const FILTER_STATE_KEY = 'isFilterActive';

// --- State Management ---
async function setFilterState(active: boolean): Promise<void> {
    console.log(`BG: Setting filter state to ${active}`);
    await chrome.storage.local.set({ [FILTER_STATE_KEY]: active });
}

async function getFilterState(): Promise<boolean> {
    // Default to false if not set
    const data = await chrome.storage.local.get({ [FILTER_STATE_KEY]: false });
    return !!data[FILTER_STATE_KEY];
}

// --- Content Script Injection/Control ---
// Injects the content script if needed and sends start/stop messages.
async function updateContentScriptState(tabId: number, active: boolean): Promise<void> {
    console.log(`BG: Updating content script state for tab ${tabId} to ${active}`);
    const message = { type: active ? 'START_FILTERING' : 'STOP_FILTERING' };

    try {
        if (active) {
            // Try injecting first. If it fails because script is already there, catch and just send message.
            try {
                console.log(`BG: Injecting content script into tab ${tabId}`);
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js'], // Ensure this file exists and is compiled JS if needed
                });
                // Short delay might sometimes help ensure script is ready before message
                await new Promise(resolve => setTimeout(resolve, 150));
            } catch (injectionError: any) {
                // Common error if script already injected: "Cannot create item with duplicate id content.ts" or similar
                // Or "Cannot access contents of url" or "Missing host permission for the tab"
                if (injectionError.message.includes("duplicate id") || injectionError.message.includes("already injected")) {
                    console.warn(`BG: Content script likely already injected in tab ${tabId}. Proceeding to send message.`);
                } else {
                    // Re-throw other injection errors (permissions etc.)
                    throw injectionError;
                }
            }
        }

        // Send the start/stop message regardless of injection result (if active=true) or always (if active=false)
        console.log(`BG: Sending ${message.type} to tab ${tabId}`);
        await chrome.tabs.sendMessage(tabId, message);

    } catch (error: any) {
        // Handle errors (e.g., no access to page, tab closed, no listener in content script)
        if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
            console.warn(`BG: Could not connect to content script in tab ${tabId} (maybe closed, navigated, or CS failed to load?):`, error.message);
        } else if (error.message.includes("Cannot access contents of url") || error.message.includes("Missing host permission")) {
            console.error(`BG: Cannot access tab ${tabId} due to permissions or restricted page.`);
        } else {
            console.error(`BG: Error updating content script state for tab ${tabId}:`, error);
        }
    }
}


// --- Message Listeners ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Listener for popup toggle
    if (message.type === 'TOGGLE_FILTER') {
        const newState = !!message.active; // Ensure boolean
        console.log(`BG: Received TOGGLE_FILTER request, target state: ${newState}`);
        setFilterState(newState).then(async () => {
            try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                // Ensure tab exists and is not a restricted URL
                if (activeTab?.id && activeTab.url && !activeTab.url.startsWith('chrome://') && !activeTab.url.startsWith('about:')) {
                    await updateContentScriptState(activeTab.id, newState);
                } else {
                    console.log("BG: No suitable active tab found to update, or URL is restricted.");
                }
                sendResponse({ status: 'success' });
            } catch (error: any) {
                console.error("BG: Error processing toggle filter:", error);
                sendResponse({ status: 'error', message: error.message });
            }
        }).catch((error: any) => {
            console.error("BG: Error setting filter state in storage:", error);
            sendResponse({ status: 'error', message: error.message });
        });
        return true; // Indicates asynchronous response is expected
    }

    // Listener for image fetch requests from content script
    if (message.type === 'FETCH_IMAGE_DATAURL' && message.url) {
        const imageUrl: string = message.url;
        console.log(`BG: Received FETCH_IMAGE_DATAURL request for: ${imageUrl.substring(0, 100)}`);

        // Basic URL validation
        if (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:')) {
            console.warn(`BG: Invalid image URL scheme: ${imageUrl}`);
            sendResponse({ status: 'error', message: 'Invalid URL scheme' });
            return false; // No async response needed
        }

        fetch(imageUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status} for ${imageUrl}`);
                }
                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.startsWith('image/')) {
                    // Optional: Still try to read as blob, maybe it works? Or reject.
                    console.warn(`BG: Content type for ${imageUrl} is not image/* (${contentType}). Attempting blob conversion anyway.`);
                    // throw new Error(`Non-image content type: ${contentType}`);
                }
                return response.blob();
            })
            .then(blob => {
                // Check blob size? Might prevent issues with massive files.
                // const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit?
                // if (blob.size > MAX_SIZE) throw new Error(`Image too large: ${blob.size} bytes`);

                const reader = new FileReader();
                reader.onloadend = () => {
                    console.log(`BG: Sending data URL back for: ${imageUrl.substring(0, 100)}`);
                    sendResponse({ status: 'success', dataUrl: reader.result as string });
                };
                reader.onerror = (error) => {
                    console.error('BG: FileReader error:', error);
                    sendResponse({ status: 'error', message: 'FileReader error' });
                };
                reader.readAsDataURL(blob);
            })
            .catch(error => {
                console.error(`BG: Fetch/Process error for ${imageUrl}:`, error);
                sendResponse({ status: 'error', message: error.message || 'Fetch failed' });
            });
        return true; // Indicates asynchronous response
    }

    // Optional: Listener for content script ready signal
    if (message.type === 'CONTENT_SCRIPT_READY') {
        console.log(`BG: Content script ready confirmation from tab ${sender.tab?.id}`);
        sendResponse({ status: "ack" });
        return false; // Synchronous response sufficient
    }

    // Default: Log unhandled messages
    // console.log("BG: Received unhandled message:", message);
});

// --- Automatic Activation on Navigation ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Check if tab finished loading, has an accessible URL, and filter is globally active
    if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
        const isGloballyActive = await getFilterState();
        if (isGloballyActive) {
            console.log(`BG: Tab ${tabId} updated (${tab.url.substring(0, 50)}...). Filter active, ensuring content script state.`);
            await updateContentScriptState(tabId, true);
        }
    }
});

// --- Initial Setup ---
chrome.runtime.onInstalled.addListener(details => {
    console.log("BG: Extension installed or updated.", details.reason);
    // Set default state on first install if not already set
    chrome.storage.local.get(FILTER_STATE_KEY, (data) => {
        if (typeof data[FILTER_STATE_KEY] === 'undefined') {
            setFilterState(false); // Default to inactive
        }
    });
});

console.log("BG: Service worker started successfully.");
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

async function fetchImageAsDataUrl(imageUrl: string, isLocalPath: boolean = false): Promise<string> {
    console.log(`BG: Fetching image: ${imageUrl.substring(0, 100)}, isLocalPath: ${isLocalPath}`);

    try {
        const fetchOptions: RequestInit = {
            mode: isLocalPath ? 'cors' : 'no-cors', // Local paths can use CORS, remote may need no-cors
            cache: 'force-cache',
            credentials: isLocalPath ? 'same-origin' : 'omit', // Only send credentials for same-origin
        };

        const response = await fetch(imageUrl, fetchOptions);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} for ${imageUrl}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            console.warn(`BG: Content type for ${imageUrl} is not image/* (${contentType}). Attempting blob conversion anyway.`);
        }

        const blob = await response.blob();

        // Convert blob to data URL
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = (error) => {
                console.error('BG: FileReader error:', error);
                reject(new Error('FileReader error'));
            };
            reader.readAsDataURL(blob);
        });
    } catch (error: any) {
        console.error(`BG: Fetch/Process error for ${imageUrl}:`, error);
        throw error; // Re-throw for proper handling by caller
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

    // Enhanced listener for image fetch requests from content script
    if (message.type === 'FETCH_IMAGE_DATAURL' && message.url) {
        const imageUrl: string = message.url;
        const isLocalPath: boolean = !!message.isLocalPath; // If flag is provided

        console.log(`BG: Received FETCH_IMAGE_DATAURL request for: ${imageUrl.substring(0, 100)}, isLocalPath: ${isLocalPath}`);

        // Basic URL validation - modified to allow local paths when flagged
        if (!isLocalPath && !imageUrl.startsWith('http:') && !imageUrl.startsWith('https:')) {
            console.warn(`BG: Invalid image URL scheme: ${imageUrl}`);
            sendResponse({ status: 'error', message: 'Invalid URL scheme' });
            return false; // No async response needed
        }

        // Use the enhanced fetch helper function
        fetchImageAsDataUrl(imageUrl, isLocalPath)
            .then(dataUrl => {
                console.log(`BG: Successfully fetched image, sending data URL back for: ${imageUrl.substring(0, 100)}`);
                sendResponse({ status: 'success', dataUrl });
            })
            .catch(error => {
                console.error(`BG: Error fetching image ${imageUrl}:`, error);
                sendResponse({
                    status: 'error',
                    message: error.message || 'Failed to fetch image'
                });
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
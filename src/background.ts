import * as tf from '@tensorflow/tfjs';

const FILTER_STATE_KEY = 'isFilterActive';
const MODEL_PATH = 'model_tfjs_saved_model/model.json'; // Relative path to model json
const LABELS = ['drawing', 'hentai', 'neutral', 'porn', 'sexy']; // Keep labels here

// --- Global State for Background ---
let modelInstance: tf.GraphModel | null = null;
let isModelLoading = false; // Prevent simultaneous load attempts
let modelLoadPromise: Promise<tf.GraphModel | null> | null = null; // Store the promise

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

async function loadModelInBackground(): Promise<tf.GraphModel | null> {
    // If model already loaded, return it
    if (modelInstance) {
        console.log("BG: Model already loaded.");
        return modelInstance;
    }
    // If model is currently loading, wait for the existing promise
    if (isModelLoading && modelLoadPromise) {
        console.log("BG: Model is currently loading, awaiting existing promise.");
        return await modelLoadPromise;
    }

    // Start loading
    console.log("BG: Attempting to load model...");
    isModelLoading = true;
    let localModelInstance: tf.GraphModel | null = null; // Use local var for promise result

    modelLoadPromise = (async () => {
        try {
            const modelUrl = chrome.runtime.getURL(MODEL_PATH);
            console.log("BG: Resolved model URL:", modelUrl);

            // Optional: Set backend *before* loading model if needed
            // await tf.setBackend('cpu');
            // console.log(`BG: TF backend set to: ${tf.getBackend()}`);

            localModelInstance = await tf.loadGraphModel(modelUrl);
            console.log('BG: Model loaded successfully!');
            return localModelInstance; // Resolve promise with loaded model
        } catch (error) {
            console.error('BG: Error loading model:', error);
            localModelInstance = null; // Ensure null on failure
            return null; // Resolve promise with null on error
        } finally {
            isModelLoading = false; // Reset loading flag regardless of outcome
            modelInstance = localModelInstance; // Assign to global state *after* promise resolves/rejects
            // modelLoadPromise = null; // Optionally clear promise? Maybe keep it for resilience.
        }
    })();

    return await modelLoadPromise;
}

async function classifyImageData(imageDataUrl: string): Promise<string | null> {
    const model = await loadModelInBackground(); // Ensure model is loaded
    if (!model) {
        console.error("BG: Model not available for classification.");
        return 'error: model not loaded'; // Return specific error string
    }

    let tensor: tf.Tensor | null = null;
    let prediction: tf.Tensor | tf.Tensor[] | null = null;
    let outputTensor: tf.Tensor | null = null;

    try {
        // 1. Load Data URL into an ImageBitmap (more efficient than HTMLImageElement in workers)
        // Note: HTMLImageElement cannot be created directly in service workers.
        // Fetch the data URL blob first.
        const response = await fetch(imageDataUrl);
        if (!response.ok) throw new Error("Failed to fetch data URL blob");
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) throw new Error("Blob is not an image");

        // Create ImageBitmap (works in Service Workers)
        const imageBitmap = await createImageBitmap(blob);

        // 2. Create Tensor
        tensor = tf.browser.fromPixels(imageBitmap)
            .resizeNearestNeighbor([224, 224]) // Match model input size
            .toFloat()
            .expandDims(0)
            .div(255.0); // Assuming normalization [0, 1]

        // 3. Predict
        prediction = model.predict(tensor) as tf.Tensor; // Adjust cast as needed
        outputTensor = Array.isArray(prediction) ? prediction[0] : prediction;
        const data = await outputTensor?.data() as Float32Array;

        // 4. Process Results
        const maxProb = Math.max(...data);
        const maxIndex = data.indexOf(maxProb);
        const label = LABELS[maxIndex] ?? 'unknown';

        console.log(`BG: Classification result: ${label} (${maxProb.toFixed(3)})`);
        return label; // Return the classification label

    } catch (error: any) {
        console.error("BG: Error during classification:", error);
        return `error: ${error.message}`; // Return specific error string
    } finally {
        // 5. Dispose Tensors (important!)
        if (tensor) tensor.dispose();
        if (outputTensor && outputTensor !== prediction) outputTensor.dispose(); // Dispose if different from prediction
        if (prediction) {
            if (Array.isArray(prediction)) {
                prediction.forEach(t => t.dispose());
            } else if (prediction instanceof tf.Tensor) {
                prediction.dispose();
            }
        }
    }
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

    if (message.type === 'CLASSIFY_IMAGE_DATAURL' && message.imageDataUrl) {
        console.log("BG: Received CLASSIFY_IMAGE_DATAURL request.");
        classifyImageData(message.imageDataUrl)
            .then(label => {
                if (label && label.startsWith('error:')) {
                    sendResponse({ status: 'error', message: label });
                } else if (label) {
                    sendResponse({ status: 'success', label: label });
                } else {
                    // Should not happen if classifyImageData returns error strings
                    sendResponse({ status: 'error', message: 'Unknown classification error' });
                }
            })
            .catch(error => { // Catch unexpected errors in classifyImageData promise chain
                console.error("BG: Unexpected error handling classification request:", error);
                sendResponse({ status: 'error', message: error.message || 'Internal background error' });
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
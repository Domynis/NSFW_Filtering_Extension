import * as tf from '@tensorflow/tfjs';

const FILTER_STATE_KEY = 'isFilterActive';
const MODEL_PATH = 'model_tfjs_saved_model/model.json';
const LABELS = ['drawing', 'hentai', 'neutral', 'porn', 'sexy'];

let modelInstance: tf.GraphModel | null = null;
let modelLoadPromise: Promise<tf.GraphModel | null> | null = null;

async function setFilterState(active: boolean): Promise<void> {
    console.log(`BG: Setting filter state to ${active}`);
    await chrome.storage.local.set({ [FILTER_STATE_KEY]: active });
}

async function getFilterState(): Promise<boolean> {
    const data = await chrome.storage.local.get({ [FILTER_STATE_KEY]: false });
    return !!data[FILTER_STATE_KEY];
}

async function loadModelInBackground(): Promise<tf.GraphModel | null> {
    if (modelInstance) {
        console.log("BG: Model already loaded.");
        return modelInstance;
    }
    if (modelLoadPromise) {
        console.log("BG: Model is currently loading, awaiting existing promise.");
        return await modelLoadPromise;
    }

    console.log("BG: Attempting to load model...");

    modelLoadPromise = (async () => {
        try {
            const modelUrl = chrome.runtime.getURL(MODEL_PATH);
            console.log("BG: Resolved model URL:", modelUrl);
            // Optional: Set backend if needed
            // await tf.setBackend('cpu');
            // console.log(`BG: TF backend set to: ${tf.getBackend()}`);
            const loadedModel = await tf.loadGraphModel(modelUrl);
            console.log('BG: Model loaded successfully!');
            modelInstance = loadedModel;
            return loadedModel;
        } catch (error) {
            console.error('BG: Error loading model:', error);
            modelInstance = null;
            modelLoadPromise = null; // Reset promise to allow retrying
            return null;
        }
    })();

    return await modelLoadPromise;
}

async function classifyImageData(imageDataUrl: string): Promise<string | null> {
    const model = await loadModelInBackground();
    if (!model) {
        console.error("BG: Model not available for classification.");
        return 'error: model not loaded';
    }

    let tensor: tf.Tensor | null = null;
    let prediction: tf.Tensor | tf.Tensor[] | null = null;
    let outputTensor: tf.Tensor | null = null;

    try {
        const response = await fetch(imageDataUrl); // imageDataUrl should be a data URL or blob URL
        if (!response.ok) throw new Error("Failed to fetch image data blob");
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) throw new Error("Blob is not an image type");

        const imageBitmap = await createImageBitmap(blob);

        tensor = tf.browser.fromPixels(imageBitmap)
            .resizeNearestNeighbor([224, 224])
            .toFloat()
            .expandDims(0)
            .div(255.0);

        prediction = model.predict(tensor) as tf.Tensor;
        outputTensor = Array.isArray(prediction) ? prediction[0] : prediction;
        const data = await outputTensor?.data() as Float32Array;

        const maxProb = Math.max(...data);
        const maxIndex = data.indexOf(maxProb);
        const label = LABELS[maxIndex] ?? 'unknown';

        console.log(`BG: Classification result: ${label} (${maxProb.toFixed(3)})`);
        return label;

    } catch (error: any) {
        console.error("BG: Error during classification:", error);
        return `error: ${error.message}`;
    } finally {
        tensor?.dispose();
        if (outputTensor && outputTensor !== prediction) outputTensor.dispose();
        if (prediction) {
            if (Array.isArray(prediction)) {
                prediction.forEach(t => t.dispose());
            } else if (prediction instanceof tf.Tensor) {
                prediction.dispose();
            }
        }
    }
}

async function updateContentScriptState(tabId: number, active: boolean): Promise<void> {
    console.log(`BG: Sending filter state to tab ${tabId}: ${active}`);
    const message = { type: active ? 'START_FILTERING' : 'STOP_FILTERING' };

    try {
        await chrome.tabs.sendMessage(tabId, message);
        console.log(`BG: Sent ${message.type} to tab ${tabId}`);
    } catch (error: any) {
        if (error.message.includes("Could not establish connection") || error.message.includes("Receiving end does not exist")) {
            console.warn(`BG: Content script in tab ${tabId} not available:`, error.message);
        } else {
            console.error(`BG: Error sending message to content script for tab ${tabId}:`, error);
        }
    }
}

async function fetchImageAsDataUrl(imageUrl: string): Promise<string> {
    // This function now assumes imageUrl is a standard web URL (http/https)
    // or a blob/data URL that fetch can handle directly.
    // Content script is responsible for resolving local/relative paths.
    console.log(`BG: Fetching image for data URL conversion: ${imageUrl.substring(0, 100)}`);

    try {
        const response = await fetch(imageUrl); // No special options, rely on default fetch behavior

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} for ${imageUrl}`);
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            console.warn(`BG: Content type for ${imageUrl} is not image/* (${contentType}). Attempting blob conversion.`);
        }

        const blob = await response.blob();

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = (error) => {
                console.error('BG: FileReader error converting blob to data URL:', error);
                reject(new Error('FileReader error'));
            };
            reader.readAsDataURL(blob);
        });
    } catch (error: any) {
        console.error(`BG: Fetch/Process error for ${imageUrl}:`, error);
        throw error;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_FILTER') {
        const newState = !!message.active;
        console.log(`BG: Received TOGGLE_FILTER, target state: ${newState}`);
        setFilterState(newState).then(async () => {
            try {
                const tabs = await chrome.tabs.query({
                    url: ["http://*/*", "https://*/*", "file://*/*"]
                });
                console.log(`BG: Found ${tabs.length} tabs to update state.`);
                for (const tab of tabs) {
                    if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
                        await updateContentScriptState(tab.id, newState);
                    }
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
        return true; // Indicates asynchronous response
    }

    if (message.type === 'FETCH_IMAGE_DATAURL' && message.url) {
        const imageUrl: string = message.url;
        // The `isLocalPath` flag is removed from here; content script should resolve local paths first
        // or send extension URLs that `fetch` can handle.

        console.log(`BG: Received FETCH_IMAGE_DATAURL for: ${imageUrl.substring(0, 100)}`);

        if (imageUrl.startsWith('data:image')) {
            console.log(`BG: URL is already a data URL, returning directly: ${imageUrl.substring(0, 60)}...`);
            sendResponse({ status: 'success', dataUrl: imageUrl });
            return false; // Synchronous response
        }

        // Validate if it's a scheme fetch can handle, otherwise error.
        // Blob URLs are also fine.
        if (!imageUrl.startsWith('http:') && !imageUrl.startsWith('https:') && !imageUrl.startsWith('blob:')) {
            console.warn(`BG: Invalid image URL scheme for background fetch: ${imageUrl}`);
            sendResponse({ status: 'error', message: 'Invalid URL scheme for background fetch' });
            return false;
        }

        fetchImageAsDataUrl(imageUrl)
            .then(dataUrl => {
                console.log(`BG: Successfully fetched and converted image to data URL for: ${imageUrl.substring(0, 100)}`);
                sendResponse({ status: 'success', dataUrl });
            })
            .catch(error => {
                console.error(`BG: Error fetching/converting image ${imageUrl}:`, error);
                sendResponse({
                    status: 'error',
                    message: error.message || 'Failed to fetch or convert image'
                });
            });
        return true; // Indicates asynchronous response
    }

    if (message.type === 'CLASSIFY_IMAGE_DATAURL' && message.imageDataUrl) {
        console.log("BG: Received CLASSIFY_IMAGE_DATAURL request.");
        classifyImageData(message.imageDataUrl)
            .then(label => {
                if (label?.startsWith('error:')) {
                    sendResponse({ status: 'error', message: label });
                } else if (label) {
                    sendResponse({ status: 'success', label: label });
                } else {
                    sendResponse({ status: 'error', message: 'Unknown classification error' });
                }
            })
            .catch(error => {
                console.error("BG: Unexpected error handling classification request:", error);
                sendResponse({ status: 'error', message: error.message || 'Internal background error' });
            });
        return true; // Indicates asynchronous response
    }

    if (message.type === 'CONTENT_SCRIPT_READY') {
        console.log(`BG: Content script ready from tab ${sender.tab?.id}`);
        sendResponse({ status: "ack" });
        return false;
    }
    // console.log("BG: Received unhandled message:", message);
    return false; // Default for unhandled messages or synchronous responses
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
        const isGloballyActive = await getFilterState();
        if (isGloballyActive) {
            console.log(`BG: Tab ${tabId} updated (${tab.url.substring(0, 50)}...). Ensuring content script state.`);
            await updateContentScriptState(tabId, true);
        }
    }
});

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log("BG: Extension installed/updated.", details.reason);
    if (details.reason === 'install') {
        await setFilterState(false);
        console.log("BG: Filter set to inactive on first install.");
    }
    // Optional: Pre-load model on install/update
    // loadModelInBackground().then(() => console.log("BG: Pre-emptive model load attempt finished on install/update."));
});

console.log("BG: Service worker started.");
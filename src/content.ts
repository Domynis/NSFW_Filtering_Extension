// content.ts
import * as tf from '@tensorflow/tfjs'; // Import TensorFlow.js library

// Type definitions for TensorFlow.js (assuming @types/tensorflow__tfjs is installed or handled)
// If not using @types, you might need to use 'any' or declare a minimal interface
// declare let tf: typeof TFJS; // Use typeof to refer to the type of the namespace object

// Wrap in an IIFE to avoid polluting global scope and allow async/await
(async () => {
    // Prevent multiple executions if injected multiple times
    if ((window as any).nsfwFilterInitialized) {
        console.log("CS: Filter already initialized, skipping.");
        return;
    }
    (window as any).nsfwFilterInitialized = true;
    console.log("CS: Initializing NSFW Filter Content Script...");

    // --- Global Variables & Constants ---
    // let tfInstance: any; // TensorFlow.js instance
    let modelInstance: any; // Loaded model instance (GraphModel)
    let observer: MutationObserver | null = null; // MutationObserver instance
    let isFilterGloballyActive = false; // Track state received from background
    const labels = ['drawing', 'hentai', 'neutral', 'porn', 'sexy']; // Classification labels
    const modelPath = 'model_tfjs_saved_model/model.json'; // Relative path within extension
    let modelUrl: string | null = null; // Resolved URL

    // Store original styles { element: { property: value } }
    const modifiedImages = new Map<HTMLImageElement, { filter: string; opacity: string }>();
    const processingImages = new Set<string>(); // Track image srcs currently being processed


    async function loadModel(): Promise<any | null> {
        if (modelInstance) {
            console.log('CS: Model already loaded.');
            return modelInstance;
        }
        if (!tf) {
            console.error('CS: TFJS not loaded, cannot load model.');
            return null;
        }
        if (!modelUrl) {
            try {
                modelUrl = chrome.runtime.getURL(modelPath);
                console.log("CS: Resolved model URL:", modelUrl);
            } catch (e) {
                console.error("CS: Failed to resolve model URL. Ensure web_accessible_resources is correct.", e);
                return null;
            }
        }

        try {
            console.log(`CS: Attempting to load model from: ${modelUrl}`);
            // Consider setting CPU backend here if needed:
            // await tf.setBackend('cpu');
            // console.log(`CS: TF backend forced to: ${tf.getBackend()}`);

            modelInstance = await tf.loadGraphModel(modelUrl);
            console.log('CS: Model loaded successfully!');
            return modelInstance;
        } catch (error) {
            console.error('CS: Error loading model:', error);
            modelInstance = null; // Ensure it's null on failure
            return null;
        }
    }

    // --- Image Fetching and Classification ---
    async function classifyAndStyleImage(imgElement: HTMLImageElement): Promise<void> {
        // 1. Pre-checks
        if (!modelInstance || !isFilterGloballyActive) {
            // console.log("CS: Skipping classification - model/filter inactive.");
            return;
        }
        // Ensure src exists and is not empty
        const originalSrc = imgElement.getAttribute('src'); // Use getAttribute for potentially non-resolved URLs
        if (!originalSrc) {
            // console.log("CS: Skipping image with missing src attribute.");
            return;
        }
        // Avoid re-processing images currently being fetched/classified
        if (processingImages.has(originalSrc)) {
            // console.log(`CS: Skipping image already being processed: ${originalSrc.substring(0,100)}`);
            return;
        }
        // Avoid re-processing images already definitively classified (unless src changed)
        if (imgElement.dataset.nsfwClassified && imgElement.dataset.nsfwOriginalSrc === originalSrc) {
            // console.log(`CS: Skipping already classified image: ${originalSrc.substring(0,100)}`);
            return;
        }

        console.log(`CS: Starting processing for: ${originalSrc.substring(0, 100)}`);
        processingImages.add(originalSrc); // Mark as processing
        imgElement.dataset.nsfwOriginalSrc = originalSrc; // Store src when processing started

        // 2. Get Image Data (Handle Data URLs vs Fetching)
        let imageDataSource: string | null = null;
        let fetchError: string | null = null;

        if (originalSrc.startsWith('data:image')) {
            console.log(`CS: Using existing data URL for: ${originalSrc.substring(0, 100)}`);
            imageDataSource = originalSrc;
        } else if (originalSrc.startsWith('http:') || originalSrc.startsWith('https:')) {
            console.log(`CS: Requesting data URL via background for: ${originalSrc.substring(0, 100)}`);
            try {
                const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_DATAURL', url: originalSrc });
                if (response?.status === 'success' && response.dataUrl) {
                    console.log(`CS: Received data URL for: ${originalSrc.substring(0, 100)}`);
                    imageDataSource = response.dataUrl;
                } else {
                    fetchError = `Failed to get data URL: ${response?.message || 'Unknown background error'}`;
                    console.error(`CS: ${fetchError} for ${originalSrc}`);
                }
            } catch (error: any) {
                fetchError = `Error communicating with background: ${error.message}`;
                console.error(`CS: ${fetchError} for ${originalSrc}`);
                // If background communication fails, it might be fatal - consider stopping?
            }
        } else {
            console.log(`CS: Skipping image with non-http(s)/data src: ${originalSrc.substring(0, 100)}`);
            processingImages.delete(originalSrc); // Unmark processing
            return;
        }

        // 3. Process Image if Data Source Acquired
        if (imageDataSource) {
            const tempImg = new Image();
            tempImg.onload = async () => {
                console.log(`CS: Processing temp image derived from: ${originalSrc.substring(0, 100)}`);
                try {
                    // Ensure positive dimensions before processing
                    if (tempImg.naturalWidth === 0 || tempImg.naturalHeight === 0) {
                        throw new Error("Temporary image has zero dimensions.");
                    }

                    const tensor = tf.browser.fromPixels(tempImg)
                        .resizeNearestNeighbor([224, 224]) // Match model input size
                        .toFloat()
                        .expandDims(0)
                        .div(255.0); // Assuming normalization [0, 1]

                    const prediction = modelInstance.predict(tensor) as any; // Use GraphModel predict
                    const outputTensor = Array.isArray(prediction) ? prediction[0] : prediction;
                    const data: Float32Array | Int32Array | Uint8Array = await outputTensor.data();

                    const maxProb = Math.max(...data);
                    const maxIndex = data.indexOf(maxProb);
                    const label = labels[maxIndex] ?? 'unknown'; // Handle potential index out of bounds

                    console.log(`CS: Classification for ${originalSrc.substring(0, 100)}: ${label} (${maxProb.toFixed(3)})`);
                    imgElement.dataset.nsfwClassified = label; // Store classification result

                    if (['porn', 'sexy', 'hentai'].includes(label)) {
                        applyNsfwStyle(imgElement);
                    } else {
                        // Ensure non-NSFW images revert to original style if they were previously blurred
                        revertImageStyle(imgElement);
                    }

                    // Dispose tensors
                    tensor.dispose();
                    outputTensor.dispose();
                    if (Array.isArray(prediction)) {
                        prediction.forEach((t: any) => t.dispose());
                    }
                } catch (error: any) {
                    console.error(`CS: Error classifying image derived from ${originalSrc.substring(0, 100)}:`, error);
                    imgElement.dataset.nsfwClassified = 'error'; // Mark classification error
                    revertImageStyle(imgElement); // Revert style on error
                } finally {
                    processingImages.delete(originalSrc); // Finished processing
                }
            };
            tempImg.onerror = (error) => {
                console.error(`CS: Error loading temporary image from data source derived from ${originalSrc.substring(0, 100)}:`, error);
                imgElement.dataset.nsfwClassified = 'load-error'; // Mark load error
                revertImageStyle(imgElement);
                processingImages.delete(originalSrc); // Finished processing (failed)
            };
            tempImg.src = imageDataSource; // Assign src to trigger load/error
        } else {
            // Handle fetch error case
            imgElement.dataset.nsfwClassified = 'fetch-error';
            revertImageStyle(imgElement);
            processingImages.delete(originalSrc); // Finished processing (failed)
        }
    }

    // --- DOM Manipulation & Styling ---
    function applyNsfwStyle(imgElement: HTMLImageElement) {
        // Store original style only if not already stored/modified
        if (!modifiedImages.has(imgElement)) {
            modifiedImages.set(imgElement, {
                filter: imgElement.style.filter || '',
                opacity: imgElement.style.opacity || '',
            });
            // Apply NSFW style
            imgElement.style.filter = 'blur(20px)';
            imgElement.style.opacity = '0.1';
            console.log(`CS: Applied NSFW style to: ${imgElement.src?.substring(0, 100)}`);
        } else {
            // Already styled, ensure it stays styled (e.g., if classified again)
            imgElement.style.filter = 'blur(20px)';
            imgElement.style.opacity = '0.1';
        }
    }

    function revertImageStyle(imgElement: HTMLImageElement) {
        if (modifiedImages.has(imgElement)) {
            const originalStyle = modifiedImages.get(imgElement)!; // Assert non-null
            imgElement.style.filter = originalStyle.filter;
            imgElement.style.opacity = originalStyle.opacity;
            modifiedImages.delete(imgElement); // Remove from map once reverted
            console.log(`CS: Reverted style for: ${imgElement.src?.substring(0, 100)}`);
        }
        // Don't remove nsfwClassified dataset here, let it persist until src changes or deactivated
    }

    function processNode(node: Node) {
        if (!isFilterGloballyActive) return; // Check global state

        if (node instanceof HTMLImageElement) {
            // Check if image is potentially visible and has dimensions before classifying
            if (node.complete && node.naturalWidth > 0 && node.naturalHeight > 0) {
                classifyAndStyleImage(node);
            } else if (!node.complete) { // If not loaded, attach listeners
                const onLoad = () => {
                    // Check dimensions again after load
                    if (node.naturalWidth > 0 && node.naturalHeight > 0) {
                        classifyAndStyleImage(node);
                    } else {
                        console.log(`CS: Image loaded but has zero dimensions: ${node.src?.substring(0, 100)}`);
                        node.dataset.nsfwClassified = 'zero-dimensions';
                    }
                    node.removeEventListener('load', onLoad);
                    node.removeEventListener('error', onError);
                };
                const onError = () => {
                    console.warn(`CS: Image failed to load natively: ${node.src?.substring(0, 100)}`);
                    node.dataset.nsfwClassified = 'native-load-error';
                    node.removeEventListener('load', onLoad);
                    node.removeEventListener('error', onError);
                };
                node.addEventListener('load', onLoad);
                node.addEventListener('error', onError);
            } else {
                // Is complete but has zero dimensions
                console.log(`CS: Image complete but zero dimensions on scan: ${node.src?.substring(0, 100)}`);
                node.dataset.nsfwClassified = 'zero-dimensions';
            }
        } else if (node instanceof Element && node.querySelectorAll) {
            // Check for images within the added/mutated element subtree
            node.querySelectorAll('img').forEach(img => processNode(img));
        }
    }

    // --- Mutation Observer ---
    function startObserver() {
        if (observer) {
            console.log("CS: Observer already running.");
            return;
        }
        if (!modelInstance) {
            console.warn("CS: Model not loaded, cannot start observer.");
            return;
        }

        console.log("CS: Starting MutationObserver...");
        observer = new MutationObserver((mutations) => {
            if (!isFilterGloballyActive) return; // Check state during callback
            console.log(`CS: MutationObserver detected ${mutations.length} mutations.`); // Debugging frequency
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processNode(node));
                    // Note: We don't explicitly handle removedNodes for reverting style,
                    // as the `modifiedImages` map keeps track. Reverting happens on STOP.
                } else if (mutation.type === 'attributes') {
                    if (mutation.attributeName === 'src' && mutation.target instanceof HTMLImageElement) {
                        console.log(`CS: Image src changed for: ${mutation.target.dataset.nsfwOriginalSrc?.substring(0, 100)} -> ${mutation.target.src?.substring(0, 100)}`);
                        // Reset classification status and re-process if src changes
                        delete mutation.target.dataset.nsfwClassified;
                        revertImageStyle(mutation.target); // Revert any old styling first
                        processNode(mutation.target);
                    }
                    // Could also observe 'style' or 'class' if needed, but might be too noisy
                }
            }
        });

        observer.observe(document.body, {
            childList: true, // Observe additions/removals of nodes
            subtree: true,   // Observe descendants
            attributes: true, // Observe attribute changes
            attributeFilter: ['src'], // Focus on src changes for images
            // attributeOldValue: false, // Don't need old value for src check
            // characterData: false,     // Don't need text changes
        });

        // Initial scan of existing images on the page
        console.log("CS: Performing initial image scan...");
        document.querySelectorAll('img').forEach(img => processNode(img));
        console.log("CS: Initial image scan complete. Observer is active.");
    }

    function stopObserver() {
        if (observer) {
            console.log("CS: Stopping MutationObserver...");
            observer.disconnect();
            observer = null;
        } else {
            console.log("CS: Observer not running, no need to stop.");
        }
        // Revert styles for all images modified by the filter
        console.log("CS: Reverting styles for all modified images...");
        modifiedImages.forEach((style, imgElement) => {
            imgElement.style.filter = style.filter;
            imgElement.style.opacity = style.opacity;
            // Optionally remove dataset markers? Or leave them? Let's remove classification status.
            // delete imgElement.dataset.nsfwClassified;
            // delete imgElement.dataset.nsfwOriginalSrc;
        });
        modifiedImages.clear(); // Clear the map
        processingImages.clear(); // Clear processing set
        console.log("CS: Styles reverted. Filtering stopped.");
    }

    // --- Initialization and Message Handling ---
    async function initialize() {
        try {
            if (!tf) throw new Error("Failed to load TFJS");

            // Load model during initialization. If it fails, log but continue (observer won't start)
            await loadModel();

            // Listen for messages from background script AFTER TF/Model attempts
            chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
                if (message.type === 'START_FILTERING') {
                    console.log("CS: Received START_FILTERING message.");
                    isFilterGloballyActive = true;
                    if (modelInstance) { // Only start if model loaded successfully
                        startObserver();
                        sendResponse({ status: 'started' });
                    } else {
                        console.error("CS: Cannot start observer, model failed to load.");
                        sendResponse({ status: 'error', message: 'Model not loaded' });
                    }
                } else if (message.type === 'STOP_FILTERING') {
                    console.log("CS: Received STOP_FILTERING message.");
                    isFilterGloballyActive = false;
                    stopObserver();
                    sendResponse({ status: 'stopped' });
                } else {
                    // Optional: Handle unknown messages
                    // sendResponse({status: 'unknown_message'});
                }
                // Indicate if you might send an asynchronous response later (we don't here)
                return false;
            });

            console.log("CS: Initialization complete. Listening for messages.");
            // Optional: Send ready message to background
            // chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' });

        } catch (error) {
            console.error("CS: CRITICAL Initialization failed:", error);
            // If TFJS fails to load, the script cannot function
        }
    }

    // --- Run Initialization ---
    initialize();

})(); // End of IIFE
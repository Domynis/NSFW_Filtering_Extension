(async () => {
    // Prevent multiple executions if injected multiple times
    if ((window as any).nsfwFilterInitialized) {
        console.log("CS: Filter already initialized, skipping.");
        return;
    }
    (window as any).nsfwFilterInitialized = true;
    console.log("CS: Initializing NSFW Filter Content Script...");

    let observer: MutationObserver | null = null; // MutationObserver instance
    let isFilterGloballyActive = false; // Track state received from background

    // Store original styles { element: { property: value } }
    const modifiedImages = new Map<HTMLImageElement, { filter: string; opacity: string }>();
    const processingImages = new Set<string>(); // Track image srcs currently being processed

    async function requestClassificationAndStyle(imgElement: HTMLImageElement): Promise<void> {
        // 1. Pre-checks (Simplified)
        if (!isFilterGloballyActive) return; // Only check global filter state

        const originalSrc = imgElement.getAttribute('src');
        if (!originalSrc) return;
        if (processingImages.has(originalSrc)) return;

        // Check if *already classified by background* (new dataset attribute maybe?)
        if (imgElement.dataset.nsfwBgClassified && imgElement.dataset.nsfwOriginalSrc === originalSrc) {
            // console.log(`CS: Skipping already classified image by BG: ${originalSrc.substring(0,100)}`);
            return;
        }

        console.log(`CS: Requesting classification for: ${originalSrc.substring(0, 100)}`);
        processingImages.add(originalSrc); // Mark as processing *before* async fetch/classify
        imgElement.dataset.nsfwOriginalSrc = originalSrc;

        // 2. Get Image Data URL (Using existing logic, including background fetch if needed)
        let imageDataSource: string | null = null;
        let fetchError: string | null = null;
        const isLocalPathFlag = originalSrc.startsWith('./') || originalSrc.startsWith('../') || originalSrc.startsWith('/');
        let fetchUrl = originalSrc;

        if (originalSrc.startsWith('data:image')) {
            console.log(`CS: Using existing data URL: ${originalSrc.substring(0, 100)}`);
            imageDataSource = originalSrc;
        } else if (isLocalPathFlag || originalSrc.startsWith('http:') || originalSrc.startsWith('https:')) {
            if (isLocalPathFlag) {
                try {
                    fetchUrl = new URL(originalSrc, document.baseURI).href;
                    console.log(`CS: Converting relative path "${originalSrc}" to absolute URL: ${fetchUrl}`);
                } catch (e) {
                    fetchError = `Invalid relative URL: ${originalSrc}`;
                    console.error(`CS: ${fetchError}`);
                    processingImages.delete(originalSrc);
                    return; // Cannot proceed
                }
            }

            console.log(`CS: Requesting data URL via background for URL: ${fetchUrl.substring(0, 100)}`);
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'FETCH_IMAGE_DATAURL',
                    url: fetchUrl,
                    isLocalPath: isLocalPathFlag // Pass flag if needed by BG fetcher
                });
                if (response?.status === 'success' && response.dataUrl) {
                    console.log(`CS: Received data URL for: ${originalSrc.substring(0, 100)}`);
                    imageDataSource = response.dataUrl;
                } else {
                    fetchError = `Failed to get data URL: ${response?.message || 'Unknown background error'}`;
                    console.error(`CS: ${fetchError} for ${originalSrc}`);
                }
            } catch (error: any) {
                fetchError = `Error communicating with background for fetch: ${error.message}`;
                console.error(`CS: ${fetchError} for ${originalSrc}`);
            }
        } else {
            console.log(`CS: Skipping image with non-fetchable src: ${originalSrc.substring(0, 100)}`);
            processingImages.delete(originalSrc); // Unmark processing
            return;
        }

        // 3. If Data Source Acquired, Send to Background for Classification
        if (imageDataSource) {
            console.log(`CS: Sending image data to background for classification: ${originalSrc.substring(0, 100)}`);
            try {
                chrome.runtime.sendMessage(
                    { type: 'CLASSIFY_IMAGE_DATAURL', imageDataUrl: imageDataSource },
                    (response) => {
                        // Check if runtime disconnected (e.g., extension reload, error)
                        if (chrome.runtime.lastError) {
                            console.error(`CS: Error sending/receiving classification for ${originalSrc.substring(0, 100)}: ${chrome.runtime.lastError.message}`);
                            imgElement.dataset.nsfwBgClassified = 'comm-error'; // Mark communication error
                            revertImageStyle(imgElement); // Revert on error
                            processingImages.delete(originalSrc); // Unmark processing
                            return;
                        }

                        // Handle response from background classification
                        if (response?.status === 'success') {
                            const label = response.label;
                            console.log(`CS: Received classification for ${originalSrc.substring(0, 100)}: ${label}`);
                            imgElement.dataset.nsfwBgClassified = label; // Store classification result

                            // Apply style based on label received from background
                            if (['porn', 'sexy', 'hentai'].includes(label)) {
                                applyNsfwStyle(imgElement);
                            } else {
                                revertImageStyle(imgElement);
                            }
                        } else {
                            console.error(`CS: Background classification failed for ${originalSrc.substring(0, 100)}: ${response?.message || 'Unknown error'}`);
                            imgElement.dataset.nsfwBgClassified = 'bg-error'; // Mark background error
                            revertImageStyle(imgElement); // Revert on error
                        }
                        processingImages.delete(originalSrc); // Unmark processing *after* handling response
                    }
                );
            } catch (error: any) {
                // Catch synchronous errors during sendMessage itself (less common)
                console.error(`CS: Synchronous error sending classification message for ${originalSrc.substring(0, 100)}: ${error.message}`);
                imgElement.dataset.nsfwBgClassified = 'send-error'; // Mark send error
                revertImageStyle(imgElement); // Revert on error
                processingImages.delete(originalSrc); // Unmark processing
            }
        } else {
            // Handle case where data URL fetch failed
            console.log(`CS: No image data source, skipping classification request for ${originalSrc.substring(0, 100)}.`);
            imgElement.dataset.nsfwBgClassified = 'fetch-error'; // Reuse fetch-error status
            revertImageStyle(imgElement); // Ensure reverted if fetch failed
            processingImages.delete(originalSrc); // Unmark processing
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
                requestClassificationAndStyle(node);
            } else if (!node.complete) { // If not loaded, attach listeners
                const onLoad = () => {
                    // Check dimensions again after load
                    if (node.naturalWidth > 0 && node.naturalHeight > 0) {
                        requestClassificationAndStyle(node);
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
            // Listen for messages from background script AFTER TF/Model attempts
            chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
                if (message.type === 'START_FILTERING') {
                    console.log("CS: Received START_FILTERING message.");
                    isFilterGloballyActive = true;
                    startObserver();
                    sendResponse({ status: 'started' });
                } else if (message.type === 'STOP_FILTERING') {
                    console.log("CS: Received STOP_FILTERING message.");
                    isFilterGloballyActive = false;
                    stopObserver();
                    sendResponse({ status: 'stopped' });
                }
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
(async () => {
    if ((window as any).nsfwFilterInitialized) return;
    (window as any).nsfwFilterInitialized = true;
    console.log("CS: Initializing NSFW Filter Content Script...");

    let observer: MutationObserver | null = null;
    let isFilterGloballyActive = false;
    const processingItems = new Set<string>();
    const BODY_CLASS_DISABLED = 'nsfw-filter-disabled';

    function setFilterDisabledVisualState(isDisabled: boolean) {
        if (isDisabled) {
            document.body.classList.add(BODY_CLASS_DISABLED);
            console.log("CS: Filter set to OFF visuals.");
        } else {
            document.body.classList.remove(BODY_CLASS_DISABLED);
            console.log("CS: Filter set to ON visuals.");
        }
    }

    async function requestClassification(imgElement: HTMLImageElement): Promise<void> {
        if (!isFilterGloballyActive) return; // Don't process if filter is off

        const originalSrc = imgElement.getAttribute('src');
        if (!originalSrc || processingItems.has(originalSrc)) return;

        if (imgElement.dataset.nsfwClassification && imgElement.dataset.nsfwClassification !== "pending") {
            return; // Already classified (and not pending)
        }

        console.log(`CS: Processing image: ${originalSrc.substring(0, 100)}`);
        processingItems.add(originalSrc);
        imgElement.dataset.nsfwOriginalSrc = originalSrc;
        imgElement.dataset.nsfwClassification = "pending"; // CSS will hide it

        let imageDataSource: string | null = null;
        let fetchError: string | null = null;
        const isPotentiallyRelative = originalSrc.startsWith('./') || originalSrc.startsWith('../') || originalSrc.startsWith('/');
        let fetchableUrl = originalSrc;

        if (originalSrc.startsWith('data:image')) {
            imageDataSource = originalSrc;
        } else {
            if (isPotentiallyRelative) {
                try {
                    fetchableUrl = new URL(originalSrc, document.baseURI).href;
                } catch (e) {
                    fetchError = `Invalid relative URL: ${originalSrc}`;
                }
            }
            // Check if fetchableUrl is a scheme background can handle (http, https, blob)
            // Data URLs are handled above. Content scripts cannot directly fetch local file:// URLs for security.
            // Extension resources (chrome-extension://) can be fetched if background is involved.
            if (!fetchError && (fetchableUrl.startsWith('http:') || fetchableUrl.startsWith('https:') || fetchableUrl.startsWith('blob:') || fetchableUrl.startsWith('chrome-extension:'))) {
                console.log(`CS: Requesting data URL from background for: ${fetchableUrl.substring(0, 100)}`);
                try {
                    const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_DATAURL', url: fetchableUrl });
                    if (response?.status === 'success' && response.dataUrl) {
                        imageDataSource = response.dataUrl;
                    } else {
                        fetchError = `Failed to get data URL: ${response?.message || 'Background error'}`;
                    }
                } catch (error: any) {
                    fetchError = `Error communicating with background for fetch: ${error.message}`;
                }
            } else if (!fetchError) {
                fetchError = `Skipping image with non-fetchable src scheme: ${fetchableUrl.substring(0, 100)}`;
            }
        }

        if (fetchError) {
            console.warn(`CS: ${fetchError} for original src ${originalSrc}`);
            imgElement.dataset.nsfwClassification = "fetch-error";
            processingItems.delete(originalSrc);
            return;
        }

        if (imageDataSource) {
            console.log(`CS: Sending image data for classification (src: ${originalSrc.substring(0, 100)})`);
            try {
                chrome.runtime.sendMessage(
                    { type: 'CLASSIFY_IMAGE_DATAURL', imageDataUrl: imageDataSource, originalUrl: originalSrc },
                    (response) => {
                        processingItems.delete(originalSrc);
                        if (chrome.runtime.lastError) {
                            console.error(`CS: Communication error for ${originalSrc.substring(0, 100)}: ${chrome.runtime.lastError.message}`);
                            imgElement.dataset.nsfwClassification = "comm-error";
                            return;
                        }

                        let finalLabel = "error";
                        if (response?.status === 'success') {
                            finalLabel = response.label || "unknown";
                            console.log(`CS: Classified ${originalSrc.substring(0, 100)} as: ${finalLabel}`);
                        } else {
                            finalLabel = response?.message?.replace('error: ', '') || "bg-error";
                            console.error(`CS: Background classification failed for ${originalSrc.substring(0, 100)}: ${response?.message}`);
                        }
                        imgElement.dataset.nsfwClassification = finalLabel;
                    }
                );
            } catch (error: any) {
                console.error(`CS: Synchronous error sending classification message for ${originalSrc.substring(0, 100)}: ${error.message}`);
                imgElement.dataset.nsfwClassification = "send-error";
                processingItems.delete(originalSrc);
            }
        } else {
            console.log(`CS: No image data source to classify for ${originalSrc.substring(0, 100)}.`);
            imgElement.dataset.nsfwClassification = "fetch-error"; // Should have been caught by fetchError earlier
            processingItems.delete(originalSrc);
        }
    }

    function processImageNode(imgNode: HTMLImageElement) {
        if (document.body.classList.contains(BODY_CLASS_DISABLED) || !isFilterGloballyActive) return;

        const currentSrc = imgNode.getAttribute('src');
        if (!currentSrc) {
            imgNode.dataset.nsfwClassification = 'no-src'; // Mark elements without src
            return;
        }

        // Reset if src changed and it was previously processed differently
        if (imgNode.dataset.nsfwOriginalSrc && imgNode.dataset.nsfwOriginalSrc !== currentSrc) {
            console.log(`CS: Image src changed, re-evaluating: ${currentSrc.substring(0, 100)}`);
            imgNode.removeAttribute('data-nsfw-classification');
            imgNode.removeAttribute('data-nsfw-original-src');
            if (processingItems.has(imgNode.dataset.nsfwOriginalSrc)) {
                processingItems.delete(imgNode.dataset.nsfwOriginalSrc);
            }
        }

        // Initial pending state for CSS hiding, if not already finally classified
        if (!imgNode.dataset.nsfwClassification || imgNode.dataset.nsfwClassification === 'pending') {
            imgNode.dataset.nsfwClassification = "pending";
        }

        if (imgNode.complete && imgNode.naturalWidth > 0 && imgNode.naturalHeight > 0) {
            requestClassification(imgNode);
        } else if (!imgNode.complete && currentSrc) { // Image still loading
            const onLoad = () => {
                cleanupListeners();
                if (imgNode.naturalWidth > 0 && imgNode.naturalHeight > 0) {
                    requestClassification(imgNode);
                } else {
                    imgNode.dataset.nsfwClassification = 'zero-dimensions';
                    if (currentSrc) processingItems.delete(currentSrc);
                }
            };
            const onError = () => {
                cleanupListeners();
                console.warn(`CS: Image native load error: ${imgNode.src?.substring(0, 100)}`);
                imgNode.dataset.nsfwClassification = 'native-load-error';
                if (currentSrc) processingItems.delete(currentSrc);
            };
            const cleanupListeners = () => {
                imgNode.removeEventListener('load', onLoad);
                imgNode.removeEventListener('error', onError);
            };
            imgNode.addEventListener('load', onLoad);
            imgNode.addEventListener('error', onError);
        } else if (currentSrc) { // Is complete but zero dimensions, or other edge case
            imgNode.dataset.nsfwClassification = 'zero-dimensions';
        }
    }

    function processNode(node: Node) {
        if (document.body.classList.contains(BODY_CLASS_DISABLED) || !isFilterGloballyActive) return;

        if (node instanceof HTMLImageElement) {
            processImageNode(node);
        } else if (node instanceof Element && node.querySelectorAll) {
            node.querySelectorAll('img').forEach(img => processImageNode(img));
            // Potential future: node.querySelectorAll('video').forEach(vid => processVideoNode(vid));
            // Potential future: node.querySelectorAll('*').forEach(el => processBackgroundStyleNode(el));
        }
    }

    function startObserver() {
        if (observer) return;
        console.log("CS: Starting MutationObserver.");
        observer = new MutationObserver((mutations) => {
            if (!isFilterGloballyActive || document.body.classList.contains(BODY_CLASS_DISABLED)) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processNode(node));
                } else if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target instanceof HTMLImageElement) {
                    console.log(`CS Obsrv: Image src attribute changed:`, mutation.target);
                    // Old src already handled by processingItems Set logic within processImageNode if new src is different.
                    // Re-run processing logic for the node with the new src.
                    processImageNode(mutation.target);
                }
                // Add similar handling for video src/currentSrc if needed
                // Add handling for style/class changes if background images are processed
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'], attributeOldValue: true });

        console.log("CS: Performing initial full page scan for images...");
        document.querySelectorAll('img').forEach(img => processImageNode(img));
        console.log("CS: Initial scan complete.");
    }

    function stopObserverAndReveal() {
        if (observer) {
            observer.disconnect();
            observer = null;
            console.log("CS: MutationObserver stopped.");
        }
        setFilterDisabledVisualState(true); // Add class to reveal all via CSS
        console.log("CS: Removing all NSFW classification attributes for cleanup...");
        document.querySelectorAll('[data-nsfw-classification]').forEach(el => {
            el.removeAttribute('data-nsfw-classification');
            el.removeAttribute('data-nsfw-original-src');
        });
        processingItems.clear();
        console.log("CS: Filtering stopped and elements revealed.");
    }

    async function initializeFilterState() {
        console.log("CS: Initializing filter state from storage...");
        try {
            const data = await chrome.storage.local.get('isFilterActive');
            isFilterGloballyActive = !!data.isFilterActive;

            if (isFilterGloballyActive) {
                console.log("CS: Initial state is ON. Activating filter.");
                setFilterDisabledVisualState(false);
                startObserver();
            } else {
                console.log("CS: Initial state is OFF. Filter remains inactive.");
                setFilterDisabledVisualState(true); // Ensure visuals are off
            }
        } catch (error) {
            console.error("CS: Error getting initial filter state:", error);
            isFilterGloballyActive = false; // Default to off on error
            setFilterDisabledVisualState(true);
        }

        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            console.log(`CS: Received message: ${message?.type}`);
            if (message.type === 'START_FILTERING') {
                isFilterGloballyActive = true;
                setFilterDisabledVisualState(false);
                if (!observer) startObserver(); // Start if not already running (e.g. was initially off)
                sendResponse({ status: 'started' });
            } else if (message.type === 'STOP_FILTERING') {
                isFilterGloballyActive = false;
                stopObserverAndReveal();
                sendResponse({ status: 'stopped' });
            }
            return false; // Use false for synchronous response or if sendResponse is not used.
        });

        console.log("CS: Initialization complete. Message listener attached.");
        // Notify background that content script is ready (optional, but good for coordination)
        chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' });
    }

    initializeFilterState();

})();
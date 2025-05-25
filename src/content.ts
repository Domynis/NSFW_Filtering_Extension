(async () => {
    if ((window as any).nsfwFilterInitialized) return;
    (window as any).nsfwFilterInitialized = true;
    console.log("CS: Initializing NSFW Filter Content Script with Lazy Loading...");

    let mutationObserver: MutationObserver | null = null;
    let imageIntersectionObserver: IntersectionObserver | null = null;
    let isFilterGloballyActive = false;
    const processingItems = new Set<string>(); // Tracks src strings of images currently being fetched/classified
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
        if (!isFilterGloballyActive) return;

        const originalSrc = imgElement.getAttribute('src');
        // Use imgElement.dataset.nsfwOriginalSrc if available, as originalSrc might be a blob/data URL by now
        const srcForProcessingItem = imgElement.dataset.nsfwOriginalSrc || originalSrc;

        if (!originalSrc || (srcForProcessingItem && processingItems.has(srcForProcessingItem))) return;

        // Check if already finally classified (not pending)
        if (imgElement.dataset.nsfwClassification && imgElement.dataset.nsfwClassification !== "pending") {
            return;
        }

        console.log(`CS: Requesting classification for: ${(imgElement.dataset.nsfwOriginalSrc || originalSrc).substring(0, 100)}`);
        if (srcForProcessingItem) processingItems.add(srcForProcessingItem);
        imgElement.dataset.nsfwOriginalSrc = imgElement.dataset.nsfwOriginalSrc || originalSrc; // Ensure original src is stored
        imgElement.dataset.nsfwClassification = "pending";

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

        const finalSrcToUseForDeletion = imgElement.dataset.nsfwOriginalSrc || originalSrc; // src used in processingItems

        if (fetchError) {
            console.warn(`CS: ${fetchError} for original src ${finalSrcToUseForDeletion}`);
            imgElement.dataset.nsfwClassification = "fetch-error";
            if (finalSrcToUseForDeletion) processingItems.delete(finalSrcToUseForDeletion);
            return;
        }

        if (imageDataSource) {
            console.log(`CS: Sending image data for classification (src: ${finalSrcToUseForDeletion.substring(0, 100)})`);
            try {
                chrome.runtime.sendMessage(
                    { type: 'CLASSIFY_IMAGE_DATAURL', imageDataUrl: imageDataSource, originalUrl: finalSrcToUseForDeletion },
                    (response) => {
                        if (finalSrcToUseForDeletion) processingItems.delete(finalSrcToUseForDeletion);
                        if (chrome.runtime.lastError) {
                            console.error(`CS: Communication error for ${finalSrcToUseForDeletion.substring(0, 100)}: ${chrome.runtime.lastError.message}`);
                            imgElement.dataset.nsfwClassification = "comm-error";
                            return;
                        }
                        let finalLabel = "error";
                        if (response?.status === 'success') {
                            finalLabel = response.label || "unknown";
                            console.log(`CS: Classified ${finalSrcToUseForDeletion.substring(0, 100)} as: ${finalLabel}`);
                        } else {
                            finalLabel = response?.message?.replace('error: ', '') || "bg-error";
                            console.error(`CS: Background classification failed for ${finalSrcToUseForDeletion.substring(0, 100)}: ${response?.message}`);
                        }
                        imgElement.dataset.nsfwClassification = finalLabel;
                    }
                );
            } catch (error: any) {
                console.error(`CS: Synchronous error sending classification message for ${finalSrcToUseForDeletion.substring(0, 100)}: ${error.message}`);
                imgElement.dataset.nsfwClassification = "send-error";
                if (finalSrcToUseForDeletion) processingItems.delete(finalSrcToUseForDeletion);
            }
        } else {
            console.log(`CS: No image data source to classify for ${finalSrcToUseForDeletion.substring(0, 100)}.`);
            imgElement.dataset.nsfwClassification = "fetch-error";
            if (finalSrcToUseForDeletion) processingItems.delete(finalSrcToUseForDeletion);
        }
    }

    async function processAndClassifyImage(imgElement: HTMLImageElement) {
        if (imageIntersectionObserver) {
            imageIntersectionObserver.unobserve(imgElement); // Stop observing once it's visible and being processed
        }

        const currentSrc = imgElement.getAttribute('src');
        if (!currentSrc || (imgElement.dataset.nsfwClassification && imgElement.dataset.nsfwClassification !== 'pending')) {
            return; // No src or already finally classified
        }

        if (imgElement.complete && imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0) {
            await requestClassification(imgElement);
        } else if (!imgElement.complete && currentSrc) {
            const nsfwOriginalSrcForListeners = imgElement.dataset.nsfwOriginalSrc || currentSrc;
            const onLoad = async () => {
                cleanupListeners();
                if (imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0) {
                    await requestClassification(imgElement);
                } else {
                    imgElement.dataset.nsfwClassification = 'zero-dimensions';
                    if (nsfwOriginalSrcForListeners) processingItems.delete(nsfwOriginalSrcForListeners);
                }
            };
            const onError = () => {
                cleanupListeners();
                console.warn(`CS: Image native load error (after intersection): ${imgElement.src?.substring(0, 100)}`);
                imgElement.dataset.nsfwClassification = 'native-load-error';
                if (nsfwOriginalSrcForListeners) processingItems.delete(nsfwOriginalSrcForListeners);
            };
            const cleanupListeners = () => {
                imgElement.removeEventListener('load', onLoad);
                imgElement.removeEventListener('error', onError);
            };
            imgElement.addEventListener('load', onLoad);
            imgElement.addEventListener('error', onError);
        } else if (currentSrc) {
            imgElement.dataset.nsfwClassification = 'zero-dimensions';
            const nsfwOriginalSrcForDeletion = imgElement.dataset.nsfwOriginalSrc || currentSrc;
            if (nsfwOriginalSrcForDeletion) processingItems.delete(nsfwOriginalSrcForDeletion);
        }
    }

    function processImageNode(imgNode: HTMLImageElement) {
        if (document.body.classList.contains(BODY_CLASS_DISABLED) || !isFilterGloballyActive) return;

        const currentSrc = imgNode.getAttribute('src');
        if (!currentSrc) {
            imgNode.dataset.nsfwClassification = 'no-src';
            return;
        }

        const oldTrackedSrc = imgNode.dataset.nsfwOriginalSrc;
        if (oldTrackedSrc && oldTrackedSrc !== currentSrc) {
            console.log(`CS: Image src changed from ${oldTrackedSrc.substring(0, 50)} to ${currentSrc.substring(0, 50)}, re-observing.`);
            if (imageIntersectionObserver) {
                imageIntersectionObserver.unobserve(imgNode);
            }
            imgNode.removeAttribute('data-nsfw-classification');
            imgNode.removeAttribute('data-nsfw-original-src');
            if (processingItems.has(oldTrackedSrc)) {
                processingItems.delete(oldTrackedSrc);
            }
        }

        // If not finally classified, mark as pending and observe
        if (!imgNode.dataset.nsfwClassification || imgNode.dataset.nsfwClassification === 'pending') {
            imgNode.dataset.nsfwClassification = "pending";
            imgNode.dataset.nsfwOriginalSrc = currentSrc; // Track current src for changes and for processingItems
            if (imageIntersectionObserver) {
                imageIntersectionObserver.observe(imgNode);
            }
        } else {
            // Already has a final classification, do nothing unless src changed (handled above)
        }
    }

    function processDomNode(node: Node) {
        if (document.body.classList.contains(BODY_CLASS_DISABLED) || !isFilterGloballyActive) return;

        if (node instanceof HTMLImageElement) {
            processImageNode(node);
        } else if (node instanceof Element && node.querySelectorAll) {
            node.querySelectorAll('img').forEach(img => processImageNode(img));
        }
    }

    function startObservers() {
        if (mutationObserver && imageIntersectionObserver) return; // Already started

        console.log("CS: Starting MutationObserver and IntersectionObserver.");

        // Initialize IntersectionObserver
        if (imageIntersectionObserver) imageIntersectionObserver.disconnect();
        imageIntersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    processAndClassifyImage(entry.target as HTMLImageElement);
                }
            });
        }, {
            root: null,
            rootMargin: '0px 0px 250px 0px', // Start loading when image is 250px from bottom of viewport
            threshold: 0.01
        });

        // Initialize MutationObserver
        if (mutationObserver) mutationObserver.disconnect();
        mutationObserver = new MutationObserver((mutations) => {
            if (!isFilterGloballyActive || document.body.classList.contains(BODY_CLASS_DISABLED)) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processDomNode(node));
                } else if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target instanceof HTMLImageElement) {
                    console.log(`CS Obsrv: Image src attribute changed on:`, mutation.target);
                    processImageNode(mutation.target); // Re-evaluate the image for observation
                }
            }
        });
        mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'], attributeOldValue: false });

        console.log("CS: Performing initial full page scan to observe images...");
        document.querySelectorAll('img').forEach(img => processImageNode(img));
        console.log("CS: Initial scan and observer setup complete.");
    }

    function stopObserversAndReveal() {
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
            console.log("CS: MutationObserver stopped.");
        }
        if (imageIntersectionObserver) {
            imageIntersectionObserver.disconnect();
            imageIntersectionObserver = null;
            console.log("CS: IntersectionObserver stopped.");
        }
        setFilterDisabledVisualState(true);
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
                console.log("CS: Initial state is ON. Activating filter and observers.");
                setFilterDisabledVisualState(false);
                startObservers();
            } else {
                console.log("CS: Initial state is OFF. Filter remains inactive.");
                setFilterDisabledVisualState(true);
            }
        } catch (error) {
            console.error("CS: Error getting initial filter state:", error);
            isFilterGloballyActive = false;
            setFilterDisabledVisualState(true);
        }

        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            console.log(`CS: Received message: ${message?.type}`);
            if (message.type === 'START_FILTERING') {
                isFilterGloballyActive = true;
                setFilterDisabledVisualState(false);
                startObservers();
                sendResponse({ status: 'started' });
            } else if (message.type === 'STOP_FILTERING') {
                isFilterGloballyActive = false;
                stopObserversAndReveal();
                sendResponse({ status: 'stopped' });
            }
            return false;
        });

        console.log("CS: Initialization complete. Message listener attached.");
        chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' });
    }

    initializeFilterState();

})();
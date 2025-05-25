(async () => {
    if ((window as any).nsfwFilterInitialized) return;
    (window as any).nsfwFilterInitialized = true;
    console.log("CS: Initializing NSFW Filter Content Script with Batching & Lazy Loading...");

    let mutationObserver: MutationObserver | null = null;
    let imageIntersectionObserver: IntersectionObserver | null = null;
    let isFilterGloballyActive = false;
    const processingItems = new Set<string>();
    const BODY_CLASS_DISABLED = 'nsfw-filter-disabled';

    const FETCH_QUEUE_MAX_SIZE = 20;
    const FETCH_QUEUE_DEBOUNCE_MS = 200;
    const CLASSIFY_QUEUE_MAX_SIZE = 10;
    const CLASSIFY_QUEUE_DEBOUNCE_MS = 200;

    let fetchQueue: Array<{ imgElement: HTMLImageElement, fetchUrl: string, originalSrc: string, imgReqId: string }> = [];
    let fetchTimeoutId: number | null = null;

    let classifyQueue: Array<{ imgElement: HTMLImageElement, imageDataUrl: string, originalSrc: string, imgReqId: string }> = [];
    let classifyTimeoutId: number | null = null;
    let nextImgReqId = 0;

    function generateImgReqId(): string {
        return `img-${nextImgReqId++}`;
    }

    function setFilterDisabledVisualState(isDisabled: boolean) {
        if (isDisabled) {
            document.body.classList.add(BODY_CLASS_DISABLED);
            console.log("CS: Filter set to OFF visuals.");
        } else {
            document.body.classList.remove(BODY_CLASS_DISABLED);
            console.log("CS: Filter set to ON visuals.");
        }
    }

    async function processFetchQueue() {
        if (fetchTimeoutId) clearTimeout(fetchTimeoutId);
        fetchTimeoutId = null;
        if (fetchQueue.length === 0) return;

        const batchToFetch = [...fetchQueue];
        fetchQueue = []; // Clear queue for next batch

        const urlsToFetch = batchToFetch.map(item => item.fetchUrl);
        console.log(`CS: Processing fetch queue for ${batchToFetch.length} items. URLs:`, urlsToFetch.map(u => u.substring(0, 60)));

        try {
            const response = await chrome.runtime.sendMessage({ type: 'BATCH_FETCH_IMAGE_DATAURLS', urls: urlsToFetch });
            if (response?.status === 'success' && response.results) {
                response.results.forEach((result: { fetchUrl: string, dataUrl: string | null, error?: string }) => {
                    const correspondingItems = batchToFetch.filter(item => item.fetchUrl === result.fetchUrl);
                    correspondingItems.forEach(item => {
                        if (result.dataUrl) {
                            console.log(`CS: Successfully fetched data URL for ${item.originalSrc.substring(0, 60)}`);
                            // Add to classification queue
                            classifyQueue.push({ imgElement: item.imgElement, imageDataUrl: result.dataUrl, originalSrc: item.originalSrc, imgReqId: item.imgReqId });
                            if (classifyQueue.length >= CLASSIFY_QUEUE_MAX_SIZE) {
                                processClassifyQueue();
                            } else if (!classifyTimeoutId) {
                                classifyTimeoutId = window.setTimeout(processClassifyQueue, CLASSIFY_QUEUE_DEBOUNCE_MS);
                            }
                        } else {
                            console.warn(`CS: Failed to fetch data URL for ${item.originalSrc.substring(0, 60)}: ${result.error}`);
                            item.imgElement.dataset.nsfwClassification = "fetch-error";
                            processingItems.delete(item.originalSrc); // Remove from global processing set
                        }
                    });
                });
            } else {
                console.error("CS: BATCH_FETCH_IMAGE_DATAURLS failed or returned invalid response:", response);
                batchToFetch.forEach(item => {
                    item.imgElement.dataset.nsfwClassification = "fetch-error";
                    processingItems.delete(item.originalSrc);
                });
            }
        } catch (error: any) {
            console.error(`CS: Error sending BATCH_FETCH_IMAGE_DATAURLS: ${error.message}`);
            batchToFetch.forEach(item => {
                item.imgElement.dataset.nsfwClassification = "fetch-error";
                processingItems.delete(item.originalSrc);
            });
        }
    }

    async function processClassifyQueue() {
        if (classifyTimeoutId) clearTimeout(classifyTimeoutId);
        classifyTimeoutId = null;
        if (classifyQueue.length === 0) return;

        const batchToClassify = [...classifyQueue];
        classifyQueue = []; // Clear for next batch

        const itemsToClassify = batchToClassify.map(item => ({ imgReqId: item.imgReqId, imageDataUrl: item.imageDataUrl, originalSrc: item.originalSrc }));
        console.log(`CS: Processing classify queue for ${batchToClassify.length} items.`);

        try {
            const response = await chrome.runtime.sendMessage({ type: 'BATCH_CLASSIFY_IMAGE_DATAURLS', items: itemsToClassify });
            if (response?.status === 'success' && response.results) {
                response.results.forEach((result: { imgReqId: string, originalSrc: string, label?: string, error?: string }) => {
                    const item = batchToClassify.find(i => i.imgReqId === result.imgReqId);
                    if (item) {
                        if (result.label) {
                            console.log(`CS: Classified ${item.originalSrc.substring(0, 60)} as: ${result.label}`);
                            item.imgElement.dataset.nsfwClassification = result.label;
                        } else {
                            console.error(`CS: Classification failed for ${item.originalSrc.substring(0, 60)}: ${result.error || 'Unknown classification error'}`);
                            item.imgElement.dataset.nsfwClassification = result.error?.replace('error: ', '') || "cls-error";
                        }
                        processingItems.delete(item.originalSrc);
                    }
                });
            } else {
                console.error("CS: BATCH_CLASSIFY_IMAGE_DATAURLS failed or returned invalid response:", response);
                batchToClassify.forEach(item => {
                    item.imgElement.dataset.nsfwClassification = "cls-batch-error";
                    processingItems.delete(item.originalSrc);
                });
            }
        } catch (error: any) {
            console.error(`CS: Error sending BATCH_CLASSIFY_IMAGE_DATAURLS: ${error.message}`);
            batchToClassify.forEach(item => {
                item.imgElement.dataset.nsfwClassification = "cls-batch-error";
                processingItems.delete(item.originalSrc);
            });
        }
    }

    // This function is called when an image is ready to be processed (e.g., visible, loaded)
    async function stageImageForProcessing(imgElement: HTMLImageElement): Promise<void> {
        if (!isFilterGloballyActive) return;

        const originalSrc = imgElement.dataset.nsfwOriginalSrc || imgElement.getAttribute('src');
        if (!originalSrc || processingItems.has(originalSrc)) return;

        if (imgElement.dataset.nsfwClassification && imgElement.dataset.nsfwClassification !== "pending") {
            return; // Already finally classified
        }

        console.log(`CS: Staging for processing: ${originalSrc.substring(0, 100)}`);
        processingItems.add(originalSrc);
        imgElement.dataset.nsfwOriginalSrc = originalSrc; // Ensure it's set
        imgElement.dataset.nsfwClassification = "pending";
        const imgReqId = generateImgReqId();

        let fetchableUrl = originalSrc;
        // let needsFetching = true;
        let fetchError = null;

        if (originalSrc.startsWith('data:image')) {
            // needsFetching = false;
            // Add directly to classification queue
            classifyQueue.push({ imgElement, imageDataUrl: originalSrc, originalSrc, imgReqId });
            if (classifyQueue.length >= CLASSIFY_QUEUE_MAX_SIZE) {
                processClassifyQueue();
            } else if (!classifyTimeoutId) {
                classifyTimeoutId = window.setTimeout(processClassifyQueue, CLASSIFY_QUEUE_DEBOUNCE_MS);
            }
        } else {
            const isPotentiallyRelative = originalSrc.startsWith('./') || originalSrc.startsWith('../') || originalSrc.startsWith('/');
            if (isPotentiallyRelative) {
                try {
                    fetchableUrl = new URL(originalSrc, document.baseURI).href;
                } catch (e) {
                    fetchError = `Invalid relative URL: ${originalSrc}`;
                }
            }

            if (!fetchError && (fetchableUrl.startsWith('http:') || fetchableUrl.startsWith('https:') || fetchableUrl.startsWith('blob:') || fetchableUrl.startsWith('chrome-extension:'))) {
                fetchQueue.push({ imgElement, fetchUrl: fetchableUrl, originalSrc, imgReqId });
                if (fetchQueue.length >= FETCH_QUEUE_MAX_SIZE) {
                    processFetchQueue();
                } else if (!fetchTimeoutId) {
                    fetchTimeoutId = window.setTimeout(processFetchQueue, FETCH_QUEUE_DEBOUNCE_MS);
                }
            } else {
                fetchError = fetchError || `Skipping image with non-fetchable src scheme: ${fetchableUrl.substring(0, 100)}`;
            }
        }

        if (fetchError) {
            console.warn(`CS: ${fetchError} for original src ${originalSrc}`);
            imgElement.dataset.nsfwClassification = "stage-fetch-error";
            processingItems.delete(originalSrc);
        }
    }

    async function processAndClassifyImage(imgElement: HTMLImageElement) {
        if (imageIntersectionObserver) {
            imageIntersectionObserver.unobserve(imgElement);
        }

        const currentSrc = imgElement.dataset.nsfwOriginalSrc || imgElement.getAttribute('src');
        if (!currentSrc || (imgElement.dataset.nsfwClassification && imgElement.dataset.nsfwClassification !== 'pending')) {
            return;
        }

        if (imgElement.complete && imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0) {
            await stageImageForProcessing(imgElement);
        } else if (!imgElement.complete && currentSrc) {
            const nsfwOriginalSrcForListeners = currentSrc;
            const onLoad = async () => {
                cleanupListeners();
                if (imgElement.naturalWidth > 0 && imgElement.naturalHeight > 0) {
                    await stageImageForProcessing(imgElement);
                } else {
                    imgElement.dataset.nsfwClassification = 'zero-dimensions';
                    processingItems.delete(nsfwOriginalSrcForListeners);
                }
            };
            const onError = () => {
                cleanupListeners();
                console.warn(`CS: Image native load error (after intersection): ${imgElement.src?.substring(0, 100)}`);
                imgElement.dataset.nsfwClassification = 'native-load-error';
                processingItems.delete(nsfwOriginalSrcForListeners);
            };
            const cleanupListeners = () => {
                imgElement.removeEventListener('load', onLoad);
                imgElement.removeEventListener('error', onError);
            };
            imgElement.addEventListener('load', onLoad);
            imgElement.addEventListener('error', onError);
        } else if (currentSrc) {
            imgElement.dataset.nsfwClassification = 'zero-dimensions';
            processingItems.delete(currentSrc);
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

        if (!imgNode.dataset.nsfwClassification || imgNode.dataset.nsfwClassification === 'pending') {
            imgNode.dataset.nsfwClassification = "pending";
            imgNode.dataset.nsfwOriginalSrc = currentSrc;
            if (imageIntersectionObserver) {
                imageIntersectionObserver.observe(imgNode);
            }
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
        if (mutationObserver && imageIntersectionObserver) return;

        console.log("CS: Starting MutationObserver and IntersectionObserver.");
        
        if (imageIntersectionObserver) imageIntersectionObserver.disconnect();
        imageIntersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    processAndClassifyImage(entry.target as HTMLImageElement);
                }
            });
        }, {
            root: null, 
            rootMargin: '0px 0px 250px 0px',
            threshold: 0.01 
        });

        if (mutationObserver) mutationObserver.disconnect();
        mutationObserver = new MutationObserver((mutations) => {
            if (!isFilterGloballyActive || document.body.classList.contains(BODY_CLASS_DISABLED)) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processDomNode(node));
                } else if (mutation.type === 'attributes' && mutation.attributeName === 'src' && mutation.target instanceof HTMLImageElement) {
                    console.log(`CS Obsrv: Image src attribute changed on:`, mutation.target);
                    processImageNode(mutation.target);
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
        // Clear any pending timeouts for queues
        if (fetchTimeoutId) clearTimeout(fetchTimeoutId);
        fetchTimeoutId = null;
        if (classifyTimeoutId) clearTimeout(classifyTimeoutId);
        classifyTimeoutId = null;
        // Clear queues and processing items
        fetchQueue = [];
        classifyQueue = [];
        processingItems.clear();

        setFilterDisabledVisualState(true);
        console.log("CS: Removing all NSFW classification attributes for cleanup...");
        document.querySelectorAll('[data-nsfw-classification]').forEach(el => {
            el.removeAttribute('data-nsfw-classification');
            el.removeAttribute('data-nsfw-original-src');
        });
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
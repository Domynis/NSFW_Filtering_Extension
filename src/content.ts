// content.ts

(async () => {
    // Initialization guard
    if ((window as any).nsfwFilterInitialized) return;
    (window as any).nsfwFilterInitialized = true;
    console.log("CS: Initializing NSFW Filter Content Script (Hide First)...");

    let observer: MutationObserver | null = null;
    let isFilterGloballyActive = false;

    // --- State Tracking ---
    // No need to store styles anymore, CSS handles it via data attributes
    // const modifiedImages = new Map<HTMLImageElement, { filter: string; opacity: string }>();
    const processingItems = new Set<string>(); // Use originalSrc for images/bg, unique key for video

    // --- Body Class Management ---
    const BODY_CLASS_ACTIVE = 'nsfw-filter-active';
    function setFilterActiveStyles(isActive: boolean) {
        if (isActive) {
            document.body.classList.add(BODY_CLASS_ACTIVE);
            console.log("CS: Added body class:", BODY_CLASS_ACTIVE);
        } else {
            document.body.classList.remove(BODY_CLASS_ACTIVE);
            console.log("CS: Removed body class:", BODY_CLASS_ACTIVE);
        }
    }

    // --- Classification Request ---
    async function requestClassification(imgElement: HTMLImageElement): Promise<void> {
        if (!isFilterGloballyActive) return;

        const originalSrc = imgElement.getAttribute('src');
        if (!originalSrc || processingItems.has(originalSrc)) return; // Check processing

        // Check if classification is already final (set by CSS or previous run)
        if (imgElement.dataset.nsfwClassification && imgElement.dataset.nsfwClassification !== "pending") {
            return;
        }

        console.log(`CS: Requesting classification for: ${originalSrc.substring(0, 100)}`);
        processingItems.add(originalSrc);
        imgElement.dataset.nsfwOriginalSrc = originalSrc; // Keep original src reference
        imgElement.dataset.nsfwClassification = "pending"; // Mark as pending for CSS

        // --- Get Image Data URL --- (Keep existing logic)
        let imageDataSource: string | null = null;
        let fetchError: string | null = null;
        const isLocalPathFlag = originalSrc.startsWith('./') || originalSrc.startsWith('../') || originalSrc.startsWith('/');
        let fetchUrl = originalSrc;

        if (originalSrc.startsWith('data:image')) {
            imageDataSource = originalSrc;
        } else if (isLocalPathFlag || originalSrc.startsWith('http:') || originalSrc.startsWith('https:')) {
            if (isLocalPathFlag) {
                try { fetchUrl = new URL(originalSrc, document.baseURI).href; }
                catch (e) { fetchError = `Invalid relative URL: ${originalSrc}`; console.error(fetchError); processingItems.delete(originalSrc); imgElement.dataset.nsfwClassification = "fetch-error"; return; }
            }
            console.log(`CS: Requesting data URL via background for URL: ${fetchUrl.substring(0, 100)}`);
            try {
                const response = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_DATAURL', url: fetchUrl, isLocalPath: isLocalPathFlag });
                if (response?.status === 'success' && response.dataUrl) {
                    imageDataSource = response.dataUrl;
                } else { fetchError = `Failed to get data URL: ${response?.message || 'Unknown BG error'}`; console.error(`CS: ${fetchError} for ${originalSrc}`); }
            } catch (error: any) { fetchError = `Error communicating with BG for fetch: ${error.message}`; console.error(`CS: ${fetchError} for ${originalSrc}`); }
        } else {
            console.log(`CS: Skipping image with non-fetchable src: ${originalSrc.substring(0, 100)}`);
            processingItems.delete(originalSrc);
            imgElement.dataset.nsfwClassification = "fetch-error"; // Mark as error to reveal
            return;
        }

        // --- Send for Classification ---
        if (imageDataSource) {
            console.log(`CS: Sending image data (src: ${originalSrc.substring(0, 100)}) to background...`);
            try {
                chrome.runtime.sendMessage(
                    { type: 'CLASSIFY_IMAGE_DATAURL', imageDataUrl: imageDataSource, originalUrl: originalSrc /* Pass original URL for caching */ },
                    (response) => {
                        processingItems.delete(originalSrc); // Done processing this item
                        if (chrome.runtime.lastError) {
                            console.error(`CS: Error receiving classification for ${originalSrc.substring(0, 100)}: ${chrome.runtime.lastError.message}`);
                            imgElement.dataset.nsfwClassification = "comm-error"; // Set final status for CSS
                            return;
                        }

                        let finalLabel = "error"; // Default to error
                        if (response?.status === 'success') {
                            finalLabel = response.label || "unknown";
                            console.log(`CS: Received classification for ${originalSrc.substring(0, 100)}: ${finalLabel}`);
                        } else {
                            finalLabel = response?.message?.startsWith('error:') ? response.message.replace('error: ', '') : "bg-error";
                            console.error(`CS: Background classification failed for ${originalSrc.substring(0, 100)}: ${response?.message || 'Unknown error'}`);
                        }
                        // ** SET FINAL STATUS VIA DATA ATTRIBUTE FOR CSS **
                        imgElement.dataset.nsfwClassification = finalLabel;
                    }
                );
            } catch (error: any) {
                console.error(`CS: Sync error sending classification msg for ${originalSrc.substring(0, 100)}: ${error.message}`);
                imgElement.dataset.nsfwClassification = "send-error"; // Set final status
                processingItems.delete(originalSrc);
            }
        } else {
            // Handle data URL fetch failure
            console.log(`CS: No image data source for ${originalSrc.substring(0, 100)}.`);
            imgElement.dataset.nsfwClassification = "fetch-error"; // Set final status
            processingItems.delete(originalSrc);
        }
    } // End requestClassification

    // --- Remove Styling Functions (CSS Handles This) ---
    // function applyNsfwStyle(...) { /* DELETE */ }
    // function revertImageStyle(...) { /* DELETE */ }

    // --- Node Processing (Simplified) ---
    function processNode(node: Node) {
        if (!isFilterGloballyActive) return;

        if (node instanceof HTMLImageElement) {
            // Set initial pending state if src exists and not already classified
            if (node.getAttribute('src') && (!node.dataset.nsfwClassification || node.dataset.nsfwClassification === 'pending')) {
                node.dataset.nsfwClassification = "pending"; // Ensure pending state for CSS
            }
            // Request classification if ready, otherwise setup listeners
            if (node.complete && node.naturalWidth > 0 && node.naturalHeight > 0) {
                requestClassification(node);
            } else if (!node.complete && node.getAttribute('src')) {
                const onLoad = () => {
                    cleanupListeners();
                    if (node.naturalWidth > 0 && node.naturalHeight > 0) {
                        requestClassification(node);
                    } else { node.dataset.nsfwClassification = 'zero-dimensions'; processingItems.delete(node.getAttribute('src') || ''); }
                };
                const onError = () => {
                    cleanupListeners();
                    console.warn(`CS: Image load error: ${node.src?.substring(0, 100)}`);
                    node.dataset.nsfwClassification = 'native-load-error'; // Reveal on error
                    processingItems.delete(node.getAttribute('src') || '');
                };
                const cleanupListeners = () => {
                    node.removeEventListener('load', onLoad);
                    node.removeEventListener('error', onError);
                };
                node.addEventListener('load', onLoad);
                node.addEventListener('error', onError);
            } else if (node.getAttribute('src')) { // Is complete but zero dimensions
                node.dataset.nsfwClassification = 'zero-dimensions';
            }
        } else if (node instanceof Element && node.querySelectorAll) {
            // Recursively check children
            node.querySelectorAll('img').forEach(img => processNode(img));
            // Add video/background processing back here if needed, applying similar logic
            // e.g., node.querySelectorAll('video').forEach(vid => processVideoNode(vid));
            // e.g., node.querySelectorAll('*').forEach(el => processBackgroundStyleNode(el));
        }
    } // End processNode

    // --- Mutation Observer (Simplified Attribute Handling) ---
    function startObserver() {
        if (observer) return;
        console.log("CS: Starting MutationObserver (Hide First)...");
        observer = new MutationObserver((mutations) => {
            if (!isFilterGloballyActive) return;
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => processNode(node));
                } else if (mutation.type === 'attributes') {
                    if (mutation.attributeName === 'src' && mutation.target instanceof HTMLImageElement) {
                        const targetElement = mutation.target;
                        const oldSrc = mutation.oldValue;
                        console.log(`CS Obsrv: Image src changed:`, targetElement);
                        if (oldSrc) processingItems.delete(oldSrc); // Clear old item from processing
                        // Reset status attribute to trigger reprocessing/re-hiding by CSS
                        targetElement.removeAttribute('data-nsfw-classification');
                        targetElement.removeAttribute('data-nsfw-original-src');
                        // Re-run processing logic for the node
                        processNode(targetElement);
                    }
                    // Add similar handling for video src/currentSrc if needed
                    // Add handling for style/class changes if background images are processed
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src' /*, 'style', 'class', 'currentSrc' */], attributeOldValue: true });

        console.log("CS: Performing initial image scan (Hide First)...");
        document.querySelectorAll('img').forEach(img => processNode(img));
        // Add initial scan for video/backgrounds if re-added
        console.log("CS: Initial scan complete.");
    } // End startObserver

    // --- Stop Observer (Simplified) ---
    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
            console.log("CS: Observer stopped.");
        }
        // Remove body class to deactivate CSS rules
        setFilterActiveStyles(false);
        // Revert styles by removing the data attribute
        console.log("CS: Removing classification attributes...");
        document.querySelectorAll('[data-nsfw-classification]').forEach(el => {
            el.removeAttribute('data-nsfw-classification');
            el.removeAttribute('data-nsfw-original-src');
        });
        processingItems.clear();
        console.log("CS: Filtering stopped, attributes removed.");
    }

    // --- Initialization and Message Handling (Simplified) ---
    async function initialize() {
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            console.log(`CS: Received message: ${message?.type}`);
            if (message.type === 'START_FILTERING') {
                isFilterGloballyActive = true;
                setFilterActiveStyles(true); // Activate CSS rules
                startObserver(); // Start processing
                sendResponse({ status: 'started' });
            } else if (message.type === 'STOP_FILTERING') {
                isFilterGloballyActive = false;
                // stopObserver() already calls setFilterActiveStyles(false)
                stopObserver(); // Stop processing and deactivate CSS/revert attributes
                sendResponse({ status: 'stopped' });
            }
            return false;
        });
        console.log("CS: Initialization complete. Listening.");

        // Optional: Check initial state on load?
        // If the filter might be active *before* the first START_FILTERING message arrives
        // (e.g., due to page reload while filter was on), you might need an initial check.
        // However, the background script usually sends START_FILTERING on page load if needed.
    }

    initialize();

})(); // End IIFE
const path = require('path');

// It's tricky to get the extension ID programmatically in a stable way before the browser launches
// and the extension is fully loaded. For MV3, the service worker target is key.
// This helper will try to find it once the browser is up.
// Store it globally within the test run if found.
let EXTENSION_ID = null;

async function getExtensionServiceWorker(browserInstance) {
    if (!EXTENSION_ID) {
        // Poll for the service worker target for a few seconds
        const startTime = Date.now();
        const timeout = 5000; // Poll for 5 seconds
        while (Date.now() - startTime < timeout) {
            const targets = await browserInstance.targets();
            const extensionTarget = targets.find(target =>
                target.type() === 'service_worker' && target.url().includes('background.js')
            );
            if (extensionTarget) {
                EXTENSION_ID = new URL(extensionTarget.url()).hostname;
                console.log(`Discovered Extension ID: ${EXTENSION_ID} via URL: ${extensionTarget.url()}`);
                // Now that we have the ID, find the specific worker instance
                const worker = await extensionTarget.worker();
                if (worker) return worker;
                // If worker is null, it might be activating, try again
            }
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retrying
        }

        // If still not found after polling
        const finalTargets = await browserInstance.targets();
        console.error("Failed to find extension service worker after polling. Available targets:",
            finalTargets.map(t => ({ type: t.type(), url: t.url(), id: t.targetId() }))
        );
        throw new Error("Could not find the extension's service worker target (background.js) after polling. Ensure the extension is loaded and active.");
    }

    // If EXTENSION_ID was found previously in this test run, try to get the worker directly
    const workerTarget = await browserInstance.targets().find(target =>
        target.type() === 'service_worker' &&
        target.url().startsWith(`chrome-extension://${EXTENSION_ID}/`) &&
        target.url().includes('background.js')
    );

    if (!workerTarget) {
        const currentTargets = await browserInstance.targets();
        console.error(`Post-discovery: Service worker for known ID ${EXTENSION_ID} (background.js) not found. Available targets:`,
            currentTargets.map(t => ({ type: t.type(), url: t.url(), id: t.targetId() }))
        );
        throw new Error(`Post-discovery: Service worker for extension ID ${EXTENSION_ID} (background.js) not found.`);
    }
    const worker = await workerTarget.worker();
    if (!worker) throw new Error('Post-discovery: Could not connect to the service worker.');
    return worker;
}

async function getStorageState(key) {
    const worker = await getExtensionServiceWorker(browser); // browser is global from jest-puppeteer
    return worker.evaluate((k) => chrome.storage.local.get(k), key);
}

async function sendMessageToExtension(message) {
    const worker = await getExtensionServiceWorker(browser);
    // Note: Service workers don't have a direct `chrome.runtime.sendMessage` equivalent for *receiving* from self in the same way.
    // However, evaluating a send from a context that *can* send (like a content script or another extension page if you had one) works.
    // For simplicity, and given background.js listens to chrome.runtime.onMessage, we can execute a self-send
    // or more directly, call the internal functions if they were exposed (but that's less E2E).
    // The most E2E way to simulate popup interaction is to have the background script functions callable or message it.
    // Here, we directly call setFilterState or simulate the message that would trigger it.
    await worker.evaluate((msg) => {
        // This relies on chrome.runtime.sendMessage being available and your background script listening.
        // This is effectively the content script or popup sending a message to the background.
        return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(msg, response => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve(response);
            });
        });
    }, message);
}

async function setFilterActiveState(isActive) {
    // This simulates the action that the popup or other UI would perform.
    // It directly messages the background script as the popup does.
    await sendMessageToExtension({ type: 'TOGGLE_FILTER', active: isActive });
    // Add a small delay for the background script and content scripts to react.
    // More robust would be to poll for a specific change (e.g. storage or a DOM attribute).
    await page.waitForTimeout(1500); // Adjust as necessary
}

describe('NSFW Filter E2E Tests', () => {
    const testPagePath = `file://${path.join(__dirname, 'test-pages', 'sample-page.html')}`;

    beforeEach(async () => {
        // page is a global provided by jest-puppeteer
        // Reset filter state to inactive before each test for consistency
        await setFilterActiveState(false);
        await page.goto(testPagePath, { waitUntil: 'networkidle0' });
    });

    it('should have filter initially inactive and images visible', async () => {
        const initialStorage = await getStorageState('isFilterActive');
        expect(initialStorage.isFilterActive).toBe(false);

        const bodyClass = await page.$eval('body', body => body.classList.contains('nsfw-filter-disabled'));
        expect(bodyClass).toBe(true);

        // Check if an image known to be NSFW is visible (or rather, not hidden by classification)
        const nsfwImage = await page.$('#imageNsfwPorn1');
        expect(nsfwImage).toBeTruthy();
        const classification = await nsfwImage.evaluate(img => img.dataset.nsfwClassification);
        expect(classification).toBeUndefined(); // No classification attributes when inactive
    });

    it('should activate filter, hide/classify NSFW images, and keep SFW images visible', async () => {
        await setFilterActiveState(true);

        const storage = await getStorageState('isFilterActive');
        expect(storage.isFilterActive).toBe(true);

        const bodyClass = await page.$eval('body', body => body.classList.contains('nsfw-filter-disabled'));
        expect(bodyClass).toBe(false);

        // Wait for content script to process images. This might need adjustment.
        await page.waitForTimeout(3000); // Increased wait for batching and classification

        const sfwImageClass = await page.$eval('#imageSfw1', img => img.dataset.nsfwClassification);
        expect(['neutral', 'drawing', 'sexy', 'pending']).toContain(sfwImageClass); // 'pending' if still processing, or actual SFW class
        // For a more robust test, wait for classification not to be 'pending'
        await page.waitForFunction(
            (selector) => document.querySelector(selector)?.dataset.nsfwClassification !== 'pending',
            { timeout: 5000 }, // wait up to 5s
            '#imageSfw1'
        );
        const sfwImageFinalClass = await page.$eval('#imageSfw1', img => img.dataset.nsfwClassification);
        expect(['neutral', 'drawing', 'sexy']).toContain(sfwImageFinalClass);


        await page.waitForFunction(
            (selector) => document.querySelector(selector)?.dataset.nsfwClassification !== 'pending',
            { timeout: 5000 }, // wait up to 5s
            '#imageNsfwPorn1'
        );
        const nsfwPornImageClass = await page.$eval('#imageNsfwPorn1', img => img.dataset.nsfwClassification);
        expect(['porn', 'hentai']).toContain(nsfwPornImageClass); // Assuming model classifies placeholder text

        await page.waitForFunction(
            (selector) => document.querySelector(selector)?.dataset.nsfwClassification !== 'pending',
            { timeout: 5000 }, // wait up to 5s
            '#imageNsfwHentai1'
        );
        const nsfwHentaiImageClass = await page.$eval('#imageNsfwHentai1', img => img.dataset.nsfwClassification);
        expect(['porn', 'hentai']).toContain(nsfwHentaiImageClass);
    });

    it('should correctly classify lazy-loaded images after scroll when filter is active', async () => {
        await setFilterActiveState(true);

        const lazyNsfwImage = await page.$('#lazyImageNsfwPorn2');
        let lazyNsfwClass = await lazyNsfwImage.evaluate(img => img.dataset.nsfwClassification);
        // It should be 'pending' as it's observed by IntersectionObserver but not yet processed by model
        expect(lazyNsfwClass).toBe('pending');

        // Scroll to the bottom to make lazy loaded images visible
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

        // Wait for IntersectionObserver, batching, and classification
        // This combines waiting for the specific image to no longer be pending.
        await page.waitForFunction(
            (selector) => {
                const el = document.querySelector(selector);
                return el && el.dataset.nsfwClassification && el.dataset.nsfwClassification !== 'pending';
            },
            { timeout: 7000 }, // Increased timeout for full pipeline
            '#lazyImageNsfwPorn2'
        );

        lazyNsfwClass = await page.$eval('#lazyImageNsfwPorn2', img => img.dataset.nsfwClassification);
        expect(['porn', 'hentai']).toContain(lazyNsfwClass);

        // Check a lazy-loaded SFW image too
        await page.waitForFunction(
            (selector) => {
                const el = document.querySelector(selector);
                return el && el.dataset.nsfwClassification && el.dataset.nsfwClassification !== 'pending';
            },
            { timeout: 7000 },
            '#lazyImageSfwNeutral2'
        );
        const lazySfwClass = await page.$eval('#lazyImageSfwNeutral2', img => img.dataset.nsfwClassification);
        expect(['neutral', 'drawing', 'sexy']).toContain(lazySfwClass);
    });

    it('should deactivate filter and remove classifications/disabled class', async () => {
        // First, activate and let it classify something
        await setFilterActiveState(true);
        await page.waitForTimeout(3000); // time for classification
        const nsfwPornImageClassInitial = await page.$eval('#imageNsfwPorn1', img => img.dataset.nsfwClassification);
        expect(['porn', 'hentai', 'pending']).toContain(nsfwPornImageClassInitial); // It should have some classification

        // Now, deactivate
        await setFilterActiveState(false);

        const storage = await getStorageState('isFilterActive');
        expect(storage.isFilterActive).toBe(false);

        // Content script should remove attributes and add nsfw-filter-disabled to body
        // This might take a moment for the message to propagate and DOM to update.
        await page.waitForFunction(
            () => document.body.classList.contains('nsfw-filter-disabled'),
            { timeout: 2000 }
        );
        const bodyClass = await page.$eval('body', body => body.classList.contains('nsfw-filter-disabled'));
        expect(bodyClass).toBe(true);

        const nsfwPornImageClassAfter = await page.$eval('#imageNsfwPorn1', img => img.dataset.nsfwClassification);
        expect(nsfwPornImageClassAfter).toBeUndefined(); // Classifications should be removed by stopObserverAndReveal
    });

}); 
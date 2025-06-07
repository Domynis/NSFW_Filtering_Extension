/// <reference types="@types/chrome" />
import 'expect-puppeteer';
import { Browser, Page, Target } from 'puppeteer';

declare const page: Page;
declare const browser: Browser;

const TEST_PAGE_ROOT = 'http://localhost:3000/e2e/test_pages/';
const TEST_PAGE_NEUTRAL_URL = TEST_PAGE_ROOT + 'test-neutral.html';
const TEST_PAGE_PORN_URL = TEST_PAGE_ROOT + 'test-porn.html';
const TEST_PAGE_SEXY_URL = TEST_PAGE_ROOT + 'test-sexy.html';
const TEST_PAGE_HENTAI_URL = TEST_PAGE_ROOT + 'test-hentai.html';
const TEST_PAGE_DRAWING_URL = TEST_PAGE_ROOT + 'test-drawing.html';

describe('NSFW Filtering Extension', () => {
    beforeAll(async () => {
        const extensionTarget = await browser.waitForTarget(
            (target: Target) => target.type() === 'service_worker'
        );
        const serviceWorker = await extensionTarget.worker();

        if (!serviceWorker) {
            throw new Error("Service worker not found.");
        }

        await serviceWorker.evaluate(() => {
            chrome.storage.local.set({ isFilterActive: true });
        });
    });

    it('should classify as neutral', async () => {
        await page.goto(TEST_PAGE_NEUTRAL_URL, { waitUntil: 'networkidle0' });

        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll('img'));
            if (images.length === 0 || images.some(img => !img.hasAttribute('data-nsfw-classification'))) {
                return false;
            }
            return images.every(img => img.getAttribute('data-nsfw-classification') !== 'pending');
        }, { timeout: 15000 });

        const classifications = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => img.getAttribute('data-nsfw-classification'));
        });

        classifications.forEach(classification => {
            console.log(`Image classified as: ${classification}`);
            expect(['neutral']).toContain(classification);
        });
    });

    it('should classify as porn', async () => {
        await page.goto(TEST_PAGE_PORN_URL, { waitUntil: 'networkidle0' });

        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll('img'));
            if (images.length === 0 || images.some(img => !img.hasAttribute('data-nsfw-classification'))) {
                return false;
            }
            return images.every(img => img.getAttribute('data-nsfw-classification') !== 'pending');
        }, { timeout: 15000 });

        const classifications = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => img.getAttribute('data-nsfw-classification'));
        });

        classifications.forEach(classification => {
            console.log(`Image classified as: ${classification}`);
            expect(['porn']).toContain(classification);
        });
    });

    it('should classify as sexy', async () => {
        await page.goto(TEST_PAGE_SEXY_URL, { waitUntil: 'networkidle0' });

        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll('img'));
            if (images.length === 0 || images.some(img => !img.hasAttribute('data-nsfw-classification'))) {
                return false;
            }
            return images.every(img => img.getAttribute('data-nsfw-classification') !== 'pending');
        }, { timeout: 15000 }); // Wait up to 15 seconds

        const classifications = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => img.getAttribute('data-nsfw-classification'));
        });

        classifications.forEach(classification => {
            console.log(`Image classified as: ${classification}`);
            expect(['sexy']).toContain(classification);
        });
    });

    it('should classify as hentai', async () => {
        await page.goto(TEST_PAGE_HENTAI_URL, { waitUntil: 'networkidle0' });

        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll('img'));
            if (images.length === 0 || images.some(img => !img.hasAttribute('data-nsfw-classification'))) {
                return false;
            }
            return images.every(img => img.getAttribute('data-nsfw-classification') !== 'pending');
        }, { timeout: 15000 });

        const classifications = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => img.getAttribute('data-nsfw-classification'));
        });

        classifications.forEach(classification => {
            console.log(`Image classified as: ${classification}`);
            expect(['hentai']).toContain(classification);
        });
    });

    it('should classify as drawing', async () => {
        await page.goto(TEST_PAGE_DRAWING_URL, { waitUntil: 'networkidle0' });

        await page.waitForFunction(() => {
            const images = Array.from(document.querySelectorAll('img'));
            if (images.length === 0 || images.some(img => !img.hasAttribute('data-nsfw-classification'))) {
                return false;
            }
            return images.every(img => img.getAttribute('data-nsfw-classification') !== 'pending');
        }, { timeout: 15000 });

        const classifications = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => img.getAttribute('data-nsfw-classification'));
        });

        classifications.forEach(classification => {
            console.log(`Image classified as: ${classification}`);
            expect(['drawing']).toContain(classification);
        });
    });
});
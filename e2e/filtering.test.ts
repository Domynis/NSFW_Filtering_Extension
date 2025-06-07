import 'expect-puppeteer';
import { Page } from 'puppeteer';

const TEST_PAGE_URL = 'http://localhost:3000/e2e/test.html';

declare const page: Page;

describe('NSFW Filtering Extension', () => {
    beforeAll(async () => {
        await page.goto(TEST_PAGE_URL, { waitUntil: 'networkidle0' });
    });

    it('should blur images on the test page', async () => {
        // Wait for the content script to add the classification attribute
        await expect(page).toMatchElement('img[data-nsfw-classification]');

        // Get the classification of all images
        const classifications = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            return images.map(img => img.getAttribute('data-nsfw-classification'));
        });

        // Verify that all images have been classified as 'drawing' or 'neutral'
        classifications.forEach(classification => {
            expect(['drawing', 'neutral']).toContain(classification);
        });
    });
});
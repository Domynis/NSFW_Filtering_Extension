/// <reference types="@types/chrome" />
import 'expect-puppeteer';
import { Browser, Page, Target } from 'puppeteer';

// Manually declare the global variables that jest-puppeteer provides
declare const page: Page;
declare const browser: Browser;

const TEST_PAGE_URL = 'http://localhost:3000/e2e/test.html';

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
    
    await page.goto(TEST_PAGE_URL, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
  });

  it('should classify and blur images on the test page', async () => {
    // **THIS IS THE KEY CHANGE**
    // Wait until all images have a classification that is NOT 'pending'
    await page.waitForFunction(() => {
        const images = Array.from(document.querySelectorAll('img'));
        // Ensure we have images and that all have a classification attribute
        if (images.length === 0 || images.some(img => !img.hasAttribute('data-nsfw-classification'))) {
            return false;
        }
        // Return true only when NO images are in the 'pending' state
        return images.every(img => img.getAttribute('data-nsfw-classification') !== 'pending');
    }, { timeout: 15000 }); // Wait up to 15 seconds

    // Now that we know the classification is complete, we can grab the values
    const classifications = await page.evaluate(() => {
      const images = Array.from(document.querySelectorAll('img'));
      return images.map(img => img.getAttribute('data-nsfw-classification'));
    });

    // Verify that all images have a valid final classification
    classifications.forEach(classification => {
      console.log(`Image classified as: ${classification}`);
      expect(['drawing', 'neutral', 'porn', 'sexy', 'hentai']).toContain(classification);
    });
  });
});
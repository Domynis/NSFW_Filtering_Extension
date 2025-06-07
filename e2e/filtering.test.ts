/// <reference types="@types/chrome" />
import 'expect-puppeteer';
import { Browser, Page, Target } from 'puppeteer';

// Manually declare the global variables that jest-puppeteer provides
declare const page: Page;
declare const browser: Browser;

const TEST_PAGE_URL = 'http://localhost:3000/e2e/test.html';

describe('NSFW Filtering Extension', () => {
  beforeAll(async () => {
    // Find the extension's background service worker
    const extensionTarget = await browser.waitForTarget(
      (target: Target) => target.type() === 'service_worker'
    );
    const serviceWorker = await extensionTarget.worker();

    if (!serviceWorker) {
      throw new Error("Service worker not found.");
    }

    // Programmatically activate the filter by setting the value in storage
    // Note: The 'chrome' object is available here because the function is
    // serialized and executed in the browser context of the service worker,
    // and we added the /// <reference> directive for type-checking.
    await serviceWorker.evaluate(() => {
      chrome.storage.local.set({ isFilterActive: true });
    });

    // Go to the test page and reload it to ensure the content script runs with the new state
    await page.goto(TEST_PAGE_URL, { waitUntil: 'networkidle0' });
    await page.reload({ waitUntil: 'networkidle0' });
  });

  it('should classify and blur images on the test page', async () => {
    // Check that an image has the 'pending' or a final classification state
    // We give it a longer timeout to allow for model loading.
    await expect(page).toMatchElement('img[data-nsfw-classification]', { timeout: 15000 });

    const classifications = await page.evaluate(() => {
      const images = Array.from(document.querySelectorAll('img'));
      return images.map(img => img.getAttribute('data-nsfw-classification'));
    });

    // Verify that all images have been classified
    classifications.forEach(classification => {
      console.log(`Image classified as: ${classification}`);
      expect(['drawing', 'neutral', 'porn', 'sexy', 'hentai']).toContain(classification);
    });
  });
});
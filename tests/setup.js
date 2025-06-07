// tests/setup.js

// You can add global setup for your tests here if needed.
// For example, extending expect with custom matchers or setting up global variables.

// jest-puppeteer automatically provides `browser` and `page` globals
// when using its preset and environment.

// If you need to find your extension ID reliably:
// This is a common challenge. One way is to get it after the browser launches.
/*
global.getExtensionId = async () => {
  if (global.extensionId) return global.extensionId;

  const targets = await browser.targets();
  // Find the service worker target associated with your extension
  // This might require knowing a unique path or identifier from your manifest
  const extensionTarget = targets.find(target => {
    return target.type() === 'service_worker' && target.url().startsWith('chrome-extension://');
  });

  if (!extensionTarget) {
    throw new Error("Could not find extension's service worker target. Ensure the extension is loaded.");
  }
  const url = extensionTarget.url();
  global.extensionId = url.split('/')[2]; // Extract ID from chrome-extension://<ID>/background.js
  console.log('Detected Extension ID:', global.extensionId);
  return global.extensionId;
};
*/ 
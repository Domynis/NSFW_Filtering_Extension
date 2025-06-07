const path = require('path');

// Use path.resolve for a more robust absolute path
const EXTENSION_PATH = path.resolve(__dirname, 'dist'); 
console.log(`[jest-puppeteer.config.cjs] Attempting to load extension from: ${EXTENSION_PATH}`); // Add log

module.exports = {
  launch: {
    headless: false, // 'new' for new headless, false for headed (useful for debugging)
    devtools: true, // This will open a devtools window for the browser itself
    args: [
      `--load-extension=${EXTENSION_PATH}`, // Load our extension first
      `--disable-extensions-except=${EXTENSION_PATH}`, // Then disable others
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--remote-debugging-port=0', // Assign a random available port for debugging
      // Temporarily remove --disable-extensions-except to see if it's interfering
      // '--no-sandbox', // Keep if running in CI, but test without locally if it causes issues
      // '--disable-setuid-sandbox', // Keep if running in CI
      // '--enable-logging=stderr', // Might give more Chrome internal logs
      // '--v=1' // Verbose logging
    ],
    dumpio: true, // Dumps browser process stdout and stderr into process.stdout and process.stderr
  },
  browserContext: 'default',
}; 
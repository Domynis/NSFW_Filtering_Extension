const { resolve } = require('path');
const EXTENSION_PATH = resolve(__dirname, 'dist');

module.exports = {
  launch: {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  },
  server: {
    command: 'npx serve -l 3000',
    port: 3000,
    launchTimeout: 10000,
  },
};
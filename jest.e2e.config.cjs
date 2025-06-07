module.exports = {
  preset: 'jest-puppeteer',
  testMatch: ['<rootDir>/tests/**/*.e2e.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'], // Optional: if you need global setup specific to jest-puppeteer
  testTimeout: 30000, // Increase default timeout for E2E tests
}; 
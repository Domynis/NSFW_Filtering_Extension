module.exports = {
    preset: 'jest-puppeteer',
    transform: {
        '^.+\\.ts$': 'ts-jest',
    },
    testMatch: ['**/e2e/**/*.test.ts'],
};
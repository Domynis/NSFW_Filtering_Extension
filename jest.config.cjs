module.exports = {
    preset: 'jest-puppeteer',
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: 'e2e/tsconfig.json' }],
    },
    testMatch: ['**/e2e/**/*.test.ts'],
    testTimeout: 20000,
};
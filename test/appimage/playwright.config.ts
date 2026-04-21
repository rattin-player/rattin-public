import { defineConfig } from '@playwright/test';

// Runtime-only validator. The Qt shell is already running when Playwright
// starts; we connect over CDP (see appimage.spec.ts) instead of launching
// a browser ourselves, so no `use.browserName` / `webServer` block.
export default defineConfig({
    testDir: '.',
    testMatch: /appimage\.spec\.ts$/,
    fullyParallel: false,
    workers: 1,
    retries: 1,
    timeout: 60_000,
    expect: { timeout: 30_000 },
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ],
    use: {
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
});

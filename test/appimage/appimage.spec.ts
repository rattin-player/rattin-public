import { test, expect, chromium, type Page } from '@playwright/test';

test('Qt shell renders first-run UI via WebEngine', async () => {
    // Connect to the running QtWebEngine's remote-debug endpoint.
    // The Qt shell exposes this because validator.sh exports
    // QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222 before launching.
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

    // CDP can expose multiple contexts/pages (service workers, about:blank
    // targets, etc.) — filter to the page actually loaded from the embedded
    // Express server at :9630. Poll: validator.sh stage-1 only confirms the
    // CDP endpoint is up, not that the WebEngine has created the target page.
    const [context] = browser.contexts();
    const findTargetPage = () =>
        context.pages().find((p) => p.url().includes('127.0.0.1:9630'));
    let page: Page | undefined;
    const pageDeadline = Date.now() + 10_000;
    while (Date.now() < pageDeadline) {
        page = findTargetPage();
        if (page) break;
        await new Promise((r) => setTimeout(r, 200));
    }
    if (!page) {
        throw new Error(
            'No CDP page is loading 127.0.0.1:9630 after 10s — Qt shell has not navigated to the embedded server yet',
        );
    }

    // Attach error listeners *before* the mount assertion so errors emitted
    // during the remaining mount phase are captured, not just errors from
    // the 2s tail window below. (Events emitted before CDP connected are
    // unrecoverable — that's a CDP limitation, not an ordering one.)
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    // React has mounted into #root.
    await page.waitForSelector('#root > *', { timeout: 15_000 });

    // App-specific anchor: with no TMDB key configured (CI default), the
    // TmdbSetup component renders a <h2>TMDB API Key Required</h2>. This
    // proves the bundle loaded, React executed, and the router resolved.
    // Text-based assertion (not a class or data-testid) to minimise
    // coupling to CSS changes — see spec §"Open decisions".
    await expect(
        page.getByRole('heading', { name: 'TMDB API Key Required' }),
    ).toBeVisible({ timeout: 10_000 });

    // Tail window: let any delayed effects / async errors surface.
    await page.waitForTimeout(2_000);
    expect(errors, 'uncaught JS errors during mount + tail window').toEqual([]);

    // Release CDP — does NOT kill the Qt shell process. validator.sh owns
    // its lifecycle via the trap-on-EXIT cleanup.
    await browser.close();
});

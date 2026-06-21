#!/usr/bin/env node
// Raw CDP runtime check — replaces Playwright's connectOverCDP which fails
// against Qt WebEngine's embedded DevTools (calls Browser.setDownloadBehavior
// unconditionally, which Qt doesn't implement).
//
// Asserts:
//   1. Qt WebEngine has a page target at 127.0.0.1:9630.
//   2. React mounted (#root has children) and document.title === 'Rattin'.
//   3. Backend /api/tmdb/status returns HTTP 200 (server alive, API wired).
//   4. No uncaught JS errors during the 2s tail window after mount.
//
// Note: we deliberately don't assert the TMDB first-run overlay. AppRun
// seeds $HOME/.config/rattin/.env from the bundled .env.example (which has
// a placeholder TMDB_API_KEY=your_tmdb_api_key_here), so tmdbConfigured()
// reports true on first-run and the app skips straight to the main UI.
//
// Env: CDP_PORT (default 9222), SERVER_PORT (default 9630).
// Exits non-zero with a human-readable message on any failed assertion.

import WebSocket from 'ws';

const CDP_PORT = parseInt(process.env.CDP_PORT ?? '9222', 10);
const SERVER_PORT = parseInt(process.env.SERVER_PORT ?? '9630', 10);
const SERVER_HOST = `127.0.0.1:${SERVER_PORT}`;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${CDP_BASE}/json`);
            const targets = await res.json();
            const match = targets.find(
                (t) => t.type === 'page' && typeof t.url === 'string' && t.url.includes(SERVER_HOST),
            );
            if (match) return match;
        } catch {
            // CDP not ready yet — keep polling.
        }
        await sleep(200);
    }
    throw new Error(`No CDP page target for ${SERVER_HOST} after 10s`);
}

class CDPClient {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        ws.on('message', (buf) => {
            const msg = JSON.parse(buf.toString());
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
                else resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
            }
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() {
        this.ws.close();
    }
}

async function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.once('open', () => resolve(new CDPClient(ws)));
        ws.once('error', reject);
    });
}

async function evaluate(client, expression) {
    const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
    });
    if (result.exceptionDetails) {
        throw new Error(`Runtime.evaluate threw: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
}

async function waitFor(client, expression, { timeout = 15_000, label }) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await evaluate(client, expression)) return;
        await sleep(200);
    }
    throw new Error(`Timed out (${timeout}ms) waiting for: ${label}`);
}

async function main() {
    const target = await findPageTarget();
    console.log(`[ok] found CDP page target: ${target.url}`);

    const client = await connect(target.webSocketDebuggerUrl);

    // Collect runtime errors that fire during mount + tail window.
    const jsErrors = [];
    client.ws.on('message', (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.method === 'Runtime.exceptionThrown') {
            const e = msg.params.exceptionDetails;
            jsErrors.push(
                `exception: ${e.exception?.description ?? e.text ?? '(no description)'}`,
            );
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            const args = (msg.params.args ?? [])
                .map((a) => a.value ?? a.description ?? '')
                .join(' ');
            jsErrors.push(`console.error: ${args}`);
        }
    });
    await client.send('Runtime.enable');

    // 1. React mounted: #root has at least one child.
    await waitFor(
        client,
        `document.querySelector('#root') && document.querySelector('#root').children.length > 0`,
        { timeout: 15_000, label: 'React mount into #root' },
    );
    console.log('[ok] React mounted into #root');

    // 2. Page title = 'Rattin' (index.html loaded, not a 404/error page).
    const title = await evaluate(client, 'document.title');
    if (title !== 'Rattin') {
        throw new Error(`document.title === ${JSON.stringify(title)}, expected 'Rattin'`);
    }
    console.log('[ok] document.title === Rattin');

    // 3. Backend API reachable — confirms the Node server + route wiring
    // survived the bundle, not just the static HTML.
    const tmdbStatus = await evaluate(
        client,
        `(async () => {
            const r = await fetch('/api/tmdb/status');
            return { status: r.status, body: await r.text() };
        })()`,
    );
    if (tmdbStatus.status !== 200) {
        throw new Error(`/api/tmdb/status returned ${tmdbStatus.status}: ${tmdbStatus.body}`);
    }
    console.log(`[ok] /api/tmdb/status → 200 ${tmdbStatus.body}`);

    // 4. Tail window — let async effects / delayed errors surface.
    await sleep(2_000);
    if (jsErrors.length > 0) {
        console.error('\nUncaught JS errors during mount + tail window:');
        for (const e of jsErrors) console.error(`  - ${e}`);
        client.close();
        process.exit(1);
    }
    console.log('[ok] no JS errors during mount + 2s tail');

    client.close();
    console.log('\nCDP runtime check: PASS');
}

main().catch((err) => {
    console.error(`\nCDP runtime check: FAIL — ${err.message}`);
    process.exit(1);
});

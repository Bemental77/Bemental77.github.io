#!/usr/bin/env node
// run_perf_t1.mjs — Puppeteer probe for bementalJIT T1 microkernels.
// Serves gamecube/bementalJIT/build-emcc/tests/test_perf_t1.html with COI headers,
// loads it in headless Chrome, and captures the [wild-perf t1*] lines.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const TEST_DIR = path.join(ROOT, 'gamecube/bementalJIT/build-emcc/tests');
const PORT = 8789;
const TIMEOUT_MS = parseInt(process.env.T1_TIMEOUT_MS || '120000', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.wasm': 'application/wasm',
};

function startServer() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.setHeader('Cross-Origin-Opener-Policy',  'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            const urlPath = decodeURIComponent(req.url.split('?')[0]);
            const filePath = path.join(TEST_DIR,
                urlPath === '/' ? 'test_perf_t1.html' : urlPath);
            fs.stat(filePath, (err, stat) => {
                if (err) { res.statusCode = 404; res.end('404'); return; }
                const ext = path.extname(filePath).toLowerCase();
                res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
                res.setHeader('Content-Length', stat.size);
                fs.createReadStream(filePath).pipe(res);
            });
        });
        srv.listen(PORT, '127.0.0.1', () => resolve(srv));
    });
}

(async () => {
    const srv = await startServer();
    console.log('[t1-probe] server up on :' + PORT);
    // V8 WASM flags. Default = unset (Liftoff dynamic-tiering, V8 default).
    // Override via T1_JS_FLAGS — useful values:
    //   --no-wasm-dynamic-tiering   eager TurboFan tier-up on bg thread
    //   --no-liftoff                TurboFan-only synchronous compile
    //   --wasm-tier-up=false        disable tier-up entirely (Liftoff stays)
    //
    // Note (per measurement 2026-05-05): eager tier-up REGRESSES 15-20% on
    // T1 because per-block modules pay TurboFan compile-thread contention
    // without the long-lived single-module-per-region prerequisite that
    // amortizes the cost. Lever #3 (tier-up) needs lever #2 (block-link
    // patching → multi-block-per-WASM-fn) to land first.
    const jsFlags = process.env.T1_JS_FLAGS || '';
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--enable-features=SharedArrayBuffer',
            '--disable-dev-shm-usage',
            ...(jsFlags ? ['--js-flags=' + jsFlags] : []),
        ],
        protocolTimeout: TIMEOUT_MS + 30000,
    });
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

    const page = await browser.newPage();
    const lines = [];
    page.on('console', (msg) => {
        const t = msg.text();
        const type = msg.type();
        lines.push(t);
        if (t.includes('[wild-perf') || t.startsWith('[PASS]') || t.startsWith('[FAIL]') ||
            t.startsWith('[info]') || t.startsWith('[bemental]') || t.includes('failed') ||
            type === 'error') {
            console.log('[' + type + '] ' + t);
        }
    });
    page.on('pageerror', (err) => console.error('[t1-probe] pageerror: ' + err.message));

    // Capture chrome://tracing JSON so wasm-trace-summary.mjs can confirm
    // TurboFan tier-up events. Start BEFORE page.goto so the page-load
    // compile events (where most WASM compilation happens) are captured.
    // Default ON; disable via T1_NO_TRACE=1.
    const tracePath = process.env.T1_TRACE_PATH || '/tmp/t1-trace.json';
    const captureTrace = !process.env.T1_NO_TRACE;
    if (captureTrace) {
        try {
            await page.tracing.start({
                path: tracePath,
                categories: [
                    'v8',
                    'v8.execute',
                    'v8.wasm',
                    'disabled-by-default-v8.compile',
                    'disabled-by-default-v8.wasm',
                    'disabled-by-default-v8.wasm.detailed',
                ],
            });
        } catch (e) {
            console.error('[t1-probe] tracing.start failed: ' + e.message);
        }
    }

    await page.goto(`http://127.0.0.1:${PORT}/test_perf_t1.html`, { waitUntil: 'load', timeout: 60000 });

    // Test exits naturally with EXIT_RUNTIME=1 once main() returns; wait for
    // a [wild-perf summary] line or timeout.
    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT_MS) {
        if (lines.some(l => l.includes('[wild-perf summary]'))) break;
        await new Promise(r => setTimeout(r, 250));
    }

    if (captureTrace) {
        try { await page.tracing.stop(); console.log('[t1-probe] trace → ' + tracePath); }
        catch (e) { console.error('[t1-probe] tracing.stop failed: ' + e.message); }
    }

    await browser.close();
    srv.close();

    const summary = lines.find(l => l.includes('[wild-perf summary]'));
    if (!summary) {
        console.error('[t1-probe] no summary line — test did not complete within ' + TIMEOUT_MS + 'ms');
        process.exit(1);
    }
    const failed = /(\d+) failed/.exec(summary);
    process.exit(failed && parseInt(failed[1], 10) > 0 ? 1 : 0);
})().catch((e) => { console.error('t1-probe error:', e); process.exit(2); });

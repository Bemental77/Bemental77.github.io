#!/usr/bin/env node
// run.mjs — conformance-harness runner (Task 2, gamecube/docs/mp4-dsp-bringup/TASKS.md).
//
// Runs a bementalJIT differential test target (default: test_diff_next, the
// live powerpc-next emitter vs DolphinPPCTests' console-recorded oracle)
// headless and waits for the test's terminal "TOTAL:" line — unlike
// tests/run_browser_test.mjs, whose DONE_RE matches the FIRST [PASS]
// per-mnemonic line and truncates the summary table.
//
// Usage: node gamecube/tools/conformance/run.mjs [test_name] [timeout_ms]
//   test_name   default test_diff_next
//   timeout_ms  default 300000
//
// Build the target first:
//   source emsdk/emsdk_env.sh
//   emcmake cmake -S gamecube/bementalJIT -B gamecube/bementalJIT/build-emcc-test
//   emmake make -C gamecube/bementalJIT/build-emcc-test <test_name>
//
// Output: full per-mnemonic table + divergence lines + TOTAL on stdout;
// complete console persisted to /tmp/conformance/<test_name>.log.
// Exit: 0 if TOTAL reports 0 failed; 1 if any failed; 2 harness error;
//       3 timeout before TOTAL.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const testName = process.argv[2] || 'test_diff_next';
const TIMEOUT_MS = parseInt(process.argv[3] || '300000', 10);
const TEST_DIR = path.join(ROOT, 'gamecube/bementalJIT/build-emcc-test/tests');
const PORT = 8000 + Math.floor(Math.random() * 1000);
const html = `${testName}.html`;

if (!fs.existsSync(path.join(TEST_DIR, html))) {
    console.error(`[conformance] no ${html} in ${TEST_DIR} — build first (see header)`);
    process.exit(2);
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm' };
function startServer() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            const urlPath = decodeURIComponent(req.url.split('?')[0]);
            const filePath = path.join(TEST_DIR, urlPath === '/' ? html : urlPath);
            fs.stat(filePath, (err, stat) => {
                if (err) { res.statusCode = 404; res.end('404'); return; }
                res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
                res.setHeader('Content-Length', stat.size);
                fs.createReadStream(filePath).pipe(res);
            });
        });
        srv.listen(PORT, '127.0.0.1', () => resolve(srv));
    });
}

// The test's terminal marker (printed once, after every case has run):
//   TOTAL: <n> passed, <n> failed[, <n> interp-fallback] (of <n>...)
const TOTAL_RE = /TOTAL:\s*(\d+) passed,\s*(\d+) failed/;
const HARD_FAIL_RE = /\bLinkError\b|\bRuntimeError\b|\babort\(|\bAborted\b|uncaught|memory access out of bounds/i;

(async () => {
    const srv = await startServer();
    const lines = [];
    let hardError = null;

    const SYS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const launchOpts = {
        headless: 'new',
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-dev-shm-usage'],
        protocolTimeout: TIMEOUT_MS + 30000,
    };
    if (fs.existsSync(SYS_CHROME)) launchOpts.executablePath = SYS_CHROME;
    else launchOpts.channel = 'chrome';

    let browser;
    try {
        browser = await puppeteer.launch(launchOpts);
        // [leak-guard] a SIGKILLed parent ORPHANS this browser (uncatchable in-process);
        // `node tools/browser_leak_guard.js reap` kills it once this process is gone.
        try { (await import('../../../tools/browser_leak_guard.js')).default.guard(browser, import.meta.url); } catch (_e) {}
    } catch (e) {
        console.error(`[conformance] puppeteer launch failed: ${e.message}`);
        srv.close(); process.exit(2);
    }
    const page = await browser.newPage();
    page.on('console', (msg) => lines.push(msg.text()));
    page.on('pageerror', (err) => { hardError = err.message; lines.push('PAGEERROR: ' + err.message); });

    try {
        await page.goto(`http://127.0.0.1:${PORT}/${html}`, { waitUntil: 'load', timeout: 60000 });
    } catch (e) { hardError = 'goto: ' + e.message; }

    const t0 = Date.now();
    let totalLine = null;
    while (Date.now() - t0 < TIMEOUT_MS) {
        if (hardError) break;
        totalLine = lines.find(l => TOTAL_RE.test(l));
        if (totalLine) {
            // Give trailing prints (report() of the TOTAL line itself) a beat.
            await new Promise(r => setTimeout(r, 500));
            break;
        }
        const hf = lines.find(l => HARD_FAIL_RE.test(l));
        if (hf) { hardError = hf; break; }
        await new Promise(r => setTimeout(r, 200));
    }
    await browser.close();
    srv.close();

    const logPath = `/tmp/conformance/${testName}.log`;
    try { fs.mkdirSync('/tmp/conformance', { recursive: true }); fs.writeFileSync(logPath, lines.join('\n')); } catch {}

    // Echo the interesting sections: per-mnemonic table, divergences, TOTAL.
    const interesting = lines.filter(l =>
        /pass=\s*\d+\s+fail=\s*\d+/.test(l) || /divergences|per-mnemonic/.test(l) ||
        /rd [!=]=|xer [!=]=|cr [!=]=/.test(l) || TOTAL_RE.test(l));
    for (const l of interesting) console.log(l);
    console.log(`[conformance] full log: ${logPath}`);

    if (hardError) { console.error(`[conformance] hard error: ${hardError.slice(0, 200)}`); process.exit(2); }
    if (!totalLine) { console.error(`[conformance] timeout before TOTAL (${TIMEOUT_MS}ms)`); process.exit(3); }
    const m = totalLine.match(TOTAL_RE);
    process.exit(parseInt(m[2], 10) === 0 ? 0 : 1);
})().catch((e) => { console.error(`[conformance] harness error: ${e.message}`); process.exit(2); });

#!/usr/bin/env node
// run_browser_test.mjs — generic COI-served headless-browser runner for the
// bementalJIT emcc test targets (test_*.html). These tests instantiate
// JIT-generated WASM block modules that import env.ppc_hle_fire etc.; they
// MUST run under cross-origin isolation (SharedArrayBuffer) in a real browser,
// not raw node. Models the COOP/COEP + headless-chrome recipe from
// gamecube/tools/run_perf_t1.mjs, generalized to any test target.
//
// Usage: node run_browser_test.mjs <test_name> [build_dir] [timeout_ms]
//   <test_name>  e.g. test_gekko  (the .html under <build_dir>/tests/)
//   [build_dir]  default gamecube/bementalJIT/build-emcc-test
//   [timeout_ms] default 90000
//
// Exit: 0 PASS, 1 FAIL, 3 INCONCLUSIVE (ran but no clear verdict), 2 harness error.
// Prints a single machine-readable verdict line: [verdict] <test>: PASS|FAIL|INCONCLUSIVE (<reason>)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = '/Users/caseybement/Bemental77.github.io';
const testName = process.argv[2];
if (!testName) { console.error('usage: run_browser_test.mjs <test_name> [build_dir] [timeout_ms]'); process.exit(2); }
const BUILD_DIR = process.argv[3] || path.join(ROOT, 'gamecube/bementalJIT/build-emcc-test');
const TEST_DIR = path.join(BUILD_DIR, 'tests');
const TIMEOUT_MS = parseInt(process.argv[4] || process.env.TEST_TIMEOUT_MS || '90000', 10);
const PORT = 8000 + Math.floor(Math.random() * 1000);
const html = `${testName}.html`;

if (!fs.existsSync(path.join(TEST_DIR, html))) {
    console.error(`[verdict] ${testName}: INCONCLUSIVE (no ${html} in ${TEST_DIR} — build first)`);
    process.exit(3);
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

// Verdict markers. FAIL takes precedence over PASS within a run.
// NOTE: do NOT include a bare "FAILED" alternative — it matches the word
// "failed" inside benign summaries like "20 passed, 0 failed". Only a NONZERO
// failed-count counts as a failure.
const FAIL_RE = /\bLinkError\b|\bRuntimeError\b|\babort\(|\bAborted\b|uncaught|assertion failed|\[FAIL\]|\b[1-9]\d*\s+failed\b|requires a callable|Table\.grow|mismatch in shared state|memory access out of bounds|dispatch failed|dispatch trap/i;
const PASS_RE = /\[PASS\]|ALL TESTS? (PASSED|OK|DONE)|\b(\d+)\/\1\b.*pass|\ball (\d+) .*pass|passed,?\s*0 failed|\[wild-perf summary\][^]*?\b0 failed|\bPASS\b\s*$/i;
// ★ COMPLETION marker only — NOT a per-case result line.
//
// THE FALSE-GREEN BUG THIS FIXES (measured 2026-09-01). This regex used to
// include `\[(PASS|FAIL)\]`, so the wait loop below broke on the FIRST per-case
// result line and the run was abandoned mid-suite; the verdict block then saw a
// `[PASS]` with no `[FAIL]` and reported PASS. Observed directly: under load
// `test_gekko_next` produced 3 of its ~169 cases, its own `TOTAL:` completion
// marker (test_gekko_next.cpp:4345) was ABSENT from an 18-line log, and the
// harness still exited 0. A suite that never reached the end cannot be a
// correctness gate, and this one was being used as one.
//
// Every suite's real end-of-run line, verified by grepping tests/*.cpp:
//   "TOTAL: %d passed, %d failed"            test_simd_bswap, test_gekko, ...
//   "TOTAL  pass=%d  fail=%d  vacuous=%d"    test_leaf_inline
//   "[wild-perf summary] ..."                test_perf_t1
const DONE_RE = /\bTOTAL[: ]|\[wild-perf summary\]|ALL TESTS? (PASSED|OK|DONE|COMPLETE)/i;

(async () => {
    const srv = await startServer();
    const lines = [];
    let sawError = false;
    let browser;
    // Use the system Chrome (the proven path in run_perf_t1.mjs); puppeteer's
    // bundled-Chromium version often mismatches what's cached locally.
    const SYS_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const launchOpts = {
        headless: 'new',
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-dev-shm-usage'],
        protocolTimeout: TIMEOUT_MS + 30000,
    };
    if (fs.existsSync(SYS_CHROME)) launchOpts.executablePath = SYS_CHROME;
    else launchOpts.channel = 'chrome';
    try {
        browser = await puppeteer.launch(launchOpts);
    } catch (e) {
        console.error(`[verdict] ${testName}: INCONCLUSIVE (puppeteer launch failed: ${e.message})`);
        srv.close(); process.exit(3);
    }
    const page = await browser.newPage();
    page.on('console', (msg) => { const t = msg.text(); lines.push(t); });
    page.on('pageerror', (err) => { sawError = true; lines.push('PAGEERROR: ' + err.message); });

    try {
        await page.goto(`http://127.0.0.1:${PORT}/${html}`, { waitUntil: 'load', timeout: 60000 });
    } catch (e) { lines.push('GOTO-ERROR: ' + e.message); sawError = true; }

    const t0 = Date.now();
    while (Date.now() - t0 < TIMEOUT_MS) {
        if (sawError) break;
        if (lines.some(l => DONE_RE.test(l))) break;
        await new Promise(r => setTimeout(r, 200));
    }
    await browser.close();
    srv.close();

    // Persist full console for citation.
    const logPath = `/tmp/bjit-tests/${testName}.log`;
    try { fs.mkdirSync('/tmp/bjit-tests', { recursive: true }); fs.writeFileSync(logPath, lines.join('\n')); } catch {}

    const failHit = lines.find(l => FAIL_RE.test(l));
    const passHit = lines.find(l => PASS_RE.test(l));
    const doneHit = lines.find(l => DONE_RE.test(l));
    let verdict, reason, code;
    // ORDER MATTERS, AND SO DOES THE COMPLETION CHECK.
    // A FAIL anywhere is a FAIL even if the suite also finished. But a PASS
    // REQUIRES the suite to have reached its own end marker — otherwise a run
    // that died, hung, or was cut off by TIMEOUT_MS after one passing case
    // reports PASS, which is exactly the false green this harness shipped.
    if (failHit) { verdict = 'FAIL'; reason = failHit.slice(0, 120); code = 1; }
    else if (!doneHit) {
      verdict = 'INCOMPLETE';
      code = 3;
      const seen = lines.filter(l => /\[PASS\]/i.test(l)).length;
      reason = `suite never reached its completion marker (saw ${seen} [PASS] line(s), ${lines.length} console line(s))`
             + (Date.now() - t0 >= TIMEOUT_MS ? ` — hit TIMEOUT_MS=${TIMEOUT_MS}, raise it with argv[4] or TEST_TIMEOUT_MS` : '')
             + (lines.length ? `; last: ${lines[lines.length-1].slice(0,80)}` : '');
    }
    else if (passHit) { verdict = 'PASS'; reason = `${doneHit.slice(0, 90)} | ${passHit.slice(0, 60)}`; code = 0; }
    else { verdict = 'INCONCLUSIVE'; reason = `completed but no pass marker; last: ${(lines[lines.length-1]||'').slice(0,80)}`; code = 3; }
    console.log(`[verdict] ${testName}: ${verdict} (${reason})  [log: ${logPath}]`);
    process.exit(code);
})().catch((e) => { console.error(`[verdict] ${testName}: harness error ${e.message}`); process.exit(2); });

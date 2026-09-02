#!/usr/bin/env node
// wasm_edge_cost_bench_chrome.mjs — run wasm_edge_cost_bench.mjs inside the
// REAL Chrome the probe uses, not node.
//
// WHY: node v24.15 carries V8 13.6. V8's speculative `call_indirect` inlining —
// the mechanism the whole "batch blocks into one module" candidate rests on —
// shipped in Chrome M137 / V8 13.7 (https://v8.dev/blog/wasm-speculative-optimizations).
// A node-only number therefore cannot settle the question, in either direction:
// it may miss a speedup Chrome would show, or report one that comes from
// something else entirely. The product runs in Chrome, so Chrome decides.
//
// The bench source is loaded as a CLASSIC script (it has no import/export) with
// its knobs injected as `globalThis.__EDGE_BENCH_ENV`.
//
//   bash tools/probe_lock.sh run -- node gamecube/tools/wasm_edge_cost_bench_chrome.mjs
//
// Knobs are the same env vars as the node bench (N_BLOCKS, BODY_OPS, EDGES,
// SLICE, REPS, WARMUP, SUCC, SPREAD, ARMS), plus CHROME / HEADLESS.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const leakGuard = require(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'browser_leak_guard.js'));

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'wasm_edge_cost_bench.mjs'), 'utf8').replace(/^#!.*\n/, '');

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PASS = ['N_BLOCKS', 'BODY_OPS', 'EDGES', 'SLICE', 'REPS', 'WARMUP', 'SUCC', 'SPREAD', 'ARMS'];
const envOut = {};
for (const k of PASS) if (process.env[k] != null) envOut[k] = process.env[k];

(async () => {
  const browser = leakGuard.guard(await puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.HEADLESS === '0' ? false : 'new',
    args: [
      '--no-sandbox',
      // Same anti-throttling pins the dolphin probe uses: headless Chrome
      // throttles timers in "backgrounded" tabs, which has produced 25fps-vs-2fps
      // pace forks on identical builds in this repo.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=IntensiveWakeUpThrottling',
      ...(process.env.CHROME_JS_FLAGS ? ['--js-flags=' + process.env.CHROME_JS_FLAGS] : []),
    ],
  }), 'wasm_edge_cost_bench_chrome');

  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.log(m.text()));
    page.on('pageerror', (e) => console.error('[pageerror] ' + e.message));
    await page.goto('about:blank');
    await page.evaluate((env) => { globalThis.__EDGE_BENCH_ENV = env; }, envOut);

    const version = await page.evaluate(() => navigator.userAgent);
    console.log('# chrome: ' + version);

    await page.evaluate(SRC);
    const result = await page.evaluate(() => globalThis.__EDGE_BENCH_RESULT || null);
    if (!result) { console.error('NO RESULT — the bench threw; see [pageerror] above'); process.exitCode = 3; }
  } finally {
    await browser.close();
  }
})();

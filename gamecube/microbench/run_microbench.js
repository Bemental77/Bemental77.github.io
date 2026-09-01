// run_microbench.js — headless driver for gamecube/microbench/microbench.html.
//
// Topic: gamecube/docs/native-speed-gap-test/TASKS.md.
// Output: gamecube/docs/native-speed-gap-test/refs/measurements-current.json
//
// Same COOP/COEP self-served pattern as dreamcast/tools/flycast_probe.js so
// SharedArrayBuffer / WebAssembly.Memory({shared:true}) work without the
// site's coi-serviceworker.js (which requires a reload).

const http = require('http');
const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = parseInt(process.env.MB_PORT || '8790', 10);
const OUT  = process.env.MB_OUT
  || path.join(ROOT, 'gamecube/docs/native-speed-gap-test/refs/measurements-current.json');
const TIMEOUT_MS = parseInt(process.env.MB_TIMEOUT_MS || '120000', 10);

// ---------------------------------------------------------------------------
// COOP/COEP server (mirrors flycast_probe.js).
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const filePath = path.join(ROOT, url === '/' ? '/index.html' : url);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(filePath, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404).end('not found: ' + url); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('[server] http://127.0.0.1:' + PORT);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.CHROME
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--enable-features=SharedArrayBuffer',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  const page = await browser.newPage();

  page.on('console', (msg) => {
    console.log('[browser ' + msg.type() + '] ' + msg.text());
  });
  page.on('pageerror', (err) => console.log('[pageerror] ' + err.message));
  page.on('requestfailed', (req) => console.log('[req-fail] ' + req.url() + ' — ' + req.failure()?.errorText));
  page.on('response', (res) => {
    if (res.status() >= 400) console.log('[res ' + res.status() + '] ' + res.url());
  });

  await page.goto('http://127.0.0.1:' + PORT + '/gamecube/microbench/microbench.html',
                  { waitUntil: 'load', timeout: 30000 });

  // Wait for the worker to publish init-done (winit becomes "ready (handle=N)").
  await page.waitForFunction(() => {
    const s = document.getElementById('winit');
    return s && /ready/.test(s.textContent);
  }, { timeout: 30000 });

  // Fixed iter counts. Big enough that V8 tier-up has time and the loop is
  // wall-clock dominated by the layer's per-iter cost, not page chatter.
  await page.evaluate(() => {
    document.getElementById('warmup').value = '200000';
    document.getElementById('iters').value  = '2000000';
    document.getElementById('trials').value = '3';
    document.getElementById('run-all').click();
  });

  // Wait until we have 9 runs (3 trials × 3 layers).
  await page.waitForFunction(() => {
    try {
      const j = JSON.parse(document.getElementById('out').textContent);
      return j.runs && j.runs.length >= 9;
    } catch { return false; }
  }, { timeout: TIMEOUT_MS, polling: 500 });

  const json = await page.evaluate(() => document.getElementById('out').textContent);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log('[wrote] ' + OUT);
  console.log('---');
  const parsed = JSON.parse(json);
  console.log('L0 median: ' + (parsed.summary.L0_empty_emasm?.median || '?') + ' calls/sec');
  console.log('L1 median: ' + (parsed.summary.L1_dispatch_raw?.median || '?') + ' disp/sec');
  console.log('L2 median: ' + (parsed.summary.L2_c_direct?.median || '?') + ' disp/sec');
  console.log('---');
  console.log('L0 ns/call:        ' + parsed.deltas.L0_ns_per_call);
  console.log('L1 ns/dispatch:    ' + parsed.deltas.L1_ns_per_dispatch);
  console.log('L2 ns/dispatch:    ' + parsed.deltas.L2_ns_per_dispatch);
  console.log('L2 / L1 speedup:   ' + parsed.ratios.L2_over_L1 + '×');
  console.log('L1 % of native:    ' + parsed.ratios.L1_pct_of_native + '%');
  console.log('L2 % of native:    ' + parsed.ratios.L2_pct_of_native + '%');

  await browser.close();
  server.close();
})().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});

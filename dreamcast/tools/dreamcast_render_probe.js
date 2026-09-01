// dreamcast_render_probe.js — Phase 1 headless render probe for the
// Flycast WASM page-side scaffolding. Mirrors the shape of
// /Users/caseybement/dolphin_render_probe.js (the GameCube probe) but
// stripped to the single-worker flow.
//
// Usage:
//   PROBE_DURATION_MS=30000 \
//     node dreamcast/tools/dreamcast_render_probe.js \
//       'dreamcast/roms/Phantasy Star Online Ver. 2 (USA) (En,Ja,Fr,De,Es)/Phantasy Star Online Ver. 2 (USA) (En,Ja,Fr,De,Es).cue'
//
// What this does:
//   1. Spins up a small static HTTP server on PORT (default 8789) serving
//      the repo root, with COOP/COEP headers so SharedArrayBuffer works.
//   2. Launches headless Chrome (Puppeteer) at /dreamcast.html.
//   3. Waits for the worker 'ready' postMessage.
//   4. Programmatically feeds the disc files to the page via DataTransfer
//      on the <input type=file>.
//   5. Clicks Boot. Runs for PROBE_DURATION_MS.
//   6. Snapshots the canvas, counts non-black pixels, and prints a fixed
//      summary section.
//
// Like the dolphin probe, this depends on Puppeteer. If it isn't installed
// yet, run `npm i --no-save puppeteer` (see TODO note at the bottom).

const http = require('http');
const fs   = require('fs');
const path = require('path');
let   puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (_e) {
  // Skeleton-only mode: print the harness summary so you can read the shape,
  // then exit. The real run requires Puppeteer.
  // TODO: install Puppeteer (`npm i --no-save puppeteer`) — same dep the
  //       dolphin render probe relies on.
  console.error('puppeteer not installed; install with `npm i --no-save puppeteer`.');
  console.error('Skeleton-only — summary structure follows so you can preview the report shape:');
  console.log('\n========== DREAMCAST RENDER PROBE RESULT ==========');
  console.log('canvas:               { skeleton: true }');
  console.log('worker ready:         skipped');
  console.log('disc-loaded events:   skipped');
  console.log('frame events:         skipped');
  console.log('audio frames written: skipped');
  console.log('rec_wasm compiles:    skipped');
  console.log('worker errors:        skipped');
  console.log('final pc (best-effort): skipped');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROOT             = '/Users/caseybement/Bemental77.github.io';
const PORT             = parseInt(process.env.PROBE_PORT || '8789', 10);
const TEST_DURATION_MS = parseInt(process.env.PROBE_DURATION_MS || '30000', 10);
const CHROME_PATH      = process.env.PROBE_CHROME ||
                         '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_CUE      = 'dreamcast/roms/Phantasy Star Online Ver. 2 (USA) (En,Ja,Fr,De,Es)/Phantasy Star Online Ver. 2 (USA) (En,Ja,Fr,De,Es).cue';
const cuePath          = path.resolve(ROOT, process.argv[2] || DEFAULT_CUE);

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.iso': 'application/octet-stream',
  '.cue': 'application/octet-stream', '.gdi': 'application/octet-stream',
  '.chd': 'application/octet-stream', '.cdi': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/dreamcast.html';
      const filePath = path.join(ROOT, urlPath);
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

// ---------------------------------------------------------------------------
// Puppeteer file-input shim — programmatically attach the .cue + .bin
// tracks to the <input type=file id=discFile> via Page.handleFileChooser.
// ---------------------------------------------------------------------------
async function pickDisc(page, cuePathAbs) {
  const dir = path.dirname(cuePathAbs);
  // Pull the cue + every adjacent track .bin (Flycast also accepts .gdi/.chd —
  // bundle whatever's adjacent so a future PSO/SA2 swap just works).
  const adjacents = fs.readdirSync(dir)
    .filter(f => /\.(cue|bin|gdi|chd|cdi|iso)$/i.test(f))
    .map(f => path.join(dir, f));
  // Wait for the input element (page may still be wiring up).
  await page.waitForSelector('#discFile', { timeout: 30000 });
  const input = await page.$('#discFile');
  await input.uploadFile(...adjacents);
  // The page's onchange handler reads files asynchronously and posts them
  // to the worker chunk-by-chunk. The 'discLoaded' event arrives later;
  // the caller polls for it via console-bucket counts.
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  if (!fs.existsSync(cuePath)) {
    console.error('cue not found: ' + cuePath);
    process.exit(2);
  }

  const srv = await startServer();
  console.log('[probe] server up on :' + PORT);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
           '--disable-web-security', '--disable-dev-shm-usage',
           `--js-flags=--max-old-space-size=4096 ${process.env.PROBE_JS_FLAGS || ''}`],
    protocolTimeout: 600000,
  });
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { require('../../tools/browser_leak_guard.js').guard(browser, __filename); } catch (_e) {}

  const page = await browser.newPage();

  const buckets = {
    worker: [],
    flycast_shim: [],
    flycast_funcs: [],
    flycast_worker: [],   // [flycast-worker] from EmscriptenWorker.cpp video/audio cb
    rec_wasm: [],
    page_err: [],
    other: [],
    counters: { ready: 0, discLoaded: 0, frame: 0, render: 0 },
  };

  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[flycast-shim]'))   buckets.flycast_shim.push(t);
    else if (t.includes('[flycast-funcs]')) buckets.flycast_funcs.push(t);
    else if (t.includes('[flycast-worker]')) buckets.flycast_worker.push(t);
    else if (t.includes('[rec_wasm]'))   buckets.rec_wasm.push(t);
    else if (t.includes('[worker]') || t.includes('[page]')) buckets.worker.push(t);
    else buckets.other.push(t);

    // Page receives worker postMessages and the inline script doesn't log
    // every cmd — we infer counts from the few it does log + the bucketed
    // [flycast-shim] markers.
    if (t.includes("[page] worker ready")) buckets.counters.ready++;
    if (t.includes("[page] disc loaded ok"))  buckets.counters.discLoaded++;
    if (t.includes("[page] disc load FAILED")) buckets.counters.discLoaded++;  // count attempts
  });
  page.on('pageerror', (err) => buckets.page_err.push(err && err.message ? err.message : String(err)));
  page.on('workererror', (err) => buckets.page_err.push('[worker] ' + (err && err.message ? err.message : String(err))));

  await page.setCacheEnabled(false);
  await page.goto(`http://127.0.0.1:${PORT}/dreamcast.html?v=${Date.now()}`,
                  { waitUntil: 'load', timeout: 60000 });

  // Wait for the worker 'ready' page log (5s grace).
  const readyStart = Date.now();
  while (buckets.counters.ready === 0 && Date.now() - readyStart < 15000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (buckets.counters.ready === 0) {
    console.warn('[probe] worker ready not seen in 15s — continuing anyway');
  }

  // Attach the disc files via the picker.
  try {
    await pickDisc(page, cuePath);
    console.log('[probe] disc picker triggered with: ' + path.basename(cuePath));
  } catch (e) {
    console.error('[probe] disc picker failed: ' + (e && e.message ? e.message : e));
  }

  // Wait for discLoaded ack (10s grace), then click Boot.
  const discStart = Date.now();
  while (buckets.counters.discLoaded === 0 && Date.now() - discStart < 30000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await page.evaluate(() => {
    const b = document.getElementById('btnBoot');
    if (b && !b.disabled) b.click();
  });
  console.log('[probe] Boot clicked, observing for ' + (TEST_DURATION_MS / 1000) + 's...');

  await new Promise((r) => setTimeout(r, TEST_DURATION_MS));

  // ---- Canvas snapshot --------------------------------------------------
  const canvasInfo = await page.evaluate(() => {
    const c = document.getElementById('dc-canvas');
    if (!c) return { found: false };
    try {
      // The page sets up WebGL on dc-canvas; getContext('2d') will throw
      // ('CanvasRenderingContext2DType...') because the GL context already owns
      // it. Use Puppeteer's screenshot path then sample bytes via a temporary
      // 2D canvas in the page.
      const off = document.createElement('canvas');
      off.width = c.width; off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const data = ctx.getImageData(0, 0, off.width, off.height).data;
      let nonBlack = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] !== 0 || data[i+1] !== 0 || data[i+2] !== 0) nonBlack++;
      }
      return { found: true, w: c.width, h: c.height, nonBlack, total: data.length / 4 };
    } catch (e) {
      return { found: true, error: String(e), w: c.width, h: c.height };
    }
  });

  await browser.close();
  srv.close();

  // ---- Fixed summary ----------------------------------------------------
  console.log('\n========== DREAMCAST RENDER PROBE RESULT ==========');
  console.log('canvas:               ' + JSON.stringify(canvasInfo));
  console.log('worker ready:         ' + (buckets.counters.ready ? 'yes' : 'NO'));
  console.log('disc loaded acks:     ' + buckets.counters.discLoaded);
  console.log('flycast video_cb cnt: ' + buckets.flycast_worker.filter(l => l.includes('video_cb')).length);
  console.log('rec_wasm log lines:   ' + buckets.rec_wasm.length);
  console.log('worker / page errors: ' + buckets.page_err.length);
  console.log('\n--- flycast_shim transitions ---');
  buckets.flycast_shim.forEach((l) => console.log('  ' + l));
  console.log('\n--- flycast_funcs transitions ---');
  buckets.flycast_funcs.forEach((l) => console.log('  ' + l));
  console.log('\n--- flycast_worker (C++ side) (first 8) ---');
  buckets.flycast_worker.slice(0, 8).forEach((l) => console.log('  ' + l));
  console.log('\n--- rec_wasm (first 5 / last 3) ---');
  buckets.rec_wasm.slice(0, 5).forEach((l) => console.log('  ' + l));
  if (buckets.rec_wasm.length > 8) console.log('  ...');
  buckets.rec_wasm.slice(-3).forEach((l) => console.log('  ' + l));
  console.log('\n--- pageerror (first 5) ---');
  buckets.page_err.slice(0, 5).forEach((l) => console.log('  ' + l));
  console.log('\n--- other (last 10) ---');
  buckets.other.slice(-10).forEach((l) => console.log('  ' + l));
  // TODO: extract a "final pc" once the rec_wasm seam emits a heartbeat with
  //       an SH4 PC (mirrors the dolphin [worker] N=… pc=… line).

  process.exit(0);
})().catch((err) => { console.error('probe error:', err); process.exit(2); });

// Headless boot probe for the Flycast WASM port.
//
// Serves the repo over a COOP/COEP local HTTP server, launches Chrome
// headless, loads dreamcast.html, auto-clicks the Start button, and
// captures the SIGNAL lines (everything `[flycast-shim]`, `[flycast-worker]`,
// `[flycast.log]`, `[flycast-funcs]`, `[flycast-wasm]`, `[page]`, plus any
// abort / uncaught wasm error) — silently drops the emcc DEBUG/ASSERTIONS
// stream (`flycast_worker_emcc.js:NNN` lines + `w:N,t:0xNNN: ...` dbg() noise)
// which currently floods the console with 50+ benign entries per boot.
//
// Exits early on:
//   - `[page] worker ready` not seen within --idle-ms ms after page load
//   - ABORT detected
//   - "load_disc:" success or fail
//   - any successful video_cb frame
//
// Usage:
//   node dreamcast/tools/flycast_probe.js [--duration 30000] [--no-start]
//                                         [--idle 8000] [--keep-noise]
//   PROBE_LOG=/tmp/dc.log node dreamcast/tools/flycast_probe.js
//
// Env:
//   FLYCAST_V8_FLAGS — forwarded verbatim to the headless Chrome instance
//                      as `--js-flags=<value>`. Use to tune V8 wasm
//                      behaviour (e.g. `--trace-deopt --print-wasm-code`,
//                      `--no-liftoff`, `--wasm-tier-up`). The probe itself
//                      runs under whichever node binary invoked it — these
//                      flags affect the Chromium renderer's V8, not node.
//
// Exits 0 on clean shutdown, 1 on probe-detected fatal abort.

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = parseInt(process.env.PROBE_PORT || '8789', 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// --- argv ---
let DURATION_MS = parseInt(process.env.PROBE_DURATION_MS || '30000', 10);
let AUTO_START = true;
// Track3.bin is 1.18 GB and streams silently for ~8–12s on a warm filesystem
// before its post-write log line fires. 20s default tolerates that.
let IDLE_MS = parseInt(process.env.PROBE_IDLE_MS || '20000', 10);
let KEEP_NOISE = false;
let LOG_PATH = process.env.PROBE_LOG || '';
let INTERP_ONLY = false;
let SEED = false;          // --seed: allow the page's fresh-boot seed state
                           // (default OFF so every probe measures a cold boot)
const PRESSES = [];        // --press <ms>:<Key>:<holdMs>: scripted key input
let PC_TRACE_UNTIL = 0;
let SCREENSHOT_PATH = '';
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--duration')   DURATION_MS = parseInt(process.argv[++i], 10);
  else if (a === '--idle')  IDLE_MS = parseInt(process.argv[++i], 10);
  else if (a === '--no-start') AUTO_START = false;
  else if (a === '--keep-noise') KEEP_NOISE = true;
  else if (a === '--log')   LOG_PATH = process.argv[++i];
  else if (a === '--interp') INTERP_ONLY = true;
  else if (a === '--seed') SEED = true;
  else if (a === '--press') {            // --press <ms>:<Key>:<holdMs>, repeatable
    const m = /^(\d+):([^:]+):(\d+)$/.exec(process.argv[++i] || '');
    if (m) PRESSES.push({ at: +m[1], key: m[2], hold: +m[3], fired: false });
    else console.error('bad --press spec (want <ms>:<Key>:<holdMs>)');
  }
  else if (a === '--pctrace') PC_TRACE_UNTIL = parseInt(process.argv[++i], 10) >>> 0;
  else if (a === '--screenshot') SCREENSHOT_PATH = process.argv[++i];
  else if (a === '-h' || a === '--help') {
    console.log('flycast_probe [--duration MS] [--idle MS] [--no-start] [--keep-noise] [--log PATH] [--interp] [--pctrace N]');
    process.exit(0);
  }
}

// --- MIME ---
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.cue': 'text/plain', '.iso': 'application/octet-stream',
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // COOP/COEP — required for SharedArrayBuffer.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/dreamcast.html';
      const filePath = path.join(ROOT, urlPath);
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) { res.statusCode = 404; res.end('404'); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
      });
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// --- noise filter ---
// Emcc's dbg() writes to console.error; under -sASSERTIONS=1 + -sGL_DEBUG=1
// it's prolific and not useful for bringup. Suppress unless --keep-noise.
function isNoise(text) {
  if (KEEP_NOISE) return false;
  // emcc dbg() format: "w:0,t:0x00000000: <message>"
  if (/^w:\d+,t:0x[0-9a-f]+:/i.test(text)) return true;
  // emcc thread bootstrap noise.
  if (/Worker Created$/.test(text)) return true;
  if (/installer proxying handler:/.test(text)) return true;
  if (/run\(\) called, but dependencies remain/.test(text)) return true;
  if (/(initRuntime|writeStackCookie|checkStackCookie|preMain|postRun|runtimeKeepalive|maybeExit|handleException|locateFile|asynchronously preparing wasm|preloading (files|data files)|done preloading|proc_exit|user callback done)/i.test(text)) return true;
  // mprotect cosmetic warnings from Sh4Recompiler::Reset.
  if (/unsupported syscall: __syscall_mprotect/.test(text)) return true;
  return false;
}

// Lines that signal a meaningful state transition.
function classify(text) {
  if (/\[flycast-shim\] ABORT:|RuntimeError|Uncaught/.test(text)) return 'fatal';
  if (/load_disc threw|load_disc: retro_load_game returned false/.test(text)) return 'fatal';
  if (/load_disc: retro_load_game returned true/.test(text))      return 'milestone';
  if (/hw_render\.context_reset returned/.test(text))             return 'milestone';
  if (/SET_HW_RENDER captured/.test(text))                        return 'milestone';
  if (/WebGL2 ctx ok/.test(text))                                 return 'milestone';
  if (/\[page\] worker ready/.test(text))                         return 'milestone';
  if (/video_cb /.test(text))                                     return 'frame';
  return null;
}

(async () => {
  const srv = await startServer();
  console.log('[probe] server up on :' + PORT);

  const chromeArgs = [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    // Headless Chromium throttles RAF/setInterval in non-visible windows,
    // which freezes the page's frameLoop after a few ticks. These three
    // flags keep the page running at full speed even when offscreen.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
  const V8_FLAGS = (process.env.FLYCAST_V8_FLAGS || '').trim();
  if (V8_FLAGS) {
    chromeArgs.push('--js-flags=' + V8_FLAGS);
    console.log('[probe] V8 flags: ' + V8_FLAGS);
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: chromeArgs,
    dumpio: !!process.env.FLYCAST_DUMPIO,  // tee Chrome stderr (V8 --print-wasm-code) into our stdout
  });
  const page = await browser.newPage();

  const linesAll = [];
  const milestones = new Set();
  let fatal = null;
  let lastSignalTime = Date.now();
  let workerReady = false;
  let stopReason = null;

  page.on('console', (msg) => {
    const t = msg.text();
    linesAll.push(t);
    if (isNoise(t)) return;
    process.stdout.write(t + '\n');
    lastSignalTime = Date.now();
    const c = classify(t);
    if (c === 'milestone') milestones.add(t.trim().slice(0, 120));
    if (c === 'fatal' && !fatal) fatal = t;
    if (/\[page\] worker ready/.test(t)) workerReady = true;
  });
  page.on('pageerror', (e) => {
    const t = '[pageerror] ' + (e && e.message ? e.message : String(e));
    linesAll.push(t);
    process.stdout.write(t + '\n');
    if (!fatal) fatal = t;
    lastSignalTime = Date.now();
  });

  const start = Date.now();
  // Probes boot COLD by default: the page ships a fresh-boot seed savestate
  // (dreamcast/states/pso2_boot.state) that would otherwise jump every run
  // past boot and silently change what a measurement means. Pass --seed to
  // exercise that path deliberately.
  const probeUrl = `http://127.0.0.1:${PORT}/dreamcast.html?diag=1`
    + (SEED ? '' : '&noseed=1')
    + (INTERP_ONLY ? '&interp=1' : '')
    + (PC_TRACE_UNTIL ? `&pctrace=${PC_TRACE_UNTIL}` : '');
  await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });

  // Poll loop: auto-click Start when worker-ready, exit on idle/fatal/duration.
  let clicked = !AUTO_START;
  while (Date.now() - start < DURATION_MS) {
    await new Promise(r => setTimeout(r, 250));
    if (fatal) { stopReason = 'fatal'; break; }
    if (!clicked && workerReady) {
      try {
        await page.click('#btnStart');
        process.stdout.write('[probe] clicked Start\n');
        clicked = true;
        lastSignalTime = Date.now();
      } catch (e) {
        process.stdout.write('[probe] Start click failed: ' + e.message + '\n');
      }
    }
    // Scripted key input (--press). Times are measured from probe start so a
    // spec lines up with the boot milestones in the log.
    for (const p of PRESSES) {
      if (p.fired || Date.now() - start < p.at) continue;
      p.fired = true;
      process.stdout.write('[probe] press ' + p.key + ' for ' + p.hold + 'ms\n');
      page.keyboard.down(p.key)
        .then(() => new Promise(r => setTimeout(r, p.hold)))
        .then(() => page.keyboard.up(p.key))
        .catch((e) => process.stdout.write('[probe] press failed: ' + e.message + '\n'));
      lastSignalTime = Date.now();
    }
    if (Date.now() - lastSignalTime > IDLE_MS) {
      stopReason = 'idle (' + IDLE_MS + 'ms no new signal)';
      break;
    }
  }
  if (!stopReason) stopReason = 'duration-elapsed';

  // Capture the visible canvas (browser composites the worker's OffscreenCanvas
  // into it). Black PNG = HW frame not presented; non-black = presentation works.
  if (SCREENSHOT_PATH) {
    try {
      const el = await page.$('#dc-canvas');
      if (el) { await el.screenshot({ path: SCREENSHOT_PATH }); }
      else    { await page.screenshot({ path: SCREENSHOT_PATH }); }
      process.stdout.write('[probe] screenshot -> ' + SCREENSHOT_PATH + '\n');
    } catch (e) {
      process.stdout.write('[probe] screenshot failed: ' + e.message + '\n');
    }
  }

  await browser.close();
  srv.close();

  // --- summary ---
  console.log('');
  console.log('=== flycast probe summary ===');
  console.log('  stop:           ' + stopReason);
  console.log('  total_lines:    ' + linesAll.length);
  console.log('  worker_ready:   ' + (workerReady ? 'yes' : 'no'));
  console.log('  clicked_start:  ' + (clicked ? 'yes' : 'no'));
  console.log('  milestones:     ' + (milestones.size || 'none'));
  for (const m of milestones) console.log('    + ' + m);
  if (fatal) {
    console.log('  fatal:          ' + fatal.replace(/\n.*/s, ''));
  }

  if (LOG_PATH) {
    fs.writeFileSync(LOG_PATH, linesAll.join('\n') + '\n');
    console.log('  full_log:       ' + LOG_PATH + ' (' + linesAll.length + ' lines, includes noise)');
  }

  process.exit(fatal ? 1 : 0);
})();

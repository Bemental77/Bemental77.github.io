// Interactive headless driver for gamecube.html — replicates exactly what a
// human does in the page: watch the screen + console live, and react with
// input / save / load. Unlike dolphin_render_probe.js (batch: console buffered
// to the end, screenshots at fixed times), this stays alive and is controlled
// via a command file so the operator can navigate menus by sight.
//
// Live outputs (read these while it runs):
//   /tmp/pso-console.log   — every Chrome console line, appended live
//   /tmp/pso-screen.png    — auto-screenshot, overwritten every SHOT_EVERY_MS
//
// Command channel: write one command per line to /tmp/pso-cmd.txt; each new
// line (the file is truncated after each poll) is executed:
//   press <btn>        — hold a GC button ~500ms (start/a/b/x/y/l/r/z/up/down/left/right/select)
//   tap <btn> <ms>     — hold for <ms>
//   shot <path>        — screenshot now to <path>
//   save               — saveState to IndexedDB (gzipped, SAVE_KEY)
//   export <path>      — write the gzipped IndexedDB state to <path>
//   load <path>        — restore a gzipped state file
//   quit               — shut down
//
// Env: ROM_IDX (default 2 = PSO), PROBE_PROFILE_DIR (persistent profile).

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8790;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM_IDX = parseInt(process.env.ROM_IDX || '2', 10);
const CMD_FILE = process.env.PSO_CMD || '/tmp/pso-cmd.txt';
const CONSOLE_LOG = process.env.PSO_CONSOLE || '/tmp/pso-console.log';
const SCREEN_PNG = process.env.PSO_SCREEN || '/tmp/pso-screen.png';
const SHOT_EVERY_MS = parseInt(process.env.PSO_SHOT_EVERY_MS || '15000', 10);

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.iso': 'application/octet-stream' };
const PRESS_KEY = { start: 'v', select: 'c', a: 'x', b: 'z', x: 's', y: 'd', l: 'w', r: 'r', z: 'e',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/gamecube.html';
      const filePath = path.join(ROOT, urlPath);
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

const log = (m) => { const line = '[drive] ' + m; console.log(line); try { fs.appendFileSync(CONSOLE_LOG, line + '\n'); } catch (_e) {} };

(async () => {
  try { fs.writeFileSync(CONSOLE_LOG, ''); } catch (_e) {}
  try { fs.writeFileSync(CMD_FILE, ''); } catch (_e) {}
  const srv = await startServer();
  log('server up on :' + PORT);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    ...(process.env.PROBE_PROFILE_DIR ? { userDataDir: process.env.PROBE_PROFILE_DIR } : {}),
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
      `--js-flags=--max-old-space-size=4096 ${process.env.PROBE_JS_FLAGS || '--no-liftoff'}`,
      '--disk-cache-size=1', '--disable-application-cache', '--disable-back-forward-cache',
      '--disable-dev-shm-usage'],
    protocolTimeout: 600000,
  });
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { require('../../tools/browser_leak_guard.js').guard(browser, __filename); } catch (_e) {}

  const page = await browser.newPage();
  await page.setViewport({ width: 820, height: 620 });

  // Live console stream — exactly what DevTools shows, tagged with the message
  // type (error/warning/log/info) so error-level lines can be counted like
  // Chrome's "N errors" badge.
  page.on('console', (msg) => { try { fs.appendFileSync(CONSOLE_LOG, '<' + msg.type() + '> ' + msg.text() + '\n'); } catch (_e) {} });
  page.on('pageerror', (e) => { try { fs.appendFileSync(CONSOLE_LOG, '<pageerror> ' + (e && e.message) + '\n'); } catch (_e) {} });
  // Identify failed (404) resource URLs — Chrome console hides the URL in the text.
  page.on('requestfailed', (r) => { try { fs.appendFileSync(CONSOLE_LOG, '<reqfail> ' + r.url() + ' : ' + (r.failure() && r.failure().errorText) + '\n'); } catch (_e) {} });
  page.on('response', (r) => { if (r.status() >= 400) { try { fs.appendFileSync(CONSOLE_LOG, '<http' + r.status() + '> ' + r.url() + '\n'); } catch (_e) {} } });

  // node-side file writer for export.
  await page.exposeFunction('__nodeWriteB64', (b64, p) => { try { fs.writeFileSync(p, Buffer.from(b64, 'base64')); return true; } catch (e) { return String(e); } });

  await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?v=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
  // gamecube.html's coi-serviceworker reloads the page once on first visit to
  // install COOP/COEP. A ROM-select + Start before that reload is lost. Retry
  // select+Start until btnStart actually goes disabled (= startEmulator ran).
  let started = false;
  for (let attempt = 0; attempt < 30 && !started; attempt++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      started = await page.evaluate((idx) => {
        const s = document.getElementById('romSelect');
        const b = document.getElementById('btnStart');
        if (!s || !b) return false;
        if (b.disabled) return true;            // already started
        s.value = String(idx);
        s.dispatchEvent(new Event('change'));
        b.click();
        return b.disabled === true;             // startEmulator disables it synchronously
      }, ROM_IDX);
    } catch (_e) { /* page mid-reload */ }
  }
  const selLabel = await page.evaluate(() => { const s = document.getElementById('romSelect'); return s ? (s.options[s.selectedIndex] || {}).text : '?'; }).catch(() => '?');
  log('started=' + started + ' rom="' + selLabel + '" (ROM_IDX=' + ROM_IDX + '); driving. cmd file=' + CMD_FILE);

  let alive = true;
  // auto-screenshot loop
  const shotTimer = setInterval(async () => {
    try { await page.screenshot({ path: SCREEN_PNG }); } catch (_e) {}
  }, SHOT_EVERY_MS);

  async function hold(btn, ms) {
    const key = PRESS_KEY[btn]; if (!key) { log('unknown button: ' + btn); return; }
    try { await page.keyboard.down(key); await new Promise(r => setTimeout(r, ms)); await page.keyboard.up(key); log('pressed ' + btn + ' (' + ms + 'ms)'); }
    catch (e) { log('press failed: ' + e.message); }
  }

  async function doCmd(line) {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    if (!cmd) return;
    if (cmd === 'press') return hold(parts[1], 500);
    if (cmd === 'tap') return hold(parts[1], parseInt(parts[2] || '500', 10));
    if (cmd === 'shot') { try { await page.screenshot({ path: parts[1] || SCREEN_PNG }); log('shot -> ' + (parts[1] || SCREEN_PNG)); } catch (e) { log('shot failed: ' + e.message); } return; }
    if (cmd === 'save') {
      try { const r = await page.evaluate(() => window.__probeSaveState ? window.__probeSaveState() : 'no-hook'); log('save -> ' + r); } catch (e) { log('save failed: ' + e.message); } return;
    }
    if (cmd === 'export') {
      const out = parts[1] || '/tmp/pso_state.gcs.gz';
      try {
        const r = await page.evaluate(async (p) => {
          // SAVE_KEY is closure-local; read it via the hook chain. Save first, then read IndexedDB gz blob.
          if (!window.__probeSaveState) return 'no-save-hook';
          await window.__probeSaveState();
          if (!window.__probeExportGzB64) return 'no-export-hook';
          const b64 = await window.__probeExportGzB64();
          if (!b64) return 'empty';
          await window.__nodeWriteB64(b64, p);
          return 'exported ' + b64.length + ' b64 chars';
        }, out);
        log('export -> ' + out + ' : ' + r);
      } catch (e) { log('export failed: ' + e.message); } return;
    }
    if (cmd === 'load') {
      const f = parts[1]; if (!f || !fs.existsSync(f)) { log('load: file not found ' + f); return; }
      try {
        const b64 = fs.readFileSync(f).toString('base64');
        const r = await page.evaluate(async (b) => {
          const bin = atob(b); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          if (!window.__probeLoadStateFromGz) return 'no-load-hook';
          await window.__probeLoadStateFromGz(u8); return 'loaded ' + u8.length + ' bytes';
        }, b64);
        log('load ' + f + ' -> ' + r);
      } catch (e) { log('load failed: ' + e.message); } return;
    }
    if (cmd === 'eval') {
      // eval <js> — run arbitrary JS in the PAGE context, log the JSON result.
      const js = line.slice(line.indexOf(' ') + 1);
      try { const r = await page.evaluate((code) => { try { return JSON.stringify(eval(code)); } catch (e) { return 'EVALERR: ' + e.message; } }, js); log('eval -> ' + r); }
      catch (e) { log('eval failed: ' + e.message); } return;
    }
    if (cmd === 'quit') { alive = false; return; }
    log('unknown cmd: ' + line);
  }

  // command poll loop
  while (alive) {
    try {
      const txt = fs.readFileSync(CMD_FILE, 'utf8');
      if (txt.trim()) {
        fs.writeFileSync(CMD_FILE, '');
        for (const line of txt.split('\n')) { if (line.trim()) await doCmd(line); }
      }
    } catch (_e) {}
    await new Promise(r => setTimeout(r, 1000));
  }

  clearInterval(shotTimer);
  log('quitting');
  try { await browser.close(); } catch (_e) {}
  srv.close();
  process.exit(0);
})();

// [recomp-live 2026-08-25] Live-pipeline probe: drives gamecube.html?recomp=1 end to end —
// JIT boot -> CPU park -> recomp_worker takeover -> live frame stream -> Dolphin WGPU render.
// Reports the HUD's delivered game-fps and screenshots the running scene.
// Usage: node gamecube/tools/recomp_live_probe.mjs
//   env: FPS (target credits/s; 0=uncapped; default 120), BOOT_MS=50000, RUN_MS=40000,
//        KEYS="ms:key,..." puppeteer key presses after takeover (default drives to the menu),
//        PROBE_HEADLESS=0 for a visible window.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8094;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = process.env.FPS ?? '120';
const BOOT_MS = parseInt(process.env.BOOT_MS || '50000', 10);
const RUN_MS = parseInt(process.env.RUN_MS || '40000', 10);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json', '.bin': 'application/octet-stream' };

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
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
console.log('[live] server on :' + PORT);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.PROBE_HEADLESS === '0' ? false : 'new',
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--disable-features=IntensiveWakeUpThrottling',
         '--disable-mac-overlays', '--js-flags=--max-old-space-size=4096',
         '--disk-cache-size=1', '--disable-application-cache', '--disable-back-forward-cache'],
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

const page = await browser.newPage();
page.on('console', (m) => { const t = m.text(); if (/recomp|guestPeek|Unknown Opcode/i.test(t)) console.log('[page]', t.slice(0, 260)); });
await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?recomp=1&fps=${FPS}&bootms=${BOOT_MS}${process.env.BOARD === '1' ? '&board=1' : ''}${process.env.GPEEK ? '&peek=' + process.env.GPEEK : ''}${process.env.FULLMEM === '1' ? '&fullmem=1' : ''}${process.env.XFREGONLY === '1' ? '&xfregonly=1' : ''}&v=${Date.now()}`,
                { waitUntil: 'load', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  localStorage.setItem('gcwasm_romIdx', '0');
  const sel = document.getElementById('romSelect');
  if (sel) sel.value = '0';
  document.getElementById('btnStart')?.click();
});
console.log('[live] JIT boot started; takeover in ' + BOOT_MS + 'ms; observing ' + RUN_MS + 'ms after');
await new Promise((r) => setTimeout(r, BOOT_MS + 8000));

// scripted key presses (page keyboard handlers feed the pace SAB)
const keys = (process.env.KEYS || '4000:Enter,9000:KeyZ,12000:ArrowUp,13000:KeyZ,17000:KeyZ,21000:KeyZ').split(',');
for (const tok of keys) {
  const [ms, code] = tok.split(':');
  setTimeout(async () => { try { await page.keyboard.press(code); console.log('[live] pressed', code); } catch {} }, parseInt(ms, 10));
}

const t0 = Date.now();
const fpsLog = [];
const shotEvery = parseInt(process.env.SHOTS_MS || '0', 10);   // 0 = no periodic shots
let shotN = 0, lastShot = 0;
while (Date.now() - t0 < RUN_MS) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const hudTxt = await page.evaluate(() => document.getElementById('recompFps')?.textContent || '');
    fpsLog.push(hudTxt);
    console.log('[live]', hudTxt);
    if (shotEvery && Date.now() - lastShot >= shotEvery) {
      lastShot = Date.now();
      await page.screenshot({ path: `/tmp/live_shot_${String(shotN++).padStart(2, '0')}.png` });
    }
  } catch (e) { console.log('[live] page gone:', String(e).slice(0, 120)); break; }
}
await page.screenshot({ path: '/tmp/recomp_live_run.png' });
console.log('[live] screenshot -> /tmp/recomp_live_run.png');
// PEEK="addr:len,addr:len" (hex addr): dump dolphin-side RAM windows for sync-corruption diffs
if (process.env.PEEK) {
  await page.evaluate((peeks) => {
    for (const tok of peeks.split(',')) {
      const [a, l] = tok.split(':');
      dolphin_worker.postMessage({ cmd: 'recompPeek', addr: parseInt(a, 16), len: parseInt(l, 10) || 96 });
    }
  }, process.env.PEEK);
  await new Promise((r) => setTimeout(r, 1500));
}
await browser.close();
srv.close();

// wgpu_diff_probe.mjs — recomp fixture render + wgpuCap GPU-boundary capture.
// Based on gamecube/tools/recomp_fix_probe.mjs; adds:
//   FIXDIR=<dir>   dir holding recomp_fix_frame.bin / recomp_fix_mem1.bin / recomp_fix_regions.json
//   TAG=<name>     capture tag; JSON lands at /tmp/wgpu_cap_<TAG>.json
// The dolphin_worker.js TEMP wrapper is armed by {cmd:'wgpuCap'} after injection settles;
// its chunked dump rides the {cmd:'print'} relay -> page console -> here.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const puppeteer = createRequire('/Users/caseybement/Bemental77.github.io/package.json')('puppeteer');

const ROOT = '/Users/caseybement/Bemental77.github.io';
const PORT = 8093;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BOOT_MS = parseInt(process.env.BOOT_MS || '50000', 10);
const POST_MS = parseInt(process.env.POST_MS || '10000', 10);
const FIXDIR = process.env.FIXDIR || '/tmp';
const TAG = process.env.TAG || 'cap';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png' };
const FIX = { '/__fix_frame': path.join(FIXDIR, 'recomp_fix_frame.bin'),
              '/__fix_mem1': path.join(FIXDIR, 'recomp_fix_mem1.bin'),
              '/__fix_regions': path.join(FIXDIR, 'recomp_fix_regions.json') };
for (const p of Object.values(FIX)) if (!fs.existsSync(p)) { console.log('MISSING fixture:', p); process.exit(1); }

const srv = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/gamecube.html';
  const filePath = FIX[urlPath] || path.join(ROOT, urlPath);
  fs.stat(filePath, (err, stat) => {
    if (err) { res.statusCode = 404; res.end('404'); return; }
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
  });
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
console.log('[diff] server on :' + PORT + ' fixtures from ' + FIXDIR);

const chunks = [];
let chunkTotal = -1, endSeen = null;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.PROBE_HEADLESS === '0' ? false : 'new',
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--disable-features=IntensiveWakeUpThrottling',
         '--disable-mac-overlays',
         '--js-flags=--max-old-space-size=4096',
         '--disk-cache-size=1', '--disable-application-cache', '--disable-back-forward-cache'],
});
  // [leak-guard] A SIGKILLed parent ORPHANS this browser — verified by test and
  // uncatchable in-process. `node tools/browser_leak_guard.js reap` kills it once
  // this process is gone; a live run is never touched.
  try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  const j = t.indexOf('[wgpuCapJ]');
  if (j >= 0) {
    const rest = t.slice(j + 10);
    const bar = rest.indexOf('|');
    const [i, n] = rest.slice(0, bar).split('/').map(Number);
    chunkTotal = n; chunks[i] = rest.slice(bar + 1);
    return;
  }
  if (/wgpuCap/.test(t)) {
    console.log('[page]', t.slice(0, 200));
    if (t.includes('[wgpuCap] END')) endSeen = true;
    return;
  }
  if (process.env.ALLCON) console.log('[page]', t.slice(0, 300));
  else if (/recomp|Unknown Opcode/i.test(t)) console.log('[page]', t.slice(0, 200));
});
await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?v=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  localStorage.setItem('gcwasm_romIdx', '0');
  const sel = document.getElementById('romSelect');
  if (sel) sel.value = '0';
  const b = document.getElementById('btnStart');
  if (b) b.click();
});
console.log('[diff] MP4 boot started; waiting ' + BOOT_MS + 'ms for the renderer...');
await new Promise((r) => setTimeout(r, BOOT_MS));

const armed = await page.evaluate(async (pauseCpu) => {
  const [fifo, mem1, regions] = await Promise.all([
    fetch('/__fix_frame').then((r) => r.arrayBuffer()),
    fetch('/__fix_mem1').then((r) => r.arrayBuffer()),
    fetch('/__fix_regions').then((r) => r.json()),
  ]);
  if (typeof dolphin_worker === 'undefined' || !dolphin_worker) return 'NO dolphin_worker handle';
  // stop the JIT guest for real — the ppc-worker thread keeps running (and writing guest RAM)
  // after recomp_pause_cpu; it stomped the injected image every frame (board-font 01FE stomp).
  if (window.ppc_worker) { try { window.ppc_worker.terminate(); } catch (e) {} window.ppc_worker = null; }
  dolphin_worker.postMessage({ cmd: 'recompFix', fifo, mem1, regions, pauseCpu, pumps: 100000 }, [fifo, mem1]);
  return 'posted fifo=' + fifo.byteLength + ' mem1=' + mem1.byteLength + ' arrays=' + regions.arrays.length;
}, true);
console.log('[diff] inject:', armed);
await new Promise((r) => setTimeout(r, POST_MS));
// PEEKADDR=hex[,hex...]: print guest bytes post-injection (stomp forensics)
if (process.env.PEEKADDR) {
  await page.evaluate((addrs) => {
    dolphin_worker.onmessage = (function (orig) { return function (e) {
      if (e.data && e.data.cmd === 'recompPeek') { console.log('recompPeek 0x' + e.data.addr.toString(16) + ': ' + e.data.hex); return; }
      if (orig) orig(e); }; })(dolphin_worker.onmessage);
    for (const a of addrs) dolphin_worker.postMessage({ cmd: 'recompPeek', addr: a, len: 32 });
  }, process.env.PEEKADDR.split(',').map((s) => parseInt(s, 16)));
  await new Promise((r) => setTimeout(r, 1500));
}
await page.screenshot({ path: `/tmp/wgpu_cap_${TAG}.png` });
console.log(`[diff] screenshot -> /tmp/wgpu_cap_${TAG}.png`);

console.log('[diff] arming wgpuCap tag=' + TAG);
await page.evaluate((tag, submits) => dolphin_worker.postMessage({ cmd: 'wgpuCap', tag, submits }), TAG, parseInt(process.env.SUBMITS || '2', 10));
const t0 = Date.now();
while (!endSeen && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 250));
// chunks arrive via console events; give the tail a moment
await new Promise((r) => setTimeout(r, 1500));
if (!endSeen) console.log('[diff] TIMEOUT waiting for capture END (got ' + chunks.filter(Boolean).length + '/' + chunkTotal + ' chunks)');
const got = chunks.filter((c) => c !== undefined).length;
if (chunkTotal > 0 && got === chunkTotal) {
  const json = chunks.join('');
  fs.writeFileSync(`/tmp/wgpu_cap_${TAG}.json`, json);
  console.log(`[diff] capture saved: /tmp/wgpu_cap_${TAG}.json (${json.length}B, ${chunkTotal} chunks)`);
} else {
  console.log(`[diff] INCOMPLETE capture: ${got}/${chunkTotal} chunks`);
}
await browser.close();
srv.close();

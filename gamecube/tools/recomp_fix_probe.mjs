// [recomp-bridge 2026-08-25] Fixture probe for the recomp->Dolphin-WGPU render seam.
// Boots MP4 under the JIT on gamecube.html (initializing the real WGPU backend + RAM),
// then injects a decomp->wasm recomp frame captured by recomp_probe.mjs DUMPFIX:
//   /tmp/recomp_fix_frame.bin    the frame's BE GP-FIFO bytes
//   /tmp/recomp_fix_mem1.bin     raw 24MB guest-RAM image (LE arrays, BE DLs)
//   /tmp/recomp_fix_regions.json CP array (base,stride,count) pairs + CALL_DL spans
// The worker handler ('recompFix' in worker_funcs.js) parks the emulated CPU
// (_recomp_pause_cpu), writes the RAM image, byte-swaps the f32 arrays LE->BE in place,
// and renders the frame through _recomp_render_fifo every pump. Screenshots land at
// /tmp/recomp_fix_pre.png (JIT game, pre-injection) and /tmp/recomp_fix_post.png (the
// recomp frame rendered by Dolphin's backend).
// Usage: node gamecube/tools/recomp_fix_probe.mjs   (env: BOOT_MS=50000 POST_MS=10000
//        PROBE_HEADLESS=0 for a visible window, PAUSE_CPU=0 to composite over the live game)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8093;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BOOT_MS = parseInt(process.env.BOOT_MS || '50000', 10);
const POST_MS = parseInt(process.env.POST_MS || '10000', 10);
const PAUSE_CPU = process.env.PAUSE_CPU !== '0';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png' };
const FIX = { '/__fix_frame': '/tmp/recomp_fix_frame.bin', '/__fix_mem1': '/tmp/recomp_fix_mem1.bin',
              '/__fix_regions': '/tmp/recomp_fix_regions.json' };

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
console.log('[fix] server on :' + PORT);

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
page.on('console', (m) => { const t = m.text(); if (process.env.ALLCON) console.log('[page]', t.slice(0, 300)); else if (/recomp|Unknown Opcode/i.test(t)) console.log('[page]', t.slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/gamecube.html?v=${Date.now()}${process.env.SKIP_DL === '1' ? '#skipdl' : ''}`, { waitUntil: 'load', timeout: 60000 });
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate(() => {
  localStorage.setItem('gcwasm_romIdx', '0');
  const sel = document.getElementById('romSelect');
  if (sel) sel.value = '0';
  const b = document.getElementById('btnStart');
  if (b) b.click();
});
console.log('[fix] MP4 boot started; waiting ' + BOOT_MS + 'ms for the renderer to come up...');
await new Promise((r) => setTimeout(r, BOOT_MS));
await page.screenshot({ path: '/tmp/recomp_fix_pre.png' });
console.log('[fix] pre-injection screenshot -> /tmp/recomp_fix_pre.png');

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
  dolphin_worker.postMessage({ cmd: 'recompFix', fifo, mem1, regions, pauseCpu, skipDL: location.hash.includes('skipdl'), pumps: 100000 }, [fifo, mem1]);
  return 'posted fifo=' + fifo.byteLength + ' mem1=' + mem1.byteLength + ' arrays=' + regions.arrays.length;
}, PAUSE_CPU);
console.log('[fix] inject:', armed);
await new Promise((r) => setTimeout(r, POST_MS));
await page.screenshot({ path: '/tmp/recomp_fix_post.png' });
console.log('[fix] post-injection screenshot -> /tmp/recomp_fix_post.png');
// EFB grid peek: fragments in the EFB vs XFB/present losses
await page.evaluate(() => dolphin_worker.postMessage({ cmd: 'recompEfbPeek' }));
await new Promise((r) => setTimeout(r, 1500));
await browser.close();
srv.close();

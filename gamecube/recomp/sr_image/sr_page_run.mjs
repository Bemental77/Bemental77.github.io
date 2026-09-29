// sr_page_run.mjs — run the ?srimage=1&srrender=1 guest arm of gamecube.html in Chrome and
// report it AS IT RUNS: every [srimage] / [recompLive] console line is written out with its wall
// time the moment it arrives, so a run that crashes or hangs still leaves its evidence.
//
// WHY NOT gamecube/tools/dolphin_render_probe.js.  That probe buffers the page's console and
// prints it at the END of the run.  Measured 2026-09-29: two guest-arm runs died before the end
// (a "Page crashed!" and a hung end-of-run dump), and both left ZERO guest lines.  This harness
// is small on purpose: serve, click Start, stream, screenshot, stop.
//
//   SRR_ROOT=<hermetic tree> SRR_MS=300000 SRR_OUT=/tmp/run.jsonl SRR_SHOTS=60000,180000 \
//   SRR_SHOT_PREFIX=/tmp/run NODE_PATH=~/probe-deps/node_modules node gamecube/recomp/sr_image/sr_page_run.mjs
//
// SRR_ROOT should be a HERMETIC copy of the tree (CLAUDE.md gate 10: a sibling relink tore the
// Dolphin .wasm under a live run on 2026-09-29 -> "BufferSource argument is empty").  The md5 of
// the guest image and of Dolphin's worker are printed before AND after.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const resolveDep = (n) => { for (const d of (process.env.NODE_PATH || '').split(':').filter(Boolean)) {
  try { return require(path.join(d, n)); } catch (_) {} } return require(n); };
const puppeteer = resolveDep('puppeteer');

const ROOT = path.resolve(process.env.SRR_ROOT || REPO);
const MS = +(process.env.SRR_MS || 300000);
const OUT = process.env.SRR_OUT || '/tmp/sr_page_run.jsonl';
const SHOTS = (process.env.SRR_SHOTS || '').split(',').filter(Boolean).map(Number);
const SHOT_PREFIX = process.env.SRR_SHOT_PREFIX || '/tmp/sr_page_run';
const QUERY = process.env.SRR_QUERY ||
  'srimage=1&srrender=1&srmode=main&srbase=/gamecube/recomp/sr_image/guest/&srdisc=1500';
const CHROME = process.env.SRR_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.gz': 'application/octet-stream' };
// The game library is served under lib/asset_base.js's prefix (e.g. /gamedata) in production and
// is THIS tree locally — map it back, as dolphin_render_probe.js does, or every ROM chunk 404s.
const OFFSITE = (() => { try { const m = /^window\.ASSET_BASE\s*=\s*'([^']*)'/m
  .exec(fs.readFileSync(path.join(ROOT, 'lib', 'asset_base.js'), 'utf8')); return m ? m[1] : ''; } catch { return ''; } })();
const srv = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (OFFSITE && (rel === OFFSITE || rel.startsWith(OFFSITE + '/'))) rel = rel.slice(OFFSITE.length) || '/';
  const file = path.join(ROOT, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size, 'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const md5 = (p) => { try { return createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex'); }
  catch { return 'MISSING'; } };
const HASHED = ['gamecube/recomp/sr_image/guest/sab_image.wasm', 'gamecube/dolphin_libretro/dolphin_worker_emcc.wasm',
  'gamecube/dolphin_libretro/dolphin_worker_emcc.js'];
const before = HASHED.map(md5);
const out = fs.createWriteStream(OUT);
const t0 = Date.now();
const log = (o) => { o.t = Date.now() - t0; const s = JSON.stringify(o); out.write(s + '\n'); console.log(s.slice(0, 300)); };
log({ kind: 'start', root: ROOT, port, md5: before, query: QUERY });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--disable-background-timer-throttling',
         '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--disable-features=IntensiveWakeUpThrottling', '--disable-dev-shm-usage',
         '--js-flags=--max-old-space-size=4096'], protocolTimeout: 120000 });
try { require(path.join(REPO, 'tools/browser_leak_guard.js')).guard(browser, fileURLToPath(import.meta.url)); } catch (_) {}
const page = await browser.newPage();
let errLines = 0;
page.on('console', (m) => {
  const s = m.text();
  if (!/\[srimage\]|\[recompLive\]|srimage|first frame/.test(s)) {
    if (m.type() === 'error' && errLines++ < 200) log({ kind: 'console-error', text: s.slice(0, 300) });
    return;
  }
  let j = null; const i = s.indexOf('{');
  if (i >= 0) { try { j = JSON.parse(s.slice(i)); } catch (_) {} }
  log(j ? { kind: 'sr', msg: j } : { kind: 'line', text: s.slice(0, 400) });
});
let n404 = 0;
page.on('response', (r) => { if (r.status() >= 400 && n404++ < 50) log({ kind: 'http', status: r.status(), url: r.url().slice(0, 200) }); });
page.on('pageerror', (e) => log({ kind: 'pageerror', text: String(e && e.message || e).slice(0, 400) }));
page.on('crash', () => log({ kind: 'crash' }));
page.on('error', (e) => log({ kind: 'error', text: String(e && e.message || e) }));

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/gamecube.html?v=${Date.now()}&${QUERY}`, { waitUntil: 'load', timeout: 60000 });
  // coi-serviceworker reloads the page once on a fresh origin: wait until two evaluates agree
  for (let ok = 0, last = '', n = 0; ok < 2 && n < 80; n++) {
    try { const h = await page.evaluate(() => location.href); ok = h === last ? ok + 1 : 1; last = h; } catch { ok = 0; }
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.evaluate(() => { localStorage.setItem('gcwasm_romIdx', '1');
    const s = document.getElementById('romSelect'); if (s) s.value = '1'; });   // 1 = SAB (CLAUDE.md gate 1)
  const picked = await page.evaluate(() => { const s = document.getElementById('romSelect');
    document.getElementById('btnStart').click(); return s && s.options[+s.value] ? s.options[+s.value].textContent : '?'; });
  log({ kind: 'clicked', rom: picked, env: await page.evaluate(async () => ({ coi: self.crossOriginIsolated,
    sab: typeof SharedArrayBuffer, gpu: !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)) })) });
  const tStart = Date.now();
  for (const at of SHOTS.sort((a, b) => a - b)) {
    const wait = at - (Date.now() - tStart);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { const f = `${SHOT_PREFIX}_${at}.png`; await page.screenshot({ path: f }); log({ kind: 'shot', file: f }); }
    catch (e) { log({ kind: 'shot-failed', text: String(e.message) }); }
  }
  const rest = MS - (Date.now() - tStart);
  if (rest > 0) await new Promise((r) => setTimeout(r, rest));
} catch (e) { log({ kind: 'harness-error', text: String(e && e.message || e) }); exitCode = 1; }
const after = HASHED.map(md5);
log({ kind: 'end', md5: after, hashesStable: after.every((h, i) => h === before[i]) });
out.end();
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15000))]);
try { browser.process() && browser.process().kill('SIGKILL'); } catch (_) {}
srv.close();
process.exit(exitCode);

// gcsnap.mjs — boot MP4 (recomp path), snap title + mode-select frames.
// env: ROOT (served dir), QUERY (e.g. "?wgpu=0&hwRender=0"), TAG, THROTTLE=1 (render a frame
// only after the previous rendered frame was PUBLISHED — keeps the software GPU queue at ~1),
// ROM (default 0), DUR (s after mode-select press), ALL=1 (print all console).
import http from 'http'; import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(process.env.HOME + '/probe-deps/'); const puppeteer = require('puppeteer');
const ROOT = process.env.ROOT, TAG = process.env.TAG || 'x', Q = process.env.QUERY || '';
const OUT = process.env.OUT || '/tmp/gcsnap'; fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json' };
const srv = http.createServer((q, r) => {
  r.setHeader('Cross-Origin-Opener-Policy','same-origin'); r.setHeader('Cross-Origin-Embedder-Policy','require-corp'); r.setHeader('Cross-Origin-Resource-Policy','cross-origin');
  const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0].split('#')[0]));
  fs.stat(f, (e, s) => { if (e || !s.isFile()) { r.statusCode = 404; return r.end(); }
    const range = q.headers.range; const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); r.setHeader('Accept-Ranges', 'bytes');
    if (m) { const a = +m[1], z = m[2] ? Math.min(+m[2], s.size - 1) : s.size - 1; r.statusCode = 206;
      r.setHeader('Content-Range', `bytes ${a}-${z}/${s.size}`); r.setHeader('Content-Length', z - a + 1); return fs.createReadStream(f, { start: a, end: z }).pipe(r); }
    r.setHeader('Content-Length', s.size); fs.createReadStream(f).pipe(r); });
});
await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
const b = await puppeteer.launch({ protocolTimeout: 900000, ignoreDefaultArgs: ['--disable-dev-shm-usage'], executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: 'new',
  args: ['--no-sandbox','--enable-unsafe-webgpu','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-features=IntensiveWakeUpThrottling'] });
const p = await b.newPage(); const errs = []; const t0 = Date.now(); const T = () => ((Date.now()-t0)/1000).toFixed(0);
p.on('pageerror', e => { errs.push(e.message.slice(0, 200)); console.log(`[t=${T()}] PAGEERROR ${e.message.slice(0,200)}`); });
p.on('console', m => { const t = m.text(); if (process.env.ALL || /\[harness\]|gcgate|recompLive\] f|Call New Ovl|DEVICE LOST|RuntimeError|\[wgpu\]|uncaptured|WGPU|error/i.test(t)) console.log(`[t=${T()}] ` + (t.includes("TRACE") ? t : t.slice(0, 300))); });
await p.goto(`http://127.0.0.1:${srv.address().port}/gamecube.html${Q}`, { waitUntil: 'load', timeout: 60000 });
await new Promise(r => setTimeout(r, 1000));
const ROM = process.env.ROM || '0';
await p.evaluate((rom) => { localStorage.setItem('gcwasm_romIdx', rom); const s = document.getElementById('romSelect'); if (s) s.value = rom; document.getElementById('btnStart').click(); }, ROM);
if (process.env.KILLJIT) await p.evaluate(() => { const iv = setInterval(() => { if (window.ppc_worker) { try { window.ppc_worker.terminate(); } catch (e) {} window.ppc_worker = null; console.log('[harness] ppc_worker terminated early (no JIT-phase frames)'); clearInterval(iv); } }, 20); });
if (process.env.GATE_AT) await p.evaluate((at, k, t0off) => {
  // needs /gcgate.js in the overlay worker shim. Before `at`: render every recomp frame with the GPU
  // gate CLOSED (state + texture uploads stay current, no GPU work). Then k frames with the gate OPEN.
  // After that: skip every frame (no present => nothing overwrites the ring).
  const T0 = performance.now() - t0off; let left = k;
  self.__gate = { at, k, sent: 0, closed: 0, skipped: 0 };
  const iv = setInterval(() => {
    const w = window.dolphin_worker; if (!w || w.__hooked) return; w.__hooked = true;
    const orig = w.postMessage.bind(w);
    self.__gcDumps = [];
    w.addEventListener('message', (e) => { const d = e.data; if (d && d.cmd === 'gcgateDump') {
      const px = new Uint8ClampedArray(d.px); for (let j = 3; j < px.length; j += 4) px[j] = 255;
      const oc = document.createElement('canvas'); oc.width = d.w; oc.height = d.h; oc.getContext('2d').putImageData(new ImageData(px, d.w, d.h), 0, 0);
      self.__gcDumps.push({ seq: d.seq, w: d.w, h: d.h, url: oc.toDataURL('image/png') }); } });
    w.postMessage = function (m, t) {
      if (m && m.cmd === 'recompFrame') {
        const ts = (performance.now() - T0) / 1000;
        if (ts < at) { m.skipRender = false; m.gate = false; self.__gate.closed++; }
        else if (left > 0) { m.skipRender = false; m.gate = true; left--; self.__gate.sent++; self.__gate.openAt = self.__gate.openAt || ts; }
        else { m.skipRender = true; m.gate = false; self.__gate.skipped++; }
      }
      return orig(m, t);
    };
  }, 100);
}, +process.env.GATE_AT, +(process.env.GATE_K || 3), Date.now() - t0);
if (process.env.THROTTLE) await p.evaluate((to) => { self.__thrTO = to;
  const iv = setInterval(() => {
    const w = window.dolphin_worker; if (!w || w.__hooked) return; w.__hooked = true;
    const orig = w.postMessage.bind(w);
    let lastSeq = -1, sentAt = 0; self.__thr = { rendered: 0, skipped: 0 };
    w.postMessage = function (m, t) {
      if (m && m.cmd === 'recompFrame') {
        const seq = new Uint32Array(sharedMemory.buffer)[0x026B3518 / 4];
        const ok = lastSeq < 0 || seq !== lastSeq || (performance.now() - sentAt) > (+self.__thrTO || 30000);
        if (ok) { lastSeq = seq; sentAt = performance.now(); m.skipRender = false; self.__thr.rendered++; }
        else { m.skipRender = true; self.__thr.skipped++; }
      }
      return orig(m, t);
    };
  }, 100);
}, +(process.env.THR_TO || 30000));
setInterval(async () => { try { const v = await p.evaluate(() => { const u = new Uint32Array(sharedMemory.buffer); return [u[0x026B3518/4], u[0x026E0008/4], JSON.stringify(self.__thr || self.__gate || {}), [u[0x026B3500/4], u[0x026B3504/4], u[0x026B3508/4], u[0x026B350C/4]].join("/")]; }); console.log(`[t=${T()}] seq=${v[0]} ringpub=${v[1]} thr=${v[2]} show/rb/cb/pub=${v[3]}`); } catch (e) {} }, 10000);
const press = async (code) => { await p.keyboard.down(code); await new Promise(r => setTimeout(r, 150)); await p.keyboard.up(code); console.log(`[t=${T()}] press ${code}`); };
const snap = async (name) => {
  const r = await p.evaluate(() => {
    const out = {};
    const c = document.getElementById('canvas');
    try { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let nz = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 30) nz++; out.canvas = c.toDataURL('image/png'); out.cnz = nz; } catch (e) { out.cerr = String(e); }
    try { // newest ring slot straight from the shared heap (WGPU path only)
      const u = new Uint32Array(sharedMemory.buffer); const R = 0x026E0000 / 4;
      if (u[R] === 0x31475250) { const pub = u[R + 2], slots = u[R + 1]; const s = R + 4 + ((pub - 1) & (slots - 1)) * 4;
        const ptr = u[s], w = u[s + 1] >>> 16, h = u[s + 1] & 0xffff;
        const px = new Uint8ClampedArray(w * h * 4); px.set(new Uint8Array(sharedMemory.buffer, ptr, w * h * 4));
        for (let i = 3; i < px.length; i += 4) px[i] = 255;
        const oc = document.createElement('canvas'); oc.width = w; oc.height = h; oc.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
        out.ring = oc.toDataURL('image/png'); out.ringpub = pub; }
    } catch (e) { out.rerr = String(e); }
    return out;
  });
  if (r.canvas) fs.writeFileSync(`${OUT}/${TAG}-${name}-canvas.png`, Buffer.from(r.canvas.split(',')[1], 'base64'));
  if (r.ring) fs.writeFileSync(`${OUT}/${TAG}-${name}-ring.png`, Buffer.from(r.ring.split(',')[1], 'base64'));
  console.log(`[t=${T()}] snap ${name} canvasNonBlack=${r.cnz} ring=${r.ring ? 'pub' + r.ringpub : 'none'} ${r.cerr || ''} ${r.rerr || ''}`);
};
const TITLE = +(process.env.TITLE_AT || 66);
const plan = (process.env.PLAN || `${TITLE - 8}:snap:t0,${TITLE - 2}:snap:t1,${TITLE}:Enter,${TITLE + 2}:Enter,${TITLE + 20}:snap:m20,${TITLE + 40}:snap:m40,${TITLE + 60}:snap:m60,${TITLE + 90}:snap:m90`)
  .split(',').map(s => s.split(':'));
for (const [at, k, name] of plan) {
  while ((Date.now() - t0) / 1000 < +at) await new Promise(r => setTimeout(r, 250));
  if (k === 'snap') await snap(name);
  else if (k === 'ram') { // ram:<name> -> guest RAM bytes at RAMADDRS, read inside the worker (needs /gcgate.js)
    const r = await p.evaluate((addrs) => new Promise((res) => {
      const w = window.dolphin_worker; if (!w) return res('no worker');
      const h = (e) => { if (e.data && e.data.cmd === 'gcgateRamReply') { w.removeEventListener('message', h); res(JSON.stringify(e.data)); } };
      w.addEventListener('message', h); w.postMessage({ cmd: 'gcgateRam', addrs, len: 16 }); setTimeout(() => res('timeout'), 5000);
    }), (process.env.RAMADDRS || '0x10240,0x10400,0x10800').split(',').map(x => parseInt(x)));
    console.log(`[t=${T()}] RAM ${name} ${r}`);
  }
  else if (k === 'cells') { // cells:<name> -> dump CELLS env "hexaddr:count"
    const [ad, cnt] = (process.env.CELLS || '0x026B3B40:73').split(':');
    const v = await p.evaluate((a, c) => Array.from(new Uint32Array(sharedMemory.buffer, a, c)).map(x => (x >>> 0).toString(16)), parseInt(ad), +cnt);
    console.log(`[t=${T()}] CELLS ${ad}: ${v.join(' ')}`);
  }
  else if (k === 'settle') { // wait until the ring publish index has not moved for 90 s (after the gate window), then dump all slots
    let last = -1, since = Date.now();
    for (;;) { const v = await p.evaluate(() => [new Uint32Array(sharedMemory.buffer)[0x026E0008 / 4] * 100 + (self.__gcDumps || []).length, (self.__gate || {}).sent | 0, (self.__gcDumps || []).length]);
      if (v[0] !== last) { last = v[0]; since = Date.now(); console.log(`[t=${T()}] settle progress ring*100+dumps=${v[0]}`); }
      if (v[1] >= +(process.env.GATE_K || 3) && v[2] >= +(process.env.NDUMPS || 1) && Date.now() - since > 60000) break;
      await new Promise(r => setTimeout(r, 3000)); }
    const slots = await p.evaluate(() => { const u = new Uint32Array(sharedMemory.buffer); const R = 0x026E0000 / 4; const out = [];
      for (let i = 0; i < u[R + 1]; i++) { const s = R + 4 + i * 4, ptr = u[s], w = u[s + 1] >>> 16, h = u[s + 1] & 0xffff; if (!ptr || !w) continue;
        const px = new Uint8ClampedArray(w * h * 4); px.set(new Uint8Array(sharedMemory.buffer, ptr, w * h * 4)); for (let j = 3; j < px.length; j += 4) px[j] = 255;
        const oc = document.createElement('canvas'); oc.width = w; oc.height = h; oc.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
        out.push({ pub: u[s + 3], url: oc.toDataURL('image/png') }); } return out; });
    const dumps = await p.evaluate(() => self.__gcDumps || []);
    for (const d of dumps) fs.writeFileSync(`${OUT}/${TAG}-${name}-rt${d.seq}-${d.w}x${d.h}.png`, Buffer.from(d.url.split(',')[1], 'base64'));
    console.log(`[t=${T()}] rt dumps: ${dumps.map(d => d.seq + ':' + d.w + 'x' + d.h).join(' ')}`);
    for (const sl of slots) fs.writeFileSync(`${OUT}/${TAG}-${name}-pub${sl.pub}.png`, Buffer.from(sl.url.split(',')[1], 'base64'));
    console.log(`[t=${T()}] settle ${name}: ring pubs ${slots.map(x => x.pub).join(',')} gate=${JSON.stringify(await p.evaluate(() => self.__gate))}`);
  }
  else if (k === 'waitpub') { // wait until TWO more frames publish (so one was rendered after now), then snap
    const pub0 = await p.evaluate(() => new Uint32Array(sharedMemory.buffer)[0x026E0008 / 4]);
    while ((await p.evaluate(() => new Uint32Array(sharedMemory.buffer)[0x026E0008 / 4])) < pub0 + 2) await new Promise(r => setTimeout(r, 2000));
    await snap(name);
  } else await press(k);
}
console.log('pageerrors', errs.length, JSON.stringify(errs.slice(0, 5)));
await b.close(); srv.close(); process.exit(0);

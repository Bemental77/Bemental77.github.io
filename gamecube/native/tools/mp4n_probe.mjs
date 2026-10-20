// gamecube/native/tools/mp4n_probe.mjs — headless driver for mp4-native.html (the MP4 source port).
// Serves the repo with tools/devserver.mjs on its own port, boots the page in Chrome (SwiftShader
// Vulkan WebGPU when there is no GPU), and reports state every WAIT/NSHOT seconds with screenshots.
//   node gamecube/native/tools/mp4n_probe.mjs <waitS> <out.png> [extra query, e.g. "epoch=820000000&hash=30"]
// env:
//   NSHOT=n          screenshots/state samples over the run (out_0.png ..)
//   POKE=frame:hexaddr:and:or  a u16 of game memory rewritten at that frame's boundary (before an RBTEST enable)
//   HEAPSCAN=frame:b-e,..:hostlo HEAPSCANOUT=f.json  game-memory words that point at the C stack/heap (diff two runs)
//   PIXTEST=N:a-b:every,.. PIXOUT=dir  draw exactly every Nth frame (no frame skip, GPU waited) and save captures
//   PEEK=hexaddr:len,..  bytes of wasm memory at the end of the run
//   ROUTE=file.json  a room route ([f0,f1,buttons,overlay?]), inputs memoized per frame (rollback-safe)
//   SCRIPT='[[f0,f1,buttons],..]'  port-0 input by guest frame (GC PAD_* bits; 4096=Start, 256=A)
//   NAV=board        overlay-relative route: title -> file -> Party Mode -> 1P+3COM -> board -> play
//                    (NAVLEFT=n board-select LEFT presses, default 4; NAVASTEP=n A every n frames on the board, default 150)
//   HASHOUT=f.json   with &hash=N: game-state hashes every N frames (compare two runs for determinism)
//   SNAPTEST=f1,f2   whole-memory snapshot at f1, run to f2, restore, rerun, compare hashes
//   DIFFAT=f DIFFOUT=f.json [DUMPADDR=a]  per-4KB state checksums at frame f (find what diverges)
//   WAV=f.wav        with &audrec=S: the first S seconds of game audio
//   RBPOOL=n RBKEEP=1  with RBTEST: a small page pool, and rb_keep(f - depth) at every boundary (the pool must grow, not overwrite)
//   RBTEST=at,period,depth  rollback self-test (needs the write-barrier build): logging on from frame `at`;
//                    every `period` frames rewind `depth` frames (mp4web_rb_restore) and re-run them on the
//                    same input; every re-run frame's fingerprint must equal its first run's, and the
//                    restored state's must equal the one recorded at that frame
//   SKIPTEST=a,b,stop  frames in [a,b) alternate drawn / undrawn (mp4web_set_gfx_skip), then the game HOLDS at
//                    `stop` so the canvas keeps frame stop-1: compare the picture with a=b (nothing skipped)
//   RBON=at          rollback logging on from `at` (a boundary every frame, no hashing, no rewinds):
//                    what the write barrier costs while a room runs
//   VW/VH/DPR/MOBILE=1  viewport, devicePixelRatio, mobile+touch emulation; CPUTHROTTLE=n  CDP CPU slowdown x n
//   KEYS="sec:Code:holdMs,.."  real keyboard presses;  DUMPIO=1 Chrome stderr;  NOSS=1 no ANGLE SwiftShader
// Before measured runs: node tools/browser_leak_guard.js reap && uptime; wrap in tools/probe_lock.sh run --
import { createRequire } from 'module';
import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const guard = (await import(ROOT + '/tools/browser_leak_guard.js')).default;
const [waitS, out, qs = ''] = process.argv.slice(2);
const PORT = +(process.env.PROBE_PORT || 18978);   // PROBE_PORT: parallel correctness shards (perf runs stay serialized under tools/probe_lock.sh)
const srv = spawn('node', [ROOT + '/tools/devserver.mjs'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4n-'));
const b = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: 'new', userDataDir: udd, dumpio: !!process.env.DUMPIO,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', ...(process.env.NOSS ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--window-size=1280,1000'] });
try { guard.guard(b, 'scratch mp4n'); } catch (_e) {}
const logs = []; const t0 = Date.now();
try {
  const p = await b.newPage(); await p.setViewport({ width: +(process.env.VW || 1100), height: +(process.env.VH || 1000), deviceScaleFactor: +(process.env.DPR || 1), isMobile: !!process.env.MOBILE, hasTouch: !!process.env.MOBILE });
  if (process.env.CPUTHROTTLE) { const cdp = await p.target().createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +process.env.CPUTHROTTLE }); }
  await p.evaluateOnNewDocument(() => { window.addEventListener('error', (ev) => console.log('ERRSTACK ' + (ev.error && ev.error.stack))); window.addEventListener('unhandledrejection', (ev) => console.log('REJSTACK ' + (ev.reason && ev.reason.stack)));  });
  await p.evaluateOnNewDocument(() => { Error.stackTraceLimit = 100; for (const k of ['warn', 'error', 'log']) { const o = console[k].bind(console); console[k] = (...a) => { const t = a.join(' '); o(...a); if (/Instance reference|Device lost|Aborted/.test(t)) o('JSSTACK ' + new Error().stack.split('\n').slice(2, 40).map((l) => l.trim().replace(/\(?http[^)]*\)?/, '')).join(' | ')); }; } });
  p.on('console', (m) => { logs.push(((Date.now() - t0) / 1000).toFixed(1) + ' ' + m.text().slice(0, /JSSTACK|ERRSTACK|REJSTACK/.test(m.text()) ? 8000 : 500)); if (/Instance reference|Aborted|rror/.test(m.text())) logs.push('  STACK ' + m.stackTrace().slice(0, 25).map((f) => f.url.split('/').pop() + ':' + f.lineNumber + ' ' + (f.functionName||'')).join(' < ')); });
  p.on('response', (r) => { if (r.status() >= 400) logs.push('HTTP ' + r.status() + ' ' + r.url()); });
  p.on('pageerror', (e) => logs.push('PAGEERROR ' + String(e.message).slice(0, 400) + ' :: ' + String(e.stack || '').slice(0, 1500)));
  // HEAPSHIFT=n (diagnostic): malloc n bytes once the runtime is up, before main — shifts every later C-heap
  // address, as a second console's different allocation history would (pairs with HEAPSCAN)
  if (process.env.HEAPSHIFT) await p.evaluateOnNewDocument((n) => { let real; Object.defineProperty(window, 'createMp4Native', { configurable: true, set(f) { real = f; }, get() { return real && ((o) => { o = o || {}; const prev = o.onRuntimeInitialized; o.onRuntimeInitialized = function () { try { this._malloc(n); console.log('HEAPSHIFT ' + n); } catch (e) { console.log('HEAPSHIFT failed ' + e); } if (prev) prev.call(this); }; return real(o); }); } }); }, +process.env.HEAPSHIFT);
  await p.goto(`http://127.0.0.1:${PORT}/mp4-native.html?autostart=1${qs ? '&' + qs : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // KEYS="sec:Code:holdMs,..." real keyboard presses; SCRIPT='[[f0,f1,buttons],...]' frame-scripted pad 0
  if (process.env.KEYS) for (const k of process.env.KEYS.split(',')) { const [sec, code, hold] = k.split(':'); setTimeout(async () => { try { await p.keyboard.down(code); await sleep(+hold || 300); await p.keyboard.up(code); logs.push('KEY ' + code + ' @' + sec); } catch (e) {} }, +sec * 1000); }
  // ROUTE=file.json: a room route ([f0, f1, buttons, overlay?] — an entry with an overlay applies only while that
  // overlay is the latest "DLLStart"), port 0. Each frame's input is fixed the first time the frame runs, so a
  // rollback self-test's re-run sees exactly the first pass's input (as a room's recorded inputs are).
  if (process.env.ROUTE) {
    const R = JSON.parse(fs.readFileSync(process.env.ROUTE, 'utf8'));
    p.on('console', (msg) => { const mm = /DLLStart (\d+)/.exec(msg.text()); if (mm) p.evaluate((o) => { window.__routeOvl = o; }, +mm[1]).catch(() => {}); });
    await p.waitForFunction(() => window.Mp4Input, { timeout: 120000 });
    // ROUTEOVL=hexaddr: read the current overlay from game memory (omcurovl, from the link map) when the input is
    // latched, instead of from console messages, whose arrival time varies — two runs then press on the same frames
    await p.evaluate((R, OA) => { const memo = new Map(); window.Mp4Input.override((f) => { let b = memo.get(f); if (b === undefined) { b = 0; const m = window.__mp4n && window.__mp4n.module; const cur = OA && m ? m.HEAP32[OA >> 2] : window.__routeOvl; for (const [a, z, k, ov] of R) if (f >= a && f < z && (ov == null || cur === ov)) b |= k; memo.set(f, b); } const o = new Array(32).fill(0); o[0] = 1; o[1] = b; return o; }); }, R, parseInt(process.env.ROUTEOVL || '0', 16));
  }
  if (process.env.SCRIPT) { await p.waitForFunction(() => window.Mp4Input, { timeout: 120000 }); await p.evaluate((sc) => { const S = JSON.parse(sc); window.Mp4Input.override((f) => { const o = new Array(32).fill(0); o[0] = 1; for (const [a, b, btn, sx, sy] of S) if (f >= a && f < b) { o[1] |= btn; o[2] = sx || 0; o[3] = sy || 0; } if (o[1]) console.log('OVR ' + f + ' ' + o[1]); return o; }); console.log('OVERRIDE SET'); }, process.env.SCRIPT); }
  if (process.env.SNAPTEST) { const [f1, f2] = process.env.SNAPTEST.split(',').map(Number); await p.waitForFunction(() => window.Mp4State && window.__mp4n.module, { timeout: 120000 }); await p.evaluate((f1, f2) => { const S = window.Mp4State, m = window.__mp4n.module, T = window.__snapT = { phase: 'wait' }; const tick = () => { const f = m._mp4web_total(); if (T.phase === 'wait' && f >= f1) { T.phase = 'snapping'; S.requestSnapshot((snap) => { T.snap = snap; T.snapFrame = snap.frame; T.snapMs = S.lastSnapshotMs; T.memMB = snap.mem.length / 1048576; T.phase = 'run1'; }); } else if (T.phase === 'run1' && f >= f2) { T.phase = 'restoring'; T.pass1 = Object.assign({}, S.hashes); S.hashes = Object.create(null); S.requestRestore(T.snap, (fr) => { T.restoredTo = fr; T.restoreMs = S.lastRestoreMs; T.phase = 'run2'; }); } else if (T.phase === 'run2' && f >= f2) { T.pass2 = Object.assign({}, S.hashes); T.phase = 'done'; } if (T.phase !== 'done') setTimeout(tick, 50); }; tick(); }, f1, f2); }
  if (process.env.DIFFAT) { await p.waitForFunction(() => window.Mp4State && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 }); await p.evaluate((F, D) => { const m = window.__mp4n.module, prev = m.mp4FrameHook; m.mp4FrameHook = (f) => { if (f === F) { const pr = m._malloc(32); m._mp4web_state_ranges(pr); const R = Array.from(new Uint32Array(m.HEAPU8.buffer, pr, 8)); m._free(pr); const H = m.HEAPU8, CH = 4096; const sum = (a, b) => { const out = []; for (let o = a; o < b; o += CH) { let h = 2166136261; const e = Math.min(b, o + CH); for (let i = o; i < e; i++) { h ^= H[i]; h = Math.imul(h, 16777619); } out.push([o, h >>> 0]); } return out; }; window.__diff = { R, mem1: sum(R[0], R[0] + R[1]), data: sum(R[2], R[3]), bss: sum(R[4], R[6]).concat(sum(R[7], R[5])), dump: D ? Array.from(H.subarray(D, D + 4096)) : null }; } return prev(f); }; }, +process.env.DIFFAT, +(process.env.DUMPADDR || 0)); }
  if (process.env.SKIPTEST) { const [a, bb, stop] = process.env.SKIPTEST.split(',').map(Number); await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 }); await p.evaluate((a, bb, stop) => { const m = window.__mp4n.module, prev = m.mp4FrameHook; m.mp4FrameHook = (f) => { const r = prev(f); if (f >= stop) { m._mp4web_set_gfx_skip(0); window.__held = f; return r | 2; } m._mp4web_set_gfx_skip(f >= a && f < bb && (f & 1) ? 1 : 0); return r; }; }, a, bb, stop); }
  // CNTDUMP=out.json CNTN=n: with a store-counting barrier build (?build=…, Module.__wx.mp4web_cnt_set) — dynamic store counts per instrumentation site
  if (process.env.CNTDUMP) { await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.__wx, { timeout: 120000 }); await p.evaluate((n) => { const m = window.__mp4n.module; const ptr = m._malloc(n * 4); m.HEAPU8.fill(0, ptr, ptr + n * 4); m.__wx.mp4web_cnt_set(ptr); window.__cnt = { ptr, n }; }, +(process.env.CNTN || 600000)); }
  if (process.env.RBON) { const ea = +process.env.RBON; await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 }); await p.evaluate((ea) => { const m = window.__mp4n.module, prev = m.mp4FrameHook; let on = false; m.mp4FrameHook = (f) => { const r = prev(f); if (!on && f >= ea) { window.__rbOnRc = m._mp4web_rb_enable(f, 40, 8192); on = true; } else if (on) m._mp4web_rb_boundary(f); return r; }; }, ea); }
  // POKE=frame:hexaddr:and:or — at the boundary before `frame`, a u16 in game memory becomes (v & and) | or
  // (hex masks). Use it BEFORE an RBTEST's enable frame (an unlogged JS write); e.g. turn a party's
  // per-turn save on so a rewind can span one.
  if (process.env.POKE) {
    const [pf, pa, pand, por] = process.env.POKE.split(':');
    await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 });
    await p.evaluate((F, A, AND, OR) => { const m = window.__mp4n.module, prev = m.mp4FrameHook; let done = false; m.mp4FrameHook = (f) => { if (!done && f >= F) { done = true; const H = m.HEAPU8, v = H[A] | (H[A + 1] << 8), w = (v & AND) | OR; H[A] = w & 255; H[A + 1] = w >> 8; console.log('POKE f=' + f + ' ' + A.toString(16) + ' ' + v.toString(16) + ' -> ' + w.toString(16)); } return prev(f); }; }, +pf, parseInt(pa, 16), parseInt(pand, 16), parseInt(por, 16));
  }
  // HEAPSCAN=frame:ranges:hostlo HEAPSCANOUT=f.json — at that frame's boundary, every aligned u32 in the given
  // game-memory ranges ("b-e,b-e" hex, e.g. .data and the hashed .bss) whose value points past the static data
  // (>= hostlo: the C stack and the C heap, whose addresses differ between two consoles). Diff two runs'
  // files to find host pointers kept in game state.
  if (process.env.HEAPSCAN) {
    const [hf, hr, hlo] = process.env.HEAPSCAN.split(':');
    await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 });
    await p.evaluate((F, R, LO) => { const m = window.__mp4n.module, prev = m.mp4FrameHook; m.mp4FrameHook = (f) => { if (f === F && !window.__heapScan) { const H = m.HEAP32, hi = m.HEAPU8.length, out = []; for (const [b, e] of R) for (let a = b & ~3; a < e; a += 4) { const v = H[a >> 2] >>> 0; if (v >= LO && v < hi) out.push([a, v]); } window.__heapScan = { f, n: out.length, out }; console.log('HEAPSCAN f=' + f + ' ' + out.length + ' words'); } return prev(f); }; }, +hf, hr.split(',').map((x) => x.split('-').map((y) => parseInt(y, 16))), parseInt(hlo, 16));
  }
  // PIXTEST=N:a-b:every[,a-b:every..] PIXOUT=dir — a DETERMINISTIC PICTURE: auto frame-skip off and the GPU waited
  // for (no scratch frames), so exactly the frames f % N == 0 are drawn; the drawn frames f in [a,b) with
  // f % every == 0 are captured (canvas -> 2D -> PNG) to PIXOUT/f<frame>.png. Two runs that differ only in a
  // host-side setting (e.g. ?fifoskip) must give the same PNGs.
  if (process.env.PIXTEST) {
    const [pn, ...rs] = process.env.PIXTEST.split(':'); const ranges = rs.join(':').split(',').map((x) => { const [ab, ev] = x.split(':'); const [a0, b0] = ab.split('-').map(Number); return [a0, b0, +ev]; });
    const dir = process.env.PIXOUT || '/tmp/pix'; fs.mkdirSync(dir, { recursive: true });
    await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 });
    await p.evaluate((N, R) => { const m = window.__mp4n.module, prev = m.mp4FrameHook; m._mp4web_set_frameskip(0); if (m._mp4web_set_gpu_nowait) m._mp4web_set_gpu_nowait(0);
      window.__pix = []; let c2 = null;
      m.mp4FrameHook = (f) => { const r = prev(f); const last = f - 1;
        if (last % N === 0 && R.some(([a, b, ev]) => last >= a && last < b && last % ev === 0)) {
          const g = document.getElementById('canvas'); if (!c2) c2 = document.createElement('canvas'); c2.width = g.width; c2.height = g.height;
          const x = c2.getContext('2d'); x.drawImage(g, 0, 0); window.__pix.push([last, c2.toDataURL('image/png')]); }
        m._mp4web_set_gfx_skip(f % N === 0 ? 0 : 1); return r; }; }, +pn, ranges);
    const pull = async () => { const got = await p.evaluate(() => { const o = window.__pix || []; window.__pix = []; return o; }).catch(() => []);
      for (const [f, u] of got) fs.writeFileSync(path.join(dir, 'f' + String(f).padStart(6, '0') + '.png'), Buffer.from(u.split(',')[1], 'base64')); return got.length; };
    const iv = setInterval(() => { pull(); }, 5000); process.on('beforeExit', () => clearInterval(iv)); globalThis.__pixPull = pull; globalThis.__pixIv = iv;
  }
  if (process.env.RBTEST) {
    const [ea, per, dep, toEa] = process.env.RBTEST.split(',').map(Number);   // toEa=1: rewinds may land ON the enable frame (a room's first misprediction)
    await p.waitForFunction(() => window.__mp4n && window.__mp4n.module && window.__mp4n.module.mp4FrameHook, { timeout: 120000 });
    if (toEa) await p.evaluate(() => { window.__rbToEa = 1; });
    // RBPOOL=n: page-image pool size at enable (default 8192); RBKEEP=1: tell rollback.c the oldest frame a rewind will target
    await p.evaluate((pool, keep) => { if (pool) window.__rbPool = pool; if (keep) window.__rbKeep = 1; }, +(process.env.RBPOOL || 0), +(process.env.RBKEEP || 0));
    await p.evaluate((ea, per, dep, rbdiff, rbdump) => {
      const m = window.__mp4n.module, prev = m.mp4FrameHook;
      const T = window.__rbT = { on: false, h1: {}, cmp: 0, bad: [], restores: 0, rcmp: 0, rbad: 0, enableRc: null, replayUntil: -1, hashMs: 0, maxHashMs: 0, restoreMs: [] };
      m.mp4FrameHook = (f) => {
        let r = prev(f);
        if (!T.on && f === ea) { T.enableRc = m._mp4web_rb_enable(f, 16, window.__rbPool || 8192); T.on = T.enableRc > 0; if (T.on) { T.h1[f] = m._mp4web_rb_hash(); T.sm = { [f]: [m._mp4web_rb_small_hash(0), m._mp4web_rb_small_hash(1), m._mp4web_rb_small_hash(2)] }; } return r; }   // the enable frame is fingerprinted too: a rewind onto it is checked
        if (!T.on || f <= ea) return r;
        m._mp4web_rb_boundary(f);
        if (window.__rbKeep && m._mp4web_rb_keep) m._mp4web_rb_keep(Math.max(ea, f - dep));   // RBKEEP=1: the pool must grow rather than lose frame f - dep
        const t0 = performance.now(); const h = m._mp4web_rb_hash(); const dt = performance.now() - t0; T.hashMs += dt; if (dt > T.maxHashMs) T.maxHashMs = dt;
        const pageSums = () => { const b = m._mp4web_rb_base(), n = m._mp4web_rb_pages(), H = new Int32Array(m.HEAPU8.buffer, b, n * 1024), out = new Int32Array(n); for (let p = 0; p < n; p++) { let x = 0; const o = p * 1024; for (let i = 0; i < 1024; i++) x = (Math.imul(x, 31) + H[o + i]) | 0; out[p] = x; } return out; };
        if (rbdiff && T.h1[f] === undefined && f === rbdiff) { T.ps = pageSums(); if (rbdump) T.pg = m.HEAPU8.slice(rbdump, rbdump + 4096); }
        if (T.h1[f] === undefined) { T.h1[f] = h; T.sm = T.sm || {}; T.sm[f] = [m._mp4web_rb_small_hash(0), m._mp4web_rb_small_hash(1), m._mp4web_rb_small_hash(2)]; delete T.sm[f - 64]; }
        else { T.cmp++; if (T.h1[f] !== h) T.bad.push(f); }
        // a store into game memory that bypassed the barrier leaves its page's incremental hash stale
        if (f % 60 === 0) { T.fullCmp = (T.fullCmp || 0) + 1; if (m._mp4web_rb_hash_full() !== h) { T.fullBad = (T.fullBad || 0) + 1; if (!T.fullFirst) T.fullFirst = f; } }
        if (f > T.replayUntil && f % per === 0 && f - dep > ea - (window.__rbToEa ? 1 : 0)) {
          const k = f - dep, t1 = performance.now(), rc = m._mp4web_rb_restore(k);
          if (rc === 0) { T.restoreMs.push(performance.now() - t1); m._mp4web_set_frame(k); T.restores++; T.replayUntil = f; r = 1; T.rcmp++; if (m._mp4web_rb_hash() !== T.h1[k]) { T.rbad++; const sm = [m._mp4web_rb_small_hash(0), m._mp4web_rb_small_hash(1), m._mp4web_rb_small_hash(2)], o = T.sm && T.sm[k]; const rec = { k, at: f, full: m._mp4web_rb_hash_full() === T.h1[k], smallDiff: o ? sm.map((x, i) => x !== o[i]) : null };
            if (T.ps && k === rbdiff) { const now = pageSums(), b = m._mp4web_rb_base(), d = []; for (let p = 0; p < now.length; p++) if (now[p] !== T.ps[p]) d.push((b + p * 4096).toString(16)); rec.pages = d.slice(0, 20); rec.npages = d.length; if (m._mp4web_det_owner && d.length) { const q = m._malloc(8); rec.owner = d.slice(0, 4).map((x) => { m._mp4web_det_owner(parseInt(x, 16), q); const o = new Uint32Array(m.HEAPU8.buffer, q, 2); return [o[0].toString(16), o[1]]; }); m._free(q); } }
            if (T.pg && k === rbdiff) { const cur = m.HEAPU8.subarray(rbdump, rbdump + 4096), offs = []; for (let i = 0; i < 4096; i++) if (cur[i] !== T.pg[i]) offs.push(i); rec.bytes = offs.slice(0, 64).map((i) => [(rbdump + i).toString(16), T.pg[i], cur[i]]); rec.nbytes = offs.length; if (offs.length && m._mp4web_det_owner) { const q = m._malloc(8); m._mp4web_det_owner(rbdump + offs[0], q); const o = new Uint32Array(m.HEAPU8.buffer, q, 2); rec.byteOwner = [o[0].toString(16), o[1]]; m._free(q); } }
            (T.rbadAt = T.rbadAt || []).push(rec); } } else { T.rcFail = rc; T.rcFails = (T.rcFails || 0) + 1; }
        }
        return r;
      };
    }, ea, per, dep, +(process.env.RBDIFF || 0), parseInt(process.env.RBDUMP || '0', 16));
  }
  // NAV=board: inputs keyed to overlay starts (console "DLLStart N"), so the route survives timing shifts
  if (process.env.NAV) {
    p.on('console', (msg) => { const mm = /DLLStart (\d+)/.exec(msg.text()); if (mm) p.evaluate((o) => { const m = window.__mp4n && window.__mp4n.module; (window.__ovl = window.__ovl || {})[o] = m ? m._mp4web_total() : 0; window.__ovlLast = o; }, +mm[1]).catch(() => {}); });
    await p.waitForFunction(() => window.Mp4Input, { timeout: 120000 });
    if (process.env.NAVEXTRA) await p.evaluate((x) => { window.__navExtra = JSON.parse(x); }, process.env.NAVEXTRA);
    await p.evaluate((nl, astep) => {
      const A = 256, START = 4096, LEFT = 1;
      const rel70 = [];
      for (const f of [110, 260, 410, 560, 710]) rel70.push([f, A]);
      for (let k = 0; k < nl; k++) rel70.push([860 + 40 * k, LEFT]);   // NAVLEFT: board-select presses (default 4)
      if (window.__navExtra) { for (const e of window.__navExtra) rel70.push(e); } else {
      for (let f = 1060; f <= 3310; f += 200) rel70.push([f, A]);
      rel70.push([3510, START], [3710, START]);
      for (let f = 3910; f < 30000; f += astep) rel70.push([f, A]); }   // NAVASTEP: A every N frames on the board (default 150)
      window.Mp4Input.override((f) => {
        const o = new Array(32).fill(0); o[0] = 1; const ov = window.__ovl || {};
        let btn = 0;
        if (ov[70] !== undefined) { const r = f - ov[70]; for (const [a, b, len] of rel70) if (r >= a && r < a + (len || 8)) btn |= b; }
        else if (ov[74] !== undefined) { const r = f - ov[74]; if (r > 150 && r % 150 < 8) btn |= A; }
        else if (f > 900 && f % 100 < 8) btn |= START;
        o[1] = btn; return o;
      });
    }, +(process.env.NAVLEFT || 4), +(process.env.NAVASTEP || 150));
  }
  const n = +(process.env.NSHOT || 1);
  for (let k = 0; k < n; k++) {
    await sleep(+waitS * 1000 / n);
    const st = await p.evaluate(() => { const m = window.__mp4n || {}; const mod = m.module; return { phase: m.phase, errors: m.errors, frames: mod && mod._mp4web_frames ? mod._mp4web_frames() : null, reanchors: mod && mod._mp4web_reanchors ? mod._mp4web_reanchors() : null, last: window.Mp4Input && window.Mp4Input.last() ? window.Mp4Input.last().slice(0, 4).join('/') : null, total: mod && mod._mp4web_total ? mod._mp4web_total() : null, busy: mod && mod._mp4web_busy_ms ? Math.round(mod._mp4web_busy_ms()) : null, audio: m.audio ? { pushed: m.audio.pushed, nonSilent: m.audio.nonSilent, peak: m.audio.peak, gaps: m.audio.gaps, drops: m.audio.drops, ctx: m.audio.ctx && m.audio.ctx.state, worklet: !!m.audio.node } : null, det: mod && mod._mp4web_det_heap_high_water ? [mod._mp4web_det_heap_high_water(), mod._mp4web_det_heap_fallbacks()] : null, gpuw: mod && mod._mp4web_gpu_wait_ms ? Math.round(mod._mp4web_gpu_wait_ms()) : null, fibersJs: mod && mod.mp4Co ? mod.mp4Co.size : null, jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, drawn: mod && mod._mp4web_drawn ? mod._mp4web_drawn() : null, build: m.build || null, t: performance.now() }; }).catch((e) => ({ err: String(e) }));
    console.log(((Date.now() - t0) / 1000).toFixed(1) + 's ' + JSON.stringify(st));
    await p.screenshot({ path: n > 1 ? out.replace(/\.png$/, '_' + k + '.png') : out });
  }
  if (process.env.SNAPTEST) { const r = await p.evaluate(() => { const T = window.__snapT || {}; return { phase: T.phase, snapFrame: T.snapFrame, restoredTo: T.restoredTo, snapMs: T.snapMs, restoreMs: T.restoreMs, memMB: T.memMB, pass1: T.pass1, pass2: T.pass2 }; }); logs.push('SNAPTEST ' + JSON.stringify(r)); }
  // PEEK=hexaddr:len[,...]: wasm-memory bytes at the end of the run (e.g. a game-memory counter, from the link map)
  if (process.env.PIXTEST) { clearInterval(globalThis.__pixIv); const n = await globalThis.__pixPull(); logs.push('PIXTEST pulled ' + n + ' more -> ' + (process.env.PIXOUT || '/tmp/pix')); }
  if (process.env.HEAPSCAN && process.env.HEAPSCANOUT) { const r = await p.evaluate(() => window.__heapScan || null); fs.writeFileSync(process.env.HEAPSCANOUT, JSON.stringify(r)); logs.push('HEAPSCAN -> ' + process.env.HEAPSCANOUT + ' ' + (r ? r.n : 'none')); }
  if (process.env.PEEK) { const r = await p.evaluate((spec) => { const m = window.__mp4n.module; return spec.split(',').map((x) => { const [a, n] = x.split(':'); const o = parseInt(a, 16); return a + ' ' + Array.from(m.HEAPU8.subarray(o, o + (+n || 4))).map((v) => v.toString(16).padStart(2, '0')).join(''); }); }, process.env.PEEK); logs.push('PEEK ' + r.join(' | ')); }
  if (process.env.RBTEST) { const r = await p.evaluate(() => { const T = window.__rbT, m = window.__mp4n.module; const st = Array.from(new Float64Array(m.HEAPU8.buffer, m._mp4web_rb_stats(), 8)); const rs = T.restoreMs.slice().sort((a, b) => a - b); return { enableRc: T.enableRc, inexactAt: T.rbadAt || [], fullChecked: T.fullCmp || 0, fullMismatch: T.fullBad || 0, fullFirst: T.fullFirst || null, restores: T.restores, restoreExactChecked: T.rcmp, restoreInexact: T.rbad, rerunFramesCompared: T.cmp, mismatches: T.bad.length, firstBad: T.bad.slice(0, 5), rcFail: T.rcFail, rcFails: T.rcFails || 0, restoreMsP50: rs[rs.length >> 1], restoreMsMax: rs[rs.length - 1], avgHashMs: T.hashMs / Math.max(1, Object.keys(T.h1).length + T.cmp), maxHashMs: T.maxHashMs, boundaries: st[0], pagesPerFrame: st[1] / Math.max(1, st[0]), maxPagesPerFrame: st[2], restoredPagesPer: st[4] / Math.max(1, st[3]), lastBoundaryMs: st[6], overflow: st[7] }; }); logs.push('RBTEST ' + JSON.stringify(r)); }
  if (process.env.CNTDUMP) { const c = await p.evaluate(() => { const m = window.__mp4n.module, C = window.__cnt; const a = new Uint32Array(m.HEAPU8.buffer, C.ptr, C.n), o = {}; for (let i = 0; i < C.n; i++) if (a[i]) o[i] = a[i]; return { o, frames: m._mp4web_total() }; }); fs.writeFileSync(process.env.CNTDUMP, JSON.stringify(c)); logs.push('CNTDUMP ' + Object.keys(c.o).length + ' sites, frames ' + c.frames); }
  if (process.env.DIFFOUT) { const d = await p.evaluate(() => window.__diff); fs.writeFileSync(process.env.DIFFOUT, JSON.stringify(d)); logs.push('DIFF ' + !!d); }
  if (process.env.HASHOUT) { const h = await p.evaluate(() => window.Mp4State && window.Mp4State.hashes); fs.writeFileSync(process.env.HASHOUT, JSON.stringify(h)); logs.push('HASHES ' + Object.keys(h || {}).length); }
  if (process.env.WAV) { const b64 = await p.evaluate(() => { const a = window.__mp4n.audio; if (!a || !a.rec) return null; const u = new Uint8Array(a.rec.buffer, 0, a.recLen * 2); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }); if (b64) { const pcm = Buffer.from(b64, 'base64'); const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(32000, 24); h.writeUInt32LE(128000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); fs.writeFileSync(process.env.WAV, Buffer.concat([h, pcm])); logs.push('WAV ' + pcm.length); } }
} finally { console.log(logs.join('\n')); try { await b.close(); } catch (_e) {} srv.kill(); fs.rmSync(udd, { recursive: true, force: true }); }

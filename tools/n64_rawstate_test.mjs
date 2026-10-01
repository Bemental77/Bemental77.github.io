#!/usr/bin/env node
// n64_rawstate_test.mjs — IS THE N64 RAW SAVESTATE EXACT, AND WHAT DOES IT COST, ON THE REAL PAGE?
//
// Drives the SHIPPED page (/n64/, JIT on by default) one lockstep frame at a
// time (_neil_ls_arm + _neil_ls_set_pad + _neil_ls_run_frame) with a scripted
// input that is a pure function of the frame index, and for each rep:
//   1. save raw at frame N (_neil_state_save_raw) — timed;
//   2. run K frames, recording per frame a hash of the WHOLE raw state (RDRAM,
//      the m64p stream, the trailer: event queue, RSP/RDP/AI/PI/SI state,
//      hidden RDRAM bits, save memory) plus _neil_last_fp;
//   3. load raw (_neil_state_load_raw) — timed; record how the code cache was
//      treated (_neil_state_last_load_mode: 1 = only changed code pages,
//      2 = full wipe) and the cost of the first frame after the load;
//   4. re-run the same K frames: every hash must be identical.
// Then a ring of _neil_state_save_raw_fast saves is checked byte-for-byte
// against full saves of the same moment, and save/load timings are reported.
// The trailer's bookkeeping words (nonce, tlb_gen, hid_epoch at trailer+16..28)
// are excluded from the hash: they identify WHEN a buffer was written, not the
// machine state in it.
//
// USAGE (needs `npm run web`, or WEB_ROOT=<hermetic tree> PORT=<n> node tools/devserver.mjs):
//   bash tools/probe_lock.sh run -- node tools/n64_rawstate_test.mjs [--game "Mario Kart 64"] [--warm 600] [--frames 120] [--reps 3] [--url http://localhost:8080] [--jit off] [--query fbasync=0]
// Exit code 0 only if every rep is exact and every fast save matches.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const GAME = flag('game', 'Mario Kart 64'), WARM = +flag('warm', '600'), K = +flag('frames', '120'), REPS = +flag('reps', '3');
const BASE = flag('url', 'http://localhost:8080'), JIT = flag('jit', ''), QX = flag('query', '');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await puppeteer.launch({ headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try { (await import('./browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = { game: GAME, warm: WARM, frames: K, reps: REPS, jit: JIT || 'default', query: QX };
let pass = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => { (out.pageErrors = out.pageErrors || []).push(String(e).slice(0, 300)); });
  const q = `game=${encodeURIComponent(GAME)}&autostart` + (JIT ? `&jit=${JIT}` : '') + (QX ? `&${QX}` : '');
  await page.goto(`${BASE}/n64/?${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Module && Module._neil_ls_arm && window.myApp && window.myApp.rivetsData
    && window.myApp.rivetsData.beforeEmulatorStarted === false, { timeout: 240000 });
  out.hasRawApi = await page.evaluate(() => !!(Module._neil_state_size && Module._neil_state_save_raw && Module._neil_state_load_raw));
  if (!out.hasRawApi) throw new Error('this core build does not export _neil_state_* — rebuild n64/N64Wasm/code');
  const r = await page.evaluate(async (WARM, K, REPS) => {
    const M = window.Module;
    M._neil_ls_arm(1); if (M._neil_fp_always) M._neil_fp_always(1);
    const drive = (f) => {
      const mask = (1 << 4) | ((f % 90) < 30 ? (1 << 3) : 0) | ((f % 240) === 7 ? (1 << 6) : 0) | ((f % 50) === 3 ? (1 << 5) : 0);
      M._neil_ls_set_pad(0, mask, Math.round(Math.sin(f / 20) * 20000), Math.round(Math.cos(f / 33) * 9000));
      for (let p = 1; p < 4; p++) M._neil_ls_set_pad(p, 0, 0, 0);
      M._neil_ls_run_frame();
    };
    const SIZE = M._neil_state_size(), REG = M._neil_state_m64p_region();
    const S = M._malloc(SIZE), B = M._malloc(SIZE), REF = M._malloc(SIZE);
    const RING = 4, ring = []; for (let i = 0; i < RING; i++) ring.push(M._malloc(SIZE));
    if (!S || !B || !REF || ring.some((x) => !x)) return { error: 'malloc failed for ' + (3 + RING) + ' x ' + SIZE + ' bytes' };
    const h32 = (off, len) => { const u = new Uint32Array(M.HEAPU8.buffer, off, len >>> 2); let h = 0x811c9dc5 | 0;
      for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619); return h >>> 0; };
    const stateHash = () => { M._neil_state_save_raw(B); M.HEAPU32.fill(0, (B + REG + 16) >> 2, (B + REG + 28) >> 2);
      return [h32(B + 448, 8 << 20), h32(B, REG), h32(B + REG, SIZE - REG), M._neil_last_fp() >>> 0].map((x) => x.toString(16)).join(':'); };
    let f = 0; for (; f < WARM; f++) drive(f);
    const tf0 = performance.now(); for (let i = 0; i < 30; i++) drive(f++); const frameMs = (performance.now() - tf0) / 30;
    const reps = [];
    for (let k = 0; k < REPS; k++) {
      const f0 = f;
      let t = performance.now(); const n = M._neil_state_save_raw(S); const saveMs = performance.now() - t;
      const X = []; for (let i = 0; i < K; i++) { drive(f0 + i); X.push(stateHash()); }
      t = performance.now(); const ok = M._neil_state_load_raw(S); const loadMs = performance.now() - t;
      const mode = M._neil_state_last_load_mode(), pages = M._neil_state_last_load_pages();
      t = performance.now(); drive(f0); const firstFrameMs = performance.now() - t;
      const Y = [stateHash()]; for (let i = 1; i < K; i++) { drive(f0 + i); Y.push(stateHash()); }
      let first = -1; for (let i = 0; i < K; i++) if (X[i] !== Y[i]) { first = i; break; }
      reps.push({ at: f0, bytes: n, ok, loadMode: mode, invalidatedPages: pages, saveMs: +saveMs.toFixed(3), loadMs: +loadMs.toFixed(3),
        firstFrameAfterLoadMs: +firstFrameMs.toFixed(2), exact: first < 0, firstDiff: first,
        a: first >= 0 ? X[first] : undefined, b: first >= 0 ? Y[first] : undefined, distinctStates: new Set(X).size });
      f = f0 + K; for (let i = 0; i < 37; i++) drive(f++);
    }
    // fast-save ring vs full save, byte for byte (bookkeeping words excluded)
    let ringMismatch = 0; const tFast = [], tFull = [], tLoad = [];
    for (let k = 0; k < 40; k++) {
      drive(f++);
      const slot = ring[k % RING];
      let t = performance.now(); M._neil_state_save_raw_fast(slot); tFast.push(performance.now() - t);
      t = performance.now(); M._neil_state_save_raw(REF); tFull.push(performance.now() - t);
      const x = M.HEAPU8.subarray(slot, slot + SIZE), y = M.HEAPU8.subarray(REF, REF + SIZE);
      for (let i = 0; i < SIZE; i++) { if (i >= REG + 16 && i < REG + 28) continue; if (x[i] !== y[i]) { ringMismatch++; break; } }
      if (k % 10 === 9) { t = performance.now(); M._neil_state_load_raw(ring[(k - 3 + RING) % RING]); tLoad.push(performance.now() - t); f -= 3; }
    }
    const med = (a) => { a = a.slice().sort((p, q) => p - q); return +a[a.length >> 1].toFixed(3); };
    return { stateBytes: SIZE, frameMs: +frameMs.toFixed(2), reps, ringChecks: 40, ringMismatch,
      medFastSaveMs: med(tFast.slice(RING)), medFullSaveMs: med(tFull), medLoadMs: med(tLoad),
      jit: window.__jitStats ? window.__jitStats() : null };
  }, WARM, K, REPS);
  Object.assign(out, r);
  pass = !r.error && r.reps.every((x) => x.ok === 1 && x.exact) && r.ringMismatch === 0;
} catch (e) { out.error = e.message; }
out.pass = pass;
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close().catch(() => {});
process.exit(pass ? 0 : 1);

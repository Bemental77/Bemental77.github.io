#!/usr/bin/env node
// n64_state_exact_probe.mjs — IS A RAW N64 SAVESTATE EXACT, AND WHERE DOES IT LEAK?
//
// The question under rollback: after loading the state saved at the start of
// frame k, does re-running frame k.. produce EXACTLY what the first run did?
// Answered on the real page with the shipped core and the page's own raw
// savestate (window.__n64State: neil_serialize/neil_unserialize without gzip),
// driving the core one frame at a time (_neil_ls_arm + _neil_ls_run_frame)
// with a pad that is a pure function of the frame, after the same one neutral
// pre-roll frame a room runs. Per arm, per frame: the CPU fingerprint
// (_neil_last_fp) and a FULL hash of the state after the frame (every byte of
// the 16.8 MB savestate — RDRAM included).
//   S1, S2    : frames 0..N straight, the state saved (and hashed) after every
//               frame — two fresh contexts: the determinism control
//   nosave    : frames 0..N straight, NO saves; CPU fingerprint only (does
//               SAVING perturb the guest?)
//   present   : S1, but the browser presents the canvas after every frame (a
//               live page's rhythm) — does PRESENTATION reach the guest?
//   reload    : at every --every frames, load the state saved D frames ago and
//               re-run those D frames (what a rollback does), then go on
//   mispredict: reload, but between the load and the re-run the D frames run once more on a WRONG
//               pad (another frame's) and the state is loaded again — what a rollback after a
//               misprediction does: whatever host state the wrong timeline left behind meets the
//               re-run (--gls 1: glide's host state — lazy_fb.c neil_gl_state_save + rand() — is
//               saved with each ring state and restored with each load, as room_core.js does)
// Each arm is compared frame for frame with S1; S1 vs S2 is the control (if the
// core is not even deterministic straight, nothing else means anything).
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_state_exact_probe.mjs [--frames 400] [--depth 4] [--every 25] [--query ...]
// ⚠ This rig steps the core through window.Module / window.__n64State on the PAGE, so it pins
// the main-thread core (?worker=0) unless --query names a worker= arm itself.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const FRAMES = +flag('frames', '400'), DEPTH = +flag('depth', '4'), EVERY = +flag('every', '25');
const BASE = flag('url', 'http://localhost:8080'), GAME = flag('game', 'Mario Kart 64'), QUERY = flag('query', '');
const ARMS = flag('arms', 'S1,S2,nosave,reload').split(',');
const PLAYERS = +flag('players', '2');
const GLS = flag('gls', '0') === '1';
const YIELD = flag('yield', '0') === '1';
// --wclear 1 (diagnostic, mispredict arm): after the wrong timeline, before the re-run, clear the WebGL window
//   (default framebuffer, every channel, no scissor) — does host window content left by the wrong timeline reach the guest?
const WCLEAR = flag('wclear', '0') === '1';
// --at A:B — reload/mispredict only at frames f in [A, B] (still every --every frames); default all
const AT = flag('at', '0:1e9').split(':').map(Number);   // --yield 1: every arm presents after every frame, as 'present' does
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PAD = `window.__pad = function (f, p) {
  var b = new Uint8Array(4), m = 0;
  if ((((f >> 3) + p) & 1) === 1) m |= (1 << 4);
  if (((f + 5 * p) % 23) < 11) m |= (1 << 3);
  if ((f % 97) === 40 + p) m |= (1 << 6);
  var sx = ((Math.floor(f / 6) * 37 + p * 50) % 200) - 100;
  b[0] = m & 0xff; b[1] = (m >> 8) & 0x3f; b[2] = sx & 0xff; b[3] = 0;
  return b;
};`;
const browser = await puppeteer.launch({ headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const res = {};
try {
  // --s1cache PATH: the S1 arm's result is read from PATH when it exists (same ROM / frames / build:
  // the caller's promise), written there otherwise — a bisection re-runs only the arm it varies
  const S1C = flag('s1cache', '');
  for (const arm of ARMS) {
    if (arm === 'S1' && S1C && existsSync(S1C)) { res.S1 = JSON.parse((await import('node:fs')).readFileSync(S1C, 'utf8')); continue; }
    const ctx = await browser.createBrowserContext();
    const pg = await ctx.newPage();
    await pg.setViewport({ width: 1280, height: 900 });
    const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
    await pg.evaluateOnNewDocument(() => {
      const iv = setInterval(() => {
        const app = window.myApp; if (!app || app.__refHooked) return;
        app.__refHooked = true; clearInterval(iv);
        const prevBR = app.beforeRun ? app.beforeRun.bind(app) : () => {};
        app.beforeRun = function () {
          const r = prevBR.apply(this, arguments);
          const M = window.Module;
          M._neil_ls_arm(1); if (M._neil_fp_always) M._neil_fp_always(1);
          const cm = M.callMain;
          M.callMain = function () { const x = cm.apply(this, arguments); window.__refMain = true; return x; };
          return r;
        };
      }, 1);
    });
    await pg.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart${QUERY ? '&' + QUERY : ''}${/(^|&)worker=/.test(QUERY || '') ? '' : '&worker=0'}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__refMain === true, { timeout: 240000 });
    const t0 = Date.now();
    if (flag('gltrace', '')) await pg.evaluate((a) => { window.__gltRange = a; }, flag('gltrace', '').split(':').map(Number));
    const r = await pg.evaluate(async (pad, arm, N, D, E, players, gls, yieldEvery, at, wclear) => {
      (0, eval)(pad);
      const M = window.Module, S = window.__n64State;
      const lsp = M._malloc(32); let pre = null;
      // --gltrace A:B (diagnostic): from frame A to B, getError after every WebGL call; the first errors, with the call
      const glt = window.__gltRange, gltLog = []; let curF = -1;
      if (glt) {
        const g = M.ctx, P = Object.getPrototypeOf(g), ge = P.getError;
        for (const k of Object.getOwnPropertyNames(P)) {
          const dsc = Object.getOwnPropertyDescriptor(P, k);
          if (k === 'getError' || k === 'constructor' || !dsc || typeof dsc.value !== 'function') continue;
          const o = dsc.value;
          g[k] = function () { const r = o.apply(this, arguments); if (curF >= glt[0] && curF <= glt[1]) { const e = ge.call(this); if (e && gltLog.length < 40) gltLog.push([curF, k, e, Array.from(arguments).map((a) => a == null ? String(a) : (typeof a === 'object' ? (a.constructor && a.constructor.name) : a)).slice(0, 6).join(','), window.__gltPrev, (new Error().stack || '').split('\n').slice(2, 7).join(' <- ').replace(/https?:[^ )]*\//g, '')]); window.__gltPrev = k; } return r; };
        }
      }

      const lst = () => { if (!M._neil_lfb_stats) return null; M._neil_lfb_stats(lsp); return Array.from(M.HEAPU32.subarray(lsp >> 2, (lsp >> 2) + 8)); };
      const set = (f, wrong) => {
        pre = lst(); curF = wrong ? -1 : f;
        for (let p = 0; p < 4; p++) {
          const b = p < players ? window.__pad(wrong ? f + 5000 : f, p) : new Uint8Array(4);
          const mask = b[0] | (b[1] << 8), sx = (b[2] << 24) >> 24, sy = (b[3] << 24) >> 24;
          M._neil_ls_set_pad(p, mask, Math.round(sx / 127 * 32000), Math.round(sy / 127 * 32000));
        }
      };
      for (let p = 0; p < 4; p++) M._neil_ls_set_pad(p, 0, 0, 0);
      M._neil_ls_run_frame();                                   // the pre-roll
      const heap = (f) => M._neil_heap_brk ? { f, brk: M._neil_heap_brk() >>> 0, freeBelow: M._neil_heap_free_below() >>> 0, max: M.HEAPU8.length } : null;
      const heapLog = [heap(0)];
      const probe = S.alloc();
      const hashNow = () => { S.save(probe); return S.hashFull(probe); };
      const fp = [], full = [];
      const ring = [];                                          // state at the START of frame k
      let loads = 0, loadMs = 0, resimMs = 0, firstAfterLoadMs = [], normalMs = [];
      // lfbq[f]: the lazy framebuffer queue after frame f (Glide64/lazy_fb.c neil_lfb_pending: [lo, hi) per copy)
      const lfbq = [], lqp = M._malloc(256);
      const record = (f) => { fp[f] = M._neil_last_fp() >>> 0; if (arm !== 'nosave') full[f] = hashNow();
        if (M._neil_lfb_pending) { const n = M._neil_lfb_pending(lqp, 16); lfbq[f] = Array.from(M.HEAPU32.subarray(lqp >> 2, (lqp >> 2) + 2 * Math.min(n, 16))).map((x) => x.toString(16)).join(',');
          const now = lst(); if (now && pre) lfbq[f] += ' |q' + (now[0] - pre[0]) + ' m' + (now[1] - pre[1]) + ' s' + (now[2] - pre[2]) + ' d' + (now[3] - pre[3]) + ' x' + (now[4] - pre[4]) + ' e' + (now[5] - pre[5]) + ' nf' + (M._neil_native_fbread_failed ? M._neil_native_fbread_failed() : '?') + ' on' + (window.__fbAsync.on ? 1 : 0); } };
      for (let f = 0; f < N; f++) {
        // the framebuffer-readback pin goes with the state, exactly as the page's
        // rollback ring keeps it (rbSaveSlot / rbLoadSlot)
        const FB = window.__fbAsync;
        const glp = gls && M._neil_gl_state_size ? (window.__glsp || (window.__glsp = M._malloc(M._neil_gl_state_size()))) : 0, gln = glp ? M._neil_gl_state_size() : 0;
        const keep = (b, k) => { S.save(b); b.frame = k; if (FB.on) { if (b.fb) FB.release(b.fb); b.fb = FB.snapshot(); }
          if (glp) { M._neil_gl_state_save(glp); b.gl = M.HEAPU8.slice(glp, glp + gln); b.rlo = M._neil_rand_lo() >>> 0; b.rhi = M._neil_rand_hi() >>> 0; } };
        const restore = (b) => { if (!S.load(b)) return false; if (FB.on) FB.restore(b.fb);
          if (glp && b.gl) { M.HEAPU8.set(b.gl, glp); M._neil_gl_state_load(glp); M._neil_rand_set(b.rlo, b.rhi); } return true; };
        if (arm === 'reload' || arm === 'mispredict') { const b = ring[f % (D + 2)] || (ring[f % (D + 2)] = S.alloc()); keep(b, f); }
        set(f);
        let t = performance.now(); M._neil_ls_run_frame(); normalMs.push(performance.now() - t);
        record(f);
        if ((arm === 'reload' || arm === 'mispredict') && f >= D && (f % E) === E - 1 && f >= at[0] && f <= at[1]) {
          // roll back D frames: load the start of frame f-D+1 and re-run to f
          const from = f - D + 1, b = ring[from % (D + 2)];
          if (b.frame !== from) return { err: 'ring miss ' + from };
          if (arm === 'mispredict') {
            if (!restore(b)) return { err: 'load refused' };
            for (let k = from; k <= f; k++) { set(k, true); M._neil_ls_run_frame(); }
            if (wclear) { const g = M.ctx, fbo = g.getParameter(g.FRAMEBUFFER_BINDING), sc = g.isEnabled(g.SCISSOR_TEST), cm = g.getParameter(g.COLOR_WRITEMASK), cc = g.getParameter(g.COLOR_CLEAR_VALUE);
              g.bindFramebuffer(g.FRAMEBUFFER, null); g.disable(g.SCISSOR_TEST); g.colorMask(true, true, true, true); g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT | (window.__wcDepth ? g.DEPTH_BUFFER_BIT : 0));
              g.clearColor(cc[0], cc[1], cc[2], cc[3]); g.colorMask(cm[0], cm[1], cm[2], cm[3]); if (sc) g.enable(g.SCISSOR_TEST); g.bindFramebuffer(g.FRAMEBUFFER, fbo); }
          }
          t = performance.now(); if (!restore(b)) return { err: 'load refused' }; loadMs += performance.now() - t; loads++;
          const tr = performance.now();
          for (let k = from; k <= f; k++) {
            if (k > from) { const bb = ring[k % (D + 2)]; keep(bb, k); }
            set(k); const tk = performance.now(); M._neil_ls_run_frame(); if (k === from) firstAfterLoadMs.push(performance.now() - tk);
            record(k);
          }
          resimMs += performance.now() - tr;
        }
        // 'present': yield to the browser after EVERY frame, so the canvas is
        // presented (and, with preserveDrawingBuffer false, cleared) between
        // frames — the way a live page runs — instead of back to back.
        if ((f % 100) === 99) heapLog.push(heap(f));
        if (arm === 'present' || yieldEvery) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        else if ((f & 31) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      normalMs.sort((a, b) => a - b);
      firstAfterLoadMs.sort((a, b) => a - b);
      return { fp, full, lfbq, gltLog, heapLog, loads, loadMs: loads ? +(loadMs / loads).toFixed(2) : null, resimMsPerRollback: loads ? +(resimMs / loads).toFixed(1) : null,
               frameMsP50: +normalMs[normalMs.length >> 1].toFixed(2), firstAfterLoadMsP50: firstAfterLoadMs.length ? +firstAfterLoadMs[firstAfterLoadMs.length >> 1].toFixed(2) : null,
               firstAfterLoadMsMax: firstAfterLoadMs.length ? +firstAfterLoadMs[firstAfterLoadMs.length - 1].toFixed(2) : null,
               info: S.info(), fb: (() => { const s = window.__fbAsync; return { on: s.on, calls: s.calls, async: s.async, sync: s.sync, restores: s.restores | 0 }; })() };
    }, PAD, arm, FRAMES, DEPTH, EVERY, PLAYERS, GLS, YIELD, AT, WCLEAR);
    if (r.gltLog && r.gltLog.length) console.log('GLERR ' + arm + ' ' + JSON.stringify(r.gltLog));
    if (r.heapLog) console.log('HEAP ' + arm + ' ' + JSON.stringify(r.heapLog));
    r.errs = errs.slice(0, 3); r.wallMs = Date.now() - t0;
    res[arm] = r;
    if (arm === 'S1' && S1C) writeFileSync(S1C, JSON.stringify(r));
    console.log(JSON.stringify({ arm, err: r.err, loads: r.loads, loadMs: r.loadMs, resimMsPerRollback: r.resimMsPerRollback, frameMsP50: r.frameMsP50,
      firstAfterLoadMsP50: r.firstAfterLoadMsP50, firstAfterLoadMsMax: r.firstAfterLoadMsMax, info: r.info, fb: r.fb, errs: r.errs, wallMs: r.wallMs }));
    await ctx.close();
  }
} finally { await browser.close().catch(() => {}); }
const first = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : n; };
const ref = res.S1;
let fail = 0;
for (const arm of ARMS) {
  if (arm === 'S1' || !res[arm] || !ref) continue;
  const dFp = first(ref.fp, res[arm].fp), dFull = arm === 'nosave' ? -1 : first(ref.full, res[arm].full);
  const okk = dFp < 0 && dFull < 0;
  if (!okk) fail++;
  if (ref.lfbq && res[arm].lfbq) { const dq = first(ref.lfbq, res[arm].lfbq); console.log(`  lazy-fb queue first differs at ${dq}` + (dq >= 0 ? ` (S1 ${ref.lfbq[dq]} | ${arm} ${res[arm].lfbq[dq]})` : '')); }
  console.log(`  ${okk ? 'PASS' : 'FAIL'}  ${arm} vs S1: fp first differs at ${dFp}, full-state hash first differs at ${dFull} (of ${ref.fp.length})`);
}
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(res));
process.exit(fail ? 1 : 0);

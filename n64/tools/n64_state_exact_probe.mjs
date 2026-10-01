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
// Each arm is compared frame for frame with S1; S1 vs S2 is the control (if the
// core is not even deterministic straight, nothing else means anything).
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_state_exact_probe.mjs [--frames 400] [--depth 4] [--every 25] [--query ...]
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
  for (const arm of ARMS) {
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
    await pg.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart${QUERY ? '&' + QUERY : ''}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => window.__refMain === true, { timeout: 240000 });
    const t0 = Date.now();
    const r = await pg.evaluate(async (pad, arm, N, D, E, players) => {
      (0, eval)(pad);
      const M = window.Module, S = window.__n64State;
      const set = (f) => {
        for (let p = 0; p < 4; p++) {
          const b = p < players ? window.__pad(f, p) : new Uint8Array(4);
          const mask = b[0] | (b[1] << 8), sx = (b[2] << 24) >> 24, sy = (b[3] << 24) >> 24;
          M._neil_ls_set_pad(p, mask, Math.round(sx / 127 * 32000), Math.round(sy / 127 * 32000));
        }
      };
      for (let p = 0; p < 4; p++) M._neil_ls_set_pad(p, 0, 0, 0);
      M._neil_ls_run_frame();                                   // the pre-roll
      const probe = S.alloc();
      const hashNow = () => { S.save(probe); return S.hashFull(probe); };
      const fp = [], full = [];
      const ring = [];                                          // state at the START of frame k
      let loads = 0, loadMs = 0, resimMs = 0, firstAfterLoadMs = [], normalMs = [];
      const record = (f) => { fp[f] = M._neil_last_fp() >>> 0; if (arm !== 'nosave') full[f] = hashNow(); };
      for (let f = 0; f < N; f++) {
        // the framebuffer-readback pin goes with the state, exactly as the page's
        // rollback ring keeps it (rbSaveSlot / rbLoadSlot)
        const FB = window.__fbAsync;
        const keep = (b, k) => { S.save(b); b.frame = k; if (FB.on) { if (b.fb) FB.release(b.fb); b.fb = FB.snapshot(); } };
        if (arm === 'reload') { const b = ring[f % (D + 2)] || (ring[f % (D + 2)] = S.alloc()); keep(b, f); }
        set(f);
        let t = performance.now(); M._neil_ls_run_frame(); normalMs.push(performance.now() - t);
        record(f);
        if (arm === 'reload' && f >= D && (f % E) === E - 1) {
          // roll back D frames: load the start of frame f-D+1 and re-run to f
          const from = f - D + 1, b = ring[from % (D + 2)];
          if (b.frame !== from) return { err: 'ring miss ' + from };
          t = performance.now(); if (!S.load(b)) return { err: 'load refused' }; if (FB.on) FB.restore(b.fb); loadMs += performance.now() - t; loads++;
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
        if (arm === 'present') await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        else if ((f & 31) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      normalMs.sort((a, b) => a - b);
      firstAfterLoadMs.sort((a, b) => a - b);
      return { fp, full, loads, loadMs: loads ? +(loadMs / loads).toFixed(2) : null, resimMsPerRollback: loads ? +(resimMs / loads).toFixed(1) : null,
               frameMsP50: +normalMs[normalMs.length >> 1].toFixed(2), firstAfterLoadMsP50: firstAfterLoadMs.length ? +firstAfterLoadMs[firstAfterLoadMs.length >> 1].toFixed(2) : null,
               firstAfterLoadMsMax: firstAfterLoadMs.length ? +firstAfterLoadMs[firstAfterLoadMs.length - 1].toFixed(2) : null,
               info: S.info(), fb: (() => { const s = window.__fbAsync; return { on: s.on, calls: s.calls, async: s.async, sync: s.sync, restores: s.restores | 0 }; })() };
    }, PAD, arm, FRAMES, DEPTH, EVERY, PLAYERS);
    r.errs = errs.slice(0, 3); r.wallMs = Date.now() - t0;
    res[arm] = r;
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
  console.log(`  ${okk ? 'PASS' : 'FAIL'}  ${arm} vs S1: fp first differs at ${dFp}, full-state hash first differs at ${dFull} (of ${ref.fp.length})`);
}
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(res));
process.exit(fail ? 1 : 0);

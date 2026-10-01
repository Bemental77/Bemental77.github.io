#!/usr/bin/env node
// n64_lag_probe.mjs — KEY -> SCREEN, IN FRAMES: THE ROOM'S LAG + THE GAME'S OWN.
//
// A press reaches the screen after
//   (a) the frames the ROOM holds it back — lockstep's input delay d, rollback 0
//       (measured live by the page's own witness, __n64Net().lat), plus
//   (b) the GAME'S own lag frames L: the game reads the pad in frame f and the
//       picture of frame f + L is the first one that shows it, minus
//   (c) the frames RUN-AHEAD shows early (__n64Net().runahead.frames).
// So key->screen (frames) = d + L - RA, each term measured, never assumed.
//
// L is measured by COUNTERFACTUAL on the real page and core, which is exact
// because the core is deterministic from a saved state (n64_state_exact_probe):
// from one saved state, run K frames with no press and K frames with the press
// applied from frame 0, reading the rendered picture after every frame (the
// default framebuffer, in the same task, before the browser presents it); the
// first frame whose picture differs is L (0 = the very frame that read the
// press shows it). Repeated at --trials points (every --gap frames) so it is a
// distribution, not one sample. The page is booted and pre-rolled the way a
// room is; the press is a --button held on port 0.
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_lag_probe.mjs [--warm 700] [--trials 8] [--gap 37] [--button start|a|up]
// ⚠ This rig steps the core through window.Module / window.__n64State on the PAGE, so it pins
// the main-thread core (?worker=0) unless --query names a worker= arm itself.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const WARM = +flag('warm', '700'), TRIALS = +flag('trials', '8'), GAP = +flag('gap', '37'), K = +flag('k', '10');
const BUTTON = flag('button', 'start');
const BITS = { up: 0, down: 1, left: 2, right: 3, a: 4, b: 5, start: 6, z: 7 };
const BASE = flag('url', 'http://localhost:8080'), GAME = flag('game', 'Mario Kart 64'), QUERY = flag('query', '');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await puppeteer.launch({ headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = { game: GAME, warm: WARM, trials: TRIALS, gap: GAP, k: K, button: BUTTON };
try {
  const pg = await browser.newPage();
  await pg.setViewport({ width: 1280, height: 900 });
  await pg.evaluateOnNewDocument(() => {
    const iv = setInterval(() => {
      const app = window.myApp; if (!app || app.__refHooked) return;
      app.__refHooked = true; clearInterval(iv);
      const prevBR = app.beforeRun ? app.beforeRun.bind(app) : () => {};
      app.beforeRun = function () {
        const r = prevBR.apply(this, arguments);
        const M = window.Module;
        M._neil_ls_arm(1);
        const cm = M.callMain;
        M.callMain = function () { const x = cm.apply(this, arguments); window.__refMain = true; return x; };
        return r;
      };
    }, 1);
  });
  await pg.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart${QUERY ? '&' + QUERY : ''}${/(^|&)worker=/.test(QUERY || '') ? '' : '&worker=0'}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => window.__refMain === true, { timeout: 240000 });
  const r = await pg.evaluate(async (WARM, TRIALS, GAP, K, bit) => {
    const M = window.Module, S = window.__n64State, FB = window.__fbAsync;
    const gl = M.ctx || document.getElementById('canvas').getContext('webgl2');
    // The whole picture, read once right after the frame, hashed on a grid.
    let px = null;
    const picture = () => {
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      if (!px || px.length !== W * H * 4) px = new Uint8Array(W * H * 4);
      FB.bypass = true;
      try {
        const rfb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb);
      } finally { FB.bypass = false; }
      let h = 2166136261 >>> 0;
      for (let i = 0; i < px.length; i += 28) h = Math.imul(h ^ px[i], 16777619) >>> 0;
      return h;
    };
    const run = (mask) => { M._neil_ls_set_pad(0, mask, 0, 0); for (let p = 1; p < 4; p++) M._neil_ls_set_pad(p, 0, 0, 0); M._neil_ls_run_frame(); };
    run(0);                                                       // the pre-roll
    for (let f = 0; f < WARM; f++) { run(0); if ((f & 63) === 0) await new Promise((r) => setTimeout(r, 0)); }
    const snap = S.alloc(), trials = [];
    for (let t = 0; t < TRIALS; t++) {
      S.save(snap); const pin = FB.on ? FB.snapshot() : null;
      const A = [], B = [];
      for (let k = 0; k < K; k++) { run(0); A.push(picture()); }
      S.load(snap); if (pin) FB.restore(pin);
      for (let k = 0; k < K; k++) { run(1 << bit); B.push(picture()); }
      S.load(snap); if (pin) { FB.restore(pin); FB.release(pin); }
      let L = null; for (let k = 0; k < K; k++) if (A[k] !== B[k]) { L = k; break; }
      trials.push({ L, distinctNoPress: new Set(A).size });
      for (let g = 0; g < GAP; g++) run(0);
      await new Promise((r) => setTimeout(r, 0));
    }
    return { trials };
  }, WARM, TRIALS, GAP, K, BITS[BUTTON]);
  out.trials = r.trials;
  const Ls = r.trials.map((x) => x.L).filter((x) => x != null).sort((a, b) => a - b);
  out.gameLagFrames = { n: Ls.length, of: r.trials.length, min: Ls[0], median: Ls[Ls.length >> 1], max: Ls[Ls.length - 1] };
} catch (e) { out.error = e.message; }
console.log(JSON.stringify(out));
const jp = flag('json', ''); if (jp) writeFileSync(jp, JSON.stringify(out, null, 1));
await browser.close().catch(() => {});

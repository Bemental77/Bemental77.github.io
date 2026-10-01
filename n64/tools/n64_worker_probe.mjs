#!/usr/bin/env node
// n64_worker_probe.mjs — THE CORE WORKER (?worker=1) AGAINST THE MAIN-THREAD CORE.
//
// Two questions, two modes. Both drive the REAL /n64/ page.
//
// --mode exact   IS THE WORKER-HOSTED CORE THE SAME CONSOLE?
//   Arm M: ?worker=0 — the main-thread core, frame gate armed before main()
//          (the exact hook n64/index.html uses for a room: myApp.beforeRun),
//          frames advanced by the rig with neil_ls_run_frame in the page realm.
//   Arm W: ?worker=1&workerrig=1 — the core in core_worker.js; the worker arms
//          the same gate before main() itself and, in rig mode, does not start
//          its frame clock, so the rig advances it the same way, in the
//          WORKER's realm (window.__n64Worker.eval).
//   Both get the identical scripted pad image per frame and run the identical
//   code below. Compared: the CPU fingerprint (_neil_last_fp: GPRs, CP0, FPRs,
//   FCR31, PC) after EVERY frame, and a hash of the COMPLETE raw savestate
//   (_neil_state_save_raw_fast: RDRAM with glide's framebuffer copies in it,
//   RSP, TLB, CPU, event queue, save memory) every --every frames and at the
//   end. Same JIT (emit) on both, same fbasync decision (fbasync.js, shared).
//   Each arm runs in its own fresh browser context (MK64 writes EEPROM to IDB).
//
// --mode load    WHAT DOES IT BUY? Free-running solo, the shipped governor on
//   each arm, interleaved rounds, a FRESH browser per run. Measured over a
//   window after warm-up, on the page's MAIN thread: long tasks
//   (PerformanceObserver 'longtask': count, ms per second, max), animation
//   frames per second, and responsiveness (a 50 ms probe timer's lateness —
//   how long an input event would have waited). Guest: VI fields per second
//   / the cartridge's field rate (core counter; worker-reported in arm W),
//   wall ms inside retro_run per field (cost), worklet underruns.
//   --device mobile = the phone profile the solo audit used (Pixel 7 UA,
//   915x412 @2x, touch) + Emulation.setCPUThrottlingRate 4 on the PAGE.
//   ⚠ THE CDP THROTTLE DOES NOT REACH WORKERS (tools/netplay_device_matrix.mjs
//   measured the refusal on chromium-1194; this rig records it again per run in
//   `workerThrottle`). So under --device mobile arm W's EMULATOR runs at
//   desktop speed while arm M's runs throttled: its guest rate is an UPPER
//   BOUND for a phone, not a phone measurement. What the arm DOES measure is
//   main-thread relief, which is the throttled thread in both arms.
//
// USAGE (dev server on a free port, hermetic snapshot recommended):
//   node n64/tools/n64_worker_probe.mjs --mode exact --rom mariokart.z64 --frames 900
//   node n64/tools/n64_worker_probe.mjs --mode load --rom mariokart.z64 --device mobile --rounds 2
// Flags: --url http://localhost:18500  --out DIR  --query 'x=y' (both arms)
// Emits one JSON object on stdout (and --out/result.json).
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const MODE = flag('mode', 'exact');
const ROM = flag('rom', 'mariokart.z64');
const BASE = flag('url', 'http://localhost:18500');
const OUT = flag('out', path.join(os.tmpdir(), 'n64-worker-probe'));
const XQ = flag('query', '');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
fs.mkdirSync(OUT, { recursive: true });
const load1 = () => { try { return +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const b = await puppeteer.launch({
    headless: 'new', executablePath: fs.existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
           '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,900'],
  });
  try { require(path.join(path.dirname(__filename), '../../tools/browser_leak_guard.js')).guard(b, __filename); } catch (_e) {}
  return b;
}

// ============================================================ exact
// [f0, f1, ports, mask, ax, ay]: mask bits 0 up 1 down 2 left 3 right 4 A 5 B 6 Start
// 7 Z 8 L 9 R 10-13 C. The default walks MK64 off its title into the menus and keeps
// pressing A / steering, so the arms leave the attract loop and take real input.
function defaultPlan(frames) {
  const p = [];
  for (let f = 300; f < frames; f += 40) p.push([f, f + 4, [0], (f / 40) % 3 === 0 ? (1 << 6) : (1 << 4), 0, 0]);
  for (let f = 900; f < frames; f += 90) p.push([f, f + 45, [0], (1 << 4), ((f / 90) % 2) ? 0.8 : -0.6, 0.3]);
  return p;
}
const PLAN = defaultPlan(+flag('frames', '900'));

// Runs in EITHER realm (page window or the core worker's self): frames [from, to).
const RUN = function (from, to, plan, every, last) {
  const G = (typeof window !== 'undefined' && window.Module && !window.Module.__worker) ? window : self;
  const M = G.Module;
  if (!G.__wkp) {
    const n = M._neil_state_size() >>> 0;
    G.__wkp = { n, ptr: M._malloc(n) };
    if (M._neil_fp_always) M._neil_fp_always(1);
  }
  const S = G.__wkp, out = { fp: [], st: [], ms: 0 };
  const hashState = () => {
    M.HEAPU8.fill(0, S.ptr, S.ptr + S.n);
    if (!(M._neil_state_save_raw_fast(S.ptr) | 0)) return -1;
    // Every byte EXCEPT the trailer header's nonce / tlb_gen / hid_epoch (region+16..+28):
    // bookkeeping for the fast save, "not machine state" (neil_rawstate.c struct
    // neil_raw_hdr) — the nonce is per-instance by design. Same mask as the page's
    // n64sHashFull, which the rollback probe's straight-run comparison uses.
    const w = M.HEAP32, i0 = S.ptr >> 2, i1 = (S.ptr + S.n) >> 2;
    const R = M._neil_state_m64p_region ? (M._neil_state_m64p_region() >>> 0) : 16789504;
    const s0 = (S.ptr + R + 16) >> 2, s1 = (S.ptr + R + 28) >> 2;
    let h = 0x811c9dc5 | 0;
    for (let i = i0; i < i1; i++) { if (i >= s0 && i < s1) continue; h = Math.imul(h ^ w[i], 16777619); }
    return h >>> 0;
  };
  for (let f = from; f < to; f++) {
    const pads = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const [f0, f1, ports, mask, ax, ay] of plan) {
      if (f >= f0 && f < f1) for (const p of ports) { pads[p][0] |= mask; if (ax) pads[p][1] = ax; if (ay) pads[p][2] = ay; }
    }
    for (let p = 0; p < 4; p++) M._neil_ls_set_pad(p, pads[p][0], Math.round(pads[p][1] * 32000), Math.round(pads[p][2] * 32000));
    const t0 = performance.now();
    M._neil_ls_run_frame();
    out.ms += performance.now() - t0;
    out.fp.push(M._neil_last_fp() >>> 0);
    if ((f + 1) % every === 0 || (f + 1 === last)) out.st.push([f + 1, hashState()]);
  }
  return out;
};

const PRE_MAIN = `(() => {
  window.__rig = { armed: false, main: false };
  const iv = setInterval(() => {
    const app = window.myApp; if (!app || app.__rigHooked) return;
    app.__rigHooked = true; clearInterval(iv);
    const prev = app.beforeRun ? app.beforeRun.bind(app) : () => {};
    app.beforeRun = function () {
      const r = prev.apply(this, arguments);
      const M = window.Module;
      M._neil_ls_arm(1);
      window.__rig.armed = true;
      const cm = M.callMain;
      M.callMain = function () { const x = cm.apply(this, arguments); window.__rig.main = true; return x; };
      return r;
    };
  }, 1);
})();`;

async function exactArm(browser, arm, frames, every, tag) {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [], logs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
  const W = arm === 'W';
  if (!W) await page.evaluateOnNewDocument(PRE_MAIN);
  const q = (W ? 'worker=1&workerrig=1' : 'worker=0') + (XQ ? '&' + XQ : '');
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(ROM)}&autostart&${q}`, { waitUntil: 'domcontentloaded' });
  if (W) {
    await page.waitForFunction(() => { const s = window.__n64Worker && window.__n64Worker.state(); return s && (s.booted || s.fatal); }, { timeout: 240000 });
    const st = await page.evaluate(() => window.__n64Worker.state());
    if (st.fatal) throw new Error('worker fatal: ' + st.fatal);
    await page.waitForFunction(() => window.__n64Worker.state().stat, { timeout: 60000 });
  } else {
    await page.waitForFunction(() => window.__rig && window.__rig.main === true, { timeout: 240000 });
    if (!/jit=off|nojit/.test(XQ)) await page.waitForFunction(() => !!(window.bementalMips && window.myApp && window.myApp.jitCompile), { timeout: 60000 });
  }
  const res = { arm, fp: [], st: [], ms: 0, errs, logs };
  const CH = 30;
  for (let f = 0; f < frames; f += CH) {
    const to = Math.min(frames, f + CH);
    const src = `(${RUN.toString()})(${f}, ${to}, ${JSON.stringify(PLAN)}, ${every}, ${frames})`;
    const o = W ? await page.evaluate((s) => window.__n64Worker.eval(s), src) : await page.evaluate(src);
    res.fp.push(...o.fp); res.st.push(...o.st); res.ms += o.ms;
  }
  if (+flag('dumpat', '0') === frames) {
    const dsrc = `(() => { const G = (typeof window !== 'undefined' && window.Module && !window.Module.__worker) ? window : self; const M = G.Module, S = G.__wkp;
      M.HEAPU8.fill(0, S.ptr, S.ptr + S.n); M._neil_state_save_raw_fast(S.ptr);
      const u = M.HEAPU8.subarray(S.ptr, S.ptr + S.n); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })()`;
    res.dump = W ? await page.evaluate((s) => window.__n64Worker.eval(s), dsrc) : await page.evaluate(dsrc);
  }
  res.where = W ? await page.evaluate(() => window.__n64Worker.eval('({ realm: typeof WorkerGlobalScope !== "undefined" ? "worker" : "window", jit: self.__jitStats ? self.__jitStats() : null, fb: self.__fbAsync ? { on: self.__fbAsync.on, calls: self.__fbAsync.calls, async: self.__fbAsync.async } : null })'))
                : await page.evaluate(() => ({ realm: 'window', jit: window.__jitStats ? window.__jitStats() : null, fb: window.__fbAsync ? { on: window.__fbAsync.on, calls: window.__fbAsync.calls, async: window.__fbAsync.async } : null }));
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, `exact-${tag}-${arm}.png`) });
  await ctx.close();
  return res;
}

async function modeExact() {
  const frames = +flag('frames', '900'), every = +flag('every', '30');
  const browser = await launch();
  const out = { mode: 'exact', rom: ROM, frames, every, query: XQ, load: [load1()] };
  try {
    // --arms M,W (default) | M,M | W,W — the same-realm pairs are the determinism CONTROL:
    // a difference there is the rig or the state, not the worker.
    const [a1, a2] = flag('arms', 'M,W').split(',');
    const A = await exactArm(browser, a1, frames, every, 'A');
    const B = await exactArm(browser, a2, frames, every, 'B');
    out.armsRun = [a1, a2];
    if (A.dump && B.dump) {
      const x = Buffer.from(A.dump, 'base64'), y = Buffer.from(B.dump, 'base64'), runs = [];
      let i = 0;
      while (i < x.length && runs.length < 40) {
        if (x[i] !== y[i]) { let j = i; while (j < x.length && x[j] !== y[j]) j++; runs.push([i, j - i]); i = j; } else i++;
      }
      let nd = 0; for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) nd++;
      // the masked bookkeeping words (see hashState) are reported, not judged
      out.dump = { at: +flag('dumpat', '0'), bytes: x.length, differing: nd, firstRuns: runs };
    }
    let fpDiff = -1, stDiff = -1;
    for (let i = 0; i < frames; i++) if (A.fp[i] !== B.fp[i]) { fpDiff = i; break; }
    for (let i = 0; i < A.st.length; i++) if (!B.st[i] || A.st[i][1] !== B.st[i][1] || A.st[i][1] === -1) { stDiff = A.st[i][0]; break; }
    out.arms = { M: { realm: A.where, errs: A.errs, msPerFrame: +(A.ms / frames).toFixed(3) }, W: { realm: B.where, errs: B.errs, msPerFrame: +(B.ms / frames).toFixed(3) } };
    out.fpFrames = [A.fp.length, B.fp.length];
    out.stateHashes = A.st.length;
    out.fpFirstDiff = fpDiff;
    out.stateFirstDiffAfterFrame = stDiff;
    out.finalState = [A.st[A.st.length - 1], B.st[B.st.length - 1]];
    out.distinctFp = new Set(A.fp).size;
    out.verdict = (fpDiff === -1 && stDiff === -1 && A.fp.length === frames && B.fp.length === frames && !A.errs.length && !B.errs.length) ? 'PASS' : 'FAIL';
  } finally { out.load.push(load1()); await browser.close(); }
  return out;
}

// ============================================================ load
const LOAD_PRE = `(() => {
  const P = window.__wkl = { lt: [], raf: 0, lag: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { P.ltErr = String(e); }
  const raf = window.requestAnimationFrame.bind(window);
  (function f() { P.raf++; raf(f); })();
  // Responsiveness: a 50 ms timer, and how late it fires. An input event queued at the
  // same moment would have waited about as long.
  let due = performance.now() + 50;
  (function t() { const now = performance.now(); P.lag.push([now, Math.max(0, now - due)]); due = now + 50; setTimeout(t, 50); })();
})();`;
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

async function loadRun(arm, device, warmMs, winMs) {
  const browser = await launch();
  const r = { arm, device, errs: [], workerThrottle: [] };
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => r.errs.push(String(e.message).slice(0, 300)));
    const cdp = await page.createCDPSession();
    if (device === 'mobile') {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 915, height: 412, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv81' });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      page.on('workercreated', async (w) => {
        try { await w.client.send('Emulation.setCPUThrottlingRate', { rate: 4 }); r.workerThrottle.push('applied: ' + w.url().split('/').pop()); }
        catch (e) { r.workerThrottle.push('REFUSED: ' + w.url().split('/').pop().slice(0, 40) + ': ' + String(e.message || e).slice(0, 80)); }
      });
    } else await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(LOAD_PRE);
    const q = (arm === 'W' ? 'worker=1' : 'worker=0') + (XQ ? '&' + XQ : '');
    // ?mobile makes a desktop-UA page take the touch shell; the UA override does it here.
    await page.goto(`${BASE}/n64/?game=${encodeURIComponent(ROM)}&autostart&${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Module && window.Module._neil_vi_total && window.Module._neil_vi_total() > 30, { timeout: 240000, polling: 500 });
    await sleep(warmMs);
    const snap = () => page.evaluate(() => {
      const M = window.Module, ws = window.__n64Worker && window.__n64Worker.state();
      const W = !!(ws && ws.on && ws.stat);
      return { t: W ? ws.stat.at - performance.timeOrigin : performance.now(), now: performance.now(),
               vi: M._neil_vi_total() >>> 0, costMs: M._neil_frame_cost_ms(), costN: M._neil_frame_cost_n() >>> 0,
               u: window.__audioDbg ? window.__audioDbg.u : null, viHz: window.__n64Rate ? window.__n64Rate.viHz : null,
               worker: W, raf: window.__wkl.raf, lt: window.__wkl.lt.length, lag: window.__wkl.lag.length,
               reanchors: W ? ws.stat.reanchors : null, lostMs: W ? ws.stat.lostMs : null, workerFrames: W ? ws.stat.frame : null };
    });
    const a = await snap();
    const la = load1();
    await sleep(winMs);
    const b = await snap();
    const lb = load1();
    const det = await page.evaluate((t0, t1) => {
      const P = window.__wkl;
      const lt = P.lt.filter(([s]) => s >= t0 && s < t1).map(([, d]) => d);
      const lag = P.lag.filter(([s]) => s >= t0 && s < t1).map(([, d]) => d).sort((x, y) => x - y);
      const q = (p) => lag.length ? lag[Math.min(lag.length - 1, Math.floor(p * lag.length))] : null;
      return { ltN: lt.length, ltMs: lt.reduce((s, d) => s + d, 0), ltMax: lt.length ? Math.max(...lt) : 0, lagP50: q(0.5), lagP95: q(0.95), lagMax: lag.length ? lag[lag.length - 1] : null };
    }, a.now, b.now);
    const wallS = (b.now - a.now) / 1000, coreS = (b.t - a.t) / 1000;
    const viHz = b.viHz || a.viHz;
    r.window = { wallS: +wallS.toFixed(2), load: [la, lb] };
    r.main = { longTasksPerS: +(det.ltN / wallS).toFixed(2), longTaskMsPerS: +(det.ltMs / wallS).toFixed(1), longTaskMax: Math.round(det.ltMax),
               rafPerS: +((b.raf - a.raf) / wallS).toFixed(1), timerLagP50: det.lagP50 && +det.lagP50.toFixed(1), timerLagP95: det.lagP95 && +det.lagP95.toFixed(1), timerLagMax: det.lagMax && +det.lagMax.toFixed(1) };
    r.guest = { viHz, viPerS: +((b.vi - a.vi) / coreS).toFixed(2), rate: viHz ? +(((b.vi - a.vi) / coreS) / viHz).toFixed(4) : null,
                costMsPerField: (b.costN - a.costN) ? +((b.costMs - a.costMs) / (b.costN - a.costN)).toFixed(2) : null,
                underruns: (a.u != null && b.u != null) ? b.u - a.u : null, worker: b.worker,
                reanchors: b.worker ? b.reanchors - a.reanchors : null, lostMsPerS: b.worker ? +((b.lostMs - a.lostMs) / coreS).toFixed(1) : null };
    await page.screenshot({ path: path.join(OUT, `load-${arm}-${device}-${Date.now()}.png`) });
  } catch (e) { r.fault = String(e && e.message || e).slice(0, 300); }
  finally { await browser.close(); }
  return r;
}

async function modeLoad() {
  const device = flag('device', 'desktop'), rounds = +flag('rounds', '2');
  const warm = +flag('warm', '20000'), win = +flag('window', '20000');
  const runs = [];
  for (let i = 0; i < rounds; i++) {
    const order = i % 2 ? ['W', 'M'] : ['M', 'W'];
    for (const arm of order) { const r = await loadRun(arm, device, warm, win); r.round = i; runs.push(r); process.stderr.write(JSON.stringify(r) + '\n'); }
  }
  const agg = (arm, k1, k2) => { const v = runs.filter((r) => r.arm === arm && r[k1] && r[k1][k2] != null).map((r) => r[k1][k2]); return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3) : null; };
  const sum = {};
  for (const arm of ['M', 'W']) sum[arm] = { longTaskMsPerS: agg(arm, 'main', 'longTaskMsPerS'), longTaskMax: agg(arm, 'main', 'longTaskMax'), rafPerS: agg(arm, 'main', 'rafPerS'),
    timerLagP95: agg(arm, 'main', 'timerLagP95'), rate: agg(arm, 'guest', 'rate'), costMsPerField: agg(arm, 'guest', 'costMsPerField'), underruns: agg(arm, 'guest', 'underruns') };
  return { mode: 'load', rom: ROM, device, rounds, warmMs: warm, windowMs: win, query: XQ, summary: sum, runs };
}

const result = MODE === 'load' ? await modeLoad() : await modeExact();
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));

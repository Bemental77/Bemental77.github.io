#!/usr/bin/env node
// n64_rollback_probe.mjs — DOES N64 ROLLBACK RE-SIMULATE EXACTLY, AND WHAT DOES IT COST?
//
// One REAL Mario Kart 64 core, on the real page, in a rollback room (input
// delay 0) with 1 or 3 GHOST players: real lib/netplay.js Lockstep engines in a
// Web Worker, no emulator, each pressing a scripted pad that is a pure function
// of (frame, port) and changes every few frames, so the page's predictions
// (repeat-last) are wrong over and over and it rolls back. Every link — page to
// ghost and ghost to ghost — gets its own one-way latency, uniform in
// [--latmin, --latmax] ms per message, delivered in order (what an ordered
// DataChannel does). The page's own pad is scripted the same way through the
// __n64PadOverride seam; the page runs its SHIPPED rollback (rbRunFrame),
// run-ahead and 1.000x governor, unmodified.
//
// THE EXACTNESS CHECK. Every --hash-every confirmed frames the page hands its
// saved state (the state after frame k) to __n64RbTap, and this rig takes a
// FULL hash of it — all 16.8 MB: RDRAM (with glide's framebuffer copies in
// it), RSP memory, TLB tables, CPU, event queue. Then a SECOND, fresh page
// (new browser context) boots the same ROM, runs the same one neutral
// pre-roll frame, and runs every frame STRAIGHT — no prediction, no load,
// no re-simulation — with exactly the confirmed input each frame of the room
// had, and hashes its state at the same frames. A rollback that is not exact
// (a load that does not restore everything, a readback pin that leaks, a
// run-ahead frame that is not undone) shows up as the first differing frame.
// If there were no rollbacks the check is VOID and says so.
//
// Two consoles of a room each match the straight run, so they match each
// other: this is a stronger statement than two cores comparing fingerprints,
// and it can be made for 4 players on a 4-core box.
//
// THE CORE WORKER (the page's default since 2026-10-01): the room driver and the engine run
// in n64/N64Wasm/dist/core_worker.js, so the two seams the rig needs INSIDE the room driver —
// the scripted pad (__n64PadOverride) and the confirmed-state tap (__n64RbTap) — are installed
// in the worker's realm through the page's ?workerrig=1 eval seam, after the core has booted
// and before the room is declared, and read back the same way. The page still hands the rig
// its engine (__n64LsEngine, adopted: every call goes to the worker's engine, in order). The
// STRAIGHT REFERENCE pins the main-thread core (?worker=0): a worker room checked against a
// main-thread straight run is the stronger, cross-realm statement. --query worker=0 runs the
// room on the main thread instead (the control arm).
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node n64/tools/n64_rollback_probe.mjs \
//        --players 2|4 --latmin 40 --latmax 100 --secs 30 [--cpu 4] [--mobile] \
//        [--query 'ra=auto'] [--hash-every 10] [--json PATH]
import { createRequire } from 'node:module';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const PLAYERS = +flag('players', '2');
const LATMIN = +flag('latmin', '40'), LATMAX = +flag('latmax', '100');
const SECS = +flag('secs', '30');
const CPU = +flag('cpu', '1');
const MOBILE = has('mobile');
const HASH_EVERY = +flag('hash-every', '10');
const RBW = +flag('rbw', '8');
const BASE = flag('url', 'http://localhost:8080');
const GAME = flag('game', 'Mario Kart 64');
const QUERY = flag('query', '');
const JSON_OUT = flag('json', '');
const NOREF = has('noref');
const ADAPTIVE = flag('adaptive', '1') !== '0';   // declare rbCatchUp (the adaptive room) on every console
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The scripted pad: a pure function of (frame, port), shared verbatim by the
// page seam, the ghosts and the reference run. Buttons change every 8 / 23
// frames, the stick every 6 — a repeat-last prediction is wrong several times
// a second per remote port.
const PAD_SRC = `function __pad(f, p) {
  var b = new Uint8Array(4), m = 0;
  if ((((f >> 3) + p) & 1) === 1) m |= (1 << 4);          // A
  if (((f + 5 * p) % 23) < 11) m |= (1 << 3);             // right
  if ((f % 97) === 40 + p) m |= (1 << 6);                  // Start, now and then
  var sx = ((Math.floor(f / 6) * 37 + p * 50) % 200) - 100;
  b[0] = m & 0xff; b[1] = (m >> 8) & 0x3f; b[2] = sx & 0xff; b[3] = 0;
  return b;
}`;

const GHOST_SRC = `
self.window = self;
importScripts('__ORIGIN__/lib/netplay.js');
${PAD_SRC}
let cfg = null;
const G = [];                  // ghost engines, ports 1..n-1
const links = new Map();       // 'from>to' -> { last, q: [{at, m}] }
function lat() { return cfg.latmin + Math.random() * (cfg.latmax - cfg.latmin); }
function post(from, to, m) {
  const k = from + '>' + to;
  let L = links.get(k); if (!L) { L = { last: 0, q: [] }; links.set(k, L); }
  const at = Math.max(L.last, performance.now() + lat());
  L.last = at; L.q.push({ at, m, to });
}
function tick() {
  const now = performance.now();
  for (const L of links.values()) {
    while (L.q.length && L.q[0].at <= now) {
      const x = L.q.shift();
      if (x.to === 'page') postMessage({ t: 'm', m: x.m });
      else { const g = G.find((e) => e.id === x.to); if (g) g.ls.receive(x.m); }
    }
  }
  for (const g of G) {
    const ls = g.ls;
    if (ls.state !== 'running' && ls.state !== 'stalled') continue;
    // the adaptive room's page contract, ghost side: hidden catch-up frames
    // first, and the credit multiplied by rbPace()
    const cu = ls.rbCatchUp ? ls.rbCatchUp() : 0;
    for (let c = 0; c < cu; c++) {
      const pads = {}; pads[g.port] = __pad(ls.frame, g.port);
      const r = ls.beginFrame(pads, { hidden: true });
      if (!r.ready) break;
      ls.endFrame(null); ls.takeHashDue(); g.frames++; g.baseFrame++; g.hidden++;
    }
    const pace = ls.rbPace ? ls.rbPace() : 1;
    if (pace !== g.pace) { g.pace = pace; g.base = 0; g.period = 1000 / cfg.viHz / pace; }
    let n = 0;
    while (n++ < 8) {
      if (!g.base) { g.base = now; g.baseFrame = g.frames; }
      const due = g.base + (g.frames - g.baseFrame) * g.period;
      if (now < due) break;
      if (now - due > g.period * 2) { g.base = now; g.baseFrame = g.frames; }
      const pads = {}; pads[g.port] = __pad(ls.frame, g.port);
      const r = ls.beginFrame(pads);
      if (!r.ready) { if (r.reason === 'advantage') g.base += g.period; else g.base = 0; break; }
      ls.endFrame(null); ls.takeHashDue(); g.frames++;
      if (r.rollback) { g.rollbacks++; g.resim += r.rollback.depth; }
    }
  }
}
onmessage = (e) => {
  const d = e.data;
  if (d.t === 'init') {
    cfg = d.cfg;
    for (let i = 1; i < cfg.players; i++) {
      const id = 'g' + i;
      const ls = new Netplay.Lockstep({ host: false, peerId: id, portCount: 4, padBytes: 4, rollback: cfg.rbw,
        hashEvery: 0, stallBudgetMs: 600000, frameHz: cfg.viHz, rbCatchUp: cfg.adaptive, selfStepMs: 0.05, send: (m) => {
          post(id, 'page', m);
          for (let j = 1; j < cfg.players; j++) if (j !== i) post(id, 'g' + j, m);
        } });
      G.push({ id, port: i, ls, frames: 0, base: 0, baseFrame: 0, period: 1000 / cfg.viHz, rollbacks: 0, resim: 0, hidden: 0, pace: 1 });
    }
    setInterval(tick, 1);
    postMessage({ t: 'ok' });
  } else if (d.t === 'm') { for (const g of G) post('page', g.id, d.m); }
  else if (d.t === 'ready') { for (const g of G) g.ls.declareReady(d.disc); }
  else if (d.t === 'stat') postMessage({ t: 'stat', s: G.map((g) => ({ id: g.id, frame: g.ls.frame, state: g.ls.state, frames: g.frames,
    rollbacks: g.rollbacks, resim: g.resim, hidden: g.hidden, rb: g.ls.rollbackReport ? g.ls.rollbackReport() : null })) });
};`;

const launch = () => puppeteer.launch({
  headless: 'new', executablePath: existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const browser = await launch();
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const out = { worker: null, adaptive: ADAPTIVE, players: PLAYERS, latMs: [LATMIN, LATMAX], secs: SECS, cpu: CPU, mobile: MOBILE, hashEvery: HASH_EVERY, rbw: RBW, query: QUERY };
const log = [];
let room = null;
try {
  // ======================= A. THE ROOM ======================================
  const ctxA = await browser.createBrowserContext();
  const page = await ctxA.newPage();
  page.setDefaultTimeout(240000);
  if (MOBILE) await page.emulate({ userAgent: ANDROID_UA, viewport: { width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true } });
  else await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m) => { const t = m.text(); if (/lockstep|rollback|runahead|\[state\]|\[fb\]|error|⚠/i.test(t)) log.push('[A] ' + t.slice(0, 300)); });
  page.on('pageerror', (e) => log.push('[A] PAGEERROR ' + e.message));
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&rbw=${RBW}&workerrig=1${QUERY ? '&' + QUERY : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__n64LsAttach && !!window.Netplay, { timeout: 60000 });
  if (CPU > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
  await page.evaluate((cfg, src, padSrc) => {
    // eslint-disable-next-line no-eval
    (0, eval)(padSrc);
    window.__n64PadOverride = function (f, p) { return window.__pad(f, p); };
    window.__rbFull = {}; window.__n64RbLog = [];
    window.__n64RbTap = function (k, buf, fp) { window.__rbFull[k] = { full: window.__n64State.hashFull(buf), fp: fp >>> 0 }; };
    const w = new Worker(URL.createObjectURL(new Blob([src.replace('__ORIGIN__', location.origin)], { type: 'text/javascript' })));
    window.__ghost = w; window.__ghostStat = null;
    window.__n64LsAttach({ host: true, peerId: 'page', portCount: 4, padBytes: 4, rollback: cfg.rbw, hashEvery: cfg.hashEvery, rbCatchUp: cfg.adaptive, frameHz: 50,
      stallBudgetMs: 600000, send: (m) => w.postMessage({ t: 'm', m }), code: 'RBPRB' });
    w.onmessage = (e) => {
      if (e.data.t === 'm') { window.__n64LsEngine.receive(e.data.m); if (e.data.m.t === 'ls' && window.__n64LsKick) window.__n64LsKick(); }
      else if (e.data.t === 'stat') window.__ghostStat = e.data.s;
    };
    w.postMessage({ t: 'init', cfg: { players: cfg.players, rbw: cfg.rbw, latmin: cfg.latmin, latmax: cfg.latmax, viHz: 50, adaptive: cfg.adaptive } });
    const eng = window.__n64LsEngine;
    eng.seat('page', 1);
    for (let i = 1; i < cfg.players; i++) eng.seat('g' + i, 1);
  }, { players: PLAYERS, rbw: RBW, hashEvery: HASH_EVERY, latmin: LATMIN, latmax: LATMAX, adaptive: ADAPTIVE }, GHOST_SRC, PAD_SRC.replace('function __pad', 'window.__pad = function'));
  await page.evaluate((want) => {
    for (const id of ['romSelect', 'mobileRomSelect']) {
      const sel = document.getElementById(id); if (!sel) continue;
      for (let i = 0; i < sel.options.length; i++) if (sel.options[i].textContent.trim() === want) { sel.value = sel.options[i].value; sel.dispatchEvent(new Event('change')); }
    }
  }, GAME);
  if (MOBILE) {
    const b = await page.evaluate(() => { const r = document.getElementById('mobileSplashStart').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.touchscreen.tap(b.x, b.y);
  } else await page.evaluate(() => document.getElementById('btnStart').click());
  await page.waitForFunction(() => { const n = window.__n64Net && window.__n64Net(); return n && n.armed && n.coreArmed && n.party && n.party.able; }, { timeout: 240000 });
  out.worker = await page.evaluate(() => !!(window.__n64Net && window.__n64Net().worker));
  if (out.worker) {
    // The same two seams, in the realm the room driver runs in (see the header).
    const src = PAD_SRC.replace('function __pad', 'self.__pad = function') + `;
      self.__n64PadOverride = function (f, p) { return self.__pad(f, p); };
      self.__rbFull = {}; self.__n64RbLog = [];
      self.__n64RbTap = function (k, buf, fp) { self.__rbFull[k] = { full: self.__n64State.hashFull(buf), fp: fp >>> 0 }; };
      ({ realm: typeof WorkerGlobalScope !== 'undefined' ? 'worker' : 'window', state: !!self.__n64State });`;
    out.workerSeams = await page.evaluate((s2) => window.__n64Worker.eval(s2), src);
  }
  await page.evaluate(() => { window.__n64LsEngine.declareReady('probe'); window.__ghost.postMessage({ t: 'ready', disc: 'probe' }); });
  await page.waitForFunction(() => { const n = window.__n64Net(); return n.running && n.frame > 10; }, { timeout: 120000 });
  const snap = () => page.evaluate(() => {
    window.__ghost.postMessage({ t: 'stat' });
    const n = window.__n64Net();
    return { t: performance.now(), frame: n.frame, mode: n.mode, rb: n.rollback, ra: n.runahead, stalls: n.stalls, stallMs: n.stallMs,
             reanchors: n.reanchors, lostMs: n.lostMs, advWaits: n.advWaits, viHz: n.viHz, costAvgMs: n.costAvgMs, fault: n.fault,
             engineState: n.engine && n.engine.state, error: n.engine && n.engine.error, ghosts: window.__ghostStat,
             fb: n.fb, lat: n.lat, speed: window.__n64Rate && window.__n64Rate.speed };
  });
  await sleep(3000);
  const a = await snap();
  const tl = [];
  let prev = a;
  for (let i = 0; i < SECS; i++) {
    await sleep(1000);
    const s = await snap();
    const pr = prev.rb && prev.rb.page, sr = s.rb && s.rb.page;
    tl.push({ s: i + 1, rate: +((s.frame - prev.frame) / ((s.t - prev.t) / 1000) / (s.viHz || 50)).toFixed(3),
              rollbacks: sr && pr ? sr.rollbacks - pr.rollbacks : null, resim: sr && pr ? sr.resimFrames - pr.resimFrames : null,
              ra: s.ra && s.ra.frames, stalls: s.stalls - prev.stalls, adv: s.advWaits - prev.advWaits });
    prev = s;
    if (s.fault || s.engineState === 'failed' || s.engineState === 'desync') break;
  }
  const z = prev, secs = (z.t - a.t) / 1000;
  const rbA = a.rb && a.rb.page, rbZ = z.rb && z.rb.page;
  room = out.worker
    ? Object.assign(await page.evaluate(() => window.__n64Worker.eval('({ rblog: self.__n64RbLog.slice(0, 4000), full: self.__rbFull })')),
                    await page.evaluate(() => ({ frame: window.__n64LsEngine.frame, confirmed: window.__n64LsEngine._rbConfirmed })))
    : await page.evaluate(() => ({ rblog: window.__n64RbLog.slice(0, 4000), full: window.__rbFull, frame: window.__n64LsEngine.frame, confirmed: window.__n64LsEngine._rbConfirmed }));
  Object.assign(out, {
    mode: z.mode, roomRate: +((z.frame - a.frame) / secs / (z.viHz || 50)).toFixed(4),
    secsBelow99: tl.filter((x) => x.rate < 0.99).length,
    frames: z.frame - a.frame,
    rollbacksPerSec: rbZ && rbA ? +((rbZ.rollbacks - rbA.rollbacks) / secs).toFixed(2) : null,
    resimFramesPerFrame: rbZ && rbA ? +((rbZ.resimFrames - rbA.resimFrames) / Math.max(1, z.frame - a.frame)).toFixed(3) : null,
    page: rbZ, engine: z.rb && z.rb.engine, state: z.rb && z.rb.state, runahead: z.ra, advWaits: z.advWaits - a.advWaits,
    stalls: z.stalls - a.stalls, stallMs: z.stallMs - a.stallMs, reanchors: z.reanchors - a.reanchors, lostMs: (z.lostMs || 0) - (a.lostMs || 0),
    costAvgMs: z.costAvgMs, fb: z.fb, ghosts: z.ghosts, fault: z.fault, engineState: z.engineState, error: z.error,
    latFrames: (z.lat && z.lat.samples || []).map((x) => x.frames),
    tappedFrames: Object.keys(room.full).length, confirmedTo: room.confirmed,
  });
  out.timeline = tl;
  await ctxA.close();

  // ======================= B. THE STRAIGHT REFERENCE ========================
  const keys = Object.keys(room.full).map(Number).sort((x, y) => x - y);
  if (!NOREF && keys.length) {
    const ctxB = await browser.createBrowserContext();
    const pb = await ctxB.newPage();
    pb.setDefaultTimeout(240000);
    await pb.setViewport({ width: 1280, height: 900 });
    pb.on('pageerror', (e) => log.push('[B] PAGEERROR ' + e.message));
    // Arm before main(), exactly as the page does in a room; note when main() returns.
    await pb.evaluateOnNewDocument(() => {
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
    // The reference is ALWAYS the main-thread core: it steps window.Module itself.
    const refQ = (QUERY || '').split('&').filter((kv) => kv && !/^worker=/.test(kv)).join('&');
    await pb.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart&worker=0${refQ ? '&' + refQ : ''}`, { waitUntil: 'domcontentloaded' });
    await pb.waitForFunction(() => window.__refMain === true, { timeout: 240000 });
    const last = keys[keys.length - 1];
    const ref = await pb.evaluate(async (padSrc, players, keys, last) => {
      (0, eval)(padSrc);
      const M = window.Module, want = new Set(keys), res = {};
      const set = (p, b) => {
        const mask = b[0] | (b[1] << 8), sx = (b[2] << 24) >> 24, sy = (b[3] << 24) >> 24;
        M._neil_ls_set_pad(p, mask, Math.round(sx / 127 * 32000), Math.round(sy / 127 * 32000));
      };
      // the pre-roll: one neutral frame, as lsPreroll does
      for (let p = 0; p < 4; p++) M._neil_ls_set_pad(p, 0, 0, 0);
      M._neil_ls_run_frame();
      const buf = window.__n64State.alloc();
      for (let f = 0; f <= last; f++) {
        for (let p = 0; p < 4; p++) set(p, p < players ? window.__pad(f, p) : new Uint8Array(4));
        M._neil_ls_run_frame();
        if (want.has(f)) {
          window.__n64State.save(buf);
          res[f] = { full: window.__n64State.hashFull(buf), fp: M._neil_last_fp() >>> 0 };
        }
        if ((f & 63) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return res;
    }, PAD_SRC.replace('function __pad', 'window.__pad = function'), PLAYERS, keys, last);
    let firstFull = null, firstFp = null, same = 0;
    for (const k of keys) {
      const A = room.full[k], B = ref[k];
      if (!B) continue;
      if (A.full === B.full) same++;
      else if (firstFull == null) firstFull = k;
      if (A.fp !== B.fp && firstFp == null) firstFp = k;
    }
    out.reference = { compared: keys.length, fullMatch: same, firstFullMismatch: firstFull, firstFpMismatch: firstFp,
      events: (room.rblog || []).filter((e) => (e[0] === 'grow') || (e[1] >= (firstFull == null ? 0 : firstFull) - 25 && e[1] <= (firstFull == null ? 0 : firstFull) + 5)).slice(0, 60),
      mismatches: keys.filter((k) => ref[k] && room.full[k].full !== ref[k].full).slice(0, 12) };
    await ctxB.close();
  }
} catch (e) { out.error = e.message; }
out.log = log.slice(-40);

// ---- verdicts -----------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); };
const R = out.reference;
if (out.error) bad('rig', out.error);
if (out.mode !== 'rollback') bad('the room ran ROLLBACK', 'mode=' + out.mode);
else ok('the room ran ROLLBACK (input delay 0)');
const rbN = out.page ? out.page.rollbacks : 0;
if (!R) bad('exactness', 'no reference run (' + (out.tappedFrames || 0) + ' tapped frames)');
else if (!rbN) bad('VOID: no rollback happened, so exactness was not exercised');
else if (R.firstFullMismatch == null && R.fullMatch === R.compared && R.compared > 0)
  ok('every confirmed state matches a straight run BIT FOR BIT (full 16.8 MB hash)', `${R.compared} frames compared after ${rbN} rollbacks / ${out.page.resimFrames} re-simulated frames`);
else bad('confirmed state differs from the straight run', JSON.stringify(R));
if (out.engineState === 'desync' || out.engineState === 'failed' || out.fault) bad('engine state', out.engineState + ' ' + (out.fault || out.error || ''));
console.log(JSON.stringify(Object.assign({}, out, { timeline: undefined, log: undefined })));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log(`\n[n64-rollback] ${pass} passed, ${fail} failed`);
await browser.close().catch(() => {});
process.exit(fail ? 1 : 0);

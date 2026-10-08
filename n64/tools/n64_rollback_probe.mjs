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
// THE ROLLBACK-DEFAULT ARMS (n64/docs/rollback-default/): L = delay lockstep, G = rollback with
// the product's capacity gate live; both get the product's pre-Ready RTT setup (--rtt, default on):
//   L: --rbw 0 --query rb=0 --expect any --noref
//   G: --rbw 8 --query rb=1 --expect any --cin
// (append &worker=0 to --query for the main-thread realm; --wslow 4 slows the worker's core).
import { createRequire } from 'node:module';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
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
// --rtt 1 (default): before Ready, the HOST engine gets what the product's chooseDelayThenReady
//   gives it from its RTT pings (n64/index.html, Session.rttReport): six round trips per ghost,
//   each drawn from this rig's own link model (two independent one-way draws in [latmin, latmax]),
//   fed to Lockstep.recommendDelayForRoom / floorDelayForRoom at this cartridge's field period ->
//   engine.delay, engine.rttDelay (the most a capacity-gated room may switch to) and
//   engine.netFloorDelay. The __n64LsAttach path skips chooseDelayThenReady, so without this a
//   lockstep arm would run the engine's default delay and a gated arm would have no RTT. Both arms
//   get it, as both product rooms do. --rtt 0: the old bare attach. --ldelay D [--lfloor F]: pin
//   them instead of drawing.
// --wslow R: in WORKER mode, make the worker core's three heavy exports (_neil_ls_run_frame,
//   _neil_state_save_raw_fast, _neil_state_load_raw) take R x their own wall time (busy-wait),
//   because the CDP CPU throttle does not reach workers (n64/docs/worker/README.md).
const RTT = flag('rtt', '1') !== '0';
// --rttseed N: draw those pings from a seeded generator, so the two arms of a matched pair get
//   the SAME link measurement (and so the same delay) — the comparison is then of the arms only.
const RTTSEED = flag('rttseed', null);
const FORCE_RETURN = +flag('force-return', '0');
const LDELAY = +flag('ldelay', '0'), LFLOOR = +flag('lfloor', '0'), WSLOW = +flag('wslow', '1');
// --wslow-until S: the slowed worker core gets its own speed back S seconds into the window — a
//   device whose step later FITS. The gated room must return to rollback on the engine's real
//   judgement (rbResume; no --force-return), and with --cin every confirmed state after the
//   return is checked bit for bit like any other.
const WSLOW_UNTIL = +flag('wslow-until', '0');
// --expect rollback|any: the room must still be in rollback at the end (default: rollback, the
//   exactness probe) / may have been switched by the capacity gate (a rate cell's G or L arm).
// --cin: record every input the ROOM's engine holds (engine.inputs: real inputs only, final once
//   present, kept LS_KEEP=240 frames) every 50 ms, and run the straight reference with THOSE
//   inputs instead of __pad(f). __pad(f) at frame f is only the confirmed input at input delay 0;
//   once a capacity-gated room decides to switch to delay, the local pad sampled at f is put at
//   f+d (lib/netplay.js _rbPutLocal via beginFrame), so the plain reference compares wrong inputs.
const CIN = has('cin');
const EXPECT = flag('expect', 'rollback');
// --lsexact: a DELAY-LOCKSTEP room's exactness — room_core.js taps the state after every 10th frame
//   (the same __n64RbTap seam), so a room with no rollback is not VOID (the frame-skip arms: a
//   delay frame that skipped its draws must leave the same machine as a straight run).
const LSEXACT = has('lsexact');
// --pics PATH: hash the window after every PRESENTED frame that drew (core worker only), keep the
//   ones that stayed true — a frame no later rollback reached back to (from <= f): its picture is of
//   the frame's final state — and write { frame: hash } to PATH. --picsref PATH: compare against such
//   a file from another run (the frame-skip arms: a skipped room's drawn pictures against a room that
//   draws every frame), frame for frame where both have one.
const PICS = flag('pics', ''), PICSREF = flag('picsref', '');
// --dumpat F1,F2,... --dumpdir DIR: diagnostic — write the room's raw state after each listed tapped frame
//   and the straight run's at the same frames to DIR/room_F.bin, DIR/ref_F.bin (16.8 MB each), for a
//   field-by-field diff (n64/tools/n64_state_diff.mjs).
const DUMPAT = flag('dumpat', '').split(',').filter(Boolean).map(Number), DUMPDIR = flag('dumpdir', '');
// --ranlog PATH (diagnostic, core worker): after every frame the room runs (again), the lazy framebuffer
//   queue, glide's readback-failed flag and the CPU fingerprint, last run wins: { frame: [...] } -> PATH
//   (+ hist: EVERY run in order as [frame, kind, CPU fingerprint] — a re-run from a snapshot that comes out
//   different from the run before it is a snapshot/restore miss; jit: the async JIT's install rejections by reason)
const RANLOG = flag('ranlog', '');
// --regions (diagnostic): every tapped state is also hashed per 4 KiB chunk (the raw layout's bookkeeping
//   words skipped as hashFull does), on both sides, and the report names the chunks that differ at the first
//   mismatching frame — which RDRAM pages / trailer blobs a rollback did not put back.
const REGIONS = has('regions');
const REG_SRC = `function __regHash(u8) {
  var R = 16789504, n = Math.ceil(u8.length / 4096), out = new Array(n);
  for (var c = 0; c < n; c++) {
    var a = c * 4096, b = Math.min(u8.length, a + 4096) & ~3, h = 2166136261;
    var w = new Uint32Array(u8.buffer, u8.byteOffset + a, (b - a) >>> 2);
    for (var i = 0; i < w.length; i++) { if (a === R && i >= 4 && i < 7) continue; h = Math.imul(h ^ w[i], 16777619) >>> 0; }
    out[c] = h >>> 0;
  }
  return out;
}`;
const PICDUMP = flag('picdump', '').split(',').filter(Boolean).map(Number);   // diagnostic: raw RGBA of these frames into the --json
// THE RECORDER. Every write into the engine's input table goes through Lockstep._put (lib/netplay.js),
//   so that is hooked: the record is the table's own LAST value for every (frame, port), written at the
//   moment it is written — nothing to fall out of a retention window, nothing a starved poll can miss,
//   and a value the engine replaces is replaced here too (the 50 ms poll this replaces kept the FIRST
//   value it saw and never updated a port once recorded). The poll stays, only to pick up what was in
//   the table before the hook went in; puts counts the hooked writes, rewrites those that changed a value.
const CIN_SRC = (engExpr) => `(function () {
  self.__cin = {}; self.__cinPolls = 0; self.__cinStat = { puts: 0, rewrites: 0, hooked: false };
  function rec(f, p, b) {
    var row = self.__cin[f] || (self.__cin[f] = [null, null, null, null]), v = Array.prototype.slice.call(b);
    if (row[p] && row[p].join() !== v.join()) self.__cinStat.rewrites++;
    row[p] = v;
  }
  function hook(e) {
    if (!e || e.__cinHooked || typeof e._put !== 'function') return;
    var put = e._put; e.__cinHooked = true; self.__cinStat.hooked = true;
    e._put = function (f, port, bytes) { try { self.__cinStat.puts++; if (port >= 0 && port < 4 && bytes) rec(f, port, bytes); } catch (x) {} return put.apply(this, arguments); };
  }
  function poll() {
    var e = ${engExpr}; if (!e || !e.inputs) return; self.__cinPolls++; hook(e);
    e.inputs.forEach(function (mp, f) {
      for (var p = 0; p < 4; p++) { var b = mp.get(p); if (!b) continue; var row = self.__cin[f]; if (!row || !row[p]) rec(f, p, b); }
    });
  }
  poll(); setInterval(poll, 50);
  return true;
})()`;
// THE CORE'S OWN INPUT (core worker, --cin): after every frame the room's core runs (rbStep, again on a
//   re-simulation), the image it ran with (room_core.js RB.img) — last run wins. Checked frame for frame
//   against the engine's final input below: the straight reference is given the ENGINE's input, so a frame
//   the room's core last ran with something else (a missed correction) would otherwise pass unseen.
const RAN_SRC = `(function () {
  self.__ranWith = {}; self.__ranN = 0;
  var prev = self.__n64RanTap;
  self.__n64RanTap = function (k, kind) {
    try {
      var R = self.RM && self.RM.R, RB = R && R.RB;
      if (RB) for (var j = 0; j < RB.imgF.length; j++) if (RB.imgF[j] === k && RB.img[j]) { self.__ranWith[k] = Array.prototype.slice.call(RB.img[j]); self.__ranN++; break; }
    } catch (x) {}
    if (prev) return prev(k, kind);
  };
  return true;
})()`;
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
// --ghostconst (diagnostic): the ghost players hold a constant (empty) pad, so the room's predictions are
//   right and it (almost) never rolls back — what a rollback room does per frame, without its loads
const GHOSTCONST = has('ghostconst');
const PAD_SRC = `function __pad(f, p) {
  var b = new Uint8Array(4), m = 0;
  if (${GHOSTCONST ? 'p > 0' : 'false'}) return b;
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
const W = { inN: 0, inB: 0, outN: 0, outB: 0, inT: {}, outT: {} };   // the page<->ghost traffic (messages, JSON bytes, by type)
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
      if (x.to === 'page') { W.outN++; W.outB += JSON.stringify(x.m).length; W.outT[x.m.t] = (W.outT[x.m.t] || 0) + 1; postMessage({ t: 'm', m: x.m }); }
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
        hashEvery: 0, stallBudgetMs: 600000, frameHz: cfg.viHz, rbCatchUp: cfg.adaptive, selfStepMs: 0.05, rbResume: true, send: (m) => {
          post(id, 'page', m);
          for (let j = 1; j < cfg.players; j++) if (j !== i) post(id, 'g' + j, m);
        } });
      G.push({ id, port: i, ls, frames: 0, base: 0, baseFrame: 0, period: 1000 / cfg.viHz, rollbacks: 0, resim: 0, hidden: 0, pace: 1 });
    }
    setInterval(tick, 1);
    postMessage({ t: 'ok' });
  } else if (d.t === 'm') { W.inN++; W.inB += JSON.stringify(d.m).length; W.inT[d.m.t] = (W.inT[d.m.t] || 0) + 1; for (const g of G) post('page', g.id, d.m); }
  else if (d.t === 'ready') { for (const g of G) g.ls.declareReady(d.disc); }
  else if (d.t === 'stat') postMessage({ t: 'stat', s: G.map((g) => ({ id: g.id, frame: g.ls.frame, state: g.ls.state, frames: g.frames,
    rollbacks: g.rollbacks, resim: g.resim, hidden: g.hidden, rb: g.ls.rollbackReport ? g.ls.rollbackReport() : null,
    wire: W, holds: { resync: g.ls.stats.resyncHolds | 0, cadence: g.ls.stats.cadenceHolds | 0, stalls: g.ls.stats.stalls | 0, stallMs: Math.round(g.ls.stats.stallMs || 0) } })) });
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
  page.on('console', (m) => { const t = m.text(); if (/lockstep|rollback|runahead|fskip|\[state\]|\[fb\]|error|⚠/i.test(t)) log.push('[A] ' + t.slice(0, 300)); });
  page.on('pageerror', (e) => log.push('[A] PAGEERROR ' + e.message));
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&rbw=${RBW}&workerrig=1${QUERY ? '&' + QUERY : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__n64LsAttach && !!window.Netplay, { timeout: 60000 });
  if (CPU > 1) { const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
  await page.evaluate((cfg, src, padSrc) => {
    // eslint-disable-next-line no-eval
    (0, eval)(padSrc);
    window.__n64PadOverride = function (f, p) { return window.__pad(f, p); };
    window.__rbFull = {}; window.__n64RbLog = []; window.__dumpAt = cfg.dumpAt;
    if (cfg.ranlog) {
      window.__ranlog = {};
      window.__n64RanTap = function (k, kind) {
        const M = window.Module; if (!window.__rlq) { window.__rlq = M._malloc(256); window.__rls = M._malloc(32); }
        const lq = window.__rlq, ls = window.__rls;
        const n = M._neil_lfb_pending(lq, 16), q = Array.from(M.HEAPU32.subarray(lq >> 2, (lq >> 2) + 2 * Math.min(n, 16))).map((x) => x.toString(16)).join(',');
        M._neil_lfb_stats(ls); const st = Array.from(M.HEAPU32.subarray(ls >> 2, (ls >> 2) + 8));
        window.__ranlog[k] = [q, M._neil_native_fbread_failed(), M._neil_last_fp() >>> 0, kind, st.join('.'), window.__fbAsync ? window.__fbAsync.calls : -1];
        window.__clF = k;
        if (window.__callLog && k >= 1237 && k <= 1248) window.__callLog.push([k, 'TAP', kind, new Error().stack.split('\n').slice(2, 6).join(' <- ').replace(/https?:[^ )]*\//g, '')]);
        if (!window.__clOn) {
          // every call into the core's exports while frames 1238..1248 run, with its arguments
          window.__clOn = true; window.__callLog = [];
          for (const name of Object.keys(M)) {
            if (!/^_/.test(name) || typeof M[name] !== 'function' || /^_(neil_lfb_pending|neil_lfb_stats|neil_native_fbread_failed|malloc|free)$/.test(name)) continue;
            const f = M[name];
            M[name] = function () { if (window.__clF >= 1237 && window.__clF <= 1248 && window.__callLog.length < 20000) window.__callLog.push([window.__clF, name, Array.from(arguments).join(','), name === '_neil_ls_run_frame' ? new Error().stack.split('\n').slice(2, 6).join(' <- ').replace(/https?:[^ )]*\//g, '') : '']);
              try { return f.apply(this, arguments); } catch (e) { if (window.__callLog.length < 20000) window.__callLog.push([window.__clF, 'THROW ' + name, String(e && e.message || e), String(e && e.stack || '').split('\n').slice(0, 12).join(' <- ').replace(/https?:[^ )]*\//g, '')]); throw e; } };
          }
        }
      };
    }
    window.__n64RbTap = function (k, buf, fp) { window.__rbFull[k] = { full: window.__n64State.hashFull(buf), fp: fp >>> 0 };
      if (window.__dumpAt && window.__dumpAt.indexOf(k) >= 0) (window.__rbDump = window.__rbDump || {})[k] = buf.slice(); };
    const w = new Worker(URL.createObjectURL(new Blob([src.replace('__ORIGIN__', location.origin)], { type: 'text/javascript' })));
    window.__ghost = w; window.__ghostStat = null;
    // (the options the page's own startLockstep passes: rollbackOk, rbCatchUp, rbResume)
    window.__n64LsAttach({ host: true, peerId: 'page', portCount: 4, padBytes: 4, rollback: cfg.rbw, hashEvery: cfg.hashEvery, rbCatchUp: cfg.adaptive, frameHz: 50,
      rollbackOk: true, rbResume: true,
      stallBudgetMs: 600000, send: (m) => w.postMessage({ t: 'm', m }), code: 'RBPRB' });
    w.onmessage = (e) => {
      if (e.data.t === 'm') { window.__n64LsEngine.receive(e.data.m); if (e.data.m.t === 'ls' && window.__n64LsKick) window.__n64LsKick(); }
      else if (e.data.t === 'stat') window.__ghostStat = e.data.s;
    };
    w.postMessage({ t: 'init', cfg: { players: cfg.players, rbw: cfg.rbw, latmin: cfg.latmin, latmax: cfg.latmax, viHz: 50, adaptive: cfg.adaptive } });
    const eng = window.__n64LsEngine;
    eng.seat('page', 1);
    for (let i = 1; i < cfg.players; i++) eng.seat('g' + i, 1);
  }, { ranlog: !!RANLOG, dumpAt: DUMPDIR ? DUMPAT : [], players: PLAYERS, rbw: RBW, hashEvery: HASH_EVERY, latmin: LATMIN, latmax: LATMAX, adaptive: ADAPTIVE }, GHOST_SRC, PAD_SRC.replace('function __pad', 'window.__pad = function'));
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
      ${REGIONS ? REG_SRC.replace('function __regHash', 'self.__regHash = function') + ';' : ''}
      self.__n64RbTap = function (k, buf, fp) { self.__rbFull[k] = { full: self.__n64State.hashFull(buf), fp: fp >>> 0 };
        if (self.__regHash) self.__rbFull[k].reg = self.__regHash(buf);
        if (${JSON.stringify(DUMPAT)}.indexOf(k) >= 0) (self.__rbDump = self.__rbDump || {})[k] = buf.slice(); };
      ${RANLOG ? `(function () {
        var M = self.Module, lq = M._malloc(256), ls = M._malloc(32); self.__ranlog = {};
        self.__n64RanTap = function (k, kind) {
          var n = M._neil_lfb_pending(lq, 16), q = Array.from(M.HEAPU32.subarray(lq >> 2, (lq >> 2) + 2 * Math.min(n, 16))).map(function (x) { return x.toString(16); }).join(',');
          M._neil_lfb_stats(ls); var st = Array.from(M.HEAPU32.subarray(ls >> 2, (ls >> 2) + 8));
          self.__ranlog[k] = [q, M._neil_native_fbread_failed(), M._neil_last_fp() >>> 0, kind, st.join('.'), self.__fbAsync ? self.__fbAsync.calls : -1];
          (self.__runHist = self.__runHist || []).push([k, kind, M._neil_last_fp() >>> 0]);   // every run, in order
        };
      })();` : ''}
      ${(PICS || PICSREF) ? `(function () {
        var px = null, toastSeen = true;
        self.__n64PicTap = function (f) {
          // the frontend's toast (mymain.cpp toastCounter, 60 swaps) is HOST state that a rollback's
          // re-simulated frames count down too, so in a rollback room its last frame lands at a
          // different frame on every run (MEASURED: two rooms with no frame skip differed at 6
          // consecutive drawn frames, the toast's end) — frames that may show it are not compared
          // (the counter is the last int of glide's host-state image, lazy_fb.c neil_gl_state_save)
          var Mm = self.Module, tc = 0, was = toastSeen;
          if (Mm._neil_gl_state_size) {
            var gn = Mm._neil_gl_state_size(), gp = self.__gsp || (self.__gsp = Mm._malloc(gn));
            Mm._neil_gl_state_save(gp); var U = Mm.HEAPU8, o = gp + gn - 4;
            tc = U[o] | (U[o + 1] << 8) | (U[o + 2] << 16) | (U[o + 3] << 24);
          }
          toastSeen = tc > 0;
          if (tc > 0 || was) return;
          if (!self.FSK || !self.FSK.lastDrew) return;
          var gl = self.Module.ctx, FB = self.__fbAsync, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
          if (!px || px.length !== W * H * 4) px = new Uint8Array(W * H * 4);
          if (FB) FB.bypass = true;
          try {
            var rfb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), pb = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pb);
          } finally { if (FB) FB.bypass = false; }
          var h = 2166136261 >>> 0;
          for (var i = 0; i < px.length; i += 4) { h = Math.imul(h ^ px[i], 16777619); h = Math.imul(h ^ px[i + 1], 16777619); h = Math.imul(h ^ px[i + 2], 16777619); }
          self.__n64RbLog.push(['pic', f, h >>> 0]);
          if (${JSON.stringify(PICDUMP)}.indexOf(f) >= 0) { var str = ''; for (var q = 0; q < px.length; q += 0x8000) str += String.fromCharCode.apply(null, px.subarray(q, q + 0x8000)); (self.__picDump = self.__picDump || {})[f + ':' + self.__n64RbLog.length] = { W: W, H: H, b64: btoa(str) }; }
        };
      })();` : ''}
      ({ realm: typeof WorkerGlobalScope !== 'undefined' ? 'worker' : 'window', state: !!self.__n64State });`;
    out.workerSeams = await page.evaluate((s2) => window.__n64Worker.eval(s2), src);
    // --weval SRC (diagnostic): evaluated in the core worker after the seams, before the room starts
    //   (e.g. 'Module._neil_state_set_remap(0)' — every TLB-changing load takes the full wipe)
    if (flag('weval', '')) out.weval = await page.evaluate((s4) => window.__n64Worker.eval(s4), flag('weval', ''));
    if (WSLOW > 1) {
      out.wslowInstall = await page.evaluate((s3) => window.__n64Worker.eval(s3), `(function (R) {
        var M = self.Module, done = [];
        self.__wslow = { R: R, calls: 0, baseMs: 0, addedMs: 0 };
        ['_neil_ls_run_frame', '_neil_state_save_raw_fast', '_neil_state_load_raw'].forEach(function (n) {
          var f = M[n]; if (typeof f !== 'function') return;
          M[n] = function () {
            var R2 = self.__wslow.R, t0 = performance.now(), r = f.apply(this, arguments), d = performance.now() - t0, until = performance.now() + d * (R2 - 1);
            while (performance.now() < until) {}
            self.__wslow.calls++; self.__wslow.baseMs += d; self.__wslow.addedMs += d * (R2 - 1);
            return r;
          };
          done.push(n);
        });
        return done;
      })(${WSLOW})`);
    }
  }
  if (!out.worker) {
    // Presented frames on the main-thread core, with the worker's definition (core_worker.js
    // observePresents): animation frames in which the core's field counter moved.
    await page.evaluate(() => {
      window.__pres = { shown: 0, frames: 0, lastVi: -1 };
      (function obs() {
        requestAnimationFrame(obs);
        const P = window.__pres; P.frames++;
        const M = window.Module; if (!M || !M._neil_vi_total) return;
        const vi = M._neil_vi_total() >>> 0;
        if (P.lastVi >= 0 && vi !== P.lastVi) P.shown++;
        P.lastVi = vi;
      })();
    });
  }
  if (CIN) out.cinInstall = out.worker ? await page.evaluate((s) => window.__n64Worker.eval(s), CIN_SRC('self.RM && self.RM.eng'))
                                       : await page.evaluate((s) => (0, eval)(s), CIN_SRC('window.__n64LsEngine'));
  if (CIN && out.worker) out.ranInstall = await page.evaluate((s) => window.__n64Worker.eval(s), RAN_SRC);
  if (RTT || LDELAY > 0) out.lsetup = await page.evaluate((cfg) => {
    const e = window.__n64LsEngine, L = window.Netplay.Lockstep, frameMs = 1000 / 50;   // MK64 is PAL: 50 Hz
    let d = cfg.ldelay, floor = cfg.lfloor, samples = null;
    if (!(d > 0)) {
      samples = {};
      let st = (cfg.seed == null ? (Math.random() * 4294967296) : +cfg.seed) >>> 0;
      const rnd = cfg.seed == null ? Math.random : () => {   // mulberry32
        st = (st + 0x6D2B79F5) >>> 0; let t = st;
        t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const one = () => cfg.latmin + rnd() * (cfg.latmax - cfg.latmin);
      for (let i = 1; i < cfg.players; i++) { samples['g' + i] = []; for (let k = 0; k < 6; k++) samples['g' + i].push(one() + one()); }
      d = L.recommendDelayForRoom(samples, frameMs); floor = L.floorDelayForRoom(samples, frameMs);
    }
    e.delay = d; e.rttDelay = d; if (floor > 0) e.netFloorDelay = floor;
    return { delay: d, rttDelay: d, netFloorDelay: floor || 0, samples };
  }, { ldelay: LDELAY, lfloor: LFLOOR, latmin: LATMIN, latmax: LATMAX, players: PLAYERS, seed: RTTSEED });
  await page.evaluate(() => { window.__n64LsEngine.declareReady('probe'); window.__ghost.postMessage({ t: 'ready', disc: 'probe' }); });
  await page.waitForFunction(() => { const n = window.__n64Net(); return n.running && n.frame > 10; }, { timeout: 120000 });
  // what the capacity switch WOULD pick right now, from the host engine's own methods
  const CAPX_SRC = `(function (e) { if (!e || !e._capWireFloor) return null; var now = e._now();
    var rows = e._capRows ? e._capRows(now) : [];
    return { wire: e._capWireFloor(), lateInP99: e._rbLateInP99 ? e._rbLateInP99() : null,
             peerLi: rows.filter(function (r) { return r.peer !== e.peerId; }).map(function (r) { return r.li; }),
             wouldPick: e._capDelay ? e._capDelay(rows) : null, need: e._capNeed, window: e.rollback }; })`;
  const snap = () => page.evaluate(async (capx) => {
    window.__ghost.postMessage({ t: 'stat' });
    const n = window.__n64Net();
    let cx = null;
    try { cx = n.worker ? await window.__n64Worker.eval(capx + '(self.RM && self.RM.eng)') : (0, eval)(capx)(window.__n64LsEngine); } catch (e) { cx = { err: String(e) }; }
    return { t: performance.now(), frame: n.frame, mode: n.mode, rb: n.rollback, ra: n.runahead, stalls: n.stalls, stallMs: n.stallMs,
             reanchors: n.reanchors, lostMs: n.lostMs, advWaits: n.advWaits, viHz: n.viHz, costAvgMs: n.costAvgMs, fault: n.fault,
             costOver: n.costOver, costMaxMs: n.costMaxMs,
             engineState: n.engine && n.engine.state, error: n.engine && n.engine.error, ghosts: window.__ghostStat,
             fb: n.fb, lat: n.lat, speed: window.__n64Rate && window.__n64Rate.speed,
             eng: n.engine ? { delay: n.engine.delay, state: n.engine.state, desync: n.engine.desync, mode: n.engine.mode,
                                hashesCompared: n.engine.hashesCompared, stalls: n.engine.stalls, ownClock: n.engine.ownClock || null } : null,
             capx: cx, step: n.step || null, fskip: n.fskip || null,
             pres: n.worker ? (function () { const p = window.__n64Pace ? window.__n64Pace() : {}; return { shown: p.shown | 0, frames: p.animFrames | 0 }; })()
                            : (window.__pres ? { shown: window.__pres.shown, frames: window.__pres.frames } : null) };
  }, CAPX_SRC);
  await sleep(3000);
  // THE LATENCY WITNESS over the window (core_worker.js fsReport: per presented picture, the tick
  // that ran its frame -> its fence signalled / the animation frame that committed it)
  if (out.worker) await page.evaluate(() => window.__n64Worker.eval('typeof fsReset === "function" ? (fsReset(), 1) : 0'));
  const a = await snap();
  const tl = [];
  let prev = a, lastRbPage = a.rb && a.rb.page;
  for (let i = 0; i < SECS; i++) {
    await sleep(1000);
    const s = await snap();
    const pr = prev.rb && prev.rb.page, sr = s.rb && s.rb.page;
    tl.push({ s: i + 1, rate: +((s.frame - prev.frame) / ((s.t - prev.t) / 1000) / (s.viHz || 50)).toFixed(3),
              rollbacks: sr && pr ? sr.rollbacks - pr.rollbacks : null, resim: sr && pr ? sr.resimFrames - pr.resimFrames : null,
              ra: s.ra && s.ra.frames, stalls: s.stalls - prev.stalls, adv: s.advWaits - prev.advWaits,
              mode: s.mode, delay: s.eng && s.eng.delay,
              lag: (function () { const v = (s.lat && s.lat.samples || []).slice(-10).map((x) => x.frames).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; })(),
              shown: s.pres && prev.pres ? s.pres.shown - prev.pres.shown : null, ticks: s.pres && prev.pres ? s.pres.frames - prev.pres.frames : null,
              capx: s.capx });
    if (s.rb && s.rb.page) lastRbPage = s.rb.page;
    if (WSLOW_UNTIL > 0 && i + 1 === WSLOW_UNTIL && out.worker && WSLOW > 1) {
      await page.evaluate(() => window.__n64Worker.eval('self.__wslow.R = 1'));
      tl[tl.length - 1].wslowLifted = true; out.wslowLiftedAt = i + 1;
    }
    // --force-return S (TEST SEAM, never a product path): once the gated room is in delay and
    // S seconds of the window have passed, the HOST engine is told every console can afford
    // rollback (its _capNeedOf answers 0.1, the calm is 1 s) so it schedules the return; once the
    // room is back in rollback the real judgement is restored. What it exercises is the page's
    // half of rbResume — room_core.js rbRearm — and with --cin every confirmed state after the
    // return is checked bit for bit against the straight run like any other.
    if (FORCE_RETURN > 0 && i + 1 >= FORCE_RETURN) {
      const src = `(function (e) { if (!e) return 'no engine';
        if (!e.__frOrig && !e.rollback && e._capGate) { e.__frOrig = e._capNeedOf; e._capNeedOf = function () { return 0.1; };
          e._capUpCooldown = 1000; e._capDownAt = 0; return 'forced'; }
        if (e.__frOrig && e.rollback) { e._capNeedOf = e.__frOrig; e.__frOrig = null; e.__frDone = true; return 'restored'; }
        if (e.__frOrig) { var now = e._now(), rows = e._capRows(now);
          return 'waiting ' + JSON.stringify({ rows: rows.map(function (r) { return [r.peer, r.st, r.rr, r.rz]; }), seated: e.expectedPeers().length + 1,
            dropped: e.dropped.size, pend: !!e._pendingDelay, calm: e._capCalmSince ? Math.round(now - e._capCalmSince) : 0, down: Math.round(now - e._capDownAt),
            cool: e._capUpCooldown, mem: !!e._capMemDown, next: !!e._modeNext, st: e.state, peers: Array.from(e._capPeer.entries()).map(function (x) { return [x[0], x[1].mode, Math.round(now - x[1].at)]; }) }); }
        return e.__frDone ? 'done' : 'idle'; })`;
      const r = out.worker ? await page.evaluate((x) => window.__n64Worker.eval(x + '(self.RM && self.RM.eng)'), src)
                           : await page.evaluate((x) => (0, eval)(x)(window.__n64LsEngine), src);
      tl[tl.length - 1].forceReturn = r;
    }
    prev = s;
    if (s.fault || s.engineState === 'failed' || s.engineState === 'desync') break;
  }
  const z = prev, secs = (z.t - a.t) / 1000;
  if (out.worker) out.fsLat = await page.evaluate(() => window.__n64Worker.eval('typeof fsReport === "function" ? (function (r) { return { presented: r.presented, overwritten: r.overwritten, lat: r.lat, gpu: r.gpu }; })(fsReport()) : null'));
  const rbA = a.rb && a.rb.page, rbZ = z.rb && z.rb.page;
  room = out.worker
    ? Object.assign(await page.evaluate((pics) => window.__n64Worker.eval('({ rblog: self.__n64RbLog.slice(0, 4000), pics: ' + (pics ? '(function (L) { var o = {}, minFrom = Infinity; for (var i = L.length - 1; i >= 0; i--) { var e = L[i]; if (e[0] === "rb") minFrom = Math.min(minFrom, e[2]); else if (e[0] === "pic" && e[1] < minFrom) o[e[1]] = e[2]; } return o; })(self.__n64RbLog)' : 'null') + ', full: self.__rbFull, cin: self.__cin || null, cinPolls: self.__cinPolls | 0 })'), !!(PICS || PICSREF)),
                    await page.evaluate(() => ({ frame: window.__n64LsEngine.frame, confirmed: window.__n64LsEngine._rbConfirmed })))
    : await page.evaluate(() => ({ rblog: window.__n64RbLog.slice(0, 4000), full: window.__rbFull, frame: window.__n64LsEngine.frame, confirmed: window.__n64LsEngine._rbConfirmed, cin: window.__cin || null, cinPolls: window.__cinPolls | 0 }));
  const b64 = (u8) => { let str = ''; for (let q = 0; q < u8.length; q += 0x8000) str += String.fromCharCode.apply(null, u8.subarray(q, q + 0x8000)); return btoa(str); };
  if (RANLOG && out.worker) writeFileSync(RANLOG, await page.evaluate(() => window.__n64Worker.eval('JSON.stringify({ ran: self.__ranlog || {}, hist: self.__runHist || [], vlog: self.__vlog || null, jit: self.bementalMips ? { staleWhy: self.bementalMips.async.staleWhy || null, stale: self.bementalMips.async.stale, installed: self.bementalMips.async.installed, deferStaleSrc: self.bementalMips.stats.deferStaleSrc | 0 } : null, log: (self.__n64RbLog || []).slice(0, 20000), seq: (self.__fbAsync && self.__fbAsync.seq) || null })')));
  else if (RANLOG) writeFileSync(RANLOG, await page.evaluate(() => JSON.stringify({ ran: window.__ranlog || {}, seq: (window.__fbAsync && window.__fbAsync.seq) || null, calls: window.__callLog || null })));
  if (DUMPAT.length && DUMPDIR) {
    for (const k of DUMPAT) {
      const s64 = out.worker
        ? await page.evaluate((k2, src) => window.__n64Worker.eval('(function (u8) { if (!u8) return null; ' + src + ' return b64(u8); })(self.__rbDump && self.__rbDump[' + k2 + '])'), k, 'var b64 = ' + b64.toString() + ';')
        : await page.evaluate((k2, src) => { const u8 = window.__rbDump && window.__rbDump[k2]; if (!u8) return null; const f = (0, eval)('(' + src + ')'); return f(u8); }, k, b64.toString());
      if (s64) writeFileSync(DUMPDIR + '/room_' + k + '.bin', Buffer.from(s64, 'base64'));
    }
  }
  // --wdump DIR (diagnostic, core worker): every buffer a --weval hook left in self.__wdump { name: Uint8Array } -> DIR/name.bin
  if (flag('wdump', '') && out.worker) {
    const names = await page.evaluate(() => window.__n64Worker.eval('Object.keys(self.__wdump || {})'));
    for (const nm of names || []) {
      const s64 = await page.evaluate((nm2, src) => window.__n64Worker.eval('(function (u8) { if (!u8) return null; ' + src + ' return b64(u8); })(self.__wdump[' + JSON.stringify(nm2) + '])'), nm, 'var b64 = ' + b64.toString() + ';');
      if (s64) writeFileSync(flag('wdump', '') + '/' + nm + '.bin', Buffer.from(s64, 'base64'));
    }
    out.wdump = names;
  }
  // --cin: the input each held frame LAST ran with on the room's core (room_core.js RB.img) — the
  // confirmed timeline's — checked against the engine's final inputs below
  if (CIN && out.worker) {
    room.ranWith = await page.evaluate(() => window.__n64Worker.eval('self.__ranWith || null'));
    room.cinStat = await page.evaluate(() => window.__n64Worker.eval('self.__cinStat || null'));
    if (!room.ranWith || !Object.keys(room.ranWith).length)   // (no run tap: the ring's images, as before)
      room.ranWith = await page.evaluate(() => window.__n64Worker.eval('(function (R) { var o = {}; if (!R || !R.RB) return o; for (var j = 0; j < R.RB.imgF.length; j++) { var f = R.RB.imgF[j], im = R.RB.img[j]; if (f >= 0 && im) o[f] = Array.prototype.slice.call(im); } return o; })(self.RM && self.RM.R)'));
  } else if (CIN) room.cinStat = await page.evaluate(() => window.__cinStat || null);
  Object.assign(out, {
    mode: z.mode, roomRate: +((z.frame - a.frame) / secs / (z.viHz || 50)).toFixed(4),
    secsBelow99: tl.filter((x) => x.rate < 0.99).length,
    frames: z.frame - a.frame,
    rollbacksPerSec: rbZ && rbA ? +((rbZ.rollbacks - rbA.rollbacks) / secs).toFixed(2) : null,
    resimFramesPerFrame: rbZ && rbA ? +((rbZ.resimFrames - rbA.resimFrames) / Math.max(1, z.frame - a.frame)).toFixed(3) : null,
    page: rbZ, engine: z.rb && z.rb.engine, state: z.rb && z.rb.state, runahead: z.ra, advWaits: z.advWaits - a.advWaits,
    stalls: z.stalls - a.stalls, stallMs: z.stallMs - a.stallMs, reanchors: z.reanchors - a.reanchors, lostMs: (z.lostMs || 0) - (a.lostMs || 0),
    costAvgMs: z.costAvgMs, costOver: (z.costOver || 0) - (a.costOver || 0), costMaxMs: z.costMaxMs, fb: z.fb, ghosts: z.ghosts, fault: z.fault, engineState: z.engineState, error: z.error,
    latFrames: (z.lat && z.lat.samples || []).map((x) => x.frames),
    tappedFrames: Object.keys(room.full).length, confirmedTo: room.confirmed,
    ownClock: (z.eng && z.eng.ownClock) || (z.rb && z.rb.engine && z.rb.engine.ownClock) || null,
    fskip: z.fskip,     // room_core.js RFS: the room's frame skip (skipped / re-runs / lost)
    fsReruns: (room.rblog || []).filter((e) => e[0] === 'fsrerun').slice(0, 60),
  });
  // what the rollback-default decision needs, in one place (n64/docs/rollback-default/)
  const presA = a.pres, presZ = z.pres;
  out.gate = {
    modeStart: a.mode, modeEnd: z.mode, delayStart: a.eng && a.eng.delay, delayEnd: z.eng && z.eng.delay,
    gated: !!(z.eng && z.eng.mode && z.eng.mode.gated), modeHistory: z.eng && z.eng.mode ? z.eng.mode.history : [],
    need: z.eng && z.eng.mode ? z.eng.mode.need : null, engineDesync: z.eng ? z.eng.desync : null,
    lastRbPage: lastRbPage ? { rollbacks: lastRbPage.rollbacks, resimFrames: lastRbPage.resimFrames, stepMs: lastRbPage.stepMs, runMs: lastRbPage.runMs,
                              saveMs: lastRbPage.saveMs, loadMs: lastRbPage.loadMs, k: lastRbPage.k, depthAvg: lastRbPage.depthAvg, frames: lastRbPage.frames } : null,
    shownPerSec: presA && presZ ? +((presZ.shown - presA.shown) / secs).toFixed(2) : null,
    ticksPerSec: presA && presZ ? +((presZ.frames - presA.frames) / secs).toFixed(2) : null,
    presentedShare: presA && presZ && presZ.frames > presA.frames ? +((presZ.shown - presA.shown) / (presZ.frames - presA.frames)).toFixed(3) : null,
    lagMedianAll: (function () { const v = (z.lat && z.lat.samples || []).map((x) => x.frames).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; })(),
    lsetup: out.lsetup || null,
    // INPUT LAG THE ROOM ADDS, over the window: the engine's delay each second (0 in rollback —
    // the definition of room_core.js's own witness); and the seconds spent in rollback.
    lagAvg: tl.length ? +(tl.reduce((a, x) => a + (x.mode === 'rollback' ? 0 : (x.delay || 0)), 0) / tl.length).toFixed(2) : null,
    lagEnd: tl.length ? (tl[tl.length - 1].mode === 'rollback' ? 0 : tl[tl.length - 1].delay) : null,
    rollbackSecs: tl.filter((x) => x.mode === 'rollback').length + '/' + tl.length,
    step: z.step || null,
    wslow: out.worker && WSLOW > 1 ? await page.evaluate(() => window.__n64Worker.eval('self.__wslow')) : null,
  };
  out.timeline = tl;
  if (PICDUMP.length && out.worker) out.picDump = await page.evaluate(() => window.__n64Worker.eval('self.__picDump || null'));
  if (room.pics) {
    // a frame the room had not confirmed when the window closed may still have been predicted wrong
    if (out.mode === 'rollback' && typeof room.confirmed === 'number') for (const f in room.pics) if (+f > room.confirmed) delete room.pics[f];
    out.pics = { kept: Object.keys(room.pics).length };
    if (PICS) writeFileSync(PICS, JSON.stringify(room.pics));
    if (PICSREF && existsSync(PICSREF)) {
      const ref = JSON.parse(readFileSync(PICSREF, 'utf8')); let both = 0, same = 0; const diff = [];
      for (const f in room.pics) if (f in ref) { both++; if (ref[f] === room.pics[f]) same++; else if (diff.length < 12) diff.push(+f); }
      out.pics.compared = both; out.pics.same = same; out.pics.firstDiffs = diff;
    }
  }
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
    const picKeys = room.pics ? Object.keys(room.pics).map(Number).filter((f) => f <= last) : [];
    const ref = await pb.evaluate(async (padSrc, players, keys, last, cin, picKeys, dumpAt, picDumpF, regSrc) => {
      // the room's kept pictures, from the straight run (same inputs, every frame drawn)
      const picWant = new Set(picKeys), pics = {};
      let px = null;
      const picture = () => {
        const M = window.Module, gl = M.ctx, FB = window.__fbAsync, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        if (!px || px.length !== W * H * 4) px = new Uint8Array(W * H * 4);
        if (FB) FB.bypass = true;
        try {
          const rfb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), pb = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pb);
        } finally { if (FB) FB.bypass = false; }
        let h = 2166136261 >>> 0;
        for (let i = 0; i < px.length; i += 4) { h = Math.imul(h ^ px[i], 16777619); h = Math.imul(h ^ px[i + 1], 16777619); h = Math.imul(h ^ px[i + 2], 16777619); }
        return h >>> 0;
      };
      let cinMissing = 0, cinUsed = 0, cinDiffers = 0; const missAt = [], diffAt = [];
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
        for (let p = 0; p < 4; p++) {
          const sp = p < players ? window.__pad(f, p) : new Uint8Array(4);
          if (cin) {
            const row = cin[f], b = row && row[p];
            if (b) { const u = Uint8Array.from(b); cinUsed++; if (u.join() !== sp.join()) { cinDiffers++; if (diffAt.length < 40) diffAt.push([f, p]); } set(p, u); }
            else { if (p < players) { cinMissing++; if (missAt.length < 40) missAt.push([f, p]); } set(p, sp); }
          } else set(p, sp);
        }
        M._neil_ls_run_frame();
        (window.__refCalls = window.__refCalls || {})[f] = window.__fbAsync ? window.__fbAsync.calls : -1;
        // the frontend's toast, as the room side reads it (the last int of glide's host-state image):
        // a frame that may show it is not compared on either side
        let toastNow = false;
        if (picWant.size && M._neil_gl_state_size) {
          const gn = M._neil_gl_state_size(), gp = window.__gsp || (window.__gsp = M._malloc(gn));
          M._neil_gl_state_save(gp); const o = gp + gn - 4, U = M.HEAPU8;
          toastNow = (U[o] | (U[o + 1] << 8) | (U[o + 2] << 16) | (U[o + 3] << 24)) > 0;
        }
        const toastHid = toastNow || window.__toastWas; window.__toastWas = toastNow;
        if (picWant.has(f) && !toastHid) { pics[f] = picture(); if (picDumpF.indexOf(f) >= 0) { let str = ''; for (let q = 0; q < px.length; q += 0x8000) str += String.fromCharCode.apply(null, px.subarray(q, q + 0x8000)); (window.__picDumpRef = window.__picDumpRef || {})[f] = { W: window.Module.ctx.drawingBufferWidth, H: window.Module.ctx.drawingBufferHeight, b64: btoa(str) }; } }
        if (want.has(f)) {
          window.__n64State.save(buf);
          res[f] = { full: window.__n64State.hashFull(buf), fp: M._neil_last_fp() >>> 0 };
          if (regSrc) { if (!window.__regHash) window.__regHash = (0, eval)('(' + regSrc + ')'); res[f].reg = window.__regHash(buf); }
          if (dumpAt.indexOf(f) >= 0) (window.__refDump = window.__refDump || {})[f] = buf.slice();
        }
        if ((f & 63) === 0) await new Promise((r) => setTimeout(r, 0));
      }
      res.__cin = { used: cinUsed, missing: cinMissing, differsFromPad: cinDiffers, missingAt: missAt, differsAt: diffAt };
      res.__pics = pics;
      return res;
    }, PAD_SRC.replace('function __pad', 'window.__pad = function'), PLAYERS, keys, last, CIN ? room.cin : null, picKeys, DUMPDIR ? DUMPAT : [], PICDUMP, REGIONS ? REG_SRC : null);
    if (PICDUMP.length) out.picDumpRef = await pb.evaluate(() => window.__picDumpRef || null);
    if (DUMPAT.length && DUMPDIR) {
      for (const k of DUMPAT) {
        const s64 = await pb.evaluate((k2, src) => { const u8 = window.__refDump && window.__refDump[k2]; if (!u8) return null; const b64 = (0, eval)('(' + src + ')'); return b64(u8); }, k, b64.toString());
        if (s64) writeFileSync(DUMPDIR + '/ref_' + k + '.bin', Buffer.from(s64, 'base64'));
      }
    }
    if (room.pics) {
      const rp = ref.__pics; let both = 0, same = 0; const diff = [];
      for (const f in rp) { both++; if (rp[f] === room.pics[f]) same++; else if (diff.length < 12) diff.push(+f); }
      out.picsStraight = { compared: both, same, firstDiffs: diff };
    }
    delete ref.__pics;
    const cinStat = ref.__cin; delete ref.__cin;
    if (room.ranWith && room.cin) {
      // did each frame last run with its final input? (a frame that did not and was never rolled
      // back is a missed correction — this console's guest is not the room's)
      const bad = []; let checked = 0, wrongN = 0, noRow = 0;
      const lastK = keys[keys.length - 1];
      for (const f in room.ranWith) {
        if (+f > (room.confirmed | 0) || +f > lastK) continue;
        const row = room.cin[f]; if (!row) { noRow++; continue; }
        const im = room.ranWith[f]; checked++;
        for (let p = 0; p < PLAYERS; p++) { const b = row[p]; if (!b) continue; if (b.join() !== im.slice(p * 4, p * 4 + 4).join()) { wrongN++; if (bad.length < 20) bad.push([+f, p, im.slice(p * 4, p * 4 + 4), b]); } }
      }
      out.ranWithFinal = { checked, wrongN, noRow, wrong: bad, of: room.ranWith ? Object.keys(room.ranWith).length : 0 };
    }
    let firstFull = null, firstFp = null, same = 0;
    for (const k of keys) {
      const A = room.full[k], B = ref[k];
      if (!B) continue;
      if (A.full === B.full) same++;
      else if (firstFull == null) firstFull = k;
      if (A.fp !== B.fp && firstFp == null) firstFp = k;
    }
    if (REGIONS) {
      // per mismatching tapped frame (first 6): the 4 KiB chunks that differ, as byte offsets into the raw state
      out.regionDiffs = [];
      for (const k of keys) {
        const A = room.full[k], B = ref[k];
        if (!B || A.full === B.full || !A.reg || !B.reg) continue;
        const d = []; for (let c = 0; c < Math.max(A.reg.length, B.reg.length); c++) if (A.reg[c] !== B.reg[c]) d.push(c * 4096);
        out.regionDiffs.push({ frame: k, n: d.length, chunks: d.slice(0, 400) });
        if (out.regionDiffs.length >= 6) break;
      }
      for (const k of keys) { if (room.full[k]) delete room.full[k].reg; if (ref[k]) delete ref[k].reg; }
    }
    out.reference = { cin: CIN ? Object.assign({ polls: room.cinPolls, frames: room.cin ? Object.keys(room.cin).length : 0, rec: room.cinStat || null }, cinStat) : null, compared: keys.length, fullMatch: same, firstFullMismatch: firstFull, firstFpMismatch: firstFp,
      events: (room.rblog || []).filter((e) => (e[0] === 'grow') || (e[1] >= (firstFull == null ? 0 : firstFull) - 25 && e[1] <= (firstFull == null ? 0 : firstFull) + 5)).slice(0, 60),
      mismatches: keys.filter((k) => ref[k] && room.full[k].full !== ref[k].full).slice(0, 12),
      // the rollbacks that re-simulated the frames before the first mismatch (they may run later)
      rbInto: firstFull == null ? [] : (room.rblog || []).filter((e) => (e[0] === 'rb' || e[0] === 'fsrerun') && e[2] <= firstFull && e[1] >= firstFull - 10).slice(0, 40) };
    if (RANLOG) writeFileSync(RANLOG + '.ref', await pb.evaluate(() => JSON.stringify({ calls: window.__refCalls || {}, seq: (window.__fbAsync && window.__fbAsync.seq) || null })));
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
if (EXPECT === 'rollback') {
  if (out.mode !== 'rollback') bad('the room ran ROLLBACK', 'mode=' + out.mode);
  else ok('the room ran ROLLBACK (input delay 0)');
} else console.log('  INFO  mode at the end: ' + out.mode + '; ' + JSON.stringify(out.gate && { lagAvg: out.gate.lagAvg, rollbackSecs: out.gate.rollbackSecs, modeHistory: out.gate.modeHistory }));
const rbN = (out.gate && out.gate.lastRbPage) ? out.gate.lastRbPage.rollbacks : (out.page ? out.page.rollbacks : 0);
if (NOREF) console.log('  INFO  --noref: exactness not checked');
else if (!R) bad('exactness', 'no reference run (' + (out.tappedFrames || 0) + ' tapped frames)');
else if (!rbN && !LSEXACT) bad('VOID: no rollback happened, so exactness was not exercised');
// --cin: a straight run given anything but the room's own confirmed input proves nothing either way — a
// mismatch would be the rig's, and a match would be of another trajectory. So an incomplete record is
// the RIG failing, said as such, and the exactness verdict below it is withheld (neither PASS nor desync).
else if (CIN && R.cin && R.cin.missing > 0)
  bad('RIG: the straight run lacked ' + R.cin.missing + ' confirmed inputs — exactness NOT judged (VOID)', JSON.stringify({ missingAt: R.cin.missingAt, rec: R.cin.rec, firstFullMismatch: R.firstFullMismatch }));
else if (R.firstFullMismatch == null && R.fullMatch === R.compared && R.compared > 0)
  ok('every confirmed state matches a straight run BIT FOR BIT (full 16.8 MB hash)', `${R.compared} frames compared after ${rbN} rollbacks`
     + (out.fskip ? `; frame skip: ${out.fskip.skipped} presented + ${out.fskip.resimSkipped} re-sim + ${out.fskip.hiddenSkipped} hidden skipped, ${out.fskip.reruns} re-runs`
        + (out.fskip.linearFs ? `, delay frames ${out.fskip.linear} (${out.fskip.linearFs.skipped} skipped, ${out.fskip.linearFs.redo} re-runs)` : '') : ''));
else bad('confirmed state differs from the straight run', JSON.stringify(R));
if (out.ranWithFinal && out.ranWithFinal.of > 0) {
  const W = out.ranWithFinal;
  if (W.wrongN > 0) bad('every confirmed frame last ran on the room\'s core with its final input', JSON.stringify(W));
  else if (W.checked > 0) ok('every confirmed frame last ran on the room\'s core with its final input', W.checked + ' frames');
}
if (out.engineState === 'desync' || out.engineState === 'failed' || out.fault) bad('engine state', out.engineState + ' ' + (out.fault || out.error || ''));
if (out.picsStraight) {
  const P = out.picsStraight;
  if (!(P.compared > 0)) bad('pictures vs the straight run', 'nothing compared');
  else if (P.same === P.compared) ok('every kept picture matches the straight run (same inputs, every frame drawn)', `${P.compared} frames`);
  else bad('pictures differ from the straight run', JSON.stringify(P));
}
if (PICSREF) {
  const P = out.pics;
  if (!P || !(P.compared > 0)) bad('pictures', 'nothing compared ' + JSON.stringify(P));
  else if (P.same === P.compared) ok('every drawn picture that stayed true matches the reference run', `${P.compared} frames compared (${P.kept} kept here)`);
  else bad('pictures differ from the reference run', JSON.stringify(P));
}
// NEVER PAST ITS OWN WALL CLOCK (lib/netplay.js ownClock: frames begun since the console's first
// frame attempt minus wall frames elapsed at its frameHz) — the page's engine and every ghost's.
{
  const oc = [['page', out.ownClock]].concat((out.ghosts || []).map((g) => [g.id, g.rb && g.rb.ownClock]));
  const have = oc.filter((x) => x[1]);
  const txt = oc.map(([w, o]) => `${w} ${o ? `${o.lead} (max ${o.leadMax}) rate ${o.rate} catch-up ${o.granted}/refused ${o.refused}` : 'n/a'}`).join(' · ');
  if (!have.length) console.log('  INFO  own wall clock: not reported (' + txt + ')');
  else if (have.every(([, o]) => o.lead < 2 && o.leadMax < 2)) ok('never past its own wall clock', txt);
  else bad('never past its own wall clock', txt);
}
console.log(JSON.stringify(Object.assign({}, out, { timeline: undefined, log: undefined })));
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
console.log(`\n[n64-rollback] ${pass} passed, ${fail} failed`);
await browser.close().catch(() => {});
process.exit(fail ? 1 : 0);

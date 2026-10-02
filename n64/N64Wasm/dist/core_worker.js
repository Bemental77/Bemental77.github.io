// core_worker.js — the N64 core (mupen64plus + glide2gl, n64wasm.{js,wasm}) hosted
// in a dedicated Worker, drawing into the page's canvas through an OffscreenCanvas.
//
// WHY. On the main thread every emulated frame is one task: on a phone at 4x CPU
// the audit measured 865 ms of every second inside long tasks and rAF at 11.7/s,
// so the page could not even receive a touch or a key until the frame ended. Here
// the core owns a thread of its own: the page keeps UI, input and the audio
// graph, and the only things that cross the boundary are small messages (a pad
// image when an input changes, a few counters ten times a second, audio chunks
// that go STRAIGHT to the AudioWorklet over a MessagePort and never touch the
// page's thread). See n64/docs/worker/README.md for the plan and measurements.
//
// THE SAME BINARY. Nothing here needs a different build: n64wasm.js/.wasm are the
// exact files the main-thread page loads. The core's SDL2 port expects a DOM, so
// four tiny shims stand in for the pieces it touches during init (`screen`,
// `document` as an EventTarget, canvas.style, canvas.getBoundingClientRect); all
// of them are inert — no event ever arrives on them, which is right, because
// input does not come from SDL in this mode (see THE FRAME CLOCK).
//
// THE FRAME CLOCK. The worker arms the core's frame gate (neil_ls_arm(1)) before
// main() runs, exactly as a lockstep room does, and from then on advances the
// guest only with neil_ls_run_frame() — one VI field per call, with the pad image
// the page posted (neil_ls_set_pad, all four ports). That is the deterministic
// path every rollback/lockstep rig already proves exact, and it means the
// worker, not SDL's DOM event plumbing, decides what input a frame sees. The
// schedule is the room's 1.000x governor (lsDueNow in n64/index.html): a frame
// runs when its wall-clock slot has arrived, debt older than two field periods
// is discarded rather than sprinted back (CLAUDE.md gate #9 — never faster than
// the hardware), and the field rate comes from the ROM header, never a default.
//
// Message protocol (page -> worker):
//   {t:'boot', canvas, rom, files, romName, viHz, search, jit, rig}
//   {t:'pad', p: Int32Array(12)}   [mask, axis0, axis1] x 4 ports, core units
//   {t:'audioPort', port}          the AudioWorklet's MessagePort (direct feed)
//   {t:'reset'} {t:'saveState'} {t:'loadState'} {t:'pause', on}
//   {t:'eval', id, src}            rig seam, ONLY with boot.rig (?workerrig=1)
// worker -> page:
//   {t:'log'|'print'|'err'|'toast', s}  {t:'stat', ...}  {t:'evalr', id, v|e}
'use strict';

var CORE_V = '';                  // cache-buster for importScripts, set from boot
var BOOT = null;
var M = null;                     // the emscripten Module once it exists
var PADS = new Int32Array(12);    // latest pad image from the page
var paused = false;

function post(m, tr) { try { postMessage(m, tr || []); } catch (e) {} }
function log(s) { post({ t: 'log', s: String(s) }); }
self.addEventListener('error', function (e) { post({ t: 'err', s: String((e && e.message) || e) }); });
self.addEventListener('unhandledrejection', function (e) { post({ t: 'err', s: 'unhandled rejection: ' + String(e && e.reason && (e.reason.stack || e.reason)) }); });

// ---- DOM shims (installed BEFORE n64wasm.js is evaluated) ------------------------------
// Each one is the minimum the core's init path was measured to touch in a worker
// (feasibility run, 2026-10-01): emscripten_get_screen_size reads `screen`; SDL's
// window setup sets canvas.style.cursor and asks for the element's CSS size; SDL's
// event setup registers listeners on `document`. `window` is deliberately NOT
// defined here: emscripten decides ENVIRONMENT_IS_WEB from `typeof window` when the
// script loads, and this must load as a worker.
function installShims(canvas) {
  self.screen = { width: canvas.width, height: canvas.height, availWidth: canvas.width, availHeight: canvas.height };
  if (!canvas.style) canvas.style = {};
  canvas.getBoundingClientRect = function () {
    return { left: 0, top: 0, x: 0, y: 0, right: canvas.width, bottom: canvas.height, width: canvas.width, height: canvas.height };
  };
  var doc = new EventTarget();
  doc.querySelector = function (q) { return (q === '#canvas' || q === 'canvas') ? canvas : null; };
  doc.getElementById = function (id) { return id === 'canvas' ? canvas : null; };
  doc.body = new EventTarget(); doc.documentElement = doc.body;
  doc.hidden = false; doc.visibilityState = 'visible'; doc.title = '';
  self.document = doc;
}

// ---- IndexedDB: the SAME database, store and keys dist/script.js uses ------------------
// (DB 'N64WASMDB', store 'N64WASMSTATES', key = rom name for the savestate and
// rom name + '.sram' for cartridge save memory), so a save made on either path is
// found by the other, and the page's Export/Import keep working unchanged.
function idb() {
  return new Promise(function (res, rej) {
    var q = indexedDB.open('N64WASMDB');
    q.onupgradeneeded = function (e) { var db = e.target.result; if (!db.objectStoreNames.contains('N64WASMSTATES')) db.createObjectStore('N64WASMSTATES', { autoIncrement: true }); };
    q.onsuccess = function (e) { res(e.target.result); };
    q.onerror = function () { rej(q.error); };
  });
}
function idbPut(k, v) { return idb().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('N64WASMSTATES', 'readwrite').objectStore('N64WASMSTATES').put(v, k); t.onsuccess = function () { res(); }; t.onerror = function () { rej(t.error); }; }); }); }
function idbGet(k) { return idb().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('N64WASMSTATES', 'readonly').objectStore('N64WASMSTATES').get(k); t.onsuccess = function () { res(t.result); }; t.onerror = function () { rej(t.error); }; }); }); }

function saveSram() {
  try {
    var data = M.FS.readFile('/game.savememory');
    idbPut(BOOT.romName + '.sram', data).then(function () { log('[worker] cartridge save memory stored (' + data.length + ' B)'); },
      function (e) { log('[worker] ⚠ save memory NOT stored: ' + e); });
  } catch (e) { log('[worker] ⚠ save memory read failed: ' + e); }
}

// ---- what the core's EM_ASM blocks call (they name the global `myApp`) ------------------
self.myApp = {
  rivetsData: { inputController: { updateMobileControls: function () {} } },  // pads arrive via neil_ls_set_pad
  localCallback: function () {},
  loadCloud: function () {}, saveCloud: function () {}, fullscreen: function () {},
  // neil_serialize -> savestates_save_m64p -> gzip to /savestate.gz -> here (libretronew.c)
  SaveStateEvent: function () {
    try {
      var bytes = M.FS.readFile('/savestate.gz');
      idbPut(BOOT.romName, bytes).then(function () { post({ t: 'toast', s: 'State saved' }); },
        function (e) { post({ t: 'toast', s: 'State NOT saved: ' + e, bad: true }); });
    } catch (e) { post({ t: 'toast', s: 'State NOT saved: ' + e, bad: true }); }
  },
  ExportEepEvent: function () {}, ExportSraEvent: function () {}, ExportFlaEvent: function () {}
};

// ---- the JIT bridge (recomp.c up-call), 'emit' mode — the shipped default ---------------
function setupJit(mode) {
  if (mode === 'off') { log('[jit] disabled by query flag'); return; }
  if (!M.addFunction || !M._neil_set_jit_bridge || !M.wasmTable) { log('[jit] bridge unavailable in this core build'); return; }
  importScripts('/n64/bementalJIT/mips_emit.js?v=' + Date.now());   // as the page does: the emitter moves independently
  var wrapped = 0;
  self.myApp.jitCompile = function (paramsPtr) {
    var p = self.__n64JitParams(M, paramsPtr);
    // For rollback's code-preserving load (room_core.js n64sCodeKeep), as the page records it.
    if (!self.__n64CorePtrs && p.invalidCode && p.dramBase) self.__n64CorePtrs = { invalidCode: p.invalidCode, dramBase: p.dramBase };
    var idx = self.bementalMips ? self.bementalMips.compileSpan(p, M) : 0;
    if (idx > 0) wrapped++;
    return idx;
  };
  self.__jitStats = function () {
    var e = self.bementalMips ? self.bementalMips.stats : {};
    return { mode: 'emit', wrapped: wrapped, blocks: e.blocks, fallbackOps: e.fallbackOps, emitFails: e.fails };
  };
  M._neil_set_jit_bridge(1);
  log('[jit] bridge enabled (emit) — in the core worker');
}

// ---- audio: the core's resampled ring -> the AudioWorklet, directly ----------------------
var AUD = { port: null, ring: null, read: 0, sent: 0, dropped: 0 };
function audioPump() {
  if (!M || !M._neilGetAudioWritePosition) return;
  var write = M._neilGetAudioWritePosition();
  if (!AUD.ring || AUD.ring.buffer !== M.HEAP16.buffer) AUD.ring = new Int16Array(M.HEAP16.buffer, M._neilGetSoundBufferResampledAddress(), 64000);
  var read = AUD.read;
  if (write === read) return;
  var count = (write - read + 64000) % 64000;
  AUD.read = write;
  if (!AUD.port) { AUD.dropped += count; return; }       // no device yet: nothing queued, nothing late
  var out = new Int16Array(count);
  if (read + count <= 64000) out.set(AUD.ring.subarray(read, read + count));
  else { var first = 64000 - read; out.set(AUD.ring.subarray(read, 64000)); out.set(AUD.ring.subarray(0, count - first), first); }
  AUD.port.postMessage({ s: out }, [out.buffer]);
  AUD.sent += count;
}

// ---- THE FRAME CLOCK (see the header) --------------------------------------------------
var CLK = { viHz: 0, base: 0, baseFrame: 0, frame: 0, lostMs: 0, reanchors: 0, presents: 0, ticks: 0, busyMs: 0 };
function applyPads() {
  for (var p = 0; p < 4; p++) M._neil_ls_set_pad(p, PADS[p * 3], PADS[p * 3 + 1], -PADS[p * 3 + 2]);
}
function runOneFrame() {
  applyPads();
  M._neil_ls_run_frame();
  CLK.frame++;
  audioPump();
}
function due(now) {
  if (!(CLK.viHz > 0)) return true;
  var period = 1000 / CLK.viHz;
  if (!CLK.base) { CLK.base = now; CLK.baseFrame = CLK.frame; return true; }
  var d = CLK.base + (CLK.frame - CLK.baseFrame) * period;
  if (now < d) return false;
  // TIME LOST IS NEVER REPAID (gate #9): debt older than two periods is discarded.
  if (now - d > period * 2) { CLK.lostMs += now - d; CLK.base = now; CLK.baseFrame = CLK.frame; CLK.reanchors++; }
  return true;
}
// THE DRIVER. ONE FIELD PER TASK, NEVER A BATCH. An OffscreenCanvas from
// transferControlToOffscreen commits what the context holds when this thread
// next updates its rendering — at most once per task, and in practice on the
// worker's own animation frame — so a task that ran FOUR fields put ONE picture
// on the screen and three were drawn and overwritten unseen. MEASURED on a real
// phone (Android Chrome, Mali-G715, MK64, a field costing 20.4 ms against a
// 20 ms PAL period, so a field was always already due when the last one ended):
// 45 fields/s ran and the meter read "12 shown" — a tick of ~4 fields, the old
// cap. Mario Kart draws a new picture on every second field, so most of its 23
// pictures a second never reached the display.
// So a tick runs AT MOST ONE field and, when the next one is already due, queues
// the next tick as an immediate task (a MessageChannel message, not a loop), so
// every field's picture gets its own commit and the page's pad messages still
// land between fields. When the clock is on time the tick comes from the
// worker's rAF or the field's own timer slot, whichever is first: rAF alone
// ran at ~30/s here under load and capped a 50 Hz guest at ~0.58x, and the slot
// timer alone would lose vsync. `due` is the only gate on running a field, so
// nothing here can run the guest ahead of its schedule (gate #9).
// ?pace=0 — THE CONTROL ARM (the page's own ?pace=0 is the same switch): fields
// run only inside the worker's animation-frame callback, one per frame, i.e. the
// rAF-coupled loop, so VI fields per second can never exceed animation frames.
var hasRaf = (typeof self.requestAnimationFrame === 'function');
var SCHED = { raf: false, imm: false, tmr: false, chan: null, rafTicks: 0, immTicks: 0, tmrTicks: 0,
              paced: 0, notOwed: 0, coupled: false };
function dueNow(now) {
  if (!(CLK.viHz > 0) || !CLK.base) return true;
  return now >= CLK.base + (CLK.frame - CLK.baseFrame) * (1000 / CLK.viHz);
}
function tick(src) {
  if (src === 'raf') { SCHED.raf = false; SCHED.rafTicks++; }
  else if (src === 'imm') { SCHED.imm = false; SCHED.immTicks++; }
  else if (src === 'tmr') { SCHED.tmr = false; SCHED.tmrTicks++; }
  if (!paused) {
    CLK.ticks++;
    if ((!SCHED.coupled || src === 'raf') && due(performance.now())) {
      var t0 = performance.now();
      runOneFrame();
      CLK.presents++; CLK.busyMs += performance.now() - t0;
      // A field the rAF-coupled loop would not have produced: the analog of the
      // main-thread pace governor's catch-up run (the meter's `paced`).
      if (src !== 'raf') SCHED.paced++;
      // Counters ride on the frames themselves when fields are being made, so a long field
      // cannot starve the page's meter (its audio integrator drops any interval > 1 s).
      if (performance.now() - STAT.last >= 50) postStats();
    } else SCHED.notOwed++;
  } else CLK.base = 0;     // resume re-anchors: a pause is not debt
  schedule();
}
function schedule() {
  if (paused) return;
  if (!SCHED.coupled && dueNow(performance.now())) {
    if (!SCHED.imm) {
      if (!SCHED.chan) { SCHED.chan = new MessageChannel(); SCHED.chan.port1.onmessage = function () { tick('imm'); }; }
      SCHED.imm = true; SCHED.chan.port2.postMessage(0);
    }
    return;
  }
  // Not due yet: whichever comes first, the next animation frame or the field's own
  // slot. rAF alone is not enough — a worker's rAF is the compositor's cadence, and
  // measured here it ran at ~30/s under load, which capped a 50 Hz guest at ~0.58x
  // with the thread idle half the time; the slot timer alone would lose vsync.
  if (hasRaf && !SCHED.raf) { SCHED.raf = true; self.requestAnimationFrame(function () { tick('raf'); }); }
  if (!SCHED.tmr && !(SCHED.coupled && hasRaf)) {
    var wait = 8;
    if (CLK.viHz > 0 && CLK.base) wait = Math.max(0, CLK.base + (CLK.frame - CLK.baseFrame) * (1000 / CLK.viHz) - performance.now());
    SCHED.tmr = true; setTimeout(function () { tick('tmr'); }, wait);
  }
}

// ---- WHAT REACHED THE SCREEN ------------------------------------------------------------
// The page's `shown` is "animation frames in which a NEW FIELD was drawn" (its
// observePresents), never callbacks or refreshes. Here the pictures are committed by
// THIS thread, so the same count is taken on this thread's own animation frames: one
// loop of its own, re-registered FIRST, counting the frames in which the core's field
// counter moved since the previous one. Two fields between two frames count once —
// only the second was ever on screen.
var PRES = { shown: 0, frames: 0, lastVi: -1, on: false };
function observePresents() {
  if (PRES.on || !hasRaf) return;
  PRES.on = true;
  (function obs() {
    self.requestAnimationFrame(obs);
    PRES.frames++;
    if (!M || !M._neil_vi_total) return;
    var vi = M._neil_vi_total() >>> 0;
    if (PRES.lastVi >= 0 && vi !== PRES.lastVi) PRES.shown++;
    PRES.lastVi = vi;
  })();
}

// ---- THE GAME'S OWN FRAME RATE (the meter's "made") ---------------------------------------
// limitFPS() (mymain.cpp) writes "FPS: %d GameFPS: %d" into the static `fps_text` buffer once
// per wall second; the page finds it by scanning the heap for the FORMATTED text (n64/index.html
// scanForFpsTextStep) and cannot here — the heap is in this realm. Same scan, same digit rule
// (the rodata format string is in the heap too and is reached first), in 1 MB slices of at most
// 4 ms, one slice per 20 ms, so it never holds this thread for more than a sliver of a field.
var FPSX = { at: 0, pos: 0, busy: false, dec: null, miss: 0, lastScan: 0, text: null };
function fpsScanStep() {
  var H = M.HEAPU8, CH = 1 << 20, RE = /^FPS: \d+ GameFPS: \d+/, t0 = performance.now();
  var dec = FPSX.dec || (FPSX.dec = new TextDecoder('latin1'));
  while (FPSX.pos < H.length) {
    var base = FPSX.pos, s = dec.decode(H.subarray(base, Math.min(base + CH + 64, H.length))), i = -1;
    while ((i = s.indexOf('FPS: ', i + 1)) !== -1) if (RE.test(s.slice(i, i + 40))) { FPSX.pos = 0; return base + i; }
    FPSX.pos += CH;
    if (performance.now() - t0 > 4) return -1;
  }
  FPSX.pos = 0;
  return 0;
}
function fpsScanRun() {
  if (FPSX.busy || !M || !M.HEAPU8) return;
  FPSX.busy = true;
  (function step() {
    var r = 0;
    try { r = fpsScanStep(); } catch (e) { r = 0; }
    if (r === -1) { setTimeout(step, 20); return; }
    FPSX.busy = false;
    if (r > 0) { FPSX.at = r; log('[rate] core frame counters found at heap 0x' + r.toString(16) + ' (core worker)'); }
  })();
}
function fpsText() {
  if (!M || !M.HEAPU8) return null;
  if (!FPSX.at) {
    var now = performance.now();
    if (!FPSX.busy && now - FPSX.lastScan >= 4000) { FPSX.lastScan = now; fpsScanRun(); }
    return null;
  }
  var H = M.HEAPU8, e = FPSX.at;
  while (e < FPSX.at + 48 && H[e] !== 0) e++;
  var t = String.fromCharCode.apply(null, H.subarray(FPSX.at, e));
  // The buffer could move across a different core build; re-scan rather than report stale.
  if (!/^FPS: \d+ GameFPS: \d+/.test(t)) { if (++FPSX.miss > 5) { FPSX.at = 0; FPSX.miss = 0; } return null; }
  FPSX.miss = 0;
  return t;
}

var STAT = { last: 0 };
function postStats() {
  if (!M || !M._neil_vi_total) return;
  STAT.last = performance.now();
  var js = self.__jitStats ? self.__jitStats() : null;
  var owed = 0;
  if (CLK.viHz > 0 && CLK.base) owed = (STAT.last - (CLK.base + (CLK.frame - CLK.baseFrame) * (1000 / CLK.viHz))) / (1000 / CLK.viHz);
  post({ t: 'stat', at: performance.timeOrigin + performance.now(),
         vi: M._neil_vi_total() >>> 0, costMs: M._neil_frame_cost_ms(), costN: M._neil_frame_cost_n() >>> 0,
         apos: M._neilGetAudioWritePosition() | 0, audDropped: RM.R ? (RM.R.AUDX.dropped | 0) : 0,
         frame: CLK.frame, presents: CLK.presents, ticks: CLK.ticks,
         lostMs: CLK.lostMs, reanchors: CLK.reanchors, busyMs: CLK.busyMs,
         rafTicks: SCHED.rafTicks, immTicks: SCHED.immTicks, tmrTicks: SCHED.tmrTicks,
         paced: SCHED.paced, notOwed: SCHED.notOwed, coupled: SCHED.coupled, owed: Math.max(-2, Math.min(2, owed)),
         shown: PRES.shown, animFrames: PRES.frames, fpsText: fpsText(),
         audioSent: AUD.sent, audioDropped: AUD.dropped,
         jitBlocks: js ? js.blocks : null,
         fb: self.__fbAsync ? { on: !!self.__fbAsync.on, calls: self.__fbAsync.calls, async: self.__fbAsync.async,
                                sync: self.__fbAsync.sync, blocked: self.__fbAsync.blocked, decided: self.__fbAsync.decided } : null });
}

// ---- ROOMS: the room driver and the lockstep engine, IN THIS WORKER ----------------------
// (n64/docs/worker/README.md, "Rooms".) The page keeps the room's transport — the
// RTCDataChannel and the signalling, which a worker cannot own — and relays the engine's
// traffic with ONE postMessage each way: every message the page's Session would have handed
// the engine ('lsin', in arrival order) and every call it would have made on it ('lscall',
// 'lsset', in program order) arrive here through one ordered port, so the engine sees the
// same messages in the same order; everything the engine sends ('lso') and emits ('lsev')
// goes back the same way, in order. Next to the engine runs room_core.js — the page's own
// room driver, one implementation for both realms — and it drives this core synchronously,
// exactly as it drives the main-thread core with ?worker=0.
// The page mirrors what its Session and its panel read synchronously (roster, state, seats,
// the report): 'lsm', small and frequent; nothing on the page can step the engine or the core.
var RM = { on: false, role: null, eng: null, R: null, pads: null, rtt: 0, chan: null, kicked: false,
           drivers: false, mirT: 0, pubT: 0, search: '' };
var ZERO4 = new Uint8Array(4);
function roomInstall(d) {
  if (RM.R) return RM.R;
  RM.search = d.search || '';
  CORE_V = d.v || CORE_V;
  // fbasync first, then the room core: the same order the page installs them in, so the
  // GLSKIP readPixels wrapper sits OUTSIDE fbasync's, as on the main thread.
  importScripts('fbasync.js?v=' + CORE_V, 'jit_params.js?v=' + CORE_V, 'room_core.js?v=' + CORE_V);
  self.__n64InstallFbAsync(self, RM.search);
  RM.R = self.__n64InstallRoomCore(self, {
    search: RM.search,
    log: log,
    ringBudgetMB: d.ringBudgetMB > 0 ? d.ringBudgetMB : 200,
    engine: function () { return RM.eng; },
    inRoom: function () { return RM.on; },
    isHost: function () { return RM.role === 'host'; },
    packLocal: function (k) { return (RM.pads && RM.pads[k]) || ZERO4; },
    audioPump: function () { audioPump(); },
    audioReadPos: function () { return M ? AUD.read : null; },
    audioDrop: function () { if (M && M._neilGetAudioWritePosition) AUD.read = M._neilGetAudioWritePosition(); },
    canvas: function () { return BOOT && BOOT.canvas; },
    slotCanvas: function () { return BOOT && BOOT.canvas; },
    onArmGl: roomWatchContext,
    onArmKeys: function () {},
    oneFramePerTask: true,
    kick: roomKick
  });
  return RM.R;
}
// Every clonable field the page's Session and panel read off `session.ls` synchronously.
function roomLite(ls) {
  return { state: ls.state, frame: ls.frame, roster: ls.roster.slice(), localPorts: ls.localPorts.slice(), delay: ls.delay,
           rollback: ls.rollback, _rbAdaptive: ls._rbAdaptive, rosterAt: ls.rosterAt, peerId: ls.peerId, isHost: ls.isHost,
           portCount: ls.portCount, padBytes: ls.padBytes, lobby: new Map(Array.from(ls.lobby.keys()).map(function (k) { return [k, true]; })),
           dropped: new Map(ls.dropped), _bar: ls._bar || null, error: ls.error, desync: ls.desync, hashEvery: ls.hashEvery,
           _rbConfirmed: ls._rbConfirmed, roomGame: ls.roomGame, rbMaxWindow: ls.rbMaxWindow, rbCapable: ls.rbCapable,
           rbHintMs: ls.rbHintMs, netFloorDelay: ls.netFloorDelay, rttDelay: ls.rttDelay, rosterEvicted: ls.rosterEvicted, lastAgreedFrame: ls.lastAgreedFrame,
           _hostId: ls._hostId };
}
function clonable(x) { try { return JSON.parse(JSON.stringify(x)); } catch (e) { return null; } }
function roomPost(m) { try { postMessage(m); } catch (e) { if (m.a !== undefined) m.a = clonable(m.a); if (m.net) m.net = clonable(m.net); try { postMessage(m); } catch (e2) {} } }
function roomMirror(full) {
  var ls = RM.eng; if (!ls) return;
  var m = { t: 'lsm', lite: roomLite(ls) };
  if (full && RM.R) {
    RM.mirT = performance.now();
    var L = RM.R.LS, c = {};
    for (var k in L) if (k !== 'paceHist') c[k] = L[k];
    m.LS = c;
    m.net = RM.R.netReport();
    m.rb = { proven: RM.R.LS_RB.proven, why: RM.R.LS_RB.why };
  }
  roomPost(m);
}
function roomNew(d) {
  if (RM.eng) { log('[lockstep] ⚠ a second engine was asked for — ignored'); return; }
  roomInstall(d);
  if (!self.Netplay) importScripts(d.npSrc || ('/lib/netplay.js?v=' + CORE_V));
  RM.on = true; RM.role = d.role || null;
  var o = d.opts || {};
  o.send = function (m) { roomPost({ t: 'lso', m: m }); };
  var ls = RM.eng = new self.Netplay.Lockstep(o);
  // TEST-ONLY (?rbgate=0, a rig's attached engine only): exactly the page's __n64LsAttach patch.
  if (d.rbgate0 && typeof ls._lobbySet === 'function') {
    var lobbySet = ls._lobbySet;
    ls._lobbySet = function (p, dd, cu, rb, wr, x) { return lobbySet.call(this, p, dd, cu, rb, wr, Object.assign({}, x || {}, { ms: false })); };
    log('[rollback] ?rbgate=0: capacity gating disabled for this rig room');
  }
  // Every event the engine emits is the page's: its Session forwards them to the page's
  // handlers. Each carries the engine's fields as of the event, so a handler that reads
  // `ls.state` reads the state the event was emitted in.
  var emit = ls._emit;
  ls._emit = function (ev, a) {
    var r = emit.call(this, ev, a);
    roomPost({ t: 'lsev', ev: ev, a: a, lite: roomLite(ls) });
    return r;
  };
  log('[lockstep] engine created in the core worker (' + (o.host ? 'host' : 'guest') + ', rollback ' + (o.rollback | 0) + ')');
  roomMirror(true);
}
function roomIn(d) {
  var ls = RM.eng; if (!ls) return;
  try { ls.receive(d.m); } catch (e) { log('[lockstep] receive threw: ' + ((e && e.message) || e)); }
  // THE HOST'S RELAY, decided here because the limp spans live here (Session._onRoomMsg:
  // forward what Lockstep.filterRelay keeps, to every other guest).
  if (d.rel) { var fwd = null; try { fwd = ls.filterRelay(d.m); } catch (e) { fwd = d.m; } roomPost({ t: 'lsrelay', k: d.k, m: fwd }); }
  // ⚠ KICK THE FEED WHEN AN INPUT ACTUALLY LANDS (the page's watchLockstep receive wrap).
  if (d.m && d.m.t === 'ls' && RM.R && RM.R.LS.armed && RM.R.lsDriveOk('timer')) { try { RM.R.lsFeed(); } catch (e) {} }
  roomMirror(performance.now() - RM.mirT > 100);
}
function roomCall(d) {
  var ls = RM.eng; if (!ls || typeof ls[d.fn] !== 'function') { log('[lockstep] ⚠ no engine method ' + d.fn); return; }
  try { ls[d.fn].apply(ls, d.args || []); } catch (e) { log('[lockstep] ' + d.fn + ' threw: ' + ((e && e.message) || e)); }
  roomMirror(true);
}
function roomSet(d) {
  if (d.k === 'rttMs') { RM.rtt = d.v; }
  else if (d.k === 'role') { RM.role = d.v; }
  else if (RM.eng) RM.eng[d.k] = d.v;
  roomMirror(false);
}
// One presented frame per task (room_core.js env.oneFramePerTask): the next feed is queued
// as an immediate task, so this frame's picture is committed before the next one is drawn.
function roomKick() {
  if (RM.kicked) return;
  if (!RM.chan) { RM.chan = new MessageChannel(); RM.chan.port1.onmessage = function () { RM.kicked = false; roomFeed('imm'); }; }
  RM.kicked = true; RM.chan.port2.postMessage(0);
}
function roomFeed(src) {
  var R = RM.R; if (!R || !R.LS.armed || !R.lsDriveOk(src === 'raf' ? 'raf' : 'timer')) return;
  var f0 = R.LS.frame;
  try { R.lsFeed(); } catch (e) { log('[lockstep] feed threw: ' + ((e && e.stack) || e)); }
  if (R.LS.frame !== f0) CLK.frame = R.LS.frame;
  var now = performance.now();
  if (now - RM.mirT > 100) roomMirror(true);
  if (now - RM.pubT > 400) { RM.pubT = now; if (R.LS.running) R.publishSelf(RM.rtt); }
}
// THE ROOM'S DRIVERS, as on the page (wireNetplay's rAF tick and lsArmFeedTimer's 4 ms
// timer): rAF so a quiet room still advances and sends its input, the timer because rAF
// stops when nothing is shown. lsDueNow() is the only thing that decides a frame runs.
function roomDrivers() {
  if (RM.drivers) return;
  RM.drivers = true;
  if (hasRaf) (function raf() { self.requestAnimationFrame(raf); roomFeed('raf'); })();
  setInterval(function () { roomFeed('tmr'); }, 4);
  setInterval(function () { if (RM.eng) roomMirror(true); }, 100);
}
function roomMainRan() {
  var R = RM.R;
  // main() has returned on a gated core: the same point the page's callMain wrapper marks
  // (declareWhenMainReturns). The rollback path is proven HERE, before the page declares.
  try { R.lsRbProve(); } catch (e) { R.lsRbRefuse('the savestate check threw: ' + ((e && e.message) || e)); }
  log('[lockstep] main() has run — the core is booted and gated in the core worker; declaring now');
  roomDrivers();
  roomMirror(true);
  post({ t: 'mainRan', proven: R.LS_RB.proven, why: R.LS_RB.why });
}
// Leaving the room hands the console back, as on the page — but here "free-run" is this
// worker's own frame clock (the gate stays armed; the solo driver steps it with the page's
// pad image), never the core's SDL loop, which has no input in a worker.
function roomDisarm(why) {
  var R = RM.R;
  RM.on = false;
  if (R && R.LS.armed) {
    R.lsDisarm(why);
    if (M && M._neil_ls_arm) M._neil_ls_arm(1);
    CLK.base = 0;
    if (!BOOT || !BOOT.rig) schedule();
  }
  roomMirror(true);
}
function roomWatchContext() {
  var c = BOOT && BOOT.canvas;
  if (!c || c.__lsGlWatch || typeof c.addEventListener !== 'function') return;
  c.__lsGlWatch = true;
  c.addEventListener('webglcontextlost', function () { if (RM.R) RM.R.LS_GL.lost = true; post({ t: 'gllost' }); });
  c.addEventListener('webglcontextrestored', function () { if (RM.R) RM.R.LS_GL.restored = true; post({ t: 'glrestored' }); });
}

// ---- boot --------------------------------------------------------------------------------
function boot(d) {
  BOOT = d;
  CORE_V = d.v || '';
  CLK.viHz = d.viHz > 0 ? d.viHz : 0;
  // BOOT PREFLIGHT, so a browser that cannot do this fails HERE — before the 512 MB heap,
  // the ROM and assets.zip — and the page falls back to the main-thread core (n64/index.html
  // wkFallback). WebGL2 in a worker is the one requirement the page cannot test for itself
  // from its own thread: a separate 1x1 OffscreenCanvas is asked for a context and given it
  // back at once (the core's own canvas is never touched, so its context attributes are the
  // core's). ?workerfail=boot|main is a rig seam that simulates a failure at either point.
  if (d.workerfail === 'boot') { post({ t: 'err', s: 'boot: ?workerfail=boot — a simulated boot failure (rig seam)', fatal: true, boot: true }); return; }
  try {
    var probe = (typeof OffscreenCanvas === 'function') ? new OffscreenCanvas(1, 1).getContext('webgl2') : null;
    if (!probe) { post({ t: 'err', s: 'boot: WebGL2 is not available inside a worker on this browser (OffscreenCanvas getContext("webgl2") returned null)', fatal: true, boot: true }); return; }
    var lose = probe.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
  } catch (e) { post({ t: 'err', s: 'boot: WebGL2 in a worker threw: ' + ((e && e.message) || e), fatal: true, boot: true }); return; }
  installShims(d.canvas);
  importScripts('fbasync.js?v=' + CORE_V, 'jit_params.js?v=' + CORE_V);
  // The SAME readback implementation as the page (fbasync.js), decided from the
  // SAME ROM header with the SAME query string, so this console hands RDRAM the
  // same bytes at the same guest point as a main-thread one would.
  self.__n64InstallFbAsync(self, d.search || '');
  var rom = new Uint8Array(d.rom);
  try {
    self.__fbDecide(rom);
    log('[fb] ' + (self.__fbAsync.romName || '?') + ': readback ' + (self.__fbAsync.on ? 'ASYNC' : 'sync') + ' — ' + self.__fbAsync.decided + ' (core worker)');
  } catch (e) { log('[fb] readback decision failed: ' + e); }
  fetch('assets.zip').then(function (r) {
    if (!r.ok) throw new Error('assets.zip HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (assets) {
    self.Module = {
      canvas: d.canvas,
      print: function (s) {
        // The room's raw savestate calls (rollback, run-ahead) print from the core; the page
        // silences them the same way (N64S.quiet in its processPrintStatement).
        if (RM.R && RM.R.N64S.quiet) return;
        post({ t: 'print', s: String(s) });
        // dist/script.js does this on the main thread: the core announces every
        // write of its save memory, and the bytes go to IndexedDB shortly after.
        if (String(s).indexOf('writing game.savememory') !== -1) setTimeout(saveSram, 100);
      },
      printErr: function (s) { post({ t: 'log', s: '[core-err] ' + s }); },
      onAbort: function (what) { post({ t: 'err', s: 'core abort: ' + what, fatal: true }); },
      onRuntimeInitialized: function () {
        M = self.Module;
        try {
          M.FS.writeFile('assets.zip', new Uint8Array(assets));
          var files = d.files || {};
          for (var name in files) M.FS.writeFile(name, files[name]);
          M.FS.writeFile('custom.v64', rom);
          // THE FRAME GATE, before main(): see THE FRAME CLOCK in the header. In a room the
          // room driver arms it (room_core.js lsArmBeforeBoot: the gate, every-frame
          // fingerprints, the latched start frame) — the same call, at the same point, as
          // the page's myApp.beforeRun does on the main thread.
          var roomArmed = false;
          if (d.room && RM.R) {
            RM.R.LS.viHz = CLK.viHz;
            try { roomArmed = !!RM.R.lsArmBeforeBoot(); } catch (e) { log('[lockstep] arm threw: ' + ((e && e.message) || e)); }
          }
          if (!roomArmed) M._neil_ls_arm(1);
          var fbn = new URLSearchParams(d.search || '').get('fbnative');
          if (fbn != null && typeof M._neil_set_native_fbread === 'function') M._neil_set_native_fbread(fbn === '0' ? 0 : 1);
          // `window` is defined only now, after the runtime decided it is a worker:
          // the JIT up-call (recomp.c) and the emitter both spell it `window.`.
          self.window = self;
          try { setupJit(d.jit || 'emit'); } catch (e) { log('[jit] emitter failed to load — bridge stays off: ' + e); }
          if (d.workerfail === 'main') throw new Error('?workerfail=main — a simulated core failure during boot (rig seam)');
          M.callMain(['custom.v64']);
          post({ t: 'booted' });
          SCHED.coupled = (function () { var pq = new URLSearchParams(d.search || '').get('pace'); return pq === '0' || pq === 'off'; })();
          if (SCHED.coupled) log('[pace] core worker: CONTROL ARM (?pace=0) — one field per animation frame, nothing else');
          observePresents();
          setInterval(postStats, 100);
          if (roomArmed) roomMainRan();
          else if (!d.rig) schedule();
          else log('[worker] rig mode: the frame clock is NOT running; frames advance only on request');
        } catch (e) { post({ t: 'err', s: 'boot: ' + (e && e.stack || e), fatal: true }); }
      }
    };
    importScripts('n64wasm.js?v=' + CORE_V);
  }).catch(function (e) { post({ t: 'err', s: 'boot: ' + (e && e.stack || e), fatal: true }); });
}

onmessage = function (e) {
  var d = e.data;
  if (!d || !d.t) return;
  switch (d.t) {
    case 'boot': boot(d); break;
    case 'pad': if (d.p && d.p.length === 12) PADS.set(d.p); break;
    case 'audioPort': AUD.port = d.port; if (M && M._neilGetAudioWritePosition) AUD.read = M._neilGetAudioWritePosition(); break;
    // A ROOM IS NEVER PAUSED BY A HIDDEN TAB: the other consoles would stall on this one
    // (lockstep never guesses). The room's own drivers keep running, on this thread.
    case 'pause': if (RM.on) break; paused = !!d.on; if (!paused && M && !BOOT.rig) schedule(); break;
    case 'lsnew': roomNew(d); break;
    case 'lsin': roomIn(d); break;
    case 'lscall': roomCall(d); break;
    case 'lsset': roomSet(d); break;
    case 'lspads': if (d.p && d.p.length === 4) RM.pads = d.p; break;
    case 'lsdisarm': roomDisarm(d.why); break;
    case 'glwant': if (RM.R) { RM.R.LS_GL.want = d.n; RM.R.LS_GL.said = ''; RM.R.LS_GL.reads = 0; RM.R.LS_GL.lit = 0; } break;
    case 'reset': if (M) { M._neil_reset(); post({ t: 'toast', s: 'Reset' }); } break;
    case 'saveState': if (M) M._neil_serialize(); break;
    case 'loadState':
      idbGet(BOOT.romName).then(function (bytes) {
        if (!bytes) { post({ t: 'toast', s: 'No saved state for this game', bad: true }); return; }
        M.FS.writeFile('/savestate.gz', bytes);
        M._neil_unserialize();
        post({ t: 'toast', s: 'State loaded' });
      }, function (err) { post({ t: 'toast', s: 'Load failed: ' + err, bad: true }); });
      break;
    case 'eval':
      if (!BOOT || !BOOT.rig) { post({ t: 'evalr', id: d.id, e: 'eval is available only with ?workerrig=1' }); break; }
      try {
        var v = (0, eval)(d.src);
        Promise.resolve(v).then(function (r) { post({ t: 'evalr', id: d.id, v: r }); },
          function (er) { post({ t: 'evalr', id: d.id, e: String(er && er.stack || er) }); });
      } catch (er) { post({ t: 'evalr', id: d.id, e: String(er && er.stack || er) }); }
      break;
  }
};

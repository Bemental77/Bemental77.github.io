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
var CLK = { viHz: 0, base: 0, baseFrame: 0, frame: 0, lostMs: 0, reanchors: 0, presents: 0, ticks: 0, busyMs: 0, maxPerTick: 4 };
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
// THE DRIVER. On time, a tick per animation frame (the worker's own rAF, so a 60 Hz
// game on a 60 Hz display presents one field per refresh). BEHIND — a field is
// still due when the tick ends — the next tick is queued IMMEDIATELY as a task
// instead of waiting a whole refresh for rAF: this thread has nothing else to do,
// and on a device that cannot hold 1.000x every refresh spent waiting is capacity
// thrown away (measured: rAF-only ticked ~30/s here and ran the guest at ~half its
// producible rate). Queued as a task, never a loop, so the page's pad messages
// still land between fields; the picture commits at the end of each task.
// Still never AHEAD of the schedule: `due` is the only gate on running a field.
var hasRaf = (typeof self.requestAnimationFrame === 'function');
var SCHED = { raf: false, imm: false, tmr: false, chan: null, rafTicks: 0, immTicks: 0, tmrTicks: 0 };
function dueNow(now) {
  if (!(CLK.viHz > 0) || !CLK.base) return true;
  return now >= CLK.base + (CLK.frame - CLK.baseFrame) * (1000 / CLK.viHz);
}
function tick(src) {
  if (src === 'raf') { SCHED.raf = false; SCHED.rafTicks++; }
  else if (src === 'imm') { SCHED.imm = false; SCHED.immTicks++; }
  else if (src === 'tmr') { SCHED.tmr = false; SCHED.tmrTicks++; }
  if (!paused) {
    var t0 = performance.now(), n = 0;
    while (n < CLK.maxPerTick && due(performance.now())) { runOneFrame(); n++; }
    CLK.ticks++;
    if (n) { CLK.presents++; CLK.busyMs += performance.now() - t0; }
    // Counters ride on the frames themselves when fields are being made, so a long field
    // cannot starve the page's meter (its audio integrator drops any interval > 1 s).
    if (n && performance.now() - STAT.last >= 50) postStats();
  } else CLK.base = 0;     // resume re-anchors: a pause is not debt
  schedule();
}
function schedule() {
  if (!paused && dueNow(performance.now())) {
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
  if (!SCHED.tmr) {
    var wait = 8;
    if (CLK.viHz > 0 && CLK.base) wait = Math.max(0, CLK.base + (CLK.frame - CLK.baseFrame) * (1000 / CLK.viHz) - performance.now());
    SCHED.tmr = true; setTimeout(function () { tick('tmr'); }, wait);
  }
}

var STAT = { last: 0 };
function postStats() {
  if (!M || !M._neil_vi_total) return;
  STAT.last = performance.now();
  var js = self.__jitStats ? self.__jitStats() : null;
  post({ t: 'stat', at: performance.timeOrigin + performance.now(),
         vi: M._neil_vi_total() >>> 0, costMs: M._neil_frame_cost_ms(), costN: M._neil_frame_cost_n() >>> 0,
         apos: M._neilGetAudioWritePosition() | 0, frame: CLK.frame, presents: CLK.presents, ticks: CLK.ticks,
         lostMs: CLK.lostMs, reanchors: CLK.reanchors, busyMs: CLK.busyMs,
         rafTicks: SCHED.rafTicks, immTicks: SCHED.immTicks, tmrTicks: SCHED.tmrTicks,
         audioSent: AUD.sent, audioDropped: AUD.dropped,
         jitBlocks: js ? js.blocks : null,
         fb: self.__fbAsync ? { on: !!self.__fbAsync.on, calls: self.__fbAsync.calls, async: self.__fbAsync.async,
                                sync: self.__fbAsync.sync, blocked: self.__fbAsync.blocked, decided: self.__fbAsync.decided } : null });
}

// ---- boot --------------------------------------------------------------------------------
function boot(d) {
  BOOT = d;
  CORE_V = d.v || '';
  CLK.viHz = d.viHz > 0 ? d.viHz : 0;
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
          // THE FRAME GATE, before main(): see THE FRAME CLOCK in the header.
          M._neil_ls_arm(1);
          var fbn = new URLSearchParams(d.search || '').get('fbnative');
          if (fbn != null && typeof M._neil_set_native_fbread === 'function') M._neil_set_native_fbread(fbn === '0' ? 0 : 1);
          // `window` is defined only now, after the runtime decided it is a worker:
          // the JIT up-call (recomp.c) and the emitter both spell it `window.`.
          self.window = self;
          try { setupJit(d.jit || 'emit'); } catch (e) { log('[jit] emitter failed to load — bridge stays off: ' + e); }
          M.callMain(['custom.v64']);
          post({ t: 'booted' });
          setInterval(postStats, 100);
          if (!d.rig) schedule();
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
    case 'pause': paused = !!d.on; if (!paused && M && !BOOT.rig) schedule(); break;
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

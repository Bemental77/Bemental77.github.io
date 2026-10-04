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
  var jv = Date.now();
  // the emitter's off-thread half runs the same file (mips_emit.js OFF-THREAD EMISSION)
  self.__n64JitWorkerUrl = '/n64/bementalJIT/jit_compile_worker.js?v=' + jv;
  importScripts('/n64/bementalJIT/mips_emit.js?v=' + jv);   // as the page does: the emitter moves independently
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
  // ?jitcapture=1: record every offer from the first (n64/tools/n64_jit_corpus.mjs makes a corpus of them)
  if (new URLSearchParams((BOOT && BOOT.search) || '').get('jitcapture') === '1' && self.bementalMips && self.bementalMips.warm) self.bementalMips.warm.capture = [];
  jitCorpusLoad();
}
// THE SHIPPED SPAN CORPUS (mips_emit.js A SHIPPED SPAN CORPUS): dist/jit/<internal name>.json.gz,
// when the title has one, decoded here and handed to the emitter, which uses it only if it was
// made with this session's param block, flags and table base. ?jitcorpus=0 = none (the A/B arm).
function jitCorpusLoad() {
  var d = BOOT || {}, name = (self.__fbAsync && self.__fbAsync.romName) || '';
  if (!name || new URLSearchParams(d.search || '').get('jitcorpus') === '0' || typeof DecompressionStream !== 'function') return;
  var u32 = function (b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Uint32Array(u8.buffer);
  };
  fetch('jit/' + encodeURIComponent(name.replace(/[^A-Za-z0-9 _-]/g, '_')) + '.json.gz?v=' + (d.v || ''))
    .then(function (r) { return r.ok ? new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).json() : null; })
    .then(function (c) {
      if (!c || c.v !== 1 || !self.bementalMips || !self.bementalMips.warmCorpus) return;
      var C = { static: c.static, flags: c.flags, tableBase: c.tableBase, pages: [], jobs: [] };
      c.pages.forEach(function (pg) { C.pages.push({ w0: pg[0], words: u32(pg[1]) }); });
      c.jobs.forEach(function (j) { C.jobs.push({ vaddr: j[0], entryPtr: j[1], span: j[2], srcPtr: j[3], blockStart: j[4], blockEnd: j[5], pg: j[6], ops: u32(j[7]) }); });
      self.bementalMips.warmCorpus(C);
      log('[jit] span corpus: ' + C.jobs.length + ' spans, ' + C.pages.length + ' pages (' + name + ')');
    }).catch(function (e) { log('[jit] span corpus not loaded: ' + ((e && e.message) || e)); });
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
  // rig seam (?workerrig=clock only: a rig's eval installs it): the pads as a function of the
  // field, so a measured run on the SHIPPED clock follows one guest trajectory
  if (self.__n64PadOverride) for (var q = 0; q < 4; q++) { var o = self.__n64PadOverride(CLK.frame, q); PADS[q * 3] = o[0]; PADS[q * 3 + 1] = o[1]; PADS[q * 3 + 2] = o[2]; }
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
function tick(src) { if (DBG) return DBG.task('tick:' + src, tickBody)(src); return tickBody(src); }
function tickBody(src) {
  if (src === 'raf') { SCHED.raf = false; SCHED.rafTicks++; }
  else if (src === 'imm') { SCHED.imm = false; SCHED.immTicks++; }
  else if (src === 'tmr') { SCHED.tmr = false; SCHED.tmrTicks++; }
  if (!paused) {
    CLK.ticks++;
    var now = performance.now();
    if ((!SCHED.coupled || src === 'raf') && dueNow(now) && !gqReady()) {
      // held: the GPU is too far behind (THE GPU QUEUE GUARD); a timer turn retries
      if (!GQ.timer) { GQ.timer = true; setTimeout(function () { GQ.timer = false; tick('gq'); }, 1); }
      return;
    } else if ((!SCHED.coupled || src === 'raf') && dueNow(now) && !cbMayDraw(src)) {
      // yielded: the last field's picture is not pushed yet (THE COMMIT YIELD)
    } else if ((!SCHED.coupled || src === 'raf') && due(now)) {
      var t0 = performance.now();
      runOneFrame();
      gqAfterField();
      cbDidDraw(src);
      pbPresent();
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
    // Yielded (THE COMMIT YIELD): its timer turn runs the field.
    if (CB.waiting) return;
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

// ---- THE GPU QUEUE GUARD: THE GPU IS NEVER MORE THAN A FEW FIELDS BEHIND ----------------
// Until glide's framebuffer copy went lazy (Glide64/lazy_fb.c), a read_always title read the
// previous frame back every display list (fbasync.js getBufferSubData), and that wait was the
// one thing that kept this thread from running ahead of the GPU: 6-8 ms a field on the user's
// phone, 20-70 ms here under SwiftShader. Without it nothing bounds the GPU's queue, and a GPU
// slower than the guest's field rate falls behind WITHOUT LIMIT — measured here (MK64 race,
// n64_field_cost_probe --finish): a fence set after a field signalled 3.4 s later on average,
// i.e. what reached the screen was 3.4 s old (input lag), and the WebGL call that finally hit
// the full command buffer took 0.3-2.5 s.
// So a fence is set after every field, and a field does not START while the GPU is too far
// behind: this thread yields (a 1 ms timer turn; the GPU and every other task run meanwhile)
// instead of queueing more. The guest is untouched — the frame clock still decides WHEN a field
// is owed, and time lost to a slow GPU is lost (gate 9), exactly as it was while the readback
// waited. A sync object only changes state between tasks, so the status read here is free.
// After 250 ms of holding the field runs anyway (a lost context, a driver that never signals).
//
// THE BOUND IS A TIME, NOT A DEPTH (2026-10-04). It was "more than 2 fences outstanding". On
// this box's SwiftShader that held the guest to 0.71x (MK64 race, worker threads at half a core:
// held ~1150x, 31 s of a 55 s window) while with no guard at all the guest held 1.000x and the
// queue did not grow without limit (it settled at ~20 fields): a GPU that keeps up, but only with
// many frames in flight, was treated as one that does not. Measured per bound (fps of guest /
// hardware, fence latency p50 / p99, two runs each): depth 2 0.71x 73/136 ms; 250 ms 0.89-0.92x
// 187-217/343-355; 500 ms 0.96-0.97x 298-333/576-578; 1000 ms 1.00x 397-446/934-967; none 1.00x
// 368-567/1040-1409. What must never happen is the queue growing WITHOUT LIMIT (a GPU slower than
// the guest: seconds of lag, a WebGL call that blocks for seconds). So a field is held only when
// the oldest unsignalled fence is older than GQ.capMs (1000): a GPU that keeps up within that is
// never waited for, whatever its depth; one that falls behind is held at ~1 s of lag at most.
// Below 3 outstanding nothing is ever held, and nothing is asked of GL while the oldest fence is
// younger than capMs (the age is this thread's own clock). ?gpuqms=N sets the bound;
// ?gpuq=N is the old fixed-depth guard (the A/B arm); ?gpuq=0 no guard (control arm).
var GQ = { on: true, max: 2, capMs: 1000, fences: [], times: [], held: 0, heldMs: 0, holdFrom: 0, forced: 0, gl: null, timer: false, lastAge: 0 };
function gqGl() {
  if (GQ.gl) return GQ.gl;
  var g = M && M.ctx;
  if (g && typeof g.fenceSync === 'function') GQ.gl = g;
  return GQ.gl;
}
function gqAfterField() {
  if (!GQ.on) return;
  var gl = gqGl(); if (!gl) return;
  var f = null;
  try { f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); } catch (e) { f = null; }
  if (f) { GQ.fences.push(f); GQ.times.push(performance.now()); }
  if (GQ.fences.length > 256) { try { gl.deleteSync(GQ.fences.shift()); } catch (e) {} GQ.times.shift(); }
}
// within the bound? (the fixed-depth arm: within GQ.max fences; the time bound: at most GQ.max
// fences, or the oldest no older than GQ.capMs)
function gqWithin(now) {
  if (GQ.fences.length <= GQ.max) return true;
  return GQ.capMs > 0 && now - GQ.times[0] <= GQ.capMs;
}
// may a field start now? false = hold it (the caller retries from a later task)
function gqReady() {
  var now = performance.now();
  // within the bound nothing is asked of GL: fences are retired only when the answer matters
  if (!GQ.on || gqWithin(now)) {
    if (GQ.holdFrom) { GQ.heldMs += now - GQ.holdFrom; GQ.holdFrom = 0; }
    return true;
  }
  var gl = gqGl(); if (!gl) return true;
  while (GQ.fences.length) {
    var st = gl.getSyncParameter(GQ.fences[0], gl.SYNC_STATUS);
    if (st !== gl.SIGNALED) break;
    gl.deleteSync(GQ.fences.shift()); GQ.lastAge = now - GQ.times.shift();
  }
  if (gqWithin(now)) { if (GQ.holdFrom) { GQ.heldMs += now - GQ.holdFrom; GQ.holdFrom = 0; } return true; }
  if (!GQ.holdFrom) { GQ.holdFrom = now; GQ.held++; }
  if (now - GQ.holdFrom > 250) { GQ.forced++; GQ.heldMs += now - GQ.holdFrom; GQ.holdFrom = 0; return true; }
  return false;
}

// ---- PRESENTATION BY BITMAP: EVERY DRAWN FIELD REACHES THE PAGE ------------------------
// (See THE COMMIT YIELD below for what the canvas-commit path loses and why.) An ARM (?present=bitmap): with
// boot.present === 'bitmap' the core draws into an OffscreenCanvas of this worker's own (no
// placeholder, so nothing is ever committed behind its back), and after every field that
// drew into the default framebuffer its picture is taken with transferToImageBitmap — a
// buffer hand-over, no copy — and posted to the page, which puts it on #canvas
// (ImageBitmapRenderingContext) on ITS OWN animation frames, one picture per frame, in
// order. The page's main thread is idle (it holds only UI, input and the audio graph), so
// its frames are the display's; this thread never waits for one — the guest's rate is
// untouched (gate 9) — and two fields made between two display frames are both shown,
// the second one frame later, instead of the first being overwritten unseen.
// Only fields that DREW are taken: a field that draws nothing (Mario Kart draws a picture
// every second field) leaves the last picture up, exactly as a canvas commit would.
var PB = { on: false, drew: false, sent: 0, errs: 0, err: null, ms: 0 };
function pbInstall() {
  if (!self.WebGL2RenderingContext) return;
  var P = WebGL2RenderingContext.prototype;
  var FB = P.FRAMEBUFFER, DFB = P.DRAW_FRAMEBUFFER, bf = P.bindFramebuffer;
  P.bindFramebuffer = function (t, fb) { if (t === FB || t === DFB) this.__pbFb = fb || null; return bf.apply(this, arguments); };
  ['drawArrays', 'drawElements', 'drawRangeElements', 'drawArraysInstanced', 'drawElementsInstanced',
   'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer'].forEach(function (n) {
    var f = P[n]; if (typeof f !== 'function') return;
    P[n] = function () {
      if (!this.__pbFb && !(RM.R && RM.R.GLSKIP && RM.R.GLSKIP.on)) PB.drew = true;
      return f.apply(this, arguments);
    };
  });
}
function pbPresent() {
  if (!PB.on || !PB.drew) return;
  PB.drew = false;
  var bmp = null, t0 = performance.now();
  try { bmp = BOOT.canvas.transferToImageBitmap(); } catch (e) { PB.errs++; PB.err = String((e && e.message) || e); return; }
  try { postMessage({ t: 'frame', b: bmp, f: CLK.frame }, [bmp]); PB.sent++; } catch (e) { PB.errs++; PB.err = String((e && e.message) || e); }
  PB.ms += performance.now() - t0;
}

// ---- THE COMMIT YIELD: A FIELD DOES NOT DRAW OVER ONE THAT WAS NEVER SHOWN -------------
// MEASURED on a real phone (Android Chrome 154, Mali-G715, MK64 PAL, a room guest, after
// the one-field-per-task driver above): 3907 fields, 4042 worker animation frames, but only
// 2083 of those frames had a new field to show — "14 shown / 25 made". One field per TASK
// is not one field per COMMIT. In Chrome a worker's placeholder-backed OffscreenCanvas
// (transferControlToOffscreen) is pushed to the compositor only by that worker's
// BeginFrame — its animation-frame task, after the rAF callbacks — at most once per
// display frame. A field that costs about a field period (17.9 ms against PAL's 20 ms) is
// almost always due again when the last one ends, and its immediate task ran AHEAD of the
// BeginFrame that had arrived meanwhile: two fields drawn, one push, the first never seen.
// So when a field is due while the last one's picture is still unpushed, this thread
// YIELDS ONE TIMER TURN before drawing it: an animation frame already queued runs (and
// pushes) first; if none was queued, the field runs anyway. It never WAITS for a frame.
// Inside a rAF callback, a picture drawn before that frame is about to be pushed, so the
// callback draws nothing over it and the field runs right after the push.
// MEASURED here (MK64, solo, worker, hermetic snapshot, interleaved; screen = distinct
// pictures the page's main thread saw / made = the game's own GameFPS):
//   commit (no yield)   screen/made 0.82-0.85   fields/s 42.3, 42.4 (34.2 under load)
//   yield               screen/made 0.92-0.99   fields/s 42.1, 41.6 (29.3 under load)
//   WAIT for the frame  screen/made ~1.00       fields/s 36.8, 33.5 vs 39.1, 37.4 — REJECTED:
//     the guest lost ~8% of its rate waiting on a 28/s compositor (gate 9).
//   bitmap (below)      screen/made 0.98-0.99   fields/s 39.1-40.4 vs 42.3 — the per-field
//     cost rose ~3 ms under SwiftShader, so it is an arm (?present=bitmap), not the default.
// ?present=commit is the control arm (no yield).
var CB = { on: true, mode: 'yield', drawn: false, commitThis: false, waiting: false, yielded: false,
           holds: 0, released: 0, forced: 0, rafDraws: 0, taskDraws: 0, rafSkips: 0 };
function cbMayDraw(src) {
  if (!CB.on || !hasRaf) return true;
  if (src === 'raf') {
    if (!CB.commitThis) return true;
    // this frame pushes the picture drawn before it: run the field right after the push
    CB.rafSkips++;
    if (!CB.waiting) { CB.waiting = true; setTimeout(function () { if (CB.waiting) cbRelease(); }, 0); }
    return false;
  }
  if (!CB.drawn) return true;
  if (CB.yielded) { CB.forced++; CB.waiting = false; return true; }
  CB.yielded = true; CB.holds++;
  if (!CB.waiting) { CB.waiting = true; setTimeout(function () { if (CB.waiting) cbRelease(); }, 0); }
  return false;
}
function cbDidDraw(src) {
  CB.yielded = false; CB.waiting = false;
  if (src === 'raf') { CB.commitThis = true; CB.rafDraws++; }
  else { CB.drawn = true; CB.taskDraws++; }
}
// The yielded field runs now, in an immediate task.
function cbRelease() {
  CB.waiting = false;
  CB.released++;
  if (RM.on && RM.R && RM.R.LS.armed) { roomKick(); return; }
  if (!SCHED.imm && !paused) {
    if (!SCHED.chan) { SCHED.chan = new MessageChannel(); SCHED.chan.port1.onmessage = function () { tick('imm'); }; }
    SCHED.imm = true; SCHED.chan.port2.postMessage(0);
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
    // THE COMMIT YIELD: this frame pushes whatever was drawn before it.
    CB.commitThis = CB.drawn; CB.drawn = false;
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
         pb: PB.on ? { sent: PB.sent, errs: PB.errs, err: PB.err, ms: Math.round(PB.ms) } : null,
         cb: { mode: CB.mode, yields: CB.holds, released: CB.released, forced: CB.forced,
               rafDraws: CB.rafDraws, taskDraws: CB.taskDraws, rafSkips: CB.rafSkips },
         audioSent: AUD.sent, audioDropped: AUD.dropped,
         jitBlocks: js ? js.blocks : null, dbg: DBG ? DBG.report() : undefined,
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
  if (!DBG) return roomMirrorBody(full);
  var t0 = performance.now(); roomMirrorBody(full); var dt = performance.now() - t0;
  DBG.mir.n++; DBG.mir.ms += dt; if (dt > DBG.mir.max) DBG.mir.max = dt;
}
function roomMirrorBody(full) {
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
  if (d.m && d.m.t === 'ls' && RM.R && RM.R.LS.armed) roomFeed('kick');
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
function roomFeed(src) { if (DBG) return DBG.task('feed:' + src, roomFeedBody)(src); return roomFeedBody(src); }
function roomDueAt(R) {
  var L = R.LS;
  if (!(L.viHz > 0) || !L.baseWall) return -Infinity;
  return L.baseWall + (L.frame - L.baseFrame) * (1000 / L.viHz / ((L.pace > 0 && L.pace <= 1) ? L.pace : 1));
}
function roomFeedBody(src) {
  var R = RM.R; if (!R || !R.LS.armed || !R.lsDriveOk(src === 'raf' ? 'raf' : 'timer')) return;
  // THE COMMIT YIELD (above): a due frame yields once to an unpushed picture's commit.
  // THE GPU QUEUE GUARD (above): a due frame waits while the GPU is too far behind;
  // the 4 ms feed timer and rAF retry it
  if (R.LS.running && performance.now() >= roomDueAt(R) && !gqReady()) return;
  if (R.LS.running && performance.now() >= roomDueAt(R) && !cbMayDraw(src === 'raf' ? 'raf' : 'task')) return;
  var f0 = R.LS.frame;
  try { R.lsFeed(); } catch (e) { log('[lockstep] feed threw: ' + ((e && e.stack) || e)); }
  if (R.LS.frame !== f0) { CLK.frame = R.LS.frame; cbDidDraw(src === 'raf' ? 'raf' : 'task'); pbPresent(); gqAfterField(); }
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

// ---- ?costdbg=1: WHERE A SLOW FIELD'S TIME WENT (a measurement arm, OFF when shipped) -----
// A real phone (Mali-G715, MK64 PAL, room guest) logged 902 fields over a field period and one
// of 620 ms. This splits every field's wall time (one _neil_ls_run_frame) into the up-calls
// that can be slow inside it — the JIT compiling a block (myApp.jitCompile, a synchronous
// wasm module per span), shader compile/link and the first use of a program, framebuffer
// readback, texture and buffer uploads — and the rest ("core": emulation, every other GL
// call, and any GC that landed there). It also times every WORKER TASK, so a burst outside
// the field (a rollback, a ring allocation, the room mirror) is seen too. Nothing is wrapped
// unless the flag is on: the shipped worker runs with none of it.
var DBG = null;
function dbgInstall(search) {
  if (new URLSearchParams(search || '').get('costdbg') !== '1') return;
  var B = ['jit', 'shader', 'prog', 'read', 'gbsd', 'tex', 'buf', 'sync'];
  DBG = { b: {}, n: {}, frames: 0, over: 0, overMs: 0, overB: {}, overCore: 0, max: [], tasks: { n: 0, over: 0, max: [] },
          hist: [0, 0, 0, 0, 0, 0], depth: 0, mir: { n: 0, ms: 0, max: 0 },
          ring: new Float32Array(4096), ringN: 0 };   // every field's wall ms: mean / p99 / max per report
  B.forEach(function (k) { DBG.b[k] = 0; DBG.n[k] = 0; DBG.overB[k] = 0; });
  var now = function () { return performance.now(); };
  function wrap(obj, name, bucket) {
    var f = obj[name]; if (typeof f !== 'function') return;
    obj[name] = function () {
      if (DBG.depth) return f.apply(this, arguments);
      DBG.depth++; var t0 = now();
      try { return f.apply(this, arguments); } finally { DBG.b[bucket] += now() - t0; DBG.n[bucket]++; DBG.depth--; }
    };
  }
  if (self.WebGL2RenderingContext) {
    var P = WebGL2RenderingContext.prototype;
    ['compileShader', 'getShaderParameter', 'getShaderInfoLog'].forEach(function (n) { wrap(P, n, 'shader'); });
    ['linkProgram', 'getProgramParameter', 'getProgramInfoLog', 'getUniformLocation', 'getAttribLocation', 'validateProgram'].forEach(function (n) { wrap(P, n, 'prog'); });
    wrap(P, 'readPixels', 'read'); wrap(P, 'getBufferSubData', 'gbsd');
    var rp0 = P.readPixels; P.readPixels = function (x, y, w, h) { DBG.rect = w + 'x' + h; return rp0.apply(this, arguments); };
    ['texImage2D', 'texSubImage2D', 'texStorage2D', 'copyTexImage2D', 'copyTexSubImage2D', 'generateMipmap'].forEach(function (n) { wrap(P, n, 'tex'); });
    ['bufferData', 'bufferSubData'].forEach(function (n) { wrap(P, n, 'buf'); });
    ['finish', 'flush', 'clientWaitSync', 'getSyncParameter', 'getError'].forEach(function (n) { wrap(P, n, 'sync'); });
  }
  DBG.wrapJit = function () {
    var f = self.myApp && self.myApp.jitCompile; if (!f || f.__dbg) return;
    var g = function (p) { var t0 = now(); try { return f(p); } finally { DBG.b.jit += now() - t0; DBG.n.jit++; } };
    g.__dbg = true; self.myApp.jitCompile = g;
  };
  DBG.wrapFrame = function () {
    var rf = M._neil_ls_run_frame; if (!rf || rf.__dbg) return;
    var w = function () {
      var b0 = {}; for (var k in DBG.b) b0[k] = DBG.b[k];
      var t0 = now();
      try { return rf.apply(this, arguments); } finally {
        var dt = now() - t0, per = CLK.viHz > 0 ? 1000 / CLK.viHz : 16.7;
        DBG.frames++;
        DBG.ring[DBG.ringN++ & 4095] = dt;
        if (self.__rigFields) self.__rigFields.push(CLK.frame, dt);
        DBG.hist[dt < per ? 0 : dt < 2 * per ? 1 : dt < 50 ? 2 : dt < 100 ? 3 : dt < 300 ? 4 : 5]++;
        if (dt > per) {
          var rec = { f: CLK.frame, ms: +dt.toFixed(1), at: Math.round(t0) }, acc = 0;
          for (var k2 in DBG.b) { var d = DBG.b[k2] - b0[k2]; DBG.overB[k2] += d; acc += d; if (d >= 1) rec[k2] = +d.toFixed(1); }
          rec.core = +(dt - acc).toFixed(1);
          DBG.over++; DBG.overMs += dt; DBG.overCore += dt - acc;
          DBG.max.push(rec); DBG.max.sort(function (a, b) { return b.ms - a.ms; }); if (DBG.max.length > 24) DBG.max.length = 24;
        }
      }
    };
    w.__dbg = true; M._neil_ls_run_frame = w;
  };
  // Every task this worker runs, by its entry point.
  DBG.task = function (name, fn) {
    return function () {
      var t0 = now();
      try { return fn.apply(this, arguments); } finally {
        var dt = now() - t0; DBG.tasks.n++;
        if (dt > 30) {
          DBG.tasks.over++;
          DBG.tasks.max.push({ task: name, ms: +dt.toFixed(1), at: Math.round(t0) });
          DBG.tasks.max.sort(function (a, b) { return b.ms - a.ms; }); if (DBG.tasks.max.length > 24) DBG.tasks.max.length = 24;
        }
      }
    };
  };
  // the distribution of the last n fields (n <= 4096): mean, p50, p99, max
  DBG.dist = function (n) {
    n = Math.min(n || 4096, DBG.ringN, 4096);
    if (!n) return null;
    var a = new Float32Array(n), sum = 0;
    for (var i = 0; i < n; i++) { a[i] = DBG.ring[(DBG.ringN - 1 - i) & 4095]; sum += a[i]; }
    a.sort();
    return { n: n, mean: +(sum / n).toFixed(2), p50: +a[n >> 1].toFixed(2), p99: +a[Math.min(n - 1, Math.floor(n * 0.99))].toFixed(2), max: +a[n - 1].toFixed(1) };
  };
  DBG.report = function () {
    var r = { rect: DBG.rect, frames: DBG.frames, dist: DBG.lastDist || null, over: DBG.over, overMs: Math.round(DBG.overMs), overCoreMs: Math.round(DBG.overCore), hist: DBG.hist.slice(),
              all: {}, inOver: {}, max: DBG.max.slice(0, 12), mirror: { n: DBG.mir.n, ms: Math.round(DBG.mir.ms), max: +DBG.mir.max.toFixed(1) }, tasks: { n: DBG.tasks.n, over: DBG.tasks.over, max: DBG.tasks.max.slice(0, 12) } };
    for (var k in DBG.b) { r.all[k] = [Math.round(DBG.b[k]), DBG.n[k]]; r.inOver[k] = Math.round(DBG.overB[k]); }
    return r;
  };
  // Every 10 s, one line into the page's log — what a player on a real phone can copy out.
  var lastN = 0;
  setInterval(function () {
    if (!DBG.frames) return;
    var d = DBG.dist(DBG.ringN - lastN), b = [], x = [];
    DBG.lastDist = d;              // what the page's stats (every 100 ms) carry: sorted once per 10 s
    lastN = DBG.ringN;
    var r = DBG.report();
    // what the frame-cost levers did (lazy framebuffer copy, off-thread JIT, shader prewarm)
    try {
      if (M && M._neil_lfb_stats) { var lp = M._malloc(32); M._neil_lfb_stats(lp); var L = M.HEAPU32.subarray(lp >> 2, (lp >> 2) + 8); x.push('fb copies queued ' + L[0] + ' made ' + L[1] + ' skipped ' + L[2]); M._free(lp); }
      if (self.bementalMips && self.bementalMips.async) { var A = self.bementalMips.async; x.push('jit off-thread ' + (A.on ? 'on' : 'off') + ' ' + A.installed + '/' + A.offered + ' installed'); }
      x.push('gpu queue guard ' + (GQ.on ? 'held ' + GQ.held + 'x ' + Math.round(GQ.heldMs) + ' ms, forced ' + GQ.forced + ', ' + GQ.fences.length + ' outstanding' : 'off'));
      if (M && M._neil_shader_stats) { var sp = M._malloc(16); M._neil_shader_stats(sp); var Q = M.HEAP32.subarray(sp >> 2, (sp >> 2) + 4); x.push('shaders prewarmed ' + Q[0] + ' used ' + Q[1] + ' compiled ' + Q[2]); M._free(sp); }
    } catch (e) {}
    if (d) log('[costdbg] last ' + d.n + ' fields: mean ' + d.mean + ' ms, p50 ' + d.p50 + ', p99 ' + d.p99 + ', max ' + d.max + ' (period ' + (CLK.viHz > 0 ? (1000 / CLK.viHz).toFixed(1) : '?') + ' ms). ' + x.join('; '));
    for (var k in r.inOver) if (r.inOver[k] >= 1) b.push(k + ' ' + r.inOver[k]);
    log('[costdbg] fields ' + r.frames + ', over a period ' + r.over + ' (' + r.overMs + ' ms; <P/<2P/<50/<100/<300/300+ ms: '
        + r.hist.join('/') + '); inside them: ' + b.join(', ') + ', core ' + r.overCoreMs + ' ms. worst: '
        + r.max.slice(0, 4).map(function (x) { var s = []; for (var q in x) if (q !== 'f' && q !== 'at' && q !== 'ms') s.push(q + ' ' + x[q]); return x.ms + ' ms (' + s.join(' ') + ')'; }).join('; ')
        + '. slow tasks: ' + r.tasks.max.slice(0, 3).map(function (x) { return x.task + ' ' + x.ms; }).join(', '));
  }, 10000);
  log('[costdbg] per-field cost buckets ON (?costdbg=1) — a measurement arm; it wraps GL calls and the JIT up-call');
}

// ---- SHADER PREWARM LIST (glitch64_combiner.c SHADER PREWARM) ------------------------------
// Every fragment source glide made a program from in this session is stored per ROM in the
// same IndexedDB as the saves (key '<rom>.glsl'), merged with the list shipped for the title
// (dist/shaders/<internal name>.glsl, when there is one); the next boot writes the union to
// /n64_shaders.bin before main() and glide compiles and links all of them ahead, with no
// query, so a display list never waits for a compile it has seen before. Pixels are
// unchanged by construction: a program is adopted only for the identical source text.
// ?shaderwarm=0 is the A/B arm and kill switch (nothing loaded, nothing stored).
var SHD = { boot: null, saved: 0, off: false, n: 0 };
function shdSplit(u8) {
  var out = [], i0 = 0;
  if (!u8) return out;
  for (var i = 0; i < u8.length; i++) if (u8[i] === 0) { if (i > i0) out.push(u8.subarray(i0, i)); i0 = i + 1; }
  return out;
}
function shdLoad(d) {
  SHD.off = new URLSearchParams(d.search || '').get('shaderwarm') === '0';
  if (SHD.off) return Promise.resolve(null);
  var name = (self.__fbAsync && self.__fbAsync.romName) || '';
  var mine = idbGet(d.romName + '.glsl').catch(function () { return null; });
  var shipped = name ? fetch('shaders/' + encodeURIComponent(name.replace(/[^A-Za-z0-9 _-]/g, '_')) + '.glsl?v=' + (d.v || ''))
    .then(function (r) { return r.ok ? r.arrayBuffer() : null; }).catch(function () { return null; }) : Promise.resolve(null);
  return Promise.all([mine, shipped]).then(function (a) {
    var out = shdMerge([a[0] && new Uint8Array(a[0].buffer ? a[0].buffer.slice(a[0].byteOffset, a[0].byteOffset + a[0].byteLength) : a[0]),
                        a[1] && new Uint8Array(a[1])]);
    SHD.n = out ? shdSplit(out).length : 0;
    SHD.saved = a[0] ? a[0].byteLength : 0;
    if (out) log('[shader] prewarm list: ' + SHD.n + ' programs (' + (a[0] ? 'stored' : 'none stored') + (a[1] ? ' + shipped' : '') + ')');
    return out;
  }).catch(function () { return null; });
}
// Union of lists of NUL-terminated sources; a text listed k times stands for k programs (two
// combiner keys can build one text), so each text appears max(k) times in the result.
function shdMerge(lists) {
  var td = new TextDecoder(), cnt = new Map(), bytes = new Map(), order = [];
  lists.forEach(function (u8) {
    if (!u8) return;
    var here = new Map();
    shdSplit(u8).forEach(function (p) {
      var k = td.decode(p);
      here.set(k, (here.get(k) || 0) + 1);
      if (!bytes.has(k)) { bytes.set(k, p); order.push(k); }
    });
    here.forEach(function (n, k) { if (n > (cnt.get(k) || 0)) cnt.set(k, n); });
  });
  var total = 0;
  order.forEach(function (k) { total += (bytes.get(k).length + 1) * cnt.get(k); });
  if (!total) return null;
  var out = new Uint8Array(total), o = 0;
  order.forEach(function (k) { for (var n = cnt.get(k); n > 0; n--) { out.set(bytes.get(k), o); o += bytes.get(k).length + 1; } });
  return out;
}
function shdSave() {
  if (SHD.off || !M || typeof M._neil_shader_dump !== 'function' || !BOOT) return;
  var n = M._neil_shader_dump(0, 0) | 0;
  if (n <= 0) return;
  // the stored list is the union of what this session used and what was stored before
  var ptr = M._malloc(n);
  if (!ptr) return;
  try {
    M._neil_shader_dump(ptr, n);
    var merged = shdMerge([M.HEAPU8.slice(ptr, ptr + n), SHD.boot]);
    if (!merged || merged.length <= SHD.saved) return;
    SHD.saved = merged.length;
    idbPut(BOOT.romName + '.glsl', merged).catch(function () {});
  } finally { M._free(ptr); }
}

// ---- boot --------------------------------------------------------------------------------
function boot(d) {
  BOOT = d;
  // ?workerrig=clock: the rig seam (eval) with the frame clock RUNNING as shipped — a
  // measurement of what a player gets, driven by a pad function (applyPads)
  BOOT.rigClock = new URLSearchParams(d.search || '').get('workerrig') === 'clock';
  (function () {
    var gq = new URLSearchParams(d.search || '').get('gpuq');
    var gqms = new URLSearchParams(d.search || '').get('gpuqms');
    if (gq === '0') { GQ.on = false; log('[gpuq] CONTROL ARM (?gpuq=0): no GPU queue guard'); }
    else if (gq && +gq > 0) { GQ.max = Math.min(16, +gq | 0); GQ.capMs = 0; log('[gpuq] fixed depth ' + GQ.max + ' (?gpuq)'); }
    if (gqms !== null && +gqms >= 0) GQ.capMs = Math.min(2000, +gqms);
  })();
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
  if (d.present === 'bitmap') {
    d.canvas = new OffscreenCanvas(d.cw > 0 ? d.cw : 640, d.ch > 0 ? d.ch : 480);
    PB.on = true; pbInstall();
    log('[present] core worker: pictures go to the page as ImageBitmaps, one per drawn field (no canvas commit)');
  }
  installShims(d.canvas);
  dbgInstall(d.search);
  (function () {
    var gf = new URLSearchParams(d.search || '').get('glflush');
    if (gf === 'fence' && self.WebGL2RenderingContext) {
      var P = WebGL2RenderingContext.prototype, fs = P.fenceSync;
      P.fenceSync = function () { var s = fs.apply(this, arguments); this.flush(); return s; };
      log('[glflush] arm: flush after every fenceSync');
    }
  })();
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
  var shaderList = shdLoad(d);
  fetch('assets.zip').then(function (r) {
    if (!r.ok) throw new Error('assets.zip HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (assets) { return shaderList.then(function (sl) { SHD.boot = sl; return assets; }); }).then(function (assets) {
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
          if (SHD.boot && SHD.boot.length) M.FS.writeFile('/n64_shaders.bin', SHD.boot);   // glide prewarms these (glitch64_combiner.c)
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
          if (DBG) { DBG.wrapJit(); DBG.wrapFrame(); }
          if (d.workerfail === 'main') throw new Error('?workerfail=main — a simulated core failure during boot (rig seam)');
          M.callMain(['custom.v64']);
          post({ t: 'booted' });
          SCHED.coupled = (function () { var pq = new URLSearchParams(d.search || '').get('pace'); return pq === '0' || pq === 'off'; })();
          if (SCHED.coupled) log('[pace] core worker: CONTROL ARM (?pace=0) — one field per animation frame, nothing else');
          CB.mode = PB.on ? 'bitmap' : (d.present === 'commit' ? 'commit' : 'yield');
          CB.on = CB.mode === 'yield';
          if (CB.mode === 'commit') log('[present] core worker: CONTROL ARM (?present=commit) — no commit yield');
          observePresents();
          setInterval(postStats, 100);
          setInterval(shdSave, 15000);
          if (roomArmed) roomMainRan();
          else if (!d.rig) schedule();
          else log('[worker] rig mode: the frame clock is NOT running; frames advance only on request');
        } catch (e) { post({ t: 'err', s: 'boot: ' + (e && e.stack || e), fatal: true }); }
      }
    };
    importScripts('n64wasm.js?v=' + CORE_V);
  }).catch(function (e) { post({ t: 'err', s: 'boot: ' + (e && e.stack || e), fatal: true }); });
}

onmessage = function (e) { if (DBG && e.data && e.data.t) return DBG.task('msg:' + e.data.t, onMsg)(e); return onMsg(e); };
function onMsg(e) {
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
      if (!BOOT || !(BOOT.rig || BOOT.rigClock)) { post({ t: 'evalr', id: d.id, e: 'eval is available only with ?workerrig=1 or ?workerrig=clock' }); break; }
      try {
        var v = (0, eval)(d.src);
        Promise.resolve(v).then(function (r) { post({ t: 'evalr', id: d.id, v: r }); },
          function (er) { post({ t: 'evalr', id: d.id, e: String(er && er.stack || er) }); });
      } catch (er) { post({ t: 'evalr', id: d.id, e: String(er && er.stack || er) }); }
      break;
  }
}

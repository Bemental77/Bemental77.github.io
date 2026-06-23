// render-worker.js — owns the on-screen OffscreenCanvas and replays the WebGL2
// command stream produced by worker_0 (dolphin_worker). FIX #1 of the
// native-speed plan: moves the whole GL draw path — bufferSubData +
// texSubImage3D are ~34% of worker_0 — OFF the CPU/dispatch worker.
//
// This is a SEPARATE Worker, NOT an emscripten pthread. That distinction is
// load-bearing: the prior dual-core attempt put the GPU work on a pthread whose
// GL proxied BACK to worker_0 under OffscreenCanvas + proxyContextToMainThread
// (worker_funcs.js:155-165). A separate Worker that receives the OffscreenCanvas
// by postMessage transfer and calls getContext('webgl2') locally genuinely owns
// the context on its own thread (the proven gpu-worker.js pattern,
// gamecube.html:1811-1834).
//
// PROTOCOL (single-producer/single-consumer i32 ring on SharedArrayBuffer):
//   each command = [opcode, nWords, w0, w1, ... w(nWords-1)]
//   - opcode = index into METHODS (shared ordering, below)
//   - integer/enum args: i32 words
//   - float args: bit-cast to i32 (DataView), tagged per-method by the decoder
//   - GL object handles: CPU-minted ids (i32), resolved to real WebGLObjects here
//   - bulk uploads (bufferSubData/texSubImage3D/...): carry (heapByteOffset,
//     byteLength) and are read ZERO-COPY from the shared wasm heap — worker_0
//     never copies the payload, only writes the descriptor (decided by the
//     gl-capture probe: blockingGL=0, so the heap source is safe to read late).
//   - setup-time queries (getUniformLocation/link status/...) are NOT in this
//     ring; they use a separate synchronous round-trip slot (worker_0
//     Atomics.waits) because uniform locations must resolve on THIS context.
//     The per-frame draw stream has zero queries (verified by enumeration).
//
// The METHODS list below defines the opcode numbering. worker_0's producer MUST
// use the identical ordered list (gamecube/gl-stream-methods.js mirrors it).

'use strict';

// Ordered GL method surface (opcode = index). Derived from the live enumeration
// of Dolphin's OGL backend (65 methods). `k` tags how the replay decodes args:
//   's' scalar i32/enum, 'f' float (bit-cast), 'h' handle id, 'H' nullable
//   handle, 'B' bulk (offset,len) heap slice, 'S' string, 'r' returns-handle
//   (create*), 'q' query (sync round-trip; not streamed). Per-method arg specs
//   live in the decoder switch (some GL calls are variadic / overloaded).
const METHODS = [
  /* 0 */  'bindBufferRange', /* 1 */ 'bindFramebuffer', /* 2 */ 'scissor',
  /* 3 */  'bufferSubData',   /* 4 */ 'colorMask',       /* 5 */ 'disable',
  /* 6 */  'viewport',        /* 7 */ 'depthRange',      /* 8 */ 'drawElements',
  /* 9 */  'enable',          /* 10 */ 'framebufferTextureLayer',
  /* 11 */ 'activeTexture',   /* 12 */ 'bindTexture',    /* 13 */ 'createQuery',
  /* 14 */ 'useProgram',      /* 15 */ 'blitFramebuffer',/* 16 */ 'bindVertexArray',
  /* 17 */ 'blendEquationSeparate', /* 18 */ 'blendFuncSeparate',
  /* 19 */ 'bindSampler',     /* 20 */ 'clearColor',     /* 21 */ 'clear',
  /* 22 */ 'depthMask',       /* 23 */ 'drawArrays',     /* 24 */ 'bindAttribLocation',
  /* 25 */ 'clearDepth',      /* 26 */ 'texSubImage3D',  /* 27 */ 'depthFunc',
  /* 28 */ 'enableVertexAttribArray', /* 29 */ 'vertexAttribPointer',
  /* 30 */ 'attachShader',    /* 31 */ 'createTexture',  /* 32 */ 'texParameteri',
  /* 33 */ 'samplerParameteri', /* 34 */ 'createShader', /* 35 */ 'shaderSource',
  /* 36 */ 'compileShader',   /* 37 */ 'texStorage3D',   /* 38 */ 'bindBuffer',
  /* 39 */ 'uniform1i',       /* 40 */ 'createFramebuffer', /* 41 */ 'drawBuffers',
  /* 42 */ 'createProgram',   /* 43 */ 'linkProgram',    /* 44 */ 'deleteShader',
  /* 45 */ 'uniformBlockBinding', /* 46 */ 'texSubImage2D', /* 47 */ 'samplerParameterf',
  /* 48 */ 'createVertexArray', /* 49 */ 'createBuffer', /* 50 */ 'bufferData',
  /* 51 */ 'createSampler',   /* 52 */ 'texStorage2D',   /* 53 */ 'vertexAttribIPointer',
  /* 54 */ 'pixelStorei',     /* 55 */ 'uniformBlockBinding2', // reserved/aliases
  /* 56 */ 'present',         // synthetic: swap/commit at Presenter::Present
];

// ---- ring header layout (mirrors gamecube/ringbuffer.js) ----
const HDR_HEAD = 0, HDR_TAIL = 1, HDR_CAPACITY = 2, HDR_ELEMSIZE = 3, HDR_WORDS = 4;

// ---- ctrl-SAB protocol (mirrors gl-record.js CTRL_*) — setup-time queries ----
const CTRL_FUTEX = 0, CTRL_OPCODE = 1, CTRL_PROGRAM = 2, CTRL_RESULT = 3, CTRL_ARG = 4, CTRL_NAMELEN = 4, CTRL_NAME0 = 5;
const CTRL_AU_SIZE = 3, CTRL_AU_TYPE = 5, CTRL_AU_NAMELEN = 6, CTRL_AU_NAME0 = 7;
const CTRL_GET_UNIFORM_LOC = 1, CTRL_GET_UBLOCK_IDX = 2, CTRL_GET_ACTIVE_UNIFORMS = 3, CTRL_GET_ACTIVE_UNIFORM_AT = 4;

let gl = null;
let canvas = null;
let heapU8 = null;      // Uint8Array over the shared wasm memory (zero-copy uploads)
let heapI32 = null;
let ring = null;        // Int32Array over the command ring (header + storage)
let ringCap = 0;        // element capacity (words)
let ringStore = 0;      // word index where storage begins (= HDR_WORDS)
let ctrl = null;        // Int32Array over the ctrl-SAB sync round-trip slot
let framesPainted = 0;
let started = false;

// CPU-minted id -> real WebGLObject. Index 0 reserved for null.
const objs = [null];
function obj(id) { return id === 0 ? null : objs[id]; }
function setObj(id, o) { objs[id] = o; }

// Render-worker-minted uniform-location id -> real WebGLUniformLocation, plus a
// reverse map so the SAME (program,name) returns a STABLE id across queries.
const locById = [null];                 // locId -> WebGLUniformLocation
const locIdByKey = new Map();           // "progId|name" -> locId
function resolveUniformLoc(progId, name) {
  const key = progId + '|' + name;
  let id = locIdByKey.get(key);
  if (id !== undefined) return id;
  const prog = obj(progId);
  const real = prog ? gl.getUniformLocation(prog, name) : null;
  if (real === null) { locIdByKey.set(key, -1); return -1; } // absent
  id = locById.length;
  locById.push(real);
  locIdByKey.set(key, id);
  return id;
}

const f32 = new Float32Array(1);
const i32f = new Int32Array(f32.buffer);
function asF(i) { i32f[0] = i; return f32[0]; }

let wasmMem = null;        // the shared WebAssembly.Memory (its .buffer grows)
let heapBuf = null;        // the ArrayBuffer heapU8 currently views
let ringByteOff = 0, ringWordsTotal = 0, ctrlByteOff = 0; // embedded-mode offsets (0 = separate-SAB mode)
function reacquireHeap(mem) {
  // wasm memory can grow (ALLOW_MEMORY_GROWTH). For shared memory, growth yields
  // a new, larger SharedArrayBuffer; stale views map only the old range. Re-view
  // whenever mem.buffer identity changes (checked cheaply each drain pass).
  wasmMem = mem;
  heapBuf = mem.buffer;
  heapU8 = new Uint8Array(heapBuf);
  heapI32 = new Int32Array(heapBuf);
  // Embedded-mode ring/ctrl views are into the same buffer — re-view them too.
  if (ringByteOff) ring = new Int32Array(heapBuf, ringByteOff, ringWordsTotal);
  if (ctrlByteOff) ctrl = new Int32Array(heapBuf, ctrlByteOff, 256);
}
function syncHeap() {
  // Re-view if the shared memory grew since the last drain (buffer identity flips).
  if (wasmMem && wasmMem.buffer !== heapBuf) reacquireHeap(wasmMem);
}

function init(msg) {
  canvas = msg.canvas;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: false, depth: true, stencil: true, antialias: false,
      preserveDrawingBuffer: false, premultipliedAlpha: false,
      failIfMajorPerformanceCaveat: false,
    });
  } catch (e) {
    postMessage({ cmd: 'init-failed', reason: 'getContext threw: ' + e });
    return;
  }
  if (!gl) { postMessage({ cmd: 'init-failed', reason: 'webgl2 unavailable on render worker' }); return; }

  reacquireHeap(msg.memory);
  // Ring + ctrl transport. Two modes:
  //  (1) separate SABs (msg.ringSab/ctrlSab) — used when GL runs on worker-main.
  //  (2) embedded in the shared wasm heap at fixed byte offsets
  //      (msg.ringByteOff/ringWords/ctrlByteOff) — used when GL runs on an
  //      emscripten proxy-pthread (JS-object SABs don't propagate to pthreads,
  //      but the shared heap is visible to all threads + this worker).
  if (msg.ringSab) {
    ring = new Int32Array(msg.ringSab);
  } else {
    ringByteOff = msg.ringByteOff; ringWordsTotal = 4 + (msg.ringWords | 0);
    ring = new Int32Array(wasmMem.buffer, ringByteOff, ringWordsTotal);
  }
  ringCap = ring[HDR_CAPACITY];
  ringStore = HDR_WORDS;
  if (msg.ctrlSab) { ctrl = new Int32Array(msg.ctrlSab); ctrlPoll(); }
  else if (msg.ctrlByteOff) { ctrlByteOff = msg.ctrlByteOff; ctrl = new Int32Array(wasmMem.buffer, ctrlByteOff, 256); ctrlPoll(); }

  postMessage({ cmd: 'ready' });
  started = true;
  drainLoop();
}

// Responder for the setup-time synchronous query round-trip. worker_0 packs a
// request and Atomics.notify's FUTEX=1; we resolve against the REAL linked
// program/context and store FUTEX=2 + notify. Bounded-wait poll so we never
// hard-spin when idle.
function ctrlReadName(base, lenWord) {
  const n = ctrl[lenWord];
  if (n <= 0) return '';
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (ctrl[base + (i >> 2)] >> ((i & 3) * 8)) & 0xff;
  return new TextDecoder().decode(bytes);
}
function ctrlService() {
  // Replay all ring commands up to the published HEAD first, so the program this
  // query targets is already created+linked on our context before we resolve.
  drainOnce();
  const op = ctrl[CTRL_OPCODE];
  const progId = ctrl[CTRL_PROGRAM];
  const prog = obj(progId);
  try {
    if (op === CTRL_GET_UNIFORM_LOC) {
      ctrl[CTRL_RESULT] = resolveUniformLoc(progId, ctrlReadName(CTRL_NAME0, CTRL_NAMELEN));
    } else if (op === CTRL_GET_UBLOCK_IDX) {
      const name = ctrlReadName(CTRL_NAME0, CTRL_NAMELEN);
      const idx = prog ? gl.getUniformBlockIndex(prog, name) : 0xFFFFFFFF;
      ctrl[CTRL_RESULT] = (idx === 0xFFFFFFFF) ? -1 : idx; // GL_INVALID_INDEX -> -1
    } else if (op === CTRL_GET_ACTIVE_UNIFORMS) {
      ctrl[CTRL_RESULT] = prog ? gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) : 0;
    } else if (op === CTRL_GET_ACTIVE_UNIFORM_AT) {
      const info = prog ? gl.getActiveUniform(prog, ctrl[CTRL_ARG]) : null;
      if (info) {
        ctrl[CTRL_AU_SIZE] = info.size;
        ctrl[CTRL_AU_TYPE] = info.type;
        const bytes = new TextEncoder().encode(info.name);
        ctrl[CTRL_AU_NAMELEN] = bytes.length;
        const words = (bytes.length + 3) >> 2;
        for (let w = 0; w < words; w++) {
          let v = 0;
          for (let b = 0; b < 4; b++) { const k = w * 4 + b; if (k < bytes.length) v |= bytes[k] << (b * 8); }
          ctrl[CTRL_AU_NAME0 + w] = v;
        }
      } else { ctrl[CTRL_AU_SIZE] = 0; ctrl[CTRL_AU_NAMELEN] = 0; }
    } else {
      ctrl[CTRL_RESULT] = -1;
    }
  } catch (e) {
    ctrl[CTRL_RESULT] = -1; ctrl[CTRL_AU_SIZE] = 0; ctrl[CTRL_AU_NAMELEN] = 0;
    postMessage({ cmd: 'gl-error', op: 'ctrl' + op, msg: '' + (e && e.message ? e.message : e) });
  }
  Atomics.store(ctrl, CTRL_FUTEX, 2);
  Atomics.notify(ctrl, CTRL_FUTEX);
}
// Setup-time query responder. The producer issues ONE request at a time and
// blocks on Atomics.wait until answered, so a bounded-wait poll loop is correct:
// wake on FUTEX==1, service, reschedule. Setup-only — finishes once shaders are
// built; never runs in the steady per-frame loop (verified query-free).
function ctrlPoll() {
  // Service every pending request, bounded by a short Atomics.wait when idle so
  // we share the thread with drainLoop() and the canvas paint.
  if (Atomics.load(ctrl, CTRL_FUTEX) === 1) ctrlService();
  else Atomics.wait(ctrl, CTRL_FUTEX, 0, 4);   // park up to 4ms; wakes on notify
  setTimeout(ctrlPoll, 0);
}

// Decode + execute one command at ring word-offset `p` (already past header
// wrap). Returns the new producer-relative consumed word count for this command
// (opcode + nWords header + nWords body). `a(k)` reads body word k.
function exec(opcode, a, nWords) {
  const g = gl;
  switch (opcode) {
    case 0:  g.bindBufferRange(a(0), a(1), obj(a(2)), a(3), a(4)); break;       // target,index,buffer,offset,size
    case 1:  g.bindFramebuffer(a(0), obj(a(1))); break;
    case 2:  g.scissor(a(0), a(1), a(2), a(3)); break;
    case 3:  g.bufferSubData(a(0), a(1), heapU8, a(2), a(3)); break;            // target,dstOffset, srcHeapByteOff,len (zero-copy view + srcOffset/len)
    case 4:  g.colorMask(!!a(0), !!a(1), !!a(2), !!a(3)); break;
    case 5:  g.disable(a(0)); break;
    case 6:  g.viewport(a(0), a(1), a(2), a(3)); break;
    case 7:  g.depthRange(asF(a(0)), asF(a(1))); break;
    case 8:  g.drawElements(a(0), a(1), a(2), a(3)); break;                     // mode,count,type,offset
    case 9:  g.enable(a(0)); break;
    case 10: g.framebufferTextureLayer(a(0), a(1), obj(a(2)), a(3), a(4)); break;
    case 11: g.activeTexture(a(0)); break;
    case 12: g.bindTexture(a(0), obj(a(1))); break;
    case 13: setObj(a(0), g.createQuery()); break;
    case 14: g.useProgram(obj(a(0))); break;
    case 15: g.blitFramebuffer(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9)); break;
    case 16: g.bindVertexArray(obj(a(0))); break;
    case 17: g.blendEquationSeparate(a(0), a(1)); break;
    case 18: g.blendFuncSeparate(a(0), a(1), a(2), a(3)); break;
    case 19: g.bindSampler(a(0), obj(a(1))); break;
    case 20: g.clearColor(asF(a(0)), asF(a(1)), asF(a(2)), asF(a(3))); break;
    case 21: g.clear(a(0)); break;
    case 22: g.depthMask(!!a(0)); break;
    case 23: g.drawArrays(a(0), a(1), a(2)); break;
    case 24: g.bindAttribLocation(obj(a(0)), a(1), readStr(a, 2)); break;
    case 25: g.clearDepth(asF(a(0))); break;
    case 26: // texSubImage3D(target,level,xo,yo,zo,w,h,d,format,type, heapByteOff)
      g.texSubImage3D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9), heapU8, a(10)); break;
    case 27: g.depthFunc(a(0)); break;
    case 28: g.enableVertexAttribArray(a(0)); break;
    case 29: g.vertexAttribPointer(a(0), a(1), a(2), !!a(3), a(4), a(5)); break;
    case 30: g.attachShader(obj(a(0)), obj(a(1))); break;
    case 31: setObj(a(0), g.createTexture()); break;
    case 32: g.texParameteri(a(0), a(1), a(2)); break;
    case 33: g.samplerParameteri(obj(a(0)), a(1), a(2)); break;
    case 34: setObj(a(0), g.createShader(a(1))); break;
    case 35: g.shaderSource(obj(a(0)), readStr(a, 1)); break;
    case 36: g.compileShader(obj(a(0))); break;
    case 37: g.texStorage3D(a(0), a(1), a(2), a(3), a(4), a(5)); break;
    case 38: g.bindBuffer(a(0), obj(a(1))); break;
    case 39: { const loc = locById[a(0)]; if (loc) g.uniform1i(loc, a(1)); break; } // locId -> real WebGLUniformLocation (resolved via ctrl round-trip)
    case 40: setObj(a(0), g.createFramebuffer()); break;
    case 41: g.drawBuffers(readIntArr(a, 0)); break;
    case 42: setObj(a(0), g.createProgram()); break;
    case 43: g.linkProgram(obj(a(0))); break;
    case 44: g.deleteShader(obj(a(0))); break;
    case 45: g.uniformBlockBinding(obj(a(0)), a(1), a(2)); break;
    case 46: g.texSubImage2D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), heapU8, a(8)); break;
    case 47: g.samplerParameterf(obj(a(0)), a(1), asF(a(2))); break;
    case 48: setObj(a(0), g.createVertexArray()); break;
    case 49: setObj(a(0), g.createBuffer()); break;
    case 50: g.bufferData(a(0), heapU8.subarray(a(1), a(1) + a(2)), a(3)); break;
    case 51: setObj(a(0), g.createSampler()); break;
    case 52: g.texStorage2D(a(0), a(1), a(2), a(3), a(4)); break;
    case 53: g.vertexAttribIPointer(a(0), a(1), a(2), a(3), a(4)); break;
    case 54: g.pixelStorei(a(0), a(1)); break;
    case 56: present(); break;
    default: break; // unknown/reserved opcode: skip (nWords lets us resync)
  }
}

// String packing: [byteLen, ...utf8 bytes packed 4/word]. `base` is body index
// of the byteLen word.
function readStr(a, base) {
  const n = a(base);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (a(base + 1 + (i >> 2)) >> ((i & 3) * 8)) & 0xff;
  return new TextDecoder().decode(bytes);
}
function readIntArr(a, base) {
  const n = a(base);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = a(base + 1 + i);
  return out;
}

function present() {
  framesPainted++;
  // Default framebuffer is presented by the browser at the next paint when the
  // OffscreenCanvas is owned here; no explicit swap needed for the default FB.
  if ((framesPainted & 63) === 0) postMessage({ cmd: 'stats', framesPainted: framesPainted });
}

// SPSC drain: consume all commands currently available (up to the published
// HEAD), executing each. Returns when the ring is caught up. Called both by the
// steady drainLoop and by ctrlService (so a uniform/block query resolves only
// AFTER the program's create/shaderSource/compile/link commands have replayed).
function drainOnce() {
  syncHeap();   // pick up any ALLOW_MEMORY_GROWTH growth before reading uploads
  let tail = Atomics.load(ring, HDR_TAIL);
  for (;;) {
    const head = Atomics.load(ring, HDR_HEAD);
    if ((head - tail) <= 0) break;
    const baseIdx = ringStore + (tail % ringCap);
    const opcode = ring[baseIdx];
    const nWords = ring[ringStore + ((tail + 1) % ringCap)];
    const body0 = tail + 2;
    const a = (k) => ring[ringStore + ((body0 + k) % ringCap)];
    try { exec(opcode, a, nWords); } catch (e) {
      postMessage({ cmd: 'gl-error', op: opcode, msg: '' + (e && e.message ? e.message : e) });
    }
    tail = tail + 2 + nWords;
    Atomics.store(ring, HDR_TAIL, tail);
  }
}

function drainLoop() {
  drainOnce();
  // keep draining; rAF-free tight loop yields via setTimeout(0) to let the event
  // loop service the canvas paint + incoming messages.
  setTimeout(drainLoop, 0);
}

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.cmd === 'init') init(msg);
  else if (msg.cmd === 'grow') reacquireHeap(msg.memory); // heap grew: re-view
};

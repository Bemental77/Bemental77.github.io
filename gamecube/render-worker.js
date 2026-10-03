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
  // Object deletes (APPENDED — lockstep with gl-record.js OP; never renumber 0..56).
  /* 57 */ 'deleteTexture',   /* 58 */ 'deleteFramebuffer', /* 59 */ 'deleteBuffer',
  /* 60 */ 'deleteVertexArray', /* 61 */ 'deleteSampler',   /* 62 */ 'deleteRenderbuffer',
  /* 63 */ 'deleteQuery',     /* 64 */ 'deleteProgram',
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
let lastPresentMs = 0;   // throttle the GPU->main ImageBitmap handoff to ~display refresh
let started = false;

// [main-thread WebGL2 replay, variant A-ii] This file runs in TWO modes:
//   'worker' — the legacy dedicated render Worker that owns a private
//              OffscreenCanvas and ships frames via transferToImageBitmap
//              (the crbug-948249 path: a worker-owned GPU surface).
//   'main'   — the consumer runs on the MAIN THREAD against a WebGL2 context
//              bound directly to #canvas; the default composited swap presents
//              automatically (no worker GPU surface => crash path eliminated).
// MAIN must NEVER call Atomics.wait (forbidden on the main thread) and presents
// via the canvas swap, so present()/ctrl polling/drain pacing/logging are routed
// through ENV. Default is 'worker' so the legacy worker entry is unchanged.
let MODE = 'worker';
function log(s) {
  if (MODE === 'main') { if (typeof self.pageLog === 'function') self.pageLog(s); else console.log(s); }
}
function reportGlError(op, msg) {
  if (MODE === 'main') log('[mtgl] gl-error op=' + op + ' ' + msg);
  else postMessage({ cmd: 'gl-error', op: op, msg: msg });
}

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

// ---- inline texture-upload payload decode (race fix) ----
// texSubImage2D/3D now snapshot their source bytes INTO the ring (producer froze
// them to dodge Dolphin's in-place-overwritten texture StreamBuffer scratch). The
// inline form's body is [...header, byteLen, ...payload words]; we decode the
// payload into this growable scratch Uint8Array and upload from it. Reused across
// calls to avoid per-upload allocation.
let texScratch = new Uint8Array(1 << 20);   // 1MB; grows on demand
// [eager-copy 2026-06-25] Copy `req` bytes from the SAB wasm heap at byte `off` into
// the OWNED texScratch and return a tight view. Passing a live heapU8 (SAB) view to
// texSubImage/bufferData lets the GPU defer-read it; when the SAB heap GROWS
// (ALLOW_MEMORY_GROWTH) the old heapU8 ArrayBuffer DETACHES before that read ->
// "ArrayBufferView not big enough" -> GPU-process fault (the ~frame-40 backlog crash
// the per-frame getError() worked around). texScratch is a plain ArrayBuffer (never
// detached) and WebGL copies it synchronously during the upload (same as the INLINE
// path), so reusing it across uploads within a frame is race-free. This severs the
// backlog at its source, so the heavy per-frame getError() sync can be dropped.
function texHeapSrc(off, req) {
  if (req > texScratch.length) texScratch = new Uint8Array((req + 4096) & ~3);
  texScratch.set(heapU8.subarray(off, off + req));
  return texScratch.subarray(0, req);
}
let _body0 = 0;   // ring-relative word index of the body of the command being executed (drainOnce)
function texInlinePayload(a, lenWordIdx) {
  const n = a(lenWordIdx);                   // byte length
  if (((n + 3) & ~3) > texScratch.length) texScratch = new Uint8Array((n + 4096) & ~3);
  const words = (n + 3) >> 2;
  // Bulk copy straight out of the ring (at most two segments across the wrap). Vertex streams
  // now travel inline at any size (gl-record.js INLINE_STREAM_MAX), so a per-word decode
  // through a(k) would be the hottest loop on this thread.
  const dst = new Int32Array(texScratch.buffer, 0, texScratch.length >> 2);
  const start = (_body0 + lenWordIdx + 1) % ringCap;
  const first = Math.min(words, ringCap - start);
  dst.set(ring.subarray(ringStore + start, ringStore + start + first), 0);
  if (first < words) dst.set(ring.subarray(ringStore, ringStore + (words - first)), first);
  return n;                                  // bytes written to texScratch[0..n)
}

// WebGL's required source byte count for texSubImage(w,h,d,fmt,type) under the
// default UNPACK_ALIGNMENT=4 (Dolphin never sets ROW_LENGTH for these uploads).
// Used to detect when the producer's inline snapshot is undersized so we can fall
// back to the zero-copy heap read instead of throwing GL_INVALID_OPERATION (which
// on a real GPU driver can fault a later draw). Returns 0 for unknown fmt/type so
// the caller treats the snapshot as sufficient (no spurious fallback).
function texReqBytes(w, h, d, fmt, type) {
  let cb; // bytes per channel-group (packed types fix whole-pixel size)
  switch (type) {
    case 0x8363: case 0x8033: case 0x8034: return ((w * 2 + 3) & ~3) * h * d; // 5_6_5/4_4_4_4/5_5_5_1
    case 0x84FA: case 0x8368: return ((w * 4 + 3) & ~3) * h * d;              // 24_8 / 2_10_10_10_REV
  }
  let ch;
  switch (fmt) {
    case 0x1908: case 0x8D99: ch = 4; break;                                  // RGBA / RGBA_INTEGER
    case 0x1907: ch = 3; break;                                               // RGB
    case 0x8227: case 0x8228: case 0x190A: ch = 2; break;                     // RG / RG_INTEGER / LUMINANCE_ALPHA
    case 0x1903: case 0x8D94: case 0x1909: case 0x1906: case 0x1902: ch = 1; break; // RED/RED_INT/LUMINANCE/ALPHA/DEPTH
    case 0x84F9: ch = 1; break;                                               // DEPTH_STENCIL
    default: return 0;                                                        // unknown → assume snapshot OK
  }
  switch (type) {
    case 0x1401: case 0x1400: cb = 1; break;                                  // U_BYTE / BYTE
    case 0x1403: case 0x1402: case 0x140B: cb = 2; break;                     // U_SHORT / SHORT / HALF_FLOAT
    case 0x1405: case 0x1404: case 0x1406: cb = 4; break;                     // U_INT / INT / FLOAT
    default: return 0;                                                        // unknown → assume snapshot OK
  }
  const rowBytes = (w * ch * cb + 3) & ~3;     // align rows to 4
  return rowBytes * h * d;
}


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
  // [bitmaprenderer present, crbug 948249] We are NO LONGER handed the on-screen canvas
  // (it stays main-thread to dodge the worker-overlay SharedImage teardown wall ~512).
  // Render into our OWN private OffscreenCanvas and ship each frame to main as a
  // zero-copy ImageBitmap (see present()). desynchronized is REMOVED: web evidence
  // (developer.chrome.com/blog/desynchronized + chromium graphics-dev) shows it FORCES
  // the SingleBuffer/overlay present path that is broken on Mac — the opposite of what
  // we want. A private offscreen surface is composited via transferToImageBitmap, never
  // scanned out. preserveDrawingBuffer:false is required so transferToImageBitmap takes
  // the freshly-drawn buffer and resets it each frame.
  canvas = msg.canvas || new OffscreenCanvas(msg.rwWidth || 640, msg.rwHeight || 528);
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
    case 3:
      // Two forms (producer disambiguates by nWords):
      //  zero-copy (nWords==4): [target, dstOff, srcHeapByteOff, len]
      //  INLINE  (nWords>4):    [target, dstOff, byteLen, ...payload] — the [ubo]
      //    race fix snapshots UNIFORM_BUFFER bytes into the ring. Consumer-side
      //    decode was LOST in the render-worker reset; without it case 3 misread
      //    the inline payload as (srcOff,len) → garbage len (e.g. 994888909) →
      //    GL_INVALID_VALUE → empty uniforms → collapsed/black draws.
      if (nWords > 4) {
        const n = texInlinePayload(a, 2);   // decodes a(2)=byteLen + payload into texScratch
        g.bufferSubData(a(0), a(1), texScratch.subarray(0, n), 0, n);
      } else {
        g.bufferSubData(a(0), a(1), heapU8, a(2), a(3));   // target,dstOffset, srcHeapByteOff,len
      }
      break;
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
      // nWords==11 → zero-copy (read heapU8 at off=a(10)). nWords>11 → INLINE:
      // body is [..10 hdr, off, byteLen, ...payload]; decode the snapshot and
      // upload from texScratch (frozen at record time → race-free).
      {
        // INLINE snapshot (texScratch) when present and big enough; otherwise EAGER-COPY
        // the heap source into the owned texScratch (texHeapSrc). Never hand texSubImage a
        // live heapU8 (SAB) view — it detaches on heap growth before the deferred GPU read.
        // _req==0 means unknown fmt/type (texReqBytes can't size it) → keep the raw heap
        // path as a last resort (rare).
        const _req = texReqBytes(a(5), a(6), a(7), a(8), a(9));
        if (nWords > 11) {
          const n = texInlinePayload(a, 11);
          if (n >= _req && _req > 0)
            g.texSubImage3D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9), texScratch.subarray(0, n), 0);
          else if (_req > 0)
            g.texSubImage3D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9), texHeapSrc(a(10), _req), 0);
          else
            g.texSubImage3D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9), heapU8, a(10));
        } else if (_req > 0) {
          g.texSubImage3D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9), texHeapSrc(a(10), _req), 0);
        } else {
          g.texSubImage3D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), a(8), a(9), heapU8, a(10));
        }
      }
      break;
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
    case 46: // texSubImage2D: nWords==9 → zero-copy; nWords>9 → INLINE snapshot.
      {
        // Same eager-copy discipline as the 3D path (case 26): never hand a live SAB view.
        const _req = texReqBytes(a(4), a(5), 1, a(6), a(7));
        if (nWords > 9) {
          const n = texInlinePayload(a, 9);
          if (n >= _req && _req > 0)
            g.texSubImage2D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), texScratch.subarray(0, n), 0);
          else if (_req > 0)
            g.texSubImage2D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), texHeapSrc(a(8), _req), 0);
          else
            g.texSubImage2D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), heapU8, a(8));
        } else if (_req > 0) {
          g.texSubImage2D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), texHeapSrc(a(8), _req), 0);
        } else {
          g.texSubImage2D(a(0), a(1), a(2), a(3), a(4), a(5), a(6), a(7), heapU8, a(8));
        }
      }
      break;
    case 47: g.samplerParameterf(obj(a(0)), a(1), asF(a(2))); break;
    case 48: setObj(a(0), g.createVertexArray()); break;
    case 49: setObj(a(0), g.createBuffer()); break;
    case 50:
      // a(1)==0xFFFFFFFF (i32 -1) → ALLOCATE-ONLY form: glBufferData(target,size,usage)
      // with NO data (Dolphin allocates streaming/uniform buffers this way, then
      // fills via bufferSubData). The old code fed heapU8.subarray(0xFFFFFFFF,...)
      // = an EMPTY view → every streaming buffer was 0 bytes → every later
      // bufferSubData failed GL_INVALID_VALUE → every draw failed
      // GL_INVALID_OPERATION → black canvas. Honor the sentinel: allocate by size.
      if ((a(1) | 0) === -1) {
        g.bufferData(a(0), a(2) >>> 0, a(3));
      }
      // EAGER-COPY: same heap-growth-detach hazard as texSubImage — bufferData also
      // defers reading its source view, so copy out of the SAB into owned texScratch.
      else { g.bufferData(a(0), texHeapSrc(a(1), a(2) >>> 0), a(3)); }
      break;
    case 51: setObj(a(0), g.createSampler()); break;
    case 52: g.texStorage2D(a(0), a(1), a(2), a(3), a(4)); break;
    case 53: g.vertexAttribIPointer(a(0), a(1), a(2), a(3), a(4)); break;
    case 54: g.pixelStorei(a(0), a(1)); break;
    case 56: present(); _hitPresent = true; break;
    // Object deletes — free the REAL GL object on this (canvas-owning) context
    // AND clear the objs[] slot so the JS wrapper can be GC'd and the id table's
    // live set stays bounded. This is what releases the per-frame XFB/EFB-copy/
    // render-target IOSurfaces that TextureCache::Cleanup evicts, so the GPU
    // shared-image count never reaches the ~512 wall.
    case 57: { const o = obj(a(0)); if (o) g.deleteTexture(o);      objs[a(0)] = null; break; }
    case 58: { const o = obj(a(0)); if (o) g.deleteFramebuffer(o);  objs[a(0)] = null; break; }
    case 59: { const o = obj(a(0)); if (o) g.deleteBuffer(o);       objs[a(0)] = null; break; }
    case 60: { const o = obj(a(0)); if (o) g.deleteVertexArray(o);  objs[a(0)] = null; break; }
    case 61: { const o = obj(a(0)); if (o) g.deleteSampler(o);      objs[a(0)] = null; break; }
    case 62: { const o = obj(a(0)); if (o) g.deleteRenderbuffer(o); objs[a(0)] = null; break; }
    case 63: { const o = obj(a(0)); if (o) g.deleteQuery(o);        objs[a(0)] = null; break; }
    case 64: { const o = obj(a(0)); if (o) g.deleteProgram(o);      objs[a(0)] = null; break; }
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

// ── MAIN-THREAD PRESENT: NEVER WAIT ON THE GPU (2026-10-03) ──────────────────────────────────
// WHERE THE PAGE ACTUALLY BLOCKED. Mario Party 4 / no WebGPU / SwiftShader: long tasks of 194 s,
// 290 s and 380 s (three runs), and ~200 ms tasks several times a second between them. A main-
// thread CPU profile of one such window is 98.5% `(program)` — native time with NO JavaScript on
// the stack — and timing every replayed GL call found none above 100 ms (getError measured
// 0-2 ms at every one of its syncs). So the wait was not in this file's calls at all: it was the
// browser's own CANVAS COMMIT. chrome://gpu on that box reads "Compositing: Software only", and
// with a software compositor every WebGL canvas that was drawn since the last frame is READ BACK
// SYNCHRONOUSLY on the main thread when the page updates its rendering (a glReadPixels of the
// drawing buffer). A synchronous readback waits for every GPU command queued before it. Nothing
// here ever asked whether the GPU had finished the last frame, so whole seconds of SwiftShader
// work queued up behind each commit, and one commit waited out minutes of it.
//
// THE RULES THIS PATH NOW KEEPS:
//   1. ONE frame is in flight on the GPU. Every present ends in a fenceSync; the next
//      frame is not replayed until that fence reads SIGNALED (getSyncParameter is a cached,
//      non-blocking read in Chrome, refreshed between tasks). Frames the GPU cannot keep up with
//      are dropped at the SOURCE: window.__gcRwBusy() tells the page, which marks them skipRender
//      (their RAM state still lands, so the guest is untouched — only presents are dropped).
//      MEASURED on SwiftShader (Mario Party 4 title fade-in, 900 s run): one frame took 488.8 s
//      of GPU time; this thread's longest task over the whole run was 55 ms after boot, the guest
//      held 59.997 frames/s, and once that frame retired presents ran at 8.05/s. That frame's
//      draws carry vertex data that decodes as positions like 1.3e35 under the declared float
//      layout (see
//      gamecube/docs/webgl2-fallback/TASKS.md) — huge triangles that cost a software rasterizer
//      minutes. Neither flushing nor issuing extra commands while waiting shortened it.
//      NEVER MORE WORK BEHIND A STUCK FRAME. Letting the next frame through when a fence looked
//      stuck (tried with a 1-3 s threshold and up to 4 frames tracked) blocked this thread for
//      446-451 s in four of four runs: once the GPU is genuinely behind, further GL calls wait in
//      Chrome's command transport for it. So it is one frame in flight, full stop; a frame the
//      GPU is still drawing costs presents, never this thread.
//   2. On a SOFTWARE compositor the WebGL canvas is never composited at all ('readback' mode):
//      the context lives on an OffscreenCanvas, each present reads the frame into a PIXEL_PACK
//      buffer behind the fence, and only once the fence has signaled is it copied out
//      (getBufferSubData on finished data does not wait for the GPU) and painted to #canvas with
//      a 2D putImageData. So the commit has nothing of ours to wait for.
//   3. On a GPU compositor ('direct') the WebGL canvas is composited as before — that commit is
//      a mailbox handoff, not a readback — and rule 1 alone bounds the GPU queue.
//   4. No periodic getError: it was a synchronous round trip kept as a "drain" for an ANGLE-Metal
//      backlog that rule 1 now prevents by construction. ?glerr=1 restores it for debugging.
let rwMode = 'direct';                // 'direct' | 'readback' (set by startMainThreadReplay)
const RW_MAX_INFLIGHT = 1;
let rwFences = [];                    // in-flight frames, oldest first: { sync, at, slot }
let rwPbos = [], rwBuf = null, rwImg = null, rwCtx2d = null, rwW = 0, rwH = 0;
let rwSentReplayed = -1, rwSentAt = 0;  // a frame the page sent that has not reached the ring yet
const RW_GLERR = (typeof location !== 'undefined') && /[?&]glerr=1\b/.test(location.search);
const rwStats = { replayed: 0, completed: 0, superseded: 0, fenceMaxMs: 0, readbackMaxMs: 0, sent: 0 };
if (typeof self !== 'undefined') self.__rwStats = rwStats;

function rwFreeSlot() {
  for (let k = 0; k < RW_MAX_INFLIGHT; k++) if (!rwFences.some((f) => f.slot === k)) return k;
  return 0;
}
function rwIssueReadback(slot) {
  const g = gl;
  const prevRead = g.getParameter(g.READ_FRAMEBUFFER_BINDING);
  const prevPack = g.getParameter(g.PIXEL_PACK_BUFFER_BINDING);
  const pr = g.getParameter(g.PACK_ROW_LENGTH), psr = g.getParameter(g.PACK_SKIP_ROWS);
  const psp = g.getParameter(g.PACK_SKIP_PIXELS), pa = g.getParameter(g.PACK_ALIGNMENT);
  g.bindFramebuffer(g.READ_FRAMEBUFFER, null);
  g.bindBuffer(g.PIXEL_PACK_BUFFER, rwPbos[slot]);
  if (pr) g.pixelStorei(g.PACK_ROW_LENGTH, 0);
  if (psr) g.pixelStorei(g.PACK_SKIP_ROWS, 0);
  if (psp) g.pixelStorei(g.PACK_SKIP_PIXELS, 0);
  if (pa !== 4) g.pixelStorei(g.PACK_ALIGNMENT, 4);
  g.readPixels(0, 0, rwW, rwH, g.RGBA, g.UNSIGNED_BYTE, 0);
  if (pr) g.pixelStorei(g.PACK_ROW_LENGTH, pr);
  if (psr) g.pixelStorei(g.PACK_SKIP_ROWS, psr);
  if (psp) g.pixelStorei(g.PACK_SKIP_PIXELS, psp);
  if (pa !== 4) g.pixelStorei(g.PACK_ALIGNMENT, pa);
  g.bindBuffer(g.PIXEL_PACK_BUFFER, prevPack);
  g.bindFramebuffer(g.READ_FRAMEBUFFER, prevRead);
}
function rwFinishReadback(slot) {
  const g = gl, t0 = performance.now();
  const prevPack = g.getParameter(g.PIXEL_PACK_BUFFER_BINDING);
  g.bindBuffer(g.PIXEL_PACK_BUFFER, rwPbos[slot]);
  // This slot's fence has signaled and no later readback targets this buffer (one buffer per
  // in-flight slot), so the copy-out has no GPU work to wait for.
  g.getBufferSubData(g.PIXEL_PACK_BUFFER, 0, rwBuf);
  g.bindBuffer(g.PIXEL_PACK_BUFFER, prevPack);
  // readPixels rows are bottom-up; ImageData is top-down.
  const row = rwW * 4, dst = rwImg.data;
  for (let y = 0; y < rwH; y++) dst.set(rwBuf.subarray((rwH - 1 - y) * row, (rwH - y) * row), y * row);
  rwCtx2d.putImageData(rwImg, 0, 0);
  const dt = performance.now() - t0;
  if (dt > rwStats.readbackMaxMs) rwStats.readbackMaxMs = dt;
}
// Non-blocking: retire (and, in readback mode, paint) every in-flight frame whose fence has
// signaled, oldest first. Fences signal in submission order.
function rwPollFence() {
  while (rwFences.length) {
    const f = rwFences[0];
    if (gl.getSyncParameter(f.sync, gl.SYNC_STATUS) !== gl.SIGNALED) break;
    gl.deleteSync(f.sync); rwFences.shift();
    const dt = performance.now() - f.at;
    if (dt > rwStats.fenceMaxMs) rwStats.fenceMaxMs = dt;
    if (rwMode === 'readback') {
      try { rwFinishReadback(f.slot); } catch (e) { reportGlError('readback', '' + (e && e.message ? e.message : e)); }
    }
    rwStats.completed++;
    rwCountFps();
  }
  return rwFences.length === 0;
}
// May the next frame be replayed now? Only when nothing is in flight (see rule 1).
function rwCanReplay() { return rwFences.length === 0; }
// The page's source-side frame gate (gamecube.html, recomp 'frame' handler): true while drawing
// another frame would only queue it behind one the GPU has not finished — or behind one already
// sent that has not reached the ring yet (bounded at 1 s, so a frame that never presents cannot
// hold presents down).
function rwBusy() {
  if (!started) return false;
  if (!rwCanReplay()) return true;
  if (Atomics.load(ring, HDR_HEAD) !== Atomics.load(ring, HDR_TAIL)) return true;
  if (rwSentReplayed === rwStats.replayed && (performance.now() - rwSentAt) < 1000) return true;
  return false;
}
function rwNoteSent() { rwSentReplayed = rwStats.replayed; rwSentAt = performance.now(); rwStats.sent++; }
// Introspection for rigs: what the present path is waiting on right now.
function rwState() {
  return { mode: rwMode, started: started, lost: !!(gl && gl.isContextLost && gl.isContextLost()),
           inflight: rwFences.length, fenceAgeMs: rwFences.length ? performance.now() - rwFences[0].at : 0,
           ringPending: started ? (Atomics.load(ring, HDR_HEAD) - Atomics.load(ring, HDR_TAIL)) : 0,
           sentPending: rwSentReplayed === rwStats.replayed, sinceSentMs: performance.now() - rwSentAt,
           stats: Object.assign({}, rwStats) };
}
if (typeof self !== 'undefined') { self.__gcRwBusy = rwBusy; self.__gcRwNoteSent = rwNoteSent; self.__gcRwState = rwState; }

let _fpsFrames = 0, _fpsLastMs = 0;   // main-thread [fps] metric (probe parses these)
function rwCountFps() {
  // Emit the same '[fps]' line the software path logs so the probe's fps metric works on this
  // path too. It counts frames the GPU has FINISHED (and, in readback mode, painted) — not
  // frames merely replayed into a queue.
  _fpsFrames++;
  const now = performance.now();
  if (_fpsLastMs === 0) _fpsLastMs = now;
  else if (now - _fpsLastMs > 1000) {
    const fps = _fpsFrames * 1000 / (now - _fpsLastMs);
    try {
      const fe = (typeof document !== 'undefined') ? document.getElementById('fps') : null;
      if (fe) fe.textContent = 'FPS: ' + fps.toFixed(1);
    } catch (e) {}
    self.__mtglTotalFrames = (self.__mtglTotalFrames || 0) + _fpsFrames;
    console.log('[fps] ' + fps.toFixed(2) + ' @t=' + (now / 1000).toFixed(0) +
                's totalFrames=' + self.__mtglTotalFrames + ' [mtgl ' + rwMode + ']');
    _fpsFrames = 0; _fpsLastMs = now;
  }
}
function present() {
  framesPainted++;
  if (MODE === 'main') {
    rwStats.replayed++;
    // Past the in-flight bound (only ctrlService's full drain or the JIT backlog path can get
    // here) the oldest frame is superseded: its fence is dropped unread, newest wins.
    if (rwFences.length >= RW_MAX_INFLIGHT) {
      const old = rwFences.shift();
      gl.deleteSync(old.sync); rwStats.superseded++;
      // Its readback may still be pending on the GPU, and a readPixels into a buffer the GPU is
      // still writing WAITS for it — MEASURED: present() blocked this thread 100-128 ms per frame,
      // and once 450 s, reusing such a buffer. So the slot gets a fresh buffer; the old one is
      // freed by GL once the GPU is done with it.
      if (rwMode === 'readback') {
        const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.deleteBuffer(rwPbos[old.slot]);
        rwPbos[old.slot] = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, rwPbos[old.slot]);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, rwW * rwH * 4, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
      }
    }
    const slot = rwFreeSlot();
    if (rwMode === 'readback') rwIssueReadback(slot);
    rwFences.push({ sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), at: performance.now(), slot: slot });
    gl.flush();
    if (RW_GLERR && (framesPainted % 240) === 0) {
      const _glerr = gl.getError();
      if (_glerr !== 0) reportGlError('present', 'GL error ' + _glerr);
    }
    return;
  }
  // [bitmaprenderer present] transferToImageBitmap is a ZERO-COPY GPU handoff on Chrome:
  // it hands ownership of the just-drawn GPU bitmap to an ImageBitmap and resets this
  // private canvas to transparent-black (HTML spec). Main displays it via a COMPOSITED
  // 'bitmaprenderer' context inside rAF (newest-wins, stale bitmaps close()d) — the
  // normal main-thread present, one reused surface, no per-present overlay SharedImage
  // -> defeats the ~512-present teardown. flush() so the draws are queued before snapshot.
  // Cap the GPU->main handoff to ~display refresh. The emulator may produce >60 fps
  // (JIT is above native); transferToImageBitmap + postMessage every game frame is
  // wasted work the display can't show and (combined with the ring drain) back-pressures
  // the CPU worker. Snapshot the LATEST drawn frame at most ~once per 15ms; intermediate
  // frames still drew to this canvas (each present-blit redraws the full XFB), so the
  // snapshot is always a complete, current frame.
  if (gl && typeof canvas.transferToImageBitmap === 'function') {
    gl.flush();
    const bmp = canvas.transferToImageBitmap();
    postMessage({ cmd: 'frame', bitmap: bmp }, [bmp]);
  }
  if ((framesPainted & 63) === 0) postMessage({ cmd: 'stats', framesPainted: framesPainted });
}

// SPSC drain: consume all commands currently available (up to the published
// HEAD), executing each. Returns when the ring is caught up. Called both by the
// steady drainLoop and by ctrlService (so a uniform/block query resolves only
// AFTER the program's create/shaderSource/compile/link commands have replayed).
//
// `stopAtPresent` (main-thread replay only): return TRUE the moment a `present`
// opcode (56) is executed, leaving the rest of the ring for the next turn. This
// paces the replay to ONE frame per rAF turn so the browser composites + swaps
// (and the driver recycles that frame's GPU resources / zero-copy upload views)
// between frames. Without it, a dolphin worker running ahead replays several
// frames' commands in one turn; on ANGLE-Metal the un-presented command buffer +
// its referenced upload sources pile up until the GPU process faults (observed:
// `texSubImage3D: ArrayBufferView not big enough` then a frozen black canvas).
// ctrlService passes false so setup-time queries still drain the whole ring.
let _hitPresent = false;
function drainOnce(stopAtPresent) {
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
    _body0 = body0;
    _hitPresent = false;
    try { exec(opcode, a, nWords); } catch (e) {
      reportGlError(opcode, '' + (e && e.message ? e.message : e));
    }
    tail = tail + 2 + nWords;
    Atomics.store(ring, HDR_TAIL, tail);
    if (stopAtPresent && _hitPresent) return true;   // one frame this turn; yield
  }
  return false;
}

let _mpLast = 0, _mpMaxReplay = 0, _mpMaxGap = 0, _mpMaxDrained = 0, _mpLastLogged = -1;   // [mainprof TEMP 2026-06-26]
// [decoupled drain 2026-06-26] Drive the drain off a MessageChannel macrotask instead of
// requestAnimationFrame. Measured: rAF was firing at ~1Hz on this foreground page (gating present
// FAR below the worker's production rate) while the main thread sat idle. MessageChannel is not
// vsync/compositor-coupled, so it can't be throttled that way; the browser still composites #canvas
// on its own ~60Hz schedule (showing the latest frame we drew), so the visible swap stays paced.
let _drainPort = null;
function _scheduleDrain() {
  if (!_drainPort) {
    const _mc = new MessageChannel();
    _mc.port1.onmessage = drainLoop;
    _drainPort = _mc.port2;
  }
  _drainPort.postMessage(0);
}
function drainLoop() {
  if (MODE === 'main') {
    const _t0 = performance.now();
    // ONE FRAME IN FLIGHT (see MAIN-THREAD PRESENT above). The old loop replayed up to 8 queued
    // frames per turn toward the newest, all of them into the GPU queue, with nothing asking
    // whether the GPU had finished any of them. Now: finish (and, in readback mode, paint) the
    // in-flight frame once its fence has signaled, and only then replay the next one. Stale
    // frames are dropped before they are drawn (the page's skipRender gate), so there is no
    // backlog here to catch up on.
    let drained = 0;
    // The JIT engine has no source-side gate (only the recomp's frame relay asks __gcRwBusy), so
    // its producer can run ahead and fill the ring; past a quarter of it, replay without waiting
    // (the newer present supersedes the in-flight one) so the producer is never stalled on it.
    rwPollFence();
    if ((rwCanReplay() || (Atomics.load(ring, HDR_HEAD) - Atomics.load(ring, HDR_TAIL)) > (ringCap >> 2)) && drainOnce(true)) drained = 1;
    const _t1 = performance.now();
    if (ctrl) ctrlServiceMain();   // setup-time uniform queries (capped at 12ms/turn)
    const _t2 = performance.now();
    const _replay = _t1 - _t0, _gap = _mpLast ? (_t0 - _mpLast) : 0;
    if (_replay > _mpMaxReplay) _mpMaxReplay = _replay;
    if (_gap > _mpMaxGap) _mpMaxGap = _gap;
    if (drained > _mpMaxDrained) _mpMaxDrained = drained;
    // Logged once per 64 presented frames, never on an idle poll.
    if ((framesPainted >> 6) !== _mpLastLogged) {
      _mpLastLogged = framesPainted >> 6;
      console.log('[mainprof] f=' + framesPainted + ' mode=' + rwMode +
        ' replay(now/max)=' + _replay.toFixed(1) + '/' + _mpMaxReplay.toFixed(1) + 'ms' +
        ' gap(now/max)=' + _gap.toFixed(1) + '/' + _mpMaxGap.toFixed(1) + 'ms' +
        ' completed=' + rwStats.completed + ' superseded=' + rwStats.superseded +
        ' fenceMax=' + rwStats.fenceMaxMs.toFixed(0) + 'ms readbackMax=' + rwStats.readbackMaxMs.toFixed(1) + 'ms');
      _mpMaxReplay = 0; _mpMaxGap = 0; _mpMaxDrained = 0;
    }
    _mpLast = _t2;
    // A partial frame still in the ring (no present yet) is picked up on the next turn; an
    // in-flight fence is polled every 2 ms (its status only refreshes between tasks anyway).
    if (rwCanReplay() && Atomics.load(ring, HDR_HEAD) !== Atomics.load(ring, HDR_TAIL)) _scheduleDrain();
    else setTimeout(_scheduleDrain, rwFences.length ? 2 : 4);
  } else {
    drainOnce(false);
    setTimeout(drainLoop, 16);
  }
}

// [main-thread WebGL2 replay] Non-blocking ctrl responder. The worker path uses
// Atomics.wait to park (ctrlPoll), which THROWS on the main thread. Here we just
// check FUTEX==1 each drain turn and service synchronously; the producer
// (gl-record on the dolphin worker) is the one that blocks on Atomics.wait for
// the answer — so a poll on our side is correct and never blocks the UI thread.
let _ctrlTotal = 0, _ctrlTurns = 0;
function ctrlServiceMain() {
  // Service requests published since the last turn (setup is bursty). Each ctrlService() is a
  // REAL GL uniform query on this (page main) thread; an unbounded loop ran up to 4096/turn and
  // froze the page 11.4s (the rAF-handler [longtask]). [ctrl-cap 2026-06-26] Bound the wall-clock
  // per turn so the page can never freeze; the rest drains next turn. [ctrlprof] reports the
  // sustained per-turn query count so the real speed fix (cut the flood) can be targeted.
  const _deadline = performance.now() + 12;
  let n = 0;
  while (Atomics.load(ctrl, CTRL_FUTEX) === 1 && n < 4096) {
    ctrlService(); n++;
    if (performance.now() >= _deadline) break;
  }
  if (n > 0) {
    _ctrlTotal += n; _ctrlTurns++;
    if ((_ctrlTurns & 31) === 0)
      console.log('[ctrlprof] serviced=' + n + '/turn  cumTotal=' + _ctrlTotal +
        ' (each = a real GL uniform query on the main thread)');
  }
}

// [main-thread WebGL2 replay, variant A-ii] Entry point for running the GL
// command-stream replay on the MAIN THREAD against a WebGL2 context bound to
// #canvas. opts: { gl, canvas, memory, ringByteOff, ringWords, ctrlByteOff }.
// Returns false if the context is missing/lost (caller routes to software).
function startMainThreadReplay(opts) {
  MODE = 'main';
  // [longtask TEMP 2026-06-26] Name what blocks the PAGE main thread during the [mainprof] gap.
  // If a 1-2.7s task shows up here -> that script is the gate; if NOTHING shows while the gap is
  // still seconds -> rAF itself is being throttled (not a JS task), a different fix. REMOVE after.
  try {
    new PerformanceObserver(function (list) {
      for (var i = 0, es = list.getEntries(); i < es.length; i++) {
        var e = es[i];
        if (e.duration > 150) {
          var a = (e.attribution && e.attribution[0]) ? e.attribution[0] : {};
          console.log('[longtask] ' + e.duration.toFixed(0) + 'ms name=' + e.name +
            ' container=' + (a.containerType || '?') + '/' + (a.containerName || '?') +
            '/' + (a.containerSrc || '?'));
        }
      }
    }).observe({ entryTypes: ['longtask'] });
    console.log('[longtask] observer armed (>150ms tasks on the page main thread)');
  } catch (_e) { console.log('[longtask] observer unavailable: ' + _e); }
  gl = opts.gl;
  canvas = opts.canvas;
  if (!gl || (typeof gl.isContextLost === 'function' && gl.isContextLost())) {
    log('[mtgl] startMainThreadReplay: no/lost WebGL2 context');
    return false;
  }
  reacquireHeap(opts.memory);
  ringByteOff = opts.ringByteOff; ringWordsTotal = 4 + (opts.ringWords | 0);
  ring = new Int32Array(wasmMem.buffer, ringByteOff, ringWordsTotal);
  ringCap = ring[HDR_CAPACITY];
  ringStore = HDR_WORDS;
  if (opts.ctrlByteOff) { ctrlByteOff = opts.ctrlByteOff; ctrl = new Int32Array(wasmMem.buffer, ctrlByteOff, 256); }
  // 'readback': the context is on an OffscreenCanvas the compositor never sees, and frames are
  // painted to opts.display (a 2D canvas) once the GPU has finished them. See MAIN-THREAD PRESENT.
  if (opts.mode === 'readback' && opts.display) {
    rwW = gl.drawingBufferWidth; rwH = gl.drawingBufferHeight;
    rwCtx2d = opts.display.getContext('2d', { alpha: false });
    if (!rwCtx2d) { log('[mtgl] readback mode: no 2D context on the display canvas'); return false; }
    const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    for (let k = 0; k < RW_MAX_INFLIGHT; k++) {
      rwPbos[k] = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, rwPbos[k]);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, rwW * rwH * 4, gl.STREAM_READ);
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
    rwBuf = new Uint8Array(rwW * rwH * 4);
    rwImg = rwCtx2d.createImageData(rwW, rwH);
    rwMode = 'readback';
  } else rwMode = 'direct';
  started = true;
  log('[mtgl] main-thread WebGL2 replay started (ringCap=' + ringCap + ' words, present=' + rwMode +
      (rwMode === 'readback' ? ' ' + rwW + 'x' + rwH : '') + ')');
  drainLoop();
  return true;
}
if (typeof self !== 'undefined') self.__gcStartMainThreadReplay = startMainThreadReplay;

// Worker-mode message entry. Only bind when actually running inside a dedicated
// Worker (no `window`) — loading this file as a <script> on the main thread for
// startMainThreadReplay() must NOT clobber window.onmessage.
if (typeof window === 'undefined' && typeof self !== 'undefined') {
  self.onmessage = function (e) {
    const msg = e.data;
    if (msg.cmd === 'init') init(msg);
    else if (msg.cmd === 'grow') reacquireHeap(msg.memory); // heap grew: re-view
  };
}

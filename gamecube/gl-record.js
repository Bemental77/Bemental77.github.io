// gl-record.js — the PRODUCER half of FIX #1's GL-stream offload. Runs on
// worker_0 (dolphin_worker). Builds a recording object that stands in for the
// real WebGL2 context: every draw/state/upload call is encoded into the SAB
// command ring (consumed + replayed by render-worker.js, which owns the canvas).
//
// This file MUST stay byte-compatible with render-worker.js: the METHODS order
// here defines the opcodes, and each encoder packs args in exactly the order the
// consumer's exec() switch reads them. Keep the two in lockstep.
//
// Object handles: create* mint a monotonic CPU id (returned to the caller as a
// tagged fake "WebGLObject" so emscripten's GL bookkeeping is satisfied) and the
// id is what crosses the ring; render-worker resolves id->real object.
//
// Uploads (bufferSubData/texSubImage3D/texSubImage2D/bufferData): ZERO-COPY —
// the encoder writes (heapByteOffset, byteLength) descriptors; the payload
// stays in the shared wasm heap and render-worker reads it directly. Safe
// because the GL stream has no blocking fences (gl-capture: blockingGL=0) and
// the ring is drained promptly; double-buffering of dynamic vertex data is the
// guest's own (Dolphin StreamBuffer rotates regions).
//
// Setup-time queries (getUniformLocation, link/compile status, caps) are NOT
// streamed: caps come from a tiny worker_0-side query-only WebGL2 context;
// context-specific handles (uniform locations) use a synchronous round-trip
// (Atomics.wait on a dedicated SAB slot while render-worker resolves). The
// per-frame draw stream is query-free (verified by enumeration), so this never
// stalls a frame.

'use strict';

const HDR_HEAD = 0, HDR_TAIL = 1, HDR_CAPACITY = 2, HDR_ELEMSIZE = 3, HDR_WORDS = 4;

// Opcode order — MUST equal render-worker.js METHODS.
const OP = {
  bindBufferRange: 0, bindFramebuffer: 1, scissor: 2, bufferSubData: 3, colorMask: 4,
  disable: 5, viewport: 6, depthRange: 7, drawElements: 8, enable: 9,
  framebufferTextureLayer: 10, activeTexture: 11, bindTexture: 12, createQuery: 13,
  useProgram: 14, blitFramebuffer: 15, bindVertexArray: 16, blendEquationSeparate: 17,
  blendFuncSeparate: 18, bindSampler: 19, clearColor: 20, clear: 21, depthMask: 22,
  drawArrays: 23, bindAttribLocation: 24, clearDepth: 25, texSubImage3D: 26, depthFunc: 27,
  enableVertexAttribArray: 28, vertexAttribPointer: 29, attachShader: 30, createTexture: 31,
  texParameteri: 32, samplerParameteri: 33, createShader: 34, shaderSource: 35,
  compileShader: 36, texStorage3D: 37, bindBuffer: 38, uniform1i: 39, createFramebuffer: 40,
  drawBuffers: 41, createProgram: 42, linkProgram: 43, deleteShader: 44, uniformBlockBinding: 45,
  texSubImage2D: 46, samplerParameterf: 47, createVertexArray: 48, createBuffer: 49,
  bufferData: 50, createSampler: 51, texStorage2D: 52, vertexAttribIPointer: 53,
  pixelStorei: 54, present: 56,
};

const f32 = new Float32Array(1);
const i32f = new Int32Array(f32.buffer);
function fbits(x) { f32[0] = x; return i32f[0]; }      // float -> i32 bit pattern

// Tagged fake handle so id round-trips through GL object args. We return small
// boxed objects; the encoder reads .__id.
function mintHandle(id) { return { __id: id }; }
function idOf(h) { return (h && h.__id) ? h.__id : 0; }

// ---- ctrl-SAB sync round-trip layout (worker_0 <-> render-worker) ----
// A separate small i32 SAB used ONLY for setup-time queries that must resolve
// on the render-worker's drawing context (uniform locations, uniform-block
// indices). Per the GL-surface enumeration these never fire per-frame, so the
// Atomics.wait below never stalls a draw frame.
//   [0] FUTEX   : 0 idle, 1 request pending (worker_0 stores 1 + notify),
//                 2 response ready (render-worker stores 2 + notify)
//   [1] OPCODE  : CTRL_GET_UNIFORM_LOC | CTRL_GET_UBLOCK_IDX
//   [2] PROGRAM : CPU id of the program
//   [3] RESULT  : returned i32 (location id / block index, -1 if absent)
//   [4]         : name byteLen
//   [5..]       : name utf8 packed 4/word
// Layout: [0]=FUTEX [1]=OPCODE [2]=PROGRAM [3]=RESULT [4]=ARG (index for
// getActiveUniform) / NAMELEN (for name-keyed queries). For getActiveUniform the
// render-worker writes back: [3]=size, [5]=type, [6]=nameLen, [7..]=name utf8.
const CTRL_FUTEX = 0, CTRL_OPCODE = 1, CTRL_PROGRAM = 2, CTRL_RESULT = 3, CTRL_ARG = 4, CTRL_NAMELEN = 4, CTRL_NAME0 = 5;
const CTRL_AU_SIZE = 3, CTRL_AU_TYPE = 5, CTRL_AU_NAMELEN = 6, CTRL_AU_NAME0 = 7;
const CTRL_GET_UNIFORM_LOC = 1, CTRL_GET_UBLOCK_IDX = 2, CTRL_GET_ACTIVE_UNIFORMS = 3, CTRL_GET_ACTIVE_UNIFORM_AT = 4;

class GLRecorder {
  // ring/ctrl may each be: a SharedArrayBuffer (whole-buffer view), OR an
  // already-constructed Int32Array view (e.g. a bounded view into the shared
  // wasm heap at a fixed offset — the cross-pthread transport, since JS objects
  // don't propagate to emscripten pthreads but the shared heap is visible to
  // all). Detect and wrap accordingly.
  constructor(ring, heapGetter, queryCtx, ctrl) {
    this.ring = (ring instanceof Int32Array) ? ring : new Int32Array(ring);
    this.cap = this.ring[HDR_CAPACITY];
    this.store = HDR_WORDS;
    this.heap = heapGetter;          // () => Uint8Array over current wasm heap
    this.q = queryCtx;               // tiny local WebGL2 context for caps, or null
    this.ctrl = ctrl ? ((ctrl instanceof Int32Array) ? ctrl : new Int32Array(ctrl)) : null;
    this.nextId = 1;
    this.scratch = new Int32Array(64);
  }

  // Synchronous query round-trip: pack (opcode, programId, name) into the ctrl
  // SAB, flush the command ring (so the render-worker has already created the
  // real program/linked it), wake the render-worker, Atomics.wait for the
  // response, return the resolved i32. Returns -1 if ctrl SAB unavailable.
  ctrlQuery(opcode, programId, name) {
    const c = this.ctrl;
    if (!c) return -1;
    // Ensure all prior create/shaderSource/compile/link commands are visible to
    // the consumer before it tries to resolve against the real program. The ring
    // is SPSC and the consumer drains continuously; HEAD is already published by
    // emit(), so a memory fence via Atomics.load suffices.
    Atomics.load(this.ring, HDR_HEAD);
    const bytes = new TextEncoder().encode(name);
    c[CTRL_OPCODE] = opcode;
    c[CTRL_PROGRAM] = programId | 0;
    c[CTRL_NAMELEN] = bytes.length;
    const words = (bytes.length + 3) >> 2;
    for (let w = 0; w < words; w++) {
      let v = 0;
      for (let b = 0; b < 4; b++) { const i = w * 4 + b; if (i < bytes.length) v |= bytes[i] << (b * 8); }
      c[CTRL_NAME0 + w] = v;
    }
    Atomics.store(c, CTRL_FUTEX, 1);
    Atomics.notify(c, CTRL_FUTEX);
    // Wait for response (FUTEX flips 1 -> 2). Bounded spins keep this safe even
    // if the render-worker is briefly behind.
    while (Atomics.load(c, CTRL_FUTEX) !== 2) {
      Atomics.wait(c, CTRL_FUTEX, 1, 50);
    }
    const r = c[CTRL_RESULT] | 0;
    Atomics.store(c, CTRL_FUTEX, 0);
    return r;
  }

  // getActiveUniform(program, index) -> {name,size,type} (or null). Render-worker
  // writes size at CTRL_AU_SIZE, type at CTRL_AU_TYPE, name (len+utf8) from
  // CTRL_AU_NAMELEN. CTRL_ARG carries the index (no name input).
  ctrlActiveUniform(programId, index) {
    const c = this.ctrl;
    if (!c) return null;
    Atomics.load(this.ring, HDR_HEAD);
    c[CTRL_OPCODE] = CTRL_GET_ACTIVE_UNIFORM_AT;
    c[CTRL_PROGRAM] = programId | 0;
    c[CTRL_ARG] = index | 0;
    Atomics.store(c, CTRL_FUTEX, 1);
    Atomics.notify(c, CTRL_FUTEX);
    while (Atomics.load(c, CTRL_FUTEX) !== 2) { Atomics.wait(c, CTRL_FUTEX, 1, 50); }
    const size = c[CTRL_AU_SIZE] | 0;
    const type = c[CTRL_AU_TYPE] | 0;
    const nameLen = c[CTRL_AU_NAMELEN] | 0;
    let name = '';
    if (nameLen > 0) {
      const bytes = new Uint8Array(nameLen);
      for (let i = 0; i < nameLen; i++) bytes[i] = (c[CTRL_AU_NAME0 + (i >> 2)] >> ((i & 3) * 8)) & 0xff;
      name = new TextDecoder().decode(bytes);
    }
    Atomics.store(c, CTRL_FUTEX, 0);
    return (size === 0 && nameLen === 0) ? null : { name, size: size || 1, type };
  }

  // Reserve + write one command [opcode, nWords, ...words]. Blocks (spin) if the
  // ring is momentarily full — render-worker drains continuously.
  emit(opcode, words, n) {
    const total = 2 + n;
    const ring = this.ring, cap = this.cap, store = this.store;
    for (;;) {
      const head = Atomics.load(ring, HDR_HEAD);
      const tail = Atomics.load(ring, HDR_TAIL);
      if ((cap - (head - tail)) >= total) {
        ring[store + (head % cap)] = opcode;
        ring[store + ((head + 1) % cap)] = n;
        for (let i = 0; i < n; i++) ring[store + ((head + 2 + i) % cap)] = words[i];
        Atomics.store(ring, HDR_HEAD, head + total);
        return;
      }
      // ring full: brief pause; consumer is draining on its own thread.
    }
  }

  e(opcode) { this.emit(opcode, this.scratch, 0); }
  e1(op, a) { const s = this.scratch; s[0] = a | 0; this.emit(op, s, 1); }
  e2(op, a, b) { const s = this.scratch; s[0] = a | 0; s[1] = b | 0; this.emit(op, s, 2); }
  e3(op, a, b, c) { const s = this.scratch; s[0] = a; s[1] = b; s[2] = c; this.emit(op, s, 3); }
  e4(op, a, b, c, d) { const s = this.scratch; s[0] = a; s[1] = b; s[2] = c; s[3] = d; this.emit(op, s, 4); }

  // Pack a JS string as [byteLen, ...utf8 packed 4/word] into scratch from `off`.
  packStr(str, off) {
    const bytes = new TextEncoder().encode(str);
    const s = this.scratch;
    s[off] = bytes.length;
    const words = (bytes.length + 3) >> 2;
    for (let w = 0; w < words; w++) {
      let v = 0;
      for (let b = 0; b < 4; b++) { const i = w * 4 + b; if (i < bytes.length) v |= bytes[i] << (b * 8); }
      s[off + 1 + w] = v;
    }
    return off + 1 + words;
  }
}

// Build a recording object exposing the WebGL2 method surface. `view` resolves
// a wasm pointer (i32) to a heap byte offset for zero-copy uploads.
function makeRecordingGL(rec, fallback) {
  const g = {};
  const s = rec.scratch;
  // ---- object creation (mint id, stream id) ----
  const create = (op) => () => { const id = rec.nextId++; rec.e1(op, id); return mintHandle(id); };
  g.createBuffer = create(OP.createBuffer);
  g.createTexture = create(OP.createTexture);
  g.createFramebuffer = create(OP.createFramebuffer);
  g.createVertexArray = create(OP.createVertexArray);
  g.createSampler = create(OP.createSampler);
  g.createQuery = create(OP.createQuery);
  g.createProgram = create(OP.createProgram);
  g.createShader = (type) => { const id = rec.nextId++; rec.e2(OP.createShader, id, type); return mintHandle(id); };

  // ---- pure state (scalar/enum) ----
  g.enable = (c) => rec.e1(OP.enable, c);
  g.disable = (c) => rec.e1(OP.disable, c);
  g.activeTexture = (t) => rec.e1(OP.activeTexture, t);
  g.depthFunc = (f) => rec.e1(OP.depthFunc, f);
  g.depthMask = (m) => rec.e1(OP.depthMask, m ? 1 : 0);
  g.clear = (m) => rec.e1(OP.clear, m);
  g.clearDepth = (d) => rec.e1(OP.clearDepth, fbits(d));
  g.scissor = (x, y, w, h) => rec.e4(OP.scissor, x, y, w, h);
  g.viewport = (x, y, w, h) => rec.e4(OP.viewport, x, y, w, h);
  g.depthRange = (n, f) => rec.e2(OP.depthRange, fbits(n), fbits(f));
  g.colorMask = (r, gg, b, a) => rec.e4(OP.colorMask, r ? 1 : 0, gg ? 1 : 0, b ? 1 : 0, a ? 1 : 0);
  g.clearColor = (r, gg, b, a) => rec.e4(OP.clearColor, fbits(r), fbits(gg), fbits(b), fbits(a));
  g.blendEquationSeparate = (a, b) => rec.e2(OP.blendEquationSeparate, a, b);
  g.blendFuncSeparate = (a, b, c, d) => rec.e4(OP.blendFuncSeparate, a, b, c, d);
  g.pixelStorei = (a, b) => rec.e2(OP.pixelStorei, a, b);
  g.enableVertexAttribArray = (i) => rec.e1(OP.enableVertexAttribArray, i);
  g.depthFunc = (f) => rec.e1(OP.depthFunc, f);

  // ---- binds (handle args) ----
  g.bindBuffer = (t, h) => rec.e2(OP.bindBuffer, t, idOf(h));
  g.bindTexture = (t, h) => rec.e2(OP.bindTexture, t, idOf(h));
  g.bindVertexArray = (h) => rec.e1(OP.bindVertexArray, idOf(h));
  g.bindSampler = (u, h) => rec.e2(OP.bindSampler, u, idOf(h));
  g.bindFramebuffer = (t, h) => rec.e2(OP.bindFramebuffer, t, idOf(h));
  g.useProgram = (h) => rec.e1(OP.useProgram, idOf(h));
  g.bindBufferRange = (t, i, h, o, sz) => { s[0] = t; s[1] = i; s[2] = idOf(h); s[3] = o; s[4] = sz; rec.emit(OP.bindBufferRange, s, 5); };
  g.framebufferTextureLayer = (t, at, h, lvl, ly) => { s[0] = t; s[1] = at; s[2] = idOf(h); s[3] = lvl; s[4] = ly; rec.emit(OP.framebufferTextureLayer, s, 5); };

  // ---- draws ----
  g.drawElements = (m, c, t, o) => rec.e4(OP.drawElements, m, c, t, o);
  g.drawArrays = (m, f, c) => rec.e3(OP.drawArrays, m, f, c);
  g.drawBuffers = (arr) => { s[0] = arr.length; for (let i = 0; i < arr.length; i++) s[1 + i] = arr[i]; rec.emit(OP.drawBuffers, s, 1 + arr.length); };
  g.blitFramebuffer = (a, b, c, d, e, f, gg, h, mask, filt) => { s[0] = a; s[1] = b; s[2] = c; s[3] = d; s[4] = e; s[5] = f; s[6] = gg; s[7] = h; s[8] = mask; s[9] = filt; rec.emit(OP.blitFramebuffer, s, 10); };

  // ---- vertex attribs ----
  g.vertexAttribPointer = (i, sz, t, norm, stride, off) => { s[0] = i; s[1] = sz; s[2] = t; s[3] = norm ? 1 : 0; s[4] = stride; s[5] = off; rec.emit(OP.vertexAttribPointer, s, 6); };
  g.vertexAttribIPointer = (i, sz, t, stride, off) => { s[0] = i; s[1] = sz; s[2] = t; s[3] = stride; s[4] = off; rec.emit(OP.vertexAttribIPointer, s, 5); };

  // ---- texture/sampler params + storage ----
  g.texParameteri = (t, p, v) => rec.e3(OP.texParameteri, t, p, v);
  g.samplerParameteri = (h, p, v) => rec.e3(OP.samplerParameteri, idOf(h), p, v);
  g.samplerParameterf = (h, p, v) => rec.e3(OP.samplerParameterf, idOf(h), p, fbits(v));
  g.texStorage2D = (t, l, f, w, h) => { s[0] = t; s[1] = l; s[2] = f; s[3] = w; s[4] = h; rec.emit(OP.texStorage2D, s, 5); };
  g.texStorage3D = (t, l, f, w, h, d) => { s[0] = t; s[1] = l; s[2] = f; s[3] = w; s[4] = h; s[5] = d; rec.emit(OP.texStorage3D, s, 6); };

  // ---- program/shader build ----
  g.attachShader = (p, sh) => rec.e2(OP.attachShader, idOf(p), idOf(sh));
  g.compileShader = (sh) => rec.e1(OP.compileShader, idOf(sh));
  g.linkProgram = (p) => rec.e1(OP.linkProgram, idOf(p));
  g.deleteShader = (sh) => rec.e1(OP.deleteShader, idOf(sh));
  g.uniformBlockBinding = (p, idx, bind) => rec.e3(OP.uniformBlockBinding, idOf(p), idx, bind);
  // loc is the integer render-worker locId returned by g.getUniformLocation
  // (emscripten's webglGetUniformLocation passes it straight through). The
  // render-worker maps locId -> real WebGLUniformLocation. locId 0/null => skip.
  g.uniform1i = (loc, v) => { const id = (typeof loc === 'number') ? loc : idOf(loc); if (id) rec.e2(OP.uniform1i, id, v); };
  g.shaderSource = (sh, src) => { s[0] = idOf(sh); const end = rec.packStr(src, 1); rec.emit(OP.shaderSource, s, end); };
  g.bindAttribLocation = (p, idx, name) => { s[0] = idOf(p); s[1] = idx; const end = rec.packStr(name, 2); rec.emit(OP.bindAttribLocation, s, end); };

  // ---- ZERO-COPY uploads: pass heap byte offset + length ----
  // emscripten calls these with (target,..., HEAPU8, srcOffset, length) or with
  // a pointer; we capture the (offset,length) into the shared heap.
  g.bufferSubData = (target, dstOff, srcView, srcOff, len) => {
    const off = (srcView && srcView.byteOffset || 0) + (srcOff || 0);
    const n = (len != null) ? len : (srcView ? srcView.byteLength : 0);
    s[0] = target; s[1] = dstOff; s[2] = off; s[3] = n; rec.emit(OP.bufferSubData, s, 4);
  };
  g.bufferData = (target, srcView, usage) => {
    const off = (srcView && srcView.byteOffset) || 0;
    const n = srcView ? srcView.byteLength : 0;
    s[0] = target; s[1] = off; s[2] = n; s[3] = usage; rec.emit(OP.bufferData, s, 4);
  };
  // Resolve an upload arg pair (srcView, srcOff) to an ABSOLUTE heap byte offset.
  // emscripten calls these two distinct ways:
  //  (a) typed-array view + ELEMENT index: GLctx.texSubImage3D(...,heap,idx)
  //      where heap is HEAPU8/U16/I32/F32 (byteOffset 0) and idx is in elements
  //      -> byteOff = idx * heap.BYTES_PER_ELEMENT.
  //  (b) typed-array view alone (texSubImage2D pixelData / bufferSubData subarray)
  //      -> byteOff = view.byteOffset (srcOff undefined).
  //  (c) PBO path: a bare integer offset (no view) -> use it directly as bytes.
  const heapByteOff = (srcView, srcOff) => {
    if (srcView == null) return (srcOff || 0);                 // (c) PBO byte offset
    const bpe = srcView.BYTES_PER_ELEMENT || 1;
    return (srcView.byteOffset || 0) + ((srcOff || 0) * bpe);  // (a)/(b)
  };
  g.texSubImage3D = (t, lvl, x, y, z, w, h, d, fmt, type, srcView, srcOff) => {
    const off = heapByteOff(srcView, srcOff);
    s[0] = t; s[1] = lvl; s[2] = x; s[3] = y; s[4] = z; s[5] = w; s[6] = h; s[7] = d; s[8] = fmt; s[9] = type; s[10] = off;
    rec.emit(OP.texSubImage3D, s, 11);
  };
  g.texSubImage2D = (t, lvl, x, y, w, h, fmt, type, srcView, srcOff) => {
    const off = heapByteOff(srcView, srcOff);
    s[0] = t; s[1] = lvl; s[2] = x; s[3] = y; s[4] = w; s[5] = h; s[6] = fmt; s[7] = type; s[8] = off;
    rec.emit(OP.texSubImage2D, s, 9);
  };

  // emscripten's GL layer keeps a per-program `currentProgram` it sets in
  // _glUseProgram and reads in webglGetUniformLocation. Provide a writable slot
  // so that machinery doesn't NPE against the recording context.
  g.currentProgram = null;

  // ---- queries ----
  // Two classes, both SETUP-TIME ONLY (verified query-free per frame):
  //   (1) device caps  -> answered locally from rec.q (a real 1x1 WebGL2 ctx).
  //   (2) program/shader/uniform reflection -> answered by the render-worker on
  //       the REAL linked program via the ctrl-SAB synchronous round-trip, then
  //       cached. Link/compile STATUS is safe-faked (the render-worker compiles
  //       the identical source; a real failure surfaces as a gl-error there).
  const q = rec.q;
  g.getParameter = (p) => q ? q.getParameter(p) : 0;          // caps: real local ctx
  g.getSupportedExtensions = () => q ? q.getSupportedExtensions() : [];
  g.getError = () => 0;                                       // real errors surface on render-worker
  g.getProgramInfoLog = () => '';
  g.getShaderInfoLog = () => '';

  // Link/compile status: safe-fake GL_TRUE; GL_INFO_LOG_LENGTH 0. BUT
  // GL_ACTIVE_UNIFORMS (0x8B86=35718) is queried by emscripten's own
  // webglPrepareUniformLocationsBeforeFirstUse — that path needs the REAL count
  // from the render-worker, else emcc builds a bogus uniform table and every
  // getUniformLocation returns -1 (samplers unbound -> black render).
  const GL_DELETE_STATUS = 0x8B80, GL_LINK_STATUS = 0x8B82, GL_VALIDATE_STATUS = 0x8B83;
  const GL_INFO_LOG_LENGTH = 0x8B84, GL_ACTIVE_UNIFORMS = 0x8B86, GL_COMPILE_STATUS = 0x8B81;
  g.getProgramParameter = (p, pname) => {
    if (pname === GL_ACTIVE_UNIFORMS) return rec.ctrlQuery(CTRL_GET_ACTIVE_UNIFORMS, idOf(p), '');
    if (pname === GL_INFO_LOG_LENGTH) return 0;
    return 1; // LINK/DELETE/VALIDATE status -> GL_TRUE
  };
  g.getShaderParameter = (sh, pname) => {
    if (pname === GL_INFO_LOG_LENGTH) return 0;
    return 1; // COMPILE_STATUS -> GL_TRUE
  };
  // Per-index active-uniform reflection: emscripten reads .name + .size to build
  // uniformSizeAndIdsByName. Resolve the real name/size from the render-worker.
  g.getActiveUniform = (p, i) => {
    const packed = rec.ctrlActiveUniform(idOf(p), i);   // {name,size,type} or null
    return packed || { name: 'u' + i, size: 1, type: 0 };
  };
  // Uniform-block index: used ONLY in `!= -1` test + glUniformBlockBinding arg.
  // Must be the REAL index on the render-worker's program (or -1 if absent), so
  // absent blocks (e.g. GSBlock with geometry shaders off) skip the binding.
  g.getUniformBlockIndex = (p, name) => rec.ctrlQuery(CTRL_GET_UBLOCK_IDX, idOf(p), name);
  // Uniform location: resolve a stable render-worker locId for (program,name).
  // The render-worker caches locId -> real WebGLUniformLocation. Returns -1 when
  // absent (Dolphin's only consumer is `loc >= 0` then glUniform1i(loc, unit)).
  // We return a PLAIN INTEGER (not a boxed handle): emscripten's
  // webglGetUniformLocation hands this value straight to g.uniform1i, where
  // idOf() of a number is 0 — so uniform1i must read the raw value, see below.
  g.getUniformLocation = (p, name) => {
    const locId = rec.ctrlQuery(CTRL_GET_UNIFORM_LOC, idOf(p), name);
    return locId < 0 ? null : locId;   // null = absent (falsy, emcc returns -1)
  };

  g.present = () => rec.e(OP.present);

  // Completeness: emscripten's _glXXX and get_proc_address existence-checks read
  // arbitrary GLctx members. For anything we don't explicitly record, fall back
  // to the REAL context (a 1x1 offscreen) so those calls resolve. Recorded draw/
  // state/upload methods take precedence (they're own-properties of `g`).
  if (fallback && typeof Proxy !== 'undefined') {
    return new Proxy(g, {
      get(target, prop) {
        if (prop in target) return target[prop];
        const v = fallback[prop];
        return (typeof v === 'function') ? v.bind(fallback) : v;
      },
      set(target, prop, value) { target[prop] = value; return true; },
      has(target, prop) { return (prop in target) || (prop in fallback); },
    });
  }
  return g;
}

// ctrl-SAB protocol constants shared with render-worker.js (consumer side).
const CTRL = {
  FUTEX: CTRL_FUTEX, OPCODE: CTRL_OPCODE, PROGRAM: CTRL_PROGRAM, RESULT: CTRL_RESULT,
  ARG: CTRL_ARG, NAMELEN: CTRL_NAMELEN, NAME0: CTRL_NAME0,
  AU_SIZE: CTRL_AU_SIZE, AU_TYPE: CTRL_AU_TYPE, AU_NAMELEN: CTRL_AU_NAMELEN, AU_NAME0: CTRL_AU_NAME0,
  GET_UNIFORM_LOC: CTRL_GET_UNIFORM_LOC, GET_UBLOCK_IDX: CTRL_GET_UBLOCK_IDX,
  GET_ACTIVE_UNIFORMS: CTRL_GET_ACTIVE_UNIFORMS, GET_ACTIVE_UNIFORM_AT: CTRL_GET_ACTIVE_UNIFORM_AT,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GLRecorder, makeRecordingGL, OP, mintHandle, idOf, CTRL };
}
if (typeof self !== 'undefined') {
  self.__GLRecord = { GLRecorder, makeRecordingGL, OP, mintHandle, idOf, CTRL };
}

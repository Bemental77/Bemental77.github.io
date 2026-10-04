// gamecube/recomp/rb_instrument.js — COPY-ON-WRITE PAGE LOGGING FOR ROLLBACK, ADDED TO mp4_game.wasm
// AT LOAD TIME.
//
// WHAT ROLLBACK NEEDS. A rollback room rewinds the guest a few frames and re-runs them with the
// inputs that actually happened. That needs the guest's whole state at the start of every frame
// still inside the window. The state is the wasm linear memory below the guest window (MP4's C
// statics, the heap, every fiber stack: ~40 MB) plus MEM1 (24 MB) plus the FST page, and copying
// it measured 13 ms each way on the dev box (tools/gc_netplay_det_test.mjs rollback-cost) — most
// of a 16.7 ms frame, before the frame itself runs. But a frame CHANGES little of it: the same
// rig measured 25 changed 64 KiB pages per frame at p50 and 44 at p95.
//
// SO THE MODULE LOGS ITS OWN WRITES. Every store instruction, memory.copy and memory.fill in the
// module is preceded by a check of a one-byte-per-4-KiB-page bitmap; the FIRST write to a page in
// a frame copies the page's current bytes (its content at the start of the frame) into a free slot
// and logs (page, slot). At the frame boundary the worker turns that log into the frame's UNDO
// record and clears the bitmap bits it set. Rewinding to frame f is then: for every frame from the
// newest back to f, copy each logged slot back over its page. Nothing is copied that the frame did
// not touch, there is no shadow copy of the state, and a solo game never loads this (the worker
// instruments only for a room).
//
// WHY IN THE WASM, NOT IN JS. A JS write barrier would be a call per store. Here the common case
// (page already logged this frame) is one i32.load8_u and a branch; the copy is a memory.copy.
//
// WHAT THE MODULE CANNOT SEE, AND WHO COVERS IT. Writes into linear memory from JS: the worker's
// DVD model (serveDvdRead), and the emscripten glue's fiber switch (it stores the old fiber's
// stack pointer and asyncify rewind id into the fiber struct, and clears the new fiber's entry).
// The worker calls the exported __rb_touch for those pages BEFORE the JS write (recomp_worker.js
// THE ROLLBACK RING). Data segments are written at instantiation, before any logging is armed.
//
// NOTHING ELSE CHANGES. No import is added (that would renumber every function), four functions
// and three types are APPENDED, one export is added, and every instruction that is not a store or a
// bulk-memory op is copied byte for byte. The guest's own memory is bit-identical to the
// uninstrumented module's at every point (the rig compares them: tools/gc_rollback_det_test.mjs);
// the only bytes that differ are the logging region below MEM1, which no fingerprint covers.
//
// Usable from the worker (importScripts) and from Node (require) for the offline check.
(function (root) {
  'use strict';
  // ---- THE LOGGING REGION — in the unused hole between the C heap (~40 MB) and MEM1 (2 GiB).
  // The memory is grown to 0x82000000 before main(), so all of it exists; only touched pages
  // are ever committed. Every address here is BELOW 0x80000000 and ABOVE anything the heap
  // reaches (lowTopScan in the worker never scans above RB.LO).
  const RB = {
    LO:      0x60000000,          // lowest address the region uses (slots start here)
    SLOTS:   0x60000000,          // 4 KiB undo slots, up to SLOTCAP of them
    SLOTCAP: 0x1D000,             // 118,784 slots = 464 MiB of address space (only the peak is committed)
    BITMAP:  0x7F000000,          // one byte per 4 KiB page of linear memory (0x82000 bytes)
    CTRL:    0x7F100000,          // i32 cells, below
    LOG:     0x7F101000,          // (page, slot) pairs for the frame in progress
    LOGCAP:  0x1D000,             // as many entries as there are slots
    FREE:    0x7F200000,          // stack of free slot addresses (i32), SLOTCAP deep
    PAGE_SHIFT: 12,
  };
  // CTRL cells (byte offsets from CTRL)
  RB.C_ENABLED = 0;    // 0 = only mark the bitmap (nothing is logged), 1 = log first writes
  RB.C_LOGN = 4;       // entries in LOG for the frame in progress
  RB.C_LOGCAP = 8;     // capacity of LOG
  RB.C_FREETOP = 12;   // entries on the FREE stack
  RB.C_OVERFLOW = 16;  // nonzero = a first write could not be logged (1 log full, 2 no free slot)
  RB.C_TOUCHES = 20;   // logged first-writes since arming (statistics)
  RB.HI = RB.FREE + RB.SLOTCAP * 4;   // one past the region's last byte

  // ---- LEB128 ------------------------------------------------------------------------------
  function uleb(out, v) { v >>>= 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); }
  function sleb32(out, v) {
    v |= 0;
    for (;;) { const b = v & 0x7f; v >>= 7;
      if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return; }
      out.push(b | 0x80); }
  }

  // A growable byte sink.
  function Sink(cap) { this.b = new Uint8Array(cap || 1 << 16); this.n = 0; }
  Sink.prototype.room = function (k) {
    if (this.n + k <= this.b.length) return;
    let c = this.b.length * 2; while (c < this.n + k) c *= 2;
    const nb = new Uint8Array(c); nb.set(this.b.subarray(0, this.n)); this.b = nb;
  };
  Sink.prototype.byte = function (x) { this.room(1); this.b[this.n++] = x; };
  Sink.prototype.bytes = function (a, s, e) { const k = e - s; this.room(k); this.b.set(a.subarray(s, e), this.n); this.n += k; };
  Sink.prototype.arr = function (a) { this.room(a.length); for (let i = 0; i < a.length; i++) this.b[this.n++] = a[i]; };
  Sink.prototype.uleb = function (v) { const t = []; uleb(t, v); this.arr(t); };
  Sink.prototype.out = function () { return this.b.subarray(0, this.n); };

  // ---- the three appended functions ----------------------------------------------------------
  // memarg helpers: [align, offset] as LEB bytes
  function ma(align, off) { const t = [align]; uleb(t, off); return t; }
  const I32_CONST = 0x41, LOCAL_GET = 0x20, LOCAL_SET = 0x21, LOCAL_TEE = 0x22;
  function touchBody() {
    // (param $pg i32) (local $slot i32) (local $n i32)
    const c = [];
    const ctrlLoad = (o) => { c.push(I32_CONST, 0, 0x28, ...ma(2, RB.CTRL + o)); };            // i32.load
    // bitmap[pg] = 1
    c.push(LOCAL_GET, 0, I32_CONST, 1, 0x3a, ...ma(0, RB.BITMAP));                             // i32.store8
    // if (!enabled) return
    ctrlLoad(RB.C_ENABLED); c.push(0x45, 0x04, 0x40, 0x0f, 0x0b);                              // eqz if return end
    // n = logN; if (n >= logCap) { overflow = 1; return }
    ctrlLoad(RB.C_LOGN); c.push(LOCAL_TEE, 2); ctrlLoad(RB.C_LOGCAP); c.push(0x4f, 0x04, 0x40); // ge_u if
    c.push(I32_CONST, 0, I32_CONST, 1, 0x36, ...ma(2, RB.CTRL + RB.C_OVERFLOW), 0x0f, 0x0b);
    // top = freeTop; if (!top) { overflow = 2; return }
    ctrlLoad(RB.C_FREETOP); c.push(LOCAL_TEE, 1, 0x45, 0x04, 0x40);
    c.push(I32_CONST, 0, I32_CONST, 2, 0x36, ...ma(2, RB.CTRL + RB.C_OVERFLOW), 0x0f, 0x0b);
    // freeTop = top - 1
    c.push(I32_CONST, 0, LOCAL_GET, 1, I32_CONST, 1, 0x6b, LOCAL_TEE, 1, 0x36, ...ma(2, RB.CTRL + RB.C_FREETOP));
    // slot = FREE[top - 1]
    c.push(LOCAL_GET, 1, I32_CONST, 2, 0x74, 0x28, ...ma(2, RB.FREE), LOCAL_SET, 1);
    // LOG[n] = (pg, slot)
    c.push(LOCAL_GET, 2, I32_CONST, 3, 0x74, LOCAL_GET, 0, 0x36, ...ma(2, RB.LOG));
    c.push(LOCAL_GET, 2, I32_CONST, 3, 0x74, LOCAL_GET, 1, 0x36, ...ma(2, RB.LOG + 4));
    // logN = n + 1; touches++
    c.push(I32_CONST, 0, LOCAL_GET, 2, I32_CONST, 1, 0x6a, 0x36, ...ma(2, RB.CTRL + RB.C_LOGN));
    c.push(I32_CONST, 0); ctrlLoad(RB.C_TOUCHES); c.push(I32_CONST, 1, 0x6a, 0x36, ...ma(2, RB.CTRL + RB.C_TOUCHES));
    // memory.copy(slot, pg << 12, 4096)
    c.push(LOCAL_GET, 1, LOCAL_GET, 0, I32_CONST, RB.PAGE_SHIFT, 0x74);
    c.push(I32_CONST); sleb32(c, 4096); c.push(0xfc, 10, 0, 0);
    c.push(0x0b);
    return { locals: [[2, 0x7f]], code: c };
  }
  // rb_copy(dst, src, n) / rb_fill(dst, val, n): touch every page of [dst, dst+n) first.
  function bulkBody(touchIdx, isFill) {
    const c = [];
    c.push(LOCAL_GET, 2, 0x04, 0x40);                                                       // if (n)
    c.push(LOCAL_GET, 0, I32_CONST, RB.PAGE_SHIFT, 0x76, LOCAL_SET, 3);                     // p = dst >>> 12
    c.push(LOCAL_GET, 0, LOCAL_GET, 2, 0x6a, I32_CONST, 1, 0x6b, I32_CONST, RB.PAGE_SHIFT, 0x76, LOCAL_SET, 4); // e
    c.push(0x03, 0x40);                                                                     // loop
    c.push(LOCAL_GET, 3, 0x2d, ...ma(0, RB.BITMAP), 0x45, 0x04, 0x40, LOCAL_GET, 3, 0x10); uleb(c, touchIdx); c.push(0x0b);
    c.push(LOCAL_GET, 3, I32_CONST, 1, 0x6a, LOCAL_TEE, 3, LOCAL_GET, 4, 0x4d, 0x0d, 0);   // ++p <= e: br_if 0
    c.push(0x0b, 0x0b);                                                                     // end loop, end if
    c.push(LOCAL_GET, 0, LOCAL_GET, 1, LOCAL_GET, 2);
    if (isFill) c.push(0xfc, 11, 0); else c.push(0xfc, 10, 0, 0);
    c.push(0x0b);
    return { locals: [[2, 0x7f]], code: c };
  }

  // rb_touchn(ea, size): the slow path of a store — touch the page of its first byte and of its
  // last byte, each only if not yet logged this frame.
  function touchnBody(touchIdx) {
    const c = [];
    c.push(LOCAL_GET, 0, I32_CONST, RB.PAGE_SHIFT, 0x76, LOCAL_TEE, 2);
    c.push(0x2d, ...ma(0, RB.BITMAP), 0x45, 0x04, 0x40, LOCAL_GET, 2, 0x10); uleb(c, touchIdx); c.push(0x0b);
    c.push(LOCAL_GET, 0, LOCAL_GET, 1, 0x6a, I32_CONST, 1, 0x6b, I32_CONST, RB.PAGE_SHIFT, 0x76, LOCAL_TEE, 3);
    c.push(0x2d, ...ma(0, RB.BITMAP), 0x45, 0x04, 0x40, LOCAL_GET, 3, 0x10); uleb(c, touchIdx); c.push(0x0b);
    c.push(0x0b);
    return { locals: [[2, 0x7f]], code: c };
  }
  // ---- the instrumenter ----------------------------------------------------------------------
  // Store opcodes: [bytes written, value type of the stored operand]
  const STORE = { 0x36: [4, 0x7f], 0x37: [8, 0x7e], 0x38: [4, 0x7d], 0x39: [8, 0x7c],
                  0x3a: [1, 0x7f], 0x3b: [2, 0x7f], 0x3c: [1, 0x7e], 0x3d: [2, 0x7e], 0x3e: [4, 0x7e] };

  function rbInstrument(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) throw new Error('not a wasm module');
    let p = 8;
    const rd = () => { let r = 0, s = 0, b; do { b = u8[p++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80); return r; };
    const skipLeb = () => { while (u8[p++] & 0x80); };
    const sections = [];
    while (p < u8.length) {
      const hdr = p, id = u8[p++], len = rd(), start = p;
      sections.push({ id, hdr, start, end: start + len });
      p = start + len;
    }
    const sec = (id) => sections.find((s) => s.id === id);
    // ---- types: params per type, and the count
    const tS = sec(1); if (!tS) throw new Error('no type section');
    p = tS.start;
    const nTypes = rd(); const typeParams = [];
    for (let i = 0; i < nTypes; i++) {
      if (u8[p++] !== 0x60) throw new Error('type ' + i + ' is not a plain function type (GC/rec types are not supported)');
      const np = rd(); p += np; typeParams.push(np);   // value types are single bytes in MVP
      const nr = rd(); p += nr;
    }
    // ---- imports: function import count
    let nImpFuncs = 0;
    const iS = sec(2);
    if (iS) {
      p = iS.start; const n = rd();
      for (let i = 0; i < n; i++) {
        { const ml = rd(); p += ml; const nl = rd(); p += nl; }   // module, name
        const k = u8[p++];
        if (k === 0) { skipLeb(); nImpFuncs++; }
        else if (k === 1) { p++; const f = rd(); skipLeb(); if (f & 1) skipLeb(); }
        else if (k === 2) { const f = rd(); skipLeb(); if (f & 1) skipLeb(); }
        else if (k === 3) { p += 2; }
        else throw new Error('unknown import kind ' + k);
      }
    }
    // ---- functions: type index of each defined function
    const fS = sec(3); if (!fS) throw new Error('no function section');
    p = fS.start; const nFuncs = rd(); const funcType = new Uint32Array(nFuncs);
    for (let i = 0; i < nFuncs; i++) funcType[i] = rd();
    const touchIdx = nImpFuncs + nFuncs, copyIdx = touchIdx + 1, fillIdx = touchIdx + 2, touchnIdx = touchIdx + 3;
    const tTouch = nTypes, tBulk = nTypes + 1, tTouchn = nTypes + 2;

    // ---- code: rewrite every body
    const cS = sec(10); if (!cS) throw new Error('no code section');
    p = cS.start;
    const nBodies = rd(); if (nBodies !== nFuncs) throw new Error('function/code count mismatch');
    const code = new Sink(Math.floor((cS.end - cS.start) * 1.9) + 4096);
    const body = new Sink(1 << 16);
    const stats = { stores: 0, copies: 0, fills: 0, bodies: nBodies };
    for (let fi = 0; fi < nBodies; fi++) {
      const bsize = rd(), bend = p + bsize;
      body.n = 0;
      // locals
      const nGroups = rd();
      let nLocals = 0;
      const groups = [];
      for (let g = 0; g < nGroups; g++) { const cnt = rd(), t = u8[p++]; groups.push([cnt, t]); nLocals += cnt; }
      const base = typeParams[funcType[fi]] + nLocals;
      const L_A = base, L_PG = base + 1, L_V = { 0x7f: base + 2, 0x7e: base + 3, 0x7d: base + 4, 0x7c: base + 5 };
      // appended locals: a, pg, v_i32 (three i32), v_i64, v_f32, v_f64 — one run per type
      {
        const head = [];
        uleb(head, nGroups + 4);
        for (const [cnt, t] of groups) { uleb(head, cnt); head.push(t); }
        uleb(head, 3); head.push(0x7f); uleb(head, 1); head.push(0x7e); uleb(head, 1); head.push(0x7d); uleb(head, 1); head.push(0x7c);
        body.arr(head);
      }
      // instructions
      let q = p;   // start of the run to copy verbatim
      const flush = (upto) => { if (upto > q) body.bytes(u8, q, upto); };
      while (p < bend) {
        const at = p, op = u8[p++];
        if (op <= 0x01 || op === 0x05 || op === 0x0b || op === 0x0f || op === 0x1a || op === 0x1b) continue;
        if (op >= 0x02 && op <= 0x04) {        // block / loop / if: blocktype
          const bt = u8[p];
          if (bt === 0x40 || bt === 0x7f || bt === 0x7e || bt === 0x7d || bt === 0x7c || bt === 0x7b || bt === 0x70 || bt === 0x6f) p++;
          else skipLeb();
          continue;
        }
        if (op === 0x0c || op === 0x0d) { skipLeb(); continue; }
        if (op === 0x0e) { const n = rd(); for (let i = 0; i <= n; i++) skipLeb(); continue; }
        if (op === 0x10 || op === 0x12) { skipLeb(); continue; }
        if (op === 0x11 || op === 0x13) { skipLeb(); skipLeb(); continue; }
        if (op === 0x1c) { const n = rd(); p += n; continue; }
        if (op >= 0x20 && op <= 0x26) { skipLeb(); continue; }
        if (op >= 0x28 && op <= 0x35) {        // loads
          const al = rd(); if (al & 0x40) skipLeb(); skipLeb(); continue;
        }
        if (op >= 0x36 && op <= 0x3e) {        // STORES — instrumented
          const ms = p;
          const al = rd(); if (al & 0x40) throw new Error('multi-memory store in function ' + fi);
          const off = rd();
          const me = p;
          const [size, vt] = STORE[op];
          flush(at);
          // ONE CHECK, ONE BRANCH. The fast path is: the page of the first byte is already logged
          // AND the store does not cross into the next page ((ea & 0xFFF) <= 4096 - size, which
          // with size <= 8 means it stays inside one page). Anything else — a first write, or a
          // store straddling two pages (misaligned: legal in wasm whatever the align hint says,
          // so the hint is never trusted) — calls rb_touchn(ea, size), which logs exactly the
          // pages the store touches. It used to be two independent bitmap checks per multi-byte
          // store (first byte, last byte): two loads and two branches on every store.
          const c = [];
          c.push(LOCAL_SET); uleb(c, L_V[vt]);
          c.push(LOCAL_TEE); uleb(c, L_A);
          if (off) { c.push(I32_CONST); sleb32(c, off | 0); c.push(0x6a); }
          c.push(LOCAL_TEE); uleb(c, L_PG);                                   // ea
          c.push(I32_CONST, RB.PAGE_SHIFT, 0x76, 0x2d, ...ma(0, RB.BITMAP));   // bitmap[ea >>> 12] (0/1)
          if (size > 1) {
            c.push(LOCAL_GET); uleb(c, L_PG);
            c.push(I32_CONST); sleb32(c, 0xFFF); c.push(0x71);                 // ea & 0xFFF
            c.push(I32_CONST); sleb32(c, 4096 - size); c.push(0x4d);          // <= 4096 - size (0/1)
            c.push(0x71);                                                       // and
          }
          c.push(0x45, 0x04, 0x40, LOCAL_GET); uleb(c, L_PG);
          c.push(I32_CONST, size, 0x10); uleb(c, touchnIdx); c.push(0x0b);
          c.push(LOCAL_GET); uleb(c, L_A);
          c.push(LOCAL_GET); uleb(c, L_V[vt]);
          body.arr(c);
          body.byte(op); body.bytes(u8, ms, me);
          q = p; stats.stores++;
          continue;
        }
        if (op === 0x3f || op === 0x40) { skipLeb(); continue; }
        if (op === 0x41) { skipLeb(); continue; }
        if (op === 0x42) { skipLeb(); continue; }
        if (op === 0x43) { p += 4; continue; }
        if (op === 0x44) { p += 8; continue; }
        if (op >= 0x45 && op <= 0xc4) continue;
        if (op === 0xd0) { skipLeb(); continue; }
        if (op === 0xd1) continue;
        if (op === 0xd2) { skipLeb(); continue; }
        if (op === 0xfc) {
          const sub = rd();
          if (sub <= 7) continue;
          if (sub === 8) { skipLeb(); p++; continue; }
          if (sub === 9) { skipLeb(); continue; }
          if (sub === 10 || sub === 11) {      // memory.copy / memory.fill -> call the touching wrapper
            const mm = sub === 10 ? [u8[p], u8[p + 1]] : [u8[p]];
            if (mm.some((x) => x !== 0)) throw new Error('multi-memory bulk op in function ' + fi);
            p += mm.length;
            flush(at);
            body.byte(0x10); body.uleb(sub === 10 ? copyIdx : fillIdx);
            q = p; stats[sub === 10 ? 'copies' : 'fills']++;
            continue;
          }
          if (sub === 12 || sub === 14) { skipLeb(); skipLeb(); continue; }
          if (sub === 13 || (sub >= 15 && sub <= 17)) { skipLeb(); continue; }
          throw new Error('unsupported 0xfc ' + sub + ' in function ' + fi);
        }
        throw new Error('unsupported opcode 0x' + op.toString(16) + ' at byte ' + at + ' in function ' + fi +
                        ' (SIMD, atomics, exceptions and GC are not handled — refusing rather than guessing)');
      }
      if (p !== bend) throw new Error('function ' + fi + ' overran its body');
      flush(bend);
      code.uleb(body.n); code.bytes(body.b, 0, body.n);
    }
    // the appended bodies
    const enc = (f) => {
      const t = [];
      uleb(t, f.locals.length); for (const [cnt, ty] of f.locals) { uleb(t, cnt); t.push(ty); }
      for (const x of f.code) t.push(x);
      const o = []; uleb(o, t.length); return o.concat(t);
    };
    code.arr(enc(touchBody()));
    code.arr(enc(bulkBody(touchIdx, false)));
    code.arr(enc(bulkBody(touchIdx, true)));
    code.arr(enc(touchnBody(touchIdx)));

    // ---- reassemble
    const out = new Sink(code.n + (u8.length - (cS.end - cS.start)) + 4096);
    out.bytes(u8, 0, 8);
    const emitSec = (id, payload) => { out.byte(id); out.uleb(payload.length); out.bytes(payload, 0, payload.length); };
    for (const s of sections) {
      if (s.id === 1) {
        const pl = new Sink(s.end - s.start + 16);
        pl.uleb(nTypes + 3);
        p = s.start; rd(); pl.bytes(u8, p, s.end);
        pl.arr([0x60, 1, 0x7f, 0]);              // touch: (i32) -> ()
        pl.arr([0x60, 3, 0x7f, 0x7f, 0x7f, 0]);  // bulk: (i32 i32 i32) -> ()
        pl.arr([0x60, 2, 0x7f, 0x7f, 0]);        // touchn: (i32 i32) -> ()
        emitSec(1, pl.out());
      } else if (s.id === 3) {
        const pl = new Sink(s.end - s.start + 16);
        pl.uleb(nFuncs + 4);
        p = s.start; rd(); pl.bytes(u8, p, s.end);
        pl.uleb(tTouch); pl.uleb(tBulk); pl.uleb(tBulk); pl.uleb(tTouchn);
        emitSec(3, pl.out());
      } else if (s.id === 7) {
        const pl = new Sink(s.end - s.start + 32);
        p = s.start; const n = rd();
        pl.uleb(n + 1); pl.bytes(u8, p, s.end);
        const nm = '__rb_touch';
        pl.uleb(nm.length); for (let i = 0; i < nm.length; i++) pl.byte(nm.charCodeAt(i));
        pl.byte(0); pl.uleb(touchIdx);
        emitSec(7, pl.out());
      } else if (s.id === 10) {
        const pl = new Sink(code.n + 8);
        pl.uleb(nFuncs + 4); pl.bytes(code.b, 0, code.n);
        emitSec(10, pl.out());
      } else {
        out.bytes(u8, s.hdr, s.end);            // copied verbatim, header included
      }
    }
    if (!sec(7)) throw new Error('module has no export section');
    stats.touchIdx = touchIdx;
    return { bytes: out.out(), stats };
  }

  const api = { RB, rbInstrument };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RbInstrument = api;
})(typeof self !== 'undefined' ? self : this);

// [recomp-live 2026-08-25] The decomp->wasm recomp running in a dedicated Web Worker — the
// CPU half of the live browser pipeline. Boots mp4_game.wasm with the full host layer
// (ported from recomp_probe.mjs), serves DVD reads from the split ROM parts (the deployed
// gamecube/roms/MarioParty4.bin.parta* — the TRIMMED image; pair with mp4_fst_trimmed.bin),
// and per game frame:
//   - scans the frame's GP-FIFO for NEW display lists and NEW vertex-array bindings,
//     walks new DLs once to size their arrays exactly (maxIndex+1)*stride, and byte-swaps
//     f32-based arrays LE->BE into shadow copies,
//   - posts {fifo, regions} to the page (transferables), which forwards to dolphin_worker's
//     'recompFrame' handler (RAM region writes + recomp_render_fifo + recomp_present),
//   - reads pad input from a SAB the page's keyboard handlers write,
//   - paces via Atomics.wait on the SAB until the page grants the next frame budget.
// Message in: {cmd:'boot', parts:[ArrayBuffer x6], fst:ArrayBuffer, glueUrl, wasmUrl,
//              pace:SharedArrayBuffer}  pace i32[0]=frame-credits i32[1]=btn i32[2]=dstk
//              i32[3]=stkx i32[4]=stky i32[5]=uncapped
// Message out: {cmd:'frame', fifo, regions:[{addr,bytes}], n} | {cmd:'log', txt}

let Module = null, viRetrace = 0;
let paceI32 = null;
let inputScript = null;   // frame -> [btn, dstk, stkx, stky] canned choreography (?board=1)
let parts = [], fstBuf = null;
const PART_SIZE = 104857600;   // 100MiB fixed part boundaries (gamecube.html chunkRange)

const log = (txt) => postMessage({ cmd: 'log', txt: '[recomp-worker] ' + txt });

// ---- GX state tracking for incremental region sync --------------------------------------
let vcdLo = 0, vcdHi = 0;
const vatA = new Array(8).fill(0);
const arrayBase = new Array(16).fill(0), arrayStride = new Array(16).fill(0);
const knownDLs = new Set();          // guest addr -> already walked+synced
const knownArrays = new Map();       // "base|stride" -> synced byte count so far
// BP texture state: SETIMAGE0 (0x88-0x8B tex0-3, 0xA8-0xAB tex4-7) w/h/fmt per slot;
// SETIMAGE3 (0x94-0x97, 0xB4-0xB7) base>>5 per slot. TLUT loads: 0x64 src>>5, 0x65 tmem+count.
const texImg0 = new Array(8).fill(0);
const texBound = new Map();          // phys base -> byte size (bound this frame)
let tlutSrc = 0;
const knownTex = new Map();          // phys base -> {size, lastSync}
// GX texture format -> bits per texel (tile-padded dims give the safe overestimate)
const TEX_BPP = { 0: 4, 1: 8, 2: 8, 3: 16, 4: 16, 5: 16, 6: 32, 8: 4, 9: 8, 10: 16, 14: 4 };
const gxShadow = { cp: new Map(), xf: new Map(), bp: new Map() };  // for the takeover prologue
let sentPrologue = false;
let cacheDirty = false;   // set on any DVD read: the heap turns over on scene loads, and every
                          // address-keyed cache (DLs/arrays/textures) is invalid — resnapshot.

const FMT_SZ = [1, 1, 2, 2, 4];
const COL_SZ = [2, 3, 4, 2, 3, 4];
function attrList(vat) {
  const va = vatA[vat];
  const list = [];
  const posT = (vcdLo >> 9) & 3, nrmT = (vcdLo >> 11) & 3, c0T = (vcdLo >> 13) & 3, c1T = (vcdLo >> 15) & 3;
  if (vcdLo & 1) list.push({ sz: 1 });
  for (let i = 0; i < 8; i++) if (vcdLo & (1 << (1 + i))) list.push({ sz: 1 });
  const push = (t, directSz, arrIdx) => {
    if (t === 1) list.push({ sz: directSz });
    else if (t === 2) list.push({ sz: 1, idx: arrIdx });
    else if (t === 3) list.push({ sz: 2, idx: arrIdx });
  };
  push(posT, (((va & 1) ? 3 : 2)) * FMT_SZ[(va >> 1) & 7], 0);
  push(nrmT, ((((va >> 9) & 1) ? 9 : 3)) * FMT_SZ[(va >> 10) & 7], 1);
  push(c0T, COL_SZ[(va >> 14) & 7], 2);
  push(c1T, COL_SZ[(va >> 18) & 7], 3);
  for (let i = 0; i < 8; i++) {
    const tT = (vcdHi >> (2 * i)) & 3;
    const dsz = i === 0 ? (((va >> 21) & 1) ? 2 : 1) * FMT_SZ[(va >> 22) & 7] : 8;
    push(tT, dsz, 4 + i);
  }
  return list;
}

// Walk one GX stream (frame or DL body): update reg shadows, collect new DLs, and for
// indexed draws track max index per bound array. buf = Uint8Array, guest = whether offsets
// are guest addresses (DL bodies) — used only for labels.
function walkStream(mem, buf, start, end, depth, newDLs, touched) {
  let p = start;
  const rdU16 = (o) => (buf[o] << 8) | buf[o + 1];
  const rdU32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  while (p < end) {
    const op = buf[p++];
    if (op === 0x00) continue;
    else if (op === 0x08) {
      const a = buf[p], v = rdU32(p + 1); p += 5;
      gxShadow.cp.set(a, v);
      if (a === 0x50) vcdLo = v; else if (a === 0x60) vcdHi = v;
      else if (a >= 0x70 && a <= 0x77) vatA[a - 0x70] = v;
      else if (a >= 0xA0 && a <= 0xAF) arrayBase[a - 0xA0] = v;
      else if (a >= 0xB0 && a <= 0xBF) arrayStride[a - 0xB0] = v;
    }
    else if (op === 0x10) {
      const hdr = rdU32(p); p += 4;
      const count = (hdr >>> 16) + 1, xfAddr = hdr & 0xFFFF;
      if (xfAddr >= 0x1000) for (let k = 0; k < count; k++) gxShadow.xf.set(xfAddr + k, rdU32(p + 4 * k));
      p += 4 * count;
    }
    else if (op === 0x61) {
      const v = rdU32(p); p += 4;
      const reg = (v >>> 24) & 0xff, val = v & 0xffffff;
      gxShadow.bp.set(reg, val);
      let slot = -1;
      if (reg >= 0x88 && reg <= 0x8B) { texImg0[reg - 0x88] = val; }
      else if (reg >= 0xA8 && reg <= 0xAB) { texImg0[4 + (reg - 0xA8)] = val; }
      else if (reg >= 0x94 && reg <= 0x97) slot = reg - 0x94;
      else if (reg >= 0xB4 && reg <= 0xB7) slot = 4 + (reg - 0xB4);
      else if (reg === 0x64) tlutSrc = (val << 5) >>> 0;
      else if (reg === 0x65) {
        // TLUT load: count field (bits 10-20) x 32B from tlutSrc
        const n32 = (val >>> 10) & 0x7FF;
        if (tlutSrc && n32) texBound.set(tlutSrc, Math.max(texBound.get(tlutSrc) || 0, n32 * 32));
      }
      if (slot >= 0) {
        const base = (val << 5) >>> 0;
        const i0 = texImg0[slot];
        const w = ((i0 & 0x3FF) + 1), h = (((i0 >>> 10) & 0x3FF) + 1), fmt = (i0 >>> 20) & 0xF;
        const bpp = TEX_BPP[fmt] || 32;
        // tile-pad dims to 8 and add 33% mip headroom
        const wp = (w + 7) & ~7, hp = (h + 7) & ~7;
        const size = Math.ceil((wp * hp * bpp) / 8 * 1.34);
        if (base) texBound.set(base, Math.max(texBound.get(base) || 0, size));
      }
    }
    else if (op >= 0x20 && op <= 0x38 && (op & 7) === 0) p += 4;
    else if (op === 0x48) continue;
    else if (op === 0x40) {
      const addr = rdU32(p), size = rdU32(p + 4); p += 8;
      if (depth > 0) continue;
      if (!knownDLs.has(addr) && size > 0) {
        knownDLs.add(addr); newDLs.push({ addr, size });
        // walk it ONCE, now, while the binding state is current (arrays are static per model;
        // re-walking 1600+ DLs every frame was the 28fps worker-side throttle)
        const ofs = addr & 0x01FFFFFF;
        const gm = new Uint8Array(mem.buffer, 0x80000000 + ofs, size);
        walkStream(mem, gm, 0, size, depth + 1, newDLs, touched);
      }
    }
    else if ((op & 0x80) && [0x80, 0x88, 0x90, 0x98, 0xA0, 0xA8, 0xB0, 0xB8].includes(op & 0xF8)) {
      const vat = op & 7, n = rdU16(p); p += 2;
      const attrs = attrList(vat);
      for (let v = 0; v < n; v++) {
        for (const a2 of attrs) {
          if (a2.idx !== undefined) {
            const iv = a2.sz === 2 ? rdU16(p) : buf[p];
            const b2 = arrayBase[a2.idx], st = arrayStride[a2.idx];
            if (b2 && st) {
              const k = b2 + '|' + st;
              const need = (iv + 1) * st;
              const have = touched.get(k) || knownArrays.get(k) || 0;
              if (need > have) touched.set(k, need);
            }
          }
          p += a2.sz;
        }
      }
      if (p > end) { log('DRAW OVERRUN in walk'); return; }
    }
    else { log('walk: unknown op 0x' + op.toString(16) + ' at +0x' + (p - 1).toString(16)); return; }
  }
}

function buildPrologue() {
  const pro = [];
  const pu8 = (v) => pro.push(v & 0xff);
  const pu32 = (v) => { pu8(v >>> 24); pu8(v >>> 16); pu8(v >>> 8); pu8(v); };
  for (const [a, v] of gxShadow.cp) { pu8(0x08); pu8(a); pu32(v); }
  for (const [a, v] of gxShadow.xf) { pu8(0x10); pu32(a & 0xffff); pu32(v); }
  for (const [r, v] of gxShadow.bp) { pu8(0x61); pu32(((r & 0xff) << 24) | (v & 0xffffff)); }
  return new Uint8Array(pro);
}

// Copy an array region, swapping f32-based strides (8/12) LE->BE for Dolphin's vertex loader.
// HISTORY: mid-session the pools measured BE only because the HSF swapper's pristine-copy
// restore hole (ClusterProc <- unswapped data.file[0]) was re-BE-ing them per frame; with
// swapper Fixes A-D every GPU-visible pool is LE in guest memory (LE-everywhere), so the
// bridge owns the LE->BE conversion at the sync boundary. s8/rgba8 strides copy raw.
function swap4InPlace(out) {
  for (let k = 0; k + 4 <= out.length; k += 4) {
    const t0 = out[k]; out[k] = out[k + 3]; out[k + 3] = t0;
    const t1 = out[k + 1]; out[k + 1] = out[k + 2]; out[k + 2] = t1;
  }
}
const f32Arrays = [];   // [{b, e}] guest-phys intervals of known f32 (stride 8/12) arrays
function regionBytes(mem, base, stride, count) {
  const src = new Uint8Array(mem.buffer, 0x80000000 + (base & 0x01FFFFFF), count);
  const out = new Uint8Array(count);
  out.set(src);
  if (stride === 8 || stride === 12) {
    swap4InPlace(out);
    const b = base & 0x01FFFFFF;
    f32Arrays.push({ b, e: b + count });
  }
  return out;
}

function serveDvdRead(mem, dv, block, addr, length, offset, cbIdx) {
  block >>>= 0; addr >>>= 0; length >>>= 0; offset >>>= 0;
  cacheDirty = true;
  const dst = new Uint8Array(mem.buffer, addr, length);
  let done = 0;
  while (done < length) {
    const pi = Math.floor((offset + done) / PART_SIZE);
    const po = (offset + done) % PART_SIZE;
    const part = parts[pi];
    if (!part) { dst.fill(0, done); break; }
    const chunk = Math.min(length - done, PART_SIZE - po);
    dst.set(new Uint8Array(part, po, chunk), done);
    done += chunk;
  }
  dv.setInt32(block + 12, 0, true);
  dv.setUint32(block + 32, length, true);
  const cb = cbIdx ? Module.wasmExports.__indirect_function_table.get(cbIdx) : null;
  if (cb) cb(length | 0, block | 0);
  return 1;
}

async function boot(msg) {
  parts = msg.parts;
  fstBuf = new Uint8Array(msg.fst);
  paceI32 = new Int32Array(msg.pace);

  const wasmBinary = await (await fetch(msg.wasmUrl)).arrayBuffer();
  const wasmModule = await WebAssembly.compile(wasmBinary);
  const isEmscriptenProvided = (name) =>
    name.startsWith('emscripten_') || name.startsWith('__asyncify') || name.startsWith('asyncify_') ||
    name.startsWith('__wasm') || name.startsWith('invoke_') || name === 'memory' ||
    /^(_?abort|_?assert|proc_exit|fd_write|fd_read|fd_close|fd_seek|environ_get|environ_sizes_get|_tzset_js|_localtime_js|_gmtime_js|_mktime_js|emscripten_date_now|_emscripten_get_now_is_monotonic|getentropy|_setitimer_js|__syscall_.*|segfault|__stack_chk_fail|_munmap_js|_mmap_js|__cxa_.*|setTempRet0|getTempRet0|__handle_stack_overflow|_emscripten_memcpy_js|_emscripten_runtime_keepalive_clear)$/.test(name);
  const hostNames = [];
  for (const imp of WebAssembly.Module.imports(wasmModule))
    if (imp.kind === 'function' && (imp.module === 'env' || imp.module === 'wasi_snapshot_preview1')
        && !isEmscriptenProvided(imp.name)) hostNames.push(imp.name);

  const mem = () => Module.wasmMemory;
  const dv = () => new DataView(mem().buffer);

  function stub(n) {
    return (...a) => {
      switch (n) {
        case 'OSInit':
          Module._OSSetArenaLo(0x80004000); Module._OSSetArenaHi(0x81800000); return 0;
        case 'OSGetTime': case '__OSGetSystemTime': return BigInt(viRetrace) * 675000n;
        case 'OSGetTick': return (viRetrace * 675000) >>> 0;
        case 'DVDInit': { const f = Module.___DVDFSInit; if (f) f(); return 0; }
        case 'DVDReadAbsAsyncPrio':
        case 'DVDReadAbsAsyncForBS': return serveDvdRead(mem(), dv(), a[0], a[1], a[2], a[3], a[4]);
        case 'VIGetRetraceCount': return viRetrace;
        case 'VIWaitForRetrace': {
          const pos = Module._gx_fifo_pos ? Module._gx_fifo_pos() : 0;
          if (pos > 0) {
            const base = Module._gx_fifo_base();
            const fb = new Uint8Array(mem().buffer.slice(base, base + pos));
            const newDLs = [], touched = new Map();
            try { walkStream(mem(), fb, 0, pos, 0, newDLs, touched) } catch (e) { log('walk threw: ' + e.message); }
            const regions = [];
            for (const d of newDLs)
              regions.push({ addr: d.addr & 0x01FFFFFF,
                             bytes: new Uint8Array(mem().buffer.slice(0x80000000 + (d.addr & 0x01FFFFFF),
                                                                      0x80000000 + (d.addr & 0x01FFFFFF) + d.size)) });
            for (const [k, need] of touched) {
              const [b2, st] = k.split('|').map(Number);
              knownArrays.set(k, need);
              regions.push({ addr: b2 & 0x01FFFFFF, bytes: regionBytes(mem(), b2, st, need) });
            }
            // texture regions: sync on FIRST sight only (per-frame dynamic updates now flow
            // through the dirty-range ring below — the game's own DCStoreRange calls)
            for (const [base, size] of texBound) {
              const ofs = base & 0x01FFFFFF;
              if (ofs + size > 0x01800000) continue;
              const kt = knownTex.get(base);
              if (!kt || size > kt.size) {
                knownTex.set(base, { size, lastSync: viRetrace });
                regions.push({ addr: ofs, bytes: new Uint8Array(mem().buffer.slice(0x80000000 + ofs, 0x80000000 + ofs + size)) });
              }
            }
            texBound.clear();
            // dirty-range ring (gc_dirty_ring.c): the game's DCStoreRange/DCFlushRange calls
            // mark exactly the CPU-written GPU-visible bytes this frame (skinning vertex
            // writes, glyph textures, minigame arrays). Drain, filter to guest RAM, forward.
            if (Module.___recomp_dirty_count) {
              const dn = Module.___recomp_dirty_count();
              if (Module.___recomp_dirty_overflow && Module.___recomp_dirty_overflow()) {
                cacheDirty = true;   // pathological burst (whole-heap flush): full resnapshot next frame
              } else if (dn > 0) {
                const dbase = Module.___recomp_dirty_base() >>> 0;
                const dvw = new DataView(mem().buffer, dbase, dn * 8);
                for (let di = 0; di < dn; di++) {
                  const da = dvw.getUint32(di * 8, true), ds = dvw.getUint32(di * 8 + 4, true);
                  if (da < 0x80000000 || da + ds > 0x81800000) continue;   // stack/out-of-RAM: drop
                  if (ds > 0x100000) { cacheDirty = true; continue; }      // jumbo: full resync instead
                  const ofs = da - 0x80000000;
                  const by = new Uint8Array(mem().buffer.slice(da, da + ds));
                  // dirty range inside a known f32 vertex/texcoord array (skinning/morph
                  // writes are LE floats) -> swap for Dolphin; anything else (glyph
                  // textures, DLs, misc buffers) is byte-exact -> raw
                  for (const iv of f32Arrays)
                    if (ofs >= iv.b && ofs + ds <= iv.e) { swap4InPlace(by); break; }
                  regions.push({ addr: ofs, bytes: by });
                }
              }
              if (Module.___recomp_dirty_reset) Module.___recomp_dirty_reset();
            }
            let mem1Snap = null;
            if (cacheDirty) {
              cacheDirty = false;
              knownDLs.clear(); knownArrays.clear(); knownTex.clear(); f32Arrays.length = 0;
              mem1Snap = mem().buffer.slice(0x80000000, 0x81800000);
            }
            if (!sentPrologue) { sentPrologue = true;
              if (!mem1Snap) mem1Snap = mem().buffer.slice(0x80000000, 0x81800000);
            }
            // Prepend the rolling register shadow to EVERY frame (~1.5KB): each frame is then
            // fully self-contained, so the renderer may skip backlogged frames without the
            // decoder losing persistent CP/XF/BP state carried only by a skipped frame.
            const pro = buildPrologue();
            const fifo = new Uint8Array(pro.length + fb.length);
            fifo.set(pro, 0); fifo.set(fb, pro.length);
            const transfers = [fifo.buffer, ...regions.map((r) => r.bytes.buffer)];
            if (mem1Snap) transfers.push(mem1Snap);
            postMessage({ cmd: 'frame', n: viRetrace, fifo: fifo.buffer, mem1: mem1Snap,
                          regions: regions.map((r) => ({ addr: r.addr, bytes: r.bytes.buffer })) }, transfers);
          }
          if (Module._gx_fifo_reset) Module._gx_fifo_reset();
          // input from the pace SAB (page keyboard); one-shot semantics live in the bake
          const scripted = inputScript ? inputScript[viRetrace + 1] : null;
          if (Module.___recomp_set_inject_btn) Module.___recomp_set_inject_btn(Atomics.exchange(paceI32, 1, 0) | (scripted ? scripted[0] : 0));
          if (Module.___recomp_set_inject_dstk) Module.___recomp_set_inject_dstk(Atomics.exchange(paceI32, 2, 0) | (scripted ? scripted[1] : 0));
          if (Module.___recomp_set_inject_stkx) Module.___recomp_set_inject_stkx(Atomics.exchange(paceI32, 3, 0) || (scripted ? scripted[2] : 0));
          if (Module.___recomp_set_inject_stky) Module.___recomp_set_inject_stky(Atomics.exchange(paceI32, 4, 0) || (scripted ? scripted[3] : 0));
          viRetrace++;
          // pacing: consume one frame credit; block until the page grants more (uncapped=freerun)
          if (!Atomics.load(paceI32, 5)) {
            while (Atomics.load(paceI32, 0) <= 0) Atomics.wait(paceI32, 0, 0, 500);
            Atomics.sub(paceI32, 0, 1);
          }
          return 0;
        }
        default: return 0;
      }
    };
  }

  const instantiateWasm = (info, receive) => {
    info.env ??= {};
    for (const name of hostNames) info.env[name] = stub(name);
    WebAssembly.instantiate(wasmModule, info).then((inst) => receive(inst, wasmModule));
    return {};
  };
  const createModule = (await import(msg.glueUrl)).default;
  Module = await createModule({ instantiateWasm, noInitialRun: true });
  if (Module.wasmMemory.buffer.byteLength < 0x82000000) Module._emscripten_resize_heap(0x82000000);
  if (msg.autoboard && Module.___recomp_autoboard_arm) { Module.___recomp_autoboard_arm(1); log('AUTOBOARD armed'); }
  if (msg.inputScript) { inputScript = msg.inputScript; log('input script: ' + Object.keys(inputScript).length + ' entries'); }

  // stage BootInfo (LE) + FST (BE->LE entry table) + FSTLocation
  const d = new DataView(Module.wasmMemory.buffer);
  d.setUint32(0x80000000, 0x0D15EA5E, true);
  d.setUint32(0x80000008, 0x01800000, true);
  d.setUint32(0x80000014, 2, true);
  const fst = fstBuf.slice();
  const fdv = new DataView(fst.buffer, fst.byteOffset, fst.length);
  const maxEntry = fdv.getUint32(8, false), eb = maxEntry * 12;
  for (let i = 0; i + 4 <= eb; i += 4) fdv.setUint32(i, fdv.getUint32(i, false), true);
  new Uint8Array(Module.wasmMemory.buffer).set(fst, 0x81C00000);
  d.setUint32(0x80000038, 0x81C00000, true);
  d.setUint32(0x8000003C, fst.length, true);
  log('module up (' + hostNames.length + ' host stubs, ' + parts.length + ' disc parts); running main()');
  try { await Module._main(); } catch (e) { log('main stopped: ' + (e.message || e)); }
}

onmessage = (e) => {
  if (e.data.cmd === 'boot') boot(e.data).catch((err) => log('boot failed: ' + (err.stack || err)));
};

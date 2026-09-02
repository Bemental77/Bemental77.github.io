// [wasm-recomp 2026-08-24] Full-boot Node probe — the committed reconstruction of the
// session-scratchpad fiber_probe.mjs rig that was lost with /tmp (lesson: rigs live in the
// repo now). recomp_run.mjs stays the minimal harness; THIS is the one that serves the full
// host layer so the boot runs past the logo: FST staging (mp4_fst.bin, BE->LE entry table),
// DVD reads served from the trimmed decomp ISO with the callback fired synchronously
// (OSSleepThread is a no-op import, so sync DVD wrappers would spin otherwise), OSReport/
// OSPanic format-string decoding, PPCHalt catch, host input injection (___recomp_set_inject_btn
// pulses on a frame schedule), and per-frame GP-FIFO draw decoding.
//
// Usage:
//   node gamecube/recomp/recomp_probe.mjs                       # boot, 3000 frames
//   INPUT="640:start,700:a" node .../recomp_probe.mjs           # press Start@640, A@700
//   PUMP_MAX=900 TRACE_DVD=1 node .../recomp_probe.mjs
// Env: GLUE/WASM (default /tmp/gc_recomp_build/mp4_game.{js,wasm} — build_wasm.sh output),
//   ISO (default ~/Downloads/Mario Party 4 (USA).iso — the FULL retail disc; the committed
//   mp4_fst.bin is byte-identical to ITS FST. The trimmed decomp ISO has a DIFFERENT FST —
//   serving it with this FST reads garbage and OOBs in HuDataReadNum at frame 41),
//   FST (default ./mp4_fst.bin), PUMP_MAX (default 3000), INPUT ("frame:btn,..."; btn =
//   start|a|b|x|y|z|l|r|up|down|left|right or hex), TRACE_DVD=1, QUIET=1 (frame lines off).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeFifo } from './fifo_decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLUE = process.env.GLUE || '/tmp/gc_recomp_build/mp4_game.js';
const WASM = process.env.WASM || '/tmp/gc_recomp_build/mp4_game.wasm';
const ISO  = process.env.ISO  || path.join(process.env.HOME, 'Downloads/Mario Party 4 (USA).iso');
const FST  = process.env.FST  || path.join(HERE, 'mp4_fst.bin');
const PUMP_MAX = parseInt(process.env.PUMP_MAX || '3000', 10);
const TRACE_DVD = !!process.env.TRACE_DVD, QUIET = !!process.env.QUIET;
const PERF = !!process.env.PERF; let perfLast = 0;   // PERF=1: wall-clock game-fps per 200-frame segment
const DUMPDL = parseInt(process.env.DUMPDL || '0', 10);
const DUMPFIX = parseInt(process.env.DUMPFIX || '0', 10);
const DUMPANIM = parseInt(process.env.DUMPANIM || '0', 10);
const AUTOBOARD = !!process.env.AUTOBOARD;   // arm the direct-to-board shortcut
const gxShadow = { cp: new Map(), xf: new Map(), bp: new Map() };   // DUMPFIX: last-write-wins GX register shadow

// GC pad bits (include/dolphin/pad.h)
const BTN = { left:0x0001, right:0x0002, down:0x0004, up:0x0008, z:0x0010, r:0x0020, l:0x0040,
              a:0x0100, b:0x0200, x:0x0400, y:0x0800, start:0x1000 };
const inputSchedule = new Map();   // frame -> button mask (HuPadBtnDown)
const dstkSchedule  = new Map();   // frame -> stick-direction mask (HuPadDStkRep: menus/choice
                                   // dialogs navigate on the analog-stick repeat, NOT the D-pad
                                   // buttons — use dleft/dright/ddown/dup tokens for those)
const DSTK = { dleft: 0x01, dright: 0x02, ddown: 0x04, dup: 0x08 };
const STK  = { sxl: [-80, 0], sxr: [80, 0], syu: [0, 80], syd: [0, -80] };  // raw analog (mentDll UIs)
const stkSchedule = new Map();
for (const tok of (process.env.INPUT || '').split(',').filter(Boolean)) {
  const [f, b] = tok.split(':');
  const key = b?.toLowerCase();
  if (key in DSTK) { dstkSchedule.set(parseInt(f, 10), DSTK[key]); continue; }
  if (key in STK) { stkSchedule.set(parseInt(f, 10), STK[key]); continue; }
  const mask = BTN[key] ?? parseInt(b, 16);
  if (Number.isFinite(mask)) inputSchedule.set(parseInt(f, 10), mask);
}

let Module = null, viRetrace = 0, dvdReads = 0, dvdBytes = 0, osReportN = 0, heapArmed = false, lastCleanImport = ''; const armedHeaps = new Set();
const frames = [];                 // {bytes, draws} per retrace
const reports = [];                // decoded OSReport lines (with frame no)
const isoFd = fs.existsSync(ISO) ? fs.openSync(ISO, 'r') : -1;
if (isoFd < 0) console.log('[probe] WARNING: ISO not found at', ISO, '— DVD reads will zero-fill');

const wasmBinary = fs.readFileSync(WASM);
const wasmModule = await WebAssembly.compile(wasmBinary);
const isEmscriptenProvided = (name) =>
  name.startsWith('emscripten_') ||
  name.startsWith('__asyncify') || name.startsWith('asyncify_') ||
  name.startsWith('__wasm') || name.startsWith('invoke_') ||
  name === 'memory' ||
  /^(_?abort|_?assert|proc_exit|fd_write|fd_read|fd_close|fd_seek|environ_get|environ_sizes_get|_tzset_js|_localtime_js|_gmtime_js|_mktime_js|emscripten_date_now|_emscripten_get_now_is_monotonic|getentropy|_setitimer_js|__syscall_.*|segfault|__stack_chk_fail|_munmap_js|_mmap_js|__cxa_.*|setTempRet0|getTempRet0|__handle_stack_overflow|_emscripten_memcpy_js|_emscripten_runtime_keepalive_clear)$/.test(name);
const hostImportNames = [];
for (const imp of WebAssembly.Module.imports(wasmModule))
  if (imp.kind === 'function' && (imp.module === 'env' || imp.module === 'wasi_snapshot_preview1')
      && !isEmscriptenProvided(imp.name)) hostImportNames.push(imp.name);

const mem = () => Module.wasmMemory;
const u8 = () => new Uint8Array(mem().buffer);
const dv = () => new DataView(mem().buffer);
const cstr = (p) => { p >>>= 0; if (!p) return '(null)'; const m = u8(); let e = p;
  while (e < m.length && m[e] && e - p < 512) e++; return Buffer.from(m.slice(p, e)).toString('latin1'); };
// minimal printf for OSReport/OSPanic. Emscripten lowers C varargs into a packed stack block
// and passes its POINTER as the import's last fixed arg — so read successive values from
// memory at vaPtr (i32 at 4-byte alignment; %f is a double, 8-aligned).
function fmt(fmtP, vaPtr) {
  const d = dv(); let p = vaPtr >>> 0;
  const i32 = () => { const v = d.getInt32(p, true); p += 4; return v; };
  const f64 = () => { p = (p + 7) & ~7; const v = d.getFloat64(p, true); p += 8; return v; };
  let s = cstr(fmtP), out = '', i = 0;
  while (i < s.length) {
    if (s[i] !== '%') { out += s[i++]; continue; }
    let j = i + 1; while (j < s.length && /[-0-9.#+ l]/.test(s[j])) j++;
    const c = s[j];
    if (c === '%') out += '%';
    else if (c === 's') out += cstr(i32());
    else if (c === 'd' || c === 'i') out += i32();
    else if (c === 'u') out += (i32() >>> 0);
    else if (c === 'x' || c === 'X') out += (i32() >>> 0).toString(16);
    else if (c === 'c') out += String.fromCharCode(i32() & 0xff);
    else if (c === 'f' || c === 'g' || c === 'e') out += f64();
    else out += '%' + (c ?? '');
    i = j + 1;
  }
  return out.replace(/\n$/, '');
}
const table = () => Module.wasmExports.__indirect_function_table;

// DVD serve: copy ISO [offset,offset+len) -> guest addr, complete the block, fire the callback.
// DVDCommandBlock (wasm32): state @+12, transferredSize @+32; cb = void(s32 result, block*).
function serveDvdRead(block, addr, length, offset, cbIdx) {
  block >>>= 0; addr >>>= 0; length >>>= 0; offset >>>= 0;
  let got = 0;
  if (isoFd >= 0 && length > 0) {
    const view = new Uint8Array(mem().buffer, addr, length);   // fresh view (buffer identity can change on grow)
    got = fs.readSync(isoFd, view, 0, length, offset);
    if (got < length) view.fill(0, got);
  }
  dvdReads++; dvdBytes += length;
  if (TRACE_DVD) console.log(`[dvd] frame=${viRetrace} read off=0x${offset.toString(16)} len=${length} -> 0x${addr.toString(16)} (got ${got})`);
  const d = dv();
  d.setInt32(block + 12, 0, true);            // state = DVD_STATE_END
  d.setUint32(block + 32, length, true);      // transferredSize
  const cb = cbIdx ? table().get(cbIdx) : null;
  if (cb) cb(length | 0, block | 0);          // synchronous completion (no interrupts here)
  return 1;
}

const T0 = Date.now();
const MAX_WALL_MS = parseInt(process.env.MAX_WALL_MS || '180000', 10);
const HEAPCHECK = process.env.HEAPCHECK ? parseInt(process.env.HEAPCHECK, 16) : 0;
// HEAPCHECK ring walk (size@0 magic@4(0xa5|0xcd) next@+12). Runs at EVERY import crossing —
// per-frame is too coarse when the corruptor and the fatal walk share one frame. Reports the
// last-clean/first-broken import pair, which brackets the corrupting wasm code. The throw's
// stack (Error) names the wasm frames live at detection.
function heapRingCheck(where) {
  const d = dv();
  for (let h = 0; h < 5; h++) {                       // HEAP_SYSTEM..HEAP_MISC (HeapID enum)
    const head = Module._HuMemHeapPtrGet ? (Module._HuMemHeapPtrGet(h) >>> 0) : (h === 0 ? HEAPCHECK : 0);
    if (!head) continue;
    let p = head, steps = 0, bad = null;
    do {
      const magic = d.getUint8(p + 4), next = d.getUint32(p + 12, true);
      if ((magic !== 0xa5 && magic !== 0xcd) || next < 0x80000000 || next >= 0x81C00000) { bad = { p, magic, next }; break; }
      p = next; steps++;
    } while (p !== head && steps < 20000);
    const ok = !bad && steps < 20000;
    if (ok) { armedHeaps.add(h); continue; }
    if (armedHeaps.has(h)) {
      console.log(`[heapcheck] BROKEN heap ${h} (head 0x${head.toString(16)}) at frame ${viRetrace} at import '${where}' (last clean: '${lastCleanImport}'): ` +
                  (bad ? `block 0x${bad.p.toString(16)} magic=0x${bad.magic.toString(16)} next=0x${bad.next.toString(16)}` : 'ring does not close in 20000 steps'));
      const err = new Error('heap ring broken');
      console.log(err.stack.split('\n').filter(l => l.includes('wasm')).slice(0, 12).join('\n'));
      throw { __heapbroken: true };
    }
  }
  lastCleanImport = where;
}
function makeStub(n) {
  return (...a) => {
    // wall watchdog: a game spin that still crosses ANY import gets caught here, and the
    // thrown Error's stack names the spinning wasm frames (a pure-wasm spin is uncatchable).
    if (Date.now() - T0 > MAX_WALL_MS) throw new Error(`WALL watchdog (${MAX_WALL_MS}ms) in import ${n} at frame ${viRetrace}`);
    if (HEAPCHECK) heapRingCheck(n);
    switch (n) {
      case 'OSInit':
        Module._OSSetArenaLo(0x80004000); Module._OSSetArenaHi(0x81800000); return 0;
      // FRAME-DRIVEN clock: 1 retrace = 1/60s = 675000 timebase ticks (GC timebase = bus/4 =
      // 40.5MHz). The game's OSTicksToMilliseconds waits (logo holds, demo timers) then take a
      // deterministic frame count instead of depending on how fast the probe pumps wall-clock.
      case 'OSGetTime': case '__OSGetSystemTime': return BigInt(viRetrace) * 675000n;
      case 'OSGetTick': return (viRetrace * 675000) >>> 0;
      case 'OSReport': case 'OSVReport': {
        osReportN++; const line = fmt(a[0], a[1]);
        reports.push([viRetrace, line]);
        if (!QUIET) console.log(`[OSReport f${viRetrace}] ${line}`);
        return 0;
      }
      case 'OSPanic': {
        const line = fmt(a[2], a[3]);
        console.log(`[OSPanic f${viRetrace}] ${cstr(a[0])}:${a[1] | 0}: ${line}`);
        return 0;
      }
      case 'PPCHalt': throw { __halt: true };
      case '__recomp_aramanim_note':   // aramanim diag: anim tree swapped INSIDE the emulated-ARAM buffer
        console.log(`[aramanim f${viRetrace}] tree=0x${(a[0] >>> 0).toString(16)} (aram+0x${((a[0] - a[1]) >>> 0).toString(16)})\n` +
                    new Error().stack.split('\n').filter(l => l.includes('wasm')).slice(0, 12).join('\n'));
        return 0;
      case '__recomp_alloc_trap':   // RECOMP_ALLOCDIAG build: print the failing alloc's wasm caller chain
        console.log(`[alloc-err f${viRetrace}] size=0x${(a[0] >>> 0).toString(16)}\n` +
                    new Error().stack.split('\n').filter(l => l.includes('wasm')).slice(0, 12).join('\n'));
        return 0;
      case '__recomp_texobj_trap':  // RECOMP_TEXDIAG build: junk-texture bind (image ptr outside MEM1)
        console.log(`[texobj-trap f${viRetrace}] ptr=0x${(a[0] >>> 0).toString(16)} w=${(a[1] >>> 16) & 0xffff} h=${a[1] & 0xffff} fmt=${a[2] >>> 0}\n` +
                    new Error().stack.split('\n').filter(l => l.includes('wasm')).slice(0, 14).join('\n'));
        return 0;
      case '__recomp_sprtex_trap': { // RECOMP_TEXDIAG build: junk sprite-tex bind — dump the AnimData tree head
        const t = a[0] >>> 0, bmpPtr = a[2] >>> 0, d = dv();
        const hx = (p, n) => { let s = ''; for (let k = 0; k < n; k += 4) s += d.getUint32(p + k, true).toString(16).padStart(8, '0') + ' '; return s; };
        console.log(`[sprtex-trap f${viRetrace}] anim=0x${t.toString(16)} bmpNo=${a[1] >>> 0} bmpPtr=0x${bmpPtr.toString(16)}\n` +
                    `  animHead: ${hx(t, 20)}\n  bmpRec:   ${hx(bmpPtr, 20)}`);
        return 0;
      }
      case 'DVDInit': { const f = Module.___DVDFSInit || Module.__DVDFSInit; if (f) f(); return 0; }
      case 'DVDReadAbsAsyncPrio': return serveDvdRead(a[0], a[1], a[2], a[3], a[4]);
      case 'DVDReadAbsAsyncForBS': return serveDvdRead(a[0], a[1], a[2], a[3], a[4]);
      case 'DVDGetDriveStatus': return 0;
      case 'VIGetRetraceCount': return viRetrace;
      case 'VIWaitForRetrace': {
        const pos = Module._gx_fifo_pos ? Module._gx_fifo_pos() : 0;
        let draws = 0;
        if (pos > 0 && !PERF) {   // PERF=1: skip probe-side per-frame decode — measure the GAME's cost only
          const buf = Buffer.from(mem().buffer.slice(Module._gx_fifo_base(), Module._gx_fifo_base() + pos));
          try { const { cmds } = decodeFifo(new DataView(buf.buffer, buf.byteOffset, buf.length), buf.length);
                for (const c of cmds) if (c.t === 'draw') draws++; } catch { draws = -1; }
          fs.writeFileSync('/tmp/recomp_probe_last.fifo', buf);   // last non-empty frame, for offline decode
        }
        frames.push({ bytes: pos, draws });
        // DUMPDL=<frame>: at that frame, follow every CALL_DL into guest memory and census the
        // DISPLAY-LIST bodies (the 3D-model geometry lives there, not in the top-level FIFO):
        // are they clean BE GX streams, and do their draws use direct or indexed attributes?
        if (DUMPDL && viRetrace === DUMPDL && pos > 0) {
          const top = Buffer.from(mem().buffer.slice(Module._gx_fifo_base(), Module._gx_fifo_base() + pos));
          const { cmds } = decodeFifo(new DataView(top.buffer, top.byteOffset, top.length), top.length);
          const dls = cmds.filter(c => c.t === 'calldl');
          const uniq = new Map();
          for (const d of dls) if (!uniq.has(d.addr)) uniq.set(d.addr, d.size);
          console.log(`[dumpdl f${viRetrace}] top-level: ${cmds.length} cmds, ${dls.length} calldl (${uniq.size} unique)`);
          let i = 0;
          for (const [addr, size] of [...uniq.entries()].slice(0, 12)) {
            const body = Buffer.from(mem().buffer.slice(addr >>> 0, (addr >>> 0) + Math.min(size, 65536)));
            let rep;
            try {
              const r = decodeFifo(new DataView(body.buffer, body.byteOffset, body.length), body.length);
              const k = {}; for (const c of r.cmds) k[c.t] = (k[c.t] || 0) + 1;
              const drs = r.cmds.filter(c => c.t === 'draw');
              const direct = drs.filter(d => d.direct).length;
              const cpAB = r.cmds.filter(c => c.t === 'cp' && c.reg >= 0xA0 && c.reg <= 0xBF).length;
              rep = `clean=${r.clean} ${JSON.stringify(k)} draws=${drs.length} direct=${direct} cpArrayBase=${cpAB}`;
            } catch (e) { rep = 'DECODE THROW: ' + e.message; }
            console.log(`[dumpdl] DL#${i} @0x${(addr >>> 0).toString(16)} size=${size}: ${rep}`);
            fs.writeFileSync(`/tmp/recomp_dl_${i}.bin`, body);
            i++;
          }
        }
        // DUMPANIM=<frame>: walk the swapped-AnimData registry (gc_anim_bswap.c) and report
        // each tree's bmp[0] header; dump the message-font sheet (sizeX==320) raw to
        // /tmp/font_sheet.bin for offline texture decode (glyph-barcode forensics).
        if (DUMPANIM && viRetrace === DUMPANIM) {
          const n = Module.___recomp_get_anim_count ? Module.___recomp_get_anim_count() : 0;
          const aramB = Module.___recomp_aram_base ? (Module.___recomp_aram_base() >>> 0) : 0;
          console.log(`[dumpanim f${viRetrace}] ${n} swapped AnimData trees | __recomp_aram=[0x${aramB.toString(16)},0x${(aramB + 0x1000000).toString(16)})`);
          const memLen = mem().buffer.byteLength;
          for (let ai = 0; ai < n; ai++) {
            const ad = Module.___recomp_get_anim_at(ai) >>> 0;
            const d2 = dv();
            // registry keeps every tree ever swapped; freed entries get reused/zeroed —
            // range-guard all derived reads so one corpse can't kill the walk.
            if (ad < 0x80000000 || ad + 0x20 > memLen) { console.log(`  anim#${ai} @0x${ad.toString(16)} (out-of-window — freed/masked)`); continue; }
            const bmpNum = d2.getInt16(ad + 4, true), bmpOfs = d2.getUint32(ad + 0x10, true);
            const bmpP = bmpOfs < 0x14 || bmpOfs >= 0x01000000 ? bmpOfs : ad + bmpOfs;  // relocated ptr vs offset
            if (bmpP < 0x80000000 || bmpP + 0x14 > memLen) { console.log(`  anim#${ai} @0x${(ad - 0x80000000 >>> 0).toString(16)} bmpP=0x${(bmpP >>> 0).toString(16)} (bmp out-of-window)`); continue; }
            const pixSize = d2.getUint8(bmpP), fmt = d2.getUint8(bmpP + 1);
            const palNum = d2.getInt16(bmpP + 2, true), w = d2.getInt16(bmpP + 4, true), h = d2.getInt16(bmpP + 6, true);
            const dataSize = d2.getUint32(bmpP + 8, true);
            let dataP = d2.getUint32(bmpP + 0x10, true); if (dataP < 0x01000000) dataP = ad + dataP;
            console.log(`  anim#${ai} @0x${(ad - 0x80000000 >>> 0).toString(16)} bmpNum=${bmpNum} bmp0: fmt=${fmt} pix=${pixSize} pal=${palNum} ${w}x${h} dataSize=${dataSize}` +
                        (w > 0 && w <= 1024 && h > 0 && h <= 1024 ? ` dataP=0x${(dataP >>> 0).toString(16)}` : ''));
            if (w === 320 && dataP >= 0x80000000 && dataP + dataSize <= memLen && dataSize > 0 && dataSize < 0x100000) {
              fs.writeFileSync('/tmp/font_sheet.bin', Buffer.from(mem().buffer.slice(dataP, dataP + dataSize)));
              console.log(`  -> font sheet dumped: /tmp/font_sheet.bin (${dataSize}B, fmt=${fmt}, dataP=0x${(dataP >>> 0).toString(16)})`);
            }
          }
        }
        // DUMPFIX=<frame>: write the render fixture for the Dolphin-WGPU seam — the frame's
        // FIFO bytes, a raw MEM1 image (guest 0x80000000..0x81800000), and a region manifest
        // (CP array base/stride pairs with byte extents + unique CALL_DL spans). The browser
        // bridge replays these into dolphin_worker: RAM image + f32-array byte-swaps + fifo.
        // Persistent GX state (VAT/VCD slots, array bases, BP/XF configs) is set across MANY
        // frames (boot, scene loads) and never fully re-emitted per frame — a lone frame
        // desyncs Dolphin's stateful decoder mid-display-list. Track a last-write-wins
        // REGISTER SHADOW (CP, XF regs 0x1000+, BP) over every frame's stream, and at
        // DUMPFIX synthesize a compact state prologue (~4KB) before the target frame.
        if (DUMPFIX && pos > 0) {
          const b0 = Module._gx_fifo_base();
          const fb = Buffer.from(mem().buffer.slice(b0, b0 + pos));
          try {
            const { cmds } = decodeFifo(new DataView(fb.buffer, fb.byteOffset, fb.length), fb.length);
            for (const c of cmds) {
              if (c.t === 'cp') gxShadow.cp.set(c.addr & 0xff, c.val >>> 0);
              else if (c.t === 'bp') gxShadow.bp.set(c.reg & 0xff, c.val & 0xffffff);
              else if (c.t === 'xf' && c.addr >= 0x1000 && c.raw) {
                for (let k = 0; k < c.raw.length; k++) gxShadow.xf.set(c.addr + k, c.raw[k] >>> 0);
              }
            }
          } catch {}
        }
        if (DUMPFIX && viRetrace === DUMPFIX && pos > 0) {
          const base = Module._gx_fifo_base();
          const frameOnly = Buffer.from(mem().buffer.slice(base, base + pos));
          const pro = [];
          const pu8 = (v) => pro.push(v & 0xff);
          const pu32 = (v) => { pu8(v >>> 24); pu8(v >>> 16); pu8(v >>> 8); pu8(v); };
          for (const [a, v] of gxShadow.cp) { pu8(0x08); pu8(a); pu32(v); }
          for (const [a, v] of gxShadow.xf) { pu8(0x10); pu32(a & 0xffff); pu32(v >>> 0); }
          for (const [r, v] of gxShadow.bp) { pu8(0x61); pu32(((r & 0xff) << 24) | (v & 0xffffff)); }
          // GXInit-era XF defaults (written once at boot, never re-emitted): identity into
          // GX_IDENTITY (0xF0) + GX_PTIDENTITY (0x5F4) — sprite/glyph texgens reference them.
          { const ONE = 0x3f800000, ident = [ONE, 0, 0, 0, 0, ONE, 0, 0, 0, 0, ONE, 0];
            for (const mb of [0xF0, 0x5F4]) { pu8(0x10); pu32(((ident.length - 1) << 16) | mb); for (const w of ident) pu32(w); } }
          const fifo = Buffer.concat([Buffer.from(pro), frameOnly]);
          console.log(`[dumpfix] state prologue: cp=${gxShadow.cp.size} xf=${gxShadow.xf.size} bp=${gxShadow.bp.size} (${pro.length}B) + ${frameOnly.length}B frame`);
          fs.writeFileSync('/tmp/recomp_fix_frame.bin', fifo);
          fs.writeFileSync('/tmp/recomp_fix_mem1.bin', Buffer.from(mem().buffer.slice(0x80000000, 0x81800000)));
          const { cmds } = decodeFifo(new DataView(fifo.buffer, fifo.byteOffset, fifo.length), fifo.length);
          const pend = {}, pairs = new Map(), dls = new Map();
          for (const c of cmds) {
            if (c.t === 'cp' && c.addr >= 0xA0 && c.addr <= 0xA7) pend[c.addr - 0xA0] = c.val >>> 0;
            if (c.t === 'cp' && c.addr >= 0xB0 && c.addr <= 0xB7) {
              const at = c.addr - 0xB0, b2 = pend[at];
              if (b2 !== undefined) pairs.set(`${b2}|${c.val}`, { attr: at, base: b2, stride: c.val >>> 0 });
            }
            if (c.t === 'calldl') dls.set(c.addr >>> 0, Math.max(dls.get(c.addr >>> 0) || 0, c.size >>> 0));
          }
          // extent per array: clip at the nearest FOLLOWING array base OR display-list start
          // (cap 256KB) — arrays and DLs interleave per model, and an over-greedy extent
          // byte-swaps DL bytes (the 0x0f-at-DL+1 desync: swap trampled 0x80a038a0).
          const clipPts = [...new Set([...[...pairs.values()].map(p => p.base),
                                       ...[...dls.keys()].map(a => a & 0x01FFFFFF)])].sort((x, y) => x - y);
          const arr = [...pairs.values()].map(p => {
            const next = clipPts.find(b2 => b2 > p.base);
            const cap = next ? Math.min(next - p.base, 0x40000) : 0x40000;
            return { ...p, count: cap };
          });
          fs.writeFileSync('/tmp/recomp_fix_regions.json',
            JSON.stringify({ arrays: arr, dls: [...dls.entries()].map(([a, s]) => ({ addr: a, size: s })) }));
          console.log(`[dumpfix f${viRetrace}] fifo=${fifo.length}B arrays=${arr.length} dls=${dls.size} -> /tmp/recomp_fix_*.bin/json`);
        }
        if (PERF && (viRetrace % 200) === 0) {
          const now = performance.now();
          if (perfLast) console.log(`[perf] frames ${viRetrace - 200}-${viRetrace}: ${(200000 / (now - perfLast)).toFixed(1)} game-fps (wall)`);
          perfLast = now;
        }
        const prev = frames[frames.length - 2];
        if (!QUIET && !PERF && (!prev || prev.draws !== draws || Math.abs(prev.bytes - pos) > 256))
          console.log(`[frame ${viRetrace}] fifo=${pos}B draws=${draws}`);
        if (Module._gx_fifo_reset) Module._gx_fifo_reset();
        // input pulses: deliver this frame's scheduled mask, clear it the frame after
        const inj = Module.___recomp_set_inject_btn;
        if (inj) inj(inputSchedule.get(viRetrace + 1) ?? 0);   // set for the NEXT game frame
        const injD = Module.___recomp_set_inject_dstk;
        if (injD) injD(dstkSchedule.get(viRetrace + 1) ?? 0);
        const stk = stkSchedule.get(viRetrace + 1) ?? [0, 0];
        if (Module.___recomp_set_inject_stkx) { Module.___recomp_set_inject_stkx(stk[0]); Module.___recomp_set_inject_stky(stk[1]); }
        viRetrace++;
        pumpAudio();
        if (viRetrace >= PUMP_MAX) throw { __pumpDone: true };
        return 0;
      }
      default: return 0;
    }
  };
}

// ---- audio tap (RECOMP_MUSYX builds only) ------------------------------------------------
// Drives ___recomp_audio_pump on the SAME schedule recomp_worker.js does — from
// VIWaitForRetrace, with the sample count derived from viRetrace and nothing else — so what is
// measured here is what the page would get, and no host clock can enter the guest's audio
// timing (CLAUDE.md gate #9). It exists because "silent" needed to be attributable: the
// counters below separate `no AI` from `AI but no voices` from `voices but no signal`.
const AUDIO_RATE = 32000;
// AUDIO_SELFTEST="frame:seId[,frame:seId...]" — call ___recomp_audio_selftest (msmSePlay) at
// those retraces. Separates "the mixer cannot render" from "nothing has asked it to": the boot
// parks on the title screen, so without this the mixer is measured with no voice ever started.
const selftestSchedule = new Map();
for (const tok of (process.env.AUDIO_SELFTEST || '').split(',').filter(Boolean)) {
  const [fr, id] = tok.split(':');
  selftestSchedule.set(parseInt(fr, 10), parseInt(id, 10));
}
let audioAcc = 0;
const audio = { frames: 0, nonZero: 0, peak: 0, sumSq: 0, pumps: 0, maxVoices: 0, stat: [0,0,0,0,0,0,0,0] };
function pumpAudio() {
  if (!Module || !Module.___recomp_audio_pump || !Module.___recomp_audio_base) return;
  if (selftestSchedule.has(viRetrace) && Module.___recomp_audio_selftest) {
    const id = selftestSchedule.get(viRetrace);
    const r = Module.___recomp_audio_selftest(id) | 0;
    console.log(`[audio-selftest] frame ${viRetrace}: msmSePlay(${id}) -> ${r}`);
  }
  audioAcc += AUDIO_RATE;
  const n = (audioAcc / 60) | 0;
  audioAcc -= n * 60;
  if (n <= 0) return;
  audio.pumps++;
  if (Module.___recomp_musyx_active_voices) {
    const v = Module.___recomp_musyx_active_voices() | 0;
    if (v > audio.maxVoices) audio.maxVoices = v;
  }
  if (Module.___recomp_musyx_stat) {
    for (let i = 0; i < 8; i++) {
      const v = Module.___recomp_musyx_stat(i) | 0;
      if (v > audio.stat[i]) audio.stat[i] = v;
    }
  }
  const got = Module.___recomp_audio_pump(n) | 0;
  if (got <= 0) return;
  const base = Module.___recomp_audio_base() >>> 0;
  const pcm = new Int16Array(mem().buffer.slice(base, base + got * 4));
  audio.frames += got;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a) audio.nonZero++;
    if (a > audio.peak) audio.peak = a;
    audio.sumSq += pcm[i] * pcm[i];
  }
}

const instantiateWasm = (info, receive) => {
  info.env ??= {};
  for (const name of hostImportNames) info.env[name] = makeStub(name);
  WebAssembly.instantiate(wasmModule, info).then((instance) => receive(instance, wasmModule));
  return {};
};
const createModule = (await import(GLUE)).default;
Module = await createModule({ instantiateWasm, noInitialRun: true });

// grow via emscripten's resize (keeps HEAP views fresh — raw grow detaches them under Asyncify)
const needBytes = 0x82000000;
if (mem().buffer.byteLength < needBytes) Module._emscripten_resize_heap(needBytes);
if (AUTOBOARD && Module.___recomp_autoboard_arm) { Module.___recomp_autoboard_arm(1); console.log('[probe] AUTOBOARD armed'); }
console.log('[probe] memory:', (mem().buffer.byteLength / 1048576) | 0, 'MB | host stubs:', hostImportNames.length,
            '| ISO:', isoFd >= 0 ? ISO : 'MISSING', '| input:', inputSchedule.size, 'pulses');

// stage OSBootInfo (LE — the wasm is little-endian) + FST (BE->LE entry table) + FSTLocation
{
  const d = dv();
  d.setUint32(0x80000000, 0x0D15EA5E, true);
  d.setUint32(0x80000008, 0x01800000, true);   // memorySize 24MB
  d.setUint32(0x80000014, 2, true);            // consoleType retail
  const fstRaw = fs.readFileSync(FST);
  const fst = new Uint8Array(fstRaw);
  const fdv = new DataView(fst.buffer, fst.byteOffset, fst.length);
  const maxEntry = fdv.getUint32(8, false), eb = maxEntry * 12;
  for (let i = 0; i + 4 <= eb; i += 4) fdv.setUint32(i, fdv.getUint32(i, false), true);
  const FST_ADDR = 0x81C00000;
  u8().set(fst, FST_ADDR);
  d.setUint32(0x80000038, FST_ADDR, true);
  d.setUint32(0x8000003C, fst.length, true);
  console.log('[probe] FST staged:', maxEntry, 'entries,', fst.length, 'bytes');
}

let result = 'ran to completion';
try { await Module._main(); }
catch (e) {
  if (e && e.__pumpDone) result = `pumped ${viRetrace} retraces (PUMP_MAX)`;
  else if (e && e.__halt) result = `PPCHalt (OSHalt/panic stop) at frame ${viRetrace}`;
  else if (e && e.__heapbroken) result = `HEAPCHECK: MCB ring broken at frame ${viRetrace}`;
  else result = `TRAP after ${viRetrace} retraces: ${e && (e.stack || e.message || e)}`;
}

const drawsTotal = frames.reduce((s, f) => s + Math.max(0, f.draws), 0);
const last = frames[frames.length - 1] || { bytes: 0, draws: 0 };
const fib = (n) => (Module['___gc_fiber_stat_' + n] ? Module['___gc_fiber_stat_' + n]() : -1);
if (Module && Module.___recomp_audio_pump) {
  const st = (i) => (Module.___recomp_audio_stat ? Module.___recomp_audio_stat(i) | 0 : -1);
  const rms = audio.frames ? Math.sqrt(audio.sumSq / (audio.frames * 2)) : 0;
  console.log(`=== audio: pumps=${audio.pumps} framesOut=${audio.frames} nonZeroSamples=${audio.nonZero}` +
              ` peak=${audio.peak} rms=${rms.toFixed(1)} maxActiveVoices=${audio.maxVoices}` +
              ` | AI running=${st(0)} cbRegistered=${st(1)} ringDepth=${st(2)} inited=${st(3)}` +
              ` | msmBswapUnknownReads=${Module.___recomp_msm_bswap_unknowns ? Module.___recomp_msm_bswap_unknowns() : '?'}`);
  console.log(`=== audio stages (peak over the run): salNumVoices=${audio.stat[0]}` +
              ` activeStudios=${audio.stat[1]} voiceMgrBusy=${audio.stat[2]}` +
              ` pbPlaying=${audio.stat[3]} studioVoiceList=${audio.stat[4]}`);
  console.log(`=== audio peaks (sampled at the 200Hz AI rate, inside the mixer):` +
              ` voiceMgrBusy=${audio.stat[5]} pbPlaying=${audio.stat[6]} nonZeroMixedSamples=${audio.stat[7]}`);
}
console.log('=== result:', result);
console.log(`=== frames=${frames.length} totalDraws=${drawsTotal} last={bytes:${last.bytes},draws:${last.draws}}`,
            `| dvd: ${dvdReads} reads / ${(dvdBytes / 1024) | 0}KB | OSReport: ${osReportN}`,
            `| fibers fab=${fib('fabricate')} enter=${fib('enter')} swap=${fib('swap')}`);
// condensed per-frame phase map: contiguous runs of equal draw-count
let runs = [], cur = null;
frames.forEach((f, i) => {
  if (!cur || cur.draws !== f.draws) { cur = { from: i, to: i, draws: f.draws, bytes: f.bytes }; runs.push(cur); }
  else { cur.to = i; cur.bytes = f.bytes; }
});
console.log('=== phase map (frame-range: draws @ last-bytes):');
for (const r of runs.slice(0, 60)) console.log(`  ${r.from}-${r.to}: draws=${r.draws} (${r.bytes}B)`);
if (runs.length > 60) console.log('  ... +' + (runs.length - 60) + ' more runs');

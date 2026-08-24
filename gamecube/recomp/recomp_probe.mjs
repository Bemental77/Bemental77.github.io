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

// GC pad bits (include/dolphin/pad.h)
const BTN = { left:0x0001, right:0x0002, down:0x0004, up:0x0008, z:0x0010, r:0x0020, l:0x0040,
              a:0x0100, b:0x0200, x:0x0400, y:0x0800, start:0x1000 };
const inputSchedule = new Map();   // frame -> button mask (HuPadBtnDown)
const dstkSchedule  = new Map();   // frame -> stick-direction mask (HuPadDStkRep: menus/choice
                                   // dialogs navigate on the analog-stick repeat, NOT the D-pad
                                   // buttons — use dleft/dright/ddown/dup tokens for those)
const DSTK = { dleft: 0x01, dright: 0x02, ddown: 0x04, dup: 0x08 };
for (const tok of (process.env.INPUT || '').split(',').filter(Boolean)) {
  const [f, b] = tok.split(':');
  const key = b?.toLowerCase();
  if (key in DSTK) { dstkSchedule.set(parseInt(f, 10), DSTK[key]); continue; }
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
      case '__recomp_alloc_trap':   // RECOMP_ALLOCDIAG build: print the failing alloc's wasm caller chain
        console.log(`[alloc-err f${viRetrace}] size=0x${(a[0] >>> 0).toString(16)}\n` +
                    new Error().stack.split('\n').filter(l => l.includes('wasm')).slice(0, 12).join('\n'));
        return 0;
      case 'DVDInit': { const f = Module.___DVDFSInit || Module.__DVDFSInit; if (f) f(); return 0; }
      case 'DVDReadAbsAsyncPrio': return serveDvdRead(a[0], a[1], a[2], a[3], a[4]);
      case 'DVDReadAbsAsyncForBS': return serveDvdRead(a[0], a[1], a[2], a[3], a[4]);
      case 'DVDGetDriveStatus': return 0;
      case 'VIGetRetraceCount': return viRetrace;
      case 'VIWaitForRetrace': {
        const pos = Module._gx_fifo_pos ? Module._gx_fifo_pos() : 0;
        let draws = 0;
        if (pos > 0) {
          const buf = Buffer.from(mem().buffer.slice(Module._gx_fifo_base(), Module._gx_fifo_base() + pos));
          try { const { cmds } = decodeFifo(new DataView(buf.buffer, buf.byteOffset, buf.length), buf.length);
                for (const c of cmds) if (c.t === 'draw') draws++; } catch { draws = -1; }
          fs.writeFileSync('/tmp/recomp_probe_last.fifo', buf);   // last non-empty frame, for offline decode
        }
        frames.push({ bytes: pos, draws });
        const prev = frames[frames.length - 2];
        if (!QUIET && (!prev || prev.draws !== draws || Math.abs(prev.bytes - pos) > 256))
          console.log(`[frame ${viRetrace}] fifo=${pos}B draws=${draws}`);
        if (Module._gx_fifo_reset) Module._gx_fifo_reset();
        // input pulses: deliver this frame's scheduled mask, clear it the frame after
        const inj = Module.___recomp_set_inject_btn;
        if (inj) inj(inputSchedule.get(viRetrace + 1) ?? 0);   // set for the NEXT game frame
        const injD = Module.___recomp_set_inject_dstk;
        if (injD) injD(dstkSchedule.get(viRetrace + 1) ?? 0);
        viRetrace++;
        if (viRetrace >= PUMP_MAX) throw { __pumpDone: true };
        return 0;
      }
      default: return 0;
    }
  };
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

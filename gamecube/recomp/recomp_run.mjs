// [wasm-recomp 2026-08-22] Node run-harness (ASYNCIFY / fiber build). The port dropped
// -sSTANDALONE_WASM to get emscripten_fiber_swap (stackful coroutines for the Hu cooperative
// scheduler), so the module now ships ES6 JS glue and owns its own memory, and main() runs
// under Asyncify (returns a Promise). This harness: loads the glue factory, injects the ~123
// host-import stubs via instantiateWasm (WITHOUT clobbering emscripten's own runtime imports
// like emscripten_fiber_swap / emscripten_resize_heap), stages OSBootInfo + the arena, and
// awaits main() — capturing how far the game's own boot code runs and whether a real process
// body emits a GP-FIFO with DRAW primitives (validated by fifo_decode.mjs).
import fs from 'fs';
import { decodeFifo } from './fifo_decode.mjs';

const GLUE = process.env.GLUE || '/tmp/gc_recomp_build/mp4_game.js';
const WASM = process.env.WASM || '/tmp/gc_recomp_build/mp4_game.wasm';

let Module = null;                  // set after the factory resolves
let osReportN = 0, viRetrace = 0, firstFifoPos = 0;
const PUMP = !!process.env.PUMP;
const PUMP_MAX = parseInt(process.env.PUMP_MAX || '8', 10);
const frameLog = [];

// Compile the wasm ourselves so we can enumerate its imports and merge our stubs into the
// emscripten-provided `info.env` inside instantiateWasm.
const wasmBinary = fs.readFileSync(WASM);
const wasmModule = await WebAssembly.compile(wasmBinary);

// Names emscripten's runtime PROVIDES in info.env — must NOT be overwritten by our stubs
// (overwriting emscripten_fiber_swap with a no-op reproduces the exact no-op gclongjmp
// dead-end this whole change exists to fix). Everything else in `env` is a game/OS host
// symbol we stub. We detect emscripten-owned names by prefix + a small explicit set.
const isEmscriptenProvided = (name) =>
  name.startsWith('emscripten_') ||
  name.startsWith('__asyncify') || name.startsWith('asyncify_') ||
  name.startsWith('__wasm') || name.startsWith('invoke_') ||
  name === 'memory' ||
  /^(_?abort|_?assert|proc_exit|fd_write|fd_read|fd_close|fd_seek|environ_get|environ_sizes_get|_tzset_js|_localtime_js|_gmtime_js|_mktime_js|emscripten_date_now|_emscripten_get_now_is_monotonic|getentropy|_setitimer_js|__syscall_.*|segfault|__stack_chk_fail|_munmap_js|_mmap_js|__cxa_.*|setTempRet0|getTempRet0|__handle_stack_overflow|_emscripten_memcpy_js|_emscripten_runtime_keepalive_clear)$/.test(name);

// The set of host-import names (from the wasm's own import section) that are NOT emscripten
// runtime — these are the ones we install stubs for.
const hostImportNames = [];
for (const imp of WebAssembly.Module.imports(wasmModule)) {
  if (imp.kind === 'function' && (imp.module === 'env' || imp.module === 'wasi_snapshot_preview1')
      && !isEmscriptenProvided(imp.name)) {
    hostImportNames.push(imp.name);
  }
}

// Build the one host stub for a given name (matches the pre-fiber harness behavior exactly:
// a few names get real behavior, the rest are no-ops returning 0).
function makeStub(n) {
  return (...a) => {
    if (n === 'OSInit') {
      // Stage the arena (the one job InitMem depends on). 0x80100000..0x81000000 = 15MB, unused
      // (recomp static data lives at low wasm addresses).
      // Full ~24MB MEM1 arena (past the OS globals). 15MB was too small: HuMemInitAll's
      // OSAlloc failed -> "HuMem> Failed OSAlloc" -> OSPanic. Verified 2026-08-22: widening
      // to 0x80004000..0x81800000 clears the OSAlloc panic (now "HuMem> left memory space").
      if (Module._OSSetArenaLo) Module._OSSetArenaLo(0x80004000);
      if (Module._OSSetArenaHi) Module._OSSetArenaHi(0x81800000);
      return 0;
    }
    if (n === 'OSGetTime' || n === '__OSGetSystemTime') return BigInt(Math.floor(performance.now() * 40500));
    if (n === 'OSGetTick') return (performance.now() * 40500) >>> 0;
    if (n === 'OSGetResetCode') return 0;
    if (n === 'OSDisableInterrupts' || n === 'OSEnableInterrupts' || n === 'OSRestoreInterrupts') return 0;
    if (n === 'OSReport') { osReportN++; return 0; }
    if (n === 'VIGetRetraceCount') return viRetrace;
    if (n === 'VIWaitForRetrace') {
      viRetrace++;
      const pos = Module._gx_fifo_pos ? Module._gx_fifo_pos() : 0;
      if (PUMP) {
        frameLog.push(pos);
        if (viRetrace === 1) firstFifoPos = pos;
        if (Module._gx_fifo_reset) Module._gx_fifo_reset();
        if (viRetrace >= PUMP_MAX) throw { __pumpDone: true };
        return 0;
      }
      if (viRetrace === 1) { firstFifoPos = pos; throw { __frame0: true, pos }; }
      return 0;
    }
    return 0;   // everything else: no-op stub
  };
}

// instantiateWasm: emscripten hands us `info` (its full imports incl. its runtime env entries);
// we merge our host stubs into info.env for the names emscripten left as game/OS host symbols,
// then instantiate (async — Asyncify needs the JS-driven instantiate) and hand back the instance.
const instantiateWasm = (info, receive) => {
  info.env ??= {};
  let installed = 0;
  for (const name of hostImportNames) {
    // hostImportNames already EXCLUDES emscripten-owned runtime imports (isEmscriptenProvided),
    // so for these names emscripten only put an abort("missing function") placeholder in
    // info.env — overwrite it unconditionally with our real host stub.
    info.env[name] = makeStub(name); installed++;
  }
  console.log('[harness] host stubs installed:', installed, '/ host import names:', hostImportNames.length,
              '| emscripten_fiber_swap provided by emscripten:', typeof info.env.emscripten_fiber_swap === 'function');
  WebAssembly.instantiate(wasmModule, info).then((instance) => receive(instance, wasmModule));
  return {}; // async path: emscripten waits on receive()
};

// Load the ES6 factory and instantiate.
const createModule = (await import(GLUE)).default;
Module = await createModule({ instantiateWasm, noInitialRun: true });

const mem = Module.wasmMemory;
// Grow to ~2GB so guest 0x80000000 identity-map addresses (OSBootInfo, arena) are in-bounds.
// CRITICAL: grow via emscripten's _emscripten_resize_heap (-> growMemory -> updateMemoryViews),
// NOT a raw mem.grow(). A raw grow leaves emscripten's JS-side HEAPU32/HEAP32 typed-array views
// DETACHED/stale, so the Asyncify fiber runtime (finishContextSwitch reads HEAPU32[fiber+12] for
// the entry function-table index) reads `undefined` and dynCall_vi(undefined,...) traps as
// "null function or function signature mismatch". Refreshing the views is mandatory under the
// glue build. (This was the frame-8 trap.)
const needBytes = 0x82000000;   // headroom above the 0x81800000 arena top
if (mem.buffer.byteLength < needBytes) {
  if (Module._emscripten_resize_heap) {
    const ok = Module._emscripten_resize_heap(needBytes);
    if (!ok) console.log('emscripten_resize_heap to 2GB failed');
  } else {
    try { mem.grow(Math.ceil((needBytes - mem.buffer.byteLength) / 65536)); }
    catch (e) { console.log('memory.grow to 2GB failed:', e.message); }
  }
}
// mem.buffer is re-fetched fresh each call (it changes identity on grow).
const dv = () => new DataView(mem.buffer);
console.log('memory pages after grow:', (mem.buffer.byteLength / 65536) | 0, '(', (mem.buffer.byteLength / 1048576) | 0, 'MB )');

// Stage OSBootInfo at guest 0x80000000 (magic, memSize 24MB, consoleType retail).
try {
  const d = dv();
  d.setUint32(0x80000000, 0x0D15EA5E);      // magic
  d.setUint32(0x80000000 + 4, 0);           // (reserved)
  d.setUint32(0x80000000 + 8, 0x01800000);  // memorySize = 24MB
  d.setUint32(0x80000000 + 0x14, 2);        // consoleType (retail)
} catch (e) { console.log('BootInfo stage failed (addr out of range):', e.message); }

console.log('host import names:', hostImportNames.length, '| main present:', typeof Module._main);
let result = 'ran to completion (no VIWaitForRetrace hit)';
try {
  // main is Asyncify-wrapped -> returns a Promise (it now suspends across fiber swaps).
  await Module._main();
} catch (e) {
  if (e && e.__frame0) result = 'reached FIRST VIWaitForRetrace, fifo_pos=' + e.pos;
  else if (e && e.__pumpDone) result = 'pumped ' + viRetrace + ' retraces (PUMP_MAX), still running';
  else result = 'TRAP/throw after ' + viRetrace + ' retraces: ' + (e && (e.message || e.toString()));
}
console.log('=== main() result:', result);
if (PUMP) console.log('=== per-frame FIFO bytes:', JSON.stringify(frameLog));
console.log('OSReport calls:', osReportN, '| VIWaitForRetrace hits:', viRetrace, '| first-frame FIFO bytes:', firstFifoPos);

// Decode the largest per-frame FIFO for DRAW primitives (the success signal).
function decodeAndReport(label, base, len) {
  if (!(len > 0)) return;
  const buf = Buffer.from(mem.buffer.slice(base, base + len));
  fs.writeFileSync('/tmp/recomp_frame_' + label + '.fifo', buf);
  const { cmds, clean } = decodeFifo(new DataView(buf.buffer, buf.byteOffset, buf.length), buf.length);
  const kinds = {};
  for (const c of cmds) kinds[c.t] = (kinds[c.t] || 0) + 1;
  console.log('=== FIFO DECODE [' + label + ']:', JSON.stringify(kinds), 'clean=' + clean,
              '(cp=CP-reg, xf=matrices/state, bp=blend/tev, draw=primitives)');
  console.log((kinds.draw || 0) > 0
    ? '✓ DRAW PRIMITIVES EMITTED by the game’s own code (draw=' + kinds.draw + ')'
    : ((kinds.cp || kinds.xf || kinds.bp)
        ? '(GP-FIFO registers only, no draw primitives yet)'
        : '(empty/no render commands yet)'));
}

// In PUMP mode the ring is reset each frame; re-run capturing only the last frame's bytes by
// reading the current ring (whatever survived the final frame). Also decode frame 0 if present.
if (firstFifoPos > 0) decodeAndReport('frame0', Module._gx_fifo_base(), firstFifoPos);
// Decode the current (final) ring contents too — a later frame may be the one that draws.
if (PUMP && Module._gx_fifo_pos) {
  const finalPos = Module._gx_fifo_pos();
  if (finalPos > 0) decodeAndReport('final', Module._gx_fifo_base(), finalPos);
  console.log('=== max per-frame FIFO bytes across pump:', Math.max(0, ...frameLog));
}

// sr_boot_stage.js — THE ONE COPY of what BS2 and the apploader leave behind.
//
// [sr-gx 2026-09-04]  Extracted verbatim from sr_image_worker.js, which was the sole
// owner until a second worker (sr_render_worker.js) needed the identical staging.
// Every row of OS_GLOBALS is a cited hardware fact and none of it is new here; the
// citations are the originals, copied without edit.
//
// ⚠ OWED WORK, RECORDED RATHER THAN HIDDEN: RIGHT NOW ONLY sr_render_worker.js IMPORTS
// THIS.  sr_image_worker.js still carries its own copy of these tables, because it was
// under concurrent edit when this was extracted and rewriting a file someone else is
// mid-change on is how two agents lose each other's work.  So these tables exist TWICE
// today, and that is exactly the drift this module was created to end: if the two ever
// disagree, the two workers boot two different machines and any difference in their
// results gets attributed to the thing under test instead of to the drift.  Whoever
// touches sr_image_worker.js next should delete its OS_GLOBALS / EXC_VECTORS / bind() /
// stageFst() / readLog() / summarize() / readDev() and import them from here.
'use strict';

// ---------------------------------------------------------------- OS LOW MEMORY
// What BS2 (the IPL's second stage) and the apploader leave behind before the DOL
// entry point runs.  A static recomp has neither, so the host synthesizes it.
//
// EVERY ROW IS CITED.  Anything not cited is deliberately absent and stays at the zero
// sr_init()'s calloc already guarantees — a wrong non-zero here is far worse than a
// zero, because the guest acts on it.  Citations are to the trees under ~/gc_refs.
export const OS_GLOBALS = [
  // --- the 32-byte disc ID, copied verbatim from the disc.  Dolphin does exactly this
  // (DVDReadDiscID, Boot.cpp:343-349, called from Boot_BS2Emu.cpp:314); the bytes below
  // were read out of the shipped ISO at offset 0.
  [0x80000000, 0x47534E45, 'DVDDiskID.gameName "GSNE"      dvd.h:6-15'],
  [0x80000004, 0x38500000, 'company "8P", diskNumber 0, gameVersion 0'],
  [0x80000008, 0x01000000, 'streaming=1, streamingBufSize=0 (BS2 substitutes 10, Boot_BS2Emu.cpp:322-324)'],
  [0x8000001C, 0xC2339F3D, 'GameCube disc magic            DiscUtils.h:25'],

  // --- OSBootInfo (os.h:110)
  [0x80000020, 0x0D15EA5E, 'OSBootInfo.magic "booted from bootrom"  Boot_BS2Emu.cpp:252'],
  [0x80000024, 0x00000000, 'OSBootInfo.version — Dolphin writes 1 only on Wii (Boot_BS2Emu.cpp:476)'],
  [0x80000028, 0x01800000, '__OSPhysicalMemSize 24 MB      Boot_BS2Emu.cpp:255 / OSMemory.c:7-9'],
  // 0x10000006 = Core.h:78 LatestDevkit.  Dolphin deliberately does NOT use the true
  // retail 0x00000003 and says why at Boot_BS2Emu.cpp:257-259 ("determine why some
  // games fail when using a retail ID").  OSInit rewrites the low bits from PI anyway
  // (OS.c:150), so only the OS_CONSOLE_DEVELOPMENT bit here is load-bearing.
  [0x8000002C, 0x10000006, '__OSConsoleType                Boot_BS2Emu.cpp:260-261'],
  // arenaLo/arenaHi ZERO is correct and self-healing: OS.c:127-131 falls back to the
  // DOL's own linker symbols, and SAB's fallbacks disassemble as __ArenaLo=0x803C3460
  // (0x800e36f8) / __ArenaHi=0x81700000 (0x800e3754).
  [0x80000030, 0x00000000, 'OSBootInfo.arenaLo — 0 => OSInit uses __ArenaLo 0x803C3460  OS.c:127-131'],
  [0x80000034, 0x00000000, 'OSBootInfo.arenaHi — 0 => OSInit uses __ArenaHi 0x81700000'],
  // FST: the ONLY two entries the apploader (not BS2) provides, so a flat-DOL loader
  // does not get them for free.  Left at 0 they are a latent null deref in __DVDFSInit
  // (dvdfs.c:34-35).  The caller stages the real FST from the disc at the disc's own
  // fst_memory_address, so these are written to match — see stageFst().
  [0x80000038, 0x803EDE20, 'OSBootInfo.FSTLocation — disc boot.bin +0x430  nod/src/disc/mod.rs:153'],
  [0x8000003C, 0x000121DB, 'OSBootInfo.FSTMaxLength — disc boot.bin +0x42C  nod/src/disc/mod.rs:151'],

  // --- 0x80000060 MUST BE ZERO.  OSExceptionInit installs the DB integrator ONLY if
  // this word reads 0 (OS.c:243-251, "Lomem should be zero cleared only once by BS2").
  // Listed with its value so the intent is explicit rather than accidental.
  [0x80000060, 0x00000000, 'OS_DBJUMPPOINT_ADDR — must be 0 or the DB integrator is skipped  OS.c:243-251'],

  [0x800000CC, 0x00000000, '__OSTVMode 0 = NTSC            Boot_BS2Emu.cpp:264-265'],
  [0x800000D0, 0x01000000, 'ARAM size 16 MB               Boot_BS2Emu.cpp:268'],
  [0x800000F0, 0x00000000, '__OSSimulatedMemSize — Dolphin GC path leaves 0'],
  // 0x800000F4 = OS_DVD_BI2 (OSHardware.h:95), NOT a debugger function pointer.
  // SAB's __start reads it at 0x80003174 and, if non-zero, dereferences +0xC
  // (OSBI2.debugFlag) and can `blrl` into InitMetroTRK.  BS1 itself zeroes this word
  // (gc-ipl/Bootstrap/boot.s:539-542, "Clear OS pointer to DVD BI2 location"), and
  // Dolphin never writes it.  ZERO IS THE RETAIL VALUE.
  [0x800000F4, 0x00000000, 'OS_DVD_BI2 — 0 skips the MetroTRK path  gc-ipl/Bootstrap/boot.s:539-542'],
  [0x800000F8, 162000000, '__OSBusClock 162 MHz          Boot_BS2Emu.cpp:270'],
  [0x800000FC, 486000000, '__OSCoreClock 486 MHz         Boot_BS2Emu.cpp:271'],
];

// The 15 exception vectors.  Dolphin writes `rfi` (0x4C000064) into each one on a
// direct-DOL boot (CopyDefaultExceptionHandlers, Boot.cpp:481-493).  Nothing in this
// image takes a hardware exception — there is no interrupt source — but OSExceptionInit
// copies over these addresses, and leaving them as zero words means it copies over
// something that is not an instruction.
export const EXC_VECTORS = [0x80000100, 0x80000200, 0x80000300, 0x80000400, 0x80000500,
                            0x80000600, 0x80000700, 0x80000800, 0x80000900, 0x80000C00,
                            0x80000D00, 0x80000F00, 0x80001300, 0x80001400, 0x80001700];
export const PPC_RFI = 0x4C000064;

export const DISP = { 1: 'REAL', 2: 'VOID', 3: 'UNIMPL', 4: 'OS' };

// Bind straight to the wasm exports rather than through cwrap(). cwrap is a RUNTIME
// method and is only attached when it is named in -sEXPORTED_RUNTIME_METHODS; this build
// exports HEAPU8/HEAPU32/wasmMemory and nothing else, so `M.cwrap` is undefined and the
// first draft died on "M.cwrap is not a function". Everything here takes and returns
// plain i32, so the raw export IS the right binding — cwrap would only add a marshalling
// layer none of these signatures need. Missing names are collected and reported instead
// of surfacing later as "undefined is not a function" inside the boot.
export const BASE_WANT = {
  init: '_sr_image_init', loadDol: '_sr_image_load_dol', boot: '_sr_image_boot',
  call: '_sr_image_call', entry: '_sr_image_entry', fault: '_sr_image_fault',
  logPtr: '_sr_image_log', logN: '_sr_image_log_n', logDropped: '_sr_image_log_dropped',
  setGlobal: '_sr_image_set_global', ram: '_sr_ram', ramSize: '_sr_ram_size',
  tailSize: '_sr_tail_size', state: '_sr_state', stateSize: '_sr_state_size',
  devLogPtr: '_sr_image_dev_log', devLogN: '_sr_image_dev_log_n',
  devReads: '_sr_image_dev_reads', devWrites: '_sr_image_dev_writes',
  exiClears: '_sr_image_exi_clears', setExiModel: '_sr_image_set_exi_model',
  setWatchdog: '_sr_image_set_watchdog', setStrict: '_sr_image_set_strict',
  // sr_host_os.c's mode.  sr_image_init() installs SR_OS_IRQ (the MSR family + the
  // clock, no threading); `osMode` is the RUN-TIME switch that widens or narrows it
  // on ONE binary with ONE md5, which is the only way this boundary can be measured
  // against a falsifying control arm without a relink standing between the readings.
  osMode: '_sr_os_mode', osGetMode: '_sr_os_get_mode',
};

export function bindImage(M, extra) {
  const want = Object.assign({}, BASE_WANT, extra || {});
  const api = {}, missing = [];
  for (const [k, name] of Object.entries(want)) {
    if (typeof M[name] !== 'function') { missing.push(name); continue; }
    api[k] = M[name];
  }
  if (missing.length) throw new Error('wasm exports missing from the Module: ' + missing.join(', '));
  return api;
}

// Stage the disc's real File System Table at the address the disc itself names, so
// __DVDFSInit has something to point at.  NOTE WHAT THIS IS NOT: staging the FST does
// not make a DVD read work — there is no DI device model and no disc image in the
// worker.  It removes a null dereference; it does not supply data.
//
// ⚠ KNOWN GAP, stated rather than papered over.  On a real disc boot the APPLOADER sets
// OSBootInfo.arenaLo to just past the FST it just staged.  This stages arenaLo=0,
// because 0 is the value whose consequence is cited (OS.c:127-131 falls back to the
// DOL's own __ArenaLo, which disassembles as 0x803C3460 at 0x800e36f8) and picking any
// other number would be inventing one.  The consequence is that SAB's arena STARTS BELOW
// the FST at 0x803EDE20, so a long enough run of arena allocations would overwrite it.
// That is a fidelity gap in the boot layer, not in the translation, and it is recorded
// here because a boot that dies of it would otherwise look like a translator bug.
export function stageFst(M, a, fst) {
  const FST_ADDR = 0x803EDE20;                 // disc boot.bin +0x430, read from the ISO
  const phys = (FST_ADDR & 0x03FFFFFF) >>> 0;
  if (phys + fst.length > a.ramSize()) return { staged: false, why: 'FST would leave MEM1' };
  M.HEAPU8.set(fst, a.ram() + phys);
  return { staged: true, addr: FST_ADDR, bytes: fst.length };
}

export async function fetchBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Read the boundary log out of linear memory.  The log lives in the wasm heap, so this
// is only legal once the call that filled it has RETURNED — see the one-way-call note
// at the top of sr_image_worker.js.
export function readLog(M, a) {
  const n = a.logN(), base = a.logPtr() >>> 2, out = [];
  const H = M.HEAPU32;
  for (let i = 0; i < n; i++) out.push([H[base + 2 * i] >>> 0, H[base + 2 * i + 1] >>> 0]);
  return { entries: out, dropped: a.logDropped() };
}

// Collapse the ordered log into a run-length trajectory, so 4,000 crossings of the same
// two addresses read as "0x800e78ac x2001" instead of scrolling past the interesting
// part.  The ORDER is preserved; only adjacent repeats are folded.
export function summarize(log) {
  const runs = [];
  for (const [addr, disp] of log.entries) {
    const last = runs[runs.length - 1];
    if (last && last.addr === addr && last.disp === disp) { last.n++; continue; }
    runs.push({ addr, disp, n: 1 });
  }
  const distinct = new Map();
  for (const [addr, disp] of log.entries) {
    const k = addr >>> 0;
    if (!distinct.has(k)) distinct.set(k, { addr: k, disp, n: 0 });
    distinct.get(k).n++;
  }
  return {
    runs: runs.map(r => ({ addr: '0x' + r.addr.toString(16).padStart(8, '0'),
                           disp: DISP[r.disp] || r.disp, n: r.n })),
    distinct: [...distinct.values()]
      .sort((a, b) => b.n - a.n)
      .map(d => ({ addr: '0x' + d.addr.toString(16).padStart(8, '0'),
                   disp: DISP[d.disp] || d.disp, n: d.n })),
    total: log.entries.length,
    dropped: log.dropped,
  };
}

// The DEVICE inventory: the first touch of every distinct hardware register, in order,
// tagged read / write / EXI-model-clear. This is the thing the fixtures could never
// produce, because a fixture never reaches a device.
export const DEVKIND = { 1: 'read', 2: 'write', 3: 'EXI-model-cleared-TSTART' };
export const DEVNAME = (a) =>
  a >= 0xCC006800 && a < 0xCC006C00 ? 'EXI'  : a >= 0xCC006400 ? 'SI'  :
  a >= 0xCC006000 ? 'DI'   : a >= 0xCC005000 ? 'DSP/AI' : a >= 0xCC004000 ? 'MI' :
  a >= 0xCC003000 ? 'PI'   : a >= 0xCC002000 ? 'VI'     : a >= 0xCC001000 ? 'PE' : 'CP';
export function readDev(M, a) {
  const n = a.devLogN(), base = a.devLogPtr() >>> 2, H = M.HEAPU32, out = [];
  for (let i = 0; i < n; i++) {
    const addr = H[base + 2 * i] >>> 0;
    out.push({ addr: '0x' + addr.toString(16), block: DEVNAME(addr),
               kind: DEVKIND[H[base + 2 * i + 1]] || H[base + 2 * i + 1] });
  }
  return { firstTouch: out, reads: a.devReads(), writes: a.devWrites(), exiClears: a.exiClears() };
}

// THE LOW-MEMORY + DOL STAGING, in the order sr_image_worker.js established.  Globals
// AFTER the DOL copy: the DOL's own sections do not reach below 0x80003100, but the
// order makes the dependency explicit rather than incidental.
export async function stageBoot(mod, api, base) {
  const dol = await fetchBin(base + 'sab_main.dol');
  const p = mod._malloc(dol.length);
  mod.HEAPU8.set(dol, p);
  const copied = api.loadDol(p, dol.length);
  mod._free(p);
  if (copied >>> 24 === 0xC6) throw new Error('sr_image_load_dol failed: 0x' + (copied >>> 0).toString(16));

  let fstInfo = { staged: false, why: 'not fetched' };
  try { fstInfo = stageFst(mod, api, await fetchBin(base + 'sab_fst.bin')); }
  catch (err) { fstInfo = { staged: false, why: String(err && err.message || err) }; }

  for (const [ea, v] of OS_GLOBALS) api.setGlobal(ea >>> 0, v >>> 0);
  for (const ea of EXC_VECTORS) api.setGlobal(ea >>> 0, PPC_RFI);

  return { dolBytes: dol.length, copied, fst: fstInfo };
}

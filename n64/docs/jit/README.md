# N64 JIT campaign — architecture and ground truth

Goal (user directive 2026-06-12): fix the N64 stack the way the GameCube stack
is being fixed — a real MIPS R4300i → wasm JIT in the bementalJIT mold, not
interpreter-throughput acceptance. Acceptance bar matches GC: games running
at native speed or faster, sustained, in-game.

Everything below is cited against the live tree (researcher sweep 2026-06-12,
3 agents over `n64/N64Wasm/code/`, `gamecube/bementalJIT/`, and the dist
build). Paths are relative to `n64/N64Wasm/code/` unless noted.

## What the wasm build actually is

- Single-module, single-threaded (no pthreads, `-DNO_LIBCO`, `-DNO_ASM`)
  emscripten build of mupen64plus + glide2gl, libretro frontend
  `src/libretro/libretronew.c` (NOT libretro.c) — Makefile:56,147-176.
- CPU core: **cached interpreter only**. `-DDYNAREC` is never defined; the
  hacktarux x86 dynarec and new_dynarec sources are not in CFILES. emumode
  defaults to 1 (main.c:170-172); selecting 2/3 silently coerces back to the
  cached interpreter in r4300_init (r4300.c:121-133). The libretro option
  path that would select "neb_dynamic_recompiler" (=3) is gutted
  (config.c:987-1005 — environ_cb lookup commented out).
- **Build reproducibility: PROVEN 2026-06-12** (commit on dev). Two
  implicit-int fixes; `source emsdk/emsdk_env.sh && cd n64/N64Wasm/code &&
  make -j8` links clean under emsdk 3.1.67 and the rebuilt wasm boots
  Mario Kart at 98% speed headless. NOTE (corrected 2026-08-29): the
  Makefile now reads `TOTAL_MEMORY=536870912` (Makefile:185) — 512MB,
  matching the vendored dist. The old "Makefile is 1GB, dist is 512MB"
  warning was resolved by the M1 re-link and is no longer a live trap.

## The seam (why this port is CHEAPER than GC's)

The cached interpreter **is already a block recompiler**: recomp.c is live in
the link. `recompile_block` (recomp.c:2353) lazily builds per-4KB-page
`precomp_block` entries holding `precomp_instr` arrays whose `ops` field is a
**per-instruction function pointer** (recomp_types.h:30-32), discovered via
NOTCOMPILED stubs (cached_interp.c:209-231), cached in `blocks[0x100000]`
with `invalid_code[0x100000]` page invalidation (cached_interp.c:55-57).

Therefore: **a JIT block is a wasm funcref installed as the block-head
`ops` pointer.** `PC->ops()` (r4300.c:183) is already a wasm
indirect_call through the function table; a JS-instantiated per-block module
importing the main memory can read/write all guest state (reg[], hi, lo, PC,
g_cp0_regs, next_interrupt — r4300.c:55-62) directly. Zero dispatcher
changes. The compile bridge is an EM_ASM call at NOTCOMPILED time returning a
table index (precedent for EM_ASM→myApp in mymain.cpp:547-556 and
libretronew.c).

Do NOT integrate by filling the 245 `gen*` stubs in empty_dynarec.c — that
surface is x86/precomp-coupled (recomp.h:48 pulls hacktarux assemble.h under
DYNAREC; dynarec_setup_code is `#if !defined(NO_ASM)` — r4300.c:82-93, a
compile error under the wasm flags).

## The contract a JIT block must honor (boot-killer list)

1. **Interrupt polling**: `Count` advances lazily via cp0_update_count
   (`Count += ((PC->addr - last_addr)>>2) * count_per_op`, count_per_op=2 —
   cp0.c:87-99) and `if (next_interrupt <= Count) gen_interrupt()` is polled
   ONLY at jump/branch tails (DECLARE_JUMP, cached_interp.c:73-106 at :104),
   MTC0 Count/Compare, and ERET. The VI interrupt fired INSIDE the
   instruction stream is what ends each retro_run frame (gen_interrupt
   VI_INT → retro_return → stop_stepping; r4300_step exits only when
   stop_stepping AND VI_Count>0 — r4300.c:175-196, interrupt.c:569-578).
   A block that spins without polling wedges the tab (single-threaded; the
   GC/DC ISR-not-delivered class — see memory
   feedback_isr_not_delivered_pattern).
2. **One retro_run == one VI frame** (~394K instructions at NTSC V_SYNC 524,
   count_per_op 2). Frame pacing lives inside the CPU loop, not outside.
3. **Delay-slot exceptions**: skip_jump two-phase redirect (exception.c:143-145,
   interrupt.c:547-561, cached_interp.c:93/124) — EPC/BD corruption shows up
   as rare misjumps, not crashes. Subtlest part of the port.
4. **Invalidation** is page-granular and lazy: `invalid_code` set by
   CHECK_MEMORY on stores, write_nomem*, and PI-DMA; KSEG0/KSEG1 aliases
   (addr^0x20000000) and TLB physical twins (init_block validates the
   physical-page sibling — recomp.c:2279-2327) must all be honored; a
   running block is never patched mid-flight (invalidation bites at next
   jump_to). adler32 CRC revalidation on TLB rewrites is perf-critical for
   TLB-heavy games.
5. **Savestates**: serialize only runs between retro_run calls (JS-invoked,
   single-threaded), so flush-at-block-exit register writeback is
   sufficient; savestate load calls invalidate_r4300_cached_code(0,0)
   (r4300_core.c:127-142) — the JIT must flush everything on that path and
   rebuild lazily like NOTCOMPILED.

## Required re-link changes (verified absent today)

- `addFunction`/reserved table slots + `-sALLOW_TABLE_GROWTH` (no occurrence
  in dist/n64wasm.js or Makefile link flags:181-197).
- Memory is non-shared, importable, fixed max==initial — fine for
  per-block module imports.
- Sync `new WebAssembly.Module` on the main thread is size-limited in Chrome
  (believed ~4KB; UNVERIFIED) — design for async compile with interpreter
  execution until the funcref lands (the NOTCOMPILED structure already
  supports exactly this).

## bementalJIT port pattern (from the GC fork)

- N64 gets a **full fork**: `n64/bementalJIT/` with `guests/mips/` only —
  per the de-sharing convention (GC owns gamecube/bementalJIT, DC owns root
  bementalJIT). Never add a guest to another console's fork.
- The "guest-agnostic" core is NOT agnostic: block_cache.cpp hardcodes
  ppc_* import names, Module._dolphin_* exports, GC watch PCs and region
  bounds (block_cache.cpp:14-94,122-216,377-379,590-598). Rename every seam
  FIRST and prove one block instantiates — a name mismatch silently binds
  zero imports and falls back 100% to interpreter with a swallowed
  console.error (documented at block_cache.cpp:147-154).
- Blocks: nullary wasm functions returning next-PC; per-op emitters with a
  block-local register cache; per-op interpreter-fallback import for
  unported ops (the gencallinterp role).
- Testing is three-tier (GC pattern): unit corpus with red-test discipline
  (a red test must be a VALID repro), JIT-vs-interpreter differential with
  PASS/FAIL/FALLBACK tri-state, puppeteer conformance runner
  (gamecube/tools/conformance/run.mjs is the model).

## Oracles and references

- **In-process oracle**: the cached interpreter itself — same binary,
  differential per-block reg-state diffing (the GC test_diff pattern).
- **Native oracle**: `mupen64plus` (brew, /usr/local/bin/mupen64plus) — same
  core lineage natively with a real dynarec; the "native Dolphin" role.
- **Reference recompilers** (the Jit64-parity role): upstream mupen64plus
  new_dynarec; the in-tree NEW_DYNAREC seam description (new_dynarec.h:36-47,
  pcaddr/pending_exception-based) documents the alternative integration.
- **N64 SDK**: ~/n64_refs/sdk-ultra (libultra headers usr/include/PR/*.h,
  man pages at ~/n64_refs/man) — OS symbol identification, HLE candidates,
  idle-loop shapes (the dolsdk role).
- **Harnesses**: tools/n64_boot_test.mjs (boot/speed via audio rate),
  tools/n64_page_test.mjs (shell e2e). Audio truth: speed = audio write rate
  vs 88200 i16/s; the core's GameFPS overlay is the game's internal
  framerate, NOT emulator speed.

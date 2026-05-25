# Dreamcast SH4 — PSO boot blocker + emitter unit test — handoff (2026-05-25)

Branch: **`dreamcast-sh4-loop-exit`** (pushed to origin). Last commits:
- `7a83470` — SH4 loop-region diagnostics (rec_wasm.cpp: interrupt_pend/r13 snapshot @0x8c02c16a, blockdump target10 @0x8c02ab54).
- (WIP) — SH4 area-1 VRAM-store swizzle fastpath (wasm_emit.cpp) + emitter unit test (test_sh4_dispatch.cpp, INCOMPLETE).

> NOTE on isolation: all DC work lives in `dreamcast/flycast-bridge/*` and `bementalJIT/guests/sh4/*` (SH4-only; GC uses `guests/powerpc/`). NEVER edit `bementalJIT/src/*` (shared with GameCube). The Dreamcast build (`dreamcast/build_and_probe.sh`) hardcodes `ROOT=/Users/.../Bemental77.github.io` (build_and_probe.sh:57, flycast_worker_link.sh:14) and `build-wasm/` exists only in the main checkout — so a git worktree does NOT isolate the DC build (it compiles the main tree). Verify build freshness by grepping a new marker in the built `.wasm`/`.js` AND checking mtime > edit.

## 1. The blocker (what PSO is stuck on)

PSO Ver.2 (MK-51193) boots through REIOS, hits 4 init milestones, renders ONE HW frame, then makes no further progress. It is stuck in an **8 MB VRAM-clear loop** that does not complete in any observed run window.

- Loop structure (SH4, from native bytes): outer counter block `0x8c02ab54` (`add #1,r13; cmp/ge r12,r13; bf/s 0x8c02ab4c`, limit `r12=0x200000`), calls inner 4-byte copy via `jsr @r11` (`r11=0x8c02c15e`), which `rts` at `0x8c02c16a` → returns to `0x8c02ab54`. Dst is VRAM `r14=0xa5xxxxxx` (phys `0x05xxxxxx`), `r14 += 4`/iter. = 0x200000 × 4 bytes = 8 MB clear.

### What is PROVEN (cited, not asserted)
- **Codegen is correct.** `wasm2wat` of the emitted `0x8c02ab54` and `0x8c02c16a` blocks matches the SH4 semantics exactly (r13++, cmp/ge signed, bf/s targets `0x8c02ab4c`/`0x8c02ab5c`, delay-slot r14+=4; rts sets pc=pr when interrupt_pend==0). `r13` advances monotonically across runs (`0→0x118c30` release / `0→0xe7ef0` w/ VRAM fix). So **no logic/port-gap in this loop**.
- **Native flycast+REIOS runs the identical loop and exits**, reaching game code (`0x8c12/0x8c1e/0x8c37/0x8c3c`, up to `0x8c3f6ae0`). Differential: our JIT trajectory = 0 out-of-set blocks vs native (decoder is shared). So it is purely a SPEED-of-completion gap, not wrong control flow.
- **Dispatcher/INTC bridge is a faithful port.** Our mainloop calls `UpdateSystem_INTC()` per `SH4_TIMESLICE` (rec_wasm.cpp:1691-92) + SR-change `UpdateINTC`, matching `sh4_interpreter.cpp:67-68/185-192`. `interrupt_pend==0` at the spin (verified) → the "Fix A" per-block interrupt prologue is NOT firing / not the cause.

### What is NOT proven (do NOT assert)
- That the blocker is "throughput." The loop is correct + progressing, but I never measured a clean build COMPLETING it and booting past `0x8c02ab5c`. Every "wedge here" was a DIAG build (per-dispatch EM_ASM dominates) OR a release build that also didn't finish in-window. The per-outer-iteration cost looked ~tens of µs even on release, far above the ~126ns/dispatch figure — UNEXPLAINED; the dispatcher round-trip per iteration is the suspect but unmeasured.

## 2. The VRAM-store fastpath fix (WIP, committed, uncommitted-correctness)

`bementalJIT/guests/sh4/wasm_emit.cpp` shop_writem fastpath previously covered only areas 4/5 with a LINEAR offset. But:
- PSO clears area-1 32-bit VRAM (phys `0x05xxxxxx`; `masked>>24 == 5`), which area-4/5 didn't match → fell to the slow `WIMPORT_WRITE32` import per word.
- flycast maps these via `pvr_write32p`→`pvr_map32` (bank-interleaved 64-bit bus, pvr_mem.cpp:289), NOT linear. `VRAM_MASK` is a runtime macro (`settings.platform.vram_mask`); DC=`0x7FFFFF`.

Fix added an area-1 case baking the swizzle: `off = (m&3) | ((m&0x3FFFFC)<<1) | ((m&0x400000)>>20)`. (Algebraically == pvr_map32 for DC; see unit test.) Result: ~6x faster inner writes on DIAG (`r13` 0xe7ef0/run vs 0x6ddd0 in a longer pre-fix run) but **loop still did not complete** → the VRAM write was *a* cost, not the whole cost.

OPEN: the existing area-4/5 path still uses LINEAR offset where flycast uses the swizzle — likely a latent correctness bug for any game hitting area-4/5 (not exercised by PSO). Did not touch it.

## 3. Emitter unit test (the current task — INCOMPLETE)

Goal: unit-test the SH4 emitter host-side to escape the build-probe-emulator loop. `bementalJIT/tests/test_sh4_dispatch.cpp` extended with:
- **Test A (compiles, should pass):** the baked VRAM swizzle == flycast `pvr_map32` over the 8 MB range. Pure arithmetic, validates the fix's math.
- **Test B (BLOCKED):** `build_block` of a single `shop_writem` size=4 to a VRAM register, scan emitted bytes for the swizzle mask constants (`0x3FFFFC` LEB = `fc ff ff 01`, `0x400000` = `80 80 80 02`).

### Build setup (works)
SH4 test is gated `if(BEMENTAL_GUEST_SH4)` (tests/CMakeLists.txt:226) and is an EMSCRIPTEN target (`SUFFIX .html`, run via node). Neither `build-test` nor `build-emcc` enables SH4 (both PowerPC). Created a dedicated SH4 build:
```
source emsdk/emsdk_env.sh
cd bementalJIT
emcmake cmake -S . -B build-sh4-test -DBEMENTAL_GUEST_SH4=ON -DBEMENTAL_BUILD_TESTS=ON
cmake --build build-sh4-test --target test_sh4_dispatch     # SH4-only; PowerPC lib not built
node build-sh4-test/tests/test_sh4_dispatch.js
```
(SH4 CMake auto-finds flycast-src at `../dreamcast/flycast-src`, guests/sh4/CMakeLists.txt:13-14.)

### Mocked flycast link deps (added to the test, resolve so the emitter links host-side)
`getRegOffset`, `rdv_writeMemImmediate`, `rdv_readMemImmediate`, `fatal_error`, `os_DebugBreak`, `ReadMem16` (function-pointer global). Their values don't affect the swizzle constants Test B scans.

### CURRENT BLOCKER (where it stopped)
Link error: `undefined symbol: RuntimeBlockInfo::~RuntimeBlockInfo()` and `vtable for RuntimeBlockInfo`. Constructing a `RuntimeBlockInfo` on the stack (for Test B's `build_block(&blk)`) needs its vtable/dtor from `blockmanager.cpp` (the exact "drags in blockmanager.cpp" the original test comment warned about).

### Paths forward for Test B (pick one)
1. **Avoid RuntimeBlockInfo**: test `emitShilOp()` directly (it's public) with a `WasmModuleBuilder` + `RegCache` + a stack `shil_opcode`, passing `block=nullptr`. Need to confirm `emitShilOp(shop_writem,...)` + `tryEmitWriteMemImmediate` don't deref `block` on the register path (they likely only use it for the immediate-EA case). This sidesteps the vtable entirely. **Recommended.**
2. Provide a host stub for `RuntimeBlockInfo`'s vtable/dtor (define `~RuntimeBlockInfo()` + a minimal vtable) — fragile.
3. Link `blockmanager.cpp` — cascades into more flycast deps; avoid.

Test A alone is already a worthwhile unit test (validates the swizzle math). Splitting Test A into a tiny standalone (no emitter link) would give an instant always-green check.

## 4. Concrete next steps (priority order)
1. Finish Test B via path #1 (emitShilOp + nullptr block) → green emitter unit test for the VRAM fastpath. Run via the build-sh4-test recipe above.
2. Decide the real loop fix (performance, not codegen): the per-outer-iteration dispatcher round-trip via the dynamic `rts` at `0x8c02c16a`. `PR` is a constant (`0x8c02ab54`) at this site — a "dynamic-jump-to-constant → tail-link" optimization would keep the loop in wasm and likely let the 8 MB clear complete. Alternatively the broader table-dispatch throughput work (docs/nasomers-table-dispatch/TASKS.md).
3. Re-measure on a CLEAN release build whether the loop completes + boot advances past `0x8c02ab5c` (release emits no PC trace; the `[pr-snap]` r13 dump in rec_wasm.cpp DOES fire in release — watch r13 reach `0x200000`). Gate freshness.
4. Audit the area-4/5 writem fastpath (linear vs pvr_map32 swizzle) for the latent correctness bug.

## 5. Useful artifacts/logs
- Native oracle: re-stage `/tmp/flycast-lr2` (core from `flycast-src/build-libretro-native/`) + `/tmp/pso/` (disc from `dreamcast/discs/pso2/`, reassemble Track3.bin from `.parta*`), flip Flycast.opt `flycast_hle_bios=enabled` for REIOS, run `dreamcast/run_native_flycast.sh`; trajectory = `rdv_FailedToFindBlock` PCs in the log.
- Probe logs in `/tmp/dc-probes/`: `vramfix.log` (DIAG, fix on), `relr13.log` (release pre-fix), `loopdrive.log` (long DIAG). `[pr-snap]` lines carry r13.
- `wasm2wat --enable-threads --enable-tail-call` to decode `[blockdump]` hex from probe logs.

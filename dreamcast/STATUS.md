# Dreamcast WASM Bring-Up — STATUS / HANDOFF

Last updated: 2026-05-15. Branch: `dev` (changes uncommitted).
Read time: ~5 minutes. Designed so the next session can pick up the work without loading 20+ memory files.

---

## 1. Goal & acceptance bar

Port Flycast to WebAssembly under the same JIT pipeline as PS1/N64/SNES/GBA/GameCube, with `bementalJIT` as the SH4 emitter. **First-signal target: PSO Ver.2 USA (MK-51193) boots to title screen.** Sustained acceptance bar: **>=100% native SH4 speed** under V8 (mirrors `feedback_native_speed_acceptance.md`). Time is not a metric; correctness + speed are. We do **not patch `dreamcast/flycast-src/`** — all bridging lives in `dreamcast/flycast-bridge/` + `bementalJIT/guests/sh4/` (mirrors `feedback_no_dolphin_patching.md`).

## 2. Current state in one sentence

Reios HLE BIOS path boots cleanly through ~597K SH4 dispatches into IP.BIN execution, then the JIT diverges from real hardware: an `RTS` epilogue at PC=`0x8c008a8a` loads PR=`0x8c009dd1` from stack and jumps into the IP.BIN glyph-metrics **data** table at `0x8c009dd0..dd4`, where byte `0x0d52` triggers `Sh4Ex_IllegalInstr`. The bad PR was written 8 times by an iteration loop at PC=`0x8c0086ba`; root cause is upstream JIT correctness producing values that real hardware does not — RegCache PR/R15 coherency has been **ruled out**.

## 3. Layered architecture

| Layer | What it is | Where it lives |
|---|---|---|
| Page / shim worker | `dreamcast.html` boots `flycast_worker.js`, which `importScripts('flycast_worker_emcc.js')`. Owns canvas, audio, controller, ROM upload. | `/dreamcast.html`, `dreamcast/flycast_libretro/flycast_worker.js` |
| Emscripten worker bridge | Hand-written C++ wrapping libretro (`retro_init`/`load_game`/`run`). Owns video_cb, GD-ROM log, `sh4_interp_shil_fb` SHIL fallback, dispatch sampler bootstrap, force-keep `__emscripten_thread_crashed`. | `dreamcast/flycast-bridge/EmscriptenWorker.cpp` |
| WasmDynarec (rec_wasm) | Subclass of Flycast's `Sh4Dynarec`. Owns `mainloop` (cycle counter + INTC pump + region trap + PC ring + try/catch SH4 exceptions). `compile()` invokes bementalJIT and registers the resulting WASM module by vaddr. | `dreamcast/flycast-bridge/rec_wasm.cpp` |
| SHIL-to-WASM emitter | Per-block SHIL ops -> WASM bytes via `WasmModuleBuilder`. RegCache for ctx fields, area-3 RAM fast-path, native FPU emit, IFB fallback. Emits `UpdateINTC` sentinel call (`0xFFFFFFFFu`) at `BET_*Intr` block exits. | `bementalJIT/guests/sh4/wasm_emit.{h,cpp}` |
| Flycast core | Upstream Flycast (~main, shallow). Built as a single static archive `libflycast_libretro.a` under emscripten with patches 0001-0008 in `flycast-bridge/patches/`. | `dreamcast/flycast-src/` (gitignored) |
| Reios HLE BIOS | Active path. With BIOS embed disabled, `nvmem::loadFiles()` returns false and Flycast takes `loadHle()`. Reios skips `OSCheckRunQueue`-style init that real BIOS performs. | `flycast-src/core/reios/...` |

## 4. Build / link / probe

Canonical inner loop:

```bash
bash /Users/caseybement/Bemental77.github.io/dreamcast/build_and_probe.sh                # full: bementalJIT + link + probe -> /tmp/probe-dc.log
bash /Users/caseybement/Bemental77.github.io/dreamcast/build_and_probe.sh --skip-link    # JS-only iteration
bash /Users/caseybement/Bemental77.github.io/dreamcast/build_and_probe.sh --duration 60000  # 60s probe
bash /Users/caseybement/Bemental77.github.io/dreamcast/build_and_probe.sh --name baseline   # archive to /tmp/dc-probes/baseline.log
```

Build state (2026-05-15 ~13:03):
- `dreamcast/flycast_libretro/flycast_worker_emcc.{js,wasm}` (~8.4 MB wasm)
- `/tmp/flycast-lr2/flycast_libretro.dylib` — native libretro core (rec-x64), works in RetroArch with the same Reios config
- `/tmp/flycast-native/` — failed standalone Flycast.app build (Cocoa link error; needs Xcode, only CLT installed)

## 5. Confirmed bugs fixed (chronological)

Listed oldest first. All are still in the tree.

| # | Date | Bug | Fix | File:line |
|---|---|---|---|---|
| 1 | 05-13 | Patches 0001-0008 — Flycast doesn't know `__EMSCRIPTEN__`; fails to detect arch, hits `#error` in `build.h`, `__cxa_throw` etc. | 8 patches under `flycast-bridge/patches/`; applied via `apply_patches.sh`. | `dreamcast/flycast-bridge/patches/0001..0008-*.patch` |
| 2 | 05-14 | Bridge: `framebufferWidth/Height = 0` because we never called `retro_get_system_av_info` after `retro_load_game`. Every `video_cb` was `data=0 w=0 h=0`. | Pump `retro_get_system_av_info` after load. | `EmscriptenWorker.cpp` `emscripten_worker_init` |
| 3 | 05-14 | `config::ThreadedRendering=true` default + emcc asyncify => `mainloop` never enters. | `config::ThreadedRendering.override(false)` | `EmscriptenWorker.cpp` |
| 4 | 05-14 | `CustomTextures=true` default => `pending_preloads>0` forever => `retro_run` early-returns at texPreloading. | `CustomTextures.override(false)` + `PreloadCustomTextures.override(false)` + still `mkdir /bios/dc/textures/<gameId>/` to avoid `StorageException`. | `EmscriptenWorker.cpp`, `flycast_worker.js` |
| 5 | 05-14 | **`ram_base = 0`** passed to JIT trampoline. Area-3 fast path computed `wasmMemory[0..16MB]` while host disc DMAs landed in `mem_b` (host malloc). IP.BIN invisible to SH4. | `s_ram_base = (uintptr_t)GetMemPtr(0x0c000000, 1)` lazily on first call. | `rec_wasm.cpp:126-128` |
| 6 | 05-15 | **`sh4_interp_shil_fb` was a no-op stub.** `shop_sync_sr` -> `UpdateSR()` (bank swap on SR.RB flip) and `shop_sync_fpscr` -> `Sh4Context::UpdateFPSCR(ctx)` never ran. RTE flipping RB 1->0 saw uninitialised `r_bank` -> wild PC. | Look up `bm_GetBlock(block_vaddr)->oplist[op_idx].op` and dispatch. | `EmscriptenWorker.cpp:769-794` |
| 7 | 05-15 | **IFB-PC convention.** `sh4_interp_ifb` expects `Sh4cntx.pc == current_op_pc + 2` (per `sh4_interpreter.cpp:21-39 ReadNexOp`). Our `shop_ifb` emit + synthesized fallback were off by 4/6 bytes. | Use `op.rs2._imm` / `op_addr + 2`. | `bementalJIT/guests/sh4/wasm_emit.cpp:551,1183` |
| 8 | 05-15 | **PC bit-0 not masked on dispatch.** Real SH4 fetches at `(PC & ~1)`. Flycast decoder emits `dec_DynamicSet` for JMP/JSR/RTS/RTE without masking, relying on hardware tolerance. Native rec-x64 inherits this. We didn't. Odd PC -> misaligned 16-bit decode -> garbage opcodes -> `Sh4Ex_IllegalInstr`. | `next_pc &= ~1u` in `wasm_block_trampoline`. | `rec_wasm.cpp:139` |
| 9 | 05-15 | **Missing `UpdateINTC` tail-call at `BET_*Intr` block exits.** Native rec-x64 does `GenCall(UpdateINTC)` at `rec_x64.cpp:530`. Without it, an SR change that just opened an IRQ never refreshes `decoded_srimask` -> Do_Interrupt blind to the pending IRQ. | Emit sentinel constant `0xFFFFFFFFu` + SHIL_FB import call at end of `BET_StaticIntr`/`BET_DynamicIntr` blocks; `sh4_interp_shil_fb` recognises sentinel and routes to `UpdateINTC()`. | `wasm_emit.cpp:1125-1140`; `EmscriptenWorker.cpp:769-777` |

## 6. Active blocker — IP.BIN divergence at `PC=0x8c009dd4`

### Evidence chain (from `/tmp/probe-dc.log`)

```
[lsb-trip] #1..#8 write32 addr=0x7e000f70 val=0x8c009da7..dd1 guest_pc=0x8c0086ba r15=0x7e000f70 pr=0x8c00866e
[pr-trip] block pc=0x8c008a8a -> 0x8c009dd0 pr=0x8c009dd1 r15=0x7e000f74 r0=0x0 dispatch=#597380
[exception] #1 epc=0x8c009dd4 expEvn=0x180 sr=0x400000f1 vbr=0x8c000000 ssr=0x40000001 spc=0x8c000776
[exception] #2 epc=0x8c000100 expEvn=0x180 sr=0x700000f1 vbr=0x8c000000 ssr=0x400000f1 spc=0x8c009dd4
```

### Static IP.BIN proof (`/tmp/ipbin.dis`, produced by `dreamcast/tools/sh4dis.py`)

The function epilogue at `0x8c008a8a`:

```
8c008a8a: 7f28    add #40,R15
8c008a8c: 4f26    lds.l @R15+,PR
8c008a8e: 000b    rts
8c008a90: 0009    nop
```

The function prologue is at `0x8c00898c` (`sts.l PR,@-R15; add #-40,R15`) — frame is 4 (PR) + 40 (locals) = 44 bytes; epilogue is symmetric.

The loop that wrote PR at `PC=0x8c0086ba` is glyph-metrics table iteration (3-byte stride):

```
8c0086ba: 63f2    mov.l @R15,R3        ; load pointer P
8c0086bc: 8432    mov.b @(0x2,R3),R0   ; read byte at P+2 (glyph metric)
...
8c0086c6: 61f2    mov.l @R15,R1
8c0086c8: 7103    add #3,R1            ; P += 3
8c0086ca: 2f12    mov.l R1,@R15        ; store P back
8c0086cc: 53fa    mov.l @(0x28,R15),R3
8c0086ce: 7301    add #1,R3
8c0086d0: 1f3a    mov.l R3,@(0x28,R15)
8c0086d2..d8:                          ; loop terminator: cmp/ge + bf 0x8c0086a8
```

Values 0x8c009da7..0x8c009dd1 are pointers **into** the glyph metrics table starting at ~0x8c009d44. The data at 0x8c009dc0..d4 is `bd00 bd00 bd00 bd00 bd00 bd00` (six adjacent half-words that disassemble as `bsr` but are obviously a packed table). On real hardware this loop terminates with R15 unchanged and PR untouched. **Our JIT lets the loop write 8 stale pointers into stack slot `[0x7e000f70]`, then a later `lds.l @R15+,PR` at `0x8c008a8c` pops one of them as the return address.**

### What is and isn't proven

| Hypothesis | Status |
|---|---|
| RegCache PR (offset 0x140) coherency bug | **RULED OUT** — Researcher 1 disabled cache for both PR and R15 (offset 0xFC); throw was identical. |
| Audit of all hot SHIL emit ops | Researcher 3 found **no semantic bug** in `wasm_emit.cpp`. One unrelated finding: `shop_pref` not handled in `sh4_interp_shil_fb` — only matters for SQ-region store-queue writes (post-graphics path), not relevant here. |
| WasmModuleBuilder layer | **Untested** — researcher 3 flagged this as a candidate. Bytes-correctness not yet validated against a known-good emit. |
| Real hardware ever hits PC=0x8c009dd4 | **NO** — IP.BIN bytes there are table data, not code. Native Flycast (rec-x64) loads same disc + same Reios HLE config and **boots PSO** — confirmed in RetroArch via `/tmp/flycast-lr2/flycast_libretro.dylib`. |

### Why the second exception cascades to fatal

The first throw at `0x8c009dd4` should vector through `vbr+0x100 = 0x8c000100`. Reios doesn't install a general-exception handler there (memory is uninit, op=0xffff). Cascading exception -> fatal. emcc thread runtime then references `__emscripten_thread_crashed` which our build still drops via LTO despite `-Wl,-u,_emscripten_thread_crashed` (line 189 of link script) + a keep-alive function. Visible in probe as `[pageerror] __emscripten_thread_crashed is not defined`.

## 7. Reios A/B — what we learned about the real-BIOS path

Disabling the BIOS embed (commenting out `--embed-file ".../DC - BIOS.bin@/bios/dc/dc_boot.bin"` in `flycast_worker_link.sh`) forces Reios. Note that `config::UseReios.override(true)` does **not** work because `loadGameSpecificSettings` (`emulator.cpp:849-869`) reloads from saved config and clobbers our override.

| Path | Dispatch #1-#2 SR | BL | First IRQ delivered? |
|---|---|---|---|
| Real BIOS (embed enabled) | sr=0x700000f0 (RB=1, BL=1) — never clears | 1 | Never (the BL-clearing `LDC SR` itself depends on an IRQ that never fires) |
| Reios (embed disabled, current) | sr=0x400000f1 by dispatch #3 (RB=0, BL=0) | 0 | Yes |

So real-BIOS stalls because **no IRQ delivery -> BL stuck high**. Likely a JIT bug in BIOS's "clear BL" path (probably the `LDC SR`/`RTE` SR-write emit that should now be correct after fix #6+#9 but hasn't been re-tested with the BIOS embed re-enabled).

## 8. What we ruled out (so we don't redo)

- RegCache PR/R15 coherency (researcher 1 A/B).
- `sync_sr` / `sync_fpscr` — fixed (bug #6).
- `ram_base=0` — fixed (bug #5).
- IFB-PC off-by-N — fixed (bug #7).
- PC bit-0 retention on dispatch — fixed (bug #8).
- Missing `UpdateINTC` after SR-changing block — fixed (bug #9, but downstream of the active blocker).
- Area-3 fast-path slowpath inversion — checked, correct.
- All hot SHIL emit ops — researcher 3 audit found no semantic bug.
- "Threaded rendering / texture preload paths" — disabled at config (bugs #3, #4).

## 9. Tools available locally

| Tool | Path / command | Use |
|---|---|---|
| `build_and_probe.sh` | `dreamcast/build_and_probe.sh` | Full or `--skip-link` rebuild + headless probe |
| `flycast_probe.js` | `dreamcast/tools/flycast_probe.js` | puppeteer-driven boot of `dreamcast.html`; auto-clicks Start; filters emcc noise; writes `/tmp/probe-dc.log` |
| `sh4dis.py` | `dreamcast/tools/sh4dis.py` | Custom 250-line SH4 disassembler. `sh-elf-objdump` is **not available**. |
| Native libretro core | `RetroArch -L /tmp/flycast-lr2/flycast_libretro.dylib /path/to/PSO.cue` | Boots PSO with same Reios config -> ground-truth oracle for memory/register state |
| RetroArch | `/Applications/RetroArch.app/Contents/MacOS/RetroArch` (1.16.0) | Loads `.dylib` cores via `-L` |
| redream | `dreamcast/oracle/redream/redream` | Closed-source x86_64 native DC emu; boots PSO; `--gdb` flag exists but doesn't expose listening port; visual sanity check only |
| lldb | `/usr/bin/lldb` | SIP blocks attaching to running processes — must launch under lldb |
| emcc / emsdk / node24 (nvm) / puppeteer | `Bemental77.github.io/emsdk/`, `nvm use 24` | Build + probe |
| cmake / brew / SDL2 / libpng / zlib | system | Native lib build deps |

**Not available**: Xcode (only CLT — standalone Flycast.app needs Xcode), `sh-elf-gdb`, `sh-elf-objdump`, `gdb-multiarch`, `arm-none-eabi-gdb`.

## 10. Probe artifacts on disk

| Path | Purpose |
|---|---|
| `/tmp/probe-dc.log` | Most recent probe (~931 lines incl `[exception]` ring dumps with R15+PR snapshots, `[pr-trip]`, `[lsb-trip]`) |
| `/tmp/ipbin.bin` | Clean 32 KB IP.BIN extracted from PSO Track3.bin (sectors 0-15 user data, no sync/ECC) |
| `/tmp/ipbin.dis` | Full SH4 disassembly of IP.BIN (16383 lines) |
| `/tmp/dc-probes/<name>.log` | Archived probes when run with `--name` |
| `/tmp/flycast-lr2/flycast_libretro.dylib` | Native libretro core for ground-truth comparison |

## 11. Concrete next-action menu

| # | Action | Effort | Why |
|---|---|---|---|
| A | **Native-vs-WASM differential trace.** Boot PSO under `/tmp/flycast-lr2/flycast_libretro.dylib` in RetroArch; instrument rec-x64 (or use libretro's frame-step) to dump R15+PR+R0..R3 every block; replay against our probe to find the **first block where state diverges** between dispatch #1 and #597K. | M (1 session) | Highest signal — turns "JIT correctness gap" into a specific instruction. We already have the native build working. |
| B | **WasmModuleBuilder byte-level audit.** Researcher 3 flagged this as the only un-audited layer. Pick a small block (5-10 ops), emit it, decode the resulting bytes by hand against the SHIL ops, verify locals/imports/control flow match intent. | M | Cheaper than (A) if the bug is in module assembly rather than per-op semantics. |
| C | **Re-enable BIOS embed and re-test.** Fixes #6 + #8 + #9 may have already addressed the BL=1-stuck issue. Uncomment the `--embed-file ".../dc_boot.bin"` line at `flycast_worker_link.sh:~195` and run the probe. If real-BIOS now progresses, the IP.BIN-divergence blocker may shift or disappear. | XS (1 link + 1 probe) | Cheap to try; informs which path to debug. |
| D | **Snapshot R0..R15 in the PC ring.** Currently the ring stores only PC/R15/PR. Adding R0..R3 (or all GPRs) gives finer-grain divergence detection without needing the native oracle. | S (rec_wasm.cpp edit) | Multiplies signal per probe run. |
| E | **Force-keep `__emscripten_thread_crashed`.** `-Wl,-u` + a keep-alive fn is being DCE'd. Try `__attribute__((used))` on a function that calls it, or a non-statically-elidable indirect call from `main()`. Lets probes survive past the throw and gather more state. | S | Helps every future probe. |
| F | **`shop_pref` in `sh4_interp_shil_fb`.** Researcher 3 found this — only matters for SQ-region store-queue writes (post-graphics), not the active blocker. Drop in when convenient. | XS | Unblocks future graphics path. |
| G | **Worker-shim `discChunk` race in `flycast_worker.js:121-134`** (researcher 2, 05-14). `bootstrapped=true` set before factory finishes -> chunks posted before mem-init silently dropped. NOT current symptom. | S | Latent bug; defer until after first signal. |

Recommend order: **C** (cheap, may shift state) -> **A** (highest signal) -> **B** (if A doesn't pin it) -> **E**, **D**, **F**, **G** as cleanup.

## 12. Files of interest

| Path | Description |
|---|---|
| `dreamcast/STATUS.md` | This file |
| `dreamcast/flycast-bridge/EmscriptenWorker.cpp` | Bridge: video_cb, gdrom_log, `sh4_interp_shil_fb` (incl UpdateINTC sentinel L774), disc_type log, force-keep stubs |
| `dreamcast/flycast-bridge/rec_wasm.cpp` | `wasm_block_trampoline` (`s_ram_base` L126-128, PC bit-0 mask L139); `mainloop` (PC ring + region trap L274-424; exception ring dump L437-471; per-1k dispatch sampler L302-326) |
| `dreamcast/flycast-bridge/flycast_worker_link.sh` | emcc link. **BIOS embed currently DISABLED** (only `DC - Flash.bin` embedded at L195; the `dc_boot.bin` line is removed). `-Wl,-u,_emscripten_thread_crashed` at L189 (currently ineffective). |
| `dreamcast/flycast-bridge/flycast_stubs.cpp` | Host-side stubs Flycast pulls but emcc doesn't have |
| `dreamcast/flycast-bridge/patches/0001..0008-*.patch` | Required Flycast patches (CPU_WASM, FEAT_SHREC=DYNAREC_JIT, etc) |
| `dreamcast/flycast-bridge/apply_patches.sh` | Idempotent patch driver |
| `bementalJIT/guests/sh4/wasm_emit.cpp` | SHIL-to-WASM emit. Recent fixes: IFB-PC L551 + L1183, BET_*Intr UpdateINTC sentinel L1125-1140 |
| `bementalJIT/guests/sh4/wasm_emit.h` | RegCache, ctx_off offsets, LOCAL_RAM/CTX/TMP slots |
| `dreamcast/tools/sh4dis.py` | 250-line SH4 disassembler (since `sh-elf-objdump` unavailable) |
| `dreamcast/tools/flycast_probe.js` | Puppeteer headless probe driver |
| `dreamcast/build_and_probe.sh` | Build + probe inner loop |
| `dreamcast/flycast_libretro/flycast_worker_emcc.{js,wasm}` | WASM build output (built ~13:03 today) |
| `/tmp/flycast-lr2/flycast_libretro.dylib` | Native libretro oracle |
| `/tmp/probe-dc.log` | Latest probe (Reios path; 931 lines) |
| `/tmp/ipbin.{bin,dis}` | Extracted IP.BIN + disassembly |

## 13. Open questions

1. Does re-enabling BIOS embed now boot past BL=1 stuck? (action **C**) If yes, does the IP.BIN divergence still occur on the real-BIOS path?
2. **Where does the JIT first diverge from native rec-x64?** PR=0x8c009dd1 is wrong **somewhere** between dispatch #1 and #597K; the native oracle can pin the exact instruction.
3. Is the WasmModuleBuilder emitting correct bytes for non-trivial control flow (br_if, br_table, nested blocks/loops)? Researcher 3 flagged this as untested.
4. Why does `-Wl,-u,_emscripten_thread_crashed` not retain the symbol under our LTO config? (Stronger forcing via `__attribute__((used))` on a real call site untried.)
5. Once the IP.BIN-divergence is fixed and PSO progresses, does the `shop_pref` SQ-region gap (researcher 3) become the next blocker for graphics?
6. Throughput: at 643K-737K disp/sec single-threaded under puppeteer, what's the ceiling under V8? The GameCube precedent (`ppc_exterior_worker_2026_05_05.md`) suggests a dedicated worker is needed eventually but not for first signal.

---

Related memory files (in `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/`):
`dreamcast_bringup.md`, `dreamcast_session_2026_05_14.md`, `dreamcast_ram_base_fix_2026_05_14.md`, `dreamcast_sync_sr_fix_2026_05_15.md`, `dreamcast_session_2026_05_15.md`, `feedback_no_dolphin_patching.md`, `feedback_solid_accurate_build.md`, `feedback_native_speed_acceptance.md`, `feedback_no_softening_no_false_checkpoints.md`, `feedback_run_dont_check.md`.

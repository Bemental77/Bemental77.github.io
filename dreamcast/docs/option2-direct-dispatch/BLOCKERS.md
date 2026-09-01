# Option 2 — Blockers + open questions consolidated

Compiled from the 7 phase docs + RedDream local-run inspection. Each item is concrete + actionable. NO time estimates per `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_no_time_estimates.md`.

## Hard blockers (must resolve before committing to Option 2)

### B1. Cross-instance call_indirect deopt (cited Phase 1, validated Phase 4)
`dlsym()` returns a `wasmTable` index. `(*fnptr)(args)` from C lowers to `call_indirect` against `__indirect_function_table`. The target function lives in the side module's `WebAssembly.Instance`, the caller in main's instance. **V8 docs explicitly cite this as a deopt case.** This is the same wall the current epoch path already hits.

**Resolution path**: Phase 1 spike script at `phase1-feasibility.md` §6 measures `ns/call`. <200ns = strong go, ≥2000ns = no-go.

### B2. ASYNCIFY + dlopen + SIDE_MODULE has open correctness bug (#13049)
`library_dylink.js:1140-1153` uses `Asyncify.handleSleep`. Exports are wrapped via `Asyncify.instrumentWasmExports` at line 749-751. **When a side module loaded via dlopen calls an async JS import, the asyncify call stack becomes invalid and traps.** Issue open since 2020-12-15, no fix. Our blocks call `sh4_mem_read*`/`sh4_ifb`/`sh4_shil_fb` — these are JS-side (currently — would become C-side under Option 2). After conversion they MAY no longer be async, sidestepping the bug, but Phase 1 spike must verify.

### B3. Asyncify wraps every side-module export call (Phase 2 risk)
`library_dylink.js:749-751` instruments all side-module exports. Per-call cost addition unknown. **Could entirely defeat Option 2's throughput goal.** Phase 6 microbench (`#ifdef DISPATCH_MICROBENCH` block) is the only way to measure. **Can be done on the CURRENT build without building Option 2** to validate the 100μs/dispatch cost model first.

### B4. dlopen pthread synchronization (Phase 4)
`dynlink.c:422-433` asserts main-thread; dlopen from SH4 worker pthread does a synchronous `dlsync` proxy round-trip to the main thread. **The SH4 thread blocks on every compile-and-dlopen.** With cache-miss-triggered flushes happening every new PC, this could stall worse than the current epoch model. Mitigation: batch via per-epoch `build_epoch_module` (one DSO per N blocks).

### B5. pthread_create undefined-symbol regression with side+fexceptions+O3 (#14896)
Open since 2020. We have ALL THREE (`-pthread`, `-fexceptions`, `-O3`) in the current link script. May force `-fno-exceptions` or `-O2` workaround — both with side effects.

## Soft blockers (workaround exists or low-impact)

### S1. Import-name mismatch (Phase 5)
Side modules currently emit imports as `env.sh4_read8` but the main module exports `_sh4_mem_read8` (underscore prefix is JS-side only). **Three options**:
- (a) Rename emit constants in `bementalJIT/guests/sh4/wasm_emit.h:31-41` to match main's actual symbol names (`sh4_mem_read8`, `sh4_interp_ifb`, `sh4_interp_shil_fb`). LOW RISK.
- (b) Add `--js-library` alias shim. Cleanest but adds JS file.
- (c) Add `__attribute__((alias("sh4_read8")))` to main-side definitions. Cleanest C-side.

### S2. Full PIC rebuild required (Phase 2)
`-DCMAKE_POSITION_INDEPENDENT_CODE=ON` + `-fPIC` on `dreamcast/flycast-src/build-wasm/` — full archive rebuild. Mixed-PIC archives link silently but break vtables/TLS at runtime. `rm -rf build-wasm && reconfigure && rebuild` is the safe sequence.

### S3. MAIN_MODULE=2 vs =1 trade-off (Phases 2 + 5 contradict)
Phase 5 says =1 is simpler (auto-exports via `--export-dynamic`). Phase 2 says =2 (manual `EXPORTED_FUNCTIONS` + new `SIDE_MODULE_IMPORTS`). **Resolution**: go with =2 (avoids `INCLUDE_FULL_LIBRARY=1` bloat) + add the 8 helpers to `SIDE_MODULE_IMPORTS`. List of helpers already in `EXPORTED_FUNCTIONS` at `flycast_worker_link.sh:54-63`.

### S4. dlclose is a no-op (Phase 4)
Emscripten musl stub at `dlclose.c:4-7` returns invalid-handle error. `nodelete: true` default. Handles + JIT code + table slots leak for worker's life: ~2.5KB/block × 5000 blocks = ~13MB. Acceptable; linear growth.

### S5. Main module wasm grows ~1.7× (Phase 1 §5)
50MB → ~75-85MB per issue #5256's data point. Cold-load wait grows proportionally. Mitigation: prefer Lever 3 (multi-block-per-instance epoch — `single_module_jit_plan.md`) if it gives equivalent dispatch benefit without PIC tax.

### S6. Side-module sharedModules cost across pthreads (#17034)
Each dlopen'd module gets posted to every existing pthread via `sharedModules` cache (`library_dylink.js:736-744`). At N=2000 blocks × `PTHREAD_POOL_SIZE=8`, that's 16K postMessage payloads. Mitigation: don't spawn new pthreads after JIT starts.

## Cross-doc contradictions / decisions needed

### D1. In-memory dlopen (Phase 4 says no, Phase 2 says yes)
Phase 4: "No public in-memory dlopen API — must write bytes to FS." Phase 2: "Use `dso.file_data` field (`library_dylink.js:1001-1008`)." **Reconciliation**: no PUBLIC API but the internal `file_data` field is usable. Phase 2's path wins (avoids FS round-trip).

### D2. PIC requirement for blocks (Phase 3 says no, Phase 2 says yes)
Phase 3: "PIC not needed because our emit references no side-module-local data." Phase 2: "Full PIC rebuild of main module required." **Reconciliation**: PIC on the MAIN module is required (Phase 2). PIC on the BLOCK modules is not (Phase 3) — they're already position-agnostic because they only reference imported memory + locals.

## What RedDream confirms (no blocker)

- **Renders PSO to full game** on user's hardware. Confirms no structural Dreamcast emulation gap in our build — pure throughput closes the gap.
- **Uses HLE BIOS** ("bios_boot using hle bootstrap" in binary strings). Same architecture as our `config::UseReios=true` path. No real-BIOS dependency.
- **VMU/flash persistence** working (`~/Library/Application Support/redream/{flash.bin,vmu0-3.bin}`). Not implemented in our build — orthogonal to throughput.
- **No special hardware/peripheral requirement** beyond what flycast provides.

## Recommended validation gate (before committing to Option 2)

Two cheap experiments answer the most important questions:

### Gate A: Phase 6 microbench on the CURRENT build
Apply the `#ifdef DISPATCH_MICROBENCH` block from `phase6-verify-measure.md` §2 around `wasm_block_trampoline()` in `rec_wasm.cpp::mainloop`. Recompile current build with `-DDISPATCH_MICROBENCH`. Probe. Grep `[mbench]` lines for median μs/dispatch.

- **If median is ~100μs**: the JS-hop hypothesis is confirmed. Proceed to Gate B.
- **If median is <10μs**: the cost is elsewhere (block bodies, memory imports, etc.). Option 2 won't help — investigate further.
- **If median is in between**: partial — Option 2 may win a fraction.

### Gate B: Phase 1 spike build
Run the build script in `phase1-feasibility.md` §6. Read the `ns/call` from the printf.

- **`ns/call < 200`**: strong go. Build full Option 2.
- **`200 ≤ ns/call < 2000`**: weak go. Useful intermediate while pursuing single-module emission in parallel.
- **`ns/call ≥ 2000`**: no-go. The PIC tax doesn't justify the saving. Pivot to single-module emission (the existing partial scaffold in `flycast_install_epoch`).

## Open questions only a real build resolves

Across phases, ordered by decision-impact:

1. **What is actual `ns/call` for cross-side-module dispatch on V8?** (Phase 1) — go/no-go gate.
2. **Asyncify-wrap per-call overhead on side-module exports** (Phase 2) — may dominate.
3. **Does dlopen of a side module work correctly from the SH4 pthread?** (Phase 1, #13049 risk)
4. **wasmTable.grow cost per dlopen at N=10k entries** (Phase 1 kill criterion #4)
5. **Mixed-PIC vs full-PIC archive linkage** (Phase 2 risk)
6. **dlsync round-trip cost under SH4 thread load** (Phase 4)
7. **MAIN_MODULE=2 + Flycast static archives — link success or fail** (Phase 4)

## Files in this bundle

```
dreamcast/docs/option2-direct-dispatch/
├── README.md              ← cross-doc synthesis + recommended sequence
├── BLOCKERS.md            ← THIS FILE (blockers + validation gate)
├── phase1-feasibility.md  ← Emscripten compat matrix, V8 deopt analysis, spike script
├── phase2-build-pipeline.md  ← link.sh diff, CMake -fPIC, MAIN_MODULE=2 rationale
├── phase3-sidemodule-emit.md ← dylink.0 16-byte format, wasm_emit.cpp diff
├── phase4-dispatch-rewrite.md  ← dlsym→fnptr path, dlopen-pthread caveat, leak math
├── phase5-imports.md      ← cross-module symbol resolution, name reconciliation
├── phase6-verify-measure.md  ← microbench, A/B mode, kill criteria
├── phase7-cleanup.md      ← deletion + keep checklists, memory-file actions
└── refs/
    ├── side_ref.c         ← `int run(int a, int b){return a;}` for spike
    └── side_ref_mem.c     ← variant that touches imported memory
```

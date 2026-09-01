# Option 2 — Direct C-to-WASM dispatch

Research bundle for replacing the SH4 JIT's `C++ → EM_JS → JS dispatcher → wasm` chain with direct `C++ → wasm` dispatch via Emscripten dynamic linking.

## Background

Current dispatch ceiling: ~9.5K block-dispatches/sec at ~1395 active blocks. Native target: ~20M dispatches/sec. Gap is ~2000×. Per-dispatch cost is ~100μs vs expected ~50ns. The hypothesis: the JS-hop chain (6 wasm/JS boundary crossings per dispatch) is the dominant cost. See `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_inwasm_dispatcher_plan.md` for the path that got us here, including a failed in-wasm dispatcher attempt that made things worse.

Option 2: emit per-block wasm as Emscripten SIDE_MODULE format, link main flycast wasm with MAIN_MODULE=2, dlopen+dlsym at compile time, store the resulting C function pointer, call directly per dispatch. No JS hop.

## Phase docs

| Doc | Topic | Verdict |
|---|---|---|
| `phase1-feasibility.md` | dlopen + pthread + ASYNCIFY + SHARED_MEMORY compat | **unknown-needs-spike-build**. dlsym path is still `call_indirect` cross-instance — V8 may deopt. <200ns/call = strong go; ≥2000ns/call = no-go. |
| `phase2-build-pipeline.md` | link.sh + CMake changes for MAIN_MODULE=2 | Use `=2` not `=1`. Drop `EXPORT_ALL`. CMake needs `-DCMAKE_POSITION_INDEPENDENT_CODE=ON` + full rebuild. **Risk**: Asyncify wraps side-module exports (may add per-call cost). |
| `phase3-sidemodule-emit.md` | dylink.0 byte format + wasm_emit.cpp diff | 16-byte minimum dylink.0 section. No relocs, no GOT, no PIC needed. **~30 LoC change** in `wasm_module_builder.h` + 1 line in `build_block`. |
| `phase4-dispatch-rewrite.md` | C-side dispatch via dlopen+dlsym | dlsym → fn-pointer → direct call via `__indirect_function_table`. **Caveats**: dlopen needs main-thread proxy (blocks SH4 pthread); dlclose is no-op (handles leak ~2.5KB/block); in-memory delivery via `dso.file_data` field. |
| `phase5-imports.md` | Side modules calling main's `sh4_mem_*` etc | `EMSCRIPTEN_KEEPALIVE` sufficient under MAIN_MODULE=1; under =2 need `EXPORTED_FUNCTIONS` + new `SIDE_MODULE_IMPORTS` list. **Two renames** required: `sh4_read8`→`sh4_mem_read8`, `sh4_ifb`→`sh4_interp_ifb`, `sh4_shil_fb`→`sh4_interp_shil_fb`. |
| `phase6-verify-measure.md` | Probe + microbench + A/B + kill criteria | Microbench (`#ifdef DISPATCH_MICROBENCH` around `wasm_block_trampoline`) paste-ready. A/B via `FLYCAST_DISPATCH=js\|c` env var. 6 kill criteria (median >10μs, <4 milestones, etc). |
| `phase7-cleanup.md` | Deletion + keep + memory-update plan | Detailed file-by-file checklist. KEEP: canvas-sed patch, SPG raises, intra-link tail-call, cycle drain. SUPERSEDE: `dreamcast_inwasm_dispatcher_plan.md`. NEW: `dreamcast_direct_dispatch_landed.md`. |

Reference C sources at `refs/side_ref.c` + `refs/side_ref_mem.c` for the eventual spike build.

## Cross-doc findings worth surfacing

### Three confirmed risks (any could kill Option 2)

1. **Cross-instance call_indirect** (Phase 1, validated by Phase 4): dlsym returns a wasm table index. `(*fnptr)(args)` lowers to `call_indirect` against `__indirect_function_table`. The TARGET function lives in a different WebAssembly.Instance (the side module). V8 documents cross-instance call_indirect as a deopt case. **This is exactly the bottleneck the current epoch path already hits.** Option 2 may only save the EM_JS hop + Map.get, not the underlying cross-instance cost.

2. **Asyncify wrapping** (Phase 2): `library_dylink.js:749-751` wraps each side-module export in an Asyncify shim. Per-call cost addition unknown. Could entirely defeat the throughput goal if the shim is ~μs.

3. **dlopen synchronization** (Phase 4): `dynlink.c:422-433` asserts main-thread; dlopen from SH4 pthread does a synchronous dlsync proxy round-trip. Could stall the SH4 thread per compile. Mitigation: batch via per-epoch `build_epoch_module` (one DSO per N blocks).

### Validation gate

Phase 6's microbench + Phase 1's spike script together provide the empirical answer. Both can be done **without** building Option 2 — paste the microbench into the existing `rec_wasm.cpp` mainloop, measure baseline. If baseline shows 100μs/dispatch is actually elsewhere (e.g. per-block memory imports, not the dispatcher call), Option 2 won't help.

### Recommended sequence

1. **Land microbench (Phase 6 §2) on the current build**. Measure per-dispatch cost. Confirm the 100μs is in the dispatcher call vs elsewhere. **Decision point.**
2. If 1 confirms JS-hop is the cost: **build Phase 1 spike** (50-line standalone main+side modules with EM_JS-stub and direct-call variants). Measure both. **Decision point.**
3. If 2 shows direct-call <200ns: proceed Phases 2 → 3 → 4 → 5 in order.
4. Phase 7 cleanup last.

### Open questions across all phases

- Asyncify-wrap per-call overhead (Phase 2 risk)
- V8 cross-side-module call_indirect actual cost (Phase 1 unknown)
- dlsync round-trip cost under SH4 thread load (Phase 4)
- Mixed-PIC vs full-PIC archive linkage (Phase 2)
- `MAIN_MODULE=2` compatibility with Flycast static archives (Phase 4)
- Import-name reconciliation (rename in emit vs JS-library shim — Phase 5)

## What's NOT in this bundle

- An estimate of how long any of this takes. Use the kill criteria and dependency graph; describe progress in terms of which phases have landed, not wall-clock.

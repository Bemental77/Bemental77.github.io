# Phase 7 — Cleanup after Option 2 (dlopen + C-dispatch) lands

Scope: catalog every identifier, file region, build flag, and memory entry that
needs to be removed, kept, or updated once Phases 1-6 ship the dlopen +
C-dispatch architecture and the JS-side epoch/EM_JS dispatcher is fully
retired.

Reference docs: `/Users/caseybement/Bemental77.github.io/dreamcast/docs/option2-direct-dispatch/refs/side_ref.c`,
`refs/side_ref_mem.c` (the C-side reference template for Option 2's compiled
side modules).

---

## 1. Deletion checklist

Grouped by file. Every identifier listed below becomes orphan / dead once the
C-side dlopen path is the sole dispatch route.

### 1.1 `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/flycast_worker_funcs.js`

The entire SH4 dispatcher block — JS-side state and helper functions reachable
from `EM_JS` bodies in `rec_wasm.cpp` — becomes unreachable.

Identifiers to delete (with current line refs):

| Line(s) | Identifier | Notes |
|---|---|---|
| 45 | `var flycast_block_modules = new Map();` | Per-block WebAssembly.Module cache — superseded by C-side dlopen handle table |
| 46 | `var flycast_block_instances = new Map();` | Per-block WebAssembly.Instance cache — same |
| 47 | `var flycast_wasm_imports = null;` | Shared import object — dlopen side modules import via emscripten's native dynamic-loader mechanism |
| 61 | `var flycast_active_instance = null;` | Live epoch Instance — no longer needed |
| 62 | `var flycast_vaddr_to_fn = new Map();` | JS-side vaddr→exported-fn map — replaced by C-side `std::unordered_map<u32, fnptr_t>` (Section 3) |
| 63 | `var flycast_epoch_serial = 0;` | Diag counter — drop |
| 65-97 | `function flycast_build_imports()` | Whole function. dlopen side modules import via emcc's MAIN_MODULE / SIDE_MODULE machinery, not via a hand-built JS import object |
| 103 | `var flycast_last_register_error = ''` | Stash for EM_JS error retrieval — drop |
| 104-125 | `function flycast_register_block(vaddr, bytesPtr, len)` | Per-block synchronous compile path — removed completely |
| 136-172 | `function flycast_install_epoch(bytesPtr, len, vaddrsPtr, count)` | The entire merged-module install path |
| 174-188 | `function flycast_run_block(vaddr, ctxPtr, ramBase)` | The hot-path dispatcher reached by `wasm_dispatcher_run_block` EM_JS body |

What remains in `flycast_worker_funcs.js` after deletion:
- Lines 190-245: the `ENVIRONMENT_IS_PTHREAD` guard, `onRuntimeInitialized`
  hook posting `runtime-ready`, the `mbx-cmd` handler skeleton, the
  `shutdown` handler.

If those remaining handlers are also no longer used (verify by greppping the
page for `cmd: 'mbx-cmd'` and `cmd: 'shutdown'` consumers), the entire file
can be dropped and the `--post-js` flag removed from the link script (see
Section 4).

### 1.2 `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/rec_wasm.cpp`

Identifiers and regions to delete (current line refs):

| Line(s) | Identifier / region | Notes |
|---|---|---|
| 62-71 | `EM_JS(int, wasm_dispatcher_register_block, ...)` | Per-block register EM_JS body |
| 85-94 | `EM_JS(int, wasm_dispatcher_install_epoch, ...)` | Epoch install EM_JS body |
| 96-103 | `EM_JS(uint32_t, wasm_dispatcher_run_block, ...)` | Hot-path EM_JS body — the one site called from `wasm_block_trampoline` |
| 108-119 | `EM_JS(int, wasm_dispatcher_get_last_error, ...)` | Error retrieval EM_JS body |
| 127 | `static std::unordered_map<u32, std::vector<u8>> g_compiled_blocks;` | Diagnostic byte stash — bytes now live on disk under the side-module FS path |
| 156 | `static std::vector<RuntimeBlockInfo*> g_active_blocks;` | Epoch state |
| 157 | `static std::vector<u32> g_active_vaddrs;` | Epoch state |
| 158 | `static std::vector<RuntimeBlockInfo*> g_pending_blocks;` | Epoch state |
| 159 | `static std::vector<u32> g_pending_vaddrs;` | Epoch state |
| 160 | `static uint64_t g_epoch_serial = 0;` | Epoch counter |
| 161 | `static uint64_t g_epoch_flushes = 0;` | Epoch counter |
| 162 | `static uint64_t g_epoch_flush_errs = 0;` | Epoch counter |
| 164 | `static constexpr u32 EPOCH_BATCH = 64;` | Threshold — gone |
| 171 | `static constexpr u32 EPOCH_MAX_ACTIVE = 512;` | FIFO eviction cap — gone (dlopen handles get released individually via Section 3) |
| 179-280 | `static void flush_epoch(const char* reason)` | Entire function: merge-pending-into-active, FIFO eviction loop with `bm_DiscardBlock`, `build_epoch_module` call, `wasm_dispatcher_install_epoch` call, success/fail log, rollback logic |
| 440 (`reset()`) | `g_compiled_blocks.clear();` | Reset path's stash clear |
| 449-452 (`reset()`) | `g_active_blocks.clear(); g_active_vaddrs.clear(); g_pending_blocks.clear(); g_pending_vaddrs.clear();` | All four lines |
| 376-380 (`compile()`) | `g_pending_blocks.push_back(block); g_pending_vaddrs.push_back(vaddr); if (g_pending_blocks.size() >= EPOCH_BATCH) { flush_epoch("batch"); }` | Pending push + batch trigger |
| 501 (`mainloop()`) | `flush_epoch("entry");` | Initial flush call |
| 732 (`mainloop()`) | `flush_epoch("miss");` | Cache-miss flush call |

`wasm_block_trampoline` (lines 312-344) keeps the same SHAPE but the call on
line 328 (`wasm_dispatcher_run_block(...)`) gets replaced with a direct C call
via the vaddr→fnptr map (see Section 3). The trampoline-PC-mask defensive
mirror (lines 329-343) stays.

The `compile()` method (line 363) keeps the block dump telemetry (lines
382-422) and the `block->code = (DynarecCodeEntryPtr)(uintptr_t)block` unique-
key trick (line 432) — the latter is still needed because Flycast's
`bm_AddBlock` requires unique `code` values per block. Only the
epoch-push / batch-flush plumbing comes out.

### 1.3 `/Users/caseybement/Bemental77.github.io/bementalJIT/guests/sh4/wasm_emit.cpp`

Identifiers and regions to delete (current line refs):

| Line(s) | Identifier / region | Notes |
|---|---|---|
| 1390-1450 | `std::vector<u8> build_epoch_module(RuntimeBlockInfo* const* blocks, u32 count)` | Entire function. Each block now produces its own SIDE_MODULE compiled by emcc + loaded via dlopen — no merged module |
| 1370-1374 | `std::vector<u8> build_block_function_bytes(RuntimeBlockInfo* block)` | Public helper only used by `build_epoch_module`'s ancestors; verify no other callers, then delete |
| 1347-1362 | `std::vector<u8> build_block(RuntimeBlockInfo* block)` | If Option 2 routes through a different emit path (e.g. emit complete SIDE_MODULE bytes directly), this whole-block module builder is dead. KEEP if Option 2 still wraps the SHIL emit in a module envelope for dlopen — the wrapper just becomes a SIDE_MODULE envelope instead of a plain module. **Verify with the Option 2 emit prototype before deleting.** |
| 1409-1416 | The "ATTEMPTED 2026-05-17" comment block inside `build_epoch_module` | Goes with the function |

Note `emitBlockFuncBody` (lines 1255-1312) and the `vaddr_to_idx` map
parameter on `emitBlockExit` stay LOAD-BEARING — see Section 2.

### 1.4 `/Users/caseybement/Bemental77.github.io/bementalJIT/guests/sh4/wasm_emit.h`

| Line(s) | Identifier | Notes |
|---|---|---|
| 219 | `std::vector<u8> build_block_function_bytes(RuntimeBlockInfo* block);` | Public decl; remove with the cpp |
| 221 | `std::vector<u8> build_epoch_module(RuntimeBlockInfo* const* blocks, u32 count);` | Public decl; remove with the cpp |
| 200-218 | "Epoch (multi-block) emit." comment block | Outdated context; remove with the function decls |

`build_block` decl (line 198) — see KEEP/DELETE note above; gate on the
Option 2 emit prototype.

### 1.5 Sanity sweep

After the above removals, run:

```bash
grep -rn 'flycast_install_epoch\|flycast_run_block\|flycast_register_block\|\
flycast_block_modules\|flycast_block_instances\|flycast_vaddr_to_fn\|\
flycast_wasm_imports\|flycast_last_register_error\|flycast_active_instance\|\
flycast_epoch_serial\|wasm_dispatcher_register_block\|\
wasm_dispatcher_install_epoch\|wasm_dispatcher_run_block\|\
wasm_dispatcher_get_last_error\|build_epoch_module\|\
build_block_function_bytes\|g_active_blocks\|g_active_vaddrs\|\
g_pending_blocks\|g_pending_vaddrs\|g_epoch_serial\|g_epoch_flushes\|\
g_epoch_flush_errs\|EPOCH_BATCH\|EPOCH_MAX_ACTIVE\|flush_epoch\|\
g_compiled_blocks' \
  dreamcast/ bementalJIT/guests/sh4/
```

Expected result: 0 hits anywhere outside docs/memory/comments.

---

## 2. Keep checklist — load-bearing, do not remove

| File:line | Item | Why it stays |
|---|---|---|
| `dreamcast/flycast-bridge/flycast_worker_link.sh:239-241` | The `sed -i ''` `transferredCanvasNames` null-guard post-build patch | Emscripten 3.1.67 `pthread.js` bug — fires regardless of dispatch model because `PTHREAD_POOL_SIZE=8` pre-allocates 8 pthreads at runtime init; flycast's `std::thread` use also keeps spawning. See `dreamcast_canvas_emscripten_fix.md` |
| `dreamcast/flycast_libretro/flycast_worker.js:89-94, 100-110` | `transferredCanvasNames: ['#canvas']` in module config + re-attach hook | Companion to the sed patch — the shim provides the iterable the runtime's pthread spawn iterates |
| `dreamcast/flycast-bridge/rec_wasm.cpp:836-872` | SPG triplet + MAPLE_VBOI force-raise + extra `UpdateSystem_INTC()` in the cycle-counter drain | SH4 JIT still below the throughput threshold where `sh4_sched_tick` delivers VBLANK_IN on time. Removable only when SH4 reaches near-native speed — Option 2's throughput win narrows this gap but doesn't necessarily eliminate it. See `dreamcast_session_2026_05_16.md` |
| `dreamcast/flycast-bridge/EmscriptenWorker.cpp:611-749` (gated by `#ifdef FLYCAST_BRIDGE_DIAG`) | GDROM SPI state-tracker `g_gdrom_state`, `gdrom_log_r`, `gdrom_log_w`, and the `sh4_mem_read*`/`sh4_mem_write*` wrappers that call them | Independent of dispatch model. Useful for bringup probes; compiled out when `FLYCAST_RELEASE=1` |
| `dreamcast/flycast-bridge/rec_wasm.cpp:286-296` | `g_diag_enabled`, `g_ifb_count`, `g_exc_count`, `flycast_diag_set`, `flycast_diag_ifb` | Runtime-toggleable diag gate driven from JS via `cmd:'diag'`; orthogonal to dispatch |
| `dreamcast/flycast-bridge/rec_wasm.cpp:475-823, 873-1001` (gated by `#ifdef DEBUG_DISPATCH`) | PC ring buffer, region trap, one-shot dumps, SPG diag counters, 5s `[stats]` flush, exception ring dump | Debug instrumentation; compiled out via `FLYCAST_RELEASE=1`. Some of the dumps (e.g. `s_b6b8_dump_fired`, `s_loop_dump_fired`) target specific PCs and may be stale post-cleanup; review separately, not in scope here |
| `dreamcast/flycast-bridge/flycast_worker_link.sh:149-155` | `DIAG_FLAGS` env-var pattern (`-DFLYCAST_BRIDGE_DIAG -DDEBUG_DISPATCH`) | Keep the gating mechanism |
| `bementalJIT/guests/sh4/wasm_emit.cpp:1063-1232` | `emitBlockExit`, `sibling_func_idx`, `vaddr_to_idx` plumbing through `emitBlockFuncBody` | Tail-call (`return_call`) linking for static SH4 jumps still works inside a single side module's local function-index space. A side module containing K blocks (or 1 block as the dlopen unit) can still link internally; `vaddr_to_idx` is just keyed by intra-side-module index. Only the multi-block emission path (epoch) goes; the linking logic remains usable |
| `bementalJIT/guests/sh4/wasm_emit.cpp:1255-1312` | `emitBlockFuncBody` | Still the per-function body emitter; needed by any side-module emitter |
| `bementalJIT/guests/sh4/wasm_emit.cpp:1271-1282` | Per-block `cycle_counter -= block->guest_cycles` prologue emit | Correctness — cycle accounting still has to happen inside compiled code; removing it reintroduces the flat-32 over/under-drain |
| `bementalJIT/guests/sh4/wasm_emit.cpp:1319-1342` | `emitTypeImportSection` | Shared envelope helper; will be reused by the Option 2 side-module emitter (the import set is the same: `sh4_read*`, `sh4_write*`, `sh4_ifb`, `sh4_shil_fb`, `env.memory`) |
| `bementalJIT/guests/sh4/wasm_emit.h:31-41` | `WasmImportFunc` enum | Same import indices used by the side modules |
| `bementalJIT/guests/sh4/wasm_emit.h:56-62` | `ctx_off::` constants | Sh4Context field offsets — guest-arch invariant |
| `bementalJIT/guests/sh4/wasm_emit.h:70-77` | `LOCAL_CTX`/`LOCAL_RAM`/`LOCAL_TMP*` constants | Per-function local layout |
| `bementalJIT/guests/sh4/wasm_emit.h:88-165` | `RegCache` | Register-cache machinery used by emit |
| `bementalJIT/guests/sh4/wasm_emit.h:173-189` | `emitShilOp`, `emitBlockExit` decls | Still public API |
| `dreamcast/flycast-bridge/flycast_worker_link.sh:223-224` | `--pre-js $BRIDGE/webgl2-compat.js` and `--js-library $BRIDGE/gl_override.js` | Independent of dispatch model |

---

## 3. What's newly needed (Phase 7 introduces these — coordinate with Phase 1-6 deliverables)

These items live downstream of the dlopen path; they don't exist yet but the
deletion checklist assumes them. Cross-check the Option 2 prototype landed by
Phases 1-6 to confirm names match.

| Need | Likely home | Notes |
|---|---|---|
| `std::unordered_map<u32, void*> g_vaddr_to_handle` | `rec_wasm.cpp` | Replaces `flycast_block_modules` Map. Value is the `dlopen` handle returned for the side module containing this vaddr |
| `std::unordered_map<u32, sh4_block_fn_t> g_vaddr_to_fnptr` | `rec_wasm.cpp` | Replaces JS-side `flycast_vaddr_to_fn` Map. `sh4_block_fn_t` is the C function-pointer typedef (e.g. `typedef u32 (*sh4_block_fn_t)(Sh4Context*, void* ram_base);`). Populated by `dlsym(handle, "run")` per side module |
| `wasm_block_trampoline` body | `rec_wasm.cpp:312` | Lookup pattern becomes: `auto it = g_vaddr_to_fnptr.find(pc); if (it != g_vaddr_to_fnptr.end()) { ctx->pc = it->second(ctx, (void*)s_ram_base) & ~1u; return; }` |
| `dlclose` path | `WasmDynarec::reset()` and any block-invalidation hook | Walk `g_vaddr_to_handle`, dedup handles, `dlclose` each. Without this, repeated reset → leak grows the side-module count linearly |
| Side-module FS path management | `rec_wasm.cpp` `compile()` | Each compiled block writes its `.wasm` blob to a deterministic path (e.g. `/tmp/sh4_blocks/<vaddr_hex>.wasm`) for `dlopen` to find. Decide on dir cleanup on `reset()`. Emscripten's MEMFS is fine — these never hit real disk |
| Optional: shared side-module template | Option 2 emitter | If multiple blocks share an envelope, the emit path can stamp them into one template — but the dispatch model treats each block as its own dlopen unit. Coordinate with the prototype |

These are NEW items, not cleanup — listed here for completeness so the
deletion checklist isn't read in isolation.

---

## 4. Build-script diff (`dreamcast/flycast-bridge/flycast_worker_link.sh`)

Changes contingent on whether `flycast_worker_funcs.js` retains the
`mbx-cmd` + `shutdown` + `runtime-ready` handlers (lines 190-245 of that
file).

### Always remove

Nothing in the link script changes purely because of the JS-dispatcher
removal — `--post-js` continues to bundle whatever's left in funcs.js. The
SH4 dispatcher functions live in module-factory scope alongside the other
handlers, so the file itself stays unless emptied.

### Remove if `flycast_worker_funcs.js` becomes empty

Line 225:

```
  --post-js $BRIDGE/flycast_worker_funcs.js \
```

And delete the file `dreamcast/flycast-bridge/flycast_worker_funcs.js`.

The `mbx-cmd` handler (line 218-231 of funcs.js) is currently a Phase 2
placeholder ("TODO: wire to flycast SH4 MMIO mirrors once sh4-worker
lands"). If Phase 2 mailbox routing hasn't landed by Phase 7 cleanup, this
handler can be deleted with the rest. The `shutdown` handler (line 211-216)
is a no-op acknowledge — also deletable. The `runtime-ready` postMessage
(line 199) is observed by `flycast_worker.js`'s shim via
`onRuntimeInitialized` already (the shim has its own `onRuntimeInitialized`
hook at `flycast_worker.js:111` calling `onRuntimeInitialized()` direct
without waiting on the `runtime-ready` cmd). Confirm by tracing the page
console: if no consumer listens for the `runtime-ready` cmd, drop it.

### Possibly add (depends on Option 2 link requirements)

If the dlopen path requires Emscripten's `MAIN_MODULE=1` (or `=2`) link
flag and side modules are built separately with `-sSIDE_MODULE=1`:

```
  -sMAIN_MODULE=2 \
```

Plus any `EXPORTED_FUNCTIONS` additions needed so side modules can
`dlsym` the bridge's `sh4_read*`, `sh4_write*`, `sh4_interp_ifb`,
`sh4_interp_shil_fb` exports — those are already exported (line 53-61).

This is Option 2 plumbing, not strictly "cleanup", but flagged here
because the link script is the central choke point.

---

## 5. Memory-file actions

Path prefix:
`/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/`

| File | Action | What to write |
|---|---|---|
| `dreamcast_jit_perf_phase1.md` | SUPERSEDE | Mark whole file SUPERSEDED by Option 2 / `dreamcast_direct_dispatch_landed.md`. Items #1 (single-module epoch) and #4 (intra-module tail-call linking via merged module) are GONE in Option 2; #2 (per-block cycle drain) and #3/#5 (DIAG/DEBUG_DISPATCH gates) stay valid. Add a header banner: "SUPERSEDED 2026-05-17+ by Option 2 dlopen+C-dispatch. Items #1 and #4 no longer apply — see dreamcast_direct_dispatch_landed.md." |
| `dreamcast_inwasm_dispatcher_plan.md` | SUPERSEDE | Mark SUPERSEDED. The "in-wasm dispatcher" approach was investigated and abandoned (per the wasm_emit.cpp:1409-1416 inline note: regressed throughput 21K→9.5K). Option 2 is the chosen fix. Add header: "SUPERSEDED — in-wasm dispatcher attempt regressed throughput; Option 2 dlopen+C-dispatch is the chosen replacement. See dreamcast_direct_dispatch_landed.md." |
| `dreamcast_canvas_emscripten_fix.md` | KEEP unchanged | Canvas patch and `transferredCanvasNames` workaround are both still load-bearing (Section 2). No edit needed |
| `dreamcast_session_2026_05_16.md` | UPDATE | SPG forced-raise (Workaround section) STILL ACTIVE. Throughput numbers (175 unique PCs, 30s wall, ~3% real speed) are pre-Option-2 — append note: "Throughput numbers above are pre-Option-2; the dispatch path is replaced and the cliff at ~1395 blocks no longer applies. SPG force-raise band-aid still in place; re-measure once Option 2 lands." |
| `dreamcast_session_2026_05_15.md` | KEEP unchanged | JIT correctness fixes (sync_sr, IFB-PC, PC bit-0 mask, Reios A/B) are orthogonal to dispatch model |
| `dreamcast_session_2026_05_14.md` | KEEP unchanged | Phase-2 native SHIL emit + bridge fixes; orthogonal to dispatch |
| `dreamcast_ram_base_fix_2026_05_14.md` | KEEP unchanged | Area-3 RAM fast-path correctness fix; orthogonal |
| `dreamcast_sync_sr_fix_2026_05_15.md` | KEEP unchanged | SHIL emit correctness; orthogonal |
| `dreamcast_bringup.md` | KEEP unchanged | High-level bringup overview; the dispatch-model swap doesn't change the bringup narrative |

### New entry: `dreamcast_direct_dispatch_landed.md`

Sketch of content:

- **Architecture** — One side module per compiled SH4 block, written to MEMFS,
  loaded via `dlopen`, dispatched via `dlsym`'d C function pointer from
  `wasm_block_trampoline`. Bridge holds two unordered_maps: vaddr→fnptr
  (hot path) and vaddr→dlopen-handle (lifecycle).
- **Why** — V8 megamorphic IC cliff at 1395 blocks on JS-side
  `Map<vaddr, WasmExportedFunction>.get(...)()` call site collapsed
  throughput 19× (405K→21K disp/s); cross-instance `call_indirect` deopts
  prevented epoch-merge from scaling; in-wasm dispatcher attempt regressed
  21K→9.5K (per `wasm_emit.cpp:1409-1416`).
- **Removed** — all of Section 1 above (epoch JS state + EM_JS bodies +
  `flush_epoch` + `build_epoch_module`).
- **Kept** — all of Section 2 above (canvas patch, SPG raises, GDROM diag,
  emit envelope, RegCache, tail-call linking *inside* one side module).
- **Build flags added** — whatever `-sMAIN_MODULE=…` / side-module link
  flags Phases 1-6 settled on; reference the link script post-cleanup.
- **Open work** — `dlclose` lifecycle on `reset()` and on block
  invalidation; FS-path GC policy; whether multiple blocks can share a
  single side module template to amortize compile cost.

---

## 6. Smoke test after cleanup

Sequenced from cheapest to most thorough:

1. **Compile-only**: `bash dreamcast/flycast-bridge/flycast_worker_link.sh`
   must produce `flycast_worker_emcc.{js,wasm}` with no `undefined reference`
   errors for any of the deleted symbols in Section 1.5's grep list. If link
   succeeds, no dangling references remain at C++ level.
2. **JS reference sweep**: the Section 1.5 grep, expanded to also search
   `dreamcast.html`, `*.js`, and `dreamcast/flycast_libretro/`, must return
   zero hits outside docs / memory / commented-out lines.
3. **Boot probe**: `bash dreamcast/build_and_probe.sh` (or its equivalent
   harness) must reach the same number of unique PCs as the
   pre-cleanup Option-2 baseline. Regression on this metric flags a missing
   wire in Phases 1-6.
4. **Release-mode link**:
   `FLYCAST_RELEASE=1 bash dreamcast/flycast-bridge/flycast_worker_link.sh`
   exercises the `-DFLYCAST_BRIDGE_DIAG` + `-DDEBUG_DISPATCH` compile-out
   paths in `EmscriptenWorker.cpp` and `rec_wasm.cpp`. If a deleted
   identifier was referenced from a non-DIAG path that was previously
   gated, this surfaces it.
5. **Reset/teardown loop**: drive the worker through 2-3 `retro_reset()`
   cycles; verify the page's wasm-memory steady-state usage doesn't climb
   (catches missing `dlclose` in `WasmDynarec::reset()`).

---

## 7. Files referenced

Code:
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/flycast_worker_funcs.js`
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/rec_wasm.cpp`
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/flycast_worker_link.sh`
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/EmscriptenWorker.cpp`
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/gl_override.js`
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast-bridge/webgl2-compat.js`
- `/Users/caseybement/Bemental77.github.io/dreamcast/flycast_libretro/flycast_worker.js`
- `/Users/caseybement/Bemental77.github.io/bementalJIT/guests/sh4/wasm_emit.cpp`
- `/Users/caseybement/Bemental77.github.io/bementalJIT/guests/sh4/wasm_emit.h`

Reference templates:
- `/Users/caseybement/Bemental77.github.io/dreamcast/docs/option2-direct-dispatch/refs/side_ref.c`
- `/Users/caseybement/Bemental77.github.io/dreamcast/docs/option2-direct-dispatch/refs/side_ref_mem.c`

Memory:
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_jit_perf_phase1.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_inwasm_dispatcher_plan.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_canvas_emscripten_fix.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_session_2026_05_16.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_session_2026_05_15.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_session_2026_05_14.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_ram_base_fix_2026_05_14.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_sync_sr_fix_2026_05_15.md`
- `/Users/caseybement/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dreamcast_bringup.md`

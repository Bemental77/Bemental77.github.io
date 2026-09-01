# Nasomers table-dispatch — implementation task plan

Goal: replicate the architecture in [nasomers/flycast-wasm wasm-jit](https://github.com/nasomers/flycast-wasm) which reportedly hits **20-40+ FPS on Dreamcast titles** in WASM, using the same Flycast + SHIL + per-block emit pipeline we already have.

Architectural delta from current state:
- **Today**: every dispatch goes through `C++ → EM_JS → JS dispatcher (Map.get) → wasm block.run()`. The EM_JS hop is the documented jor1k-2014 failure mode (10K+ JS↔wasm round-trips/sec doesn't work).
- **Target**: each compiled block's `run` export is added to Emscripten's shared `__indirect_function_table` (single shared table across the worker). C++ dispatcher calls via a regular function pointer → WASM toolchain lowers to `call_indirect` against that table. Dispatch stays inside WASM. No JS hop.

No time estimates anywhere in this doc, per `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_no_time_estimates.md`. Tasks are ordered by dependency; some are parallel-safe (noted).

---

## Files touched

| File | Change shape |
|---|---|
| `dreamcast/flycast-bridge/flycast_worker_link.sh` | export `wasmTable` runtime; add `ASYNCIFY_REMOVE` list |
| `dreamcast/flycast-bridge/flycast_worker_funcs.js` | new `flycast_install_block` (grows wasmTable); delete `flycast_install_epoch`, `flycast_run_block` |
| `dreamcast/flycast-bridge/rec_wasm.cpp` | new C-side dispatch table + lookup; delete EM_JS `wasm_dispatcher_run_block`, `wasm_dispatcher_install_epoch`, `flush_epoch`, `g_active_blocks` etc |
| `bementalJIT/guests/sh4/wasm_emit.cpp` | delete `build_epoch_module`; restore single-block `build_block` as the only emit path |
| `bementalJIT/guests/sh4/wasm_emit.h` | drop epoch declarations |

---

## Task 1 — Build-script changes (no dependencies)

**Goal**: expose Emscripten's `wasmTable` to JS land and remove ASYNCIFY wrapping from hot SH4 functions.

**File**: `dreamcast/flycast-bridge/flycast_worker_link.sh`

**Concrete change** — `EXPORTED_RUNTIME` array at line ~67, append `wasmTable`:

```bash
EXPORTED_RUNTIME='[
  "ccall",
  "cwrap",
  "getValue",
  "setValue",
  "HEAP8",
  "HEAPU8",
  "HEAP32",
  "HEAPU32",
  "FS",
  "FS_createDataFile",
  "FS_createPath",
  "callMain",
  "stringToNewUTF8",
  "GL",
  "wasmTable"
]'
```

Then add an `ASYNCIFY_REMOVE` flag near the existing `-sASYNCIFY=1` at line ~202. The nasomers data shows this nets +37% on the interpreter path; on the JIT path the gain compounds because block bodies stop being wrapped:

```bash
  -sASYNCIFY=1 \
  -sASYNCIFY_REMOVE='["sh4_mem_read8","sh4_mem_read16","sh4_mem_read32","sh4_mem_write8","sh4_mem_write16","sh4_mem_write32","sh4_interp_ifb","sh4_interp_shil_fb","wasm_block_trampoline"]' \
```

Note: `ASYNCIFY_REMOVE` is a strict subset (functions that DON'T need asyncify wrapping); errors at link time if any listed function transitively reaches an async import. Add functions cautiously; remove from list if link fails.

**Verification**: relink, grep build log for `error: ASYNCIFY`. If clean, build artifact reaches the worker without abort.

---

## Task 2 — JS install hook (depends on Task 1)

**Goal**: add a JS function that takes block bytes + vaddr, compiles + instantiates a one-export module, grows `wasmTable`, writes the export ref at the new slot, returns the slot index. Drop the epoch-shaped JS that's currently active.

**File**: `dreamcast/flycast-bridge/flycast_worker_funcs.js`

**Concrete change** — add the new function (after `flycast_register_block` at line ~107):

```js
// nasomers-pattern install: compile block, instantiate, grow shared wasmTable,
// return new table index. C dispatcher in rec_wasm.cpp calls via fn pointer →
// WASM toolchain lowers to call_indirect against this same table, no JS hop.
// Keep instance refs alive so V8 doesn't GC the wasm code while the slot is in
// use. Returns 0 on failure (sentinel — slot 0 is unused/null fn).
var flycast_table_slots = [];   // index → Instance (GC root)
var flycast_first_grow_done = false;

function flycast_install_block(bytesPtr, len, vaddr) {
  bytesPtr = bytesPtr >>> 0;
  len      = len      >>> 0;
  vaddr    = vaddr    >>> 0;
  try {
    var src   = HEAPU8.subarray(bytesPtr, bytesPtr + len);
    var bytes = new Uint8Array(src);          // owned copy — compile may detach src
    var mod   = new WebAssembly.Module(bytes);
    if (!flycast_wasm_imports) {
      flycast_wasm_imports = flycast_build_imports();
    }
    var inst  = new WebAssembly.Instance(mod, flycast_wasm_imports);
    var fn    = inst.exports.run;
    if (typeof fn !== 'function') {
      flycast_last_register_error = 'install_block: missing "run" export';
      return 0;
    }
    // wasmTable is Module.wasmTable (added via EXPORTED_RUNTIME). It's the
    // SAME table Emscripten's __indirect_function_table maps to inside wasm.
    // grow + set is the documented WebAssembly.Table API; supported in
    // Chrome 69+ / Firefox 78+. https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Table/grow
    var idx = wasmTable.length;
    wasmTable.grow(1);
    wasmTable.set(idx, fn);
    flycast_table_slots[idx] = inst;
    return idx;
  } catch (e) {
    flycast_last_register_error = (e && e.message) ? e.message : String(e);
    return 0;
  }
}
```

**Delete from same file** (no longer needed):
- `flycast_install_epoch` (~lines 139-185)
- `flycast_run_block` (~lines 187-204)
- `flycast_active_instance`, `flycast_vaddr_to_fn`, `flycast_epoch_serial` globals at top
- `flycast_block_modules`, `flycast_block_instances` Maps (old per-block path)
- `flycast_register_block` (~lines 107-128) — superseded by `flycast_install_block`

**Verification**: open dreamcast.html in browser console. After load, type `typeof Module.wasmTable` — should print `"object"`. Type `Module.wasmTable.length` — should print a number ≥ initial pool size.

---

## Task 3 — New EM_JS bridge (depends on Task 2)

**Goal**: thin EM_JS body that the C compile path calls to install a block + get its table index back.

**File**: `dreamcast/flycast-bridge/rec_wasm.cpp`

**Concrete change** — replace the existing `wasm_dispatcher_register_block` EM_JS (lines 62-71). Sketch:

```cpp
// Compile + instantiate `bytes`, grow __indirect_function_table by one,
// install the block's `run` export at the new slot, return the slot index.
// Returns 0 on failure (slot 0 is reserved as a null sentinel by Emscripten).
EM_JS(uint32_t, wasm_install_block,
      (const uint8_t* bytes, uint32_t len, uint32_t vaddr),
{
    if (typeof flycast_install_block === 'function') {
        return flycast_install_block(bytes >>> 0, len >>> 0, vaddr >>> 0) >>> 0;
    }
    return 0;
});
```

**Delete from same file** (no longer needed):
- `wasm_dispatcher_register_block` EM_JS (lines 62-71)
- `wasm_dispatcher_install_epoch` EM_JS (lines 85-94)
- `wasm_dispatcher_run_block` EM_JS (lines 96-103)
- `wasm_dispatcher_get_last_error` EM_JS (lines 108-119) — or keep if useful for diag

---

## Task 4 — C-side dispatch table + lookup (depends on Task 3)

**Goal**: C-side typed-fn-pointer table indexed by a vaddr hash. Lookup + direct call replaces the EM_JS trampoline.

**File**: `dreamcast/flycast-bridge/rec_wasm.cpp`

**Concrete change** — add after the includes and before any function definitions:

```cpp
// ---------------------------------------------------------------------------
// nasomers-pattern dispatch table.
//
// Each compiled SH4 block's `run` export is registered into Emscripten's
// __indirect_function_table at install time (via JS-side wasmTable.grow+set).
// The table index is then stored here, hashed by guest vaddr. C-side dispatch
// becomes a direct function-pointer call which the WASM toolchain lowers to
// `call_indirect __indirect_function_table, idx` — staying inside WASM, no
// JS hop, no Map.get megamorphic IC.
//
// Sizing: JIT_TABLE_SIZE = 1<<20 entries × 8B/entry × 2 arrays = 16 MB.
// Hash collision via linear probe in lookup() / install_block().
// PC guard (s_block_pc) doubles as occupancy bit: 0 = empty slot.
// ---------------------------------------------------------------------------
typedef uint32_t (*BlockFn)(uint32_t ctx_ptr, uint32_t ram_base);

#define JIT_TABLE_SIZE (1u << 20)
#define JIT_TABLE_MASK (JIT_TABLE_SIZE - 1u)
static BlockFn  s_block_fn[JIT_TABLE_SIZE];   // funcref-table index cast to fn ptr
static uint32_t s_block_pc[JIT_TABLE_SIZE];   // 0 = empty, non-zero = vaddr stored here
static uint32_t s_block_count = 0;            // active blocks (diag)

static inline uint32_t jit_hash(uint32_t vaddr) {
    // Knuth multiplicative hash — fast, decent distribution on aligned vaddrs.
    return (vaddr * 2654435761u) & JIT_TABLE_MASK;
}

static inline BlockFn jit_lookup(uint32_t vaddr) {
    uint32_t h = jit_hash(vaddr);
    // Linear-probe up to 8 slots; further means table is overloaded
    // (resize or evict — not implemented in v1).
    for (int probe = 0; probe < 8; ++probe) {
        uint32_t slot = (h + probe) & JIT_TABLE_MASK;
        uint32_t stored_pc = s_block_pc[slot];
        if (stored_pc == 0)     return nullptr;   // empty: not installed
        if (stored_pc == vaddr) return s_block_fn[slot];
    }
    return nullptr;
}

// Called from compile() after wasm_install_block returns a non-zero index.
// vaddr must be non-zero (caller guards). On full hash bucket (8 collisions),
// returns false; caller should defer or fall back.
static inline bool jit_register(uint32_t vaddr, uint32_t table_idx) {
    if (vaddr == 0 || table_idx == 0) return false;
    uint32_t h = jit_hash(vaddr);
    for (int probe = 0; probe < 8; ++probe) {
        uint32_t slot = (h + probe) & JIT_TABLE_MASK;
        if (s_block_pc[slot] == 0 || s_block_pc[slot] == vaddr) {
            s_block_pc[slot] = vaddr;
            // The table index from Emscripten's wasmTable is the same value
            // the WASM call_indirect opcode expects. Cast through uintptr_t
            // for clarity; on wasm32 this is just a 32-bit reinterpret.
            s_block_fn[slot] = (BlockFn)(uintptr_t)table_idx;
            ++s_block_count;
            return true;
        }
    }
    return false;
}
```

**Verification**: link succeeds; `nm dreamcast/flycast_libretro/flycast_worker_emcc.wasm | grep s_block_fn` (or equivalent objdump) shows the symbol.

---

## Task 5 — Replace `wasm_block_trampoline` with direct call (depends on Task 4)

**Goal**: the per-dispatch hot path becomes lookup + direct call, no EM_JS.

**File**: `dreamcast/flycast-bridge/rec_wasm.cpp` (lines ~330-377)

**Concrete change** — replace the current `wasm_block_trampoline` body:

```cpp
static void wasm_block_trampoline()
{
#ifdef DEBUG_DISPATCH
    const double tA = emscripten_get_now();
#endif
    Sh4Context* ctx = &Sh4cntx;
    const u32 pc = ctx->pc;
    static uintptr_t s_ram_base = 0;
    if (!s_ram_base) s_ram_base = (uintptr_t)GetMemPtr(0x0c000000, 1);

    BlockFn fn = jit_lookup(pc);
    if (!fn) {
        // Cache miss: invoke Flycast's standard "compile block at PC" path.
        // That ends up calling our compile() override, which calls
        // wasm_install_block and jit_register. After it returns, look up
        // again — if still missing, advance PC by 2 (matches the legacy
        // fallback in flycast_run_block).
        rdv_FailedToFindBlock_pc();
        fn = jit_lookup(pc);
        if (!fn) {
            ctx->pc = pc + 2;
            return;
        }
    }

#ifdef DEBUG_DISPATCH
    const double tB = emscripten_get_now();
#endif
    // Direct call. WASM toolchain lowers this to:
    //   call_indirect $type, $__indirect_function_table   ;; idx on stack
    // Same table, same instance as the caller — V8 fast path. No JS bound-
    // ary cross, no EM_JS asyncify wrap.
    const u32 next_pc_raw = fn((u32)(uintptr_t)ctx, (u32)s_ram_base);
#ifdef DEBUG_DISPATCH
    const double tC = emscripten_get_now();
#endif

    const u32 next_pc = next_pc_raw & ~1u;
    ctx->pc = next_pc;

#ifdef DEBUG_DISPATCH
    const double tD = emscripten_get_now();
    g_cb_tramp_pre_ns.fetch_add ((uint64_t)((tB - tA) * 1e6), std::memory_order_relaxed);
    g_cb_tramp_emjs_ns.fetch_add((uint64_t)((tC - tB) * 1e6), std::memory_order_relaxed);
    g_cb_tramp_post_ns.fetch_add((uint64_t)((tD - tC) * 1e6), std::memory_order_relaxed);
#endif
}
```

**Verification**: bench shows `tramp_emjs_ns` drops from ~1000 ns to <100 ns post-cliff. If it doesn't, the lookup is hitting the linear-probe-overflow path or `fn` is null.

---

## Task 6 — Update `compile()` to use new install path (depends on Task 4 + Task 5)

**Goal**: compile() emits a single-block module, calls `wasm_install_block`, registers the returned table index.

**File**: `dreamcast/flycast-bridge/rec_wasm.cpp` (search for `void compile(`, ~line 335)

**Concrete change**:

```cpp
void compile(RuntimeBlockInfo* block, bool /*smc_checks*/, bool /*optimise*/) override
{
    const u32 vaddr = block->vaddr;

    // Emit a one-export WASM module containing the SHIL-translated block body.
    // build_block returns plain wasm bytes (Module + Instance done JS-side).
    std::vector<u8> bytes = bemental::sh4::build_block(block);
    if (bytes.empty()) {
        WARN_LOG(DYNAREC, "[rec_wasm] build_block returned empty for vaddr=%08x", vaddr);
        return;
    }

    // JS-side: compile, instantiate, grow wasmTable, return new slot index.
    const u32 idx = wasm_install_block(bytes.data(), (u32)bytes.size(), vaddr);
    if (idx == 0) {
        WARN_LOG(DYNAREC, "[rec_wasm] wasm_install_block FAILED vaddr=%08x bytes=%zu",
                 vaddr, bytes.size());
        return;
    }

    // C-side: hash + store. Linear-probe collision is a no-op on overflow
    // (block becomes uncached; next dispatch will re-compile).
    if (!jit_register(vaddr, idx)) {
        WARN_LOG(DYNAREC, "[rec_wasm] jit_register overflow at vaddr=%08x", vaddr);
        return;
    }

    // Flycast's block manager still wants block->code to be a non-null pointer
    // (it die()s on duplicates with nullptr). Reuse the trampoline pointer —
    // any dispatch to this block goes through wasm_block_trampoline anyway.
    block->code           = (DynarecCodeEntryPtr)&wasm_block_trampoline;
    block->host_code_size = 0;
    block->host_opcodes   = 0;
}
```

**Delete from same file**:
- `g_active_blocks`, `g_active_vaddrs`, `g_pending_blocks`, `g_pending_vaddrs` vectors and their initializers
- `g_epoch_serial`, `g_epoch_flushes`, `g_epoch_flush_errs` counters
- `EPOCH_BATCH`, `EPOCH_MAX_ACTIVE` constants
- `flush_epoch()` function entirely
- All `flush_epoch(...)` call sites in `mainloop()` and `compile()`

**Verification**: build + 30s probe. `[stats]` should show non-zero `disp/s` and growing block count. `grep -c "wasm_install_block FAILED" /tmp/probe-dc.log` should be 0.

---

## Task 7 — Drop epoch from `bementalJIT` (depends on Tasks 5+6 actually using single-block path)

**Goal**: remove the multi-export epoch module emit since nothing calls it any more.

**File**: `bementalJIT/guests/sh4/wasm_emit.cpp`

**Concrete change** — delete:
- `build_epoch_module` function (lines ~1390-1450 in current state)
- 4th type slot in `emitTypeImportSection` if present (revert to 3 types) — already reverted as of latest state per `dreamcast_inwasm_dispatcher_plan.md`'s ATTEMPTED+REVERTED writeup

**File**: `bementalJIT/guests/sh4/wasm_emit.h`

**Concrete change** — delete:
- `build_epoch_module` declaration
- `build_block_function_bytes` declaration
- Intra-link / `vaddr_to_idx` parameter on `emitBlockExit` if the parameter is now always nullptr (verify by grep — `emitBlockFuncBody` callers)

**Keep**:
- `build_block` (the single-block emit path — used by the new compile())
- `emitBlockExit` core logic — intra-link tail-call was epoch-only, but the function itself still emits PC writeback for non-linked branches
- `emitBlockFuncBody` — used by `build_block`
- Per-block cycle drain emit
- RegCache, ctx_off, etc.

**Verification**: build succeeds. `grep build_epoch_module bementalJIT/ -r` returns no matches.

---

## Task 8 — A/B harness for measurement (parallel-safe with Tasks 5+6)

**Goal**: build artifact supports both old (EM_JS) and new (table dispatch) paths via env var, so we can compare measurements without round-tripping git.

**File**: `dreamcast/flycast-bridge/flycast_worker_link.sh`

**Concrete change** — add near the existing `FLYCAST_RELEASE` env-var gate at line ~149:

```bash
# Dispatch architecture: "table" (nasomers __indirect_function_table) or
# "emjs" (legacy EM_JS round-trip). Default "table" once Task 5 lands.
DISPATCH_FLAGS=""
case "${FLYCAST_DISPATCH:-table}" in
  table) DISPATCH_FLAGS="-DFLYCAST_DISPATCH_TABLE" ;;
  emjs)  DISPATCH_FLAGS="-DFLYCAST_DISPATCH_EMJS" ;;
  *)     echo "ERROR: FLYCAST_DISPATCH must be table|emjs" >&2; exit 1 ;;
esac
echo "link: dispatch = ${FLYCAST_DISPATCH:-table}"
```

Add `$DISPATCH_FLAGS` to the emcc command line.

**File**: `dreamcast/flycast-bridge/rec_wasm.cpp`

Gate the new path behind `#ifdef FLYCAST_DISPATCH_TABLE` and keep the old EM_JS code reachable under `#ifdef FLYCAST_DISPATCH_EMJS`. Two compile-time variants, one source tree. Drop the gate (and old code) once table-dispatch is verified.

**Verification**: `FLYCAST_DISPATCH=emjs bash dreamcast/flycast-bridge/flycast_worker_link.sh && bash dreamcast/build_and_probe.sh --skip-link --name baseline-emjs` and `FLYCAST_DISPATCH=table ... --name new-table`. Compare `/tmp/dc-probes/baseline-emjs.log` vs `new-table.log` for disp/s and unique-PC count.

---

## Task 9 — Verify + measure (depends on Tasks 5-8)

**Goal**: confirm the new path beats the old one + reaches game-render frames.

**Probe sequence** (no source changes):

```bash
# Baseline (current, EM_JS dispatch)
cd /Users/caseybement/Bemental77.github.io
FLYCAST_DISPATCH=emjs bash dreamcast/flycast-bridge/flycast_worker_link.sh
bash dreamcast/build_and_probe.sh --skip-link --duration 60000 --idle 30000 --name baseline-emjs

# New (nasomers table dispatch)
FLYCAST_DISPATCH=table bash dreamcast/flycast-bridge/flycast_worker_link.sh
bash dreamcast/build_and_probe.sh --skip-link --duration 60000 --idle 30000 --name new-table
```

**Numbers to extract from each log**:

```bash
LOG=/tmp/dc-probes/new-table.log
echo "disp/s at cliff:" ; grep '\[stats\]' $LOG | tail -10
echo "unique PCs:"      ; grep "sh4 dispatch" $LOG | awk -F'pc=' '{print $2}' | awk '{print $1}' | sort -u | wc -l
echo "video_cb real frames:" ; grep "video_cb" $LOG | grep -v "data=0" | wc -l
echo "trampoline cost:" ; grep '\[cost-breakdown\]' $LOG | tail -5
```

**Success criteria** (any one is decisive):

- New disp/s ≥ 10× old disp/s at the same boot wall-time mark (current 9.5K → target ≥95K)
- Unique-PC count ≥ 200 in 60s (today: ~91 in 5min)
- Any non-zero `video_cb data=0x...` line (real frame to canvas)

**Kill criteria**:

- Build fails repeatedly with new flags — fall back to Angle 2 (interpreter, one-line `config::DynarecEnabled.override(false)`) for milestone validation
- disp/s ≤ 2× old — the JS hop wasn't actually the bottleneck; revisit the cost-breakdown numbers for what else dominates
- Probe shows exceptions > 0 with new path — fn-signature mismatch in install path; check `inst.exports.run` arity vs `BlockFn` typedef

---

## Task 10 — Cleanup (depends on Task 9 success)

**Goal**: remove dead code paths once table-dispatch is verified.

**Files** + **Concrete changes**:

1. `dreamcast/flycast-bridge/flycast_worker_funcs.js` — delete: `flycast_install_epoch`, `flycast_run_block`, `flycast_active_instance`, `flycast_vaddr_to_fn`, `flycast_epoch_serial`, `flycast_block_modules`, `flycast_block_instances`, `flycast_register_block` (all already noted in Task 2)

2. `dreamcast/flycast-bridge/rec_wasm.cpp` — drop the `#ifdef FLYCAST_DISPATCH_EMJS` guard + old EM_JS bridges + epoch state from Tasks 6 + 8

3. `bementalJIT/guests/sh4/wasm_emit.cpp` + `.h` — drop epoch from Task 7

4. `dreamcast/flycast-bridge/flycast_worker_link.sh` — drop the `FLYCAST_DISPATCH` env-var gate, hardcode `-DFLYCAST_DISPATCH_TABLE` or just remove the define entirely

5. **Memory file actions** (`~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/`):
   - SUPERSEDE: `dreamcast_inwasm_dispatcher_plan.md` (the in-wasm dispatcher attempt is dead)
   - SUPERSEDE: most of `dreamcast_jit_perf_phase1.md` except the SPG-raise + canvas-fix sections
   - NEW: `dreamcast_table_dispatch_landed.md` — architecture summary + before/after numbers
   - KEEP: `dreamcast_canvas_emscripten_fix.md`, `dreamcast_session_2026_05_16.md` (SPG fix still load-bearing)

6. Delete `dreamcast/docs/option2-direct-dispatch/` directory (Option 2 is abandoned per pivot doc)

**Verification**: full rebuild + probe still passes. `grep -r "flush_epoch\|flycast_install_epoch\|wasm_dispatcher_run_block" dreamcast/ bementalJIT/` returns no matches.

---

## Reference: minimal block module shape (what `build_block` emits today)

For Tasks 2 + 3 to work, the JS-side `flycast_install_block` expects `inst.exports.run` with signature `(i32 ctx_ptr, i32 ram_base) -> i32`. This is already what `bementalJIT/guests/sh4/wasm_emit.cpp` `build_block` produces:

- Type 0: `(i32, i32) -> i32` — the block's `run` signature
- Imports: `env.memory` + 8 host functions (`sh4_read8/16/32`, `sh4_write8/16/32`, `sh4_ifb`, `sh4_shil_fb`)
- One exported function named `"run"` at func-index `WIMPORT_COUNT + 0`
- Code section: per-block cycle drain + SHIL body + emitBlockExit (writes ctx->pc, returns it)

No changes to `build_block` are needed for table-dispatch. The new path just plumbs `inst.exports.run` to `wasmTable` instead of into a JS Map.

---

## Dependency graph

```
Task 1 (link.sh — runtime exports + ASYNCIFY_REMOVE)
   ↓
Task 2 (JS install hook)
   ↓
Task 3 (EM_JS bridge in rec_wasm.cpp)
   ↓
Task 4 (C-side table + lookup)
   ↓
Task 5 (replace trampoline with direct call)  ─┐
   ↓                                            ├─ parallel-safe with Task 8 (A/B gate)
Task 6 (replace compile() to use new install)  ─┘
   ↓
Task 7 (drop epoch from bementalJIT)
   ↓
Task 9 (verify + measure)
   ↓
Task 10 (cleanup — only after 9 passes)
```

---

## What this plan deliberately does NOT do

- **No dlopen / MAIN_MODULE / SIDE_MODULE.** Option 2's complexity is bypassed entirely. The shared `__indirect_function_table` does the same job with no PIC tax, no dynamic-linking-with-pthreads bugs, no main-module rebuild.
- **No multi-module sharding / partition strategies.** Single shared table; each block is a tiny module attached at instantiate time.
- **No clock scaling / interpreter switching / threaded-rendering re-enable.** Those are separate orthogonal angles documented in `dreamcast/docs/option2-direct-dispatch/pivot-options.md` — not part of this pivot.

---

## References

- [nasomers/flycast-wasm wasm-jit branch](https://github.com/nasomers/flycast-wasm/blob/wasm-jit/upstream/patches/rec_wasm.cpp) — production architecture
- [WebAssembly.Table.grow MDN](https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Table/grow) — runtime table extension
- [V8 wasm-speculative-optimizations](https://v8.dev/blog/wasm-speculative-optimizations) — call_indirect inlining, same-instance fast path
- [Emscripten ALLOW_TABLE_GROWTH docs](https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html#interacting-with-code-call-function-pointers-from-js) — addFunction / table.grow
- [Emscripten Asyncify ASYNCIFY_REMOVE](https://emscripten.org/docs/porting/asyncify.html#optimizing) — +37% lift on hot functions
- Local: `dreamcast/docs/option2-direct-dispatch/pivot-options.md` — Angle 7 source
- Local: `dreamcast/docs/option2-direct-dispatch/BLOCKERS.md` — why Option 2 is dropped
- Local: `dreamcast/flycast-bridge/rec_wasm.cpp` lines 62-377 — current EM_JS dispatch
- Local: `dreamcast/flycast-bridge/flycast_worker_funcs.js` lines 65-243 — current JS dispatcher
- Local: `bementalJIT/guests/sh4/wasm_emit.cpp` `build_block` at line ~1347 — unchanged emit path

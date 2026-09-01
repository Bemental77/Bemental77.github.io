# Item 5: HLE handler dispatch statically linked into ppc-worker

## Problem

Every PPC block dispatched in ppc-worker can begin with a call to
`env.ppc_hle_check(pc)` (one WASM import). Each call crosses
WASM -> JS (page mailbox) -> WASM (dolphin) -> `dolphin_hle_check` ->
`HLE::GetHookByAddress` (`std::map<u32,u32>` lookup) -> back. Per
`levers_post_skip_real_measurement_2026_05_06.md`, even after gating
the per-instruction call sites, the prologue check fires ~2.7x per
dispatch (the prologue plus block-body re-checks) and is the single
biggest per-dispatch JS round-trip cost.

`option_d_emit_stub_shipped_2026_05_11.md` (commit f35466e) already
stubs every per-instruction `WIMPORT_HLE_CHECK` to `drop + i32.const 0`
when `emit_perf_stub=true` (ppc-worker passes true). And ppc-worker
currently passes `emit_hle_check=false` to the prologue
(`ppc_worker_main.cpp:271,339`), so the prologue check is also dead.
This is FINE for perf-window measurement but WRONG for real boot --
without the prologue check, ppc-worker would skip every replaced HLE
function (DCFlushRange, __OSLoadContext, HLEMemset, HLEMemcpy, the
string family, etc.) and boot regression is guaranteed.

Item 5 makes the prologue + body HLE checks correct AND fast: same
semantics as dolphin's `dolphin_hle_check`, executed as inlined wasm
inside the same module as the dispatched blocks.

## Active HLE table (HLE.cpp:29-129)

`os_patches[]` -- 56 entries. Active in production:

| Category                | Entries                                                                                                                                  | Side effects                                                                            |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| Cache mgmt (no-op)      | DCFlushRange{,NoSync}, DCInvalidate/Store{,NoSync}, DCZeroRange, ICInvalidateRange, ICBlockInvalidate, DCBlock{Flush,Invalidate,Store,Zero}, FlushCacheCW | Each = `npc = lr`. No state touched beyond PC/LR.                                       |
| Scheduler hot path      | __OSLoadContext, __OSSaveContext, OSLoadContext, OSSaveContext                                                                           | Read/write OSContext (768B) via MMU. Touches GPR, FPR, SPR, MSR, CR. CheckExceptions.   |
| String / mem            | HLEMemset, HLEMemcpy, HLEStrlen, HLEStrcpy, HLEStrcat, HLEStrchr                                                                         | MEM1 reads/writes via MMU. Sets r3, CR0.                                                |
| OSPanic / OSReport      | OSPanic, OSReport, DEBUGPrint, vprintf, printf, puts, ___blank, AppLoaderReport, etc.                                                    | Read MEM1 (format str + va_args), emit console log. No state mutation beyond PC = LR.   |
| Misc unblocks           | HLEEXIWaitUnblock, HLEDSPResetUnblock, HLEDSPMailUnblock, HLEDSPARModeUnblock, HLEAIBufferUnblock                                         | HookType::Start -- run alongside the real function.                                     |
| Fixed (address-keyed)   | HBReload, GeckoCodehandler, GeckoHandlerReturnTrampoline                                                                                 | Special boot path.                                                                      |
| SAB busy-wait           | HLESICallback, HLEGenericSkip                                                                                                            | `npc = lr`.                                                                             |

Per `sab_session_arc_2026_05_05.md` actual hot HLE matches during real
SAB boot: HLEMemset, HLEMemcpy, the 4 OS{Load,Save}Context entries, the
string family, DCFlushRange variants. ~30-40 patched PC ranges total.
Each patched function patches its whole range (every 4-byte instr addr
within `[symbol->address, symbol->address + symbol->size)` is keyed
into `s_hooked_addresses`, see HLE.cpp:206-210).

For SAB observed range counts:
* ~30 functions x ~10 instrs avg = ~300 entries in `s_hooked_addresses`.
* For PSO likely similar.

## Strategy: hybrid (option c)

Pure-wasm fast path in ppc-worker for the lookup; dolphin still owns
the handler bodies because they require `Core::CPUThreadGuard`,
`Core::System&`, the `PPCSymbolDB`, host logging, etc. (handlers are
deeply coupled to dolphin's runtime model).

* Pure wasm **lookup** in ppc-worker: "does this PC have an HLE hook,
  and if so what is its hook_index?". Direct read of SAB-resident
  data. Zero JS calls.
* On miss (the ~95% case): branch falls through, block body executes.
* On hit (the ~5% case): fire `env.ppc_hle_fire(pc, hook_index)` via
  page mailbox -> `dolphin_hle_fire`, which calls `HLE::Execute` then
  returns the new PC. Same cost as today's `dolphin_hle_check` hit
  path, but only on actual matches.

Net: the dominant ~95% miss path goes from "WASM->JS->WASM->JS->WASM"
to "wasm-only -- one i32.load + one i32.eq + br_if". V8 can keep this
inline.

### Why not a bloom filter?

A bloom filter adds false positives (each false positive triggers the
~5% hit path, which IS a JS round-trip). With ~300 keys, false-
positive rate at 4 KB of bits is small (<1%) but nonzero. Direct
lookup is simpler, fits trivially in SAB, and gives zero false
positives.

### Data structure (SAB-resident)

Direct-mapped hash table, open addressing, linear probe. Sized at
build time to 2x peak entries -> 1024 slots = 8 KB. Each slot:

```
struct HleSlot { u32 pc; u32 hook_index; };   // 8 bytes
```

Sentinel: `pc == 0` means empty (PC 0 is never a valid hook).

SAB layout addition (sab_layout.h). 0x02680000 was taken by Item 7's
CoreTiming event queue between this design doc and Item 5's
implementation; HLE table moved to 0x02690000..0x026A0000 (64 KB
reserved, only 8 KB currently used so future grow-to-2048 fits):
```
constexpr uint32_t HLE_TABLE_ADDR  = 0x02690000u;
constexpr uint32_t HLE_TABLE_SLOTS = 1024u;
constexpr uint32_t HLE_TABLE_MASK  = HLE_TABLE_SLOTS - 1u;
constexpr uint32_t HLE_TABLE_BYTES = HLE_TABLE_SLOTS * 8u;  // 8 KB
```

`SabMetadata::hle_table_addr` and `hle_table_count` (sab_layout.h:56-57)
already exist; populate at init.

Hash: `(pc >> 2) * 2654435761u` (Knuth multiplicative; PC is 4-byte
aligned). Linear probe up to MAX_PROBE_DIST (e.g. 8) on collision;
if exceeded, panic-fallback to the JS path so we never miss a real
hook.

### Wasm-native lookup emit

New helper in `bementalJIT/guests/powerpc/gekko_emit.cpp` --
`emit_hle_check_native(EmitCtx& c, u32 pc_const_or_local)` -- emits
this body (~12 wasm ops):

```
;; const-PC variant (prologue): pc known at emit time.
;; hash := (start_pc >> 2) * 2654435761 & MASK
i32.const HLE_TABLE_ADDR + ((((start_pc >> 2) * 2654435761) & MASK) << 3)
local.tee TMP_A
i32.load offset=0           ;; slot.pc
i32.const start_pc
i32.eq
local.get TMP_A
i32.load offset=4           ;; slot.hook_index (may be junk if pc!=)
i32.const 0
select                      ;; hook_index or 0
```

If hash bucket misses, linear probe is unrolled in JIT (1-2 probes
inline, fall back to runtime hash-walk in a separate wasm function
exported by the same module). For a const-PC prologue, the bucket
index AND probe sequence can be fully resolved at emit time --
either we know start_pc is in the table (with a specific slot) or
not. That collapses prologue to: `i32.const hook_index_or_0` --
literally one constant load.

### Block-body checks

Per-instruction HLE checks (today emitted via `emit_import_or_stub`
at compile time) are checks against a runtime PC (after a branch
target). Those are rarer than the prologue check; for those use
the runtime-resolved variant (1-2 probes inline + fall-back wasm
function).

## Phased implementation plan

### Phase 1 -- SAB layout + dolphin writer

Files:
* `gamecube/ppc-worker/sab_layout.h` -- add `HLE_TABLE_ADDR` etc as
  shown above. Reserved range `0x02680000..0x02690000`.
* `gamecube/dolphin-src/Source/Core/Core/HLE/HLE.h` -- add
  `void ExportSnapshot(u8* sab_base, u32 slots_addr, u32 n_slots, u32 mask)`.
* `gamecube/dolphin-src/Source/Core/Core/HLE/HLE.cpp` -- after
  `PatchFunctions()` returns, iterate `s_hooked_addresses` and place
  each `{pc, hook_index}` pair into the table using the same hash as
  the JIT. Linear probe on collision. Track `g_hle_table_load_factor`
  for monitoring.
* `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp` --
  call `HLE::ExportSnapshot(...)` in `EM_ASM` setup after `PatchFunctions`
  is done (boot path). Also export
  `EMSCRIPTEN_KEEPALIVE u32 dolphin_hle_table_addr() { return HLE_TABLE_ADDR; }`
  for ppc-worker to read at init.

Acceptance: after dolphin boot, page can DataView-read SAB[0x02680000..]
and count nonzero slots. Should be ~300 for SAB ROM.

### Phase 2 -- ppc-worker mailbox cmd 14 = HleFire

Files:
* `gamecube/ppc-worker/sab_layout.h` -- add `MailboxCmd::HleFire = 14`,
  payload (pc, hook_index), reply (next_pc).
* `gamecube/ppc-worker/ppc_worker.js` -- in the import setup block,
  add `env.ppc_hle_fire = (pc, idx) => call2(14, pc, idx);`.
* `gamecube/dolphin-bridge/worker_funcs.js` (case routing) -- add
  `case 14: r = Module._dolphin_hle_fire(a0, a1) >>> 0; break;`.
* `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp` --
  add `EMSCRIPTEN_KEEPALIVE u32 dolphin_hle_fire(u32 pc, u32 idx)` which
  calls `HLE::ExecuteFromJIT(pc, idx, system)` and returns the post-
  execute PC. Export from dolphin_worker_link.sh.

Acceptance: ppc-worker calling `ppc_hle_fire(pc, idx)` for a known
HLE PC delivers the same state transitions as the existing
`dolphin_hle_check` path.

### Phase 3 -- bementalJIT emit_hle_check_native

Files:
* `bementalJIT/guests/powerpc/gekko_emit.h` -- add
  `bool emit_hle_check_native = false` to `BlockInputs`. New
  `WIMPORT_HLE_FIRE` import index (signature: `(pc, idx) -> i32`).
* `bementalJIT/guests/powerpc/gekko_emit.cpp`:
  * Add `HLE_TABLE_ADDR` mirror constant (matching sab_layout.h).
  * Add the multiplicative-hash constant `HLE_HASH_KNUTH = 2654435761u`.
  * Add `emit_hle_check_native_const_pc(EmitCtx&, u32 pc_const)` --
    fully resolved at emit time (just emit `i32.const hook_idx_or_0`).
    Reads the dolphin-built table at emit time; this requires the
    table be available when ppc-worker compiles a block. Since
    ppc-worker self-compiles (Phase 2g), it has SAB read access --
    expose the table base as a global to the emitter via a new
    `EmitCtx::hle_table_addr` (or use the MMIO_MIRROR_ADDR-style
    constant).
  * Add `emit_hle_check_native_runtime(EmitCtx&, u32 ra_or_local)` for
    block-body checks where PC is runtime-computed.
  * In `emit_import_or_stub`, when `emit_perf_stub=true` AND import is
    `WIMPORT_HLE_CHECK` AND `emit_hle_check_native=true`, replace the
    `drop + i32.const 0` with `emit_hle_check_native_runtime`.
  * In `emit_block_body` prologue (line 3999), when `emit_hle_check`
    is true, prefer the native emit path; fall back to import call
    only when `emit_hle_check_native=false` (dolphin's own JIT).
* `bementalJIT/include/bementalJIT/block_cache.h` -- thread
  `emit_hle_check_native` flag through `BlockEmitInputs`.
* `bementalJIT/src/block_cache.cpp` -- propagate at relink.

### Phase 4 -- ppc-worker init plumbing

Files:
* `gamecube/ppc-worker/ppc_worker_main.cpp`:
  * Track the SAB-resident table address; expose to `build_block` via
    a new arg `u32 hle_table_addr`.
  * At init (`ppc_worker_init`), read `dolphin_hle_table_addr()` -- or
    just use the hard-coded `HLE_TABLE_ADDR` constant.
  * Pass `emit_hle_check=true` (was false) + `emit_hle_check_native=true`
    at both compile sites (lines 271, 339).
* `gamecube/ppc-worker/ppc_worker.js` -- wire `env.ppc_hle_fire` import.

Acceptance:
1. Compile a block at a known patched PC (e.g. HLEMemset entry). Decode
   the emitted wasm; confirm prologue contains `i32.const <slot_addr>`
   + load + eq + select, NOT a `call $WIMPORT_HLE_CHECK`.
2. Dispatch loop on SAB hits the HLEMemset path. Compare frame counts
   and boot trajectory against pre-change baseline (must match).
3. Measurement: probe `env.ppc_hle_check` import count over 100K
   dispatches. Should be 0 (or near-0 if any residual fallback paths
   remain).

### Phase 5 -- perf measurement

Reuse `bementalJIT/build-emcc/tests/test_perf_t1.js` shape. Add a
counter on `env.ppc_hle_fire` (hit count) and assert `env.ppc_hle_check`
import is not even installed in ppc-worker's import object after
this lands.

## Build commands

After Phase 1 dolphin changes:
```
bash build_and_probe.sh
```

After Phase 3 bementalJIT changes (no dolphin rebuild needed if the
runtime API is stable):
```
bash gamecube/ppc-worker/build_ppc_worker.sh
```

Both phases require rebuild together for end-to-end test.

## Risks + open questions

1. **Symbol-DB timing.** `HLE::PatchFunctions` runs after the
   apploader loads the ROM AND after `PPCSymbolDB` is populated from
   the .map. ppc-worker compile of a block at a patched PC BEFORE
   that point would see a zero table -> wrongly skip the HLE
   replacement. Mitigation: ppc-worker gates compile until
   `SabMetadata::dolphin_ready` is set; dolphin sets it AFTER
   `PatchFunctions`.

2. **Re-patch on Reload.** `HLE::Reload` is called on state-load and
   on certain game-mode changes. Dolphin must re-call ExportSnapshot
   after Reload, and ppc-worker's block-cache must be flushed (already
   happens via `region_relink` infra). The const-PC prologue baked at
   emit time would otherwise still hold the old slot value.

3. **Fixed-flag patches.** HBReload at 0x80001800, GeckoCodehandler,
   GeckoHandlerReturnTrampoline are address-keyed not symbol-keyed.
   The snapshot handles them the same way (they're already in
   `s_hooked_addresses`), so no special path needed.

4. **HookType::Start patches.** For HookType::Start, the handler runs
   AT function entry; the real function ALSO runs. Current
   `dolphin_hle_check` returns 0 for Start hooks (so the block falls
   through to normal execution) and the handler runs as a side
   effect. We must preserve this: `ppc_hle_fire` for a Start hook
   runs `HLE::Execute` then returns the unchanged PC; the block
   continues. The wasm emit must NOT `return` early on a Start-hook
   match -- only on a Replace-hook match (where PC changes to LR).
   Encode the hook type in the slot's high bits:
   `slot.hook_index = (type << 16) | idx`.

5. **Multi-block prologue cost.** For const-PC prologue, the emit-
   time table read collapses to one `i32.const`. For Phase 3a's
   merged-region path with a `br_table` dispatcher, each region-fn
   entry must independently emit its const-PC check; this is no
   different from today's per-block prologue cost.

## Files touched (summary)

* `gamecube/ppc-worker/sab_layout.h` -- add HLE table constants + cmd 14
* `gamecube/dolphin-src/Source/Core/Core/HLE/HLE.{h,cpp}` -- ExportSnapshot
* `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp` -- call ExportSnapshot, add dolphin_hle_fire + dolphin_hle_table_addr exports
* `gamecube/dolphin-bridge/dolphin_worker_link.sh` -- add 2 exports
* `gamecube/dolphin-bridge/worker_funcs.js` -- mailbox case 14
* `bementalJIT/guests/powerpc/gekko_emit.{h,cpp}` -- emit_hle_check_native, WIMPORT_HLE_FIRE, BlockInputs field
* `bementalJIT/include/bementalJIT/block_cache.h` + `bementalJIT/src/block_cache.cpp` -- propagate flag
* `gamecube/ppc-worker/ppc_worker_main.cpp` -- pass emit_hle_check=true + emit_hle_check_native=true at both compile sites; gate on dolphin_ready
* `gamecube/ppc-worker/ppc_worker.js` -- env.ppc_hle_fire import wiring

## Acceptance criteria

* `env.ppc_hle_check` import count over 100K real-boot dispatches: 0
* `env.ppc_hle_fire` import count: matches dolphin baseline `g_perf_hle_check` HIT count (the ~5% subset, not the ~95% miss)
* Boot trajectory unchanged (frames=5 minimum, no new pc-stuck regression)
* Per-block prologue emit size shrinks (no more `call` instr)

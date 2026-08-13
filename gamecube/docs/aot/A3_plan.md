# AOT campaign — A3 plan (whole-function assembly line)

**Committed campaign artifact.** Written 2026-08-12 after the merged-emitter read. Companion
to `A0_coverage.md` (the coverage table) and the A1/A2 pipeline (commits f684885, 3af4fbd).

## The Amdahl line (pre-registered — read this before judging any A3.1 number)

Board speedup is bounded by **coverage × per-function speedup**:

| coverage | per-fn win | board speedup | fps (from ~21.5fps board) |
|---:|---:|---:|---:|
| 24% (A3.1 leaf) | 3× | ~1.19× | +19% |
| 60% (A3.1+A3.2) | 3× | ~1.67× | — |
| ~80% | 3–4× | ~2.8× | **60fps** |

So **A3.1 is the proving ground**, not the win: its expected result is **+13–19% board fps**,
pre-registered here so it is not misread as failure. **A3.2's call-bearing machinery is the
center of mass** — the engine functions (FaceDraw 5.2%, HuSprDisp 3.04%, Hu3DMotionExec 1.85%,
SelectThread 3.08%, …) are where 60 actually lives. A3.1 proves the mechanism and banks the
first fifth of the distance; the road to 60 is A3.2, with a number on it.

## Emit mechanism — FOUND (reuse, don't rebuild)

`build_region_function_next_merged(const RegionBlockDesc* blocks, u32 n_blocks, u32 gen_idx,
u32 blr_chain_addr, u32 mem_pages)` (ppc_emit.cpp:2114, decl `bementalJIT/region_desc.h`) is
the whole-function emitter. Shape:

- ONE wasm function `$region` (idx 13): 8-group locals, an **activation pad** that loads all 32
  GPRs into locals once per host entry, then `loop $L` + `br_table(entry_sel)` into N spliced
  `emit_block_body_into` bodies (the SAME per-block codegen, 13-import contract).
- `fn_k` wrappers (idx 14+k), exported `()->i32`: set `entry_sel=k`, `return_call $region`.
  These are the **global-dispatch entry points** registered at each block's guest PC.
- **The fps mechanism**: intra-region edges are `entry_sel=k; return_call $region` (a V8 jump,
  ~6.6ns) or warm `br $L` (same activation → **GPR residency**, bodies skip the reload prologue).
  No inter-block host dispatch, no cross-instance call — that tax is what per-block AOT (A1)
  still paid and this removes.

**Offline-drivable: CONFIRMED.** At emit time it needs only the block descriptors + `gen_idx`
(pick a reserved AOT gen) + `blr_chain_addr` (host address of `bemental::g_blr_chain`). Both are
fixed per-binary addresses baked like `ctx_ptr` (`ctx` itself is pinned at 0x02400000). Nothing
runtime is read at emit — the runtime rtag/rslot state is read by the *emitted code* at runtime.

## Registration — the real wiring cost

The merged module is heavier to register than A1's single-`run` block. `region_relink`
(block_cache.cpp:2251) does it at runtime via `EM_ASM`: instantiate the module, build a JS
per-region `pc → local_fn_idx` Map, resolve each `fn_<k>` export, and dispatch intra-region
edges through the gen-packed `rtag/rslot` cache (`(gen_idx<<16)|k`; own-gen warm, other-gen
falls through to the host chain + enters via the global-table wrapper).

**Decision: register the AOT merged module as a PRE-SEALED immutable region gen** (reserved
`gen_idx`), then `region_dispatch` (block_cache.cpp:2497, which the game already calls) handles
it for free. Safest impl: a self-contained AOT seal that COPIES `region_seal`'s recipe, leaving
the proven runtime region path untouched.

**Registration recipe** (extracted verbatim from `region_seal`, block_cache.cpp:2068-2181 — the
exact set the AOT seal replicates):
1. Instantiate: `new WebAssembly.Instance(new WebAssembly.Module(bytes), { env })`, env = the
   shared `wasmMemory` + `Module.bemental_imports.env` (13 `ppc_*`) + `__indirect_function_table`
   = `wasmTable`.
2. Resolve exports: `gen.regionFn = exports['region']`, `gen.entrySel = exports['entry_sel']`,
   `gen.fns[i] = exports['fn_'+i]`.
3. Grow `wasmTable`, `wasmTable.set(gi, fns[i])` per block → `gen.globalSlots[i] = gi`.
4. `Module.bemental_gens[genIdx] = gen`.
5. Per block: `Module.bemental_pc2gen.set(pc, (genIdx<<16)|i)` AND point the global dispatch
   cache at the slot: `g_bem_disp_tag[(pc>>2)&mask] = pc; g_bem_disp_slot[...] = globalSlots[i]`
   (so BOTH the C-loop and the in-wasm tail-chain reach the gen directly).
6. C-side: `m_sealed_pcs.insert(pc)` per block + `m_sealed_gen_count++` (gates `region_dispatch`).

`g_bem_mrtag/mrslot` (the merged warm-edge cache) start empty → intra-region edges fall through
to the global dispatch cache (step 5, populated) until they warm — correct + fast from boot,
identical to A1's per-block correctness path. Authenticity: each block carries an FNV guest-hash
(v3 asset) verified against live guest code before the seal; any mismatch → skip (JIT fallback).

**Three riders (registration step):**
1. **Bytes/function is a tracked line metric.** HandleReverb = 539KB module from 1.3KB guest
   (~415×); at 40+ functions ~20MB+ assets, and V8 commits ~4× wire bytes + stacked instantiate
   time. Evaluate an offline `wasm-opt` post-pass at asset #2-3 (offline emission gets passes the
   runtime never could); the cold-arm question may return here in offline form.
2. **Follow A1's load path to the letter**: fetch async on the pump thread → hand bytes via SAB →
   instantiate + register on the EmuThread (tables are per-agent; A1 proved this exact
   choreography, hits=4). Registration writes keep tag-last publication order. Boot-time sync
   instantiate is fine; watch cumulative boot cost as assets stack, stagger if it grows.
3. **Per-asset gate = in-situ AOT-vs-JIT body timing + correctness**, scene fps only at batch
   milestones (~every +10% cumulative coverage, and A4).

### Loader seal design (acceptance-driven — investigated 2026-08-12, before building)

Reserved AOT gen `0xa07` (no collision with runtime gens 0..23). The seal copies the
`region_seal` recipe (above) into `BlockCache::aot_seal_merged`, with FNV per-block auth done in
JitWasm (read live guest words at each pc via `mem.Read_U32`, compare to the asset ghash; any
mismatch → skip the whole seal, JIT fallback). Load path = A1's exactly (async fetch on pump →
SAB publish tag-last → `AotPollAndLoad` on EmuThread).

**Acceptance #1 (immutability respected by the runtime) — the hazard investigation found two:**
- **`BlockCache::clear()` (savestate load / DoState, block_cache.cpp:1227-1249) WIPES ALL gens**
  incl. the AOT gen (`bemental_gens=[]`, `m_sealed_pcs.clear()`, `pc2gen.clear()`). The probe
  USES `PROBE_LOAD_STATE`, so without a response the AOT gen vanishes at load and HandleReverb
  silently runs JIT. FIX: **re-seal after clear()** — Run() re-fires the seal when the asset is
  loaded but `m_aot_sealed` is false; `clear()` also resets `m_aot_gen_count=0`/`m_aot_sealed`.
  Re-seal re-auths (FNV) so a state that changed the code can't run stale.
- **24-gen budget**: the AOT seal must NOT consume a runtime slot. Track `m_aot_gen_count`
  SEPARATELY; `region_dispatch`'s cold gate becomes `(m_sealed_gen_count + m_aot_gen_count) == 0`;
  the allocation cap stays `m_sealed_gen_count < 24` (AOT uncounted). Runtime allocation uses
  `m_sealed_gen_count` as the next index → never picks 0xa07; compaction/relink operate on their
  own region gen → never touch 0xa07. (Minimal block_cache.cpp edits; recipe copied, not refactored.)

### Timing gate result — HandleReverb (asset #1), 2026-08-12

Counter-free asset, PC-sample share on the SAME MP4 board savestate (like-for-like call
distribution), AOT-on vs AOT-off(kill): **JIT 6.14% → AOT 5.04% = −18% body time. PASS
(AOT ≤ JIT).** The merged path updates ppc_state.pc (share > 0), so the PC-sample IS a valid
per-asset timing instrument here — and this is a per-asset measure, NOT scene fps (HandleReverb's
predicted +0.7 fps is inside the board's ±1.8 noise, exactly why scene fps can't gate this).

★CALIBRATION (honest, pre-registered vs measured): the merged emit reuses `emit_block_body_into`
verbatim, so **−18% is the DISPATCH-savings + GPR-residency win ONLY — NOT a body-quality win.**
The pre-registered 2–3× assumed a better BODY (hand-optimal SIMD vs generic emit). Whole-function
merging alone does not deliver that. So the Amdahl input recalibrates: leaf line 24% × ~1.2×
(merge only) ≈ **+4–5% board** — the merge is necessary infrastructure, not the multiplier.

**Where the multiplier actually lives — two levers, honestly priced:**
- **wasm-opt (offline post-pass, rider #1) — pre-registered ~10–30%, NOT 2–3×.** Binaryen is
  deliberately conservative with SHARED-memory loads/stores (it may not freely eliminate them) and
  the singles dual-arm branches are RUNTIME-GUARDED, not statically dead — and those are precisely
  the two biggest tax classes in the emitted bodies. Both sit largely outside a post-pass's reach.
  Run the evaluation (one cheap pass on the existing asset through the existing timing gate) but do
  NOT plan the line on it; if it surprises upward, bonus.
- **★A3.1b — function-scope register RESIDENCY in the emit itself = the true multiplier (3–4×).**
  ctx→locals ONCE at function entry; per-block bodies read/write LOCALS, not memory; flush only at
  exits, service points, and import calls. This removes the per-op ctx traffic the cycle ledger
  identified as the STRUCTURAL core of the 5–6× cost (the true §6.5 shape). The merge infrastructure
  just built IS its delivery vehicle, and the full validation net (goldens, shadow-verify, timing
  gate) already stands to keep it honest. Substantial emitter work — the real kind — and where the
  3–4×/function the Amdahl line demands lives.

**Acceptance #2 (SMC evicts the AOT gen) — comes FREE from reusing the recipe.** `evict(pc)`
(block_cache.cpp:1131) → `unseal_pc_js(pc)` already per-PC drops the pc from `m_sealed_pcs` +
`bemental_pc2gen` + the global dispatch cache + `g_bem_mrtag/mrslot`, for ANY sealed gen; the
comment: "per-PC eviction is SUFFICIENT for merged gens (no baked edges)." So a write into
HandleReverb's range → `InvalidateICacheRange` → `invalidate_overlap`/`evict` → region_dispatch
misses → per-block JIT recompile. **Scripted test**: write one byte into the guest range, assert
the AOT hit-counter stops climbing and a JIT recompile of those PCs occurs.

## ★ Singles-arm precondition (existential — gates every matrix function)

`emit_block_body_into` under `MergedRegionCtx` is flagged (ppc_emit.cpp:1093) to lose the
PM44/46/47 singles arms — **Double-only merged bodies**, which is the exact mechanism of the
step-0 −38% disaster. Wiring the merged emitter as-is for the matrix family would ship
**slower-than-JIT assets**, caught by the timing gate one expensive build too late. So it is a
**HARD PRECONDITION**: singles-arm survival in merged bodies must be verified before ANY
`pure_compute` matrix function (PSMTX*/C_MTX*) is wired.

**Sequencing exploits this deliberately**: **HandleReverb (the clean-table #1, 6.44%) is
scalar-FP** — it uses no paired-single arms, so A3.1 opens there with zero exposure to the
singles bug, while the singles-in-merged-bodies fix lands for the matrix family behind it.

## Rules banked (instrument stack policing itself)

- **Coverage samples are taken AOT-off.** An AOT'd function's slowmem path freezes its own PC and
  inflates its share (the 22.17%→1.75% PSMTX correction, commit 3995cb7).
- **Any asset-on profile is contaminated by default** — kill AOT (or build without it) before
  reading any share/profile that will feed a decision.
- Timing gate is **live from asset one**: shadow-verify doubles as the guard that AOT ≥ JIT speed.

## Build order

1. ✅ A0 clean table + A3.1 leaf line (`A0_coverage.md`, `a31_leaf_line.json`).
2. **Generalize `aot_compile.cpp`** to a function spec: decode guest bytes → blocks (terminator
   logic) → `RegionBlockDesc[]` → `build_region_function_next_merged` → validate the module.
   First test: emit HandleReverb's merged module offline (extract its 323 words BY ADDRESS —
   there are two `HandleReverb` symbols; the hot one is 0x801136f0).
3. **AOT loader: merged registration** — replicate region_relink's instantiate + fn_k register +
   pc map for the asset-loaded module.
4. **HandleReverb asset** + offline direct-invocation goldens (characterize its MusyX reverb ABI
   from the decomp: reverb work-struct pointer + I/O buffers) + the live timing gate.
5. ✅ A3.1 HandleReverb asset COMPLETE: execution (5.8M) + timing (−18%) + immutability (#1) +
   SMC evict (#2). Cold-boot clean, cross-game safe. (commits 3e06d43 / 3f59a6a / ebdc815)

### Updated order (post-calibration, 2026-08-12)

1. **Singles-in-merged fix** (existential) — ppc_emit.cpp:1093, the step-0 −38% mechanism.
   **Demonstrator = PSMTXROMultVecArray** (NOT PSMTXInverse): pure paired-single (ideal arm
   exerciser — Inverse's scalar-double determinant/divide ops route to the Double arm and would
   muddy simdCensus attribution); its 26/26 goldens + differential fixture already exist
   (correctness free, no new driver); sharp acceptance = **ps-class ops in the merged body execute
   the SIMD arm** (not a fuzzy "whole-function single"). Its small share is irrelevant — this is
   the acceptance vehicle, not the win; Inverse follows as an ordinary asset. Fix = decouple the
   singles-arm build from lc_base via `g_bem_aot_build_singles` (lc_base=0 → no emit-time SAB reads;
   the `mmap` workaround is dead on macOS `__PAGEZERO`). Two consequences banked:
   - **AOT assets are GENERAL-PATH** (lc_base=0 → no locked-cache shortcut) — accepted by design,
     consistent with the impurity doctrine and irrelevant for matrix-on-RAM anyway.
   - **v9b value-verify at entry MUST survive the decoupling** — confirm it in the acceptance;
     that's the NaN-flap safety the dual-arm machinery depends on.
2. **wasm-opt evaluation** — one pass on the HandleReverb asset through the timing gate.
   Pre-registered **~10–30%, not 2–3×** (Binaryen can't touch shared-mem loads/stores or the
   runtime-guarded dual-arm branches — the two biggest tax classes).
3. **A3.1b go/no-go** — function-scope register residency (ctx→locals at entry; the true 3–4×);
   decided by (2)'s number + the residency thesis. The merge infra is its delivery vehicle.
4. **Generalize `aot_merge`** down `a31_leaf_line.json` with whichever body path won.
5. **A3.2** — call-bearing machinery (FaceDraw/HuSprDisp/Hu3DMotionExec… ~half the board) = where
   A4's 60 lives, on the proven substrate.

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
5. Singles-arm-in-merged fix → wire the matrix family (PSMTX*, C_MTX*, …).
6. Walk the rest of the leaf line (stateful → live shadow-verify). Batch MIPS gate.
7. A3.2 design from A3.1's measured per-function speedups → the road to 60.

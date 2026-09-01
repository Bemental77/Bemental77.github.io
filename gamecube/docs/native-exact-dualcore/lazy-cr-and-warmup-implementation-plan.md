# Lazy-CR + Preload/Warmup — full implementation plan (resume-after-compaction)

**Status 2026-08-04 (PM57).** Phase A (lazy-CR + adjacent cmp→branch fusion) is
BUILT, PROVEN CORRECT, and MEASURED = **WASH → reverted to eager** (BEM_LAZY_CR=
false). Same-session SAB A/B (120s presentN steady): default tiering ON≈316 vs
eager≈318 (fully overlapping); --no-liftoff ON≈303-314 vs eager≈315. The fusion
recovers PM56's lazy-CR-alone ~4% regression to parity but yields no page-fps win
— because TurboFan already DCEs the redundant eager CR-build on hot code. Code +
CmpFuse + 4 tests KEPT. **The resumable next step is PHASE B (region-scope CR
liveness)** — the one context where the CR elision is PROVABLE-DEAD (not
redundant-with-DCE) and could actually pay. Phases C/D unchanged. Ship discipline
throughout: no page-fps win on default tiering (real Chrome, `PROBE_JS_FLAGS=" "`)
= don't ship; keep the code, record.

**Measurement-rig lesson (PM57, binding for all future JIT A/Bs):** SAB presentN
has ~10% per-boot nondeterminism (two identical ON builds gave 331 vs 300/snap) —
this SWAMPS any sub-5% effect, so a 2-run default-tiering A/B cannot resolve one.
Use `--no-liftoff` (omit PROBE_JS_FLAGS) as the LOW-NOISE deterministic
attribution instrument (±1/snap intra-run) to detect an emit-quality delta, THEN
confirm the ultimate metric (default tiering) doesn't regress. And: a wasm-emit
peephole that only removes work V8's TurboFan already DCEs will wash out under
real tiering — target structural elisions V8 can't do (cross-block/region), not
local redundancies.

Governing memories: `gc_jit_lazy_cr_flags_architecture_2026_08_04`,
`gc_jit_pm22_23_thp_idct_campaign_2026_07_23`,
`feedback_metric_is_page_fps_real_chrome_2026_08_03`. Governing research outputs
(on disk under the session tasks dir, cited by run-id): wf_35a63c0e (deep research
on the architecture), wf_6a1c99de (lazy-CR representation scoping), wf_1e20dc39
(cmp→branch fusion predicate table + plumbing).

## Where things stand (verified this session)

- **Lazy-CR (QEMU cc_op, representation B: shadow+pending) is fully built and gated
  OFF** behind `constexpr bool BEM_LAZY_CR = false` in
  `gamecube/bementalJIT/guests/powerpc-next/cr_shadow.h`. When OFF the emit is
  byte-identical to pre-PM56 eager CR (verified: test_diff_next 3457/0, gekko 79/0,
  SAB ~322/snap back in the pre-lazy ~316-327 band).
- Proven SOUND (with BEM_LAZY_CR ON): test_diff_next 3457/0 (differential validates
  deferred→materialized reconstruction vs the DolphinPPCTests oracle bit-for-bit),
  plus `lazycr_cross_block_beq` (block A defers CR0, separate block B reads it — the
  no-liveness/no-guard cross-block proof) and `lazycr_so_freeze` (frozen XER.SO).
- Measured with ON: consistent ~4% SAB regression, MP4 parity. CAUSE: every
  conditional branch takes the runtime materialize path (pending-check + tag-switch)
  instead of the old 3-op eager read; consumer tax > producer savings on
  branch-heavy code.

### Files already carrying the (gated-off) lazy-CR foundation
- `cr_shadow.h` — struct `BemCrShadow{a,b,tag,so,pad0,pad1}` (12B), `BemCrTag` enum
  (CMP_REG=0, CMP_IMM=1, RC_VS0=2, KIND_MASK=3, UNSIGNED=4), extern arrays
  `g_bem_cr_shadow[8]` / `g_bem_cr_pending[8]`, the `BEM_LAZY_CR` gate.
- `cr_encode.cpp` — array DEFINITIONS; `emit_defer_cr` / `emit_defer_cr_reg` /
  `emit_defer_cr_imm` (deferred store ~11 ops); `emit_clear_cr_pending`;
  `bem_materialize_pending_cr(void* ctx_base)` — THE single reconstruction source
  (bridge + tests both call it); `emit_cr0_from_local` gated (defer vs eager).
- `cr_encode.h` — decls for `emit_defer_cr_reg/_imm`.
- `jit_compare.cpp` — the 4 cmp emitters gated (defer vs eager).
- `jit_branch.cpp` — `emit_crbit_test_eager` (the old switch, factored out),
  `emit_materialize_crbit` (runtime tag dispatch), `emit_crbit_test` gated (eager
  when !BEM_LAZY_CR; pending-check+materialize when ON).
- `dolphin-bridge/dolphin_jit_wimports.cpp` — extern decl of
  `bem_materialize_pending_cr`; call before `SingleStepInner()` in `dolphin_interp`.
- `tests/test_gekko_next.cpp` — `lazycr_cross_block_beq`, `lazycr_so_freeze`.
- `tests/test_diff_next.cpp` — `bem_materialize_pending_cr` extern + call before
  `dolphin_to_mfcr` (the raw-cr-read = a materialization boundary, like savestate).

## PHASE A — adjacent cmp→branch fusion [DONE PM57 → measured WASH, reverted; see Status block above]

Goal: remove the per-branch consumer tax on the HOT path. When a conditional branch
consumes the immediately-preceding cmp's CR field, emit a DIRECT compare of the
cmp's operand locals — no pending-check, no shadow round-trip. Sound because the
shadow+pending still backs the (rare) cross-block readers. This is
QEMU-cc_op-for-soundness + peephole-for-speed.

Predicate table (from wf_1e20dc39, verified): tested bit `bi%4`, pre-polarity push
(stack=1 iff CR bit SET), then the existing `if(!branch_if_true) op_i32_eqz()`:
- LT(0): cmp/cmpi → `a lt_s b/imm`; cmpl/cmpli → `a lt_u b/imm`
- GT(1): signed → `a gt_s b`; unsigned → `a gt_u b`
- EQ(2): `a eq b` (both forms)
- SO(3): NO FUSE (fall to pending/eager path — SO comes from XER, not operands)

### A1. CmpFuse stash (loop-scoped, modeled on EaCache)
- In `ppc_emit.cpp` `emit_block_body_into`, beside `EaCache ea_cache;` (~:1128), add
  `CmpFuse cmp_fuse;`. Define `struct CmpFuse { bool valid; u32 crfd; u32 a_local;
  s32 imm; u32 b_local; bool is_imm; bool is_signed; u8 tested_bit; };` in a shared
  header (`jit_compare.h` or `cr_shadow.h`).
- Thread `CmpFuse*` to the cmp emitters and to `emit_bcx`. Cmp emitters currently
  take `ctx_ptr` not `params`; add a `CmpFuse* fuse = nullptr` trailing param to the
  4 cmp emitters + their dispatch_op call sites (ppc_emit.cpp ~:455-456,:549-550),
  OR reuse the `LoadStoreParams` path — but cmp uses ctx_ptr, so a dedicated param
  is cleaner. `emit_bcx` gets a trailing `const CmpFuse* fuse = nullptr`.

### A2. Producer sets the stash (when BEM_LAZY_CR ON)
- In each cmp emitter, when it defers, ALSO populate `*fuse` with
  {valid=true, crfd, a_local, imm-or-b_local, is_imm, is_signed=(!unsigned form),
  tested_bit unused-here}. (The cmp still stores the shadow — for cross-block.)

### A3. Consumer uses the stash (emit_bcx CR-bit arm, jit_branch.cpp ~:230-233)
- Replace the `emit_crbit_test(wb, ctx_ptr, bi)` call with:
  `if (fuse && fuse->valid && fuse->crfd == bi/4u && bi%4u != 3u) { <direct compare
  per the table above> } else { emit_crbit_test(wb, ctx_ptr, bi); }`
- The trailing `if(!branch_if_true) op_i32_eqz()` stays unchanged.
- Do NOT clear pending after the fused branch — pending stays set so a later
  cross-block reader still materializes correctly (the fused branch and the shadow
  agree by construction).

### A4. Invalidation (dispatch loop, ppc_emit.cpp, clone the ea_cache pattern ~:1406)
- After each op, clear `cmp_fuse.valid` UNLESS this op is the cmp that just set it.
  Concretely: the stash is only valid for the immediately-following op. Any op
  between the cmp and the branch (that writes the operand regs OR the CR field OR is
  itself non-adjacent) invalidates. Simplest sound rule: set valid in the cmp
  emitter; in the dispatch loop, AFTER emitting each op, if the op was NOT a
  fusable cmp, and it's not the branch consuming it, clear valid. Because cmp and
  branch are adjacent in the hot idiom, "valid only survives to the very next op"
  is the safe invariant — clear valid at the top of the next iteration unless the
  next op is the consuming branch. (Mirror ea_cache: keep only across the exact
  adjacency, else invalidate.)

### A5. Gate + measure
- Flip `BEM_LAZY_CR = true` (cr_shadow.h) TOGETHER with A1-A4.
- New tests: `fused_cmp_branch_direct` — a block {cmp; bcx} for each (cmp form ×
  tested bit LT/GT/EQ × polarity × operand relationship incl. sign-boundary
  0x7FFFFFFF/0x80000000, 0xFFFFFFFF vs 0) asserting next_pc == the ISA-correct
  branch decision. The differential test_diff_next already covers cmp+CR; the new
  test proves the ADJACENT fused path specifically.
- GATES: test_diff_next 3457/0 + test_gekko_next (incl. the new + the 3 lazy-CR
  tests) all green.
- A/B (page metric, default tiering, 2 runs each): SAB presentN-delta/snap and MP4
  gc vs the pre-lazy band (SAB ~316-327, MP4 gc ~6600-6860).
- SHIP CRITERION: SAB present rate must beat ~327 (top of the band) by a clear
  margin, MP4 parity-or-better, both games render, zero regressions. If it does not
  clearly win, keep BEM_LAZY_CR=false and record — the architecture is sound but
  not worth the complexity on this workload (an honest, valuable negative).

## PHASE B — region-tier CR-liveness elision (the OTHER sound layer)

The region tier (N-fn gens) compiles many blocks as one unit, so cross-block CR
liveness becomes intra-region dataflow — provable. In a region, ELIDE the CR
entirely (neither eager nor deferred) where the field is region-dead. This is the
HHVM/LuaJIT region approach and it's independent of Phase A (composes with it).
- Site: `block_cache.cpp` `region_seal` re-emit loop — the region has
  `rs.block_records` (member insts) + `rs.pc_to_idx` (CFG). Compute per-member CR
  live-out over the region CFG (backward dataflow; a cmp whose CR field is not live
  at any region-internal successor AND not in any region live-out edge → elide).
- Conservative at region-exit edges (out-of-region successor → treat CR as live →
  build/defer). Same gating discipline; the differential + a region-CR test arbitrate.
- Lower priority than A (A hits per-block AND region bodies; B only regions), but it
  is the pure elision (0 ops for region-dead CR).

## PHASE C — preload / AOT warmup (kills the first-minute storm; user's "preload+chunk")

Research (wf_35a63c0e / wf_007b7f74): V8 caches TurboFan-compiled wasm modules but
only via specific instantiation paths; module BYTES persist via IndexedDB/structured
clone, compiled code attaches only under same-URL conditions. So preloading moves
region FORMATION + compile off the hot path (real warmup win) but doesn't skip V8
compile.
- C1. AOT region set: chunk the known-hot functions from the symbol map (MP4
  `~/gc_refs/marioparty4/config/GMPE01_01/symbols.txt`; SAB `tools/gsne8p.map`) or a
  captured profile; pre-seal those regions at load BEFORE gameplay so gen modules
  are live from frame 1. Reuses the (fixed, PM54c) region seal pipeline.
- C2. Cluster-pooled promotion (tiering research): pool lukewarm CFG-clusters so
  SAB's individually-cold scheduler blocks cross the promotion threshold together
  (v86's per-page pooling). Site: the drain histogram in `block_cache.cpp`
  chain_dispatch (~:1230-1280).
- C3. Module persistence: store sealed gen module bytes in IndexedDB keyed by
  (game-id, gen-pc-set hash); on next session, instantiate from bytes (skips
  formation+analysis+re-emit, V8 still Liftoff-compiles). Measure whether V8's code
  cache attaches compiled code for the instantiate-from-bytes path.

## PHASE D — remaining research-ranked levers
- Branch hints (`metadata.code.branch_hint`, Chrome M136+ on-by-default): annotate
  the ~90-op scaffolding biased branches (downcount, slowmem/MMIO arms, MSR/FPRF
  bails). CheerpX measured 7-10%. Site: WasmModuleBuilder — add a branch-hint
  section + emit hints at the biased `op_if` sites.
- get_now bridge batching (2.5%, PM51) + block-cache warmup (task #4).
- Stage-B DSI self-exit (task #13) — needs a matched host DSI-raise; native-exact
  form of the load-path exit.
- Fusion track (task #10 N-fn, #11 v3): region-liveness-gated cmp/branch merge; the
  N-fn direct-call payload is landed, run-fusion v2/v3 landed.

## Measurement protocol (binding)
1. Canonical 3-step GameCube loop (NO wrapper): build `build-wasm-4010` (emsdk
   `~/emsdk-upstream`), link `dolphin_worker_link_4010.sh` (from REPO ROOT — cwd
   trap: link path is relative), probe `dolphin_render_probe.js`.
2. Page metric = default tiering: `PROBE_JS_FLAGS=" "`. The `[fps]` drain-window
   lines are unreliable (recurring quirk) — use presentN deltas across phase-snaps
   (`grep '"presentN":[0-9]*' | tail -6`, take consecutive diffs) as the robust
   page-fps proxy. gc-rate/native (`symbolize_compare.py`) + `--no-liftoff` is
   RESEARCH ONLY, never distance-to-60.
3. Correctness gate every change: `node gamecube/tools/conformance/run.mjs
   test_diff_next` (3457/0) + `test_gekko_next` (the bench+dump run is slow ~15min;
   the log persists to /tmp/conformance/test_gekko_next.log). V8 trace flags need
   `PROBE_DUMPIO=1` (trace goes to Chrome stdout, not the page console).
4. Two runs per A/B to bound the ±warm-machine variance (bench ±9%, presentN band
   ~316-327 on SAB). Deltas inside the band are NOT attributable.

## Current shipping baseline (do not regress)
BEM_LAZY_CR=false. SAB ~322/snap, MP4 gc ~6700, PSO ~19-20, all render, conf
3457/0 + 79/0. Everything above is ADDITIVE and gated; ship only on a clear
measured page-metric win.

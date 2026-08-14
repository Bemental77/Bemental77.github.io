# Quick-stack lever PREDICTION TABLE (Step 0, static, zero builds) — 2026-08-13

Predict-then-land (worker order 13g). Predicted board frames-delta computed from
board_coverage.json (samples/shares), RESEARCH.md measured thread decomposition
(guest-body 55.8% / chain-dispatch 25.4% / cross-module edge sequence 12.9%, board ~26fps
JIT-bound ~95% busy), the op model (5-instr block ≈124 ops; prologue ~20; edge predicate ~30),
PM51 (4.8M edges/s @ 99.66%). Every gate line reads predicted-vs-measured; a >2× miss = a
MODEL bug to fix, not more probes.

| Lever | Predicted board Δ | Measured (cooled) | Conf | Status |
|---|---|---|---|---|
| **Diag strip** (11 RMWs) | **+3.0..8.5%** (+3.2% floor) | _(pending cooled rig)_ | MED | LANDED 27bf73d — correctness certified, magnitude deferred |
| **Edge-diet** (predicate→downcount-only) | **+5.0..6.8%** | _(pending cooled rig)_ | MED | LANDED 7f08e00 — correctness certified (mechanism verified from code + live), magnitude deferred |
| **Bundle** (strip+edge-diet, live worker) | **+8..15%** | _(pending cooled rig)_ | — | the resolvable combined signal — confirm this on cooled Chrome page-fps |
| **Promote-ring retire** | **+0.09..0.65%** (~+0.1 fps) | — DROPPED — | LOW | **near-worthless** (below); dropped before any build |
| **SAB pump de-quant** (parallel, SAB not board) | **5.7 → 7.7..11.2 fps (+2..6)** | _(SAB, later)_ | MED | remove 16ms yield quantum; queued |

## Standing thermal protocol (order 13i — thermal has bitten twice: N-fn false −21%, tonight's blocked strip gate)
- **Magnitude gates: cooled-rig ONLY.** A saturated machine's frames metric drifts (tonight: 839→575, ~31% over 8 runs) and swamps small-lever signals below a ±~14% noise floor.
- **Thermal sentinel brackets every magnitude gate:** a fixed reference workload run before AND after; **>5% drift between them VOIDS the gate** (a named reason, not a result).
- **Correctness gates run any time** — thermal-independent (traps/renders/guest-advance are binary), as tonight proved.
- **Magnitude confirmation for these two levers:** cooled real-Chrome page-fps of the live bundle worker vs the pre-strip baseline → expect +8..15%. Whichever lands first (that read or a cooled sentinel-bracketed probe re-gate) stamps the Measured column. >2× miss from the summed prediction = fix-the-model.

## The inversion — promote-ring is NOT the highest-value lever; it's the lowest

The scoping sized it "15-40% of 3-9-instr block ops" — but that is **per-UNPROMOTED-block**,
and the board's execution is dominated by **PROMOTED** blocks, which **already skip the prologue**
(PM55, region_gen>=0). Board coverage: top-2048 blocks = 97.9% of samples, and the gen cap holds
~6144 blocks — so ~98% of executed samples are in promoted blocks that never emit the prologue.
Only the ~2% unpromoted tail pays it → retiring it saves ~2% × 16% ≈ 0.3% of thread ≈ **+0.09 fps**.
The 15-40% was real but applied to the wrong population. **Drop it** (not worth the build +
the g_bem_sealed_pcs_bitmap complexity + any correctness risk).

## Prediction-driven ladder (reordered from 13f)

1. **Diag strip FIRST** — safest (pure telemetry removal, no control-flow deps) AND a
   high-confidence **+3.2% floor** (the per-slice RMW) with +8.5% upside. Land the guaranteed win.
2. **Edge-diet SECOND** — biggest (+5..6.8%) but carries the three correctness preconditions
   (ForceExceptionCheck(0), post-rfi CHECK_EXC, cpu_owner==1 poll) — build with the envelope
   verified from code first.
3. ~~Promote-ring~~ — **dropped** on the prediction (+0.09 fps).
4. **SAB pump** — parallel lane (SAB, disjoint files), +2..6 fps for that title.

Board quick-stack (diag + edge) ≈ **+8..15% → 26 → ~28-30fps**, before §6.4/§6.2 multipliers.
Every build below is now a prediction-confirmation gate (matched pairs, interleaved A/B), not
an exploration.

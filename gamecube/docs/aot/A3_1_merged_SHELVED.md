# A3.1 whole-function merged AOT — SHELVED (the clean §4 experiment result)

**Date:** 2026-08-13. **Verdict:** the pre-registered kill criterion (worker order 2026-08-13c
Item 3 / THE-60FPS-COMPLETION-PLAN Phase 0.1) FIRED. A3.1 whole-function merged `$region` AOT is
shelved; the campaign pivots to §6.4 (N-fn + PM54d direct-edge) + §6.2 (FP-fusion).

## The question (RESEARCH.md §4/§7.6)

The whole-function merged `$region` shape (one wasm function per gen: 8-group locals + activation
pad + `loop $L` + `br_table(entry_sel)` into N spliced block bodies, intra-region edges = warm
`br $L` with GPRs live) had never been measured against per-block JIT with its FOUR named
artifacts removed. This week removed all four:

1. **Wild addresses** — v4 reloc-seal (4076fe9): offline assets emit OOB sentinels + a reloc
   table the seal patches; zero native-tool-pointer bakes.
2. **Dead warm-edge seeding** — the seal now seeds mrtag/mrslot (part of the v4 work), so AOT
   warm edges can hit for the first time. (Also gated behind the $-index trap fix, 72bb593, and
   the re-seal fix, 37ce4f1 — without those the merged gen never dispatched or died at load.)
3. **Dispatch-precedence** — e716794 re-assert + guard.
4. **Branch exits (this order, 13d)** — jit_branch.cpp `emit_coalesced_taken_exit` op_returned
   every mid-block coalesced taken branch to the C loop instead of chaining. HandleReverb is
   branchy scalar-FP DSP; the CFG-walk fix made every taken target a sealed block, so each taken
   branch = C-loop round-trip → fn_k re-entry → full 32-GPR activation pad. Census confirmed it:
   `taken = 43.7M ≈ DISPATCHES`, `service_bail = 1118` (not the alternative). Fix: route the
   merged taken arm through `emit_chain_or_return`'s warm cascade (`entry_sel=k; br $L`).

## The measurement (matched pairs, frames metric, standing measurement law)

Board savestate, 3+3 matched runs, rate-independent GlobalCounter frames/30s, AOT-off = asset
absent (deterministic, merged_n=0), traps=0, two-launch byte-identical asset.

Post-artifact-#4-fix census (board): `taken 43,669,822 → 0`, `warm_br 3.35M → 47.6M`,
`DISPATCHES (C-loop round-trips) 43.67M → 224K` (~195× collapse). The gen tail-chains in-wasm
exactly like per-block. **Round-trips collapsed >90% ✓.**

Frames gate, same build:

| config | frames / 30s | HandleReverb share |
|---|---|---|
| AOT-off (per-block) | **851 ± 20** (~28 fps) | 6.03% |
| AOT-on (merged, all 4 artifacts removed) | **710 ± 30** (~24 fps) | 11.92% |

**Frames still lose (710 < 851, non-overlapping) → KILL CRITERION FIRES.**

## Conclusion — the merged shape loses for STRUCTURAL reasons

With every named artifact removed and in-wasm chaining proven (47.6M warm laps, 224K host
round-trips), the merged `$region` is still ~17% slower than per-block. The residual is
structural, beyond the four artifacts:
- `br_table(entry_sel)` dispatch cost per warm lap (47.6M laps);
- lap-counter + `entry_sel` global read/write traffic per edge;
- register-allocation pressure from the fixed 152-local + 32-GPR activation pad in one giant
  function (664KB module) — V8 regalloc + tier-up degrade vs small per-block modules;
- big-function tier-up / inlining-budget effects.

This is a REAL research deliverable: the §4 hypothesis (merged wins with artifacts removed) is
REFUTED on the board scene. The dispatcher-hub merged shape is not the 60fps vehicle.

## Pivot (per the completion plan)

- **Vehicle: §6.4** — N-fn sealed gens + PM54d intra-gen direct `return_call` edges (keeps V8
  per-function optimization + selective inlining; no br_table hub, no 152-local monolith).
- **Levers are substrate-portable:** function-scope register residency (the make-or-break
  1.5-2.5× lever), FP/paired-single fusion (§6.2), wasm-opt, coverage — all re-target onto N-fn.
- **Carry-forward from this experiment:**
  - The merged-aware branch-exit fix (jit_branch.cpp/h, ppc_emit.cpp) is committed as the
    FOUNDATION — but it is gated on `merged != nullptr`, so **N-fn (merged=nullptr) still has
    artifact #4 at its mid-block taken exits.** §6.4 must GENERALIZE the fix to route N-fn taken
    exits through emit_chain_or_return's internal-table dispatch (region_gen>=0 path).
  - The exit-reason census (g_bem_aot_count_exits, flag-gated) is a reusable diagnostic for
    analyzing N-fn exit behavior in §6.4.
- A3.2 call-bearing design builds on the N-fn substrate, not the shelved merged one.

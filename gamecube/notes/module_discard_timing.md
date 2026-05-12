# Module-discard timing (V8 tier-up grace)

Item 2 of 7. Verified + fix for `bementalJIT/src/block_cache.cpp:802` (the
`prev.instance = null` line that drops the previous region instance).

## Actual bottleneck

The `prev.instance = null` itself is correct — V8 type feedback is per
instance, so "keeping the old instance alive" does NOT transfer feedback
to the new module. The real issue is one level up: **relink cadence
discards the fresh module before V8's background TurboFan tier-up has
finished**, capping sustained throughput at Liftoff baseline.

Per `lever_3_tierup_blocked_2026_05_05.md`, eager tier-up (`--no-wasm-
dynamic-tiering`) verified TurboFan compile jobs run, but per-block tiny
modules amortize them poorly. The merged-region path produces real
multi-fn modules where tier-up pays off — but only if those modules
stay live long enough for the bg tier-up window to close.

## What changed (already shipped in this worktree)

`bementalJIT/include/bementalJIT/block_cache.h`
- `RegionState` gains `last_relink_ms` + `dispatches_since_relink`.

`bementalJIT/src/block_cache.cpp`
- `region_should_relink` — once a region is past warmup (`n_funcs >= 256`),
  defer relink when `since_relink < grace_ms` AND
  `dispatches_since_relink < min_dispatches`. Quiesce trigger (idle >2s)
  bypasses the gate so stranded pending blocks still materialize.
- `region_relink` — stamps `last_relink_ms` + resets
  `dispatches_since_relink` on successful new_handle.
- `region_dispatch` — bumps `dispatches_since_relink` per call.
- `region_drop` — clears both new fields.

## Tunables

| Env var | Default | Meaning |
|---|---|---|
| `BJIT_TIERUP_GRACE_MS` | 250.0 | Wall-clock ms after relink before relink may fire again |
| `BJIT_TIERUP_MIN_DISPATCHES` | 5000 | Min calls into region_dispatch since relink |

Default `250 ms` chosen as 1.5x–2x the observed bg compile window for
merged modules with ~480 fns (~145 ms per `lever_3_tierup_blocked_2026_05_05`).
Default `5000 dispatches` chosen so type feedback has ≥10 samples on
each of the 480 fns, well above V8's monomorphic-IC threshold.

## Measurement plan

Use `gamecube/tools/run_perf_t1.mjs` (already gated by `T1_JS_FLAGS`).

1. **Baseline (gate off)**:
   `BJIT_TIERUP_GRACE_MS=0 BJIT_TIERUP_MIN_DISPATCHES=0 bash build_and_probe.sh`
   — relink fires on every threshold hit (current behavior modulo no-op gate).

2. **Gate on (defaults)**:
   `bash build_and_probe.sh`
   — observes lockout: regions past warmup pause relink in grace window.

3. **Sweep grace ms**: `BJIT_TIERUP_GRACE_MS=100,250,500,1000` —
   throughput vs grace. Look for knee where throughput stops climbing
   (= V8 tier-up window upper bound for this workload).

4. **Combined with lever #3**: `T1_JS_FLAGS="--no-wasm-dynamic-tiering"`
   on top of (2). With the gate keeping merged modules alive, eager
   tier-up should now win (vs the regression measured pre-gate).

### Success metrics

- `compile_calls` per wall-second (lower = fewer wasted relinks)
- `region_generation` ramp slope (flatter = fewer module-discards)
- `_ppc_worker_*` dispatch throughput (higher)
- V8 `wasm.TopTierCompilation` trace events vs module count
  (closer ratio = better amortization)

## Where the next blocker is

If measurement (3) shows no throughput knee, the bottleneck is
elsewhere — likely the env.ppc_* mailbox round-trips (already documented
in `levers_post_skip_real_measurement_2026_05_06.md`) which dominate
per-dispatch cost regardless of module lifetime. In that case Item 3
(fastmem expansion to all guest reads/writes in the emitter) and
Item 4 (mailbox-elimination via per-region MMIO inline stubs) take
priority over further relink-cadence tuning.

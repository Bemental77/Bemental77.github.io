# Lever-13 — where the worker's time ACTUALLY goes, and the sched-timer retirement

## Why this card exists

The standing model going into this session was the corrected lever-12 split:

```
jit (residual)  374.3 ms/s  74.71%
rnd             87.7        17.50%
sch             34.2         6.82%
pvr / sq         4.9         0.98%   <- retired 2026-08-29
```

and the conclusion drawn from it was "THE JIT OWNS ~75%". Two levers were then
aimed at the emitted SH4 code on that basis and both missed: LEVER-12 trace
formation is a wall-time NULL despite halving hot-path instructions per
iteration and collapsing dispatcher returns 161 -> 7, and a prior SH4 codegen
audit put per-instruction emission at the stack-machine floor.

**`jit` is a RESIDUAL. It was never a measurement of the emitter, and reading it
as one is wrong by a factor of ~1.8.** This card replaces it with a direct
measurement.

## The measurement

CDP CPU profile of the emulation worker (`Profiler.start` on the
`flycast_worker.js` target), 25.07 s of samples, PSO gameplay restored from
`/tmp/dcx-state-user2.bin`. Artifact `/tmp/dcx-worker.cpuprofile`.

The canonical loop could not reach the probe's `--profat` flag, so every prior
attribution run was an improvised `node flycast_probe.js`. `build_and_probe.sh`
now passes `--profat` / `--profdur` through — same gap, and same fix, as
`--loadstate` and `--ctxms` before it.

**CAVEAT, stated up front: that profile ran at machine load ~45 with a 0.859x
guest ratio.** The SHARES below are the durable part; its wall numbers are void.
And per gate #10 a profile is for attribution only — no win was sized from it.

### Self time by module

| bucket | % of worker | % of BUSY (idle excluded) |
|---|---|---|
| emitted SH4 (JIT shard modules) | 43.97% | **47.5%** |
| static C++ core (`flycast_worker_emcc.wasm`) | 37.56% | 40.6% |
| idle | 7.40% | — |
| JS | 6.38% | 6.9% |

### Self time by what the code is doing

| bucket | % of worker | % of BUSY |
|---|---|---|
| emitted SH4 shard functions | 43.97 | 47.5 |
| dispatch + `jit_lookup` + boundary thunks | 11.10 | 12.0 |
| guest-memory slowpath (`sh4_mem_write32`, `addrspace::writet`, SQ) | 9.22 | 10.0 |
| AICA + ARM7 audio | 7.81 | 8.4 |
| render + GL | 6.22 | 6.7 |
| **clock reads (`emscripten_get_now`)** | **4.67** | **5.0** |
| interpreter fallback (`sh4_interp_shil_fb`) | 1.84 | 2.0 |
| `sh4_sched` | 1.43 | 1.5 |
| TA parse | 1.35 | 1.5 |
| compile / emit | 1.33 | 1.4 |
| unclassified (each < 0.4%) | 3.65 | 3.9 |

**The emitted SH4 code is under half of busy time, not three-quarters.** That is
why two independent attacks on emitted-code quality returned nulls, and it is
the single most useful number on this page: an emitter lever with a perfect 20%
improvement moves the whole worker by 9.5%, not 15%.

Corroboration from the other direction: the GameCube side reached the same
verdict independently on the same day (per-instruction codegen at the floor;
deleting ALL rendering buys 2%).

## THE FINDING — a clock read in the dispatch loop, 3.91% of the worker

The single largest named entry after the emitter and the dispatcher was

```
3.91%  _emscripten_get_now <- wasm-to-js <- WasmDynarec::dispatch_slice <- dynCall_vi
```

`LEVER12_HOT_TIMERS` had already retired the `pvr` and `sq` clock reads that
morning. `dispatch_slice`'s only remaining `emscripten_get_now()` callers in a
RELEASE build are:

1. the frame watchdog at `(s_dispatch_count & 0x3FFFF) == 0` — fires 2-4x/s,
   cannot be it;
2. **the `sch` bucket's timer pair around `sh4_sched_tick`** — two calls per
   tick, and the `[split]` line reads n = 10,689 ticks/s, so **21,378 calls/s**.

The lever-12 audit KEPT `sch` on the grounds that its per-event reading
(2645 ns) sits 6.0x above the `emscripten_get_now()` quantum, i.e. that the
bucket RESOLVES. It does. **That was the wrong question — a bucket can resolve
and still cost more than it is worth.** Against the LEVER-12 pair's own measured
~738 ns per `get_now()` call at load 23-41, 21,378 calls/s is 15.8 ms/s of pure
observer; against the bucket's own reading (32.8 ms/s over 10,689 ticks =
3.07 us/tick), the instrument is ~48% of what it reports.

### Why not sampled instead of retired

Timing 1 tick in N would cost ~0 and still give a mean. Not taken: sched ticks
are driven by `SH4_TIMESLICE` and the devices on the list have their own fixed
periods (AICA every `AICA_TICK` = 4535 cycles, SPG per line, VBlank per field),
so a power-of-two stride can alias onto one device's period and sample a biased
subset. A sampled `sch` would be cheap and WRONG, which is worse than absent.

## VERDICT: GATED — two independent matched pairs, 8/8 pairwise same sign

Both arms built from the SAME source generation, differing only in
`#define LEVER13_SCHED_TIMER`. Pre-built byte-identical snapshots swapped per
arm, `md5` hash-guarded PRE and POST of every arm (all four PRE == POST).
Samples keyed to the `[vbl]` guest-cycle counter and restricted to the span
common to all arms — never to a wall window. Settled gated on the GUEST RATIO
(0.99 <= g <= 1.01), never on throughput.

**Pair 1** — heavy scene (`/tmp/dcx-state-user2.bin`), order B/S/S/B, load 25 -> 48,
common span 316.594e9 .. 322.519e9 guest cycles:

| arm | timer | ml_p50 (ms/s) | rnd_p50 | guest_p50 |
|---|---|---|---|---|
| B1 | ON  | 557.6 | 61.0 | 1.00043 |
| S1 | OFF | 487.9 | 58.8 | 0.99896 |
| S2 | OFF | 504.3 | 60.1 | 1.00030 |
| B2 | ON  | 541.4 | 59.2 | 0.99974 |

B mean 549.5, S mean 496.1 → **-9.7% mainloop**. Sentinel B1 vs B2 = -2.9%.

**Pair 2** — the SHIPPED autoload scene (repo `state.bin`, guest cycle
25.0e9..32.6e9 — the same anchor region as the committed 3.23x figure),
**order REVERSED to S/B/B/S** so the load ramp biases the opposite way,
load 38 -> 81:

| arm | timer | ml_p50 (ms/s) | duty | headroom | rnd_p50 | guest_p50 |
|---|---|---|---|---|---|---|
| rS1 | OFF | 301.0 | 30.1% | 3.32x | 19.4 | 0.99975 |
| rB1 | ON  | 325.1 | 32.5% | 3.08x | 18.8 | 1.00003 |
| rB2 | ON  | 329.0 | 32.9% | 3.04x | 19.6 | 1.00017 |
| rS2 | OFF | 315.0 | 31.5% | 3.17x | 19.8 | 0.99977 |

B mean 327.1, S mean 308.0 → **-5.8% mainloop**, headroom **3.06x -> 3.25x
(x1.062)**. Sentinel rB1 vs rB2 = +1.2%.

- **Every B arm reads higher than every S arm in both pairs — 8/8 pairwise
  comparisons, under two opposite arm orderings.** Between-arm separation
  exceeds the within-arm spread in both (pair 2: 5.8% vs 1.2% sentinel).
- **CONTROL CLEAN**: `rnd` is real render work, timed identically in both arms
  with only ~30 clock reads/s. 61.0/58.8/60.1/59.2 and 19.4/18.8/19.6/19.8 —
  unchanged, so the machine was not faster during the S arms.
- **GUEST EXACTNESS HELD**: every arm 0.99975 .. 1.00043 with the settled
  window reading `COUNTED vs COMPUTED +-0.0000%`.
- Quote the CONSERVATIVE pair-2 figure, because it is the scene the standing
  3.23x claim was measured on. The committed 3.23x baseline scales by x1.062 to
  **~3.43x**. Gap to 4.0x (= 120 producible on a 30 fps title) narrows from
  +24% to **+17%**.

**THIS IS HEADROOM, NOT SPEED.** Presents are 30/s in all eight arms — PSO is a
30 fps title and the guest is governed to 1.000x. Say "30 presented, 3.4x
headroom".

Boot-verify of the final binary (`/tmp/probe-dcx-l13-verify.log`): guest ratio
**0.99995x**, `COUNTED vs COMPUTED -0.0000%`, 517 presents, **0 dupes**, 0
watchdog fires, 0 aborts, and the t=45 s canvas shot is a render-perfect PSO
character-select screen.

**Binary reproduction, against the "committed the wrong binary" trap**: after
restoring the source to `LEVER13_SCHED_TIMER 0`, a clean relink produced
`md5 31f2a9faa98cb87aa63db001c5fc9407` — byte-identical to the `armS` snapshot
the S arms actually ran. Source and shipped artifact are the same object.

### Why the measured -5.8..-9.7% exceeds the profile's 5.0%-of-busy share

Not resolved, and not claimed as resolved. The likeliest cause is that a
sampling profiler under-attributes a wasm->JS boundary crossing, charging the
transition to the calling wasm frame rather than to the JS callee; the profile
also ran at load ~45 with a 0.859x guest ratio, a different mix from the pairs.
The matched pairs are the measurement; the profile share is the pointer that
found it.

## ALSO IN THIS CARD — the SMC counter ledger is closed

Standing open item: a 75 s count campaign over shipping-binary gameplay read
`smcS=smcB=smcR=smcT=0` across all 59 samples with `cpg=10552`, **but `icgen`
still advanced 2 -> 5**, so some bump path was unattributed and "no SMC
occurred" was NOT provable from those counters.

A source audit of every site that mutates `g_ic_generation` found **five**
further paths, none of which touched a counter:

| ledger | path | class |
|---|---|---|
| [4] `smcI` | `flycast_ic_invalidate()` — savestate load | administrative |
| [5] `smcC` | `jit_clear()` — block-cache flush | administrative |
| [6] `smcX` | flycast block-manager `reset()` | administrative |
| [7] `smcP` | `g_ic_flush_mask` periodic — inert at the shipped default 0 | administrative |
| (E) `smcE` | **the EMITTED in-wasm store mark** — `wasm_emit.cpp` `emitSmcMarkLocal():87` / `emitSmcMarkConstPage():135` do `g_ic_generation += g_code_map[chunk]` branchlessly on the hot guest-store path | **guest SMC** |

[4]-[7] are now counted directly. (E) is **derived, exactly and for free**:
`g_smc_gen_accounted` accumulates the generation units added by every C-side
path and is rezeroed at each arm, so while armed

```
smcE = (g_ic_generation - 1) - g_smc_gen_accounted
```

is the generation units contributed by emitted stores. Counting (E) inline was
rejected: it taxes EVERY area-3 guest store, which is the exact trade LEVER-12
and LEVER-13 just retired twice. `smcE` is a count of UNITS, not events (an
8-byte `fmov.d` pair marks two chunks and can add 2 in one store), so it bounds
events from ABOVE — the correct direction for a safety claim.

**IDENTITY, checkable in any log:**
`d(icgen) == d(smcS+smcB+smcR+smcT+smcI+smcC+smcX+smcP+smcE)` exactly, by
construction. "No SMC occurred over this window" is now exactly `d(icgen) == 0`.

### The answer, on the same run that raised the question (`cpg=10552`)

```
icgen=2 ... smcT=0 smcI=0 smcC=0 smcX=1 smcP=0 smcAcc=1 smcE=0
icgen=5 ... smcT=0 smcI=1 smcC=0 smcX=3 smcP=0 smcAcc=4 smcE=0   (flat to end of run)
```

5 = 1 (the arm) + 4 accounted + 0 emitted. **The unattributed "2 -> 5" was three
flycast block-manager `reset()` calls plus the one savestate
`flycast_ic_invalidate()` — all administrative. `smcE = 0`: the emitted in-wasm
store mark contributed ZERO generation units over the entire run. No guest
self-modifying code occurred.**

That is now a proof rather than an absence of evidence, and it is the evidence
the unguarded intra-shard tail-link needs. It does NOT by itself certify leaving
the tail-link unguarded — one game, one scene, and `FLYCAST_TRACE_SMCGUARD`
(`wasm_emit.cpp:431`) remains the built-and-tested upgrade path. It removes the
specific objection that the counters could not see the emitted writer.

## Files touched

| file | change |
|---|---|
| `dreamcast/flycast-bridge/rec_wasm.cpp` | `LEVER13_SCHED_TIMER` (default 0) + `g_attr_sched_timed`; ledger counters [4]-[7]; `g_smc_gen_accounted` + rebase at arm; ctxsnap cases 103-108 |
| `dreamcast/flycast-bridge/EmscriptenWorker.cpp` | `[split]` prints `sch=-` when untimed, branching on the timer TU's own flag; split notes (f)/(g) carry the profile map |
| `dreamcast/flycast_libretro/flycast_worker.js` | `[smc]` line prints `smcI/smcC/smcX/smcP/smcAcc/smcE` + the identity |
| `dreamcast/build_and_probe.sh` | `--profat` / `--profdur` passthrough |
| `dreamcast/flycast_libretro/flycast_worker_emcc.{js,wasm,js.symbols}` | rebuilt |

## WHAT THIS CARD SAYS TO DO NEXT — sized, in order

The remaining gap to 4.0x is +17%. Against the corrected map (% of BUSY):

1. **`dispatch + jit_lookup` = 12.0%.** `jit_lookup` alone is 3.40% of the
   worker, and **2.203pp of that is called straight from `dispatch_slice`, not
   from `sh4_jit_lookup_idx`** — i.e. it is the trampoline re-resolving
   `ctx->pc` on every dispatcher round-trip, not the chain probe. The ctxsnap
   `rt` counter reads ~142,220 round-trips/s at steady state while `cmiss` is
   FLAT (52,065 -> 54,288 over 10 s, chain hit rate ~99.99%). A round-trip that
   returns to a block the dispatcher just came from is re-hashing and
   re-verifying a target the chain already knows. This is the largest named
   non-emitter bucket and it has not been attacked.
2. **guest-memory slowpath = 10.0%**, of which the Holly/PVR register window is
   108,814 stores/s (`[split] pvr n=`, identical across arms and windows —
   deterministic). `sh4_mem_write32` masks and range-compares, then `WriteMem32`
   -> `addrspace::writet` decodes the area AGAIN and dispatches through a
   function-pointer table. That is a double decode on a path taken ~110K/s.
3. **AICA + ARM7 = 8.4%.** `AicaUpdate` is 3.645pp of the worker called from
   `sh4_sched_tick`. Accuracy-critical — do not trim channels or DSP.
4. **render + GL 6.7% + TA parse 1.5%.** Note `rnd` in the shipped scene is
   ~19 ms/s (5-8% of `ml`), NOT the 17.5% the pooled lever-12 window reported;
   that pooled figure came from a heavier scene. R stays well under the 0.36
   async-render trigger.
5. **The emitter's 47.5%** is the biggest single bucket and the hardest. Both
   LEVER-12 (bigger blocks) and the codegen audit (fewer instructions per block)
   have returned nulls against it. Do NOT open a third instance of that attempt
   without a new mechanism. The untested hypothesis worth pricing first is the
   one the GameCube side already banked: V8 M137 cross-INSTANCE `call_indirect`
   deopt (`gc_cross_instance_deopt_single_instance_lever_2026_08_20`). The
   Dreamcast shard design has 6+ live shard modules in this profile and every
   cross-shard exit is a `return_call_indirect` on the shared table. A cheap
   first read is a matched pair with `--js-flags "--no-liftoff"` (the canonical
   loop already forwards `--js-flags`) to test whether the shard functions are
   tiering up at all.

## What this does NOT do

- Does not change guest timing. `sh4_sched_tick` is called identically; only the
  two clock reads around it are gone. Guest ratio held at 1.000x in all 8 arms.
- Does not remove the `sch` EVENT COUNT — `n=` still prints, and it is the
  load-robust scene-identity control the matched pairs are read against.
- Does not add any cost to the emitted guest-store path. The SMC ledger counters
  sit only on C-side paths, all of which read 0 per run in practice.
- Does not certify the unguarded intra-shard tail-link. It closes the specific
  instrument gap that made the previous evidence inadmissible.

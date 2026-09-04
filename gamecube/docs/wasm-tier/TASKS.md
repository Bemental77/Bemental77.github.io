# The V8 tier is a 2.1x factor on emitted code — and the probe has been forcing it

## Why this topic exists

`gamecube/docs/executed-op-census/TASKS.md` closed with a hard bound: removing
**100%** of per-block fixed overhead buys `1.27x` against the `2.29x` SAB owes, so
"the remaining deficit is NOT recoverable from inside the emitted block bodies."
Every op-count lever in the tree has measured null (the SIMD byte-swap's proven
−887 emitted ops matched-paired at **0.994x**).

That bound prices *how many wasm ops we emit*. It says nothing about **what V8
compiles those ops into**, which is a second, independent, and larger factor. This
topic measures it.

Everything below is offline unless marked LIVE. The offline instrument is
browser-free, load-independent and deterministic — which is most of why it is worth
having, given gate #10 voids any pair taken above ~load 25.

## The refuted premise

`webAssemblyFindings.md:525` was headed **"Verified: V8 Liftoff is the only tier our
blocks ever reach"** and concluded **"There is no TurboFan tier-up for our JIT'd
blocks, no matter how hot they get."**

Its evidence was entirely "From V8 official wasm compilation pipeline doc + V8 code
caching blog" — **no measurement of this tree's blocks.** Two of its bullets are
wrong about the mechanism:

- *"TurboFan tier-up only happens for streaming-compiled (`compileStreaming`)
  modules — synchronous `new WebAssembly.Module(bytes)` from byte arrays generally
  stays at Liftoff."* Tier-up is not a function of the compile API.
- *"TurboFan code caching only kicks in for `.wasm` resources >= 128KB."* That is
  about **code caching across page loads**, a different mechanism from dynamic
  tier-up. It does not gate tier-up.

**Measured refutation.** node 24.15.0 ships V8 with the disassembler compiled in, so
`--print-wasm-code` prints a real `compiler:` line per compiled function. Running one
real emitted SAB block (`80022e0c.wasm` — the live shape: 13 imports per
`hle_prologue.h:35` `WIMPORT_COUNT`, `run` exported at function index 13,
instantiated with synchronous `new WebAssembly.Module(bytes)`) for 3,000,000 calls:

```
name: wasm-function[13]   compiler: Liftoff
name: wasm-function[13]   compiler: TurboFan     <-- it tiers up
```

The section in `webAssemblyFindings.md` is now boxed as refuted rather than deleted.

## The tier-up model — measured, predictive, exact

V8: `--wasm-tiering-budget` default **13,000,000**, documented in `node --v8-options`
as *"budget for dynamic tiering (rough approximation of bytes executed)"*. It is
charged **per function against its own code-body size**, so:

> **executions to tier up = 13,000,000 / code_body_bytes**

Verified on three real blocks spanning a 275x size range. Each crossed inside the
predicted bracket, none outside it:

| block | code body | predicted | measured threshold |
|---|---:|---:|---|
| `80022eec` | 223 B | 58,295 | between 40,000 and 58,000 ✅ |
| `80022e0c` | 431 B | 30,162 | between 20,000 and 30,000 ✅ |
| `80169d00` | 61,390 B | 211 | between 100 and 200 ✅ |

**The consequence inverts the old paragraph's reasoning.** A *small* body does not
keep code in Liftoff forever — it *raises the execution count needed to leave it*.
SAB's hot regime is short blocks (`executed-op-census`: 1-instruction blocks mean
51.9 unconditional ops, modal prologue 6-9 ops), i.e. exactly the shape that needs
tens of thousands of its **own** executions to tier up, while a merged region crosses
in hundreds.

## What the tier is worth: 2.108x on emitted bodies

323 real emitted block modules from `gamecube/bementalJIT/tools/op_census.cpp` run
over `/tmp/sab2.manifest` (the corrected-instrument corpus the census topic used).
Each block instantiated with a shared memory large enough for the live windows (ctx
`0x02400000`, lc_base `0x02600000`, fastmem `0x10000000 + mem1_mask 0x01FFFFFF` —
**an undersized memory traps mid-loop and silently drops blocks**), called in a tight
loop, best-of-5 windows, 2 reps per arm, arms interleaved.

`--liftoff-only` vs `--no-liftoff`, **318 blocks paired** (5 skipped: trap/instantiate).
A per-arm FLOOR (an empty exported wasm function through the identical call path) is
subtracted, because the floor itself differs by arm — Liftoff 6.137 ns, TurboFan
3.217 ns.

| | value |
|---|---|
| body-cost ratio lift/turbo — min / p25 / **median** / p75 / max | 1.10 / 1.88 / **2.75** / 3.74 / 6.30 |
| unweighted sum-of-bodies | 12,682.5 ns vs 5,895.3 ns = **2.151x** |
| **census-weighted mean body** | 41.514 ns vs 19.696 ns = **2.108x** |
| raw incl. wrapper (conservative) | 47.651 vs 22.914 = 2.080x |

**2.108x is larger than the entire measured lever inventory in this tree** (+8.7%
composed, L1×L2) **and larger than the 1.27x ceiling on the whole "delete fixed
overhead" program.** It is a factor on the same quantity — `[13]`, the emitted
bodies — and it is multiplicative with op removal, not competing with it.

### But most of it is already being collected

Replicating the live many-module shape — 323 separate `Module`+`Instance` pairs,
census-weighted round-robin schedule, 30,000,000 total block executions, 3 reps at
load 1.6-1.8:

| arm | ns/call (min of 3) | vs TurboFan |
|---|---:|---:|
| `--liftoff-only` | 98.477 | 1.714x slower |
| **default V8** (dynamic tiering) | 66.844 | **1.164x slower** |
| `--no-liftoff` (TurboFan forced) | 57.450 | — |

Under default V8, **260 of 323 modules reached TurboFan**. So the hot set tiers up on
its own and collects most of the 2.1x; the residual **1.164x** is the part still on
the table, concentrated in (a) the 63 modules that never crossed their budget and
(b) time spent in Liftoff before crossing.

## ⚠ The measurement-validity problem this uncovered

`gamecube/tools/dolphin_render_probe.js:159`:

```js
`--js-flags=--max-old-space-size=4096 ${process.env.PROBE_JS_FLAGS || '--no-liftoff'}`,
```

**Every probe run in this tree defaults to `--no-liftoff`** — TurboFan forced, no
Liftoff tier at all. The comment at `:128-131` is explicit that this was chosen
because it "measured 2.2x throughput vs default V8 ... on real-game SAB" (independent
of, and consistent with, the 2.108x measured here from a completely different
instrument).

**A web page cannot set V8 flags.** So every guest-rate figure this probe has ever
produced — the SAB `0.4371x` / `0.4617x` / `0.4888x` family, and the ceiling
arithmetic in `executed-op-census` that divides into them — was taken under a V8
configuration **the shipping product cannot have.** The user's real Chrome gets
default dynamic tiering.

This does not invalidate any *ratio* measured as a matched pair under the same flag.
It does mean the **absolute** guest rate quoted for SAB is optimistic relative to what
a visitor gets, and the offline replication above sizes that gap at **1.164x**.

**Recommendation, NOT taken here because it would silently reprice every sibling's
in-flight numbers:** decide deliberately whether the probe should measure the
shipping configuration (drop the default) or keep forcing TurboFan (and annotate
every number as flag-forced). Either is defensible; the current state — forcing it
silently — is not.

## ⚠ The LIVE pair is CONFOUNDED — reported as void, not as confirmation

One binary (`md5 82bc8f8b6e1c6ac8db27ec0a5d49dadb` **before AND after**, HASH
STABLE), 4 runs interleaved A B A B under `probe_lock`, `ROM_IDX=1` SAB cold boot,
`PROBE_DURATION_MS=75000`, `PROBE_QUERY=bjit_batch=64`, load 1.77 → 7.43. The arms
differ **only** in `PROBE_JS_FLAGS` (`--liftoff` = default V8 = the user's Chrome, vs
`--no-liftoff` = the probe default).

| arm | guest (AI-DMA, both witnesses) | published/s | cumulative peFrames |
|---|---:|---:|---:|
| `--liftoff` rep1 | 0.3774x | 21.80 | 2563 |
| `--liftoff` rep2 | 0.3891x | 22.23 | 2572 |
| `--no-liftoff` rep1 | 0.4544x | 18.55 | 2111 |
| `--no-liftoff` rep2 | 0.4430x | 17.65 | 2140 |

The AI-DMA guest witness says `--no-liftoff` is **1.171x faster** (arm ranges do not
overlap; within-arm spread 2.6-3.1%), which agrees with the offline 1.164x almost
exactly.

**Do not use that agreement.** Two guest-side counters disagree in **direction**:

- **AI-DMA callback rate**: `--no-liftoff` **+17.1%**.
- **peFrames** (pixel-engine frame completions, also guest-side): `--no-liftoff`
  **−21%** — the *slower*-guest arm produced *more* frames. `published/s`,
  `shown(rAF-distinct)` and `guest_pe_finish` all move the same way as peFrames.

Per gate #8, a contradiction means the rig is dirty, not that a new mystery exists.
The most likely reading — **stated as a hypothesis, not a finding** — is that the two
arms are not scene-matched: this is a 75 s cold boot through SAB's intro, so a faster
guest reaches a *different* (heavier) part of the sequence inside the window, and the
AI-DMA witness measures **credited emulated time**, which memory entry
`gc_jit_execution_ceiling_is_the_deficit` records as inflatable by idle-skip
(`8a4342e5` idle-skips SAB's frame governor). A faster arm can reach the governor
spin sooner each frame and accrue credited time without doing guest work.

**So the live number is VOID and the offline 1.164x / 2.108x stand alone.** A clean
live sizing needs a scene-matched rig (savestate restore verified by the restore-OK
line + screenshot, per gate #10), which this pass did not build.

## What this changes for the "make [13] cheaper" program

`executed-op-census` bounded op removal at `1.27x` and concluded the deficit is not
recoverable from inside the bodies. That conclusion is **unchanged for op removal**,
but it was reasoning about only one of two factors:

```
cost of emitted code  =  (how many wasm ops we emit)  x  (machine cost per wasm op)
                          ^ op census: bounded at 1.27x   ^ the tier: 2.108x, mostly already collected
```

Two consequences worth carrying forward:

1. **Block merging has a second, unpriced benefit.** The census priced perfect
   merging at `1.16x` from fixed-overhead removal alone. Merging also multiplies the
   body size, and tier-up threshold is `13e6 / body_bytes` — so an N-way merge
   crosses into TurboFan ~N times sooner and drags part of the cold tail over the
   line. This is a *new* argument for the merging/region program, grounded in a
   measured V8 parameter rather than in op counts. It does not overturn the three
   recorded net-negative region-promotion measurements at `block_cache.cpp:205-232`;
   it adds a term those A/Bs never isolated.
2. **The "op-count levers measure null" mystery has a candidate mechanism.** The
   census's own hypothesis was that ~47% of the counted op stream (`i32.const` 30.98%
   + `local.get`/`local.set` 16.81%) folds away in the backend. That is consistent
   with what is measured here: what the ops cost depends entirely on which compiler
   consumed them, and TurboFan — which does the folding — is a 2.108x factor on the
   same op stream. Sizing levers in raw op counts prices the wrong variable.

## Open, not done

- **Module churn is unmeasured and could make the live gap much larger than 1.164x.**
  Every recompile of a PC produces a fresh module whose V8 tiering budget **resets to
  13,000,000**. `block_cache.cpp` already counts this (`0x026B3960 recompileN`,
  `0x026B3940 evictAtCapN`, `0x026B3964 evictedBlocksN`) but
  `dolphin_render_probe.js` does not surface those cells — they appear in none of the
  four logs above. Reading them is the cheapest next step and it is pure telemetry.
- **Which 63 modules fail to tier, and what share of `[13]` self-time they hold.**
  The census manifest + weights can answer this offline.
- **A scene-matched live pair**, per the void above.
- Not attempted: any emitter change. Nothing in this topic edits emitted code.

## Reproducing

```bash
# real emitted block modules (offline; build op_census per executed-op-census/TASKS.md)
node /tmp/op_census.js /tmp/sab2.manifest /tmp/census-tier

# tier of one real block (needs a V8 with the disassembler — node 24.15.0 has it)
node --print-wasm-code <harness> /tmp/census-tier/80022e0c.wasm 3000000 | grep "^compiler:"

# the three arms, live many-module shape
CALLS=30000000 node --liftoff-only <many.mjs>   # Liftoff floor
CALLS=30000000 node                <many.mjs>   # default V8 = the user's Chrome
CALLS=30000000 node --no-liftoff   <many.mjs>   # what the probe forces
```

Harnesses were scratch-local to the session that produced this; the load-bearing
details are recorded above (memory sizing, the 13 import stubs, per-arm floor
subtraction, best-of-5, interleaved arms) so they can be rebuilt from this file.

# What a chain edge costs, by module topology — the unmeasured premise under candidate #1

## Goal

`gamecube/docs/designs/wasm-dispatch-research.md:585` ranks *"batch hot blocks
into few multi-function modules with a module-internal table"* as candidate #1.
It rests on two vendor statements and **zero measurements of this JIT's edge
shape**:

- V8, <https://v8.dev/blog/wasm-speculative-optimizations>: inlining a
  `call_indirect` whose target belongs to another instance *"would hence require
  additional compiler machinery"*; V8 instead checks instance identity and
  deoptimizes. The blog names our exact configuration — *"called via an imported
  table."*
- SpiderMonkey, <https://dbezhetskov.dev/opt-ind-call/>: private-table indirect
  calls *"become much faster −30%"* while external calls pay *"+18%"*.

Against those sit **three recorded net-negative measurements** of region
promotion, the only mechanism in-tree that could deliver an internal table
(`gamecube/bementalJIT/src/block_cache.cpp:205-232`). So the standing question —
"is candidate #1 worth another campaign?" — has been argued from vendor prose on
one side and from outcome measurements on the other, with the *mechanism* itself
never priced.

This topic prices it.

## The instrument

| File | What it is |
|---|---|
| `gamecube/tools/wasm_edge_cost_bench.mjs` | Hand-encodes raw wasm for four module topologies with **identical bodies, identical terminal ops and identical edge counts**, and times them interleaved. Runs in node or in a browser page. Depends on nothing in the tree; builds no C++; opens no browser by itself. |
| `gamecube/tools/wasm_edge_cost_bench_chrome.mjs` | Runs that same source inside the Chrome the dolphin probe uses. |

The terminal is copied op-for-op from the shipping non-merged/non-region
`emit_chain_or_return` — service bail (`ppc_emit.cpp:233-244`), the vector-page
guard in its EDGE-DIET short-circuit form (`:273-289`), the bucket probe
(`:336-421`) and the host return (`:461-462`).

```bash
# node (fast, no lock needed — no browser)
N_BLOCKS=512 SUCC=4 BODY_OPS=68 REPS=5 node gamecube/tools/wasm_edge_cost_bench.mjs
# real Chrome (the product) — takes the probe lock
bash tools/probe_lock.sh run -- node gamecube/tools/wasm_edge_cost_bench_chrome.mjs
```

### The arms

| arm | topology | models |
|---|---|---|
| A | N modules, N instances, table **imported** | what ships today (`block_cache.cpp:422`, `:623`, `ppc_emit.cpp:2001`) |
| A2 | 1 module, N funcs, table **imported** | isolates instance count from table provenance |
| B | 1 module, N funcs, table **internal** | candidate #1 |
| C | 1 module, N funcs, guarded **direct** `return_call` + indirect fallback | candidate #2, the self-emitted inline cache |
| G | `BATCHES` modules × N/`BATCHES` funcs, internal table for in-group edges + the shared imported table for cross-group edges | the realistic batched design — and the shape `build_region_module_next` already emits (`ppc_emit.cpp:2288` imports the global table, `:2145-2147` declares an internal one) |

### Why node alone could not have answered this

node v24.15.0 carries **V8 13.6**. V8's speculative `call_indirect` inlining
shipped in **Chrome M137 / V8 13.7**. A node-only result could therefore have
missed the very mechanism under test. Every headline number below is from
**HeadlessChrome/152.0.0.0**, with node reported alongside as an independent
second engine.

### Three modelling bugs this bench had, and what each produced

Recorded because each one produced a confident wrong number before it was
caught, and the same traps will catch the next person:

1. **A constant-folded body.** Seeding the ALU accumulators from a constant let
   V8 delete the entire body; arm C was then *insensitive to `BODY_OPS`* (227 →
   160 → 183 Medge/s for BODY_OPS 0 → 68 → 200). Accumulators are now seeded
   from memory, written back, and their **addends are loaded from memory** so
   the arithmetic of several inlined blocks cannot be fused.
2. **Monomorphic-only edges.** With one successor per site, V8's speculation
   always wins and the batched arms are flattered. `SUCC` now sets the successor
   count; the realistic cell is a 2-target site (a taken/not-taken conditional
   branch, which is how a 3-5-instruction Gekko block ends).
3. **A trapped chain.** With every edge in-group, the working set silently
   collapsed to one group — arm A, which has no groups at all, sped up 2.7x
   across the sweep. **Arm A's rate staying flat across a GROUPS/HIT sweep is
   the validity check**; if it moves, that sweep is invalid.

Two endpoint self-tests the G arm must pass, on the current code (node, N=256,
SUCC=8, BODY_OPS=68, 3 reps): at `GROUPS=N_BLOCKS` (one function per module) it
lands on arm A — **24.44 vs 22.71**, within 8%; at `GROUPS=1` it lands near arm B
— **65.98 vs 77.77**, 15% low, which is the extra group test plus the table
import it still carries and which arm B does not. Arm A itself reads 22.41 and
22.71 across those two rows, i.e. flat, which is the topology-control check from
trap 3.

## The measurement

**Chrome 152, N_BLOCKS=512, EDGES=40M/rep, REPS=5 interleaved round-robin,
WARMUP=2, probe lock held, load 2.97 → 1.77.** Medges/s, median of 5.

| SUCC | BODY_OPS | A | A2 | B | C | **B/A** |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 30.34 | 94.07 | 97.85 | 131.49 | **3.22x** |
| 1 | 68 | 29.73 | 105.12 | 84.41 | 59.00 | **2.84x** |
| 1 | 200 | 25.68 | 90.99 | 89.51 | 63.86 | **3.49x** |
| 4 | 0 | 24.85 | 86.84 | 92.96 | 97.94 | **3.74x** |
| 4 | 68 | 24.63 | 71.98 | 69.66 | 64.78 | **2.83x** |
| 4 | 200 | 21.03 | 43.88 | 44.29 | 51.30 | **2.11x** |

**node v24.15.0 / V8 13.6.233.17, same configuration** (not lock-serialized;
load 1.75 → 3.36):

| SUCC | BODY_OPS | A | A2 | B | C | **B/A** |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 0 | 23.48 | 99.04 | 104.50 | 84.20 | **4.45x** |
| 1 | 68 | 24.46 | 102.92 | 105.93 | 70.41 | **4.33x** |
| 1 | 200 | 22.52 | 63.87 | 66.63 | 37.78 | **2.96x** |
| 4 | 0 | 24.16 | 84.94 | 85.22 | 68.05 | **3.53x** |
| 4 | 68 | 22.34 | 67.66 | 72.10 | 49.98 | **3.23x** |
| 4 | 200 | 18.86 | 49.36 | 50.35 | 35.89 | **2.67x** |

The SAB-shaped cell is `SUCC=4, BODY_OPS=68` — a 2-way-polymorphic site on a
block whose body is about what the executed-op census measured for a
3-5-instruction block (`executed-op-census/TASKS.md`: 125.4 d0 ops, 56.2 fixed).
**Chrome 2.83x, node 3.23x.**

## Findings

### F1 — The per-block-module topology costs 2.1-3.7x per chain edge in Chrome

Twelve cells across two engines, all in the same direction. This is the number
that was missing.

### F2 — The lever is SAME-INSTANCE, not internal-table. `block_cache.h:17-20` is half wrong, and it is the operative half.

The header states the rule verbatim:

> *"V8's speculative inlining requires the call_indirect target to live in the
> same instance's table, so the table MUST NOT be imported."*

**Measured, six paired Chrome cells: B/A2 = 1.040, 0.803, 0.984, 1.070, 0.968,
1.009 — median 0.996.** Making the table internal buys nothing detectable over an
imported table, *provided the target is in the same instance*.

Node is not identical here and should not be reported as if it were: its six
cells read 1.055, 1.029, 1.043, 1.003, 1.066, 1.020 — **median 1.036**, i.e. a
small but consistently *positive* ~3-4% for the internal table, every cell above
1.0. So V8 13.6 pays a few percent for an imported table and Chrome 152 pays
nothing measurable. Either way the effect is one to two orders of magnitude
below the 2.1-3.7x that same-instance buys, which is the decision-relevant fact;
but "an internal table is worth ~0-4%" is the honest statement, not "worth
nothing."

This matters far more than it reads, because it removes the design constraint
that made candidate #1 expensive. The doc's own reasoning was: *"an internal
table can only hold functions from its own module … so the compliant shape is
inseparable from multi-block modules"* — true, but the premise it serves is not
the binding one. **The global `g_bem_disp_tag`/`g_bem_disp_slot` dispatch cache
and the shared imported `__indirect_function_table` can stay exactly as they
are.** The only thing that has to change is how many blocks share a module.

SpiderMonkey's −30%/+18% private-table result does **not** transfer to V8. Both
engines penalise the topology; they do not penalise the same half of it.

> ✅ **DONE 2026-09-02.** The correction is now in `block_cache.h`, folded in
> alongside the `batch_note`/`batch_flush`/`m_batch_pcs` members of F9 — i.e.
> the header was opened for a real change, which is the condition this note set.
> (The deferral was because `.claude/hooks/verify_fresh_probe.sh:52` derives
> "newest GameCube source" from an `mtime` walk of `gamecube/bementalJIT`, and a
> comment-only touch would have flipped every sibling's probe to **STALE** for a
> comment. F9's change rebuilt and relinked, so no sibling pays for it.)

### F3 — Candidate #2 (self-emitted inline cache of direct tail calls) is REFUTED at realistic scale

Arm C beats the indirect arms at N=64 (175 vs 109 Medge/s), and at N=512 it stops
being reliable. C/B per cell:

| engine | C/B across the six N=512 cells | verdict |
|---|---|---|
| Chrome 152 | 1.34, 0.70, 0.71, 1.05, 0.93, 1.16 | beats both indirect arms in 3/6, loses to both in 3/6 |
| node / V8 13.6 | 0.81, 0.66, 0.57, 0.80, 0.69, 0.71 | **loses to both in 6/6** |

Nine of twelve cells are a loss and the wins do not reproduce across engines, so
this is **no reliable win**, not a modest one — a guarded ladder of direct
`return_call`s across hundreds of functions costs more in code growth than it
saves in dispatch, and the swing (0.57x to 1.34x) says the outcome depends on
inlining decisions we do not control. Do not build the winliner-style IC as a
standalone lever.

Note this is a weaker statement than "C is slower." It is "C is unpredictable at
the scale that matters, and predominantly worse." A batching design should not
count on it.

### F4 — Batch size has a ceiling, and it is below 1024

node N sweep, arms A and B only, SUCC=1, BODY_OPS=68, EDGES=30M, REPS=5:

| N | A | B | B/A |
|---:|---:|---:|---:|
| 32 | 77.98 | 100.25 | 1.29x |
| 64 | 42.35 | 101.66 | 2.40x |
| 128 | 25.37 | 97.77 | 3.85x |
| 256 | 21.91 | 98.50 | 4.50x |
| 512 | 22.16 | 89.03 | 4.02x |
| **1024** | 21.14 | **35.35** | **1.67x** |

At N=1024 arm B **collapses**, and it is not a tier-up artifact: over 10 reps the
samples read 30.2 47.6 51.9 44.8 35.4 40.5 37.9 37.7 38.4 39.4 — stable, with no
upward trend, against 104.8-120.5 at N=512 in the same run. I have not
established the mechanism (V8 per-module optimisation budget, code-space
pressure and element-segment size are all candidates and I did not separate
them). **The actionable part is the constraint: batch at a few hundred functions,
not thousands.** The hot set therefore has to span *several* modules, and edges
between them are cross-instance again — which is what arm G exists to price.

### F5 — [SUPERSEDED BY F8 — read F8 first] A coverage model, and why it is wrong

> ⚠ **This finding was refuted by my own follow-up measurement (F8). It is kept
> because the reasoning is instructive and because the model's headline number
> was quoted in three commits before F8 landed.** The model assumed an
> out-of-batch edge costs the same as today's edge. **It does not** — in a
> batched world there are only a handful of live instances, so even a 100%-miss
> batch is ~1.9x faster than today. Coverage turns out to be nearly irrelevant;
> instance COUNT is the variable. What follows is the superseded model.

Blending the two measured edge costs — in-batch at rate `R` = 2.83x, out-of-batch
at today's rate — gives `speedup(h) = 1 / (h/R + (1-h))` for in-batch hit rate `h`:

| h | speedup |
|---:|---:|
| 0.05 | **1.03x** |
| 0.50 | 1.48x |
| 0.778 | 2.01x |
| 0.90 | 2.39x |
| 0.95 | 2.59x |

`block_cache.cpp:207-210` records the achieved hit rate as **"~5%"**. At h=0.05
the mechanism is worth **+3%** — comfortably inside the noise, and trivially
swamped by the per-miss membrane tax, the promote-ring prologue and the
region-first dispatch loop that the same comment block names. **The three
net-negative measurements are exactly what this model predicts.** They are
evidence about the policy, and they are not evidence against the mechanism.

For SAB's 0.4726x → 1.000x (a 2.12x need) the model asks for **h ≈ 0.82**.
`block_cache.cpp:218-223` measured board top-512 = 77.8% of dynamic entries and
top-2048 = 97.9%; the profile split in `wasm-dispatch-research.md:38-45`
independently puts top-512 at 76.7-96.2% of `wasm-function[13]` self-time. So
the required coverage is *near* what the locality data says is available — but
F4 says it cannot be one module, and 2.12x from this lever alone would need
essentially everything to go right. **Treat 1.5-2x as the defensible target for
this lever, not 2.83x.**

> The model's one load-bearing assumption is that an out-of-batch edge costs the
> same as today's edge. **F8 measured that assumption and it is false in the
> optimistic direction.**

### F8 — Coverage barely matters. INSTANCE COUNT is the variable. (This refutes F5.)

Arm G, `BATCHES=8` (8 modules × 64 functions), N=512, SUCC=8, BODY_OPS=68,
EDGES=30M, REPS=5 interleaved, Chrome 152, probe lock held, load 2.92 → 3.58:

| HIT (in-batch edge fraction) | A | G | **G/A** |
|---:|---:|---:|---:|
| 0.000 | 38.57 | 72.71 | **1.885x** |
| 0.250 | 37.56 | 73.86 | **1.966x** |
| 0.500 | 43.07 | 78.10 | **1.814x** |
| 0.750 | 44.66 | 76.41 | **1.711x** |
| 0.875 | 44.25 | 77.10 | **1.743x** |

**G/A is flat — 1.71x to 1.97x, with no trend — across the entire coverage
range.** F5's model predicted 1.03x at low coverage and 2.4x at high; the
measurement says ~1.8x everywhere.

The `HIT=0` row is the decisive one. There, **every single edge leaves its batch
and goes through the shared imported table to another instance** — arm G and arm
A are executing the same edge kind, through the same table, with the same ops.
The only surviving difference is that arm G's call sites see **8 target
instances** and arm A's see **512**. That is worth **1.885x** by itself.

So the mechanism is not "keep edges inside a module." It is **"stop having
thousands of live instances."** V8's per-call-site instance check has to be
monomorphic-ish to be cheap, and 512 modules-of-one guarantees it never is.

**This changes the design target, and makes it easier.** The whole "coverage
wall" framing — the thing all three recorded negatives were attributed to, and
the thing F5 reconstructed arithmetically — is measuring the wrong variable.
Promotion does not need to capture the successors of hot edges; it needs to
capture *enough of the working set that few modules remain live*. It also
re-explains the recorded negatives better than F5 did: promoting ~570 blocks
into regions while thousands of per-block modules stay live barely moves the
instance count, so the mechanism's actual benefit never had a chance to appear —
while the promote-ring prologue, the per-miss membrane crossing and the
region-first dispatch loop all cost immediately.

**Validity caveat, stated not buried.** Arm A is *not* flat across this sweep —
38.57 → 44.66, a 16% rise — so the topology is not perfectly held. That is
expected and benign here: `HIT` changes the walk itself (at `HIT=0.875` seven of
eight edges advance sequentially inside a 64-block window, which is more
cache-friendly than the strided cross-batch walk at `HIT=0`), and it moves both
arms. **The valid comparison is G/A within a row**, where both arms see the
identical edge sequence; that ratio is what is flat. A cross-row reading of
either arm's absolute rate is not supported.

**Do not over-extend this.** It is measured at one batch size (8 × 64) on a
512-block working set. The real build has 2,184-4,461 *live-and-sampled* modules
(`wasm-dispatch-research.md:38-45`) and more created; F4 caps a module at a few
hundred functions, so covering that set means order-10-to-30 modules, not 8 —
and whether the instance-count benefit holds at 30 instances rather than 8 is
**not measured here**.

### F6 — The selection-signal circularity is already broken

`executed-op-census/TASKS.md` records the blocker as circular: *"the per-PC
execution counters that would drive a better selection (`g_bem_pc_exec`,
`ppc_emit.cpp:1035`) are themselves gated behind the very flag being decided."*

The gating is real — `ppc_emit.cpp:1061` emits the counter only
`if (g_bem_promote_enabled && region_gen < 0)`, and `block_cache.cpp:233` sets
that to 0. **But two independent ranking signals already exist on stock HEAD and
need no code change at all:**

1. **`PROBE_PC_SAMPLE=1`** (`dolphin_render_probe.js:40`) — a page-side guest-PC
   sampler dumping `/tmp/wasm_pc_hist.json`, ungated by anything in the JIT.
   `sab-frame-governor/TASKS.md` used it on stock HEAD to attribute 23.2% of
   guest execution to one loop. `gamecube/tools/op_census_manifest.mjs` already
   converts that histogram plus the disc image into a block manifest, recovering
   block-entry PCs *"with the same two predicates the JIT uses"*. Caveat: it
   buckets to 256 bytes (`dolphin_render_probe.js:614`, `pc & ~0xFF`), so it
   ranks 256-byte regions rather than individual blocks — adequate for choosing
   a few hundred hot regions, not for ranking within one.
2. **A `.cpuprofile` URL histogram.** Every per-block module is its own
   `WebAssembly.Module`, so V8 gives each a distinct `callFrame.url`;
   `wasm-dispatch-research.md:38-45` reports 2,184-4,461 distinct module URLs
   under `wasm-function[13]` across four existing profiles, ranked by self-time.
   That is a direct per-block hotness ranking, obtainable offline from an
   artifact type the tree already produces.

**Selection can be driven offline from either signal. Flipping
`g_bem_promote_enabled` is not a prerequisite for building a better policy — it
is only a prerequisite for the *runtime* counter, which is the one thing the
2026-08-20 A/B named as part of the regression** (`block_cache.cpp:230`: *"the
promote-ring prologue"*).

### F7 — The cheaper-terminal family is exhausted, and this bench is the controlled experiment that says so

The standing follow-up to the edge diet was "40 → 32 ops landed; what remains in
those 32, and how much is unconditional on every edge?" Reading
`emit_chain_or_return` for the shipping case (`merged == nullptr`,
`region_gen < 0`, `n_direct == 0`) gives **31 by my count** against the census's
measured 32 — I did not chase the one-op difference, which is plausibly how the
report attributes a closing `end`:

| phase | `ppc_emit.cpp` | d0 ops | what it is |
|---|---|---:|---|
| service bail | :233-244 | 6 | `ctx.DOWNCOUNT <= 0` → return PC |
| vector guard | :273-289 | 7 | `PC < 0x4000` outer, `MSR & IR` inner, PC teed into `TMP_A` |
| bucket probe | :336-344, :421 | 15 | `((PC>>2) & MASK)*4` → `TMP_B`, tag load, compare, `if` + its `end` |
| host return | :461-462 | 3 | tag miss / freed slot → return PC to the C loop |

On a **taken** edge the 3 host-return ops never execute and the structured
`end`s are not runtime instructions, so the executed sequence is roughly 35
machine-level operations — of which **exactly one is the call**.

That single op is the whole story, and the two experiments are now matched:

- The tree's own op-count experiment held topology fixed and removed ops: SIMD
  byte-swap, **−887 emitted ops, matched-paired at 0.994x** — null. Stripping the
  byte-swap entirely measured FLAT (`jit_load_store.cpp:270-278`).
- **This bench holds the op count fixed and changes only the topology.** Arms A
  and B execute the *identical* terminal — every op above, in the same order,
  emitted from the same code — and differ solely in whether the callee lives in
  the caller's instance. **2.1-3.7x.**

So: cutting further into the remaining 31 ops is arithmetic, and arithmetic has a
measured null prior in this tree. **Do not spend another campaign on the
terminal.** The two items `executed-op-census/TASKS.md` still lists as "sized but
not built" should be re-scoped accordingly — `BEM_MIPS_CENSUS`'s 6-op prologue
RMW is worth removing because it instruments a meter gate #10 forbids quoting,
not because 6 ops are worth speed; and the `slot >= 0` check's ~5 ops/edge are
not worth the audit of every writer of `-1` that removing them safely requires.

This does **not** retire the *other* half of the per-block fixed overhead. The
census's 45.7% figure covers prologue + terminal, and the way to remove it is to
have fewer edges (bigger blocks, or blocks that share a module and can therefore
be inlined into one another) — which is the same lever as F1, arrived at from the
op side.

### F9 — MEASURED ON THE REAL BUILD 2026-09-02: instance reduction TRANSFERS, and it is worth **+3.0% to +4.5% guest**, not 1.8-2.8x. The K sweep is FLAT.

The mechanism this topic argued for was built and probed. `?bjit_batch=<K>`
(SAB cell `0x026B39A0`, `gamecube.html`) makes K freshly compiled blocks share
one `WebAssembly.Module`/`Instance`: `BlockCache::stash_block` queues every
compiled PC, `BlockCache::batch_flush` re-emits their bodies with
`emit_block_body_flat_next` (byte-for-byte the per-block body — global
`g_bem_disp_tag`/`slot` cache, shared imported table 0, `region_gen = -1`),
packs them with `build_block_batch_module_next`, and installs each `fn_i` **at
the wasmTable slot that block already owned**. Nothing downstream changes: the
dispatch cache, the C chain loop, the in-WASM tail-chain and `evict()` all
address blocks by slot and the slots do not move. K < 2 is OFF and is the
byte-identical control, so **every arm below came off ONE binary**
(`md5 9267a160d3afd3114e4112c6a7c5bc91`).

Deliberately NOT the promotion path: `g_bem_promote_enabled` stays 0 (so
`ppc_emit.cpp:1061`'s prologue counter is still compiled out), no
`region_dispatch` is consulted, and there is no miss path to pay a membrane
crossing on. Those are the three causes the recorded negatives name.

**SAB (`ROM_IDX=1`), cold boot, `PROBE_DURATION_MS=75000`, guest clock read from
the two AI-DMA witnesses over the steady 40 s window, all runs `probe_lock`-held
from a hermetic `PROBE_ROOT` snapshot, load 5.4-6.6 throughout.**

| run | K | modules | live instances | guest | published/s |
|---|---:|---:|---:|---:|---:|
| A1 | 0 | 0 | **11,809** | 0.4227 | 16.38 |
| B1 | 64 | 186 | 186 | **0.4389** | 17.43 |
| A2 | 0 | 0 | 11,806 | 0.4246 | 16.72 |
| B2 | 64 | 186 | 186 | **0.4337** | 17.23 |
| A3 | 0 | 0 | 11,809 | 0.4203 | 16.70 |
| K256 | 256 | 46 | 159 | **0.4370** | 17.20 |
| K512 | 512 | 23 | 148 | **0.4387** | 17.43 |
| K16 | 16 | 746 | 746 | **0.4370** | 17.48 |
| A4 | 0 | 0 | 11,811 | 0.4050 | 16.50 |

Zero `BLOCK TRAP`, zero `chain trap`, zero `C-dispatch trap`, zero
`compile_raw failed`, zero batch-install failures in all nine runs, and both
arms **render** — the 60 s screenshots are clean SAB intro frames, no black
world, no NaN geometry. Batch build cost is `build_ms` 114-281 **cumulative for
the whole run** (whole-ms truncation makes that a slight under-report), i.e. a
third of a second against ~90 s, even though batching re-emits every body a
second time.

- **Complete separation.** Every treatment (5 runs, min 0.4337) is above every
  control (4 runs, max 0.4246). One-sided exact permutation p = 1/C(9,4) =
  **0.0079**. The delivered-fps witness separates identically and independently
  (min treatment 17.20 > max control 16.72).
- **Effect size, both estimators, because they differ.** Strict adjacent
  interleaved pairs A1/B1 and A2/B2: **+3.0%**. All runs pooled: 0.43706 vs
  0.41815 = **+4.5%**. Dropping A4 (a low control outlier — the other three
  controls span only 0.4203-0.4246) gives +3.4%. **Report the range, not a point
  estimate:** the control spread is about as wide as the effect.
- **The instance count moved 63x and the guest rate moved 4%.** So the 2.1-3.7x
  per-edge ratio of F1/F8 is real but is a small share of end-to-end cost, which
  is consistent with F7: on a taken edge exactly one op is the call, and
  `wasm-function[13]` (the block bodies themselves) is 47-68% of CPU thread
  self-time. **This does not rescue SAB.** 0.4181x -> 0.4371x against a 1.000x
  target is 2.29x still owed.

#### F9b — the K sweep is FLAT, so "how many instances" is the wrong knob past the first batch

This answers the open question this topic parked. Guest rate by live instance
count: 746 -> 0.4370, 186 -> 0.4389/0.4337, 159 -> 0.4370, 148 -> 0.4387. **The
spread ACROSS K (0.4337-0.4389) is no larger than the spread WITHIN K=64
(0.4337-0.4389).** Cutting 746 instances to 148 buys nothing measurable; the
entire win appears at the very first batching, K=16.

That is not what F8's global-instance-count model predicts (it read 1.885x
between 8 and 512 modules). **The reading I favour, stated as a hypothesis and
not as established:** V8's check is per CALL SITE, and a call site only ever
sees its own successors' instances — not the global population. Blocks are
queued in COMPILE order, and a hot loop's 3-5 blocks are compiled together, so
even K=16 already puts a loop's successors in one or two shared modules and
collapses that site's polymorphism. Global instance count then has nothing left
to give. I did not test this directly; the discriminating experiment would be a
batch assignment that deliberately SCATTERS a loop's blocks across modules at
fixed K, and it has not been run.

Note K=256 and K=512 left 113 and 125 blocks unbatched (the trailing partial
batch never flushes before the run ends) and still measured at the top of the
range — another sign the residual per-block population is not what binds.

## What this topic does NOT establish

- ~~**No end-to-end fps or guest-rate delta.**~~ **SUPERSEDED BY F9** — the
  matched pair was run. What stands: the 2.83x is a per-edge microbenchmark
  ratio and it did NOT transfer as a speedup; the real build moved +3.0-4.5%.
- **F9's arms are cold-boot runs and their SCENES diverge.** All four controls
  screenshot the identical frame at 60 s and all treatments the identical
  (later) frame — arm-linked, and in the direction of the speedup, which
  corroborates it. But it means the two arms execute partly different guest code
  over the window, and a scene-matched savestate A/B has not been run. The
  AI-DMA witness is a host-side rate over a fixed 40 s wall window, so it is not
  itself a scene proxy; the workload behind it still differs.
- **Nothing here is measured on MP4 or PSO**, only SAB.
- **The op-count null prior is untouched and still stands.** SIMD byte-swap
  landed −887 emitted ops and matched-paired at 0.994x. Nothing here contradicts
  that; this measurement says the edge's cost is **structural (a cross-instance
  call), not arithmetic (its op count)** — which is why the edge diet's −8 ops
  and this 2.83x are different claims about different things.
- **Only ONE batch size was swept.** F8 is `BATCHES=8` on a 512-block working
  set. Where the instance-count benefit saturates between 1 and ~30 modules is
  the open question, and it is what decides whether this lever is worth 1.8x or
  2.8x on the real build.
- **The 1024-block collapse has no established mechanism.**
- **Fidelity limits of the bench:** it imports memory and a table, where a real
  per-block module also imports 13 functions and declares globals
  (`ppc_emit.cpp:1982-2001`); its bodies are synthetic ALU + memory traffic, not
  emitted Gekko; and it holds every dispatch-cache probe to a HIT. Each of those
  makes the bench *cleaner* than the real thing, so the real-world ratio should
  be read as **at most** what is measured here.

## The unblocking plan, in dependency order

~~1. Sweep `BATCHES` at fixed coverage~~ — **DONE, on the real build (F9b): the
sweep is FLAT from 746 instances down to 148.** Do not spend another campaign
looking for a better K; the whole effect is present at the smallest batch tried.

~~2. Rank blocks offline from a `PROBE_PC_SAMPLE=1` histogram (F6).~~ — **not
needed for this lever.** F9 batches in plain COMPILE order with no ranking at
all and captures the entire available benefit, which is what F9b's flat sweep
means. The ranking work would only matter if a scattered-assignment control
(below) showed that locality of assignment, rather than batching per se, is what
pays.

3. **The one experiment left that would explain F9b**: at fixed K, deliberately
   SCATTER each hot loop's blocks across different modules instead of letting
   compile order co-locate them. If that erases the win, the mechanism is
   per-call-site polymorphism (the F9b hypothesis) and the useful knob is
   ASSIGNMENT, not count. If it does not, F9b has no explanation yet.
4. Do **not** re-introduce a region-first dispatch loop (`block_cache.cpp:209`),
   and do **not** build candidate #2's inline cache (F3).
5. **Do not expect this lever to close the gap.** F9 measures +3.0-4.5% against
   the ~2.3x SAB still owes. It is worth shipping — it is free at runtime, costs
   ~0.3 s of build time per run, and never traps — but the deficit is inside the
   block bodies, not on the edges between them.

## References

- `gamecube/tools/wasm_edge_cost_bench.mjs`, `gamecube/tools/wasm_edge_cost_bench_chrome.mjs`
- `gamecube/bementalJIT/include/bementalJIT/block_cache.h:17-20` — the rule F2 corrects.
- `gamecube/bementalJIT/src/block_cache.cpp:205-232` — the three recorded net-negatives; `:233` — `g_bem_promote_enabled = 0`; `:422`, `:623` — one module per block.
- `gamecube/bementalJIT/guests/powerpc-next/ppc_emit.cpp:233-462` — the terminal the bench copies; `:1061` — the gated per-PC counter; `:2288` — the region module importing the global table.
- `gamecube/docs/designs/wasm-dispatch-research.md:585-681` — candidates #1 and #2.
- `gamecube/docs/executed-op-census/TASKS.md` — the per-block fixed-overhead census and the op-count null prior.
- `gamecube/docs/sab-frame-governor/TASKS.md` — the `PROBE_PC_SAMPLE=1` recipe used by F6.
- <https://v8.dev/blog/wasm-speculative-optimizations>, <https://dbezhetskov.dev/opt-ind-call/>

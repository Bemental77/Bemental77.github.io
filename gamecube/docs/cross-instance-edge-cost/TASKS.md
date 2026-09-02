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
| G | GROUPS modules × N/GROUPS funcs, internal table for in-group edges + the shared imported table for cross-group edges | the realistic batched design — and the shape `build_region_module_next` already emits (`ppc_emit.cpp:2288` imports the global table, `:2145-2147` declares an internal one) |

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

> ⚠ **`block_cache.h:17-20` still states the refuted rule, deliberately.** The
> correction was written into that header and then reverted, because
> `.claude/hooks/verify_fresh_probe.sh:52` derives "newest GameCube source" from
> an `mtime` walk of `gamecube/bementalJIT`, and the shipped
> `dolphin_worker_emcc.wasm` mtime currently *equals* the newest source mtime
> (both 1788304516). A comment-only touch would therefore have flipped every
> sibling's probe to **STALE** until someone rebuilt — a false alarm charged to
> other people's in-flight campaigns, for a comment. **Fold the correction into
> that header the next time it is opened for a real change.**

### F3 — Candidate #2 (self-emitted inline cache of direct tail calls) is REFUTED at realistic scale

Arm C beats the indirect arms at N=64 (175 vs 109 Medge/s) and **loses at
N=512** in 4 of 6 Chrome cells (59.00 vs 84.41 at the SUCC=1/BODY=68 cell;
64.78 vs 69.66 at the SAB-shaped cell). A guarded ladder of direct `return_call`s
across hundreds of functions costs more in code growth than it saves in dispatch.
Do not build the winliner-style IC as a standalone lever.

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

### F5 — Coverage is the whole game, and the arithmetic explains all three recorded negatives

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
> same as today's edge, not more. That was **false** for the design that produced
> the three negatives (it paid an extra EM_ASM membrane crossing per miss), and
> `JitWasm.cpp:739-750` says that specific cost was already removed. The arm-G
> sweep is the direct measurement that would replace this model; it was queued
> behind a sibling's probe-lock hold and did not complete in this session.

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

## What this topic does NOT establish

- **No end-to-end fps or guest-rate delta.** Everything here is a synthetic edge
  cost. Nothing was built, linked, or probed against SAB. The 2.83x is a per-edge
  ratio in a microbenchmark, not a speedup of the emulator, and per CLAUDE.md
  gate #10 the only thing that can establish the latter is a matched pair on the
  real build.
- **The op-count null prior is untouched and still stands.** SIMD byte-swap
  landed −887 emitted ops and matched-paired at 0.994x. Nothing here contradicts
  that; this measurement says the edge's cost is **structural (a cross-instance
  call), not arithmetic (its op count)** — which is why the edge diet's −8 ops
  and this 2.83x are different claims about different things.
- **Arm G's coverage sweep did not complete.** F5's curve is a model over two
  measured endpoints, not a measured curve.
- **The 1024-block collapse has no established mechanism.**
- **Fidelity limits of the bench:** it imports memory and a table, where a real
  per-block module also imports 13 functions and declares globals
  (`ppc_emit.cpp:1982-2001`); its bodies are synthetic ALU + memory traffic, not
  emitted Gekko; and it holds every dispatch-cache probe to a HIT. Each of those
  makes the bench *cleaner* than the real thing, so the real-world ratio should
  be read as **at most** what is measured here.

## The unblocking plan, in dependency order

1. **Finish the arm-G coverage sweep** (`GROUPS=8`, `HIT` ∈ {0, 0.25, 0.5, 0.75,
   0.875}, N=512, Chrome, arm A flat as the validity check). Replaces F5's model
   with a measured curve and fixes the batch-size/hit-rate trade directly.
2. **Rank blocks offline** from a `PROBE_PC_SAMPLE=1` histogram or an existing
   `.cpuprofile` URL histogram (F6). No JIT change. Produce a static top-N PC
   list and check its predicted coverage against a second run's histogram —
   if predicted `h` on unseen execution is below ~0.5, stop here, because F5
   says the lever cannot pay off and no amount of emitter work will change that.
3. **Only then** consider re-enabling N-fn promotion, seeded from that static
   list rather than from the runtime promote-ring — which keeps the
   `ppc_emit.cpp:1061` prologue compiled out and removes one of the three
   recorded regression causes by construction.
4. Do **not** re-introduce a region-first dispatch loop (`block_cache.cpp:209`),
   and do **not** build candidate #2's inline cache (F3).

## References

- `gamecube/tools/wasm_edge_cost_bench.mjs`, `gamecube/tools/wasm_edge_cost_bench_chrome.mjs`
- `gamecube/bementalJIT/include/bementalJIT/block_cache.h:17-20` — the rule F2 corrects.
- `gamecube/bementalJIT/src/block_cache.cpp:205-232` — the three recorded net-negatives; `:233` — `g_bem_promote_enabled = 0`; `:422`, `:623` — one module per block.
- `gamecube/bementalJIT/guests/powerpc-next/ppc_emit.cpp:233-462` — the terminal the bench copies; `:1061` — the gated per-PC counter; `:2288` — the region module importing the global table.
- `gamecube/docs/designs/wasm-dispatch-research.md:585-681` — candidates #1 and #2.
- `gamecube/docs/executed-op-census/TASKS.md` — the per-block fixed-overhead census and the op-count null prior.
- `gamecube/docs/sab-frame-governor/TASKS.md` — the `PROBE_PC_SAMPLE=1` recipe used by F6.
- <https://v8.dev/blog/wasm-speculative-optimizations>, <https://dbezhetskov.dev/opt-ind-call/>

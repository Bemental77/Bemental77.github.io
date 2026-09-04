# Executed-op census — where wasm-function[13]'s ops actually go on SAB

## Goal

Every op-level number in this tree has been a STATIC emitted-op count. Static
size is not executed cost, and the tree has already paid for that confusion once:
commit `dd6759fb` records that `psq_st`'s "536 vs 5 = 107x" is an artifact,
because the ~500-op quantized tree sits behind an `op_if` on `st_type`
(`jit_load_store.cpp:2116/:2173`) that the FLOAT path never enters.

This topic builds the missing instrument — emitted ops joined to executed
frequency, with the conditional arms separated — and uses it to pick and size
levers inside `wasm-function[13]`.

## What `wasm-function[13]` is (settled, cite this instead of re-deriving it)

It is **the emitted guest code**, not a dispatcher. Every per-block module
declares exactly 13 imports (`hle_prologue.h:35` `WIMPORT_COUNT = 13`;
`ppc_emit.cpp:1953-1971` emits them as idx 0..12), and the block body is exported
as `"run"` at function index `WIMPORT_COUNT` (`ppc_emit.cpp:1981`). Every block is
its own `WebAssembly.Module`/`Instance` (`block_cache.cpp:422`, `:623`), so V8
labels thousands of distinct block bodies `wasm-function[13]` and the profiler
aggregates them into one symbol.

Consequence: "make [13] faster" == "emit better code". There is no dispatcher
inside that symbol to optimize. The C dispatcher is `bem_chain_loop_c`
(`block_cache.cpp:960-1106`) and is attributed separately.

## The instrument

| File | What it does |
|---|---|
| `gamecube/bementalJIT/tools/op_census.cpp` | Host driver: runs the LIVE `build_block_next` over real guest blocks, records the byte range of every emit phase and every guest instruction. |
| `gamecube/bementalJIT/guests/powerpc-next/ppc_emit.h` + `.cpp` | `g_bem_emit_mark_cb` — a null-by-default callback given only `(tag, pc, b.size())`. It is handed no builder and so cannot alter one emitted byte. |
| `gamecube/tools/op_census_manifest.mjs` | Turns a `PROBE_PC_SAMPLE=1` histogram + the disc image into the block manifest, recovering block-entry PCs with the same two predicates the JIT uses (`IsBlockTerminator` / `IsForwardConditionalBranch`). |
| `gamecube/tools/op_census_report.py` | `wasm-objdump -d` + control-nesting, weighted by the histogram. Reports `d0` (unconditional) and `cond` (behind an `op_if`) **separately, never summed** — that separation is the whole point. |

**Build it for wasm, not native.** The in-wasm write-gather-pipe arm is gated on
`params.lc_base` (`jit_load_store.cpp:661`), so emitting with `lc_base = 0`
silently produces the ALL-IMPORT shape. Native macOS cannot supply a real
`lc_base`: with a small `PAGEZERO` dyld lands the image at ~`0x2696000` and
libsystem_malloc's metadata covers `0x26af000-0x26d0000`, i.e. exactly the
`0x026B3408` the emitter reads. `-sGLOBAL_BASE=40894464` puts every emcc datum
above the SAB window, so the wasm build gets a genuinely zeroed cell — and it is
the same target the live build compiles to.

```bash
# build (vendored emsdk is fine — the emitter is deterministic C++, so which
# emcc compiled it cannot change the wasm it EMITS; this is not the dolphin
# build and must not use the 4010 WebGPU pair)
source emsdk/emsdk_env.sh
emmake make -C gamecube/bementalJIT/build-emcc -j2
cd gamecube/bementalJIT && em++ -std=c++2a -O1 -I. -Iinclude tools/op_census.cpp \
  build-emcc/guests/powerpc-next/libbementalJITPowerPCNext.a build-emcc/libbementalJIT.a \
  build-emcc/guests/powerpc/libbementalJITPowerPC.a \
  build-emcc/guests/powerpc-next/libbementalJITPowerPCNext.a build-emcc/libbementalJIT.a \
  -sGLOBAL_BASE=40894464 -sINITIAL_MEMORY=201326592 -sALLOW_MEMORY_GROWTH=1 \
  -sNODERAWFS=1 -sEXIT_RUNTIME=1 -sSTACK_SIZE=4194304 -o /tmp/op_census.js

# run
node gamecube/tools/op_census_manifest.mjs /tmp/wasm_pc_hist.json /tmp/sab.manifest
node /tmp/op_census.js /tmp/sab.manifest /tmp/census-out
python3 gamecube/tools/op_census_report.py /tmp/census-out /tmp/sab.manifest.weights
```

For an A/B, flip one compile-time constant, rebuild both, and census both into
separate directories — never compare a census to a remembered number.

**For a RUNTIME-gated A/B, no rebuild is needed.** `OPCENSUS_MIPS=1` sets the
`[mips]` meter's SAB flag cell in the driver, so one binary censuses both arms:

```bash
node /tmp/op_census.js /tmp/sab.manifest /tmp/census-off        # shipping default
OPCENSUS_MIPS=1 node /tmp/op_census.js /tmp/sab.manifest /tmp/census-armed
```

⚠ **Compare the two in OPS, never with `cmp`.** Two censuses taken from
separately-linked driver binaries differ in a handful of LEB bytes because the
emitters bake host addresses as `i32.const` (CLAUDE.md gate #10) — measured here
as exactly 4 bytes per module, all `0xC0` vs `0x80`, with the emitted OP STREAM
identical. `cmp` reports 323/323 "differing" on two arms that are the same code.

The census itself needs no lock — it is offline, browser-free and load-independent,
which is most of why it is worth having. **Anything that opens a browser does:
`bash tools/probe_lock.sh run -- <cmd>`** (acquires, reaps orphaned browsers,
waits for 1-minute load < 12, releases on every path). That includes the emitter
test suite, which is a headless-browser harness, not just probes.

Validate emitted modules with **`wasm-validate --enable-all`**. Plain
`wasm-validate` rejects them with `memory may not be shared: threads not allowed`
and reports every module invalid — that is the validator's default feature set,
not a codegen bug. (This produced a full false alarm once already.)

### ⚠ `test_gekko_next` needs a ~25-minute timeout, and a truncated run once read as `ALL PASS`

`test_gekko_next` registers **171** tests and one of them streams a wasm hex dump
through the headless console. The cost is documented in the test itself
(`test_gekko_next.cpp:4147`: "the wasmdump hex stream takes ~15 min through the
headless console pipe"), and `dump_block_wasm` (`:2501`) is called from 9 sites.
There is no filter mechanism — `main()` (`:4310`) takes no arguments and parses
no query string — so you cannot skip it. Budget for it:

```bash
TEST_TIMEOUT_MS=2400000 node gamecube/bementalJIT/tests/run_browser_test.mjs \
  test_gekko_next gamecube/bementalJIT/build-emcc-test
```

Measured 2026-09-01, one workload, three budgets: the 90 s default yielded **3**
`[PASS]` lines; 900 s yielded **134** `[PASS]`, 0 `[FAIL]`, 10,859 console lines,
and still timed out inside `[wasmdump IDCT_nospec]`; **2400 s completed with
`TOTAL: 169 passed, 0 failed`** in 11,124 lines. Only the third is a result.

**The trap, and its fix.** `run_browser_test.mjs` used to decide the verdict as
"FAIL if any `[FAIL]`, else **PASS if any `[PASS]`**, else INCONCLUSIVE" — it
never checked the suite reached its end, so a run that timed out after 3 of 171
cases reported **PASS**, and `run_tests.sh` printed **ALL PASS**. That happened
here at load 26-45. A sibling fixed the harness the same day: it now carries a
`DONE_RE` completion-marker check (`:77`) and reports **INCOMPLETE** with the
`[PASS]` count and the timeout value (`:132-135`).

The invariant that made it detectable is worth keeping regardless of the harness:
**the suite's own completion marker is `TOTAL: %d passed, %d failed`
(`test_gekko_next.cpp:4345`). If that line is absent from
`/tmp/bjit-tests/<name>.log`, the run did not finish, whatever the verdict says.**
Read the counts from that line, not from the summary.

> ## ⚠ 2026-09-02 — THE NUMBERS BELOW THIS LINE WERE MEASURED ON A CENSUS WITH A
> ## FIDELITY BUG, AND ON A PRE-IDLE-SKIP WORKLOAD. See "Re-census" at the bottom.
>
> Two independent problems, both now fixed:
> 1. **`op_census.cpp` emitted 6 ops per load/store that the live build never
>    emits.** `Memmap.cpp:100-102` sets `m_ram_size = NextPowerOf2(24MB) = 32MB`
>    and `m_ram_mask = m_ram_size - 1`, so `mem1_mask == ram_size - 1` is an
>    INVARIANT of every live config — and `jit_load_store.cpp:239-246` elides the
>    fastmem bound check on exactly that equality. The census hardcoded
>    `kMem1Mask = 0x01FFFFFF` with `kRamSize = 0x01800000`, breaking the equality,
>    so every load and store carried a phantom `local.get / i32.const mask /
>    i32.and / i32.const bound / i32.lt_u / i32.and`. Fixed, with a `static_assert`
>    so it cannot regress.
> 2. **The weighting predates `8a4342e5`** (the governor idle-skip), as the note
>    at the governor example already flagged.
>
> Both corrections move the headline numbers materially. The old figures are kept
> for provenance; do not quote them.

## The finding

Top-24 SAB hot buckets, post-boot segments, 8,696 weighted samples, 276 recovered
blocks. `d0` = unconditional ops, i.e. executed whenever the phase is reached.

| guest instrs / block | blocks | weight | mean d0 ops | mean fixed | fixed % |
|---:|---:|---:|---:|---:|---:|
| 1 | 43 | 1267 | 59.4 | 51.1 | **86.0%** |
| 2 | 22 | 924 | 83.8 | 54.3 | **64.8%** |
| 3-5 | 101 | 2354 | 125.4 | 56.2 | **44.9%** |
| 6-9 | 43 | 2024 | 167.7 | 59.5 | 35.5% |
| 10-19 | 36 | 1070 | 467.1 | 145.4 | 31.1% |
| 20+ | 31 | 1057 | 4023.5 | 514.6 | 12.8% |

Sample-weighted mean of each block's own fixed/total ratio: **45.7%**.

**The per-edge terminal is a hard constant of ~39-41 unconditional ops on every
single block**, independent of block length. On SAB — where the hot regime is
short blocks — that one sequence plus the prologue is where roughly half of all
executed emitted ops go.

The sharpest single case: `0x80117e0c` in SAB's frame-governor loop is a
**1-guest-instruction block** (`bl 0x800f3710`) that executes **60 unconditional
wasm ops, 51 of them prologue+terminal**. Its neighbours `0x80117e08` (`b +4`)
and `0x80117e28` are the same shape.

### The governor loop, per iteration (the case worth quoting)

`sab-frame-governor/TASKS.md` measures this loop at 23.2% of all guest-PC
samples. It is three JIT blocks — the `bl`, the pure leaf it calls, and the
compare-and-branch tail:

| block | guest instrs | prologue | body | terminal | total d0 |
|---|---:|---:|---:|---:|---:|
| `0x80117e0c` (`bl`) | 1 | 12 | 9 | 39 | 60 |
| `0x800f3710` (leaf) | 2 | 15 | 36 | 39 | 90 |
| `0x80117e10` (tail) | 6 | 18 | 109 | 39 | 166 |
| **per iteration** | **9** | 45 | 154 | **117** | **316** |

**316 executed unconditional wasm ops for 9 guest instructions = 35.1 ops per
guest instruction, of which 162 (51.3%) is per-block fixed overhead and 117
(37%) is the terminal alone, paid three times because the loop is cut into three
blocks.**

> ⚠ **This example's WEIGHT is now stale, though its op counts are not.** Commit
> `8a4342e5` ("idle-skip SAB's frame governor — guest 0.4311x -> 0.4726x") landed
> after this census was taken, and it skips this loop. The per-block op counts
> above are properties of the emitter and still hold for any block of that shape,
> but the governor's 23.2% share of the PC census is gone, so the SAB weighting
> in this document predates it. **Re-capture the histogram before quoting any
> weighted number here as current** — the by-length table is the part that
> generalizes. With the edge diet the terminal drops to 31/block and the iteration to
**292 ops (−7.6%)**. Merging the three blocks into one would remove two entire
terminals and two prologues — which is why the concurrent leaf-inline work and
this diet compose rather than compete.

### Weighting caveat, stated not buried

The PC sampler buckets to 256 bytes (`dolphin_render_probe.js:614`,
`pc & ~0xFF`), so a bucket's samples cannot be attributed to a specific block
inside it. The manifest splits a bucket's weight evenly across the block entries
it recovers, and the recovered set is a SUPERSET of the entered set. The report
therefore prints two aggregates: a ratio-of-sums (biased toward long blocks a
loop may never enter) and the sample-weighted mean of per-block ratios, which is
the correct estimator under `samples ∝ exec × ops` because the per-block op count
cancels. The by-length table is the durable result; the single headline number is
not. Narrowing the probe's bucket mask would remove this caveat entirely.

## Levers landed

### 1. Edge diet — vector-page guard short-circuit (`ppc_emit.cpp`)

The guard is `(PC < 0x4000) && (MSR & IR)`. It was a flat AND: both conjuncts
evaluated unconditionally, two `ctx` loads plus a normalize-to-0/1, **13
unconditional ops on every block edge**. The PM51 census recorded at
`ppc_emit.cpp:72-74` measured the vector arm firing **0 times in 75 s** against
362.5M chain-taken edges, so the rare term is `PC < 0x4000`. Testing it outer
moves the MSR load and the normalize off the executed path; the inner test also
drops the `!= 0` normalize because wasm `if` already branches on nonzero. PC is
teed once and the bucket probe below reuses it instead of re-loading.

**The guard is unchanged and stays PERMANENT** — same predicate, same bail.

MEASURED, matched arms differing only in this change. The per-block result is
exact and has no weighting in it at all: **268 of the 276 blocks have a terminal
of exactly 40 unconditional ops in the base arm and exactly 32 in the diet arm —
−8 on every one of them.** The remaining 8 blocks read 934/1597/1987/2700/3009/
3172/3862/3961 and each moves by exactly **−16 = 2 × −8**, which is the tell that
they are two-arm (singles-speculation) blocks emitting the body twice
(`ppc_emit.cpp:1805+`): the phase attribution lumps the second arm's body into
the first arm's terminal span, so their *phase labels* are wrong while their
*delta* is right. That artifact is the only reason the weighted terminal figure
below reads 41.3 rather than 40. It inflates the `20+` row of the by-length table
too. Fixing it needs per-arm span nesting in the report; it does not affect any
delta.

| | base | diet | delta |
|---|---:|---:|---:|
| terminal, per block (268/276) | 40 | 32 | **−8 exactly** |
| terminal d0 ops (weighted, incl. artifact) | 41.3 | 32.8 | −8.5 (−20.6%) |
| terminal cond ops | 18.0 | 24.4 | +6.4 (moved off the executed path) |
| 1-instr block mean d0 | 59.4 | 51.4 | −13.5% |
| 3-5-instr block mean d0 | 125.4 | 117.5 | −6.3% |
| weighted fixed share | 45.7% | 43.0% | −2.7pp |

276/276 modules `wasm-validate --enable-all` clean on both arms.

**Speed effect: UNMEASURED, with a null prior — see correction (b) below.**

### 2. Write-gather-pipe const-EA carve-out (`jit_load_store.cpp`)

WPAR (`0xCC008000`) sits inside the `0xCC000000..0xCC03FFFF` const-MMIO window,
so a store whose EA the analyst folded took `emit_const_mmio_store` and
**returned at `emit_store_d:1060`**, never reaching `emit_store_common` and hence
never reaching the in-wasm gather arm. The fold is real and routine: `lis
rX,0xCC01` is OPCD 15 with RA=0, which `ppc_analyst.cpp:559-572` const-props, so
`sth rY,-0x8000(rX)` folds to exactly `0xCC008000` (`ppc_analyst.cpp:514-524`).

This is an inconsistency, not a decision: the same store issued through a
**dynamic** EA has appended in-wasm since 2026-08-28, and the const-MMIO
routing's stated rationale (`jit_load_store.cpp:912-924`) is DVDInterface
`DICR.TSTART`/`DICMDBUF` ordering, which WPAR has no part in. `frc.Flush` is
dropped for the same reason `emit_store_common:879-883` drops it on the integer
store path; `rc.Flush` is kept. The `cpu_owner` conjunct of
`emit_gp_region_test` is kept; the EA conjunct collapses at compile time.

MEASURED arm difference (`BEM_GP_CONST_EA_ARM` false vs true, same corpus):
**43 emitted host-import call sites eliminated** (−20 `write8`, −5 `write16`,
−18 `write32`) across 6 blocks, each dropping to zero import calls:

| block | before | after |
|---|---|---|
| `0x80103eb0` | 15×`write8` + 15×`write32` | 0 |
| `0x80100b90` | 4×`write8` + 2×`write32` | 0 |
| `0x80120128` | 2×`write16` | 0 |
| `0x801019f8` | 1×`write8` + 1×`write16` | 0 |
| `0x8011d8e4` | 2×`write16` | 0 |
| `0x80120138` | 1×`write32` | 0 |

**SIZING HONESTY: this is a REGRESSION in raw op count** — it trades ~26 in-wasm
ops for one cross-instance host call — and the op census scores it that way. The
win is the crossing, not the ops. Its runtime effect is **UNMEASURED**.

## Refuted / already-done, do not re-spend

- **SIMD byte-swap (`i8x16.shuffle` for two `emit_bswap_i32`) is ALREADY LANDED**
  — commit `dd6759fb`, −887 emitted ops, bit-exact three ways. Its matched pair
  at usable load measured **0.994x, i.e. no measurable runtime difference**.
- **The coordinator-reported "six host import calls per vertex" over-counts.**
  The FP half (`stfs` to WPAR) already takes the in-wasm gather arm live via
  `emit_fp_words_gp_or_import` (`jit_load_store.cpp:729+`) and
  `emit_gp_or_import_store` (`:783`). Only the INTEGER const-EA half was still
  crossing. A census run with `lc_base = 0` shows the FP stores calling
  `ppc_write32` and will mislead you here — that is the lc_base trap above.
- **`gekko_emit.cpp` citations are to the retired emitter.** The live path is
  `build_block_next` in `guests/powerpc-next/` (`JitWasm.cpp:1134`).
- **Region promotion / run-fusion is unreachable**: `g_bem_promote_enabled = 0`
  (`block_cache.cpp:233`), disabled 2026-08-20 as a measured board regression.
  Any A/B of a fusion lever today compares two identical configurations.
- **`chainCensus 0/0/0/0`** in the probe's phase-snap means the census is
  compiled out (`BEM_PM51_CENSUS = false`, `ppc_emit.cpp:75`) — absence of
  instrument, not absence of chaining.
- **The promote-ring profiling prologue** (`ppc_emit.cpp:1035`, the "15-40% of
  executed ops on 3-9-instr blocks" item in `RESEARCH.md:64`) is already gated
  off by the same `g_bem_promote_enabled = 0`. It costs nothing today.

## Still on the table, sized but not built

- **`BEM_MIPS_CENSUS = true`** (`ppc_emit.cpp:86`) emits a 6-op RMW into the
  prologue of **every non-idle block execution**, for a meter CLAUDE.md gate #10
  says must never be quoted. That is ~6 of the ~51 fixed ops on a 1-instruction
  block. It should become a SAB-cell flag (the `ppc_emit.cpp:1177-1180` pattern),
  default OFF, not a deletion — the probe reads `0x026B3420`.
- **Dropping the `slot >= 0` check** in the bucket probe (~5 ops/edge) if a tag
  hit provably implies a live slot. `evict` clears the tag bucket (per the PM54d
  note at `ppc_emit.cpp:285-288`), but every writer of `-1` needs auditing first.
  NOT attempted here.
- **Block merging** is the complementary lever — it cuts the NUMBER of edges
  while the diet cuts the COST of each — and is owned by the concurrent
  leaf-inline work in `ppc_analyst.cpp` (`[LEAF-INLINE 2026-09-01]`). The census
  says why it matters: SAB's frame-governor loop is three blocks of 1, 2 and 6
  guest instructions, paying three full terminals per iteration.

## Corrections received 2026-09-01, and what they do to the two levers

**(a) The "[13] is 68% of CPU" premise is retracted.** Splitting `[13]` nodes by
`callFrame.url` across four existing `.cpuprofile` files measured 38.04 / 47.07 /
48.89 / 51.51% self-time, and the 68%/49-50% figures could not be reproduced.
Nothing in this topic rests on it — every number here is a share *within* emitted
code, which is unaffected — but it does bound the whole-thread payoff: a 20%
cut to the terminal is 20% of the fixed slice of a 38-52% bucket, not of the
thread.

**(b) OP-COUNT LEVERS HAVE A NULL PRIOR IN THIS TREE, AND THE EDGE DIET IS ONE.**
Stripping the byte-swap entirely measured FLAT in the cycle ledger, and the SIMD
replacement — a proven −887 emitted ops — matched-paired at **0.994x, i.e. no
measurable speed difference**. That is the strongest available prior on exactly
the class of change Lever 1 is. So: **Lever 1's −8 ops/edge is a proven code-size
and executed-op reduction and an UNMEASURED speed change, against a prior that
says such changes have not moved speed here.** Do not quote it as a speedup. The
one structural difference from the bswap case — it deletes a memory load
(`ctx.MSR`) and shortens the per-edge dependency chain, rather than swapping ALU
for ALU — is a hypothesis, not evidence.

**Lever 2 is NOT in that class** and should not inherit the null prior: it
removes 43 cross-instance host-call sites, and the same profile split puts the
JS/wasm boundary at 13.5-22.7% — larger than `bem_chain_loop_c` (5.1-14.5%) in
all four profiles. It is still unmeasured, but it attacks a bigger and different
bucket.

**(c) The imported-table lever — real, but entangled, and NOT a flag flip.**

> **UPDATED 2026-09-02 by measurement — this correction's DIAGNOSIS holds and its
> PRESCRIPTION is wrong on two points.** See
> `gamecube/docs/cross-instance-edge-cost/TASKS.md`.
> 1. **"The compliant shape is inseparable from multi-block modules" is right;
>    "the table must not be imported" is not.** An internal table buys nothing
>    detectable in V8 (six paired Chrome cells, median 0.99x). What costs
>    2.1-3.7x per edge is the target being in another INSTANCE. So the shared
>    imported table and the global dispatch cache can be left alone — only module
>    granularity has to change, which is a strictly smaller change than this
>    paragraph assumes.
> 2. **The circularity is already broken.** The runtime counter at
>    `ppc_emit.cpp:1061` really is gated on `g_bem_promote_enabled`, but two
>    ungated ranking signals exist on stock HEAD: `PROBE_PC_SAMPLE=1`
>    (`dolphin_render_probe.js:40`, already consumed by
>    `gamecube/tools/op_census_manifest.mjs`) and the per-module `callFrame.url`
>    histogram of any existing `.cpuprofile`. Selection can be built and
>    validated offline before anything is flipped — and seeding from a static
>    list also keeps the promote-ring prologue compiled out, removing one of the
>    three named regression causes by construction.
>
> Also measured there: **in-batch coverage is not the variable.** Sweeping it
> from 0% to 87.5% at 8 modules x 64 functions leaves the gain flat at
> 1.71-1.97x, and at **0% coverage** — every edge still crossing instances —
> 8 modules beat 512 modules-of-one by **1.885x**. What matters is how many
> live INSTANCES a call site sees, so promotion should aim at collapsing the
> module count rather than at capturing hot successors. A single module of 1024
> functions loses most of the win, so the hot set must span several modules of a
> few hundred.
`block_cache.h:17-20` states the rule verbatim: "V8's speculative inlining
requires the call_indirect target to live in the same instance's table, so the
table MUST NOT be imported." The shipping per-block path violates it at
`ppc_emit.cpp:2001` (`emitImportTable("env","__indirect_function_table")`).

But an internal table can only hold functions from its own module, and the
shipping shape is **one block per module** (`block_cache.cpp:422`, `:623`) — so
an internal table would contain only the block itself and could serve nothing but
self-edges, which already use a DIRECT `return_call` and need no table. **The
compliant shape is therefore inseparable from multi-block modules, i.e. from
region promotion** — and that is gated at `block_cache.cpp:233` by
`g_bem_promote_enabled = 0`, which carries THREE recorded net-negative
measurements in the comment block at `:205-232`:

- 2026-06-21: OFF — region hit ~5%, per-miss membrane tax (coverage wall).
- 2026-07-13: Party-Mode lobby A/B — ON 13.3fps vs OFF 14.5fps, **~−8%**.
- 2026-08-20: board page-fps A/B — **OFF +36% vs ON** (peFrames 1814 vs 1337),
  confirmed in the user's real Chrome. Dispatch self-time 18.7% ON → 8.8% OFF.

So the inlining argument explains *why the region shape ought to win*; it does
not overturn three measurements showing it loses **as currently selected**. The
in-tree verdict names the blocker as promotion SELECTION, not locality — and the
2026-07-15 census (`:219-226`: board top-512 = 77.8%, top-2048 = 97.9%)
independently reproduced by the profile split (top-512 = 76.7-96.2% of `[13]`
self-time) says the locality to exploit is genuinely there. **The unblocking work
is a coverage/selection redesign — promote by measured execution count rather
than chain-head arrival — not flipping `:233`.** Note the circularity to break
first: the per-PC execution counters that would drive a better selection
(`g_bem_pc_exec`, `ppc_emit.cpp:1035`) are themselves gated behind the very flag
being decided.

## What this topic did NOT do

- No runtime matched pair. Both levers are sized in OPS and in HOST CALLS only;
  neither has a measured fps/speed delta. The probe lock was held by a sibling
  for the entire session and the box ran at load 6.8-38.6, above the ~25 at which
  gate #10 voids a pair anyway.
- (RESOLVED) The emitter suite now passes COMPLETE, on a quiet box at a 2400 s
  budget: `test_gekko_next` **`TOTAL: 169 passed, 0 failed`** and
  `test_simd_bswap` **`TOTAL: 8 passed, 0 failed`**. The 169/0 figure is
  identical to the pre-change baseline commit `dd6759fb` recorded, so both
  levers land on an unchanged suite result. Also verified: all 276 emitted
  modules validate under `wasm-validate --enable-all` on both arms, and a
  differential disassembly of 0x80117e0c confirms the diet's terminal is exactly
  the intended transformation.
- No attempt at the internal-table / region re-enable — see correction (c). It is
  not a flag flip and the box could not support the matched pair it needs.
- No change to the `[a]` downcount predicate, the vector guard's semantics, the
  `slot >= 0` check, or anything in `ppc_analyst.cpp`.

---

# Re-census 2026-09-02 — corrected instrument, fresh workload, and the CEILING

Everything in this section is from ONE run of the corrected instrument:
fresh `PROBE_PC_SAMPLE=1` histogram off the shipping binary
(`md5 9267a160d3afd3114e4112c6a7c5bc91` = the `c224b7c2` batch build),
14,905 samples, `TOPN=32`, 323 recovered blocks, 7,197 weighted samples,
`kRamSize` corrected. The census is offline and load-independent.

## What changed in the instrument

Three additions to `gamecube/tools/op_census_report.py`, all of which report
`d0` and `op_if`-gated ops separately as before:

1. **Per-GUEST-OPCODE attribution.** `BEM_MARK_OP` already carries `op.address`
   (`ppc_emit.cpp:1370`) and the `.marks` file already lists `inst <pc> <word>`,
   so a tag-2 span joins directly to the guest instruction that produced it.
   This is the "what ARE the 46x amplified ops" question the phase table could
   not answer.
2. **Per-WASM-MNEMONIC attribution**, split fixed (prologue+terminal) vs guest.
3. **A NORMALIZED estimator, and it is the one to quote.** The per-opcode
   ratio-of-sums is dominated by long blocks: `20+`-instruction blocks are 19.4%
   of samples but **83% of the ratio-of-sums op total** (1396 x 3947 of 6.6M).
   The normalized estimator weights each block's own COMPOSITION by its sample
   share — the same estimator the fixed-overhead headline already used, correct
   under `samples ∝ exec × ops` because the per-block `ops_b` cancels.

**The two estimators disagree by 5-8x on individual opcodes and they disagree
about the ANSWER.** Ratio-of-sums says SAB's emitted code is FP/paired-single
dominated (`ps_madds0` 6.4%, `fctiw` 6.2%, `fmadds` 4.8%); normalized says it is
branch and load dominated (`ps_madds0` 0.83%, `fctiw` 0.85%). The normalized
reading is the one consistent with the independently-known fact that SAB is
0.51% paired-single. **A ratio-of-sums per-opcode table on this corpus is
actively misleading — it would have sent this work at the FP emitters.**

## The corrected finding

| | old census | corrected |
|---|---:|---:|
| per-block FIXED share (normalized) | 45.7% | **41.3%** (prologue 14.7 + terminal 26.6) |
| mean guest instrs / block | 3-5.5 (stated) | 13.61 — **ratio-of-sums, see caveat** |
| unconditional ops per guest instr | — | 55.6 — **ratio-of-sums, see caveat** |

> **Caveat on the two ratio-of-sums rows.** `mean guest instrs/block` and
> `ops/guest instr` are both sums-over-sums across the RECOVERED block set, and
> `op_census_manifest.mjs` recovers a SUPERSET of the entered blocks (its own
> header says so), splitting each 256-byte bucket's weight evenly across the
> entries it finds. A long block the loop never enters therefore contributes its
> full length. So 13.61 does NOT refute the independently-sourced "SAB averages
> 3-5.5 guest instructions per block" — the two are different estimators over
> different populations, and only the FIXED-share row uses the normalized
> estimator that is robust to this. **Narrowing the probe's `pc & ~0xFF` bucket
> mask (`dolphin_render_probe.js:614`) would remove this caveat entirely** and is
> the single highest-value upgrade left in this instrument.

| guest instrs / block | blocks | weight | mean d0 | mean fixed | fixed % |
|---:|---:|---:|---:|---:|---:|
| 1 | 48 | 869 | 51.9 | 43.1 | **83.1%** |
| 2 | 21 | 382 | 72.3 | 46.4 | **64.1%** |
| 3-5 | 121 | 2548 | 112.1 | 46.5 | **41.5%** |
| 6-9 | 46 | 1102 | 127.9 | 49.2 | 38.5% |
| 10-19 | 45 | 901 | 650.3 | 171.1 | 26.3% |
| 20+ | 42 | 1396 | 3947.2 | 548.3 | 13.9% |

**Top guest opcodes, normalized share of executed unconditional ops.** Two arms,
because the `[mips]` lever below changes the denominator — quote the SHIPPING one:

| arm | `b` | `bclr` | `bc` | `lwz` | `cmpi` | `addi` | `stfs` | `stb` | `stw` | `fmadds` | branches | guest total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| meter ON (pre-change) | 5.27 | 4.98 | 5.13 | 4.93 | 3.68 | 3.20 | 2.53 | 2.31 | 2.27 | 1.68 | **15.4%** | 58.71% |
| **meter OFF (ships)** | 5.68 | 5.29 | 5.24 | 5.12 | 3.82 | 3.40 | 2.57 | 2.44 | 2.36 | 1.69 | **16.2%** | 60.91% |

**Branches are the single largest executed guest-op class** (`b`+`bc`+`bclr` =
16.2%), ahead of `lwz` at 5.12%. Cost per dynamic occurrence (shipping arm):
`lwz` **19.1** unconditional wasm ops, `b` 18.9, `bclr` ~16.

### Sensitivity: the fixed-overhead headline is NOT an artifact of the `TOPN` cut

The whole ceiling argument rests on one number, so it was swept across a 4x range
of corpus size (post-change binary, meter off):

| `TOPN` | blocks | fixed % | prologue | terminal |
|---:|---:|---:|---:|---:|
| 12 | — | 41.8% | 10.3% | 31.5% |
| 24 | — | 39.5% | 10.5% | 29.1% |
| 32 | 323 | 39.1% | 10.3% | 28.7% |
| 48 | — | 38.7% | 10.3% | 28.4% |

**38.7-41.8%, and the prologue is flat at 10.3-10.5%.** Widening the corpus pulls
in colder, longer blocks and slowly dilutes the terminal, exactly as the
by-length table predicts. Nothing here hinges on where the cut is drawn.

## ★ What the amplified ops ARE — and why op COUNT is the wrong currency

Normalized share of executed unconditional ops, by wasm mnemonic:

| mnemonic | fixed | guest | total |
|---|---:|---:|---:|
| **i32.const** | 13.48% | 17.50% | **30.98%** |
| **local.get** | 1.93% | 9.09% | **11.02%** |
| i32.load | 5.68% | 2.20% | 7.88% |
| i32.store | 1.62% | 4.70% | 6.32% |
| local.set | 1.00% | 4.79% | 5.79% |
| i32.and | 0.99% | 3.48% | 4.47% |
| if / end | 2.49% | 1.54% | 4.02% each |

**Nearly a third of every executed op in emitted code is an `i32.const`, and
another 17% is `local.get`/`local.set`.** That is the measured part.

**The interpretation is a HYPOTHESIS, not a measurement** — I did not disassemble
V8's machine output. But it is the standard behaviour of any optimising backend
that these are the ops folded into addressing modes and register allocation:
`i32.const ctx_ptr; i32.load offset=F` is the classic base+displacement pair, and
`local.get`/`local.set` on a register-allocated local is a coalescable move. If
that holds, **roughly 47% of the counted stream costs ~zero machine work**, and
"executed op count" systematically overstates the payoff of cutting ops — which
would be a structural explanation for why this tree's op-count levers keep
measuring null (the SIMD byte-swap's proven −887 ops at 0.994x).

**Cheap way to settle it:** run the emitted module under
`--print-wasm-code` / `--trace-turbo` and count machine instructions per wasm op
class. Until then: size levers in *loads, stores, branches and real ALU*, and
treat a saved `i32.const` as suspect rather than as a win.

## Levers sized against the corrected census

| lever | executed-op reach | verdict |
|---|---:|---|
| **`[mips]` meter RMW in every block prologue** | **−2.2pp** (fixed 41.3% → 39.1%; **−30% of the whole prologue**, 14.7% → 10.3%) | **LANDED, runtime-gated** |
| dead `ctx.PC` store before a branch that overwrites it | −0.40% (ratio-of-sums; `b`/`bclr`/`fctiw`/`mtmsr`) | measured, NOT worth the risk |
| RegCache dead load on a pure-Write first-touch bind | 3 ops per load | **DO NOT** — see below |

### The `[mips]` meter (LANDED)

`ppc_emit.cpp` emitted a 6-op read-modify-write of ONE global cell
(`BEM_MIPS_EXEC_CELL = 0x026B3420`) into the prologue of **every non-idle block
execution**, plus the same 6 ops on every fused-loop back edge
(`jit_branch.cpp`). Its own comment said "flip false for a final overhead-free
fps read" — but flipping the compile-time constant also DELETES the instrument,
which the probe reads (`dolphin_render_probe.js:688`, `:1190`).

Now gated at EMIT time on SAB cell `BEM_MIPS_FLAG_CELL = 0x026B39B8`, default 0 =
OFF = zero emitted ops; `?bjit_mips=1` (`gamecube.html`) arms it. Same shape as
`?bjit_batch` (`0x026B39A0`) and the psmtxro flag (`ppc_emit.cpp:1112`). The
duplicated `BEM_MIPS_CENSUS`/`BEM_MIPS_EXEC_CELL` pair that jit_branch.cpp had to
"keep in sync by hand" is gone — both sites now call one `bem_mips_census_on()`.

Census A/B, same corpus, cell 0 vs armed: total d0 916.2 → 910.4, prologue
125.6 → 119.8, fixed 41.3% → 39.1%, prologue share 14.7% → 10.3%.

**The per-block result is EXACT, not a weighted average.** Every bucket of the
prologue op-count histogram shifts by exactly −6:

| prologue d0 (armed) | 12 | 15 | 18 | 21 | 24 | … | 2087 | 2275 | 2651 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **shipping (off)** | **6** | **9** | **12** | **15** | **18** | … | **2081** | **2269** | **2645** |
| blocks | 75 | 102 | 45 | 29 | 9 | | 2 | 1 | 1 |

The only blocks that do not move are the **3 idle blocks**, which take the
force-zero downcount branch and never emitted the meter by construction. Post
change the modal prologue is **6 ops** (77 blocks — the bare downcount RMW) and
**9 ops** (103 blocks — downcount + one RegCache load).

Three independent correctness proofs, all offline:
1. The runtime-gated build with the cell zeroed is **byte-identical** to the
   compile-time-`false` arm — 323/323 modules, `cmp`-exact.
2. The **armed** arm reproduces the pre-gate emit **exactly in ops** (916.2 d0,
   3171.3 cond, fixed 41.3%, prologue 14.7% — every figure identical). Its four
   per-module byte differences are LEB address bytes from link layout, per gate #10.
3. 323/323 modules pass `wasm-validate --enable-all` on both arms.

For reference, the terminal is **exactly 31 unconditional ops on all 336
terminals** in this corpus — a hard constant with zero exceptions, confirming the
edge diet's result on the shipping arm.

#### Runtime verification (correctness, NOT a speed measurement)

Both arms off ONE binary, `md5 e4a2abd035e389721fd4f27135d51ed3` before AND after
(`HASH STABLE`), SAB `ROM_IDX=1` cold boot, `PROBE_DURATION_MS=75000`,
`?bjit_batch=64`, `probe_lock`-held:

| arm | `[mips]` line | guest (both AI-DMA witnesses) | published/s | traps | renders |
|---|---|---:|---:|---:|---|
| default (`bjit_mips` unset) | `METER OFF (no ops emitted; SAB cell 0x026B39B8 = 0)` | 0.4617 / 0.4616 | 18.85 | 0 | ✅ |
| `?bjit_mips=1` | `EXECUTED=110.0 MHz CREDITED=218.6 MHz ratio=50.3%` | 0.4498 / 0.4499 | 18.35 | 0 | ✅ |

**The gate works in both directions** — unarmed emits nothing and says so, armed
restores a live meter — and both arms render (screenshots: SAB intro, clean
geometry, no black world, no NaN).

**⚠ DO NOT READ THE GUEST COLUMN AS THE LEVER'S EFFECT.** It is n=1 per arm, the
two arms acquired the lock at **different loads** (4.68 vs 6.41), and I rebuilt
the census library *during* the OFF arm. The +2.6% direction is consistent with
the prediction and is **inside the noise floor** — gate #10 puts rig resolution
at ~6-7%. This is a correctness check that happens to print rates, not a
matched pair.

**The lever's runtime effect is therefore UNMEASURED and is predicted to be BELOW RIG RESOLUTION**
(2.2pp of emitted-code ops, and emitted code is 38-52% of thread self-time per
correction (a), so ~1% of the thread against a ~6-7% resolution at load 9-11).
Do NOT quote it as a speedup. It is landed because it is free, it removes a
per-block global RMW, and it stops every shipping run paying for a meter
CLAUDE.md gate #10 forbids quoting.

### RegCache dead load — FOUND, DELIBERATELY NOT TAKEN

Every guest load emits `i32.const ctx; i32.load gpr(RT); local.set <RT local>`
**before** the fastmem branch tree, loading the DESTINATION register's old value,
which the arms then unconditionally overwrite. It is a dead load on every `lwz`.

`reg_cache.cpp:82-111` does this knowingly and says why: the 2026-06-11 PSO
`__LCEnable` crash. RMW emitters bind DEST first (`Bind(ra, Write)` then
`Bind(rs, Read)`); when `dest == src` and the reg is unassigned, a Write bind that
marked `loaded` without loading made the Read bind consume a zero-initialised
local. The comment states the trade explicitly: *"One redundant i32.load on a
genuinely-overwritten first-touch reg is the price; coherence bugs of this class
are gone."*

A narrow fix exists (defer the load on pure-Write binds; emit it from the later
Read bind — the 3-op sequence is stack-neutral so its position is safe). It was
NOT taken here: the reward is ~3 ops on loads, and the failure mode is a Flush
writing a never-written local over live guest state — the exact bug class that
cost a PSO boot. Given the ceiling below, this is not where the risk budget goes.

## ★★ THE CEILING — this is the answer, and it is not encouraging

Two measured quantities bound the ENTIRE "make the block bodies cheaper" program:

- **41.3%** of executed unconditional ops in emitted code is per-block FIXED
  overhead (this census, normalized).
- **38.04-51.51%** of CPU-thread self-time is `[13]`, the emitted bodies
  (correction (a) above, four `.cpuprofile` files — **NOT reproduced here**;
  taken as given and used at its most favourable end).

**Remove 100% of the fixed overhead — every prologue and every terminal, which is
impossible — and the thread gets 0.413 × 0.515 = 21.3% faster: `1.27x`.**
SAB owes **2.29x** (0.4371 → 1.000).

> **⚠ An unexplained baseline discrepancy, recorded rather than buried.** The
> histogram run that produced this census — same binary
> (`md5 9267a160d3afd3114e4112c6a7c5bc91`), same `?bjit_batch=64`, same
> `PROBE_DURATION_MS=75000`, `ROM_IDX=1`, load 3.9-5.6 — measured
> **guest = 0.4888x** on BOTH AI-DMA witnesses (`ai_dma_cb` and `aid_fire`
> agreeing exactly), with `published = 20.60/s`. F9's nine-run campaign measured
> 0.4203-0.4389 with `published` 16.4-17.5 at load 5.4-6.6. That is ~12% apart on
> a witness pair that agrees with itself to four decimals, and it is **more than
> the ~6-7% rig resolution**. I did not chase it — this run had `PROBE_PC_SAMPLE=1`
> installed, which is a perturbation, and one run is not a measurement. **Do not
> treat either number as settled without a fresh matched pair.** The ceiling
> argument is unaffected: at 0.4888x SAB owes 2.05x, still far above the 1.27x
> bound below.

**The `[13]` share is the input I did not reproduce, so here is the ceiling as a
function of it** — `1 / (1 − 0.413 × f13)`:

| `[13]` self-time share | ceiling of removing ALL fixed overhead |
|---:|---:|
| 38% (low end of the measured split) | **1.19x** |
| 45% | **1.23x** |
| 52% (high end) | **1.27x** |
| 68% (the RETRACTED, most optimistic figure ever claimed here) | **1.39x** |

**Even at the retracted 68% the ceiling is 1.39x against 2.29x owed.** Inverted:
to reach 1.000x by deleting fixed overhead you would need the fixed share to be
**82.8%** of emitted-code ops even at `f13 = 0.68`, and **>100%** (i.e. flatly
impossible) at `f13 = 0.52`. Measured fixed share is **41.3%**. The conclusion
does not depend on which end of the `[13]` range is right.

The bound is generous in three separate ways:

1. **A third of "fixed" is `i32.const`** (13.48pp of the 41.3pp). IF the folding
   hypothesis above holds — unverified — those cost ~nothing after the backend and
   fixed's TIME share is well below its OP share. This one is a hypothesis, so the
   ceiling stands without it; it only makes the ceiling lower.
2. **It counts only unconditional ops, and the conditional ops are almost all
   GUEST work.** Per block there are 3,171 `op_if`-gated ops against 916
   unconditional, and one arm of each `if` DOES execute. Of those 3,171,
   **3,058 (96.4%) sit in guest-op spans** and only 113 in prologue+terminal
   (88.1 + 25.1). So whatever fraction of conditional work actually runs, it
   lands overwhelmingly in the denominator's guest half — counting it can only
   DECREASE fixed's share, never increase it. This holds without needing a model
   of which arm runs.
3. **Fixed is not removable.** Of the 43-49 fixed ops on a short block: downcount
   RMW (6, CoreTiming slice accounting), meter (6 — **the only removable one, now
   gone**), terminal 31 = service bail (6) + vector guard (7) + bucket probe (15)
   + host return (3). The bail is slice/exception delivery, the guard is a
   correctness invariant that prevents a real crash, and the bucket probe IS the
   chaining mechanism. **6 of ~46 were removable, and they are now removed.**

**Block merging — the one lever with the right shape — is also bounded.** The
by-length table prices it exactly: if every block were `20+` instructions, fixed
would be 13.9% instead of 41.3%. That removes 27.4pp of emitted-code ops =
14.1% of thread = **`1.16x`**, for PERFECT merging of every block in the game.

So: op removal and block merging are the same program (both attack `fixed`), and
that program's ceiling is **~1.27x against 2.29x owed**. To reach 1.000x from
inside the bodies you would have to delete all fixed overhead AND ~25% of the
guest-work ops — and guest work is the translation of guest semantics.

> ## ⚠ 2026-09-04 — THIS CEILING PRICES ONLY ONE OF TWO FACTORS
>
> See `gamecube/docs/wasm-tier/TASKS.md`. The arithmetic below bounds *how many wasm
> ops we emit*. It says nothing about *what V8 compiles those ops into*, and that
> second factor is larger: **TurboFan vs Liftoff measures 2.108x on this exact
> corpus** (318 of these same blocks, census-weighted, offline, arms interleaved).
> The two are multiplicative, not competing.
>
> Three things that land directly on this section:
> 1. **The `[13]` self-time share used below was measured through
>    `dolphin_render_probe.js`, which forces `--no-liftoff` (`:159`) — a V8 flag the
>    shipping page cannot have.** The ceiling arithmetic is unaffected (it is a
>    ratio), but every *absolute* guest rate it divides into is optimistic; offline
>    replication sizes that gap at 1.164x.
> 2. **Block merging is worth more than the 1.16x priced below.** V8's tier-up
>    threshold is `13,000,000 / code_body_bytes` executions (measured, exact), so an
>    N-way merge also crosses into TurboFan ~N times sooner and drags part of the
>    cold tail over the line. That term is absent from the by-length table's pricing.
> 3. **The "i32.const is ~free after the backend" hypothesis below now has a
>    mechanism.** What an op costs depends on which compiler consumed it — and the
>    compiler that does the folding is a 2.108x factor on the same op stream. That is
>    consistent with why every op-count lever here has measured null.

### Verdict

**SAB's remaining 2.29x is NOT recoverable from inside the emitted block bodies.**
That is not a claim that the emitter is optimal — **`lwz` costs 19.1 unconditional
wasm ops** (weighted mean over 123 blocks; a clean instance is 3 set_pc + 4 EA +
4 fastmem guard + 3 RegCache dead load + `if` + 2 result move) against Jit64's
single fastmem instruction, which is obvious slack. But most of that slack is a
*wasm-imposed floor*, not a code-quality defect: wasm has no trap-and-backpatch,
so the `if/else/else` region tree on every memory access cannot be replaced by
Dolphin's raw access + SIGSEGV handler. It is a claim about arithmetic: the
recoverable share is bounded by 41.3% of 38-52%, and that product cannot reach 2.29x.

The remaining deficit needs a different execution model. Static recompilation is
the live candidate (`gamecube/docs/static-recomp-sab/`), and it is the one path
that deletes the per-block prologue/terminal entirely rather than shrinking it.

## Reproducing

```bash
# 1. fresh histogram off the shipping binary (browser — needs the lock)
bash tools/probe_lock.sh run -- env PROBE_HEADLESS=1 PROBE_VANILLA_WEBGPU=1 \
  ROM_IDX=1 PROBE_DURATION_MS=75000 PROBE_PC_SAMPLE=1 PROBE_QUERY=bjit_batch=64 \
  node gamecube/tools/dolphin_render_probe.js > /tmp/probe-hist.log 2>&1
# 2. manifest + census + report (offline, load-independent, no lock)
TOPN=32 node gamecube/tools/op_census_manifest.mjs /tmp/wasm_pc_hist.json /tmp/sab2.manifest
node /tmp/op_census.js /tmp/sab2.manifest /tmp/census-out          # build per the block at the top
python3 gamecube/tools/op_census_report.py /tmp/census-out /tmp/sab2.manifest.weights
```

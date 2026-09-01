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
node gamecube/tools/op_census_manifest.mjs /tmp/wasm_pc_hist.json /tmp/sab.manifest
node /tmp/op_census.js /tmp/sab.manifest /tmp/census-out
python3 gamecube/tools/op_census_report.py /tmp/census-out /tmp/sab.manifest.weights
```

Validate emitted modules with **`wasm-validate --enable-all`**. Plain
`wasm-validate` rejects them with `memory may not be shared: threads not allowed`
and reports every module invalid — that is the validator's default feature set,
not a codegen bug. (This produced a full false alarm once already.)

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
blocks.** With the edge diet the terminal drops to 31/block and the iteration to
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

## What this topic did NOT do

- No runtime matched pair. Both levers are sized in OPS and in HOST CALLS only;
  neither has a measured fps/speed delta. The box was at load 6.8-17 with the
  probe lock held by a sibling for the whole session.
- No change to the `[a]` downcount predicate, the vector guard's semantics, the
  `slot >= 0` check, or anything in `ppc_analyst.cpp`.

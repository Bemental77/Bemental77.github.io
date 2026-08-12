# AOT campaign — A0 board coverage + A3.1 leaf line

**Committed campaign artifact** (per the "never a session scratchpad" rule). Re-derived
2026-08-12, then **corrected the same day** — see the reconciliation below; the first cut
was measured on a contaminated build. The numbers here are the clean snapshot the A3.1 line
is planned against.

## ⚠ Measurement-hygiene rule (learned here, the hard way)

**Coverage MUST be sampled with AOT OFF** (`PROBE_AOT_KILL=1`, or a build with no AOT). An
AOT'd function runs the slowmem general path — every `psq_l`/`psq_st` becomes a JS
`ppc_read/write` import round-trip with `ppc_state.pc` pinned beforehand for fault handling —
so the guest PC *freezes* inside the import and that one function's PC-sample share explodes.
First cut sampled on the AOT-enabled A2 build and reported **PSMTXROMultVecArray at 22.17%**;
the clean re-sample (AOT killed) puts it at **1.75%**, matching three prior independent
measurements (1.62% / 1.79% via the same instrument on other board savestates). The 22.17%
was pure self-inflation; the aggregation tool was correct, the input data was dirty.

## What this is

The AOT campaign compiles Mario Party 4's hot guest functions ahead-of-time into optimized
wasm (see `gc_aot_a1_pipeline_proven` memory + commits f684885/A1, 3af4fbd/A2). A3 runs the
assembly line down this table. Two locked design constraints shape it:

1. **Interior-entry problem.** Dispatch enters functions at interior block-starts (every `bl`
   returns to one). A single-entry whole-function AOT unit captures only the head and loses
   control at the first callee — silently bleeding coverage while the census still shows hits.
   So **A3.1 compiles LEAF (call-free), single-entry functions only**; A3.2 designs the
   call-bearing machinery from A3.1's measured data.
2. **Golden strategy splits by class.** `pure_compute` (result = f(args, read-only mem), writes
   only an output pointer) → **offline direct-invocation goldens** (the PSMTX model).
   `stateful` (GX FIFO / MMIO / mutable globals) → **live shadow-verify**: N minutes of zero
   hash-mismatch on real scenes (A1's machinery), which doubles as the timing guard (AOT must
   not be slower than the JIT it replaces — very real given the impurity finding).

## Method / reproduce

```bash
# 1. board PC-sample — AOT OFF (kill=1). Sampler reads live guest PC (offset 0 = pc), 256B buckets.
PROBE_HEADLESS=0 PROBE_VANILLA_WEBGPU=1 ROM_IDX=0 \
  PROBE_LOAD_STATE="$HOME/Downloads/MarioParty4.gcs.gz" \
  PROBE_PC_SAMPLE=1 PROBE_AOT=3000 PROBE_AOT_KILL=1 PROBE_DURATION_MS=95000 \
  node gamecube/tools/dolphin_render_probe.js       # -> /tmp/wasm_pc_hist.json
# 2. resolve x symbol map, rank by share (post-load seg>=3)
node gamecube/tools/aot_coverage.mjs                # -> /tmp/aot_coverage.json + board_coverage.json
# 3. classify: leaf (no bl/bctrl/blrl inside) && single-entry (no EXTERNAL branch targets the
#    interior, BY ADDRESS not symbol name) && size>=0x40
~/gc_refs/marioparty4/build/binutils/powerpc-eabi-objdump -d \
  ~/gc_refs/marioparty4/build/GMPE01_01/main.elf > /tmp/mp4_disasm.txt
node gamecube/tools/aot_classify.mjs                # -> /tmp/aot_classify.json
```

Golden-class + adversarial single-entry confirmation: 36-agent workflow `aot-a31-verify`
(run wf_8d99c4f7) — each function independently analyzed then refuted. Clean total: **16256
post-load samples, 98.6% resolved.**

## Traps the classification caught (why by-address + adversarial verify)

- **`__save_gpr` is MULTI-ENTRY** — callers `bl _savegpr_NN` into interior labels; a
  symbol-name test misses it (objdump names them separately), the **by-address** test catches it.
- **Duplicate symbol name** — main.elf has TWO `HandleReverb` functions; symbol-name grep gave
  22 false external hits, by-address gave 29 internal / 0 external → single-entry holds.
- **Indirect calls with no static target** — `GXLoadTexObjPreLoaded`'s `blrl` returns interior →
  not leaf. The first-cut classifier gated on a resolvable target and missed it; workflow caught
  it; tool fixed (bctrl/blrl count regardless of target; operand-less insns parse).
- **objdump mis-decodes Gekko paired-single ops** (psq_l / ps_madd → VSX). Branches decode fine
  (single-entry unaffected); store/MMIO checks used raw bytes / decomp.

## A3.1 LEAF LINE — 17 functions, **23.8%** of board samples (verified single-entry, clean)

Compile in share order. `pure_compute` → offline direct-invocation goldens; `stateful` → live
shadow-verify. (Machine-readable: `a31_leaf_line.json`.)

| share% | addr | size | class | function | notes |
|---:|---|---|---|---|---|
| 6.44 | 0x801136f0 | 0x50c | pure_compute | **HandleReverb** | audio DSP (MusyX), scalar-FP, 59 blocks — the biggest single leaf target |
| 1.75 | 0x800bc8d0 | 0x118 | pure_compute | PSMTXROMultVecArray | ✅ A1/A2 pipeline (per-block slow path); whole-fn re-do is the fps test |
| 1.63 | 0x800bb57c | 0xf8 | pure_compute | PSMTXInverse | |
| 1.56 | 0x800ca0cc | 0x9c | stateful | __GXSetVAT | GX FIFO MMIO 0xCC008000 + dirtyVAT global |
| 1.31 | 0x800ce3a4 | 0x74 | stateful | GXSetTevKColor | |
| 1.25 | 0x800bbeb4 | 0x98 | pure_compute | C_MTXOrtho | |
| 1.25 | 0x800cbf78 | 0x148 | stateful | GXLoadLightObjImm | |
| 1.05 | 0x800bb460 | 0xcc | pure_compute | PSMTXConcat | reads read-only pool @0x801D |
| 1.04 | 0x800cc3dc | 0x1e4 | stateful | GXSetChanCtrl | |
| 1.00 | 0x800ceb7c | 0x104 | stateful | GXSetBlendMode | |
| 0.89 | 0x800cd190 | 0xcc | stateful | __SetSURegs | |
| 0.87 | 0x800cea7c | 0x100 | stateful | GXSetFogRangeAdj | |
| 0.80 | 0x800e23cc | 0x5c | pure_compute | __cvt_fp2unsigned | runtime fp→u32 converter |
| 0.78 | 0x800cc5c0 | 0x15c | pure_compute | GXGetTexBufferSize | **internal bctr switch** (.data table, targets interior) |
| 0.78 | 0x800bb674 | 0xc8 | pure_compute | PSMTXInvXpose | mtx.c asm (spot-verified; not in workflow set) |
| 0.71 | 0x800274f4 | 0x14c | pure_compute | GetObjTRXPtr | **internal bctr switch**; obj-transform getter (spot-verified) |
| 0.66 | 0x800c984c | 0x360 | stateful | GXSetVtxDesc | **internal bctr switch** (26 .data entries, interior); GX state |

**9 pure_compute** (offline goldens) + **8 stateful** (live shadow-verify) = **23.8%**.
15 confirmed by the workflow; PSMTXInvXpose + GetObjTRXPtr spot-verified (surfaced by the clean
re-rank). PSMTXMultVec + GXInitTexObjLOD are also leaf/eligible but fell just below the top-45
clean cut — pick them up in the tail.

## Strategic read (corroborates the prior "broadly distributed" finding)

The clean table confirms `gc_b1_template_pilot`'s verdict: **the board gap is broadly
distributed — no single >7% lever.** HandleReverb (6.44%) is the largest leaf function and it's
scalar-FP audio, not SIMD matrix. The matrix-SDK family sums to ~8% across several small
functions (family-level win). The A3.1 leaf ceiling is **~24%**, not 40% — so **A4's 60%
firmly requires A3.2's call-bearing machinery** (FaceDraw 5.2%, SelectThread 3.08%, HuSprDisp
3.04%, SetTevStageTex 2.03%, SetEnvelop 1.9%, Hu3DMotionExec 1.85%, MesDispFunc… ≈ the other
half). PSMTX at 1.75% means A1/A2 proved the pipeline on a *small* function — correct for a
pipeline MVP, but the fps case rests on the whole-function body-quality win measured per batch.

## Emitter requirements A3.1 surfaced

- **Intra-function computed jumps (jump tables).** GXGetTexBufferSize, GXSetVtxDesc, GetObjTRXPtr
  use `mtctr; bctr` switches whose case tables live in `.data` (all targets interior). The
  whole-function emitter must resolve these internally, not exit to the runtime dispatcher.
- Everything else is straight-line + `bdnz`/`bc` internal loops (already handled).

## Excluded from A3.1 (from top-45, clean)

- **Call-bearing → A3.2**: FaceDraw (5.2%), SelectThread (3.08%), HuSprDisp (3.04%),
  SetTevStageTex, SetEnvelop, Hu3DMotionExec, GXInitTexObj, MesDispFunc, salBuildCommandList,
  HuSprOrderEntry, GXLoadTexObjPreLoaded (indirect blrl), … ≈ half the board.
- **Multi-entry helper**: __save_gpr (1.08%) — EABI save/restore, entered mid-body.
- **Too small (single-block, no whole-fn headroom → call-site-inline candidates instead)**:
  PSMTXIdentity (3.73%!), DSPCheckMailToDSP (2.05%, DSP MMIO), WriteMTXPS4x3 (1.91%).

## The line from here

1. ✅ Re-derive + commit this table — **on a clean (AOT-off) build**.
2. **A3.1**: whole-function emit (the fps mechanism — not A1's per-block slow path; likely the
   `region_relink` merge path + `.data` jump-table handling) → generalize `aot_compile.cpp` to a
   function spec driven by `a31_leaf_line.json` → walk the line in share order (HandleReverb
   first) with class-appropriate proofs + a MIPS/timing gate per batch (shadow-verify guards
   AOT ≥ JIT speed).
3. **A3.2**: call-bearing machinery from A3.1's measured results.
4. **A4**: board A/B at ~60% (A3.1 leaf ~24% + A3.2 call-bearing) = the Summit-1 number.

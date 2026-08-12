# AOT campaign — A0 board coverage + A3.1 leaf line

**Committed campaign artifact** (per the "never a session scratchpad" rule). Re-derived
2026-08-12. Regenerate with the two tools below; the numbers below are the snapshot the
A3.1 line is planned against.

## What this is

The AOT campaign compiles Mario Party 4's hot guest functions ahead-of-time into optimized
wasm (see `gc_aot_a1_pipeline_proven` memory + commits f684885/A1, 3af4fbd/A2). A3 runs the
assembly line down this table. Two locked design constraints shape it:

1. **Interior-entry problem.** Dispatch enters functions at interior block-starts (every `bl`
   returns to one). A single-entry whole-function AOT unit captures only the head and loses
   control at the first callee — silently bleeding coverage while the census still shows hits.
   So **A3.1 compiles LEAF (call-free), single-entry functions only**; A3.2 designs the
   call-bearing machinery (multi-entry table / dispatcher round-trip) from A3.1's measured data.
2. **Golden strategy splits by class.** `pure_compute` functions (result = f(args, read-only
   mem), writes only an output pointer) get **offline direct-invocation goldens** (the PSMTX
   model). `stateful` functions (GX FIFO / MMIO / mutable globals) can't be golden'd offline —
   their proof is **live shadow-verify**: N minutes of zero hash-mismatch on real scenes (A1's
   machinery), which doubles as the timing guard (AOT must not be slower than the JIT it replaces).

## Method / reproduce

```bash
# 1. board PC-sample (MP4 board savestate; sampler reads live guest PC per 10s segment)
PROBE_HEADLESS=0 PROBE_VANILLA_WEBGPU=1 ROM_IDX=0 \
  PROBE_LOAD_STATE="$HOME/Downloads/MarioParty4.gcs.gz" \
  PROBE_PC_SAMPLE=1 PROBE_DURATION_MS=95000 \
  node gamecube/tools/dolphin_render_probe.js   # -> /tmp/wasm_pc_hist.json
# 2. resolve PC histogram against MP4's symbol map, rank by share (post-load seg>=3)
node gamecube/tools/aot_coverage.mjs            # -> /tmp/aot_coverage.json + board_coverage.json here
# 3. classify: leaf (no bl/bctrl/blrl inside) && single-entry (no EXTERNAL branch targets the
#    interior, by ADDRESS not symbol) && size>=0x40, using the full main.elf disasm cache
~/gc_refs/marioparty4/build/binutils/powerpc-eabi-objdump -d \
  ~/gc_refs/marioparty4/build/GMPE01_01/main.elf > /tmp/mp4_disasm.txt
node gamecube/tools/aot_classify.mjs            # -> /tmp/aot_classify.json
```

Golden-class + adversarial single-entry confirmation was done by a 36-agent workflow
(`aot-a31-verify`, run wf_8d99c4f7): each function independently analyzed then refuted.

### Sample: 16289 post-load board samples, 98.8% resolved.

## Traps the classification caught (why by-address + adversarial verify)

- **`__save_gpr` is MULTI-ENTRY** — callers `bl _savegpr_NN` into its interior labels. A
  symbol-name test misses this (objdump names the interior labels separately); the
  **by-address interior-entry test** catches it. Excluded.
- **Duplicate symbol name** — main.elf has TWO `HandleReverb` functions (0x80112b00 and
  0x801136f0); objdump symbolizes both against the lower one, so symbol-name grep gave 22
  false external hits. By-address resolution: 29 internal / 0 external. → single-entry holds.
- **Indirect calls with no static target** — `GXLoadTexObjPreLoaded` has a `blrl`
  (`mtlr r12; blrl` = tlutRegionCallback) returning to its interior → NOT leaf. The first-cut
  classifier gated call-detection on a resolvable target and missed it; the workflow caught it,
  and the tool is now fixed (bctrl/blrl count regardless of target; operand-less insns parse).
- **objdump mis-decodes Gekko paired-single ops** (psq_l / ps_madd → VSX xsaddsp etc.).
  Branches decode fine (single-entry unaffected), but store-target / MMIO checks need raw-byte
  or decomp confirmation — the workflow did this.

## A3.1 LEAF LINE — 17 functions, 39.5% of board samples (verified single-entry)

Compile in share order. `pure_compute` → offline direct-invocation goldens; `stateful` → live
shadow-verify. "blocks" = basic-block count (whole-function emit unit size).

| share% | addr | size | blocks | class | function | notes |
|---:|---|---|---:|---|---|---|
| 22.17 | 0x800bc8d0 | 0x118 | 5 | pure_compute | **PSMTXROMultVecArray** | ✅ DONE (A1/A2) — but as the slow per-block path; whole-fn AOT re-do is the fps test |
| 5.13 | 0x801136f0 | 0x50c | 59 | pure_compute | HandleReverb | audio reverb; reads reverb struct via arg, writes output buffer; 0xCC-free |
| 1.40 | 0x800bb57c | 0xf8 | 3 | pure_compute | PSMTXInverse | mtx.c asm; src/inv pointer args |
| 1.14 | 0x800bbeb4 | 0x98 | 1 | pure_compute | C_MTXOrtho | single block |
| 1.10 | 0x800ca0cc | 0x9c | 6 | stateful | __GXSetVAT | writes GX FIFO MMIO 0xCC008000 + dirtyVAT global |
| 0.99 | 0x800cc3dc | 0x1e4 | 12 | stateful | GXSetChanCtrl | GX state |
| 0.88 | 0x800bb460 | 0xcc | 1 | pure_compute | PSMTXConcat | reads read-only pool @0x801D; 127 head-only callers |
| 0.80 | 0x800cc5c0 | 0x15c | 24 | pure_compute | GXGetTexBufferSize | **internal bctr switch** (jump table in .data @0x8013d…, all targets interior) |
| 0.79 | 0x800ce3a4 | 0x74 | 1 | stateful | GXSetTevKColor | GX state |
| 0.73 | 0x800cea7c | 0x100 | 3 | stateful | GXSetFogRangeAdj | GX state |
| 0.72 | 0x800cd190 | 0xcc | 1 | stateful | __SetSURegs | GX SU regs |
| 0.69 | 0x800cbf78 | 0x148 | 20 | stateful | GXLoadLightObjImm | GX light |
| 0.67 | 0x800ceb7c | 0x104 | 4 | stateful | GXSetBlendMode | GX state |
| 0.60 | 0x800e23cc | 0x5c | 6 | pure_compute | __cvt_fp2unsigned | runtime fp→u32 converter |
| 0.58 | 0x800bbcb0 | 0x54 | 1 | pure_compute | PSMTXMultVec | paired-single (objdump mis-decodes stores; verified via decomp) |
| 0.56 | 0x800c984c | 0x360 | 29 | stateful | GXSetVtxDesc | **internal bctr switch** (26 entries @.data 0x8013D8C0, all interior); GX state |
| 0.56 | 0x800ccaa0 | 0x194 | 19 | pure_compute | GXInitTexObjLOD | fills GXTexObj struct via arg ptr; no MMIO |

**9 pure_compute** (offline goldens) + **8 stateful** (live shadow-verify). Total **39.5%**.

## Emitter requirements A3.1 surfaced

- **Intra-function computed jumps (jump tables).** GXGetTexBufferSize + GXSetVtxDesc use
  `mtctr; bctr` switches whose case table lives in `.data` (targets all interior). The
  whole-function AOT emitter must resolve these internally (read the .data table, emit a
  br_table / internal dispatch), not treat `bctr` as a block-exit to the runtime dispatcher.
- Everything else is straight-line + `bdnz`/`bc` internal loops (already handled by the emit path).

## Excluded from A3.1 (from top-45)

- **Call-bearing → A3.2**: FaceDraw (3.78%), SelectThread (2.38%), HuSprDisp (2.34%),
  SetTevStageTex (1.73%), SetEnvelop (1.62%), C_QUATSlerp (1.48%), Hu3DMotionExec (1.41%),
  GXInitTexObj (1.20%), GXCallDisplayList, MesDispFunc, ObjDraw, Hu3DExec, __GXSetSUTexRegs,
  GXEndDisplayList, salBuildCommandList, FaceDrawShadow, Hu3DMtxScaleGet, objMesh, particleFunc,
  __ieee754_rem_pio2, GXLoadTexObjPreLoaded (indirect blrl). These are ~half the board and are
  REQUIRED to reach 60% — the leaf line alone caps near 40%.
- **Multi-entry helper**: __save_gpr (0.69%) — EABI save/restore, entered mid-body.
- **Too small (single-block, no whole-fn headroom; candidates for call-site inlining instead)**:
  PSMTXIdentity (3.06%!), DSPCheckMailToDSP (1.58%, DSP MMIO), WriteMTXPS4x3 (1.22%),
  PSVECSquareMag (0.75%).

## The line from here

1. ✅ Re-derive + commit this table.
2. **A3.1**: generalize `aot_compile.cpp` (currently PSMTX-hardcoded) to take a function spec
   (entry, bytes, block-starts); walk the leaf line above with class-appropriate proofs and a
   MIPS/timing gate per batch (shadow-verify guards that AOT ≥ JIT speed). The whole-function
   emit — not A1's per-block slow path — is the fps mechanism to validate.
3. **A3.2**: design call-bearing machinery from A3.1's measured results.
4. **A4**: board A/B at ~60% coverage (A3.1 leaf ~40% + A3.2 call-bearing) = the Summit-1 number.

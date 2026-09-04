# The guest-PC census — what it can and cannot tell you

The PC census is the instrument every "what should we optimise next?" answer on
GameCube has been read off. This folder exists because on 2026-09-02 it could
name 19% of what it sampled, and because the one number it produced turned out
not to reproduce.

Everything below is either a citation from a command run on 2026-09-04 or an
explicit hedge. Machine load is reported with every measured number.

---

## 1. Why 62.3% of the census was unresolved (it was not what the doc guessed)

`gamecube/docs/sab-frame-governor/TASKS.md` recorded "81.0% of symbols
unresolved". Re-running HEAD's resolver on that same artifact
(`wasm_pc_hist_sab_2026-09-01.json`, 15,478 samples) gives **62.3%**, not 81.0% —
the 81.0% predates commit `02f8ef65` ("fix the PC-census symbol resolver"), which
landed after the doc was written. The 81.0% figure is stale; 62.3% is the
honest BEFORE.

Three candidate causes were proposed. Two are refuted by measurement:

| Hypothesis | Verdict | Evidence |
|---|---|---|
| 256B bucket granularity | **contributing, not the cause** | 25.3% of samples sat in a bucket spanning >1 named symbol — real, but it cannot explain a 62.3% miss. |
| `.rel` / overlay code absent from the static map | **REFUTED for SAB (3.1%)** | SAB's DOL `.text` is `0x80003100..0x80005500` + `0x80005500..0x80173140` (read from the ISO header at `0x420` → DOL at `0x1e700`). **96.92% of the 15,478 samples fall inside it.** The 3.08% outside is 238 buckets, mostly `0x80bc____`. |
| Address-space / relocation offset mismatch | **REFUTED** | Static disassembly of `0x80117e00` from the ISO reproduces the doc's LIVE `dump_sab_pc.mjs` dump instruction-for-instruction, including both branch targets. Guest addresses are the DOL's addresses. |

The actual cause is much duller. `tools/gsne8p_xref.map` holds **441 symbols
covering 101,884 of the 1,507,392 bytes of `.text` — 6.8%.** A sample landing in
the other 93.2% has nothing to resolve against. No resolver change fixes that;
only more symbols do, and for SAB more *names* do not exist offline (there is no
SAB decomp; `~/gc_refs/sadx` is Sonic Adventure DX and shares no game code).

**PSO is the opposite case and the overlay hypothesis IS the story there.** PSO's
DOL (offset `0x1e000`, per its own header) has only **181,760 bytes** of `.text`
against SAB's 1,507,392. Nearly all of PSO's code is `.rel` overlay loaded at
runtime, so a static-map census of PSO will be mostly unresolved no matter what,
and the offline-relocation work in `gamecube/recomp/sr/` is the route.

## 2. The fix: recover BOUNDARIES, which is what a census actually needs

`gamecube/tools/gc_funcmap.py` carves the DOL into functions:

1. seed from the DOL entry + every static `bl` target + every symbol-map start;
2. carve each function with a forward-branch watermark, so an early `blr` or an
   if/else tail does not split it;
3. gap-fill the ranges no `bl` reaches (callback/vtable targets — the case
   `tools/gcsdk_scan.py`'s own header says `PPCAnalyst` misses);
4. name from the symbol map at exact starts, else emit `fn_<addr>`, which is
   deliberately a boundary and not a claimed identity.

**Validated against ground truth before being trusted anywhere else.** MP4 has a
byte-identical decomp, so `--rom 0 --validate --no-map-seeds` scores the recovery
with the ground truth withheld from the seeds (feeding it in and then scoring
against it would be circular, and it is also the arm that matches SAB, where the
map supplies 91 of 3,549 seeds):

```
$ python3 gamecube/tools/gc_funcmap.py --rom 0 --validate --no-map-seeds
#   seeds: 2756 bl-targets + 0 map-only + entry = 2757
#   recovered 4549 functions (2757 from seeds, 1792 gap-filled), coverage 99.5%
  exact-start recall : 3484/3558 = 97.92%
  ATTRIBUTION        : 285603/287493 instruction addresses land in the
                       correct function = 99.34%
```

## 3. BEFORE / AFTER on the same 15,478 samples

Same artifact, same command, one env var apart
(`GC_SYMS_NO_FNMAP=1` selects the old name-map-only resolver):

```
BEFORE  37.7% named   0.0% recovered   62.3% UNRESOLVED
AFTER   37.7% named  59.2% recovered    3.1% UNRESOLVED
```

**62.3% → 3.1% unresolved.** The residual 3.1% is code outside the DOL entirely
and is not resolvable from a static map by construction.

A fresh 4B-bucket run (§4) reads **30.5% named / 65.4% recovered / 4.1%
unresolved**, and `GC_SYMS_XMATCH=1` moves a further 5.7% from recovered to
named.

### What is still not a name

`gamecube/tools/gc_xmatch.py` content-matches recovered SAB functions against
MP4's decomp by masked-instruction fingerprint (masking only the fields two
links of the same source legitimately differ in). It adds **162 SDK names**.
Its precision is **measured, not asserted** — the 441 functions the xref map
already names are labelled examples:

```
$ ROM_IDX=1 python3 gamecube/tools/gc_xmatch.py --check
  225 matched functions overlap a known name
  agree    : 216
  disagree : 9  (96.00% precision on labelled examples)
```

It is **opt-in** (`GC_SYMS_XMATCH=1`) and `Symbols.kind()` reports it as
`xmatch`, never `named`, so a 96%-precise name can never be quoted as though it
came from a symbol table.

Two of the nine disagreements are the EXISTING MAP being wrong, not the matcher:

* `0x800e4f14` is labelled `DCZeroRange` in `tools/gsne8p_xref.map`, but its body
  is `icbi 0,r3 / addi r3,r3,0x20 / bdnz` — that is `ICInvalidateRange`.
  `DCZeroRange` would use `dcbz`.
* `tools/gsne8p_xref.map` contains 10 duplicated names over 22 rows, including
  `SPEC0_MakeStatus` at both `0x800f4d40` and `0x800f4eb4`, and `__CARDRead` at
  both `0x8016eca8` and `0x8016ede8`. In MP4's decomp those pairs are
  `SPEC0_MakeStatus`/`SPEC1_MakeStatus` and `__CARDRead`/`__CARDWrite` at
  adjacent addresses with identical sizes — `cross_ref_expand.py`'s layout walk
  slipped by one function. (Not every duplicate is an error: MP4's own decomp
  has two static `HandleReverb`s, from `reverb_hi.c` and `reverb_std.c`.)

## 4. The sampler now records the exact PC, not a 256B bucket

A SAB function averages 316 bytes (4,766 recovered in 1.5 MB), so a 256B bucket
straddled more than one function for **74.8%** of the 2026-09-01 samples — every
one of those had to print as `A|B|C` because nothing could say which.
`dolphin_render_probe.js` now masks with `PROBE_PC_BUCKET` (default **4**, i.e.
the exact PC) and records the width in the artifact, so `annotate_pc_hist.py`
never has to assume one. Measured straddle on a 4B run: **0.0%**.

## 5. ⚠ THE POOLED CENSUS IS NOT A WORKLOAD PROFILE — it is a phase mixture

This is the most important thing in this folder.

A 75s SAB run passes through at least three unrelated phases. `SEG_SPLIT=1`
prints them (10s per segment):

```
#   s1     s2     s3     s4     s5     s6     s7       function
#   1742   2493   2500   2495   2496   2491   1260     (segment sample counts)
    0.0    26.6   32.0   0.0    0.0    0.0    0.1      fn_80022ef0
    0.0    0.0    0.0    8.5    11.9   12.2   11.5     fn_8011fff4
    44.9   0.0    0.0    0.0    0.0    0.0    0.0      __start
    0.0    9.2    10.3   2.8    2.8    2.6    2.3      HandleReverb
    0.3    5.5    12.2   3.6    0.0    0.0    0.0      fn_8012338c
    0.0    0.0    0.0    2.7    4.5    4.7    6.2      fn_8011da30
```

s1 = boot/relocation, s2–s3 = a DVD load, s4–s7 = the steady scene. **No scene
ever exhibits the pooled ranking.** And the pool does not reproduce:

| | 2026-09-01 run | 2026-09-04 run |
|---|---|---|
| `fn_80117df8` (the frame governor) per segment | 0.0 0.1 23.1 **54.1** 9.5 2.8 2.0 2.1 | 0.0 0.0 0.1 0.0 0.2 0.0 0.1 0.2 |
| pooled | **14.9%** | **0.1%** |

Same build (`dolphin_worker_emcc.wasm` md5 `82bc8f8b6e1c6ac8db27ec0a5d49dadb`,
identical before and after the run), same ROM_IDX, same 75s, same rig. The two
runs simply spent their middle segments in different phases. **The
sab-frame-governor doc's headline "23.2% of guest execution is one un-skippable
busy-wait" is a property of one boot's transient, not of the workload.** Quote a
steady-segment range (`SEG_MIN=4`), never the pool.

### And a PC histogram over-weights idle loops by construction

When `IsBusyWaitLoop` fires, `branchIsIdleLoop` sets `downcount = 0` and emulated
time advances to the next scheduled event **without executing** — while the guest
PC sits in the loop. The sampler reads the PC on a wall-clock timer, so it counts
those samples exactly like executed work. A PC census therefore cannot separate
"cycles spent here" from "parked here while time was skipped", and any idle-loop
row in it is an upper bound. (This is the same trap that poisoned
`/tmp/native_pc_hist.txt`, CLAUDE.md gate #10.) Cross-check any idle-shaped row
against an executed-op instrument before pricing a lever on it.

---

## 6. Classification of the hot functions

Method: `ROM_IDX=1 python3 gamecube/tools/gc_disasm.py --classify <addr>` — static
disassembly of the DOL through capstone plus a Gekko paired-single pre-pass, with
the recovered/named symbol table applied to branch targets. Percentages are from
the 2026-09-04 4B census (15,477 samples); steady = segments 4–7.

| Function | pooled | phase | class | why (from the disassembly) |
|---|---|---|---|---|
| `fn_80022ef0` | 9.5% | load (s2–s3, 26–32%) | **BUSY-WAIT** | 6 instrs: `lwz r0,-0x7a18(r13) / cmpwi r0,0 / bgt -8`, then reload from `-0x7a10(r13)` and `blr`. No stores in the loop body, no calls, self back-edge. |
| `fn_8011fff4` | 6.2% | **steady (8.5–12.2%)** | **REAL COMPUTE (GX submission)** | `GXClearVtxDesc` / `GXSetVtxDesc` ×3 / `GXSetVtxAttrFmt` / `GXBegin`, then a two-deep vertex loop doing `lha` index fetch + `lfs f1,f2,f3` and calling the WPAR writers below. |
| `__start` | 5.1% | **boot only (s1, 44.9%)** | **BOOT — not a workload item** | `bl __init_registers / __init_hardware / __init_data`, then the `bdnz` relocation loop at `0x800031e4`. The old census printed this bucket at 5.2% as **`__check_pad3`**; at 4B resolution `__check_pad3` gets **0 samples** — all 783 are `__start`. (`__check_pad3` at `0x80003100` is the pad3+reset check that calls `OSResetSystem`, also boot-only; it merely shares the 256B bucket.) |
| `HandleReverb` | 4.7% | 9–10% load, 2.3–2.8% steady | **HLE CANDIDATE (audio)** | DOLSDK AXFX. The name resolves to `~/gc_refs/dolsdk2001/src/axfx/reverb_std.c`; MP4's decomp has two static `HandleReverb`s of its own (`0x80112b00` size `0x3b4`, `0x801136f0` size `0x50c`) — DOLSDK ships two reverb implementations, `src/axfx/reverb_hi.c` and `src/axfx/reverb_std.c`. SAB's hot one is the `0x50c` at `0x800fa704`. CPU-side reverb the host could do natively. |
| `fn_8012338c` | 3.5% | load (s3 12.2%) | **DVD WAIT (HLE/idle candidate)** | `DVDReadAsyncPrio`, then a loop polling `DVDGetCommandBlockStatus` with `VIGetRetraceCount` gating and three `blrl` user callbacks. Not a pure spin — it calls out — so `IsBusyWaitLoop` cannot take it. |
| `fn_8011da30` | 2.4% | **steady (2.7–6.2%)** | **REAL COMPUTE (paired-single)** | Hand-scheduled `psq_l` / `psq_lu` / `ps_msub` / `ps_madd` / `psq_stu` software-pipelined inner loop. This is exactly the paired-single load/store surface that measured 45.6% of MP4's emitted work. |
| `fn_80169b9c` | 2.3% | **steady (2.6–5.1%)** | **REAL COMPUTE** | 1,076 bytes; sets `mtspr 0x394` (GQR4) then runs a large integer+float decode over `lwz`/`srawi`/`mulli` with `stmw`-saved registers. Quantised-data decoder. |
| `fn_80120144` / `fn_80120138` / `fn_80120128` | 2.2 / 1.0 / 0.9% | **steady** | **HLE CANDIDATE (WPAR)** | Each is `lis rX,0xCC01` + stores to `-0x8000(rX)` = **`0xCC008000`, the write-gather pipe**: `stfs f1,f2,f3` (position), `stw` (color), `sth ×2` (texcoord). This is the fourth store path CLAUDE.md gate #10 records as bypassing the in-wasm gather arm. |
| `OSRestoreInterrupts` / `OSDisableInterrupts` | 2.2 / 1.6% | load-weighted | **REAL COMPUTE (OS)** | Named by the map; `mfmsr`/`mtmsr` pairs. Their share tracks the DVD phase, i.e. they are the critical sections of the callers above, not an independent cost. |
| `DVDGetCommandBlockStatus` | 1.9% | load (s3 7.2%) | **POLL TARGET** | The callee of `fn_8012338c`'s wait loop. |
| `fn_800e74d8` = `EXIGetID` (xmatch) | **0.04%** | s2 only | **REAL COMPUTE (EXI probe)** — and a cautionary tale | `OSDisableInterrupts` → reads `__EXIProbeStartTime` at `0x800030c0` → `__OSMaskInterrupts` → `OSRestoreInterrupts`, 223 instrs, 26 calls. Content-matched to MP4's `EXIGetID`. **The old census listed its 256B bucket `0x800e7800` at 3.8%** — but that bucket also contains `fn_800e7854`, `OSDisableInterrupts`, `OSEnableInterrupts`, `OSRestoreInterrupts` and `__OSSetInterruptHandler`, and at 4B resolution `EXIGetID` itself is 0.04%. The 3.8% was almost entirely the interrupt primitives, not the probe. |
| `DoCrossTalk` | 1.1% | load-weighted | **HLE CANDIDATE (audio)** | Same DOLSDK AXFX family as `HandleReverb`. |
| — (outside DOL `.text`) | 4.1% | all | **OVERLAY** | `0x80b00000..` 2.58%, `0x81200000..` 1.18%, `0x00000000..` 0.28%. The `[si-final]` snapshot in the same run carries `omcurovl` / `omovlevtno` / `omovlhisidx` and `srr0=80bc82ac`, so SAB has a live overlay manager and `0x80b______` is its loaded code. |

### The one actionable difference between the two busy-waits

`fn_80022ef0` satisfies every clause of `IsBusyWaitLoop`
(`gamecube/bementalJIT/guests/powerpc-next/ppc_analyst.cpp:356-401`): 3 ops, the
`lwz`'s only input `r13` is never written, the terminator is a branch at
`i+1 == instructions` whose `branchTo` equals the block address. I have **not**
verified at runtime that the compiled block is flagged, but statically nothing
rejects it — so it is expected to be idle-skipped already, and its 9.5% is likely
parked-PC time rather than executed cost.

`fn_80117df8` provably cannot be taken: its `bl 0x800f3710` is `FL_ENDBLOCK`, so
the loop is cut into `[bl]` and `[lwz..bc]`, and the second block's back-edge
targets the *first* block's address. That is the case the sab-frame-governor doc
already documents, and the contiguous pure-leaf inline it proposes remains the
fix — but §5 says it is worth **far less** than 23.2%.

---

## Reproduce

```bash
node tools/browser_leak_guard.js reap && uptime          # MANDATORY pre-step
bash tools/probe_lock.sh run -- env PROBE_PC_SAMPLE=1 ROM_IDX=1 \
  PROBE_HEADLESS=0 PROBE_DURATION_MS=75000 \
  node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1

SEG_SPLIT=1 TOPN=25 ROM_IDX=1 python3 gamecube/tools/annotate_pc_hist.py
SEG_MIN=4 TOPN=25 ROM_IDX=1 python3 gamecube/tools/annotate_pc_hist.py   # steady only
ROM_IDX=1 python3 gamecube/tools/gc_disasm.py --classify 0x8011fff4
```

Regenerating the boundary maps (they are tracked, so this is only needed if a
DOL or a name map changes):

```bash
python3 gamecube/tools/gc_funcmap.py --rom 0   # tools/gmpe01_fn.map
python3 gamecube/tools/gc_funcmap.py --rom 1   # tools/gsne8p_fn.map
python3 gamecube/tools/gc_funcmap.py --rom 2   # tools/gpoe8p_fn.map
python3 gamecube/tools/gc_funcmap.py --rom 3   # tools/suite240p_fn.map
ROM_IDX=1 python3 gamecube/tools/gc_xmatch.py --out tools/gsne8p_xmatch.map
```

Run conditions for every number above: box load `5.46 → 6.25` (1-min average
before / after the 75s run), 8 days uptime, one sibling probe queued behind the
lock. Guest rate in the run: `ai_dma_cb=1672.08/s (hw 4003.56/s) => 0.4176x`,
`published=16.18/s` — comparable to the 2026-09-01 baseline's `0.4115x` /
`16.12/s`, so the two runs are the same speed and differ only in phase.

## Open

- [ ] `SEG_MIN` is a manual guess at where the steady phase starts. The rig
      should detect the phase boundary itself (e.g. from the DVD-status poll
      share collapsing) and refuse to print a pooled ranking across one.
- [ ] The idle-loop over-weighting in §5 has no correction. Pair the census with
      an executed-op instrument before pricing any idle-shaped lever.
- [ ] PSO (`ROM_IDX=2`) needs the overlay path: only 181,760 bytes of its code
      is in the DOL. `gamecube/recomp/sr/` already reproduces `.rel` relocation
      offline byte-exact; feeding its output into `gc_funcmap.py` would make a
      PSO census legible.
- [ ] `tools/gsne8p_xref.map` has at least two provable naming errors (§3).
      `cross_ref_expand.py`'s layout walk should confirm each placement by
      content the way `gc_xmatch.py` does, instead of by neighbour order.

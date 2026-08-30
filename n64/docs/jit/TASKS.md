# N64 JIT — task list

Read README.md first (seam facts + contract). Canonical iteration loop, per
CLAUDE.md gate #1: build = `source emsdk/emsdk_env.sh && cd n64/N64Wasm/code
&& make -j8` (writes straight into ../dist/ — restore dist via git if the
result is not meant to ship); probe = `node tools/n64_boot_test.mjs <rom.z64>`
against `npm run web` on :8080. Measurement hygiene gate #8 applies: clean
build, baseline first, one change at a time.

## M0 — build reproducibility  ✅ DONE 2026-06-12
- [x] Vendored core rebuilds under repo emsdk 3.1.67 (two implicit-int fixes)
- [x] Rebuilt binary boots Mario Kart headless: 98% speed, 0 page errors
- [x] Decision: dist stays vendored until the JIT build picks flags
      deliberately. (Resolved: Makefile:185 is now `TOTAL_MEMORY=536870912`
      = 512MB, matching the vendored dist — the old "Makefile is 1GB"
      mismatch is no longer a live trap. Verified 2026-08-29.)

## M1 — funcref plumbing: one JIT block executes in-browser
The decisive spike: prove a JS-built wasm function can be installed as a
block-head `PC->ops` and execute correctly mid-game.
- [x] Re-link with table growth + addFunction/removeFunction/wasmTable
      exports, TOTAL_MEMORY 512MB (matches vendored); boot parity verified:
      mariokart 98%, sm64 100%, starfox 99%, zero page errors (2026-06-12)
- [x] C-side bridge: EM_ASM up-call at the tail of recompile_block
      (recomp.c) → `myApp.jitCompile(entryVaddr, entryInstrPtr, origOpsIdx,
      spanLen)`; nonzero return installed as the entry instruction's ops.
      OFF by default (g_jit_bridge=0, mymain.cpp); page enables via
      `_neil_set_jit_bridge(1)` behind the `?jit` URL flag (index.html
      setupJitBridge) — interpreter remains the control arm
- [x] v0 call-through compiler PASSED: Mario Kart with ?jit — 587 spans
      wrapped, 4.22M dispatches through JS-created funcrefs installed as
      PC->ops, speed 107% vs 105% control, identical rendering, 0 errors.
      Plumbing (EM_ASM up-call, addFunction funcref, table install,
      dispatch, state integrity) fully validated in live gameplay
- [x] v0.5 PASSED: real per-block WebAssembly.Modules handcrafted in JS
      (table+memory imports, native call_indirect to the original op — no
      JS in the dispatch path; one-time canary import proved execution).
      595 modules instantiated, 0 failures, full speed. Sync-compile limit
      MEASURED: 4MB compiles in ~12ms; 16MB throws "WebAssembly.Compile is
      disallowed on the main thread" — per-block sync compile is a non-issue
- [x] Differential harness PASSED (tools/n64_jit_diff_test.mjs): per-VI
      FNV-1a over reg/hi/lo/cp0/PC (_neil_diff_* exports, captured at
      retro_return), page-side ?difftrace enable for frame-0 alignment,
      incognito context per run (shared IDB sram diverged runs at frame 80
      — found and fixed), determinism control arm required. 600 frames
      bit-identical interp-vs-jit on mariokart (569 blocks), sm64 (908),
      oot (1589); determinism PASS on all three
- [x] Savestate round-trip with JIT active PASSED: save 929KB → load →
      full block-cache flush → 121 blocks lazily rebuilt by the JIT →
      runs at full speed, 0 errors

## M2 — n64/bementalJIT + native MIPS emitters
Implementation decision (deviation from the GC fork plan, documented):
mupen already provides the block cache, dispatch, and invalidation that
block_cache.cpp provides on GC — so n64/bementalJIT is a NEW JS-hosted
emitter library (n64/bementalJIT/mips_emit.js) reusing the proven v0.5
instantiation pipeline, not a C++ fork carrying redundant machinery. Same
conceptual decomposition (opcode table, per-op emitters, per-op
interpreter fallback = the gencallinterp role); JS hosting makes the
emitter iteration loop a page reload instead of a core rebuild. Can
migrate to C++-side emission later if per-block compile cost ever shows
up in measurements.
- [x] Wave 1 (2026-06-12, dev/prod 18a2749): unrolled call-threaded
      skeleton + native integer ALU (shifts incl. variable, ADDU/SUBU,
      64-bit logicals, SLT family, ADDIU/LUI/imm-logicals; exact MIPS-III
      sign-extension semantics; r0 discarded). Fallback ops store exact PC,
      call_indirect the original interp funcref, exit on PC divergence —
      interrupt/Count contract preserved by construction. Differential
      gate PASS ×3: mariokart 47% native ops, sm64 42%, oot 38%; zero
      emit failures; page e2e green
- [x] Wave 2 (2026-06-12, 739cb17) — branches/jumps with delay slots (biggest win: every taken
      branch currently exits the block through a fallback): native
      BEQ/BNE/BLEZ/BGTZ + REGIMM, J/JAL/JR/JALR, in-block back-edges for
      hot loops, Count batch + next_interrupt<=Count poll at block tails
      (the contract decision: keep interpreter Count derivation, batch at
      tails exactly like cached_interp's DECLARE_JUMP)
- [x] Wave 3 (2026-06-12, db6f249) — loads/stores (TLB-aware: KSEG0/KSEG1 fast path via direct
      RDRAM offset, mapped/MMIO via fallback), LW/SW/LBU/LB/LH/LHU/SB/SH,
      then LD/SD/unaligned pairs
- [x] Wave 4 (2026-06-12, f1d2f84): BLOCK-LOCAL REGISTER CACHE — guest
      GPRs in 32 i64 wasm locals, lazy load, dirty flush before fallback/
      gen_interrupt/exit/back-edge, full invalidate after fallbacks.
      Differential green x3; speedup ratio 1.10x (from 1.01x). Design
      traps documented in the commit (deferred cond emission, throwaway
      probe clones, conservative joins)
- [x] Wave 5 (2026-06-12, a2688cd) — native stores SW/SB/SH (writemem-table runtime check +
      CHECK_MEMORY invalid_code mirror): stores are the most frequent
      remaining fallback and each one invalidates the whole cache —
      this is the lever that lets cached registers live
- [x] Wave 5b DONE 2026-08-29 — runtime per-opcode fallback census.
      `?jit=census` + `node tools/n64_jit_census.mjs <rom> [warmupVI]
      [windowVI] [--noinput]`. Counters are bumped through an imported host
      func ("e"."c") because this build exports no `_malloc` (verified: a
      page eval returned `typeof Module._malloc === "undefined"`), so there
      is no guest-invisible scratch region for linear-memory counters. It is
      a COUNTING arm, never a timing arm. Buckets: `<MNEM>` generic
      fallback, `SLOW:<MNEM>` native memory op that took the off-RDRAM arm,
      `CU1MISS:<MNEM>`, and structural `#block-iter` / `#backedge` /
      `#exit:*` / `#gen_interrupt`. The tool snapshots the census after
      `warmupVI`, DRIVES CONTROLLER INPUT for `windowVI` frames, and reports
      the DELTA — so the ranking is gameplay, not boot logos (mariokart
      reaches an actual race; screenshot /tmp/n64-census/mariokart.png).
      Census arm is bit-identical to the interpreter (differential PASS),
      and `?jit` / `?jit=nofp` emit byte-identical code to before.
- [x] Wave 6 (2026-06-12, 43eb990; see the wave-6 entry below) — MULT/MULTU/DIV/DIVU + MFHI/MFLO/MTHI/MTLO (hi/lo addresses
      already in the param block); JR/JALR (dynamic targets via jump_to
      fallback exit, native condition-free form)
- [ ] Delay-slot exception semantics: red tests for EPC/BD around lw/sw in
      delay slots, branch-likely skip, ERET. Wave 8 made this sharper, not
      moot: its correctness rests on "an RDRAM-table hit cannot fault", so
      the red test that matters is a TLB-mapped lw/sw IN a delay slot —
      it must take wave 8's slow arm and hand the whole branch back. The
      600-frame differential on 3 titles does not prove that path was
      even reached; a targeted repro should.
- [ ] Per-instruction conformance runner (port gamecube/tools/conformance
      shape; oracle = cached interpreter in the same binary)
- [x] Fallback census tooling — same deliverable as wave 5b above
      (`tools/n64_jit_census.mjs`), driven-input gameplay window.

## Wave 8 (2026-08-29) — delay slots stop ending blocks

The wave-5b census answered the question the campaign had been guessing at.
Ranked by MEASURED execution frequency in a driven gameplay window (warmup
600 VI, window 900 VI), the top fallbacks were branches, and the annotated
buckets said exactly why — every one was `@slot:<load/store>`, not one was
`@span-end` or `@idle`:

    mariokart  BNEL@slot:SB 26.0% | BNE@slot:LHU 22.7% | BEQL@slot:LW 11.5%
               JR@slot:SW 5.1% | BNE@slot:LW 3.5% | JR@slot:LWC1 2.4% ...
    sm64       JAL@slot:SW 8.8% | JR@slot:SW 6.0% | BEQL@slot:LW 5.7% ...
    oot        JR@slot:SW 14.3% | JAL@slot:SW 5.4% | BNE@slot:SW 2.2% ...

Cause: wave 2 accepted a branch only when its delay slot was a pure ALU op,
because a FAULTING slot needs `g_dev.r4300.delay_slot` set for EPC/BD and
`skip_jump` (cached_interp.c:73-96, exception.c:143-145) and only the
interpreter sets it. Every rejected branch fell back AND exited the block.

Fix (JS-only — no core rebuild, no dist change): a memory/FP delay slot is
emitted natively, and its RDRAM fast arm CANNOT fault (`readmem*[a>>16] ==
read_rdram*` is a direct RDRAM access — no TLB walk, no MMIO), so
`delay_slot` is never observed there. Every arm that COULD fault (off-RDRAM,
CU1 clear) hands the WHOLE BRANCH back to the interpreter and exits, which
re-runs branch+slot with the flag set. That is exact: the only guest state
the block has written by then is the link register, and DECLARE_JUMP writes
it the identical `SE32(addr+8)` again. See `slowArm()` in mips_emit.js.
The branch condition also moved from the wasm stack into a local (L_COND),
verified separately as a no-op before the slot work landed.

- [x] Correctness: differential PASS x3 at 600 VI frames (mariokart, sm64,
      oot; determinism control PASS on all three), census-arm differential
      PASS, page e2e PASS, 0 emit failures.
- [x] The risky arm IS covered, measured not assumed. Census buckets
      `SLOTSLOW:<MNEM>` / `SLOTCU1MISS:<MNEM>` count specifically the
      delay-slot bail (off-RDRAM inside a delay slot -> whole branch back to
      the interpreter). Run over the differential's OWN window (no input,
      VI 0-600): mariokart SLOTSLOW:SW 1,612 + SLOTSLOW:LW 567; oot 2,967 +
      536. So the bit-identical differential exercised that path thousands
      of times per ROM — it is not a fast-arm-only PASS. In a driven
      gameplay window it fires at a similar rate (mariokart 2,504 + 904).
- [x] Measured effect — fallback EXECUTIONS per block iteration, same drive
      script, before -> after:
        mariokart  0.849 -> 0.148   (total 4,911,185 -> 595,365, -87.9%)
        sm64       0.614 -> 0.296   (total   776,125 -> 371,955, -52.1%)
        oot        1.082 -> 0.742   (total 2,762,083 -> 1,838,715, -33.4%)
      Blocks now LOOP: mariokart `#backedge` 8 -> 656,397, and block
      iterations for the same 900-VI window fell 5,785,236 -> 4,021,195
      (fewer dispatcher round trips). Static, near-identical corpus
      (508 vs 509 blocks): fallback SITES 2,366 -> 648.
      gauntletLegends is unaffected (-1.8%): its window is dominated by a
      periodic SD/LD loop, not by branches.
- [ ] THROUGHPUT VERDICT FOR WAVE 8 IS UNMEASURED. The A/B was attempted
      order-alternating on 2026-08-29 and must be DISCARDED per the
      measurement rules below: the same arm's absolute per-frame cost moved
      ~60% between rounds (mariokart interp 15.381 vs 23.809 ms) and the
      paired ratios contradict (mariokart 1.059 / 0.991; sm64 2.339 /
      1.239), with load averages 15-84 and `CPU_Speed_Limit` 58-70
      throughout. Re-run on an idle, unthrottled machine.

## Next by MEASURED weight (post-wave-8 census, driven gameplay window)

    mariokart  SD 32.1% | MFC0 16.4% | MTC0 14.3% | C.cond.S 12.7%
               BC1FL 12.4% | LD 4.6% | SLOW:LW 1.9% | TRUNC.W.S 1.7%
    sm64       MFC0 27.0% | TRUNC.W.S 23.7% | MTC0 22.1% | SD 5.7%
               CVT.D.S 4.4% | SLOW:LW 3.0% | CVT.S.D 2.8% | CVT.S.W 2.8%
    oot        SD 34.5% | MFC0 14.5% | MTC0 12.9% | TRUNC.W.S 8.3%
               CVT.S.W 7.3% | C.cond.S 6.1% | BC1FL 5.1% | LD 4.9%
    gauntlet   SD 75.0% | LD 10.4% | SLOW:SW 4.2% | SLOW:LW 4.2% | MFC0 4.2%

Three classes, in measured order:
- [x] Wave 9 — **SD/LD (64-bit store/load)** — DONE 2026-08-29, see below.
- [x] Wave 10a — **MFC0** — DONE 2026-08-29, see below. MTC0 is deliberately
      NOT emitted; the census below shows why.
- [ ] Wave 11 — **FP converts/compares/branches**: TRUNC.W.S, CVT.*,
      C.cond.*, BC1F/BC1FL. Explicit rounding modes and FCR31 condition
      bits; the GC lfs/stfs lesson applies — bit-exactness tests first.
      **This is now the #1 remaining class on 4 of the 8 heavy titles** —
      see "Re-ranked against the heavy set" below.

## Re-ranked against the HEAVY SET, not the reference trio (2026-08-29)

The ranking above was measured on mariokart/sm64/oot/gauntlet. Re-running
`tools/n64_jit_census.mjs <rom> 600 900` against the eight titles that are
actually below 80% of hardware gives a MATERIALLY DIFFERENT order — this is
the wave-5b lesson again, one level up: a ranking measured on the wrong ROMs
points at the wrong opcode. Percentages are shares of all fallback
EXECUTIONS in a driven gameplay window (the census is a counting arm, so
these numbers are immune to the machine load that invalidates every timing
number in this session).

BEFORE wave 9, by class:

    rom                fb/iter  SD/LD  MFC0+MTC0  FPcvt  FPcmp+BC1
    flyingDragon        0.181   52.8      31.1      3.7      1.5
    pkmnsnap            0.527   33.5      33.6     20.1      4.8
    dk64                0.366   24.2       8.2     32.2     14.8
    bk-jiggiesoftime    0.772   10.3      10.9     41.7     29.1
    Banjo-Dreamie       0.738   10.3      10.9     41.4     28.9
    banjoChristmas      0.711    8.8       9.6     43.0     30.5
    clayFighter         0.559    3.1      56.5     20.1     19.5
    thewheel               --   census could not complete, see below

So SD/LD leads on only 2 of 7; MFC0/MTC0 leads on clayFighter (56.5%); and
the FP class (converts + compares + BC1) is the largest on 4 of 7 — 70.9-73.5%
combined on the three Banjo titles and 47.0% on dk64.

## Wave 9 (2026-08-29) — SD/LD native

`emitLoad`/`emitStore` gained op 0x37 (LD) and 0x3F (SD), using the dword
dispatch tables already in the param block (`readmemD`/`writememD`/
`rdRdramD`/`wrRdramD`, recomp.c:2540-2543) — the same live-table fast-arm
shape LDC1/SDC1 already used, just against the GPR file. `readd`/`writed`
split the doubleword HIGH word first (m64p_memory.c:127-133, :170-181), and
`CHECK_MEMORY()` still tests only the page of `a`, because it reads the
GLOBAL `address` which `writed()`'s own parameter shadows.

- [x] Differential PASS x6 at 600 VI frames with determinism control PASS on
      every one: mariokart, sm64, oot, flyingDragon, pkmnsnap, dk64.
      0 emit failures.
- [x] MEASURED EFFECT — fallback executions per block iteration, same census
      window, before -> after. The drop tracks the ROM's prior SD/LD share
      almost exactly, which is the strongest available evidence that wave 9
      removed that class and nothing else:

        rom             SD/LD share before   fb/iter before -> after   drop
        flyingDragon         54.1%              0.181 -> 0.087        51.9%
        pkmnsnap             34.4%              0.527 -> 0.351        33.4%
        dk64                 24.6%              0.366 -> 0.278        24.0%
        bk-jiggiesoftime     10.3%              0.772 -> 0.697         9.7%
        clayFighter           3.1%              0.559 -> 0.642       -14.8%

      SD and LD buckets are now absent from every post-run ranking.
      Block-iteration counts drifted only -4.1%/+4.0%/+5.6%/+1.4%, so the
      ratio is meaningful. **clayFighter went the WRONG WAY and that is
      reported, not hidden**: its SD/LD share was only 3.1%, and the census
      drive is wall-paced, so run-to-run the window lands in a different
      scene. For a ROM where the target class is a few percent, that scene
      variance is larger than the effect — such a pair proves nothing either
      way and should not be quoted as a regression.

## Wave 10a (2026-08-29) — MFC0 native; MTC0 deliberately NOT

MFC0 is exactly `rrt = SE32(g_cp0_regs[rd])` for every rd except RANDOM (1)
and COUNT (9), which call `cp0_update_count()` first
(mips_instructions.def:618-634). There is no coprocessor-usable check on the
path, so MFC0 cannot fault and is emitted in delay slots with no bail arm.

`g_cp0_regs`' base is not in the param block. It is DERIVED from the two
elements that are — `p.count` = `&g_cp0_regs[CP0_COUNT_REG]` (index 9) and
`p.cp0Status` = `&g_cp0_regs[CP0_STATUS_REG]` (index 12), both `uint32_t`
(cp0_private.h:27, cp0.h:104-132) — so their byte difference must be 12.
That identity is ASSERTED at emit time; if it ever fails the op falls back
rather than reading a wrong address. `tools/n64_emit_unit_test.mjs` has a
case that deliberately breaks the layout and requires the fallback.

**MTC0 is not emitted, and the census is the reason.** Adding the CP0
register number to the census bucket label turned "MTC0 14-28%" into a
usable fact: essentially all of it is register 12 (Status) —
`MTC0.12` is 28.4% of remaining fallbacks on flyingDragon, 28.4% on
clayFighter, 22.7% on pkmnsnap. MTC0 to Status runs an FR-bit FPR shuffle,
`cp0_update_count()`, `check_interrupt()` and an inline `gen_interrupt()`
poll (:687-698). So a native "inert registers only" MTC0 — which is what the
old wave-10 plan proposed — would have bought approximately nothing while
adding a side-effect surface. The paired `MFC0.12` reads ARE inert and are
what wave 10a captures.

Share of post-wave-9 fallback executions that wave 10a addresses:
flyingDragon 38.0%, clayFighter 28.7%, pkmnsnap 27.4%, dk64 6.3%,
Banjo titles 5.9-7.3%.

- [x] Differential PASS x5 at 600 VI frames with determinism control PASS on
      every one: mariokart, sm64, oot, flyingDragon, pkmnsnap. 0 emit
      failures. The derived-base guard is confirmed LIVE, not just in the
      unit harness: `__jitStats().nativeCop0` is nonzero in every run
      (mariokart 16, sm64 18, oot 19, pkmnsnap 13, flyingDragon 12), which is
      the only proof that `p.cp0Status - p.count === 12` actually holds in
      the shipped core. Had it not, MFC0 would have silently kept falling
      back and wave 10a would have been a no-op that still passed every
      correctness gate. `n64/index.html` now surfaces `nativeCop0` in
      `__jitStats()` specifically so that can never go unnoticed.

## thewheel.z64 WEDGES UNDER ?jit AT VI 245 — open, pre-existing (2026-08-29)

**This is the first known ?jit LIVENESS failure on a shipped ROM, and it
blocks the "flip ?jit to default" gate.**

An earlier draft of this section called it "not a JIT problem" on the
strength of a single interpreter-arm timeout. That was wrong and is corrected
here; the full evidence:

- `tools/n64_jit_census.mjs thewheel.z64 600 900` (`?jit=census`) aborted:
  **VI stalled at 245**. This run was on the PRE-wave-9 emitter.
- `tools/n64_gameplay_ab.mjs thewheel.z64` (wave 9 + 10a emitter):
  - interpreter arm **COMPLETED** — 885 frames measured, 22.380 ms/frame,
    36.3 VI/s, luminance 39.4, canvas verifiably changing during the window.
  - `?jit=emit` arm **stalled at VI 245**, luminance 8.5 (near-black).
- `tools/n64_jit_diff_test.mjs thewheel.z64 600` timed out at 180s, but the
  stack puts that in `interpA` — that one is a harness timeout on a slow ROM
  under load, a DIFFERENT failure mode, and it is what misled the first
  classification. It says nothing about the JIT either way.

Two independent `?jit` runs stall at the SAME VI (245) while the interpreter
arm of the same tool, on the same machine, in the same minutes, runs to
completion. It reproduces on both the pre-wave-9 and the wave-9+10a emitter,
so it is PRE-EXISTING — not introduced by either wave.

This is the shape README.md's contract item #1 warns about: a block that
reaches a state where the interrupt poll is never satisfied wedges the tab,
because the core is single-threaded and one retro_run must end on a VI
interrupt. Suggested first move: run the differential with a small frame
count (e.g. `thewheel.z64 260 emit`) to see whether the checksums diverge
BEFORE the stall, which separates "wrong code, then wedge" from "correct
code, but a block that stops polling".

## Next by measured weight, AFTER waves 9 + 10a

    rom                fb/iter  MTC0  FPcvt  FPcmp+BC1  offRDRAM  other
    dk64                0.278    4.8   42.3     19.1       2.8     15.7
    bk-jiggiesoftime    0.697    5.7   46.1     31.3       2.9      2.1
    banjoChristmas      0.658    4.6   47.1     33.4       2.6      1.5
    Banjo-Dreamie       0.670    5.5   45.8     32.1       2.8      1.7
    clayFighter         0.642   28.4   17.8     24.2       0.6      0.2
    pkmnsnap            0.351   22.7   29.0      7.0       7.9      3.1
    flyingDragon        0.087   28.4    7.0      2.9      16.0      4.5

- [ ] **Wave 11 (FP) is now the top lever on the heavy set**: converts plus
      compares/BC1 are 61.4% (dk64), 77.4-80.5% (the three Banjo titles) and
      42.0% (clayFighter) of everything still falling back. Two sub-levers,
      and they are NOT equally risky:
      - **compares + BC1 are exactly emittable with plain wasm** and should
        go first. Read fpu.h:222-300: `c_lt_s`/`c_le_s`/`c_seq_s`/`c_ngl_s`/
        `c_nge_s`/`c_ngt_s` have NO isnan special case at all, and
        `c_eq_s`/`c_olt_s`/`c_ole_s` clear the bit on NaN — which is exactly
        what wasm `f32.eq/lt/le` already return for NaN. The `u`-prefixed
        forms (`c_ueq/ult/ule`) SET the bit on NaN, so they need an explicit
        `(s != s) | (t != t) |` term. BC1F/BC1T/BC1FL/BC1TL are just a branch
        on FCR31 bit 23 (0x800000) — and today each one ALSO ends the block,
        so the wave-8 argument applies: they cost more than their share.
      - **converts are the risky half.** `trunc_w_s` is `(int32_t)truncf(f)`
        (fpu.h:126-129) — C undefined behaviour out of range, so its wasm
        lowering in the SHIPPED dist binary decides the answer, and
        `cvt_w_s`/`cvt_s_w` route through `set_rounding()`/FCR31&3
        (fpu.h:64-93, :178-200). Determine what the vendored .wasm actually
        emitted BEFORE writing an emitter, or the bit-exactness gate will
        fail on out-of-range and non-default-rounding inputs.
- [ ] **dk64 has a cheap 64-bit-integer cluster** the reference trio does not:
      DMULT 3.2% + DADD 3.2% + DSLL32 2.8% + DSRA32 2.8% + DMULTU 2.8%
      = ~14.7% of its remaining fallbacks, and every one of them is an exact
      wasm i64 op. Small, low-risk, dk64-specific.
- [ ] flyingDragon's remaining profile is 16.0% `SLOW:*` — genuinely
      off-RDRAM accesses taking the interpreter arm, not an unported opcode.
      That is a different problem class from every wave so far.

## Two join-contract bugs found and fixed (2026-08-29)

Both are the same class, and it is the class this emitter is most exposed to.
A natively-emitted memory op compiles to `if (table[a>>16] == *_rdram)
{ fast } else { interp }` and **the slow arm CONTINUES in-block**, so the two
arms JOIN. The register cache is compile-time state shared across both arms,
so any `C.read`/`C.writeFromStack` whose BYTES land inside one arm while its
COMPILE-STATE escapes to both is a latent divergence — the wasm local is
assigned on only one path, and locals are zero-initialised. Critically this
depends on emit-CALL order, not byte order: `[].concat(C.read(rs), ...)`
evaluates left to right, but hoisting the fast-arm bytes into a variable
first silently inverts that.

1. **`emitStore` (pre-existing, shipped since wave 5).** `C.read(rt)` was
   called while building the fast-arm bytes. On the SLOW arm the value
   register's local was never assigned, so a later in-block read of rt saw 0;
   and for `sw $8, off($8)` the effective address itself was computed from
   that unassigned local. Fixed by `RegCache.ensure(rt)` hoisting the load
   above the branch, and by reading rs before rt in emit-call order.
2. **`cuGuard` (pre-existing, shipped since wave 6).** MFC1/DMFC1 end their
   native arm with `C.writeFromStack(rt)`, marking rt dirty; `cuGuard` then
   called `C.flushSnapshot()` for its else arm, which emitted — on the
   CU1-CLEAR path — a store of a local only assigned on the CU1-SET path,
   writing zero over the guest register and only then calling the
   interpreter. Fixed by capturing the snapshot BEFORE building the native
   bytes (`preFlush` parameter).
   HONESTY NOTE ON REACH: the CU1-clear arm fires at all (SDC1, 1 and 7
   executions across two of seven census runs), but the specific
   MFC1/DMFC1-with-CU1-clear combination was NOT observed in any census
   window. This is a real bug proven by an executing test; it is not a
   demonstrated cause of any observed misbehaviour.

A third, self-inflicted instance of the same class was introduced and caught
DURING wave 9: hoisting `emitLoad`'s fast arm into a `fastBytes` variable
moved `C.writeFromStack(rt)` ahead of `C.read(rs)`, breaking `lw $8, off($8)`
— the ubiquitous pointer chase. It diverged oot at frame 74. It was found by
bisecting against a clean baseline, which is the gate-#8 step that had been
skipped: the emitter was edited BEFORE the pre-change differential was run.
Run the baseline first.

## `tools/n64_emit_unit_test.mjs` — the M2 unit corpus (NEW 2026-08-29)

    node tools/n64_emit_unit_test.mjs [path-to-mips_emit.js]

Runs `mips_emit.js` outside the browser (stubbed window/Module, a real
`WebAssembly.Memory` as the guest address space), EXECUTES the block it
emits, and reads the guest register file back out of linear memory. ~1
second, no ROM, no browser. The stub "interpreter op" advances PC by one
precomp_instr stride, so the slow arm's divergence check passes and the block
continues exactly as in the core; the slow arm is forced by pointing the
dispatch table at something that is not `*_rdram`.

22 cases, and every one was RED on some real revision of the emitter — the
pre-wave-9 emitter fails 16 of them. It takes the file path as an argument
specifically so a suspect revision can be tested against it directly. This is
the "unit corpus with red-test discipline" M2 asks for; it does not replace
the differential, it makes the differential's failures cheap to localise.

## Gameplay baseline attempt on the 8 heavy titles (2026-08-29) — VOID

`tools/n64_gameplay_ab.mjs <rom> <ab|ba> 600 900`, arm order alternated
across the set. All eight interpreter arms and seven of eight `?jit` arms
completed with the canvas verifiably changing during the measured window.

    rom                interp ms/f  cpu ms/f  VI/s   load during interp   wallX  cpuX
    Banjo-Dreamie          9.835     13.25    59.3     129.35 -> 89.14    0.908  0.912
    pkmnsnap              13.481     18.54    60.5      42.93 -> 35.96    1.143  1.157
    bk-jiggiesoftime      15.263     18.94    51.4      34.92 -> 39.20    0.498  0.877
    banjoChristmas        15.512     20.62    56.6     158.96 -> 129.35   0.794  0.869
    flyingDragon          16.594     35.30    36.8      90.69 -> 103.34   1.147  1.048
    dk64                  19.622     25.56    44.2      36.49 -> 46.80    0.956  1.014
    thewheel              22.380     35.91    36.3      76.56 -> 87.10     --     --
    clayFighter           23.438     34.21    39.3     175.76 -> 131.37   0.623  0.858

**NONE OF THIS IS QUOTABLE, AS EITHER A BASELINE OR A SPEEDUP.** It is
recorded so the next session does not repeat it, not to be cited. Every one
of the campaign's own measurement rules is violated by this data:

- Load ran 34.9 to 175.8 DURING measurement (~11 concurrent sibling agent
  probes plus an emsdk `wasm-metadce` build). `CPU_Speed_Limit` was 52-58
  throughout and moved mid-round on 5 of 8 ROMs.
- The paired ratios contradict. dk64's two metrics have OPPOSITE SIGNS
  (wall 0.956 vs cpu 1.014). bk-jiggiesoftime's `?jit` arm ran while load
  went 39.2 -> 140.8, and its two metrics are 76% apart (0.498 vs 0.877).
  A pair that disagrees with itself measures the machine, not the code.
- Cross-ROM comparison fails its own sanity check: Banjo-Dreamie reads
  9.835 ms/f at load ~129 while the near-identical bk-jiggiesoftime reads
  15.263 ms/f at load ~35. The two arms also landed at luminance 9.8 vs
  42.1 — i.e. different scenes — so even the interpreter column is not
  measuring comparable work across ROMs.

The one thing worth carrying forward: 5 of the 7 completed pairs read
`?jit` SLOWER than the interpreter. Under these conditions that is NOT
evidence of a regression and must not be reported as one — but it is a
reason to make the FIRST measurement on a quiet machine a wave-8/9/10a
throughput A/B rather than another emitter wave. Note also that the `?jit`
arm pays block-compilation cost inside the window whenever the driven scene
reaches new code, which a 600 VI warmup does not fully absorb.

## Campaign state (2026-08-29)
M0-M2 COMPLETE through wave 10a. The JIT is correctness-proven on the ROMs
it has been gated against (every wave 600-1200 VI frames bit-identical vs the
interpreter with GPR+CP0+FPR+FCR31 in the checksum; savestates; invalidation;
zero emit failures ever shipped). The ?jit flag remains opt-in; the shipped
default is unchanged interpreter behavior — `mips_emit.js` is not even
fetched without `?jit` (index.html:2254-2259).

Two things that were previously believed and are now known to be false:
- "correctness-proven" did NOT mean bug-free. Two latent join-contract
  divergences had been shipped since waves 5 and 6 and survived every
  differential gate, because reaching them needs a store's off-RDRAM arm (or
  a CU1-clear MFC1) to coincide with a specific register-liveness pattern.
  The 600-frame differential is necessary and not sufficient; the new unit
  corpus exists to cover what it structurally cannot.
- "all 27 ROMs boot and render" did NOT mean all 27 run under `?jit`.
  `thewheel.z64` wedges at VI 245 with the JIT on and runs fine without it.

Perf history, most recent first:
- waves 9 + 10a (2026-08-29): SD/LD and MFC0 native. Fallback executions
  per block iteration cut 51.9% (flyingDragon), 33.4% (pkmnsnap), 24.0%
  (dk64) by wave 9 alone; wave 10a addresses a further 38.0/28.7/27.4% of
  what remained. THROUGHPUT UNMEASURED for both — see the VOID gameplay
  sweep above.
- wave 8 (2026-08-29): fallback executions per block iteration cut
  87.9% / 52.1% / 33.4% (mariokart / sm64 / oot) and blocks now loop
  natively — but the THROUGHPUT ratio is UNMEASURED, see wave 8 above.
  Machine was at load 15-84 with CPU_Speed_Limit 58-70 all session
  (~11 concurrent sibling agent probes); every A/B pair failed the
  measurement rules below and was discarded rather than quoted.
- 2026-06-12 (a5efb66), the one valid window so far: machine off throttle
  (CPU_Speed_Limit = 100 verified before AND after each run),
  order-alternating frame-cost A/B — sm64 interp 6.98 vs jit 5.69/5.51 =
  1.23x / 1.27x; gauntlet interp 11.74 vs jit 5.88/6.06 = 2.0x / 1.94x.
  The post-wave-6 "0.89x regression" was thermal-regime distortion.
- The acceptance bar (>=100% native sustained IN-GAME on heavy titles, ON
  DEVICE) remains UNVERIFIED.

NEXT ACTIONS, in order:
1. **On an IDLE, UNTHROTTLED machine, measure THROUGHPUT before writing any
   more emitter waves.** `tools/n64_gameplay_ab.mjs <rom> ab|ba 600 900` now
   exists for exactly this: VI-counted windows and VI-paced input, so both
   arms traverse the same guest work (the pinned `tools/_jit_speed_ab.mjs`
   settles by wall clock on an ATTRACT scene and cannot). Waves 8, 9 and 10a
   are ALL still unpriced. 5 of 7 pairs in the 2026-08-29 sweep read `?jit`
   slower than the interpreter — discarded as machine noise at load 35-176,
   but it is the reason this is now action #1 rather than #2.
2. **Fix the `thewheel.z64` `?jit` wedge at VI 245** — see its section above.
   It is a shipped ROM and a hard blocker on flipping `?jit` to default.
3. Wave 11 (FP), now the top measured lever on the heavy set — compares and
   BC1 first (exactly emittable), converts second (rounding/UB risk). See
   "Next by measured weight, AFTER waves 9 + 10a".
4. Full-library differential sweep (all 27 ROMs bit-identical per VI) — the
   gate a5efb66 named before the ?jit default can flip. `thewheel` already
   proves this sweep is not a formality.

Standing note for whoever measures next: run
`node tools/n64_emit_unit_test.mjs` first. It is ~1 second, needs no browser,
and the wave-9 session lost a full differential cycle to a bug it catches
instantly.

## M3 — FPU (COP1) + the long tail
- [ ] COP1 moves/arith/converts/compares native (the GC lfs/stfs lesson:
      bit-exactness first, fp-rounding parity tests)
- [ ] TLB-mapped code paths + adler32 revalidation behavior preserved
- [ ] cache-op / self-modifying code: page invalidation aliases
      (KSEG0/KSEG1 ^0x20000000, TLB physical twins) under JIT

## M4 — performance burn-down
- [ ] Baselines per game (audio-rate speed metric) interp vs JIT on the
      27-ROM sweep; per-block fallback census (which ops still interp)
- [ ] Burn down hottest fallbacks by measured frequency, not guesses
      (the GC psq/FP lesson; cite disasm + counts before claiming any
      "throughput" cause — CLAUDE.md gate #6)
- [ ] Bar: ≥100% native-speed sustained in-game on the heavy set
      (Gauntlet Legends, DK64, Conker, Pod Racer in-race), on-device

- [x] Wave 6 (2026-06-12, 43eb990+): FPR-aware differential checksum
      (reg_cop1_fgr_64 + FCR31) FIRST, then native MULT/MULTU/DIV/DIVU
      (exact def mirrors incl. full-64-bit MULT operands, arithmetic-shift
      MULTU hi, skip-on-zero-divisor) + MFHI/MFLO/MTHI/MTLO + the COP1
      family (CU1-guarded moves/arith/loads/stores through the LIVE
      pointer banks; CVT/compares/BC1 stay fallback). Fallback census
      HALVED on FP-heavy titles (sm64 14,260->6,740; oot 27,452->14,387).
      All gates green with float state in the checksum.
- [ ] OPEN PERF QUESTION (measure on a COOL machine before any fix):
      order-alternating A/B under full throttle reads ~0.89x after wave 6
      (was 1.10x at wave 4) — either FP emission costs more than the
      interp ops it replaces, or it is throttle-regime distortion.
      ?jit=nofp isolates FP emission for one-variable attribution;
      --no-liftoff probe was inconclusive under thermal drift. Candidate
      fixes if real: hoisted CU1/bank-pointer caching with
      fallback-invalidate; page-batched multi-function modules
      (amortized instantiation + V8 tier-up budget accumulation).
- [x] Wave 7 (2026-06-12, e3e1eba): cross-page + register jumps native —
      all _OUT branches via jump_to_address/jump_to_func, runtime
      last_addr = PC->addr after jump_to, JR/JALR target captured pre-
      link/slot, JALR links rd. Branch family complete except IDLE.
      Census: mariokart fallback 4,632->2,716; sm64 ->3,406; oot ->10,013.
      Remaining fallback: CVT/FP-compares/BC1, COP0/ERET/cache, LWL/LWR,
      IDLE — all rare classes; emit only if a runtime census shows weight

## Measurement rules (M4 spine, learned 2026-06-12)
- Per-frame CPU cost via _neil_frame_cost_* (timed retro_run) is the
  throughput metric — immune to the frame limiter. tools/_jit_speed_ab.mjs
  runs the interleaved A/B.
- THERMAL THROTTLING invalidates absolute numbers on this machine (i9 MBP;
  pmset -g therm CPU_Speed_Limit observed at 20 under campaign load).
  Only same-window interleaved ratios are valid; discard rounds whose
  absolute costs shifted mid-round. ALSO: alternate arm order between
  rounds (tools/_jit_speed_ab.mjs second arg ab|ba) — the second arm is
  penalized under monotonic heating; and fully-throttled-regime ratios
  shift the bottleneck mix (not representative of healthy hardware).
- The wave-gate is: differential x3 (mariokart/sm64/oot) + page e2e +
  interleaved A/B ratio. Correctness gates alone DO NOT catch perf
  regressions — and a 'regression' under throttle may be the machine.

## Standing rules
- The interpreter is the always-available oracle: every emitter lands with
  a differential test; a red test must be a valid repro (GC lfs lesson)
- No instrumentation accumulation: diags are temporary, perf verdicts only
  on clean builds (gate #8)
- dist/ ships only deliberately: page + core versions move together

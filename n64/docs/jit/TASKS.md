# N64 JIT — task list

Read README.md first (seam facts + contract). Canonical iteration loop, per
CLAUDE.md gate #1: build = `source emsdk/emsdk_env.sh && cd n64/N64Wasm/code
&& make -j8` (writes straight into ../dist/ — restore dist via git if the
result is not meant to ship); probe = `node tools/n64_boot_test.mjs <rom.z64>`
against `npm run web` on :8080. Measurement hygiene gate #8 applies: clean
build, baseline first, one change at a time.

## M0 — build reproducibility  ✅ DONE 2026-06-12, RE-DONE 2026-09-01 under emsdk 6.0.2
- [x] **2026-09-01: the vendored emsdk moved 3.1.67 → 6.0.2 and BROKE this
      milestone; it is repaired and the dist now SHIPS FROM SOURCE** (213d49c0).
      See "NEXT ACTIONS" item 4 for the three causes and the full gate. The two
      that will bite anyone touching another emulator's build the same way:
      emscripten 6 attaches `FS`/`HEAP*` to `Module` only when EXPORTED, and
      `Module.calledRun` no longer exists at all — a harness gating on it
      reports a healthy core as `launched:false` with empty logs.
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

## thewheel.z64 ?jit wedge at VI 245 — ✅ FIXED 2026-09-01 (607b3b1)

**RESOLVED, and the hypothesis recorded below was WRONG — read the fix first.**
It was NOT poll-starvation. It is **a hard wasm trap**, localised by a mode
ladder:

    interpreter                       VI 400 OK
    ?jit=wrap (13,062,207 dispatches) VI 401 OK   -> plumbing fine
    ?jit=v05 (per-block module)       VI 401 OK   -> instantiation fine
    ?jit=nofp (nativeFP: 0)           245, RuntimeError: null function
    ?jit=emit                         245, same

So: native emission, NOT plumbing, NOT FP.

**ROOT CAUSE, IN THE VENDORED CORE (not the emitter):** `get_block_memsize`
(`recomp.c:2164-2168`) allocates `(length+1)+(length>>2)` entries and
`init_block` memsets all of it to 0 (`:2207`), but the NOTCOMPILED init loop
only covers `i<length` (`:2244-2255`). **The overflow entries stay null.** The
cached interpreter never falls into them; the JIT's fall-through exit sets
`PC = entryPtr + span*stride` and the dispatcher then calls `PC->ops()` on a
null entry.

Fix is JS-only, no core rebuild: a null-ops guard that refuses such spans
(`n64/bementalJIT/mips_emit.js:841`, counted as `stats.nullOpsRejects`).
Gates: unit corpus 22/22; thewheel differential @400 VI det=PASS jit=PASS.

The lesson worth carrying: a liveness failure under `?jit` is not evidence the
EMITTER is wrong. The mode ladder (wrap -> v05 -> nofp -> emit) costs four runs
and separates plumbing / instantiation / FP / emission before any hypothesis.

<details><summary>Original 2026-08-29 evidence, kept for the record</summary>

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

^ That hypothesis (poll-starvation) was WRONG. See the fix above.
</details>

## Next by measured weight, AFTER waves 9 + 10a

    rom                fb/iter  MTC0  FPcvt  FPcmp+BC1  offRDRAM  other
    dk64                0.278    4.8   42.3     19.1       2.8     15.7
    bk-jiggiesoftime    0.697    5.7   46.1     31.3       2.9      2.1
    banjoChristmas      0.658    4.6   47.1     33.4       2.6      1.5
    Banjo-Dreamie       0.670    5.5   45.8     32.1       2.8      1.7
    clayFighter         0.642   28.4   17.8     24.2       0.6      0.2
    pkmnsnap            0.351   22.7   29.0      7.0       7.9      3.1
    flyingDragon        0.087   28.4    7.0      2.9      16.0      4.5

- [x] **Wave 11 (FP) — 11a (converts) DONE 2026-09-01, 11b (compares + BC1)
      DONE 2026-09-02.** Both sub-levers landed. The risk assessment written
      here was BACKWARDS in both halves and both corrections came from reading
      a compiled/dispatched artifact rather than the C:
      - ~~compares + BC1 are exactly emittable with plain wasm~~ — TRUE for
        the FCR31 result, FALSE for the instruction. Eight of the sixteen
        predicates carry an `isnan -> stop = 1` side effect that fpu.h does
        not show. See the wave-11b section.
      - ~~converts are the risky half~~ — they were the SAFE half once the
        shipped binary's own lowering was disassembled. See wave 11a.
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

## Wave 11a (2026-09-01) — FP converts native; compares/BC1 BLOCKED, and why

TASKS.md required, before any convert emitter was written, that someone
**determine what the SHIPPED dist wasm actually emitted for `trunc_w_s`**,
because `(int32_t)truncf(f)` is C UNDEFINED BEHAVIOUR out of range and fpu.h
therefore does not define the answer. That determination was made by
disassembling the vendored binary (`wasm2wat n64/N64Wasm/dist/n64wasm.wasm`),
and it changed the plan: **the converts are the SAFE half, not the risky half.**

Four facts, each read off the shipped artifact rather than the C:

1. **There is no saturating conversion in the build.** `i32.trunc_sat_*` and
   `i64.trunc_sat_*` occur **0 times** in the whole 2.6 MB module, while the
   trapping `i32.trunc_f32_s` occurs 128 times. The toolchain was built without
   nontrapping-fptoint, so every float->int cast is the TRAPPING opcode and
   LLVM had to guard it.
2. **The guard LLVM emitted is simple, uniform, and exactly reproducible**
   (func 2548 = TRUNC.W.S, 2539 = FLOOR.W.S, 2544 = CEIL.W.S, 2547 = TRUNC.W.D,
   2545 = TRUNC.L.D, 2546 = TRUNC.L.S):

        r = <round>(x);  if (|r| < 2^31) dest = (i32)r;  else dest = INT32_MIN

   with 2^63 / INT64_MIN for the `.L` forms. **NaN takes the else arm**, since
   `abs(NaN) < k` is false — so on this build NaN converts to **INT_MIN**, and
   a "sensible" saturating emitter would have been WRONG on both NaN (0) and
   positive overflow (INT32_MAX). This is exactly the trap the task warned of,
   and it was resolved by reading the binary rather than reasoning about C.
3. **`set_rounding()` is INERT here.** In CVT.S.W (2563), CVT.S.L (2561),
   CVT.D.L (2558) and CVT.S.D (2564) it compiles to a load of FCR31, a table
   index, and then a literal **`drop`** — wasm has no dynamic rounding mode, so
   `fesetround()` cannot affect a result. Every int->float and float->float
   convert is therefore plain round-to-nearest-even, needs no FCR31 access, and
   is a single wasm opcode.
4. FCR31 lives at **63865504** in the shipped binary; `reg_cop1_simple` is at
   70682880 and `reg_cop1_double` at 70683008.

**Emitted (16 opcodes), each verified against its shipped counterpart:**
TRUNC/CEIL/FLOOR `.W.S .L.S .W.D .L.D`, and CVT `.S.W .D.W .S.L .D.L .D.S .S.D`.
The emitted block was dumped and disassembled: it is instruction-for-instruction
the shipped sequence (`f32.load; f32.trunc; local.tee; f32.abs; f32.const 2^31;
f32.lt; if(i32) ... i32.trunc_f32_s else i32.const -2147483648; i32.store`),
inside the existing CU1 guard. `stats.nativeFPCvt` counts it, so a wave that
silently emitted nothing cannot pass the gates looking green (the wave-10a
`nativeCop0` lesson).

**NOT emitted, and these are refusals with reasons, not omissions:**
- **ROUND.W/L.\*** lowers to a `roundf()` CALL (`call 700`, func 2553). C
  `round()` is half-AWAY-from-zero; wasm `f32.nearest` is half-to-EVEN. They
  differ at exactly .5, so `f32.nearest` would NOT be bit-exact. Red test
  pins this.
- **CVT.W.\* / CVT.L.\*** dispatch on `FCR31&3` (funcs 2554-2557).
- **C.cond.\* and BC1\*** read/write FCR31 bit 23 (0x800000). The compare
  shape was confirmed too (func 2513 = C.UEQ.S: `FCR31 = (FCR31 & ~0x800000) |
  (cmp << 23)`, with the `u`-forms setting the bit on NaN exactly as fpu.h
  says) — so these are *semantically* ready to emit.

  **They are blocked on ONE LINE OF CORE CODE, not on the emitter.** All three
  need FCR31's ADDRESS, which is not in the `jit_params` block (recomp.c:2500-
  2542 ends at index 42) and is NOT derivable from any param that is: FCR31 is
  ~6.8 MB away from `reg_cop1_simple`, in a different section, so there is no
  wave-10a-style layout identity to assert, and a guessed address would
  silently corrupt FCR31 rather than fall back. The fix is
  `jit_params[43] = (uint32_t)(uintptr_t)&FCR31;` — but the core **cannot
  currently be rebuilt**: the vendored emsdk now reports `6.0.2`
  (`emsdk/upstream/emscripten/emscripten-version.txt`) and CLAUDE.md records
  that `libretronew.c` no longer compiles under it. **So the largest remaining
  FP lever on the heavy set — compares + BC1, 19-33% of what still falls back
  on dk64/banjo — is gated on restoring the N64 build toolchain, and that is
  now the highest-value non-emitter task in this campaign.**

**Why wave 11a is structurally OUTSIDE the join-contract bug class** that
produced the two latent divergences below: `roundToIntNat` and `plainCvtNat`
take the param block only — they never call `C.read`, `C.ensure` or
`C.writeFromStack`. A convert reads and writes FPR memory through the live
bank pointers and touches the GPR register cache not at all, so there is no
compile-time cache state that can escape one arm of a branch. The only
conditional it introduces is the value-guard, and both of its arms produce the
same wasm type and join immediately.

- [x] Unit corpus extended 22 -> 47 cases, all green, and **red-test discipline
      verified**: run against `git show HEAD:...mips_emit.js`, the 17 new
      behavioural convert cases all FAIL and the 23 pre-existing ones still
      pass. The corpus now models both FPR banks (it previously filled only
      `reg_cop1_simple[0]`, so any convert test would have read a null bank
      pointer).
- [x] **Emitted bytes verified against the shipped lowering directly.** The
      emitter's own output for TRUNC.W.S was dumped and disassembled, and it is
      the shipped func-2548 sequence instruction for instruction
      (`f32.load; f32.trunc; local.tee; f32.abs; f32.const 0x1p+31; f32.lt;
      if(i32) local.get/i32.trunc_f32_s else i32.const -2147483648; i32.store`)
      inside the CU1 guard. This is stronger than an input/output test: it
      compares the generated code to the reference code.
- [x] **Differential PASS x4 at 600 VI frames with the determinism control
      PASS on every one** (2026-09-01, `CPU_Speed_Limit` 100 before and after,
      load 3.71-5.11): mariokart, sm64, oot, and dk64 — dk64 included
      deliberately because converts are 42.3% of its remaining fallbacks. 0
      emit failures, 0 page errors on any arm.

        rom        blocks  nativeFP  fallbackOps  emitFails
        mariokart     475      1374          321          0
        sm64          851      5152          719          0
        oot          1487      9632         1820          0
        dk64         1216     10223         1788          0

- [x] `n64/index.html`'s `__jitStats()` copies fields EXPLICITLY, so it did not
      surface `nativeFPCvt` and the differential round above could not prove
      the new path had fired at all — the exact wave-10a trap, caught here by
      looking for the counter rather than trusting the PASS. `nativeFPCvt` is
      now surfaced (index.html:2265).
- [x] **LIVENESS COUNTER CAPTURED — ✅ 2026-09-01.** `nativeFPCvt` is NONZERO on
      live ROMs, read off `__jitStats()` in `tools/n64_jit_diff_test.mjs` runs
      that also returned determinismControl PASS and jitVsInterp PASS at 600 VI:
      **sm64 382, mariokart 125, oot 809** (0 emitFails, 0 instantiateFail on
      all three). ⚠ **THOSE THREE NUMBERS ARE INFLATED — the counter
      double-counted, fixed 2026-09-02.** `emitCop1` is the only emitter that
      bumps a stat itself, and compileSpan PROBES a branch's delay slot with a
      throwaway register cache before deciding to emit it — the probe discarded
      its bytes but kept the increment, so every FP op in a delay slot counted
      twice. Proven by the wave-11b unit corpus, which read `nativeFPCmp` = 2
      for a single C.LT.S in a delay slot; fixed in compileSpan by restoring
      the two counters around the probe. The conclusion is unchanged (nonzero
      is nonzero) but a liveness counter that over-reports is worse than none.
      The post-fix readings are sm64 348, mariokart 116, oot 750 — **but those
      are NOT a clean isolation of the fix**: they come from the wave-11b
      build, which also changed which spans compile (mariokart 475 -> 481
      blocks), so part of each delta is emission change, not de-duplication.
      Only the double-count itself is proven; the size of it is not measured.
      That is the single direct observation this item asked for, and
      it replaces the two-step inference below. Taken incidentally while gating
      the restored emsdk-6.0.2 core build (213d49c0) — on the REBUILT binary,
      whose emission stats are bit-identical to the vendored core's, so it
      applies to both. dk64 specifically is still unread; the three above are
      sufficient to prove the path fires, not to rank it.
      <details><summary>Original blocked note, kept for the record</summary>
      The re-run to read `nativeFPCvt` off a live ROM was queued through
      `probe_lock.sh` and **timed out after 2400 s without ever acquiring the
      lock** (11-12 sibling agents queued; the lock is an unfair `mkdir` spin,
      so a waiter can starve indefinitely). It correctly refused to steal a
      live lock. What stands in its place is an INFERENCE, not a measurement:
      this file's own census already records these exact opcodes EXECUTING in
      these ROMs (sm64 TRUNC.W.S 23.7%, oot CVT.S.W 7.3%, dk64 FPcvt 42.3% of
      fallbacks), and the unit corpus proves the emitter emits them — so they
      should now be native. **That is a two-step argument, not the single
      direct observation wave 10a insisted on. Re-run
      `node tools/n64_jit_diff_test.mjs dk64.z64 600` and read `nativeFPCvt`
      before treating wave 11a as fully gated.**
      Worth fixing at the rig level too: the lock has no queue fairness, and a
      waiter that loses ~12 races in a row starves while the box sits at load
      0.5-1.0.
      </details>

## Wave 11b (2026-09-02) — FP compares + BC1 native; the wrapper fpu.h hides

Landed in `2877e30f`. `jit_params[43] = &FCR31` was the one line 11a was
blocked on; the emsdk-6.0.2 build restore (action #4) unblocked it, and the
core now rebuilds and ships from source with the param added.

**THE PLAN CHANGED ON A CODE READ, and this is the wave's main lesson.** The
bullet above called compares "exactly emittable with plain wasm" on the
strength of `fpu.h:222-388`. That reading is right about the FCR31 result and
WRONG about the instruction. The dispatched op is not the fpu.h helper: for the
eight SIGNALLING predicates — **SF NGLE SEQ NGL LT NGE LE NGT, fn 0x38-0x3F** —
`mips_instructions.def` wraps the helper (`:1301-1391` for the S forms,
`:1000-1090` for the D forms) in

    if (isnan(*reg_cop1_simple[cffs]) || isnan(*reg_cop1_simple[cfft]))
    { DebugMessage(M64MSG_ERROR, "Invalid operation exception in C opcode");
      stop = 1; }

and `stop` is the global that ends emulation (`r4300.c:53`, checked at
`:147-166`). The FCR31 bit comes out **identical** either way, so a plain-wasm
emitter is bit-exact on every architectural checksum this campaign gates on —
GPR, CP0, FPR, FCR31, PC — and still fails to halt where the interpreter halts.
`C.LT.S` and `C.LE.S` are in that group and are the two most common FP compares
in these ROMs (dk64 census: `C.LT.S` 117,406 + `C.LE.S` 23,051 executions in
one window), so this was not a corner. Those eight now carry a NaN pre-test
that hands the instruction back to the interpreter and exits; the
non-signalling eight (fn 0x30-0x37) have no wrapper and need no guard.

**Same shape as wave 11a**: read the code that actually runs, not the helper it
calls. 11a had to disassemble the shipped `.wasm` because fpu.h's casts are C
UB; 11b had to read the `.def` because fpu.h is only half the instruction.

Emission notes:
- 12 of 16 predicates are ONE wasm compare. A wasm float relation is false
  whenever an operand is NaN, which is exactly what fpu.h's isnan-clear forms
  and its no-check forms both produce. The `u`-forms stay at one compare too:
  **`ult(s,t) == !(s >= t)`** and **`ule(s,t) == !(s > t)`** (NaN makes ge/gt
  false, so the negation is true; ordered operands give ordinary `<`/`<=`).
  Only `UN` and `UEQ` genuinely need both operands twice, which is why
  `L_F32B`/`L_F64B` were added — appended as NEW local groups so `L_F32`/
  `L_F64` keep their wave-11a indices.
- `C.F.*` takes no operands at all (`fpu.h:221-224`) and loads none.
- **BC1 decodes as `recomp_bc[(word >> 16) & 3]` (`recomp.c:1584`) — bits 20:18
  are IGNORED.** The emitter mirrors that mask, not MIPS-IV's wider `cc` field,
  because the interpreter is the oracle.
- `DECLARE_JUMP`'s `cop1` flag (`mips_instructions.def:741-744`) runs
  `check_cop1_unusable()` BEFORE anything else, and on CU1-clear it raises the
  exception and returns WITHOUT branching. Emitted as a bail PREFIX rather than
  a wrapper: at that point not one byte of the instruction has run, so
  re-executing the whole branch under the interpreter is exact — the same
  argument `slowArm()` makes for a faulting delay slot, only stronger (there
  the link register had already been written).
- **VERSION SKEW FAILS SAFE.** FCR31 sits ~6.8 MB from `reg_cop1_simple` in a
  different section, so unlike wave 10a's `g_cp0_regs` there is NO layout
  identity to assert. A page reading index 43 of an OLD 43-entry `jit_params`
  would get adjacent static data and **store the condition bit through it**.
  `jit_params[44]` now carries a magic (`0x4E36344A`) the page must match
  before it trusts index 43; without it compares and BC1 fall back.
  `__jitStats().fcr31` surfaces the value so a skew reads as `fcr31: 0` rather
  than as silently-zero counters — a zero counter alone cannot distinguish
  "core too old" from "this ROM has no FP compares".

- [x] **Differential PASS x5 at 600 VI with the determinism control PASS on
      every one**, `CPU_Speed_Limit` 100 before and after, load 1.0-4.0:
      mariokart, sm64, oot, dk64, bk-jiggiesoftime. 0 emitFails, 0 page errors.
      `fcr31` nonzero (71215636) on all five, which is what proves the magic
      matched in the shipped core.

        rom               blocks  nativeFP  FPCmp  FPBr  fallbackOps  (11a fbOps)
        mariokart            481      1411     44    42          235        321
        sm64                 851      5247    107   102          508        719
        oot                 1487     10021    590   552          673       1820
        dk64                1216     10535    494   448          839       1788
        bk-jiggiesoftime    2064      8613    515   481          524          —

- [x] **EXECUTION PROVEN, not inferred** — the wave-10a trap, closed with a
      counting arm rather than an emit-site counter. Census A/B on dk64, same
      `600 900` window, the emitter file swapped as the ONLY variable (same
      core, same page, same drive script):

        BC1FL  146,076 -> 0     C.LT.S  117,406 -> 0     BC1F   47,253 -> 0
        C.LE.S  23,051 -> 0     C.EQ.S   19,419 -> 0     C.LE.D 18,570 -> 0
        C.EQ.D   9,444 -> 0     C.LT.D    8,289 -> 0     BC1T    5,088 -> 0
        BC1TL    1,068 -> 0                       TOTAL 395,664 -> 0

      Total fallback EXECUTIONS 1,054,063 -> 655,551 (**-37.8%**), against the
      class's measured 37.5% share — the drop tracks the target class and
      nothing else, the same evidence shape wave 9 used. `fb/iter` 0.142 ->
      0.088. Block iterations moved only +0.24% (7,420,747 -> 7,438,852), so
      the ratio is meaningful. `BEQL@slot:C.EQ.S` (18,109) also disappeared:
      branches rejected because their delay slot was a compare are now
      emittable, a wave-8 knock-on that was not designed for.
- [x] Unit corpus **47 -> 76 cases**, all green, red-test discipline verified:
      run against `git show HEAD~1:...mips_emit.js`, **all 30 new cases FAIL**
      and the 46 pre-existing ones still pass. The corpus models FCR31 and an
      `opts.noFcr31` arm (an old core / magic mismatch) so the fall-back path
      is covered too. The NaN cases are the load-bearing ones: `C.LT.S` with a
      NaN operand must leave FCR31 untouched AND must not execute the next
      in-block instruction, while `C.EQ.S` with the same input must do both —
      an emitter without the signalling guard fails the first and passes the
      second.
- [ ] **HONEST LIMIT ON REACH.** Neither guard arm was observed firing on a
      live ROM: no `CMPNAN:` and no `CU1MISS:BC1*` bucket appeared in the dk64
      census window. They are proven by executing unit tests, not by a ROM —
      the same standing caveat wave 6's `cuGuard` carries. A census sweep
      looking specifically for those buckets across the heavy set would close
      it.

**Next FP items this exposed.** `CFC1` (13,620 execs) and `CTC1` (5,785) are
now visible in dk64's post-wave ranking — they move FCR31/FCR0 wholesale and
FCR31's address is finally available, so they are cheap. dk64's 64-bit integer
cluster (DMULT 10.3% + DADD 10.2% + DSLL32 9.3% + DSRA32 9.3% + DMULTU 9.2% =
**48.3% of what remains**, up from 14.7% pre-wave because the denominator
shrank) is now by far its largest block, and every one is an exact wasm i64 op.

## Full-library sweep, 27 ROMs (2026-09-02) — 24 PASS/PASS, and the 3 that did not

`bash tools/probe_lock.sh run -- bash tools/n64_jit_sweep.sh`, 600 VI per ROM,
interpreter/interpreter-control/`?jit` per ROM. `CPU_Speed_Limit` **100 on
every row**, 1-minute load **2.46-6.34**. The determinism control PASSED on all
27, so the method is valid everywhere — including on the three that failed.
Full table in the commit; `fcr31` was nonzero on all 24 that reported stats,
which is the shipped-core proof that the wave-11b version magic matched.

**This sweep is the gate a5efb66 set before `?jit` can become the default, and
on 2026-09-02 it was NOT clean.** (It went 27/27 on 2026-09-04 and the flip has
happened — see the end of this file.) The sweep earned its keep: two of the
three are problems no per-wave gate in this campaign would ever have found,
because both ROMs are outside the reference trio.

> **STATUS 2026-09-04. ALL THREE ARE FIXED and `?jit` IS NOW THE PAGE
> DEFAULT** — see "BOTH REMAINING SWEEP BLOCKERS FIXED" below and the flip
> record at the end of this file. (1) was `recomp.c`'s RNOP rewrite of an
> r0 destination. (2) and (3) turned out to be ONE bug: a JIT block invoked as a
> branch DELAY SLOT. Read each subsection below — the ✅ header states which.
>
> **STATUS 2026-09-02 (superseded, kept for the trail).** (1) is **FIXED** — and
> the cause was NOT the construct the ablation named. (2) and (3) are **STILL
> OPEN** and both are now correctly CLASSIFIED where they were previously
> mis-classified: conker is a **divergence**, not a throughput pathology;
> gauntletLegends is a **wedge**, not conker's slowness. Two harness bugs that
> were producing those mis-classifications are fixed. **The `?jit` default
> therefore STAYS OFF.**

## Sweep RE-RUN after the fixes (2026-09-02) — **25 of 27 PASS/PASS**

`bash tools/probe_lock.sh run -- bash tools/n64_jit_sweep.sh`, 600 VI per ROM,
on the fixed emitter (`mips_emit.js` mtime 17:31) and the fixed harness (18:29),
both settled before the first row at 18:31 — one rig, no mid-run edits.
**`CPU_Speed_Limit` 100 on every single row**, 1-minute load **2.57-5.14**. The
determinism control PASSED on all 27, `emitFails` is 0 on all 27, and `fcr31` is
nonzero on all 25 that reported stats. **Exit status 1 — the gate is NOT clean
and the `?jit` default stays off.**

        rom                     det   jit                                      firstDiff  liveness                                           blocks  fallbackOps  emitFails  nullOpsRejects  load  limit
        Banjo-Dreamie.z64       PASS  PASS                                     -1         -                                                  2063    524          0          93              4.59  100/100
        banjo-tooie.z64         PASS  PASS                                     -1         -                                                  5215    8859         0          187             4.12  100/100
        banjoChristmas.z64      PASS  PASS                                     -1         -                                                  2062    524          0          93              4.35  100/100
        bk-jiggiesoftime.z64    PASS  PASS                                     -1         -                                                  2063    524          0          93              5.14  100/100
        blitz2001.z64           PASS  PASS                                     -1         -                                                  1025    300          0          26              4.66  100/100
        clayFighter.z64         PASS  PASS                                     -1         -                                                  772     137          0          33              4.73  100/100
        conker.z64              PASS  INCOMPLETE (jit reached 454/600)         82         jit:SLOW (VI advanced 437->452 in 5s = 3.00 VI/s)  989     368          0          68              4.48  100/100
        crusin.z64              PASS  PASS                                     -1         -                                                  460     290          0          25              3.79  100/100
        diddyKongRacing.z64     PASS  PASS                                     -1         -                                                  828     802          0          72              4.58  100/100
        dinosaurplanet.z64      PASS  PASS                                     -1         -                                                  881     543          0          81              4.04  100/100
        dk64.z64                PASS  PASS                                     -1         -                                                  1216    839          0          95              4.01  100/100
        flyingDragon.z64        PASS  PASS                                     -1         -                                                  507     189          0          33              3.49  100/100
        gauntletLegends.z64     PASS  INCOMPLETE (jit reached UNREADABLE/600)  -1         jit:NO CDP RESPONSE (main thread never yielded)    -       -            -          -               3.41  100/100
        mariokart.z64           PASS  PASS                                     -1         -                                                  475     234          0          34              5.06  100/100
        marioo.z64              PASS  PASS                                     -1         -                                                  581     194          0          36              5.09  100/100
        mariopartynew.z64       PASS  PASS                                     -1         -                                                  739     170          0          22              4.24  100/100
        newTetris.z64           PASS  PASS                                     -1         -                                                  377     255          0          28              3.33  100/100
        oot.z64                 PASS  PASS                                     -1         -                                                  1487    673          0          102             4.07  100/100
        papermario.z64          PASS  PASS                                     -1         -                                                  658     1350         0          27              3.60  100/100
        pkmnsnap.z64            PASS  PASS                                     -1         -                                                  705     350          0          42              3.45  100/100
        podracer.z64            PASS  PASS                                     -1         -                                                  472     264          0          34              3.42  100/100
        sm64.z64                PASS  PASS                                     -1         -                                                  851     508          0          58              3.54  100/100
        starfox.z64             PASS  PASS                                     -1         -                                                  470     263          0          35              3.23  100/100
        starfoxsurvival.z64     PASS  PASS                                     -1         -                                                  1119    394          0          61              2.57  100/100
        superMarioStarRoad.z64  PASS  PASS                                     -1         -                                                  584     194          0          38              3.57  100/100
        thewheel.z64            PASS  PASS                                     -1         -                                                  1290    214          0          48              2.68  100/100
        zeldaMasterOfTime.z64   PASS  PASS                                     -1         -                                                  1475    660          0          91              3.27  100/100

superMarioStarRoad moved DIVERGED@24 -> PASS. The two remaining rows are the
ones the old rig could not describe at all: both used to be a bare `NOJSON`,
and both now carry their own diagnosis in the row —
**conker is SLOW *and* WRONG (`firstDiff 82`)**, gauntletLegends is a **WEDGE**
(`NO CDP RESPONSE`, and `UNREADABLE` rather than a fake `0` frame count).
That is the whole value of the harness fix: the sweep row now says which of the
three failure modes it is.

### (1) `superMarioStarRoad.z64` — ✅ FIXED 2026-09-02. It was NOT the _OUT tail.

**RESOLVED. `node tools/n64_jit_diff_test.mjs superMarioStarRoad.z64 600` now
reports `determinismControl: PASS` / `jitVsInterp: PASS`, 584 blocks, 194
fallbackOps, 0 emitFails** (load 6.28 -> 3.91, `CPU_Speed_Limit` 100 before and
after). Read the cause before the historical evidence below — **the localisation
recorded there pointed at the wrong construct, and the reason it did is the
lesson.**

**ROOT CAUSE: `recomp.c` rewrites an instruction whose DESTINATION IS r0 into a
plain NOP, and the emitter emitted it anyway.** Most recomp.c emitters end with
`if (dst->f.i.rt == reg) RNOP();` / `if (dst->f.r.rd == reg) RNOP();` — `reg` is
the global `int64_t reg[32]` and `recompile_standard_{i,r}_type` binds
`f.i.rt = reg + rt` (recomp.c:99-117), so the test is exactly "destination is
r0". `RNOP()` sets `dst->ops = NOP` (recomp.c:137-141): no arithmetic, **no
memory access**, and no write to reg[0]. `mips_emit.js`'s header asserted the
blanket opposite ("this core's interpreter WRITES reg[0] for ops whose
destination is r0"), which is true only of the ops recomp.c does NOT guard —
MTHI/MTLO/MULT/MULTU/DIV/DIVU (destination hi/lo), MTC1/DMTC1 (destination an
FPR), and every store (no destination). `grep -c "== *reg) RNOP()" recomp.c`
returns **58** — that is how many emitters carry the guard.

**HOW IT WAS LOCALISED — a per-span bisect, which removed the confound the
older note below flags.** A temporary `?jitonly=<vaddr,...>` hook (added, used
and REMOVED; `n64/index.html` is byte-identical to `2877e30f`) compiles ONLY the
listed spans. Bisecting the 32 spans this ROM offers in 30 frames converged in
5 rounds on **one block, `0x802ca6d0`, compiled ALONE — `blocks: 1`,
`DIVERGED at frame 24`.** Its 6 instructions:

        802ca6d0 lui   $t2, 0x8034
        802ca6d4 lw    $t3, -0x4d70($t2)
        802ca6d8 addiu $t3, $t3, 1
        802ca6dc sw    $t3, -0x4d70($t2)
        802ca6e0 j     0x80327b98
        802ca6e4 addiu $zero, $zero, 0x101   <- DELAY SLOT, word 0x24000101

`RADDIU` (recomp.c:1770-1775) turns that delay slot into NOP. Runtime
confirmation, not inference: the live `precomp_instr.ops` array dumped for this
span reads `[2938, 2913, 2932, 2918, 2968, 3144, 3148, 3148]` — index 5 (the
`addiu $zero`) binds table index **3144**, a DIFFERENT op from index 2's
ordinary `addiu $t3, $t3, 1` (**2932**). The emitter computed `reg[0] + 0x101`
and stored `0x101` into reg[0]; the core stores nothing; reg[0] is in the
differential checksum.

**WHY THE OLD ABLATION SAID "_OUT tail".** Disabling `_OUT` emission made the
`j` fall back, and the interpreter then executed the delay slot itself — so the
symptom vanished for a reason that had nothing to do with `emitOutJumpTail`.
A class ablation tells you which SWITCH silences a bug, not which code is wrong;
only the single-block + single-instruction bisect separated those.

**FIX** (`mips_emit.js`): `SPECIAL_RD_NOP` / `ITYPE_RT_NOP` mirror recomp.c's
guarded set exactly, and `emitAlu`, `emitLoad`, `emitCop0` (MFC0) and `emitCop1`
(MFC1/DMFC1) emit NOTHING when the destination is r0. Two deliberate
non-generalisations, both load-bearing: **MULT/DIV/MTHI all encode `rd = 0`**, so
the guard is keyed on the opcode's real destination and not on the rd FIELD (a
field-keyed guard would silently delete them — the unit corpus has a control for
each); and a load into r0 must not even perform the ACCESS, which is why
`emitLoad` returns before touching the dispatch table. `JALR $zero, $rs` is the
same class from a different direction — `DECLARE_JUMP` writes the link only
`if (link_register != &reg[0])` (cached_interp.c:78-81) — and is fixed too.

**GATES**: unit corpus **76 -> 96 -> 102 cases**, all green; run against
`git show HEAD:...mips_emit.js`, **13 of the 20 r0 cases FAIL** and every
pre-existing case still passes. Differential PASS with determinism control PASS
on superMarioStarRoad (600 VI), mariokart (600 VI, 475 blocks) and oot (600 VI,
1487 blocks), 0 emitFails on all three.

<details><summary>Original 2026-09-02 localisation, kept for the record — its verdict was wrong</summary>

The first true correctness divergence this campaign has recorded. Localised in
six runs and **NOT caused by wave 11b** — every step is a measurement:

- **Control, HEAD~1 emitter, same ROM/frames: `DIVERGED at frame 24`, blocks
  33, fallbackOps 48 — identical.** So it predates wave 11b. (It also has
  `nativeFPCmp` 0 and `nativeFPBranches` 0, i.e. wave 11b emitted nothing at
  all for this ROM.)
- **Mode ladder** (the thewheel protocol): `?jit=wrap` **PASS**, `?jit=v05`
  **PASS**, `?jit=nofp` **DIVERGED at 24**, `?jit=emit` **DIVERGED at 24**.
  So: native emission, not plumbing, not instantiation, and NOT FP.
- **Per-class ablation** (temporary `?noemit=<class>` hooks, added, used, and
  REMOVED — the emitter is byte-identical to `2877e30f` and the unit corpus is
  76/76 on it):

        noemit=load    DIVERGED @24     noemit=store   DIVERGED @24
        noemit=alu     DIVERGED @24     noemit=cop0    DIVERGED @24
        noemit=branch  PASS

- **Sub-ablation inside the branch path** — only one arm clears it:

        noemit=brslot   DIVERGED @24    noemit=brreg    DIVERGED @24
        noemit=brlikely DIVERGED @24    noemit=brplain  DIVERGED @24
        noemit=brout    PASS

  **So the fault is in the _OUT branch path — wave 7's `jump_to_address` /
  `jump_to_func` tail (`emitOutJumpTail`), not wave 8's delay slots.**
  ⚠ One caveat on that last step, stated because it is a real confound: both
  PASSING arms (`branch`, `brout`) report 584 blocks while every failing arm
  reports 33. The most likely reading is that 33 is a CONSEQUENCE — a run that
  diverges at frame 24 never explores more code — and `brplain` is the control
  for it (it holds blocks at 33, changes only WHICH branches are native, and
  still fails). But "the culprit block simply never compiles under brout" has
  not been positively excluded. The next step is to dump the _OUT branch sites
  in those 33 blocks and diff one against the interpreter.

  ⚠ That caveat was RIGHT to be stated and the "most likely reading" was right
  too — 33 blocks is a consequence of diverging early, and the fixed emitter now
  compiles 584 on this ROM. But the verdict the ablation reached ("_OUT tail")
  was still wrong, for the reason given above.
</details>

## ✅ BOTH REMAINING SWEEP BLOCKERS FIXED 2026-09-04 — one bug, not two: **a JIT block can be invoked as a BRANCH DELAY SLOT**

`conker.z64` (a divergence at frame 82) and `gauntletLegends.z64` (a wedge) had
the SAME root cause. It is not in any opcode emitter — it is in the block
*entry* contract, and it is the reason 25 of 27 ROMs never saw it.

**THE BUG.** A JIT block is installed as ONE instruction's `precomp_instr.ops`.
The core calls `PC->ops()` in two places that require the callee to execute
**exactly one instruction** and return:

* `DECLARE_JUMP`'s delay slot — `PC++; delay_slot=1; PC->ops(); cp0_update_count();`
  (`cached_interp.c:87-91`). Reachable whenever a block ENTRY address is also
  some branch's `addr+4`.
* **`FIN_BLOCK`'s delay-slot path (`cached_interp.c:184-206`), which fires at
  EVERY 4KB page boundary.** When a branch sits in the last word of a page, its
  delay slot is the FIN_BLOCK pseudo-instruction; FIN_BLOCK then `jump_to()`s
  the next page, calls **that page's FIRST instruction** as the slot, and
  afterwards **restores `PC = inst+1`** — discarding whatever PC the callee left.

A whole span running there is wrong twice over. It executes instructions the
guest never issued (with `delay_slot` set, so any fault inside is recorded as a
BD exception), and — the part that actually killed conker — **its `last_addr`
and `Count` writes SURVIVE the PC restore.**

**THE WITNESS, not an inference.** A temporary negative-delta detector inside
`cp0_update_count` (added, used, REMOVED; `cp0.c` is byte-identical to
`2069a0a`) froze a 96-entry ring on the first `PC->addr < last_addr` event. It
fired **once** in the `?jit` arm and **zero times** in the interpreter arm over
the same window. The last two entries:

        PC->addr=0x10014024  last_addr=0x10013fec  delta=+56  delay_slot=1
        PC->addr=0x10014004  last_addr=0x1001402c  delta=-40  delay_slot=0

The first line is the JIT block's OWN branch tail (`beq $zero,$zero` at
`0x1001401c`, so `addr+8 = 0x10014024`) executing **with `delay_slot` set** —
which only a delay-slot invocation can produce. It set `last_addr` to its branch
target `0x1001402c`. FIN_BLOCK then restored `PC = inst+1 = 0x10014004`, and the
next `cp0_update_count()` computed `(0x10014004 - 0x1001402c) >> 2` on
**uint32**: `0xFFFFFFD8 >> 2 = 0x3FFFFFF6`, times conker's `count_per_op` of 3
(`rom_luts.c:382-383`) = **+0xBFFFFFE2**.

**The arithmetic closes exactly, which is the part that makes this a proof and
not a story.** The ring's own Count at that entry is `0x02e956eb`, and
`0x02e956eb + 0xBFFFFFE2 = 0xC2E956CD` — the *same* `0xc2e956cd` an independent
per-rAF sampler read off `g_cp0_regs[COUNT]` in the `?jit` arm at VI 83, against
`0x02f1921a` in the interpreter arm at the same VI. Two instruments, one number.
`next_interrupt` then collapsed to 0 (`interrupt.c:553-556` returns 0 once Count
is more than 2^31 past the queue head), and the guest fell into the permanent
interrupt storm the old note below measured as 599M `gen_interrupt` calls in
252 VI. **The 70x was never a throughput problem at all.**

**THE FIX** — the same move `slowArm()` already makes for a faulting delay slot:
hand the instruction back. The block now opens with

        if (delay_slot != 0) { call_indirect(<entry instruction's ORIGINAL ops>); br $exit; }

which is exact — it is literally what `PC->ops()` would have done — and costs one
i32 load per block entry. `&g_dev.r4300.delay_slot` is a new
`jit_params[45]`, and the param-block version magic at `[44]` moved
`0x4E36344A` -> **`0x4E36344B`** so a page/core skew cannot read it as garbage.
Unlike wave 11b's FCR31, a missing address here is not a lost optimisation but a
guest-corrupting bug, so **a core that does not supply it gets NO jit at all**:
`compileSpan` returns 0 for every span and counts `stats.noDelaySlotRejects`.

**REACH PROVEN ON REAL ROMs, not just in the unit corpus** (the wave-10a
lesson). The guard bumps a `#delayslot-entry` census bucket. Over the same
`300 400 --noinput` window:

        conker.z64           1,832 delay-slot entries   (#block-iter 2,334,318)
        gauntletLegends.z64    415 delay-slot entries   (#block-iter   990,812)
        mariokart.z64        bucket ABSENT (zero)

That last row is the control, and it is why this survived 11 waves: the
reference trio never enters a block through a delay slot at all.

**ARM-DIFFERENCE PROOF.** With a temporary flag disabling ONLY the guard —
same core, same emitter file, same frame count — `gauntletLegends.z64` at 300 VI
reproduces the original signature exactly (`INCOMPLETE (jit reached
UNREADABLE/300)`, `liveness: NO CDP RESPONSE (main thread never yielded)`); with
the guard it is `det PASS / jit PASS` at 300 **and** 600 VI. conker is
`det PASS / jit PASS` at 100, 300 **and** 600 VI, and now completes 600 VI well
inside the harness's ordinary 180 s wait — the slowness went with the storm.

**HOW IT WAS LOCALISED, and the one step that mattered.** The recorded
localisation ("one block `0x10014000`, span index 7") reproduced exactly, but
the reading of it was wrong: index 7 is not a defective instruction. A third
arm settled it — the same `?jitspan=8` block with the generic fallback changed
to *exit* the block instead of *calling* the interpreter op in place:

        ?jitonly=10014000                      DIVERGED at 82
        ?jitonly=10014000&jitspan=9            DIVERGED at 82   (branch emitted natively)
        ?jitonly=10014000&jitspan=8            DIVERGED at 82   (branch falls back, called IN-BLOCK)
        ?jitonly=10014000&jitspan=8&jitfbexit  PASS             (branch falls back, block EXITS first)
        ?jitonly=10014000&jitspan=7            PASS
        ?jitonly=10014000&jitspan=6            PASS

The emitted code for indices 0-6 is byte-identical across all six arms. So the
variable is not *which* code runs but **whether control returns to
`r4300_step`'s dispatch loop before the branch** — which is a statement about
the block's ENTRY context, not about any emitter. That is what pointed at the
delay slot, and the `cp0_update_count` watchdog then named it outright.
A span bisect that ends at `blocks: 1` is necessary but not sufficient: it
localises *where*, and the where can still be innocent.

**AN ADJACENT EXPOSURE OF THE SAME FAMILY, FOUND WHILE READING AND NOT FIXED —
because it is UNVERIFIED and the sweep is clean.** `emitOutJumpTail`
(`mips_emit.js`) is the ONLY place the emitter calls into the core WITHOUT first
storing `PC`: it writes `jump_to_address` and calls `jump_to_func`. That
function can fault — `update_invalid_addr()` on a TLB-mapped target raises a
refill exception — and `exception_general()` then runs `cp0_update_count()`
against whatever stale `PC` the block last wrote, while `emitCountBatch` has
already advanced `Count` but has NOT advanced `last_addr` (only the post-jump
`last_addr = PC->addr` does that). The interpreter's `X_OUT` reaches `jump_to()`
with `PC = fallPtr` and `last_addr = addr+8`. So the exact repair, if anyone
ever witnesses it, is to store both of those BEFORE the `jump_to_func` call —
`storeI32Const(p.pcGlobal, fallPtr)` and `storeI32Const(p.lastAddr, fallAddr)`.
**I have no witness that this fires**: the negative-delta detector caught only
the delay-slot event, on the one ROM it was pointed at. Stated as an identified
exposure with a named repair, not as a bug.

**Gates**: unit corpus **102 -> 107**, all green; run against
`git show HEAD:...mips_emit.js`, **3 of the 5 new cases FAIL** (the other two are
deliberate controls that must pass on both) and all 102 pre-existing cases still
pass. The new cases pin: a delay-slot entry runs ONE instruction and not the
span; a delay-slot entry moves neither `last_addr` nor `Count`; the same span
with `delay_slot` clear still runs natively and DOES move `last_addr`; and a core
without the param refuses the span outright.

<details><summary>The 2026-09-02 conker section, kept for the record — its
"which write puts last_addr ahead?" question is answered above</summary>

### (2) `conker.z64` — NOT 70x slow: it **DIVERGES at frame 82**. STILL OPEN.

**THE "THROUGHPUT PATHOLOGY" READING BELOW IS WRONG AND IS CORRECTED HERE
(2026-09-02). conker is a CORRECTNESS DIVERGENCE; the 70x is its symptom.** The
180 s wait hid it: at 600 VI the jit arm timed out before any comparison
happened. Run it at a frame count the arm can actually reach and the oracle
speaks:

        node tools/n64_jit_diff_test.mjs conker.z64  60   ->  det PASS, jit PASS
        node tools/n64_jit_diff_test.mjs conker.z64 300   ->  det PASS, jit DIVERGED at frame 82

**Localised to ONE block and ONE instruction index**, by the same two bisects
that solved superMarioStarRoad (temporary `?jitonly=` / `?jitspan=` hooks, both
REMOVED; `n64/index.html` is byte-identical to `2877e30f`):

- span bisect over the 928 spans conker offers in 100 frames, 15 rounds:
  **`0x10014000` alone — `blocks: 1`, `DIVERGED at frame 82`.** That page is
  **TLB-MAPPED** (vaddr < 0x80000000), which no ROM in the reference trio is.
- truncating that block's span (`?jitspan=N`) and walking N down, **twice, on
  two different emitter revisions**: `span<=18 .. span<=8` all diverge at 82,
  `span<=7` is CLEAN. Index 7 is the block's first branch,
  `beq $zero,$zero,+3` at `0x1001401c`. Control: every truncated span 6/7/8/9
  compiles and instantiates in the offline rig (`blocks:1, fails:0`), so
  "clean at 7" is not a compile failure.

  ⚠ Note what this does and does not say. At `span=8` that branch FALLS BACK
  (`i+1 >= span`), at `span=9` it is emitted NATIVELY, and **both diverge** — so
  the trigger is not the branch emitter. The minimal diff between the clean and
  dirty blocks, dumped and disassembled (`wasm2wat`), is literally one
  flush + `PC = instrPtr` + `call_indirect` + PC-divergence check. Why that
  changes anything is UNEXPLAINED, and saying so is the honest state.

**MECHANISM OF THE 70x, measured.** The slowdown is a consequence of the
divergence, not an independent problem:

- `Count` runs away. Sampling `g_cp0_regs[COUNT]` every rAF: the interpreter arm
  shows **no jumps at all** (Count 0x4d32351 at VI 123 = ~660K/VI), while the
  jit arm sits at **~0xC0000000 and wraps through 2^32 repeatedly**. `0xC0000000`
  is `3 * 2^30` — the exact signature of a WRAPPED `(a - b) >>> 2` multiplied by
  `count_per_op`, i.e. a Count update computed from a `last_addr` that is AHEAD
  of the current address. **conker's `count_per_op` IS 3**, cited not assumed:
  `main/rom_luts.c:382-383` maps both Conker's Bad Fur Day CRCs to 3 in
  `lut_cpop`. (A non-default `count_per_op` is not by itself the fault —
  dk64 runs at 1, `rom_luts.c:393-396`, and passes the differential.)
- With Count that far ahead, `next_interrupt` reaches **0** (`exception.c:144`,
  and `remove_interrupt_event` when the queue head is far past), so
  `next_interrupt <= Count` is true at EVERY branch tail.
- `?jit=census` over a driven `600 900`-shaped window (`60 240`) then reads:
  **`#gen_interrupt` 599,106,360** and **`#block-iter` 435,655,358** in 252 VI
  — 1.73M block entries per VI frame, against **2,856/VI** measured on the
  `?jit=wrap` arm (685,414 dispatches / 240 VI), a **605x** excess. The
  fallback census is three buckets at essentially equal counts —
  `MTC0.12` 54.4M, `SLOW:LW` 54.4M, `MTC0.11` 54.4M — and a per-block census
  bucket names the loop: `@80000180` (the general exception vector) 53.4M plus
  a chain of `@10007xxx` handler blocks. It is an interrupt storm in the guest's
  own timer handler, which keeps rewriting `Compare` only to have it expire
  immediately.
- The same census at BOOT with no input reads `#block-iter` **875/VI** and
  `#gen_interrupt` **1**. So the storm is phase-specific and begins after the
  divergence, not at boot.

**The plumbing is exonerated by the mode ladder** (`60 240` window, quiet box):

        ?jit=v05   interp 5.5 ms/f   jit 5.738 ms/f   0.959x   60 VI/s
        ?jit=wrap  interp 6.431      jit 6.325        1.017x   60 VI/s
        ?jit=emit  interp 6.574      jit 460.782      0.014x

So per-block instantiation and dispatch are at parity; only native emission
storms.

**Two real emitter bugs were found while chasing this and BOTH are fixed, and
NEITHER of them is conker's cause** — stated plainly because a fix that does not
move the symptom must not be reported as if it did:
1. the r0/RNOP class (section 1 above) — conker still diverged at 82 after it;
2. a THIRD join-contract instance in `emitLoad`: `fastBytes` ends with
   `C.writeFromStack(rt)`, so `slowArm`'s `C.flushSnapshot()` stored a wasm
   local that is only assigned on the FAST arm — zeroing `reg[rt]` and only then
   calling the interpreter op. Benign only while the op rewrites `rt`; NOT benign
   when it faults (TLB/MMIO), when `ops` is NOTCOMPILED, or when `rt == 0`. The
   old comment there asserted "the redundant later flush rewrites identical
   values", which was the same "benign" reasoning that hid bugs #1 and #2 of this
   class. Fixed with cuGuard's `preFlush` pattern; 4 red tests, RED against both
   `HEAD` and the r0-only intermediate. **conker still diverges at 82.**

**NEXT STEP for whoever picks this up**: the repro is now cheap and exact —
`?jitonly=10014000&jitspan=8` on `conker.z64` at 100 frames. The state dump at
the divergence already shows `next_interrupt = 0` and Count wrapped, so the
question is narrow: *which write puts `last_addr` ahead of the address the next
`cp0_update_count()` sees?* A `last_addr` sampler that records every write (not
just per-frame) would answer it directly.

<details><summary>Original 2026-09-02 "throughput pathology" reading, kept for the record — the verdict was wrong</summary>

The sweep row is `NOJSON` because `n64_jit_diff_test.mjs` threw a 180 s
timeout, and the throw is at **:61, the JIT arm** (both interpreter arms
completed). That is the thewheel SHAPE but not the thewheel CAUSE.
`n64_gameplay_ab.mjs conker.z64 ab 60 240` separates them, because it has a
stall detector (`:114-120`, "VI stalled at N" after 60 s of no VI progress):

        interp  perFrameMs = 6.574    lum 0.7   error=None
        jit     perFrameMs = 460.782  lum 0     error=None
        speedupWallX = 0.014

**The stall detector never fired — VI kept advancing.** So this is a
throughput pathology, not a hang: 460 ms per `retro_run` is ~2.2 VI/s, under
the 3.33 VI/s that 600 VI in 180 s requires, which fully explains the sweep
timeout. 70x is far beyond ordinary compile cost and points at recompile churn
(every invalidation rebuilds a `WebAssembly.Module` synchronously inside
`retro_run`, and compile time is charged to `retro_run`); `slotReuses` vs
`distinctSlots` on a conker run would test that directly.

**PRE-EXISTING — controlled, not assumed.** The same command with the HEAD~1
emitter, same window:

        arm     wave 11b            HEAD~1 (control)
        interp  6.574 ms/frame      6.367 ms/frame
        jit     460.782 ms/frame    446.615 ms/frame
        ratio   0.014x              0.014x

Identical to the resolution of the rig. Wave 11b did not cause it. (The 3%
gap between the two jit numbers is well inside this rig's ~+/-6% single-pair
resolution and must not be read as an effect.)
</details>

</details>

### (3) `gauntletLegends.z64` — ✅ **FIXED 2026-09-04** (same delay-slot bug as conker; section above). Kept below: the 2026-09-02 separation that made it findable.

**RESOLVED.** `det PASS / jit PASS` at 300 and 600 VI. The block-bisect the note
below recommends was never needed — conker's fix cleared it outright, and the
census then proved the shared mechanism fires here too (415 `#delayslot-entry`
executions in a 400-VI window). The separation recorded below is what made that
attribution possible at all: a run that reads `NO CDP RESPONSE` instead of
throwing is what let a one-flag control arm prove the guard is the fix.

### (3, original) `gauntletLegends.z64` — ✅ SEPARATED 2026-09-02. It is a **WEDGE**, not slow.

**The discriminator now survives, which was the actual blocker here.** The
"third failure mode" recorded below was a HARNESS bug, not a property of the
ROM: every CDP `evaluate` runs ON the page's main thread — the very thread a
wedged emulator is monopolising — and both harnesses called it unprotected, so
the ProtocolError propagated and killed the run before any detector could
speak. (Note `n64_gameplay_ab.mjs` already had `protocolTimeout: 600000` in
HEAD, so "raise protocolTimeout" was NOT the fix; raising it only makes the
harness hang for ten minutes per probe instead of failing fast.) Both harnesses
now BOUND every page read (15-60 s) and treat a non-answer as data.

**VERDICT** — `node tools/n64_jit_diff_test.mjs gauntletLegends.z64 300`,
reproduced with the wait raised to 600 s (`N64_DIFF_TIMEOUT_MS=600000`):

        determinismControl            PASS   (both interpreter arms completed 300)
        jitVsInterp                   INCOMPLETE
        firstDivergenceInCommonPrefix -1
        timeouts[jit].liveness        NO CDP RESPONSE (main thread never yielded)

The page BOOTED (the `beforeEmulatorStarted === false` wait succeeded), and then
the main thread never yielded again — not in 180 s, not in 600 s, and not to a
15 s bounded probe. That is categorically different from conker, whose VI kept
advancing at ~2 VI/s. This is the **thewheel SHAPE**: `README.md`'s contract
item #1 — a block that reaches a state where the interrupt poll is never
satisfied wedges the tab, because the core is single-threaded and one
`retro_run` must end on a VI interrupt.

⚠ **What that run does NOT say.** Its `framesReached` printed `0`, and that `0`
was a bounded-read DEFAULT, not a count — the page could not be asked, so the
true number is unknown. (The harness now prints `UNREADABLE (page did not
answer)` there instead, precisely so this cannot be misread as "zero frames
captured".) The only measured facts are: the interpreter arms completed, the jit
arm did not, and the jit arm's main thread never answered.

**But it is NOT wedged from the start.** The mode ladder at 60 VI is clean on
every rung, `?jit=emit` included:

        ?jit=wrap  det PASS  jit PASS   wrapped 42, calls 254,838
        ?jit=v05   det PASS  jit PASS   wrapped 42, canaryFired 1
        ?jit=nofp  det PASS  jit PASS   blocks 42, 0 emitFails, 0 nullOpsRejects
        ?jit=emit  det PASS  jit PASS   blocks 42, 0 emitFails, 0 nullOpsRejects

So the first 60 VI frames are bit-identical to the interpreter and the wedge is
later — the same shape as conker (clean at 60, broken at 82) and as thewheel
(clean to 244, trapped at 245). **The next step is the block bisect that solved
both of the others**: re-add the temporary `?jitonly=`/`?jitspan=` hooks to
`n64/index.html`'s `jitCompile` and bisect. Do NOT reach for the mode ladder
again — it has already answered, and its answer is "native emission, later".

<details><summary>Original 2026-09-02 note — the separation failed because of a harness bug</summary>

### (3) `gauntletLegends.z64` — same `NOJSON` at `:61`; SEPARATION FAILED, twice

Identical sweep signature to conker (JIT arm, 180 s timeout, interpreter arms
fine). The wedge-or-slow discriminator did NOT answer it: the run died with

    ProtocolError: Runtime.callFunctionOn timed out. Increase the
    'protocolTimeout' setting in launch/connect calls ...

i.e. a single CDP `evaluate` blocked past puppeteer's own default. That is a
THIRD failure mode, not an answer — it is consistent with conker's severe
main-thread blocking AND with a genuine hang, and does not distinguish them.
**So gauntletLegends is UNSEPARATED.** Note the 2026-06-12 record has gauntlet
running FASTER under `?jit` (1.94-2.0x), so whatever this is, it is a change
from a known state. Next step: raise `protocolTimeout` on the harness launch
and re-run the discriminator; the stall detector at `n64_gameplay_ab.mjs:114-120`
is the thing that actually answers the question, and it never got to speak.
</details>

### A rig limit this exposed — ✅ FIXED 2026-09-02
`n64_jit_diff_test.mjs` hardcoded 180 s for the 600-VI wait and simply THREW on
expiry, so ANY ROM slower than 3.33 VI/s produced a bare stack trace that the
sweep recorded as `NOJSON` — indistinguishable from a wedge. **That is the only
reason conker's divergence went unseen for a whole session: the arm timed out
before any checksum was compared.** The harness now:

- takes `N64_DIFF_TIMEOUT_MS` (default still 180 s, so an ordinary sweep row
  costs the same) and `N64_PROTOCOL_TIMEOUT_MS`;
- **catches** the expiry and turns it into data — it samples `_neil_vi_total()`
  twice, 5 s apart, and reports one of three named outcomes:
  `SLOW (VI advanced A->B in 5s = N VI/s)`, `WEDGED (VI frozen at A for 5s)`, or
  `NO CDP RESPONSE (main thread never yielded)`;
- **never reports PASS on a truncated stream.** `firstDiff` only compares as far
  as the shorter arm, so an arm that timed out at 200 of 600 frames and matched
  over those 200 used to be able to read `-1` = PASS. A short stream is now
  `INCOMPLETE`, and `firstDivergenceInCommonPrefix` is reported separately
  because a divergence inside the frames both arms DID reach is real and is what
  localises the bug.

Still true and still worth fixing: it runs the three arms in ONE browser with
the jit arm always THIRD, so "jit arm" and "third arm" are confounded on any
resource-exhaustion failure — the ladder's `wrap` rung is the control for that.

### Also visible in the table
`nullOpsRejects` is nonzero on **every** ROM (22-187, and 0 only on
superMarioStarRoad, which diverges too early to accumulate any). The
thewheel null-ops guard was written for what looked like one ROM's bug; it is
in fact refusing spans across the whole library, and every refused span stays
on the cached interpreter. Nobody has measured what that costs.

## Sweep after the delay-slot fix (2026-09-04) — **27 of 27 PASS/PASS, exit 0. THE GATE IS CLEAN.**

`bash tools/probe_lock.sh run -- bash tools/n64_jit_sweep.sh`, 600 VI per ROM,
interpreter / interpreter-control / `?jit=emit` per ROM. **`CPU_Speed_Limit` was
100 on every single row** and 1-minute load stayed **2.37-4.67**. The
determinism control PASSED on all 27, `emitFails` is 0 on all 27, `fcr31` is
nonzero on all 27, and `firstDivergenceInCommonPrefix` is -1 on all 27.

The run was **hash-guarded**: `mips_emit.js` `50dc6d96...`, `index.html`
`a44db1ee...`, `n64wasm.wasm` `8ac90212...`, identical before AND after. That
guard is not ceremony here — an earlier attempt at this same sweep was KILLED
and restarted because a comment-only edit to `mips_emit.js` landed mid-run, and
a torn read of the emitter would have produced a silent `[jit] emitter failed to
load` and therefore a row of FALSE PASSES.

        rom                     det   jit   blocks  fallbackOps  emitFails  nullOpsRejects  load  limit
        Banjo-Dreamie.z64       PASS  PASS  2062    524          0          93              2.76  100/100
        banjo-tooie.z64         PASS  PASS  5215    8859         0          187             3.29  100/100
        banjoChristmas.z64      PASS  PASS  2063    524          0          93              3.67  100/100
        bk-jiggiesoftime.z64    PASS  PASS  2064    524          0          93              3.98  100/100
        blitz2001.z64           PASS  PASS  1025    300          0          26              3.55  100/100
        clayFighter.z64         PASS  PASS  772     137          0          33              3.46  100/100
        conker.z64              PASS  PASS  1273    459          0          103             3.74  100/100
        crusin.z64              PASS  PASS  460     290          0          25              3.97  100/100
        diddyKongRacing.z64     PASS  PASS  828     802          0          72              3.21  100/100
        dinosaurplanet.z64      PASS  PASS  881     543          0          81              3.14  100/100
        dk64.z64                PASS  PASS  1216    839          0          95              4.26  100/100
        flyingDragon.z64        PASS  PASS  507     189          0          33              3.27  100/100
        gauntletLegends.z64     PASS  PASS  1485    355          0          52              3.29  100/100
        mariokart.z64           PASS  PASS  475     234          0          34              3.57  100/100
        marioo.z64              PASS  PASS  581     194          0          36              3.15  100/100
        mariopartynew.z64       PASS  PASS  739     170          0          22              2.86  100/100
        newTetris.z64           PASS  PASS  377     255          0          28              3.40  100/100
        oot.z64                 PASS  PASS  1487    673          0          102             2.68  100/100
        papermario.z64          PASS  PASS  658     1350         0          27              2.47  100/100
        pkmnsnap.z64            PASS  PASS  705     350          0          42              2.37  100/100
        podracer.z64            PASS  PASS  472     264          0          34              3.03  100/100
        sm64.z64                PASS  PASS  851     508          0          58              3.02  100/100
        starfox.z64             PASS  PASS  470     263          0          35              3.93  100/100
        starfoxsurvival.z64     PASS  PASS  1119    394          0          61              3.02  100/100
        superMarioStarRoad.z64  PASS  PASS  584     194          0          38              2.99  100/100
        thewheel.z64            PASS  PASS  1290    214          0          48              4.67  100/100
        zeldaMasterOfTime.z64   PASS  PASS  1475    660          0          91              4.05  100/100

conker.z64 and gauntletLegends.z64 — the two rows that blocked this gate — now
complete 600 VI inside the harness's ordinary 180 s wait, with no `liveness`
column entry at all.

**This is the gate `a5efb66` set, and it is met, so `?jit` is now the page
default.** From here the sweep is the REGRESSION gate: the shipped page depends
on it, and it still exits nonzero unless every ROM is PASS/PASS.

## Action #1 EXECUTED — waves 8/9/10a priced on a quiet box (2026-09-01)

The first throughput numbers in this campaign that pass its own measurement
rules. `CPU_Speed_Limit` was **100 before AND after every arm** (contrast the
52-70 of every prior attempt) and 1-minute load stayed **2.49-7.25**, versus
the 15-176 that voided the sweep above.

**What this prices.** Waves 8, 9 and 10a are all in HEAD, so an
interpreter-vs-`?jit` A/B prices the STACK, not any single wave. There is no
build in which wave 8 is present and wave 9 is not, so per-wave throughput
attribution is not available from this rig and is not claimed here.

    rom        round  order        interp   jit    wallX  cpuX   load        limit
    mariokart  ab     interp,jit    8.661   7.592  1.141  1.030  4.29->7.25  100/100
    mariokart  ba     jit,interp    9.477   9.084  1.043  0.995  3.16->6.37  100/100
    sm64       r1     interp,jit    7.785   6.457  1.206  1.073  2.49->6.20  100/100
    sm64       r2     interp,jit    8.312   7.672  1.083  1.017  2.74->3.05  100/100

(ms per VI frame, `_neil_frame_cost_*`. mariokart is a correctly alternated
pair. **The two sm64 rounds are NOT an alternated pair** — a zsh word-splitting
bug meant the `ba` argument never reached the tool, and both ran interp-first.
Reported as what they actually are.)

**So: roughly 1.04-1.21x on retro_run cost, and ~1.00-1.07x on whole-process
CPU. The acceptance bar (>=100% of hardware in-game) is NOT cleared by this
and is not addressed by it — see the scene caveat below.**

Three things this run establishes that matter more than the ratios:

1. **RIG RESOLUTION, measured for the first time.** The two sm64 rounds are the
   same ROM, same order, same window, back to back on a quiet box — an exact
   repeatability pair. They read **1.206 vs 1.083** (wall) and 1.073 vs 1.017
   (cpu). So a single pair resolves roughly **+/-6%**, and NO effect smaller
   than about 15% is resolvable from one round even at load 2.5-6. Most of
   this campaign's per-wave hopes are below that floor.
2. **THE TWO METRICS DISAGREE SYSTEMATICALLY, and the direction is explicable.**
   `wallX` (1.04-1.21) exceeds `cpuX` (1.00-1.07) in all four rounds.
   `perFrameMs` times `retro_run` ONLY, while `cpuMsPerFrame` charges the whole
   browser process tree — renderer, compositor, GPU process — which the JIT
   does not touch and which therefore DILUTES the ratio. On that reading
   `cpuX` is a lower bound and `wallX` is the guest-work measure. That is a
   hypothesis consistent with all four rounds, not a proven decomposition;
   it has not been tested by ablating the renderer.
3. **THE MEASURED WINDOW IS A MENU ON BOTH ROMS, which the screenshots prove.**
   At the documented `600 900`, mariokart's window is the **PLAYER SELECT**
   screen (`/tmp/n64-ab/mariokart-jit.png`) and sm64's is the **spinning Mario
   head** on the title screen (`/tmp/n64-ab/sm64.z64 ab-interp.png`) — not
   gameplay. This is the tool's own documented failure mode (its header warns
   an idle-dominated scene "reads meaninglessly close to 1.0x", the GameCube
   lesson). **These ratios therefore describe menu scenes and must not be
   quoted as in-game speedups.** Both arms saw the same scene, so the ratios
   are internally valid; they are just not measuring the workload the
   acceptance bar is about. The next A/B must raise the warmup until the
   screenshot shows a race / a level, and verify that from the PNG.

`uptime` and `pmset -g therm` are recorded per arm in
`/tmp/n64-ab-rounds/*.json`.

**Lock protocol (2026-09-01):** measurement now serializes through
`bash tools/probe_lock.sh run -- <cmd>`, which records the owner PID, reclaims
only a dead owner's lock, releases on every exit path, and — the part the bare
`mkdir` lock lacked — **waits for 1-minute load to fall below 12 before
returning**, because sibling BUILDS never took the lock and holding it does not
by itself make the box quiet.

## `n64_page_test.mjs` rafdedupe — ✅ SETTLED 2026-09-02: it was CONTENTION

Re-run on a quiet box (`bash tools/probe_lock.sh run -- node
tools/n64_page_test.mjs`, load 2.58, `CPU_Speed_Limit` 100), during the wave-11b
page e2e gate. Verbatim from `/tmp/n64-11b-pagetest.log`:

    "controlShownPerSec": 58.22124071192913,
    "extraLoops": 2,
    "withExtraShownPerSec": 58,
    "inflation": 0.996,
    "armTook": true,
    "ok": true,
    "why": "shown held at 58.2/s -> 58.0/s with 2 extra rAF loops"

0.996 is inside the 0.9-1.1 band, and `armTook` is true so the arm was not a
placebo. The 0.723 reading was the loaded box, exactly as the mechanical
argument below predicted — the dedupe bug INFLATES `shown` and cannot produce a
decrease. The suggestion below still stands on its own merits: record load
alongside `inflation` so this does not have to be re-litigated.

<details><summary>Original 2026-09-01 analysis, kept for the record</summary>

Raised because a loaded box read the `rafdedupe` section RED: `shown` moved
**58.86/s -> 42.58/s (0.723x)** when only the number of rAF CALLBACKS changed,
against a 0.9-1.1 band, while an earlier run on the same box read 0.958.

**Not settled empirically** — the re-run was queued through `probe_lock.sh` and
never got lock time. Verbatim, from `/tmp/n64-raf.log`:

    [probe-lock] TIMEOUT after 2400s — held by pid 84630 (: probe_lock.sh
    17:28:32). NOT stealing a live lock.

i.e. it waited 40 minutes, lost every race, and exited 7 WITHOUT RUNNING — the
identical outcome to the wave-11a liveness re-run (see above). Two independent
40-minute waits starving on the same lock, while the box sat at load 0.5-4, is
the datum: **this is a rig problem, not a scheduling accident.**

What CAN be said without a run, from the test's own construction
(`tools/n64_page_test.mjs:393-447`): **the direction is wrong for the bug this
test exists to catch.** That bug INFLATES `shown` — `rafTicks++` sat above the
`t !== lastPaceT` dedupe, so it counted callbacks and every extra rAF loop
MULTIPLIED the number (measured 60 -> 180 with three loops before the fix). A
reading of **0.723x is a DECREASE**, which the dedupe bug cannot produce. The
arm adds two self-perpetuating rAF loops, which is real per-frame work, so a
decrease is what contention on a busy box would look like: the compositor
misses frames and `shown`, which is bounded by actual animation frames, falls.

So the hypothesis "contention, not a regression" is mechanically consistent —
but it is an argument, not a measurement, and the band is two-sided (0.9-1.1),
so a genuine drop would also fail it. **Re-run `node tools/n64_page_test.mjs`
on a quiet box and read `rafdedupe.inflation`.** If it lands in 0.9-1.1 it was
contention; if it reproduces near 0.72 with load < 2, it is a real pacing bug.
Consider also making the assertion tolerate a downward move under load, or
recording load alongside `inflation`, so this question does not have to be
re-litigated every time the box is busy.
</details>

## Campaign state (2026-09-04) — **`?jit` IS THE DEFAULT**

M0-M2 COMPLETE through **wave 11b**, and the full-library gate is CLEAN. All
three opcode classes the post-wave-9 census ranked are native: SD/LD (wave 9),
MFC0 (10a), and the whole FP block — converts (11a) plus compares and BC1 (11b).
The core builds from source and `jit_params` carries `&FCR31` **and**
`&g_dev.r4300.delay_slot` behind a version magic (`0x4E36344B`).

**THE FLIP HAPPENED.** `n64/index.html`'s bridge gate is now
`if (mode === 'off' || qs.has('nojit')) return;` with `mode = qs.get('jit') ||
'emit'` — the JIT runs for every visitor and `?jit=off` / `?nojit` opts out.
The opt-out is load-bearing, not a courtesy: `tools/n64_jit_diff_test.mjs` and
`tools/n64_gameplay_ab.mjs` now pass `&jit=off` on their interpreter arms,
because without it the "interpreter" control would silently be a second JIT run
and every differential in this file would become vacuous while still printing
PASS.

Arm-difference proof for the flip itself (mariokart, 124 VI, one browser):
no `?jit` param -> `bementalMips` loaded, 299 blocks, `delaySlot` nonzero,
0 emitFails, 0 page errors; `&jit=off` and `&nojit` -> emitter not fetched,
`__jitStats` absent.

<details><summary>What used to stand between `?jit` and the default (2026-09-02)</summary>

**THE FLIP IS STILL BLOCKED, and `n64/index.html:2200` (`if (!qs.has('jit'))
return;`) must NOT be touched.** The re-run sweep is **25 of 27 PASS/PASS**
(exit 1) — up from 24, and the two failures are now self-describing rows rather
than blank `NOJSON`. Two of the three blockers moved:
1. ~~`superMarioStarRoad.z64` DIVERGES at frame 24, localised to the _OUT
   branch path (wave 7)~~ — ✅ **FIXED.** The _OUT localisation was WRONG; the
   cause was `recomp.c`'s RNOP rewrite of any instruction whose destination is
   r0. PASS at 600 VI with the determinism control PASS. See section (1).
2. `conker.z64` — ~~a throughput pathology, not a hang~~ — **it is a
   CORRECTNESS DIVERGENCE at frame 82**, and the 70x is the symptom (Count
   wraps, `next_interrupt` reaches 0, 599M `gen_interrupt` calls in 252 VI).
   Localised to ONE block (`0x10014000`, a TLB-mapped page) and to span index 7,
   reproducibly, on two emitter revisions. **STILL OPEN** — two real emitter
   bugs were fixed along the way and NEITHER moved it. See section (2).
3. `gauntletLegends.z64` — ✅ **SEPARATED**: it is a **WEDGE** (the main thread
   never yields, at 180 s and at 600 s), NOT conker's slowness. The thing
   that had blocked it was a HARNESS bug — an unbounded CDP read on the very
   thread the wedge owns. Clean on all four mode-ladder rungs at 60 VI, so the
   wedge is later; block-bisect it next. **STILL OPEN as a sweep failure.**
4. Separately, a THROUGHPUT number on a GAMEPLAY window. Every ratio this
   campaign owns was measured on a menu (screenshot-proven) and the acceptance
   bar is in-game. Waves 9/10a/11a/11b are all unpriced.

**Three emitter bugs were fixed on 2026-09-02, all of the same shape — the
emitter believed something about the core that a code read of `recomp.c` /
`cached_interp.c` refutes.** This is the wave-11a/11b lesson for a third and
fourth time: *read the code that actually runs.*
- `recomp.c` RNOP-rewrites a destination of r0 to a plain NOP (59 emitters);
  `emitAlu`/`emitLoad`/`emitCop0`/`emitCop1` wrote reg[0] anyway.
- `DECLARE_JUMP` links only `if (link_register != &reg[0])`, so
  `jalr $zero, $rs` links nothing; the emitter linked.
- `emitLoad`'s slow arm flushed a wasm local assigned only on the fast arm —
  the third instance of the join-contract class, and its comment claimed it was
  "benign".
Unit corpus **76 -> 102** cases; 17 of the 26 new ones are RED against `HEAD`.

</details>

**A FOURTH bug of the same family landed 2026-09-04, and it is the one that
closed the sweep**: the emitter believed a block could only be entered through
the dispatcher, and `cached_interp.c` calls `PC->ops()` for a delay slot too.
Unit corpus **102 -> 107**; 3 of the 5 new cases are RED against `HEAD`.

The correctness picture below is unchanged and still applies.

M0-M2 COMPLETE through wave 10a. The JIT is correctness-proven on the ROMs
it has been gated against (every wave 600-1200 VI frames bit-identical vs the
interpreter with GPR+CP0+FPR+FCR31 in the checksum; savestates; invalidation;
zero emit failures ever shipped). ~~The ?jit flag remains opt-in; the shipped
default is unchanged interpreter behavior — `mips_emit.js` is not even
fetched without `?jit`~~ — **STALE as of 2026-09-04: the JIT is the default and
`mips_emit.js` is fetched unless `?jit=off` / `?nojit` is passed.**

Two things that were previously believed and are now known to be false:
- "correctness-proven" did NOT mean bug-free. Two latent join-contract
  divergences had been shipped since waves 5 and 6 and survived every
  differential gate, because reaching them needs a store's off-RDRAM arm (or
  a CU1-clear MFC1) to coincide with a specific register-liveness pattern.
  The 600-frame differential is necessary and not sufficient; the new unit
  corpus exists to cover what it structurally cannot.
- "all 27 ROMs boot and render" did NOT mean all 27 run under `?jit`.
  `thewheel.z64` wedged at VI 245 with the JIT on and ran fine without it —
  FIXED 2026-09-01 (607b3b1), and the cause was in the VENDORED CORE, not the
  emitter. A `?jit` liveness failure is not by itself evidence against the
  emitter; run the mode ladder (wrap/v05/nofp/emit) before hypothesising.

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
1. ~~Measure THROUGHPUT on an idle, unthrottled machine~~ — ✅ DONE 2026-09-01,
   see "Action #1 EXECUTED" above. Waves 8/9/10a as a STACK read 1.04-1.21x on
   retro_run cost, at `CPU_Speed_Limit` 100 and load 2.5-7.3. **Two follow-ups
   it generated, both real:** (a) the measured window is a MENU on both ROMs
   (screenshot-proven), so the in-game acceptance bar is still unmeasured — the
   next A/B must raise the warmup until the PNG shows gameplay; (b) single-pair
   resolution is only ~+/-6%, so per-wave attribution below ~15% is not
   available from this rig at all.
2. ~~Fix the `thewheel.z64` `?jit` wedge~~ — ✅ DONE 2026-09-01 (607b3b1),
   a vendored-core null-ops bug, not an emitter bug. See its section above.
3. ~~Wave 11~~ — ✅ **BOTH HALVES DONE**: 11a (converts) 2026-09-01, 11b
   (compares + BC1) 2026-09-02 in `2877e30f`. `jit_params[43] = &FCR31` is in
   the shipped core and the dist rebuilt from source. See both sections above.
   The FP class that was 19-33% of dk64/banjo fallbacks is gone: on dk64 it
   measured 37.5% of fallback EXECUTIONS and is now 0.
4. ~~**RESTORE THE N64 CORE BUILD.**~~ — ✅ **DONE 2026-09-01** (4aaff9f2 source,
   39a8477f Makefile, 8110341a harnesses, 213d49c0 the shipped dist). The core
   builds from source under the vendored emsdk **6.0.2** and the rebuilt binary
   is now what ships; `n64/N64Wasm/dist/` is reproducible again.
   Three causes, and only the first was the one CLAUDE.md named:
   - 7 `-Wincompatible-pointer-types` in `libretronew.c` (`gzFile` is already a
     pointer; `savestate_buffer` is an array and decays on its own; one
     `struct rgba*` → `uint32_t*` return), plus
     `EXTRA_EXPORTED_RUNTIME_METHODS` → `EXPORTED_RUNTIME_METHODS`.
   - **Emscripten 6 no longer attaches `FS` or the `HEAP*` views to `Module`**
     unless they are EXPORTED (`emsdk/upstream/emscripten/src/runtime_common.js:
     164-171`). `n64/index.html:2102` reads `Module.HEAP16.buffer` and
     `dist/script.js:618,679,907,927,981` call `FS.*`, so the first rebuild died
     with `Cannot read properties of undefined (reading 'buffer')`. The Makefile
     export list is now a diffed SUPERSET of what the 3.1.67 binary exposed.
   - **`Module.calledRun` DOES NOT EXIST under 6.0.2** — guarded by
     `#if ASSERTIONS`, never assigned to `Module` (`src/postamble.js:117-120`).
     Measured on the artifacts: shipped 3.1.67 `n64wasm.js` contains the string
     6 times, the 6.0.2 rebuild 0 times. `n64_boot_test.mjs` and
     `n64_gameplay_probe.mjs` gated boot on it and reported `launched:false` +
     TimeoutError + **empty pageErrors AND empty coreLog** for a core that was
     booting and rendering correctly. **The lesson: a silent harness failure is
     not a core failure — sample the canvas for non-black + changing pixels
     before believing any Module flag.** Both harnesses now try `calledRun`
     first (so 3.1.67 behaviour is unchanged) then fall back to
     `moduleInitializing === false` + exports attached.

   Gated 8/8 ROMs paired against the vendored binary in one `probe_lock` window
   (CPU_Speed_Limit 100, load 2.3-4.3, `.wasm` md5 checked before and after
   every run): sm64 / mariokart / oot / starfox / dk64 / conker /
   gauntletLegends / pkmnsnap all boot AND render on both arms, 0 page errors.
   `n64_page_test.mjs` is identical across the two cores (ratetest 104/0 on
   both; `pace.ok` false on BOTH — pre-existing). `n64_jit_diff_test.mjs` at 600
   VI: determinism + jitVsInterp **PASS** on sm64/mariokart/oot with 0 emitFails,
   and the emission stats are bit-identical to wave 11a's recorded table.
   **Two control lessons worth keeping**: dk64 read `blackScreen=true` at the
   default 8s settle *on both cores* (dark intro — use `N64_SETTLE_MS=25000`),
   and one starfox arm failed on 4x `net::ERR_FAILED` from
   `cdnjs.cloudflare.com` because the vendored `dist/n64.html` test page pulls
   rivets/toastr/popper/nipplejs from a CDN. Neither is a core property; both
   would have been reported as regressions without a matched control arm.
5. ~~Full-library differential sweep~~ — ✅ **RUN 2026-09-02, 24 of 27
   PASS/PASS. THE `?jit` DEFAULT MUST NOT FLIP YET — see the three exceptions
   below.** Now reproducible as `bash tools/probe_lock.sh run -- bash
   tools/n64_jit_sweep.sh`, which exits nonzero unless every ROM is clean.
6. ~~**THE ONE REMAINING CORRECTNESS BLOCKER IS conker.z64.**~~ — ✅ **CLOSED
   2026-09-04, together with gauntletLegends: one bug, the delay-slot block
   entry.** The question this item posed ("which write leaves `last_addr` AHEAD
   of the address the next `cp0_update_count()` sees?") was answered by exactly
   the instrument it asked for — a temporary negative-delta detector inside
   `cp0_update_count`. Answer: the block's OWN branch tail, running while the
   block was being invoked as a branch delay slot, after which `FIN_BLOCK`
   restored PC behind it. See the section above.
7. **THE `?jit` DEFAULT IS FLIPPED (2026-09-04).** Sweep 27/27, exit 0. What is
   still open is the ACCEPTANCE BAR, not correctness: every throughput ratio
   this campaign owns was measured on a MENU (screenshot-proven), and the bar in
   M4 is ">=100% of hardware sustained IN-GAME on the heavy set". That number
   does not exist yet. Note also that single-pair resolution on this rig is only
   ~±6%, so it takes alternated pairs on a quiet box.
8. `nullOpsRejects` is nonzero on every ROM (22-187) and every refused span
   stays on the cached interpreter. Nobody has measured what that costs — and
   now that the JIT is the default, it is a shipped cost.

### On measuring action #1 — the load source was OURS (2026-09-01)
Every discarded A/B in this file blames "machine load". The largest single
source was this repo's own harnesses: seven orphaned Chromes from a run 2 days
17 hours earlier were still resident, two spinning an emulator page with 832
and 815 CPU-MINUTES accumulated, together burning 230.3% of CPU. A SIGKILLed
parent ORPHANS its browser and no in-process handler can prevent it, so this
accumulated silently across days.

**Before any throughput measurement, run:**

    node tools/browser_leak_guard.js reap   # kills orphans; never touches a live run
    uptime                                  # record the load WITH the result

Every `puppeteer.launch` site in every harness is now registered with the
guard (1caa1ad). A guarded run is reaped only once its owner process is gone,
so this is safe to run while sibling agents are working.

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

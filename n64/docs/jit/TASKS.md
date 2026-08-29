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
- [ ] Wave 9 — **SD/LD (64-bit store/load)**: the single largest remaining
      bucket on 3 of 4 titles (gauntlet 85% of all fallbacks). The dword
      dispatch tables are already in the param block (`readmemD`/`writememD`
      /`rdRdramD`/`wrRdramD`, used by LDC1/SDC1) — this is the same fast-arm
      shape against the GPR file.
- [ ] Wave 10 — **MFC0/MTC0**: 27-49% of what remains on sm64/oot/mariokart.
      MFC0 is a plain `g_cp0_regs[rd]` read for most rd; MTC0 is NOT (Count/
      Compare/Status/Cause have side effects and an interrupt poll), so emit
      MFC0 native + MTC0 only for the inert registers, else fall back.
- [ ] Wave 11 — **FP converts/compares/branches**: TRUNC.W.S, CVT.*,
      C.cond.*, BC1F/BC1FL. Explicit rounding modes and FCR31 condition
      bits; the GC lfs/stfs lesson applies — bit-exactness tests first.

## Campaign state (2026-08-29)
M0-M2 COMPLETE through wave 8. The JIT is correctness-proven (every wave
600-1200 VI frames bit-identical vs the interpreter on mariokart/sm64/oot
with GPR+CP0+FPR+FCR31 in the checksum; savestates; invalidation; zero
emit failures ever shipped). The ?jit flag remains opt-in; the shipped
default is unchanged interpreter behavior.

Perf history, most recent first:
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
1. On an IDLE, UNTHROTTLED machine: order-alternating A/B to price wave 8.
   Note the pinned rig (tools/_jit_speed_ab.mjs) measures an ATTRACT scene,
   not gameplay — an idle-dominated scene reads meaninglessly close to 1.0x.
   Prefer adding the census tool's input drive to it before believing a
   headline number.
2. Waves 9/10/11 by measured weight (SD/LD, MFC0/MTC0, FP converts) — see
   "Next by MEASURED weight" above. Do NOT reorder these by intuition; they
   are ranked by runtime execution counts, not by static site counts.
3. Full-library differential sweep (all 27 ROMs bit-identical per VI) — the
   gate a5efb66 named before the ?jit default can flip.

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

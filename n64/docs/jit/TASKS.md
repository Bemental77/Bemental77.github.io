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
      deliberately (Makefile TOTAL_MEMORY=1GB vs vendored 512MB)

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
- [ ] Wave 2 — branches/jumps with delay slots (biggest win: every taken
      branch currently exits the block through a fallback): native
      BEQ/BNE/BLEZ/BGTZ + REGIMM, J/JAL/JR/JALR, in-block back-edges for
      hot loops, Count batch + next_interrupt<=Count poll at block tails
      (the contract decision: keep interpreter Count derivation, batch at
      tails exactly like cached_interp's DECLARE_JUMP)
- [ ] Wave 3 — loads/stores (TLB-aware: KSEG0/KSEG1 fast path via direct
      RDRAM offset, mapped/MMIO via fallback), LW/SW/LBU/LB/LH/LHU/SB/SH,
      then LD/SD/unaligned pairs
- [ ] Wave 4 — MULT/MULTU/DIV/DIVU + MFHI/MFLO/MTHI/MTLO (hi/lo addresses
      already in the param block)
- [ ] Delay-slot exception semantics: red tests for EPC/BD around lw/sw in
      delay slots, branch-likely skip, ERET (required before Wave 2 ships)
- [ ] Per-instruction conformance runner (port gamecube/tools/conformance
      shape; oracle = cached interpreter in the same binary)
- [ ] Fallback census tooling: per-opcode counts from real gameplay to
      drive wave priorities by measured weight (gate #6: no guessing)

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

## Standing rules
- The interpreter is the always-available oracle: every emitter lands with
  a differential test; a red test must be a valid repro (GC lfs lesson)
- No instrumentation accumulation: diags are temporary, perf verdicts only
  on clean builds (gate #8)
- dist/ ships only deliberately: page + core versions move together

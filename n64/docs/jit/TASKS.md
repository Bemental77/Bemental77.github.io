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
- [ ] Re-link with `-sALLOW_TABLE_GROWTH -sEXPORTED_RUNTIME_METHODS=addFunction,...`
      and pick TOTAL_MEMORY deliberately (512MB unless measured otherwise);
      verify boot parity (mariokart 98%±, sm64, starfox) on the relinked core
- [ ] C-side bridge at recompile_block/NOTCOMPILED: EM_ASM up-call
      `myApp.jitCompile(blockStart, byteLen, ramPtr, blockPtr)` returning a
      table index; install as ops for the block head; flag to disable
      (`?jit=0` style) so interpreter remains the control arm
- [ ] JS-side compiler v0: build a wasm module per block that simply CALLS
      the per-op cached-interpreter functions in sequence (call-threaded
      block) — zero new semantics, proves: module instantiation against the
      main memory, table install, dispatch through PC->ops, interrupt-poll
      placement at block exit, invalidation flush path
- [ ] Differential harness v0 (the GC test_diff pattern, in-process oracle):
      run N frames interp-only vs jit-v0, compare reg[]/hi/lo/PC/g_cp0_regs
      checksums per VI; PASS required on mariokart + sm64 + oot boot
- [ ] Verify Chrome sync-Module size limit claim; if real, async-compile
      with NOTCOMPILED fallback until funcref lands (structure supports it)
- [ ] Savestate round-trip with JIT active (save → load → diff vs interp)

## M2 — n64/bementalJIT fork + native integer emitters
- [ ] Fork gamecube/bementalJIT → n64/bementalJIT, STRIP guests/powerpc*,
      rename every import/export seam (block_cache.cpp ppc_*/_dolphin_*
      names, GC watch PCs, region bounds) — then prove ONE trivial block
      instantiates before porting any emitter
- [ ] guests/mips/: analyzer + opcode table for the R4300 integer core
      (SPECIAL/REGIMM/I-type/loads/stores/branches+delay slots), per-op
      emitters with block-local reg cache, interpreter-fallback import per
      op (gencallinterp role)
- [ ] Count/interrupt contract in emitted code: batch Count at block tails,
      poll next_interrupt<=Count, exact PC->addr/last_addr maintenance (or
      take over Count wholesale — decide ONCE, document)
- [ ] Delay-slot exception semantics: red tests for EPC/BD around lw/sw in
      delay slots, branch-likely skip, ERET
- [ ] Per-instruction conformance runner (port gamecube/tools/conformance
      shape; oracle = cached interpreter in the same binary)

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

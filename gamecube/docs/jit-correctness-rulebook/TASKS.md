# JIT correctness — bementalJIT vs JIT64 rulebook

## Goal

After the DSPHLE mail-handshake fix + the OSLoadContext wild-branch redirect (see `gamecube/docs/wild-pc-0x58-crash/TASKS.md`), boot reaches OS scheduler running threads but still wedges via a deeper layer: **functions are invoked with LR=0 and registers containing instruction-encoded bytes**.

User observation (load-bearing): "**seems odd that we do not already have the JIT rulebook from running dolphin JIT64 emulation locally**." Native Dolphin runs the same SAB ROM cleanly with its JIT64 PowerPC JIT (verified 2026-05-18: boots to SEGA logo / staffRoll.prs intro in ~10s wall). **JIT64 IS the rulebook.** This topic uses JIT64 as the canonical oracle for diagnosing bementalJIT's correctness divergence.

**Question this topic answers**: which Gekko instruction(s) does bementalJIT emit incorrectly such that callers reach JIT-emitted blocks with LR=0 / registers loaded from code-area instead of stack-frame data?

## Anchored facts (verified before writing this plan)

- **Native Dolphin (JIT64) runs the same ROM cleanly**: 2026-05-18 capture at `~/Library/Application Support/Dolphin/Logs/dolphin.log` (line ~42:15 → 42:38) shows SEGA logo intro playing on loop (`c_escap1.adx`, `event_adx_e.afs` streams). 90s native run = full boot + intro.
- **bementalJIT wedge state** (captured 2026-05-18 in `/tmp/probes/oslc-bypass-50.log` `[oslc-bypass] #33`):
  - `pc=0x800e5778 r3=0x0 r31=0x7c600124 lr=0x0`
  - **`r31=0x7c600124` decodes as the PowerPC instruction `mtmsr r3, 0`** (opcode 31, XO=146). r31 should be a saved register from the function prologue stack-frame load (`lwz r31, 12(r1)`) — it's instead loaded with a CODE BYTE from somewhere.
  - `lr=0x0` means the function was invoked WITHOUT a saved-LR set up by the caller's prologue (or the prologue's `stw r0, 4(r1) ; stwu r1, -N(r1) ; mflr r0` chain corrupted r0).
- **JIT64 source tree** lives at `gamecube/dolphin-src/Source/Core/Core/PowerPC/Jit64/`:
  - `Jit_LoadStore.cpp` — lwz/stw/lwzu/stwu (the prologue/epilogue ops most suspect)
  - `Jit_SystemRegisters.cpp` — mfspr/mtspr/mflr/mtlr (LR handling)
  - `Jit_Branch.cpp` — b/bl/blr/bctr (return paths)
  - `Jit_Integer.cpp` — addi (for stack adjustments)
- **bementalJIT emitter** lives at `bementalJIT/guests/powerpc/gekko_emit.{cpp,h}` and `bementalJIT/src/block_cache.cpp`.
- **Existing host-side tests**: `bementalJIT/tests/test_gekko.cpp`, `test_dispatch.cpp`, `test_pi_mask_path.cpp`, `test_str_hle_pattern.cpp`. Built via `cmake -S bementalJIT -B bementalJIT/build-host-test && cmake --build bementalJIT/build-host-test -j`.

## Hypotheses + kill criteria

Each candidate is a divergence pattern between bementalJIT and JIT64. Kill criteria are observable diffs.

### H1 — stwu (store-word-with-update, prologue stack alloc) emits wrong

Standard PowerPC prologue: `mflr r0 ; stw r0, 4(r1) ; stwu r1, -N(r1) ; stw r31, N-4(r1)`. The `stwu` atomically writes r1 to (r1-N) AND updates r1 to r1-N. If bementalJIT emits the STORE address using the UPDATED r1 (a common bug) instead of the OLD r1, the saved LR goes to a different stack slot than the matching `lwz` in the epilogue reads.

**Kill criterion**: read `bementalJIT/guests/powerpc/gekko_emit.cpp`'s stwu emit. If it computes the store address from `r1 - N` BEFORE updating, OK. If it updates r1 first then stores to `r1` (= new r1 = stale ptr arithmetic), H1 confirmed. Compare to `Jit64/Jit_LoadStore.cpp` stwu implementation.

### H2 — lwz from stack-frame returns wrong word (epilogue load)

Mirror of H1. The epilogue does `lwz r0, N+4(r1)` (load saved LR from stack frame). If bementalJIT uses the wrong base register or wrong displacement encoding, the load returns the wrong word — could be instruction bytes (if r1 ended up pointing into code area) or zeros.

**Kill criterion**: emit a hand-built block via `bementalJIT::powerpc::build_block` with a known prologue+epilogue. Execute the block on a controlled `PowerPCState` with known stack contents. Verify r0 after epilogue equals the value the prologue stored. If diverged, H2 confirmed.

### H3 — mflr/mtlr emit wrong

`mflr rN` reads SPR_LR (SPR 8). `mtlr rN` writes SPR_LR. If bementalJIT misencodes the SPR number (encodes 9 = CTR or wrong SPR) or hardcodes a stale value, prologues lose the saved LR.

**Kill criterion**: build_block with `mflr r0 ; mtlr r0 ; blr` sequence with LR pre-set to a known value (e.g. 0x80123456). Verify after dispatch LR == 0x80123456. Compare emit to `Jit64/Jit_SystemRegisters.cpp` PerformFPRStateChange / mfspr block.

### H4 — SDA-relative load uses wrong base register

GameCube code heavily uses SDA-relative addressing: `lwz rD, simm(r13)` where r13 is the SDA pointer. If bementalJIT optimizes SDA loads to use `ctx_ptr_const` (the emit-time PPCState address) instead of the dynamic r13 register, AND the SDA pointer for that thread differs from the boot-time value baked into ctx_ptr_const, loads return wrong data.

**Kill criterion**: grep `bementalJIT/guests/powerpc/gekko_emit.cpp` for `ctx_ptr_const` usage in `lwz` emission. If it short-circuits SDA-relative addressing via the constant, AND no per-thread update mechanism exists, H4 confirmed.

### H5 — Block-boundary register liveness loss

bementalJIT's region-dispatch mechanism (multi-block per WASM module per region) requires registers to propagate across blocks via the PowerPCState struct. If a `mflr` in one block writes to a wasm local that the next block doesn't reload from PowerPCState, the LR is "lost" across the block boundary.

**Kill criterion**: emit a 2-block sequence where block 1 ends in `mflr r0` and block 2 starts with `mtlr r0` (the r0 must propagate via memory). Verify post-dispatch LR. If diverged, H5 confirmed. Compare to `Jit64/Jit_SystemRegisters.cpp` register-cache flush points.

### H6 — Self-modifying-code invalidation gap

GameCube boot rewrites instruction memory (apploader installs game code, OSLoadStr loads relocs, etc.). If bementalJIT caches blocks AND game code overwrites them WITHOUT bementalJIT invalidating, dispatch executes stale instructions. The stale block may not have the same prologue/epilogue alignment as the new code.

**Kill criterion**: bementalJIT exposes `BlockCache::invalidate_overlap(addr, max_block_bytes)` per `block_cache.h:144`. Check whether it's CALLED from the appropriate `icbi` / `dcbf` / DMA-completion hooks. If not invoked at the right points, H6 plausible. Compare to JIT64's `JitInterface::InvalidateICacheRange` callers.

## Files touched

Diagnostic-only until a hypothesis confirms. Then narrow fix in bementalJIT.

| File | Why |
|---|---|
| `gamecube/docs/jit-correctness-rulebook/refs/jit64-vs-bemental-diff.md` | New artifact. Side-by-side comparison of JIT64 emit vs bementalJIT emit for stwu / lwz / mflr / mtlr. |
| `gamecube/docs/jit-correctness-rulebook/refs/wedge-block-disasm.log` | New artifact. Hand-disassembly of the SAB code that reaches the wedge state — identifies which Gekko ops bementalJIT mis-emitted. |
| `gamecube/docs/jit-correctness-rulebook/refs/host-test-results.md` | New artifact. Output of `bementalJIT/build-host-test/tests/test_gekko` + any new test cases derived from H1-H6 (prologue, epilogue, SDA load round-trip). |
| `bementalJIT/tests/test_prologue_epilogue.cpp` | New host-side test. Builds prologue+body+epilogue blocks, executes, verifies saved-LR / saved-r31 round-trip. |
| (conditional) `bementalJIT/guests/powerpc/gekko_emit.cpp` | Fix the specific op emit identified by A/B/C/D. |

## Tasks

A–C parallel-safe; D depends on A. E is the synthesis.

### Task A — Decode the captured r31 = 0x7c600124

**Resource**: PowerPC ISA reference (Freescale "Programming Environment Manual" or Dolphin's existing decode tables in `gamecube/dolphin-src/Source/Core/Core/PowerPC/Interpreter/`).

**Action**: 0x7c600124 = opcode 31, XO=146, RT=3, RA=0, RB=0 — confirmed `mtmsr r3, 0` (move-to-MSR with r3 as source, L=0). This is a SYSTEM register write that should only appear in OS-level code (kernel context switch, exception handlers). Locate every PC in SAB code where `mtmsr r3, 0` (encoded 0x7c600124) appears.

**Expected artifact**: `refs/mtmsr-r3-pcs.md` listing PCs in SAB where this instruction appears. From `~/Library/Application Support/Dolphin/Maps/GSNE8P.map`, the OS scheduler / exception-handler functions (`zz_800e7*` family, `__OSReschedule`, `OSDispatchInterrupt`) are the likely sites.

**Verification**: At least one PC found. Cross-reference with the captured wedge state: if any of these PCs is on the call chain leading into [oslc-bypass] #33 (lr=0, r31=this-instruction), the corruption source is identified.

### Task B — Compare JIT64 vs bementalJIT emit for stwu + lwz (H1+H2)

**Resource**: `Jit64/Jit_LoadStore.cpp` (JIT64 reference), `bementalJIT/guests/powerpc/gekko_emit.cpp` (our impl).

**Action**: Extract the emit function for `stwu` from both. Document side-by-side in `refs/jit64-vs-bemental-diff.md`. Key questions:
- Does stwu write to OLD r1 or NEW r1?
- Does bementalJIT handle the RA==0 case specially (where r1 is the implicit base)?
- Does the emit produce a 32-bit aligned address?

Repeat for `lwz` (the epilogue load).

**Expected artifact**: `refs/jit64-vs-bemental-diff.md` with the two emit sequences side-by-side, divergences highlighted.

**Kills H1 / H2 if**: a clear semantic divergence is documented.

### Task C — Add host-side test: prologue + epilogue round-trip (H1+H2+H3)

**Resource**: `bementalJIT/tests/test_gekko.cpp` as template; `bementalJIT::powerpc::build_block` API.

**Action**: New test `bementalJIT/tests/test_prologue_epilogue.cpp`:

```cpp
// Build a block containing the canonical Gekko prologue + epilogue:
//   mflr  r0           ; 0x7c0802a6
//   stw   r0, 4(r1)    ; 0x90010004
//   stwu  r1, -16(r1)  ; 0x9421fff0
//   stw   r31, 12(r1)  ; 0x93e1000c
//   <body: r31 = 0xDEAD_BEEF>
//   lwz   r31, 12(r1)  ; 0x83e1000c
//   addi  r1, r1, 16   ; 0x38210010
//   lwz   r0, 4(r1)    ; 0x80010004
//   mtlr  r0           ; 0x7c0803a6
//   blr                ; 0x4e800020
// Pre-condition: r1 = sp (valid stack), LR = 0x12345678
// Post-condition: r31 unchanged from pre, LR == 0x12345678, PC == 0x12345678
```

**Expected artifact**: test binary at `bementalJIT/build-host-test/tests/test_prologue_epilogue` exits 0 if round-trip is clean, non-zero with failure details.

**Verification**: `ctest --test-dir bementalJIT/build-host-test --output-on-failure` shows the new test PASSING (= bementalJIT prologue/epilogue is correct) or FAILING with specific reg/PC mismatch (= bug located).

**Kills H1/H2/H3 if**: test fails with reg mismatch. The mismatched register narrows the bug.

### Task D — Disassemble the SAB code that triggers the wedge (depends on A)

**Resource**: `gamecube/tools/sab_disasm.py`, `tools/gsne8p.map`, the captured `lr=0x800ec0b8` from [oslc-bypass] #5 (the caller invoking OSLoadContext that eventually corrupts).

**Action**: Disassemble 64 bytes around 0x800ec0b8 (the caller). Identify the call site + the prologue/epilogue chain. Locate the specific instruction sequence that bementalJIT must emit. Compare emitted wasm (via `wasm2wat` on a JIT'd block dump) to the expected behavior.

**Expected artifact**: `refs/wedge-block-disasm.log` containing:
- 16 instructions around 0x800ec0b8 (the corrupting caller)
- The emitted-wasm dump of the block containing 0x800ec0b8 (via existing JIT block-dump infrastructure, if available)
- Annotation showing where the LR-loss happens

**Kills H1-H5 narrowly** if the disassembly directly shows which op corrupted state.

### Task E — Synthesis (depends on A + B + C + D)

**Resource**: the four artifacts.

**Action**: Determine which hypothesis confirms. Write fix patch in `bementalJIT/guests/powerpc/gekko_emit.cpp`. Re-run host tests + probe. Document.

**Verification**: `bash build_and_probe.sh --name jit-fix --duration 90000` shows wild-PC walk eliminated (no `[wild] #N pc=0x0` entries), AC > 201 baseline, ideally `video_cb > 0`.

## Dependency graph

```
Task A (decode r31 mtmsr)        ──┐
Task B (JIT64 vs bementalJIT diff)──┤  parallel
Task C (host-side round-trip test) ──┤
Task D (SAB disasm at lr=0x800ec0b8)──┘
                                    ↓
              Task E (synthesis + targeted fix + probe verify)
                                    ↓
        Open follow-on topic for whatever wedge surfaces next
```

## What this plan deliberately does NOT do

- **No throughput "fix".** The bug is a CORRECTNESS divergence (bementalJIT emits ≠ JIT64 semantics). Even at infinite throughput, the corruption would still occur.
- **No additional HLE patches.** The existing patches advanced boot to expose this JIT bug. Adding more would mask it.
- **No bementalJIT rewrite.** Identify the ONE op family that's wrong and fix only that. Per `feedback_throughput_assertion_pattern.md` — narrow citation, narrow fix.
- **No assumption that "the JIT" is the only bug.** Tasks A-D may reveal it's actually an HLE patch corrupting state. Hypothesis stays falsifiable.
- **No host-side test that requires the wasm runtime** (Emscripten / Node-puppeteer). The bementalJIT host tests run natively and exercise emit/dispatch via the bementalJIT API directly. This is the right scope for correctness fixes.

## References

- `gamecube/docs/README.md` — pattern + oracle inventory.
- `gamecube/docs/wild-pc-0x58-crash/TASKS.md` — sibling topic; the HLE-side fixes that unblocked enough boot to expose this JIT bug.
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/Jit64/` — **the rulebook**. JIT64 is verified correct on this ROM via native Dolphin runs.
- `bementalJIT/guests/powerpc/gekko_emit.{cpp,h}` — our PowerPC emit; where the fix lands.
- `bementalJIT/src/block_cache.cpp` — region/per-block dispatch (H6 region).
- `bementalJIT/tests/` — host-side test directory; build via cmake into `bementalJIT/build-host-test/`.
- `/tmp/probes/oslc-bypass-50.log` line with `[oslc-bypass] #33` — the captured corruption state.
- `~/Library/Application Support/Dolphin/Logs/dolphin.log` (2026-05-18 capture) — native JIT64 boot baseline.
- `gamecube/tools/sab_disasm.py` — disassembler for SAB ROM bytes.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_use_all_oracles_first.md` — the rule this topic operationalizes (JIT64 IS the oracle, use it).
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_throughput_assertion_pattern.md` — narrow-citation rule, why we don't speculate beyond the data.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_no_dolphin_patching.md` — fix lands in `bementalJIT/`, not `gamecube/dolphin-src/`.

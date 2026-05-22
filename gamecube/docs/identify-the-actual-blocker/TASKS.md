# Identify the actual blocker (not "throughput", not "cache cold-start")

## Goal

`phase_2e_cutover_works_cache_bottleneck.md` claims the current limiter past the Phase 2e cutover is "ppc-worker cache cold-start (~85ms/compile)". `baseline_probe_2026_05_14.md` separately documents `video_cb=0` (zero game-frames ever) and AC=33 / F=1 IDENTICAL to a baseline two days older — i.e. moving CT advance per iter did NOT move hybrid-event cadence (AID/VI/DSP). Two memories, two different "the bottleneck is throughput" framings, neither one falsified against the oracle inventory.

**Question this topic answers**: is the next blocker actually JIT throughput / cache cold-start, or is there a discrete unresolved wedge that the throughput framing has been hiding?

This topic does not try to fix throughput. It tries to disprove that throughput is the next blocker. If the disproof fails (all kill criteria below survive), throughput moves from hypothesis to finding, and a separate topic dir opens to do the optimization. If the disproof succeeds at any step, that step identifies the actual blocker and this topic closes by pointing to a new topic dir for it.

## Working hypothesis + kill criteria

**Hypothesis H0** (the one we're trying to falsify): "The next blocker past Phase 2e cutover is cache cold-start / JIT throughput in `ppc-worker`. Fixing throughput will unblock progress."

**Kill criteria for H0** (any single one closes the throughput hypothesis):

1. Native Dolphin running the same disc + same boot duration **also** plateaus at the same stage (asset-load / no `video_cb`). Then the stall is structural in the game's boot path, not a wasm-side perf gap.
2. The stuck-PC at end-of-probe maps via `tools/gsne8p.map` / `tools/gpoe8p.map` to a known polling loop with an existing HLE pattern (per `feedback_hle_polling_pattern.md`). Then the blocker is a missing HLE, not throughput.
3. The PPC state at end-of-probe shows an exception pending / a register diverged from native at the same instruction count. Then the blocker is a correctness bug in an emitted op.
4. An MMIO register the game is waiting on (DSPCR / AI / DI / VI) is at the wrong value vs native at the same point. Then the blocker is the MMIO mirror / write-routing path (`item6_mmio_stage2_design.md` territory), not throughput.
5. `dsphle_ucode_handshake_gap_2026_05_14.md`'s claim is correct and `DSPCR = 0x9d0` vs native `0x950` at the wedge. Then DSPHLE is the blocker.

If all 5 are negative AND `disp/s` measured in `/tmp/probes/*.summary.json` is more than 100× below native PowerPC dispatch rate at the same emulated wall-time, only then does the throughput framing survive.

## Files touched

Diagnostic-only. No source changes unless a kill criterion fires.

| File | Why |
|---|---|
| `gamecube/docs/identify-the-actual-blocker/refs/native-baseline-30s.log` | Native Dolphin reference log for the kill-criterion comparison. New artifact. |
| `gamecube/docs/identify-the-actual-blocker/refs/wasm-baseline-30s.summary.json` | Latest probe summary, copied for diffing. New artifact. |
| `gamecube/docs/identify-the-actual-blocker/refs/end-of-probe-state.md` | Captured stuck-PC + register state + symbol lookup. New artifact. |
| (conditional) `gamecube/dolphin-bridge/worker_funcs.js` or `gamecube/ppc-worker/ppc_worker_main.cpp` | Only if a kill criterion identifies a specific MMIO / HLE / dispatch fix. Don't pre-design. |

## Tasks

Each step is pinned to a specific oracle from `gamecube/docs/README.md`'s resource table, with a concrete expected artifact. Steps 1–4 are independent and parallel-safe. Step 5 synthesizes.

### Task 1 — Native Dolphin baseline (parallel-safe, run first)

**Resource**: Native Dolphin (user runs locally per `feedback_native_dolphin_short_runs.md`, ≤10s runs).

**Action**: Run native Dolphin against `gamecube/roms/Sonic Adventure 2 - Battle (USA).iso` for 10s with PC / interrupt / `video_cb` logging enabled. Capture the log.

**Expected artifact**: `gamecube/docs/identify-the-actual-blocker/refs/native-baseline-30s.log` containing:

- PC trajectory through OS init, scheduler, first asset load.
- At least one `video_cb` event (real-frame emit) within 10s — or, if zero, confirmation that native ALSO produces zero `video_cb` in 10s for SAB boot, which means we've been measuring against the wrong success criterion.
- The PC reached at t=10s.

**Verification**: file exists, contains a non-zero `video_cb` count OR an explicit "native also plateaued" note.

**Kills H0 if**: native at t=10s is at roughly the same PC as wasm at end-of-probe (kill criterion #1).

### Task 2 — End-of-probe stuck-PC + register state from the latest wasm run

**Resource**: `/tmp/probes/*.log` + `gamecube/tools/dump_sab_pc.mjs` + `tools/gsne8p.map`.

**Action**: Identify the latest probe archive under `/tmp/probes/`. Find the last PC dispatched (`grep -E 'pc=' /tmp/probes/<latest>.log | tail -20`). Run `node gamecube/tools/dump_sab_pc.mjs` against the SAB snapshot (or extract from probe summary) to get GPR / SPR state. Look the PC up in `tools/gsne8p.map` to get the symbol name.

**Expected artifact**: `gamecube/docs/identify-the-actual-blocker/refs/end-of-probe-state.md` containing:

```
PC at end of probe:    0x<pc>
Symbol (gsne8p.map):   <function name>
GPRs:                  r1=<sp>  r3=<arg0>  r4=<arg1>  ... r13=<sda> r14=<sda2>
LR:                    0x<addr> → <symbol>
SRR0/SRR1:             0x<val>  0x<val>
MSR:                   0x<val>  (EE=<0|1> PR=<0|1> ...)
DEC:                   0x<val>
Exceptions pending:    0x<bitmask>
Dispatches at this PC: <count> (from grep -c)
```

**Verification**: file exists, every field populated. If `dump_sab_pc.mjs` can't read the current SAB layout, the layout is captured separately and the tool is patched in a follow-up topic — but the symbol lookup MUST land.

**Kills H0 if**: PC is in a known polling-loop symbol (kill #2) OR exceptions bitmask is non-zero (kill #3 partial).

### Task 3 — Symbol cross-reference for the stuck-PC region

**Resource**: `tools/gsne8p.map` + `tools/gcsdk_scan.py` + `~/Downloads/GameCubeSDK` + `gamecube/dolphin-src/Source/Core/Core/PowerPC/HLE/`.

**Action**: For the PC and LR captured in Task 2, look up:
- Direct symbol from `tools/gsne8p.map`.
- If symbol is unknown, run `python3 tools/gcsdk_scan.py --pc 0x<pc> --rom gamecube/roms/Sonic\ Adventure\ 2\ -\ Battle\ \(USA\).iso` (extract SDK first if needed) to surface SDK signature matches.
- Cross-reference against `gamecube/dolphin-src/Source/Core/Core/PowerPC/HLE/HLE_OS.cpp` / `HLE_Misc.cpp` to see if dolphin's native HLE table has a hook for this symbol.

**Expected artifact**: appended section in `refs/end-of-probe-state.md`:

```
Symbol class:          [user code | OS scheduler | DVD path | DSP path | render | other]
Existing HLE hook?:    [yes file:line | no]
HLE polling pattern?:  [yes — matches feedback_hle_polling_pattern.md | no]
```

**Verification**: section populated. "Unknown" is an acceptable value only after both `gsne8p.map` and `gcsdk_scan.py` have been run.

**Kills H0 if**: symbol class = OS scheduler / DSP path / DVD path AND HLE polling pattern = yes (kill #2).

### Task 4 — MMIO state diff vs native at the same emulated wall-time

**Resource**: `gamecube/dolphin-src/Source/Core/Core/HW/DSPHLE.cpp` + `ProcessorInterface.cpp` + native Dolphin log from Task 1 + wasm probe log + `gamecube/tools/find_writers.mjs`.

**Action**: From the native log, extract DSPCR, AIDCR, DICR, VIINTCR (or the MMIO subset the stuck-PC is polling per Task 3) at the same emulated wall-time mark as the wasm probe's end-of-probe. From the wasm probe summary or by re-running with `--query mmiodump=1` (if the dolphin worker honors it; check `gamecube/dolphin-bridge/worker_funcs.js` first), extract the same values at end-of-probe.

**Expected artifact**: appended section in `refs/end-of-probe-state.md`:

```
                       Native            Wasm              Diff?
DSPCR (0xCC00500A):    0x<val>           0x<val>           [match | DIVERGED]
AIDCR (0xCC005036):    0x<val>           0x<val>           [match | DIVERGED]
DICR  (0xCC006004):    0x<val>           0x<val>           [match | DIVERGED]
VIINTCR (per chan):    0x<val>           0x<val>           [match | DIVERGED]
```

**Verification**: section populated for at least DSPCR (the highest-prior suspect per `dsphle_ucode_handshake_gap_2026_05_14.md`).

**Kills H0 if**: any DIVERGED row (kill #4 / #5).

### Task 5 — Synthesis (depends on 1–4)

**Resource**: the three artifacts above.

**Action**: Open `refs/end-of-probe-state.md`. Append a section per kill criterion stating its outcome (true/false/unknown). Then write the conclusion as one of:

- **H0 falsified by kill #N**: open new topic dir `gamecube/docs/<short-name>/` for the identified blocker. Close this topic by editing `gamecube/docs/README.md`'s current-topics table to point at the new one.
- **H0 survives**: ALL kill criteria negative AND `disp/s` ratio confirmed (see "Required-for-survival measurement" below). Open new topic dir `gamecube/docs/ppc-worker-throughput-fix/` and migrate the cache-cold-start angle there.
- **Inconclusive**: at least one kill criterion is "unknown" because an oracle didn't produce a usable artifact. List which artifacts are missing and what would unblock them. Do NOT default to either conclusion.

**Verification**: `refs/end-of-probe-state.md` has a "Conclusion" section. `gamecube/docs/README.md`'s topic table is updated.

### Required-for-survival measurement (only run after Tasks 1–4 are all negative)

If and only if all 4 kill criteria are negative, then measure throughput:

- Run `bash build_and_probe.sh --name throughput-survey --duration 30000` against SAB.
- Extract `disp/s` from `/tmp/probes/throughput-survey.summary.json`.
- Native PowerPC is 486 MHz × ~1 disp/instr ≈ 486M instr/sec on a clean inner loop. Per `feedback_native_speed_acceptance.md` the bar is ≥100% native sustained. Even allowing for block-size amortization, sustained `disp/s` below ~1M is a real throughput gap.
- If `disp/s` ≥ 100K AND native baseline (Task 1) confirms native finishes the same workload in <10s, the gap might NOT be throughput either — the next blocker is whatever is gating progress per dispatch, not per-second.

Only after this measurement land the conclusion "H0 survives".

## Dependency graph

```
Task 1 (native baseline)   ─┐
Task 2 (stuck-PC + regs)   ─┤  parallel
Task 3 (symbol xref)       ─┤
Task 4 (MMIO diff)         ─┘
                           ↓
Task 5 (synthesis + kill-criterion evaluation)
                           ↓
(if all 4 negative) Required throughput measurement
                           ↓
       Open follow-on topic dir for the identified blocker
```

## What this plan deliberately does NOT do

- **No emit-side changes.** `phase3_publisher_result_2026_05_14.md` and `sleep_tick_extension_2026_05_14.md` already shipped without falsifying the working hypothesis; piling on more emit changes before identifying the blocker is the failure mode this topic exists to prevent.
- **No cache-cold-start optimization.** That's the next topic IF (and only if) H0 survives. Pre-coding it locks in the throughput framing the user has explicitly called "abhorrent."
- **No new wasm instrumentation before native log is consulted.** Per `feedback_use_native_log_first.md`.
- **No patches to `gamecube/dolphin-src/`.** Per `feedback_no_dolphin_patching.md`. Any fix lands in `bementalJIT/` / `gamecube/dolphin-bridge/` / `gamecube/ppc-worker/`.

## References

- `gamecube/docs/README.md` — resource/oracle inventory + per-topic conventions.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_throughput_assertion_pattern.md` — the rule this topic operationalizes.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_use_all_oracles_first.md` — the missing-oracle-inventory failure mode.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_idle_diagnosis_methodology.md` — stuck-PC methodology.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_hle_polling_pattern.md` — HLE-vs-skip rule for polling loops.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/phase_2e_cutover_works_cache_bottleneck.md` — original cache-cold-start framing being audited here.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/baseline_probe_2026_05_14.md` — `video_cb=0` / AC=33 baseline.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dsphle_ucode_handshake_gap_2026_05_14.md` — pre-identified DSPHLE candidate (kill #5).
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_native_dolphin_short_runs.md` — ≤10s native runs.
- `build_and_probe.sh` — canonical probe script.
- `tools/gsne8p.map` — SAB symbol map.
- `gamecube/tools/dump_sab_pc.mjs` — PC/register extractor.

# Wild PC=0x58 crash after the DSP handshake unblock

> **STATUS: SUPERSEDED — 2026-05-29.** The PC=0x58 symptom was a downstream
> effect of the 0x800e362c bcx self-loop wedge documented in
> `dolphin_sab_362c_selfloop_chain_2026_05_21`. That self-loop is fixed
> (commit 95b9d1b: powerpc-next emit_bcx natively resolves bne/beq/bdnz/bdz).
> Current authoritative wedge root: memory
> `gamecube_first_mmio_divergence_2026_05_28` (MMIO routing, zz_800e6760_
> skipped at write-index 12). This topic kept as historical record;
> follow-up work happens against the new root, not these tasks.



## Goal

After `HLE_DSPMailUnblock` was patched 2026-05-17 to drain DSPHLE's pending mail + clear PI `INT_CAUSE_DSP` (gamecube/dolphin-src/Source/Core/Core/HLE/HLE_OS.cpp:584-625), boot advanced from a stuck wedge at `0x80139a6c` (AC=33 in 30s) to running the OS scheduler with 10+ polling loops cycled in 90s wall (AC=235, F=11, slice_n=83 per `refs/dspmail-pi-clear-90s.summary.json`). Boot now eventually crashes with a wild jump to **PC=0x58** in a corrupted state.

**Question this topic answers**: which dispatched block produces the wild jump to PC=0x58, and why does it leave LR=0 / r1=0xfffffca8 / an empty backtrace?

This topic does not try to fix it. It produces the data identifying the source. A fix topic forks once the cause is named.

## Anchored facts (verified from refs/ before writing this plan)

These are the citations the plan pivots on. Future sessions amending this doc must re-verify per pre-action gate #3.

- Probe artifact: `refs/dspmail-pi-clear-90s.summary.json` + `refs/wedge-context.log` (40 lines tail of `[wild-*]` events).
- **Wedge state at crash** (per `refs/wedge-context.log`):
  - `[wild-bt] pc=0x58 lr=0x0 r1=0xfffffca8 chain: 0x0 0x0 0x0 0x0 0x0 0x0 0x0 0x0` — LR is zero, stack pointer is `0xfffffca8` (effectively `-0x358` — stack underflowed below zero in the i32 space, suggesting a stack frame load from invalid memory returned zeros), all 8 backtrace entries are zero.
  - `[wild-pivec] #19 pc=0x500 cause=0x10144 mask=0x1fc unmasked=0x144 srr0=0x58 srr1=0x8002` — exception fired with SRR0=0x58, SRR1=0x8002 (MSR.EE=0, MSR.PR=0 — was in supervisor mode with interrupts disabled). PI cause has bits **VI (0x100) + DSP (0x40) + DI (0x4)** simultaneously asserted.
- **Predecessor activity** (lines immediately before crash in `refs/wedge-context.log`): 10 distinct `[wild-idle-detected]` PCs fired, OS scheduler cycled through threads via `[wild-rqb]` (RunQueueBits 0x8000→0x0→0x80→0x800080→0x8080→0x80→0x808080→...). The crash is downstream of substantial real OS execution, not at boot init.
- Predecessor wedge state (per memory):
  - `dsphle_ucode_handshake_gap_2026_05_14.md` was the prior blocker; FIXED via `HLE_DSPMailUnblock` drain.
  - `sab_third_polling_loop_2026_05_06.md` / `sab_aram_dsp_dispatcher_2026_05_07.md` — old framing of the 0x80139a6c wedge; now unblocked.

## Root cause identified — 2026-05-18 Task A done from existing probe log

Re-reading `/tmp/probes/dspmail-pi-clear-90s.log` lines 12266-12294 (no instrumentation needed — the dump was already in the existing log) shows the load-bearing sequence:

```
[wild] #4 pc=0x0 msr=0x2000 (IR=0 DR=0 EE=0) exc=0x0 last_pc=0x800e5778
       lr=0x0 ctr=0x0 srr0=0x0 srr1=0x2000 r1=0x38500000
```

CPU jumped `0x800e5778 → PC=0` with MMU disabled. Disasm of 0x800e5778-0x800e5790 (via `gamecube/tools/sab_disasm.py` against the SAB ISO):

```
0x800e5778: lwz   r4, 408(r3)   ; load ctx[0x198] → r4
0x800e577c: mtspr 26, r4        ; SRR0 = r4   (mtspr 26 = SRR0)
0x800e5780: lwz   r4, 412(r3)   ; load ctx[0x19C] → r4
0x800e5784: mtspr 27, r4        ; SRR1 = r4   (mtspr 27 = SRR1)
0x800e5788: lwz   r4, 16(r3)    ; restore r4
0x800e578c: lwz   r3, 12(r3)    ; restore r3
0x800e5790: rfi
```

This is the **OSLoadContext** epilogue. Per `~/Library/Application Support/Dolphin/Maps/GSNE8P.map`, the surrounding symbol is `zz_800e56bc_` size 0xd8 ending at 0x800e5794 (just before `OSGetStackPointer`). Same family as the patched `__OSLoadContext` documented in `hle_osloadcontext_ras_inverted_2026_05_05.md`.

**The Context struct loaded had `ctx[0x198]=0` (SRR0) and `ctx[0x19C]=0x2000` (SRR1)**. After `rfi`, CPU executes at PC=0 in real mode → falls through 0x0 → 0x4 → 0xc → 0x10 → 0x14 → 0x18 → 0x1c → 0x24 → 0x28 → 0x2c → 0x34 → 0x40 → 0x44 → ... eventually trips the wedge symptom `[wild-bt] pc=0x58 lr=0x0 r1=0xfffffca8`.

**H1 falsified.** **H2 falsified.** **H3 confirmed by adjacency** — it's a Context-restore problem, but the corruption is in the Context's SRR0 field at the moment of load, not a torn read mid-load.

## Open sub-question (replaces Tasks A/B/C below)

**Where do zero SRR0/SRR1 in a Context come from?** Three candidates:

S1. A newly-created thread never had its initial PC/MSR set before being scheduled. Real `OSCreateThread` writes the thread's initial PC into ctx[0x198] (SRR0) and MSR mask into ctx[0x19C] (SRR1). If our HLE patches for OSCreateThread/OSSetup* run instead of the real C and skip those writes, the new context starts with zeros.

S2. `OSClearContext` (at 0x800e579c — size 0x24) is called on an active Context, zeroing it. If a thread is killed/cleared while still on a run queue, the next OSLoadContext on it loads zeros.

S3. Bridge SAB sync writes zeros into the active Context struct (race between dolphin-bridge mirror and ppc-worker write).

## Tasks (revised) — find which sub-hypothesis is correct

### Task A' — Locate the Context whose SRR0=0 was loaded

**Resource**: `gamecube/tools/dump_sab_pc.mjs`, the dispatch log infrastructure (`[wild-bt]` ring already prints r3 implicitly via context loads).

**Action**: At the `[wild-bt] pc=0x58` moment, the loaded ctx pointer is in r3 just before the `lwz r3, 12(r3)` at 0x800e578c. Need to extend the wild-bt dump to ALSO capture r3 value at SRR0=0 and dump the full Context struct (216 bytes) at that address. Lookup which thread that Context belongs to (game-side OSThread struct has a Context member embedded).

**Expected artifact**: `refs/zero-context-dump.log` containing 216 bytes of the offending Context plus the OSThread struct it lives in.

**Kills S1 if**: the Context was freshly allocated (entire struct mostly zeros, not just SRR0/SRR1) — a newly-created thread.
**Kills S2 if**: the Context belongs to a still-active thread whose other fields are non-zero (only SRR0/SRR1 are zero — selectively cleared).
**Kills S3 if**: the Context has live thread state in registers but zero SRR0 — partial mirror corruption.

### Task B' — Symbol-look-up Context creators in SAB code

**Resource**: `tools/gsne8p.map` (limited; many OS symbols are `zz_*`), `tools/gcsdk_scan.py` against SDK headers.

**Action**: Find OSCreateThread / OSInitThread / OSSetCurrentContext / OSCreateAlarm symbols in SAB. Locate each one's HLE patch (if any) in `gamecube/dolphin-src/Source/Core/Core/HLE/HLE.cpp` and `HLE_OS.cpp`. Audit each patch for SRR0/SRR1 writes.

**Expected artifact**: appended section in `refs/conclusion.md`:

```
OSCreateThread:   real fn at 0x800eXXXX; HLE patch [yes/no]; SRR0 set [yes/no]
OSInitThread:     ...
...
```

**Kills S1 if**: any HLE patch listed above skips ctx[0x198] / ctx[0x19C] writes.

### Task C — Native dolphin diff (kept from original plan, in flight)

Background process started 2026-05-18 to capture native boot at 90s with same SAB ISO. Confirms whether native ALSO hits this code path or successfully boots past it.

### Task D — Synthesis

After A' + B' + C land: name the fix-topic. Expected to be one of:
- `hle-osCreateThread-set-srr0` (if S1)
- `osloadcontext-on-cleared-thread-guard` (if S2)
- `sab-bridge-context-mirror-race` (if S3)



Each is a candidate for "what produces the wild jump." Kill criteria are numerical or trace-grounded.

### H1 — JIT-emitted bad branch (BLR returning to LR=0)

**Stated cost**: a bementalJIT-emitted block's terminating `blr` returns to a context where LR=0. CPU loads PC from LR, branches to 0, then either crashes there or advances a few bytes to 0x58. Possible JIT bug: emitting `blr` without first checking LR validity, or a `mtlr` / `lwz r0, 4(r1) ; mtlr r0` sequence whose stack load returned zero.

**Kill criterion**: capture the LAST PC dispatched by ppc-worker before `[wild-bt] pc=0x58` fires. If the last block ends with `blr` AND the SAB-mirrored `ctx[LR]` is 0 at the moment of dispatch, H1 confirmed. Tool: extend `gamecube/tools/dump_sab_pc.mjs` to log a rolling N=64 dispatched-PC ring; correlate with the wild-bt timestamp.

### H2 — Stack underflow from runaway thread

**Stated cost**: r1=0xfffffca8 = wraparound past 0. A thread's stack started at e.g. `0x80003000` and got pushed past zero by an unbounded recursion or bad stack-frame size. The `lwz r0,4(r1) ; mtlr r0` epilogue then reads from invalid memory (returns zero or garbage), `blr` jumps to 0.

**Kill criterion**: capture r1 history (last N=32 values) before the wedge. If r1 was monotonically decreasing AND crossed below `0x80003000` (the bottom of MEM1 + OS area), H2 confirmed.

### H3 — Bad OS context restore

**Stated cost**: SAB scheduler's `RunQueueBits` activity is very high (15 transitions in 90s). Each transition involves a context switch — `OSSaveContext` writes regs to a Context struct, `OSLoadContext` reads them back. If `OSLoadContext`'s SAB read sees stale/zero data (race with dolphin-bridge MMIO mirror sync), the loaded thread runs with all-zero registers → r1=0 → tiny stack offset triggers immediate fault.

**Kill criterion**: find the last `OSLoadContext` HLE fire (if hooked) or `[wild-rqb]` event before the wedge. If the context restore happened within ~256 dispatches of the wedge AND the SAB seqlock around `PowerPCState` shows a torn read at that time, H3 confirmed.

### H4 — Phantom interrupt cascade (the H5 of the prior fix recurring at a different vector)

**Stated cost**: my `HLE_DSPMailUnblock` fix cleared `INT_CAUSE_DSP` after the synthetic drain, but did not touch VI / DI. If a similar bridge gap exists for VI completion or DI completion, the CPU could take a VI/DI interrupt that has no clean ack path → handler re-fires → eventually corrupts state. PI cause at wedge IS `unmasked=0x144` (VI + DSP + DI all set).

**Kill criterion**: instrument bridge VI / DI completion paths. If either fires `GenerateInterrupt` without a matching CPU-side ack in the next N dispatches, the analog of the DSP bug exists for VI/DI too.

### H5 — Specific HLE patch corrupting r1/LR

**Stated cost**: 10 different idle-skip patches fire in the 90s window. One of them may write to ppc_state in a way that races with the CPU (e.g., HLE writes r1 via wrong offset, CPU resumes with corrupted r1).

**Kill criterion**: log every HLE fire's PC + r1-before/r1-after + LR-before/LR-after. If any HLE shows r1 going to 0xfffffca8 or LR going to 0, that patch is the source.

## Files touched

Diagnostic-only until a hypothesis confirms.

| File | Why |
|---|---|
| `gamecube/docs/wild-pc-0x58-crash/refs/wedge-context.log` | Tail of `[wild-*]` events around the crash. Staged. |
| `gamecube/docs/wild-pc-0x58-crash/refs/dispatch-ring-pre-wedge.log` | New artifact. Last N=64 dispatched-PCs + r1/LR at each, just before the wild-bt event. Produced by a one-time probe extension. |
| `gamecube/docs/wild-pc-0x58-crash/refs/native-equivalent.log` | New artifact. Native dolphin run for same wall budget (90s). What does native do at the wall-time mark where wasm crashed? If native reaches game render frame, this confirms wasm's crash is a wasm-specific bug, not a game stall. |
| (conditional) `gamecube/dolphin-bridge/worker_funcs.js` or `gamecube/ppc-worker/ppc_worker.js` | Only if a kill criterion identifies a specific fix surface. Don't pre-design. |

## Tasks

A–C are diagnostic captures; parallel-safe. D synthesizes.

### Task A — Capture pre-wedge dispatch ring (H1 + H2 + H3 + H5 inputs)

**Resource**: probe instrumentation (`gamecube/tools/dump_sab_pc.mjs` for snapshot, or a one-line addition to ppc-worker logging).

**Action**: Extend the dispatch loop (read-only addition) to maintain a 64-slot ring of `{pc, r1, lr, ctr}` updated every dispatch. On `[wild-bt]` detection (PC == 0x58), dump the ring to log as `[pre-wedge-ring]`. One round-trip — patch + probe.

**Expected artifact**: `refs/dispatch-ring-pre-wedge.log` containing 64 lines of `pc=0x80xxxxxx r1=0x80xxxxxx lr=0x80xxxxxx ctr=0x80xxxxxx`. The last 1–4 entries should show the corrupting block.

**Verification**: file exists, last entry's `r1` matches the wild-bt `r1=0xfffffca8` (confirming the ring captured the wedge moment).

**Kills H1 if**: any entry's `lr` is 0 (or jumps to 0 between entries) — that's the JIT bug source.
**Kills H2 if**: r1 is monotonically decreasing through the ring AND crosses below 0x80003000.

### Task B — Cross-reference against HLE fires (H5)

**Resource**: probe log `[wild-idle-detected]` + `[wild-idle-skip]` events already in `refs/wedge-context.log`.

**Action**: For each HLE fire in the 1s window before the wedge, check whether r1/LR changed across the HLE boundary. Use the dispatch ring from Task A — find the dispatch immediately before and after each HLE timestamp; compare r1/LR.

**Expected artifact**: appended section in `refs/dispatch-ring-pre-wedge.log`:

```
HLE fires in last 1s before wedge:
  t=X.XXXs pc=0x800f6c50 r1_before=0x... r1_after=0x... lr_before=0x... lr_after=0x...
  ...
```

**Kills H5 if**: any row shows r1_after or lr_after jumping to 0 / 0xfffffca8.

### Task C — Native dolphin diff at same wall-time mark (H3 + general sanity)

**Resource**: `/Users/caseybement/Desktop/Dolphin.app/Contents/MacOS/Dolphin --batch --exec=<SAB.iso>` (per `feedback_native_dolphin_oracle.md`), 90s capture matched to wasm probe duration.

**Action**: Boot native dolphin for 90s on the same SAB ISO. Tail `~/Library/Application Support/Dolphin/Logs/dolphin.log` at the 90s mark. If native is rendering the title screen by then, this confirms the crash is wasm-specific (not a game stall the game would hit on real hardware). If native ALSO crashes near a context-switch, H3 promoted.

**Expected artifact**: `refs/native-equivalent.log` containing the last 100 log lines from a 90s native boot.

**Verification**: file exists, contains `event_adx_e.afs` or `staffRoll.prs` or later game-data load lines (per prior native capture 2026-05-17 that hit these in 5s wall).

**Kills H3 if**: native runs cleanly for 90s with thread switches and reaches game render — confirms the wasm-side context-restore path is the divergence.

### Task D — Synthesis (depends on A–C)

**Resource**: the three artifacts.

**Action**: For each hypothesis, mark its kill criterion outcome (true / false / inconclusive). The first surviving hypothesis names the fix-topic.

**Verification**: `refs/conclusion.md` written. `gamecube/docs/README.md` topic table updated to reference the follow-on topic.

## Dependency graph

```
Task A (dispatch ring) ──┐
Task B (HLE-fire diff)   ──┤  parallel
Task C (native diff)     ──┘
                           ↓
Task D (synthesis + name the follow-on)
                           ↓
        Open follow-on topic for the identified fix
```

## What this plan deliberately does NOT do

- **No JIT changes yet.** H1 is plausible (BLR with LR=0) but unverified. Patching bementalJIT before the dispatch ring identifies a specific bad block is the throughput-assertion failure mode at a different layer (`feedback_throughput_assertion_pattern.md`).
- **No additional HLE patches.** Same reason — the existing patches advanced boot; adding more before confirming H5 is the cause is speculation.
- **No changes to `gamecube/dolphin-src/`** beyond optional instrumentation (the `HLE_OS.cpp` patches from the prior topic are documented exceptions per `gamecube/docs/README.md`).
- **No throughput "fix"** — the wedge is structural state corruption, not slow execution. Per `feedback_throughput_assertion_pattern.md`, throughput is not a default conclusion.

## References

- `gamecube/docs/README.md` — pattern + oracle inventory.
- `gamecube/docs/identify-the-actual-blocker/TASKS.md` — sibling topic; complementary.
- `gamecube/docs/native-speed-gap-test/TASKS.md` — sibling topic; complementary.
- `refs/dspmail-pi-clear-90s.summary.json` — probe summary anchoring the wedge.
- `refs/wedge-context.log` — 40-line tail of `[wild-*]` events around the crash.
- `gamecube/dolphin-src/Source/Core/Core/HLE/HLE_OS.cpp:584-625` — `HLE_DSPMailUnblock` (the fix that produced this new wedge).
- `gamecube/dolphin-src/Source/Core/Core/HW/DSPHLE/MailHandler.cpp:59-89` — mail consume sequence used by the fix.
- `gamecube/dolphin-src/Source/Core/Core/HW/ProcessorInterface.h:30-45` — PI cause bit map (`INT_CAUSE_VI=0x100`, `INT_CAUSE_DSP=0x40`, `INT_CAUSE_DI=0x4`).
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_native_dolphin_oracle.md` — how to invoke native dolphin for the oracle pass.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_run_emulator_locally_first.md` — emulator-first investigation rule.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_throughput_assertion_pattern.md` — the rule against premature throughput conclusions.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_hle_polling_pattern.md` — HLE pattern (relevant if H5 confirms).
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/dsphle_ucode_handshake_gap_2026_05_14.md` — superseded by the fix that unblocked to this new wedge.

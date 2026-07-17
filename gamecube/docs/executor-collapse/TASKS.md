# Executor Collapse — Instructions for Claude Code

## PROGRESS (2026-07-02) — GATE 0 GO, Task 1 DONE, do Task 0 next (fresh thread)

**Task 1 DONE — single-owner token + per-block ownership checks in place. The caught SRR0 race is KILLED.** Edits already made (DO NOT redo):
- `cpu_owner` @ SAB **0x02680060** (0=DOLPHIN boot-default/SAB-zero-init, 1=WORKER); `quiesced` @0x02680064, futex @0x02680068 reserved for Task 2.
- `JitWasm.cpp`: `if (*(volatile u32*)0x02680060 == 1u) return;` at the do-loop top (~L266) + `... break;` inside the region `while` (~L347).
- `block_cache.cpp`: same check `... break;` at `bem_chain_loop_c` loop top (~L625).
- `ppc_worker.js`: worker check at the stop-flag boundary (~L1120): `if (Atomics.load(i32, 0x02680060>>2) !== 1) { exitReason='not-owner'; break; }`.
- `gamecube.html`: handoff (~L2095, right after the Phase-IV `0x6` store) `Atomics.store(..., 0x02680060>>2, 1)`.

**Result (v=52):** NO `[rfi0] srr0=0` (SRR0 crash gone), crash frame `r1=0x801e6d30` ABSENT, dolphin concurrent dispatch **6332 → 3** (per-block ownership check works — the fine-grained yield the advisory flag couldn't do). Worker then sits in `HuSprExec`(0x8000D498) → `HuSprDisp`(0x8000F7F8) loop.

**BLOCKER on reading the result — SLOT COLLISION (this is Task 0's justification):** the kept `[srr0-side-channel]` (gekko `emit_mtspr_impl`, SAB 0x0600/0604/0608) COLLIDES with the `[husprdisp-lr]` worker probe (also writes 0x026B0600 — gamecube.html:1686/1691). Two gekko writers on 0x0600 → the acceptance instrument is UNREADABLE until Task 0 strips the colliding probe. **=> Task 0 is unconditionally next; it un-corrupts the side-channel.**

**DECIDER after Task 0 (NOT the screen):** clean `[srr0-side-channel]` (zero non-owner SRR0 writes + no `SRR0=0` ever) + whether guest PC ADVANCES past the `HuSprExec` loop. A static Hudson frame is the EXPECTED frame at this stage, so "not changing" ≠ stuck — the visual is one weak signal, not the decider. Harden (progress) vs debug (stuck worker loop) is decided by the uncorrupted instrument. Then continue Task 2 (quiescence) → Task 3 (interrupt/CoreTiming through owner).

## Goal
MP4 boots past the Hudson-logo halt: exactly ONE PowerPC executor owns `ppc_state` at a time.

## Root — scoped to what's proven
- **Confirmed:** concurrent race on shared `ppc_state.SRR0`. `[rfi0#1]`: `mtsrr0Pc==wkSrr0Pc==0x800b6adc`, dolphin wrote `0x800ba2bc`, worker wrote `0`, worker's 0 landed between dolphin's `mtsrr0` and `rfi`.
- **UNSETTLED:** *why* the worker's value was 0 — race-zeroed context vs never-populated context. `wkSrr0Val=0` proves a concurrent write, not its cause.

## GATE 0 — RESOLVED (2026-07-01): RACE-ZEROED → build the collapse
**Decomp half done + conclusive** (`~/gc_refs/dolsdk2001/src/os/OSContext.c` + `OSThread.c`): the complete set of context-SRR0 writers is `OSInitContext` (SRR0 = entry pc, at creation) / `OSSaveContext` (SRR0 = LR, at yield) / `OSClearContext` (leaves SRR0 untouched). None produce `SRR0=0`. `OSCreateThread` runs `OSInitContext` (OSThread.c:437) BEFORE `ENQUEUE_THREAD` (:447), and the thread is `suspend=1` (:423) until `OSResumeThread` — so no thread is selectable before its context is populated (no queue-before-init window). Cross-confirmed by measured `srr0_MEM=0x800ba2bc` (0x8019c4d0 was validly saved). Therefore `SRR0=0` is ONLY reachable by corruption = the concurrent write caught in `[rfi0#1]` → **race-zeroed → the collapse is the correct fix.** Native watchpoint is a redundant empirical cross-check (its result is predetermined by the above code); run only if the build surfaces a contradiction.

### (original gate — kept for reference)
Do NOT start the collapse until this is answered:
- **Decomp:** does `OSSaveContext` ever write SRR0 (offset 0x198) for the 0x8019c4d0 context? Read the save/schedule order.
- **Native (dual-core, fine):** watchpoint on `0x8019c4d0+0x198` during MP4 boot — does native ever load it zeroed? (It won't; that's the reference.)
- **Branch:**
  - context IS saved before load → race-zeroed → collapse is the fix, proceed.
  - context NEVER saved → **STOP.** Lifecycle bug (thread queued before context established). Collapse won't fix it; fix the save/schedule order instead.

## Use the resources — what each is for
- **Decomp (mariopartyrd/marioparty4):** authoritative guest source. `OSSaveContext`/`OSLoadContext`/scheduler — the legit-writer set + save order for Gate 0. Also the reference for any post-collapse boot bug.
- **Native Dolphin + GDB stub:** oracle for *correct* behavior only. Watchpoint for Gate 0; reference for correct OSContext lifecycle. **Cannot** repro the race (native = 1 CPU executor; your split = 2). Don't expect it to name your clobberer — the `[srr0-side-channel]` already did.
- **Maps:** decode any caught PC → named routine in one lookup. Keep loaded in native + instrumentation.
- **SDK/libogc:** canonical semantics for OS routines (context switch, interrupts, EXI) when decomp is ambiguous.
- **Rule:** these give *what's correct*. Your split's *incorrect* runtime behavior is only visible in your own instrument. Don't ask native to see a bug it structurally can't have.

## Fix: hard-stop (worker-XOR-dolphin), NOT a lock
Lock keeps both executors running guest code → serializes thousands of cross-SAB accesses/frame AND preserves the bug-generating architecture. Rejected. Hard-stop: non-owner executes ZERO guest instructions. Matches native; kills the class.

## Failure mode to avoid
`Phase4|5` was advisory — set to make dolphin defer; dolphin ran OSLoadContext ~6332× anyway. Advisory flags don't stop an executor mid-`retro_run`. Ownership must be **authoritative + checked-before-dispatch + handoff-at-flushed-boundary**.

## Tasks

<task id="1">Single-owner token</task>
- `cpu_owner ∈ {WORKER,DOLPHIN}` in SAB, `Atomics` read/write.
- Both run loops check `Atomics.load(cpu_owner)` before dispatching ANY block; non-owner yields, runs nothing.

<task id="2">Quiescence handshake (not a flag flip)</task>
- Transfer: owner reaches clean boundary (no in-flight block) → flushes FULL `ppc_state` (all GPRs incl. r1, pc, npc, SRR0/1, msr, CR) → `Atomics.store` publishes quiesced → taker assumes ownership.
- Taker uses `Atomics.wait`/`notify`, not polling. Build the perf win (~10–20× vs setTimeout 4ms clamp) HERE, not later.

<task id="3">Interrupt delivery through the owner</task>
- Dolphin decides *that*+*what* (cause/vector); the `ppc_state` mutation (vector, SRR0=pc, msr mask) happens on the CPU owner at a boundary or via transient dolphin-owns handoff.
- Host-service paths (interrupt entry, CoreTiming) ARE `ppc_state` mutations — if dolphin does them while worker owns, race is back. `workerisr` gated timing but not ownership; generalize it.

## Task 0 — revert probe-hunt diagnostics
Strip `[rfi0]`/`[ea-watch]`/`[arm-watch]`/`[mtspr-watch]`/`[baked-base]`/X-form `[srr0-watch]`. **KEEP** gekko `[srr0-side-channel]` (SAB 0x0600/0604/0608) — it caught this AND it's the acceptance test.

Revert map (grep each `[tag]`, one pass):
- `Source/Core/Core/PowerPC/Interpreter/Interpreter_Branch.cpp` — the `[rfi0]` block in `Interpreter::rfi` (`srr0_mem`/`baked_base`/`curr_base`/`lwz_*`/`arm`/`rtVal`/`mtsrr0*`/`wkSrr0*`/`dbat0*`/`pre_rfi_msr`) + `[rfi-msr]` probe + `extern dolphin_read32` decl.
- `gamecube/bementalJIT/guests/powerpc-next/jit_load_store.cpp` — `[ea-watch]`/`[ea-watch2]` in `emit_load_d`, `[arm-watch]` in `emit_load_common`, and the `watch_pc` param.
- `gamecube/bementalJIT/guests/powerpc-next/jit_system_registers.cpp` — `[mtspr-watch]` in `emit_mtspr`.
- `gamecube/bementalJIT/guests/powerpc-next/ppc_emit.cpp` — `[baked-base]` + `osload-caller`/`ctx-write` probes in `emit_block_body_into`.
- `gamecube/bementalJIT/guests/powerpc/gekko_emit.cpp` — `[srr0-watch WORKER X-form]` in `emit_store_x`, **AND the `[husprdisp-lr]` worker probe writing SAB 0x0600 (MUST strip — it COLLIDES with the kept `[srr0-side-channel]` on 0x0600, making the acceptance instrument unreadable)**; KEEP `[srr0-side-channel]` in `emit_mtspr_impl`.
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp` — `[jw-pc0]` + `[husprdisp-dolphin]` TEMP probes (~L266-299). **KEEP the `[collapse]` ownership `return`/`break` (Task 1 — DONE, do not remove).**
- `gamecube/bementalJIT/src/block_cache.cpp` — `[bcl-isi]` + `[husprdisp-dolphin]` TEMP probes (~L628-666). **KEEP the `[collapse]` ownership `break` (Task 1 — DONE).**
- `gamecube.html` — `[baked-base]` log in the ee-track **+ the `[husprdisp-lr]`/`[husprdisp-dolphin]` page-side readers (~L1686-1707) reading 0x0600** — strip so `[srr0-side-channel]` is the SOLE 0x0600 writer/reader. **KEEP the `[collapse]` `cpu_owner` handoff store @~L2095 (Task 1 — DONE).**

## Acceptance test
Collapse is done when `[srr0-side-channel]` shows ZERO non-owner SRR0 writes during the owner's window. Re-run Hudson boot → race dead.

**Sharper invariant (from GATE 0 — do not misread):** the decomp proves `SRR0=0` is illegitimate by the guest's OWN writer set (`OSInitContext`→entry pc / `OSSaveContext`→LR / `OSClearContext`→untouched), so post-collapse `SRR0=0` should be **impossible**, not merely race-free. The side-channel is therefore TWO checks: (1) zero non-owner SRR0 writes during the owner's window, AND (2) no executor EVER writes `SRR0=0` for a selectable context. If a zero-write appears post-collapse, that is a **NEW bug** — a writer outside the legit set — NOT a residual race and NOT "collapse incomplete." Chase the out-of-set writer, don't re-open the collapse.

## Out of scope (defer)
- **Perf:** collapse removes the correctness hazard, not the poll ceiling — Atomics handshake (Task 2) handles that.
- **MIPS:** no clean number yet. Post-collapse steady-state → wire real downcount (replace placeholder `-=1`) + instruction counter → 60fps go/no-go. Real downcount also a suspect in interrupt-timing.
- **WebGPU readback** (EFB-to-RAM/XFB; `mapAsync` async, no sync readback): don't touch until CPU side hits frame rate.

## Sequence
1. GATE 0 (decomp + native) — race-zeroed vs never-saved. If never-saved → STOP, wrong build.
2. Task 0 (strip diagnostics, keep side-channel).
3. Tasks 1→2→3.
4. Acceptance test (side-channel = 0 non-owner SRR0 writes).
5. Real downcount + MIPS → 60fps decision.

## Invariant to get right
Authoritative ownership — single atomic owner, checked before every dispatch, handoff only at a flushed boundary, `ppc_state` mutation owner-exclusive **including interrupts**. Not advisory "please stop." Phase4|5's 2-step overlap was fatal; authoritative kills the class instead of guarding it.

Start fresh with this as the brief.

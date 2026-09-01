# GameCube WASM — MP4 DSP-bringup Task Queue

Repo: /Users/caseybement/Bemental77.github.io · Branch: dev
Rule: complete tasks IN ORDER. Each task ends with its acceptance criteria verified
empirically and `gamecube/STATUS.md` updated. No synthesis, no skipping, no "this
probably works."

---

## QUEUE STATUS (update this block every session)

| Task | State | Evidence |
|---|---|---|
| 0 — STATUS.md | **DONE** | `gamecube/STATUS.md` exists with wedge PCs 0x800E4C5C/0x800ECB60/0x800E4C60, verified facts, dead ends, probe commands, reference assets |
| 1 — Opinfo audit | **DONE** | All 18 entries verified live at `ppc_tables.cpp:273-308` (grep, 2026-06-10); opinfo_gap.md updated to `MISSING (reachable) | 0` with closure note; PC delta 706→698 resolved as NOISE by 2-run variance check (699/701, STATUS.md "Task-1 variance check"); 0 new `block broken` markers |
| 2 — Conformance harness | **SUPERSEDED-IN-PART (stale block corrected 2026-06-12)** | The "lfs D-form EA" red was a HARNESS ARTIFACT (no-op interp stub + return-0 ppc_read32) — REFUTED per STATUS.md 2026-06-11 LATER; the real root (missing MSR.FP first-FP-op guard) is FIXED, suite 36/36 green. First frame PRESENTED (video_cb), PSO handoff fixed (icbi range-evict). Harness remains the standing gate for new emitters. **2026-06-12 LATER: psq D-forms NATIVE (42/42 conformance, diff 3457/0, MP4 clean) — but PSO count=3 did NOT move, and the scaling falsifier (count=3 at 90s AND 270s) proves the park DISCRETE, not throughput. 'HandleReverb frontier' RETRACTED. NEXT: pin the discrete gate on present #4 with PSO-correct instrumentation (pso.map; [ax-gates] reads MP4 addresses on PSO = garbage)** |
| 3 — Trace differ | NOT STARTED | — |
| 4 — CoreTiming pump check | NOT STARTED | — |
| 5 — DSPHLE mailbox | NOT STARTED (blocked on 4) | — |

## CORRECTIONS to the original queue text (live-tree facts, per STATUS.md)

- `probe_fix.js` no longer exists. Canonical probe is
  `ROM_IDX=0 PROBE_DURATION_MS=60000 node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1`
- "Rebuild" = the three discrete foreground steps (NO wrapper — `build_and_probe.sh`
  deleted by user directive 2026-05-30):
  1. `source emsdk/emsdk_env.sh`
  2. `cd gamecube/dolphin-src/build-wasm && emmake make dolphin_libretro -j4`
  3. `bash gamecube/dolphin-bridge/dolphin_worker_link.sh`
- STATUS.md "Current wedge" carries an unresolved hedge: the DSP-mailbox-poll framing
  vs the 7d3edce SelectThread/FinishQueue observation. Task 4/5 work must reconcile
  these, not silently pick one.

## MULTI-AGENT RULES (ultramode / workflows)

- Fan-out is fine for READ-ONLY work: static table diffs (Task 1 style), source
  audits, decomp/symbol cross-referencing, test-vector generation (Task 2).
- Build → probe → measure is SERIAL, main loop only. Never give subagents the
  browser probe, headless Dolphin, or the build. One binary, one change, one probe
  at a time (CLAUDE.md gate #8; memory `feedback_dont_fanout_dolphin_agents_2026_05_27`).
- A perf/boot claim from a parallel agent that ran its own probe is invalid by
  construction — discard and re-measure serially on a clean build.

---

## Task 0 — Create STATUS.md (30 min)
Create `gamecube/STATUS.md`. Every future session reads it FIRST and updates it LAST.

Contents:
- **Current wedge:** PC(s), symptom, evidence (probe output lines)
- **Verified facts:** things proven empirically with the command that proved them (e.g. "negx fixed, 146 PCs, probe 60s")
- **Dead ends:** approaches tried and disproven, so they're never retried
- **Probe commands:** exact invocations for dolphin_render_probe.js, dump_os_threads.mjs, dump_wasm_mem1.mjs
- **Reference assets:** paths to MP4 decomp (~/gc_refs/marioparty4), dolsdk headers (~/gc_refs/dolsdk2001), symbols.txt, dolphin.log.preserved

Seed it from the f8c941d and 7d3edce commit messages.

**Accept:** file exists, contains current DSP-mailbox-poll wedge state with PCs 0x800e4c5c/0x800ecb60/0x800e4c60.

---

## Task 1 — Opinfo table completeness audit (1 session)
Goal: eliminate the ENTIRE negx wedge class in one pass, not one boot-debug at a time.

1. Extract every opcode Dolphin knows: parse `gamecube/dolphin-src/Source/Core/Core/PowerPC/PPCTables.cpp` + `Interpreter/Interpreter_Tables.cpp` (primary op, op-19/31/59/63 extended tables, including OE/Rc variants).
2. Extract every opcode bementalJIT's lookup_op_info() resolves (the table ppc_analyst.cpp consults).
3. Diff. Output `gamecube/docs/opinfo_gap.md`: three columns — opcode/xo, Dolphin name, status (MISSING / PRESENT / INTENTIONALLY-SKIPPED).
4. For every MISSING entry that MP4 (GMPE01_01) or libogc/dolsdk code can plausibly emit: add the opinfo entry. If the emitter (ppc_emit.cpp) lacks the emit function, add a fallback that calls the interpreter for that op — a slow instruction is fine, a truncated block is not.
5. Rebuild, run the 60s probe, record PC count delta in STATUS.md.

**Accept:** opinfo_gap.md shows zero MISSING entries reachable from integer/FP/load-store/branch/system categories. PC count ≥ previous run. No new self-loop wedges of the "unknown op truncates block" class.

**Do not:** hand-implement paired-single ops from scratch this session — interpreter fallback is acceptable.

---

## Task 2 — Instruction conformance harness (1 session)
Goal: catch SEMANTIC bugs (wrong flags, wrong carry, wrong CR) before they cost a boot-debug session.

1. Build `gamecube/tools/conformance/` — a native (host) test binary that links Dolphin's interpreter (dolphin-src Interpreter_*.cpp) as the oracle.
2. For each opcode bementalJIT emits: generate ≥1000 randomized input states (GPRs, CR, XER SO/OV/CA, FPSCR where relevant), execute through (a) Dolphin interpreter, (b) bementalJIT's emitted wasm semantics (compile the single-instruction block, run under node with a minimal harness mirroring the worker's dispatch).
3. Compare full post-state: target GPR/FPR, CR fields, XER, FPSCR. Any mismatch = print opcode, input state, both outputs.
4. Wire as `node gamecube/tools/conformance/run.mjs` and document in STATUS.md.

**Accept:** harness runs end-to-end; all currently-emitted integer + branch + load/store ops pass, or every failure is logged in STATUS.md with a fix or a tracked exception. Bugs found here count as wins — fix them.

**Do not:** skip XER.CA / CR0 comparison — flag bugs are exactly what this catches.

---

## Task 3 — Automated first-divergence trace differ (1 session)
Goal: replace "stare at the wedge" with "the diff names the broken thing."

1. Define a canonical trace event format: `seq, type(mmio-r|mmio-w|exception|hle-hit), addr, value, pc`. PC-per-block traces are too noisy; MMIO sequence is the comparable signal (already proven — PI_MASK write at 0c003004 pc=800e7970 matched native line 62784).
2. Native side: script that runs native Dolphin with the logger config that produced dolphin.log.preserved and normalizes its [mmio-r]/[mmio-w] lines into the canonical format. If dolphin.log.preserved already covers boot, just write the normalizer.
3. WASM side: extend the probe (or new probe_trace.mjs) to emit the same canonical stream from the worker's existing [mmio-w]/[exi-write] instrumentation.
4. Differ: `node gamecube/tools/trace_diff.mjs native.trace wasm.trace` → prints the first divergent event with ±10 events of context from both sides.
5. Run it against the current build. Record the first divergence in STATUS.md — this IS the current bug's address.

**Accept:** trace_diff.mjs runs and reports a concrete first divergence (event index, both sides' context). STATUS.md updated with it.

**Do not:** attempt cycle-exact timestamp matching — sequence/ordering comparison only. Timestamps will never align.

---

## Task 4 — Verify CoreTiming pumps in the worker loop (½ session)
The DSP mailbox poll at 0x800e4c5c can NEVER exit if scheduled events don't fire. Verify before touching DSP code.

1. In the worker dispatch loop (dolphin_worker_emcc.js ↔ the C++ main loop it wraps): confirm `CoreTiming::Advance()` (or the slice equivalent) is called between block dispatches, and that `g_slice_length`/downcount actually decrements with executed cycles. Instrument: count Advance() calls and fired-event callbacks per second; print every 5s.
2. Confirm the DSP interrupt/update event is REGISTERED (grep dolphin-src DSP.cpp for CoreTiming::ScheduleEvent of the DSP callback; verify the libretro/wasm init path reaches that registration — it may be skipped in stripped init).
3. Run probe 60s: report (a) Advance calls/sec, (b) events fired/sec, (c) whether the DSP update event ever fires.

**Accept:** empirical numbers for a/b/c in STATUS.md. If events fire = 0, fix the pump and re-measure BEFORE Task 5.

**Note:** instrumentation added here is temporary (gate #8) — remove and rebuild clean before any perf/correctness verdict.

---

## Task 5 — DSPHLE mailbox handshake (1 session, only after Task 4 passes)
1. Confirm DSPHLE (not LLE) is the configured DSP backend in the wasm init path (dolphin-src Core/HW/DSP* + DSPHLE/). Verify the HLE object is constructed and its Update() is reachable from the CoreTiming event.
2. Instrument CPU→DSP and DSP→CPU mailbox MMIO (0x0c005000–0x0c00500a): log every read/write with pc.
3. Boot. Expected: CPU writes init mail → DSPHLE responds → poll at 0x800e4c5c reads ready status → loop exits.
4. Cross-check the mailbox value sequence against dolphin.log.preserved's same region (around native line 62784 onward) using the Task 3 differ.

**Accept:** PC trace advances past the 0x800e4c5c/0x800ecb60/0x800e4c60 cycle; new wedge (if any) documented in STATUS.md with probe evidence. Update "Current wedge."

**Do not:** implement DSP LLE. Do not patch/skip __OSInitAudioSystem via HLE stub unless DSPHLE is proven structurally unreachable — and if you stub it, record it in STATUS.md as tech debt. Reminder: observation-only `[ax-*]` patches in dolphin-src are precedent; FIX patches go in bementalJIT/bridge only (memory `feedback_no_dolphin_patching`).

---

## Standing rules (every session)
- Read `gamecube/STATUS.md` first. Update it before ending. Update the QUEUE STATUS block here too.
- Every claim must have a command + output behind it. "Should work" is not a status.
- One wedge class per session. Do not chase side quests.
- Commit messages keep the current forensic style: symptom → root cause → fix → empirical before/after.

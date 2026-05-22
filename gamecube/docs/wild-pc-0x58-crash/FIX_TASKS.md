# Fix tasks — wild-pc-0x58-crash

The JIT-correctness diff refuted "JIT emits stwu/lwz wrong" (see `gamecube/docs/README.md` topic table, jit-correctness-rulebook row marked refuted 2026-05-18). bementalJIT correctly executes broken guest code: `lwz r4, 408(r3)` with r3=0 reads MEM1[408]=0 → SRR0=0 → rfi to PC=0. The OS-side bug is upstream.

**Single load-bearing question to fix the blocker**: where does `r31=0x7c600124` (the `mtmsr r3,0` instruction encoding) come from at the moment OSLoadContext is wild-dispatched at PC=0x800e5778 with r3=0 / lr=0?

Two possibilities, each resolvable by reading one specific source:

## Task 1 — Find the load instruction that put 0x7c600124 into r31

Read `/tmp/probes/oslc-bypass-50.log` entries #22–#33. r31 transitions: `0x802babb8` (#22) → `0x802babb8` (#23) → `0x1` (#24) → `0x1` (#25) → `0x80363178` (#28) → `0x0` (#30) → `0x0` (#32) → `0x7c600124` (#33). Each transition is a register WRITE — either from a function prologue's saved-r31 restore (`lwz r31, X(r1)`) or from an explicit move.

Between #32 (r31=0) and #33 (r31=0x7c600124), some block ran that wrote 0x7c600124 to r31. The captured PC chain wasn't logged between these entries.

**Action**: instrument JitWasm to log every block's last-PC + r31-value when r31 changes. Trigger ONLY when r31 transitions to a value with no MSB set (i.e., looks like instruction bytes, not a pointer). Use the same in-source `if (pc == X)` pattern at JitWasm.cpp:3010 — proven not to regress AC when narrowly scoped. Fire once-per-transition, cap 16 fires. Rebuild, re-probe.

Output: `[r31-instr-load] block_pc=0x... new_r31=0x... prev_r31=0x...` — the block_pc is the JIT block that wrote the instruction-encoded value.

**Then read** that block_pc in SAB via `gamecube/tools/sab_disasm.py`. The corrupting block's actual PowerPC bytes will identify the bug class (it's likely an `lwz r31, X(r1)` reading from a stack frame whose contents are stale instruction bytes — meaning the calling code copied instructions to a stack area or the prior frame's data area held instructions).

## Task 2 — Find what code copies `mtmsr r3,0` (0x7c600124) somewhere into MEM1 data area

Native dolphin doesn't have this corruption. So either:
- (a) A wasm-side HLE patch copies/leaks instruction bytes
- (b) The bridge writes wrong bytes to a thread-context address
- (c) Real OS code does a structure copy that includes code bytes, and bementalJIT mishandles the copy

`mtmsr r3,0` (0x7c600124) appears in code. Real callers: kernel/exception-handler code that toggles MSR. The `0x800e7*` family in `~/Library/Application Support/Dolphin/Maps/GSNE8P.map` (functions around `__OSLoadContext` and the IRQ chain we already see in `[dsp-sentinel] IRQ_live`).

**Action**: grep the entire SAB ROM for the byte sequence `7c 60 01 24` (big-endian). Use `gamecube/tools/sab_disasm.py` or a 1-liner with `xxd`/grep against the SAB ISO. Get the list of PCs that contain this instruction.

Then for each PC, check whether that 4-byte region is in MEM1 at boot time (yes — all code is loaded into MEM1). The COPY happens via either:
- `OSCopyContext` / `__OSContextCopy` — a real OS function that should copy register save areas
- `OSInitContext` — initializes a fresh context (probably 0-fills the save area)
- `OSResumeThread` / `__OSReschedule` — thread management

**One of these is doing a wrong-size copy or reading from a wrong source address.** Find the symbol via gsne8p.map. Read the function. Compare what it does in our JIT vs what JIT64 does (the diff IS a JIT-emit diff but only for the SPECIFIC function in question, not "all JIT").

If grep finds no copies of this byte sequence from a data-side source (only the instruction itself in code), then (c) is correct and the corruption is real OS code being copied as data — which means some thread's context save area overlaps a real text section, which means a thread was created with a stack pointer pointing into code area. That's a thread-init bug.

## Done

Whichever task identifies the source first answers the blocker. Both can be run concurrently. Output is a specific file:line to fix (either a bementalJIT op emit, an HLE patch, or a bridge write path).

No additional hypotheses. No additional kill criteria. The two tasks above resolve to a single file:line each.

## References

- `/tmp/probes/oslc-bypass-50.log` — captured wedge state (#22-#33 transitions).
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp:3010` — in-source instrumentation pattern proven not to regress AC.
- `gamecube/dolphin-src/Source/Core/Core/PowerPC/JitWasm/JitWasm.cpp:3060-3068` — existing comment on this same wedge mechanism.
- `gamecube/tools/sab_disasm.py` — SAB ROM disassembler.
- `~/Library/Application Support/Dolphin/Maps/GSNE8P.map` — SAB symbol map.
- `~/.claude/projects/-Users-caseybement-Bemental77-github-io/memory/feedback_no_dolphin_patching.md` — fix lands in bementalJIT or dolphin-bridge, not dolphin-src.

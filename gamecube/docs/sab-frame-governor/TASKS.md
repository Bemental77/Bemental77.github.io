# SAB frame governor — 23.2% of guest execution is one un-skippable busy-wait

Measured 2026-09-01 on a QUIET box (load 1.37, no competing Chrome, orphan
reaper run first). Every number here is a citation, not a recollection.

## How it was measured (reproduce exactly this)

```bash
node tools/browser_leak_guard.js reap && uptime          # MANDATORY pre-step
PROBE_PC_SAMPLE=1 ROM_IDX=1 PROBE_HEADLESS=0 PROBE_DURATION_MS=75000 \
  node gamecube/tools/dolphin_render_probe.js > /tmp/probe.log 2>&1
TOPN=25 ROM_IDX=1 python3 gamecube/tools/annotate_pc_hist.py   # /tmp/wasm_pc_hist.json
```

`ROM_IDX=1` is Sonic Adventure 2 Battle. The `.wasm` was NOT rebuilt for this
run — it is stock HEAD, so this is a clean baseline in the gate-#8 sense.

## Baseline

    ai_dma_cb = 1647.38/s  (hw 4003.56/s)  => guest = 0.4115x
    aid_fire  =   82.37/s  (hw  200.18/s)  => guest = 0.4115x
    published = 16.12/s    shown(rAF-distinct) = 16.10/s
    [mips] EXECUTED=133.3 MHz  CREDITED=200.0 MHz  ratio=66.6%  phantom=33.4%

**Use the two guest-clock witnesses, never `[mips]`.** They are independent and
agree to the fourth decimal; `[mips]` is explicitly unvalidated (CLAUDE.md gate
#10) and reads a different number in the same run.

> **[2026-09-02] `[mips]` now ships OFF and prints `METER OFF`, not a number.**
> Its 6-op prologue RMW was 2.2pp of all executed emitted ops (30% of the whole
> block prologue), so it is emit-time gated on SAB cell `0x026B39B8` and armed
> with **`?bjit_mips=1`**. The `EXECUTED=133.3 MHz` line above therefore cannot be
> reproduced without that flag — and a run without it is NOT a 0 MHz reading.
> See `gamecube/docs/executed-op-census/TASKS.md`.

## PC census — 15,478 samples, 81.0% of symbols unresolved

    14.9%  (unresolved 0x80117e00)     <-- the governor loop
     8.3%  (unresolved 0x800f3700)     <-- the pure leaf it calls
     5.2%  (unresolved 0x80120100)
     5.2%  __check_pad3
     4.4%  (unresolved 0x80120000)
     3.8%  (unresolved 0x800e7800)
     3.2%  HandleReverb
     2.4%  (unresolved 0x80123400)
     2.0%  (unresolved 0x8011da00) / 0x800f1300 / DoCrossTalk

## What 0x80117e00 is

`node gamecube/tools/dump_sab_pc.mjs 80117e0c`:

```
0x80117e00: stwu r1, -8(r1)      <- function entry
0x80117e04: b +4
0x80117e08: b +4
0x80117e0c: bl -149244           -> 0x800f3710
0x80117e10: lwz r5, -29248(r13)
0x80117e14: lwz r4, -29244(r13)
0x80117e18: addi r0, r4, -1
0x80117e1c: op31.266
0x80117e20: op31.32              (compare)
0x80117e24: bc 4, -24            -> 0x80117e0c, back to the bl
```

`dump_sab_pc.mjs 800f3710` — the callee is a two-instruction pure leaf:

```
0x800f3710: lwz r3, -29952(r13)
0x800f3714: blr
```

No stores, no calls, no side effects. **14.9% + 8.3% = 23.2% of all guest-PC
samples are this one spin loop and its getter.**

This is verbatim the case Dolphin's own source documents and does not handle
(`gamecube/dolphin-src/Source/Core/Core/PowerPC/PPCAnalyst.cpp`, in
`IsBusyWaitLoop`): *"a lot of the most used busy loops are DSP register
interactions, which are bl/cmp/bne (with the bl target a pure function that
follows the above rules). We don't detect these at the moment."*

## Why nothing in the current build skips it — three mechanisms, all miss

1. **The analyst.** `bl` is FL_ENDBLOCK, so `IsBlockTerminator`
   (`gamecube/bementalJIT/guests/powerpc-next/ppc_analyst.cpp:55`) cuts the loop
   into `[bl]` at 0x80117e0c and `[lwz..bc]` at 0x80117e10. The second block's
   back-edge targets 0x80117e0c, which is not its own `m_address`, and
   `IsBusyWaitLoop` (:260) requires
   `branchTo == block->m_address && i+1 == instructions`. It can never fire.
2. **LEAF-IDLE (:651-731) already implements exactly this fix — and is DEAD
   CODE here.** It is gated on `block->m_noncontiguous`, i.e. it only sees a
   FUSION v3 spliced stream. Fusion does not fire on this workload: the probe's
   phase-snap reports `"chainCensus":"0/0/0/0"` and `"pcringN":0`.
3. **Runtime idle-collapse** (`gamecube/bementalJIT/src/block_cache.cpp:1082`)
   only serves the non-tail-chainable C-loop path, by its own comment. This loop
   tail-chains in WASM; `pcring` is all zeros in the snapshot.

## The fix

Let the CONTIGUOUS decoder inline a provably-pure leaf `bl` so the loop becomes
one self-referential block. Everything downstream already exists and ships: the
existing `IsBusyWaitLoop` classifies it, `branchIsIdleLoop` sets
`downcount = 0` in the block prologue (`ppc_emit.cpp:998-1005`), which is the
same machinery that already idle-skips SelectThread's RunQueueBits poll.

Purity must be provable from a static decode and conservative: small
instruction budget, only `OpType::Integer` / `OpType::Load`, terminated by a
plain `blr`, no stores, no further branches or calls, no SPR/MSR writes.
Anything else keeps today's block-terminating behaviour.

**Gate #9 is preserved by construction and this must stay true.** Zeroing
downcount ends the CoreTiming slice; `CoreTiming::Advance` credits
`slice_length - DowncountToCycles(downcount)` where `slice_length` was already
clamped to `next_event.time - global_timer` (`ppc_analyst.cpp:693-704`). So
emulated time advances to the NEXT SCHEDULED EVENT and never past it — the
guest still observes exactly one VI retrace per 1/60 emulated second. The block
body still executes, so architectural state stays exact. This is not a
fast-forward and must never become one.

## Caveat carried forward

An earlier note recorded this loop as "65.44% of all emulated Gekko cycles in
City Escape". **This measurement says 23.2%**, on the boot/menu scene the probe
reaches (`xpc` 0x8011d890 / 0x8011da54). Both can be true — they are different
scenes — but only the 23.2% figure has an artifact behind it in this repo. Do
not quote the 65% figure without re-measuring it on the scene it names.

## Open

- [ ] Contiguous pure-leaf inline + the correctness corpus that gates it
      (LR exactness, refusal cases, non-self back-edge, the gate-#9 invariant).
- [ ] Resolve the census: 81.0% of symbols unresolved makes every future
      GC census far weaker than it should be. `tools/gsne8p.map` is the SAB map;
      `gamecube/tools/gc_symbols.py` is the resolver.
- [ ] Classify the remaining hot buckets (0x80120100, 0x80120000, 0x800e7800,
      `__check_pad3`, `HandleReverb`, `DoCrossTalk`) as busy-wait / real compute
      / HLE candidate.

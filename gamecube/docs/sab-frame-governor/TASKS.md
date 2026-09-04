# SAB frame governor — an undetected `bl`/`cmp`/`bne` busy-wait, and what skipping it actually costs

> **⚠ THE ORIGINAL HEADLINE ("23.2% of guest execution") IS RETRACTED TWICE OVER.**
> 1. **The size did not reproduce (2026-09-04):** a second run on the same build
>    measured **0.1%**. The pooled PC census is a phase mixture, not a property of
>    the workload. See the retraction box near the bottom + `../pc-census/TASKS.md`.
> 2. **The fix was built, and it is a NET LOSS on the probe's scene (2026-09-04):**
>    an interleaved matched pair off ONE binary reads **-5.0% guest rate /
>    -8.1% published** with the splice ON. See "RE-PRICED ON THE GUEST RATE".
>
> The MECHANISM analysis on this page is a code-read and still stands: the `bl`
> really does split the block and `IsBusyWaitLoop` really cannot fire. Only the
> value of fixing it is in question — and it currently measures negative.

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

## ⚠ [2026-09-04] THE 23.2% DOES NOT REPRODUCE — read `../pc-census/TASKS.md`

A second 75s SAB run on the SAME build (`dolphin_worker_emcc.wasm` md5
`82bc8f8b6e1c6ac8db27ec0a5d49dadb`, unchanged before and after), same `ROM_IDX=1`,
same duration, box load 5.46→6.25, put this loop at **0.1% pooled** against this
page's **14.9%**. Per 10s segment:

    2026-09-01   0.0  0.1  23.1  54.1   9.5   2.8   2.0   2.1   -> 14.9% pooled
    2026-09-04   0.0  0.0   0.1   0.0   0.2   0.0   0.1   0.2   ->  0.1% pooled

Both runs are the same speed (`0.4115x` / 16.12 published vs `0.4176x` / 16.18),
so this is not a perf difference — the two boots simply spent their middle
segments in different PHASES. The 2026-09-01 run sat in this retrace-wait; the
2026-09-04 run spent segments 2–3 in a DVD load (`fn_80022ef0`, a 3-instruction
`lwz/cmpwi/bgt` spin, at 26.6%/32.0%) and reached a GX-submission-dominated
steady scene in segments 4–7.

**So "23.2% of guest execution" is a property of one boot's transient, not of the
workload.** The mechanism analysis on this page still stands — the `bl` really
does split the block and `IsBusyWaitLoop` really cannot fire — but the LEVER IS
WORTH FAR LESS than 23.2%, and it must be re-priced on a named steady scene
(`SEG_MIN=4`) before anyone builds the pure-leaf inline for it.

Also corrected here: the disassembly above starts mid-function. The function
entry is **`0x80117df8`** (`mflr r0; stw r0,4(r1)`), not `0x80117e00`; and the
"pure leaf it calls" at `0x800f3710` is **`VIGetRetraceCount`**, which
`tools/gsne8p_xref.map` already named — the 256B bucket base `0x800f3700` fell in
its neighbour, which is why it printed as unresolved.

## ⚠ [2026-09-04] RE-PRICED ON THE GUEST RATE: THE LEVER FIRES AND **COSTS** ~5%

The box above asked for a re-price with a witness that is not a PC histogram.
Done. **The answer is worse than a null: on the scene the probe reaches, the
shipped splice is a measured REGRESSION.**

### Why this measurement is not the 2026-09-01 one

`8a4342e5` priced this lever by comparing **two separately-linked binaries**
(pre-change tree vs post-change tree). CLAUDE.md gate #10 records that the
emitters bake host addresses as LEB `i32.const`, so **link layout shifts emitted
bytes between builds** — two baseline binaries differed by 0.16% on emitted
bytes for identical input. A cross-binary A/B carries that confound.

This re-price removes it. A switch on SAB cell `0x026B3B74`
(`JitWasm.cpp`, `?noleafinline` in `gamecube.html`) gates **only the
splice**, so **both arms come off ONE binary**, md5
`82bc8f8b6e1c6ac8db27ec0a5d49dadb`, verified identical before AND after every
run. Read at emit time, so it is armed from the query string (same constraint as
`?bjit_mips=1`).

### The arm-difference proof is the census, not the flag

The candidate counter is bumped on BOTH arms and only the splice is gated, so an
inert flag is distinguishable from a working one (an all-zero census would look
identical to "the census never ran" — the placebo-arm failure the device matrix
exists to catch):

    arm A (?noleafinline=1)  leafInline = 4866/0/0/0     lastIdlePc = 0
    arm C (default, shipped) leafInline = 4866/15/15/219  lastIdlePc = 0x80117e0c

`lastIdlePc = 0x80117e0c` is **this page's governor loop**. The lever provably
fires, on exactly the intended block.

### Matched pair, interleaved A/C/A/C, one binary

Both guest-clock witnesses, never `[mips]`. They agree to 4 decimals in all runs.

    run  arm  guest(ai_dma_cb)  guest(aid_fire)  published/s  load at start→end
    A1   OFF      0.4396           0.4396          17.69        3.98 → 5.74
    C1   ON       0.4151           0.4152          16.18        4.94 → 6.61
    A2   OFF      0.4477           0.4476          18.15        5.91 → 6.61
    C2   ON       0.4277           0.4277          16.75        6.88 → 7.30

    mean  OFF 0.4437   ON 0.4214   ->  ON/OFF = 0.950  (-5.0% guest)
    mean  OFF 17.92/s  ON 16.47/s  ->  ON/OFF = 0.919  (-8.1% published)

**The two arms' ranges are DISJOINT on both metrics** — every OFF run beats every
ON run. Load rose monotonically across the campaign, which works AGAINST this
reading, not for it: within each arm the LATER, higher-load run was the FASTER
one (A2 > A1, C2 > C1), so load drift is not producing the arm ordering.

**LIMITATION — n = 2 per arm.** A third pair was attempted and ABANDONED, not
silently dropped: a sibling agent began a back-to-back multi-ROM campaign and the
queued run lost the probe lock for 14 minutes. It was killed (`rc=143`,
`/tmp/li-A3.log` empty, no partial data used) because a run taken 40 minutes
later under a different contention regime is *less* matched to A1-C2, not more.
Note also that `ai_dma_cb` and `aid_fire` are two readings of the SAME guest
clock, not independent evidence — they agree to 4 decimals by construction. The
genuinely separate second metric is `published/s`. So this is 2 runs per arm on 2
metrics, with disjoint ranges: strong enough to refuse the "+9.6% win" claim and
to block a default flip, **not** strong enough to be a final price.

### The cost mechanism (code-read, not speculation)

`branchIsIdleLoop` makes the block store `downcount = 0` in its **prologue**
(`ppc_emit.cpp:1051-1055`). That ends the CoreTiming slice on **every execution
of that block**, forcing a return to the dispatcher instead of tail-chaining in
WASM. That is a win only while the guest is genuinely PARKED in the loop. Per the
retraction box above, on a run whose phases differ the loop is **0.1%** of
samples — so the same mechanism buys nothing and each entry still pays the forced
slice exit. Arm C also pays 234 extra `build_block_next` calls at compile time
(15 kept + 219 bailed).

**This is a hypothesis consistent with the data, not a proven cause.** What is
measured is the sign and size of the delta, not the reason for it.

### What this does NOT say

* It does not say the mechanism analysis is wrong. `bl`/`cmp`/`bne` loops
  genuinely are undetected; that part is a code-read and still stands.
* It does not generalise past this scene. The probe's boot/menu path is the
  phase mixture the retraction box documents. A scene where the guest really does
  park in the retrace-wait could still favour the splice — that is exactly the
  segmented, named-scene re-price still open below.
* **The shipped default was left ON.** Flipping a shipped default on one
  phase-mixed scene, days after this page's headline was retracted for being
  scene-dependent, would repeat the failure this doc exists to record. The switch
  makes the decision reversible in one query parameter; it should be made on a
  named steady scene.

## Open

- [x] **Contiguous pure-leaf inline + the correctness corpus that gates it.**
      IMPLEMENTED and green — but see the re-price box directly above: on the
      probe's scene the lever is a **-5.0% guest / -8.1% published REGRESSION**,
      not a win. Code `8a4342e5` (`ppc_analyst.{h,cpp}` `DecodePureLeaf` /
      `DecodeBlockLeafInlined`, spliced in `JitWasm::TryCompileBlock`), corpus
      `02f8ef65`, A/B kill switch + this re-price 2026-09-04.
      Corpus: `bash gamecube/bementalJIT/tests/run_leaf_inline_test.sh` —
      **75 pass / 0 fail / 0 vacuous**, host-native, ~1s, no browser or ROM.
      It covers LR exactness (G.3), the non-self back-edge cases (G.4a/b/c),
      every refusal case (C.1-C.19: store, nested call, branches, non-`blr`
      terminator, `blrl`, SPR/MSR writes, FPU, over-budget, self-recursive,
      in-range target), and the gate-#9 invariant (GROUP E: a 15,686-cell sweep
      asserting `downcount = 0` credits EXACTLY `slice_length` and global_timer
      never passes the next scheduled event).
      `run_leaf_inline_mutants.sh` is the red-test gate: **5/5 mutants caught**
      (self-check, seam pairing, Store, CTR back-edge, SPR), control green.
- [x] **Decide the default.** DECIDED 2026-09-04 — **default is now OFF (splice
      suppressed)**, and the deciding argument is CORRECTNESS, not price. On the
      named steady scene `gamecube/states/sab-citye-gameplay.gcs.gz` (SAB City
      Escape gameplay) the splice renders a **black world behind a live HUD**:
      every draw is submitted and encoded, and none of it reaches the screen.
      One binary `82bc8f8b` (md5 identical before **and** after every run), one
      page, restore proven in all three arms:

      | arm | `leafInline` | canvas `nonBlack` | world |
      |---|---|---:|---|
      | `?noleafinline=1` | `7011/0/0/0` | 307180/307200 | FULL 3D |
      | default (after the fix) | `6989/0/0/0` | 307094/307200 | FULL 3D |
      | `?noleafinline=0` | `8087/20/20/334` `lastIdlePc=80117e0c` | 4343/307200 | **BLACK** |

      Cross-checked against the pre-splice binary `69e38d94` (`0e2dc92b`), which
      renders the same savestate, and against native Dolphin. Full write-up:
      `gamecube/docs/sab-citye-black-world/TASKS.md` §9 F13.
      The fix is JS-only — `gamecube.html` now writes cell `0x026B3B74`
      unconditionally, default suppressed. ⚠ Do NOT read a perf win out of that
      table: the black arm's higher `drawn/s` is an artifact of not drawing the
      world.
- [x] **Make the C++ side default-off too** — DONE. `JitWasm::TryCompileBlock`
      no longer reads "cell == 0 ⇒ splice"; `0x026B3B74` is now an **ARM** cell
      and the splice fires only on the magic `0x1EAF0001`
      (`kLeafInlineArmMagic`), so a worker booted with nothing written there —
      a probe, a test, a bespoke harness, a future page that forgets the cell —
      does not splice. Every value a pre-flip writer could leave behind (`0`,
      `1`) reads OFF, so it fails safe. Proven by an interleaved A/B/A/B matched
      pair on ONE binary (`afa27eb8…`): `arm=0` ⇒ `spliced 0/0`, full-3D City
      Escape; `arm=1eaf0001` ⇒ `spliced 20/20 lastIdlePc=80117e0c`, black world.
      Full table and the idle-skip caveat:
      `gamecube/docs/sab-citye-black-world/TASKS.md` §F14.
- [ ] **Explain WHY the splice blackens the scene.** The count is not the
      trigger — `selftest` classifies the same 20 idle blocks on HEAD and renders
      (its `lastIdlePc` is `0x800fe5c8`, not the governor), and the cold-boot run
      classifies 15 *including* `0x80117e0c` and renders. So it is the splice
      being live on the governor *while the gameplay scene runs*. The mechanism
      (idle-classification stores `downcount = 0` in the block prologue,
      `ppc_emit.cpp:1051-1055`, ending the CoreTiming slice on every execution)
      is a plausible frame-pacing cause but is **NOT** proven.
- [ ] `gamecube/ppc-worker/ppc_worker_main.cpp` does NOT call the splice — only
      the `dolphin_worker` path is wired. Left deliberately unwired while the
      measured payoff on the shipped path is negative.
- [x] **Resolve the census.** Done 2026-09-04, `gamecube/docs/pc-census/TASKS.md`.
      The cause was neither bucket granularity nor overlays (96.92% of samples
      are inside SAB's DOL `.text`): `tools/gsne8p_xref.map` names 441 functions
      covering 6.8% of `.text`, so there was nothing to resolve against.
      `gamecube/tools/gc_funcmap.py` recovers function boundaries from the DOL
      (validated on MP4 ground truth at 97.92% exact-start recall / 99.34%
      attribution with the truth withheld from the seeds), and on THIS artifact
      unresolved goes **62.3% → 3.1%**. (62.3%, not 81.0% — the 81.0% on this
      page predates commit `02f8ef65`.) The sampler now records the exact PC, so
      the 74.8% of samples that straddled two functions at 256B is 0.0%.
- [x] **Classify the remaining hot buckets.** Done — full table with the
      disassembly behind each verdict in `gamecube/docs/pc-census/TASKS.md` §6.
      Headline corrections to this page's list:
      * `0x80120100` + `0x80120000` are one function, `fn_8011fff4` — a GX
        vertex-submission loop (`GXBegin`, `lfs`, then WPAR writers at
        `0x80120144/138/128` storing to `0xCC008000`). REAL COMPUTE, and the
        steady scene's #1 item at 8.5–12.2%.
      * `__check_pad3` scored 5.2% only as a bucket artifact — at 4B resolution
        it gets **0 samples** and all 783 in that region are `__start`, whose
        802 samples in the 2026-09-01 run are **all in segment 1** (boot).
      * `0x800e7800` is not one function — at 4B resolution `EXIGetID` is 0.04%
        and the bucket's 3.8% was the interrupt primitives sharing it.
      * `HandleReverb` + `DoCrossTalk` are DOLSDK AXFX (`src/axfx/reverb_*.c`) =
        5.8% combined, the clearest HLE candidates in the census.

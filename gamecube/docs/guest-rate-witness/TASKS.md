# GameCube guest-clock witness — the standing rig, and what it says

Built 2026-09-04 to give GameCube what Dreamcast already has: a guest-rate
witness that can be **cross-checked**, and that can never again publish a
`1.00x` without saying how much of that time was skipped rather than executed.

Every number below is a citation to a file:line or to a probe artifact produced
in this session. Where something is not verified it says so.

---

## 1. Why the old numbers were untrustworthy

CLAUDE.md gate #10: the `[mips]` meter "is **NOT validated** — it has produced
98.2/94.5/75.2/97.8% across runs and once disagreed with MP4's own
`GlobalCounter` by ~1.7x." It also ships OFF as of 2026-09-02 and prints
`METER OFF` unless armed with `?bjit_mips=1`.

**A large part of that disagreement is a misuse, not an instrument fault.** The
`[mips]` meter reports two things: `EXECUTED` (cycles the JIT charged for real
blocks, SAB cell `0x026B3420`) and `CREDITED` (CoreTiming's `global_timer`, SAB
`0x026B3424/28`). **`CREDITED` is the guest clock. `EXECUTED` is not, and never
was** — their ratio is the idle-skip split. Quoting `EXECUTED/486` as a guest
multiple is what disagrees with `GlobalCounter`; it is supposed to.

That distinction is the whole content of this topic.

---

## 2. The hardware constant, derived from source (not copied from a doc)

`SystemTimers::AudioDMACallback` reschedules itself every
`GetAudioDMACallbackPeriod()` CoreTiming ticks and consults nothing but
CoreTiming — no wall clock, no host audio, no GPU, no frontend
(`gamecube/dolphin-src/Source/Core/Core/HW/SystemTimers.cpp:87-95`).

```
period = cpu_core_clock * aid_sample_rate_divisor
         / (Mixer::FIXED_SAMPLE_RATE_DIVIDEND * 4 / 32)     SystemTimers.cpp:80-85
```

| term | value | source |
|---|---|---|
| `cpu_core_clock` (GC, not Wii) | 486,000,000 | `SystemTimers.cpp:243` |
| `Mixer::FIXED_SAMPLE_RATE_DIVIDEND` | `54000000 * 2` = 108,000,000 | `AudioCommon/Mixer.h:58` |
| denominator `DIVIDEND*4/32` | 13,500,000 | arithmetic on the two above |
| `Get48KHzSampleRateDivisor()` | `(IsWii ? 1125 : 1124) * 2` = **2248** | `AudioInterface.cpp:353-356` |
| `Get32KHzSampleRateDivisor()` | `48kHz * 3 / 2` = **3372** | `AudioInterface.cpp:348-351` |

```
period            = 486,000,000 * 3372 / 13,500,000 = 121,392 ticks
hw ai_dma_cb rate = 486,000,000 / 121,392           = 4003.5587 /s
hw aid_fire rate  = 4003.5587 / NumBlocks           = 200.1779 /s   (NumBlocks = 20)
```

**Measured live, every run in this session:** `ticksHz=486000000 period=121392
NumBlocks=20`, e.g. `/tmp/gcw/sab-cold.log` `[witness] t=136.9s`. The derived
constant and the emulator's own published cells agree exactly.

> ⚠ **`DSP.cpp:561` has the wrong number in its comment.** It says
> "`486e6 * 3375 / 13.5e6 = 121,500 ticks`". 3375 is the **Wii** divisor
> (`1125*2*3/2`); GameCube is 3372 and the period is 121,392. The code does not
> use the comment's number — it recomputes with the live divisor
> (`DSP.cpp:610-614`) — so nothing is broken, but the comment is a trap.

**The rig never hardcodes any of this.** `UpdateAudioDMA` republishes
`period`/`ticksHz`/`NumBlocks` on every callback (`DSP.cpp:615-617`), and the
probe divides by those cells. A title that programs 48 kHz (divisor 2248 →
period 80,928 → 6005.34/s) is handled with no code change.

---

## 3. The five witnesses

| # | name | what it counts | where | independent of the host clock? |
|---|---|---|---|---|
| W1 | `ai_dma_cb` | raw entries to `UpdateAudioDMA`, counted **before** the `Enable` gate | `DSP.cpp:608` → SAB `0x026B391C` | no |
| W2 | `aid_fire` | the DMA **block wrap** inside that callback (1 per `NumBlocks`) | `DSP.cpp:642` → SAB `0x026B3918` | no |
| W3 | `global_timer` | CoreTiming's clock itself, mirrored on **every** `Advance()` | `CoreTiming.cpp:404-410` → SAB `0x026B3424/28` | no |
| W4 | guest counters | MP4 `GlobalCounter` (one per main-loop iteration) + `retraceCount` (guest VI ISR) | `~/gc_refs/marioparty4/src/game/main.c:115`; symbols `0x801D3A54` / `0x801D4428` (`config/GMPE01_00/symbols.txt:5145,5782`) | **yes** |
| W5 | `drawn/s ÷ W1` | implied native frame rate | `PixelEngine.cpp:266-268` (`g_pe_setfinish_count` → SAB `0x026B0930`) | **yes** |

**Say this plainly and do not overstate it: W1, W2 and W3 are three different
code paths onto ONE clock.** Their agreement proves the callback-period
arithmetic, the event scheduler and the SAB mirror are all consistent — it is
**not** three independent confirmations that emulated time equals wall time.

**W4 and W5 are the genuinely independent axes.**

- W4 requires the *guest* to execute and interrupts to be *delivered*. It is
  MP4-only today: `tools/gsne8p.map` (264 lines) and `tools/gpoe8p.map` (76
  lines) contain no `retraceCount` symbol — grepped 2026-09-04, zero hits — so
  SAB and PSO have no equivalent yet.
- W5 works on every title. `PixelEngineManager::SetFinish` is called from the
  **video** thread when the *guest's* GX stream finishes a frame, and a
  VI-locked title emits exactly `nativeFps` frames per emulated second. So
  `drawn/s ÷ guest-rate` must land on a real VI rate. It is a prediction the
  host clock cannot fake.

### W5's verdict on the validation run

**SAB cold boot, 26 steady windows: `drawn/s ÷ W1` implies a native
58.67 fps — 2.1% off the NTSC VI field rate 59.94.** A host-clock witness and a
guest-render witness, with no shared term, agree to 2%. That is the
cross-validation this topic was opened to get.

---

## 4. The idle-skip caveat is mandatory output

Emulated time advances two ways:

1. by executing guest code, and
2. by **clock-jumping over detected idle loops** — the analyst's
   `branchIsIdleLoop` blocks write `downcount = 0` in the prologue instead of
   charging cycles (`gamecube/bementalJIT/guests/powerpc-next/ppc_emit.cpp:1047-1057`),
   and the C dispatcher's busy-poll collapse does the same after a 96-iteration
   streak (`gamecube/bementalJIT/src/block_cache.cpp:1135`). `CoreTiming::Advance`
   then credits `slice_length - DowncountToCycles(downcount)` = the whole slice
   (`CoreTiming.cpp:386-396`).

So **a scene that is 80% idle-skipped reads 1.00x while the JIT does 20% of the
work.** This is exactly the trap CLAUDE.md records ("idle-dominated scenes read
1.00x ONLY because ~80% of credited time is skipped idle").

The rig therefore prints `idle-skip=<n>%` on every window, and where the meter
that measures it is off it prints **`METER-OFF(not 0%)`** — never `0%`. Arming
it is `?bjit_mips=1` (`gamecube.html:2700-2705`, writes SAB `0x026B39B8`, read at
**emit** time by `bem_mips_census_on()`, `ppc_emit.cpp:133`, so it must come from
the query string).

**Measured perturbation of arming it** — six matched pairs, same scene and same
frozen binary within each pair, across all three discs: the meter-ON arm came out
between **-0.5% and +4.9%** of the meter-OFF arm, and four of the six pairs were
*faster* with it on. The meter can only *add* emitted ops, so a speedup is
physically impossible — the correct reading is that its cost is **below this
rig's resolution at load 4.3-7.4**. Full table in §8 F7. Do not quote any of
those deltas as a speedup.

---

## 5. THE TRUTH TABLE

All 14 cells: **one frozen binary**, `dolphin_worker_emcc.wasm` md5
`82bc8f8b6e1c6ac8db27ec0a5d49dadb`, hash-checked before and after every cell and
identical every time. That is the binary committed at `0b6b61e9`
(`git log -1 -- gamecube/dolphin_libretro/dolphin_worker_emcc.wasm`), so these
numbers describe HEAD and not a local build. Served from a `PROBE_ROOT` symlink snapshot whose link
outputs are real copies, because a sibling agent relinked the live tree between
this session's first two probe runs (observed: `e4a2abd035e389721fd4f27135d51ed3`
→ `82bc8f8b6e1c6ac8db27ec0a5d49dadb`). Without the snapshot that relink would
have landed inside a cell. `probe_lock`-serialized. Load 4.3–7.4
throughout — quiet enough for ratios, and every cell records its own
before/after `uptime` in `/tmp/gcw/guest-rate-truth-table.json`.

Regenerate with `node gamecube/tools/guest_rate_witness.mjs --reanalyse --markdown`.

| cell | path | W1 `ai_dma_cb` | W2 `aid_fire` | W3 `global_timer` | max spread | idle-skip | drawn/s | published/s | W4 retrace→guest | W5 implied fps |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `mp4-cold-recomp` | recomp | — | — | — | — | **METER-OFF** | 120 | 60 | — | — |
| `mp4-cold-jit` | jit | 0.8353x | 0.8351x | 0.8352x | 0.0007 | **METER-OFF** | 50 | 50 | 0.834x (0.16% off W1) | 59.85 ✓ |
| `mp4-cold-jit-mips` | jit | 0.8315x | 0.832x | 0.8315x | 0.0006 | **51.1%** | 50 | 50 | 0.8307x (0.10% off W1) | 59.90 ✓ |
| `mp4-ingame-jit` | jit | 0.4363x | 0.4361x | 0.4364x | 0.0005 | **METER-OFF** | 25.5 | 25.5 | 0.4369x (0.15% off W1) | 58.45 ✓ |
| `mp4-ingame-jit-mips` | jit | 0.4433x | 0.4435x | 0.4433x | 0.0005 | **26.4%** | 26 | 26 | 0.4439x (0.15% off W1) | 58.34 ✓ |
| `sab-cold` | jit | 0.3674x | 0.3677x | 0.3674x | 0.0005 | **METER-OFF** | 21.4 | 21 | n/a (MP4 symbols) | 58.67 ✓ |
| `sab-cold-mips` | jit | 0.3855x | 0.3852x | 0.3855x | 0.0005 | **24.0%** | 22 | 21.6 | n/a (MP4 symbols) | 58.67 ✓ |
| `sab-ingame` | jit | 0.4473x | 0.4473x | 0.4473x | 0.0005 | **METER-OFF** | 2.6 | 2.6 | n/a (MP4 symbols) | 6.10 ✗ |
| `sab-ingame-mips` | jit | 0.4653x | 0.4654x | 0.4653x | 0.0007 | **47.6%** | 2.6 | 2.6 | n/a (MP4 symbols) | 5.91 ✗ |
| `pso-cold` | jit | 0.9998x | 1.0000x | 0.9998x | 0.0006 | **METER-OFF** | 30 | 30 | n/a (MP4 symbols) | 29.99 ✓ |
| `pso-cold-mips` | jit | 0.9992x | 0.9992x | 0.9993x | 0.0007 | **71.8%** | 29.9 | 29.9 | n/a (MP4 symbols) | 29.93 ✓ |
| `pso-ingame` | jit | 0.6408x | 0.6410x | 0.6408x | 0.0007 | **METER-OFF** | 19.2 | 19.2 | n/a (MP4 symbols) | 29.79 ✓ |
| `pso-ingame-mips` | jit | 0.6544x | 0.6543x | 0.6545x | 0.0005 | **64.0%** | 19.4 | 19.4 | n/a (MP4 symbols) | 29.71 ✓ |
| `suite240p-cold` | jit | — | — | — | — | **METER-OFF** | **0** | **0** | n/a (MP4 symbols) | — |

All figures are the MEDIAN over the steady windows (cold cells: `t ≥ 45s`;
state cells: `t ≥ restore + 25s`), 25–28 windows of 5 s each per cell. `max
spread` is the p90 of `max(W1,W2,W3) − min(W1,W2,W3)` within a window.

The same rows as executed-throughput, which is the number that is NOT the guest
clock (median credited / executed MHz over the same windows):

| cell | scene | guest clock (W1) | credited MHz | **executed MHz** | executed ÷ 486 MHz Gekko |
|---|---|---:|---:|---:|---:|
| `mp4-cold-jit-mips` | MP4 title | 0.8315x | 404.1 | **197.6** | **0.4066x** |
| `mp4-ingame-jit-mips` | MP4 board | 0.4433x | 215.5 | **159.0** | **0.3272x** |
| `sab-cold-mips` | SAB boot/menu | 0.3855x | 187.4 | **143.8** | **0.2959x** |
| `sab-ingame-mips` | SAB City Escape | 0.4653x | 226.1 | **118.9** | **0.2447x** |
| `pso-cold-mips` | PSO title | 0.9992x | 485.7 | **137.3** | **0.2825x** |
| `pso-ingame-mips` | PSO Pioneer 2 | 0.6544x | 318.1 | **113.0** | **0.2325x** |

---

## 6. Reproduce exactly this

```bash
# 0. the rig is self-contained: it reaps orphaned browsers, freezes a snapshot
#    root, takes tools/probe_lock.sh per cell, hash-guards, screenshots, and
#    proves any savestate restore before believing a scene claim.
node gamecube/tools/guest_rate_witness.mjs --list
node gamecube/tools/guest_rate_witness.mjs                      # whole matrix
node gamecube/tools/guest_rate_witness.mjs --only sab-ingame-mips
node gamecube/tools/guest_rate_witness.mjs --reanalyse           # no re-probe

# a single cell by hand (this is what the rig runs):
node tools/browser_leak_guard.js reap && uptime
bash tools/probe_lock.sh run -- env \
  PROBE_ROOT=/tmp/gcw/snap PROBE_HEADLESS=0 ROM_IDX=1 \
  PROBE_DURATION_MS=150000 PROBE_SCENE_RATE=5000 \
  PROBE_SCENE_RATE_JSON=/tmp/gcw/sab-ingame-mips.rows.json \
  PROBE_SHOT=/tmp/gcw/sab-ingame-mips.png@138000 \
  PROBE_QUERY="bjit_mips=1" \
  PROBE_LOAD_STATE="$PWD/gamecube/states/sab-citye-gameplay.gcs.gz" \
  PROBE_LOAD_STATE_MS=30000 PROBE_RESTORE_WITNESS=1 \
  node gamecube/tools/dolphin_render_probe.js > /tmp/gcw/sab-ingame-mips.log 2>&1
grep -a "\[witness\]" /tmp/gcw/sab-ingame-mips.log
```

Artifacts: `/tmp/gcw/<cell>.log`, `<cell>.rows.json`, `<cell>.png`,
`/tmp/gcw/guest-rate-truth-table.json`.

**Two traps this rig hit and now guards:**

- **`bash -lc` is the wrong shell.** The bash login profile sources
  `emsdk_env.sh` and puts `/usr/local/bin` ahead of nvm, where `node` is
  **v14.15.1**, which dies on puppeteer-core's `Symbol.dispose ??=` with a
  `SyntaxError` that reads exactly like a probe bug. Measured: interactive
  `node --version` = `v24.15.0`, `bash -lc 'node --version'` = `v14.15.1`. The
  rig now invokes `process.execPath` by absolute path.
- **Boot-phase W4 reads garbage.** Before MEM1 is laid out, `0x801D4428` holds
  whatever is resident; one window reported a `retraceCount` rate of
  **862,252,765/s**. A VI field counter cannot exceed ~60/s, so the rig now
  discards W4 samples outside `0..1000/s` instead of printing them.

---

## 7. Restore proof (gate #10)

`worker_funcs.js` posts `stateLoaded` on **every** path including failure, so
"loaded N bytes" proves nothing. Both proofs are required and both fired on
every state cell:

```
[probe] PROBE_LOAD_STATE @30000ms -> handed 10856457 gz bytes to the worker; worker ack ok=true
[restore-witness] samples=750  median d(global_timer)/200ms=42,347,448
                  LARGEST step=30,422,734,056 at t=32.81s  (=718.4x the median)
[restore-witness] MEM1 fingerprint: max changed words in one 200ms tick = 245/512 at t=32.60s
[restore-witness] VERDICT: DISCONTINUITY PRESENT — CoreTiming was replaced, i.e. DoState ran
```
(`/tmp/gcw/sab-ingame.log`.) Screenshots are in `/tmp/gcw/<cell>.png`.

**Never read the witnesses across the restore window.** The restore replaces
`global_timer` wholesale, so W1/W2/W3 momentarily describe two different clocks:
the worst cross-witness spread anywhere in this campaign is **36.13** at
`pso-ingame-mips` t=36.8s, which is exactly the restore boundary — six seconds
after the state was handed over at t=30s. Restricted to the steady windows the
worst spread in the entire campaign is **0.0009**. That is why the rig starts
its state-cell steady window at `restore + 25s`, and why a bare whole-run
average of a state cell is meaningless.

---

## 8. Findings

### F1. The witness is sound. Three cross-checks, two of them independent.

- **W1 ≡ W2 ≡ W3 to ≤ 0.0009 in every one of the 12 measurable cells.** The p90
  of the within-window spread (`max spread` column) tops out at **0.0007**, and
  the single worst steady window in the whole campaign is **0.0009**
  (`mp4-cold-jit-mips` t=151.8s). Two of those are different code
  paths (`DSP.cpp:608` raw callback vs `:642` DMA block wrap ÷ `NumBlocks`) and
  the third is the clock itself (`CoreTiming.cpp:404-410`). The
  callback-period arithmetic, the event scheduler and the SAB mirror are all
  mutually consistent.
- **W4 (guest-executed) agrees with W1 to 0.10–0.16% on all four MP4 JIT cells.**
  `retraceCount` is bumped by the *guest's* VI retrace ISR — it requires the
  emulated CPU to run and the interrupt to be delivered — and
  `d(retraceCount)/59.94` lands within 0.16% of a witness that never leaves the
  host. Example: `mp4-ingame-jit` W1 `0.4363x`, W4 `0.4369x`.
- **W5 (guest-render) corroborates on 10 of 12 measurable JIT cells.**
  `drawn/s ÷ W1` recovers 58.3–59.9 fps on MP4/SAB (NTSC field rate 59.94) and
  29.71–29.99 fps on PSO (30). The two failures are one scene, discussed in F4.

**Do not upgrade this into "three independent witnesses".** W1/W2/W3 share
`global_timer`. The independent evidence is W4 and W5, and both exist.

### F2. `[mips]` was misused, not broken — and `CREDITED` is the guest clock

The meter's `EXECUTED` number is cycles the JIT charged for real blocks, and
`EXECUTED/486` is *not* a guest-rate multiple. Its `CREDITED` half is
`global_timer`, which IS the guest clock and which this rig calls W3 — and W3
matched W1 and W2 to ≤ 0.0009 in every cell. The recorded "~1.7x disagreement
with `GlobalCounter`" is what you get from dividing the wrong half by 486.

The remaining volatility in the recorded 98.2/94.5/75.2/97.8% figures is *real
signal*: `EXECUTED/CREDITED` is scene-dependent by construction, and this
campaign measured it from 24.0% to 71.8% across six scenes on one binary.

### F3. THE HEADLINE — `pso-cold` reads 1.00x and is 71.8% skipped

```
pso-cold-mips   W1 0.9992x   W2 0.9992x   W3 0.9993x   spread 0.0007
                credited 485.7 MHz    executed 137.3 MHz    idle-skip 71.8%
                drawn 29.9/s   published 29.9/s   W5 implies 29.93 fps (0.2% off 30)
```

PSO's title screen advances emulated time at **0.9992x of hardware** — the guest
really is running at hardware speed, W5 confirms it renders its full 30 fps, and
that is a true statement about the *product*. It is also true that the JIT is
executing **137.3 MHz of a 486 MHz Gekko (0.2825x)** and that 71.8% of the
credited time was clock-jumped over an idle loop rather than executed.

Both facts are needed. Neither is a correction of the other. **A 1.00x on this
page from now on must be published as `1.00x (N% idle-skipped)` or not at all.**

The stable per-scene ordering that falls out (idle-skip share, all on one
binary): PSO title 71.8% > PSO Pioneer 2 64.0% > MP4 title 51.1% > SAB City
Escape 47.6% > MP4 board 26.4% > SAB boot/menu 24.0%.

### F4. SAB City Escape: three signals that disagree, and the rig says so

```
sab-ingame-mips  W1 0.4653x  idle-skip 47.6%  executed 118.9 MHz  drawn 2.6/s
                 W5 implies 5.91 fps — 60.6% off the nearest VI-locked rate
```

The restore is proven (worker `ack ok=true` **and** a CoreTiming step of
718.4x the median **and** 245/512 MEM1 fingerprint words changed in one tick),
and the screenshot `/tmp/gcw/sab-ingame.png` shows a live City Escape HUD
(score 280, 00:33:40, 10 rings) over a **black world**. So the state is real
gameplay, not the "Game Data cannot be found" modal, and the world is not being
drawn.

The rig can say the guest clock, the executed throughput and the frame output
disagree. **It cannot say which is at fault**, and this session did not isolate
it. This is the one cell in the matrix whose guest-rate number should not be
quoted without the screenshot next to it.

### F5. The AI-DMA witness DOES NOT APPLY to the recomp path — and must not print 0

A plain visit with Mario Party 4 selected routes to the **recomp engine**, with
no query parameter (`RECOMP_TITLES = { MarioParty4: 1 }`, `gamecube.html:1044`;
`?recomp=0` forces the JIT, `:1046-1047`). On that path the recomp worker owns
the game and Dolphin's CoreTiming never advances: **26 of 26 steady windows in
`mp4-cold-recomp` read 0 AI-DMA callbacks and 0 credited cycles** while the page
rendered at 60 published/s.

The first version of this rig printed that as `=> 0.0000x`. It is now reported
as `DOLPHIN CORETIMING PARKED … this is NOT 0.000x`. Read the recomp path with
the page's own rate model instead — its clock is `viRetrace`, bumped once per
`VIWaitForRetrace`, with `OSGetTime = viRetrace * 675000` ticks at 40.5 MHz =
exactly 1/60 s (`gamecube/recomp/recomp_worker.js:786`).

**Unexplained, recorded rather than guessed at:** on the recomp path
`drawn/published` is **exactly 2.00** (median 2.000, range 1.985–2.019 over 26
windows: 120.0 drawn/s, 60.0 published/s), whereas the same disc on the JIT path
gives **1.00** (`mp4-cold-jit`, 50/50). So the doubling is a property of the
recomp render path, not of MP4's GX stream. This rig did not determine what
makes `PixelEngineManager::SetFinish` fire twice per published frame there.
`framegen_webgpu.js` is not the cause — it is default-off and `gamecube.html`
does not reference it (grepped 2026-09-04, zero hits).

### F6. 240pSuite is dead on this binary, at the documented PC

`suite240p-cold`: 0 AI-DMA callbacks, 0 credited cycles, **0 drawn/s**, page
headline `speed 0.00x STARVED` for the whole run, and `xpc=0x80009374` in 32 of
the 33 `[scene-rate]` windows the run emitted. That is exactly the PC recorded in
`gamecube/docs/native-exact-dualcore/TASKS.md:1857-1858` as "240pSuite =
separate pre-existing bringup bug (PC 0x80009374, pre-GX, libogc)". Independent
re-derivation of a known-open item, not a new one.

Note the shape: **every rate witness reads 0 and so does `drawn/s`.** That is
what a dead core looks like, and it is distinguishable from the F5 parked-core
case only by the path — which is why the rig reports the path on every row.

### F7. Arming the meter is below this rig's resolution

Matched pairs, same scene, same frozen binary, meter OFF → ON (W1 median):

| scene | off | on | Δ |
|---|---:|---:|---:|
| MP4 title | 0.8353 | 0.8315 | −0.5% |
| MP4 board | 0.4363 | 0.4433 | +1.6% |
| SAB boot/menu | 0.3674 | 0.3855 | +4.9% |
| SAB City Escape | 0.4473 | 0.4653 | +4.0% |
| PSO title | 0.9998 | 0.9992 | −0.1% |
| PSO Pioneer 2 | 0.6408 | 0.6544 | +2.1% |

The meter can only **add** emitted ops, so a slowdown is the only physically
possible direction. Four of six pairs came out *faster* with it on. The correct
reading is therefore: **its cost is not resolvable above run-to-run noise at
load 4.3–7.4**, so the idle-skip percentages can be quoted as-is. Do not read
the +4.9% as a speedup — CLAUDE.md gate #10 is explicit that this box's
matched-pair noise reaches ±25% at higher load.

---

## 9. Open

- [ ] **W4 for SAB and PSO.** The only genuinely independent *guest-executed*
      witness is MP4-pinned because `tools/gsne8p.map` / `tools/gpoe8p.map` have
      no `retraceCount`. Recovering the dolsdk `vi.c` `retraceCount` address in
      each disc (signature-scan against `~/Downloads/GameCubeSDK`, or
      `tools/gcsdk_scan.py`) would give every title a liveness-and-rate witness
      that does not go through CoreTiming.
- [ ] **Fold `idle-skip` into the shipped page readout.** It is currently
      behind `?bjit_mips=1` because the meter costs 2.2pp of executed ops. A
      cheaper form — accumulating the *skipped* `downcount` at the two
      clock-jump sites, which fire at slice rate rather than block rate — would
      let the page publish `Nx (M% skipped)` with no per-block tax. Not
      attempted here (it needs a rebuild, and rebuilding the live worker
      poisons concurrently running sibling probes).
- [ ] **Explain the SAB City Escape shortfall.** 0.465x clock and 118.9 MHz
      executed, but only 2.6 drawn/s and a black world behind a live HUD. This
      rig can say the three things disagree; it cannot say which is at fault.
- [ ] **Native-Dolphin arm.** The witness cells compile out off-Emscripten
      (`DSP.cpp:584-589`), so the rig cannot currently read a native reference
      run. A native oracle arm would turn W1/W2/W3 from "self-consistent" into
      "calibrated".

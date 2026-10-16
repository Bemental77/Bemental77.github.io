# Dreamcast on the toaster: where a frame's time goes (measured 2026-10-12)

## Answer

- **The toaster frame is emulation, and most of it is the SH4.** At rate 6.2,
  the emulation worker spends 951 ms of every second inside `run_iter`. Render
  hand-off takes 33 ms/s, and the governor throws away about 500 ms of debt
  every second. The guest runs at 0.458x (mean of 19 one-second windows, PSO2 seed scene).
- **The room in steady state runs at the same speed as solo.** Over a 60 s window
  the room read 0.361x (host and joiner each 0.37x), with
  42 ms/s of gate wait. The 20 s gate reads 0.05-0.15x in the room because its
  window opens during warm-up. The first ~5 heartbeats after the room's frame-0
  seed run at 0.01-0.06x. One `run_iter` alone held the worker 5.7 s. The window
  closes before the room reaches its steady rate.
- **The fix is in the core, and the core cannot be rebuilt on this box.**
  `dreamcast/flycast-src/` holds only the 34 ported files. There is no upstream
  Flycast checkout and no `libflycast_libretro.a` or other build archive
  (searched `/`). The link (`flycast_worker_link.sh:26`) needs both. Cloning
  Flycast is the permission the user has not granted, so `flycast_worker_emcc.wasm`
  is frozen. Every runtime knob the shipped wasm exports was checked: chain, ic,
  idleskip, arm7jit, mem_fastpaths, regcache, imm_fastpath, self_loop, rte_intc,
  fog and modvol. Each is already at its fast/correct default, or turning it
  changes the picture. **No product change was made.**

## The split

Rig: `dreamcast/tools/toaster_split.mjs` (this card). It uses SwiftShader,
`--max-old-space-size=512`, and the `tools/toaster_duty.py` duty cycle. The scene
is the PSO2 fresh-boot seed. wasm `flycast_worker_emcc.wasm` was unchanged from
HEAD `aa5a1b5`. Every run held `tools/probe_lock.sh`. Load at the start of each run: 6.6 (rate 1),
4.7 (6.2 solo) and 3.9 (6.2 room).

### Per one-second window (worker counters, mean of the settled windows)

| arm | guest x | emu ms/s | render-hold ms/s | gate ms/s | gov drop ms/s | pictures/s | emu per guest-second |
|---|---|---|---|---|---|---|---|
| rate 1, solo (n=24) | 1.000 | 457 | 29 | 0 | 0 | 21.3 | 457 ms |
| rate 6.2, solo (n=19) | 0.458 | 951 | 33 | 0 | ~500 | 2.7 | 2078 ms |
| rate 6.2, room host (n=57, 60 s) | 0.368 | 875 | 28 | 42 | ~600 | 2.5 | 2377 ms |

Emulation costs 4.5x more per guest-second at rate 6.2, not 6.2x
(457 → 2078 ms). The duty cycle does not slow wasm by its nominal rate. This
matches `toaster_bench`'s own BenchmarkIndex proof, which measured worker
slowdown at 5.3-7.2x.

### Inside `emu` (CDP CPU profile of the worker, rate 1, 15 s, 36,004 samples)

The worker was busy 41.5% of the time. The rest was `Atomics.wait` in the
governor's sleep. Shares below are of busy time. The duty cycle slows every
thread of the renderer equally, so these shares carry over to rate 6.2. The
exception is render, whose share falls to 7.7% of mainloop at 6.2 (the `[split]`
`rnd` field) because only about 2.7 pictures/s are drawn there.

| bucket | % of busy | what is in it |
|---|---|---|
| **SH4 JIT** | **~64%** | emitted SH4 blocks 43.5; dispatch_slice + jit_lookup 8.9; guest mem / MMIO slow paths 9.5 (`sh4_mem_write32` → `pvr_WriteReg` is the render start, counted under render below); sh4_sched 2.3 |
| **ARM7 + AICA audio** | **~17.8%** | `aica::AicaUpdate` inclusive 17.6: ARM7 (`arm_mainloop_c` + its JIT modules + `DoMemOp`) 9.1, channel mix / DSP 8.7 |
| **PVR / TA render** | **~9.6%** | `pvr_WriteReg` → `PvrMessageQueue` → `OpenGLRenderer::Process` (`ta_parse` 3.6) + `Render` 4.4 + `GetTexture` / XXH32 tex hash 2.5 + the WebGL JS calls |
| **present** | 29 ms/s at rate 1 (~6% of occupied time); 33 ms/s at 6.2 (~3%) | `paceHeldMs`: the thread is held while the GPU process takes a drawn frame |
| **threads / SAB waits** | solo 0; room 42 ms/s gate (~4%) | `paceGateMs`; JS glue on the worker (postMessage, onCmd, get_now, fences) is a further ~3% of busy |

## What it would take to pass at 6.2

A pass needs the guest at 1.000x, so emulation must fit in about 950 ms of
every wall second. At 6.2 it now takes 2078 ms per guest-second, so it has to
be cut **~2.2x**.

- If ARM7/AICA and render both moved to other threads, the worker would keep
  only the SH4 share: 0.64 x 2078 = **1330 ms**, still over budget.
- So no single lever passes. The SH4 path itself has to get at least 1.4x
  faster, AND audio and render have to move off its thread (or get about 2x
  cheaper).
- **Every one of those is a core (C++) change.** The levers, in order of size:
  1. SH4 emitted code + dispatch. Emitted code is 43.5% and dispatch +
     jit_lookup is 8.9%; `lever13-worker-attribution` covers why per-block
     codegen alone has returned nulls.
  2. ARM7/AICA on its own thread. This needs a deterministic hand-off, because
     rooms are lockstep and depend on purity
     (`dreamcast/docs/room-determinism`).
  3. `ThreadedRendering`, which is forced off in `core/emulator.cpp` for wasm.
     It would move TA parse + Render off the SH4 thread.
  4. Skip `ta_parse` / `Process` for frames whose picture is skipped (render
     to texture excepted).
- The JS-reachable remainder is too small to matter. Present is ~3% at 6.2,
  and JS glue on the worker is ~3%. Even taking all of it moves the rate by
  ≤6%, against the 2.2x that is needed.

## Room warm-up (the 20 s gate's room number)

```
hb1 x=0.013 emu=5738 wall=5811   (one run_iter: the post-seed JIT refill)
hb2 x=0.031  hb3 x=0.058  hb4 x=0.025  hb5 x=0.215 ... hb14 x=0.468
steady (hb6..hb60): 0.368x host / 0.37x joiner, gate 42 ms/s
```

Solo's measured window opens at `hbSinceRestore >= 2`, which is after the seed.
The room's window opens on `running`, during the refill. This reads as a gap in
the gate (`lib/bench.js` dreamcast adapter) and was **not** changed here,
because changing the gate's rules is not a fix. The product cost is real: a
toaster's room starts with about 10 s at 0.01-0.2x. It is a core cost (JIT
recompile after `lockstep_normalize`'s flushes) and needs the same rebuild.

## Update 2026-10-14 — core rebuilt, two levers shipped, the gate did not move

The core now rebuilds on this box (upstream `4be8a484` worktree + ported files,
`verify_core_tree.sh` PASS; dreamcast/docs/rollback/TASKS.md). Shipped:

* **Store-queue stores in-wasm** (`wasm_emit.cpp`, size 4 + fmov.d pair to
  0xE0-0xE3 -> `ctx->sq_buffer`): slow-path SQ stores 60,287/frame -> 0 in the
  PSO lobby. A/B arm `_flycast_set_sq_fp(0)`.
* **Lever 4, the picture nobody sees is not built** (`Renderer_if.cpp`
  `flycast_set_render_skip`, set by the worker's FSK each frame): TA parse,
  Process and Render are skipped for a skipped screen frame (never RTT); the
  frame still ends at the same present, so frame boundaries are unchanged.
  `[split] rnd` at rate 6.2: **1.2-1.9 %** of run_iter (was 7.7 %).

`tools/toaster_bench.mjs --pages dreamcast --rate 6.2 --reps 3 --ladder 0`
(the bench's own load reads 14-19 on this 4-core box during every run):

| build | solo speed (3 reps) | room speed (3 reps) |
|---|---|---|
| rebuilt baseline (HEAD 54bb7a8, before the levers) | 0.4413 / 0.4191 / 0.4515 | 0.1397 / 0.1555 / 0.1677 |
| + SQ in-wasm + render skip | 0.4114 / 0.4148 / 0.4012 | 0.1801 / 0.1686 / 0.1735 |
| same, `--qs dcrb=0` (no rollback arm) | 0.4462 / 0.4443 / 0.4404 | 0.1747 / 0.1656 / 0.1225 |

**No measurable change at 6.2.** Rate-1 probe on Character Select: duty
90-94 % -> 75-81 %, headroom 1.1x -> 1.2-1.3x — the levers do work where the
picture is drawn, but the 6.2 frame is not render-bound.

### The 6.2 profile, bench scene (Character Select), after the levers

`toaster_split.mjs 6.2 40 '' --prof 15`, 7,357 samples, 97.7 % busy:
SH4 70.3 % · ARM7/AICA 21.2 % · PVR 5.5 % · JS 2 %. Top self time:
`dispatch_slice` 6.2 %, `arm_mainloop_c` 4.1 %, `jit_lookup` 3.6 %,
`sh4_sched_tick` 1.8 %, TMU/P4 register reads (`readt` + `ReadMem_p4mmr` +
`read_TMU_TCNT`) 4.4 %, ARM `DoMemOp` 1.5 %; emitted JIT code 48.9 %.
The ARM7 sound driver's main loop (0x194-0x1d4) polls ~10 handlers per pass
and never waits, so a self-loop idle skip does not apply; idle-skip burns are
only ~400-1,100 per frame here (the counter is cumulative — an earlier
"70K/frame" read was wrong).

### What would pass it (unchanged conclusion, sharper numbers)

Still ~2.2x short. None of these is in place: SH4 dispatch/lookup is ~10 %,
ARM7 + AICA ~21 % (batching samples per callback, or its own deterministic
thread), and the emitted code itself ~49 % (codegen, not plumbing).

## Update 2026-10-14 (later) — the GL stream offload: big solo headroom, neutral on the toaster

`flycast_worker.js` GLRec + `dreamcast/flycast_libretro/dc_render_worker.js`
(default ON, `?glsplit=0` = control). The core's GL calls are recorded on the
emulation thread and replayed by a second worker that owns the canvas.

Why: a picture presented from a thread holds that thread until the GPU process
has rasterised it. Micro-rig (`dcrb-present.mjs`, SwiftShader, 8 ms of CPU work
+ one 200-quad picture per task): drawn on the working thread 41 tasks/s with
14.7 ms held per picture; drawn by a second worker 122 tasks/s (the no-draw
ceiling is 124) at the same ~40 pictures/s. The hold grows with raster work
(2.2 ms at 1 quad, 130 ms at 2000), and a `gl.flush()` before the work does
not overlap it.

Measured (same box, load 1-5, interleaved, PSO Pioneer 2 lobby state, 1.000x):

| arm | duty | emu | render-hold | pictures/s |
|---|---|---|---|---|
| split a / b | 52.5 / 51.0% | 51.3 / 49.4% | 1.2 / 1.6% | 16.1 / 16.5 |
| control a / b | 87.5 / 86.8% | 38.2 / 37.5% | 49.3 / 49.3% | 12.9 / 13.3 |

Emu time per guest second rises 30% (CPU contention with the now-concurrent
raster; the recorder itself is ~3% of the worker in a profile). Gauntlet cold
boot: duty 83% (emu 80.7 + hold 2.3) vs ~98-100%.

What it does NOT move: a two-browser room on this 4-core box (all cores are
already busy; split 0.907/0.912 and 0.908/0.911 vs control 0.919/0.923 and
0.920/0.913) and the toaster gate at rate 6.2 (render-hold there is ~3%; solo
0.576/0.593 vs control 0.577/0.622, room 0.242/0.154 at load 20 vs
0.248/0.255). Rollback rig 45/45 EXACT, lockstep and forced-rollback PSO soaks
IN SYNC, Gauntlet room 0 desyncs.

## Update 2026-10-14 (later still) — linked without asyncify: -6% emu, toaster solo 0.67x

`flycast_worker_link.sh` now links `-sASYNCIFY=0` by default (`FLYCAST_ASYNCIFY=1`
= the old instrumented build). Nothing in the shipped paths suspends. The wasm
shrinks from 8.71 to 6.93 MB.

- PSO Pioneer 2 lobby, three interleaved pairs from hermetic snapshots (load 3.5-5.6):
  emu per guest second is 501 / 501 / 482 ms with asyncify and 464 / 463 / 469 ms without.
- Gauntlet cold boot: 767 ms against 807.
- Toaster rate 6.2, 2 reps at load ~20: solo 0.678 / 0.671 (was 0.576-0.622), room
  0.259 / 0.273 (was 0.242-0.255).
- Rollback rig 60/60 EXACT.
- Soaks IN SYNC: PSO lockstep (61 checkpoints), PSO forced rollback (32), Gauntlet
  forced rollback (48).

A CPU profile with `?jitnames=1` (emitted blocks named `pc_<vaddr>`) shows the
emitted SH4 code at 55% of busy time and FLAT: the hottest block is 1.2%, and the
30th is 0.17%. The remaining dispatcher share is the SH4_TIMESLICE (448) round
trip, about 446K a guest second.

## Tried and rejected 2026-10-15: AICA + ARM7 on their own pthread

The design is in the reflog: local commits acf7c1b..63c7e42, never pushed.
- The SH4 thread posted sample k at its own guest time T_k and kept running.
- A pthread ran `arm::run(1)` for that sample.
- Every SH4 access to AICA space (sb_mem.cpp area 0, the aica_if.cpp G2 DMA) and every
  savestate first waited for the posted sample.
- The AICA -> SH4 IRQ level was re-derived on the SH4 thread at T_k+1, at most one sample late.

Semantics were otherwise exact. Measured how often the SH4 touches AICA space:

| scene | accesses/s | distinct sample periods/s with an access |
|---|---|---|
| PSO Pioneer 2 lobby | 45.6K | 2.8K (of 44.1K) |
| Gauntlet | — | ~70 |

So the coupling is loose enough on paper. On this box it lost badly:

| run | without the thread | with the thread |
|---|---|---|
| PSO lobby at 1.000x, emu ms per guest second | 442 | 559-733 |
| toaster rate 6.2, solo | 0.684 | 0.343 |

Instrumented: the AICA thread was busy only ~10% of wall (2.2 us a sample).
The SH4 still waited at 78% of samples, about 7.6 us each, ~25% of wall in all.
The cause: a spinning thread gets descheduled while idle, then misses the next
post. That happens on a box whose four cores are already shared with SwiftShader,
the render worker and the browser, and under the toaster's duty cycle. A per-sample
handoff needs a core of its own. A batched handoff (lag L samples) would shift
SPU-IRQ timing by L samples. It would also still pay a full sync at every SH4 AICA
access, and with a sleeping thread that sync costs a wake latency. Not pursued.

## Guest-work cut: exact fast-forward of Gauntlet's timed wait (2026-10-15)

Guest-PC histogram (`?pchist=A,B`, weights each PC by the guest cycles it took).
PSO lobby: 64.6% of guest time is already removed by the frame-wait idle skip.
Gauntlet attract: 0% was skipped. In the window measured after this change,
7.9% of guest time sat in one loop at 0x8c032e5a. Another ~6.7% sits in a
TMU-timed delay (0x8c015db6 -> 0x8c0429c8, which reads TCNT0 and divides);
that one is not touched yet.

The loop (caller 0x8c032e20) is a timed wait: up to 0x100000 passes of
`jsr @R13 (0x8c038440) ; mov #7,R4`, then `(*[R15])--`, exit if
`*[R15+4] != R14`, loop while `*[R15] != 0`. 0x8c038440 calls table entry 7
of 0x8c35c274, which is the null stub 0x8c036600 (rts; nop). It reads no
timer. A pass is 6 blocks and 50 guest cycles: 3+17+3+8+12+7, learned from
flycast's decoder.

`gwff_try` (rec_wasm.cpp) applies K passes in one step at the loop head. K stops
before the first slice credit that would tick the scheduler, and before the pass
that takes the counter to zero. The cycle bookkeeping is closed-form (see the
comment there). It falls back to running the pass on anything unexpected: code
bytes, the table entry, aliasing, a pending interrupt, the MMU, or block lengths
not yet learned. The head is excluded from chaining and from intra-shard
tail-links (`bemental_sh4_set_nolink_pc`), so every arrival is seen. `?gwff=0`
is the control. The learned cycle table is host history, but the transform is
exact, so FF vs no-FF produces the same guest state. The mixed-arm room below
proves this directly.

Measured: K is ~89 passes per fast-forward (the next scheduler event, ~4.5K
cycles, is the bound), 25.3M passes and 295K fast-forwards in 120 s, the same
counts in every run. Gauntlet cold-boot attract, 6 interleaved pairs, load
3.8-5.2, emu ms per guest second, on/off: 744/764, 767/737, 740/764,
723/749, 740/742, 743/741. Mean 743 vs 750, about -1%, inside the noise. The
skipped passes were cheap chained blocks. The toaster bench runs PSO, where
this does not fire.

Exactness, wasm `253ef97a`:
- Mixed-arm Gauntlet room in rollback mode (`dcrb=4&dcrbforce=1`), host gwff
  on, joiner `?gwff=0`: IN SYNC over 48 RAM checkpoints and 48 engine
  fingerprints across 92.3 guest s. The host applied 9.8M fast-forwarded passes
  inside that span. This is the direct proof: FF and no-FF reach the same state.
- Rollback rig 60/60 EXACT (PSO lobby). Soaks IN SYNC: PSO lockstep, PSO forced
  rollback, Gauntlet forced rollback. Gauntlet boots at 0.998x.
- A mixed-arm room in plain LOCKSTEP (not rollback) DESYNCs at f180. That run
  is not a test of exactness. The same mixed lockstep room with `?sliceinwasm=0`
  on the joiner, a knob that is exact by construction, also DESYNCs, while the
  same-arm Gauntlet lockstep room is IN SYNC (29 checkpoints). Outside rollback
  mode, block routing (shard seal points, pending-span interpretation) follows
  host dispatch history, so any knob that changes dispatch counts forks a
  mixed room. Rooms run one build, so peers share that history.

## 2026-10-15 (later) — ARM7 spin drop rejected, tier-up priced, ARM sound-RAM inline shipped

All on this box, PSO = Pioneer 2 lobby state, Gauntlet = cold-boot attract, rate 1, load 3-6,
emu = ms of emulation per guest second (mean of the settled heartbeats).

**ARM7 pure-spin drop: not worth building.** `?armhist=A,B` (new DIAG, `arm7_rec_wasm.cpp`)
counts ARM cycles by block start pc and dumps the hot code for an offline disassembly.
The detector (same block, identical register file + mode/enable state, no store and no
read outside sound RAM in between, inside one sample) found nothing after boot in either
game. PSO's driver does real work at 22.6 MHz (top blocks 0x1cec 26%, 0x9d0 11%, 0x93c 8%:
channel-update loops that store). Gauntlet's main loop scans 64 bytes for != 0xff
(0x4afc/0x4b08, 41%) then a 32-bit mask (0x4b54/0x4b5c, 32%). Each pass stores, and one
pass is longer than a sample's 512 cycles. The drop code was removed. Only the histogram stays.

**V8 tier-up is ~8% of emulation, and a page cannot buy it back by merging functions.**

| arm | emu (ms per guest s) |
|---|---|
| default | 477 / 462 / 472 |
| `--js-flags --no-liftoff` | 434 / 430 |
| `--wasm-tiering-budget=20000` | 433 |

So the whole gap is functions still running in Liftoff. Most of them are the long tail of
emitted SH4 blocks: each runs a few times a frame and never spends its budget. Tried: put
32 (or 4) shard members in one wasm function behind a br_table, so their exits share one
budget. With TurboFan forced on both arms, that code is 20% slower (496 / 488 vs 411 / 409).
At the default tier it is no better (469 / 466 vs 460 / 444). Reverted. A page has no way
to ask for TurboFan. The lever is real but has no mechanism yet.

**Shipped: ARM7 sound-RAM loads and stores inline** (`emitMemOp`, `?armmemfp=0` is the
control). Every LDR/STR used to be a call_indirect into `DoMemOp`. Measured with
`?armtime=1` (new DIAG: ARM mainloop wall time per guest second), PSO, two interleaved pairs:
68.4 / 68.3 ms with the change vs 75.2 / 74.4 without, about 1.5% of emulation. In the same
set, block-end chaining (each block calling `EntryPoints[pc]` itself) bought nothing:
67.8 / 65.3 with it off. Not kept.

- Exact: rollback rig REF1==REF2 61/61, REF==RB 59/59.
- Soaks IN SYNC: PSO lockstep 74 checkpoints, PSO forced rollback 32, Gauntlet forced
  rollback 32.
- Mixed-arm Gauntlet rollback room (joiner `armmemfp=0`): IN SYNC, 32 checkpoints.
- Toaster rate 6.2, load 15-16: solo 0.652 / 0.606, room 0.247 / 0.216. That is the same
  band as before. 1.5% is inside the bench's noise.

**div32 sized** (ctxsnap 146, `div32=` in `[ctxsnap]`): PSO lobby ~18.6K C-fallback fires a
guest second, Gauntlet ~100K (its TMU delay loop). Also counted: sync_fpscr 2.3K / 6.3K and IFB
3.3K / 1K. Each fire is flushAll + an import call + a reload.

**div32 inline: exact, no gain, shipped OFF** (`emitDiv32Inline`, `?divinline=1` arms it).
Mixed-arm rollback rooms with the joiner on the C fallback stayed IN SYNC (Gauntlet 32
checkpoints, PSO 32). Emulation per guest second, on vs off: Gauntlet 838/824/836 vs
835/845/851, PSO lobby 502/498 vs 494/484. That is inside the noise.

Toaster-rate profile, this build (rate 6.2, 15 s, 7,449 samples, worker 98% busy):
- emitted code 53.8% (SH4 ~47.5, ARM ~6.2)
- AicaUpdate inclusive 18.6% (ARM mainloop inclusive 10.6)
- dispatch_slice 3.9 + jit_lookup 2.4 + credit_slices 1.5 + sh4_sched_tick 1.3
- P4/TMU reads (readt + ReadMem_p4mmr) 3.0
- JS glue ~4

## 2026-10-15 — the AICA sound update: what is in it, and an exact ~1% cut (?aicafast=0 control)

What the 18.6% is. It is `AicaUpdate` INCLUSIVE, and the ARM7 mainloop is 10.6 of it.
The rest is the per-sample sound path. `?aicatime=1` (new DIAG) splits it and counts
voices. PSO Pioneer 2 lobby: 2.0-2.4 of 64 channels enabled a sample, FEG active on
0-0.4, `config::DSPEnabled` = 0 (the game loads an 84-step DSP program, and it never
runs). Gauntlet attract: ~1 channel, DSP off. So there is nothing to vectorise. Mixing,
interpolation, envelopes and DSP together are a few channel-steps a sample. The cost
is the fixed per-sample path. A CPU profile with the parts forced out of line (rate 6.2,
attribution only): `timeStep` 4.5% of busy. `StepAll` self 2.3%, which is the
64-entry `enabled` scan. `__pthread_mutex_lock/unlock` in `WriteSample` 0.55%.
`sh4_sched_tick` self 3.6%: its list walk plus an `sh4_sched_ffts` walk for every
reschedule.

Shipped, all exact, `?aicafast=0` = upstream's route:
- `StepAll` walks a 64-bit enabled mask (`ChannelEx::enMask`) in ascending order. It
  re-reads the mask above the channel it just stepped, so a self-disable reads the same
  as the scan. The writers are enable/disable/deserialize, which are also the only
  writers of `enabled`.
- `WriteSample` (libretro audiostream, new ported file) skips the per-sample mutex
  while ThreadedRendering is off. Every user of `audio_buffer` then runs on the
  emulation thread.
- `sh4_sched_request` inside `sh4_sched_tick`'s callbacks skips its own `ffts`, since the
  tick ends with one. ffts is a pure function of (sch_list, now), and it keeps `now()` fixed.

Measured. `?aicatime=2` (new DIAG) times every `sh4_sched_tick` with work, which covers
all callbacks: AICA, ARM7, SPG, TMU. It reports ms per guest second, with the same two
clock reads in both arms. PSO lobby, interleaved, load 1.7-5.6: on 95.5 / 93.3,
off 100.0 / 99.1. Gauntlet attract: on 84.8, off 91.2. That is -5 to -6 ms of the ~500 /
~800 ms of emulation, about 1%. Whole-emulation pairs (emu ms per guest second, PSO,
load 2.7-6.5) cannot resolve it: on 509.6 / 504.1, off 495.9 / 504.3. Toaster rate 6.2,
2 reps, load 6-13: solo on 0.592 / 0.555, off 0.563 / 0.576. Room on 0.168 / 0.186,
off 0.212 / 0.212. Both are inside the bench's noise.

Exactness, wasm `c63e673e`:
- `?aicahash=1` (new DIAG) prints, every 5 guest s of SH4 time, a hash of the output
  samples, the whole `aica::serialize` state (ARM7, DSP, timers, sound RAM, regs, 64
  channels) and SH4 RAM, and checks the mask. On vs off: PSO lobby 50 windows
  identical, and Gauntlet attract 47. Off vs off also matched (18).
- Rollback rig REF1==REF2 61/61, REF==RB 59/59, 0 full-flush fallbacks.
- Soaks IN SYNC: PSO lockstep 102 checkpoints, PSO forced rollback 32, Gauntlet
  forced rollback 32.
- Mixed rollback rooms with the joiner on `aicafast=0`: PSO and Gauntlet, 32 checkpoints
  each, IN SYNC.
- Boots: PSO lobby 1.000x and Gauntlet 0.999x, with screenshots.

What is left in the 18.6% is the ARM7 (~68 ms per guest second in PSO, `?armtime=1`)
and the scheduler's per-event walk. Neither is a mixing cost.

## 2026-10-15 — TMU TCNT reads go straight to the handler (?tcntfp=0 control)

Which reads these are. Every SH4 read that misses the inline RAM path was
histogrammed by address over 20 s (a temporary build, not kept).
- Bench scene (the toaster gate's PSO seed): `TCNT0` (0xFFD8000C) 32-bit, ~500K a
  guest second, 85% of all slow-path reads. Next are SB_ISTNRM (0xA05F6900, ~43K/s) and
  SB_FFST (0xA05F688C, ~31K/s).
- PSO lobby: TCNT0 is only ~1.2K/s. ISTNRM and FFST lead there.

`?pchist` names the reader: a timed wait at 0x8c38d480..0x8c38d4a8. It calls
0x8c37b636 (`mov.l @(lit)=ffd8000c,R2 ; mov.l @R2,R3`), subtracts the start tick and
scales the result with a multiply/divide helper, then exits on elapsed >= 0x28870 or a
RAM flag. It is ~13.6% of all guest cycles in that scene, which is ~43% of the cycles
idle-skip does not burn. An exact fast-forward of this loop (gwff-style) is the larger
lever, and it is not built here.

Shipped, exact: `sh4_mem_read32` sends a 32-bit read of TCNT0/1/2 straight to
`read_TMU_TCNT<ch>`, through `tmu_tcnt_read_direct` (tmu.cpp, new ported file), while
`ReadMem32 == addrspace::read32` (MMU off). That handler is what the readt -> RF32[] ->
ReadMem_p4mmr -> TMU bank route ends in, and nothing else on the route has an effect.
With the MMU on, reads take the normal route.

Measured. Bench scene, rate 1, `toaster_split.mjs 1 40`, emu ms per guest second, 4
interleaved pairs, load 1.3-4.9. On / off: 376.6 / 385.2, 384.8 / 407.3, 385.9 / 435.1,
404.5 / 411.5. Every pair favours on, and the mean is -5% (388 vs 410). Toaster 6.2,
2 reps: solo on 0.677 / 0.583 (load 6-16), off 0.575 / 0.581 (load 15-26). Room on
0.201 / 0.235, off 0.238 / 0.245. Both are inside the bench's noise.

Exactness, wasm `d31fabe4`:
- `?aicahash=1` on vs off: bench scene 35 windows identical (the TCNT-heavy scene),
  PSO lobby 32, Gauntlet 33.
- Rollback rig REF1==REF2 61/61, REF==RB 59/59.
- Soaks IN SYNC: PSO lockstep 81 checkpoints, PSO forced rollback 33, Gauntlet forced
  rollback 32.
- Mixed rollback rooms with the joiner on `tcntfp=0`: PSO 33, Gauntlet 32, IN SYNC.
- Boots: PSO lobby 1.000x and Gauntlet attract, with screenshots.

## 2026-10-15 — exact fast-forward of PSO's timed wait (?pswff=0 control)

The loop (0x8c38d480..0x8c38d4a8, read in place from a `?peek` dump of the bench scene):

```
8c38d480 jsr @R13 (8c37b636: R0 = ~[0xffd8000c] = ~TCNT0) ; nop
8c38d484 mov R0,R5 ; jsr @R10 (8c37b640: R0 = R5 - R4) ; mov.l @R12,R4   (R12 = 8c58d144, the start tick)
8c38d48a jsr @R9 (8c37b67a: R0 = ((d&127)*100>>7) + (d>>7)*100) ; mov R0,R4
8c38d48e mov R0,R14 ; if (*0x8c58caf4 == 0) goto 8c38d49e (exit)
8c38d498 if (R14 <u 0x28870) goto 8c38d480
```

A pass is 8 blocks, 51 guest cycles (3+9+6+4+3+15+7+4, from flycast's decoder). It
stores nothing and touches no stack. It reads TCNT0, the start tick and the flag.
Between two scheduler ticks nothing else can change RAM or deliver an interrupt, so
a pass differs from the one before only in its TCNT0 value. That value is a pure
function of guest time (`tmu.cpp`: base - (now() >> shift)). The registers after
a pass depend only on the last read: R0 = R14 = e(d), R4 = d, R5 = 100,
R2 = 0x28870, R3 = 0x8c58caf4, MACL = 100*(d>>7), PR = 0x8c38d48e, T = 0.

`pswff_try` (rec_wasm.cpp) applies K passes at the head. The per-pass TCNT values
come from `tmu_tcnt_model` / `tmu_now_cycles`, new in tmu.cpp, with no side effects.
The read in pass j happens at now0 + (j-1)*51 + 12. K stops before any of these:
- the first slice credit that would tick the scheduler (gwff_try's closed form);
- the pass whose e(d) reaches 0x28870. That pass runs for real, so the guest takes its own exit;
- any read below zero, where the real read reloads TCNT and raises TUNI0;
- a wrap of d.

e(d) is monotone over u32, so K is found by bisection. All 8 blocks must be
compiled and live: `jit_live` is a side-effect-free `jit_lookup`. A pending block
runs interpreted at a different cycle charge. The first check build without this
rule mismatched cc in 191 predictions after the restore. Anything else unexpected
falls back. K is ~87-96 passes in the bench scene (the next event bounds it).
`?pswff=2` (DIAG) predicts K passes, applies nothing, and compares
R0-R15/PR/MACL/MACH/T/cc/sched_next at the K-th following head arrival: **327,310
predictions, 0 mismatches**. The 1-pass version: 1.9M, 0.

The head is unlinked in every arm, the control included (second emitter no-link
slot). `?pswff=0` compiles the same code and differs only in the apply.

Measured. Bench scene, rate 1, `toaster_split.mjs 1 40`, emu ms per guest second
(last 30 heartbeats), 4 interleaved pairs, load 3.1-5.6, wasm `25c20ad8`. On / off:
321.2 / 400.3, 323.6 / 422.0, 341.9 / 415.0, 340.2 / 406.2. Mean **331.7 vs 410.9,
-19.3%**, and every pair favours on.

Exactness, wasm `25c20ad8`:
- `?aicahash=1` on vs off, bench scene, 47 windows each (~230 s):
  - With `?noshard=1`, **47/47 identical**. A build before the final one gave 25/25.
  - Sharded (the default), 45/47 identical. Audio and AICA state match in all 47.
    The SH4 RAM hash differs at w=24, the first window after the seed restore,
    which is the JIT refill. It also differs at w=45. With 4 KB page hashes at
    w=24/25, the difference is 3 pages: 0x8c00f000, 0x8c58d000 (the loop's start/end
    ticks) and 0x8c5b9000 (frame-wait words). Both arms re-converge.
  - A no-op arm (`?pswff=2`, nothing applied) also differed from off at w=24.
    Before the head was unlinked in every arm, the linkable control differed at w=25.
  - Cause: outside rollback mode, shard seal points follow dispatch counts.
    Removing dispatches moves which blocks run interpreted, and those run at a
    different cycle charge. This is the gwff caveat above. noshard removes it,
    and rollback mode (per-block install) removes it too.
- Rollback rig on the PSO lobby: REF1==REF2 61/61, REF==RB 59/59, 0 full-flush fallbacks
  (809 fast-forwards during warm). On a Character Select state (the bench scene,
  10,441 fast-forwards / 90.8K passes in warm): 61/61 and 59/59.
- Soaks IN SYNC. PSO lockstep: 67 RAM checkpoints + 67 fingerprints, 115.8 guest s.
  PSO forced rollback: 37. Gauntlet forced rollback: 35 RAM + 38 fingerprints.
- Mixed PSO rollback room (`dcrbforce=1`, joiner `?pswff=0`): **IN SYNC over 37 RAM
  checkpoints and 37 fingerprints**, while the host applied 34.4M fast-forwarded passes.
- `verify_core_tree` PASS. Boots: PSO lobby 1.000x and the bench Character Select
  (bench PASS 1.000x), with screenshots.

Toaster: `tools/toaster_bench.mjs --pages dreamcast --rate 6.2 --reps 2 --ladder 0`,
run back to back.
- On (load 4.3 at start, 8.4 at end): solo **0.813 / 0.840**, room 0.287 / 0.303.
- Off (`--qs pswff=0`, load 8.4 -> 9.1): solo 0.549 / 0.596, room 0.277 / 0.223.
- The off arm ran at higher load, so this is not a clean pair.
- Solo on is above every earlier band in this file (0.58-0.68x). It is still 0/2 PASS.

## 2026-10-15 — the room cell, split; rollback-mode batch compile; the room starts in delay on a slow box

Rig: `dreamcast/tools/toaster_room_split.mjs <room|pair|solo> <rate> <sec>` (new). Same arm as
the gate (SwiftShader, 512 MB heap, `tools/toaster_duty.py`). `room` = host + joiner in a new
window (own renderer, the bench's `--joiner tab` topology); `pair` = two solo pages in two
windows, the room's topology without the room. Per heartbeat it logs x (aicaX), emu/gate/held,
the engine's mode; `--thrat H` adds per-thread CPU from /proc over the steady window. PSO seed
scene, wasm `25c20ad8` for the split, load 5-20 (the cell itself drives it to ~15-20).

### Where the room cell's time goes (rate 6.2)

| | x | emulation worker CPU (ms per wall s) | CPU ms per guest s |
|---|---|---|---|
| solo, steady | 0.83-0.85 | 179 | 215 |
| pair of solos, steady (60-120 s runs) | 0.54-0.67 | 118-132 | 204-219 |
| room, steady (hb 25-60) | 0.41-0.51 | 98-122 | 212-244 |
| room, the gate's 20 s window | 0.26-0.39 | | |

- **Re-simulation: 0.** On this box the capacity gate moves every room to delay lockstep
  (delay 2-3) by frame 15-20, `resims 0` in every room cell.
- **Two consoles on one box (pair vs solo): -25 to -35%.** The worker gets 118-132 ms of
  CPU a second instead of 179. Same work per guest second.
- **Coupling (room vs pair, steady): -15 to -25%.** Work per guest second is the same as
  solo within the noise (212-244 vs 204-219 ms); the worker gets less CPU (98-122 ms/s),
  because a console parked on the gate (40-190 ms/s) cannot use its duty-cycle slices later.
  The room runs at the slower console's pace at each moment.
- **Start-up (window vs steady): -20 to -30%.** The room armed rollback at frame 0: the
  per-block rollback-mode refill held the first 8 frames for 9-13 s (`hb1 emu=6920`: one
  `run_iter` of 7 s), then the gate's switch to delay at frame 15-20 flushed again and the
  sharded refill (`refill after LEAVE: 30 frames 4.2-5.2 s`) fell inside the window.

⚠ An earlier reading of "+28% CPU per guest second in the room" used per-heartbeat means
over a window whose heartbeats were not all 1 s; time-weighted (`hbMs`) it is gone.

### Rollback-mode batch compile (rec_wasm.cpp `rbb_compile`, `?rbbatch=N`, 1 = control)

The design in dreamcast/docs/rollback/TASKS.md: a miss in rollback mode compiles its block
with its static successors (BFS over BranchBlock/NextBlock, up to 32) into ONE module, every
member registered before the miss's block runs. Bodies are the per-block bodies
(`build_blocks_unlinked`: no tail-link, no trace), so every edge still goes through the
verified lookup or the IC. A member with an FPU op is unconfirmed until its first entry
(`s_block_fcfg`: FPSCR PR/SZ/RM + SR.FD at decode); a mismatch discards it and the miss path
compiles it from live state, i.e. what per-block install does. Members come only from main
RAM, even pcs, MMU off, SR.FD clear, never 0x8c0000e0/0xac010000/0xac008300, and after a
pre-scan that rejects a branch in a delay slot (the decoder throws on it). A member that
will not register is dropped, never parked.

Measured with the new one-line `[rollback] refill after ARM: 30 frames N ms` (worker), room,
rate 1, load 3-7, ms for the first 30 frames after the arm:

| cap | runs | compiles / registered |
|---|---|---|
| 1 (per-block, control) | 1877, 1909, 2258, 1850 | 2484 / 2484 |
| 2 | 1439, 1739, 2078 | 1479 / 2824 |
| 4 | 1669, 1404 | 973 / 3403 |
| 8 | 1434, 1926 | 672 / 4194 |
| 32 (shipped) | 1737, 1810 | 402 / 7195 |

About -10 to -20%, inside a wide noise band. A CPU profile of the refill (per-block arm)
says why it is no more: `new WebAssembly.Module` is 13.8% of it, Instance 2.3%; the rest is
running the frames, the ring saves (`RamRegion::serialize` 8%) and GL program setup. At rate
6.2 the arm-to-first-heartbeat stall read 10.2 / 8.9 s batched vs 11.4 / 12.8 s per-block.
The 2.3x of the old note compared a per-block refill with a sharded one whose compiles are
DEFERRED (pending blocks span-interpret until a seal), so it was never mostly install cost.

Exact, wasm `aa0fbd55`: rollback rig REF1==REF2 61/61, REF==RB 59/59, 0 full-flush
fallbacks, 26 rollbacks; 1,101 batches / 20,346 members ahead / 128 FPU-config recompiles /
0 dropped / 0 rollback-mode parks. `--diag 8 --rbload` (cold vs warm cache): D1==D2==D3.

### The gated pump parks instead of spinning (`?lsspin=1` = control)

`pumpKick(1)` is "now" (`ms > 1` is the timer test), so after its 8 quick re-checks a pump
parked on the lockstep gate re-posted itself with no delay for as long as the gate held.
Room at rate 1, delay lockstep: host worker 530 ms of CPU a second with ~250 ms/s in
`run_iter` and ~300 ms/s on the gate (pair of solos: 190-200). Now it sleeps; the input that
un-parks it kicks the pump, any kick pre-empts the park, and a 100 ms timer is the backstop.
A joiner parked 624 ms/s now burns 141 ms/s. At rate 6.2 it moves nothing measurable
(room steady 0.455/0.464 vs 0.510/0.419 control): the duty cycle already caps the spin.

### A slow console declares a step estimate at Ready; the room starts in delay

The host's gate already starts a room in delay when a console declares an unaffordable
rollback step at Ready, but a Dreamcast console enters a room on a fresh page and declared
nothing, so every room started in rollback. dreamcast.html now declares 0.25 x the normalize
handshake's time (a fixed serialize + unserialize + flush every console does before frame 0:
74-118 ms on this box at full speed, 332-690 ms at rate 6.2). Measured frames replace it.
`?dcstepest=0` = the control. A room that starts in delay and is later moved to rollback arms
its ring at that frame, without entering rollback mode early (`rbArm enter:0`); the core
switches at the agreed frame as before. (Not reachable on this box: delay frames report no
step, so the estimate stands and the gate never sees calm.)

Room cell, rate 6.2, interleaved, load 9-18: estimate on **0.494 / 0.339**, control
**0.357 / 0.299**; first bench result 46-47 s after load vs 52-56 s. `&dcrb=0` (delay only)
read 0.403 / 0.390 against 0.363 / 0.347 in the same set.

### P1/P2 aliases (found by the Gauntlet soak)

The first Gauntlet forced-rollback soak with batching was a CORE CRASH at frame 42
(`os_DebugBreak` in `bm_AddBlock` from `compilePC`, pc 0x8c00d828; the per-block control was
IN SYNC). flycast's jump table is indexed by the physical address, ours by vaddr: a member
compiled at one view (0xac.. / 0x8c..) and a later miss at the other found the FPCA entry
claimed. Per-block install never compiles a view the guest did not run. Now a rollback-mode
miss whose other view holds the entry drops that entry first (`g_rbb_alias_drops`, ctx 157:
25 in a Gauntlet boot, 0 in the PSO lobby). Reproduced and fixed on
`rollback_measure.mjs --game gauntlet --warm 2 --rbload` (crashed at 4 s; now runs). That rig's
REF==RB on a Gauntlet boot diverges at f90-93 with batching ON and with the per-block control
alike (two control runs: f90, f93) — the known Gauntlet boot non-exactness, not this change.

### Verified, wasm `c0d7fe58` (hash-stable across every run)

- Rollback rig, PSO lobby: REF1==REF2 61/61, REF==RB 59/59, 0 full-flush fallbacks, 0
  rollback-mode parks, 1,101 batches / 20,346 members / 128 FPU-config recompiles.
  `--diag 8 --rbload`: D1==D2==D3 (cold vs warm cache byte-identical).
- Soaks (hermetic snapshot, owd 20+10): PSO lockstep IN SYNC 59 RAM + 59 fingerprints (the
  room started in delay 3 from the estimate); PSO forced rollback IN SYNC 33; Gauntlet
  forced rollback IN SYNC 32 (41 rollbacks); mixed PSO rollback room, joiner
  `rbbatch=1&lsspin=1&dcstepest=0`, IN SYNC 33; the same mixed room on Gauntlet IN SYNC 31.
- Boot probe 0.999x; `verify_core_tree` PASS.

Toaster gate, `tools/toaster_bench.mjs --pages dreamcast --rate 6.2 --reps 2 --ladder 0`
(load 4.9 at start, 16-19 during): solo **0.790 / 0.838**, room **0.348 / 0.388** (delay 2,
in sync). Before (84811cd): solo 0.813 / 0.840, room 0.287 / 0.303; the same bench at 10:30
today read room 0.277 / 0.223. Still 0/2 PASS.

## 2026-10-15 (later) — the room toaster as two devices (`dreamcast/tools/toaster_room2.mjs`)

The gate's room cell runs both players in one browser under one duty cycle, so they take
each other's on-slices. The new rig gives each player its own browser and its own device:
- **cpuset**: the whole process tree is pinned, player A to cpus 0-1 and B to 2-3.
- **per-thread quota**: every renderer thread gets its own cpu cgroup at 1/6.2 of a core,
  the duty cycle's per-thread slowdown. GPU/browser processes are not slowed, as before.
- The signalling is the shipped one (MQTT broker + WebRTC), as in room_desync_soak.

Proof before every run (BenchmarkIndex in a worker of each browser, a run is VOID without it):

| run | slowdown A / B (want 6.2 +-25%) | together/alone A / B (want ~1) | cpus allowed (all threads) |
|---|---|---|---|
| pair | 6.63 / 6.12 | 1.079 / 1.036 | 0-1 / 2-3 |
| room | 6.94 / 6.64 | 1.053 / 1.016 | 0-1 / 2-3 |
| room | 6.99 / 6.66 | 1.024 / 1.000 | 0-1 / 2-3 |

The throttled share was 1211-1223 of 1317-1369 cgroup periods. One earlier room run was
VOID: 7.54x on a 1 s free score; the free score is now a median of 5 x 2 s.

Rate 6.2, 20-heartbeat window (lib/bench.js's rule), load 0.4-3.2:

| cell | x (A or host / B or joiner) |
|---|---|
| solo | 0.844 (bench), 0.796, 0.789 |
| pair of solos | 0.731 / 0.753 (bench) |
| room (delay 2, in sync) | 0.819 / 0.825, 0.825 / 0.824, 0.819 / 0.822, 0.696 / 0.706 |

**On two real-shaped devices, the room runs at solo speed.** On one shared box it read
0.35-0.39x; the gap came from sharing a box, not from rooms. The steady coupling term is now
inside the noise (gate wait 0-100 ms/s). Every room started in delay through the step estimate
(87-92 ms declared).

### The up-switch, exercised (`?dcstepfake=HI,LO,F`, test arm)

A console with the arm declares HI ms at Ready and reports LO from frame F on, whatever it
measured. That makes a room that started in delay get moved up to rollback by the host's gate.
PSO soak (hermetic snapshot, owd 20+10, `dcstepfake=200,1,300` on both):
- The room started in delay, and both consoles logged "moved to ROLLBACK at frame 651".
- Each armed its ring held (`enter:0`) and entered rollback mode at frame 651. The refill
  after ENTER was 1.2-1.5 s with batching.
- 25 / 30 rollbacks, depth 4. **IN SYNC** over 34 RAM checkpoints and 34 fingerprints.
- The same room with the joiner on `dcrbbroken=1` **DESYNCs** (first RAM mismatch at f1380),
  so the detectors work across the switch.

### Lockstep coupling on the two-device toaster: not measurable

Three interleaved room/solo pairs, `toaster_room2.mjs`, rate 6.2, 40 s, load 2-5. Every
proof passed.

| pair | room host / joiner, window | solo, window (bench) | room steady | solo steady |
|---|---|---|---|---|
| 1 | 0.829 / 0.827 | 0.799 (0.815) | 0.891 / 0.883 | 0.823 |
| 2 | 0.710 / 0.709 | 0.818 (0.874) | 0.833 / 0.827 | 0.916 |
| 3 | 0.782 / 0.779 | 0.814 (0.821) | 0.815 / 0.815 | 0.818 |

Means: window room 0.773 vs solo 0.810 (-5%); steady room 0.844 vs solo 0.852 (-1%). The run
to run spread of each arm is 0.71-0.83 and 0.82-0.92. Gate wait in the room is 1-49 ms/s.
The -15 to -25% "coupling" measured on one shared box was the two consoles competing for one
duty-cycled CPU, not the lockstep. There is no coupling lever to take: on two devices a
toaster room runs at solo speed. What keeps both short of 1.000x is the solo work itself
(~2.2x over budget at 6.2, the levers above).

## 2026-10-15 (later) — PSO's G2 sound-RAM read in closed form (?g2ff=0 control)

Re-profiled at rate 6.2 after pswff, bench scene (`toaster_split.mjs 6.2 120 '&pchist=50,60'`):
82.2% of guest time is burnt (idle-skip 68.8%, pswff 13.5%). The executed rest is flat,
except one family: the Shinobi G2-safe copy at 0x8c37af50 and its helpers (0x8c37a8b8-
0x8c37b4d8), ~10% of host self time (15% inclusive) in a `?jitnames=1` profile.

A census of its entries (bench scene, 30 guest s): 399,156 calls (13.3K a guest second).
341,620 from 0x8c352d70 and 50,344 from 0x8c352c9c are ONE-WORD reads of sound RAM (size 4,
count 1, sel 0/0). 0x8c352d40/0x8c352c6c are the sound manager's read32 helpers. They read
hundreds of different words once a frame each (the driver's state), so this is work, not a
poll. Each call masks interrupts, suspends the 4 G2 DMA channels (4 SB_xxSUSP stores),
waits for the G2 FIFO twice (SB_FFST, always 0 here), copies one word, resumes the channels
and restores SR: 64 block entries and 623 guest cycles to move 4 bytes.

`g2ff_try` (rec_wasm.cpp) applies the whole call at its entry for that shape. The end state
is closed-form: R0-R7, SR (IMASK restored, T=1), `old_sr` and SRdecode, as the last ldc
leaves them; the 14 stack words the call leaves below R15; [0x8c5783f4]=0; the two FIFO-wait
counters [P+0x10c]/[P+0x110] +1; [dst]; SUSP bit 0 clear. Guards: no tick inside (the gwff
closed form over the 64 learned block cycles), no interrupt pending before or after, no
bank change, every block of the path compiled and live (cached by IC generation + a table
epoch that rb_discard_slot bumps), code and literal pools byte-identical to a golden copy
(the pools are marked in the SMC map so a write drops the cache), and the stack frame,
the struct, [0x8c5783f4] and dst disjoint. Anything else runs the real call (~15% of calls:
a tick falls inside). The entry is unchained in every arm, so `?g2ff=0` compiles the same
code and differs only in the apply.

- `?g2ff=2` (DIAG) predicts, applies nothing, and compares R0-R15, PR, MAC, SR, old_sr, T,
  cycle counter, sched_next, the 18 written words and the 4 SUSP registers at the return:
  **720,897 predictions, 0 mismatches** (bench scene, 60 s).
- Rate 1, bench scene, emu ms per guest second (last 30 heartbeats), 3 interleaved pairs,
  load 2.2-5.0, wasm `3cc30f83`: on 329.4 / 337.0 / 353.5, off 356.5 / 365.6 / 372.6.
  Mean **340.0 vs 364.9, -6.8%**; every pair favours on.
- Toaster 6.2 solo (`toaster_bench.mjs --rate 6.2 --reps 2 --ladder 0 --room 0`), load during
  the reps in brackets: on 0.700 / 0.756 (13.9 / 12.5), off 0.667 / 0.625 (6.2 / 6.8),
  on 0.708 / 0.672 (8.3 / 9.3). The on arm is ahead in all four, inside the bench's noise,
  and this box read lower today than 84811cd's 0.79-0.84 for both arms. Still 0/2 PASS.

Exactness, wasm `3cc30f83`:
- Rollback rig, PSO lobby: REF1==REF2 61/61, REF==RB 59/59, 0 full-flush fallbacks; g2ff
  applied 262K calls inside the run (`--echo g2ff`).
- Soaks (hermetic snapshot, owd 20+10), all IN SYNC: PSO lockstep 37 RAM + 37 fingerprints;
  PSO forced rollback 32; Gauntlet forced rollback 29 RAM + 32 fingerprints; mixed PSO
  rollback room with the joiner on `?g2ff=0`, 33 + 33 (42 / 40 rollbacks).
- Boots with screenshots: PSO lobby (guest 0.995x), Gauntlet intro (0.996x).
  `verify_core_tree` PASS (only bridge files changed).

### What the toaster has left, ranked (rate 1, bench scene, ~340 ms per guest second)

- **ARM7: 84-96 ms per guest second (`?armtime=1`), ~26%.** The driver's main loop at 0x194
  polls the SH4 command queue (0x2100), pops its own queue four times (0x1cec / 0xd60), and
  updates ONE channel's status per pass round-robin (0x93c: MSLC = counter, then reads the
  monitor registers 0x2810/0x2814). With the queues empty that pass is ~30 one-instruction
  `bl` / return blocks, ~4 passes a sample. 0x1cec alone is 26% of ARM cycles.
- SH4 emitted code: flat over ~2000 pcs.
- Dispatch / scheduler ~15%, AICA C ~9%, JS ~11% (GL record/post on the worker).
- Gauntlet is not the same problem: its attract is a video decode (0x8c111xxx byte loops +
  ftrv, 94% of guest time executed, 6.3% burnt). It costs 850-900 ms per guest second at
  rate 1 and runs 0.13-0.5x at rate 6.2: ~6x short, not 1.2x.

## 2026-10-15 (later) — the ARM7 driver loop run block by block in C (?armff=0 control)

PSO's driver loop (0x194..0x1e0, read in place from sound RAM): each pass bumps the
monitored channel and writes MSLC (0xac0), checks the SH4->ARM queue (0x2100), pops its own
queue four times (0x1cec / 0xd60), updates one channel from the monitor registers (0x93c,
groups A/B/C by [0x12060]/[0x12061] = 2/54 here), and checks two flags (0x1c0 / 0x1d8). The
learned decode cycles put a pass at ~840 cycles, so it is NOT a few passes a sample: a
sample's 512 cycles end mid-pass. So whole-pass fast-forward never fits; `armff_go`
(arm7_rec_wasm.cpp) runs those 27 blocks in C instead, from whatever pc the ARM is at,
exactly as the mainloop would: cycles > 0 and no FIQ before each block, the block's decode
cycles (+9 for the MLA FALLBACK, r15 = its pc + 8), every input modelled (both branch
outcomes, conditional ops, flags as the emitter computes them, incl. C from >255
immediates), accesses through the same arm::readMem/writeMem in program order (MSLC write,
0x2810 read that clears the loop flag, 0x2814 read). It stops at the first pc outside the
set (full queue, set flag, active channel) and runs only while EntryPoints holds the block
compiled from the golden bytes (live mask cached by a compile/flush epoch). Gauntlet's
driver is different: it never fires there.

- `?armff=2` DIAG: every 64th entry serializes the AICA (ARM regs, sound RAM, AICA regs,
  channels), runs the blocks in C, serializes, restores, lets the compiled blocks run the
  same number of blocks and compares byte for byte: **16,385 (bench scene) and 21,505 (PSO
  lobby) checks, 0 mismatches, 0 lost**.
- ~400K of the ARM's ~600K blocks a guest second now run in C.
- In-run A/B (new `toaster_split.mjs --ab NAME:SECS`: toggles the knob in the worker every
  SECS s and reports emu ms per guest second per arm; run-to-run pairs read +-8% here):
  rate 6.2, 200 s: armff 1058.7 vs 1104.4 (**-4.1%**); g2ff 1051.1 vs 1150.4 (**-8.6%**).
  Rate 1: armff 284.4 vs 287.8 (-1.2%), g2ff 299.3 vs 310.5 (-3.6%). The duty cycle makes
  both worth more at the toaster rate than at rate 1.
- Toaster 6.2 solo, 2 reps each, load during the reps in brackets: both on 0.901 / 0.925
  (4.5 / 9.5), armff=0 0.793 / 0.783 (5.1 / 5.4), both off 0.701 / 0.753 (5.9 / 6.6), both
  on again 0.736 / 0.797 (9.1 / 7.1). Still 0/2 PASS.

Exactness, wasm `e8316176`: rollback rig (PSO lobby, armff applied 1.8M runs inside it)
REF1==REF2 61/61, REF==RB 59/59, 0 full-flush fallbacks. Soaks IN SYNC: PSO lockstep 64 + 64,
PSO forced rollback 33, Gauntlet forced rollback 29 + 32, mixed PSO rollback room with the
joiner on `?armff=0` 33 + 33 (40 / 43 rollbacks). Boots with screenshots: PSO lobby 0.997x,
Gauntlet intro 1.009x. `verify_core_tree` PASS.

## 2026-10-15 (later) — four more candidates, each measured in-run and null

All with `toaster_split.mjs 6.2 200 '' --ab KNOB:8` (the knob toggled in the worker every
8 s; the noise floor of this rig is ~1-1.5%), base = g2ff + armff (wasm `e8316176`). None was kept.

| candidate | on | off | verdict |
|---|---|---|---|
| b2ff: the G2 bulk copy 0x8c37b2c4 K words at a time (DIAG 16,605 / 0 bad; ~74 words a fast-forward, sound-RAM destination) | 1044.7 | 1045.3 | null |
| iskloop: the idle-skip burn + credit sequence looped inside the trampoline | 1065.8 | 1052.5 | null (dispatcher overhead is not where idle time goes) |
| GL recorder: drop redundant activeTexture/bindTexture (glsm re-applies ~130 a frame; 52K of 50-150 ops a post) | busy 1097.9 | 1094.4 | null |
| pswff head check from 3 literals instead of ~36 ReadMem16 (DIAG 262K / 0 bad) | 1043.2 | 1048.8 | -0.5%, inside the noise |

Also seen: the lazy disc's async readahead never completes in the bench (`readahead=0` in
[lazydisc]); misses (~0.2/s) inflate synchronously in JS. Small at steady state.

Where the toaster stands (bench scene, rate 6.2): ~1045 ms of emulation per guest second,
x = 0.90-0.93 over 200 s windows; the 20 s gate cell reads 0.74-0.93 run to run on this box.
1.000x needs ~950: about 10% more. The remaining split is flat: SH4 emitted code ~46% over
~2000 pcs, dispatch/scheduler ~15%, AICA/ARM per sample ~12% (armff_go itself 4.5%), JS ~11%.
Gauntlet's attract is a video decode at 94% executed guest time: ~6x short at 6.2.

## Status

- [x] Split measured: solo at 1 and 6.2, room at 6.2 for 60 s, and a worker
      CPU profile.
- [ ] **BLOCKED on a core rebuild** (Flycast upstream checkout + build tree).
      That is the user's call to grant.
- [ ] After that, lever 1 then lever 2, each measured on `tools/toaster_bench.mjs`,
      kept IN SYNC on `room_desync_soak.mjs`, and confirmed by screenshot.

## 2026-10-15 (later) — SH4 emitter: executed-op census, and deferred first-use register loads (?sh4lazy=0 control)

**Census** (`?jitcensus=1`, DIAG; `toaster_split.mjs --census F`): static ops per function weighted
by per-function entry counters. Unconditional wasm ops per guest SH4 instruction: Gauntlet attract
12.6 (+24.0 inside if-arms), PSO lobby 13.0 (+22.7); ~10 guest instructions per block entry.
Ctx (guest register / pc / cycle) loads + stores are ~1.7 per instruction.

**Instruction-level truth** (`perf record -e cpu-clock` + V8 `--perf-prof`, `perf inject --jit`;
the box has no PMU, so cpu-clock sampling). Gauntlet attract, worker samples: emitted code 64%,
all of it TurboFan (Liftoff 0.05%). Emitted-code samples by x86 instruction: **stack spill
loads+stores 12.7%**, ctx loads 4.9% / stores 6.5%, guest RAM 6.3%, globals 7.8%, branches 7.9%.
The eager prologue kept every cached register live across the whole block, and TurboFan spilled
them. (SwiftShader rasterizer threads take ~56% of the box's CPU in that run.)

**Shipped: deferred first-use loads** (`wasm_emit.cpp computeDeferAt`, `?sh4lazy=0` = control).
A read-first register is loaded right before the first op that names it. That point is
top level in the oplist, never inside an emitter's if-arm. Exit-only registers keep the
prologue load. Off for self-loops, traces and the memset path. Exact, wasm `ad2e6aff`:
- rollback rig REF1==REF2 61/61, REF==RB 59/59;
- PSO lockstep soak IN SYNC (52 RAM checkpoints + 52 fingerprints);
- mixed Gauntlet forced-rollback room, joiner `?sh4lazy=0`, IN SYNC (32 + 32);
- boot 1.000x.

The -4.4% first reported for it (Gauntlet attract) was rig bias, see below. On the fixed rig,
PSO lobby: **561.0 vs 562.5, null**.

### ⚠ The in-run A/B was biased (fixed 2026-10-15)

`toaster_split --ab` counted the FIRST arm window. That window follows the cold start (boot,
state load, first compile), not a flush from the other arm. Placebo runs (`--ab NAME:SECS:1:1`:
the same value in both arms, the same flushes) read the first arm slow:
- PSO lobby: +4.5%;
- Gauntlet attract: +8.5%.

That window is now discarded, and the PSO placebo reads +1.2%. Gauntlet's **cold-boot attract
cannot carry an in-run A/B at all**: it is a fixed sequence, so arms land on the same scenes
every run (placebo +14% after the fix).

For Gauntlet, use `dreamcast/states/gauntlet_level1_wizard.state`, gameplay in level 1 made by
`gauntlet_p2_probe.mjs --savestate --statefile`. Add `--abreload`, which re-loads the state at
every switch: the idle level times out to the title after a few minutes. Placebo there: +2.0%.
**The rig's floor is about ±2%.**

Fixed-rig numbers:

| knob | scene | on | off | placebo, same scene | verdict |
|---|---|---|---|---|---|
| sh4lazy | PSO lobby, rate 1 | 561.0 | 562.5 | +1.2% | null, kept (exact) |
| sh4smcbr: branch-guarded SMC generation bump | PSO lobby | 581.2 | 574.2 | +1.2% | null, OFF |
| sh4plink: per-arm cond-exit sibling link | PSO lobby | 509.9 | 500.9 | +1.2% | null, OFF |
| divinline | Gauntlet level, reload | 478.0 | 476.3 | +2.0% | null |
| g2ff | bench, rate 6.2, 8 s arms | 961.4 | 1021.5 | -3.0% (957.1 / 986.6) | ~-3%, kept |
| armff | bench, rate 6.2 | 956.1 | 1009.2 | -3.0% | ~-2%, kept |

`?sh4early=1` (store a register at its last definition) is unpriced: its one A/B was the biased
Gauntlet attract. Shipped OFF.

**Shipped OFF, measured only on the biased Gauntlet-attract rig (unpriced):**
- `?sh4sb=1`: loop superblocks over guest code. The planner now searches both arms of a
  conditional and decodes members that are not in the shard batch (`trace_decode`). 886.9 vs 880.4.
  The old LEVER-12 planner never formed the hot poll loop (0x8c05c952→960→986): it follows the
  fall-through arm, and its members span shards.
- `?sh4frm=1`: FR registers in f32 locals through fmov.s loads/stores and int<->FR moves.
  899.1 vs 877.3 (12 s arms) and 805.8 vs 794.7 (30 s arms).
- A node micro-bench prices a block hop at ~2.4 ns (direct return_call) vs ~3.7 ns (indirect,
  cross-instance), so hop transport itself is small.

## 2026-10-15 (later) — the toaster gate now throttles the GPU process too

Until now `tools/toaster_duty.py` duty-cycled only `--type=renderer` processes. Chrome's GPU
process runs SwiftShader on the host CPU, so on a no-GPU toaster the rasterizer ran at full
speed while the emulation was slowed 6.2x. Now it is stopped and continued in the same cycle
(`gpu=1`, the default; `toaster_bench --gputhrottle 0` / `toaster_split --gpuoff` /
`toaster_room2 --gpuoff` = the old arm). `toaster_room2` puts the GPU process in ONE cgroup
with a quota of CORES/R cores (a per-thread 1/R cap let SwiftShader's parallel threads take
4/R: raster slowed only 3.49x).

Arm-difference proof (new `RASTER_SRC`: a fragment-bound 640x480 WebGL2 loop, one
triangle and a 1-pixel readPixels a frame, so the score is the rasterizer's throughput).
`toaster_bench --rate 6.2 --proof-only`, load 1.9:

| context | rate 1 | rate 6.2, GPU throttled | rate 6.2, GPU NOT throttled | slowdown |
|---|---|---|---|---|
| raster (frames / 10 s) | 615 | 96 | 459 | **6.41x** vs 1.34x (arm difference 4.78x) |
| page / worker / nested / SW (BenchmarkIndex) | 2106 / 2110 / 2093 / 1988 | 290 / 269 / 347 / 359 | | 7.26 / 7.84 / 6.04 / 5.54 |

The bench VOIDs the run unless raster slows >= 0.5 R AND the arm difference is >= 1.5x.
`toaster_room2 solo`: raster 371 free -> 54 under quota (6.87x), BenchmarkIndex 6.36x.

### What the GPU throttle shows (rate 6.2, PSO bench scene, `toaster_split`, load 4-9)

| arm | x (last 20-40 hb) | emu per guest s | pictures drawn/s | GPU process CPU (ms per wall s) |
|---|---|---|---|---|
| GPU throttled (the honest arm) | 0.62-0.69 | 1387-1529 | 2.9-3.2 | 478 |
| GPU NOT throttled (old arm) | 0.937-0.944 | 993-997 | 7.6-9.1 | 1233 |

No `__sync` call waits on the render worker in steady state (`?glsyncstat=1`, new DIAG: 0 a
second), so the extra emulation time is CPU contention: in each on-slice SwiftShader's four
raster threads (~93 ms/s each, the whole slice) run on the same four cores as the SH4.
Gauntlet level state (`--state ... &benchgame=gauntlet`), same pair: x 0.237 vs 0.277.

## 2026-10-15 (later) — LOW-RENDER on software rasterizers (`?lowrender=0` control)

**What flycast renders now.** `?glsizes=1` (new DIAG, prints each distinct render-target /
viewport / blit size and texture parameter once): one 640x480 RGBA texture + a 640x480
DEPTH24_STENCIL8 renderbuffer (the postprocess target), viewport 640x480 — the console's own
resolution, no upscale (`RenderResolution` 480 = option.cpp's default; the bridge answers no
core option). Anisotropy 1, no mipmap filters (MIN/MAG LINEAR or NEAREST only), and the
present on ANGLE/SwiftShader is `gl.bogusBlitFramebuffer`'s route: viewport(0,0,w,h) + one quad.

**Where SwiftShader's time goes**, rate 1, PSO bench scene, 30 pictures/s every arm, GPU
process CPU from /proc (one run each):

| arm | GPU process ms/s | emu ms per guest s |
|---|---|---|
| core defaults (`lowrender=0`) | 3271 (~109 ms a picture) | 227 |
| 320x240 + nearest + fog off + per-strip sort | 1609 | 159 |
| same, game's filtering | 1658 | 158 |
| same, fog on | 1813 | 160 |
| same, per-TRIANGLE sort (the default) | **1262** | 154 |
| same, 640x480 | 2707 | 167 |
| same, 160x120 | 1284 | 156 |
| canvas shown at 64x48 / hidden (compositor) | 1304 / 1272 | |

Per-strip sorting costs MORE raster than the default per-triangle sort here, so it is not
used. Below 320x240 nothing is left to gain: ~40 ms a picture is fixed (not the page
compositor — hiding the canvas moves nothing), most likely per-draw/per-pass work in
SwiftShader's threads.

**Shipped.** `lib/capability.js softwareGL()` (renderer names SwiftShader / llvmpipe /
softpipe / lavapipe / WARP, or the browser refuses `failIfMajorPerformanceCaveat:true` — a
measured refusal, not a property read; 4 new self-test assertions, `?captest=1` 241/241 under
SwiftShader). On such a device dreamcast.html sends `{res: 240, filter: 1, fog: 0}`
(`flycast_set_render_res / _tex_filter / _fog`, new core setters in libretro.cpp next to
`flycast_set_fog`). The window follows the picture: the worker resizes the drawing buffer to
the frame the core presents (`sizeWrap`, both the recorder and the direct path), and the page's
640x480 CSS box scales it (`image-rendering: pixelated`). `?lowrender=0` = off, `=1` = on
anywhere, `?lrres= / lrfilter= / lrsort= / lrfog=` one knob.

**Exact — rendering never reaches guest state** (wasm `26d01864`):
- `?aicahash=1&noshard=1`, bench scene, lowrender 1 vs 0: **42/42 windows identical**
  (audio, whole AICA state, SH4 RAM).
- Rollback rig with `--query '&lowrender=1'` (PSO lobby): REF1==REF2 61/61, REF==RB 59/59,
  0 full-flush fallbacks, 26 rollbacks.
- Mixed rooms, host `lowrender=1`, joiner `lowrender=0` (snapshot server, owd 20+10): PSO
  lockstep IN SYNC 80 RAM + 80 fingerprints (138 guest s); PSO forced rollback IN SYNC 32 + 32
  (32 / 58 rollbacks); Gauntlet IN SYNC 29 RAM + 32 fingerprints (the gate held this one in
  delay lockstep, delay 7: no rollback ran). Screenshots: host 320x240, joiner 640x480, same frame.

**Measured, in-run A/B** (`toaster_split --ab fn.__dcLowRenderAB:SECS`, the whole lever
toggled in the worker; new `fn.` form and `--abskip`), GPU throttled, emu ms per guest s:

| scene | on | off | placebo (same value both arms) |
|---|---|---|---|
| PSO bench, rate 6.2, 8 s arms | 1048.6 (x 0.880) | 1197.0 (x 0.793) | 958.8 / 967.0 (-0.8%) |
| Gauntlet level, rate 6.2, 30 s arms, `--abreload --abskip 6` | 4013.3 (x 0.241) | 4192.8 (x 0.230) | 4310.2 / 4380.0 (-1.6%) |

PSO: **-12.4%** against a -0.8% placebo. Gauntlet: -4.3% against -1.6%, inside the floor —
its level runs ~4 s of emulation per guest second at 6.2 and draws 1-2 pictures a second, so
the picture is not its problem.

**Toaster gate** (`toaster_bench --pages dreamcast --rate 6.2 --reps 2 --ladder 0 --room 0`, GPU
throttled, raster proof 5.95-6.66x / arm difference 4.57-6.03x; `--qs lowrender=0` = off;
two interleaved on/off pairs, load 2-11):

| arm | solo speed (reps) |
|---|---|
| low-render (auto: SwiftShader detected) | 0.672, 0.806, 0.827 (one rep: no window — boot passed the bench's 4-min wait) |
| `lowrender=0` | 0.614, 0.611, 0.663, 0.683 |

Mean 0.768 vs 0.643. Still 0/7 PASS. The 4-min boot miss is new with the GPU throttled (twice
in ~20 runs, also seen with `lowrender=0`): a slow device's boot now pays for its rasterizer too.

**room2** (`toaster_room2 room 6.2 40`, GPU in one CORES/R cgroup, raster 6.07-6.65x):
on 0.936 / 0.945 (steady 0.984 / 0.983); `&lowrender=0` 0.973 / 0.970 (steady 0.976 / 0.976).
Null — the room starts on PSO's title, which draws little. One earlier "on" room2 run never
started (the host never reached Allow); the retry ran.

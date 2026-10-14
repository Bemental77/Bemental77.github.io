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

## Status

- [x] Split measured: solo at 1 and 6.2, room at 6.2 for 60 s, and a worker
      CPU profile.
- [ ] **BLOCKED on a core rebuild** (Flycast upstream checkout + build tree).
      That is the user's call to grant.
- [ ] After that, lever 1 then lever 2, each measured on `tools/toaster_bench.mjs`,
      kept IN SYNC on `room_desync_soak.mjs`, and confirmed by screenshot.

# Dreamcast rooms: do two real browsers stay in sync? (measured 2026-10-01)

## Answer

- **A shipped PSO room did not desync. It died.** Every shipped PSO room wrote
  Player 2's 128 KB memory card into **freed wasm heap** at frame 240. In three
  real two-browser rooms on the shipped page, both consoles then died at the
  same moment, after the engine had compared fingerprints with no mismatch:
  - one room threw `memory access out of bounds` at frame ~326;
  - the other two froze, at frames 242 and 340.

  The same seed and the same walk ran 60 guest seconds clean **solo**. Fixed in
  `flycast_worker.js` + `dreamcast.html` (§2).
- **With that fixed, the canonical room is IN SYNC.** Two Chrome processes, the
  shipped signalling and the shipped seed-at-frame-0 path, a 3D scene, and both
  players pressing:
  - zero engine desyncs;
  - zero mismatches of a full 16 MB guest-RAM hash taken at every fingerprint
    frame on both peers.

  The proof run, on the final files, had 105 checkpoints over frames 0-6240,
  ≥ 202.6 guest seconds, and 118 input steps. Five other canonical rooms forked
  0 times; their ends were environmental. Details in §3.
- **The idle-skip streak cannot fork a canonical room.** Every peer anchors on a
  fresh worker, so its streak is 0. The streak *does* fork a room the moment a
  peer has history: the CONTROL arm (§4) gives one peer 10 frames before the
  seed, and the room desyncs **at frame 0**.
- **Turning idle-skip off does NOT fix that.** It was the proposed lever. The
  same history with idle-skip off on **both** peers still desyncs at frame 0
  (fingerprint `cycle_counter` 301 vs 268, guest RAM differs in the second 4 MB).

  At least one other carrier that no savestate holds is in play. It is NOT
  isolated. The source-read candidate is libretro's `first_run`
  (`libretro.cpp:176`), which makes `retro_unserialize` skip
  `emu.stop()/emu.start()` on a worker that has never run a frame
  (`libretro.cpp:2447-2460`). If that is the carrier, the same seed load takes
  a different path depending on history.
- **The fix is an anchor guard.** Every worker counts every retro_run it ever
  performs. On the first frame a lockstep anchor runs, a worker that has run
  anything **refuses the frame** instead of forking the room, and names why.

  Cost: one integer compare per anchor, and one JS call per frame. On this
  machine, with history: the joiner refused, the host passed, and nothing
  forked (§4). In a matched solo pair the final page was not slower than the
  shipped one (shipped/final capacity 0.969, 0.960). Idle-skip off would have
  cost 17-22% (§5).

## The rig: `dreamcast/tools/room_desync_soak.mjs`

The rig drives a real room:
- **Players:** two Chrome **processes**, each with its own profile.
- **Room entry:** the shipped hand-off URL (`?np=CODE&game=pso2[&join=1]`). The
  host presses the real Allow button.
- **Signalling:** the shipped `?signal=ws` path through
  `tools/mqtt_ws_broker.mjs`.
- **Transport:** a WebRTC DataChannel.
- **Seed:** the shipped seed-before-frame-0 path. The only fixture is the seed
  *content*: the hermetic snapshot's `dreamcast/states/pso2_boot.state` is
  `pso2_pioneer2_lobby.state` (27,652,485 B, md5 `715715b4…`), so frame 0 is the
  3D Pioneer 2 lobby.
- **Input:** both players press keys. Host walks/acts on port 0, joiner on
  port 1, seeded-random but reproducible. The script is keyed to the HOST
  ENGINE'S FRAME NUMBER read on the page; PSO renders at 30/s.
- **Two detectors:**
  1. The product's fingerprint compare: `lib/netplay.js` Lockstep `desync` /
     `hashesCompared`.
  2. A hash of all 16 MB of guest main RAM, taken inside each worker at the
     same clean asyncify boundary as the product's own `lsHash`. RAM is located
     in the wasm heap by content and verified word-for-word against
     `_sh4_mem_read32`, then re-verified on 64 random words at every hash. It
     never calls `_emscripten_save_state`, because `retro_serialize` does
     `emu.stop()/start()` and would perturb the run.
- **Verdicts:** IN SYNC, DESYNC, REFUSED, CORE CRASH, FROZEN, or VOID. A fork
  needs no minimum sample; "in sync" needs ≥10 checkpoints on both detectors.
- `--preroll N` is the CONTROL lever. The joiner's worker runs N real frames
  from the seed (with idle-skip on) before the page's own frame-0 seed load.
- `--save-at S` and `--load-at S` make the host press Save or Load State
  mid-room.

```bash
node tools/browser_leak_guard.js reap && uptime
# hermetic snapshot: git archive HEAD (dreamcast.html lib coi-serviceworker.js
#   dreamcast/flycast_libretro dreamcast/audio-worklet.js dreamcast/states) into
#   a scratch root, symlink dreamcast/discs, then swap in the seed you want.
WEB_ROOT=<snapshot> PORT=18804 node tools/devserver.mjs &
CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  node dreamcast/tools/room_desync_soak.mjs --url http://localhost:18804 --game pso2 \
       --soak 240 --query '&nogate=1' --name F-canon             # canonical
  ... --soak 120 --preroll 10 --query '&nogate=1' --name ctrl     # control: history on one peer
# -> /tmp/dc-soak/<name>.log / .json / -host-*.png / -joiner-*.png
```

⚠ `&nogate=1` is needed only because of this box. At load 25-47 the capability
layer's Web Worker probe timed out ("worker did not respond within 3000 ms"),
and the page refused to boot one peer. That is a false negative of
`lib/capability.js` on a CPU-starved device. It is recorded here, not fixed
here.

⚠ Do not poll the emulator worker over CDP during a soak. A
`Runtime.evaluate` every 100 ms took a solo core from 0.69x to 0.16x. The
rig only enters the worker to install its hook and to collect.

## 1. Arms and results

| run | page | arm | result |
|---|---|---|---|
| smoke1 | shipped (`aba14d48`) | canonical, RAM hook | both consoles crashed at frame ~326: `memory access out of bounds` in `emscripten_builtin_malloc ← operator new ← WasmDynarec::compile`, same `sh4_pc=0x8c122b52` on both; 6 fingerprints compared, 0 mismatches |
| nohook1 | shipped | canonical, NO rig hook | both froze at frame 242 (the host worker stopped answering); 4 compared, 0 mismatches |
| solowalk1 | shipped | SOLO, same seed + walk | 60.5 guest s, 40 steps, no crash, no rewind |
| B-canon1 | VMU fix | canonical | **IN SYNC**: 103 RAM checkpoints + 103 engine fingerprints, 0 mismatches, frames 0-6120, **202.9 guest s** (by the guest cycle counter), 116 input steps; idle-skip active throughout (burns 401 → 6,384,393) |
| B-preroll1 | VMU fix | joiner 10 frames of history | **DESYNC at frame 0** (engine) |
| B-preroll-isk0 | VMU fix | same history, then idle-skip OFF on both before frame 0 | **DESYNC at frame 0**: engine on both; RAM hash differs at f0; `cycle_counter` 301 vs 268, `spc` differs |
| C-preroll-guard | + anchor guard | same history | **REFUSED**: the joiner was stopped at frame 0 ("already ran 10 frame(s) (8275 idle-skip slices)"); the host logged `anchor frame 0: this worker has run no frame before it`; no desync |
| F-canon | final (pre-wording) | canonical | **IN SYNC** over 58 RAM checkpoints + 58 fingerprints to frame 3420 (112.8 guest s). Then the JOINER's core threw `RendererException "OpenGL shader compilation failed"` at load 66 (host-GL failure, see §6), and the room ended |
| G-canon | final (`75eb95ec` page, `580c139d` worker) | canonical | **IN SYNC** over 78 RAM checkpoints + 78 fingerprints to frame 4620 (**152.9 guest s**), 91 input steps. Both pages logged `anchor frame 0: this worker has run no frame before it`. The engine then went to state `failed` on both at wall 1540 s, with load peaking at 64. That run did not capture the reason; the rig now records `report().error`. The engine's other `failed` causes are listed in `lib/netplay.js` `fail()`; a no-input stall past its budget is the unverified suspect. It was NOT a desync: `desync` was null on both |
| A-ctrl | shipped | canonical, current rig | **FROZEN at frame 340 on both** after `[vmu] port 1: re-installed 131072 B at frame 240`; both workers "stopped reporting entirely"; 6 fingerprints compared, 0 mismatches |
| G-canon2 | final | canonical | **IN SYNC** over 38 RAM checkpoints + 38 fingerprints to frame 2220 (72.7 guest s). Then the JOINER again threw the same `RendererException` (load 50), and the room ended |
| **G-canon3** | **final** (`75eb95ec` page, `580c139d` worker) | canonical | **IN SYNC: 105 RAM checkpoints + 105 engine fingerprints, 0 mismatches, frames 0-6240, 202.6 guest s by frames (206.9 by the guest cycle counter), 118 input steps from both players, 0 page errors.** Idle-skip active throughout (burns 401 → 6,429,822). Both peers logged a clean anchor. Load 10-34. Midway the HOST's WebGL context was lost (the page's own `GPU CONTEXT LOST` banner; black canvas), and its emulation kept running **in sync** to the end |
| G-save, G-save2 | final | host Save State mid-room | VOID: the room never got past frame 10 (`engine state failed` about 19 s after the gate engaged, load 33-43, delay chosen 9-12 frames). The rig did not yet record the reason |
| G-save3 | final | host presses **Save State** at guest 22.3 s and **Load State** at 46.0 s | **IN SYNC** over 41 RAM checkpoints + 41 fingerprints to frame 2400 (78.2 guest s). The save really ran (`[page] state saved 27652485 B`), so a one-sided Save did not fork the room in this run. Load was refused by the page: `Load State is off while you are in a room…` |

The wasm was the same `eec9ff8ccc0f2036d1d9435f7e2f84a6` in every run.

The served page, worker, emcc pair, `lib/netplay.js` and seed were md5'd before
and after each run. Every completed run read STABLE. smoke1 and A-ctrl were
stopped by hand once frozen; smoke1 printed identical before/after hashes,
and A-ctrl printed only its before hashes, which match the snapshot on disk.

Load was 4-66 throughout (sibling agents), and the rooms ran at 0.01-0.6x.
Every claim in this card is a byte comparison or a frame-indexed fingerprint,
so it does not depend on speed. No rate is quoted from these runs.

## 2. The PSO room killer: a card the seed deleted

`retro_unserialize → mcfg_DeserializeDevices` (`maple_cfg.cpp:546-583`) frees
EVERY maple device. It re-creates only the devices the state was captured with.
`g_vmu_flash_ptr[port]` (`maple_devs.cpp:367`) is set in `OnSetup` and cleared
nowhere, so `flycast_vmu_ptr(1)` keeps answering the old pointer at full size.

`pso2_boot.state` was captured with ONE card, so loading it deletes port 1's
card. Decisive test (`vmucheck2`, both the shipped seed and the lobby state):

```
before {p0 ptr 156434508 gen 2} {p1 ptr 156567380 gen 2}
after  {p0 ptr 156434508 gen 4} {p1 ptr 156567380 gen 2}      <- port 1 never re-created
32-byte marker written via flycast_vmu_ptr(p), then retro_serialize:
  port0 found at 2278601 (= the card's own offset 0x22b4c9 + 0x1000)    port1 NOT FOUND
```

The page "fixed" this as a guest behaviour. It wrote the room's card set again
at frame 240 (`VMU_REINSTALL_FRAME`), "because port 1 reads zeros once frames
run, at the same pointer". Those zeros were the allocator reusing freed memory.
The rewrite then corrupted the heap.

**Fix:**
- **Worker, `vmuGuardLoad`.** Every load site goes through it: Load State, the
  solo rewind, the lockstep normalize, and the parity begin. A card that a
  load re-created bumps its generation, through `OnSetup` and `deserialize`.
  A port whose generation did not move while its pointer is still set is
  DEAD:
  - `vmuPtr()` answers 0 for a dead port;
  - every read and write goes through `vmuPtr()`: poll, dump, info, seed,
    and the frame-scheduled install;
  - the page is told (`vmuDead`).

  A load that failed before reaching the devices moves no generation, so it is
  not read as "every card gone".
- **Page.**
  - The seat whose card the seed deleted still trades bytes, so the room
    protocol is unchanged. Those bytes are its stored card, or the power-on
    card the page kept before the seed.
  - Every console then *skips* that seat on install. The dead set is a pure
    function of seed + controller count, and both are already in the
    barrier's tag.
  - The frame-240 re-install is gone. The cards that exist were written after
    the seed and before frame 0, and nothing replaces them later.

## 3. Canonical room, final code

**G-canon3 is the proof run** (final files, served md5 `75eb95ec…` page /
`580c139d…` worker / `eec9ff8c…` wasm, STABLE before and after):
- two Chrome processes, one real room;
- frame 0 is the 3D Pioneer 2 lobby;
- both players pressed 118 seeded-random walks and button taps;
- **0 desyncs on both detectors over 105 checkpoints**, frames 0-6240,
  **≥ 202.6 guest seconds**.

The joiner's final screenshot (`/tmp/dc-soak/G-canon3-joiner-end.png`) shows the
lobby at frame 6173 with `desync check on, 103 compared`.

Two more canonical runs on final code agree up to where the ENVIRONMENT ended
them: G-canon (152.9 s, then the engine failed at load 64) and G-canon2 (72.7 s,
then the joiner's renderer threw). B-canon1 (202.9 s) ran the same trajectory
code without the anchor guard. Six canonical rooms, 0 forks in
all of them.

## 4. History forks a room, and idle-skip off does not stop it

- **The control.** The joiner's worker runs 10 frames from the seed, which
  takes 8,275 idle-skip slices. It then takes the page's own seed load. Its
  guest state at frame 0 is byte-identical to the host's.
  - Idle-skip ON: the engine reports DESYNC at frame 0.
  - Idle-skip OFF on both peers before frame 0: still DESYNC at frame 0. The
    RAM detector agrees: `a05b057f b636609a …` vs `a05b057f ff23a3b8 …`, with
    the second 4 MB quarter differing.
- **So the idle-skip streak is not the only carrier.** The proposed
  "`_flycast_set_idleskip(0)` on every peer" would cost CPU on every PSO room
  and not protect one.
- **What does protect is the invariant every canonical room already has: no
  peer has run a frame.** The worker now checks it on the first frame of every
  lockstep anchor and refuses on violation:
  - `lsRunIterEver`, counted on the `_emscripten_run_iter` export and on
    parity ticks;
  - plus `_flycast_ctx_snapshot(90)` burns, as a second witness.

  The page shows the refusal in the desync banner (`lsHistory`). With the
  guard shipped, the same control arm is refused on the joiner and passed on
  the host, and nothing forks.

Separately, the page now **refuses Reset and Load State while the frame gate is
armed** (`roomRefuses`). Either one changes only the clicking console's machine,
which is a guaranteed fork. Load State also rewinds that worker's lockstep frame
counter to 0.

## 5. Cost

**What the fix adds to a running console.**
- One JS function call per frame: the `_emscripten_run_iter` counting
  wrapper.
- One integer compare per lockstep anchor.
- Eight exported reads per state load (`vmuGuardLoad`).
- Two 128 KB card reads at a room's boot.

None of it is in the emulation loop. A Node micro-benchmark of the wrapper on
this box read 7-13 ns per call (noisy); at 30-60 frames/s that is under 1 µs
per second.

**Measured, solo, matched and interleaved.** Run with
`dreamcast/tools/idleskip_cost.mjs` under `tools/probe_lock.sh`, PSO Pioneer 2
lobby, governed, 20 s settle + 40 s window per cell, a fresh browser per cell.
`capacityX = guestX / duty` is guest seconds per second of worker busy time.

| rep | load | final (`75eb95ec`/`580c139d`) | shipped (`aba14d48`/`6a0a5910`) | final + `?noidleskip=1` |
|---|---|---|---|---|
| 0 | 5.1-5.8 | 0.9678 (guestX 0.674, duty 0.696) | 0.9377 (0.673, 0.717) | 0.7995 (0.663, 0.829) |
| 1 | 5.2-5.8 | 1.0142 (0.686, 0.677) | 0.9739 (0.679, 0.697) | 0.7944 (0.670, 0.844) |
| 2 | 5.3-**10.6** | 0.7937 | **0.3716** (22 iters/s: a load spike) | 0.7654 |

Matched ratios from reps 0-1, where load stayed under 6:

| ratio | rep 0 | rep 1 |
|---|---|---|
| shipped / final | 0.969 | 0.960 |
| idle-skip-off / final | 0.826 | 0.783 |

- **The fix costs nothing measurable.** Shipped was not faster than the final
  page in either clean pair, and the final page's guest rate (0.674 / 0.686) is
  the shipped page's (0.673 / 0.679).
- **The lever that was proposed, idle-skip off on every peer, costs about
  17-22% of PSO's capacity.** It would not have protected a room anyway (§4).
- **Neither page reaches 1.000x for PSO on this box, solo, at load 5.** guestX
  was 0.67-0.69 at 68-73% worker duty, presenting 21-22 of PSO's 30 frames/s.
  That is this machine with SwiftShader, not a regression. It is why no rate
  from the room runs is quoted anywhere here.

## 6. What this does NOT cover

- One box, one Chrome build, SwiftShader on both peers: no cross-GPU or
  cross-browser difference can show up here.
- The 2 s frame watchdog (`rec_wasm.cpp:2449-2478`) truncates a frame at a
  wall-clock-dependent point. It needs two 262,144-dispatch checks inside one
  `run_iter` more than 2 s apart. It is still live and still host-time
  dependent, and it never fired in these runs. A very slow device could hit it
  in a long frame. Only a rebuild can gate it (rollback patch 0001).
- **A lost WebGL context.** It happened to the host in G-canon3: the page
  raised its own `GPU CONTEXT LOST` banner and the canvas went black. That
  emulation stayed in sync to the end: measured, its RAM hash matched the
  joiner's at every checkpoint after the loss. So rendering did not feed the
  guest here. This bridge never sets a core option (`EmscriptenWorker.cpp`
  `RETRO_ENVIRONMENT_GET_VARIABLE` returns false), so render-to-texture
  write-back is at its built-in default; that default was not checked in
  source. The player still sees nothing until a reload, because Flycast does
  not rebuild GL objects on restore (the page's own note).
- **A host-side renderer failure ends a room.** In F-canon (load 66) and again
  in G-canon2 (load 50), the JOINER's core threw `RendererException "OpenGL
  shader compilation failed"` out of `retro_run` mid-frame, at the same
  `sh4_pc 0x8c3c24aa`.
  - It is thrown only when program link fails AND an info log exists
    (`gles.cpp:696-718`). On a lost WebGL context, `getProgramParameter`
    returns null, so link status reads 0. The shipped `flycast_worker_emcc.js`
    `glGetProgramiv(GL_INFO_LOG_LENGTH)` then substitutes `"(unknown error)"`,
    so the length is greater than 0, and the throw follows.
  - A lost context is the likely cause, with ~35 SwiftShader renderers on
    this box, and the host's G-canon3 loss shows such losses happen here. It is
    NOT proven for these two runs: the release build does not print the log.
  - It never occurred in B-canon1 (202.9 guest s), G-canon (152.9 guest s) or
    G-canon3 (202.6 guest s), and nothing in this change touches GL.
  - Solo, the rewind (37a651c) recovers from it. In a room the rewind is
    deliberately off, because rewinding one console forks it, so the room
    ends. Nothing in the JS bridge can finish a half-run frame identically on
    every peer; that needs rollback or a renderer that cannot throw.
- **The capability gate false-negatives under CPU starvation.** `lib/capability.js`
  times its Web Worker probe out at 3000 ms. At load ~28 it refused to boot one
  peer ("worker did not respond within 3000 ms"), so the rig runs with `&nogate=1`.
  A phone under thermal throttling could plausibly hit the same refusal, but
  that has NOT been measured. Not owned here; reported.
- Gauntlet and other discs were not soaked. PSO was chosen because idle-skip's
  spin PCs (`0x8c3c53d8/e0/f8`) are PSO's, and because it is the seeded disc.

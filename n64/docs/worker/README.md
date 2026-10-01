# N64 core off the main thread (the default)

## Status

The core runs in a dedicated Worker **by default**, solo and in rooms
(`WK_DEFAULT = true` in `n64/index.html`). `?worker=0` pins the main-thread core
(the opt-out and the control arm). Rooms run there too: lockstep, rollback with
`?rb=1`, and run-ahead. The room driver and the lib/netplay.js engine run in the
worker; the room's transport stays on the page (see "Rooms in the worker").

A few measurement arms still boot the main-thread core: `?jit=` arms other than
`emit`/`off`, `?difftrace`, `?turbo` and `?fbwitness`. So does any browser that
fails the checks in `wkRefusal()`: no Worker, no `transferControlToOffscreen`,
no AudioWorklet, or no WebGL2 in a worker as measured by
`lib/capability.js` (`webgl2Worker`). If the worker still fails while it boots,
the page falls back to the main thread by itself (see "Automatic fallback").

- `n64/N64Wasm/dist/core_worker.js` is the worker. It hosts the same
  `n64wasm.{js,wasm}` build as the page. No rebuild was needed, so the shipped
  md5s are unchanged: js `624d1a09`, wasm `2a0720e5`.
- `n64/N64Wasm/dist/fbasync.js` and `n64/N64Wasm/dist/jit_params.js` were moved
  verbatim out of `n64/index.html`. The page and the worker now share one
  readback implementation and one JIT param-block decode, because both of them
  decide which bytes end up in guest RAM.
- `n64/audio-worklet.js` now accepts `{port}` as a second producer. The worker
  feeds the worklet directly and the page's thread is never on the audio path.
- `n64/N64Wasm/dist/room_core.js` is the room driver, moved out of
  `n64/index.html`. Both realms run this one file: the feed, the 1.000x governor
  (`lsDueNow`), rollback (snapshots, re-simulation, GLSKIP, run-ahead), the exact
  savestates (`__n64State`), the fingerprints, the pre-roll and arm-before-boot.
  The only edits are `window.` to `G.` and an `env` object for what only the page
  knows (see its header).

## How the worker mode works

- **Canvas.** `#canvas.transferControlToOffscreen()` is handed to the worker.
  SDL2's init touches four DOM pieces: `screen`, `document` (as an
  EventTarget), `canvas.style` and `getBoundingClientRect`. These are shimmed in
  the worker. `window` is defined only after the runtime has loaded, so
  emscripten still treats the environment as a worker. This was measured
  2026-10-01: with exactly these shims, MK64 boots and renders in the worker.
- **Frame clock.** The worker arms the core's frame gate (`neil_ls_arm(1)`)
  before `main()`, which is the same hook a room uses. It then advances the guest
  only with `neil_ls_run_frame()`, applying the page's pad image to all four
  ports. The schedule is the room's 1.000x governor (`lsDueNow`):
  - Debt older than two field periods is dropped (gate #9).
  - `viHz` comes from the ROM header.
  - When the clock is on time, the driver ticks on the worker's rAF or on the
    field's own timer slot, whichever comes first.
  - When it is behind, the next tick is queued as an immediate task.
  - **A tick runs at most one field.** See "Presentation".

  rAF alone ran at about 30 per second on this box and capped MK64 at about
  0.58x, with the worker idle half the time. `?pace=0` is the control arm: one
  field per worker animation frame and nothing else.
- **Input.** The page builds the pad image in the core's own units. It mirrors
  the KEYBOARD, SDL-joystick and MOBILE blocks of `mainLoopInner` and honours the
  user's KeyMappings. It posts the image only when it changes:
  - on every key event,
  - on every pointer or touch event (as a microtask, after the overlay's own
    handlers run),
  - from an 8 ms heartbeat that covers gamepads and the overlay's
    minimum-press release.
- **Audio.** After each field, the worker reads the core's resampled ring and
  posts the chunk on the MessagePort the worklet adopted.
- **Saves.** The worker uses the same IndexedDB DB, store and keys as
  `dist/script.js` (`N64WASMDB`/`N64WASMSTATES`, `rom` and `rom.sram`). Save
  State, Load State, Reset, Export/Import and cartridge saves keep working.
- **What the page sees.** `window.Module` is a read-only facade over the
  worker's counters, reported every 50–100 ms. Main-thread-only features find no
  core to drive.

## Presentation: one field per task

A real phone (Android Chrome 154, Mali-G715, MK64, `?worker=1`) read
"12 shown / -- made" at 0.91x. MK64 draws a new picture on every second field,
so about 23 pictures a second were made. The cause was the worker's tick: it ran
up to 4 due fields per task. A field cost 20.4 ms against a 20 ms PAL period, so
the next field was always due, and every tick ran about 4. The OffscreenCanvas
commits what the context holds once per task (at most), so three of the four
fields were drawn and then overwritten before anyone saw them.

Now a tick runs at most one field. When the next field is already due, the
next tick is queued as an immediate task (a MessageChannel message), so each
field gets its own commit. The guest clock is unchanged: `due()` is still the
only gate. A room in the worker does the same (`env.oneFramePerTask` in
`room_core.js`): the feed presents one frame per task and kicks the next one.
Only the task boundaries move; every frame runs with the same input.

This box shows the mechanism but cannot reproduce the phone's loss. At HEAD it
ran about 2 fields per tick, and one of the two was the drawn one. After the
fix the worker reports `presents == fields`, one per task. An independent
screen witness confirms what reaches the screen: each main-thread rAF draws the
placeholder canvas, hashes it and counts the changes. It saw 97–98% of the
core's own made count (table below; it is a lower bound, because identical
thumbnails count once).

## The meter in worker mode

The page's readouts now work with the core in the worker:

- **made / game rate.** The worker scans its own heap for the core's `fps_text`
  ("FPS: n GameFPS: n"). It uses the page's scan: 1 MB slices, at most 4 ms each,
  20 ms apart. It reports the text with its counters. The page parses it with
  `N64Rate.parseCoreFps`, so `made`, `gameHz` and the 120 verdict appear.
- **shown.** This uses the page's definition: animation frames in which the
  core's field counter moved. It is counted on the worker's own animation
  frames, because the worker commits the pictures. No page rAF loop can reach
  it.
- **pace.** The worker's frame clock reports in the pace governor's shape:
  - busy time gives the e2e duty;
  - fields run outside a worker animation frame are counted as `paced`;
  - ticks with nothing due are counted as `notOwed`;
  - its debt allowance is 2 fields.

  `__n64Pace()` returns `worker: true`, `runFrame: true`, and `?pace=0` is a real
  control arm.
- **audio speed.** Samples a rollback or run-ahead dropped unplayed are
  subtracted (`AUDX.dropped`, reported by the worker), as on the main thread.

## Proof

All runs used a hermetic snapshot on its own port (18600–18605). The snapshot
was `git archive HEAD` with only this change's three served files laid over it
(`n64/index.html`, `core_worker.js`, `room_core.js`). Another agent's
uncommitted `fbasync.js` and core edits were therefore not in it. For every run,
the md5 of the served `index.html` matched the working tree. Final snapshot:
`index.html` `ce476b79`, `core_worker.js` `f65bf5ad`, `room_core.js` `c40feef9`,
`fbasync.js` `2e04f1b9` (HEAD), `n64wasm.wasm` `2a0720e5` (HEAD).

| Check | Result |
|---|---|
| `n64_worker_probe --mode exact`: main-thread core vs worker core. Same scripted pads. CPU fingerprint every frame, full raw-state hash every 30 frames | MK64, 1800 frames: PASS. SM64, 1200: PASS. OoT, 1200: PASS. No differing frame, 0 page errors. |
| `lockstep_probe --arms pair`: two tabs, real `local` transport, the **worker** room (default). Every presented frame's fingerprint compared, using the new `fps` ring in `__n64Net()` | 2/2 PASS. 900/900 frames compared each, 0 desyncs, 15 hashes each. The locked rate runs below added 2/2 more. |
| `lockstep_probe --arms pair --query worker=0 --join-query worker=1`, then the reverse: **mixed rooms**, one console in each realm | Both PASS: 902 and 901 frames compared, 0 desyncs, 16/16 hashes. |
| `lockstep_probe --arms pair --query worker=0` (main-thread room, regression) | PASS: 901 frames compared, 0 desyncs. The locked rate runs below added 2/2 more. |
| `n64_rollback_probe --query 'rb=1&rbgate=0'`, the **worker** room. Pad override and confirmed-state tap installed in the worker. The straight reference is the **main-thread** core, so this is a cross-realm check | PASS. 103 confirmed frames bit-exact (full 16.8 MB hash) after 182 rollbacks and 932 re-simulated frames. |
| same, `worker=0` (main-thread room, regression) | PASS. 125 frames bit-exact after 196 rollbacks. |
| `n64_worker_fallback_probe`: `?workerfail=boot` (before the core loads, where the WebGL2 preflight fails) and `?workerfail=main` (after runtime init, where a core abort lands) | 2/2 PASS. The page reloaded itself with `?worker=0`, logged the fallback, ran the core on the main thread (no facade) and advanced the guest, with 0 page errors. |
| `lockstep_probe --arms pair --query workerfail=boot`: both consoles of a room fail at boot | PASS. Both reloaded to `?worker=0` and rejoined the code (2 admissions). 400 frames compared, 0 desyncs. |
| `tools/n64_page_test.mjs mariokart.z64`. The default is now the worker, so `desktop`, `mobile`, `meter`, `diag` and `pace` run it | 9/10 PASS. `meter`: region, game rate (`gameHz` 25.1 from the worker's fps_text), capacity, both witnesses agree, not ahead. `pace`: worker governor wired, active, control arm inert, never ahead. `rafdedupe` fails: it is pinned to the main-thread core, which it tests, and HEAD fails it identically here (0.48x / 0.75x on HEAD, 0.65x / 0.44x after). |

### Rates (probe lock held, load 3.6–5.1, interleaved)

| | worker | main thread |
|---|---|---|
| room, `pair` 900 frames: frames per wall second ÷ 50 | 0.468, 0.453 | 0.478, 0.494 |
| room, host stalls (ms) | 113 (2188), 129 (2526) | 250 (4487), 216 (2946) |
| room, host meter: speed / made / gameHz | 0.65 / 16 / 21.2, 0.53 / 13 / 20.4 | 0.59 / 14 / 21.7, 0.63 / 16 / 22.4 |
| solo MK64, 20 s: meter speed (mean) | 0.68, 0.60 | 0.65, 0.62 |
| solo: made per s (core) / screen changes per s (witness) | 15.6 / 15.1, 13.2 / 12.8 | 14.4 / –, 13.2 / – |
| solo: worklet underruns in 20 s | 57, 70 | 82, 81 |

- The two realms run rooms at the same rate on this box.
- The worker feed adds no audio gaps of its own: at the same guest rate it has
  fewer underruns. Underruns below 1.0x are expected; the worklet's floor
  follows production down to 0.85x.
- The main-thread screen witness reads 0. A WebGL canvas with
  `preserveDrawingBuffer: false` cannot be drawn from another task, so this
  witness works only for the worker's placeholder.
- The guest rates are SwiftShader's ceiling on a shared 4-core box, not a
  device's.
- Per-field cost differs a lot between the realms: about 22–24 ms in the worker
  (meter `cap` 0.91x / 0.83x hw) and about 5–7 ms on the page (3.68x / 2.86x).
  The guest rates are equal anyway. I have not verified the cause. My guess is
  that the worker's retro_run waits on the shared SwiftShader GPU, which the
  page's rAF pacing hides. The other agent's readback work on this core targets
  that cost.

## What it buys

Each arm was run 2 rounds, interleaved, with a fresh browser per run, MK64
attract, a 20 s window after a 20 s warm-up, and the probe lock held.

| | mobile 4x: main | mobile 4x: worker | desktop: main | desktop: worker |
|---|---|---|---|---|
| main-thread long tasks, ms/s | 574 | **0** | 187 | **0** |
| longest main-thread task, ms | 431 | 0 | 485 | 0 |
| 50 ms timer lateness p95, ms (how long an input would wait) | 75 | 10 | 52 | 7 |
| main-thread rAF/s | 28 | 48 | 40 | 56 |
| guest rate (VI/s ÷ 50) | 0.561x | 0.735x\* | 0.776x | 0.860x |
| worklet underruns in 20 s | 80 | 37 | 36 | 10 |

\* **The CDP CPU throttle does not reach workers.** Every run recorded the
refusal ("Operation is only supported for pages"). So in the mobile column the
worker's emulator ran at desktop speed. That guest rate is an upper bound, not
a phone measurement. The main-thread columns are throttled in both arms, so the
long-task and lag rows are honest.

Box conditions: SwiftShader (software GL), load 3.3–5.4. The absolute guest
rates are this box's GL ceiling, not a phone's. The desktop pair is the
like-for-like comparison: +11% guest rate and 0 long tasks.

## Rooms in the worker

A room's core must be driven synchronously by its room driver: the feed,
rollback's saves, loads and re-simulation, and the fingerprints. So with the
core in the worker, `room_core.js` and the lib/netplay.js `Lockstep` engine run
there too.

The page keeps what a worker cannot own:

- the Session (RTCDataChannel, signalling, admission);
- the party panel;
- the input devices.

**The engine sees what it would have seen, in the same order.** The Session
still builds its engine with its own `startLockstep`, unmodified, so every
handler it registers lands on the object it holds. The page then adopts that
object (`wkAdoptEngine`):

- Every call on it is posted to the worker, one postMessage each, through one
  ordered port. The real engine executes them there. The calls are:
  - `receive`, in arrival order;
  - `seat`, `unseat`, `dropPeer`, `forgetReady`, `requestRoster`, `_rosterSend`,
    `declareReady`, `fail`, `stopRosterBeat`;
  - setting writes (`delay`, `rbHintMs`, `netFloorDelay`).
- Everything the engine sends comes back in order into the Session's own
  `_send` (`lso`).
- Every event the engine emits comes back as `lsev` and is dispatched to the
  page's handlers, with the engine's fields as of that event.
- The fields the Session and the panel read synchronously form a mirror
  (`lsm`): state, roster, seats, lobby, the barrier, `report()` and
  `paceReport()`. The mirror is refreshed with each event, after each call and
  every 100 ms.
- The host's relay (`filterRelay`) is decided in the worker, where the limp
  spans are, one hop later.
- The feed's API (`beginFrame`, `endFrame` and the rest) throws on the page's
  copy.

**Arming and declaring.** The worker arms the core before its `main()` with
`room_core.js` `lsArmBeforeBoot`. That is the same call, at the same point,
that `myApp.beforeRun` makes on the page. When `main()` returns, the worker
proves the savestate path (`lsRbProve`) and posts `mainRan`. The page then
declares (`autoDeclare`, then `chooseDelayThenReady`).

**Drivers.** The worker runs the same drivers as the page: its own rAF loop,
a 4 ms timer and the kick when an input lands. A worker room is never paused by
a hidden tab. Leaving the room hands the console to the worker's solo clock.
The gate stays armed, because SDL has no input in a worker.

**Pads.** The page posts four packed local seats (`lsPackLocal(0..3)`) on change
(`lspads`): from the input handlers and from the 8 ms heartbeat. `room_core.js`
`lsLocalPads` maps them onto this console's ports exactly as it does on the
page. The rig seam `__n64PadOverride` is honoured in the worker's realm.

**Rig seams.** `__n64LsAttach` adopts the rig's engine the same way, so the rig's
`send()` receives the engine's traffic unchanged. `__n64LsEngine` is that
adopted object. `__n64Net()` is the worker's report plus the page's room fields,
including a ring of the last 64 presented frames' fingerprints (`fps`).
`__n64State`, `__n64RbTap`, `__n64PadOverride` and `__n64RbLog` live in the
worker's realm. With `?workerrig=1`, `__n64Worker.eval` reaches them; that is how
`n64_rollback_probe.mjs` drives a worker room.

**Not SAB.** `/n64/` is deliberately not cross-origin isolated
(`Capability.SPECS.n64` forbids it), so everything is postMessage.

## Automatic fallback

**Detection.** If the worker fails before the core prints "Starting R4300", the
page falls back to the main thread. Three things count as failing:

- the worker's own WebGL2 preflight fails. It asks a separate 1×1
  OffscreenCanvas for `webgl2` before the heap, the ROM or assets.zip load, and
  never touches the core's canvas.
- the worker script fails to load;
- the core aborts while it boots.

**Recovery.** The canvas has already been transferred, so the page reloads once
with `?worker=0`. A solo console restarts its game (`&autostart&game=`). A room
keeps `?np=`, `&game=` and `&join=` and rejoins its code; the host has to admit
the joiner again.

**Reporting.** The reason goes to sessionStorage. The next load prints it and
pins it in the diagnostics facts (`facts.workerFallback`).

**Testing.** `?workerfail=boot|main` is the rig seam that simulates the
failure; `?workerfallback=0` disables the fallback.

## What still needs a real device

- **Rates on a phone.** Android Chrome and iOS 17+ Safari, `?worker=1` vs
  `?worker=0`, solo and in a room: guest rate, made vs shown, worklet underruns
  and touch-to-pad latency. CDP cannot throttle the worker, so no emulated arm
  can answer this.
- **Two physical devices.** Every pair here is two tabs of one Chrome, so
  cross-machine determinism is still covered only by the existing two-machine
  rigs.

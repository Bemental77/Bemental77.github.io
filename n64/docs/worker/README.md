# N64 core off the main thread (`?worker=1`)

## Status

The core runs in a dedicated Worker when the URL has `?worker=1`. It is opt-in.
`WK_DEFAULT` in `n64/index.html` is `false`, and `?worker=0` pins the main-thread
core. Rooms (rollback, lockstep, run-ahead) still run the core on the main
thread; see Phase 2 below.

- `n64/N64Wasm/dist/core_worker.js` is the worker. It hosts the same
  `n64wasm.{js,wasm}` build as the page. No rebuild was needed, so the shipped
  md5s are unchanged: js `624d1a09`, wasm `2a0720e5`.
- `n64/N64Wasm/dist/fbasync.js` and `n64/N64Wasm/dist/jit_params.js` were moved
  verbatim out of `n64/index.html`. The page and the worker now share one
  readback implementation and one JIT param-block decode, because both of them
  decide which bytes end up in guest RAM.
- `n64/audio-worklet.js` now accepts `{port}` as a second producer. The worker
  feeds the worklet directly and the page's thread is never on the audio path.

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

  rAF alone ran at about 30 per second on this box and capped MK64 at about
  0.58x, with the worker idle half the time.
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

## Proof

All runs used a hermetic snapshot on its own port. The served `index.html` md5
matched the working tree.

| Check | Result |
|---|---|
| `n64/tools/n64_worker_probe.mjs --mode exact`: main-thread core vs worker core, same scripted pads, CPU fingerprint every frame and full raw-state hash every 30 frames (nonce, tlb_gen and hid_epoch bookkeeping masked, as in `n64sHashFull`) | MK64, 1800 frames: PASS. SM64, 1200: PASS. OoT, 1200: PASS. No differing frame, 0 page errors. |
| `tools/n64_page_test.mjs`, new `worker` and `workerMobile` passes | MK64, SM64 and OoT all pass, with 0 page errors. Each one was running, rendering (luminance 75/134/64), had one core (none loaded in the page realm), and a key or touch reached the worker's pad image. |
| `n64/tools/n64_rollback_probe.mjs --query 'rb=1&rbgate=0'` (main-thread room path, regression check) | PASS. 147 confirmed frames were bit-exact after 246 rollbacks. |
| `n64/tools/lockstep_probe.mjs --arms pair` (two tabs) | 2/2 PASS, 0 desyncs. |

The existing main-thread passes `rafdedupe` (all three ROMs) and `pace` (OoT)
fail on this box. They fail the same way on an unmodified HEAD snapshot, so the
cause is SwiftShader and load, not this change.

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

## Phase 2: rooms in the worker (not done)

Rooms still need the main-thread core. These pieces call into the core
synchronously from the page:

- `lsFeed` and `rbRunFrame`
- the N64S raw-state ring
- GLSKIP
- run-ahead
- the fbasync pins
- `__n64Net`

The plan:

1. Move the lib/netplay.js Lockstep engine into the core worker. It already runs
   in a worker as the rollback probe's ghosts. Move the page's room driver
   (lsFeed, rbRunFrame, n64s*, raRun, GLSKIP) with it, unchanged, since it only
   needs `Module`.
2. Keep the transport (RTCDataChannel / MQTT signalling) on the page. Relay
   engine messages with one postMessage each way. The page is idle in worker
   mode, so the hop costs well under a field. The local pad keeps the current
   post-on-change path, keyed by engine frame.
3. Expose `__n64Net`, `__n64State` and `__n64RbTap` through the worker eval rig
   so `lockstep_probe` and `n64_rollback_probe` can drive both realms. Gate it
   with the same rollback bit-exactness straight-run reference.
4. Keep using postMessage, not SAB rings. `/n64/` is deliberately not
   cross-origin isolated (Capability.SPECS.n64 forbids it), so SAB is not
   available here.

## Flipping the default

Before `WK_DEFAULT = true`:

- **Real devices.** Android Chrome and iOS 17+ Safari, measured with
  `?worker=1` vs `?worker=0`: guest rate, worklet underruns and touch-to-pad
  latency. CDP cannot throttle the worker, so no emulated arm can answer this.
- **Meter parity.** The per-title game rate (fps_text heap scan) and the pace
  stats need to be read inside the worker. The `meter` and `pace` page-test
  passes then need to run with `worker=1`.
- **Automatic fallback.** If the worker posts a fatal error before
  `Starting R4300`, retry once with `?worker=0`.

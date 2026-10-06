# Xbox (Microsoft Edge) — device notes

Living record of what is MEASURED on Edge for Xbox. Each entry names its evidence
(a user debug report, a bench result, or a test). Anything not listed here is unverified.

## Input: the stick drives Edge's cursor, not the game

- Edge on Xbox ships a virtual mouse by default: the left stick moves a cursor and A clicks.
- `lib/xboxinput.js` switches `navigator.gamepadInputEmulation` to `'gamepad'` while an
  emulator runs, and back to `'mouse'` in menus. That way the page stays clickable and the
  stick reaches the game.
- `gamepadInputEmulation` exists only on Xbox/Edge. Desktop test rigs can prove the page
  ASKS for the right mode, but only hardware proves the shell honours it.
- **Reported 2026-10-06, fixed:** on `/n64/`, a "use pointer game controls" prompt the user
  did not ask for. What could raise it, checked one by one (`lib/xboxinput.js`):
  - `gamepadInputEmulation = 'gamepad'` is written ONLY by the card's "Use game controls"
    button, by LB+RB, or by resume/visibility while a game the visitor accepted is running —
    never at load, never without a click (`npm run matrix` asserts `preStartWrites === 0`).
  - **The site's OWN card** ("Use game controls?" / "Use game controls" / "Keep pointer" — the
    words in the report) was raised from each page's start path, and a room link AUTOSTARTS,
    so it appeared with no action by the visitor. It was also shown where
    `gamepadInputEmulation` does not exist and its button switches nothing.
    Fix: offered only when the shell can switch (`'gamepadInputEmulation' in navigator`); an
    offer made without user activation (`navigator.userActivation.hasBeenActive`) is held and
    asked on the visitor's next click/keypress; a menu click before any game asks nothing.
  - **Edge's own affordance** (offered when a page USES the Gamepad API): `xboxinput.js` called
    `navigator.getGamepads()` every animation frame FROM PAGE LOAD, on purpose, and registered
    `gamepadconnected` at load. That poll is gone. On a console UA, `getGamepads()` answers `[]`
    without touching the real API, and `gamepadconnected` listeners are queued, until the page
    has user activation (on Xbox the A button is a click). Measured before (matrix, console arm,
    rig activation ON): snes/gba called `getGamepads()` 51-60 times at load; gamecube, ps1, gba
    and dreamcast added `gamepadconnected` listeners at load.
  - `requestPointerLock`, the Keyboard Lock API and fullscreen: none is called at load on any
    page; the matrix counts all of them from the first byte (`window.__grab`).
  - Which of the two prompts the screenshot showed is not provable without the hardware; both
    triggers are removed.

## Graphics: WebGL2 may be missing

Reported 2026-10-06 on `/n64/?np=DHRNN&game=Mario Kart 64`:

| Observed | Detail |
|---|---|
| Capability probe | `getContext("webgl2", {depth, stencil})` returned null |
| Gate | blocked Start |
| With `&nogate=1` | `Load failed: Cannot read properties of undefined (reading 'getParameter')` |

- **Fixed (4760036, deployed):** the N64 core falls back to WebGL1 (`n64/N64Wasm/dist/glcompat.js`):
  the .wasm is unchanged (only the glue: MIN_WEBGL_VERSION=1), the core's GLSL 3.00 overlay and
  native-sampling shaders get GLSL 1.00 equivalents, and the GLES3 state they touch is answered
  without GL errors. The gate requires `webgl` (1 or 2), not `webgl2`. No WebGL at all now reads
  "this device gave no WebGL context …" instead of the `getParameter` TypeError.
- **Same console as WebGL2:** MEASURED, `n64_worker_probe --query-m webgl=1` (WebGL1 main thread vs
  WebGL2 worker), MK64 / DK64 / Pokémon Snap, 900 frames: 900/900 CPU fingerprints and 30/30
  FULL-state hashes identical. Before the sampling pass ran on WebGL1, RDRAM differed from frame 60
  (eager vs lazy framebuffer copies). If a device's WebGL1 cannot run that pass (a self-test at
  the room barrier), the console declares `· nf-eager` and a mixed room is refused with a reason —
  never a silent fork.
- **Speed (WebGL1 arm, SwiftShader):** solo 1.0000/1.0005x, loopback room 1.0004/0.9996x, 0 frames
  over budget, 0 bursts (bench, 2 interleaved pairs with WebGL2, which read identically).
- **Still unknown:** whether Xbox Edge grants WebGL2 inside a worker. Chrome's `--disable-webgl2`
  refuses it on a `<canvas>` but still grants it on an OffscreenCanvas (MEASURED), so the rig
  cannot answer for the Xbox. The probe now records every rung (webgl2 with/without attributes,
  relaxed, WebGL1, worker), so the next "Copy debug" from the Xbox will say.

## Pages that draw with Canvas 2D

`genesis.html`, `snes.html` and `gba.html` draw with Canvas 2D, not WebGL/WebGPU.

- **Expected:** they do not depend on WebGL2, so the N64 graphics failure above should not
  apply to them.
- **Status:** expected from the code, not yet proven on an Xbox.

## Measured: Genesis 2-player room, 2026-10-06 (user debug report)

`genesis.html?np=CE3W2&game=X-Men`. The report came from the GUEST: an Android phone
(Chrome 154, Mali-G715). The host's device is not in the report.

| Measure | Value | Verdict |
|---|---|---|
| Mode | rollback, delay 0 frames, `lagMs=0` | zero added input lag ✔ |
| Guest speed | 59.99/s = 1.001x; room engine 1.004x over 1 s | ✔ (own-clock rate 0.9999, lead −1.38 frames) |
| Presented | 60.0/s on a 60.0 Hz display, 0 janks in the sample | ✔ |
| Link | direct P2P (srflx/udp), RTT 127 ms, 9 frames | — |
| Rollback | 131 rollbacks over 110 s, mean depth 3.5, max 4; window 12–14 frames | working |
| Desync | none (110/110 hashes compared) | ✔ |
| **Stalls** | **15 stalls, 376 ms total, worst 66 ms; 359 ms of it waiting on the host (port 0)** | ✘ slowdown |
| **Audio** | **`latencyHint: 'playback'` → `outputLatency` 216 ms** | ✘ sound trails the picture by ~0.2 s |
| Startup | one 257 ms long frame at load (capability probe) | before play; not in-game |
| Errors | 0 | ✔ |

**Follow-ups from this report (worked 2026-10-06):**

1. **Audio latency — fixed.** `genesis.html`, `snes.html` and `gba` (`gba/gbaWasm/dist/script.js`)
   created their AudioContext with `latencyHint: 'playback'`; all three now ask for
   `'interactive'`, as N64 always did. `dreamcast.html`, `gamecube.html` and `ps1.html` pass no
   hint, which is the spec's `'interactive'` default. Measured in headless Chrome 141 on this
   box (not the phone): `'playback'` base 21.3 ms / output 64 ms → `'interactive'` base 10.0 ms
   / output 32 ms. The audio cushion (`lib/cart_audio.js`, 80 ms target) is unchanged, and it did
   not underrun: `node tools/bench_page_test.mjs --pages snes,genesis --sec 20` → 54 pass, 0 fail,
   **0 underruns** in all four windows (solo + loopback room, both pages). `?bench=1` now
   reports `audio: { baseLatencyMs, outputLatencyMs, underruns, missingMs, backlogMs }` per
   window, and Genesis is in the bench. **Not yet measured on the phone itself:** the 216 ms
   figure needs a fresh "Copy debug" from that device to confirm what `'interactive'` gives there.
2. **Stalls — cause found and fixed in `lib/netplay.js` (f538fe0).** The room's numbers were
   reproduced without a browser (`tools/netplay_rb_pace_sim.mjs rb-2p-127rtt`: 58 ms + 0–20 ms
   jitter each way, a 2% heavy tail of up to +60 ms, 2% loss, 110 s → 16 stalls, 451 ms).
   It was not the host's pacing and not the own-clock rule. Four causes:
   - **The window was sized from the wrong number.** The "late p99 9 / max 10" in the report
     is lateness *when an input arrives*. The window is checked on every frame, and between
     two arrivals the frontier keeps ageing. The host's acknowledgement (which a guest's window
     is also measured against) is sent with every other input message, and a lost message
     doubles the gap. Every stall after the start sat at `frame − frontier = window + 1` while
     the arrival maximum read `window − 2`. Each frame now also records the frontier's age, and
     a window stall grows the window at once.
   - **A direct room started at 8 frames.** Only relay rooms told the engine the path; a P2P
     room started at the page's 8-frame window and stalled until reports grew it (15 of 16 sim
     stalls were in the first 3 s). The host now pings each guest in the lobby
     (`Session._lobbyPing`), and the first window covers the **round trip**.
   - **A phone lost its margin.** The 3-frame jitter margin was cut to 1 for a 4 ms/step
     device, which turned jitter into stalls. Now it is cut only when a full-window
     re-simulation would take more than 4 display ticks.
   - Shrinking the window now requires that the smaller window covers the worst sample, not the
     p99. Two-player rooms send 4 frames of input redundancy instead of 3.
   - "Waiting on port 0" is not evidence about the host. A guest's stall always names the
     host's port, including when what it waits on is the host's acknowledgement.

   **Measured, before → after:**

   | Rig | Before (2b3adee engine) | After |
   |---|---|---|
   | sim `rb-2p-127rtt`, seed 11, 110 s | 16 stalls / 451 ms | 0 |
   | sim, 10 seeds × 3 cells (127 ms; phone guest at 4 ms/step; 5% loss) | — | 0 stalls in 27 of 30; the other 3: one lost `lsgo` delaying a start (2 seeds), one 34 ms stall at 5% loss |
   | two browsers, `netplay_device_matrix --arms r127`, Genesis (Sonic 3), 110 s | joiner 33 stalls / 845 ms (21 after the first 3 s) | 2 + 2 stalls (87 / 227 ms), **all in the first 2 s of play**; 0 after |
   | same, SNES (SimCity) | joiner 15 stalls / 462 ms (11 after 3 s) | 3 / 128 ms: 2 in the first 2 s, 1 × 15 ms at 68 s |

   All runs: rollback, delay 0, 0.998–1.001x, 0 desyncs (111–112 hashes compared in the
   browser cells), own-clock lead max ≤ 1.1 frames in the sim. Box load 8.8–10.9 during the
   browser cells (shared box), and the disk gate was lowered (`NPDM_MIN_FREE_GB=2`, 4.1 GB free).
   **Still open:** the stalls in the first ~2 s of the browser rooms. Both consoles stall at the
   same frame there (host on the guest's input, guest on the host's acknowledgement). That fits
   the two emulators' start-up hitches on a shared 4-core box. It is not proven, and a real
   two-device room has to show whether those stalls happen there too.

   **Cross-console suites after the engine change (netplay.js c0642f6f):** Node:
   netplay_rollback 28/28, rb_capacity 26/26, lockstep 152/152, delay_stepdown 26/26,
   rb_advantage, rb_drop, rb_outage, redundancy, pace_verdict, rejoin_session, rb_msgcost 4/4
   (2p 79.6 B/frame against 80.0 before adaptive rooms), rb_pace_sim 15/15, snes_rollback_probe
   19/19. Browser: ps1_netplay_test 26/26, gc_rollback_det_test 7/7, N64 lockstep_probe GATE
   PASS. gc_netplay_room_test (600 s) **passed 20/20 on one run and failed 19/20 on another**:
   `never-past-its-own-wall-clock`, host page-sampler lead max 2.95 at 0.6 s (engine ownClock
   leadMax 2.58), against a 2-frame bar. The old engine passed in the one run it got (max 1.16).
   On the failing run the room opened at a 23-frame window on a ~0 ms loopback link, because
   the lobby pings were answered while both pages were still loading. A suspected mechanism,
   not a proven one: a wider opening window lets the page's opening credit burst through,
   where an 8-frame window used to stall it. Open, needs more runs.

   **Follow-up (dd5308d).** gc_netplay_room_test, 60 s runs, interleaved f538 → old → fix × 4,
   load 4.2–6.7. Lead max per run, page sampler host/p2 (engine ownClock host/p2):

   | Run | f538fe0 (window 19–22) | 2b3adee (window 8) | dd5308d fix (window 22–25) |
   |---|---|---|---|
   | 1 | 1.51 / 0.91 (0.84 / 0.14) | 1.08 / 1.25 (0.41 / 0.71) | 0.63 / 1.23 (0.34 / 0.21) |
   | 2 | 0.83 / 0.69 (0.29 / 0.18) | 1.01 / 0.73 (0.41 / 0.23) | 0.42 / 0.20 (0.67 / −0.41) |
   | 3 | 1.86 / 1.41 (1.64 / 0.54) | 0.52 / 1.62 (0.62 / 0.35) | 1.73 / 0.98 (0.54 / −0.15) |
   | 4 | 1.32 / 1.50 (0.89 / 0.02) | 1.06 / 1.45 (0.50 / 0.27) | 0.84 / 1.97 (0.30 / 0.55) |

   All 12 runs: 20/20, every lead under 2. The 2.95 did not reproduce in 4 more f538 runs. One
   difference remains: in the wide-window arms the page sampler's peaks fall mid-room (13–55 s,
   up to 1.97) rather than at the release. The engine's own clock stays ≤ 0.67 on the fix arm.
   The fix does not depend on reproducing it. `OC_CAP`: no frame, credited or hidden, begins
   while the engine's ownClock lead exceeds 1.5. The sim case that read 2.1 (a lost `lsgo`)
   now reads 1.50, and the full 600 s gc room on the fix reads max 0.30 / 1.33 (engine 0.34 /
   0.02), 20/20.
   `RB_START_EXTRA`: +4 frames on the first window. In the sim, 30 seeds × 110 s go from 7 stalls
   to 0. In the r127 two-browser rig (fixed engine, single runs, load 8.3–9.2): Genesis host 0,
   joiner 3 stalls / 68 ms; SNES host 0, joiner 2 / 51 ms (frame 65, plus one 15 ms stall at
   86 s). Down from 33 / 845 ms and 15 / 462 ms before the change. The start-up stalls (frames
   48–65) persist at a 22–24 frame window, which means 370+ ms of lateness: a page hitch, not the
   link. Pre-warming would have to happen in the pages.
   Suites on dd5308d: all Node suites pass; ps1_netplay 26/26, gc_rollback_det 7/7,
   gc_netplay_room 20/20 (600 s), N64 lockstep_probe GATE PASS.

## How to add an entry

On the device, open the page and press "Copy debug" (or add `?bench=1` and press
"Copy results"), then paste the report. Record here:

- the date and URL;
- the device and browser, and which side of the room it was (host or guest);
- the table of measured values, each with a verdict.

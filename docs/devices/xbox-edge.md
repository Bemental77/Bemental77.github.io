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
- **Open (reported 2026-10-06):** on `/n64/`, Edge showed a "use pointer game controls"
  prompt the user did not ask for. Suspect: the page requesting a mode change or pointer
  lock without a user gesture. Being fixed.

## Graphics: WebGL2 may be missing

Reported 2026-10-06 on `/n64/?np=DHRNN&game=Mario Kart 64`:

| Observed | Detail |
|---|---|
| Capability probe | `getContext("webgl2", {depth, stencil})` returned null |
| Gate | blocked Start |
| With `&nogate=1` | `Load failed: Cannot read properties of undefined (reading 'getParameter')` |

- **Impact:** N64 needs WebGL2 today, so it does not run on this browser.
- **Fix in progress:** a WebGL1 fallback for N64, the crash fixed so it degrades instead of
  throwing, the gate relaxed to what N64 can actually run on, and a "WebGL1-only" arm in
  `npm run matrix`.
- **Not yet captured:** the Xbox's `edge://gpu` page, which would show which WebGL
  versions and extensions it really has.

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

**Follow-ups from this report:**

1. **Audio latency.** `genesis.html` and `snes.html` create their AudioContext with
   `latencyHint: 'playback'` (`genesis.html:1259`, `snes.html:1128`); N64 uses
   `'interactive'`. On this phone that gave 216 ms of output latency. Fix: use
   `'interactive'`.
2. **Stalls.** The room still stalls about once every 7 s, waiting on the host's inputs.
   Over 110 s that is 376 ms lost, against a zero-slowdown rule. Under investigation:
   whether the rollback window or the input redundancy should absorb these.

## How to add an entry

On the device, open the page and press "Copy debug" (or add `?bench=1` and press
"Copy results"), then paste the report. Record here:

- the date and URL;
- the device and browser, and which side of the room it was (host or guest);
- the table of measured values, each with a verdict.

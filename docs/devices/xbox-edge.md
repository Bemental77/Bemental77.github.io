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

## How to add an entry

On the device, open the page and press "Copy debug" (or add `?bench=1` and press
"Copy results"), then paste the report. Record here:

- the date and URL;
- the device and browser, and which side of the room it was (host or guest);
- the table of measured values, each with a verdict.

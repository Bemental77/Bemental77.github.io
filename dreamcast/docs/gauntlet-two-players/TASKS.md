# Gauntlet Legends: does the GAME react to port 1? — ANSWERED YES, 2026-09-07

## Status: PROVEN. A second character exists, is created from port 1, and moves independently of player 1.

Everything below is from ONE run — `p2proof`, log `p2proof.log` in this folder
(copy of `/tmp/dc-p2/p2proof.log`), numbers `p2proof.json`, screenshots
`shots/`. It was reproduced end-to-end by an earlier identical run (`move1`,
`/tmp/dc-p2/move1.log`); the two agree to a few pixels on every arm — see
"Reproducibility" below.

| | |
|---|---|
| binary | `dreamcast/flycast_libretro/flycast_worker_emcc.wasm` sha256 `14bddf42b8255a0c`, 8,704,964 B — **hash-guarded BEFORE and AFTER the run, STABLE** |
| page | `dreamcast.html` served by `npm run web` (`http://localhost:8080`), stock Chrome via puppeteer, headless |
| guest rate | **0.995–1.004x across the 20 heartbeats covering the measured arms** (t>90 s; the full log also holds 0.58–0.67x during the boot ramp). 30–60 presented fps |
| machine load | 3.09 / 3.21 / 2.76 at launch (`uptime`), a sibling agent's `dreamcast_netplay_test` browser was live on the box |
| maple bus, this run | `[maple] bus (type per slot, -1=empty): p0[1,-1,-1,-1,-1,0] p1[1,-1,-1,-1,-1,0] p2[-1,…] p3[-1,…]` |

## What was already proven, and what was missing

* `tools/dreamcast_netplay_test.mjs` (24/24) proves the **BYTES**: with two tabs
  connected, port 0 carries `0x40,0x1 lx=-32767` and port 1 carries `0x81
  lx=32766` in the same frame — different buttons, opposite sticks — in the very
  buffer `frameStep()` posts to the emulator worker (`dreamcast.html:4361`).
* `dreamcast/docs/core-relink-broken/TASKS.md` proves the **DEVICE**: a real
  Maple controller exists on both ports.

Neither says the GAME reacts to port 1. **That is the only thing this card
answers, and the answer is yes.**

## Method — two ports, one tab, no WebRTC

`packPad()` (`dreamcast.html:4237`) builds the 256-byte pad buffer. Its gamepad
branch (`:4264-4266`) writes pad `p` at byte `p*64`, so **a synthetic gamepad at
`navigator.getGamepads()[1]` lands on port 1 through the page's own shipped
code**, byte-for-byte where the netplay guest's pad lands
(`netApplyPadMask(bytes, 64, …)`, `:4292`). The keyboard keeps port 0.

That removes the transport from the experiment. The composition is:

```
netplay test:  remote browser  ->  WebRTC  ->  bytes 64..127     [ALREADY PROVEN]
this card:                                     bytes 64..127  ->  the game
```

Button numbering: `GP_BTN_TO_RETRO` (`dreamcast.html:4199-4201`) maps standard
gamepad button **9 -> `RB.START`** and button **0 -> `RB.B`** (= the Dreamcast
CONFIRM, `RB` at `:4125`). Stick: `axes[0]` -> the s16 LE left-stick X at port
byte 8, which `input_state_cb` reads
(`dreamcast/flycast-bridge/EmscriptenWorker.cpp:1030-1049`).

Rig: **`dreamcast/tools/gauntlet_p2_probe.mjs`**.

```bash
node tools/browser_leak_guard.js reap && uptime     # gate, per CLAUDE.md
npm run web                                          # port 8080, gate #2
node dreamcast/tools/gauntlet_p2_probe.mjs --name p2proof --script "<see below>"
```

### The gate that makes a negative meaningful

A rig whose input never lands looks EXACTLY like "the game ignores player 2" —
one agent already burned a long run on a page throwing `netRemotePad is not
defined` and reported a clean negative. So before any pixel claim the rig presses
the synthetic pad and reads the page's own `window.__dcPad()`:

```
GATE port-1 press -> p1 bytes [8,0,0,0,0,0,0,0,255,127,0,0]  p0 bytes [0,0,0,0,0,0,0,0,0,0,0,0]
GATE startBit=true p1Lx=32767 p0Untouched=true releases=true
```

Byte 64 = `0x08` = bit 3 = `RB.START`; bytes 72-73 = `0x7FFF` = +32767 = full
right. Port 0 stays all-zero, and both release. **The rig aborts and reports
nothing about the game if this fails.** Beyond that, every position sample in the
movement section below carries its own `PAD p0[…] p1[…]` witness read in the same
breath as the pixels, so a mid-run input failure cannot masquerade as a null.

## 1. Port-1 START opens PLAYER 2's join prompt

Port 0 is driven to the character screen (`Enter`, `Enter`, `m`). It shows four
bays — PLAYER 1 … PLAYER 4 — with only player 1's panel lit.

| | |
|---|---|
| `shots/01-charselect-p1-only.png` | "ENTER INITIALS TO BUILD A CHARACTER", PLAYER 1's panel (yellow) active, 2/3/4 dark |
| `shots/02-p2-start-opens-new-load.png` | **one port-1 START tap** — a red/white **`New` / `Load`** menu appears IN PLAYER 2's BAY, positioned under the "PLAYER 2" heading. Player 1's panel is untouched. |
| `shots/03-p2-joined.png` | second port-1 START tap selects `New` — **PLAYER 2's panel lights up blue with its own "ENTER INITIALS / HEALTH 1000"**, next to player 1's yellow one |

The same press, measured as pixels rather than read off a screenshot (8x6 grid of
block-mean luminance — a coarse signature, because these scenes animate every
frame and an exact hash is distinct every sample and proves nothing):

```
ctrlA -> ctrlB : distance 0.546, within-arm churn 0.948, ratio 0.58x   <- no input, 3 s apart
ctrlB -> afterA: distance 0.481, within-arm churn 0.037, ratio 12.99x  <- after ONE port-1 START
afterA -> afterB: distance 0.88,  within-arm churn 0.037, ratio 23.77x <- after the second
```

(from the earlier `join1` run — `join1.log` in this folder). The scene's own churn with
nobody pressing anything is the yardstick; the port-1 press moves the picture 13x
and 24x that.

## 2. Two characters get created, one per port

Alternating confirms — `m` on port 0, gamepad button 0 on port 1 — walks both
players through character creation independently.

`shots/04-two-characters-chosen.png`: **PLAYER 1 = WIZARD (yellow), PLAYER 2 =
VALKYRIE (blue)**, each with its own full-body portrait, stats block and HEALTH
1000. Players 3 and 4 stay empty.

`shots/05-in-game-two-bodies.png`: the level, **two bodies on screen and two HUD
panels** (`WIZARD GOLD 0 HEALTH 1000` | `VALKYRIE GOLD 0 HEALTH 1000`).

## 3. They move INDEPENDENTLY

Nine arms, 10 samples each, alternating held-input and at-rest. `pos` is a
colour-keyed centroid over the play area only (the bottom ~24% is the two-panel
HUD, which carries both colours and never moves): the WIZARD is white-and-gold,
the VALKYRIE is saturated blue. X runs 0..512.

| arm | pad witness (read WITH the pixels) | WIZARD x | VALKYRIE x |
|---|---|---|---|
| rest0 | `p0[lx=0] p1[lx=0]` | 276.88 | 179.31 |
| **p1left** | `p0[lx=-32767] p1[lx=0]` | **230.20** | 345.12 |
| rest1 | `p0[lx=0] p1[lx=0]` | 254.94 | 449.85 |
| **p2left** | `p0[lx=0] p1[lx=-32767]` | 270.11 | **107.25** |
| rest2 | `p0[lx=0] p1[lx=0]` | 337.62 | 50.78 |
| **split** | `p0[lx=-32767] p1[lx=+32767]` | 277.86 | **469.10** |
| rest3 | `p0[lx=0] p1[lx=0]` | 289.61 | 473.88 |
| **swap** | `p0[lx=+32767] p1[lx=-32767]` | 333.64 | **61.56** |
| rest4 | `p0[lx=0] p1[lx=0]` | 343.41 | 47.77 |

**The VALKYRIE's screen X follows the port-1 stick sign on every arm, including
the arm where port 0 was completely idle:**

```
rest1 -> p2left : VALKYRIE dx = -342.60   (port 1 LEFT,  port 0 IDLE)   WIZARD dx = +15.17
rest2 -> split  : VALKYRIE dx = +418.32   (port 1 RIGHT)                 WIZARD dx = -59.76
rest3 -> swap   : VALKYRIE dx = -412.32   (port 1 LEFT)                  WIZARD dx = +44.03
```

The screenshots say the same thing without any instrument:

| | |
|---|---|
| `shots/09-port0-idle-port1-left.png` | port 0 idle, port 1 stick full left — **the Valkyrie has walked to the left wall while the Wizard stands at the right** |
| `shots/11-p1-left-p2-right.png` | port 0 LEFT + port 1 RIGHT — Wizard at the far LEFT, Valkyrie at the far RIGHT |
| `shots/12-p1-right-p2-left.png` | port 0 RIGHT + port 1 LEFT — **the two have swapped sides**: Valkyrie far LEFT, Wizard far RIGHT |

11 and 12 are the same room, the same frame composition, opposite inputs, mirrored
outcome. Two bodies, two ports, opposite directions, same instant.

## Reproducibility

`move1` (`/tmp/dc-p2/move1.log`) ran the identical script from a cold boot
earlier and produced:

```
                   p2proof                 move1
rest0     yellow 276.88 blue 179.31   yellow 277.63 blue 179.42
p2left    yellow 270.11 blue 107.25   yellow 268.17 blue 107.83
split     yellow 277.86 blue 469.10   yellow 276.56 blue 470.52
swap      yellow 333.64 blue  61.56   yellow 332.36 blue  62.09
rest1->p2left  VALKYRIE dx -342.60         dx -342.50
rest3->swap    VALKYRIE dx -412.32         dx -412.69
```

## Caveats, stated rather than buried

* **The yellow key is contaminated by scenery.** The level's brickwork is tan and
  its braziers are orange, so the WIZARD key rises from ~1,280 px in the first
  room to ~2,500 px later; its absolute X is a weak number and is only ever read
  as a delta. **The blue key is clean** (380–980 px throughout) and it is the
  blue character that the port-1 arms move. The screenshots are the primary
  evidence; the centroid table is corroboration, not the claim.
* **The camera tracks the players**, so a stationary character's screen X moves
  when the other one walks. That is why `rest0 -> p1left` shows the VALKYRIE
  "moving" +165.81 with port 1 idle — the camera followed the Wizard. The
  interpretable quantity is the arm where only ONE port is driven and the
  OTHER character barely moves, which is exactly `rest1 -> p2left`
  (VALKYRIE −342.60 vs WIZARD +15.17).
* **This drives port 1 through packPad's GAMEPAD branch, not through
  `netApplyPadMask`.** Both write bytes 64..127 of the same buffer and both are
  OR'd in before the single `postMessage`, but they are not the same line of
  code, and netplay quantises each stick axis to a signed byte
  (`netPadMask`/`netApplyPadMask`, `dreamcast.html:4309-4324`: ±127 × 258 =
  ±32766) where this rig sends the full ±32767. What is therefore proven is
  "the game reacts to bytes 64..127". Composing that with the netplay test's
  "the remote guest's pad lands in bytes 64..127" is the whole claim, and the
  seam between them is one OR into one buffer.
* **`lib/xboxinput.js` raises a full-screen "Use game controls?" card** the
  moment a pad appears — correct product behaviour, pure obstruction here. The
  rig dismisses it with **"Keep pointer"**, the arm that installs nothing: that
  file does not touch `navigator.getGamepads` and dispatches no synthetic key
  events (grep: 0 `KeyboardEvent` in it), so the path under test is unchanged.
* **Not tested here:** two real browsers actually reaching the join. This card
  proves the game half only.

## The exact script

```bash
PREFIX="5000:log:boot;10000:log:x;10000:log:x;10000:log:x;2000:k:enter;3000:log:x;2000:k:enter;3000:log:x;2000:k:m;\
3000:shot:01-charselect-p1-only;0:p2:9;1500:shot:02-p2-start-opens-new-load;0:p2:9;2500:shot:03-p2-joined;\
1500:k:m;1300:log:x;0:p2:0;1300:log:x;0:k:m;1300:log:x;0:p2:0;1300:shot:04-two-characters-chosen;\
0:k:m;1300:log:x;0:p2:0;1300:log:x;0:k:m;1300:log:x;0:p2:0;1300:log:x;2000:log:x;3000:log:x;5000:log:x;5000:shot:05-in-game"
MOVE="0:pos:rest0,10;0:shot:06-rest0;0:kd:arrowleft;2200:pos:p1left,10;0:shot:07-p1-left-only;0:ku:arrowleft;\
1800:pos:rest1,10;0:shot:08-rest1;0:p2ax:0,-1;2200:pos:p2left,10;0:shot:09-p2-left-only;0:p2ax:0,0;\
1800:pos:rest2,10;0:shot:10-rest2;0:kd:arrowleft;0:p2ax:0,1;2500:pos:split,10;0:shot:11-p1-left-p2-right;\
0:ku:arrowleft;0:p2ax:0,0;1500:pos:rest3,10;0:kd:arrowright;0:p2ax:0,-1;2500:pos:swap,10;\
0:shot:12-p1-right-p2-left;0:ku:arrowright;0:p2ax:0,0;1500:pos:rest4,10;0:shot:13-rest4"
node dreamcast/tools/gauntlet_p2_probe.mjs --name p2proof --script "$PREFIX;$MOVE"
```

Menu timings are wall-clock taps against the attract loop, not a state machine —
they are what reached the character screen on three consecutive runs on this box,
and they will need re-timing on a slower one. `--profile` keeps a persistent
Chrome profile, which is why boot is ~8 s here rather than the ~5 min a cold
1.1 GB disc fetch costs: the disc sits in that profile's HTTP cache.

## Open follow-up

The two-BROWSER path reaching an actual join has not been run. The rig for it
already exists (`tools/dreamcast_netplay_test.mjs` gets two tabs connected and
proves the bytes); what is missing is driving the host through the attract into
the character screen and then having the GUEST press START. That is a
composition of two things each proven separately, so it is a confirmation, not
an open question.

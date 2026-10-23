# SM64 Daily Parkour

A new Super Mario 64 checkpoint run every day, Wordle-style: same challenge for
everyone on a given date, 2:00 on the clock, best result and streak kept in the
browser, and a shareable result line.

- **Play:** `/sm64daily.html` → `/n64/?game=sm64.z64&autostart&daily`
- **Code:** `n64/daily/daily.js` (loaded only under `?daily`, hook at the end of `n64/index.html`)
- **Data:** `n64/daily/states/<name>.gz` (start savestate) + `n64/daily/routes/<name>.json` (route tree)
- **Tools:** `n64/tools/sm64_daily_explore.mjs` (builds the data),
  `n64/tools/sm64_daily_test.mjs` (generator, 365 days),
  `n64/tools/sm64_daily_page_test.mjs` (end-to-end on the real page)

## Why every challenge is achievable

Checkpoints are not placed by hand or at random. The explorer plays the real
game from the start state with the core's lockstep API (`neil_ls_set_pad` +
`neil_ls_run_frame`, one VI per call): Go-Explore over 400×200×400-unit cells,
restoring a savestate, playing a random input macro (walk / jump / double /
triple / long jump / backflip), and archiving any new cell Mario comes to rest
in while grounded, alive, and still in the level. Each archived node keeps its
parent, so every node has a **proof chain** of real inputs from the start
state, and `t` = the VIs that chain took.

`generate(route, date)` seeds a PRNG from the date, picks a target node whose
chain takes 25–75 s (falling back to wider bands), and takes up to 5
checkpoints in chain order ending at the target. Following the bot's chain
clears every checkpoint in order in `t ≤ 75 s`, inside the 2:00 limit; that
`t` is shown as **bot par**. `sm64_daily_test.mjs` checks this for 365 days.

## Clock

Time is **guest time**: `_neil_vi_total()` deltas at the route's `viHz`
(60 for the NTSC `sm64.z64`). The guest runs at the page's 1.000x (pacing is
untouched), so a guest second is a real second, and a host stutter can't cost
the player time. The countdown freezes the guest with `_neil_ls_arm(1)`.

## RAM map (SM64 US, read through `_neil_rdram_ptr`)

`_neil_rdram_ptr()` (added in `src/libretro/libretronew.c`) returns the wasm
address of `g_rdram`. RDRAM holds host-endian 32-bit words, so an aligned guest
word at physical `A` is `HEAPU32[(ptr + A) >> 2]`, a halfword is at `A ^ 2`, a
byte at `A ^ 3`.

| What | Address | Verified as |
|---|---|---|
| `gMarioStates[0]` | `0x8033B170` | |
| action | `+0x0C` u32 | idle `0x0C400201`, walking `0x04000440`, jump `0x03000880`, intro `0x04001301` |
| pos | `+0x3C` f32×3 | moves with input; start `(-1328, 260, 4354)` |
| vel / fwdVel | `+0x48` / `+0x54` | walking −z: `vel.z = -31.06`, `fwd = 31.06` |
| face yaw | `+0x2E` s16 | stick up → `-32768` (0x8000) moving −z; stick right → `15723` moving +x; `224` moving +z ⇒ x = sin(yaw), z = cos(yaw) |
| health | `+0xAE` s16 | `0x880` = full |
| `gCurrLevelNum` | `0x8032DDF8` s16 | 16 = Castle Grounds |

## Open work

- **Courses.** Only Castle Grounds has a start state. Writing a warp
  destination at `0x8033B248` warped Mario *within* Castle Grounds instead of
  to Bob-omb Battlefield, so that address/layout is wrong. Next: catch the real
  warp struct during a natural door/painting transition, then capture one
  start state per course and run the explorer on each.
- **In-world markers.** The HUD points with an arrow relative to Mario's
  facing; drawing rings in the 3D scene needs the camera (Lakitu) state.
- **Shared leaderboard.** Scores are per-browser (`localStorage`
  `sm64daily.v1`).

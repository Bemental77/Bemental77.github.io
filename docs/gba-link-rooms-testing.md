# Testing GBA link-cable rooms by hand

Written 2026-11-02 (stage GR5). What exists: `gba.html` forms **lockstep link-cable rooms** itself. Every player's browser runs *all* the
linked mGBA cores of the room in one wasm instance; only 10-bit pad words (and, once, one battery image per seat) cross the wire. The
protocol is `gba/mgba/room.js`, the page side is the inline script "THE ROOM" in `gba.html`, and the full description, limits and the
numbers are in `gba/mgba/README.md` ("Rooms", "The room page", "Known limits of the room page"). This file is the how-to-test-it half.

**Read "What this does NOT prove" at the bottom before you believe a green result.**

## What you need

- One machine, one browser profile, **two separate browser WINDOWS side by side** (not two tabs of one window).
  Why: `?net=local` signalling is a `BroadcastChannel`, which only works between pages of the *same* profile; and Chrome gives a
  *hidden* tab no `requestAnimationFrame`, while the emulator pages are driven from it, so the tab you are not looking at would run zero
  frames and the whole room would stall on a console frozen by *you*, not by the code (`tools/headless_cdp_multi.mjs` header records this).
  Use *New window* (not *New tab*) and keep both visible, or put one on a second monitor.
- Chrome or Edge on a desktop (the automated tests ran Chrome 156 under headless SwiftShader; nothing has run on Safari, Firefox or a phone).
- No cross-origin isolation is needed: this page has no SharedArrayBuffer and no worker.

Start the site the project's way (**not** `python3 -m http.server`; this one answers HTTP Range, which the ROM fetch uses):

```
npm run web          # = node tools/devserver.mjs, http://localhost:8080
```

## Which titles, how many players

Only titles with a passing link row are offered in the Party panel (`gba/mgba/room.js` `ROOMABLE`, sourced from `tools/gba_link_smoke.mjs`):

| Title | Players | What "linked" looks like |
|---|---|---|
| Super Bust-A-Move | 2 | title -> language -> **2P BATTLE** -> MODE SELECT -> PLAYER SELECT -> a 1P vs 2P board. A solo core stops at `PLEASE WAIT`. |
| Kirby: Nightmare in Dream Land | 2, 3 or 4 | SUB-GAMES -> Quick Draw -> MULTIPLAYER: `TRANSMITTING...` shows `P1`..`P4`, one per seat, then the Quick Draw tutorial |
| Sonic Advance 3 | 2 | name entry -> BATTLE -> MULTI-PAK MODE -> `CHECKING COMMUNICATION`, then `PLEASE SELECT A PLAYER CHARACTER` |

Not offered, on purpose: Pokemon SoulGold (no passing row: see the manual Cable Club recipe below), PKMN Ultra Violet (no row),
Monster Rancher Advance 2 (`LINK` ignores A with no save: the rig could not reach it) and Sim City 2000 (no link mode).

Keys on the page: arrows = D-pad, `m` = A, `n` = B, `q` = L, `e` = R, `Enter` = Start, `v` = Select. In a room your keys drive **your**
seat only; the key-help footer (`You are seat 1 (host, link master) — your keys drive your own Game Boy Advance only. ...`) and the HUD line in the picture's top-left
corner (`LOCKSTEP frame N · input delay 3 (50 ms) · seats 2 · you are seat 1 · fingerprints M`) say which seat you are. Seats are counted from 1 and the host is seat 1.
(The status line, `Room — <title>`, does not say it.)

## Two windows, step by step

Use `?net=local` on **both** windows. (Without it the page signals through the public PeerJS broker, which needs the internet; that path has
never been exercised for GBA, see "What this does NOT prove".)

1. **Window A (host):** open `http://localhost:8080/gba.html?net=local`. Wait for the status line to read *Core ready.* Click **Party**.
2. In the panel: **Open a room**, pick *Super Bust-A-Move* in "Game", leave "Start when this many players are in" at 2, click **Open the room**.
   A 5-character code appears (and **Copy code** / **Copy link** buttons). The status says it is waiting for another player.
3. **Window B (joiner):** open `http://localhost:8080/gba.html?net=local` in the second window, click **Party**, **Join a room**, type the code,
   click **Join**. (The link form also works: `http://localhost:8080/gba.html?net=local&np=<CODE>&join=1`.)
4. **Window A** shows an *Allow / Deny* dialog with a 4-character confirmation code; **Window B** shows the same four characters. Compare,
   click **Allow**. (Knowing the code is not enough; the host must press Allow.)
5. Do nothing else. Once both seats are filled, **every console loads by itself** (there is no Start and no Ready button): it fetches the ROM,
   checks its md5 against the title table, reads *its own* stored battery, contributes its seat's image, verifies the whole set, boots one core
   holding both seats and declares ready. The panel shows each seat as `connecting` -> `loading N%` -> `loaded` -> `ready` -> `playing`
   (never a peer id). The panel then closes itself and both canvases start.
6. Play. Press keys in each window. Walk Super Bust-A-Move to the 1P-vs-2P board: title -> language -> **2P BATTLE** -> MODE SELECT -> PLAYER SELECT -> the
   board (the scripted test needs about 4,800 frames for this; the exact key script is `SBAM_SCRIPT` in `tools/gba_link_smoke.mjs`, mostly `A` and
   `Start`, and both players must advance each screen, because the game waits for the cable). Each window draws **its own seat's** screen; sound is its
   own seat's only.

### What to look for

- Both pictures advance together and the HUD frame counter on both machines stays within a few frames of each other.
- On the 2P board, **a button you press in A changes what B draws of the P1 board** (and the reverse). Equal screens alone prove little:
  Super Bust-A-Move auto-fires an idle shooter.
- The readout in the status bar reads about `guest 59.7/s (1.000x hardware)`. **It must never read above ~1.00x**; there is no speed control in a
  room (the speed menu entry is disabled, and `?speed=`/`?fps=` do nothing).
- In either window's console: `window.__gbaNet()` -> `state` is `running` (never `desync`), `roomLocked` is `true`, `delay` is the input delay in frames (3 to
  start), `witnesses.attached` is `2` from the first frame, and `witnesses.incidents` and `witnesses.recoverCount` stay `0`. `witnesses.linked` is **`false` at the
  game's title screen and turns `true` only once the game itself is on a link screen** (it is a structural signature of cable traffic, not a statement that the game is
  linked: it read `false` on both windows 3 s into a Super Bust-A-Move room).
- The pad delay is a **latency** knob, not a speed knob: a late peer *stalls* the room (the status says whom it is waiting for), it never makes
  anyone run faster.

### Drills worth doing by hand

(Provenance: steps 1-6 above were followed literally, by label, in two headless windows of one muted browser on 2026-11-02 - 18 checks, 0 failed. The drills below are
the scenarios `tools/gba_netplay_test.mjs` and `gba/mgba/README.md` describe; nobody re-drove them by hand for this file.)

| Drill | Expected |
|---|---|
| Close window B mid-room | Window A plays on; B's seat reads `disconnected`. **Finish room and save** cannot complete (it needs every seat) so A can only leave without saving. |
| Close window B's page, then in the **same window** open the invitation link again: `http://localhost:8080/gba.html?net=local&np=<CODE>&game=Super%20Bust-A-Move&join=1` | The host may be asked to Allow once more. B rejoins and shows *Rejoining the room - catching up...*, replays the recorded history as hidden frames (silent, not drawn), then plays at 1.000x. It does **not** contribute a save again: it takes the room's agreed set. (The same window matters: it is what keeps the engine's identity. A bare reload of a URL without `np=` does not know the code.) See the open owner question below. |
| Close window A (the host, seat 1, the cable master) | The room is over for **everyone** (`ROOM_HOST_LEFT`); nobody's save changes; each window is back in solo play. |
| **Finish room and save** in both windows | Each player's local seat is written (the previous save is kept as `<rom>.mgba.sav.pre-room`); nothing of the other seat is written. It needs *every* seat to vote for 30 frames. |
| **Leave without saving** | A two-press choice (the first press only arms it). Nothing is written. |
| Open window C with a *different* code or a corrupted ROM | Refused **by name** (`ROOM_ROM`, `ROOM_CORE`, `ROOM_SEATS`, `ROOM_CLOCK`, `ROOM_SAVETYPE`, `ROOM_SAVESET`...) with a sentence, on both sides. |

**Saves in a one-profile test.** Both windows share one IndexedDB (one origin, one profile), so both seats start from the *same* stored battery. For two
different trainers use the loopback-only test seam: add `&roomtest=1&gbadb=A` to window A's URL and `&roomtest=1&gbadb=B` to window B's. `?roomtest=1` is
armed only when the host name is `localhost`, `127.0.0.1` or `[::1]`; on the public site it is inert.

### Kirby with 3 or 4 players

Pick *Kirby*, set "Start when this many players are in" to 3 or 4 and open that many windows (every window must be visible). Each joiner needs the host's
Allow. Expect `TRANSMITTING...` with `P1`..`P4`. A phone-sized or slow machine may not hold 1.000x with four cores: the 4-seat Kirby step cost on this
desktop is about 5-7 ms of a 16.74 ms frame (`gba/mgba/README.md`), and **no phone has been measured**.

## The SoulGold Cable Club: manual recipe (NOT automated, NOT roomable yet)

Pokemon SoulGold is **not** in the Party panel, because a title enters `ROOMABLE` only with a passing link row, and the Cable Club needs a save made inside
a Pokemon Center that does not exist on the build machine. This is a *recipe for a person with a real save*; nothing here has been performed.

1. Make a save in a Pokemon Center: solo `gba.html`, Pokemon SoulGold, play past the intro to a Pokemon Center, save in the game. The page persists it
   (`Pokemon SoulGold (v1.1.1).gba.mgba.sav`); **Export .sav** keeps a copy. Make one for a second trainer too, or **Import .sav** the same file.
2. In a **scratch copy** of the repo (not this tree), add a `linked` row for SoulGold to `LINK_ROWS` in `gba/mgba/room.js` and re-stamp the `room.js?v=`
   token in `gba.html` (`node tools/gba_netplay_test.mjs --only static` checks the token). Serve that copy and open **Party -> Open a room -> Pokemon
   SoulGold, 2 players**; join from the second window as above, with `&roomtest=1&gbadb=A` / `gbadb=B` so the two windows hold different saves.
3. Both consoles: CONTINUE, walk to the Cable Club counter (second floor, right-hand desk), choose a trade or a battle. **Choose the cable**; the Wireless
   Adapter path cannot be served (mGBA has no RFU).
4. Pass criteria: both reach the Trade Center / battle room; on both, `__gbaNet().witnesses`: `attached === 2`, `linked === true`, `incidents === 0`,
   `recoverCount === 0`, `serialIrqsPerFrame` about 9 or more (the plan's Emerald figure, not observed on any other title); `__gbaNet().state` never
   `desync`; the clock is pinned, so a game that shows the time shows the same time on both.
5. The save checks that matter for a trade: start a trade and **close one window between the offer and the confirmation** - neither save may have changed;
   complete a trade and **Finish room and save** on both - each save holds *its own* seat's side; the previous saves are kept as `.pre-room`.

## The automated equivalents (what was run, and what each proves)

| Command (from the repo root; server and browser started by the test) | What it covers |
|---|---|
| `node tools/gba_netplay_test.mjs --browser` | this whole page, in 2-4 real headless windows: forming, Allow, loading, equal fingerprints every 60 frames, named desync, named refusals, clean end, crash repair, kill/rejoin, host leaving, phone viewports, speed lock, audio start, byte-binding of the core, allocation failure, Copy debug |
| `node tools/gba_room_protocol_test.mjs` | `room.js` on the real `Lockstep` engine with real cores and mutants (config, disc string, save envelope, clean end, crash sweeps, disconnect policy) |
| `node tools/gba_link_smoke.mjs` | the kill-switch rig behind `ROOMABLE`: which titles reach a linked state at which seat counts |
| `node tools/gba_room_determinism_probe.mjs` | pinned RTC / time zone soak: 18 child processes, 100,000 frames |
| `node tools/gba_mgba_solo_test.mjs --browser`, `gba_page_standard_test.mjs --browser`, `gba_mgba_core_test.mjs`, `gba_mgba_build_test.mjs` | solo play on the same core, the page standard, the core's API, the reproducible build |
| `node tools/undelivered.mjs` | the standing list of what is *not* built, including the GBA entries (below) |

## What this does NOT prove

Say it plainly, in this order:

1. **No real second human.** Every multi-window test is one script driving N windows of one browser.
2. **No real network.** `?net=local` is a `BroadcastChannel` on one machine (about 1 ms). NAT traversal is not exercised. A GBA room has never formed over the
   shipped PeerJS transport, let alone between two networks (`tools/undelivered.mjs`: `gba-rooms-have-never-run-over-the-shipped-transport`;
   `tools/audit_peerjs_crossdevice.mjs`'s gba row is stale and cannot drive a GBA room).
3. **No real phone.** The phone cases are Chrome's engine at a phone viewport with touch emulation, not WebKit and not a device. The core's heap is a fixed
   192 MiB (a second one is booted for a room); how a low-memory device behaves, and how many seats a real phone holds at 1.000x, are unmeasured
   (`gba-low-memory-and-slow-devices-are-unmeasured-on-hardware`).
4. **No SoulGold Cable Club.** Neither trade nor battle has been run through a room. The clean-end save protocol was exercised on a *toy* trade core, not Pokemon.
5. **No real audio device.** Every test browser is started with `--mute-audio`; sound is checked by `AudioContext` state, the sink's counters and buffer
   contents, never by listening. Whether it *sounds* right through headphones is for you.
6. **Nothing on Safari, Firefox or any non-Chromium engine.**

Known limits and open decisions that are **not** defects of a test run (details in `gba/mgba/README.md` "Known limits of the room page" and in
`tools/undelivered.mjs`):

- **A returning page replays at more than 1x, hidden.** A reloaded page is brought level by re-simulating the room's recorded history as hidden frames at
  roughly 10x hardware or more (one measurement), then runs at 1.000x. The room itself never runs faster. Whether that satisfies "the guest never runs faster than
  hardware" is an **open owner decision** (`gba-rejoin-replay-runs-hidden-frames-above-1x`); the alternative, `rsReplay` off, means a returning page cannot
  rejoin.
- **The save-card size cap is now at the engine, opt-in (closed 2026-11-02).** `lib/netplay.js` `_cardTake` used to reassemble a card from sender-announced sizes with
  no limit; it now honours `cardLimits` when a page passes one (`gba.html` passes `ROOM_CARD_LIMITS`), and behaves exactly as before for every page that does not.
  Tests: `node tools/gba_card_cap_test.mjs` and `tools/gba_netplay_test.mjs --browser --only cap` (see `gba/mgba/README.md` "Known limits of the room page").
  The undelivered entry `gba-room-save-card-has-no-engine-size-cap` was deleted when the gap closed.
- **The solo core's 192 MiB cannot be proven released** when a room boots its own (B1(d)): the room closes the solo core and drops every reference, but whether
  the OS gets the memory back is the garbage collector's decision and cannot be measured from the page.
- **The hamburger (`#mobileMenuBtn`) is left at family parity** (B9): a 38 x 38 box with a 44 x 44 hit area, as on the other emulator pages. Only this page's own
  touch-menu entry `#mNet` was raised to a full 44 px.
- **Out of scope by decision**, each with a standing entry in `tools/undelivered.mjs`: Wireless Adapter / RFU games, Single-Pak / multiboot link, mixed-ROM rooms,
  spectators.
- **The lobby/catalogue stage and the pace/device-budget stage were not done when this was written.** The 100 ms / 4-frame tick cap and the 3-frame start delay are
  starting values.

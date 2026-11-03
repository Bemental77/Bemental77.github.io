# Pokemon Arena online: battle a friend

Two people, two devices, one battle. Nothing is streamed and nothing runs on a server: **both browsers run the same deterministic engine, and only the two
players' choices cross the wire**, which is how every other online page on this site works (every machine runs the game; the missing input is waited for,
never guessed; a state hash that disagrees stops the session and names the turn).

## How to play

* **From the hub:** the "Play a friend online" link under the menu opens `/pokemonarena/battle.html?online=1`.
* **From the lobby** (`/multiplayer.html`): pick *Pokemon Arena*, *Open a party*, give your friend the code (it starts with `A`) or the invite link, press *Start my console*.
  A friend who types only the code is taken to the Arena without being asked.
* **Direct:** `battle.html?np=CODE&host=1` and `battle.html?np=CODE&join=1`, `&team=<ARENA1 code>` preselects a team, `&format=6v6|3v3` is the host's default format.

Each player picks a saved team, a random team or a pasted team code, a name, and (the host) the format. The host's browser shows the code once the room is open and
asks the host to **allow** the joiner (a four-character confirmation code to read out, from `lib/netplay.js`). Then both browsers check each other's team, agree a
seed, and the team preview starts.

## What is reused and what is new

| Concern | Where |
|---|---|
| Pairing, room code, the host's approval, ICE and the relay fallback, link health | `lib/netplay.js` (`Netplay.Session`), unchanged |
| Our messages | type `lsarena` on that session's channel: sent with `session._send()`, received by wrapping `session._onRoomMsg` (the same seam `gba.html` uses for `lsgbahostbye`); the direct channel and the relay both end in that router |
| The protocol (handshake, seed, commit-reveal, hashes, clocks, rematch, resync) | `js/netmatch.js`: pure, no DOM, no network, no timers |
| Arena glue (judge a team code, build the controller for one side, fingerprint the engine) | `js/online_match.js`: pure |
| Setup panel, session, status bar, hand-off to the scene | `js/online.js` |
| The scene on side 1 for the guest, the `wait` screen ("Waiting for the other player...") | already in `scene.js` (`viewSide`) |
| `Battle.concede(side)` / `ctl.concede(side)` | `engine.js`, `matchctl.js`: a side leaves even while waiting with a real choice already in (a plain forfeit cannot: a real choice is final) |

**Why not the emulators' frame-lockstep engine** (`Lockstep` in `lib/netplay.js`)? It exists for cores that must run every frame at 60 Hz. A battle is turn based: a frame
loop would tick 30 times a second through five minutes of somebody thinking, and a backgrounded tab (timers throttled to 1 Hz) would turn every choice into seconds.
This protocol is message driven, so a hidden tab costs nothing.

## The protocol (`netmatch.js`)

Every message is `{ t:'lsarena', v:1, k, mn, ... }`; `mn` counts rematches. Every inbound message is shape-checked (`checkMessage`) before anything reads it.

| kind | from | meaning |
|---|---|---|
| `hello` | both | ROM sha-256, engine fingerprint, ruleset, name, team code, the host's format. Refused **by name** for a different ROM, a different engine build, different rules, an illegal team, a team too small for 3v3, a format named by the guest |
| `seedc` `seedb` `seedr` | host, guest, host | the shared seed: the host commits to its half, the guest answers with its own, the host opens. `seed = mix(a, b)`: the host is bound before it sees `b`, the guest never sees `a` until `b` is fixed |
| `go` | both | hash of the freshly started battle; both must agree before turn 1 |
| `rdy` | both | "my screen can take a choice": the other side's clock starts here, not while the last turn is still animating |
| `commit` `reveal` | both | a round where **both** sides choose (every turn, the team preview): `commit = sha256(room#match, round, side, choice, nonce)` with the state hash the round opened on; the choice is opened only after **both** commitments are in |
| `choice` | both | a round where only **one** side chooses (a replacement after a faint): nothing to hide, so no commitment |
| `bye` `end` | both | leaving (the leaver forfeits) / the match is over, with the final hash |
| `rematch` | both | both must ask; then the seed handshake runs again with the same teams |
| `sync` | both | after a dropped link or a reload: "I am here, resend me from round N" |

**Rounds** are numbered identically on both machines (a round opens each time the engine has advanced and someone has a choice to make). A round is applied only when
everything it needs is verified: the commitment opens correctly, the choice is legal (`ctl.submitRemote` is the engine's own `choose`), and the opening state hash equals ours.

### Clocks and leaving

| situation | result |
|---|---|
| the player forfeits (pause menu) or presses BACK TO HUB | they lose at once; the other side's scene shows the forfeit |
| the player's page is closed or reloaded | the link drops, the other side is told and waits (below); a RELOAD picks the battle up again |
| a player's screen is ready and they take longer than 2:00 (3:00 at the team preview) | they time themselves out; the other side's clock (+3 s) is the fallback if their page is frozen |
| a player's screen never becomes ready (a hidden tab) | out after 5:00 from the round opening |
| both committed and one reveal never comes (a broken or hostile client) | out after 30 s |
| the link drops (a closed page, a lost connection) | 60 s of grace; on reconnection the `sync` below resends exactly what was missed; after 60 s the player who stayed wins. A page that was reloaded into a battle and never gets back to the other player is stopped, and does not claim the other player left |
| an **abort** (desync, cheating, an illegal choice, a malformed message) | nobody wins; both pages say why |

A claim **against you** ("you timed out", "your link was dead") is believed only when your own clock or link record agrees; otherwise the match is stopped. A claim against
the sender itself (a forfeit) is simply taken.

## Reloads and dropped connections

* **A reload does not lose the battle.** After every change `online.js` keeps the match's `snapshot()` in `sessionStorage` (per tab; never sent anywhere): the agreed seed, every choice the engine has taken, the round, the hash the round opened on, the commitment's nonce, and every message sent this match. A page that is **reloaded** (the browser says `reload` or `back_forward`; opening the address afresh never resumes) rebuilds the controller from the seed, replays the recorded choices, **refuses unless that lands on the recorded state hash**, replays the scene silently and at speed, and re-syncs: its `sync` makes the other side resend what it missed, and its restored message log answers theirs. The address is rewritten to `?np=CODE&host=1|join=1` when a room is opened, so a reload finds its record.
* **The guest reloading** is re-admitted by the host with no prompt (`lib/netplay.js` remembers the seat). **The host reloading** makes the guest knock again by itself, and the host is asked once to allow it.
* **A dropped connection heals by itself:** `lib/netplay.js` re-knocks a link that was open and died (the room has not "started", so its normal rule applies); `online.js` also replaces a session that failed outright, on a timer, while the match's own 60 s clock runs.
* **Proved by:** `pokemonarena_netmatch_test.mjs` case R reloads each player at *every step* of three real matches, with nothing in flight, with the unsent messages lost, and (the case that found a real bug) with the player having answered but the answer not yet delivered; each must end in the uninterrupted match's exact final position (171 cases), plus records that must be refused by name; and `pokemonarena_online_page_test.mjs` group `rejoin` reloads the guest and the host in real Chrome tabs (same position on return, link back up without a click, the match plays on to the end in agreement), cuts a live connection, and checks that a fresh visit does not resume.
* **Limits:** the record is per tab (a different tab or browser starts over); a reload during the handshake (before turn 1) is not resumable; closing the tab for good costs the other player up to 60 s before they win.

## What it guarantees, and what it cannot

* Two honest machines cannot disagree: the engine is deterministic and the final position hashes are compared. A bug, a cached older script or a tampered client becomes a stopped match with a turn number.
* Neither player can read the other's choice before making their own, and neither can steer the dice (commit-reveal on both).
* A different ROM, engine build, ruleset or illegal team is refused by name before turn 1; hostile names are reduced to safe text identically on both machines.
* **It cannot hide the other team from a modified client.** Both engines need both teams to run (the cost of every lockstep game). The Stadium-style preview that hides the unchosen three is a presentation.
* **It cannot stop a player from aborting a match they are losing** (they can send an abort): matches are unrated, and nothing is recorded.
* The relay path (`lib/netplay.js` falls back to an MQTT relay when no direct path exists) carries a battle the same way; it has been tested with the same-browser transport only, not across two real networks.

## Not built (and not claimed)

* The battle is **not written into your record** (the career schema has no human-opponent entry; changing it touches stored profiles).
* No ratings, ladders, spectators, rentals or doubles.

## Tests

```bash
node tools/pokemonarena_netmatch_test.mjs             # the protocol on the real engine, in Node (~1.5 s)
node tools/pokemonarena_netmatch_test.mjs --mutants   # ... and prove it is not vacuous: break netmatch.js / matchctl.js / engine.js 23 ways, each must fail a named case
node tools/pokemonarena_online_page_test.mjs          # two real Chrome tabs; groups: hub lobby match leaving rejoin timeout refusals teams layout (name them to run a subset)
node tools/multiplayer_page_test.mjs                  # the lobby catalogue and hand-off, Arena included
node tools/no_streaming_test.mjs                      # online pages are lockstep-only; this module is one of them
node tools/stamp_lib_versions.mjs --check             # battle.html carries the version stamp that tells two builds apart
```

The browser test uses `net=local` (BroadcastChannel) so no network or broker is needed, starts its own server (`ARENA_PORT`, default 8097) and one muted headless Chrome per
group (`ARENA_CDP`, default 9283), with background-timer throttling disabled because two tabs share one browser (a hidden tab would otherwise crawl). `arenaturn=<ms>` and
`arenagrace=<ms>` shorten the clocks, **only** for `net=local`. (`turn=` is not ours: `lib/netplay.js` reads it as a TURN relay.)

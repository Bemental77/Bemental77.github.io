# GBA link-cable rooms + the SoulGold "Arena" — research record and plan

Source: a 20-agent read-only workflow run on 2026-11-01 (9 research streams, 9 adversarial verifiers,
1 synthesizer, 1 completeness critic) plus one spike run by hand. **Parts 1-7 are the research record and were static analysis:
no browser, emulator or probe was run for them.** Sizes are S/M/L/XL tiers, not predictions.

> **STATUS, 2026-11-02: the GBA half of this plan has been built, mostly. Read "Part 8 - Status" at the END of this file first.** Parts 1-7 are kept as written
> so the reasoning can be audited; where the build went another way (the solo core moved to mGBA, Part 7 decision 2) or where Part 1 no longer describes the
> page (`gba.html` no longer runs 44vba), Part 8 says so. The Arena half (Part 3, workstreams R0-R10) is a separate workflow and is not covered by Part 8; note only that R10 ("Cable Club battles as the fidelity oracle") depends on a SoulGold Cable Club that has NOT been run (Part 8, G3).
Raw results: the workflow journal under `~/.claude/projects/.../subagents/workflows/wf_346ff6d7-460/`.

## Part 1 — What gba.html is and why it cannot link today

- `gba.html` runs **44vba** (provenance is `gba/gbaWasm/dist/script.js:1-2`, not `gba.html`). All SIO/RCNT/JOY
  writes fall through to a raw IO store; the START bit never clears; the serial IRQ (IF 0x80) is never raised
  anywhere in the module (A1 + verifier). The shipped wasm matches **no public 44vba commit** (it exports
  `emuSetSaveType`, absent from public `main.cpp`) and no source/build tree is in the repo
  (`git ls-files gba` = `dist/`, `roms/`, `vendor/`). "Rebuild 44vba" would build a different program.
- Binding directive (2026-09-08): lockstep, every player runs their own core, only input crosses the wire,
  own input applied locally. Streaming is cancelled.

## Part 2 — GBA decision: mGBA, N cores per machine (O1)

| Option | Verdict | Reason |
|---|---|---|
| **O1** every browser runs all N linked GBAs in one wasm instance, only 10-bit pad masks + one-time per-seat saves cross the wire | **CHOSEN** | Exactly what `lib/netplay.js` implements (`netplay.js:20-27`); all SIO stays in-process. |
| O2 network-stalled cable | rejected | Emerald's master chains **9** transfers/frame (corrected from 15). Under the stall-per-transfer model: 0.650x at 1 ms RTT, 0.157x at 10 ms. Violates CLAUDE.md gate 9. |
| O3 one SIO exchange per frame | rejected for this site | Works only through per-game HLE batching (gpSP does), which makes cores run different saves — conflicts with the identical-core fingerprint model. |

Core: **mGBA (MPL-2.0)**, pinned revision, built **single-threaded** (`-DUSE_PTHREADS=OFF`), plus a cooperative
multi-core scheduler ported from `Spuds0588/mgba-splitscreen` (instances.c `sp_run_frame`; the 4-player ack
barrier / no-sleep-after-ack / `GBASIOLockstepCoordinatorRecover` hunks of lockstep.c; **not** its Four Swords
assist, lockstep.c:612-671). 44vba stays for solo play.

### Spike result (run this session, clone at `f1d5975d`)
- The "4,000 FPS / 0.24 ms per frame for 4 cores" claim **exists**: `mgba-splitscreen/README.md:78`,
  `PROJECT_LOG.md:129-130` — but it is the author's `bench` on the **native Rust desktop build**
  (`PROJECT_LOG.md:124-130`), **not a wasm-in-browser measurement**. (The critic missed it because it read the
  root README.) Browser frame cost for 2-4 cores is therefore still unmeasured → G6.
- The fork's shipped `mgba-splitscreen/web/mgba-splitscreen-web.wasm` is 789,852 B with **0** occurrences of
  `SharedArrayBuffer`, `new Worker`, `pthread`, `Atomics` — single-thread cooperative stepping is real.
- `web/build.sh` is `emcmake cmake` based and its `DEFINES` line still carries `-DUSE_PTHREADS` while cmake gets
  `-DUSE_PTHREADS=OFF` (lines 28/36) — must be made consistent in our build.
- lockstep.c is 2020 lines in the fork.

### Game matrix (A4 + verifiers; md5s from ROM bytes)
| ROM | Link | Notes |
|---|---|---|
| Super Bust-A-Move | Multi-Play, 2P | smallest protocol demand — **first validation target** |
| Monster Rancher Advance 2 | Multi-Play, 2P | trades mutate saves |
| **Pokemon SoulGold v1.1.1** (BPEE, md5 `b2c5caf9bc6dd28a44052427ee3ab1b7`) | Cable Club = stock Multi-Play (`EnableSerial` @ ROM 0x08197fb8) | **only title with an RTC** (SIIRTC_V); Wireless Adapter path present but **cannot be served** (mGBA has no RFU). 8 SIOCNT clusters, not 3 (critic). |
| PKMN Ultra Violet (BPRE base) | Multi-Play Cable Club (+ unservable RFU) | no RTC dependency |
| Kirby Nightmare in Dreamland | 4-slot Multi-Play (+ Normal-32 Single-Pak) | Multi-Pak first |
| Sonic Advance 3 | Multi-Play up to 4 (+ Sio32) | Multi-Pak first |
| Sim City 2000 | none found | only `SOLO.gba` candidate (hedged) |

### GBA workstreams
| ID | Size | Deps | Exit test |
|---|---|---|---|
| G0 Reproducible single-thread mGBA build (C:\em\sdk Emscripten 6.0.2; **cmake and ninja are absent**; PATH `python` is a Store shim) | M (may be L) | — | Scripted clean build twice → same wasm md5 (measurement, not assumption); 0 SAB/Worker/pthread/Atomics strings; Node instantiates it; **git stores a real wasm, not an LFS pointer** |
| G1 Cooperative multi-core bridge (one shared ROM mapping, event-batch stepping, Recover = incident) | L | G0 | Two bridge instances, identical key streams → identical per-seat saveState hash every 60th frame for 100k frames; exactly 280,896 cycles/frame |
| G2 Determinism pins (RTC epoch **and** time zone: `gpio.c:315` uses `localtime_r` → `__localtime_js`/`__tzset_js`) | M | G1 | Same stream under two time zones / Date bases → identical chains; unpinned build diverges; one-bit mutant caught |
| G3 Link-correctness matrix | L | G1, G2 | Committed pass/fail row per title × seat count; witnesses: master SIOMULTI1 ≠ 0xFFFF, ≥9 serial IRQs/VBlank, zero Recover; a title enters `ROOMABLE.gba` only with a passing row |
| G4 Seat / save / disc protocol (fold clock, save type, ROM md5, `cardSetHash` into the disc string — `cardSetHash` omits `enc`, `netplay.js:3159-3171`; recompute `cardHash` on receipt) | M | G2 | Clock mismatch / save-type mismatch / tampered chunk each refused by name; only local seat persisted; **kill a peer between offer and confirm in the Trade Center → neither save persisted** |
| G5 gba.html room integration (copy genesis party UI/driver into gba.html's own inline script; fix `script.js:1004-1007` random `?v=`) | L | G1, G4 | `tools/gba_netplay_test.mjs` scripted 2-seat session, equal fingerprints, named-field desync report; `no_streaming_test` passes gba.html |
| G6 Pace, delay, device budget (measure 2/4 cores in a browser; Worker if main thread can't hold 16.74 ms) | M | G5 | ms/frame + RSS on desktop and low-memory arm with machine load; never faster than 1.000x |
| G7 Lobby, catalogue, standing gates (`SOLO.gba=['Sim City 2000']`, `CODE_TAGS` gba `B` + arena `A` in **one** commit + HEAD-mode restamp; handoff `/gba.html?np=`, hostFlag `host=1`) | M | G3, G5 | `multiplayer_page_test`, `multiplayer_page_browser_test`, `no_streaming_test` (expect **11** online pages, not 10), `stamp_lib_versions --check` equal baseline |
| G8 Out of scope, each with a failing `verify()` in `tools/undelivered.mjs` (Wireless Adapter XL; Single-Pak L; mixed-ROM rooms; spectators) | XL | G7 | entries exist and fail while the gap is real |

## Part 3 — Arena: a standalone Stadium/Champions-style game on SoulGold data

**Data (measured, ROM md5 above, `Pokemon SoulGold (v1.1.1).gba`, 33,554,432 B, header `POKEMON EMER`/BPEE).**
It is an Emerald-engine hack with an expansion-style data layout: species struct stride 0x118 at 0x7c7310
(**1038** non-empty slots in ids 1..1577, 539 zero), moves 0x769860 stride 0x48 (935 real), abilities 0xef6e44
(523), items 0x7451d8 (930), type chart 21×21 UQ4.12 at 0x43b8b4, natures 0xef5cac, EXP rows 0x889500, cries
0x15cb0dc (BDPCM), save-slot layout table 0xf32f6c (SaveBlock2 0xB30 / SaveBlock1 0x3C54 — **non-vanilla**).
Sprites use the expansion's **"smol" tANS compression, not LZ77** (2,076 pics decode with 0 failures, ~106-115 ms
in Node; ~2.83 MiB graphics, ~5.32 MiB cries). The critic independently re-read the species/move tables and
the ROM hash; the type chart was only histogram-checked, not diffed cell by cell. "pokeemerald-expansion" is an
inference from ROM-internal evidence, not a confirmed project name.

**Strategy.**
- *Data:* derive everything at runtime in the visitor's browser from the ROM the site already serves
  (`caseybement.com/gamedata/...` serves 206 Range + full 200 and matches the local md5 — critic's curl);
  cache the decoded pack in IndexedDB keyed by ROM hash; commit only `arena/manifest.json` (hashes/ids).
- *Engine:* hybrid — vendored `@pkmn/sim` 0.10.12 (MIT) as rules core + a ROM-generated "soulgold" overlay mod
  (934/935 moves and 310/522 abilities map to PS ids; 155 species-assigned custom abilities need hand handlers;
  `coverage.json` fails closed on any UNMAPPED reachable entry). Explicit seed and gender; stat formula overridden
  with the ROM-faithful Gen 3 one. Rejected: from-scratch (XL), decomp port (no licence on pret repos), `@pkmn/engine` (Gen I/II only).
- *Profiles:* no server. IndexedDB `arena` DB, versioned schema, keyed EV/IV objects, derived stats never stored,
  `.arena.json` export/import, `ARENA1.` team codes. One pure `rules.js` validates identically in the editor and
  on the opponent's incoming card. Default ruleset: Gen 3 Standard (EV ≤255/stat, ≤510 total, IV 0-31, Lv50).
  A "Strict Champions" layer (66 points total, 32/stat) rides on the same stat engine; no VP economy.
- *Save import (Transfer-Pak analog):* table-driven `.sav` parser using the ROM's save-slot table, per-mon checksum,
  accepts 0x20000/0x20010/0x22000 B, never writes back. Needs `Export .sav`/`Import .sav` added to gba.html.
- *Netplay:* the unmodified Lockstep engine with **frame = a fixed 30 Hz tick, not = a turn** (a turn-per-frame
  mapping would apply every choice D turns late: `netplay.js:1891, 3790, 6167`); commit-reveal for choices and
  RNG halves; teams travel via `contributeCards`; `rsReplay` true.

| ID | Size | Deps |
|---|---|---|
| R0 ROM data contract + pack decoder (Worker, smol decoder, manifest drift test) | L | — |
| R1 Rules, stats, formats | M | R0 |
| R2 Profile store, export/import, team codes | M | R1 |
| R3 Save import | L | R0, R2 |
| R4 Shell + editor UI (phone width, 44 px targets, capability gate) | L | R1, R2 |
| R5 Presentation assets (sprites, icons, cries) | M | R0 |
| R6 Battle engine: PS + SoulGold overlay, coverage gate, cross-engine determinism | XL | R0, R1 |
| R7 Match protocol over Lockstep | L | R6, R2 |
| R8 Lobby, tags, standing gates | M | R7 |
| R9 Rentals, CPU opponents, replays, ladder | L | R7 |
| R10 ROM-oracle conformance (Cable Club battles as fidelity oracle) | L | G3, R6 |

Shared between both: one `CODE_TAGS` + restamp commit; the same seat-save pattern; `Export .sav`; the working
SoulGold Cable Club (G3) becomes the fidelity oracle for the Arena engine (R10).

## Part 4 — Blockers and gaps the critic raised (not in the synthesizer's plan)

1. **[blocker] LFS.** `git check-attr filter -- gba/mgba/dist/mgba_room.wasm` printed `filter: lfs` (blanket
   `*.wasm filter=lfs`, `.gitattributes` line 2). Every emulator wasm has an override line; CI checks out with
   `lfs: false` (`deploy.yml:84,191`; `audit.yml:72`). Without an override line the page ships a 132-byte pointer
   (the genesis comment records this exact failure on 2026-09-07). Fix in the **same commit** as the first mGBA
   artifact: `gba/mgba/dist/*.wasm filter= diff= merge= -text`, plus an exit test that `git cat-file -p :<path> | head -c4` is `\0asm`.
2. **[blocker] No battle screen in the plan.** Nothing turns the `@pkmn/sim` protocol log into HP bars, sprite entry/faint,
   menus, team preview, text box, turn timer. Needs its own workstream (L or XL) between R5 and R7, and a **scope decision** on how close to Stadium the presentation is (2D sprites only? move animations? mini-games? 3D?).
3. **[major] No synchronous SHA-256 in the repo** (`netplay.js` uses async WebCrypto for PBKDF2/HMAC; in-engine hashes are FNV-32). Commit-reveal inside the tick needs a vendored pure-JS SHA-256 with NIST vectors, or hashing off-tick with only the verified result entering the register.
4. **[major] R7 receipts "signed by both profile keys" but R2's schema has no keypair.** Add an identity step (ECDSA P-256 is the safer WebCrypto choice; storage/export policy; key-loss behaviour).
5. **[major] Disconnect policy for GBA rooms never chosen** (`rsReplay` re-simulates from frame 0 — ~107,000 frames × up to 4 cores for a 30-minute room). Pick on/off and measure.
6. **[major] Deploy plumbing:** add the Arena ROM URL to `tools/catalog_urls.mjs`; add `gba/mgba` build/source paths to `deploy.exclude`.
7. **[major] Toolchain:** cmake/ninja absent; `genesis/genesisWasm/build.sh` defaults to the repo's `emsdk/` (no `upstream/`) and calls `python3` (Store shim). Pin `EMSDK_ENV=C:\em\sdk\emsdk_env.sh`, use the emsdk python by absolute path.
8. **[major] `@pkmn/sim` cross-engine determinism untested**; no SpiderMonkey/JSC shells locally (jsvu can install them). Slim bundle size (~0.4 MB gz) is an estimate; unpacked package is 46,120,775 B / 858 files.
9. [minor] A "TurnSync" fallback in the plan is a different architecture from the binding directive — needs the user's sign-off before it is built.
10. [minor] Per-title save-type table for mGBA's autodetect (Super Bust-A-Move has no save-library string at all).
11. [minor] gba.html/script.js edits by two workstreams (R3 save buttons first, then G5); sibling agents have dirty files — commit with pathspecs.

## Part 5 — Corrections worth remembering (33 total; see journal)

- "Emerald link ~15 transfers/frame" → **9** (CMD_LENGTH 8 + 1 checksum; `link.h:6`; gpSP `serial_proto.c:93-101`).
- "This machine cannot build wasm" → **false**: `C:\em\sdk` has Emscripten 6.0.2 (cmake/ninja are what's missing).
- "Several shipped titles are RTC carts" → **only SoulGold** carries SIIRTC_V; Ultra Violet needs no RTC pin.
- "Every link ROM uses Multi-Play only" → Kirby and Sonic Advance 3 also use Normal-32/Sio32.
- `cardSetHash` omits `enc`, so clock/save-type must be folded into the disc string (as gamecube does).
- Re-stamp lib versions in default HEAD mode, never `--worktree`.

## Part 6 — Baselines to record before the first change

`node tools/multiplayer_page_test.mjs` → 37 passed / 1 failed (n64 list lacks GoldenEye 007 and Smash Remix 1.0.1);
`node tools/stamp_lib_versions.mjs --check` → 17 pages / 6 libs / **19 stale references**;
`node tools/no_streaming_test.mjs` → "9/9 online pages are lockstep-only; 6 not in scope" with `n/a gba.html`.

## Part 7 — Decisions only the owner can make

1. **Asset posture for the Arena:** derive everything at runtime from the site-hosted ROM and commit only hashes (default), or commit pre-extracted data/sprites/cries; and may the Arena rely on the site-hosted ROM or must the visitor supply their own? (IP/ownership call.)
2. **Solo-core policy for gba.html:** keep 44vba for solo and use mGBA only in rooms (default; preserves existing IndexedDB `.sav` keys and state snapshots), or migrate solo to mGBA.
3. **SoulGold version policy:** pin to the shipped v1.1.1 (md5-gated, default) or track the hack's releases (changelog current stable is v1.2.1).
4. **Battle presentation scope** (from the critic): 2D sprite battle only, or animations / mini-games / 3D.

## Part 8 — Status of the GBA workstreams (written 2026-11-02 by stage GR5; the Arena half is NOT covered)

**How to read this.** "Done" means the stage's own exit test passed and an independent verifier re-ran it. Every number is cited to its source:
`README` = `gba/mgba/README.md`; "lead 11-02" = counts the lead re-ran in Node and reported on 2026-11-02; "GR5 11-02" = a run made by this stage on 2026-11-02 on the
shared Windows box (Windows CPU busy 12% at the start of the browser suites; Windows has no load average, and none of this is a device number).
`gba/mgba/dist/mgba_core.wasm` md5 `13474b3883009819a5ac7304e568cb0a` (791,107 B) and `mgba_core.js` md5 `b2d6dba079610b9edc18ee994eb2a0b4` were identical before and
after every GR5 run. **Nothing here ran on a real phone, with a second human, over a real network, or through a real audio device.**

| ID | Plan item | Status | Evidence | Not done / caveat |
|---|---|---|---|---|
| G0 | Reproducible single-thread mGBA build | **DONE** on this machine and toolchain | wasm 791,107 B; zero `SharedArrayBuffer` / `new Worker` / `pthread` / `Atomics` strings (README "No threads"); `tools/gba_mgba_build_test.mjs` 68 passed 0 failed Node-only (GR5 11-02); 81 passed `--browser --rebuild` against the G1-fix artifact (README "Tests") | two-clean-builds equality was NOT re-measured on the current artifact (README "Reproducibility"); the `.gitattributes` LFS override and the `deploy.exclude` rows are uncommitted; the staged-blob check (`git cat-file -p :gba/mgba/dist/mgba_core.wasm`) cannot run until the file is staged; other OS / emsdk untested |
| G1 | Cooperative multi-core bridge | **DONE** | 1-4 seats in one wasm instance, one shared ROM mapping, fixed 192 MiB heap; `tools/gba_mgba_core_test.mjs` 117 passed 0 failed (lead 11-02; GR5 11-02 the same); the core test's soak is chain-identical (default 3,000 frames; 20,000 at G1; 100,000 frames across 5 time zones in the G2 probe) (README) | a genuine link wedge and the watchdog Recover path were never exercised (only forced through a debug hook) |
| G2 | Determinism pins (RTC epoch + fixed UTC offset) | **DONE** | `tools/gba_room_determinism_probe.mjs --browser` 52 passed 0 failed (G2 report); default run 45 passed 0 failed (README); 5 host time zones x 100,000 frames, all 1,667 sample points equal | `--frames 20000` is false-red (README); no on-screen clock was reached; Cable Club + RTC together untested; the zone pin is a fixed offset (no DST) by design |
| G3 | Link-correctness matrix | **DONE for 3 titles, PARTIAL overall** | `linked`: Super Bust-A-Move 2 seats, Kirby 2/3/4 seats, Sonic Advance 3 2 seats; `could-not-reach`: Monster Rancher Advance 2; `tools/gba_link_smoke.mjs` 16 passed 0 failed (GR5 11-02) | Pokemon SoulGold NOT run (no save made in a Pokemon Center exists): no passing row, so it is not roomable, and R10 (the Arena's fidelity oracle) has no oracle yet. The plan's Emerald figure (9 serial IRQs per frame) was not observed on any tested title (it belongs to the Cable Club) |
| G4 | Seat / save / disc protocol | **DONE**; the engine-level gap this row listed is CLOSED (2026-11-02, after the lead authorised it) | `tools/gba_room_protocol_test.mjs` 411 passed 0 failed (lead 11-02); crash sweeps of 925 + 75 runs (README "Rooms"); the engine card cap: `lib/netplay.js` `cardLimits` (opt-in, off by default; `gba.html` passes `ROOM_CARD_LIMITS` = `{ maxCardBytes: 135240, maxPieces: 12, maxCards: 4 }`), `node tools/gba_card_cap_test.mjs` (asserts: the 20,000-piece / 245,760,000 B flood is held with no limits, dropped with them, held again with the cap cut out of a copy of the engine; a 24 MiB card still passes without the option) and `tools/gba_netplay_test.mjs --browser --only cap` (the same flood into a real room: refused by seat on the page, nothing held) | The cap protects the engine's memory; it does not make a hostile peer's seat go away - the host sees "Seat N's save was refused" and the room waits at the barrier until that seat is removed. The in-doubt window at the end of a room is irreducible (README) |
| G5 | `gba.html` room integration | **DONE, with limits** | `tools/gba_netplay_test.mjs --browser` 179 passed 0 failed, solo `--browser` 196/0, page standard `--browser` 167/0, `no_streaming_test` 10/10 (all lead 11-02); GR5 11-02 re-ran solo 196/0, page standard 167/0 (static leg 56/0), `gba_netplay_test` static 34/0 and `--browser --only static,ux` 42/0, with GR5's `lib/` edits in place | **B1(d)**: the solo core's 192 MiB heap cannot be proven released when a room boots its own (the garbage collector decides). **B9**: the family hamburger is left at family parity (38 x 38 box, 44 x 44 hit area; only the page's own `#mNet` was raised to 44 px). **Open owner decision (gate 9)**: a rejoining page catches up by replaying the room's history as HIDDEN frames at about 10x hardware or more (one measurement), then runs at 1.000x; the alternative, `rsReplay` off, forbids rejoining. The 100 ms / 4-frame tick cap and the 3-frame start delay are starting values |
| G6 | Pace, delay, device budget | **NOT DONE** (stage GR3 had not run when this was written) | none | no phone, tablet or low-memory device measured; no per-device seat cap; no Worker decision; the only ms/frame figures are shared-desktop Node and headless-Chrome numbers (README "Measurements") |
| G7 | Lobby, catalogue, standing gates | **NOT DONE here** (stage GR4 runs in parallel; whatever it reports supersedes this row) | `gba_multiplayer.html` is a redirect that carries `np`, `game`, `host`, `join`, `seats` and `net` through to `gba.html`; `stamp_lib_versions --check` 17 pages / 6 libs / 0 stale (lead 11-02; GR5 11-02) | `SOLO.gba`, the `CODE_TAGS` pair (`B` for gba, `A` reserved for pokemonarena) and the lobby's GBA entry are not recorded here as done |
| G8 | Out-of-scope entries, each a standing check that must keep reading OPEN | **DONE** (the entries); the gaps themselves stay open by decision | `node tools/undelivered.mjs` prints `12 open · 3 stale` (13 open before the engine card cap was built, when its entry `gba-room-save-card-has-no-engine-size-cap` was deleted because its gap closed; HEAD's copy of the file printed `4 open · 3 stale` against this tree: the 3 stale entries - a relayed-room loss burst and two GameCube ones - predate this stage and were not touched); 12 negative controls (one mutation per entry) plus the unmutated twin all behaved (GR5 11-02; the deleted entry's control went with it) | asked for: Wireless Adapter / RFU, Single-Pak multiboot, mixed-ROM rooms, spectators, SoulGold Cable Club, low-memory hardware. GR5 ADDED two that remain: the rejoin-replay owner decision, and "never run over the shipped PeerJS transport" (it added a third, the engine card cap, which has since been built and removed from the list) |

**Plan statements that no longer hold.**
- Part 1: `gba.html` does **not** run 44vba any more. Solo play runs on the mGBA core too (stage G3; 196-check `tools/gba_mgba_solo_test.mjs`); `?core=44vba` was dropped; the 44vba
  files (`gba/gbaWasm/dist/44gba.*`) stay in the repo, unused by any page. Part 2's "44vba stays for solo play" and the *default* of Part 7 decision 2 ("keep 44vba for solo") were
  **not** followed: the build migrated solo to mGBA. I found no record in the files I read of the owner choosing that, so it is **still an owner decision to confirm**. What it cost:
  a legacy battery is converted once to `<rom>.mgba.sav` (the old key is left byte-identical); an old-core savestate cannot be loaded by mGBA, so the page reports it and leaves it untouched.
- Part 7 decision 3 (SoulGold version) was applied as the default: pinned to v1.1.1, md5 `b2c5caf9bc6dd28a44052427ee3ab1b7`, md5-gated in `room.js` `TITLES`.
- Part 6 baselines: `stamp_lib_versions --check` was 17 / 6 / 19 stale and reads 17 / 6 / 0 stale now (HEAD mode: it hashes the committed files, so GR5's uncommitted `lib/` edits do
  not show until they are committed). `multiplayer_page_test` (37 passed / 1 failed, n64) and `no_streaming_test`'s "online pages" count belong to stage GR4 and are not re-recorded here.

**What stage GR5 changed (tooling), all uncommitted, and each re-run where a runner exists on this box.**
- `lib/bench.js`: the `A.gba` adapter timed `Module._emuRunFrame`, which no longer exists, and pressed `#btnPlayGame`/`#romselect`, which no longer exist. `?bench=1` on `gba.html`
  returned `solo: null, pass: false` before; after, it records per-frame core cost (SoulGold, 10 s window, 610 frames: ms mean 0.85 / p95 1.4, speed 1.0014x, `pass: true`).
  It has no room phase for gba (while a room runs `myApp.core` is null and the cores live inside `room.js`).
- `lib/debugreport.js`: `SPOTS.gba` named the Bootstrap page (so the library placed zero buttons) and had no `party` entry; it now has the genesis shape plus `party`, so the Party
  panel's Copy debug can come from the shared function. The AUDIO line read `myApp.audioFifoCnt`, which is `undefined` on the mGBA page (`fifo: undefined of 4900 frames`); it now reports
  the core's programmed rate and the `__cartAudio` sink counters. `gba.html`'s own block that mounted the same four buttons (GR2) was redundant and has been REMOVED (GR2 follow-up; the shared function now places all four, one each, verified in the browser).
- `lib/audiodiag.js`: comment only (its code is identical to HEAD once comments are removed).
- `tools/verify_deploy_assets.mjs`: the `44gba.wasm` row (a load the page no longer makes) is replaced by `mgba_core.wasm`, `mgba_core.js`, `mgba_core.js` (adapter) and **`gba/mgba/room.js`**,
  which is loaded by a dynamic `import()` that no URL scanner can see: the old verifier did not notice a staged tree without it.
- `tools/mobile_input_latency.mjs`, `tools/mobile_chrome_test.mjs`, `tools/control_map_drift_test.mjs`, `tools/audit_all.mjs` (a `gba-netplay` entry; the `gba-state-persist` text),
  `tools/undelivered.mjs` (9 GBA entries; the card-cap one was deleted afterwards, 8 remain), `tools/debugreport_test.mjs` (the gba fake DOM), comment-only notes in `tools/mp_page_test.mjs`, `tools/audit_netplay_guest_quality.mjs`,
  `tools/audit_peerjs_crossdevice.mjs` and `tools/gba_link_smoke.mjs`, and the new `docs/gba-link-rooms-testing.md`.
- **A restamp after commit must rewrite `?v=` for `lib/debugreport.js` and `lib/bench.js`** on the pages that load them (`node tools/stamp_lib_versions.mjs`, default HEAD mode, never
  `--worktree`). `--check` stays green until then because it hashes `HEAD`. `lib/audiodiag.js` is not in the stamper's list.

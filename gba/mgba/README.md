# gba/mgba - mGBA as a single-thread WebAssembly core with a multi-core link bridge (stages G0 + G1)

Reproducible build of [mGBA](https://mgba.io/) (MPL-2.0) to WebAssembly, plus the site's own bridge that hosts **N linked GBA cores in one
wasm instance** (plan: `docs/gba-link-and-arena-plan.md`, Part 2, workstreams G0-G1). **No SharedArrayBuffer, no Worker, no pthreads**: the
module runs on a page that is not cross-origin isolated (measured, below).

Status: **G0 + G1 + G2 + G3 + GR1 + GR2 + GR3.** `gba.html` SOLO play runs on this core (G3, one seat, host clock) and, since GR2, it forms **lockstep link-cable rooms** itself (section "The room page");
`window.__gbaNet()` reports `core:'mgba'` and `supported:true` where WebRTC + BroadcastChannel exist. The lobby (catalogue, `CODE_TAGS`) and `lib/netplay.js` are untouched. The kill-switch question of G1 - "do real titles reach their linked state when the cores are
stepped cooperatively on one thread?" - is answered **yes** (matrix below). GR1 adds `room.js`, the transport-agnostic room / seat / save / disc protocol (sections "Rooms" and "Determinism pins").

| File | Role | Served? |
|---|---|---|
| `build.sh` | the whole build, from a pinned clone to `dist/` | no |
| `patches/*.patch` | four patches applied to the pinned source (see `SOURCE.md`) | no |
| `bridge/bemental_gba.{c,h}` | **the bridge**: N seats, shared ROM, cooperative frame loop, witnesses (`bgb_*` exports) | no (source offer: `SOURCE.md`) |
| `bridge/legacy_mgs.c` | the fork's `mgs_*` ABI on top of the bridge, so older glue and `tools/gba_mgba_build_test.mjs` keep running | no |
| `mgba_core.js` | **the JS API** (`window.MgbaCore` / `require`) | yes |
| `room.js` | **the room protocol** (pure ES module: config, disc string, save exchange, machine boot, in-band clean end, persistence plan, disconnect policy) - section "Rooms" | yes |
| `dist/mgba_core.{js,wasm}` | the module (Emscripten factory `createMgbaCore`) | yes |
| `dist/mgba_core.buildinfo.json` | commit, patch digest, bridge digests, toolchain, defines, md5 of both outputs (no timestamps) | yes |
| `SOURCE.md`, `LICENSE-MPL-2.0` | the MPL-2.0 source offer and license text | yes (see `deploy.exclude`) |
| `README.md` | this file | no |
| `tools/gba_mgba_core_test.mjs`, `tools/gba_link_smoke.mjs` | G1 exit tests / the kill-switch rig (repo root `tools/`) | no |
| `tools/gba_mgba_build_test.mjs` | G0 exit tests | no |
| `tools/gba_room_determinism_probe.mjs` | G2 determinism probe (pinned RTC / time zone soak) | no |
| `tools/gba_room_protocol_test.mjs` | GR1 exit tests for `room.js` (real Lockstep engines, real cores, mutants) | no |
| `tools/gba_netplay_test.mjs`, `tools/headless_cdp_multi.mjs` | GR2 exit tests: the real `gba.html` in N headless Chrome windows (section "The room page") | no |
| `tools/gba_room_budget_test.mjs`, `tools/gba_room_budget_measure.mjs` | GR3 exit tests (pure functions with mutants, the extracted `_roomTick` model, the page at 30 s / throttled / low-memory / 3 windows) and the measurement rig behind the numbers (section "Budget") | no |
| `tools/gba_card_cap_test.mjs` | the engine card cap (`lib/netplay.js` `cardLimits`): the hostile flood held/dropped/held-again-without-the-cap, each refusal reason, honest cards, and an unchanged 24 MiB card without the option (section "Known limits of the room page") | no |

## Build

```bash
bash gba/mgba/build.sh            # incremental; writes gba/mgba/dist/
bash gba/mgba/build.sh --clean    # wipe the build tree first (what the reproducibility measurement uses)
MGBA_OUT=/some/dir bash gba/mgba/build.sh --clean   # write elsewhere, leave dist/ alone
```

Run from Git Bash (Windows host defaults; `EMSDK_ROOT`, `BUILDTOOLS`, `MGBA_SRC`, `MGBA_BUILD`, `MGBA_INITIAL_MEMORY`, `JOBS` override them).

| Pin / tool | Value | Where it is recorded |
|---|---|---|
| Source | `Spuds0588/mgba-splitscreen` @ `f1d5975d77285f77affbfe64b7050ebd5c4b6a77`, cloned to `~/mgba-src` | `build.sh` `MGBA_REV`, `SOURCE.md`, `dist/mgba_core.buildinfo.json` |
| Emscripten | 6.0.2 (`7a2d97d627ff4945eae28847ce0387ac52b92c09`) from `C:\em\sdk` | `build.sh` aborts on any other version (`EMSCRIPTEN_EXPECT`) |
| cmake / ninja | 4.4.4 / 1.13.2 from a pip venv at `C:\em\buildtools` made with the emsdk's own python (PATH `python` is a Microsoft Store shim and is never used) | created by `build.sh` if missing |
| Node (tests) | 24.19.0 | |

What `build.sh` does, in order: (1) sources the emsdk, prints and checks every tool version; (2) creates `~/mgba-src` if absent (`core.autocrlf=false`),
fetches the pinned commit **by SHA** and refuses to continue unless `HEAD` equals the pin; (3) applies each patch from a CR-stripped copy
(already-applied patches are detected by reverse-apply) and refuses a tree that differs from the pin by anything but the patched files; (4) `emcmake
cmake -G Ninja` with every optional dependency named OFF, then `ninja mgba`; (5) reads the compile database, requires one identical define set across
all libmgba translation units, **aborts if any `pthread` token is in any compile command**, and reuses that exact define set for the bridge; (6) `emcc`
compiles `bridge/*.c` and links them with `libmgba.a`; (7) copies the output and writes the buildinfo.

**Why not the fork's own `mgba-splitscreen/web/build.sh`** (measured against the pinned commit): its `-DUSE_PTHREADS=OFF` was overridden by an unconditional
`set(USE_PTHREADS ON)` at `CMakeLists.txt:233`, so the "single-threaded" libmgba was compiled with `-pthread` (143 lines of `build.ninja`);
`patches/0001` makes the option real. Its autodetection also latched onto `USE_FREETYPE`/`USE_DISCORD_RPC` from the emsdk's port cache, so every optional
dependency is OFF here, `-DSKIP_GIT=ON` keeps the git state out of `version.c`, and `-ffile-prefix-map` strips host paths. Upstream `mgba-emu/mgba` + a
patch set instead of the fork was not evaluated.

## What the bridge does

One wasm instance hosts **N = 1..4 seats**, each a full mGBA GBA core, **the same ROM in every seat** (different battery saves, different key streams).

- **N = 1 is a clean fast path**: no coordinator, no sleep flags, mGBA's own `runFrame()`. `witnesses().attached == 0`, `hashLink() == 0`.
- **N >= 2** wires the seats through mGBA's lockstep link coordinator (the fork's `src/gba/sio/lockstep.c`: ack barrier for >1 secondary, no-sleep-after-ack,
  `GBASIOLockstepCoordinatorRecover`) and steps them cooperatively on the calling thread, in seat order. **The Four Swords assist is not in the binary**
  (`patches/0002` deletes it; the test greps the wasm for it). Seat *i* always has wire id *i* (the bridge answers the coordinator's `requestedId`), so seat 0 is
  the master/primary - without that the id would follow hash-table iteration order.
- **The frame loop** (`bgb_run_frame`, a re-statement of the fork's `sp_run_frame`/`mgs_run_frame`): every call owes **every seat one video frame**, counted in the
  core's own frame counter (an absolute target, `target[i] += 1`). It is *not* a per-call cycle budget: a budget that is reset every call discards the overshoot,
  which - from reading the code, not measured here - would let the guest creep above 1.000x; a frame target cannot. When every seat that still owes a frame is
  asleep (waiting on the link), a seat that is already finished and awake runs on to wake it, **for at most one frame of guest time per call**; a seat that wakes
  another seat **yields** its own `runLoop` (`GBAInterrupt`, the mechanism the driver already uses for sleeping), because a HALTED core is one `runLoop` step that lasts
  until its next interrupt - without the yield the master ended its first call with frame counter 2 while the secondary had 1 (measured).
- **Stalls are incidents, not heals.** If nothing can move while a seat owes a frame, `runFrame()` returns the `STALL` bit, `witnesses().stalls` counts it and
  `incidents()` records the sleep/done masks and the coordinator's barrier at that moment. The fork's watchdog (`Recover` after ~60 frozen frames) is kept but
  is itself an incident (`RECOVERED` bit, `recoverCount`), and `setRecoverAfter(0)` turns it off. A MULTI round that completes without every secondary's ack (the fork
  delivered FFFF and carried on) is an incident too (`MULTI_NODATA`). **No genuine wedge or missed ack occurred in any run made here**; the stall path is exercised with a
  debug hook (`debugForceAsleep`), and the watchdog's actual wake of a wedged coordinator is NOT exercised by any test.
- **One shared ROM mapping.** The ROM is allocated once in the wasm heap and every core maps that buffer through a read-only `VFile` (mGBA already treats a "pristine"
  mapped ROM as read-only and copies it itself before the first write, `_pristineCow`). The fork copied it per core. Cartridges with GPIO hardware (RTC: the Pokemon
  games) make mGBA take that private 32 MiB copy at reset, once per seat (below).
- **Determinism pins** at load: `idleOptimization = IGNORE` (no idle-loop time skipping), `allowOpposingDirections = true`, `useBios = false` (the HLE BIOS only; never a BIOS
  file), a fixed audio buffer size and volume. The cartridge clock is the one thing left to the host until `setRtc()` pins it (the G2 pin, section "Determinism pins"; pin it before or after `loadRom()`, either works).

## JS API (`gba/mgba/mgba_core.js`)

Classic script: `window.MgbaCore` after `<script src="dist/mgba_core.js">` + `<script src="mgba_core.js">`; in Node `require('gba/mgba/mgba_core.js')` (the repo has no
`"type": "module"`, so `import M from` also works). Every method below throws a `RangeError` for a seat outside `0..seats-1`.

```js
const core = await MgbaCore.create({ seats: 2 });      // Promise<Core>; one wasm instance, N linked cores. {print, printErr, locateFile, wasmBinary, factory} optional
const info = core.loadRom(romBytes, { saveType: 'auto' });   // same ROM in every seat -> { title, system, code, maker, version, romSize, crc32, saveType, saveTag, romPristine, seats }
core.setSave(0, savBytes);                             // before the first frame (a room does all of this through room.js bootMachine)
core.setKeys(0, mask); core.setKeys(1, mask);          // held buttons for the NEXT frame (low 10 bits only)
const status = core.runFrame();                        // EVERY seat advances exactly one emulated frame; 0 = clean
ctx.putImageData(new ImageData(core.video(0), 240, 160), 0, 0);
```

| Call | Contract |
|---|---|
| `MgbaCore.create({seats})` | `seats` 1..4. Instantiates the wasm (fixed 192 MiB heap). |
| `loadRom(bytes, {saveType})` | 192 B .. 32 MiB, must carry the GBA header signature (`ROM_SIZE`, `NOT_A_GBA_ROM`, ... as `err.code`). `saveType`: `'auto'` (mGBA's own detection, decided lazily at the game's first access), `'none'`, `'sram'`, `'sram512'`, `'flash512'`, `'flash1m'`, `'eeprom512'`, `'eeprom8k'` forces it after the per-game defaults. |
| `setSave(seat, bytes)` -> bool | Restores a raw `.sav`. mGBA decides the battery type lazily, and `savedataRestore` on a core that has not decided yet **succeeds and keeps nothing**; the bridge therefore reads the cartridge's save-library tag (`SRAM_V`/`SRAM_F_V`, `FLASH_V`/`FLASH512_V`, `FLASH1M_V`, `EEPROM_V` -> `info.saveTag`), forces the matching type, and **refuses (false)** a save whose size does not fit it. |
| `exportSave(seat)` -> `Uint8Array \| null` | A copy; `null` until the game has touched its save memory (mGBA has not allocated it yet) or when the cartridge has none. |
| `setKeys(seat, mask)` | `A=1 B=2 SELECT=4 START=8 RIGHT=16 LEFT=32 UP=64 DOWN=128 R=256 L=512` (`MgbaCore.KEY`). `mask & 0x3FF` - tested against KEYINPUT. |
| `runFrame()` -> status | **Advances every seat by exactly one emulated frame (280,896 cycles, 59.7275 Hz if called at that rate) and never fast-forwards**; the caller owns the clock. Bits (`MgbaCore.ST`): `STALL 1`, `RECOVERED 2`, `STEP_CAP 4`, `MULTI_NODATA 8`, `NOT_LOADED 0x80`. A non-zero return is an incident: read `incidents()` and surface it. |
| `video(seat)` | `Uint8ClampedArray` **view** (240x160x4 RGBA, alpha forced to 255) of the seat's last completed frame; rewritten in place, so draw or `.slice()` before the next `runFrame()`. |
| `audio(seat)` | `{ samples: Int16Array (view, stereo interleaved), frames, rate }` for the last `runFrame()`. **`rate` is what the game programmed**: 32768 Hz is only the default (Kirby ran at 65536 Hz in the tests: 1096 frames per video frame). |
| `saveState(seat)` / `loadState(seat, bytes)` | The full 0x61000-byte `GBASerializedState` (a copy). On a linked instance restore every seat, then call `linkReset()` once - or use `loadStates([...])`, which does both. `linkReset()` **rebuilds the coordinator** so the link layer is a pure function of the restored seat states. |
| `hash(seat)` | FNV-1a 32 over the **full 0x61000-byte savestate**: CPU registers, VRAM/OAM/palette, IO, EWRAM, IWRAM, audio, timers, DMA, cartridge GPIO/RTC, the event queue and the frame counter. **Not** over the ROM, the battery save, or the link layer. |
| `hashGame(seat)` | `hash()` with state bytes `0x130-0x18B` zeroed (PSG channel 1-4 sequencer fields). mGBA's savestate does not round-trip that block bit-exactly (`save(load(S))` differs from `S` in 6-14 bytes, all in `0x132-0x153`, measured on three games in 30 frames). **That mask is NOT enough to compare a restored instance with one that kept running** (the previous version of this row said it was; it was wrong): other bytes differ (`0x2c4-0x2c8`, plus `0x534-0x535` on SoulGold) and the audio diverges. Measured with the RTC pinned and identical keys after the restore - GR1 (2 linked seats, 600 frames, 30 samples): Sonic Advance 3 `hashGame` differs 30/30, Kirby 14/30 (`hash` 30/30 on both, video frames identical); V3 (the G2/G3 verifier): SoulGold and Sonic Advance 3 30/30, Kirby and Super Bust-A-Move 0/30. **Compare `hash` between machines that ran the same sequence from frame 0 (a room, a replay); never use `hash` or `hashGame` to prove a restored instance equals a continuing one.** |
| `hashLink()` | FNV-1a 32 over the coordinator (clock, barrier, transfer latch, data arrays) and each player's mode, flags, clock offset and queued events; 0 for a solo instance. `hashAll()` folds every seat hash and the link hash into one number. |
| `setRtc({fixedEpochMs, tzOffsetMin})` / `setRtc(null)` | The G2 determinism pin (a room's config carries the pair; see "Determinism pins" below). Pins the cartridge clock: it starts at `fixedEpochMs` at frame 0 and advances only with emulated frames (mGBA `RTC_FAKE_EPOCH`); the calendar is read as UTC + `tzOffsetMin` (minutes east, default 0), never the host zone (`patches/0004`). `rtcUnix(seat)` reads the seat's clock. **Call order does not matter**: `create -> setRtc -> loadRom` and `create -> loadRom -> setRtc` give the same clock, because the bridge remembers the pin and applies it to each core as it is created (mGBA's core init resets a core's clock to the host clock, so a pin written into a core before `loadRom()` used to be discarded without a sound; fixed and covered by `tools/gba_mgba_core_test.mjs --only rtc`). The pin is sticky across a second `loadRom()` and `reset()`; savestates do not carry the clock source, so `loadState()` cannot change it. A bad `fixedEpochMs` (NaN, infinite, missing, a string, beyond +-9e15 ms) or `tzOffsetMin` (beyond +-1440) throws a `RangeError` and leaves the previous pin alone. |
| `read16(seat, addr)` / `read32` | Side-effect-free reads (IO registers, RAM, ROM). |
| `witnesses()` | see below. |
| `incidents()` | up to the last 64: `{ n, call, kind: 'loop-stall'\|'recover'\|'step-cap'\|'multi-no-data', asleepMask, doneMask, waiting, transferActive, multiNoData, recovers }`. |
| `cycles(seat)`, `frames(seat)` | emulated cycles since reset (exact integer) and the core's own frame counter. |
| `reset()`, `setRecoverAfter(n)`, `drainLog()`, `setDebugLog(on)`, `memory()`, `close()` | power cycle (battery saves kept); stall watchdog threshold (default 60, 0 = never heal); mGBA WARN+ lines; `{heapBytes, highWater}`. |

**`witnesses()`** returns `{ seats, calls, frames[], linked, clean, transfers, transfersLast60, multiRounds, multiRoundsLast60, serialIrqs[], serialIrqsLastFrame[],
serialIrqsPerFrame[] (mean of the last 60 frames), stalls, stallDetail{loopStalls,multiNoData,stepCaps}, recoverCount, incidents, attached, masterSioMulti1,
masterSioMulti1Live, masterWords[4], masterSioCnt, masterRcnt, aheadSteps, linkSleeps, linkWakes, yields, ... }`.
`masterSioMulti1` is the word the master was handed from seat 1 **at the end of its last completed round** (what SIOMULTI1 reads after a round); `masterSioMulti1Live`
is the register at the call boundary, which is `FFFF` whenever a transfer is in flight (mGBA clears SIOMULTI1-3 when a transfer starts), so do not use it as the witness.
`linked` is the structural signature only (every seat attached, transfers and data-carrying rounds in the last 60 frames, slave word not FFFF); it does not say the *game*
is in a link screen - combine it with the screen. `clean` is "zero incidents so far".

## Link results (the G1 kill switch): `node tools/gba_link_smoke.mjs`

Every title was walked out by hand with screenshots; the scripts are deterministic key streams (same build = same frames). "Linked" = the SIO leg (above witnesses, sampled
over the last 120 frames, zero incidents over the whole run) **and** a per-title scene leg read off the framebuffers. PNGs below are in
`C:\Users\Admin\AppData\Local\Temp\claude\C--Users-Admin-Dev-Bemental77-github-io\c96e71fd-a869-4d47-86d5-aa19395edeed\scratchpad\G1\smoke\`.

| Title | Seats | Route | Outcome | Evidence observed |
|---|---|---|---|---|
| Super Bust-A-Move | 2 | title -> language -> **2P BATTLE** -> MODE SELECT -> PLAYER SELECT -> 1P vs 2P board; only seat 0 plays 3 shots, then only seat 1 | **linked** | 1020 rounds in the last 60 frames (17/frame), 30,454 rounds in all, slave-1 word `0x0000` (never `FFFF`) at round ends, serial IRQs **17 per frame on seat 1, 0 on seat 0** (the master polls: its SIOCNT IRQ bit is off), 0 incidents. The game itself gates on the cable: a solo core stops at `PLEASE WAIT` (`control_solo_modeselect.png`) and a master whose seat 1 is idle never leaves it. **Input crosses the cable:** muting only seat 0's buttons changes what *seat 1 draws* of the P1 board, and muting only seat 1's buttons changes what seat 0 draws of the P2 board, while an identical twin run draws identical boards (`crossInputFlow()`, `cross_*` PNGs). (Equal screens alone prove little: SBAM auto-fires an idle shooter, so an earlier version of this rig that read the score `1P 000000050` as proof was wrong and was replaced by this differential.) |
| Kirby: Nightmare in Dream Land | 2, 3, 4 | SUB-GAMES -> Quick Draw -> MULTIPLAYER | **linked** at 2, 3 and 4 | `TRANSMITTING...` shows `P1..P4` one per seat, the master gets `OK?` (`kirby-4p_transmit.png`), then the Quick Draw tutorial (`kirby-4p_quickdraw.png`); 1 serial IRQ/frame idle, 5/frame in the tutorial, **on every seat**; 0 incidents (the 3- and 4-seat runs exercise the multi-secondary ack barrier). |
| Sonic Advance 3 | 2 | name entry -> BATTLE -> MULTI-PAK MODE -> CHECKING COMMUNICATION | **linked** | the master shows `2` players and `PRESS START`, then `PLEASE SELECT A PLAYER CHARACTER` with the slave held behind the wait overlay (`sa3-2p_charselect.png`); 17 serial IRQs/frame on seat 1, 0 on seat 0; the words at round ends are `FFFF` while it is checking and `0xFF00`/`0x0000` after the master presses START. |
| Monster Rancher Advance 2 | 2 | title `LINK` | **could not reach** | `LINK` ignores `A` with no save file (`mra2-2p_after_link_A.png`, zero transfers); `NEW GAME` plays an intro that did reach a dialogue at the AGE Monster Association but not a savable ranch in the scripts tried (A-mash to frame 20,236 sat on an empty text box in a town square; with other buttons it advanced to `AGIMA: We hope you do well`). It was not driven further. |
| Pokemon SoulGold | 2 | **not automated** | not run | Cable Club needs a save inside a Pokemon Center; none exists on this machine. Manual recipe below. |

The Emerald-style figure from the plan ("master chains 9 transfers per frame, >= 9 serial IRQs per VBlank") was **not** observed on these four titles: it belongs to the Pokemon
Cable Club. Observed rates are the table's numbers; Super Bust-A-Move and Sonic Advance 3 run ~17 rounds per frame, Kirby 1-5.

### Manual SoulGold Cable Club recipe (not automated)

1. Solo instance (`seats: 1`), `setRtc({ fixedEpochMs: <any fixed ms>, tzOffsetMin: 0 })`, play SoulGold v1.1.1 (`b2c5caf9...`) to a Pokemon Center and save in-game; `exportSave(0)` -> `a.sav`. Repeat for a
   second trainer -> `b.sav` (or reuse `a.sav`; two distinct trainers show more).
2. `create({ seats: 2 })`, `setRtc(<the same pin>)` and `loadRom` (either order), `setSave(0, a.sav)`, `setSave(1, b.sav)` **before the first frame**; the heap holds this (100.9 MiB of 192).
3. CONTINUE on both seats, walk to the Cable Club counter (second floor, right-hand desk) on each, choose a trade/battle.
4. Pass criteria: both seats reach the link room (`Trade Center`/battle room); `witnesses()`: `attached == 2`, `transfersLast60 / 60 >= 9` (the plan's Emerald figure), `incidents == 0`,
   `recoverCount == 0`, and `masterSioMulti1` not `0xFFFF` at round ends. The Wireless Adapter path cannot be served (mGBA has no RFU).

## Determinism pins

Every peer of a room runs its own copy of all N cores and only input words cross the wire, so any byte of the guest that depends on the host is a desync. G2 found what had to be pinned and `tools/gba_room_determinism_probe.mjs` is the standing proof. Numbers in this section are from `node tools/gba_room_determinism_probe.mjs` run for GR1's fix on this machine (Windows 11, Ryzen 7 3800X, Node 24.19.0): **45 passed, 0 failed**, exit 0, 9 min 46 s, `.wasm` md5 `13474b38...` before and after.

| Pin | Where | What it removes |
|---|---|---|
| no idle-loop skipping (`idleOptimization = IGNORE`), opposite D-pad directions allowed, HLE BIOS only (`useBios = false`), fixed audio buffer size and volume | the bridge, at `loadRom()` | host-speed-dependent time skipping and any BIOS file |
| the cartridge clock starts at `fixedEpochMs` and advances only with emulated frames (mGBA `RTC_FAKE_EPOCH`) | `core.setRtc()`; the bridge remembers the pin and applies it to every core as it is created | the host clock (`Date.now()` / `time()`) |
| the calendar the game reads is `gmtime(epoch + tzOffsetMin * 60)`, never the host zone | `patches/0004` (`gmtime_r` in place of `localtime_r`) | the host's time zone and its DST rules |

### `setRtc({fixedEpochMs, tzOffsetMin})` semantics

- **Order does not matter.** `create -> setRtc -> loadRom` and `create -> loadRom -> setRtc` give the guest the same clock (fixed in G1: mGBA's core init resets a core's clock to the host's, so a pin written before `loadRom()` used to vanish silently). The pin is sticky across a second `loadRom()` and `reset()`; savestates do not carry the clock source. A bad `fixedEpochMs` (not finite, beyond +-9e15 ms) or `tzOffsetMin` (beyond +-1440) throws `RangeError` and leaves the previous pin in force. `setRtc(null)` hands the clock back to the host.
- **No DST, by construction.** The zone is a *fixed* UTC offset in minutes east (`-300` = UTC-5): there are no daylight-saving rules to apply, so a room cannot cross a DST change differently on two machines. The price is that a game never shows daylight time during a room. **Every peer must be given the same pair** - that is why `room.js` puts `{fixedEpochMs, tzOffsetMin}` into the room config and the disc string (refused `ROOM_CLOCK` on any difference). Pinning a cartridge with no RTC is harmless (measured on Super Bust-A-Move).
- **Solo play may leave the clock unpinned** (host clock, host zone): `gba.html` solo does, and `rtcWitness().utcOffsetSec` is `null` then, which is the signal that the run is not deterministic across machines.
- `bootMachine()` (room.js) is the one place a room pins the clock: `setRtc` once, with both fields, before the first frame. `tools/gba_room_protocol_test.mjs` section `boot` checks that both fields reach the core (a recording core), and section `frames` checks that the pinned offset reaches the *game*: SoulGold, epoch `1700000000`, latches the clock at frame 9 and decodes to `2023-11-14 17:13:20` at UTC-5 and `22:13:20` at UTC+0.

### `core.rtcWitness(seat)`

What the *game* did with the cartridge clock, read from the cartridge's own state (it does not count as the guest asking, and `rtcUnix()` does not count either):

`{ present, latches, firstUnix, lastUnix, digest, calendarBcd, calendar{year,month,day,weekday,hour,minute,second}, control, lastCommand, devices, pinned, utcOffsetSec }`

`latches` is how many times the guest latched the date/time (`RTC_DATETIME` / `RTC_TIME` over the GPIO port at ROM `0x080000C4-C8`) since the last `loadRom()` / `reset()`; `digest` is an FNV-1a 32 over every value handed out, so equal digests mean two machines gave their guests the same clock sequence; `calendar` is the BCD date the game last latched, decoded (year is `2000 + yy`). A cartridge without an RTC reports `present: false, latches: 0` (Kirby, measured). `tools/gba_mgba_core_test.mjs` has no direct check of `rtcWitness` (a count of the name in that file is 0); it is exercised by the probe below and by `tools/gba_room_protocol_test.mjs` section `frames`.

### The probe: `node tools/gba_room_determinism_probe.mjs`

Each *child* is a separate Node process (own wasm instance) started with a different `TZ` and a different `Date.now()`; it plays a 2-seat room with a fixed seeded key stream and samples, every 60 frames, the full 0x61000-byte state hash of each seat, the link hash and a digest of every frame's video and audio. Two children agree only if every sample agrees. The parent also counts the wasm's five host-time imports (`__gmtime_js`, `__localtime_js`, `__mktime_js`, `__tzset_js`, `_emscripten_date_now`) by wrapping them in the child.

| Check | Result (this run) |
|---|---|
| SoulGold v1.1.1 (the only RTC cartridge we ship), 2 seats, pinned epoch `1700000000000` at UTC-5, **100,000 frames**, 5 hosts: UTC, Asia/Tokyo, America/Los_Angeles (10 s before the US DST change), Pacific/Kiritimati (+14), Asia/Kolkata (+5:30), on host clocks from 1999 to 2100 | chains identical at all **1,667** sample points: seat 0 `77ab2a87`, seat 1 `d1e65270`, link `830bd598`; final hash `0x47d7e330` |
| the game really used the clock | latched **622** times on seat 0, **608** on seat 1 on every host, still reading it in the second half (269 latches at frame 45,000 -> 622 at 100,000); decoded calendar `2023-11-14 17:41:13`, the UTC-5 wall clock (the hosts would have shown 22:13, 07:13, 14:13, 12:13, 03:43 for the pin epoch) |
| the pinned path never reaches the host | 0 calls to `__localtime_js`, 0 to `__mktime_js`, 0 to `_emscripten_date_now`; `__gmtime_js` 1,230 times = the latch count; `__tzset_js` once (lazily, at the first `gmtime_r`; it writes the host zone into libc globals and nothing in the pinned path reads them - the identical chains are the evidence) |
| Super Bust-A-Move, **linked**, 4,800-frame scripted walk into the 2P battle then 100,000 random-input frames, 3 hosts | chains identical at **1,747** sample points: seat 0 `f50e5611`, seat 1 `b2517e8c`, link `4066c7df`; **166,081** MULTI rounds, serial IRQs 0 / 52,610 on the secondary |
| stall watchdog | 0 incidents, 0 loop stalls, 0 un-acked MULTI rounds, 0 step caps, 0 watchdog Recover fires, 0 non-clean `runFrame()` in all 18 children (zero incidents says the path was not needed, not that it works) |
| controls (the probe can fail) | unpinned, zone only differs: diverges at frame 60; unpinned, +5 s of host clock: frame 60; pin differing by one hour of epoch or of UTC offset: frame 60; a one-bit key flip between samples (frame 7,501): caught at 7,560; on a sampled frame (7,500): caught at 7,500; late (98,001): caught at 98,040; in the linked room (soak frame 3): caught at 4,860; the unpinned `__localtime_js` tripwire fires (352 calls) where pinned runs make 0 |
| throughput (a capacity measurement, **not** a 1.000x claim: nothing paced the frames) | one SoulGold child alone: **522** frames/s inside `runFrame()` (462 with the per-frame digests) = 8.7x the 59.7275 Hz hardware rate. Machine load: Windows CPU busy 38.7% before, 65.4% mean / 100% max over 139 samples during the 18-child phase (Windows has no load average) |

The probe prints its own list of what it does **not** prove; in short: other CPUs or OSes, any browser (`--browser` runs the same room in headless Chrome under `Emulation.setTimezoneOverride` and was not run for this fix), real-time pacing (the caller owns the clock), and a game that uses the cable and the RTC at once (SoulGold's Cable Club needs a save made in a Pokemon Center; none exists here). A build without patch 0004 fails the probe (15 passed, 7 failed at G2); that mutant build was not re-made here.

**`--frames 20000` is false-red, and it is not a room.js or core fault.** On an unmodified tree `node tools/gba_room_determinism_probe.mjs --frames 20000` reports `44 passed, 1 failed`: control (2d) puts its late one-bit key flip at frame `max(frames - 1999, 7501)` = 18,001 (`tools/gba_room_determinism_probe.mjs:347`), and the chains show no divergence through frame 20,000 (the independent verifier's `probe20k.log` line 121: `FAIL [control] (2d) ... was NOT caught  no divergence`). At the default 100,000 the same control flips at 98,001 and is caught at 98,040. I did **not** re-run the 20,000-frame mode and I have not established why the flip at frame 18,001 is inert (my guess, unchecked: the scene at that frame ignores UP). The probe is not a GR1 file; the defect is reported, not fixed. Use the default run as the gate.

**Restored versus continuing instances are not comparable.** `hash()` and `hashGame()` both differ between a savestate-restored instance and one that kept running (see the `hashGame` row above and the table in "Rooms"); a room therefore never compares across a restore - a returning page replays from frame 0.

## Rooms

`gba/mgba/room.js` is the room protocol as a pure ES module: no DOM, no `node:`, no network, no storage, no clock, no randomness (a test greps the source for each). Everything outside is passed in: the core factory, the ROM bytes, a codec, the page's storage. Several players, each on their own machine, each running **all N linked cores** in one wasm instance; only 4-byte input words per seat per frame and, once, each seat's battery image cross the wire. The room is deterministic delay-lockstep on the unmodified `lib/netplay.js` `Lockstep` engine at **exactly 1.000x hardware (59.7275 Hz)**: nothing here fast-forwards, and `inputDelay` is a latency knob, never a speed knob.

### What a room does, in order

| Step | Functions | Guarantee |
|---|---|---|
| 1 config | `makeConfig`, `encodeConfig` / `decodeConfig`, `discString`, `compareDisc`, `explainBarrierFailure`, `checkLocalAgainstConfig` | one canonical text; every field that must match is in the **disc string** the barrier compares (`lib/netplay.js` `cardSetHash` omits `enc`, so clock, save type, ROM and core build must be here); a mismatch is refused **by name** |
| 2 saves | `chooseContribution`, `makeSaveEntry`, `verifySaveSet`, `verifySaveEntry`, `readRoomConfig`, `ROOM_CARD_LIMITS` | every machine simulates every seat, so every machine needs every seat's battery image at frame 0; verified on receipt |
| 3 machine | `bootMachine`, `RoomMachine` (`localPad`, `step`, `fingerprint`, `setWantEnd`, `commitPlan`) | the same machine on every peer; one `step()` = one emulated frame |
| 4 end | `endInit`, `endStep`, `endCapture`, `endLocalCtl`, `encodeWord` / `decodeWord` | saves are committed only at a clean end every peer reaches |
| 5 persistence | `planCommit`, `commitSteps`, `runSteps`, `recoverPlan`, `endRecover`, `journalKey` | only the **local** seat is ever written; crash-safe |
| 6 policy | `lockstepOptions`, `baseLockstepOptions`, `DISCONNECT_POLICY`, `CHECKPOINT_POLICY`, `replayCost` | delay lockstep, `rsReplay` on, checkpoints off, rollback off |
| lobby | `ROOMABLE`, `TITLES`, `LINK_ROWS`, `seatRules`, `checkRoster`, `whyNotRoomable` | only titles with a passing link row |

### Config and the disc string

`{ v, game, romMd5, coreBuildMd5, seats, fixedEpochMs, tzOffsetMin, saveTypes[], inputDelay, roomId, players[] }`, canonical JSON with a fixed key order (a reordered, extended or re-spaced text is `ROOM_ENCODING`). The disc string is `gba1|g=<game>|rom=<md5>|core=<md5>|n=<seats>|clk=<epoch>@<tz>|st=<types>|room=<id>|sav=<agreed save-set fingerprint>`. **Not folded, on purpose:** `inputDelay` (the host retunes it mid-room) and `players` (a returning page is a new peer). Refusals carry a machine code and a sentence: `ROOM_VERSION`, `ROOM_GAME`, `ROOM_ROM`, `ROOM_CORE`, `ROOM_SEATS`, `ROOM_CLOCK`, `ROOM_SAVETYPE`, `ROOM_ID`, `ROOM_SAVESET`, `ROOM_DELAY`, `ROOM_NOT_ROOMABLE`, `ROOM_ENCODING`. A barrier failure always has an explanation: two discs that differ only in a field this page does not know, in field order, or in a repeated field are named `ROOM_ENCODING` (field `disc`), and the quoted peer text is clipped - show it as text, never as HTML. A game name is chosen by a peer, so every lookup is an own-property lookup: `constructor`, `__proto__`, `toString`, `valueOf`, `hasOwnProperty` are an unknown title (`ROOM_GAME` / `ROOM_NOT_ROOMABLE`), never a `TypeError`.

### Save exchange

Each peer contributes the image of **its own seat** through `contributeCards` (the engine chunks at 12 KiB, reassembles by length and fingerprints `port:size:rawHash`; it does not look inside). `makeSaveEntry` wraps the image in an envelope: 28-byte header (magic `GBS1`, seat, save-type code, codec, raw size, payload size, chunk size, whole-image FNV, chunk count, config length), the host's config (seat 0 only, so a joiner learns the clock, room id and seat count through the same verified path), one FNV per 12 KiB payload chunk, then the payload (gzip when smaller, raw otherwise). Caps: flash 128 KiB, SRAM 32 KiB, EEPROM 8 KiB, and each chip accepts only its own sizes (`SAVE_TYPES`). `verifySaveSet` refuses, each by name: a tampered chunk (`SAVE_TAMPERED_CHUNK`, with seat and chunk number), a wrong size (`SAVE_BAD_SIZE`, including gzip that inflates to the wrong length), a size over the chip's cap (`SAVE_TOO_BIG`), a wrong save type (`SAVE_WRONG_TYPE`), a missing seat (`SAVE_MISSING_SEAT`), two ports claiming one seat (`SAVE_DUPLICATE_SEAT`) or a port carrying another seat's envelope (`SAVE_SEAT_CLAIM`), a seat beyond the room (`SAVE_SEAT_RANGE`), a bad envelope (`SAVE_ENVELOPE`, `SAVE_ENC`), a bad hash (`SAVE_BAD_HASH`), a set whose recomputed fingerprint differs from the engine's (`ROOM_SAVESET`). A decompression bomb is cut off at the declared size: with a 20 MiB bomb declared as 32 KiB the decompressor handed over 49,152 bytes before it was cancelled (the test counts bytes through a wrapper on `DecompressionStream`, and checks that the wrapper sees all 20 MiB when the cap is out of the way).

**A peer with no save** contributes a blank battery for its seat (`TITLES[game].blank`): a 0xFF-filled image of the title's size (Kirby 32 KiB, Sonic Advance 3 64 KiB), or a 0-byte image for a title with no battery (Super Bust-A-Move). The test proves on real cores that a blank chip is the same machine as never calling `setSave` (900 frames, equal state hash and exported save), and that a *non*-blank save is a different machine. A stored save of the wrong size is **not** contributed and **not** overwritten (`source: 'rejected-stored'`).

**Size limit at the engine - not in room.js's hands.** `lib/netplay.js` `_cardTake` reassembles a card from the piece count and length the sender announced and has no cap of its own (only `CARD_CHUNK`); `verifySaveSet` runs after the set is assembled and broadcast. What room.js does on its side: it refuses an entry longer than `ROOM_CARD_LIMITS.maxCardBytes` = `maxEnvelopeBytes(128 KiB)` = 135,240 B (28-byte header + 4 KiB config + 11 piece hashes + a 128 KiB payload; `maxPieces` 12, `maxCards` 4) with `SAVE_TOO_BIG` *before* parsing or hashing it - in `verifySaveEntry` and again per seat in `verifySaveSet` - and the per-chip size and type are judged after the parse (a flash image sent into an SRAM room is `SAVE_WRONG_TYPE`; an SRAM seat that declares 64 KiB is `SAVE_TOO_BIG` by the chip's own cap). The same numbers are exported as `ROOM_CARD_LIMITS` for a transport-level guard. The engine-level cap itself needs an edit in `lib/netplay.js`, which GR1 does not own.

### The machine and gate 9

`bootMachine({MgbaCore, config, rom, images, localSeat, wasmBinary})` checks the ROM (length and md5 against the config; a one-byte-different ROM is `ROOM_ROM`), the wasm bytes it will run (md5 against `coreBuildMd5`; `ROOM_CORE`), then `create({seats})`, `setRtc` (see "Determinism pins"), `loadRom`, the cartridge's save-library string against the title table, and `setSave` per seat (a refusal is `SAVE_REFUSED_BY_CORE` and the half-built core is closed).

`RoomMachine.step(image)` runs `core.runFrame()` **exactly once** and returns `{status, frame, event, journal}`. This is the guest-rate rule of CLAUDE.md gate 9 (guest simulation at 1.000x; 120 would be capacity, not a rate) and it is pinned by checks that do not depend on load: (a) on a counting core every `step()` is exactly one `runFrame()`; (b) on real cores, after each of 600 `step()` calls both seats' own frame counters equal the call count, and over frames 200-600 the guest advances **280,896.00 cycles per frame** on both seats; (c) the engine is handed `frameHz = 16777216 / 280896` (59.7275 Hz) and `GBA_HZ` is derived from the same two constants. Mutants that make `step()` run the core twice and that set `frameHz` to 120 are each caught by those checks (the earlier suite only had a load-dependent replay-capacity threshold that happened to trip on the double-frame mutant). `step()` takes the engine's input image and nothing else. A non-zero `runFrame()` status is an incident, returned and counted, never swallowed.

`fingerprint()` is one word per seat (`hash(seat)`, the full 0x61000-byte state) plus `hashLink()`, folded; compare it only between machines that ran the same sequence from frame 0.

### Ending a room, and what is written

The handshake rides the 22 spare bits of every seat's 4-byte input word (the only channel the engine's star topology relays to everyone): bits 0-9 the ten keys, 10-25 payload, 26-27 position, 28-29 reserved (must be zero), 30-31 kind (0 idle, 1 WANT-END, 2 DIGEST, 3 invalid). Every machine applies the same input image on every frame, so the outcome is the same everywhere and a replaying page re-derives it. The room ends when **every** seat has held WANT-END for 30 consecutive applied frames (agreed frame F); each machine then captures all N seats' battery images and every seat repeats a 64-bit digest of them (room id, F, every image hash; four 16-bit positions, cycled) until everyone's has arrived. All four positions are compared; any disagreement is `END_MISMATCH`, a seat contradicting itself is `END_CONFLICT`, no completion within 900 frames is `END_TIMEOUT`, and a malformed word never counts as a vote. The digest is FNV-1a based: it catches machines whose saves **differ by accident**, not a hostile peer (who can forge a digest as easily as he can lie about his inputs).

**Only the local seat is ever written, and only after a clean end.** A peer's seat image is never persisted - `planCommit` takes the local seat's final image only, and the test asserts that no journal record or storage step carries another seat's bytes. During a room the local seat's writes live in the core's memory. If the end is not clean, nothing is written (`COMMIT_NOT_CLEAN`): killing a peer between a trade offer and its confirmation leaves neither save changed.

### The journal, the commit and the recovery

A page that can die mid-end needs a durable trace. `journalKey(game)` is the one storage key (one record per game per browser; a machine is in one room at a time). The record kinds, all made by `room.js`:

| State | Made by | Carries | On restart |
|---|---|---|---|
| `staged` | `step()`, on the capture frame | room, seat, F, source, hash of the initial and of the final local image - no bytes | `discard`: no peer can have committed, this page's last digest symbol had not left |
| `last-symbol` | `localPad()`, on **every** sample that carries digest position 3 (the engine may skip the first) | the LOCAL seat's final image and its hash | `in-doubt`: see below |
| `committing` | `commitPlan().journalBefore` | key, the local image and hash, the hash of the value it replaces, the plan's `skip` | `finish-commit`: the decision was reached here |
| `committed` / `aborted` | the end of a commit / `recoverPlan` | room, seat, F | nothing to do |

`commitSteps(plan)` is the ordered list of atomic storage operations (the unit a crash falls between): journal `committing`, put `<key>.pre-room` (the previous image, if there was one), put `<key>` (the local seat's final image), journal `committed`. `runSteps(steps, io, limit)` executes them through the page's `{journal(record), put(key, bytes)}`; `limit` stops after that many (the tests' crash injection). The model assumes each *operation* is atomic and nothing more; a page that has a transaction may run them in one.

`recoverPlan({record, key, stored, choice})` is the recovery, pure: it returns `{action, outcome, steps}` for the page to run. `committing` is finished idempotently - **over the old value** it backs up the old value and writes the final image; **over the final value** (died after the write) it writes nothing, and above all does not copy the new value over the backup; **over any other value** (someone else wrote it since) it writes nothing and closes the record `aborted`. A record whose image does not match its own hash, or that was written for another key, is `journal-invalid` and nothing is written. A `rejected-stored` save and a no-battery title are never written. `last-symbol` is **in-doubt**.

**The in-doubt window is irreducible** (two generals): the last digest symbol is persisted *before* the pad that carries it is handed to the engine, so a page that dies after that symbol has left cannot know whether the others saw it and committed, and a page that dies between the persist and the send leaves the same record in a room in which nobody committed (the others time out). `recoverPlan` therefore never decides: it returns `needsChoice` and the page asks. Applying changes nothing, and no question is asked, when the stored value already is the final image, when it was changed by someone else since, or when the title has no battery. Suggested wording for the page: *"Your last room ended while you were leaving. The other players may have kept its result (for example a trade) and your save may not match. Use this room's result - your previous save is kept as <key>.pre-room - or keep your save as it was."* `discard` closes the record `aborted` and drops the in-room image, so offer an export of it first. `<key>.pre-room` is one generation: the next room that changes the save replaces it.

**What the tests cover.** (1) `crashSweep`: 925 runs - every seat of 2 and 3 killed at every frame of the end handshake x input delay 0/2/5 - with the invariants: nobody commits unless the dead seat had emitted all four digest positions (and the converse), the survivors agree on phase, F and G, no store is written except by a machine that committed itself, and the dead machine **restarted** (recovery with the in-doubt room applied) ends holding its seat's consensus final image if the survivors committed and its initial image if they did not (215 survivor commits, 695 non-commits; the dead machine was in doubt in 35 and had already committed itself in 180). (2) `commitCrashSweep`: 75 runs - the machine killed after **every prefix of its commit steps**, and again after every prefix of its recovery, for 2 and 3 seats, applying or discarding an in-doubt room: storage always ends holding only the seat's initial or final image under its own key, the backup is the initial image whenever the final one was written, the journal is closed, and one more restart has nothing to do. (3) named checks on every journal record (local seat only, in the order `staged > last-symbol > committing > committed`) and on every branch of `recoverPlan`. Each has mutants that must trip it (peer image in a journal, `staged` where `committing` belongs, a backup of the wrong value, a journal never closed...). The fake core in these sweeps is a toy two-player *trade* machine - a model of the Trade Center, **not Pokemon**: no Pokemon save with a Cable Club in reach exists on this machine.

### Disconnect policy: `rsReplay` ON, checkpoints OFF, rollback OFF

`lockstepOptions()` / `baseLockstepOptions()` hand every peer `{portCount: 4, padBytes: 4, hashEvery: 60, rollback: 0, rsReplay: true, rsCheckpoint: false, frameHz: GBA_HZ}`; the host's delay wins (`lsgo`), and `fieldNames = seat0..seatN-1, link` makes a desync name `seat1` instead of `w1`. `rsReplay` (`lib/netplay.js:1962-1966`) lets a plain delay room drop a silent player and take the same player's reloaded page back instead of failing: the page boots to frame 0 and re-simulates the room's recorded history as hidden frames, through the same `step()` as live play.

**Why replay and not checkpoints or rollback.** An mGBA savestate does not round-trip bit-exactly: after `loadStates` at frame 900 and 600 identical-input frames on Sonic Advance 3 (a roomable title, 2 linked seats, RTC pinned) `hash()` differed at **30 of 30** samples and `hashGame()` at **30 of 30**, while all 600 video frames were identical. A restored page would therefore raise false desyncs against the host, so checkpoints are off (`CHECKPOINT_POLICY`, with a tripwire check that fails the day the core becomes exact) and rollback is off for the same reason (it restores a state before every re-simulation) and because the in-band end channel needs every applied frame to be final. Replay is exact: a fresh machine fed the 3,000 recorded input images of a Kirby room reproduces all **50** per-seat + link fingerprints, and dropping one image diverges the chain.

**Replay capacity, measured** (`tools/gba_room_protocol_test.mjs` section `policy`; unpaced `step()` loop in Node on this machine, **Windows CPU busy 40-62% while measured** and two runs apart, so each cell is a range; not a device number):

| Title, seats | ms/frame | frames/s = x hardware | a 30-minute room (107,000 frames) is caught up in |
|---|---|---|---|
| Super Bust-A-Move x2 | 0.96-1.08 | 929-1040 = 15.6-17.4x | 109-123 s |
| Sonic Advance 3 x2 | 2.19-2.39 | 418-457 = 7.0-7.7x | 269-299 s |
| Kirby x2 | 3.11-3.12 | 321-322 = 5.4x | 408-410 s |
| Kirby x3 | 4.50-4.62 | 216-222 = 3.6-3.7x | 659-684 s |
| Kirby x4 | 6.05-6.73 | 149-165 = 2.5-2.8x | 1013-1203 s |

The fingerprint (4 hashes of 0x61000 bytes + the link) costs 1.66 ms per call, once per 60 frames. The host keeps the input history for replay at 17 bytes per frame (4 ports x 4 bytes + a mask): 1.73 MiB per 30 minutes, 6.9 MiB per 2 hours.

**UX consequence.** A player who drops and returns sees an explicit *catching up* state (the replaying page shows nothing) for roughly `roomFrames / (replayFps - 59.7275)` seconds, using the table's numbers, which are raw `step()` capacity: how the engine paces a replaying page in a plain delay room (`_rsTick`, `lib/netplay.js:5930`) was not read in detail here, so treat the figure as an upper bound on speed, not a prediction. That is about 2 minutes for a 30-minute Super Bust-A-Move room and up to about 20 minutes for a 30-minute 4-player Kirby room on this desktop. A rejoin is only as good as the replay rate: by `replayCost()` a device at 1.5x hardware needs twice as long as one at 2.0x, and one below 1.0x never catches up.

**This decision rests on desktop numbers only.** Kirby x4 is 2.5-2.8x hardware here. A phone four to six times slower than this desktop would replay Kirby x4 at roughly 0.4-0.7x hardware (2.5 / 4..6) and could never catch up - an **inference from one ratio, not a measurement**; such a phone could not hold 1.000x *live* with four Kirby seats either, so it would not be in that room. The unmeasured case is a phone that holds the room live but replays slowly (a 2-seat Super Bust-A-Move or Sonic room, say). No phone, tablet or low-end device has been measured (stage GR3 built the device budget on this desktop and a CPU throttle: section "Budget"; the replay rate of a throttled device was not measured there either). Until then a page must show the catch-up as an explicit, cancellable state, and `DISCONNECT_POLICY.unmeasured` says so in code.

### Seats, titles and the lobby

Seat 0 is the host and the SIO master (the bridge gives seat *i* wire id *i*); occupied seats must be exactly `0..N-1` (`checkRoster`: `SEATS_GAP`, `SEATS_MULTI` for one machine in two seats, `SEATS_RANGE` for a count that never linked, `SEATS_HOST`). `ROOMABLE` is derived from `LINK_ROWS`, which the test diffs against `tools/gba_link_smoke.mjs` row for row: **Super Bust-A-Move 2 seats; Kirby 2, 3 and 4; Sonic Advance 3 2 seats.** Not roomable, each with a reason from `whyNotRoomable()`: Monster Rancher Advance 2 (`could-not-reach`), Pokemon SoulGold (Cable Club not run; a manual recipe is above), PKMN Ultra Violet (no link row), Sim City 2000 (EEPROM size undecided until runtime, so no battery contract). The per-title save table (`TITLES`) is checked against the real cores: the save-library string, and that mGBA accepts exactly the table's raw size for each battery title. Wireless Adapter / RFU games, Single-Pak multiboot, mixed-ROM rooms and spectators are out of scope.

### How to run it, and what it does not prove

`node tools/gba_room_protocol_test.mjs` (Node only; 2 min 50 s measured here with the box 43-65% CPU busy), `--browser` adds room.js as an ES module in headless Chrome, `--fast` skips the real-core sections, `--only module,tables,battery,mutants,equivalent,sweep,docs,cards,tables-live,frames,policy,e2e`, `--campaign` runs the independent verifier's 74 one-line rewrites of `room.js` against the whole battery, and `GBA_ROOM_JS=<copy of room.js>` points the whole test at a rewritten copy (how an external mutation campaign runs). Every check that matters has a `[control]` that must trip beside its quiet twin; rewrites that cannot change behaviour are listed with a probe that proves it (`equivalent` section).

Not proven here: a real second human, a real network, a real phone; any Pokemon Trade or Battle (the clean-end model uses a toy trade core); iOS/WebKit and low-memory devices (the heap is a fixed 192 MiB); the engine-level card cap (needs `lib/netplay.js`); and the in-doubt window is a fact of the problem, not something a test removes.

## The room page: `gba.html` (stage GR2)

`gba.html` is now a first-class member of the site's multiplayer system: **Party** (toolbar `#btnNet`, phone splash `#mobileSplashNet`, touch menu `#mNet`) opens the same panel the other emulator pages have, and a room is formed *on that page* (the lobby stage is separate). Everything below is in `gba.html`'s inline script "THE ROOM", `gba/gbaWasm/dist/script.js` (the loop seam) and this directory's `room.js`; `lib/netplay.js` is used **unmodified** (`git diff` is empty for it).

### What a player sees

| Step | What happens |
|---|---|
| open | **Party -> Open a room**: pick a game (only titles with a passing link row, `ROOMABLE` cut by what the site ships: Super Bust-A-Move 2, Kirby 2/3/4, Sonic Advance 3 2) and "start when N players are in", **Open the room**. A 5-character code and a link (`/gba.html?np=<code>&game=<title>&join=1`) are shown; the code is `Netplay.makeCode(5)` (a GBA code is not yet console-tagged: `CODE_TAGS` is the lobby stage's). |
| join | **Party -> Join a room** and type the code, or open the link. The joiner is gameless: the host's roster names the game (`room-game`). The host is asked to **Allow** the joiner (lib/netplay.js's own prompt) - knowing the code is not enough. |
| load | Nothing is loaded until the host's N seats are filled. Then **every console loads by itself** (no Start, no Ready button): it fetches the ROM and the core's wasm bytes, checks the ROM md5 against the title table, reads *its own* stored battery (`<rom>.mgba.sav`, the key solo play uses; an old-core `<rom>.sav` is converted in memory, never rewritten), and contributes **its own seat's** image through `contributeCards` (the host's envelope also carries the room config: clock, room id, seat count). The panel shows each seat as `connecting`, `loading N%`, `loaded`, `ready`, `playing`, `disconnected` or `open` - never a peer id. |
| boot | Every console verifies the **whole** agreed set against the config (`verifySaveSet`: tampered chunk, wrong size/type, missing or duplicate seat each refused **by name**), closes the solo core (192 MiB of fixed heap) and boots one wasm instance holding all N linked cores (`bootMachine`). It declares ready with `discString(config, setHash)`; **the engine releases frame 0 only when every seated player declared the identical string.** A difference is shown by name on both sides (`ROOM_ROM`, `ROOM_CORE`, `ROOM_SEATS`, `ROOM_CLOCK`, `ROOM_SAVETYPE`, `ROOM_SAVESET`, ...), with a sentence per field. |
| play | The panel closes itself. The canvas is the **local seat's** screen; sound is the **local seat's** only (through `MgbaCore.AudioPipe` at the fixed 48,000 Hz); keys drive the local seat only (the HUD and the key help under the canvas say which seat you are - "you are seat 2"; the status line only names the room's game, "Room - Super Bust-A-Move"). While a room forms or runs the toolbar's game pickers show the ROOM's game and are disabled; the player's own solo choice comes back after Leave. A HUD shows the frame, the input delay (3 frames to start; the host raises it for everyone at an agreed frame if the path needs more) and the fingerprint count. |
| end | **Finish room and save** is a *vote* (held every frame on the 22 spare input bits, `room.js` END channel). The room ends only when **every** seat has voted for 30 frames and every machine's end-of-room digest agrees; the panel says whom it is waiting for and the vote can be withdrawn. Then, and only then, `planCommit` writes the **local seat's** final image (previous save kept as `<key>.pre-room`), in `commitSteps` order, through one serial queue, with a visible "Saving your progress…". After the end every seat row reads **finished**, the sentence ("The room finished. Your progress was saved." and its variants) is on screen **once** (the status line; the panel's room line is hidden), and the finished room is HELD: the cores are done and no further frame is stepped on any console until Leave. |
| leave | **Leave without saving** is an explicit two-press choice (the first press only arms it and says nothing will be written). Leaving, closing the tab, a dropped link or a crashed page write **nothing**: the local seat's battery lives in core memory only for the whole room. In a room that can no longer be saved (a desync, an unclean end, a failed save) there is nothing to confirm, so Leave is a **single press**, labelled "Leave". |

### The rules the page adds on top of `room.js`

- **Gate 9.** `myApp.roomLocked` is true from the moment the machine boots: `setGameSpeed()` refuses, the speed menu entry is disabled, and `_roomTick()` (script.js) never reads `gameSpeed`. It credits wall time into **one accumulator** exactly like the solo loop, runs a frame only if `ls.beginFrame()` says every seat's input is here (a stall does **not** spend its credit and the credit is clamped to one frame afterwards, so nothing is ever repaid at speed), and drops the timer loop (rAF alone drives a room, as on genesis). At most 100 ms of wall time is credited per tick and at most 4 frames run in one tick (the ceiling is still 4; since GR3 `framesPerTick` lowers it for a slow device, section "Budget"). Nothing in the page reads `?speed=`/`?fps=`/`?uncap=`-style parameters.
- **The journal is a gate on the frame.** `RoomMachine.localPad()` returns a `last-symbol` journal record on every sample that carries the last digest symbol; the page must make it durable *before* handing the pad to the engine (once that symbol is out the other machines can commit without hearing from this one). IndexedDB is asynchronous, so the frame is **held** (not run, credit not spent) until the write resolved. The `staged` record (capture frame) is queued in the same serial queue, so records reach storage in the order made.
- **Page start recovery.** `roomRecover()` runs at every page start, for every roomable title: `recoverPlan` finishes a `committing` record idempotently (backup first, then the battery; a battery already written is not copied over the backup), discards a `staged` record, and **asks** the player about an in-doubt `last-symbol` record ("Use the room's result" / "Keep my save as it was"; the wording is `room.js`'s suggestion). A damaged record writes nothing and says so.
- **A returning page.** Reloading the tab mid-room (same window, so the engine's identity is the same) re-joins, and the host, which dropped the seat when the page died, **replays** the room into it (`rsReplay`: the new page re-simulates the recorded input history as hidden frames, bounded by the engine's own-clock bar to the room's present, silent and not drawn, with a "Rejoining the room - catching up…" notice). **The returning page does not contribute a save again**: it asks the host for the set it already holds (`requestCards`) and, if the room has already formed, boots from *that* set - a changed local save (another tab, an import) would otherwise give the replay a starting machine the room never ran. The returning page's fingerprints for the frames it replayed are compared with the host's like any other. **Gate 9 note, because this is the one place a page runs more than 1.000x of guest time per wall second:** the replayed frames are history the room has ALREADY lived, run hidden to rebuild this page's machine, bounded by the engine's own-clock bar to the room's present - the room itself never runs faster, and once level the page runs at 1.000x. Measured (headless Chrome, Kirby, 2 seats, one run, machine load 40-50%): a page killed ~7 s into a room that was then ~25 s old was level with the host again (frame gap <= 12) 2.65 s after the harness began waiting for it - an interval that ALSO contains the rest of its ROM load and boot - having re-simulated ~1,580 frames, i.e. the hidden replay itself ran at AT LEAST ~10x hardware; once level it ran at 1.0021x. That is the GR1 rsReplay decision working as designed; if the owner reads "never above 1.000x" as covering state reconstruction too, the alternative is rsReplay off, under which a returning page cannot rejoin and the room plays on without that seat.
- **When the link master leaves.** Seat 1 is both the host and the SIO master, and the room is a star around the host: **if the host leaves, the room is over for everyone** (`ROOM_HOST_LEFT`), nothing is saved, every other player is back in solo play with their previous save, and the page says so. **The host says it before it closes** (verifier FV2, D1/D2): `roomLeave` and `pagehide` send a one-line `lsgbahostbye` message down every open link (the engine hands only message types that start with `ls` to its room handler, so the name matters) and each guest ends the room at once, in a live room and before the game started alike - measured 0.26-0.31 s (host presses Leave; host closes its tab; host leaves while a guest is still loading), where a guest used to freeze for ~31 s on "Looking for the host..." in a live room and was NEVER told before the start (80 s observed; the engine re-knocks at a host that has gone). A host that could not say it (a crash, a dead network) is reported after a **visible 30 s countdown** ("Lost contact with the host - trying to get back in for another N s. If it does not answer, the room is over..."), then by the same `ROOM_HOST_LEFT` ("the host stopped answering"); 30 s is the engine's own stall budget for a guest waiting on its host, and it is kept because a host whose LINK merely blipped may be back. If any *other* seat leaves or loses its connection, the engine drops it at an agreed frame (its pad goes neutral), the room plays on, and the player can come back by reloading. **A clean end needs every seat to vote, so a room with a dropped seat cannot be saved**; the remaining players can only "Leave without saving". This is a limitation of the in-band end design (GR1), stated here rather than hidden.
- **Desync.** `Lockstep` compares a fingerprint (every seat's full-state `hash()` and the link's, folded) every 60 frames. A mismatch stops the room on both machines, shows the frame and **names the diverged fields** from `fieldNames = seat0..seatN-1, link` - in the page's own words ("Seat 1", "the cable link", never `seat0`) - and nothing is saved. Everything on the page then agrees that the room stopped: the status line is red and says so, every seat row reads "stopped", the Party label ends "- stopped", `__gbaNet().running` is false, and the "Finish room and save" control is gone. (Which fields are named depends on how soon after the fault the next sampled frame falls: in the test's injected divergence one run was caught at the first fingerprint after the flip and named only `seat0`, another a little later and named `seat0`, `seat1` and `link`, because a seat's input reaches its partner through the cable within a frame.)
- **Sound starts on the first real touch (fix M1).** A browser will not make an AudioContext without a user gesture, and a joiner who arrives by an invitation link, or a reloaded rejoiner, never pressed Party. While a room exists the page listens (capture phase) for the first `pointerdown`, `pointerup`, `keydown`, `touchend` or `click` and creates the context there; until then a "Click or press a key to turn the sound on" pill is shown. The sink is fed one seat's sound only (about 48,000 frames per guest second); a returning page's hidden replay frames are not pushed to it.
- **The bytes that were checked are the bytes that run (fix M2).** `gba.html` md5s the core wasm it fetched and binds that md5 into the disc string. The shipped glue never read `wasmBinary`, so the core used to be instantiated from a SECOND request that nothing checked. `MgbaCore.create({ wasmBinary })` now hands those bytes to Emscripten's own `instantiateWasm(imports, success)` hook: no second request is made, and a different wasm served for the bare URL is never executed. A throw inside the core constructor **rejects** `create()` (the first form of this hunk settled `resolve()` from inside a two-argument `then()`, which left `create()` pending forever and raised an unhandled rejection; `tools/gba_netplay_test.mjs --only bind` pins both the fix and a mutant that restores the old form). Solo play passes no `wasmBinary` and keeps using the glue's own fetch.
- **Another protocol version is named (fix A1).** An envelope whose magic is "GBS" plus a digit other than this page's is refused `ROOM_VERSION` ("the room speaks protocol N and this page speaks M - one of you has an out-of-date page; reload it") instead of the generic `SAVE_ENVELOPE`.
- **The speed readout is a rate over the last 10 s (fix A2).** A one-second window counts whole frames and prints 1.004x for a guest that is at 1.0000x; the `#fps` text keeps the family format and is computed over the last ten seconds of one-second windows (its `title` says so). It is a display only: the guest never runs faster.
- **No streaming.** The page loads no `netplay-host.js`, owns no `<video>`, no `captureStream`, and `tools/no_streaming_test.mjs` counts it as a lockstep page.
- **Still one page, one origin, no coi.** No SharedArrayBuffer, no Worker, no `coi-serviceworker`.

### Test seams (`?roomtest=1` only)

`window.__gbaRoomTest` exists **only** with `?roomtest=1` (a static check pins that the assignment sits behind that gate): `keys(frame)` (scripted pad per sample frame), `flip` (a *local-only* XOR of one seat's input on one machine, never via the wire), `discTamper` (a peer whose declared setup differs), `romXor` (a peer holding a different ROM file), `tamperEntry` (a corrupted battery chunk in flight), `commitLimit` (a crash after N storage steps) and `machine()`. `&gbadb=NAME` gives each simulated player its own IndexedDB (two windows of one test profile share an origin and so a database; two real players have two browsers). Without `roomtest=1` the page uses `GBAWASMDB` always. **Loopback only (fix, verifier B):** the seam is armed only when the hostname is `localhost`, `127.0.0.1` or `[::1]` (`gba.html` `TESTING`, and the `gbadb` name in `script.js` `_dbName()`), so `?roomtest=1` on the public site is inert - it cannot hand a visitor `commitLimit`, `romXor` or direct access to the room's core, nor point the page at a second database. `tools/gba_netplay_test.mjs --only static` pins both sites, carries a control for each, and unit-checks that the gate accepts the three loopback names and rejects `caseybement.com`, `www.caseybement.com`, `localhost.evil.com`, `127.0.0.1.evil.com` and an empty host.

### How it is tested: `node tools/gba_netplay_test.mjs --browser`

`tools/headless_cdp_multi.mjs` opens **one headless Chrome (`--mute-audio`, machine-wide lock, throwaway profile)** and **one window per player** (a hidden tab gets no rAF; `?net=local` signalling is a `BroadcastChannel`, so all windows must share one profile). Sections (`--only`): `static, redirect, audio, bind, alloc, ux, cap, picker, hostleft, race, third, solofetch, savenote, two, kirby, desync, refuse, save, recover, kill, leave, boot, mobile, speed`. A section that throws is reported as one failed section by name and the run goes on; an unhandled promise rejection is counted as a failure instead of ending the process.

- **Real and two-page tested:** the room forming through the real buttons including the host's Allow prompt; seats; auto-load/boot/barrier (nobody presses Start); equal fingerprints for every sampled frame over a 4,800-frame scripted menu walk with different inputs per player into Super Bust-A-Move's linked 1P-vs-2P battle, and through Kirby's SUB-GAMES -> Quick Draw -> MULTIPLAYER walk on 2, 3 and 4 pages; the cores *actually linked* (`witnesses().linked`, tens of thousands of MULTI rounds, zero incidents); the guest rate over a measured window (gate 9); an injected local-only divergence detected and **named**; a mismatched ROM / clock / core build / save type / seat count / corrupted save chunk refused by name; a clean end writing only the local seat in `commitSteps` order; leave-without-saving; crash points between storage steps repaired at the next start; the in-doubt dialog; a killed page replayed back into the room; the host leaving; an allocation failure; the phone viewport (390x844 and 320x568); the speed lock under query parameters, hotkeys and every page entry point; a CPU-throttled peer.
- **Not real, said plainly:** there is **no second human, no real network** (loopback, ~1 ms; NAT traversal is not exercised and `local` signalling skips it), **no real phone** (Chrome's engine at a phone viewport and touch emulation, not WebKit), **no real audio device** (the sink is checked by counters; every browser is muted), and the CPU throttle is a stand-in. **Pokemon SoulGold is not roomable** (no passing link row) and is exercised by no automated test.
- **Unit-covered only (`tools/gba_room_protocol_test.mjs`, GR1), not by a page test:** two joiners claiming one seat, a peer claiming a seat beyond N, a forged clean-end word, a kill at every frame of the end handshake (925 runs) and after every prefix of the commit (75 runs). The page test crashes the commit at four chosen points instead.

### Known limits of the room page

- **The engine's card cap (verifier A4) is BUILT, opt-in - it is no longer a gap (2026-11-02, authorised by the lead).** The problem: `lib/netplay.js` `_cardTake` reassembled a save ("card") from the piece count `n` and length `len` the SENDER announces, before any page code saw the bytes, and `room.js` refused an oversized entry only afterwards (`verifySaveSet`, `SAVE_TOO_BIG`). Measured before the change (the engine loaded unmodified in Node; a seated hostile peer): 20,000 pieces of 12 KiB announced as one card with `n = len = 0x7fffffff` were ALL held (245,760,000 B, RSS 62 -> 324 MB, no error), and a complete 24 MiB "save" was assembled and re-broadcast to the guest as 2,051 messages (RSS 324 -> 526 MB).
  - **What exists now.** `Lockstep` takes `opts.cardLimits` (or `ls.cardLimits = ...` later): `{ maxCardBytes, maxPieces, maxCards }`, default `null` = no cap. With it set, `_cardTake` calls `_cardOverLimit` first and DROPS the piece (allocating nothing) when the announced length is over `maxCardBytes`, the piece count is over `maxPieces`, the piece count is not what an honest sender makes of that length (`ceil(len / 12288)`), one piece is larger than 12,288 bytes, or a new card would open more than `maxCards` in-flight cards. It reports once per card and reason, by seat: a `cards` event `{ set: null, hash: null, code: 'CARD_LIMIT', what, got, max, port, peer, error }`. The hunks are additive (the constructor line, the `_cardOverLimit` method, one guard line in `_cardTake`); no existing line was edited. `gba.html` opts in for both ends of a room with `lockstep: Object.assign(R.lockstepOptions(cfg), { cardLimits: R.ROOM_CARD_LIMITS })` (`room.js`: `{ maxCardBytes: 135240, maxPieces: 12, maxCards: 4 }`, from the largest flash envelope: header 28 + config 4,096 + 4 B per 12,288-B wire piece + 131,072 B), and on a `CARD_LIMIT` event shows "Seat N's save was refused" (code `SAVE_TOO_BIG` for bytes and pieces, `CARD_LIMIT` otherwise) with the sentence; the room's honest cards still go through.
  - **Tests.** `node tools/gba_card_cap_test.mjs` (Node, no browser) 18 checks: the flood IS held with no limits (the control); with `ROOM_CARD_LIMITS` NOTHING is held (0 pieces, 0 B, ArrayBuffers growth 0 MB) and ONE refusal names seat 2; with the cap cut out of a copy of the engine (limits still passed) the 20,000-piece card is held again (the negative control); each reason (`bytes`, `pieces`, `shape`, `piece-size`, `slots`) is dropped and reported once over 500 pieces; honest cards of 131,072 B, 1 B and the largest honest 135,240 B form a set that every guest receives byte-for-byte, and 135,241 B is refused; and WITHOUT the option a legitimate 24 MiB card is still assembled, broadcast and received unchanged. In the page: `tools/gba_netplay_test.mjs --browser --only cap` injects the flood into a real room's host engine (the page seam `__gbaRoomTest.engine()`, loopback only) and sees the seat refused on screen with nothing held and the room still forming; with `ls.cardLimits = null` on that page the same 300 pieces ARE held and nobody is told (the control). `--only static` checks that the guest AND the host Session constructions opt in (a control for each) and that `lib/netplay.js` differs from the committed engine only by additions plus the CODE_TAGS line.
  - **What it does not do.** It protects memory; it does not remove the hostile seat. The host sees the refusal and the barrier waits for that seat's honest card until the seat is removed (the engine's `barrier-stuck` watchdog, 60 s by default per `barrierTimeoutMs`, is what names a missing seat; this change did not exercise it). Only gba.html opts in: another emulator that wants the same protection passes its own limits.
- **`?roomtest=1` is loopback-only** (see "Test seams"). It was reachable on the public host before.
- **Fixed after the second independent verifier (FV2), each browser-checked by a section of `tools/gba_netplay_test.mjs` with a control:** the host's departure (D1/D2, section `hostleft`, above); a page that dies while its ROM is downloading is not a refusal (D3, `race`: a transport failure is announced to the host only if the page is still alive 2.5 s later, so closing a tab before the start leaves the host waiting at the barrier, while a real failure is still reported by name; the control with the old announce-at-once timing shows the false "[ROOM_ERROR] ..." refusal again); a visitor the room refuses sees only the refusal in cartridge words (D4, `third`: the engine's "the controllers were plugged in when the disc loaded" becomes "the link cable was connected when the game started"; the shared engine is not edited, the page maps its sentences); a finished room says "finished" and is held (D5, `ux`); a solo ROM still arriving when a room forms is cancelled and its "Fetching ... 99%" leaves the status bar (D6, `solofetch`; the bar reads "Party room - the game loads and starts by itself." and the idle line returns after Leave); a stored save of the WRONG SIZE is told to its owner at the start in one sentence (`savenote`).
- **The multi-window rig (D8).** `tools/headless_cdp_multi.mjs` `openWindow()` ignored `mobile`, so `GBA_NETPLAY_PHONE=1` made only window 0 a phone; windows opened without options now inherit the rig's `mobile`, and `openAll` in the netplay test asserts that every window is a 390 px phone-shell window in that arm.
- **Releasing the solo core's heap when a room boots (partly).** The room closes the solo core (`Core.close()` nulls its module and the page drops its references) before booting its own 192 MiB instance, and re-creates a solo core after the room. Whether the 192 MiB is actually returned to the OS is the garbage collector's decision and cannot be measured from the page, so this is not claimed.
- **The hamburger (`#mobileMenuBtn`) keeps the family's size** (a 38 x 38 box with a 44 x 44 hit area, as on the other emulator pages). Only this page's own touch-menu entry, `#mNet`, was raised to a full 44 px target.
- **The rate of a returning page.** Unchanged and still an open owner question (CLAUDE.md gate 9 against `rsReplay`): a rejoining page re-simulates the room's history as hidden frames (at least about 10x hardware in the one measurement above), then runs at 1.000x. This stage did not decide it.

### Manual recipe: the SoulGold Cable Club through the page (NOT automated, NOT roomable yet)

1. Make a save in a Pokemon Center: solo `gba.html`, SoulGold, play past the intro to a Pokemon Center, save in the game. The page persists it (`Pokemon SoulGold (v1.1.1).gba.mgba.sav`); **Export .sav** keeps a copy. Do it on the second machine too (or `Import .sav` the same file; two different trainers show more).
2. SoulGold is deliberately **absent from the Party panel** (`ROOMABLE` needs a `linked` row and there is none). To try it, in a scratch copy of the repo add a `linked` row for it to `LINK_ROWS` in `gba/mgba/room.js` (and re-stamp the `room.js?v=` token in `gba.html`; `tools/gba_netplay_test.mjs --only static` checks it), serve that copy, and open **Party -> Open a room -> Pokemon SoulGold, 2 players** on one machine and join from the other. Two *different browsers or devices* are the real test; two windows of one profile share one IndexedDB (and so one save) unless `?roomtest=1&gbadb=A` / `gbadb=B` is added.
3. Both consoles: CONTINUE, walk to the Cable Club counter (second floor, right-hand desk), choose a trade or a battle.
4. Pass criteria: both reach the Trade Center / battle room; `__gbaNet().witnesses` on both: `attached === 2`, `linked === true`, `incidents === 0`, `recoverCount === 0`, `serialIrqsPerFrame` about 9 or more (the plan's Emerald figure); fingerprints keep matching (`__gbaNet().state` never `desync`); **the clock is pinned**, so a game that shows the time shows the same time on both (`rtcWitness`).
5. The save policy checks that matter for a trade: start a trade, **close one tab between the offer and the confirmation** - neither save may have changed; do a trade and **Finish room and save** on both - each player's save holds *their* seat's side of the trade; the previous saves are kept as `.pre-room`.
6. The Wireless Adapter path is not served (mGBA has no RFU) - choose the cable.

Until that has been done by a person with a real save, **the SoulGold trade/battle path is not exercised by any automated test.**

## Budget (stage GR3): what a device can hold at exactly 1.000x, the input delay, and who is slow

**Everything here is a shared Windows desktop under headless Chrome 156 / SwiftShader. These are shared-desktop SwiftShader numbers, not device numbers.** The CPU-throttle arms are a **stand-in** (CDP `Emulation.setCPUThrottlingRate` slows every task of one page by a fixed factor); they say nothing about a phone's memory system, its thermal limits or WebKit. An N-seat room measured here is N pages contending for ONE CPU (a real room has N machines), so a page's cost here is, if anything, overstated against a real device of the same speed. What needs real hardware is listed at the end.

### Decisions, with the row that supports each

| # | Decision | Rule in code | Evidence (rows below) |
|---|---|---|---|
| 1 | **Seat cap per device.** The host's picker offers only the seat counts this device is predicted to hold, says why for the others, and can be argued past only for a speed refusal | `room.js` `seatCap`: refuse a count when `COST_REFERENCE p95 x slowdown > USABLE_FRACTION (0.75) x 16.74 ms`; memory: `deviceMemory <= 0.5` GB no room, `1` GB two seats only, `>= 2` or not reported no memory limit; no usable speed reading: two seats only | cost table (the p95s), throttle table (rooms held up to p95 = 0.91 frame and failed from 1.16), speed-test table (within ~11% of the cost scale). The 0.75 leaves a quarter of a frame spare at the p95 and sits 0.16 frame below the highest cell that held |
| 2 | **Default input delay.** The host pings every player before it declares ready and starts the room at the engine's own formula for that round trip (never below 2 frames); nothing measured keeps 3 | `room.js` `defaultInputDelay`, `gba.html` `chooseDelay` | sweep (1 frame stalls at a 6x throttle, 2 does not), `Lockstep.recommendDelayForRoom` equality in Node for 9 round-trip classes. The device's own per-frame cost is NOT a term (Kirby sweep: 2 -> 8 frames of delay on an overloaded room recovers 0.012x for 100 ms of latency). |
| 3 | **A late peer stalls the room, never speeds anyone.** Unchanged and now measured: the slowest device sets the pace, every other window waits | `script.js` `_roomTick` (credit dropped, never repaid), `room.js` `paceNotice` offers no speed-up | throttle table (rate ~ 0.9 x 16.74 ms / p50 on every overloaded arm; none above 1.003x), the extracted-`_roomTick` model (72 random schedules) |
| 4 | **Frames per tick follow the device's cost** (1 to 4, never more than GR2's four) | `room.js` `framesPerTick`, `script.js` clamp | A/B table: 312 long ticks per 20 s -> 0 at the same rate |
| 5 | **A Worker is NOT needed and was not built.** Designed below | - | the core is 88-97% of a frame's cost and a Worker moves that same cost, so it cannot move the knee; no desktop frame of 3,000 was over budget; the one main-thread-specific harm measured (long ticks) is removed without it |
| 6 | **A live "this device cannot keep up" notice** that names the seat, gives the rate, and offers Leave (and, for the host, a smaller room) | `gba.html` "THE PACE NOTICE", `room.js` `PaceWatch` / `paceNotice` | slow-device runs below, `tools/gba_room_budget_test.mjs --only notice` |


### How it was measured: `node tools/gba_room_budget_measure.mjs`

The rig runs the real `gba.html` in one headless Chrome (`--mute-audio`, machine-wide browser lock, throwaway profile) with one window per player, the scripted walk of `tools/gba_link_smoke.mjs` for each title, and reads the page's own recorder (`window.__gbaBudget()`, gba.html "THE BUDGET RECORDER"): per applied room frame, in main-thread milliseconds (`performance.now()`, which Chrome rounds to 0.1 ms on a page that is not cross-origin isolated, so a 0.4 ms Super Bust-A-Move frame is read in steps of a quarter of itself),

| Column | What it covers |
|---|---|
| `core` | `core.runFrame()` for ALL the room's seats (plus the key writes) |
| `engine` | lockstep `beginFrame`/`endFrame` and, once per 60 frames, the fingerprint (4 hashes of 0x61000 bytes + the link) |
| `audio` | the AudioPipe pump for the local seat |
| `present` | `putImageData` once per rAF tick (the canvas upload); shared over the frames of that tick |
| `total` | core + engine + audio + this tick's `present` / frames in the tick: **the cost of one room frame, the number everything below uses** |
| `tick` | everything one rAF tick did; a tick over 50 ms is a "long task" the browser reports |

"Over budget" counts frames whose `total` is above one frame of wall time, 16.7427 ms (280,896 cycles at 16,777,216 Hz). **Headroom is a capacity, 16.7427 / cost, never a rate**: a room with 4x headroom still runs at 1.000x. The page says it as "59.7 presented, 3.4x headroom" (HUD) and never as a multiple of realtime.

#### Cost of one room frame, unthrottled (the numbers `room.js` carries as `COST_REFERENCE`)

`COST_REFERENCE.source` in `room.js` reads: `tools/gba_room_budget_measure.mjs plan 1 (cells), 2026-11-02, Windows 11 / Ryzen 7 3800X, Chrome 156 SwiftShader, 3000 frames of the final scene + the whole scripted walk, Windows CPU busy 6-71%`; the seat cap's `USABLE_FRACTION` is 0.75.

Plan 1 of the rig, one browser, 2026-11-02, Windows CPU busy 6-71% while it ran (other agents' suites share this box; Windows CPU busy before and after each cell, in table order: 69 to 66, 66 to 29, 54 to 37, 67 to 27 and 6 to 48 percent, so the cost numbers are, if anything, a loaded machine's). For each title the room walked its `tools/gba_link_smoke.mjs` script into the linked scene and then ran **3,000 more frames in that scene** (`final`); the `walk` is the whole scripted route before it (menus, loads, transitions: 2,373-5,116 frames) and is the more expensive of the two for Kirby. Each cell is the mean over the room's pages of that page's own statistic; `COST_REFERENCE` takes, per statistic, the larger of the two scenes.

| | Title | Seats | p50 ms | p95 ms | final scene: p50 / p95 / p99 / max (3,000 frames) | walk: p50 / p95 / p99 / max | frames over 16.74 ms | headroom at p50 / p95 | rate over 6 s after |
|---|---|---|---|---|---|---|---|---|---|
| COST_REFERENCE | Super Bust-A-Move | 2 | 2.30 | 3.10 | 2.30 / 3.10 / 3.50 / 4.1 | 1.50 / 2.85 / 3.45 / 13.4 | 0 of 3,000 and 0 of 5,113 | 7.3x / 5.4x | 1.0029x, 1.0005x |
| COST_REFERENCE | Sonic Advance 3 | 2 | 2.60 | 3.55 | 2.60 / 3.55 / 3.85 / 4.9 | 2.50 / 3.50 / 3.90 / 5.2 | 0 of 3,000 and 0 of 3,991 | 6.4x / 4.7x | 1.0009x, 0.9989x |
| COST_REFERENCE | Kirby Nightmare in Dreamland | 2 | 3.65 | 5.40 | 3.20 / 4.30 / 4.65 / 6.0 | 3.65 / 5.40 / 6.56 / 8.0 | 0 of 3,000 and 0 of 2,381 | 4.6x / 3.1x | 0.9983x, 0.9988x |
| COST_REFERENCE | Kirby Nightmare in Dreamland | 3 | 5.20 | 7.87 | 4.50 / 4.93 / 5.83 / 7.4 | 5.20 / 7.87 / 8.70 / 12.8 | 0 of 3,000 and 0 of 2,374 | 3.2x / 2.1x | 1.0012x, 0.9989x, 0.9989x |
| COST_REFERENCE | Kirby Nightmare in Dreamland | 4 | 6.72 | 10.35 | 6.07 / 8.33 / 8.77 / 10.6 | 6.72 / 10.35 / 10.98 / 15.4 | 0 of 3,000 and 0 of 2,373 | 2.5x / 1.6x | 1.0002x, 1.0012x, 1.0012x, 0.9989x |

* **Not one frame of 3,000 (nor of the walk) cost more than a frame lasts** (16.7427 ms) at any seat count, on any of the five cells; the largest single frame was 15.4 ms (Kirby, 4 seats, in the walk). That is the desktop answer to "does the main thread hold 16.742 ms": yes, with 1.6x headroom at the p95 of the worst cell.
* **Cost grows with seats the way the README's Node figures said**: Kirby 3.65 / 5.2 / 6.7 ms at 2 / 3 / 4 seats (the Node figures were 2.67 and 5.08 for 2 and 4 on the title screen; the page adds the engine, the audio pump, the canvas upload and the other windows' contention for this one CPU).
* **Where the time goes** (means over the whole run, walk and final scene together, ms; the recorder keeps the parts as running means, not per scene): core 1.65 / 2.40 / 3.37 / 4.78 / 6.40 (the five rows in table order), engine (lockstep + the 1-in-60 fingerprint) 0.09-0.10, audio pump 0.06-0.08, canvas upload 0.04-0.05 per tick. **The emulator core is 88% (Super Bust-A-Move) to 97% (Kirby, 4 seats) of a room frame; everything else the main thread does for a room is a constant 0.2-0.3 ms whatever the seat count.** That number decides the Worker question below.
* **Timer resolution.** `performance.now()` is rounded to 0.1 ms on a page that is not cross-origin isolated, so a 2.3 ms frame is read in steps of 4%, and the p50 of a cell is a multiple of 0.1 (the table's two decimals come from averaging two to four pages). The rate column is the guest rate over 6 s measured by the test, not a speed claim.
* **Browser memory** (Windows private bytes of the test profile's renderers, taken at the end of each cell): every room page is **276-300 MiB** at 2, 3 and 4 seats alike (Super Bust-A-Move 279 / 276, Sonic Advance 3 300 / 298, Kirby 283 / 283 at 2 seats, 284 / 283 / 279 at 3, 285 / 284 / 283 / 279 at 4). The seat count does not change a page's memory: one fixed 192 MiB wasm block plus about 90 MiB of page, canvas and audio. The whole browser (all windows, GPU and browser processes) was 972 MiB for 2 windows and 1,553 MiB for 4. This is the Windows number for a desktop Chrome; a phone's accounting is different and was not measured.

#### The speed test (what the page runs when the host looks at the seat picker)

`R.calibrate` runs a fixed 3,000,000-iteration integer loop (xorshift, data-dependent loads and stores into a 2,048-word table: no floating point, no allocation), seven timed trials after one warm-up, and reads the **best** trial (other work can only add time). `slowdown` = best / `CALIBRATION.refMs`, with `refMs` = **5.5 ms**, the median best-of-7 over 30 readings on this desktop's idle page.

| Check | Result |
|---|---|
| Repeatability, 30 readings, idle page | best-of-7 median 5.50 ms, p95 5.86 ms, max 7.60 ms: the spread of the reading is **6.5%** (median to p95); within one reading the median trial is 2.7% above the best; 1 of 30 readings was flagged unreliable (median trial more than 35% above the best) |
| Under a CDP CPU throttle of 2x / 4x / 6x (arm proof: a fixed loop timed before and after slowed by 1.93x / 4.48x / 6.82x, so the arm is IN EFFECT) | the speed test read **2.07x / 4.33x / 7.01x** of the unthrottled reading, 8 readings each, 0 unreliable |
| Against the cost it is meant to predict (the `p50` of a room frame at a 4x / 6x throttle over the unthrottled `p50` of the same cell) | Super Bust-A-Move 4.13 / 7.0 against a speed-test ratio of 4.60 / 6.96; Sonic Advance 3 4.3 / 7.27 against 4.16 / 6.64; Kirby 2 seats 4.28 / 6.94 against 4.36 / 6.92: **the speed test is within about 11% of the cost scale in all six pairs** |

*What that does and does not show.* It shows the arithmetic: a loop that runs N times slower predicts a room frame that costs N times more, inside a uniform slowdown. **It does not show that a phone's integer-loop speed predicts its WebAssembly emulation speed**; a CDP throttle scales every task by one factor by construction, so it cannot expose a phone whose memory system, branch predictor or thermal budget make the emulator slower (or faster) than its loop. That check needs real devices; the live notice below exists because of it.

#### A slower device, as a stand-in: every window CPU-throttled (CDP `Emulation.setCPUThrottlingRate`)

The walk ran unthrottled, then every window of the room was slowed for 30-40 s per arm. **Arm proof first:** a fixed loop timed in each window before and after the throttle had to slow by at least 0.6x the factor, or the cell prints VOID and no verdict; every arm below was IN EFFECT (loop slowed 1.93-2.15x at 2x, 3.3x at 3x, 4.0-4.6x at 4x, 5.5-5.7x at 5x, 6.6-7.1x at 6x, 8.4-8.5x at 7x). `p50`/`p95` are the per-frame cost during the arm (n = 829-2,566 frames per window), `/F` is that over 16.74 ms, `rate` is guest frames per wall second over the whole arm over 59.7275 (both windows of a 2-seat room agree to 0.001).

| Cell | throttle | speed test slowdown | p50 ms (`/F`) | p95 ms (`/F`) | rate | stalls (A/B) | ticks over 50 ms (A/B) | time lost (A/B) |
|---|---|---|---|---|---|---|---|---|
| Super Bust-A-Move x2 | 1x (final scene) | 1.0 | 2.30 (0.14) | 3.10 (0.19) | 1.0029x, 1.0005x | 0 | 0 | 0 |
| | 4x | 4.60 | 9.50 (0.57) | 11.80 (0.70) | **0.9991x**, 0.9994x | 0 / 0 | 0 / 0 | 0 |
| | 6x | 6.96 | 16.10 (0.96) | 20.40 (1.22) | **0.9159x**, 0.9158x | 162 / 226 | 57 / 15 | 2.3 s |
| Sonic Advance 3 x2 | 4x | 4.16 | 11.20 (0.67) | 12.70 (0.76) | **0.9997x**, 1.0000x | 0 / 0 | 0 / 0 | 0 |
| | 6x | 6.64 | 18.90 (1.13) | 22.50 (1.34) | **0.7941x**, 0.7945x | 1 / 64 | 24 / 12 | 8.2 s, 7.0 s |
| Kirby x2 | 2x | 2.15 | 6.30 (0.38) | 7.05 (0.42) | 0.9995x, 0.9995x | 0 / 0 | 0 / 0 | 0 |
| | 3x | 3.58 | 10.10 (0.60) | 11.00 (0.66) | 0.9998x, 0.9998x | 0 / 1 | 0 / 0 | 0 |
| | 4x | 4.36 | 13.70 (0.82) | 15.20 (0.91) | **0.9996x**, 0.9996x | 0 / 0 | 0 / 0 | 0 |
| | 5x | 5.58 | 17.25 (1.03) | 19.50 (1.16) | **0.8992x**, 0.8997x | 29 / 65 | 1 / 0 | 2.7 s, 2.3 s |
| | 6x | 6.92 | 22.20 (1.33) | 24.85 (1.48) | **0.6927x**, 0.6928x | 2 / 6 | 117 / 116 | 12.3 s |
| | 7x | 8.04 | 26.80 (1.60) | 31.00 (1.85) | **0.5495x**, 0.5492x | 26 / 0 | 17 / 16 | 12.9 s, 13.6 s |
| Kirby x4 | 4x | 4.47 | 28.2-29.0 (1.68-1.73) | 32.1-32.7 (1.9) | **0.5245x-0.5254x** | 0 / 217 / 247 / 249 | 0 / 1 / 2 / 4 | 12-19 s |
| | 6x | 6.76 | 45.2-46.6 (2.70-2.78) | 49.1-51.1 (2.9-3.1) | **0.3226x-0.3233x** | 0 / 271 / 293 / 303 | 275 / 128 / 115 / 100 | 14-27 s |

*What the stand-in shows.* (1) **A room holds 1.000x as long as its p95 cost stays under a frame and the p50 under about 0.85 of one**: the highest cells that held were Kirby 2 seats at 4x (p50 0.82, p95 0.91, p99 17.4 ms and one frame of 21.1 ms: no stall in 40 s, rate 0.9996x) and Sonic Advance 3 at 4x (p95 0.76). The lowest cell that did not was Super Bust-A-Move at 6x (p50 0.96, p95 1.22: 0.916x, 162 and 226 stalls). (2) **Past that the room is exactly as slow as its slowest device**: rate is about 0.9 x 16.74 ms / p50 on every overloaded arm (1.03 -> 0.90, 1.33 -> 0.69, 1.60 -> 0.55, 1.7 -> 0.525, 2.7 -> 0.323): nobody catches up and nobody is ever above 1.0x (no cell's rate is above 1.003x). (3) The speed test is within about 11% of the cost scale (see above), so it ranks these cells in the right order.

#### The same room with ONE slow device (the rest at full speed)

Kirby, 4 windows, the last slowed 6x after the room was level (arm proof: loop 2.7 -> 17.9 ms, x6.63). Before: 0.9992x on all four. After: **0.4222x / 0.4222x / 0.4223x / 0.4214x** - every window, including the three that were not slowed, runs at the slowest device's pace; the three fast windows spent 67% of their time stalled waiting for it and the slow one 0%. The slow device's published capacity was 0.44x-0.45x and the room ran at 0.42x. A 2-seat Super Bust-A-Move room with one window slowed 30x (a deliberately absurd arm: loop x75.7) ran at 0.052x / 0.051x. Both are the "room waits for its slowest peer" behaviour the verifier measured (0.320x with one of four at 6x), now with the notice below on top of it.

#### Per-frame tick cap (`script.js` `_roomTick`, `room.js` `framesPerTick`)

GR2 let a tick run up to four frames. On a device where a frame costs more than 12.5 ms four frames hold the main thread for 50 ms or more (the browser's long-task line), delaying every key press and touch behind them. The cap now lowers itself to as many frames as fit under 50 ms at the device's own measured cost (`floor(50 / cost)`, between 1 and 4); it can only lower the old ceiling of four, so it cannot make the guest faster (`script.js` clamps the handle's answer to 1..4; `tools/gba_room_budget_test.mjs --only tickmodel` runs the extracted `_roomTick` against 72 random schedules, and a mutant that lets the handle raise the cap runs 6 frames in one tick). A/B on the same running Kirby 4-seat room, same throttle, alternating fixed-four and adaptive in 20 s windows, twice each:

| Throttle (p50 / F) | policy | rate (4 windows) | ticks over 50 ms in 20 s (4 windows) | longest tick |
|---|---|---|---|---|
| 4x (1.7) | fixed four | 0.530 / 0.528 / 0.528 / 0.528 and 0.544 / 0.542 / 0.542 / 0.542 | **312 / 180 / 185 / 195** and 322 / 205 / 194 / 182 | 100 / 79 / 75 / 75 ms |
| | adaptive | 0.527 / 0.528 / 0.528 / 0.528 and 0.538 / 0.540 / 0.540 / 0.540 | **0 / 0 / 0 / 0** and 0 / 0 / 0 / 0 | none over 50 ms |
| 6x (2.7) | fixed four | 0.328 / 0.327 / 0.327 / 0.327 (twice) | 191 / 138 / 149 / 145 and 187 / 144 / 147 / 144 | 162 ms |
| | adaptive | 0.324 / 0.326 / 0.326 / 0.326 (twice) | 126 / 62 / 69 / 58 and 125 / 57 / 55 / 61 | 75 ms |

The rate is the same to within 0.006x (the order of the two policies alternated, so drift hits both) and the long tasks are gone at 4x and halved at 6x, where one frame alone (45 ms) plus the upload is already at the line.

#### The input delay sweep

Super Bust-A-Move at its title screen, 2 windows, the starting delay fixed with the loopback-only `?delay=N` seam, both windows throttled, 25 s each (`--mode sweep`; the engine may raise the delay by itself and none did):

| delay | 1x: rate / stalls (A, B) | 4x: rate / stalls | 6x: rate / stalls (A, B) |
|---|---|---|---|
| 1 | 0.999x / 0, 0 | 0.999x / 1, 1 | 0.996x, 0.995x / **7, 15** (0.2%, 0.6% of the time stalled) |
| 2 | 1.000x / 0, 0 | 0.999x / 0, 0 | 0.998x, 0.997x / 2, 3 |
| 3 | 0.999x / 0, 0 | 0.999x / 0, 0 | 0.997x, 0.997x / 4, 4 |
| 5 | 1.000x / 0, 0 | 1.000x / 0, 0 | 0.999x, 0.999x / 0, 0 |

Kirby, 2 windows, at its title screen (where Kirby busy-waits, its heaviest idle scene), the same sweep with delays up to 8 and throttles that put its cost near 0.8 and 1.0 of a frame, 25 s each:

| delay | 1x: rate / stalls (A, B) | 4x: rate / stalls (A, B) | 5x: rate / stalls (A, B) |
|---|---|---|---|
| 2 | 0.999x / 0, 0 | 0.986x, 0.986x / 11, 17 (0.1%, 0.2% of the time) | 0.804x, 0.803x / **80, 48** (1.5%, 0.9%) |
| 3 | 1.000x / 0, 0 | 0.983x, 0.982x / 3, 12 | 0.774x, 0.774x / 25, 34 (0.5%, 0.6%) |
| 5 | 0.999x / 0, 0 | 0.985x, 0.985x / 0, 0 | 0.799x, 0.801x / 0, 0 |
| 8 | 1.000x / 0, 0 | 0.987x, 0.988x / 0, 0 | 0.816x, 0.816x / 0, 0 |

**More delay removes the stalls and gives back almost none of the rate**: at 4x it gives back nothing (0.986x -> 0.987x), at 5x, where the room is overloaded, 2 -> 8 frames removes every stall and recovers 0.012x (the 1.5% of the time those stalls took) for 100 ms of extra latency. So the per-frame cost was measured as a candidate term for the starting delay and **left out**: a device short of power is slow because its frames do not fit, and delay cannot make them fit.

Every rate is within 0.005x of 1.000x and none is above it: a longer delay costs latency and nothing else, a shorter one costs a few stalls on a slow machine, and the engine's own give-back already walks a room from 3 down to 2 within the first minute on a clean link (every unthrottled and 4x arm above ended at delay 2; the 6x Super Bust-A-Move arm stayed at 3). The loopback link here is about 1 ms; **a real round trip is not exercised by any of this** - that part of the rule is the engine's own formula, tested against it in Node.


### The seat cap

`room.js` `seatCap({ game, deviceMemoryGB, slowdown })` answers, for every seat count the title passed in the link matrix, `ok` or a refusal with a code (`SEATS_DEVICE_MEMORY`, `SEATS_DEVICE_SLOW`, `SEATS_DEVICE_UNMEASURED`) and a sentence. The page (`gba.html` "THE DEVICE BUDGET") feeds it two readings taken the moment the host looks at the seat picker: `navigator.deviceMemory` (a rounded hint; absent on Safari and Firefox) and the speed test above. Refused counts are **disabled and labelled "not on this device"**, the reason is written under the picker (for example, on a device 2x slower than the reference: *"3 players is not offered: 3 players would need about 15.7 ms of this device for each frame of Kirby Nightmare in Dreamland at its busiest (a typical frame 10.4 ms), and a frame lasts 16.7 ms, so its busiest frames would not fit and the room would stutter. 4 players is not offered: 4 players would need about 20.7 ms ... so its busiest frames would not fit and the room would stutter."*; on one 6x slower, each count says *"... so the game would run at about 0.69x / 0.48x / 0.37x of full speed for everyone"*, the rate being 0.9 x one frame / the typical frame, the relation the throttle table shows), and a lobby hand-off for a count the device cannot hold (`?host=1&seats=4`) opens no room and says so.

* **Speed.** `COST_REFERENCE` (table above) times the measured `slowdown`, against `USABLE_FRACTION` = 0.75 of a frame, judged on the **p95** (the mean hides the frames that stall a room). The rooms that held 1.000x in the throttle table had a p95 of 0.91 of a frame or less; the cells that did not had 1.16 (Kirby 2 seats at 5x) and 1.22 (Super Bust-A-Move at 6x, the failing cell with the lowest p50, 0.96). 0.75 leaves a quarter of a frame spare and is deliberately short of the measured knee: the reference also takes the larger of the final scene and the walk, which makes it up to 1.6x more conservative for Kirby at 3 seats (walk p95 7.87 ms, final scene 4.93), and the speed test reads up to 11% high. **On the reference desktop everything is offered; the refusals begin at a slowdown of 4.0 for Super Bust-A-Move, 3.5 for Sonic Advance 3, 2.3 / 1.6 / 1.2 for Kirby at 2 / 3 / 4 seats.** (In the throttle table the 4x arms of all three 2-seat cells held 1.000x and would be refused at that slowdown by this rule: it errs toward refusing, and the host can override a speed refusal.)
* **The override.** A speed refusal carries an "Offer those anyway" button, because the estimate can be wrong in both directions (a busy desktop reads slow; a phone that throttles itself after a minute reads fast). Clicking it says what to expect ("the room will run slower ... and it will say so"). **A memory refusal has no override**: the room page needs one fixed 192 MiB block (README "Memory"); 0.5 GB and below is refused for every count, 1 GB for three and four seats.
* **No usable reading** (no speed test, e.g. the reference is missing): two seats only, with `SEATS_DEVICE_UNMEASURED` for the rest. A fast device is never refused for being unmeasured because the test needs no permission and always runs.
* **What decides memory, honestly.** The room page costs 276-300 MiB of renderer private bytes at 2, 3 and 4 seats alike (cell table), so the seat count does not change memory and the memory rule is a gate on whether a device can host at all, not a per-seat figure. Its thresholds (0.5 GB, 1 GB) are **conservative guesses from that 276-300 MiB figure, not measured on any low-memory device**; none exists here. The `lowmem` test section runs the Capability layer's own low-memory arm (a 192 MB V8 heap, as `tools/device_matrix.mjs` does) and `Capability.heapCheck(192)`: that arm limits the JavaScript heap, not WebAssembly memory, and a 2-seat room ran and held 1.000x in it (heap limit read 96 MB unflagged and 288 MB with `--max-old-space-size=192`: the two readings differ, which is the Capability layer's own arm proof, but the flagged one reads HIGHER, so on this Chrome `performance.memory` is not a faithful size of the V8 limit and that proof does not show the heap got smaller; `heapCheck(192)` was granted; the room held 0.9991x on both pages and its JavaScript heap stayed at 10 MB of 288). It cannot show what a phone does when the allocation of the 192 MiB block itself fails; that path is exercised only by `tools/gba_netplay_test.mjs --only alloc` (a mocked refusal).


### The input delay

`defaultInputDelay({ budgetsMs, costMs })`: the host runs `Session.rttReport` to every other player (six pings each, outliers dropped and a jitter margin added by the engine's `Lockstep.rttBudget`) just before it declares ready, takes the engine's own sizing - `ceil(worst round trip / 2 / 16.74 ms) + 1`, plus the second-worst round trip for three or four players because a guest-to-guest input crosses the host (`Lockstep.recommendDelayForRoom`; equality with the engine is a Node check on nine round-trip classes) - and never goes below 2 frames. For one peer that is **2 frames up to a 33 ms round trip, 3 to 66 ms, 4 to 100 ms, 7 at 200 ms, 13 at 400 ms, 25 at 800 ms, the ceiling of 30 beyond.** Nothing measured keeps GR2's 3. Guests adopt the host's delay from `lsgo`. The measurement is bounded to 6 s so a peer that never answers cannot hold the room's start. The device's own per-frame cost does not add delay: the Kirby sweep shows that a longer delay on a device short of power removes its stalls and recovers at most the 1.5% of time they took. A late peer, at any delay, **stalls** the room (the sweep's stalls column): the guest's rate never rises, the delay is latency. The engine keeps raising (on a sustained link-shaped stall) and giving back (one frame at a time after a calm) by itself; this sets only the start, so that a 200 ms link does not spend its first seconds stalling at 3.


### The live notice: "this device cannot keep up"

`gba.html` samples the room's rate every 500 ms (applied frames over the last 6 s against 59.7275), and `room.js` `PaceWatch` raises the notice only after **5 s at under 0.95x** and after the first 10 s since the room's machine was built; one stall or one collection does not raise it, and it clears after 4 s at or above 0.98x. Who is slow is the engine's own: every page publishes its measured capacity (`ls.selfCap` = 16.74 ms / its own cost) and the time it lost without waiting (`ls.selfLostMs`), the engine sends both in its pace messages, and `Lockstep.paceVerdict` says who the room is waiting on. `paceNotice` turns that into words, **reading each console's published capacity first**: with four slow devices that all wait on each other the engine's own rule says "the connection" (checked in Node against the real engine), and the notice names the devices instead. The words, from the runs below:

* The host, with the Kirby 4-seat room and window 4 at 6x: **"Seat 4's device is too slow for this room: the game runs at 0.41x for everyone. Seat 4's device can make about 0.44x of the frames the game needs. The room goes at the speed of its slowest device; nothing can make it faster than that. You can start a smaller room without that player, or leave."** The slow window itself: *"This device (Seat 4) is too slow for this room: the game runs at 0.41x for everyone. ... Leave, or open a smaller room."* A guest sees the host's sentence ending *"You can leave, or ask the host to start a smaller room."*
* Several slow seats are listed together ("Seat 1, Seat 2, Seat 3 and Seat 4 are too slow ..."); a capacity above 1x is described as losing time in bursts, not as short of power; a verdict that is really the network says "This is the network, not a device" and that the delay rises by itself; no verdict yet says "cannot yet tell which device is slow".
* **It never offers a way to run faster, because there is none.** The banner (`#netPace`, fixed so it also shows on the phone shell, buttons 44 px high) has Leave (two presses while the room can still be saved, as in the Party panel), **Start a N-player room** (host only, and only above the title's smallest count: it leaves, then reopens the Party panel on the host form with the title and N already chosen; nothing opens by itself) and "Keep playing". The HUD carries the same sentence and the capacity phrase; the Party panel's status line carries it when the panel is open.
* Measured, 2 seats, one window at 30x (a stand-in, absurd on purpose): the host's notice read *"Seat 2's device is too slow for this room: the game runs at 0.06x for everyone."* and the slow window's *"This device (Seat 2) is too slow ..."*; Kirby x4 with one window at 6x: all four windows named **Seat 4**, at 0.41x. From the moment window 3 of a 3-seat Kirby room was throttled 8x to all three windows showing the notice took **7 s** (the 6 s rate span plus the 5 s debounce, less what the rate had already lost); the banner's buttons were 44 px high or more, "Keep playing" hid it on that window only, and "Start a 2-player room" left the room and reopened the Party panel on the host form with Kirby and 2 players already chosen (the other two were told the host left). With the throttle lifted the notice cleared on both windows of a 2-seat room and the room read 0.9996x / 1.0005x. On 390 x 844 touch windows (Chrome's engine, not WebKit) the caps, notice and pacing sections pass the same 37 checks (the notice within 6 s; the 30 s rate 0.9999x on both pages): the banner is fixed over the top of the picture on the phone shell, its buttons are 44 px high or more, and "Keep playing" moves it away; it was looked at in the screenshots, not measured for overlap with every touch control.


### Gate 9 (CLAUDE.md): nothing here can run the guest above 1.000x

* **Measured, in the page, 30 s, 2 seats** (`tools/gba_room_budget_test.mjs --browser --only pacing`): a live Super Bust-A-Move room ran at **0.9999x and 1.0004x** (1,797 frames on each page in 30.0 s; one frame is 0.0006x of a 30 s total, so +0.0004x is less than one frame), the two pages agreed to 0.0005x, and no 1-second window was above 1.06x (a one-second window counts whole frames: its standard deviation was 0.0090x and 0.0082x because one frame is 0.0167x of a second). Windows CPU busy 51% then 9% while it ran. **Repeated under load** (the final run, under the exclusive browser lock, while other agents' non-browser work took Windows CPU busy from 57% to 80%): **0.9997x / 0.9997x**, 1,796 frames each; and on 390 x 844 touch windows (45% to 40%): 0.9999x / 0.9999x, 1,796 frames. A page's guest rate is wall-clock credit, so load can only lower it (a stall), and 80% busy did not. The noise of one measurement is therefore one frame in the window: 0.0006x at 30 s. The status bar read `guest 59.76/s (1.000x hardware) · presented 59.8/s` and the capacity phrase read `59.8 presented, 13x headroom`. The same check against a page whose `GBA_HZ` was doubled (`script.js` rewritten in flight over CDP `Fetch.fulfillRequest`, nothing in the repo touched) read **2.000x / 1.998x** and FAILS it, so the check can fail; the unmutated twin passes. A room started with a 7-frame delay (`?delay=7`, loopback test seam) read 1.0016x / 1.0018x over 12 s (one frame is 0.0014x there): the delay is latency, not rate.

* The new code can only lower things. `framesPerTick` answers 1-4 and `script.js` clamps whatever the handle says to that range; the recorder, the capacity published to the room and the HUD's "N presented, Mx headroom" are measurements and never feed the clock; `ls.frameHz` is not touched; the `#fps` readout keeps its family format (`guest N/s (Nx hardware) · presented N/s`, checked by `tools/gba_page_standard_test.mjs`). Headroom is a capacity: a Kirby 2-seat room that costs 3.65 ms a frame "has 4.6x headroom" and runs at 1.000x.
* **A late tick repays real lateness, a stall repays nothing.** After a tick the browser delivered up to 100 ms late the loop runs up to four frames back to back (as the solo loop's three do): that is wall time that really elapsed, and over any trailing second a room can hold at most 59.7 plus 6.97 frames (the 100 ms credit cap plus one leftover frame). The extracted `_roomTick` model shows it (most frames in a second over 72 random schedules: 64, bound 66), and that a stall's debt is dropped: a mutant that banks credit across a stall runs 84 frames in a second, and one that charges 1 ms of credit per frame runs 2.59x.
* The open owner question about a rejoining page replaying hidden history is **not touched and not decided** by this stage.


### Does the 2-4 core stepping have to leave the main thread? (a Worker)

**No, and none was built.** Evidence: (1) on this desktop **not one frame of 3,000 in the final scene, nor of the walk, was over 16.74 ms** at 2, 3 or 4 seats of any title, the largest single frame being 15.4 ms (Kirby, 4 seats). (2) The emulator core is 88-97% of a room frame and everything else the main thread does for a room is 0.2-0.3 ms, so a Worker moves the same cost to another thread: it cannot lower the cost that sets the knee, and the throttle table shows the room's rate follows that cost (rate ~ 0.9 x 16.74 / p50) on every overloaded arm. (3) The one harm that was specific to the main thread - long tasks that delay a key press - was 312 per 20 s at the old fixed four frames per tick on an overloaded room and is 0 with the cost-adaptive tick, at the same rate. (4) Where the Worker could still help is the band between "the core fits a frame" and "the core plus the main thread's other work fits a frame": by the cell table at most the 0.2-0.3 ms plus jitter, about 3-12% of capacity (one measured cell sits in that band: Super Bust-A-Move at 6x, p50 0.96 frame, 0.916x), and only on a device with a second core to run it on. (5) The seat cap already lowers the supported seat counts to the ones this main thread holds with a quarter of a frame to spare, which is the sense of "the supported seat counts" in the question.

**Design (written either way, as asked; NOT implemented).** A `Worker` hosts the one wasm instance and all N linked cores (`gba/mgba/room_worker.js`, a classic worker script loading `dist/mgba_core.js` and `mgba_core.js`); it needs no `SharedArrayBuffer`, no `coi-serviceworker`, no cross-origin isolation, only `postMessage` with transferables, so the page stays as isolated-free as it is today. The main thread keeps everything with a DOM or a decision: the Lockstep engine (`lib/netplay.js`), `localPad`, the journal gate, the fingerprint compare, the AudioPipe and the canvas. Messages: main to worker `boot {config, romBytes (transferred), images, wasmBytes (transferred)}` (the md5 of the wasm and the ROM are checked on the main thread first, exactly as `bootMachine` does now); `step {image: Uint8Array(16), hash: bool}` per applied frame (up to four per tick, batched); worker to main `frame {n, status, video: Uint8ClampedArray(57,600) (two ping-pong buffers, transferred), audio: Int16Array of the LOCAL seat (transferred), words[]: the fingerprint when `hash` was set}`. Gate 9 does not move: the main-thread accumulator is still the only clock, releases at most one frame per 16.7427 ms of credit and drops a stall's debt; the worker never schedules itself. What it would cost: a message round trip per tick, one frame of pipelining between `beginFrame` and `endFrame` (the engine needs the fingerprint of frame f before it can finish f, so `endFrame` moves to the reply), and hidden replay frames for a returning page would be sent in batches. The `RoomMachine` end handshake and the journal gate read the input image synchronously today and would have to read it from the reply. It is a rewrite of `roomFrame`, `roomTry`'s boot and the replay path, with tests for each.



### What this does not show, and what needs real hardware

* **No phone, tablet or low-memory device was measured.** Everything is a shared Windows desktop (Ryzen 7 3800X, 16 logical cores, other agents' suites running: Windows CPU busy 6-77% across the runs), Chrome 156 under SwiftShader. A CPU throttle slows every task by one factor; a real device's emulation speed, memory system, thermal limit and battery saver are not that. **What needs hardware:** (a) that the speed test predicts the emulator's cost on a phone (here: within ~11% under a uniform throttle only); (b) the cost table on a phone at 2, 3 and 4 seats, in the busiest scenes of every title; (c) where the real knee sits on a phone (USABLE_FRACTION is derived from a stand-in); (d) what a phone does when the 192 MiB block fails, and the `deviceMemory` thresholds; (e) the notice and the banner on a real phone shell (it is checked at 390 x 844 in Chrome's engine, not WebKit); (f) rAF at 30 Hz under battery saver (the room tick repays real lateness up to four frames, which is what lets a 30 Hz display hold 1.000x; not measured here).
* **No real network.** The link here is a BroadcastChannel of about 1 ms. The delay rule's round-trip classes (50, 100, 200, 400, 800 ms) are checked against the engine's formula in Node, not by a room over a slow path; the real-network pace (`lspace`, `paceVerdict` on a path-limited room) was not exercised.
* **No second human, no audio device** (every browser was started with `--mute-audio`; audio is checked by the sink's counters).
* **One run each**, on one box with changing load. The cost table is the mean of two to four pages of one run per cell; the throttle arms are single 30-40 s windows. Numbers are good to the 0.1 ms the timer allows and to the load noted.


### Running it

**Timing needs the whole machine.** The shared browser lock (`tools/headless_cdp.mjs`) has three slots since 2026-11-02, so up to three headless Chromes can run at once; the rig and the browser sections of the test therefore set `BROWSER_LOCK_EXCLUSIVE=1` themselves (the exclusive holder waits for running shared ones to drain and blocks new ones; `BROWSER_LOCK_EXCLUSIVE=0` opts out and the numbers then carry whoever else ran). Every number above was taken under the earlier one-browser-at-a-time lock, which is exclusive by construction; the Windows CPU load that was running at each is stated beside it (it was other agents' suites outside the lock's reach: 6-77%).

```bash
npm run web   # or: PORT=8113 node tools/devserver.mjs          (Range-capable; never python's http.server)
BROWSER_LOCK_TIMEOUT_MS=7200000 node tools/gba_room_budget_measure.mjs --mode cells --cells sbam2,sa32,kirby2 --frames 3000 --rss
BROWSER_LOCK_TIMEOUT_MS=7200000 node tools/gba_room_budget_measure.mjs --mode cells --cells kirby3,kirby4 --frames 3000 --rss
node tools/gba_room_budget_measure.mjs --mode throttle --cells sbam2,sa32,kirby2 --rates 4,6      # a CPU throttle, a stand-in
node tools/gba_room_budget_measure.mjs --mode calib ; --mode sweep ; --mode slow1 --cells kirby4 --rate 6
node tools/gba_room_budget_test.mjs [--browser] [--only pacing,caps,lowmem,notice,delay]            # the exit tests
GBA_BUDGET_PHONE=1 node tools/gba_room_budget_test.mjs --browser --only caps,notice                # the same on 390x844 touch windows
```

## Memory (fixed heap: 192 MiB, `ALLOW_MEMORY_GROWTH=0`)

Measured in Node, `sbrk(0)` high-water in MiB after loading the ROM into N seats, 120 frames and one savestate per seat:

| ROM | 1 seat | 2 | 3 | 4 | note |
|---|---|---|---|---|---|
| Super Bust-A-Move (4 MiB) | 7.8 | 8.4 | 9.0 | 9.7 | pristine: one shared ROM |
| Kirby (8 MiB) | 11.9 | 12.6 | 13.3 | 13.9 | pristine |
| Sonic Advance 3 (16 MiB) | 20.0 | 20.8 | 21.6 | 22.4 | pristine |
| Pokemon SoulGold (32 MiB, RTC) | 68.0 | 100.9 | 133.8 | 166.6 | +32.9 MiB per extra seat: mGBA's GPIO copy |
| PKMN Ultra Violet (16 MiB) | 52.3 | 85.4 | 118.5 | 151.6 | also not pristine after reset, so the same per-seat 32 MiB copy (cause not investigated) |

A pristine cartridge costs one ROM + ~0.7 MiB per extra seat (the fork copied the ROM per core and measured ~65 MiB per extra SoulGold core). 4 x SoulGold peaks at 166.6 MiB,
leaving 25.4 MiB; `tools/gba_mgba_core_test.mjs` fails below 16 MiB headroom for every ROM we ship. The RTC copy cannot be shared by the bridge: mGBA writes the GPIO registers *into*
the ROM image, so each seat needs its own. A solo SoulGold player is 68.0 MiB of a 192 MiB heap (Node RSS rose ~1.7 MiB on instantiate; one measurement, Node on Windows, not a
statement about phones).

## Measurements (this machine: shared, 16 logical cores, CPU about 3% when sampled; none of this is a device number)

- **Frame accounting.** Per call and per seat the core's frame counter equals the call count, for 4,800 calls solo and 4,800 calls on 2 linked seats through the menus and a battle
  (`tools/gba_mgba_core_test.mjs accounting`). Guest cycles: solo drift from `k x 280,896` is within -1..+8 cycles and does not grow; the 2-seat master runs up to ~8,150 cycles past its
  boundary to wake the secondary (bounded, not growing); the secondary's mean is 280,896.03 cycles/frame. These are cycles of *emulated* time; wall-clock pacing is G6's.
- **Speed (informational; Node and headless Chrome on a shared desktop, one measurement each - not device numbers, and the cost depends far more on the game than on the bridge).** Super Bust-A-Move: 0.19 ms/frame solo,
  0.38 for 2 linked seats (it halts the CPU while idle). Kirby at its title screen busy-waits: 1.25 ms/frame solo, 2.67 for 2 linked seats, 5.08 for 4 (about 1.3 ms per seat, i.e. the link and
  the cooperative loop add ~5-7% over N independent cores); the same 2 Kirby seats took 2.8-3.1 ms/frame in headless Chrome and 3.0 in Node over 600 frames. The fork's "4,000 FPS / 0.24 ms for 4 cores" is a native desktop
  benchmark, not this (plan Part 2). Nothing here paces to 1.000x; whether 2-4 seats of a busy-waiting game hold 16.74 ms on a phone is G6's measurement.
- **Determinism.** Two separate wasm instances, identical key streams: identical per-seat hash chains and link hashes every 60th frame (default 3,000 frames after a 4,800-frame walk
  into the 2P battle; `GBA_SOAK_FRAMES=...` for longer). A one-bit key flip is caught; hashing does not perturb the run; and two instances that BOTH restored the same savestates stay identical to each other (`state transfer` in the core test: instance A restores its own states, a fresh B restores the same bytes). An instance restored from a savestate is **not** the same machine as one that kept running - `hash()` and `hashGame()` differ (see the `hashGame` row and "Rooms") - so a room never compares across a restore.
- **Reproducibility.** `node tools/gba_mgba_build_test.mjs --rebuild` makes two CLEAN builds and compares them with `dist/`. At the setRtc order fix (G1 fix) both clean builds gave wasm md5 `434c63e5d1ba3316ac99c16af7573f51` and glue md5 `6221235b4cf3e5b71dd6efcfd2081173`, equal to `dist/` then. **`dist/` has been rebuilt since** (G2 added `rtcWitness` to the bridge): it is now wasm md5 `13474b3883009819a5ac7304e568cb0a` (791,107 B) and glue md5 `b2d6dba079610b9edc18ee994eb2a0b4` (72,521 B), which is what `dist/mgba_core.buildinfo.json` records and what `tools/gba_room_determinism_probe.mjs` and `tools/gba_room_protocol_test.mjs` hashed in this fix. GR1 did **not** re-run `--rebuild` against the current artifact, so two-clean-builds reproducibility is measured for the G1-fix artifact only. One machine, one toolchain (Emscripten 6.0.2, cmake 4.4.4, ninja 1.13.2, Windows 11 / Git Bash); other hosts are untested. G0's earlier 320 MiB build was `27b8287f...`, and the build before the setRtc order fix was `3e820153...`; the md5 changes whenever the bridge, patches or heap change.
- **No threads.** Zero occurrences of `SharedArrayBuffer`, `new Worker`, `pthread`, `Atomics` in the wasm and glue; the wasm declares one non-shared memory; headless Chrome ran it with
  `crossOriginIsolated=false` and no `SharedArrayBuffer`.

## Tests

```bash
node tools/gba_mgba_core_test.mjs                    # artifact drift api accounting soak state saves memory incidents rtc (Node, ~1.5 min)
GBA_SOAK_FRAMES=100000 node tools/gba_mgba_core_test.mjs --only soak    # the long determinism soak
node tools/gba_mgba_core_test.mjs --browser          # + the API through window.MgbaCore in headless Chrome (tools/headless_cdp.mjs, PORT=8092 devserver)
node tools/gba_link_smoke.mjs                        # the kill-switch rig: every title above + negative controls; --png-dir DIR, --only sbam-2p,kirby-4p
node tools/gba_mgba_build_test.mjs [--browser] [--rebuild]    # G0
node tools/gba_room_protocol_test.mjs [--browser] [--campaign]   # GR1: room.js on the real Lockstep engine, real cores, mutants (section "Rooms")
node tools/gba_room_determinism_probe.mjs [--browser]             # G2: pinned RTC / zone soak, 18 child processes (section "Determinism pins")
node tools/gba_netplay_test.mjs [--browser] [--only two,kill,...]   # GR2: gba.html rooms in 2-4 real headless windows (GBA_TEST_PORT, default 8092; section "The room page")
GBA_NETPLAY_PHONE=1 GBA_NETPLAY_OUT=DIR node tools/gba_netplay_test.mjs --browser --only audio,alloc,ux,desync   # the same sections on 390x844 touch windows (screenshots for a phone)
node tools/gba_card_cap_test.mjs                                     # the engine card cap, Node only (no browser, no server)
node tools/gba_room_budget_test.mjs [--browser] [--only pacing,caps,lowmem,notice,delay]   # GR3: the seat cap, the delay, the live notice, gate 9 (section "Budget")
node tools/gba_room_budget_measure.mjs --plan plan.json            # GR3: the measurement rig (modes calib, cells, throttle, sweep, slow1; section "Budget")
```

Every check that matters has a negative control that must trip (`[control]`) next to the unmutated twin that must stay quiet. G1's controls include: an LFS pointer / each forbidden word / the
Four Swords strings are caught in a mutant; a drifted header constant; a fast-forward driver (2 frames per call) and a clock that gains 5 cycles per frame fail the accounting verdict; a
one-bit key flip diverges the chain; a state from a different moment diverges; a 1-bit difference fails the save round trip and a wrong-size save is refused; the sharing predicate fails for
the RTC cart; a 128 MiB heap would not hold 4 x SoulGold; a forced stall is reported and never counted as a recover; in the smoke rig a solo core (no cable) and a 2-seat run with an idle
seat 1 are both classified not-linked.

`tools/gba_mgba_build_test.mjs` (G0) was green against the G1-fix build (`--browser --rebuild`: 81 passed, 0 failed; the current artifact is newer, see Reproducibility below). Its two premises that went stale when the shared ROM mapping cut the heap from 320 to 192 MiB were replaced
with checks that cannot go stale: the browser heap is compared with `buildinfo.link.initialMemory` (not a frozen byte count), and the headroom controls are derived from the measured 4-core peak (a heap one byte
short of `peak + 16 MiB` fails, exactly `peak + 16 MiB` passes, a heap equal to the peak fails) instead of from a constant heap size.

G1's RTC controls: the `--only rtc` section also runs against the artifact from BEFORE the call-order fix (`GBA_MGBA_DIR=<copy of the old gba/mgba> node tools/gba_mgba_core_test.mjs --only rtc`) and must fail there
(it did: 12 of 26 checks failed on the old wasm; the same section passes 26 of 26 on the fixed one). The suite also fails when `dist/mgba_core.buildinfo.json` records bridge digests that differ from the
`bridge/` sources on disk, i.e. when a bridge edit was not followed by `bash gba/mgba/build.sh`.

## How git stores the wasm (the genesis failure, 2026-09-07)

`.gitattributes` line 2 (`*.wasm filter=lfs`) would store `dist/mgba_core.wasm` as LFS, and CI checks out with `lfs: false`, so Pages would serve a 132-byte pointer. The override
`gba/mgba/dist/*.wasm filter= diff= merge= -text` fixes it (G0). `tools/gba_mgba_core_test.mjs` re-checks that the file starts `00 61 73 6d` and that `git check-attr filter` is not `lfs`.
The staged-blob form (`git cat-file -p :gba/mgba/dist/mgba_core.wasm | head -c4`) cannot be run without staging, which is forbidden here; whoever commits should run it.

## Known issues and notes for later stages

- **Debug-only exports** ride in the shipped wasm: `_bgb_debug_force_asleep(mask)` (wrapped as `debugForceAsleep`, used by the incident test) and `_bgb_debug_trace*` (records the first 512 scheduler steps; not wrapped, used to find the
  first-call transient). Neither is on any normal path.
- **Startup transient.** The first call of a 2-seat instance leaves the master ~8 k cycles past its frame boundary (visible in `cycles(0)`); it is bounded and deterministic.
- **A halted core is one big step.** A seat whose CPU is halted waiting for an interrupt runs until that interrupt (at most to its next frame boundary). In the 4,800-call walks the frame
  counters were equal at every call boundary and the master was at most ~8 k cycles ahead.
- **`hash()` after a restore** differs from the original, and `hashGame` (which masks only the PSG block) does not make a restored instance comparable with a continuing one either (see the `hashGame` row). Rooms therefore never compare across a restore: a returning page replays from frame 0 (section "Rooms").
- **mGBA decides the battery type at the first access** for carts whose type it does not know up front; `exportSave()` is `null` until then (SoulGold resolves at load).
- `tools/deploy_should_run.mjs` cannot be imported on Windows (its `ROOT` comes from `URL.pathname`); the G0 test falls back to a local matcher. Not fixed (not an owned file).
- `deploy.exclude` (G0) hides `build.sh`, `patches/` and `README.md` but not `bridge/`, so the bridge source is served next to the binary - which is what MPL-2.0 section 3.2 wants.
- The glue keeps Node-only branches (`ENVIRONMENT=web,node`); they are dead code in a browser.
- `gba.html` solo play uses this core since G3 and forms rooms since GR2; the lobby, `lib/*.js` and netplay are untouched (the page and room.js use the Lockstep engine unmodified). **Still not done** (other stages): the lobby catalogue and `CODE_TAGS` for GBA, and stale GBA references in `lib/bench.js`, `lib/audiodiag.js`, `tools/mobile_input_latency.mjs`, `tools/verify_deploy_assets.mjs`, `tools/audit_*` and `multiplayer.html`.

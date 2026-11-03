#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE THINGS THAT ARE NOT DONE, KEPT WHERE THEY CANNOT BE FORGOTTEN.
//
// Asked directly: "how come the auditor let you stop working?" — because the
// auditor only reports FAILURES OF THINGS THAT EXIST. Every harness here answers
// "is the built thing broken". None of them answers "what did we say we would
// build and have not". So a known gap left the moment it stopped being spoken
// about, and staying on it depended on somebody remembering.
//
// This is that list, in the repo, printed by the standing audit on every run.
// Each entry carries the EVIDENCE for why it is open, so nobody has to re-derive
// it, and a `verify` that must FAIL while the gap is real — if a verify starts
// passing, the entry is stale and this exits nonzero demanding it be closed or
// rewritten. A todo list that can quietly go out of date is worse than none.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// ── the GBA entries below ─────────────────────────────────────────────────────────────────────────────────────────────────
// GBA link-cable rooms exist (gba.html, 2026-11-01: every player runs ALL the linked cores of a room in one mGBA wasm instance, only
// pad words and one battery image per seat cross the wire). These are the edges of that feature that are real gaps.
// THE PIN. Several of them are properties of the shipped core binary (a thing the core does not do), and the only honest way to say
// "this binary does not do X" is to tie the claim to THAT binary — the same device the mario-party-4 entry above uses. When the core is
// rebuilt for ANY reason, every entry that cites the pin goes STALE together, which means: re-check each one (did the rebuild add the
// thing?), then re-pin or close it. It is a forced re-read, not a failure.
const GBA_CORE_MD5 = '13474b3883009819a5ac7304e568cb0a';   // gba/mgba/dist/mgba_core.wasm, 791,107 B (also in dist/mgba_core.buildinfo.json)
const gbaCorePinned = () => existsSync('gba/mgba/dist/mgba_core.wasm') &&
  createHash('md5').update(readFileSync('gba/mgba/dist/mgba_core.wasm')).digest('hex') === GBA_CORE_MD5;
// The text from one marker up to the next one, or '' if either marker is missing. Every verify() that asks for an ABSENCE inside such a
// slice also demands a positive anchor, so an unreadable or moved file cannot make a gap read as open (or closed) by accident.
const between = (text, from, to) => { const i = text.indexOf(from); if (i < 0) return ''; const j = text.indexOf(to, i + from.length); return j < 0 ? '' : text.slice(i, j); };

const OPEN = [
  // ── CLOSED 2026-09-09: 'vmu-does-not-carry-into-a-room' ────────────────────
  // It said a saved card could not follow a player into a room, and it was true:
  // seeding was suppressed there because peers must hold byte-identical guest
  // memory at frame 0 and there was no handoff. The room now agrees a full card
  // SET before frame 0 — each console contributes the card for the seat it holds
  // (its stored card, or the exact bytes of its own blank power-on card), the
  // host assembles once every occupied port has contributed, and every console
  // installs the SAME set for all ports before it declares ready. A mismatch
  // REFUSES the room through the same tested path that refuses two different
  // discs, rather than desyncing.
  // Proven on two real browsers: both declare "gauntlet#cards:542da858", both
  // install {0:d500aec5, 1:b19a59c5}, every port byte-identical over all 131072
  // bytes, "Everyone started together at frame 0.", and afterwards each side has
  // persisted only the seat it played. The standing auditor then read
  // 43 pass · 0 FAIL against production, up from 31 pass · 1 FAIL.
  //
  // ⚠ ITS verify() WAS ALREADY LYING WHEN THE FIX SHIPPED — the second entry to
  // do this, so the pattern is the rule and not an accident. It tested for the
  // string `seedSkipped` in dreamcast.html, which SURVIVED the fix: the
  // local-seed path still skips seeding in a room, because the cards now arrive
  // over the link instead. The gap was closed and the gate went on reporting it
  // OPEN. Same lesson the snes entry recorded: a verify() must test an artifact
  // or a live code shape, never a string that prose or a leftover can satisfy.

  {
    id: 'no-working-turn-relay',
    what: 'Two peers on genuinely hostile networks (symmetric NAT) cannot connect at all, and nothing detects it.',
    why: 'There is no working TURN relay. Public relays measured returning 701/400; peerjs\'s own two do not resolve. The lobby shows a "RELAY SERVER — NEEDED TO PLAY ACROSS SOME NETWORKS" box that is unproven.',
    evidence: "tools/audit_all.mjs's dreamcast-room-crossdevice ciWhy records the measurement, and its no-direct-path arm is RED for real.",
    verify: () => /no working TURN relay|701\/400/.test(read('tools/audit_all.mjs')),
  },
  // ── CLOSED 2026-09-10: 'genesis-can-run-frames-before-its-gate-closes' ────
  // It was a MEASUREMENT bug, not a Genesis bug, and closing it is the honest
  // outcome rather than a fix. The rig polled the seam until it saw `armed` and
  // THEN read the live `frame` field — so it recorded the frame at the moment it
  // happened to poll, not the frame at the moment the gate closed. The joiner
  // arms second, so when the host is already ready the barrier releases at once
  // and the joiner's core legitimately advances before the next poll lands.
  // Hence `host 0, join 2` against a console that had done nothing wrong, and
  // hence the intermittency: it was a race between a poll interval and a barrier
  // release, which is exactly what it looked like.
  // genesis.html now LATCHES the engine frame at the instant of arming
  // (`armedAtFrame`) and the rig asserts on that, a value that cannot drift.
  // Reads `frames at the moment of arming: host 0, join 0`, 44 pass / 0 FAIL.
  // The underlying invariant is unchanged and still worth asserting — the boot
  // ordering that guarantees it is documented at genesis.html's LOCKSTEP FRAME
  // DRIVER block: lsArmBeforeFreerun() runs inside bootRom() between gpx_load()
  // and `running = true`, with no await between them.

  {
    id: 'a-long-enough-loss-burst-still-deadlocks-a-relayed-room',
    what: 'A relayed room now survives message loss, but only a BOUNDED amount of it. A loss burst longer than the retransmission window is still a permanent deadlock, and nobody has measured how long a real burst is.',
    why: 'The repair is redundancy, not recovery: every relay publish re-sends the last 2*delay frames of this peer\'s input (RELAY_WIN_MIN..RELAY_WIN_MAX frames), so a frame survives unless EVERY publish carrying it is lost. There is no ACK, no NACK, and no way to ask for a frame that has aged out of the window — if one does, the room stalls forever exactly as it did before, and the only reason that is acceptable today is an unmeasured assumption about burst length. Measured loss on this box was 20.7% of publishes and appeared independent; a real carrier middlebox or a broker outage is not independent, and a two-second gap at 150 ms repair spacing is thirteen consecutive losses.',
    evidence: '/tmp/dc-xdev/fix1.stdout — gapSeq 63 (host) and 51 (join) publishes lost inside one 60 s run, and the room ran through all of them: core ran [71,71] -> [208,208], 44 pass / 0 FAIL. That is evidence the window WORKS at this burst length, not that there is no burst length at which it does not.',
    // Open while recovery is a fixed-size window with nothing behind it. It
    // closes when a peer can ASK for a frame it is missing (a request keyed by
    // frame, not a blind repeat) — at which point a burst of any length is
    // survivable and this stops being a bound.
    verify: () => /RELAY_WIN_MAX/.test(read('lib/netplay.js')) && !/_relayRequest|lsnak|lsreq/.test(read('lib/netplay.js')),
  },
  {
    id: 'never-tested-across-two-networks',
    what: 'Every netplay result in this repo comes from ONE box behind ONE NAT. The two-networks case is unestablished.',
    why: 'Both browsers run on the same machine, so a green run closes the real-UI gap and NOT the network gap. The no-direct-path arm narrows it — it proves a room forms with no direct WebRTC path available — but it does not prove two genuinely separate networks, different ISPs, or a symmetric NAT on both ends.',
    evidence: 'tools/audit_all.mjs: "both browsers sit on ONE box behind ONE NAT".',
    verify: () => /ONE box behind ONE NAT/.test(read('tools/audit_all.mjs')),
  },
  // ⚠ THIS REPLACES `gamecube-has-no-lockstep`, WHOSE verify() COULD ONLY EVER
  // HAVE BEEN WRONG. It read
  //     () => !/lockstep/.test(read('gamecube/dolphin_libretro/dolphin_worker.js'))
  // — the string "lockstep" appearing ANYWHERE in that file, including in a
  // comment, would have closed it; and the frame gate GameCube actually needed
  // was never going to live in dolphin_worker.js at all, because the JIT path
  // has no emulated-frame boundary to gate (gamecube.html's own note: under
  // emscripten dual-core `retro_run` advances ZERO guest cycles). It landed in
  // the RECOMP engine instead, so the old entry would have gone on reporting
  // "GameCube has no netplay at all" indefinitely while two machines played
  // Mario Party 4 in a room. Its wording understated the blockers and its test
  // watched the wrong file. The two entries below are what is actually left,
  // and both test a live code shape in the file the gap is IN.
  // ── CLOSED 2026-10-01: 'gamecube-rooms-do-not-agree-a-memory-card-set' ───────
  // It said two GameCube consoles in one room start from DIFFERENT memory cards,
  // and it was true: each adopted its own IndexedDB card before _main(), and the
  // card shim also stamped THIS machine's wall clock into guest memory. Now the
  // room plays on ONE card — the host's, or one blank card — at the host's card
  // clock: it travels through ls.contributeCards() gzipped, every console checks
  // the raw fingerprint before booting it, the choice rides in the disc tag the
  // barrier compares (gamecube.html gcLsAgreeCard / gcLsDisc), and only the host
  // persists what the room saves. The fingerprint it was "detected" by is now the
  // whole guest state, because tools/gc_netplay_det_test.mjs measured the whole
  // linear memory byte-identical across browser processes.
  {
    id: 'mario-party-4-recomp-stops-at-an-overlay-it-was-not-built-with',
    what: 'The Mario Party 4 recomp (the engine GameCube rooms run on) STOPS when the game needs an overlay it was not built with — a party cannot get past the first board\'s first minigame/event scene.',
    why: 'gamecube/recomp/build_wasm.sh AOT-dispatches exactly four overlays — OVL_BOOT, OVL_MODESEL, OVL_MENT and OVL_W01 (the first board) — so when a board asks for any other overlay (a minigame, an event scene, another board) omWatchOverlayProc calls a null entry: `null function or function signature mismatch` (seed 4 of the board masher at frame 12,737; a 2-tab ROOM on the board at frame 13,688 — on BOTH consoles at the same frame, no desync) or `table index is out of bounds`. Separately, Start-mashing through the menus reaches `memory access out of bounds` in LoadHSF <- Hu3DModelCreate inside modeseldll, and one seed hangs at frame 7,963 in a loop that makes no host call. All of these were hidden behind a FREEZE until 2026-10-01: HuAudSndGrpSetSet (and omWatchOverlayProc) busy-wait on OSGetTick, and this port\'s clock moved only at a retrace (fixed in recomp_worker.js THE TIMEBASE DURING A BUSY-WAIT; running the AI callbacks inside the wait, boot msg spinAudio, does not move the LoadHSF trap frame). Compiling the other overlays needs a rebuild of mp4_game.wasm from the decomp tree (~/gc_refs/marioparty4), which is not on the build box. In a room the simulation is shared, so every console stops on the same frame and the party panel says it was the game, not the room (gamecube.html window.__gcTrap).',
    evidence: 'tools/gc_netplay_det.html ?hash=0: script=mash2 (Start-mashing) seeds 1-6 — HEAD worker HANGS at frames 5122-6394 on all six, the fixed worker reaches 20,000 on seed 3 and traps on 1/2/5/6 (frames 5680-7527); script=mash (board chain + masher) seeds 1-4 — 25,000 frames on 1 and 3, hang at 7963 on 2, null-function trap at 12,737 on 4. tools/gc_netplay_room_test.mjs CHAIN=1: both consoles stopped at frame 13,688 with 228/228 fingerprints agreed.',
    // the shipped binary: a rebuilt mp4_game.wasm makes this entry stale and forces re-checking
    verify: () => existsSync('gamecube/recomp/mp4_game.wasm') &&
      createHash('md5').update(readFileSync('gamecube/recomp/mp4_game.wasm')).digest('hex') === '7040471c12551e8ebb57bffe94691944',
  },
  {
    id: 'gamecube-room-is-delay-lockstep-not-rollback',
    what: 'A GameCube room (Mario Party 4) delays every player\'s own input by the room\'s delay frames — it is delay lockstep, not zero-lag rollback.',
    why: 'Rollback needs a savestate EVERY frame and a re-simulation burst on a misprediction. Re-simulation is cheap here (guest compute p50 0.4 ms, p95 7 ms per frame, measured in the worker); the SAVESTATE is not. The recomp\'s exact state is the whole guest — [0, heap top) + MEM1 = 63.5-65.6 MB, ~25-28 MB of it non-zero — and per frame only 29 pages (1.8 MB) change at p50 and 80 (5 MB) at p95, but wasm has no write barrier, so FINDING those pages costs a full sweep (~20 ms at the 3.4 GB/s the hasher measured) and copying the whole state out/in measured 15-480 ms each way on the dev box (load-dependent). Either way one snapshot costs most or all of a 16.7 ms frame before the game runs, so a per-frame ring is unaffordable. A dirty-page snapshot needs the stores instrumented at compile time — a rebuild of gamecube/recomp/mp4_game.wasm from the decomp tree (~/gc_refs/marioparty4), which is not on the build box.',
    evidence: 'tools/gc_netplay_det_test.mjs: rollback-cost lines (snapshot MB, copy-out/copy-in ms) and "pages CHANGED per frame"; gamecube.html gcLsStep never reads ls.rollback.',
    // a live code shape: the frame gate branching on the room's rollback window
    verify: () => !/if\s*\(\s*ls\.rollback\b/.test(read('gamecube.html')),
  },
  {
    id: 'gamecube-lockstep-is-mario-party-4-only',
    what: 'Only ONE GameCube title can be played in a room — the other three cannot be gated at all.',
    why: 'The frame gate is built on the recomp engine\'s credit protocol (one credit == one guest frame with known input), and the recomp is the Mario Party 4 decompilation compiled to wasm. Sonic Adventure 2 Battle, PSO and 240pSuite run on the JIT path, where gamecube.html\'s own note records that under emscripten dual-core retro_run advances ZERO guest cycles and the CPU free-runs inside JitWasm::Run\'s unbounded loop — there is no one-emulated-frame boundary to gate, so lockstep is not merely unwired there, it is unbuildable until that changes.',
    evidence: 'gamecube.html routes engines from RECOMP_TITLES, which holds exactly one entry; gamecube/tools/gc_room_test.mjs boots two rooms of that one title and nothing else can follow it.',
    // The routing table itself, which the live router reads — adding a second
    // title to it is exactly the change that should make this stale.
    verify: () => /RECOMP_TITLES\s*=\s*\{\s*MarioParty4:\s*1\s*\}/.test(read('gamecube.html')),
  },
  // ── CLOSED 2026-09-09: 'snes-needs-a-core-rebuild' ─────────────────────────
  // It said "SNES cannot present a second controller", and it was true: the
  // shipped snes9x_2005 answered a hardcoded 0 for every port but 0, verified in
  // live wasm memory as IPPU.Joypads[0..4] = 0xffff0201 0 0 0 0. The core has
  // been rebuilt (exports.c joyPadInput[5] + setJoypadInputPort; build.sh's
  // EXTRA_EXPORTED_RUNTIME_METHODS -> EXPORTED_RUNTIME_METHODS and the HEAP
  // exports), and both ports are proven: Joypads[0..4] now read
  // 0xffff1080 0xffffa000 0 0 0, and in Tetris 2PLAYER GAME port 0 holding LEFT
  // moved only the LEFT well (x 16..71) while port 1 holding LEFT moved only the
  // RIGHT one (x 160..215).
  //
  // ⚠ ITS OLD verify() WAS ALREADY LYING BEFORE IT WAS REMOVED, which is worth
  // recording because the same trap is available to every entry here. It was
  //     /if\s*\(\s*port\s*==\s*0\s*\)/.test(read('.../exports.c'))
  // and after the fix the ONLY thing left matching it was the header comment
  // QUOTING the code that had just been deleted. It reported OPEN off a comment
  // about the fix. A verify() must test an artifact or a live code shape, not a
  // string that prose can satisfy.
  {
    id: 'eight-players-is-not-reachable',
    what: 'No console here reaches 8 players.',
    why: 'Dreamcast MAPLE_PORTS is 4 and N64 exposes 4; Since 2026-10-07 PS1 (ps1.html: a multitap in port 1 via pad_worker.c ps1_multitap when 3+ are seated), SNES and Genesis rooms seat 4 (snes.html: a Super Multitap via exports.c setMultitap when 3+ are seated; genesis.html: a Team Player / 4-Way Play via gpgx_shim.c gpx_set_multitap for a cart that takes one) — but no room opens more than 4 ports, and a SNES multitap has 4 pads behind it plus port 1 (5 players), a Genesis Team Player in each port 8: the core can, no page asks for it. init_sfc_setting still boots SNES_JOYPAD (the adaptor goes in per room).',
    evidence: 'ps1.html PS1_PORTS = 4 (one multitap: 4 slots; a second one in port 2 would make 8, no page asks for it); snes exports.c init_sfc_setting sets Settings.ControllerOption = SNES_JOYPAD.',
    verify: () => /ControllerOption\s*=\s*SNES_JOYPAD/.test(read('snes/snesWasm/source/exports.c')),
  },

  // ════ GBA LINK-CABLE ROOMS (plan G8, 2026-11-02) ═══════════════════════════════════════════════════════════════════════
  // The user decided these are OUT OF SCOPE for the first delivery (docs/gba-link-and-arena-plan.md, stage GR5). Each is written down
  // here so that "out of scope" cannot quietly turn into "forgotten". Every verify() reads a LIVE artifact or code shape in the place
  // the gap is IN, never a sentence in a doc.
  {
    id: 'gba-wireless-adapter-games-cannot-be-served',
    what: 'Games that link through the GBA Wireless Adapter (the RFU) cannot be played in a room - only the link CABLE can. That includes the Pokemon games\' wireless rooms; their Cable Club is the cable path and is a separate entry below.',
    why: 'mGBA, the core the site ships, has no RFU driver, so there is nothing for a game to talk to. The shipped core is the pinned Spuds0588/mgba-splitscreen fork at f1d5975d + four patches + the site\'s own bridge, built to wasm md5 13474b38...; none of the four patches or the bridge adds an adapter, and a game that needs one never leaves its "searching for adapter" screen. A room cannot offer such a title, and it must not list one.',
    evidence: 'gba/mgba/README.md "Manual SoulGold Cable Club recipe" step 6 ("The Wireless Adapter path cannot be served (mGBA has no RFU)"); docs/gba-link-and-arena-plan.md game matrix; gba/mgba/dist/mgba_core.buildinfo.json lists the four patches.',
    // The binary itself, pinned: a rebuilt core is exactly the change that could have added a driver, so it forces a re-read.
    verify: () => gbaCorePinned(),
  },
  {
    id: 'gba-single-pak-multiboot-link-is-not-supported',
    what: 'The link mode where ONE cartridge sends a program to GBAs that have NO cartridge (Single-Pak / multiboot) cannot be played in a room. Every seat of a room boots the same game from its own cartridge image, so only the Multi-Play (Multi-Pak) modes work.',
    why: 'Kirby and Sonic Advance 3 each ship both kinds of link mode, and the rooms catalogue is built from their Multi-Play rows only (tools/gba_link_smoke.mjs: "SUB-GAMES -> Quick Draw -> MULTIPLAYER", "MULTI-PAK MODE"). Serving a multiboot image needs a way to start a seat WITHOUT a ROM and hand it the master\'s image over the simulated cable, and the bridge has no such entry point: it maps ONE ROM and gives it to every seat. No row exists, so no title is offered on the strength of one.',
    evidence: 'gba/mgba/bridge/bemental_gba.c:205 `static uint8_t* g_rom` (the one ROM image); gba/mgba/mgba_core.js:78-86 loadRom(bytes) -> _bgb_load_rom(p, len, code); no `multiboot` identifier in the core adapter or the bridge.',
    verify: () => gbaCorePinned() && /static uint8_t\* g_rom\b/.test(read('gba/mgba/bridge/bemental_gba.c')) &&
      !/multiboot/i.test(read('gba/mgba/mgba_core.js') + read('gba/mgba/bridge/bemental_gba.c') + read('gba/mgba/bridge/bemental_gba.h')),
  },
  {
    id: 'gba-mixed-rom-rooms-are-not-possible',
    what: 'Every player of a room must be running the identical game file. Two players cannot link a Ruby cartridge to an Emerald one, or different regions or versions of one game.',
    why: 'A room\'s config carries ONE romMd5 and the disc string every peer must repeat folds it, so a peer on another ROM is refused by name (ROOM_ROM); and the core takes one ROM for all of its seats (`bgb_load_rom(p, len, code)` has no seat argument). Nothing in the protocol, the adapter or the bridge can describe seats that differ in ROM, and the lockstep model needs every peer to simulate every seat from the same bytes, so this is a design property, not an oversight.',
    evidence: 'gba/mgba/room.js CONFIG_KEYS = [... \'romMd5\' ...] (one ROM field) and the ROOM_ROM refusal; gba/mgba/mgba_core.js loadRom(bytes) calls _bgb_load_rom(p, rom.length, code); gba/mgba/bridge/bemental_gba.c:205.',
    verify: () => gbaCorePinned() && /static uint8_t\* g_rom\b/.test(read('gba/mgba/bridge/bemental_gba.c')) &&
      /_bgb_load_rom\(p, rom\.length, code\)/.test(read('gba/mgba/mgba_core.js')) &&
      /const CONFIG_KEYS = \[[^\]]*'romMd5'[^\]]*\];/.test(read('gba/mgba/room.js')) && !/romMd5s|seatRoms|romsBySeat/.test(read('gba/mgba/room.js')),
  },
  {
    id: 'gba-rooms-have-no-spectators',
    what: 'A GBA room has only players. Nobody can join to watch a room, and a player cannot watch another seat\'s screen: the page draws the LOCAL seat and plays the local seat\'s sound.',
    why: 'lib/netplay.js seats every connected peer in one of four ports (portCount 4); it has no read-only role, and neither has the page - a joiner is gameless until the host\'s N seats are filled, then every console boots all N cores. A spectator would need an engine role that receives the input stream without owning a port, and a page mode that simulates the room without contributing a save or a pad word. (The streaming spectator that used to exist is cancelled: spectating by video is exactly what the 2026-09-08 directive forbids; a lockstep spectator would be a peer that runs the cores and sends nothing.)',
    evidence: 'grep of lib/netplay.js, gba.html and gba/mgba/room.js for spectate / isSpectator / `spectator:` finds none; the only "spectator" in lib/netplay.js is prose about the cancelled stream (lines 37, 1524, 6986).',
    verify: () => !/\bspectate\b|isSpectator|spectator\s*[:=]/.test(read('lib/netplay.js') + read('gba.html') + read('gba/mgba/room.js')) &&
      /portCount/.test(read('lib/netplay.js')) && /portCount: MAX_SEATS/.test(read('gba/mgba/room.js')),
  },
  {
    id: 'gba-soulgold-cable-club-is-not-tested-by-automation',
    what: 'The Pokemon SoulGold Cable Club (trade, battle) has never been run through a room by any automated test, and SoulGold is NOT in the rooms catalogue. Nothing here shows two SoulGolds trading, or what a trade does to each save.',
    why: 'The Cable Club is reachable only with a save made inside a Pokemon Center, and no such save exists on the build machine; a solo core cannot be scripted there from a new game within a test budget that anyone has found. So the title has no passing link row (a title enters ROOMABLE only with one), the game\'s trade/battle path is untested, and the clean-end save protocol (only the local seat committed, only after an end every peer reached) was exercised on a TOY trade core - a model of the Trade Center, not Pokemon. A manual recipe is written down and has not been performed by a person.',
    evidence: 'gba/mgba/README.md "Manual recipe: the SoulGold Cable Club through the page (NOT automated, NOT roomable yet)" and "Until that has been done by a person with a real save, the SoulGold trade/battle path is not exercised by any automated test"; gba/mgba/room.js LINK_ROWS has no SoulGold row.',
    // Open while the catalogue's own rows (the source ROOMABLE is derived from) hold no Pokemon title at all.
    verify: () => { const rows = between(read('gba/mgba/room.js'), 'export const LINK_ROWS', ']);'); return /sbam-2p/.test(rows) && !/Pokemon|SoulGold|Ultra Violet/i.test(rows); },
  },
  {
    id: 'gba-low-memory-and-slow-devices-are-unmeasured-on-hardware',
    what: 'No real phone, tablet, console browser or low-memory device has run a GBA room, or even solo play on the mGBA core. How a device that cannot allocate the core\'s 192 MiB heap behaves, and how many seats a real phone can hold at 1.000x, are unknown.',
    why: 'The core\'s heap is FIXED at 201,326,592 B (ALLOW_MEMORY_GROWTH=0; the old 44vba core was 128 MB), a room boots a SECOND 192 MiB instance (the solo core is closed first, and whether the OS gets the memory back is the garbage collector\'s decision), and every ms/frame figure in the repo is a shared-desktop headless-Chrome number with Windows CPU busy % standing in for a load average. The CPU-throttled arms are stand-ins, not devices. The page has a "Could not start the emulator core" path for a failed allocation; it has been run by a test, never by a device that really ran out of memory.',
    evidence: 'gba/mgba/dist/mgba_core.buildinfo.json link.initialMemory 201326592; gba/mgba/README.md "Known limits of the room page" and "This decision rests on desktop numbers only"; docs/devices/ holds a note for Edge on Xbox only.',
    // Closes when a measured device note for this core lands next to the Xbox one.
    verify: () => { try { return JSON.parse(read('gba/mgba/dist/mgba_core.buildinfo.json')).link.initialMemory === 201326592 && !readdirSync('docs/devices').some((f) => /gba|mgba|game-?boy/i.test(f)); } catch (e) { return true; } },
  },
  {
    id: 'gba-rejoin-replay-runs-hidden-frames-above-1x',
    what: 'OWNER DECISION, not a build gap: a GBA player who drops and reloads is brought level by re-simulating the room\'s recorded history as HIDDEN frames, at several times hardware speed, and only then runs at 1.000x. Whether that counts as "the guest never runs faster than hardware" (CLAUDE.md gate 9) has not been decided.',
    why: 'Savestates of this core do not round-trip bit-exactly (hash() differed at 30 of 30 samples after a restore while all video frames matched), so checkpoints and rollback are off and a rejoin is a replay from frame 0 (`rsReplay: true`). Measured once (headless Chrome, Kirby x2, one run): a page ~7 s into a ~25 s room was level again 2.65 s after the harness began waiting, having re-simulated ~1,580 frames - the hidden replay itself ran at AT LEAST ~10x hardware; once level it ran at 1.0021x. The room itself never runs faster, nothing is presented or heard at speed, and the alternative (rsReplay off) means a returning page cannot rejoin and the room plays on without that seat. By the table in gba/mgba/README.md a 30-minute room is caught up in about 2 minutes (Super Bust-A-Move x2) to about 20 minutes (Kirby x4) on this desktop.',
    evidence: 'gba/mgba/README.md "A returning page" (the gate 9 note) and "Disconnect policy: rsReplay ON"; gba/mgba/room.js lockstepOptions(): rsReplay: true.',
    verify: () => /rsReplay:\s*true/.test(read('gba/mgba/room.js')),
  },
  {
    id: 'gba-rooms-have-never-run-over-the-shipped-transport',
    what: 'Every GBA room result comes from ONE browser profile on ONE machine over ?net=local (a BroadcastChannel). A GBA room has never formed over the transport a visitor actually gets - the public PeerJS broker and a real ICE negotiation - let alone between two networks.',
    why: 'tools/gba_netplay_test.mjs puts every simulated player in a window of one Chrome profile, because BroadcastChannel signalling needs a shared profile; its README says plainly that NAT traversal is not exercised. tools/audit_peerjs_crossdevice.mjs is the rig that runs two SEPARATE profiles with no ?net=local, but its gba row still names the retired /gba_multiplayer.html lobby (a redirect) and a `__gbamp` seam no page publishes, so it cannot drive a GBA room, and gba.html forms its rooms through its own Party panel. This is the GBA-specific half of never-tested-across-two-networks above.',
    evidence: 'tools/gba_netplay_test.mjs: all four `net=` occurrences are `net=local`; tools/audit_peerjs_crossdevice.mjs PLATFORMS.gba.lobby = \'/gba_multiplayer.html\'; gba/mgba/README.md "Not real, said plainly".',
    verify: () => { const t = read('tools/gba_netplay_test.mjs'), hits = [...t.matchAll(/net=([a-z]+)/g)].map((m) => m[1]);
      return hits.length > 0 && hits.every((h) => h === 'local') && /gba:\s*\{\s*lobby:\s*'\/gba_multiplayer\.html'/.test(read('tools/audit_peerjs_crossdevice.mjs')); },
  },
];

let stale = 0;
console.log('[undelivered] OPEN WORK — these are NOT failures, they are things not built yet:\n');
for (const e of OPEN) {
  let open = true;
  try { open = !!e.verify(); } catch (err) { open = true; }
  if (!open) {
    stale++;
    console.log(`  ⚠ STALE  ${e.id}`);
    console.log(`           its verify no longer holds — either this is DONE and the entry must be`);
    console.log(`           removed, or the evidence moved and the entry must be rewritten.`);
  } else {
    console.log(`  OPEN  ${e.id}`);
    console.log(`        ${e.what}`);
    console.log(`        why: ${e.why}`);
    console.log(`        evidence: ${e.evidence}`);
  }
  console.log('');
}
console.log(`[undelivered] ${OPEN.length - stale} open · ${stale} stale`);
if (stale) {
  console.log('A stale entry means this list has stopped describing reality, which makes every');
  console.log('other entry untrustworthy. Fix the list.');
  process.exit(1);
}

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
import { readFileSync, existsSync } from 'fs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

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
  {
    id: 'gamecube-rooms-do-not-agree-a-memory-card-set',
    what: 'Two GameCube consoles in one room start from DIFFERENT memory cards.',
    why: 'Each machine adopts its own IndexedDB card image before _main() (the recomp card shim), and nothing agrees a set the way dreamcast.html does with ls.contributeCards(). That is a divergence SOURCE sitting inside a frame-gated room. As of 2026-09-10 it is at least DETECTED rather than silent — the card image is part of what the new state fingerprint hashes, so two consoles holding different cards now raise a desync naming the frame instead of quietly playing different games. Detected is not fixed: the room reports the fork and stops, where dreamcast.html trades the cards before frame 0 so there is no fork to report.',
    evidence: 'gamecube.html has no contributeCards() call, while dreamcast.html builds a card set, verifies each contributor\'s fingerprint and installs it before the barrier. gamecube/tools/gc_room_test.mjs now proves the DETECTOR (a-REAL-divergence-is-detected-and-named) but nothing agrees a set.',
    // ⚠ ANCHORED ON A CALL, NOT A MENTION. The bare word appears in this page's
    // OWN COMMENT explaining that it does not do this — so a plain
    // /contributeCards/ test matched the prose describing the gap and declared
    // the gap closed. Fourth time a verify here has matched a comment rather
    // than code. A call site has a receiver and a paren; a sentence does not.
    verify: () => !/\.contributeCards\s*\(/.test(read('gamecube.html')),
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
    why: 'Dreamcast MAPLE_PORTS is 4 and N64 exposes 4; PS1 tops out at 2 because "multitap" appears ZERO times in that core; Genesis is 2 without a multitap its shim never calls. SNES is 2 of a possible 5: the core polls Joypads[0..4] and this page can now write all five, but ports 3-5 only answer when IPPU.Controller is SNES_MULTIPLAYER5, and exports.c sets ControllerOption = SNES_JOYPAD so S9xNextController() advances straight past it.',
    evidence: 'grep -ric multitap ps1/ps1Wasm/pcsx-wasm-src -> 0 occurrences at the time of writing; snes exports.c init_sfc_setting sets Settings.ControllerOption = SNES_JOYPAD.',
    verify: () => /ControllerOption\s*=\s*SNES_JOYPAD/.test(read('snes/snesWasm/source/exports.c')),
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

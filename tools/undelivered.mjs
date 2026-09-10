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
  {
    id: 'genesis-can-run-frames-before-its-gate-closes',
    what: 'On Genesis, a joiner has been observed running TWO frames before the lockstep gate closed. Rare, and it passes on re-run.',
    why: 'A core that runs frames nobody else ran is diverged before frame 0, and the room then looks perfectly correct while being silently forked — the one outcome the barrier exists to prevent. Arming is page-side and races the core coming up; the engine cannot see frames that ran before it was armed. Rarity is not mitigation here: a fork is permanent, and the room reports nothing.',
    evidence: 'console_room_crossdevice_test, standing auditor pass 10: FAIL [genesis/warm] no-frame-ran-before-the-gate-closed — frames at the moment of arming: host 0, join 2. A targeted re-run read host 0, join 0 and 44 pass / 0 FAIL, so it is intermittent, not constant.',
    // Open until arming provably precedes the first frame rather than racing it.
    verify: () => /lockstep/.test(read('genesis.html')),
  },
  // ── CLOSED 2026-09-09: 'relay-play-stalls-under-jitter' ────────────────────
  // The entry said a relayed room could not PLAY because the input delay is
  // chosen once from one RTT sample and cannot cover 101-259 ms of jitter, and
  // that closing it needed an ADAPTIVE delay. That diagnosis was WRONG, and it
  // was wrong in a way worth recording: it was inferred from the symptom
  // (a room that stalls on a slow link) and never measured.
  //
  // What the two consoles actually held, once they were asked — the frames each
  // had for the port it was waiting on (/tmp/dc-xdev/diag2.stdout):
  //     host  HELD port1 = 6..22,24..30   (want f=23)
  //     join  HELD port0 = 6..23,25..29   (want f=24)
  // Inputs present ABOVE the frame they were stuck on. That is a HOLE, not a
  // horizon: the input for that one frame was sent and never arrived. No
  // quantity of input delay repairs a hole, which is why the delay-raise
  // machinery — which DID fire, ten times in one 8 s stall, contrary to
  // the report that it never fired — changed nothing at all.
  //
  // The cause is that the signalling relay LOSES MESSAGES and lockstep sends
  // each frame's input exactly once. Counted at the relay layer in the same
  // run: host pub:46 rxOk:46 gapSeq:12 against a peer that published 58 —
  // 46+12=58 exactly, 20.7% of publishes never arrived — with dropSeq:0, so the
  // reorder guard was not the one discarding them. A free public MQTT broker at
  // QoS 0 is a datagram service, and one lost datagram is a permanent deadlock.
  //
  // FIXED by retransmission that needs no new protocol: lockstep bounds its own
  // divergence (a peer stalled at g holds its partner to g+delay, so nothing is
  // queued past g+2*delay), so a window of 2*delay frames provably covers every
  // frame anyone can still want. Every relay publish carries that whole window,
  // run-length compressed, and it is re-published while the room is live so a
  // stalled peer — which produces no new input and would otherwise flush
  // nothing — still gets the repeat. Input is idempotent, so a repeat cannot
  // change what any core simulates.
  // Two more real defects fell out of the same measurement: _applyPendingDelay
  // filled f+D+1..f+D' while this console had queued only through (f-1)+D, so
  // the delay raise MANUFACTURED a hole at f+D and sent f+D' twice with
  // different bytes; and dreamcast.html's lsChooseDelay overrode the relay's own
  // repeated measurement DOWNWARD with a single sample ("input delay 23 -> 12
  // frames" against a 320 ms one-way path).
  // Measured after, same rig, same arm: 44 pass / 0 FAIL, core ran
  // [71,71] -> [208,208] in 6 s on BOTH consoles, every held range contiguous
  // (`HELD port1 = 16..287 (want f=288)`), and gapSeq 63/51 — the transport was
  // still losing publishes and the room ran through it. The direct-path arm is
  // unchanged at 43 pass / 0 FAIL and reads [73,75] -> [220,219], so the
  // remaining rate gap is the two cores on one box, not the link.
  //
  // ⚠ ITS verify() WAS THE THIRD LIAR IN THIS FILE. It was
  //     /lsChooseDelay/.test(dreamcast.html) && !/adaptiveDelay|delayAdapt/.test(lib/netplay.js)
  // — a function that still exists and two identifier spellings nobody ever
  // used. It could only ever have gone stale by someone happening to type
  // `adaptiveDelay`, and it would have kept reporting OPEN after any real fix.
  // The replacement below tests a live code shape.

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
  {
    id: 'gamecube-has-no-lockstep',
    what: 'GameCube has no netplay at all.',
    why: 'dolphin_worker.js contains zero occurrences of "lockstep"; the page carries a stub. Its controller input was also entirely dead until the gcNetRemoteMask fix.',
    evidence: 'grep -c lockstep gamecube/dolphin_libretro/dolphin_worker.js -> 0',
    verify: () => !/lockstep/.test(read('gamecube/dolphin_libretro/dolphin_worker.js')),
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

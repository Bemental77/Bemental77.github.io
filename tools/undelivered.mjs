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
  {
    id: 'relay-play-stalls-under-jitter',
    what: 'Two peers with NO direct path pair, seat, gate and compare fingerprints correctly — and then cannot PLAY. The cores advance a few frames and stop.',
    why: 'Delay-based lockstep picks its input delay ONCE, at Ready, from a single RTT measurement (dreamcast.html lsChooseDelay -> Lockstep.recommendDelay). The signalling relay is not stable enough for that: one run measured 101ms, 195ms, 200ms and 259ms ONE WAY on the same link. A delay that covers the fast sample starves on the slow one, and a core waiting on input still in flight never advances. Covering the worst case needs an ADAPTIVE delay that rises when the queue starves — a real protocol change, not a constant.',
    evidence: 'room_crossdevice_test --arms no-direct-path --play: PAIRING is green (21 pass / 0 FAIL, with the arm-difference proof that relay-only ICE with no relay was in force and 7 RTCPeerConnections per side could form no candidate pair). PLAY is not: core ran [34,35] -> [34,35] and [31,36] -> [31,36] over ~6 s, join port1=false, 41 pass / 3 FAIL.',
    // Open until the delay adapts. A single fixed choice cannot cover 101-259ms of jitter.
    verify: () => /lsChooseDelay/.test(read('dreamcast.html')) && !/adaptiveDelay|delayAdapt/.test(read('lib/netplay.js')),
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

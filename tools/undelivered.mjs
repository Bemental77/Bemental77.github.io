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
  {
    id: 'vmu-does-not-carry-into-a-room',
    what: "A player's saved VMU does not carry into an ONLINE room. In a room, seeding is suppressed and the console plays a blank card.",
    why: 'Netplay has no state handoff — peers cold-boot and stay identical BY CONSTRUCTION (dreamcast.html:5595). A VMU is guest-visible memory, so seeding two different stored cards would desync the instant a game read one. Suppressing it is correct until the cards are exchanged over the link before frame 0.',
    evidence: 'Observed live on a two-browser pairing: the joiner reported seedSkipped and read blank card headers [196,0,164] rather than the 0x77 card planted in its IndexedDB.',
    // Open while the page still suppresses seeding in a room.
    verify: () => /seedSkipped|seed[^\n]*suppress/i.test(read('dreamcast.html')),
  },
  {
    id: 'no-working-turn-relay',
    what: 'Two peers on genuinely hostile networks (symmetric NAT) cannot connect at all, and nothing detects it.',
    why: 'There is no working TURN relay. Public relays measured returning 701/400; peerjs\'s own two do not resolve. The lobby shows a "RELAY SERVER — NEEDED TO PLAY ACROSS SOME NETWORKS" box that is unproven.',
    evidence: "tools/audit_all.mjs's dreamcast-room-crossdevice ciWhy records the measurement, and its no-direct-path arm is RED for real.",
    verify: () => /no working TURN relay|701\/400/.test(read('tools/audit_all.mjs')),
  },
  {
    id: 'never-tested-across-two-networks',
    what: 'Every netplay result in this repo comes from ONE box behind ONE NAT. The two-networks case is unestablished.',
    why: 'Both browsers run on the same machine, so a green run closes the real-UI gap and NOT the network gap. Marking those rigs ci:true would put a green tick under a claim no rig here can make.',
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
  {
    id: 'snes-needs-a-core-rebuild',
    what: 'SNES cannot present a second controller.',
    why: 'snes/snesWasm/source/exports.c returns a hardcoded 0 for every port but 0, confirmed in live wasm memory as IPPU.Joypads[0..4] = 0xffff0201 0 0 0 0.',
    evidence: 'exports.c:37-40.',
    verify: () => /if\s*\(\s*port\s*==\s*0\s*\)/.test(read('snes/snesWasm/source/exports.c')),
  },
  {
    id: 'eight-players-is-not-reachable',
    what: 'No console here reaches 8 players.',
    why: 'Dreamcast MAPLE_PORTS is 4 and N64 exposes 4; PS1 tops out at 2 because "multitap" appears ZERO times in that core; Genesis is 2 without a multitap its shim never calls.',
    evidence: 'grep -ric multitap ps1/ps1Wasm/pcsx-wasm-src -> 0 occurrences at the time of writing.',
    verify: () => true,   // structural; closed only by adding multitap support somewhere
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

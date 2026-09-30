#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHO IS THE ROOM WAITING ON? — Lockstep.paceVerdict, cell by cell.
//
// Live report, room 49K4T (2026-09-30): a DESKTOP host with a 4.28x cap, room
// at 0.93x, and the host's own screen said "this device cannot run this game
// at full speed". The page compared its stalled share to a FIXED 10%; the host
// had waited ~7% — every bit of the time the room lost — and blamed itself.
// The verdict now compares each console's waiting to the time the ROOM lost,
// and names consoles by port. These cells are that case and its neighbours,
// for two and for four players. No browser, no server.
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync('lib/netplay.js', 'utf8'))();
const V = globalThis.Netplay.Lockstep.paceVerdict;
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? ' — ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + ' — ' + d); };
const check = (n, v, kind, port, re) => {
  const good = v.kind === kind && (port === undefined || v.port === port) && (!re || re.test(v.text));
  good ? ok(n, v.text) : bad(n, JSON.stringify({ kind: v.kind, port: v.port, text: v.text }));
};
const me = (ports, share, cap, extra) => Object.assign({ ports, share, lost: 0, cap, waitOn: {} }, extra || {});
const peer = (ports, share, cap, extra) => Object.assign({ peer: 'x' + ports[0], ports, share, lost: 0, cap, waitOn: {}, ageMs: 500 }, extra || {});

// ---- two players ------------------------------------------------------------
// 49K4T from the HOST's screen: it waited 7% (on port 1), the joiner waited 0.
check('fast-host-slow-joiner: the HOST names player 2, with player 2\'s cap',
  V({ self: me([0], 0.07, 4.28, { waitOn: { 1: 0.07 } }), peers: [peer([1], 0, 0.93)], delay: 3 }, 0.93),
  'device', 1, /waiting on player 2: player 2's device runs this game at 0\.93x/);
check('fast-host-slow-joiner: the JOINER names itself, with its own cap',
  V({ self: me([1], 0, 0.93), peers: [peer([0], 0.07, 4.28, { waitOn: { 1: 0.07 } })], delay: 3 }, 0.93),
  'self', 1, /this device runs this game at 0\.93x/);
check('fast-both-slow-link: both wait -> the connection, not a device',
  V({ self: me([0], 0.08, 4.28), peers: [peer([1], 0.07, 2.1)], delay: 4 }, 0.92),
  'network', undefined, /connection is slower than the input delay/);
check('a joiner with cap >= 1 that falls behind in bursts is named, not the host',
  V({ self: me([0], 0.06, 4.28), peers: [peer([1], 0, 1.4, { lost: 0.06 })], delay: 3 }, 0.94),
  'device', 1, /player 2's device falls behind in bursts though it runs this game at 1\.40x on average \(6%/);
check('a room at full speed says nothing',
  V({ self: me([0], 0, 4.28), peers: [peer([1], 0, 1.9)], delay: 3 }, 0.999), 'ok');
check('caps are reported for every console on every verdict',
  (() => { const v = V({ self: me([0], 0, 4.28), peers: [peer([1], 0, 1.9)], delay: 3 }, 1); return { kind: v.caps.length === 2 && v.caps[1].cap === 1.9 ? 'ok' : 'bad', text: JSON.stringify(v.caps) }; })(),
  'ok');

// ---- four players -----------------------------------------------------------
// One slow MACHINE (player 3 = port 2): everyone else waits on it, it waits on
// nobody. Every screen must name player 3.
{
  const w = { 2: 0.2 };
  check('four players, slow machine: the host names player 3',
    V({ self: me([0], 0.2, 4, { waitOn: w }), peers: [peer([1], 0.2, 3, { waitOn: w }), peer([2], 0, 0.8), peer([3], 0.2, 2.5, { waitOn: w })], delay: 3 }, 0.8),
    'device', 2, /player 3's device runs this game at 0\.80x/);
  check('four players, slow machine: player 2 names player 3 too',
    V({ self: me([1], 0.2, 3, { waitOn: w }), peers: [peer([0], 0.2, 4, { waitOn: w }), peer([2], 0, 0.8), peer([3], 0.2, 2.5, { waitOn: w })], delay: 3 }, 0.8),
    'device', 2);
  check('four players, slow machine: player 3 names itself',
    V({ self: me([2], 0, 0.8), peers: [peer([0], 0.2, 4, { waitOn: w }), peer([1], 0.2, 3, { waitOn: w }), peer([3], 0.2, 2.5, { waitOn: w })], delay: 3 }, 0.8),
    'self', 2);
}
// One slow LINK (player 3's): everyone waits, and the waiting concentrates on
// port 2 — so it is player 3's CONNECTION, named, not "the network".
{
  check('four players, one slow link: named as the connection to player 3',
    V({ self: me([0], 0.1, 4, { waitOn: { 2: 0.1 } }), peers: [
        peer([1], 0.1, 3, { waitOn: { 2: 0.1 } }), peer([2], 0.1, 2, { waitOn: { 0: 0.05, 1: 0.03, 3: 0.02 }, rtt: 310 }),
        peer([3], 0.1, 2.5, { waitOn: { 2: 0.1 } })], delay: 5 }, 0.9),
    'link', 2, /the connection to player 3 is slower than the input delay covers \(310 ms round trip\)/);
  check('four players, everyone\'s link slow: the network',
    V({ self: me([0], 0.1, 4, { waitOn: { 1: 0.03, 2: 0.04, 3: 0.03 } }), peers: [
        peer([1], 0.1, 3, { waitOn: { 0: 0.05, 2: 0.03, 3: 0.02 } }), peer([2], 0.1, 2, { waitOn: { 0: 0.05, 1: 0.03, 3: 0.02 } }),
        peer([3], 0.1, 2.5, { waitOn: { 0: 0.04, 1: 0.03, 2: 0.03 } })], delay: 5 }, 0.9),
    'network');
}
console.log(`\n[pace-verdict] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

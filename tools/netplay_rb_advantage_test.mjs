#!/usr/bin/env node
// ============================================================================
// netplay_rb_advantage_test.mjs — DOES ROLLBACK'S ADVANTAGE WAIT COST A ROOM
// FRAMES WHEN NOBODY IS AHEAD?
// ============================================================================
//
// WHY. tools/netplay_device_matrix.mjs measured a Genesis rollback room of two
// desktop players at 0.979x with ZERO stalls: 81 and 84 'advantage' waits in
// 60 s, on BOTH consoles (/tmp/npdm/gen-a-fix1). A page may not repay a waited
// frame (CLAUDE.md gate #9), so every wait is a frame of guest time lost. The
// wait exists for a console that is REALLY ahead; the engine compared two
// instantaneous, jittery samples and fired on the jitter.
//
// THE MODEL (real Lockstep engines, simulated wire and pages). Each console is
// paced like genesis.html's loop(): a display tick every ~16.7 ms WITH JITTER,
// a wall-clock credit accumulator, up to 4 frames per tick, and a not-ready
// frame drops the credit beyond one frame (genesis.html:1114). So the numbers
// here are delivered guest rate, the thing the matrix measures.
//
// CELLS
//   jitter-alone-does-not-trigger-waits   two consoles at exactly 1.000x,
//       display ticks jittered +-6 ms, 20 ms +-10 ms one way: waits < 0.25/s
//       per console and both >= 0.99x.
//   a-console-that-is-really-ahead-still-waits   the guest starts 400 ms
//       late (24 frames behind): the host must still wait, the room must
//       converge (frame gap <= 3) without living on window stalls (<= 3).
//
// USAGE  node tools/netplay_rb_advantage_test.mjs
//        NETPLAY_JS=/path/to/old/netplay.js node tools/netplay_rb_advantage_test.mjs   (A/B)
import { readFileSync } from 'fs';
globalThis.window = globalThis; globalThis.self = globalThis;
const SRC = process.env.NETPLAY_JS || new URL('../lib/netplay.js', import.meta.url);
new Function(readFileSync(SRC, 'utf8'))();
const L = globalThis.Netplay.Lockstep;

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

function run({ seconds = 60, latencyMs = 20, jitterMs = 10, tickJitterMs = 12, guestStartMs = 40, seed = +(process.env.SEED || 7) }) {
  let now = 0;
  let s = seed >>> 0; const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const q = []; const lastAt = { H: 0, G: 0 };
  const send = (to) => (m) => {
    let at = now + latencyMs + rnd() * jitterMs;
    if (at < lastAt[to]) at = lastAt[to];      // an ordered channel never reorders
    lastAt[to] = at;
    q.push({ at, to, msg: JSON.parse(JSON.stringify(m)) });
  };
  const mk = (id, host) => new L({ peerId: id, host, portCount: 2, padBytes: 2, delay: 2, hashEvery: 30,
                                   rollback: 8, stallBudgetMs: 0, send: send(host ? 'G' : 'H'), now: () => now });
  const E = { H: mk('H', true), G: mk('G', false) };
  E.H.seat('H', 1); E.H.seat('G', 1);
  const FRAME = 1000 / 59.922751;
  const C = {};
  for (const id of ['H', 'G']) C[id] = { next: id === 'H' ? 0 : guestStartMs, accum: 0, last: 0, ran: 0, declared: false, t0: null, ranAt: [] };
  const deliver = () => { q.sort((a, b) => a.at - b.at); while (q.length && q[0].at <= now) { const d = q.shift(); E[d.to].receive(d.msg); } };
  const end = seconds * 1000;
  while (true) {
    const id = C.H.next <= C.G.next ? 'H' : 'G';
    now = C[id].next; if (now > end) break;
    deliver();
    const ls = E[id], c = C[id];
    if (!c.declared && ls.localPorts.length) { c.declared = true; ls.declareReady('disc'); }
    if (ls.state === 'running' || ls.state === 'stalled') {
      if (c.t0 == null) { c.t0 = now; c.last = now; }
      let d = now - c.last; c.last = now; if (d > 100) d = 100;
      c.accum += d;
      let n = 0;
      while (c.accum >= FRAME && n < 4) {
        const f = ls.frame;
        const pads = {}; for (const p of ls.localPorts) pads[p] = new Uint8Array([(f >> 4) & 0xff, p]);
        const r = ls.beginFrame(pads);
        if (!r.ready) break;
        ls.endFrame(null);
        for (const k of ls.takeHashDue()) ls.submitHash(k, 1);
        c.accum -= FRAME; n++; c.ran++;
      }
      if (c.accum > FRAME) c.accum = FRAME;     // genesis.html:1114
    }
    c.next += 1000 / 60 + (rnd() - 0.5) * tickJitterMs;
  }
  const rate = (id) => C[id].ran / (((end - C[id].t0) / 1000) * 59.922751);
  return { E, C, rate, seconds };
}

console.log('=== rollback advantage wait (real Lockstep, simulated jittered pages) ===');
{
  const R = run({});
  const wH = R.E.H.rbStats.advantageWaits, wG = R.E.G.rbStats.advantageWaits;
  const xH = R.rate('H'), xG = R.rate('G');
  ok('jitter-alone-does-not-trigger-waits', wH / R.seconds < 0.25 && wG / R.seconds < 0.25,
     `advantage waits host ${wH}, guest ${wG} in ${R.seconds} s (${(wH / R.seconds).toFixed(2)}/${(wG / R.seconds).toFixed(2)} per s)`);
  ok('both-consoles-deliver->=0.99x', xH >= 0.99 && xG >= 0.99, `host ${xH.toFixed(4)}x guest ${xG.toFixed(4)}x`);
}
{
  const R = run({ seconds: 20, guestStartMs: 400 });
  const wH = R.E.H.rbStats.advantageWaits, ws = R.E.H.rbStats.windowStalls + R.E.G.rbStats.windowStalls;
  const lead = R.E.H.frame - R.E.G.frame;
  ok('a-console-that-is-really-ahead-still-waits', wH >= 1 && Math.abs(lead) <= 3 && ws <= 3,
     `guest started 400 ms (~24 frames) late: host waited ${wH} times, window stalls ${ws}; after 20 s host-guest frame gap ${lead}`);
}
console.log(`\n[rb-advantage] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

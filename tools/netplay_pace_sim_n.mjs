#!/usr/bin/env node
// ---------------------------------------------------------------------------
// netplay_pace_sim_n.mjs — THE PACE A LOCKSTEP ROOM OF 3 OR 4 PLAYERS DELIVERS.
//
// tools/netplay_pace_sim.mjs answers this for TWO peers. Rooms seat up to four
// (Dreamcast, GameCube and N64 have four ports), and this 4-core box cannot run
// four real cores at 1.000x (tools/netplay_device_matrix.mjs quad-solo control),
// so the engine's behaviour with 3-4 players is measured here, the same way:
//   * N real Netplay.Lockstep engines, seated through the real barrier;
//   * every peer driven like n64/index.html lsFeed() — a 1.000x governor that
//     re-anchors instead of repaying debt (gate #9), a 4 ms feed timer and a
//     kick on every input arrival; a frame costs `cost` ms of that peer's
//     single thread;
//   * THE STAR the product actually has: every guest talks only to the host,
//     which forwards frame traffic to the other guests (lib/netplay.js RELAYED:
//     ls/lsh/lsd). So guest-to-guest input pays TWO hops — the property a
//     two-peer sim cannot show.
// Deterministic (seeded PRNG). Exits nonzero if a scenario's assertion fails.
//
// USAGE  node tools/netplay_pace_sim_n.mjs [--scenario NAME] [--secs N] [--json]
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis; globalThis.self = globalThis;
(0, eval)(fs.readFileSync(process.env.NETPLAY_JS || path.join(root, 'lib/netplay.js'), 'utf8'));
const { Lockstep } = globalThis.Netplay;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
function prng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
class Q {
  constructor() { this.h = []; this.seq = 0; }
  push(t, fn) { const h = this.h; h.push([t, this.seq++, fn]); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (lt(h[i], h[p])) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break; } }
  pop() { const h = this.h; const top = h[0]; const last = h.pop(); if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && lt(h[l], h[m])) m = l; if (r < h.length && lt(h[r], h[m])) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } } return top; }
  get size() { return this.h.length; }
}
const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
const RELAYED = { ls: 1, lsh: 1, lsd: 1 };

export function simulate(sc) {
  const rnd = prng(sc.seed || 7);
  const viHz = sc.viHz || 60, period = 1000 / viHz, secs = sc.secs || 60;
  const n = sc.cost.length;
  let T = 0; const q = new Q(); const P = []; let live = false;
  const ids = ['H', 'G1', 'G2', 'G3'].slice(0, n);
  const link = {};                         // ordered per directed hop
  const hop = (from, to, m) => {
    const k = from + '>' + to;
    const at = Math.max(link[k] || 0, T + Math.max(0, sc.latency(T, rnd, from, to)));
    link[k] = at;
    q.push(at, () => deliver(P[ids.indexOf(to)], m, from));
  };
  const mk = (i) => {
    const id = ids[i], host = i === 0;
    const p = { id, host, busyUntil: 0, baseWall: 0, baseFrame: 0, frames: 0, cost: sc.cost[i] };
    p.ls = new Lockstep({ host, peerId: id, portCount: 4, padBytes: 4, delay: 2, hashEvery: 0, frameHz: viHz, now: () => T,
      send: (m) => {
        const tagged = Object.assign({ peer: id }, m);
        if (!live) { for (const o of P) if (o !== p) o.ls.receive(tagged); return; }
        if (host) { for (const o of P) if (o !== p) hop(id, o.id, tagged); }
        else hop(id, 'H', tagged);           // a guest has ONE link: to the host
      } });
    return p;
  };
  for (let i = 0; i < n; i++) P.push(mk(i));
  const H = P[0];
  const delayLog = [];
  H.ls.on('delay', (e) => delayLog.push({ t: +(T / 1000).toFixed(2), from: e.from, to: e.to }));
  for (const p of P) H.ls.seat(p.id, 1);
  H.ls.delay = sc.startDelay;
  for (const p of P) p.ls.declareReady('g');
  if (P.some((p) => p.ls.state !== 'running')) throw new Error('barrier did not release');
  live = true;
  function deliver(p, m, from) {
    if (T < p.busyUntil) { q.push(p.busyUntil, () => deliver(p, m, from)); return; }
    p.ls.receive(m);
    // THE HOST FORWARDS a guest's frame traffic to every other guest.
    if (p.host && RELAYED[m.t] && m.peer !== 'H') for (const o of P) if (o !== p && o.id !== m.peer) hop('H', o.id, m);
    if (m.t === 'ls') feed(p);
  }
  function due(p) {
    if (!p.baseWall) { p.baseWall = T; p.baseFrame = p.frames; return true; }
    const d = p.baseWall + (p.frames - p.baseFrame) * period;
    if (T < d) return false;
    if (T - d > period * 2) { p.baseWall = T; p.baseFrame = p.frames; }
    return true;
  }
  function feed(p) {
    if (T < p.busyUntil || !due(p)) return;
    const r = p.ls.beginFrame(new Uint8Array(4));
    if (!r.ready) { p.baseWall = 0; return; }
    const c = typeof p.cost === 'function' ? p.cost(T, rnd) : p.cost;
    p.busyUntil = T + c; p.frames++; p.ls.endFrame(null);
    q.push(p.busyUntil, () => feed(p));
  }
  for (const p of P) { const tick = () => { feed(p); if (T < secs * 1000) q.push(T + 4, tick); }; q.push(0, tick); }
  const samples = []; const last = P.map(() => 0);
  const sample = () => { samples.push(P.map((p, i) => (p.frames - last[i]) / viHz)); P.forEach((p, i) => { last[i] = p.frames; }); if (T < secs * 1000) q.push(T + 1000, sample); };
  q.push(1000, sample);
  while (q.size) { const [t, , fn] = q.pop(); if (t > secs * 1000 + 1) break; T = t; fn(); }
  const tail = samples.slice(5);
  const rates = P.map((p, i) => +(tail.reduce((a, s) => a + s[i], 0) / Math.max(1, tail.length)).toFixed(4));
  const maxSec = Math.max(...tail.flat());
  return { name: sc.name, players: n, rates, maxSec: +maxSec.toFixed(3), stallMs: P.map((p) => Math.round(p.ls.stats.stallMs)),
           delay: H.ls.delay, startDelay: sc.startDelay, raises: delayLog.filter((d) => d.to > d.from).length, delayLog };
}

const uni = (base, j) => (T, rnd) => base + (rnd() * 2 - 1) * j;
const SCEN = {
  // Four capable machines on a LAN — must hold 1.000x with no raises.
  'lan-4': { startDelay: 2, cost: [8, 8, 8, 8], latency: uni(3, 1) },
  // Four players over the internet, delay picked for ONE hop (70 ms one way)
  // from the host's RTT sample: guest-to-guest input needs TWO hops.
  'wan-4': { startDelay: 6, cost: [8, 8, 8, 8], latency: uni(70, 20) },
  // Three players, same.
  'wan-3': { startDelay: 6, cost: [8, 8, 8], latency: uni(70, 20) },
  // The same rooms with the delay chosen for the TWO-hop path a guest's input
  // takes to another guest: Lockstep.recommendDelay(rtt1 + rtt2) over the two
  // worst measured host<->guest RTTs (dreamcast.html lsChooseDelay).
  'wan-4-2hop': { startDelay: 10, cost: [8, 8, 8, 8], latency: uni(70, 20) },
  'wan-3-2hop': { startDelay: 10, cost: [8, 8, 8], latency: uni(70, 20) },
  // One phone in a four-player room: the room runs at the phone's pace and
  // must not pile lag on top.
  'slow-guest-4': { startDelay: 3, cost: [8, 8, 8, 30], latency: uni(15, 5) },
};
const EXPECT = {
  'lan-4': (r) => r.rates.some((x) => x < 0.999) ? 'LAN rates ' + r.rates : r.raises ? 'raised on a LAN' : null,
  // BEFORE arms: a one-hop delay is expected to need raises (documented, not failed).
  'wan-4': (r) => !r.raises ? 'expected the one-hop delay to be raised' : null,
  'wan-3': (r) => !r.raises ? 'expected the one-hop delay to be raised' : null,
  'wan-4-2hop': (r) => r.rates.some((x) => x < 0.99) ? 'rates ' + r.rates : null,
  'wan-3-2hop': (r) => r.rates.some((x) => x < 0.99) ? 'rates ' + r.rates : null,
  'slow-guest-4': (r) => r.rates.some((x) => Math.abs(x - (1000 / 30) / 60) > 0.02) ? 'rates ' + r.rates + ' not the phone capacity ' + ((1000 / 30) / 60).toFixed(3)
                  : r.raises ? r.raises + ' raises for a slow machine' : null,
};
const all = (r) => r.maxSec > 1.02 ? 'a second ran at ' + r.maxSec + 'x (gate #9)' : null;

if (process.argv[1] && process.argv[1].endsWith('netplay_pace_sim_n.mjs')) {
  const only = flag('scenario', null), secs = +flag('secs', '120');
  let failed = 0;
  for (const nme of (only ? [only] : Object.keys(SCEN))) {
    const r = simulate(Object.assign({ name: nme, secs }, SCEN[nme]));
    const ex = all(r) || (EXPECT[nme] ? EXPECT[nme](r) : null);
    if (ex) { failed++; console.log(`  FAIL  ${nme}: ${ex}`); }
    if (argv.includes('--json')) console.log(JSON.stringify(r));
    else console.log(`${nme.padEnd(13)} players ${r.players}  rates ${r.rates.map((x) => x.toFixed(4)).join('/')}  max-second ${r.maxSec}  stallMs ${r.stallMs.join('/')}  delay ${r.startDelay}->${r.delay} raises ${r.raises}`);
  }
  console.log(`\n[pace-sim-n] ${Object.keys(only ? { [only]: 1 } : SCEN).length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

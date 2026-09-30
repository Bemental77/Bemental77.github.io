#!/usr/bin/env node
// ---------------------------------------------------------------------------
// netplay_pace_sim.mjs — WHAT PACE DOES A LOCKSTEP ROOM DELIVER, AND WHAT DOES
// THE INPUT DELAY DO OVER TIME? A discrete-event simulation, no browser.
//
// WHY A SIMULATION. The live question (room EWLE9, 2026-09-30: a phone host, a
// desktop joiner at 0.36x) cannot be answered on this box with two real cores:
// two Mario Kart 64 cores under SwiftShader measured 0.687x and 0.396x SOLO,
// side by side (n64/tools/party_pace_probe.mjs --arm solo2), so any two-tab room
// here is CPU-bound before the network is even involved. What the engine does
// with its delay — raise, give back, oscillate or settle — is a property of
// lib/netplay.js and the page's feed loop, and both are run here UNMODIFIED:
//   * two real Netplay.Lockstep engines (host + guest), started through the
//     real seat/declareReady barrier;
//   * each peer driven exactly like n64/index.html lsFeed(): the 1.000x
//     governor (lsDueNow, re-anchors instead of repaying debt — CLAUDE.md
//     gate #9), a 4 ms feed timer plus a kick on every input arrival, and a
//     stall re-anchoring the governor;
//   * a single-threaded peer: a frame costs `cost` ms of its CPU and nothing
//     else (timers, message delivery) runs on that peer meanwhile;
//   * each direction of the link is ORDERED (an RTCDataChannel is), with a
//     per-message one-way latency drawn from the scenario.
// Deterministic: a seeded PRNG, so a cell reproduces exactly.
//
// USAGE  node tools/netplay_pace_sim.mjs [--scenario NAME] [--secs N] [--json]
// With no --scenario it runs every scenario and prints one line each, and
// exits nonzero if a scenario's assertion fails.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis; globalThis.self = globalThis;
(0, eval)(fs.readFileSync(path.join(root, 'lib/netplay.js'), 'utf8'));
const { Lockstep } = globalThis.Netplay;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };

function prng(seed) {        // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A min-heap of [time, seq, fn].
class Q {
  constructor() { this.h = []; this.seq = 0; }
  push(t, fn) { const h = this.h; h.push([t, this.seq++, fn]); let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (lt(h[i], h[p])) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break; } }
  pop() { const h = this.h; const top = h[0]; const last = h.pop();
    if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < h.length && lt(h[l], h[m])) m = l; if (r < h.length && lt(h[r], h[m])) m = r;
      if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } }
    return top; }
  get size() { return this.h.length; }
}
const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

export function simulate(sc) {
  const rnd = prng(sc.seed || 1);
  const viHz = sc.viHz || 50, period = 1000 / viHz;
  const secs = sc.secs || 60;
  let T = 0;
  const q = new Q();
  const peers = {};
  const delayLog = [];
  // ---- the room, formed synchronously (the barrier is not what is measured)
  let live = false;
  const mk = (id, host) => {
    const p = { id, host, busyUntil: 0, baseWall: 0, baseFrame: 0, frames: 0, reanchors: 0,
                cost: sc.cost[id], lastDeliver: 0, feedArmed: false, perSec: [], stalledMs: 0 };
    p.ls = new Lockstep({
      host, peerId: id, portCount: 4, padBytes: 4, delay: 2, hashEvery: 0,
      now: () => T,
      send: (m) => {
        const tagged = Object.assign({ peer: id }, m);
        const other = peers[host ? 'G' : 'H'];
        if (!live) { other.ls.receive(tagged); return; }
        const lat = Math.max(0, sc.latency(T, rnd, id));
        const at = Math.max(p.lastDeliver, T + lat);   // ordered channel
        p.lastDeliver = at;
        q.push(at, () => deliver(other, tagged));
      },
    });
    peers[id] = p;
    return p;
  };
  const H = mk('H', true), G = mk('G', false);
  H.ls.on('delay', (e) => delayLog.push({ t: +(T / 1000).toFixed(2), from: e.from, to: e.to, at: e.at, down: e.to < e.from }));
  H.ls.seat('H', 1); H.ls.seat('G', 1);
  H.ls.delay = sc.startDelay;        // what the page picks from the RTT sample at Ready
  H.ls.declareReady('g'); G.ls.declareReady('g');
  if (H.ls.state !== 'running' || G.ls.state !== 'running') throw new Error('barrier did not release');
  live = true;

  // A message is processed when the peer's thread is free.
  function deliver(p, m) {
    if (T < p.busyUntil) { q.push(p.busyUntil, () => deliver(p, m)); return; }
    p.ls.receive(m);
    if (m.t === 'ls') feed(p);        // n64/index.html kicks the feed on arrival
  }
  // n64/index.html lsDueNow(), verbatim in behaviour.
  function due(p) {
    if (!p.baseWall) { p.baseWall = T; p.baseFrame = p.frames; return true; }
    const d = p.baseWall + (p.frames - p.baseFrame) * period;
    if (T < d) return false;
    if (T - d > period * 2) { p.baseWall = T; p.baseFrame = p.frames; p.reanchors++; }
    return true;
  }
  // One pass of lsFeed(). A frame occupies the peer's thread for `cost` ms, so
  // the loop continues at T + cost rather than in the same instant.
  function feed(p) {
    if (T < p.busyUntil) return;
    if (!due(p)) return;
    const r = p.ls.beginFrame(new Uint8Array(4));
    if (!r.ready) { p.baseWall = 0; return; }
    const c = typeof p.cost === 'function' ? p.cost(T, rnd) : p.cost;
    p.busyUntil = T + c;
    p.frames++;
    p.ls.endFrame(null);
    q.push(p.busyUntil, () => feed(p));
  }
  // The 4 ms feed timer, per peer.
  for (const p of [H, G]) {
    const tick = () => { feed(p); if (T < secs * 1000) q.push(T + 4, tick); };
    q.push(0, tick);
  }
  // Per-second samples.
  const samples = [];
  let lastH = 0, lastG = 0, lastSm = 0;
  const sample = () => {
    const s = H.ls.stats.stallMs + G.ls.stats.stallMs;
    samples.push({ s: samples.length + 1, rateH: (H.frames - lastH) / viHz, rateG: (G.frames - lastG) / viHz,
                   delay: H.ls.delay, stallMs: Math.round(s - lastSm) });
    lastH = H.frames; lastG = G.frames; lastSm = s;
    if (T < secs * 1000) q.push(T + 1000, sample);
  };
  q.push(1000, sample);
  while (q.size) { const [t, , fn] = q.pop(); if (t > secs * 1000 + 1) break; T = t; fn(); }

  const warm = sc.warm == null ? 5 : sc.warm;
  const tail = samples.slice(warm);
  const rate = tail.reduce((a, x) => a + x.rateH, 0) / Math.max(1, tail.length);
  const secsBelow = tail.filter((x) => x.rateH < 0.99).length;
  const ups = delayLog.filter((d) => !d.down).length, downs = delayLog.filter((d) => d.down).length;
  // An oscillation is a give-back that is later taken straight back by a raise.
  let reversals = 0;
  for (let i = 1; i < delayLog.length; i++) if (delayLog[i - 1].down && !delayLog[i].down) reversals++;
  return {
    name: sc.name, secs, viHz, startDelay: sc.startDelay,
    rate: +rate.toFixed(4), secsBelow99: secsBelow, windowSecs: tail.length,
    framesH: H.frames, framesG: G.frames,
    stallsH: H.ls.stats.stalls, stallsG: G.ls.stats.stalls,
    stallMsH: Math.round(H.ls.stats.stallMs), stallMsG: Math.round(G.ls.stats.stallMs),
    reanchorsH: H.reanchors, reanchorsG: G.reanchors,
    delayEnd: H.ls.delay, raises: ups, givebacks: downs, reversals,
    delayLog, samples,
  };
}

// ---- scenarios ---------------------------------------------------------------
const uni = (base, j) => (T, rnd) => base + (rnd() * 2 - 1) * j;
const SCEN = {
  // Two capable machines on a LAN. Must hold 1.000x with no raises.
  clean: { startDelay: 2, cost: { H: 8, G: 8 }, latency: uni(3, 1) },
  // THE REPORT: a phone host that runs this game slower than real time.
  // 52 ms/frame at 50 Hz = 0.385x capacity. The room can only go that fast.
  'slow-host': { startDelay: 2, cost: { H: 52, G: 8 }, latency: uni(15, 5) },
  // A WAN link with jitter, delay chosen from a typical RTT sample.
  jitter: { startDelay: 5, cost: { H: 8, G: 8 }, latency: uni(70, 30) },
  // The RTT sample at Ready was LOW (a lucky ping), so the floor is below what
  // the link needs — the room must raise and then SETTLE, not oscillate.
  'low-sample': { startDelay: 3, cost: { H: 8, G: 8 }, latency: uni(95, 10) },
  // A link that is fine except for a periodic 700 ms hiccup (Wi-Fi scan,
  // cellular handover). The textbook oscillation driver: every hiccup raises,
  // every calm window gives back into the next hiccup.
  hiccups: { startDelay: 4, cost: { H: 8, G: 8 },
             latency: (T, rnd) => ((T % 12000) > 6000 && (T % 12000) < 6700 ? 420 : 45) + (rnd() * 2 - 1) * 8 },
  // The mirror image: the GUEST is the slow machine, so it is the HOST that
  // waits — the one console that decides the delay. It must still not raise.
  'slow-guest': { startDelay: 2, cost: { H: 8, G: 52 }, latency: uni(15, 5) },
  // A sustained latency rise (a relay switch, a congested uplink) for 30 s,
  // then back. The delay must go up to cover it, and come back DOWN after.
  spike: { startDelay: 3, cost: { H: 8, G: 8 },
           latency: (T, rnd) => (T > 20000 && T < 50000 ? 190 : 40) + (rnd() * 2 - 1) * 5 },
  // Bigger hiccups: long enough that one stall outlasts delayBumpAfterMs, so
  // the raise fires every time — the case the give-back has to live with.
  'big-hiccups': { startDelay: 4, cost: { H: 8, G: 8 },
             latency: (T, rnd) => ((T % 12000) > 6000 && (T % 12000) < 6900 ? 900 : 45) + (rnd() * 2 - 1) * 8 },
};

// What each scenario must show (null = pass, else the reason). Written for
// the default --secs 120 and above.
const EXPECT = {
  clean: (r) => r.rate < 0.999 ? 'a clean LAN room must hold 1.000x, read ' + r.rate
             : r.raises ? 'a clean room raised its delay' : null,
  jitter: (r) => r.rate < 0.999 ? 'a delay that covers the jitter must hold 1.000x, read ' + r.rate : null,
  // The room can only run at the slowest machine's pace — and must not pile
  // lag on top of that: a slow MACHINE is not a slow LINK.
  'slow-host': (r) => Math.abs(r.rate - 20 / 52) > 0.01 ? 'room rate ' + r.rate + ' is not the host capacity ' + (20 / 52).toFixed(4)
             : r.raises ? 'the delay was raised for a slow machine (' + r.raises + ' raises) — lag with no benefit' : null,
  'slow-guest': (r) => Math.abs(r.rate - 20 / 52) > 0.01 ? 'room rate ' + r.rate + ' is not the guest capacity'
             : r.raises ? 'the delay was raised for a slow machine (' + r.raises + ' raises)' : null,
  spike: (r) => !r.raises ? 'a sustained latency rise was never covered'
             : r.delayEnd > r.startDelay + 1 ? 'the delay never came back down after the spike (ended ' + r.delayEnd + ')' : null,
  // A floor below what the link needs must be raised to what it needs and
  // then HELD: no oscillation, and the time lost to re-probing shrinks.
  'low-sample': (r) => r.delayEnd !== 6 ? 'expected to settle at 6, ended at ' + r.delayEnd
             : r.rate < 0.995 ? 'rate ' + r.rate + ' below 0.995'
             : r.reversals > Math.ceil(r.secs / 120) ? r.reversals + ' reversals in ' + r.secs + ' s' : null,
  // A hiccup no acceptable delay can cover must not move the delay at all.
  hiccups: (r) => r.reversals ? r.reversals + ' reversals' : r.delayEnd > r.startDelay + 1 ? 'delay climbed to ' + r.delayEnd : null,
  'big-hiccups': (r) => r.reversals ? r.reversals + ' reversals' : r.delayEnd > r.startDelay + 1 ? 'delay climbed to ' + r.delayEnd : null,
};

if (import.meta.url === 'file://' + process.argv[1] || process.argv[1].endsWith('netplay_pace_sim.mjs')) {
  const only = flag('scenario', null);
  const secs = +flag('secs', '120');
  const asJson = argv.includes('--json');
  const names = only ? [only] : Object.keys(SCEN);
  let failed = 0;
  for (const n of names) {
    const r = simulate(Object.assign({ name: n, secs, seed: 7 }, SCEN[n]));
    const ex = EXPECT[n] ? EXPECT[n](r) : null;
    if (ex) { failed++; console.log(`  FAIL  ${n}: ${ex}`); }
    if (asJson) console.log(JSON.stringify(r));
    else {
      console.log(`${n.padEnd(11)} rate ${r.rate.toFixed(4)}x  secs<0.99 ${String(r.secsBelow99).padStart(3)}/${r.windowSecs}  ` +
        `stallMs H ${r.stallMsH} G ${r.stallMsG}  delay ${r.startDelay}->${r.delayEnd}  raises ${r.raises} givebacks ${r.givebacks} reversals ${r.reversals}`);
      if (argv.includes('--history')) console.log('   ' + r.delayLog.map((d) => `${d.t}s:${d.from}->${d.to}`).join('  '));
    }
  }
  console.log(`\n[pace-sim] ${names.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

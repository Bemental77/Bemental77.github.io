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
  // Up to four consoles. 'H' is the host; every other id is a guest linked to
  // the host only — the product's STAR: a guest's frame traffic reaches the
  // other guests through the host's Session (lib/netplay.js RELAYED), which
  // relays it on the host's thread, so a busy host delays the relay too.
  const ids = sc.peers || ['H', 'G'];
  const guests = ids.filter((x) => x !== 'H');
  const RELAYED = { ls: 1, lsh: 1, lsd: 1, lsping: 1, lspong: 1, lspace: 1 };
  let live = false;
  const lastAt = {};   // ordered per directed link
  const link = (from, to, m) => {
    // one-way latency of the host<->guest link that `from`/`to` share
    const g = from === 'H' ? to : from;
    const lat = Math.max(0, sc.latency(T, rnd, g));
    const k = from + '>' + to;
    const at = Math.max(lastAt[k] || 0, T + lat);
    lastAt[k] = at;
    q.push(at, () => arrive(to, m, from));
  };
  const arrive = (to, m, from) => {
    const p = peers[to];
    if (T < p.busyUntil) { q.push(p.busyUntil, () => arrive(to, m, from)); return; }
    if (m.__to && m.__to !== to) {                // at the host, on its way to another guest
      link('H', m.__to, m); return;
    }
    deliver(p, m);
  };
  const mk = (id, host) => {
    const cost = sc.cost[id];
    const p = { id, host, busyUntil: 0, baseWall: 0, baseFrame: 0, frames: 0, reanchors: 0, lostMs: 0,
                cost, costSum: 0, costN: 0 };
    p.ls = new Lockstep({
      host, peerId: id, portCount: 4, padBytes: 4, delay: 2, hashEvery: 0, frameHz: viHz,
      now: () => T,
      send: (m) => {
        const tagged = Object.assign({ peer: id }, m);
        if (!live) { for (const o of ids) if (o !== id) peers[o].ls.receive(tagged); return; }
        if (host) { for (const g of guests) link('H', g, tagged); return; }
        link(id, 'H', tagged);
        if (RELAYED[m.t]) for (const g of guests) if (g !== id) link(id, 'H', Object.assign({ __to: g }, tagged));
      },
    });
    peers[id] = p;
    return p;
  };
  for (const id of ids) mk(id, id === 'H');
  const H = peers.H;
  H.ls.on('delay', (e) => delayLog.push({ t: +(T / 1000).toFixed(2), from: e.from, to: e.to, at: e.at, down: e.to < e.from }));
  for (const id of ids) H.ls.seat(id, 1);
  H.ls.delay = sc.startDelay;        // what the page picks from the RTT sample at Ready
  for (const id of ids) peers[id].ls.declareReady('g');
  for (const id of ids) if (peers[id].ls.state !== 'running') throw new Error('barrier did not release for ' + id);
  live = true;

  function deliver(p, m) {
    if (m.__to) { m = Object.assign({}, m); delete m.__to; }
    p.ls.receive(m);
    if (m.t === 'ls') feed(p);        // n64/index.html kicks the feed on arrival
  }
  // n64/index.html lsDueNow(): re-anchors instead of repaying debt; the debt
  // it discards is what the page reports as selfLostMs.
  function due(p) {
    if (!p.baseWall) { p.baseWall = T; p.baseFrame = p.frames; return true; }
    const d = p.baseWall + (p.frames - p.baseFrame) * period;
    if (T < d) return false;
    // sc.repayMs: MEASUREMENT ONLY — how much debt a console may run back to
    // its schedule. The product repays at most 2 periods (CLAUDE.md gate #9).
    if (T - d > Math.max(period * 2, sc.repayMs || 0)) { p.lostMs += T - d; p.baseWall = T; p.baseFrame = p.frames; p.reanchors++; }
    return true;
  }
  function feed(p) {
    if (T < p.busyUntil) return;
    if (!due(p)) return;
    const r = p.ls.beginFrame(new Uint8Array(4));
    if (!r.ready) { if (!sc.repayMs) p.baseWall = 0; return; }
    const c = typeof p.cost === 'function' ? p.cost(T, rnd) : p.cost;
    p.costSum += c; p.costN++;
    p.busyUntil = T + c;
    p.frames++;
    p.ls.endFrame(null);
    // what the page publishes: capacity from the frame cost, and the time lost
    // without waiting
    p.ls.selfCap = p.costN ? period / (p.costSum / p.costN) : 0;
    p.ls.selfLostMs = p.lostMs;
    q.push(p.busyUntil, () => feed(p));
  }
  for (const id of ids) {
    const p = peers[id];
    const tick = () => { feed(p); if (T < secs * 1000) q.push(T + 4, tick); };
    q.push(0, tick);
  }
  const samples = [];
  const last = {}; for (const id of ids) last[id] = 0;
  let lastSm = 0;
  const sample = () => {
    const sm = ids.reduce((a, id) => a + peers[id].ls.stats.stallMs, 0);
    const row = { s: samples.length + 1, rateH: (H.frames - last.H) / viHz, delay: H.ls.delay, stallMs: Math.round(sm - lastSm) };
    for (const id of ids) { row['rate' + id] = (peers[id].frames - last[id]) / viHz; last[id] = peers[id].frames; }
    if (peers.G) row.rateG = row.rateG;   // two-peer compatibility
    lastSm = sm;
    samples.push(row);
    if (T < secs * 1000) q.push(T + 1000, sample);
  };
  q.push(1000, sample);
  // Verdicts: every console's own answer to "who is the room waiting on",
  // from its own paceReport and the rate it measured over the last 3 s.
  const verdicts = {};
  const vAt = (secs - 1) * 1000;
  const fAt = {}; q.push(vAt - 3000, () => { for (const id of ids) fAt[id] = peers[id].frames; });
  q.push(vAt, () => {
    for (const id of ids) {
      const rate = (peers[id].frames - fAt[id]) / 3 / viHz;
      verdicts[id] = Lockstep.paceVerdict(peers[id].ls.paceReport(), rate);
    }
  });
  while (q.size) { const [t, , fn] = q.pop(); if (t > secs * 1000 + 1) break; T = t; fn(); }

  const warm = sc.warm == null ? 5 : sc.warm;
  const tail = samples.slice(warm);
  const rate = tail.reduce((a, x) => a + x.rateH, 0) / Math.max(1, tail.length);
  const secsBelow = tail.filter((x) => x.rateH < 0.99).length;
  const ups = delayLog.filter((d) => !d.down).length, downs = delayLog.filter((d) => d.down).length;
  let reversals = 0;
  for (let i = 1; i < delayLog.length; i++) if (delayLog[i - 1].down && !delayLog[i].down) reversals++;
  const G = peers[guests[0]];
  return {
    name: sc.name, secs, viHz, startDelay: sc.startDelay, peers: ids.length,
    rate: +rate.toFixed(4), secsBelow99: secsBelow, windowSecs: tail.length,
    framesH: H.frames, framesG: G.frames,
    stallsH: H.ls.stats.stalls, stallsG: G.ls.stats.stalls,
    stallMsH: Math.round(H.ls.stats.stallMs), stallMsG: Math.round(G.ls.stats.stallMs),
    stallMs: Object.fromEntries(ids.map((id) => [id, Math.round(peers[id].ls.stats.stallMs)])),
    reanchorsH: H.reanchors, reanchorsG: G.reanchors,
    delayEnd: H.ls.delay, raises: ups, givebacks: downs, reversals,
    verdicts: Object.fromEntries(ids.map((id) => [id, verdicts[id] ? { kind: verdicts[id].kind, port: verdicts[id].port, text: verdicts[id].text } : null])),
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
  // BOTH machines slower than real time, with jittery frame times — the
  // browser rig on this box. They wait on each other now and then, and that
  // must not read as a slow link.
  'both-slow': { startDelay: 5, cost: { H: (T, rnd) => 26 + rnd() * 12, G: (T, rnd) => 24 + rnd() * 16 },
                 latency: uni(70, 30) },
  // ROOM 49K4T, as reported: a desktop host with a 4.28x cap and a joiner
  // that manages 0.93x. The room can only go 0.93x — and the HOST must say it
  // is waiting on player 2, not blame itself (it did, live).
  'fast-host-slow-joiner': { startDelay: 3, cost: { H: 20 / 4.28, G: 20 / 0.93 }, latency: uni(25, 8) },
  // A WAN link, 50-150 ms one way, with 0.3% of packets lost and resent after
  // a 200 ms RTO (holding up everything behind them — an ordered channel).
  // Both machines are fast. The room must hold 1.000x once the delay covers it.
  wan: { startDelay: 7, cost: { H: 5, G: 12 }, latency: (T, rnd) => 100 + (rnd() * 2 - 1) * 50 },
  // ...and the same link LOSING 0.3% of packets, each resent after a 200 ms
  // RTO while everything behind it waits (a reliable ORDERED channel). The
  // delay cannot buy this back without ~350 ms of lag, and the 1.000x
  // governor never repays a stall, so the room loses ~2%. Recorded, not
  // hidden: the fix is on the transport (inputs on an unreliable channel,
  // each packet carrying the last few frames), not in the delay.
  'wan-loss': { startDelay: 7, cost: { H: 5, G: 12 },
                latency: (T, rnd) => 100 + (rnd() * 2 - 1) * 50 + (rnd() < 0.003 ? 200 : 0) },
  // FOUR PLAYERS. All fast, all near: 1.000x, no raises.
  'four-clean': { peers: ['H', 'G1', 'G2', 'G3'], startDelay: 3, cost: { H: 6, G1: 9, G2: 12, G3: 8 }, latency: uni(20, 5) },
  // Four players, ONE slow link (player 3's: 150 +-40 ms). Every console
  // waits, so it is link-shaped; the delay must rise to cover the relayed
  // path (G1 <-> G2 goes through the host: 20 + 150 ms) and then hold 1.000x.
  'four-slow-link': { peers: ['H', 'G1', 'G2', 'G3'], startDelay: 3, cost: { H: 6, G1: 9, G2: 8, G3: 8 },
                      latency: (T, rnd, g) => (g === 'G2' ? 150 + (rnd() * 2 - 1) * 40 : 20 + (rnd() * 2 - 1) * 5) },
  // Four players, ONE slow MACHINE (player 3 at 0.77x). No raise; every
  // console names player 3; player 3 names itself.
  'four-slow-machine': { peers: ['H', 'G1', 'G2', 'G3'], startDelay: 3, cost: { H: 6, G1: 9, G2: 26, G3: 8 }, latency: uni(20, 5) },
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
  'both-slow': (r) => r.raises > 1 ? r.raises + ' raises for two slow MACHINES (delay ' + r.startDelay + ' -> ' + r.delayEnd + ')' : null,
  'fast-host-slow-joiner': (r) => Math.abs(r.rate - 0.93) > 0.01 ? 'room rate ' + r.rate + ', expected the joiner\'s 0.93x'
             : r.raises ? r.raises + ' raises for a slow machine'
             : r.verdicts.H.kind !== 'device' || r.verdicts.H.port !== 1 ? 'the HOST blamed ' + JSON.stringify(r.verdicts.H)
             : r.verdicts.G.kind !== 'self' ? 'the joiner did not name itself: ' + JSON.stringify(r.verdicts.G)
             : !/0\.93x/.test(r.verdicts.H.text) ? 'the host\'s sentence lacks the joiner\'s cap: ' + r.verdicts.H.text : null,
  // After the delay settles, a WAN room holds 1.000x: judged on the last 60 s.
  wan: (r) => { const t = r.samples.slice(-60); const lo = t.filter((x) => x.rateH < 0.99).length;
               const m = t.reduce((a, x) => a + x.rateH, 0) / t.length;
               return m < 0.998 ? 'last 60 s at ' + m.toFixed(4) + 'x (' + lo + ' s below 0.99)' : null; },
  'wan-loss': (r) => { const t = r.samples.slice(-60); const m = t.reduce((a, x) => a + x.rateH, 0) / t.length;
               return m < 0.96 ? 'last 60 s at ' + m.toFixed(4) + 'x' : r.reversals > 2 ? r.reversals + ' reversals' : null; },
  'four-clean': (r) => r.rate < 0.999 ? 'four fast consoles at ' + r.rate : r.raises ? r.raises + ' raises' : null,
  'four-slow-link': (r) => { const t = r.samples.slice(-60); const m = t.reduce((a, x) => a + x.rateH, 0) / t.length;
               return !r.raises ? 'never raised for a slow link' : m < 0.995 ? 'last 60 s at ' + m.toFixed(4) + 'x' : null; },
  'four-slow-machine': (r) => Math.abs(r.rate - 20 / 26) > 0.01 ? 'room rate ' + r.rate + ', expected player 3\'s ' + (20 / 26).toFixed(3)
             : r.raises ? r.raises + ' raises for a slow machine'
             : ['H', 'G1', 'G3'].some((id) => r.verdicts[id].kind !== 'device' || r.verdicts[id].port !== 2) ? 'not everyone named player 3: ' + JSON.stringify(r.verdicts)
             : r.verdicts.G2.kind !== 'self' ? 'player 3 did not name itself: ' + JSON.stringify(r.verdicts.G2) : null,
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
  const repay = +flag('repay', '0');
  const secs = +flag('secs', '120');
  const asJson = argv.includes('--json');
  const names = only ? [only] : Object.keys(SCEN);
  let failed = 0;
  for (const n of names) {
    const r = simulate(Object.assign({ name: n, secs, seed: 7, repayMs: repay }, SCEN[n]));
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

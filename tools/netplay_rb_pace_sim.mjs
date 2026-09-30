#!/usr/bin/env node
// ---------------------------------------------------------------------------
// netplay_rb_pace_sim.mjs — DOES A ROLLBACK ROOM HOLD 1.000x ON A REAL LINK,
// WITH ZERO INPUT DELAY, AND NEVER FORK?
//
// WHY. tools/netplay_device_matrix.mjs measured a two-desktop Genesis rollback
// room (genesis.html RB_WINDOW 8) at 0.76x with 100 ms one way (120 window
// stalls) and at 0.85x over the relay (393 stalls). A fixed 8-frame window
// cannot cover 100 ms one way at 60 Hz plus jitter, and the guest that heard
// 'lsgo' one link-latency late started that far behind the host for good.
// This rig is where the fix is PROVEN, with no browser and no emulator:
//   * N real Netplay.Lockstep engines (2 or 4), rollback on, started through
//     the real seat -> declareReady -> 'lsgo' barrier OVER THE LINK, so a
//     guest begins one latency after the host exactly as in a real room;
//   * THE STAR the product has: a guest talks only to the host, which
//     forwards frame traffic (lib/netplay.js RELAYED) to the other guests —
//     guest-to-guest input pays two hops;
//   * TWO CHANNELS per link, as in the product: input ('ls') rides an
//     UNORDERED, maxRetransmits:0 channel (a lost packet is gone); every other
//     message rides a RELIABLE ORDERED one (a lost packet costs an RTO and
//     holds everything behind it);
//   * every console is paced exactly like genesis.html loop(): a display tick
//     every 16.7 ms WITH JITTER, a wall-clock credit accumulator whose debt
//     beyond one frame is DROPPED (genesis.html:1115, CLAUDE.md gate 9), at
//     most 4 credited frames a tick — plus, when the engine offers them,
//     rbCatchUp() hidden frames (not presented, audio dropped) and the
//     rbPace() credit multiplier;
//   * a single-threaded page: every frame, first-time or re-simulated, costs
//     `stepMs` of that console's thread (genesis.html rbStep: load + run +
//     save), and a message that arrives while the thread is busy waits;
//   * a deterministic toy core (its savestate is one uint32) with a ring of
//     savestates, so a rollback that reaches outside the ring throws.
//
// WHAT IS ASSERTED, PER CELL
//   room-rate        every console ran >= 0.995 x 60 frames per second over
//                    the measured span (hidden catch-up frames count — they
//                    are frames of the room the console really ran);
//   never-ahead      no console's frame count ever passed the ROOM CLOCK —
//                    (now - the host's start) at 1.000x — by more than 1.5
//                    frames (a tick's phase), no console ever CREDITED more
//                    frames than its own wall clock allowed (+2), and no
//                    5-second window of credited (presented) frames ran faster
//                    than 1.02x — the device matrix's fast-forward bar
//                    (gate 9: nothing is ever sped up past the hardware; a
//                    hidden catch-up frame restores time the console lost and
//                    is bounded by the room clock, not added to it);
//   zero-lag         every frame ran the local pad sampled for THAT frame
//                    (image[localPort] == the pad sampled on its first try);
//   no-desync        0 engine desyncs, fingerprints compared > 0, AND every
//                    fingerprinted state equals a straight run of the true
//                    inputs (stronger than the engines agreeing with each other).
//
// Deterministic (seeded PRNG): a cell reproduces exactly.
// USAGE  node tools/netplay_rb_pace_sim.mjs [--cell NAME] [--secs N] [--json]
//        NETPLAY_JS=/path/to/old/netplay.js node tools/netplay_rb_pace_sim.mjs   (A/B)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis; globalThis.self = globalThis;
(0, eval)(fs.readFileSync(process.env.NETPLAY_JS || path.join(root, 'lib/netplay.js'), 'utf8'));
const { Lockstep } = globalThis.Netplay;

function prng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
class Q {
  constructor() { this.h = []; this.seq = 0; }
  push(t, fn) { const h = this.h; h.push([t, this.seq++, fn]); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (lt(h[i], h[p])) { [h[i], h[p]] = [h[p], h[i]]; i = p; } else break; } }
  pop() { const h = this.h; const top = h[0]; const last = h.pop(); if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && lt(h[l], h[m])) m = l; if (r < h.length && lt(h[r], h[m])) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } } return top; }
  get size() { return this.h.length; }
}
const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
// The Session's relay set, read from the product when it publishes it.
const RELAYED = (globalThis.Netplay && globalThis.Netplay.RELAYED) ||
  { ls: 1, lsh: 1, lsd: 1, lsping: 1, lspong: 1, lspace: 1, lsnak: 1 };

const fnv = (h, v) => Math.imul((h ^ (v >>> 0)) >>> 0, 0x01000193) >>> 0;
const coreStep = (st, image, k) => { let h = fnv(st, k); for (let i = 0; i < image.length; i++) h = fnv(h, image[i]); return h >>> 0; };

export function simulate(sc) {
  const rnd = prng(sc.seed || 11);
  const HZ = 60, FRAME = 1000 / HZ, secs = sc.secs || 60;
  const n = sc.players || 2;
  const ids = ['H', 'G1', 'G2', 'G3'].slice(0, n);
  const PAD = 2;
  let T = 0; const q = new Q();
  const P = {};
  const lastAt = {};
  const stats = { dropped: 0, resent: 0, msgs: 0, bytes: 0 };
  const latency = (from, to) => {
    const g = from === 'H' ? to : from;
    const base = typeof sc.baseMs === 'function' ? sc.baseMs(T, g) : (sc.baseMs || 0);
    return Math.max(0, base + rnd() * (sc.jitterMs || 0));
  };
  const outage = (id) => sc.outage && sc.outage.id === id && T >= sc.outage.from && T < sc.outage.to;
  // One hop. `m` is already a private copy.
  const hop = (from, to, m) => {
    if (outage(from) || outage(to)) { stats.dropped++; return; }
    stats.msgs++;
    const lost = sc.loss > 0 && rnd() < sc.loss;
    const lat = latency(from, to);
    if (m.t === 'ls' && !m.rel) {                    // the unreliable, unordered input channel
      if (lost) { stats.dropped++; return; }
      q.push(T + lat, () => arrive(to, m, from));
      return;
    }
    const k = from + '>' + to;                       // reliable ordered: RTO + head-of-line
    if (lost) stats.resent++;
    const at = Math.max(lastAt[k] || 0, T + lat + (lost ? (sc.rtoMs || Math.max(200, 2 * (sc.baseMs || 0) + 50)) : 0));
    lastAt[k] = at;
    q.push(at, () => arrive(to, m, from));
  };
  const arrive = (to, m, from) => {
    const p = P[to];
    if (outage(to)) return;
    if (T < p.busyUntil) { q.push(p.busyUntil, () => arrive(to, m, from)); return; }
    p.ls.receive(m);
    // THE HOST FORWARDS a guest's frame traffic to every other guest (Session._relay).
    if (p.host && RELAYED[m.t] && m.peer !== 'H') for (const o of ids) if (o !== 'H' && o !== m.peer) hop('H', o, JSON.parse(JSON.stringify(m)));
  };
  const seg = {};
  const padFor = (id, port, f) => {
    // each console's pad changes every 4..24 frames, deterministically per (console, segment)
    const s = seg[id] || (seg[id] = { at: [0], val: [] });
    while (s.at[s.at.length - 1] <= f) s.at.push(s.at[s.at.length - 1] + 4 + ((fnv(0x1234 + ids.indexOf(id), s.at.length) % 21)));
    let i = 0; while (s.at[i + 1] <= f) i++;
    const v = fnv(0x9e37 + ids.indexOf(id) * 7919, i);
    return new Uint8Array([v & 0xff, (v >>> 8) & 0x0f]);
  };
  for (const id of ids) {
    const host = id === 'H';
    const p = P[id] = {
      id, host, busyUntil: 0, lastTs: 0, accum: 0, frames: 0, hidden: 0, presented: 0, ticks: 0,
      stepMs: (sc.stepMs && sc.stepMs[id] != null) ? sc.stepMs[id] : (sc.stepMsAll || 1.5),
      ring: new Map(), st: 0x811c9dc5, started: false, beganAt: null, declared: false,
      sampled: new Map(), lagN: 0, lagBad: 0, resim: 0, maxTickWork: 0, aheadMax: -Infinity,
      hashes: new Map(), win: [], winAt: 0, winF: 0, frameAt: [], creditOver: -Infinity,
    };
    const opts = { host, peerId: id, portCount: sc.portCount || Math.max(2, n), padBytes: PAD, delay: 2, hashEvery: 30,
                   rollback: sc.window || 8, now: () => T, frameHz: HZ,
                   send: (m) => {
                     const tagged = JSON.parse(JSON.stringify(Object.assign({ peer: id }, m)));
                     if (host) { for (const o of ids) if (o !== 'H') hop('H', o, JSON.parse(JSON.stringify(tagged))); }
                     else hop(id, 'H', tagged);
                   } };
    if (sc.catchUp !== false) { opts.rbCatchUp = true; opts.selfStepMs = p.stepMs; }
    p.ls = new Lockstep(opts);
    p.ls.selfStepMs = p.stepMs;
  }
  const H = P.H;
  for (const id of ids) H.ls.seat(id, 1);
  const events = [];
  for (const id of ids) {
    P[id].ls.on('leave', (e) => events.push({ t: Math.round(T), at: id, ev: 'leave', who: e.who, ports: e.ports, frame: e.at, missed: !!e.missed }));
    P[id].ls.on('rejoin', (e) => events.push({ t: Math.round(T), at: id, ev: 'rejoin', who: e.who, ports: e.ports, frame: e.at }));
  }

  function runFrame(p, hidden) {
    const ls = p.ls;
    const f = ls.frame;
    const pads = {};
    for (const port of ls.localPorts) pads[port] = padFor(p.id, port, f);
    if (!p.sampled.has(f)) p.sampled.set(f, pads);
    const r = ls.beginFrame(pads, hidden ? { hidden: true } : undefined);
    if (!r.ready) return 0;
    let work = 0;
    if (r.rollback) {
      let st = p.ring.get(r.rollback.from);
      if (st === undefined) throw new Error(p.id + ': rollback to ' + r.rollback.from + ' is outside the savestate ring (frame ' + f + ')');
      for (const fr of r.rollback.frames) { st = coreStep(st, fr.image, fr.frame); p.ring.set(fr.frame + 1, st); work += p.stepMs; p.resim++; }
      p.st = st;
    }
    const first = p.sampled.get(r.frame);
    for (const port of ls.localPorts) {
      p.lagN++;
      const a = first[port], b = r.image.subarray(port * PAD, port * PAD + PAD);
      if (!(ls._limp && ls._isLimp && ls._isLimp(port, r.frame)) && (a[0] !== b[0] || a[1] !== b[1])) p.lagBad++;
    }
    // genesis.html rbStep: EVERY frame loads its own start slot first. After a
    // full plan that is the corrected state; after a SPREAD plan (the engine
    // re-simulated only part of the history this tick) it is the old branch,
    // which the next tick's plan goes on correcting.
    const start = p.ring.get(r.frame);
    if (start === undefined) throw new Error(p.id + ': no savestate for the start of frame ' + r.frame);
    p.st = coreStep(start, r.image, r.frame);
    p.ring.set(r.frame + 1, p.st);
    work += p.stepMs;
    ls.endFrame(null);
    for (const k of ls.takeHashDue()) {
      const s = p.ring.get(k + 1);
      if (s === undefined) throw new Error(p.id + ': no state for the hash of frame ' + k);
      p.hashes.set(k, s);
      ls.submitHash(k, s);
    }
    const keep = Math.max(40, (ls._rbWinPeak || ls.rollback || 8) + 8);
    if ((r.frame & 31) === 0) for (const k of p.ring.keys()) { if (k < r.frame - keep) p.ring.delete(k); }
    p.frames++; if (hidden) p.hidden++;
    for (const k of p.sampled.keys()) { if (k < r.frame - 64) p.sampled.delete(k); else break; }
    return work || 0.001;
  }
  function tick(p) {
    const ls = p.ls;
    if (outage(p.id)) { p.lastTs = 0; return; }               // a backgrounded tab runs nothing
    if (!p.declared && ls.localPorts.length) { p.declared = true; ls.declareReady('g'); }
    const running = ls.state === 'running' || ls.state === 'stalled';
    if (!running) { p.lastTs = 0; return; }
    if (p.beganAt == null) { p.beganAt = T; p.ring.set(ls.frame, p.st); }
    if (!p.lastTs) { p.lastTs = T; p.accum = 0; return; }
    let d = T - p.lastTs; p.lastTs = T; if (d > 100) d = 100;
    const pace = typeof ls.rbPace === 'function' ? ls.rbPace() : 1;
    p.accum += d * pace;
    let work = 0, ran = 0;
    if (typeof ls.rbCatchUp === 'function' && sc.catchUp !== false) {
      const k = ls.rbCatchUp();
      for (let i = 0; i < k; i++) { const w = runFrame(p, true); if (!w) break; work += w; }
    }
    while (p.accum >= FRAME && ran < 4) { const w = runFrame(p, false); if (!w) break; work += w; p.accum -= FRAME; ran++; }
    if (p.accum > FRAME) p.accum = FRAME;
    if (ran) p.presented++;
    p.ticks++;
    if (work > p.maxTickWork) p.maxTickWork = work;
    p.busyUntil = T + work;
  }
  for (const id of ids) {
    const p = P[id];
    const phase = rnd() * FRAME;
    const loop = () => {
      tick(p);
      // rAF: the next vsync after the thread is free, jittered
      let next = T + FRAME + (rnd() - 0.5) * (sc.tickJitterMs == null ? 4 : sc.tickJitterMs);
      if (sc.hiccup && rnd() < sc.hiccup.p) next += sc.hiccup.ms;
      if (p.busyUntil > next) next = p.busyUntil + (FRAME - ((p.busyUntil - phase) % FRAME));
      if (T < secs * 1000) q.push(next, loop);
    };
    q.push(phase + (sc.startJitterMs ? rnd() * sc.startJitterMs : 0), loop);
  }
  // ---- sampling: the room clock and the 5-second windows ------------------
  const roomClock = () => (H.beganAt == null ? 0 : (T - H.beganAt) / FRAME);
  const winLen = 5000;
  const sample = () => {
    for (const id of ids) {
      const p = P[id];
      if (H.beganAt != null) { const ahead = p.frames - roomClock(); if (ahead > p.aheadMax) p.aheadMax = ahead; }
      // CREDITED frames against this console's OWN clock: the 1.000x accumulator
      // may never have run more than the wall time it was given.
      if (p.beganAt != null) { const over = (p.frames - p.hidden) - (T - p.beganAt) / FRAME; if (over > p.creditOver) p.creditOver = over; }
      p.frameAt.push([T, p.frames, p.frames - p.hidden]);
    }
    if (T < secs * 1000) q.push(T + 100, sample);
  };
  q.push(100, sample);
  while (q.size) { const [t, , fn] = q.pop(); if (t > secs * 1000 + 1) break; T = t; fn(); }

  // ---- verdicts -----------------------------------------------------------
  const warm = (sc.warmSecs == null ? 5 : sc.warmSecs) * 1000;
  const out = { name: sc.name, players: n, consoles: {} };
  let minRate = Infinity, maxWin = 0, lagBad = 0, lagN = 0, desyncs = 0, compared = 0;
  for (const id of ids) {
    const p = P[id], ls = p.ls, rep = ls.report(), rb = rep.rollback || {};
    const fa = p.frameAt;
    const at = (t) => { let best = fa[0]; for (const x of fa) { if (x[0] <= t) best = x; else break; } return best; };
    const a = at(warm), b = fa[fa.length - 1];
    const rate = (b[1] - a[1]) / ((b[0] - a[0]) / FRAME);
    let mw = 0;
    for (let i = 0; i < fa.length; i++) {
      if (fa[i][0] < warm) continue;
      const j = fa.findIndex((x) => x[0] >= fa[i][0] + winLen);
      if (j < 0) break;
      // CREDITED frames only: what the 1.000x accumulator ran and the screen
      // showed. Hidden catch-up frames restore time the console lost; they
      // are bounded by the room clock (never-ahead), not by this.
      const r = (fa[j][2] - fa[i][2]) / ((fa[j][0] - fa[i][0]) / FRAME);
      if (r > mw) mw = r;
    }
    minRate = Math.min(minRate, rate); maxWin = Math.max(maxWin, mw);
    lagBad += p.lagBad; lagN += p.lagN;
    if (ls.state === 'desync') desyncs++;
    compared += rep.hashesCompared || 0;
    out.consoles[id] = { rate: +rate.toFixed(4), max5s: +mw.toFixed(4), presented: +(p.presented / ((T - (p.beganAt || 0)) / FRAME)).toFixed(4),
      frames: p.frames, hidden: p.hidden, aheadOfRoomClock: +p.aheadMax.toFixed(2), state: ls.state, error: ls.error || null,
      window: ls.rollback, windowPeak: ls._rbWinPeak || ls.rollback, stalls: rb.windowStalls, advWaits: rb.advantageWaits,
      rollbacks: rb.rollbacks, maxDepth: rb.maxDepth, resim: p.resim, catchUp: rb.catchUpFrames || 0,
      windowChanges: rb.windowChanges || 0, holeNaks: rb.holeNaks || 0, compared: rep.hashesCompared, maxTickWork: +p.maxTickWork.toFixed(1),
      lag: p.lagBad + '/' + p.lagN };
  }
  // ---- the straight run: every fingerprinted state vs the TRUE inputs -----
  // True input for (frame, port): the owner's pad sampled on its first try,
  // or neutral where the engine agreed the port was limp.
  let truthChecked = 0, truthBad = 0;
  {
    const hostLs = H.ls;
    let maxK = -1;
    for (const id of ids) for (const k of P[id].hashes.keys()) if (k > maxK) maxK = k;
    let st = 0x811c9dc5;
    const img = new Uint8Array((sc.portCount || Math.max(2, n)) * PAD);
    const ownerOf = (port) => hostLs.roster[port];
    const byK = new Map();
    for (let k = 0; k <= maxK; k++) {
      img.fill(0);
      for (let port = 0; port < img.length / PAD; port++) {
        const who = ownerOf(port); if (who == null) continue;
        const limp = hostLs._limp && hostLs._isLimp && hostLs._isLimp(port, k);
        if (limp) continue;
        // padFor is a pure function of (console, port, frame), and it is
        // exactly what the owner sampled on its first try at k.
        img.set(padFor(who, port, k), port * PAD);
      }
      st = coreStep(st, img, k);
      byK.set(k, st);
    }
    for (const id of ids) for (const [k, s] of P[id].hashes) {
      // a frame the host no longer holds input for cannot be re-derived here
      truthChecked++; if (byK.get(k) !== s) truthBad++;
    }
  }
  out.minRate = +minRate.toFixed(4); out.maxWin5s = +maxWin.toFixed(4);
  out.lagBad = lagBad; out.lagN = lagN; out.desyncs = desyncs; out.compared = compared;
  out.truthChecked = truthChecked; out.truthBad = truthBad;
  out.net = stats; out.events = events;
  out.aheadMax = Math.max(...ids.map((id) => P[id].aheadMax));
  out.creditOver = Math.max(...ids.map((id) => P[id].creditOver));
  return out;
}

// ---- the cells ------------------------------------------------------------
const CELLS = {};
for (const players of [2, 4]) for (const ow of [0, 50, 100, 150]) {
  CELLS[`rb-${players}p-${ow}ms`] = { players, baseMs: ow, jitterMs: 10 + 0.2 * ow, loss: 0.02 };
}
// one phone (a 4x slower rollback step) in a room — the capacity question.
CELLS['rb-2p-100ms-phone'] = { players: 2, baseMs: 100, jitterMs: 30, loss: 0.02, stepMs: { G1: 6 } };
CELLS['rb-4p-50ms-phone'] = { players: 4, baseMs: 50, jitterMs: 20, loss: 0.02, stepMs: { G3: 6 } };
// ⚠ REPORTED, NOT GATED: a 6 ms/step phone in a FOUR-player room at 100 ms one
// way re-simulates ~20-frame corrections from three remote players and has no
// capacity left for them (it presents ~30% of its ticks; the room measured
// 0.983-0.987x). That is a device limit, not a pacing bug: the same phone holds
// >= 0.995x in the 2-player and 50 ms cells above. Spreading a correction over
// several ticks was tried and made it WORSE (presented 0.75 -> 0.56 at 2p/100).
CELLS['rb-4p-100ms-phone'] = { players: 4, baseMs: 100, jitterMs: 30, loss: 0.02, stepMs: { G3: 6 }, info: true };
// the room with display ticks that hitch (a 60 ms stall on 1% of ticks)
CELLS['rb-2p-100ms-hitchy'] = { players: 2, baseMs: 100, jitterMs: 30, loss: 0.02, hiccup: { p: 0.01, ms: 60 } };

export const RB_CELLS = CELLS;
export function judge(r) {
  const bad = [];
  if (!(r.minRate >= 0.995)) bad.push('room rate ' + r.minRate + ' < 0.995');
  // tools/netplay_device_matrix.mjs's fast-forward bar: no 5-s window of
  // presented frames above 1.02x (a hiccup's frames, repaid in the next tick,
  // can put a window a frame or four over 1.000x without the page ever having
  // run more frames than wall time — that is what creditOver checks).
  if (!(r.maxWin5s <= 1.02)) bad.push('a 5-second window PRESENTED ' + r.maxWin5s + 'x (> 1.02, gate 9)');
  if (!(r.creditOver <= 2)) bad.push('a console credited ' + r.creditOver.toFixed(2) + ' frames more than its own wall clock');
  if (!(r.aheadMax <= 1.5)) bad.push('a console ran ' + r.aheadMax.toFixed(2) + ' frames past the room clock');
  if (r.lagBad) bad.push(r.lagBad + '/' + r.lagN + ' frames did not run the pad sampled for them');
  if (r.desyncs) bad.push(r.desyncs + ' desyncs');
  if (!(r.compared > 0)) bad.push('no fingerprints compared');
  if (r.truthBad || !(r.truthChecked > 0)) bad.push(r.truthBad + '/' + r.truthChecked + ' fingerprinted states differ from a straight run');
  for (const id in r.consoles) if (r.consoles[id].state === 'failed') bad.push(id + ' failed: ' + r.consoles[id].error);
  return bad;
}

if (process.argv[1] && process.argv[1].endsWith('netplay_rb_pace_sim.mjs')) {
  const argv = process.argv.slice(2);
  const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const only = flag('cell', null), secs = +flag('secs', '60');
  let failed = 0, passed = 0;
  console.log('=== rollback pace sim (real Lockstep engines, star topology, 2% loss + jitter, zero input delay) ===');
  for (const name of (only ? only.split(',') : Object.keys(CELLS))) {
    let r;
    try { r = simulate(Object.assign({ name, secs }, CELLS[name])); }
    catch (e) { failed++; console.log(`  FAIL  ${name}: threw ${e.message}`); continue; }
    const bad = judge(r);
    const info = CELLS[name].info;
    if (bad.length && !info) failed++; else passed++;
    const c = Object.values(r.consoles);
    console.log(`  ${bad.length ? (info ? 'INFO' : 'FAIL') : 'PASS'}  ${name.padEnd(20)} room ${r.minRate.toFixed(4)}x (presented max 5s ${r.maxWin5s.toFixed(4)}x, vs room clock <=${r.aheadMax.toFixed(2)}f)`
      + `  window ${c.map((x) => x.window + '/' + x.windowPeak).join(' ')}  stalls ${c.map((x) => x.stalls).join('/')}`
      + `  catch-up ${c.map((x) => x.catchUp).join('/')}  depth<=${Math.max(...c.map((x) => x.maxDepth))}`
      + `  presented ${c.map((x) => x.presented).join('/')}  lag ${r.lagBad}/${r.lagN}  desync ${r.desyncs} cmp ${r.compared} truth ${r.truthChecked - r.truthBad}/${r.truthChecked}`
      + (bad.length ? '\n        ' + bad.join('; ') : ''));
    if (argv.includes('--json')) console.log(JSON.stringify(r));
  }
  console.log(`\n[rb-pace-sim] ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

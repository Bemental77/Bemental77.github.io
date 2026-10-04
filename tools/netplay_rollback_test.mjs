#!/usr/bin/env node
// ROLLBACK, PROVEN IN NODE — lib/netplay.js Lockstep with opts.rollback = W.
//
// Two real Lockstep engines (host + guest) speak the real wire protocol over a
// simulated network with a one-way latency, each driven by a 60 Hz tick that
// runs AT MOST one new frame per tick (the page's 1.000x accumulator), and each
// owning a deterministic toy "core" whose savestate is its whole state. The
// page contract is followed exactly:
//   r = ls.beginFrame(pads)
//   if r.rollback: state = ring[r.rollback.from]; re-run every r.rollback.frames
//                  (saving each frame's start) WITHOUT presenting
//   run r.frame on r.image; ls.endFrame(null)
//   for k of ls.takeHashDue(): ls.submitHash(k, hash(ring[k+1]))
//
// WHAT IS ASSERTED
//   1. local input lag: the pad sampled for frame F is in F's image at the
//      local port — 0 frames (lockstep arm: `delay` frames, for the before/after);
//   2. rollbacks happen under latency, never deeper than the window;
//   3. every CONFIRMED frame's state on both consoles equals a straight run of
//      the true inputs (stronger than the fingerprint), and the engines'
//      own fingerprint exchange saw no desync and compared > 0 frames;
//   4. the guest rate never exceeds 1.000x: new frames per tick <= 1;
//   5. a guest built WITHOUT rollback adopts the host's window from 'lsgo';
//   6. a mispredicted frame's hash is never submitted before it is confirmed.
//
// USAGE  node tools/netplay_rollback_test.mjs [--latency-ms 50] [--seconds 60] [--window 8]
import { readFileSync } from 'fs';
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(readFileSync(new URL('../lib/netplay.js', import.meta.url), 'utf8'))();
const L = globalThis.Netplay.Lockstep;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = +flag('seconds', 60);
const WINDOW = +flag('window', 8);

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

// ---- a deterministic toy core: state is one uint32 -------------------------
const fnv = (h, v) => Math.imul((h ^ (v >>> 0)) >>> 0, 0x01000193) >>> 0;
const step = (st, image, k) => { let h = fnv(st, k); for (let i = 0; i < image.length; i++) h = fnv(h, image[i]); return h; };

// scripted pads: port 0 changes every 11 frames, port 1 every 7 (offset)
const padFor = (port, f) => {
  const b = new Uint8Array(2);
  const seg = port === 0 ? Math.floor(f / 11) : Math.floor((f + 3) / 7);
  b[0] = (seg * (port ? 37 : 53)) & 0xff; b[1] = port;
  return b;
};

function runRoom({ latencyMs, jitterMs = 0, rollback, guestRollback = rollback, delay = 2,
                   guestStartMs = 40, seconds = SECONDS, dropGuestAtMs = 0, unique = false, noRewind = false,
                   edge = false, edgeBytes = null }) {
  // unique: every frame's pad is distinct (b[1] = f), so the frame a sampled pad
  // lands on is unambiguous — the latency arm. (Every remote frame then
  // mispredicts, so that arm is also the worst case for rollback work.)
  // edge: byte 0 is a ONE-FRAME EDGE (a press on exactly one frame, every 9th/13th frame), byte 1
  // a held level that changes every 29 frames — GameCube's btn/dstk vs stick.
  const pad = unique ? (p, f) => { const b = padFor(p, f); b[1] = (f & 0x7f) | (p << 7); return b; }
            : edge ? (p, f) => { const b = new Uint8Array(2); b[0] = (f % (p ? 13 : 9)) === 0 ? 1 + ((f >> 3) & 7) : 0; b[1] = (Math.floor(f / 29) * 41 + p) & 0xff; return b; }
            : padFor;
  let now = 0;
  const q = [];   // { at, to, msg }  — ordered per direction (a DataChannel is ordered)
  const lastAt = { H: 0, G: 0 };
  let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const send = (to) => (m) => {
    let at = now + latencyMs + (jitterMs ? rnd() * jitterMs : 0);
    if (at < lastAt[to]) at = lastAt[to];
    lastAt[to] = at;
    q.push({ at, to, msg: JSON.parse(JSON.stringify(m)) });
  };
  // rollbackOk: this toy page CAN rewind even when it does not ask for rollback
  // itself — the host runs rollback only for consoles that declare it
  // (lsready rb); `noRewind` is a page that cannot.
  const mk = (id, host, rb) => new L({ peerId: id, host, portCount: 2, padBytes: 2, delay, hashEvery: 30,
                                       rollback: rb, rollbackOk: !(noRewind && !host), stallBudgetMs: 0, send: send(host ? 'G' : 'H'), now: () => now,
                                       rbEdgeBytes: edgeBytes || undefined });
  const E = { H: mk('H', true, rollback), G: mk('G', false, guestRollback) };
  E.H.seat('H', 1); E.H.seat('G', 1);
  const con = {};
  for (const id of ['H', 'G']) con[id] = { ring: new Map(), st: 0x811c9dc5, ran: 0, maxPerTick: 0, resim: 0,
    stateAfter: new Map(), latency: [], lag: [], submitted: new Set(), started: false, ticks: 0 };
  const deliver = () => {
    q.sort((a, b) => a.at - b.at);
    while (q.length && q[0].at <= now) { const d = q.shift(); if (!(dropGuestAtMs && d.to === 'H' && now >= dropGuestAtMs)) E[d.to].receive(d.msg); }
  };
  const TICK = 1000 / 60;
  const endMs = seconds * 1000;
  let declared = { H: false, G: false };
  const tickOf = { H: 0, G: guestStartMs };
  let t = 0;
  while (t < endMs) {
    // next event: whichever console ticks next
    const id = tickOf.H <= tickOf.G ? 'H' : 'G';
    now = tickOf[id]; t = now;
    deliver();
    const ls = E[id], c = con[id];
    if (dropGuestAtMs && id === 'G' && now >= dropGuestAtMs) { tickOf[id] += TICK; continue; }
    if (!declared[id] && ls.localPorts.length) { declared[id] = true; ls.declareReady('disc'); }
    c.ticks++;
    let perTick = 0;
    if (ls.state === 'running' || ls.state === 'stalled') {
      if (!c.started) { c.started = true; c.ring.set(0, c.st); }
      const f = ls.frame;
      const pads = {}; for (const p of ls.localPorts) pads[p] = pad(p, f);
      if (!c.sampled) c.sampled = new Map();
      for (const p of ls.localPorts) if (!c.sampled.has(p + ':' + f)) c.sampled.set(p + ':' + f, pads[p]);
      const r = ls.beginFrame(pads);
      if (r.ready) {
        if (r.rollback) {
          c.st = c.ring.get(r.rollback.from);
          if (c.st === undefined) throw new Error(id + ': no savestate for frame ' + r.rollback.from);
          for (const fr of r.rollback.frames) {
            c.ring.set(fr.frame, c.st);
            c.st = step(c.st, fr.image, fr.frame);
            c.ring.set(fr.frame + 1, c.st);
            c.resim++;
          }
        }
        c.ring.set(r.frame, c.st);
        c.st = step(c.st, r.image, r.frame);
        c.ring.set(r.frame + 1, c.st);
        perTick++; c.ran++;
        // LOCAL INPUT LAG: the image frame F ran on carries, at the local port,
        // the pad this console sampled when it first attempted frame F - d.
        // d is the lag in frames. (unique pads make d unambiguous.)
        for (const p of ls.localPorts) {
          const got = r.image.subarray(p * 2, p * 2 + 2);
          let d = null;
          for (let back = 0; back <= 32 && d == null; back++) {
            const w = c.sampled.get(p + ':' + (r.frame - back));
            if (w && w[0] === got[0] && w[1] === got[1]) d = back;
          }
          if (unique || d === 0) c.lag.push(d);
          else c.lag.push(d);
        }
        ls.endFrame(null);
        for (const k of ls.takeHashDue()) {
          const after = c.ring.get(k + 1);
          c.submitted.add(k);
          c.stateAfter.set(k, after);
          ls.submitHash(k, after);
        }
        for (const k of Array.from(c.ring.keys())) if (k < ls.frame - WINDOW - 6) c.ring.delete(k);
      }
    }
    if (perTick > c.maxPerTick) c.maxPerTick = perTick;
    tickOf[id] += TICK;
  }
  // reference: a straight run of the TRUE inputs (port 0 = H's pads, port 1 = G's)
  const truth = (k) => { const im = new Uint8Array(4); im.set(E.H._inputFor(k, 0) || pad(0, k), 0); im.set(E.H._inputFor(k, 1) || pad(1, k), 2); return im; };
  return { E, con, truth, lastMs: t };
}

console.log('=== netplay rollback (node, real Lockstep engines, simulated wire) ===');

// ---- LOCAL INPUT LAG, BEFORE vs AFTER (unique per-frame pads) -------------
// (the first frames are the lockstep prologue: frames < delay run neutral pads
// by agreement, which would read as a spurious small lag — skipped.)
const lagOf = (R) => { const all = [...R.con.H.lag.slice(10), ...R.con.G.lag.slice(10)].filter((x) => x != null); const h = {}; for (const x of all) h[x] = (h[x] || 0) + 1; return { n: all.length, h }; };
{
  // The delay a page would actually pick for this link (recommendDelay, from the
  // RTT at Ready). It used to run at delay 2 over a 50 ms one-way path — two
  // frames short — which the engine then never raised (no single stall passed
  // 400 ms), so this arm measured a lockstep room running at ~0.82x with a
  // constant lag. The pace controller (lib/netplay.js _paceTick) now raises a
  // room like that to what the link needs, which is the correct BEFORE.
  const B = runRoom({ latencyMs: 50, rollback: 0, seconds: 10, unique: true, delay: L.recommendDelay(100, 1000 / 60) });
  const lb = lagOf(B);
  ok('BEFORE-lockstep-local-lag-is-the-delay', lb.n > 500 && Object.keys(lb.h).length === 1 && lb.h[B.E.H.delay] === lb.n,
     `lockstep (delay=${B.E.H.delay}): local pad applied N frames after sampling, histogram ${JSON.stringify(lb.h)} over ${lb.n} frames = ${Math.round(B.E.H.delay * 1000 / 60)} ms at 60 Hz`);
  const A = runRoom({ latencyMs: 50, rollback: WINDOW, seconds: 10, unique: true });
  const la = lagOf(A);
  ok('AFTER-rollback-local-lag-is-zero', la.n > 500 && Object.keys(la.h).length === 1 && la.h[0] === la.n,
     `rollback W=${WINDOW}: histogram ${JSON.stringify(la.h)} over ${la.n} frames; worst case (every remote frame mispredicts): `
     + `host ${A.E.H.rbStats.rollbacks} rollbacks / ${A.E.H.rbStats.resimFrames} re-sim frames in 10 s, max depth ${A.E.H.rbStats.maxDepth}`);
}

for (const latencyMs of [0, 50, 100]) {
  console.log(`\n--- rollback W=${WINDOW}, one-way latency ${latencyMs} ms, guest starts 40 ms late, ${SECONDS}s ---`);
  const R = runRoom({ latencyMs, rollback: WINDOW, guestRollback: 0 });
  const { E, con } = R;
  const H = E.H.report(), G = E.G.report();
  if (latencyMs === 50) ok('guest-adopts-the-hosts-window', E.G.rollback === WINDOW && E.G.delay === 0,
     `guest built with rollback=0 -> after lsgo rollback=${E.G.rollback}, delay=${E.G.delay}`);
  const lags = [...con.H.lag, ...con.G.lag];
  ok(`zero-local-input-lag@${latencyMs}ms`, lags.length > 1000 && lags.every((x) => x === 0),
     `AFTER: ${lags.filter((x) => x === 0).length}/${lags.length} frames ran the local pad on the frame it was sampled (0 frames)`);
  ok(`both-consoles-advance@${latencyMs}ms`, H.frame > SECONDS * 50 && G.frame > SECONDS * 50,
     `host ${H.frame} frames, guest ${G.frame} frames in ${SECONDS}s simulated`);
  ok(`never-faster-than-1.000x@${latencyMs}ms`, con.H.maxPerTick <= 1 && con.G.maxPerTick <= 1
       && H.frame <= Math.ceil(con.H.ticks) && G.frame <= Math.ceil(con.G.ticks),
     `max NEW frames per 60 Hz tick: host ${con.H.maxPerTick}, guest ${con.G.maxPerTick}; `
     + `frames/ticks host ${H.frame}/${con.H.ticks} guest ${G.frame}/${con.G.ticks}; re-simulated (not presented): host ${con.H.resim}, guest ${con.G.resim}`);
  const rbH = H.rollback, rbG = G.rollback;
  if (latencyMs > 0) ok(`rollbacks-happen-and-stay-in-the-window@${latencyMs}ms`,
     rbH.rollbacks > 0 && rbG.rollbacks > 0 && rbH.maxDepth <= WINDOW && rbG.maxDepth <= WINDOW,
     `host ${rbH.rollbacks} rollbacks / ${rbH.resimFrames} re-sim frames (mean depth ${rbH.meanDepth}, max ${rbH.maxDepth}); `
     + `guest ${rbG.rollbacks} / ${rbG.resimFrames} (mean ${rbG.meanDepth}, max ${rbG.maxDepth}); `
     + `re-sim frames/s host ${(rbH.resimFrames / SECONDS).toFixed(1)} guest ${(rbG.resimFrames / SECONDS).toFixed(1)}; `
     + `window stalls ${rbH.windowStalls}/${rbG.windowStalls}, advantage waits ${rbH.advantageWaits}/${rbG.advantageWaits}`);
  // At 0 ms the console that ticks FIRST in each 16.7 ms period still runs
  // frame F before the other has sampled F, so it predicts one frame and
  // corrects it when the other's pad changes: depth 1, never more. That is the
  // floor zero input delay costs, and it is invisible (one re-simulated frame).
  else ok('no-latency-means-depth-1-at-most', rbH.maxDepth <= 1 && rbG.maxDepth <= 1,
     `host ${rbH.rollbacks} rollbacks (max depth ${rbH.maxDepth}), guest ${rbG.rollbacks} (max depth ${rbG.maxDepth}) at 0 ms — the sampling phase between the two ticks`);
  // confirmed states vs a straight run of the true inputs
  let st = 0x811c9dc5, checked = 0, badH = 0, badG = 0;
  const upto = Math.min(E.H._rbConfirmed, E.G._rbConfirmed);
  const ref = new Map();
  for (let k = 0; k <= upto; k++) { st = step(st, R.truth(k), k); ref.set(k, st); }
  for (const [k, v] of con.H.stateAfter) if (ref.has(k)) { checked++; if (ref.get(k) !== v) badH++; }
  for (const [k, v] of con.G.stateAfter) if (ref.has(k)) { checked++; if (ref.get(k) !== v) badG++; }
  // and the FULL ring at the end: every confirmed frame still held must match
  let ringChecked = 0, ringBad = 0;
  for (const id of ['H', 'G']) for (const [k, v] of con[id].ring) if (k >= 1 && k - 1 <= upto && ref.has(k - 1)) { ringChecked++; if (ref.get(k - 1) !== v) ringBad++; }
  ok(`confirmed-states-equal-a-straight-run@${latencyMs}ms`, checked > 20 && badH === 0 && badG === 0 && ringBad === 0,
     `${checked} fingerprinted confirmed frames + ${ringChecked} ring states compared with a straight run of the true inputs: host ${badH} wrong, guest ${badG} wrong, ring ${ringBad} wrong`);
  ok(`fingerprints-agree-no-desync@${latencyMs}ms`, H.state !== 'desync' && G.state !== 'desync'
       && H.hashesCompared > 10 && G.hashesCompared > 10 && H.lastAgreedFrame > 0,
     `states ${H.state}/${G.state}; compared host ${H.hashesCompared} guest ${G.hashesCompared}; last agreed frame ${H.lastAgreedFrame}/${G.lastAgreedFrame}`);
  const early = [...con.H.submitted].filter((k) => k > E.H._rbConfirmed).length + [...con.G.submitted].filter((k) => k > E.G._rbConfirmed).length;
  ok(`only-confirmed-frames-are-fingerprinted@${latencyMs}ms`, early === 0,
     `${early} hashes submitted for frames past the confirmed frontier`);
}

// ---- ONE-FRAME EDGES ARE NEVER PREDICTED TO RECUR (opts.rbEdgeBytes) ------
// The same edge-carrying pads, with and without the page naming its edge byte: a prediction that
// repeats the last known input whole predicts every press to happen again on the next frame, so
// each remote press costs a second correction; zeroing the edge byte in the prediction removes it.
// Both arms must still end every confirmed frame in the state of a straight run of the true inputs.
{
  const res = {};
  for (const [name, eb] of [['whole', null], ['edge', [0]]]) {
    const R = runRoom({ latencyMs: 50, rollback: WINDOW, seconds: 20, edge: true, edgeBytes: eb });
    const H = R.E.H.report().rollback, G = R.E.G.report().rollback;
    let st = 0x811c9dc5, bad = 0, checked = 0;
    const upto = Math.min(R.E.H._rbConfirmed, R.E.G._rbConfirmed), ref = new Map();
    for (let k = 0; k <= upto; k++) { st = step(st, R.truth(k), k); ref.set(k, st); }
    for (const id of ['H', 'G']) for (const [k, v] of R.con[id].stateAfter) if (ref.has(k)) { checked++; if (ref.get(k) !== v) bad++; }
    res[name] = { rb: H.rollbacks + G.rollbacks, resim: H.resimFrames + G.resimFrames, bad, checked };
  }
  ok('edge-bytes-are-not-predicted-to-recur', res.edge.rb < res.whole.rb * 0.7 && res.edge.bad === 0 && res.whole.bad === 0 && res.edge.checked > 20,
     `20 s at 50 ms: ${res.whole.rb} corrections / ${res.whole.resim} re-simulated frames repeating the last input whole -> ${res.edge.rb} / ${res.edge.resim} with the edge byte zeroed in predictions; confirmed states vs a straight run: ${res.whole.bad}/${res.whole.checked} and ${res.edge.bad}/${res.edge.checked} wrong`);
}

// ---- a guest whose page CANNOT rewind: the host falls back to input delay --
{
  const R = runRoom({ latencyMs: 50, rollback: WINDOW, guestRollback: 0, noRewind: true, seconds: 10 });
  ok('a-page-that-cannot-rewind-gets-input-delay-not-rollback', R.E.H.rollback === 0 && R.E.G.rollback === 0 && R.E.H.delay >= 1,
     `host asked for rollback ${WINDOW}; guest declared no rollback: room rollback ${R.E.H.rollback}/${R.E.G.rollback}, delay ${R.E.H.delay}/${R.E.G.delay}`);
}

// ---- a DIVERGED core must still be caught (the detector is not dead) ------
{
  const R = runRoom({ latencyMs: 50, rollback: WINDOW, seconds: 3 });
  // corrupt the guest's core AFTER the fact: re-run a short room where the
  // guest's step differs from frame 120 on
  let now2 = 0; const msgs = [];
  const H = new L({ peerId: 'H', host: true, portCount: 2, padBytes: 2, hashEvery: 30, rollback: WINDOW, send: (m) => msgs.push(['G', m]), now: () => now2 });
  const G = new L({ peerId: 'G', host: false, portCount: 2, padBytes: 2, hashEvery: 30, rollback: 0, rollbackOk: true, send: (m) => msgs.push(['H', m]), now: () => now2 });
  H.seat('H', 1); H.seat('G', 1);
  const pump = () => { while (msgs.length) { const [to, m] = msgs.shift(); (to === 'H' ? H : G).receive(JSON.parse(JSON.stringify(m))); } };
  pump(); H.declareReady('d'); pump(); G.declareReady('d'); pump();
  const cs = { H: { st: 1, ring: new Map([[0, 1]]) }, G: { st: 1, ring: new Map([[0, 1]]) } };
  for (let i = 0; i < 400; i++) {
    for (const [id, ls] of [['H', H], ['G', G]]) {
      const c = cs[id]; const f = ls.frame; const pads = {}; for (const p of ls.localPorts) pads[p] = padFor(p, f);
      const r = ls.beginFrame(pads); if (!r.ready) continue;
      if (r.rollback) { c.st = c.ring.get(r.rollback.from); for (const fr of r.rollback.frames) { c.st = step(c.st, fr.image, fr.frame) ^ (id === 'G' && fr.frame >= 120 ? 1 : 0); c.ring.set(fr.frame + 1, c.st); } }
      c.st = step(c.st, r.image, r.frame) ^ (id === 'G' && r.frame >= 120 ? 1 : 0); c.ring.set(r.frame + 1, c.st);
      ls.endFrame(null);
      for (const k of ls.takeHashDue()) ls.submitHash(k, c.ring.get(k + 1));
      now2 += 16;
    }
    pump();
  }
  ok('a-diverged-core-is-still-caught', (H.state === 'desync' || G.state === 'desync') && H.desync && H.desync.frame === 120,
     `host state ${H.state}, desync at frame ${H.desync && H.desync.frame}, last agreed ${H.desync && H.desync.lastAgreedFrame}`);
  void R;
}

// ---- a peer that leaves: its port goes neutral from an agreed frame --------
{
  const R = runRoom({ latencyMs: 50, rollback: WINDOW, seconds: 6, dropGuestAtMs: 3000 });
  const H = R.E.H;
  const stalledAt = H.frame;
  const ports = H.dropPeer('G');
  // keep ticking the host alone
  let st = R.con.H.st; const c = R.con.H;
  let ran = 0;
  for (let i = 0; i < 120; i++) {
    const f = H.frame; const r = H.beginFrame({ 0: padFor(0, f) });
    if (!r.ready) continue;
    if (r.rollback) { st = c.ring.get(r.rollback.from); for (const fr of r.rollback.frames) { st = step(st, fr.image, fr.frame); c.ring.set(fr.frame + 1, st); } }
    st = step(st, r.image, r.frame); c.ring.set(r.frame + 1, st); H.endFrame(null); ran++;
    for (const k of H.takeHashDue()) H.submitHash(k, c.ring.get(k + 1));
  }
  ok('a-leaver-does-not-wedge-the-room', ports.length === 1 && ran > 100 && H.state !== 'failed',
     `dropped port ${ports} at frame ${H.dropped.get(1)} (host was at ${stalledAt}); host ran ${ran}/120 more frames; state ${H.state}`);
}

console.log(`\n[netplay-rollback] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

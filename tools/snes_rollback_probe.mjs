#!/usr/bin/env node
// snes_rollback_probe.mjs — IS SNES ROLLBACK EXACT? (Node, no browser.)
//
// Two REAL lib/netplay.js Lockstep engines (host + guest) speak the real wire
// protocol over a simulated link (one-way latency + jitter, ordered), each
// owning a REAL snes9x_2005 core (two separate wasm instances) driven by
// snes/snes_rollback.js — THE SAME FILE snes.html ships — exactly the way the
// page drives it: rollback frames through rb.runFrame(), delay frames of a
// capacity-gated room as plain runs + rb.onDelayFrame(), hidden catch-up frames
// from rbCatchUp(), credit scaled by rbPace(), 1.000x pacing at 60.0988 Hz.
//
// THE REFERENCE NEVER GUESSES. After the room, a THIRD core replays the TRUE
// inputs (the host's agreed table) through the same mode schedule the room
// ran (rollback stretches as canonical load->run->save steps, delay stretches
// as plain runs, the ring armed at the same frames) and fingerprints the state
// after every frame. Every fingerprint either console submitted for a
// CONFIRMED frame must equal the reference's for that frame.
//
// THE TEST HAS TEETH, TWICE:
//   * sensitivity: the reference re-run with port 1 held at 0 must disagree
//     with the true reference (the remote pad really reaches the guest state,
//     so a misprediction left uncorrected IS visible in a fingerprint);
//   * --broken: consoles whose rollbacks skip the re-simulation. MUST fail.
//
// CELLS (default all):  rb       50 ms one way, 25 ms jitter — rollback throughout
//                       switch   the guest's published step is forced to 16 ms
//                                from 6 s to 16 s: the capacity gate switches
//                                the room to input delay and (rbResume) back to
//                                rollback — at the SAME frames on both consoles
// 3 AND 4 PLAYERS (--players N): N real engines in the product's star (the host
// relays), portCount 4 as snes.html opens every room, and the SUPER MULTITAP
// plugged in on every console AND on the reference exactly when the room
// seats 3+ (setMultitap(1) before frame 0 — snes.html lsMultitapApply). The
// ROM is then tools/snes_multitap_rom.mjs (--rom mtap, the default for N >= 3):
// guest code that reads pads 1-3 off the auto-read registers and pads 4-5 by
// serial reads of $4017, so every port reaches the state only THROUGH the
// multitap. Extra teeth for N >= 3:
//   * sensitivity is checked for EVERY remote port, not just port 1;
//   * a reference run WITHOUT the multitap must disagree with the room
//     (the adaptor is really in the loop), and
//   * --broken-mt: the consoles leave the multitap OUT while the reference
//     plugs it in. MUST fail.
// USAGE  node tools/snes_rollback_probe.mjs [--cell rb,switch] [--secs 40] [--broken] [--json]
//                                           [--players 2|3|4] [--ports 2|4] [--rom simcity|mtap] [--broken-mt]
// No browser, so tools/probe_lock.sh is not required; it is harmless to hold it.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname;
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(fs.readFileSync(ROOT + 'lib/netplay.js', 'utf8'))();
const L = globalThis.Netplay.Lockstep;
// Session._relay's set (lib/netplay.js RELAYED): the frame traffic a host forwards.
const RELAYED = globalThis.Netplay.RELAYED || { ls: 1, lsh: 1, lsd: 1, lsping: 1, lspong: 1, lspace: 1, lsnak: 1 };
const SnesRollback = require(ROOT + 'snes/snes_rollback.js');
const { buildMultitapRom } = await import(ROOT + 'tools/snes_multitap_rom.mjs');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const SECS = +flag('secs', '40');
const BROKEN = argv.includes('--broken');
const CELLS = flag('cell', 'rb,switch').split(',');
const PLAYERS = Math.max(2, Math.min(4, +flag('players', '2') | 0));
const PORTS = +flag('ports', PLAYERS > 2 ? '4' : '2') | 0;
const ROMSEL = flag('rom', PLAYERS > 2 ? 'mtap' : 'simcity');
const BROKEN_MT = argv.includes('--broken-mt');
// THE RULE snes.html applies (lsMultitapApply): plugged in iff the room seats 3+.
const MULTITAP = PLAYERS >= 3;
const IDS = ['H', 'G', 'G2', 'G3'].slice(0, PLAYERS);
const HZ = 60.0988, FRAME_MS = 1000 / HZ, TICK = 1000 / 60, W = 8;
// SNES_CORE=<dir/> runs a core built elsewhere (a scratch build before it is installed).
const CORE = (process.env.SNES_CORE || ROOT + 'snes/snesWasm/') + 'snes9x_2005.';
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const before = { js: md5(CORE + 'js'), wasm: md5(CORE + 'wasm'), lib: md5(ROOT + 'lib/netplay.js'), rb: md5(ROOT + 'snes/snes_rollback.js') };
const ROM = ROMSEL === 'mtap' ? buildMultitapRom() : fs.readFileSync(ROOT + 'snes/snesWasm/roms/simcity.smc');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

// A fresh wasm instance per call: the emscripten glue keeps its Module in
// module scope, so dropping the require-cache entry instantiates a new one.
async function bootCore(mt = false) {
  const p = require.resolve(CORE + 'js');
  delete require.cache[p];
  const M = require(p);
  await new Promise((res) => { M.onRuntimeInitialized = res; });
  const ptr = M._my_malloc(ROM.length);
  M.HEAPU8.set(ROM, ptr);
  M._startWithRom(ptr, ROM.length, 36000);
  if (mt) { if (M._setMultitap(1) !== 1) throw new Error('the core refused the multitap'); }
  return M;
}
const keepAlive = setInterval(() => {}, 1 << 30);

// Scripted pads: each port changes on its own cadence, every SNES button in play
// (bits 4..15), so SimCity's menus and cursor answer to BOTH players.
const padFor = (port, f) => {
  const seg = Math.floor((f + port * 5) / (port ? 9 : 13));
  let h = Math.imul(seg + 1, 2654435761) ^ Math.imul(port + 7, 40503);
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  const m = (h & 0xfff0) & (seg % 3 === 0 ? 0 : 0xffff);   // a third of segments: hands off
  return new Uint8Array([m & 0xff, (m >> 8) & 0xff]);
};

function fnvBlob(M, ptr, size) {
  let h = 0x811c9dc5;
  const u32 = new Uint32Array(M.HEAPU8.buffer, ptr, size >>> 2);
  for (let i = 0; i < u32.length; i++) { h ^= u32[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

async function runRoom({ latencyMs = 50, jitterMs = 25, secs = SECS, slow = null }) {
  let now = 0;
  const q = [], lastAt = {};
  for (const id of IDS) lastAt[id] = 0;
  let seed = 777; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const send = (to) => (m) => {
    let at = now + latencyMs + rnd() * jitterMs;
    if (at < lastAt[to]) at = lastAt[to];
    lastAt[to] = at;
    q.push({ at, to, msg: JSON.parse(JSON.stringify(m)) });
  };
  // THE PRODUCT'S STAR: the host sends to every guest, a guest to the host only
  // (the host relays). With two players this is exactly the old pair.
  // With 3+ players every message carries its sender (as the pace sim's does),
  // and deliver() forwards a guest's frame traffic to the other guests the way
  // Session._relay does — through Lockstep.filterRelay.
  const tag = (id, m) => PLAYERS > 2 ? Object.assign({ peer: id }, m) : m;
  const sendFrom = (id) => (id === 'H')
    ? (m) => { for (const o of IDS) if (o !== 'H') send(o)(tag(id, m)); }
    : (m) => send('H')(tag(id, m));
  const mk = (id, host) => new L({ peerId: id, host, portCount: PORTS, padBytes: 2, hashEvery: 4, rollback: W, rollbackOk: true,
                                   rbCatchUp: true, rbResume: true, frameHz: HZ, send: sendFrom(id), now: () => now });
  const E = {};
  for (const id of IDS) E[id] = mk(id, id === 'H');
  for (const id of IDS) E.H.seat(id, 1);
  const con = {};
  for (const id of IDS) {
    const M = await bootCore(MULTITAP && !BROKEN_MT);
    const size = M._getStateSaveSize() >>> 0;
    con[id] = { M, size, scratch: M._my_malloc(size), rb: SnesRollback.create(M, { frameHz: HZ, broken: BROKEN }),
                accum: 0, declared: false, ran: 0, hiddenRan: 0, maxPerTick: 0, ticks: 0, stateAfter: new Map(),
                lag: [], sampled: new Map(), desync: null, faults: [] };
  }
  E.H.on && 0;
  const deliver = () => {
    q.sort((a, b) => a.at - b.at);
    while (q.length && q[0].at <= now) {
      const d = q.shift(); E[d.to].receive(d.msg);
      const m = d.msg;
      if (PLAYERS > 2 && d.to === 'H' && RELAYED[m.t] && m.peer && m.peer !== 'H') {
        const fwd = typeof E.H.filterRelay === 'function' ? E.H.filterRelay(m) : m;
        if (fwd) for (const o of IDS) if (o !== 'H' && o !== m.peer) send(o)(fwd);
        q.sort((a, b) => a.at - b.at);
      }
    }
  };
  // ONE FRAME, as snes.html lsRunFrame runs it.
  const frame = (id, hidden) => {
    const ls = E[id], c = con[id], M = c.M;
    const f = ls.frame;
    const pads = {};
    for (const p of ls.localPorts) { pads[p] = padFor(p, f); if (!c.sampled.has(p + ':' + f)) c.sampled.set(p + ':' + f, pads[p]); }
    if (ls.rollback && c.rb.RB.slots && typeof ls.rbRingFrames === 'function' && c.rb.RB.n < ls.rbRingFrames()) c.rb.grow(ls.rbRingFrames());
    const r = ls.beginFrame(pads, hidden ? { hidden: true } : undefined);
    if (!r || !r.ready) return false;
    const hid = !!(hidden || r.hidden);
    if (ls.rollback) {
      if (!c.rb.runFrame(ls, r, hid)) { c.faults.push(c.rb.RB.fault); return false; }
      for (const k of [...c.stateAfter.keys()]) if (k > ls.frame + 64) c.stateAfter.delete(k);
    } else {
      const pb = ls.padBytes | 0;
      for (let p = 0; p < ls.portCount; p++) M._setJoypadInputPort(p, (r.image[p * pb] | (r.image[p * pb + 1] << 8)) & 0xffff);
      const w0 = hid ? M._audioWpos() : -1;
      const t0 = performance.now();
      M._mainLoop();
      const runMs = performance.now() - t0;
      if (hid) M._audioRewind(w0);
      c.rb.onDelayFrame(ls, runMs);
      let h = null;
      const want = typeof ls.wantsHash === 'function' ? ls.wantsHash(r.frame) : (ls.hashEvery > 0 && r.frame % ls.hashEvery === 0);
      if (want && M._saveStateInto(c.scratch, c.size)) { h = fnvBlob(M, c.scratch, c.size); c.stateAfter.set(r.frame, h); }
      ls.endFrame(h);
    }
    // local input lag: the frame's image carries, at the local port, the pad
    // sampled for frame F - d
    for (const p of ls.localPorts) {
      const got = r.image.subarray(p * 2, p * 2 + 2);
      let d = null;
      for (let back = 0; back <= 32 && d == null; back++) { const w = c.sampled.get(p + ':' + (r.frame - back)); if (w && w[0] === got[0] && w[1] === got[1]) d = back; }
      c.lag.push({ d, rb: !!ls.rollback, f: r.frame });
    }
    if (hid) c.hiddenRan++; else c.ran++;
    return true;
  };
  // the rollback consoles' fingerprints go through submitHash; capture them
  for (const id of IDS) {
    const ls = E[id], orig = ls.submitHash.bind(ls);
    ls.submitHash = (k, h) => { con[id].stateAfter.set(k, h); return orig(k, h); };
    const of = ls.fail.bind(ls);
    ls.fail = (why) => { con[id].faults.push(String(why)); return of(why); };
  }
  const tickOf = { H: 0, G: 37, G2: 11, G3: 23 };
  const endMs = secs * 1000;
  while (true) {
    let id = IDS[0]; for (const k of IDS) if (tickOf[k] < tickOf[id]) id = k;
    now = tickOf[id];
    if (now >= endMs) break;
    deliver();
    const ls = E[id], c = con[id];
    if (!c.declared && ls.localPorts.length) { c.declared = true; ls.declareReady('SimCity:' + ROM.length); }
    c.ticks++;
    if (ls.state === 'running' || ls.state === 'stalled') {
      c.accum += TICK * ((ls.rollback && typeof ls.rbPace === 'function') ? ls.rbPace() : 1);
      const cu = typeof ls.rbCatchUp === 'function' ? ls.rbCatchUp() : 0;
      for (let i = 0; i < cu; i++) if (!frame(id, true)) break;
      let ran = 0;
      while (c.accum >= FRAME_MS && ran < 4) { if (!frame(id, false)) break; c.accum -= FRAME_MS; ran++; }
      if (c.accum > FRAME_MS) c.accum = FRAME_MS;
      if (ran > c.maxPerTick) c.maxPerTick = ran;
      // the forced slow console: what it PUBLISHES (the capacity gate's input)
      if (slow && id === slow.id && now >= slow.fromMs && now < slow.toMs) ls.selfStepMs = slow.stepMs;
    }
    tickOf[id] += TICK;
  }
  return { E, con, endMs };
}

// The never-guessing reference: the true inputs, the room's mode schedule.
async function reference(E, upTo, { zeroPort = -1, mt = MULTITAP } = {}) {
  const M = await bootCore(mt);
  const rb = SnesRollback.create(M, { frameHz: HZ });
  const size = M._getStateSaveSize() >>> 0, scratch = M._my_malloc(size);
  // mode at frame k: the switches the host applied (modeHistory), from the room's start mode
  const hist = (E.H.modeHistory || []).map((m) => ({ frame: m.frame, rb: m.to !== 'delay' })).sort((a, b) => a.frame - b.frame);
  const startRb = hist.length ? !hist[0].rb : !!E.H.rollback;
  const rbAt = (k) => { let m = startRb; for (const h of hist) if (k >= h.frame) m = h.rb; return m; };
  const out = new Map();
  let armedStale = true;
  const fakeLs = { padBytes: 2, portCount: PORTS, rollback: W, rbRingFrames: () => W + 4 };
  for (let k = 0; k <= upTo; k++) {
    const im = new Uint8Array(2 * PORTS);
    for (let p = 0; p < PORTS; p++) {
      if (E.H.roster[p] == null) continue;                 // an unseated port: no controller, all zero
      const b = E.H._inputFor(k, p); if (!b) return { out, stoppedAt: k }; if (p !== zeroPort) im.set(b.subarray(0, 2), p * 2);
    }
    if (rbAt(k)) {
      if (armedStale) { if (!rb.arm(fakeLs, k)) throw new Error('reference arm: ' + rb.RB.fault); armedStale = false; }
      if (!rb.step(k, im, 2, PORTS)) throw new Error('reference step ' + k + ': ' + rb.RB.fault);
      out.set(k, rb.hashAt(rb.slot(k + 1)));
    } else {
      armedStale = true;
      for (let p = 0; p < PORTS; p++) M._setJoypadInputPort(p, im[p * 2] | (im[p * 2 + 1] << 8));
      M._mainLoop();
      M._saveStateInto(scratch, size);
      out.set(k, fnvBlob(M, scratch, size));
    }
  }
  return { out, stoppedAt: upTo + 1 };
}

const results = {};
for (const cell of CELLS) {
  console.log(`\n--- cell ${cell}${BROKEN ? ' (BROKEN CONTROL: rollbacks skip the re-simulation)' : ''}${BROKEN_MT ? ' (BROKEN CONTROL: consoles without the multitap)' : ''}, ${SECS}s simulated, ${PLAYERS} players, ${PORTS} ports, multitap ${MULTITAP ? 'IN' : 'out'}, rom ${ROMSEL} ---`);
  const t0 = performance.now();
  const R = await runRoom(cell === 'switch' ? { slow: { id: 'G', fromMs: 6000, toMs: 16000, stepMs: 16 } } : {});
  const { E, con } = R;
  const H = E.H.report(), G = E.G.report();
  const confirmed = Math.min(E.H._rbConfirmed != null ? E.H._rbConfirmed : H.frame, E.G._rbConfirmed != null ? E.G._rbConfirmed : G.frame, H.frame, G.frame) - 1;
  const REP = {}; for (const id of IDS) REP[id] = E[id].report();
  const maxF = Math.max(...IDS.map((id) => REP[id].frame));
  const ref = await reference(E, maxF);
  const refZ = await reference(E, maxF, { zeroPort: 1 });
  let compared = 0, mism = 0, firstBad = null;
  for (const id of IDS) for (const [k, h] of con[id].stateAfter) {
    if (!ref.out.has(k)) continue;
    compared++;
    if (ref.out.get(k) !== h) { mism++; if (firstBad == null || k < firstBad.k) firstBad = { id, k }; }
  }
  let sens = 0; for (const [k, h] of ref.out) if (refZ.out.has(k) && refZ.out.get(k) !== h) sens++;
  // N >= 3: every remote port, and the multitap itself, must reach the state.
  const sensBy = { 1: sens };
  let noMtDiff = null;
  if (PLAYERS > 2) {
    for (let zp = 2; zp < PLAYERS; zp++) {
      const rz = await reference(E, maxF, { zeroPort: zp });
      let n = 0; for (const [k, h] of ref.out) if (rz.out.has(k) && rz.out.get(k) !== h) n++;
      sensBy[zp] = n;
    }
    const rn = await reference(E, maxF, { mt: false });
    noMtDiff = 0; for (const [k, h] of ref.out) if (rn.out.has(k) && rn.out.get(k) !== h) noMtDiff++;
  }
  const rH = con.H.rb.report(), rG = con.G.rb.report();
  const modes = { H: (E.H.modeHistory || []).map((m) => m.to + '@' + m.frame), G: (E.G.modeHistory || []).map((m) => m.to + '@' + m.frame) };
  // A SWITCH HAS A HAND-OVER, by the engine's design (lib/netplay.js, the block
  // above _capDecide): from the moment a console knows of a switch to delay its
  // own pad goes `d` frames ahead (so frame S-1 runs on real inputs only), and
  // after a return to rollback the pads queued in delay drain first. Those
  // frames are counted apart; every other rollback frame must read 0.
  const sw = (E.H.modeHistory || []).map((m) => ({ f: m.frame, to: m.to, d: m.delay | 0 }));
  const handover = (f) => sw.some((m) => m.to === 'delay' ? (f >= m.f - (W + 8 + m.d + 6) && f < m.f) : (f >= m.f && f <= m.f + 30 + 2));
  const lagAll = IDS.flatMap((id) => con[id].lag).filter((x) => x.rb && x.d != null);
  const lagRb = lagAll.filter((x) => !handover(x.f));
  const lagHand = lagAll.filter((x) => handover(x.f));
  { const bad = lagRb.filter((x) => x.d !== 0); if (bad.length) console.log('  nonzero-lag rollback frames: ' + JSON.stringify(bad.slice(0, 40).map((x) => x.f + ':' + x.d))); }
  const desync = IDS.reduce((n, id) => n + (REP[id].desync ? 1 : 0), 0);
  results[cell] = { frames: { H: H.frame, G: G.frame }, compared, mismatched: mism, firstBad, sensitivity: sens, modes,
                    rb: { H: rH, G: rG }, faults: { H: con.H.faults, G: con.G.faults }, state: { H: H.state, G: G.state },
                    hashesCompared: { H: H.hashesCompared, G: G.hashesCompared }, wallMs: Math.round(performance.now() - t0) };
  ok(`${cell}: ${PLAYERS > 2 ? 'every console advances' : 'both consoles advance'}`, IDS.every((id) => REP[id].frame > SECS * 50), IDS.map((id) => `${id} ${REP[id].frame}`).join(', ') + ` frames in ${SECS}s (state ${IDS.map((id) => REP[id].state).join('/')})`);
  ok(`${cell}: the remote pad reaches the guest state (sensitivity)`, sens > 10, `${sens} reference frames differ when port 1 is held at 0`);
  if (PLAYERS > 2) {
    ok(`${cell}: EVERY remote port reaches the guest state (sensitivity, ports 1..${PLAYERS - 1})`, Object.values(sensBy).every((n) => n > 10),
       Object.entries(sensBy).map(([p, n]) => `port ${p}: ${n}`).join(', ') + ' reference frames differ when that port is held at 0');
    ok(`${cell}: the multitap is in the loop (a reference without it disagrees)`, noMtDiff > 10, `${noMtDiff} reference frames differ with the multitap pulled out`);
  }
  ok(`${cell}: rollbacks happen`, IDS.every((id) => con[id].rb.report().rollbacks > 0), `host ${rH.rollbacks} rollbacks / ${rH.resimFrames} re-simulated (max depth ${rH.maxDepth}); guest ${rG.rollbacks} / ${rG.resimFrames} (max ${rG.maxDepth})`);
  ok(`${cell}: every confirmed fingerprint equals the never-guessing core`, compared > 500 && mism === 0,
     `${compared - mism}/${compared} equal` + (firstBad ? `; first mismatch ${firstBad.id} frame ${firstBad.k}` : ''));
  ok(`${cell}: zero local input lag in rollback`, lagRb.length > 500 && lagRb.every((x) => x.d === 0),
     `${lagRb.filter((x) => x.d === 0).length}/${lagRb.length} rollback frames ran the local pad on the frame it was sampled` + (lagHand.length ? `; switch hand-over frames (counted apart): ${lagHand.length}, max lag ${Math.max(...lagHand.map((x) => x.d))}` : ''));
  ok(`${cell}: never faster than 1.000x`, IDS.every((id) => con[id].maxPerTick <= 2 && REP[id].frame <= SECS * HZ + 2),
     `frames ${H.frame}/${G.frame} vs ${(SECS * HZ).toFixed(0)} at 1.000x; max new frames per tick ${con.H.maxPerTick}/${con.G.maxPerTick}; hidden ${con.H.hiddenRan}/${con.G.hiddenRan}`);
  // lib/netplay.js ownClock(): how far past ITS OWN wall clock (since its first frame attempt)
  // each console ever began a frame — a hidden catch-up frame is only honest for a console that
  // is behind real time, never for one merely behind its peer (the 2-console leapfrog).
  const oc = {}; for (const id of IDS) oc[id] = REP[id].ownClock;
  ok(`${cell}: never past its own wall clock`, IDS.every((id) => oc[id] && oc[id].leadMax < 2 && oc[id].lead < 2),
     `own-clock lead max/end host ${oc.H && oc.H.leadMax}/${oc.H && oc.H.lead} guest ${oc.G && oc.G.leadMax}/${oc.G && oc.G.lead}; rate ${oc.H && oc.H.rate}/${oc.G && oc.G.rate}; catch-up granted ${oc.H && oc.H.granted}/${oc.G && oc.G.granted}, refused ${oc.H && oc.H.refused}/${oc.G && oc.G.refused}`);
  ok(`${cell}: no fault, no desync`, IDS.every((id) => !con[id].faults.length && REP[id].state !== 'failed') && !desync,
     `faults ${JSON.stringify(IDS.map((id) => con[id].faults))} desync ${desync}`);
  if (cell === 'switch') {
    ok('switch: delay and back to rollback, at the SAME frames on both', modes.H.length >= 2 && modes.H[0].startsWith('delay') && modes.H.some((m) => m.startsWith('rollback'))
       && IDS.every((id) => JSON.stringify((E[id].modeHistory || []).map((m) => m.to + '@' + m.frame)) === JSON.stringify(modes.H)), `host ${JSON.stringify(modes.H)} guest ${JSON.stringify(modes.G)}`);
    ok('switch: the ring re-armed on the return (rbResume)', rH.rearms >= 1 && rG.rearms >= 1 && rH.delaySteps > 0, `re-arms ${rH.rearms}/${rG.rearms}, delay frames estimated ${rH.delaySteps}/${rG.delaySteps}, save re-timed ${rH.remeasures}/${rG.remeasures}`);
    ok('switch: the room ends in rollback', !!E.H.rollback && !!E.G.rollback && E.H.delay === 0 || (!!E.H.rollback && !!E.G.rollback), `host rollback=${E.H.rollback} delay=${E.H.delay}`);
  }
  console.log('  steps: host ' + JSON.stringify({ stepMs: rH.stepMs, ioMs: rH.ioMs, runMs: rH.runMs }) + ' guest ' + JSON.stringify({ stepMs: rG.stepMs, ioMs: rG.ioMs, runMs: rG.runMs }));
}
clearInterval(keepAlive);
const after = { js: md5(CORE + 'js'), wasm: md5(CORE + 'wasm'), lib: md5(ROOT + 'lib/netplay.js'), rb: md5(ROOT + 'snes/snes_rollback.js') };
const load = os.loadavg().map((x) => +x.toFixed(2));
if (argv.includes('--json')) console.log(JSON.stringify({ results, md5Before: before, md5After: after, load }, null, 1));
console.log(`\n${pass} passed, ${fail} failed${BROKEN ? ' — BROKEN CONTROL: this run MUST fail' : ''}; md5 wasm ${before.wasm}${before.wasm === after.wasm ? '' : ' -> ' + after.wasm} js ${before.js}; load ${load.join(' ')}`);
process.exit(fail ? 1 : 0);

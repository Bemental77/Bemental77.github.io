#!/usr/bin/env node
// genesis_rollback_probe.mjs — IS GENESIS ROLLBACK EXACT WITH 2, 3 AND 4 PLAYERS?
// (Node, no browser.) The snes_rollback_probe.mjs pattern, for genesis.html.
//
// THE CODE UNDER TEST IS THE CODE THAT SHIPS. genesis.html keeps its console
// half of rollback inline (rbInit / rbGrow / rbStep / rbHash / rbRunFrame) and
// its multitap rule (genMultitapPlan). This probe CUTS THOSE BLOCKS OUT OF
// genesis.html and runs them, verbatim, against a real Genesis-Plus-GX wasm per
// console — so a change to the page is a change to what is proven.
//
// N real lib/netplay.js Lockstep engines in the product's star (the host relays
// guest frame traffic, as Session._relay does), 50 ms one way + 25 ms jitter,
// rollback with hidden catch-up frames and rbPace(), 1.000x pacing. Every
// console boots the same ROM, and with 3+ seated plugs in the multitap
// genMultitapPlan chooses (or --kind) before frame 0, as lsMultitapApply does.
//
// THE REFERENCE NEVER GUESSES: a further core replays the host's agreed input
// table through the same extracted rbStep and fingerprints (rbHash) the state
// after every frame. Every fingerprint a console submitted for a CONFIRMED
// frame must equal the reference's.
//
// TEETH:
//   * sensitivity, per remote port: the reference re-run with that port held at
//     0 must disagree (each pad really reaches the guest state);
//   * 3+ players: a reference with NO multitap must disagree (the adaptor is in
//     the loop);
//   * --broken: consoles whose rollbacks skip re-simulation. MUST fail.
//   * --broken-mt: consoles without the multitap, reference with it. MUST fail.
//
// ROMS: --rom mtap (default for 3+): tools/genesis_multitap_rom.mjs — reads all
// four pads through BOTH adaptors, continuously (so also in the part of a frame
// before osd_input_update, the window patch_input_state.py covers). Its header
// says "J4", so genMultitapPlan picks a Team Player in port A; --kind 1 forces
// EA 4-Way Play. --rom sonic3 / xmen: the shipped carts (2 players).
//
// USAGE  node tools/genesis_rollback_probe.mjs [--players 2|3|4] [--secs 30] [--rom mtap|sonic3|xmen] [--quiet N]
//                                              [--kind 1|2|3] [--broken] [--broken-mt] [--json]
// GEN_CORE=<dir/> runs a core built elsewhere (a scratch build before it is installed).
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
const ROOT = new URL('..', import.meta.url).pathname;
globalThis.window = globalThis; globalThis.self = globalThis;
new Function(fs.readFileSync(ROOT + 'lib/netplay.js', 'utf8'))();
const L = globalThis.Netplay.Lockstep;
const RELAYED = globalThis.Netplay.RELAYED || { ls: 1, lsh: 1, lsd: 1, lsping: 1, lspong: 1, lspace: 1, lsnak: 1 };
const { buildGenesisMultitapRom, ramByte } = await import(ROOT + 'tools/genesis_multitap_rom.mjs');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const PLAYERS = Math.max(2, Math.min(4, +flag('players', '2') | 0));
const SECS = +flag('secs', '30');
const ROMSEL = flag('rom', PLAYERS > 2 ? 'mtap' : 'sonic3');
const BROKEN = argv.includes('--broken');
const BROKEN_MT = argv.includes('--broken-mt');
const KIND_FORCE = flag('kind', null);
// --quiet N: every pad held at 0 for frames < N. KNOWN, PRE-EXISTING (shipped
// core 66b69161 too, 2026-10-07): on Sonic 3 a rollback whose re-simulated
// frames fall in the first ~15 frames after power-on is NOT faithful (a
// straight run and a run rolled back from 15 to 5 differ in ~28 work-RAM bytes
// from frame 12, 68k $FFFDB8 onward); from frame 300 on, the same experiment
// is byte-identical. --quiet 60 keeps the 2-player Sonic 3 regression cell
// clear of that boot window; X-Men has no such window.
const QUIET = +flag('quiet', '0') | 0;
const PORTS = 4;                            // genesis.html GEN_PORTS
const W = 8, TICK = 1000 / 60;
const IDS = ['H', 'G', 'G2', 'G3'].slice(0, PLAYERS);
const CORE = process.env.GEN_CORE || ROOT + 'genesis/genesisWasm/dist/';
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const before = { wasm: md5(CORE + 'genesis_plus_gx.wasm'), js: md5(CORE + 'genesis_plus_gx.js'), page: md5(ROOT + 'genesis.html'), lib: md5(ROOT + 'lib/netplay.js') };
const ROMFILE = { sonic3: 'Sonic the Hedgehog 3 (USA).gen', xmen: 'X-Men (U).gen' };
const ROM = ROMSEL === 'mtap' ? buildGenesisMultitapRom() : new Uint8Array(fs.readFileSync(ROOT + 'genesis/genesisWasm/roms/' + ROMFILE[ROMSEL]));

// ── the shipped code, cut out of genesis.html ──
const PAGE = fs.readFileSync(ROOT + 'genesis.html', 'utf8');
const cut = (from, to) => { const a = PAGE.indexOf(from), b = PAGE.indexOf(to, a); if (a < 0 || b < 0) throw new Error('genesis.html: cannot find ' + JSON.stringify(from)); return PAGE.slice(a, b); };
const RB_SRC = cut('  var RB = {\n', '  // ---- LOCAL INPUT LATENCY');
const PLAN_SRC = cut('  var GEN_MT_GAMES = ', '  var NET = {');
const genMultitapPlan = new Function(PLAN_SRC + '\nreturn genMultitapPlan;')();
// rbRunFrame's world: Module, LS, the frame counters, the latency witness (a no-op here).
function pageRollback(Module, hz) {
  const LS = { fault: null, frames: 0, hashes: 0 };
  const win = { __genFrames: 0, __genLsImage: null };
  const f = new Function('Module', 'LS', 'window', 'HW_HZ', 'pageLog', 'latWitness',
    'var guestFrames = 0;\n' + RB_SRC + '\nreturn { RB: RB, rbInit: rbInit, rbGrow: rbGrow, rbStep: rbStep, rbSlot: rbSlot, rbHash: rbHash, rbRunFrame: rbRunFrame, rbFree: rbFree };');
  const api = f(Module, LS, win, hz, () => {}, () => {});
  api.LS = LS;
  return api;
}

async function bootCore() {
  const js = fs.readFileSync(CORE + 'genesis_plus_gx.js', 'utf8');
  const M = { wasmBinary: fs.readFileSync(CORE + 'genesis_plus_gx.wasm'), print: () => {}, printErr: () => {} };
  const ready = new Promise((r) => { M.onRuntimeInitialized = r; });
  new Function('Module', js + '\n;return Module;')(M);
  await ready;
  M._gpx_init();
  const p = M._gpx_alloc(ROM.length); M.HEAPU8.set(ROM, p);
  const str = (s) => { const q = M._gpx_alloc(s.length + 1); M.HEAPU8.set(Buffer.from(s + '\0'), q); return q; };
  if (!M._gpx_load(p, ROM.length, str('game'), str('gen'))) throw new Error('gpx_load refused the ROM');
  M._gpx_free(p);
  return M;
}
// THE PAGE'S DECISION (or --kind), before frame 0 — as lsMultitapApply.
function plugFor(seated) {
  const plan = genMultitapPlan(ROM, seated);
  if (KIND_FORCE != null && seated >= 3) plan.kind = +KIND_FORCE | 0;
  return plan;
}
function plug(M, plan) {
  if (!plan.kind) return 0;
  const got = M._gpx_set_multitap(plan.kind, plan.six) | 0;
  if (got !== plan.kind) throw new Error('the core refused multitap kind ' + plan.kind);
  return got;
}

const keepAlive = setInterval(() => {}, 1 << 30);
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };

// Scripted pads: each port changes on its own cadence over the 12 libretro bits.
const padFor = (port, f) => {
  if (f < QUIET) return new Uint8Array(2);
  const seg = Math.floor((f + port * 5) / (7 + port * 2));
  let h = Math.imul(seg + 1, 2654435761) ^ Math.imul(port + 7, 40503);
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  const m = (h & 0x0fff) & (seg % 3 === 0 ? 0 : 0xffff);
  return new Uint8Array([m & 0xff, (m >> 8) & 0xff]);
};

async function runRoom({ latencyMs = 50, jitterMs = 25, secs = SECS } = {}) {
  let now = 0;
  const q = [], lastAt = {}; for (const id of IDS) lastAt[id] = 0;
  let seed = 777; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const send = (to) => (m) => {
    let at = now + latencyMs + rnd() * jitterMs;
    if (at < lastAt[to]) at = lastAt[to];
    lastAt[to] = at;
    q.push({ at, to, msg: JSON.parse(JSON.stringify(m)) });
  };
  const tag = (id, m) => Object.assign({ peer: id }, m);
  const sendFrom = (id) => (id === 'H') ? (m) => { for (const o of IDS) if (o !== 'H') send(o)(tag(id, m)); } : (m) => send('H')(tag(id, m));
  const con = {}, E = {};
  for (const id of IDS) {
    const M = await bootCore();
    const hz = M._gpx_fps() || 59.922751;
    E[id] = new L({ peerId: id, host: id === 'H', portCount: PORTS, padBytes: 2, hashEvery: 4, rollback: W, rollbackOk: true,
                    rbCatchUp: true, frameHz: hz, send: sendFrom(id), now: () => now });
    con[id] = { M, hz, frameMs: 1000 / hz, pr: pageRollback(M, hz), accum: 0, declared: false, ran: 0, hiddenRan: 0, maxPerTick: 0,
                stateAfter: new Map(), sampled: new Map(), lag: [], faults: [], plugged: null };
  }
  for (const id of IDS) E.H.seat(id, 1);
  for (const id of IDS) {
    const ls = E[id];
    const sh = ls.submitHash.bind(ls);
    ls.submitHash = (k, h) => { con[id].stateAfter.set(k, h); return sh(k, h); };
    const of = ls.fail.bind(ls);
    ls.fail = (why) => { con[id].faults.push(String(why)); return of(why); };
  }
  const deliver = () => {
    q.sort((a, b) => a.at - b.at);
    while (q.length && q[0].at <= now) {
      const d = q.shift(); E[d.to].receive(d.msg);
      const m = d.msg;
      if (d.to === 'H' && RELAYED[m.t] && m.peer && m.peer !== 'H') {
        const fwd = typeof E.H.filterRelay === 'function' ? E.H.filterRelay(m) : m;
        if (fwd) for (const o of IDS) if (o !== 'H' && o !== m.peer) send(o)(fwd);
        q.sort((a, b) => a.at - b.at);
      }
    }
  };
  // ONE FRAME, as genesis.html lsRunFrame runs it (rollback room).
  const frame = (id, hidden) => {
    const ls = E[id], c = con[id], R = c.pr;
    if (c.plugged == null) {                    // lsMultitapApply, before frame 0
      let seated = 0; for (let p = 0; p < ls.portCount; p++) if (ls.roster[p] != null) seated++;
      c.plugged = BROKEN_MT ? 0 : plug(c.M, plugFor(seated));
    }
    if (ls.rollback && R.RB.slots && typeof ls.rbRingFrames === 'function' && R.RB.n < ls.rbRingFrames()) {
      if (!R.rbGrow(ls.rbRingFrames())) { c.faults.push('grow: ' + R.RB.fault); return false; }
    }
    const f = ls.frame, pads = {};
    for (const p of ls.localPorts) { pads[p] = padFor(p, f); if (!c.sampled.has(p + ':' + f)) c.sampled.set(p + ':' + f, pads[p]); }
    const r = ls.beginFrame(pads, hidden ? { hidden: true } : undefined);
    if (!r || !r.ready) return false;
    if (!ls.rollback) { c.faults.push('the room left rollback (this probe runs rollback rooms only)'); return false; }
    let rr = r;
    if (BROKEN && r.rollback) rr = Object.assign({}, r, { rollback: null });   // skip the re-simulation
    if (!R.rbRunFrame(ls, rr, hidden)) { c.faults.push(R.LS.fault || R.RB.fault || 'rbRunFrame'); return false; }
    for (const p of ls.localPorts) {
      const got = r.image.subarray(p * 2, p * 2 + 2);
      let d = null;
      for (let back = 0; back <= 32 && d == null; back++) { const w = c.sampled.get(p + ':' + (r.frame - back)); if (w && w[0] === got[0] && w[1] === got[1]) d = back; }
      c.lag.push(d);
    }
    if (hidden) c.hiddenRan++; else c.ran++;
    return true;
  };
  const tickOf = { H: 0, G: 37, G2: 11, G3: 23 };
  const endMs = secs * 1000;
  while (true) {
    let id = IDS[0]; for (const k of IDS) if (tickOf[k] < tickOf[id]) id = k;
    now = tickOf[id];
    if (now >= endMs) break;
    deliver();
    const ls = E[id], c = con[id];
    if (!c.declared && ls.localPorts.length) { c.declared = true; ls.declareReady('mt:' + ROM.length); }
    if (ls.state === 'running' || ls.state === 'stalled') {
      c.accum += TICK * ((ls.rollback && typeof ls.rbPace === 'function') ? ls.rbPace() : 1);
      const cu = typeof ls.rbCatchUp === 'function' ? ls.rbCatchUp() : 0;
      for (let i = 0; i < cu; i++) if (!frame(id, true)) break;
      let ran = 0;
      while (c.accum >= c.frameMs && ran < 4) { if (!frame(id, false)) break; c.accum -= c.frameMs; ran++; }
      if (c.accum > c.frameMs) c.accum = c.frameMs;
      if (ran > c.maxPerTick) c.maxPerTick = ran;
    }
    tickOf[id] += TICK;
  }
  return { E, con };
}

// The never-guessing reference: the host's agreed inputs, the same extracted rbStep.
async function reference(E, upTo, { zeroPort = -1, mt = true } = {}) {
  const M = await bootCore();
  let seated = 0; for (let p = 0; p < PORTS; p++) if (E.H.roster[p] != null) seated++;
  if (mt) plug(M, plugFor(seated));
  const pr = pageRollback(M, M._gpx_fps() || 59.922751);
  const fakeLs = { rollback: W, frame: 0 };
  if (!pr.rbInit(fakeLs)) throw new Error('reference rbInit: ' + pr.RB.fault);
  const out = new Map();
  let lastPass = 0;
  for (let k = 0; k <= upTo; k++) {
    const im = new Uint8Array(2 * PORTS);
    for (let p = 0; p < PORTS; p++) {
      if (E.H.roster[p] == null) continue;
      const b = E.H._inputFor(k, p); if (!b) return { out, stoppedAt: k, M };
      if (p !== zeroPort) im.set(b.subarray(0, 2), p * 2);
    }
    if (!pr.rbStep(k, im, 2, PORTS)) throw new Error('reference step ' + k);
    out.set(k, pr.rbHash(pr.rbSlot(k + 1)));
  }
  return { out, stoppedAt: upTo + 1, M };
}

console.log(`--- genesis rollback, ${PLAYERS} players, ${PORTS} ports, rom ${ROMSEL}, ${SECS}s simulated`
  + `${BROKEN ? ' (BROKEN CONTROL: rollbacks skip the re-simulation)' : ''}${BROKEN_MT ? ' (BROKEN CONTROL: consoles without the multitap)' : ''} ---`);
const plan = plugFor(PLAYERS);
console.log(`  plan for ${PLAYERS} seated: kind ${plan.kind} six ${plan.six} — ${plan.why}`);
const t0 = performance.now();
const { E, con } = await runRoom();
const REP = {}; for (const id of IDS) REP[id] = E[id].report();
const maxF = Math.max(...IDS.map((id) => REP[id].frame));
const ref = await reference(E, maxF);
let compared = 0, mism = 0, firstBad = null;
for (const id of IDS) for (const [k, h] of con[id].stateAfter) {
  if (!ref.out.has(k)) continue;
  compared++;
  if (ref.out.get(k) !== h) { mism++; if (!firstBad || k < firstBad.k) firstBad = { id, k }; }
}
const sensBy = {};
for (let zp = 1; zp < PLAYERS; zp++) {
  const rz = await reference(E, maxF, { zeroPort: zp });
  let n = 0; for (const [k, h] of ref.out) if (rz.out.has(k) && rz.out.get(k) !== h) n++;
  sensBy[zp] = n;
}
let noMtDiff = null;
if (PLAYERS > 2) {
  const rn = await reference(E, maxF, { mt: false });
  noMtDiff = 0; for (const [k, h] of ref.out) if (rn.out.has(k) && rn.out.get(k) !== h) noMtDiff++;
}
ok('every console advances', IDS.every((id) => REP[id].frame > SECS * 50), IDS.map((id) => `${id} ${REP[id].frame}`).join(', ') + ` frames in ${SECS}s (state ${IDS.map((id) => REP[id].state).join('/')})`);
ok(`the multitap is ${PLAYERS > 2 ? 'IN on every console' : 'out (two players)'}`,
   IDS.every((id) => (con[id].plugged | 0) === (PLAYERS > 2 && !BROKEN_MT ? plan.kind : 0)) && (PLAYERS > 2 ? plan.kind > 0 : true),
   `kind per console ${IDS.map((id) => con[id].plugged).join('/')}; input.system ${IDS.map((id) => con[id].M._gpx_input_system ? con[id].M._gpx_input_system(0) + ',' + con[id].M._gpx_input_system(1) : 'n/a (core has no read-back)').join(' / ')}`);
ok(`EVERY remote port reaches the guest state (ports 1..${PLAYERS - 1})`, Object.values(sensBy).every((n) => n > 10),
   Object.entries(sensBy).map(([p, n]) => `port ${p}: ${n}`).join(', ') + ' reference frames differ when that port is held at 0');
if (PLAYERS > 2) ok('the multitap is in the loop (a reference without it disagrees)', noMtDiff > 10, `${noMtDiff} reference frames differ with no adaptor`);
const rbs = IDS.map((id) => con[id].pr.RB);
ok('rollbacks happen', rbs.every((R) => R.rollbacks > 0), rbs.map((R, i) => `${IDS[i]} ${R.rollbacks} rollbacks / ${R.resimFrames} re-simulated (max depth ${R.maxDepth})`).join('; '));
ok('every confirmed fingerprint equals the never-guessing core', compared > 300 && mism === 0, `${compared - mism}/${compared} equal` + (firstBad ? `; first mismatch ${firstBad.id} frame ${firstBad.k}` : ''));
const lags = IDS.flatMap((id) => con[id].lag).filter((d) => d != null);
ok('zero local input lag', lags.length > 300 && lags.every((d) => d === 0), `${lags.filter((d) => d === 0).length}/${lags.length} frames ran the local pad on the frame it was sampled`);
const hz = con.H.hz;
ok('never faster than 1.000x', IDS.every((id) => con[id].maxPerTick <= 2 && REP[id].frame <= SECS * hz + 2), `frames ${IDS.map((id) => REP[id].frame).join('/')} vs ${(SECS * hz).toFixed(0)} at 1.000x; hidden ${IDS.map((id) => con[id].hiddenRan).join('/')}`);
const desync = IDS.reduce((n, id) => n + (REP[id].desync ? 1 : 0), 0);
ok('no fault, no desync', IDS.every((id) => !con[id].faults.length && REP[id].state !== 'failed') && !desync, `faults ${JSON.stringify(IDS.map((id) => con[id].faults.slice(0, 2)))} desync ${desync}`);
// What the GUEST read, at the end, out of the reference's work RAM: per pad, did
// anything other than "no buttons" ever reach it? (a read-back, not a verdict)
if (ROMSEL === 'mtap') {
  const M = ref.M, w = M._gpx_wram_ptr(), b = (o) => ramByte(M.HEAPU8, w, o);
  console.log(`  read-back (reference work RAM): 4-Way Play sums ${[0, 1, 2, 3].map((n) => b(0x10 + n) + '/' + b(0x14 + n)).join(' ')}; Team Player nibble sums ${Array.from({ length: 15 }, (_, k) => b(0x60 + k)).join(' ')}; presence ${b(0x20).toString(16)}`);
}
clearInterval(keepAlive);
const after = { wasm: md5(CORE + 'genesis_plus_gx.wasm'), js: md5(CORE + 'genesis_plus_gx.js'), page: md5(ROOT + 'genesis.html'), lib: md5(ROOT + 'lib/netplay.js') };
const load = os.loadavg().map((x) => +x.toFixed(2));
if (argv.includes('--json')) console.log(JSON.stringify({ md5Before: before, md5After: after, load, wallMs: Math.round(performance.now() - t0) }));
console.log(`\n${pass} passed, ${fail} failed${BROKEN || BROKEN_MT ? ' — BROKEN CONTROL: this run MUST fail' : ''}; md5 wasm ${before.wasm}${before.wasm === after.wasm ? '' : ' -> ' + after.wasm} page ${before.page.slice(0, 8)}${before.page === after.page ? '' : ' -> ' + after.page.slice(0, 8)} lib ${before.lib.slice(0, 8)}; load ${load.join(' ')}`);
process.exit(fail ? 1 : 0);

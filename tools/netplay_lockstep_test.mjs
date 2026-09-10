#!/usr/bin/env node
// DOES LOCKSTEP DO THE THINGS IT HAS TO — for as many players as the console
// has, never guessing, and never letting two machines drift apart in silence?
//
// This is the protocol under a microscope with NO browser and NO emulator: N
// Lockstep engines wired to each other through a scriptable bus, so the wire
// can be told to withhold a packet, hand back a diverged fingerprint, seat a
// latecomer, or walk a player out mid-match. A live rig cannot produce those on
// cue, which is exactly why the failure modes are tested here.
//
// WHAT IT WOULD CATCH: a prediction sneaking into the stall path; two machines
// disagreeing about who is in which port; a desync going unreported or
// unattributed; one player leaving and wedging everyone else; a latecomer being
// seated into a device set that was fixed at boot; the maps growing without
// bound; a peer writing someone else's controller.
//
// USAGE  node tools/netplay_lockstep_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(fs.readFileSync(path.join(root, 'lib/netplay.js'), 'utf8'));   // a script, not a module
const { Lockstep, Session } = globalThis.Netplay;

let pass = 0, fail = 0;
const ok  = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); };
const is  = (n, a, b) => (a === b ? ok(n, `= ${JSON.stringify(a)}`) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));
const eq  = (n, a, b) => is(n, JSON.stringify(a), JSON.stringify(b));

// One port's pad, in the Dreamcast layout EmscriptenWorker.cpp:1028 documents:
// 8 bytes of digital bitmap, then the analog axes.
const pad = (btn, lx = 0) => {
  const u = new Uint8Array(64);
  u[0] = btn & 255; u[8] = lx & 255; u[9] = (lx >> 8) & 255;
  return u;
};
const hex = (u8) => Buffer.from(u8).toString('hex');

// The names of the fingerprint fields the flycast worker actually sends
// (flycast_worker.js lsWords(): flycast_ctx_snapshot 0..11 + guest cycles).
const DC_FIELDS = ['pc', 'sr', 'interrupt_pend', 'cycle_counter', 'sh4_sched_next', 'CpuRunning',
                   'vbr', 'SB_ISTNRM', 'SB_IML6NRM', 'spc', 'ssr', 'pr', 'cycles_lo', 'cycles_hi'];

// ---- the room -------------------------------------------------------------
// Every engine's send reaches every other engine. hold() queues instead, so a
// test can starve one player and watch what the others do without them.
function room(peers, opts = {}) {
  const bus = { engines: [], held: false, q: [], drop: null };
  bus.flush = () => { const p = bus.q.splice(0); for (const [from, m] of p) deliver(from, m); };
  const deliver = (from, m) => { for (const e of bus.engines) if (e.peerId !== from) e.receive(m); };
  for (const spec of peers) {
    const e = new Lockstep(Object.assign({
      host: spec.host, peerId: spec.id, portCount: opts.portCount == null ? 4 : opts.portCount,
      delay: opts.delay == null ? 2 : opts.delay, hashEvery: opts.hashEvery == null ? 0 : opts.hashEvery,
      fieldNames: DC_FIELDS,
      send: (m) => {
        const tagged = Object.assign({ peer: spec.id }, m);
        if (bus.drop && bus.drop(spec.id, tagged)) return;
        if (bus.held) bus.q.push([spec.id, tagged]); else deliver(spec.id, tagged);
      },
    }, spec.opts || {}));
    bus.engines.push(e);
    bus[spec.id] = e;
  }
  bus.host = bus.engines.find((e) => e.isHost);
  return bus;
}

console.log('\n== the delay is a floor, and it is read in milliseconds ==');
{
  is('delay-min-1', new Lockstep({ delay: 0 }).delay, 1);      // delay 0 deadlocks everyone
  is('delay-capped', new Lockstep({ delay: 999 }).delay, 30);
  // ⚠ the quantum is one retro_run, not one VBlank: ~33.3 ms on a title that
  // renders every other VBlank (PSO Ver.2), ~16.7 on a 60 fps one.
  is('felt-60hz-delay3', Math.round(new Lockstep({ delay: 3 }).latencyMs(1000 / 60)), 50);
  is('felt-30hz-delay3', Math.round(new Lockstep({ delay: 3 }).latencyMs(1000 / 30)), 100);
  is('recommend-lan', Lockstep.recommendDelay(2, 1000 / 60), 2);
  is('recommend-60ms', Lockstep.recommendDelay(60, 1000 / 60), 3);
  is('recommend-160ms', Lockstep.recommendDelay(160, 1000 / 60), 6);
  is('portCount-not-assumed', new Lockstep({ portCount: 1 }).portCount, 1);
}

console.log('\n== the lobby: nobody starts until everybody is ready, on the same game ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }, { id: 'C' }]);
  const barriers = [];
  b.H.on('barrier', (x) => barriers.push(x));
  b.H.seat('H', 1); b.H.seat('A', 1); b.H.seat('B', 1); b.H.seat('C', 1);
  eq('roster-assigned', b.H.roster, ['H', 'A', 'B', 'C']);
  // EVERY machine must agree about who is in which port, or players drive each
  // other's characters.
  const agreed = b.engines.every((e) => JSON.stringify(e.roster) === JSON.stringify(['H', 'A', 'B', 'C']));
  agreed ? ok('roster-agreed', 'all four machines map the same person to the same port') : bad('roster-agreed');
  eq('own-ports', [b.H.localPorts, b.A.localPorts, b.B.localPorts, b.C.localPorts], [[0], [1], [2], [3]]);

  b.H.declareReady('pso-v2'); b.A.declareReady('pso-v2'); b.B.declareReady('pso-v2');
  is('barrier-holds', b.H.state, 'waiting');
  is('nobody-ran', b.A.beginFrame(pad(1)).reason, 'not-started');
  const last = barriers[barriers.length - 1];
  eq('barrier-names-who', last.waitingFor, ['C']);   // a 1.18 GB disc is a real, common state
  b.C.declareReady('pso-v2');
  b.engines.every((e) => e.state === 'running') ? ok('barrier-releases', 'all four began at frame 0 together')
                                                : bad('barrier-releases', b.engines.map((e) => e.state).join(','));
  is('frame-origin', b.A.frame, 0);
}
{
  // A different disc is REFUSED at the barrier, not hoped against — two discs
  // diverge on frame 1.
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  let failed = null;
  b.H.on('barrier-failed', (x) => { failed = x; });
  b.H.seat('H', 1); b.H.seat('A', 1);
  b.H.declareReady('pso-v2'); b.A.declareReady('gauntlet');
  failed ? ok('wrong-disc-refused', b.H.error) : bad('wrong-disc-refused', 'the room started on two different games');
  is('wrong-disc-host-state', b.H.state, 'failed');
  is('wrong-disc-peer-state', b.A.state, 'failed');
}
{
  // One machine, two controllers: two players, two ports — NOT two pads OR'd
  // into one, which is what the page does today (dreamcast.html:4419-4424).
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 2); b.H.seat('A', 1);
  eq('couch-coop-ports', b.H.localPorts, [0, 1]);
  eq('couch-coop-roster', b.H.roster, ['H', 'H', 'A', null]);
  b.H.declareReady('g'); b.A.declareReady('g');
  const r = b.H.beginFrame({ 0: pad(0x11), 1: pad(0x22) });
  // frames 0..delay-1 are the agreed neutral prologue, so step past them
  b.H.endFrame(null); b.A.beginFrame(pad(0x33)); b.A.endFrame(null);
  b.H.beginFrame({ 0: pad(0x11), 1: pad(0x22) }); b.H.endFrame(null);
  b.A.beginFrame(pad(0x33)); b.A.endFrame(null);
  const r2 = b.H.beginFrame({ 0: pad(0x44), 1: pad(0x55) });
  r2.ready && r2.image[0] === 0x11 && r2.image[64] === 0x22 && r2.image[128] === 0x33
    ? ok('couch-coop-image', 'one machine drove two distinct ports and the third came over the wire')
    : bad('couch-coop-image', r2.ready ? `${r2.image[0]},${r2.image[64]},${r2.image[128]}` : r2.reason);
}

console.log('\n== four machines, four ports, one identical frame sequence ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }, { id: 'C' }], { delay: 2 });
  b.H.seat('H', 1); b.H.seat('A', 1); b.H.seat('B', 1); b.H.seat('C', 1);
  for (const e of b.engines) e.declareReady('pso-v2');
  const images = b.engines.map(() => []);
  for (let f = 0; f < 60; f++) {
    const rs = b.engines.map((e, i) => e.beginFrame(pad((f * (i + 1)) & 255, f)));
    if (!rs.every((r) => r.ready)) { bad('nway-run', `stalled at ${f}: ${JSON.stringify(rs.map((r) => r.reason))}`); break; }
    rs.forEach((r, i) => images[i].push(hex(r.image)));
    b.engines.forEach((e) => e.endFrame(null));
  }
  const div = images[0].findIndex((h, f) => images.some((im) => im[f] !== h));
  div < 0 ? ok('nway-identical-images', '60 frames x 4 machines produced byte-identical 256 B maple images')
          : bad('nway-identical-images', `diverged at frame ${div}`);
  is('nway-frames', b.C.frame, 60);
  // The local pad is applied `delay` frames after it was pressed — the trade.
  const at10 = images[0][10];
  const wantHost = hex(pad((8 * 1) & 255, 8));
  at10.slice(0, 128) === wantHost ? ok('local-input-delayed', 'frame 10 ran the host pad from frame 8 (delay 2)')
                                  : bad('local-input-delayed', at10.slice(0, 32));
  images[0][0] === hex(new Uint8Array(256)) ? ok('neutral-prologue', 'frames 0..delay-1 are all-zero everywhere')
                                            : bad('neutral-prologue', images[0][0].slice(0, 40));
}

console.log('\n== a missing input STALLS, and says WHOSE ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }], { delay: 2 });
  b.H.seat('H', 1); b.H.seat('A', 1); b.H.seat('B', 1);
  for (const e of b.engines) e.declareReady('g');
  const step = (skip) => {
    for (const e of b.engines) {
      if (skip && e.peerId === skip) continue;
      const r = e.beginFrame(pad(1)); if (r.ready) e.endFrame(null);
    }
  };
  for (let i = 0; i < 6; i++) step();
  const stalls = [];
  b.H.on('stall', (x) => stalls.push(x));
  for (let i = 0; i < 20; i++) step('B');          // B goes quiet
  const r = b.H.beginFrame(pad(1));
  is('stall-reason', r.reason, 'stall');
  eq('stall-names-port', r.waitingOn, [2]);
  eq('stall-names-peer', r.waitingPeers, ['B']);   // a frozen picture is explainable
  is('stall-state', b.H.state, 'stalled');
  const parked = b.H.frame;
  for (let i = 0; i < 50; i++) b.H.beginFrame(pad(1));
  is('stall-does-not-advance', b.H.frame, parked);
  // Everyone kept SENDING while stalled, or the room would deadlock.
  b.H.stats.sent > parked ? ok('stall-still-sends', `${b.H.stats.sent} local inputs sent past frame ${parked}`)
                          : bad('stall-still-sends', 'a stalled machine stopped sending');
  for (let i = 0; i < 30; i++) { const r2 = b.B.beginFrame(pad(9)); if (r2.ready) b.B.endFrame(null); }
  const r3 = b.H.beginFrame(pad(1));
  r3.ready ? ok('stall-resumes', `frame ${r3.frame} ran once B caught up`) : bad('stall-resumes', r3.reason);
  is('resumed-state', b.H.state, 'running');
}

console.log('\n== a peer may not drive somebody else\'s controller ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }], { delay: 2 });
  b.H.seat('H', 1); b.H.seat('A', 1);
  for (const e of b.engines) e.declareReady('g');
  // A forged input claiming port 0, sent by the peer who owns port 1.
  b.H.receive({ t: 'ls', f: 5, peer: 'A', i: [[0, Buffer.from(pad(0xff)).toString('base64')]] });
  const forged = b.H._inputFor(5, 0);
  forged === undefined ? ok('port-ownership-enforced', 'a peer writing a port it does not own was dropped')
                       : bad('port-ownership-enforced', 'the forged pad was accepted');
}

console.log('\n== a desync names the frame, the peer, and the field ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }], { delay: 2, hashEvery: 4 });
  b.H.seat('H', 1); b.H.seat('A', 1); b.H.seat('B', 1);
  for (const e of b.engines) e.declareReady('g');
  const evts = [], details = [];
  b.H.on('desync', (d) => evts.push(d));
  b.H.on('desync-detail', (d) => details.push(d));
  const words = (n) => [0x8c0100a2 + n, 0x400000f0, 0, 1234 + n, 5678, 1, 0x8c000000, 0, 0, 0, 0, 0x8c0100b0, n, 0];
  let f = 0;
  const run = (bad3) => {
    const rs = b.engines.map((e) => e.beginFrame(pad(1)));
    if (!rs.every((r) => r.ready)) return false;
    b.engines.forEach((e) => {
      const w = e.wantsHash() ? (bad3 && e.peerId === 'B' ? words(999) : words(f)) : null;
      e.endFrame(w ? globalThis.Netplay.fnv32 && w.reduce((h, v) => (Math.imul((h ^ (v >>> 0)) >>> 0, 0x01000193) >>> 0), 0x811c9dc5) : null, w);
    });
    f++; return true;
  };
  for (let i = 0; i < 12; i++) run(false);
  is('agreeing-no-desync', evts.length, 0);
  b.H.stats.hashesCompared >= 3 ? ok('hashes-compared', `${b.H.stats.hashesCompared} checkpoints compared across 3 machines`)
                                : bad('hashes-compared', String(b.H.stats.hashesCompared));
  const agreedTo = b.H.lastAgreedFrame;
  run(true);      // B's core diverges. The INPUTS are identical — the invisible failure.
  evts.length === 1 ? ok('desync-detected', `frame ${evts[0].frame}`) : bad('desync-detected', `${evts.length} events`);
  const d = evts[0] || {};
  eq('desync-names-peer', d.differ, ['B']);
  eq('desync-names-innocent', d.agree, ['A']);
  is('desync-last-agreed', d.lastAgreedFrame, agreedTo);   // the window the divergence happened in
  is('desync-state', b.H.state, 'desync');
  is('desync-stops-frames', b.H.beginFrame(pad(1)).ready, false);
  // ...and B's raw fingerprint names the FIELD, which is the work list.
  const det = details[details.length - 1];
  det && det.fields && det.fields.length
    ? ok('desync-names-field', det.fields.map((x) => `${x.name} 0x${x.mine.toString(16)} vs 0x${x.theirs.toString(16)}`).join(', '))
    : bad('desync-names-field', JSON.stringify(det));
  det && det.fields[0].name === 'pc' ? ok('desync-field-named', 'the first differing field is named, not "w0"')
                                     : bad('desync-field-named', JSON.stringify(det && det.fields[0]));
  b.A.state === 'desync' || b.A.state === 'failed'
    ? ok('desync-propagates', `the innocent machine stopped too (${b.A.state})`) : bad('desync-propagates', b.A.state);
}

console.log('\n== a player walking out must not wedge the rest ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }], { delay: 2 });
  b.H.seat('H', 1); b.H.seat('A', 1); b.H.seat('B', 1);
  for (const e of b.engines) e.declareReady('g');
  const leaves = [];
  b.A.on('leave', (x) => leaves.push(x));
  const step = (skip) => { for (const e of b.engines) { if (skip && e.peerId === skip) continue;
    const r = e.beginFrame(pad(1)); if (r.ready) e.endFrame(null); } };
  for (let i = 0; i < 10; i++) step();
  const ports = b.H.dropPeer('B');
  eq('leave-port', ports, [2]);
  const at = b.H.dropped.get(2);
  // Every machine must apply the drop at the SAME frame, and that frame must be
  // in the future — a drop applied at different frames IS a desync.
  const allSame = b.engines.every((e) => e.dropped.get(2) === at);
  allSame ? ok('leave-agreed-frame', `port 2 goes limp at frame ${at} on every machine (now ${b.H.frame})`)
          : bad('leave-agreed-frame', b.engines.map((e) => e.dropped.get(2)).join(','));
  // Exactly frame+delay+1: the first frame nobody can have executed, and not one
  // later — every frame below it still needs B's real input.
  // One past B's LAST input: simultaneously the first frame nobody can have
  // executed and the last one that is still satisfiable.
  let lastB = -1;
  for (const [f, m] of b.H.inputs) if (m.has(2) && f > lastB) lastB = f;
  at === lastB + 1 && at >= b.H.frame
    ? ok('leave-in-future', `boundary is frame ${at} — one past B's last input (${lastB}), with the room at frame ${b.H.frame}`)
    : bad('leave-in-future', `${at}, lastInput=${lastB}, frame=${b.H.frame}`);
  leaves.length ? ok('leave-announced', `peer ${leaves[0].peer} ports ${leaves[0].ports}`) : bad('leave-announced');
  // The remaining players keep playing, and the leaver's pad reads all-zero.
  let ranPast = 0, lastImage = null;
  for (let i = 0; i < 120; i++) {
    const r = b.H.beginFrame(pad(0x77));
    if (!r.ready) { step('B'); continue; }
    if (b.H.frame >= at) { ranPast++; lastImage = r.image; }
    b.H.endFrame(null);
    for (const e of b.engines) if (e !== b.H && e.peerId !== 'B') { const q = e.beginFrame(pad(1)); if (q.ready) e.endFrame(null); }
  }
  ranPast > 20 ? ok('leave-room-continues', `${ranPast} frames run past the drop with B gone`)
               : bad('leave-room-continues', `only ${ranPast} frames`);
  lastImage && lastImage.slice(128, 192).every((v) => v === 0)
    ? ok('leave-pad-limp', "the leaver's controller stays plugged in and reads all-zero")
    : bad('leave-pad-limp', lastImage ? hex(lastImage.slice(128, 160)) : 'no frame ran');
}

console.log('\n== a latecomer is refused, out loud ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }], { delay: 2 });
  b.H.seat('H', 1); b.H.seat('A', 1);
  for (const e of b.engines) e.declareReady('g');
  let refused = null;
  b.H.on('barrier-failed', (x) => { refused = x; });
  const got = b.H.seat('LATE', 1);
  eq('late-join-refused', got, []);
  refused && /already started/.test(refused.error) ? ok('late-join-explained', refused.error)
                                                   : bad('late-join-explained', JSON.stringify(refused));
  eq('late-join-roster-untouched', b.H.roster, ['H', 'A', null, null]);
}

console.log('\n== a peer that goes away is reported, not waited on forever ==');
{
  let t = 0;
  const b = room([{ id: 'H', host: true }, { id: 'A' }], { delay: 2, opts: {} });
  b.H.stallBudgetMs = 500; b.H._now = () => t;
  b.H.seat('H', 1); b.H.seat('A', 1);
  for (const e of b.engines) e.declareReady('g');
  b.H.beginFrame(pad(1)); b.H.endFrame(null);
  b.H.beginFrame(pad(1)); b.H.endFrame(null);
  b.H.beginFrame(pad(1));
  is('budget-still-stalled', b.H.state, 'stalled');
  t += 600;
  b.H.beginFrame(pad(1));
  is('budget-fails', b.H.state, 'failed');
  /no input from A/.test(b.H.error || '') ? ok('budget-names-them', b.H.error) : bad('budget-names-them', String(b.H.error));
}

console.log('\n== a long session does not grow without bound ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }], { delay: 3, hashEvery: 10 });
  b.H.seat('H', 1); b.H.seat('A', 1);
  for (const e of b.engines) e.declareReady('g');
  for (let f = 0; f < 3000; f++) {
    const rs = b.engines.map((e) => e.beginFrame(pad(f & 255)));
    if (!rs.every((r) => r.ready)) { bad('long-run', `stalled at ${f}`); break; }
    b.engines.forEach((e) => e.endFrame(e.wantsHash() ? f : null, e.wantsHash() ? [f, 1, 2] : null));
  }
  is('long-run-frames', b.H.frame, 3000);
  const biggest = Math.max(b.H.inputs.size, b.H.myHash.size, b.H.peerHash.size, b.H.myWords.size);
  biggest < 600 ? ok('maps-bounded', `largest map held ${biggest} entries after 3000 frames`)
                : bad('maps-bounded', `${biggest} entries — the ring is not pruning`);
}

console.log('\n== the transferred-state path is kept, and is NOT the start path ==');
{
  const mk = (isHost) => {
    const s = new Session({ game: 'test', host: isHost, code: 'AAAAA', transport: 'local', ui: false });
    s._dc = { readyState: 'open', bufferedAmount: 0, send: null };
    if (isHost) s._approved = true;     // a host transmits nothing to an unapproved peer
    return s;
  };
  Session.prototype._rx2 = function (m) {
    if (m.t && m.t.charCodeAt(0) === 108 && m.t.charCodeAt(1) === 115) return this._onLockstepMsg(m);
    if (/^save-/.test(m.t)) return this._onSaveMsg(m);
  };
  const link = (x, y, mangle) => { x._dc.send = (str) => { const m = JSON.parse(str); if (!mangle || mangle(m)) y._rx2(m); }; };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const h = mk(true), g = mk(false);
  link(h, g); link(g, h);
  h.startLockstep({ delay: 2 }); g.startLockstep({ delay: 2 });
  is('session-mode-is-lockstep', h.mode, 'lockstep');
  let got = null; g.on('sync-state', (e) => { got = e; });
  await h.sendStartState(new Uint8Array(4096).fill(7), { at: 'title' });
  await settle();
  got && got.ok && got.bytes.length === 4096
    ? ok('resync-transport-works', `${got.bytes.length} B, ${got.encoding} — available for a future late-join`)
    : bad('resync-transport-works', JSON.stringify(got && got.error));
  h.ls.state !== 'running' ? ok('transfer-does-not-start-a-game', `still ${h.ls.state} — the barrier starts a session, not a transfer`)
                           : bad('transfer-does-not-start-a-game');
  // A truncated transfer is never handed to the emulator.
  const h2 = mk(true), g2 = mk(false);
  link(h2, g2, (m) => !(m.t === 'save-chunk' && m.i === 2)); link(g2, h2);
  h2.startLockstep({ delay: 2 }); g2.startLockstep({ delay: 2 });
  let handed = false, gf = null;
  g2.on('sync-state', (e) => { if (e.ok) handed = true; });
  g2.on('sync-failed', (e) => { gf = e; });
  const big = new Uint8Array(200000); for (let i = 0; i < big.length; i++) big[i] = (Math.random() * 256) | 0;
  await h2.sendStartState(big, {});
  await settle();
  !handed ? ok('truncated-not-handed-over', 'the emulator was never offered a short state') : bad('truncated-not-handed-over');
  gf ? ok('truncated-reported', gf.error) : bad('truncated-reported', 'silent');
}

// ===========================================================================
// A ROSTER IS A SNAPSHOT, AND A PEER HAS TO BE ABLE TO TELL WHEN ITS COPY HAS
// STOPPED BEING TRUE.
//
// THE FAILURE THESE CELLS EXIST FOR, from two real devices on caseybement.com:
//   PHONE  "you are Player 2 (maple port 1) · P1 f126ff364842db19 · P2 you"
//   DESKTOP "the other player dropped out — this room is empty again"
// Both at "frame 0 · core ran 0", neither saying anything was wrong. The
// roster had exactly three senders — seat(), unseat(), the barrier release —
// with no retransmit and no way to ask, so the phone was drawing a message
// that arrived before everything went wrong and had no way to know.
// The page renders rosterEvicted / rosterStale as a banner, so these two flags
// ARE the "your screen may be lying to you" claim and must be tested here
// rather than only in a browser rig where the reconnect usually wins the race.
// ===========================================================================
console.log('\n== a guest can tell when its picture of the room has stopped being true ==');
{
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  is('roster-seq-advances', b.A.rosterSeq > 0, true);
  is('a-seated-guest-is-not-evicted', b.A.report().rosterEvicted, false);
  is('a-fresh-roster-is-not-stale', b.A.report().rosterStale, false);
  // The host drops this player. On the wire that is an ordinary roster whose
  // seats no longer include them — which is exactly what the phone never got.
  b.H.unseat('A');
  is('the-guest-KNOWS-it-was-dropped', b.A.report().rosterEvicted, true);
  is('the-guest-holds-no-port', b.A.localPorts.length, 0);
  // The host is never "evicted" from its own room — it IS the roster.
  is('the-host-never-reports-eviction', b.H.report().rosterEvicted, false);
}
{
  // Silence is the other half: a guest that has heard NO authoritative roster
  // for four heartbeats must stop claiming to know who is in the room. Aged by
  // hand rather than by waiting nine seconds.
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  is('not-stale-while-heard-from', b.A.report().rosterStale, false);
  b.A.rosterAt = Date.now() - 60000;
  is('nine-seconds-of-silence-is-STALE', b.A.report().rosterStale, true);
  is('the-host-is-never-stale-to-itself', b.H.report().rosterStale, false);
  // ...and a retransmit clears it. This is the whole point of the heartbeat:
  // the room reconverges on its own instead of waiting for the next seat change
  // that may never come.
  b.H._rosterSend();
  is('a-retransmit-clears-the-staleness', b.A.report().rosterStale, false);
  is('a-retransmit-does-not-move-the-seats', JSON.stringify(b.A.roster), JSON.stringify(['H', 'A', null, null]));
}
{
  // A LATE OR REORDERED ROSTER MUST NEVER UNDO A NEWER ONE. A relay can
  // deliver a heartbeat after the seat change it precedes, and applying it
  // would unseat somebody who is in the room.
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  const newest = b.A.rosterSeq;
  b.A.receive({ t: 'lsroster', r: [null, null, null, null], portCount: 4, seq: newest - 1 });
  is('a-stale-roster-is-ignored', JSON.stringify(b.A.roster), JSON.stringify(['H', 'A', null, null]));
  b.A.receive({ t: 'lsroster', r: ['H', 'A', 'B', null], portCount: 4, seq: newest + 1 });
  is('a-newer-roster-is-applied', JSON.stringify(b.A.roster), JSON.stringify(['H', 'A', 'B', null]));
}
{
  // THE RETURNING PLAYER GETS THEIR OWN PORT BACK. Ports are handed out
  // lowest-free-first, so without seatHistory a player whose page reloaded
  // could be given a seat somebody else was about to take — i.e. a different
  // character — while nothing had run a frame.
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }]);
  b.H.seat('H', 1); b.H.seat('A', 1); b.H.seat('B', 1);
  eq('three-seated', b.H.roster, ['H', 'A', 'B', null]);
  b.H.unseat('A');                       // A's page went away
  eq('the-seat-is-freed', b.H.roster, ['H', null, 'B', null]);
  b.H.seat('A', 1);                      // ...and came back
  eq('the-returning-player-gets-PORT-1-BACK', b.H.roster, ['H', 'A', 'B', null]);
  // Re-seating an already-seated peer is a no-op on the seats and still
  // republishes, which is what a reconnect that KEPT its seat needs.
  const before = JSON.stringify(b.H.roster);
  const got = b.H.seat('A', 1);
  eq('reseating-a-seated-peer-moves-nobody', b.H.roster, JSON.parse(before));
  eq('reseating-reports-the-port-it-already-had', got, [1]);
}

console.log('\n== the memory cards are AGREED before frame 0, or nobody starts ==');
{
  // A card is guest-visible memory, so two consoles that begin with different
  // card bytes are forked at frame 0. These prove the exchange that stops that:
  // each seat contributes its OWN card, the host assembles the whole set, and
  // every machine ends up holding the SAME set and the SAME fingerprint.
  const card = (fill, n = 40 * 1024) => { const u = new Uint8Array(n); u.fill(fill); return u; };
  const cardHash = (u8) => {           // stands in for the page's raw-card hash
    let h = 0x811c9dc5;
    for (let i = 0; i < u8.length; i++) h = Math.imul((h ^ u8[i]) >>> 0, 0x01000193) >>> 0;
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  };
  const entry = (port, u8) => ({ port, size: u8.length, hash: cardHash(u8), enc: 'raw', bytes: u8 });

  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  const hostCard = card(0xa1), guestCard = card(0xb2);

  // Nothing is agreed until BOTH seats have spoken.
  b.H.contributeCards([entry(0, hostCard)]);
  is('no-set-while-a-seat-is-silent', b.H.cardSetHash, null);
  eq('the-room-names-the-seat-it-is-waiting-on', b.H.cardsWaitingFor(), [{ port: 1, peer: 'A' }]);
  is('the-guest-has-nothing-yet', b.A.cardSetHash, null);

  // ...and the moment it does, the host assembles and everybody has the set.
  b.A.contributeCards([entry(1, guestCard)]);
  eq('nothing-is-outstanding-once-both-contributed', b.H.cardsWaitingFor(), []);
  is('the-host-agreed-a-set', typeof b.H.cardSetHash, 'string');
  is('BOTH-MACHINES-HOLD-THE-SAME-SET-FINGERPRINT', b.A.cardSetHash, b.H.cardSetHash);
  eq('the-set-covers-exactly-the-occupied-ports',
     Object.keys(b.A.cards).map((x) => x | 0).sort(), [0, 1]);

  // The bytes are the ones each SEAT contributed — not the host's for both.
  // ⚠ COMPARED BY DIGEST, NOT BY PRINTING THEM. `is()` puts its values in the
  // log; two 40 KB cards as hex is 160 KB of noise that buries every other row.
  const same = (a, c) => a.length === c.length && cardHash(a) === cardHash(c);
  is('port-0-carries-the-HOSTs-card',  same(b.A.cards[0].bytes, hostCard), true);
  is('port-1-carries-the-GUESTs-card', same(b.A.cards[1].bytes, guestCard), true);
  is('the-host-also-holds-the-guests-card', same(b.H.cards[1].bytes, guestCard), true);
  is('a-card-survives-the-chunker-intact', b.A.cards[1].bytes.length, guestCard.length);
  is('the-raw-fingerprint-travels-with-it', b.A.cards[1].hash, cardHash(guestCard));

  // The fingerprint is a pure function of the SET, computed the same way on
  // both sides — which is what makes it safe to fold into the barrier's
  // declaration and refuse a mismatch by name.
  is('the-fingerprint-is-recomputable', Lockstep.cardSetHash(b.A.cards), b.H.cardSetHash);
  const forged = Object.assign({}, b.A.cards, { 1: Object.assign({}, b.A.cards[1], { hash: 'deadbeef' }) });
  is('a-different-set-fingerprints-differently', Lockstep.cardSetHash(forged) !== b.H.cardSetHash, true);
}
{
  // A PEER MAY ONLY SPEAK FOR ITS OWN SEAT. A card is guest-visible memory on
  // EVERY machine, so a peer allowed to write another port's card could fork
  // the whole room — the same rule as an input packet, for a worse reason.
  const card = (fill) => { const u = new Uint8Array(1024); u.fill(fill); return u; };
  const e = (port, u8) => ({ port, size: u8.length, hash: 'h' + port, enc: 'raw', bytes: u8 });
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  b.A.contributeCards([e(0, card(0xee))]);          // A claiming the HOST's port
  eq('a-peer-cannot-contribute-to-a-seat-it-does-not-hold', b.H.cardsWaitingFor(),
     [{ port: 0, peer: 'H' }, { port: 1, peer: 'A' }]);
  // ...and a forged packet that skips contributeCards() is refused at receive.
  b.H.receive({ t: 'lsvmu', peer: 'A', port: 0, size: 1024, hash: 'x', enc: 'raw',
                len: 4, n: 1, i: 0, d: 'AAAA' });
  eq('a-forged-contribution-for-another-port-is-dropped', b.H.cardsWaitingFor(),
     [{ port: 0, peer: 'H' }, { port: 1, peer: 'A' }]);
}
{
  // A TRUNCATED SET IS REFUSED, NOT INSTALLED. A short card installs as a
  // corrupt card, which is the silent fork the exchange exists to prevent — so
  // the guest reports it and holds itself out of the barrier instead.
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  let reported = null;
  b.A.on('cards', (c) => { if (c && c.error) reported = c.error; });
  b.A.receive({ t: 'lsvmuz', seq: 1, set: 'cafebabe',
                ports: [{ port: 0, size: 8, hash: 'h0', enc: 'raw', len: 8 }] });
  b.A.receive({ t: 'lsvmus', seq: 1, port: 0, size: 8, hash: 'h0', enc: 'raw',
                len: 8, n: 2, i: 0, d: 'AAAA' });      // 3 of the 8 bytes
  b.A.receive({ t: 'lsvmus', seq: 1, port: 0, size: 8, hash: 'h0', enc: 'raw',
                len: 8, n: 2, i: 1, d: 'AAAA' });      // ...and 3 more: 6 != 8
  is('a-short-set-is-NOT-installed', b.A.cardSetHash, null);
  // And one whose pieces DO add up but whose fingerprint disagrees with the
  // manifest is refused too — a crossed transfer looks whole.
  b.A.receive({ t: 'lsvmuz', seq: 2, set: 'cafebabe',
                ports: [{ port: 0, size: 3, hash: 'h0', enc: 'raw', len: 3 }] });
  b.A.receive({ t: 'lsvmus', seq: 2, port: 0, size: 3, hash: 'h0', enc: 'raw',
                len: 3, n: 1, i: 0, d: 'AAAA' });
  is('a-set-that-does-not-match-the-announced-fingerprint-is-refused', b.A.cardSetHash, null);
  is('and-the-refusal-carries-a-reason', /fingerprint/.test(reported || ''), true);
}
{
  // THE ROOM CHANGING DROPS THE SET. A set covers exactly the occupied ports,
  // so a seat handed out or vacated after one was agreed makes it wrong — and
  // a console installing it would hold a blank where a player's card belongs.
  const card = (fill) => { const u = new Uint8Array(2048); u.fill(fill); return u; };
  const e = (port, u8, h) => ({ port, size: u8.length, hash: h, enc: 'raw', bytes: u8 });
  const b = room([{ id: 'H', host: true }, { id: 'A' }, { id: 'B' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  b.H.contributeCards([e(0, card(1), 'h0')]);
  b.A.contributeCards([e(1, card(2), 'h1')]);
  const two = b.H.cardSetHash;
  is('a-two-seat-room-agrees-a-set', typeof two, 'string');
  b.H.seat('B', 1);                                  // a third player sits down
  is('a-NEW-SEAT-drops-the-agreed-set', b.H.cardSetHash, null);
  eq('and-the-room-waits-on-the-newcomer', b.H.cardsWaitingFor(), [{ port: 2, peer: 'B' }]);
  b.B.contributeCards([e(2, card(3), 'h2')]);
  is('the-set-is-agreed-again-once-they-contribute', typeof b.H.cardSetHash, 'string');
  is('and-it-is-NOT-the-two-seat-set', b.H.cardSetHash !== two, true);
  is('every-machine-moved-to-the-new-set', b.A.cardSetHash, b.H.cardSetHash);
  // ...and standing up again drops it and re-agrees the smaller one in the same
  // breath, because the two remaining contributions are still on file. What
  // must NOT survive is the leaver's card: a set that still names port 2 would
  // have every console install a card for a seat nobody is playing.
  b.H.unseat('B');
  is('a-VACATED-SEAT-returns-the-room-to-the-two-seat-set', b.H.cardSetHash, two);
  eq('and-the-leavers-port-is-gone-from-the-set',
     Object.keys(b.H.cards).map((x) => x | 0).sort(), [0, 1]);
  is('every-machine-followed-it-back', b.A.cardSetHash, two);
}
{
  // ...AND THE BARRIER REFUSES A ROOM WHOSE CONSOLES HOLD DIFFERENT CARDS.
  // dreamcast.html folds the agreed set's fingerprint into the string it
  // declares, so this is the SAME tested path that refuses two different discs
  // — which is the point of putting it there rather than inventing a second
  // refusal. Without this the exchange would be a best effort: correct when it
  // works and a silent fork when it does not.
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  let refused = null;
  b.H.on('barrier-failed', (x) => { refused = x; });
  b.H.declareReady('gauntlet#cards:542da858');
  b.A.declareReady('gauntlet#cards:0badc0de');   // same disc, different card set
  is('DIFFERENT-CARDS-REFUSE-THE-ROOM', !!refused, true);
  is('nobody-started', b.H.state, 'failed');
  is('and-the-refusal-NAMES-the-mismatch', /cards:/.test((b.H.error || '')), true);
  // ...while the same set on both starts normally, so the tag is not simply
  // breaking every room.
  const c = room([{ id: 'H', host: true }, { id: 'A' }]);
  c.H.seat('H', 1); c.H.seat('A', 1);
  c.H.declareReady('gauntlet#cards:542da858');
  c.A.declareReady('gauntlet#cards:542da858');
  is('THE-SAME-CARD-SET-STARTS-THE-ROOM', c.H.state, 'running');
}
{
  // A GUEST THAT MISSED THE BROADCAST CAN ASK FOR IT, the same way it can ask
  // for the roster. Without this a lost manifest is a console that never
  // starts and never says why.
  const card = (fill) => { const u = new Uint8Array(4096); u.fill(fill); return u; };
  const e = (port, u8, h) => ({ port, size: u8.length, hash: h, enc: 'raw', bytes: u8 });
  const b = room([{ id: 'H', host: true }, { id: 'A' }]);
  b.H.seat('H', 1); b.H.seat('A', 1);
  b.bus = b;
  b.H.contributeCards([e(0, card(7), 'h0')]);
  // A's contribution reaches the host, but the host's broadcast is dropped.
  b.drop = (from, m) => from === 'H' && (m.t === 'lsvmuz' || m.t === 'lsvmus');
  b.A.contributeCards([e(1, card(9), 'h1')]);
  is('the-host-agreed-it', typeof b.H.cardSetHash, 'string');
  is('the-guest-never-heard-it', b.A.cardSetHash, null);
  b.drop = null;
  b.A.requestCards();
  is('ASKING-RECOVERS-THE-SET', b.A.cardSetHash, b.H.cardSetHash);
}

// ===========================================================================
// A ROOM ON A TRANSPORT THAT LOSES MESSAGES
//
// The signalling relay is a free public MQTT broker at QoS 0, and it was
// MEASURED losing 12 of 58 publishes — 20.7% — between two browsers on one
// box (lib/netplay.js, the block above RELAY_REPAIR_MS). Lockstep sends each
// frame's input exactly once and never guesses, so one loss is a PERMANENT
// deadlock: both consoles read a hole rather than a horizon —
//     host  HELD port1 = 6..22,24..30   (want f=23)
// inputs present ABOVE the frame they are stuck on, which no amount of extra
// input delay can repair.
//
// These cells drive the three functions that fix it — _relayNote,
// _relayWindow, _relayApplyWindow — with a transport that really does drop
// one publish in five, and assert the room still runs.
// ===========================================================================
console.log('\n== a lossy transport does not deadlock a lockstep room ==');
{
  // A stand-in for the relay half of a NetplaySession: the real methods, on an
  // object holding only the state they touch. Nothing here reimplements them.
  const relaySide = (delay) => {
    const o = Object.create(Session.prototype);
    o._relayWin = new Map();
    o._relayWinPeer = null;
    o.ls = { delay, state: 'running' };
    o.delayFrames = delay;
    return o;
  };
  // window depth must cover 2*delay — the most a peer can be behind — or a
  // stalled partner's missing frame ages out before the repeat reaches it.
  const d6 = relaySide(6), d30 = relaySide(30);
  (d6._relayWinDepth() >= 12 && d30._relayWinDepth() >= 60)
    ? ok('window-covers-twice-the-delay', `delay 6 -> ${d6._relayWinDepth()}, delay 30 -> ${d30._relayWinDepth()}`)
    : bad('window-covers-twice-the-delay', `${d6._relayWinDepth()} / ${d30._relayWinDepth()}`);

  // A HELD BUTTON IS ONE RUN. Without this the window is 96 frames of
  // identical base64 on every publish.
  const r = relaySide(6);
  for (let f = 10; f < 20; f++) r._relayNote({ t: 'ls', f, i: [[0, 'AAAA']], peer: 'H' });
  r._relayNote({ t: 'ls', f: 20, i: [[0, 'BBBB']], peer: 'H' });
  const w = r._relayWindow();
  eq('a-held-pad-is-one-run', w.v.map((x) => [x[0], x[1]]), [[10, 10], [20, 1]]);
  is('the-window-names-its-sender', w.p, 'H');

  // AND IT EXPANDS BACK TO EXACTLY THE FRAMES THAT WENT IN.
  const seen = [];
  const rx = Object.create(Session.prototype);
  rx._onData = (m) => { seen.push(m.f); return true; };
  const n = rx._relayApplyWindow(w, null);
  is('expands-to-every-frame', n, 11);
  eq('expands-in-order', seen, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

  // ---- and now the whole thing, end to end, under real loss --------------
  // Two engines, delay 6, 300 frames. Every 'ls' goes into the sender's
  // window; a publish carries the WHOLE window and is dropped outright one
  // time in five by a seeded generator (deterministic, so a failure here is
  // reproducible rather than a flake).
  const DELAY = 6, FRAMES = 300;
  let seed = 0x2f6e2b1;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let dropped = 0, published = 0;

  const side = { H: relaySide(DELAY), A: relaySide(DELAY) };
  const eng = {};
  const publish = (from) => {
    const win = side[from]._relayWindow();
    if (!win) return;
    published++;
    if (rnd() < 0.2) { dropped++; return; }             // the broker ate it
    const to = from === 'H' ? 'A' : 'H';
    const rxs = Object.create(Session.prototype);
    rxs._onData = (m) => { eng[to].receive(m); return true; };
    rxs._relayApplyWindow(win, null);
  };
  for (const spec of [{ id: 'H', host: true }, { id: 'A' }]) {
    eng[spec.id] = new Lockstep({
      host: spec.host, peerId: spec.id, portCount: 2, delay: DELAY, hashEvery: 0,
      send: (m) => {
        const tagged = Object.assign({ peer: spec.id }, m);
        // Control traffic is not per-frame and rides its own path; only the
        // per-frame input goes through the lossy window, which is exactly how
        // the relay carries it.
        if (tagged.t !== 'ls') { const to = spec.id === 'H' ? 'A' : 'H'; eng[to] && eng[to].receive(tagged); return; }
        side[spec.id]._relayNote(tagged);
        publish(spec.id);
      },
    });
  }
  eng.H.seat('H', 1); eng.H.seat('A', 1);
  eng.H.declareReady('g'); eng.A.declareReady('g');
  is('the-lossy-room-started', eng.H.state, 'running');

  // Drive both consoles. A publish is also emitted with no new input, which is
  // what RELAY_REPAIR_MS does for a stalled peer — without it the repeat never
  // travels and the room stays wedged holding its own cure.
  let ranH = 0, ranA = 0;
  for (let i = 0; i < FRAMES * 6; i++) {
    for (const id of ['H', 'A']) {
      const r2 = eng[id].beginFrame(pad(i & 1 ? 1 : 0));
      if (r2.ready) { eng[id].endFrame(null); if (id === 'H') ranH++; else ranA++; }
    }
    publish('H'); publish('A');
    if (ranH >= FRAMES && ranA >= FRAMES) break;
  }
  (dropped > 20) ? ok('the-transport-really-lost-messages', `${dropped} of ${published} publishes dropped`)
                 : bad('the-transport-really-lost-messages', `only ${dropped}/${published} dropped — the arm did nothing`);
  (ranH >= FRAMES && ranA >= FRAMES)
    ? ok('BOTH-CONSOLES-RAN-EVERY-FRAME-THROUGH-A-LOSSY-LINK', `H ${ranH}, A ${ranA} of ${FRAMES}`)
    : bad('BOTH-CONSOLES-RAN-EVERY-FRAME-THROUGH-A-LOSSY-LINK',
          `H ran ${ranH}, A ran ${ranA} of ${FRAMES} — a lost input is still a permanent deadlock`);
  is('nobody-diverged', eng.H.state === 'desync' || eng.A.state === 'desync', false);
}

// ===========================================================================
// RAISING THE INPUT DELAY MID-SESSION LEAVES NO HOLE
//
// The raise exists to cure a stall, and the version that shipped manufactured
// one: it filled f+D+1 .. f+D' while this console had queued only through
// (f-1)+D, so frame f+D was never queued by anybody and the room deadlocked on
// it forever. The property is not "the delay changed" — it is that this
// peer's own input stream is CONTIGUOUS across the switch, with each frame
// sent exactly once.
// ===========================================================================
console.log('\n== a delay raise leaves a contiguous input stream ==');
{
  const runRaise = (label, stallFirst) => {
    const sentFrames = [];
    const b = room([{ id: 'H', host: true }, { id: 'A' }], { portCount: 2, delay: 4 });
    b.H.seat('H', 1); b.H.seat('A', 1);
    const origSend = b.H._send;
    b.H._send = (m) => { if (m && m.t === 'ls') for (const it of m.i) if ((it[0] | 0) === 0) sentFrames.push(m.f); return origSend(m); };
    b.H.declareReady('g'); b.A.declareReady('g');
    // Run both up to frame 10 so there is history on each side.
    for (let i = 0; i < 10; i++) {
      const rh = b.H.beginFrame(pad(0)); if (rh.ready) b.H.endFrame(null);
      const ra = b.A.beginFrame(pad(0)); if (ra.ready) b.A.endFrame(null);
    }
    // The host schedules the raise, then both sides walk forward into it.
    // `stallFirst` reproduces the OTHER position the raise can land in: a peer
    // whose lsdelay arrived late applies it on a repeat attempt at a frame
    // whose scheduling block is already spent.
    b.H._scheduleDelay(9);
    if (stallFirst) { b.bus = null; }
    for (let i = 0; i < 40; i++) {
      const rh = b.H.beginFrame(pad(0)); if (rh.ready) b.H.endFrame(null);
      const ra = b.A.beginFrame(pad(0)); if (ra.ready) b.A.endFrame(null);
    }
    const uniq = Array.from(new Set(sentFrames)).sort((x, y) => x - y);
    const dupes = sentFrames.length - uniq.length;
    let holes = [];
    for (let i = 1; i < uniq.length; i++) if (uniq[i] !== uniq[i - 1] + 1) holes.push(uniq[i - 1] + 1);
    (holes.length === 0)
      ? ok(`no-hole-across-the-raise-${label}`, `frames ${uniq[0]}..${uniq[uniq.length - 1]}, delay ${b.H.delay}`)
      : bad(`no-hole-across-the-raise-${label}`, `frame(s) ${JSON.stringify(holes)} were never queued — a hole is a permanent stall`);
    (dupes === 0)
      ? ok(`each-frame-queued-once-${label}`, `${sentFrames.length} sends, ${uniq.length} distinct`)
      : bad(`each-frame-queued-once-${label}`, `${dupes} frame(s) sent twice — two different pads for one frame`);
    return b;
  };
  const b1 = runRaise('host', false);
  is('the-raise-took-effect', b1.H.delay, 9);
  is('the-guest-adopted-the-same-delay', b1.A.delay, 9);
  runRaise('late', true);

  // A raise already agreed is RE-SENT, not re-decided: the relay loses
  // messages, and a lost lsdelay leaves the two consoles on two schedules.
  const c = room([{ id: 'H', host: true }, { id: 'A' }], { portCount: 2, delay: 4 });
  c.H.seat('H', 1); c.H.seat('A', 1);
  c.H.declareReady('g'); c.A.declareReady('g');
  const raises = [];
  c.H.on('delay', (e) => raises.push(e));
  const sent = [];
  const os = c.H._send; c.H._send = (m) => { if (m && m.t === 'lsdelay') sent.push(m); return os(m); };
  c.H._scheduleDelay(9); c.H._scheduleDelay(20); c.H._scheduleDelay(30);
  is('one-raise-is-decided-once', raises.length, 1);
  is('and-retransmitted-verbatim', sent.length, 3);
  eq('every-copy-names-the-same-frame-and-delay',
     sent.map((m) => [m.at, m.d]), [[sent[0].at, 9], [sent[0].at, 9], [sent[0].at, 9]]);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

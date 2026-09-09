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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

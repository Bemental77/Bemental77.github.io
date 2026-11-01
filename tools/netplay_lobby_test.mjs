#!/usr/bin/env node
// ---------------------------------------------------------------------------
// netplay_lobby_test.mjs - THE LOBBY / TRANSPORT GAPS, in Node (no browser).
//
// Same harness shape as tools/netplay_rejoin_session_test.mjs: real Sessions and
// real Lockstep engines, fake DataChannels/signalling, a virtual clock.
//
//   1. the start barrier has a watchdog: after `barrierTimeoutMs` with no progress it
//      names the missing seat ('barrier-stuck', lsbar.stuck); the host can drop that
//      seat (Session.kickPeer) and the room STARTS without them
//   2. a joiner that cannot boot says so (announceCannotBoot -> lscant): the host frees
//      the seat by itself and the room starts
//   3. "room is full" / "already started" are explicit replies, and the guest stops
//      knocking and shows them
//   4. a build id rides hello/ready: a mismatch is reported at KNOCK time, on both ends,
//      once; equal or missing stamps stay silent
//   5. link quality: classifyLinkStats (direct / stun / turn, Chrome + Firefox shapes),
//      Session.linkReport(), the 'link-relayed' warning, the broker path
//   6. the star fan-out: Session._relay stringifies ONCE per message and every forward is
//      the same string (so there is nothing to "stringify once" any more)
// USAGE  node tools/netplay_lobby_test.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(root, 'lib/netplay.js'), 'utf8'));
const { Session, Lockstep } = globalThis.Netplay;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let T = 0;
function chanPair(label) {
  const mk = () => ({ label, readyState: 'connecting', sent: [], onmessage: null, onopen: null, onclose: null, bufferedAmount: 0, cut: false });
  const a = mk(), b = mk();
  a.send = (s) => { a.sent.push(s); if (!a.cut && b.onmessage) b.onmessage({ data: s }); };
  b.send = (s) => { b.sent.push(s); if (!b.cut && a.onmessage) a.onmessage({ data: s }); };
  a.open = () => { a.readyState = 'open'; b.readyState = 'open'; if (a.onopen) a.onopen(); if (b.onopen) b.onopen(); };
  return [a, b];
}
function connect(H, G, nonce, pc) {
  const [hc, gc] = chanPair('play');
  const gLink = { nonce, approved: true, pc: pc || { close() {} } };
  const hLink = { nonce: '#host', approved: true, pc: { close() {} } };
  H._links.set(nonce, gLink); G._links.set('#host', hLink);
  H._bindChannel(hc, gLink); G._bindChannel(gc, hLink);
  hc.open();
  return { hc, gc, gLink, hLink };
}
// A 3-seat delay-lockstep room: host + two joiners, links up, nobody declared yet.
function room3(opts) {
  const mk = (host) => new Session(Object.assign({ game: 'g', host, code: 'AAAAA', transport: 'local', ui: false, portCount: 3 }, opts || {}));
  const H = mk(true), G1 = mk(false), G2 = mk(false);
  const sig = { H: [], G1: [], G2: [] };
  H._sig = { send: (m) => sig.H.push(m), close() {} };
  G1._sig = { send: (m) => sig.G1.push(m), close() {} };
  G2._sig = { send: (m) => sig.G2.push(m), close() {} };
  const o = { portCount: 3, padBytes: 2, hashEvery: 30, now: () => T, frameHz: 60, rollback: 0, delay: 3 };
  for (const S of [H, G1, G2]) S._lsOpts = Object.assign({}, o);
  H._known.add(G1._nonce); H._known.add(G2._nonce);
  const l1 = connect(H, G1, G1._nonce), l2 = connect(H, G2, G2._nonce);
  return { H, G1, G2, sig, l1, l2 };
}

console.log('=== 1. the barrier watchdog names the culprit; the host drops that seat and the room starts ===');
{
  const { H, G1, G2, l2 } = room3();
  const stuck = [];
  H.on('barrier-stuck', (e) => stuck.push(e));
  H.ls.declareReady('d'); G1.ls.declareReady('d');                 // G2 never declares (its core could not boot)
  const seat2 = H.ls.roster.indexOf(G2._nonce);
  ok('three-seated-two-declared', H.ls.roster.filter(Boolean).length === 3 && H.ls._bar && H.ls._bar.waitingFor.length === 1 && H.ls.state === 'waiting',
     `roster ${H.ls.roster.filter(Boolean).length}, waitingFor ${H.ls._bar && H.ls._bar.waitingFor.length}, state ${H.ls.state}`);
  ok('no-trip-before-the-timeout', H.ls.checkBarrierStall(T + 59000) === null && !stuck.length);
  // progress (a re-seat/leave changes who is missing) resets the clock: unseat+seat the same peer must not carry the old age
  const r = H.ls.checkBarrierStall(T + 61000);
  ok('trips-after-60s-naming-the-missing-seat', !!r && stuck.length === 1 && stuck[0].ports.length === 1 && stuck[0].ports[0] === seat2 && stuck[0].seconds >= 60,
     `stuck events ${stuck.length}, ports ${JSON.stringify(stuck[0] && stuck[0].ports)}, expected seat ${seat2}`);
  ok('trips-once', H.ls.checkBarrierStall(T + 90000) === null && stuck.length === 1);
  ok('lsbar-carries-stuck-to-the-other-joiner', !!(G1.ls._bar && G1.ls._bar.stuck) && G1.ls._bar.stuckFor.length === 1, JSON.stringify(G1.ls._bar && { stuck: G1.ls._bar.stuck, n: (G1.ls._bar.stuckFor || []).length }));
  // the host drops that seat
  const kicked = []; G2.on('kicked', (e) => kicked.push(e));
  const left = []; H.on('peer-left', (e) => left.push(e));
  ok('kickPeer-accepted', H.kickPeer(seat2, 'the host removed player 3: its game never loaded') === true);
  await sleep(450);
  ok('the-dropped-guest-is-told-and-closes', kicked.length === 1 && /never loaded/.test(kicked[0].why) && G2.state === 'closed', `kicked ${kicked.length}, G2 '${G2.state}', why "${kicked[0] && kicked[0].why}"`);
  ok('the-seat-is-freed-and-the-link-gone', H.ls.roster[seat2] == null && !H._links.has(G2._nonce) && left.length === 1 && left[0].why === 'kicked', `roster[${seat2}]=${H.ls.roster[seat2]}, links ${H._links.size}`);
  ok('the-room-STARTS-without-them', H.ls.state === 'running' && G1.ls.state === 'running', `host ${H.ls.state} guest ${G1.ls.state}`);
  ok('a-kicked-nonce-is-no-longer-auto-approved', !H._known.has(G2._nonce));
}
{
  // progress resets the watchdog
  const { H, G1 } = room3();
  H.ls.declareReady('d');
  T += 50000;
  G1.ls.declareReady('d');                                          // progress at t+50s: still waiting for G2, clock restarts
  ok('a-declare-restarts-the-clock', H.ls.checkBarrierStall(T + 59000) === null && H.ls.checkBarrierStall(T + 61000) !== null, 'trip measured from the LAST progress, not the first knock');
}
{
  // a host alone never trips (nobody to blame)
  const H = new Session({ game: 'g', host: true, code: 'AAAAA', transport: 'local', ui: false, portCount: 2 });
  H._sig = { send() {}, close() {} };
  H._lsOpts = { portCount: 2, padBytes: 2, now: () => T };
  H._ensureLockstep(); H.ls.declareReady('d');
  ok('alone-never-trips', H.ls.checkBarrierStall(T + 10 * 60000) === null && H.ls._bar.alone === true);
  const off = new Lockstep({ portCount: 2, padBytes: 2, host: true, peerId: 'h', barrierTimeoutMs: 0, now: () => T, send() {} });
  off.seat('h', 1); off.seat('g', 1); off.declareReady('d');
  ok('timeout-0-disables-it', off.checkBarrierStall(T + 10 * 60000) === null && off._barTimer === 0);
}

console.log('=== 2. a joiner that cannot boot says so; the host frees the seat ===');
{
  const { H, G1, G2 } = room3();
  const cant = [];
  H.on('peer-cannot-boot', (e) => cant.push(e));
  H.ls.declareReady('d'); G1.ls.declareReady('d');
  const seat2 = H.ls.roster.indexOf(G2._nonce);
  G2.announceCannotBoot('WebAssembly.Memory refused: RangeError ' + G2._nonce);
  ok('host-hears-it-with-the-seat', cant.length === 1 && cant[0].port === seat2 && /Memory refused/.test(cant[0].why), JSON.stringify(cant[0]));
  ok('the-reason-never-carries-a-nonce', !cant[0].why.includes(G2._nonce) && /a player/.test(cant[0].why));
  await sleep(450);
  ok('seat-freed-and-room-starts', H.ls.roster[seat2] == null && H.ls.state === 'running' && G1.ls.state === 'running', `host ${H.ls.state}, guest ${G1.ls.state}`);
  // a guest cannot forge the host's word
  const { H: H2, G1: Ga } = room3();
  Ga._onRoomMsg({ t: 'lskick', why: 'x', to: 'someone-else' }, { nonce: '#host' });
  ok('a-kick-addressed-to-someone-else-is-ignored', Ga.state !== 'failed' && Ga.state !== 'closed', `state ${Ga.state}`);
  H2.kickPeer('nobody');
}
{
  // after the game started a "cannot boot" is an event only: dropPeer/limp owns a running room
  const { H, G1, G2 } = room3();
  H.ls.declareReady('d'); G1.ls.declareReady('d'); G2.ls.declareReady('d');
  const cant = []; H.on('peer-cannot-boot', (e) => cant.push(e));
  const started = H.ls.state === 'running';
  G2.announceCannotBoot('late failure');
  await sleep(450);
  ok('mid-game-it-is-reported-but-nobody-is-kicked', started && cant.length === 1 && H._links.has(G2._nonce) && H.kickPeer(2) === false, `running ${started}, events ${cant.length}`);
}

console.log('=== 3. explicit "room is full" / "already started" replies, and the guest stops knocking ===');
{
  const H = new Session({ game: 'g', host: true, code: 'AAAAA', transport: 'local', ui: false, portCount: 2 });
  const sig = []; H._sig = { send: (m) => sig.push(m), close() {} };
  H._lsOpts = { portCount: 2, padBytes: 2, now: () => T };
  H._links.set('occupied', { nonce: 'occupied', approved: true, open: true, pc: { close() {} } });   // the one guest seat is taken
  await H._onSignal({ t: 'hello', proto: 2, game: 'g', n: 'late-guest', inc: 'i' });
  const d = sig[sig.length - 1];
  ok('full-room-says-so', d && d.t === 'denied' && d.to === 'late-guest' && /room is full/.test(d.why), JSON.stringify(d));
  const G = new Session({ game: 'g', host: false, code: 'AAAAA', transport: 'local', ui: false });
  G._sig = { send() {}, close() {} };
  G._sendHello();
  ok('guest-is-knocking', !!G._helloTimer);
  await G._onSignal({ t: 'denied', to: G._nonce, why: d.why });
  ok('guest-stops-knocking-and-shows-the-reason', !G._helloTimer && G.state === 'failed' && /room is full/.test(G.lastError), `state ${G.state} "${G.lastError}"`);
  const { H: H3, sig: s3 } = room3();
  H3.ls.declareReady('d');
  const G4 = new Session({ game: 'g', host: false, code: 'AAAAA', transport: 'local', ui: false, portCount: 3 });
  const L4 = connect(H3, G4, G4._nonce);
  H3.ls.declareReady('d');
  for (const ls of [H3.ls]) { ls.state = 'running'; }
  await H3._onSignal({ t: 'hello', proto: 2, game: 'g', n: 'stranger', inc: 'z' });
  const d2 = s3.H[s3.H.length - 1];
  ok('started-room-says-so', d2 && d2.t === 'denied' && /already started/.test(d2.why), JSON.stringify(d2 && { why: d2.why }));
}

console.log('=== 4. the build id rides hello/ready ===');
{
  const A = 'p2|netplay.js=aaaa1111,room_core.js=r1';
  const mkH = (b) => { const H = new Session({ game: 'g', host: true, code: 'AAAAA', transport: 'local', ui: false, build: b }); const sig = []; H._sig = { send: (m) => sig.push(m), close() {} }; return { H, sig }; };
  const { H, sig } = mkH(A);
  const ev = []; H.on('build-mismatch', (e) => ev.push(e));
  await H._onSignal({ t: 'hello', proto: 2, build: 'p2|netplay.js=bbbb2222,room_core.js=r1', game: 'g', n: 'j1', inc: 'i' });
  ok('host-is-told-at-knock-time', ev.length === 1 && ev[0].host === true && ev[0].names.join() === 'netplay.js' && /Reload this page/.test(ev[0].text), JSON.stringify(ev[0] && { names: ev[0].names, host: ev[0].host }));
  ok('and-still-answers-the-hello-it-is-a-warning-not-a-refusal', sig.some((m) => m.t === 'ready' && m.to === 'j1' && m.build === A), 'ready carries the host build');
  await H._onSignal({ t: 'hello', proto: 2, build: 'p2|netplay.js=bbbb2222', game: 'g', n: 'j1', inc: 'i' });
  ok('reported-once-per-joiner', ev.length === 1);
  ok('roomInfo-carries-it', !!H.roomInfo().buildMismatch);
  const q = mkH(A); const e2 = []; q.H.on('build-mismatch', (e) => e2.push(e));
  await q.H._onSignal({ t: 'hello', proto: 2, build: A, game: 'g', n: 'j2', inc: 'i' });
  await q.H._onSignal({ t: 'hello', proto: 2, game: 'g', n: 'j3', inc: 'i' });                 // an OLD page: no build field
  await q.H._onSignal({ t: 'hello', proto: 2, build: 'p2|other.js=zzz', game: 'g', n: 'j4', inc: 'i' });   // no script in common
  ok('equal-missing-or-disjoint-stamps-stay-silent', e2.length === 0, `events ${e2.length}`);
  // the guest side
  const G = new Session({ game: 'g', host: false, code: 'AAAAA', transport: 'local', ui: false, build: 'p2|netplay.js=old' });
  const gs = []; G._sig = { send: (m) => gs.push(m), close() {} };
  const e3 = []; G.on('build-mismatch', (e) => e3.push(e));
  G._sendHello();
  ok('hello-carries-the-build', gs[0] && gs[0].t === 'hello' && gs[0].build === 'p2|netplay.js=old');
  clearInterval(G._helloTimer);
  await G._onSignal({ t: 'ready', to: G._nonce, chal: 'c', hp: 'x', proto: 2, build: 'p2|netplay.js=new', game: 'g' });
  ok('guest-is-told-the-host-differs', e3.length === 1 && e3[0].host === false && /The host is on a different build/.test(e3[0].text), JSON.stringify(e3[0] && e3[0].names));
  const N = globalThis.Netplay;
  ok('buildsDiffer-protocol', N.buildsDiffer('p2|a.js=1', 'p3|a.js=1') === true && N.buildsDiffer('p2', 'p2') === false && N.buildsDiffer('', 'p2|a.js=1') === false);
  ok('buildStamp-outside-a-page-is-just-the-protocol', N.buildStamp() === 'p' + N.PROTO, N.buildStamp());
}

console.log('=== 5. connection quality ===');
{
  const N = globalThis.Netplay;
  const rep = (arr) => new Map(arr.map((s) => [s.id, s]));
  const chrome = (lt, rt, rtt) => rep([
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: rtt },
    { id: 'L', type: 'local-candidate', candidateType: lt, protocol: 'udp' }, { id: 'R', type: 'remote-candidate', candidateType: rt, protocol: 'udp' }]);
  const c1 = N.classifyLinkStats(chrome('host', 'host', 0.004));
  ok('direct-lan', c1.kind === 'direct' && c1.rttMs === 4 && c1.proto === 'udp', JSON.stringify(c1));
  ok('stun-reflexive-either-side', N.classifyLinkStats(chrome('srflx', 'host', 0.03)).kind === 'stun' && N.classifyLinkStats(chrome('host', 'prflx', 0.03)).kind === 'stun');
  ok('turn-relay-either-side', N.classifyLinkStats(chrome('relay', 'srflx', 0.12)).kind === 'turn' && N.classifyLinkStats(chrome('host', 'relay', 0.12)).kind === 'turn');
  const ff = rep([{ id: 'P', type: 'candidate-pair', state: 'succeeded', selected: true, nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' },
                  { id: 'L', type: 'local-candidate', candidateType: 'srflx' }, { id: 'R', type: 'remote-candidate', candidateType: 'srflx' }]);
  const c2 = N.classifyLinkStats(ff);
  ok('firefox-shape-no-selectedCandidatePairId-and-no-rtt-is-null-not-zero', c2.kind === 'stun' && c2.rttMs === null, JSON.stringify(c2));
  ok('no-pair-yet-is-null', N.classifyLinkStats(rep([{ id: 'x', type: 'transport' }])) === null && N.classifyLinkStats(null) === null);

  // a host with two guests, one direct and one on a TURN relay
  const { H, G1, G2, l1, l2 } = room3();
  l1.gLink.open = true; l2.gLink.open = true; l1.gLink.pc.getStats = async () => chrome('host', 'host', 0.002); l2.gLink.pc.getStats = async () => chrome('relay', 'srflx', 0.2);
  const ev = [], rel = []; H.on('link-quality', (e) => ev.push(e)); H.on('link-relayed', (e) => rel.push(e));
  await H._pollLinks();
  const rows = H.linkReport();
  ok('host-sees-both-links-by-seat', rows.length === 2 && rows[0].port === 1 && rows[0].kind === 'direct' && rows[1].port === 2 && rows[1].kind === 'turn' && rows[1].rttMs === 200 && rows[1].relayed === true, JSON.stringify(rows.map((r) => [r.port, r.kind, r.rttMs])));
  ok('no-nonce-in-the-report', !JSON.stringify(rows).includes(G1._nonce) && !JSON.stringify(H.roomInfo().linkQuality).includes(G2._nonce));
  ok('the-host-is-warned-about-the-relayed-link-once', rel.length === 1 && rel[0].port === 2 && /player 3/.test(rel[0].text) && /expect lag/.test(rel[0].text), JSON.stringify(rel));
  await H._pollLinks();
  ok('polling-again-does-not-repeat-the-warning', rel.length === 1 && ev.length === 2);
  // the broker relay (no peer connection at all)
  l1.gLink.relay = true; H.relay = { active: true, oneWayMs: 90, since: Date.now() };
  const r2 = H.linkReport().find((r) => r.port === 1);
  ok('broker-relay-is-reported-with-its-own-rtt', r2.kind === 'broker' && r2.relayed === true && r2.rttMs === 180, JSON.stringify(r2));
  clearInterval(H._linkPoll);
  const w = []; H.on('link-relayed', (e) => w.push(e)); H._noteLinkKind(l1.gLink, 'broker');
  ok('broker-warning-names-the-slow-channel', w.length === 1 && /signalling broker/.test(w[0].text), w[0] && w[0].text);
  // the guest's view
  G1._linkPoll && clearInterval(G1._linkPoll);
  const gl = G1._links.get('#host'); gl.open = true; gl.q = { kind: 'stun', rttMs: 41, local: 'srflx', remote: 'srflx', proto: 'udp' };
  const gr = G1.linkReport();
  ok('guest-reports-its-one-link-as-the-host-seat', gr.length === 1 && gr[0].port === 0 && gr[0].kind === 'stun' && gr[0].rttMs === 41, JSON.stringify(gr));
  for (const S of [H, G1, G2]) { if (S._linkPoll) clearInterval(S._linkPoll); }
}

console.log('=== 6. the 3-4 player star: _relay stringifies once and every forward is the same string ===');
for (const N of [2, 3, 4]) {
  const H = new Session({ game: 'g', host: true, code: 'AAAAA', transport: 'local', ui: false, portCount: N });
  const outs = [];
  for (let i = 0; i < N - 1; i++) H._links.set('g' + i, { nonce: 'g' + i, approved: true, open: true, dc: { readyState: 'open', send: (s) => outs.push([i, s]) } });
  const from = H._links.get('g0');
  const m = { t: 'ls', f: 1234, i: [[1, [3, 4]]], peer: 'g0', wr: [[1231, 3, 0]] };
  const real = JSON.stringify; let calls = 0;
  JSON.stringify = function () { calls++; return real.apply(this, arguments); };
  try { H._relay(m, from); } finally { JSON.stringify = real; }
  ok(`N=${N}: ${N - 2} forward(s), ${calls} stringify call(s) (<=2: message + one lean copy at most), identical wire`,
     outs.length === N - 2 && calls <= 2 && outs.every(([, s]) => s === real(m) || s === outs[0][1]) && (N < 3 || outs.every(([, s]) => s === outs[0][1])),
     `forwards ${outs.length}, stringify calls ${calls}`);
}

console.log(`\n[lobby] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

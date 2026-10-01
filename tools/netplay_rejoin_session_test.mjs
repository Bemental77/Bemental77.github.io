#!/usr/bin/env node
// ---------------------------------------------------------------------------
// netplay_rejoin_session_test.mjs — THE SESSION HALF OF "A DEAD LINK REJOINS",
// in Node, with fake RTCPeerConnections/DataChannels/signalling (the harness
// shape of tools/netplay_lsu_test.mjs) and a virtual clock driving two real
// Lockstep engines frame by frame.
//
// A link dead for longer than DISCONNECT_GRACE_MS used to close both sessions;
// a re-knock was refused "this room has already started"; a re-admitted link
// would have been re-seat()ed mid-game. Asserted here:
//   1. in an adaptive rollback room, neither session closes when the link dies:
//      the guest re-knocks, the host keeps the room (its engine drops the
//      guest's controller and plays on);
//   2. the host answers a hello from a KNOWN, SEATED player in a running
//      rollback room (a challenge, not 'denied'), and still refuses a stranger
//      ("already started") and a seated player of a DELAY room (which cannot
//      take anyone back) — saying which;
//   3. the re-admitted link is not re-seated (no 'barrier-failed'), the roster
//      goes out on it, and the engines take the player back (host 'rejoin'),
//      with fingerprints compared afterwards and 0 desyncs;
//   4. a guest whose engine has given up stops knocking and closes;
//   5. a delay-lockstep room keeps its old behaviour: the sessions close.
// The real-browser proof is tools/netplay_rejoin_browser_test.mjs.
// USAGE  node tools/netplay_rejoin_session_test.mjs
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(root, 'lib/netplay.js'), 'utf8'));
const { Session } = globalThis.Netplay;
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); } };
const settle = () => new Promise((r) => setTimeout(r, 5));

let T = 0;
const F = 1000 / 60;
function chanPair(label) {
  const mk = () => ({ label, readyState: 'connecting', sent: [], onmessage: null, onopen: null, onclose: null, bufferedAmount: 0, cut: false });
  const a = mk(), b = mk();
  a.send = (s) => { a.sent.push(s); if (!a.cut && b.onmessage) b.onmessage({ data: s }); };
  b.send = (s) => { b.sent.push(s); if (!b.cut && a.onmessage) a.onmessage({ data: s }); };
  a.open = () => { a.readyState = 'open'; b.readyState = 'open'; if (a.onopen) a.onopen(); if (b.onopen) b.onopen(); };
  return [a, b];
}
// Bind one host<->guest link (a fresh "peer connection"), open it.
function connect(H, G, nonce) {
  const [hc, gc] = chanPair('play');
  const gLink = { nonce, approved: true, pc: { close() {} } };
  const hLink = { nonce: '#host', approved: true, pc: { close() {} } };
  H._links.set(nonce, gLink); G._links.set('#host', hLink);
  H._bindChannel(hc, gLink); G._bindChannel(gc, hLink);
  hc.open();
  return { hc, gc, gLink, hLink };
}
function room(rollback) {
  const H = new Session({ game: 'g', host: true, code: 'AAAAA', transport: 'local', ui: false });
  const G = new Session({ game: 'g', host: false, code: 'AAAAA', transport: 'local', ui: false });
  const nonce = G._nonce;
  const sig = { H: [], G: [] };
  H._sig = { send: (m) => sig.H.push(m), close() {} };
  G._sig = { send: (m) => sig.G.push(m), close() {} };
  const o = { portCount: 2, padBytes: 2, hashEvery: 30, now: () => T, frameHz: 60 };
  if (rollback) Object.assign(o, { rollback, rollbackOk: true, rbCatchUp: true, selfStepMs: 1.5 });
  else Object.assign(o, { rollback: 0, delay: 3 });
  H._lsOpts = Object.assign({}, o); G._lsOpts = Object.assign({}, o);
  H._known.add(nonce);                       // a human let this guest in
  const link = connect(H, G, nonce);
  H.ls.declareReady('d'); G.ls.declareReady('d');
  return { H, G, nonce, sig, link };
}
// One display tick for one console: hidden catch-up frames, then one frame.
function tick(S, pad) {
  const ls = S.ls;
  if (!ls || (ls.state !== 'running' && ls.state !== 'stalled')) return;
  const run = (hidden) => {
    const pads = {}; for (const p of ls.localPorts) pads[p] = new Uint8Array([pad & 0xff, 0]);
    const r = ls.beginFrame(pads, hidden ? { hidden: true } : undefined);
    if (!r.ready) return false;
    if (!S.__st) { S.__st = new Map(); S.__st.set(0, 7); }   // the start of frame 0
    let st = r.rollback ? S.__st.get(r.rollback.from) : null;
    if (r.rollback) for (const fr of r.rollback.frames) { st = ((st * 31) ^ fr.image[0] ^ (fr.image[2] << 8) ^ fr.frame) >>> 0; S.__st.set(fr.frame + 1, st); }
    const start = S.__st.get(r.frame);
    const nx = ((start * 31) ^ r.image[0] ^ (r.image[2] << 8) ^ r.frame) >>> 0;
    S.__st.set(r.frame + 1, nx);
    ls.endFrame(!ls.rollback && ls.wantsHash(r.frame) ? nx : null);
    for (const k of (ls.takeHashDue ? ls.takeHashDue() : [])) ls.submitHash(k, S.__st.get(k + 1));
    return true;
  };
  // as genesis.html loop(): a console a rejoin-sized gap behind runs every frame
  // hidden; rbCatchUp() grants the extra hidden frames
  const rejoining = !!(ls.rollback && ls.rbRejoining && ls.rbRejoining());
  if (ls.rollback && ls.rbCatchUp) { const n = ls.rbCatchUp(); for (let i = 0; i < n; i++) if (!run(true)) break; }
  run(rejoining);
}
function play(H, G, ms, gAlive = true) {
  const end = T + ms;
  while (T < end) { T += F; tick(H, (T / 97) | 0); if (gAlive) tick(G, (T / 131) | 0); }
}
const lastSig = (arr, t) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].t === t) return arr[i]; return null; };

console.log('=== a dead link in a running room: the session half ===');
{
  const { H, G, nonce, sig, link } = room(8);
  play(H, G, 3000);
  ok('the-room-runs-rollback', H.ls.state === 'running' && G.ls.rollback > 0 && G.ls.frame > 120, `host f${H.ls.frame} guest f${G.ls.frame} window ${G.ls.rollback}`);
  const ev = { H: [], G: [] };
  H.on('close', () => ev.H.push('close')); G.on('close', () => ev.G.push('close'));
  H.ls.on('barrier-failed', (e) => ev.H.push('barrier-failed: ' + (e && e.error)));
  H.ls.on('rejoin', (e) => ev.H.push('rejoin@' + e.at));
  // ---- the link dies: nothing flows, then each side declares it gone ------
  link.hc.cut = true; link.gc.cut = true;
  play(H, G, 3000, false);
  G._linkGone(link.hLink, 'disconnected');
  H._linkGone(link.gLink, 'disconnected');
  ok('the-guest-re-knocks-instead-of-closing', G.state === 'signalling' && !ev.G.includes('close') && !!lastSig(sig.G, 'hello'),
     `guest session '${G.state}', hello sent: ${!!lastSig(sig.G, 'hello')}, closed: ${ev.G.includes('close')}`);
  ok('the-host-keeps-the-room-open', H.state === 'signalling' && !ev.H.includes('close') && H.ls.dropped.size === 1,
     `host session '${H.state}', its engine dropped port(s) ${JSON.stringify([...H.ls.dropped.keys()])}, closed: ${ev.H.includes('close')}`);
  play(H, G, 9000, false);                    // dead for ~12 s in all
  ok('the-host-played-on-alone', H.ls.state === 'running' || H.ls.state === 'stalled', `host engine ${H.ls.state} at f${H.ls.frame}`);
  // ---- the hello is answered -------------------------------------------------
  await H._onSignal({ t: 'hello', proto: 2, game: 'g', n: nonce, inc: G._inc });
  const ans = sig.H[sig.H.length - 1];
  ok('the-host-answers-a-known-seated-player', ans && ans.t === 'ready' && ans.to === nonce, JSON.stringify(ans && { t: ans.t, to: ans.to, why: ans.why }));
  await H._onSignal({ t: 'hello', proto: 2, game: 'g', n: 'a-stranger', inc: 'x' });
  const st = sig.H[sig.H.length - 1];
  ok('a-stranger-is-still-refused', st && st.t === 'denied' && /already started/.test(st.why || ''), JSON.stringify(st && { t: st.t, why: st.why }));
  // ---- re-admitted: a fresh link, no re-seat, the engines take them back ----
  H._pending = null;                          // (the admission handshake itself is the browser test's)
  const L2 = connect(H, G, nonce);
  ok('no-reseat-mid-game', !ev.H.some((e) => /^barrier-failed/.test(e)) && L2.hc.sent.some((s) => JSON.parse(s).t === 'lsroster'),
     `host events ${JSON.stringify(ev.H)}; roster sent on the new link: ${L2.hc.sent.some((s) => JSON.parse(s).t === 'lsroster')}`);
  ok('both-sessions-connected-again', H.state === 'connected' && G.state === 'connected' && !G._rejoining, `host '${H.state}' guest '${G.state}'`);
  const c0 = H.ls.report().hashesCompared;
  play(H, G, 12000);
  const rh = H.ls.report(), rg = G.ls.report();
  ok('the-engines-take-the-player-back', ev.H.some((e) => /^rejoin@/.test(e)) && H.ls.dropped.size === 0 && G.ls.dropped.size === 0,
     `host events ${JSON.stringify(ev.H)}; dropped host ${H.ls.dropped.size} guest ${G.ls.dropped.size}; guest f${G.ls.frame} host f${H.ls.frame}`);
  ok('zero-desyncs-and-fingerprints-compared-after', rh.state !== 'desync' && rg.state !== 'desync' && !rh.desync && !rg.desync
       && rh.hashesCompared > c0 + 5 && rh.lastAgreedFrame > rh.frame - 120,
     `host ${rh.state} guest ${rg.state}; compared ${c0} -> ${rh.hashesCompared}; last agreed ${rh.lastAgreedFrame} (host f${rh.frame})`);
}
{
  // a guest whose engine gives up stops knocking
  const { H, G, link } = room(8);
  play(H, G, 2000);
  let closed = false; G.on('close', () => { closed = true; });
  link.hc.cut = true; link.gc.cut = true;
  G._linkGone(link.hLink, 'disconnected');
  const knocking = G.state === "signalling" && !!G._rejoining;
  G.ls.fail('no input from player 1 (the host) for 30s');
  G._sendHello();
  ok('a-guest-whose-game-gave-up-stops-knocking', knocking && closed && G.state === 'closed',
     `knocking before: ${knocking} (session '${G.state}'), close emitted: ${closed}`);
}
{
  // a DELAY-lockstep room cannot take anyone back: it keeps the old behaviour
  const { H, G, nonce, sig, link } = room(0);
  play(H, G, 2000);
  const closed = { H: false, G: false };
  H.on('close', () => { closed.H = true; }); G.on('close', () => { closed.G = true; });
  link.hc.cut = true; link.gc.cut = true;
  G._linkGone(link.hLink, 'disconnected');
  H._linkGone(link.gLink, 'disconnected');
  ok('a-delay-room-still-closes', closed.G && closed.H, `guest closed ${closed.G}, host closed ${closed.H}`);
  H.state = 'connected';                      // (a host with other players still in it)
  await H._onSignal({ t: 'hello', proto: 2, game: 'g', n: nonce, inc: G._inc });
  const d = sig.H[sig.H.length - 1];
  ok('a-delay-room-says-why-it-cannot-take-them-back', d && d.t === 'denied' && /input delay/.test(d.why || ''), JSON.stringify(d && { t: d.t, why: d.why }));
}
console.log(`\n[rejoin-session] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

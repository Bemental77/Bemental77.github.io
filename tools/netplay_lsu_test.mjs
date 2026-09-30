#!/usr/bin/env node
// ---------------------------------------------------------------------------
// THE UNRELIABLE INPUT CHANNEL ('lsu') — negotiation and routing, with fake
// RTCPeerConnections and channels, in Node. No browser.
//
// lib/netplay.js Session: each side announces 'lscap' on its reliable channel
// when it opens; a HOST that hears it opens an unordered, maxRetransmits:0
// channel labelled 'lsu' to that guest; 'ls' input then rides it, while every
// other message (and a NAK answer, `rel`) stays on the reliable channel. An
// older peer never announces, never gets 'lsu', and is served exactly as before.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
(0, eval)(fs.readFileSync(path.join(root, 'lib/netplay.js'), 'utf8'));
const { Session } = globalThis.Netplay;
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? ' — ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + ' — ' + d); };

// A fake channel pair: send on one is delivered to the other's onmessage.
function chanPair(label, opts) {
  const a = { label, opts, readyState: 'connecting', sent: [], onmessage: null, onopen: null, onclose: null, bufferedAmount: 0 };
  const b = { label, opts, readyState: 'connecting', sent: [], onmessage: null, onopen: null, onclose: null, bufferedAmount: 0 };
  a.peer = b; b.peer = a;
  a.send = (s) => { a.sent.push(s); if (b.onmessage) b.onmessage({ data: s }); };
  b.send = (s) => { b.sent.push(s); if (a.onmessage) a.onmessage({ data: s }); };
  a.open = () => { a.readyState = 'open'; b.readyState = 'open'; if (a.onopen) a.onopen(); if (b.onopen) b.onopen(); };
  return [a, b];
}
function pair({ guestAnnounces = true } = {}) {
  const H = new Session({ game: 'g', host: true, code: 'AAAAA', transport: 'local', ui: false });
  const G = new Session({ game: 'g', host: false, code: 'AAAAA', transport: 'local', ui: false });
  const [hc, gc] = chanPair('play', { ordered: true });
  // the host side's link, with a pc that can open more channels to the guest
  const gLink = { nonce: 'guestnonce', approved: true };
  const hLink = { nonce: '#host', approved: true };
  const opened = [];
  gLink.pc = { createDataChannel: (label, o) => {
    const [x, y] = chanPair(label, o); opened.push(x);
    // the guest learns of it through ondatachannel, as a browser does
    hLink.pc.ondatachannel({ channel: y });
    setTimeout(() => x.open(), 0);
    return x;
  } };
  hLink.pc = { ondatachannel: (e) => {
    if (e.channel.label === 'lsu') G._bindUnreliable(e.channel, hLink); else G._bindChannel(e.channel, hLink);
  } };
  H._links.set(gLink.nonce, gLink);
  G._links.set(hLink.nonce, hLink);
  H._bindChannel(hc, gLink);
  if (!guestAnnounces) { const s0 = gc.send; gc.send = (s) => { if (JSON.parse(s).t === 'lscap') return; s0(s); }; }
  G._bindChannel(gc, hLink);
  hc.open();
  return { H, G, hc, gc, gLink, hLink, opened };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

{
  const { H, G, hc, gc, gLink, hLink, opened } = pair();
  await tick(); await tick();
  (opened.length === 1 && opened[0].label === 'lsu' && opened[0].opts.ordered === false && opened[0].opts.maxRetransmits === 0)
    ? ok('the-host-opens-an-unordered-unreliable-lsu-to-a-guest-that-announced', JSON.stringify(opened[0] && opened[0].opts))
    : bad('the-host-opens-an-unordered-unreliable-lsu-to-a-guest-that-announced', JSON.stringify(opened.map((c) => c.label)));
  (gLink.dcu && gLink.dcu.readyState === 'open' && hLink.dcu && hLink.dcu.readyState === 'open')
    ? ok('both-ends-bind-it') : bad('both-ends-bind-it', `host dcu ${gLink.dcu && gLink.dcu.readyState}, guest dcu ${hLink.dcu && hLink.dcu.readyState}`);
  // input goes on lsu, control stays reliable
  const hlsu = gLink.dcu, glsu = hLink.dcu;
  const n0 = hc.sent.length, u0 = hlsu.sent.length;
  H._send({ t: 'ls', f: 5, i: [[0, 'AAA=']], peer: 'h' });
  H._send({ t: 'lsdelay', at: 9, d: 4 });
  H._send({ t: 'ls', f: 6, i: [[0, 'AAA=']], peer: 'h', rel: 1 });
  const onU = hlsu.sent.slice(u0).map((x) => JSON.parse(x)), onR = hc.sent.slice(n0).map((x) => JSON.parse(x));
  (onU.length === 1 && onU[0].f === 5 && onR.length === 2 && onR[0].t === 'lsdelay' && onR[1].rel === 1)
    ? ok('input-rides-lsu-control-and-nak-answers-stay-reliable', `lsu: ${onU.map((m) => m.t + '@' + m.f)}; reliable: ${onR.map((m) => m.t)}`)
    : bad('input-rides-lsu-control-and-nak-answers-stay-reliable', `lsu ${JSON.stringify(onU)} reliable ${JSON.stringify(onR)}`);
  const g0 = gc.sent.length, gu0 = glsu.sent.length;
  G._send({ t: 'ls', f: 5, i: [[1, 'AAA=']], peer: 'g' });
  (glsu.sent.length === gu0 + 1 && gc.sent.length === g0)
    ? ok('the-guest-sends-its-input-on-lsu-too') : bad('the-guest-sends-its-input-on-lsu-too', `lsu +${glsu.sent.length - gu0}, reliable +${gc.sent.length - g0}`);
  // only input is accepted on lsu
  let routed = 0; const orig = G._onData.bind(G); G._onData = (m, L) => { routed++; return orig(m, L); };
  hlsu.send(JSON.stringify({ t: 'lsgo', delay: 3 }));
  (routed === 0) ? ok('lsu-refuses-anything-but-input') : bad('lsu-refuses-anything-but-input', 'an lsgo arriving on lsu was dispatched');
}
{
  const { opened, gLink, hc } = pair({ guestAnnounces: false });
  await tick(); await tick();
  const H2 = null;
  (opened.length === 0 && !gLink.dcu) ? ok('an-older-guest-that-never-announces-gets-no-lsu') : bad('an-older-guest-that-never-announces-gets-no-lsu', opened.length + ' opened');
}
{
  // a closed lsu falls back to the reliable channel
  const { H, hc, gLink } = pair();
  await tick(); await tick();
  gLink.dcu.readyState = 'closed';
  const n0 = hc.sent.length;
  H._send({ t: 'ls', f: 7, i: [[0, 'AAA=']], peer: 'h' });
  (hc.sent.length === n0 + 1) ? ok('a-closed-lsu-falls-back-to-the-reliable-channel') : bad('a-closed-lsu-falls-back-to-the-reliable-channel', 'input was not sent reliably');
}
console.log(`\n[lsu] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

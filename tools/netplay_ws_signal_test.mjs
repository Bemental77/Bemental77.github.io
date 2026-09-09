#!/usr/bin/env node
// ============================================================================
// netplay_ws_signal_test.mjs — DOES THE WEBSOCKET SIGNALLING RELAY ACTUALLY
//                              PAIR TWO BROWSERS, AND WHAT DOES IT LEAK?
// ============================================================================
//
// WHY THIS EXISTS. Two real devices — a PC and a phone on DIFFERENT networks —
// deadlocked on production: both rosters showed the other seat "open", frame 0,
// core ran 0, no approval prompt, no error. The joiner's hello never reached the
// host. The cause is that SIGNALLING ITSELF RODE WEBRTC: a peerjs
// DataConnection is a WebRTC connection, so `peer.connect(base + '-h')` needed
// NAT traversal BEFORE the game connection was ever attempted, and with every
// public TURN server dead (see the ICE block in lib/netplay.js) a pair that
// could not go direct had nothing to fall back on. It was invisible on this
// machine because two Chrome profiles on one box SHARE A NAT.
//
// The 'ws' transport carries the handshake over ordinary WSS to a public MQTT
// broker instead. This file measures three separate things about it:
//
//   1. IT PAIRS. Two isolated browser contexts, the real broker, real approval.
//   2. IT IS NAT-INDEPENDENT. The pairing arm is re-run with the direct path
//      DELIBERATELY BROKEN — iceTransportPolicy:'relay' with no relay
//      configured, the same trick tools/netplay_relay_check.mjs uses — which
//      is the arm a WebRTC-borne signalling channel MUST fail. If the
//      handshake still completes there, the signalling really does not depend
//      on the two networks reaching each other.
//   3. WHAT AN EAVESDROPPER SEES. A public MQTT topic is readable by anyone,
//      so this taps window.WebSocket and reads every byte the page actually
//      puts on the wire, then asserts the room code and the SDP are not in it.
//      That is the strongest form of the claim available: not "the code says
//      it derives a topic" but "the bytes do not contain the code".
//
// ⚠ WHAT THIS STILL DOES NOT PROVE. Both contexts are on ONE machine, so arm 1
// alone would be satisfied by anything at all. Arm 2 is the one that carries
// the argument, and even it is a simulation of a hostile network rather than a
// second network. Only two real devices can close that, which is the rig
// tools/netplay_realui_pair_test.mjs --url=https://caseybement.com drives.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # mandatory gate
//   npm run web                                           # port 8080, gate #2
//   node tools/netplay_ws_signal_test.mjs
//   WS_QUIET=1 node tools/netplay_ws_signal_test.mjs      # + the 35 s wrong-code arm
// ============================================================================
import puppeteer from 'puppeteer';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok = (n, d) => { res.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);

const browser = await puppeteer.launch({
  headless: 'new', executablePath: CHROME, args: ['--no-sandbox'],
});
try { (await import('/Users/caseybement/Bemental77.github.io/tools/browser_leak_guard.js')).default.guard(browser, 'ws_signal_test'); } catch (_e) {}

// ⚠ THE TAP GOES IN BEFORE lib/netplay.js LOADS, or the transport captures the
// real constructor first and every frame is invisible to us. It records the
// bytes as latin1 so a binary MQTT frame is searchable as text: the topic and
// the base64 payload are both ASCII inside it.
const TAP = () => {
  window.__wsUrls = [];
  window.__wsOut = [];
  window.__wsIn = [];
  const Real = window.WebSocket;
  const dec = (d) => {
    try {
      if (typeof d === 'string') return d;
      const u = d instanceof ArrayBuffer ? new Uint8Array(d) : (d && d.buffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null);
      if (!u) return '';
      let s = '';
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return s;
    } catch (e) { return ''; }
  };
  function Tapped(url, proto) {
    const w = proto === undefined ? new Real(url) : new Real(url, proto);
    window.__wsUrls.push(String(url));
    const send = w.send.bind(w);
    w.send = (d) => { window.__wsOut.push(dec(d)); return send(d); };
    w.addEventListener('message', (e) => { window.__wsIn.push(dec(e.data)); });
    return w;
  }
  Tapped.prototype = Real.prototype;
  Tapped.OPEN = Real.OPEN; Tapped.CLOSED = Real.CLOSED;
  Tapped.CONNECTING = Real.CONNECTING; Tapped.CLOSING = Real.CLOSING;
  window.WebSocket = Tapped;
};

// `breakDirect` forces iceTransportPolicy:'relay' with no relay configured, so
// NO RTCPeerConnection on the page can ever find a path. A transport that
// signals over WebRTC cannot survive it; one that signals over WSS must not
// notice.
const mk = async (breakDirect) => {
  // puppeteer renamed this; support both so the rig is not version-pinned.
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('    [pageerror]', String(e).slice(0, 200)));
  await p.evaluateOnNewDocument(TAP);
  if (breakDirect) {
    await p.evaluateOnNewDocument(() => {
      const Real = window.RTCPeerConnection;
      window.__iceCfg = null;
      function Broken(cfg) {
        const c = Object.assign({}, cfg, { iceTransportPolicy: 'relay' });
        window.__iceCfg = c;
        return new Real(c);
      }
      Broken.prototype = Real.prototype;
      window.RTCPeerConnection = Broken;
    });
  }
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return { ctx, page: p };
};

const boot = (p, isHost, code, transport) => p.evaluate(async (code, isHost, transport) => {
  window.__log = [];
  window.__req = null;
  const s = new Netplay.Session({ game: 'wsrig', host: isHost, code, transport: transport || 'ws', delayFrames: 0 });
  window.__s = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  // The page approves from its own handler — the built-in dialog is not
  // clicked here, because what is under test is the TRANSPORT, and a human is
  // still the gate either way.
  if (isHost) s.on('join-request', (r) => { window.__req = { id: r.id, sas: r.sas }; r.approve(); });
  return await s.start();
}, code, isHost, transport);

const read = (p) => p.evaluate(() => ({
  state: window.__s.state,
  relay: window.__s.relay ? { active: !!window.__s.relay.active, oneWayMs: window.__s.relay.oneWayMs } : null,
  err: window.__s.lastError,
  kind: window.__s._sig && window.__s._sig.kind,
  url: window.__s._sig && window.__s._sig.url,
  log: window.__log,
  req: window.__req,
  sas: window.__s.sas,
}));

// ⚠ `reqMs` IS THE NUMBER THAT MEANS ANYTHING, and it is separate from the
// loop's own runtime on purpose. The first version of this rig reported the
// whole wait — 26 s — next to "the hello crossed", which reads as though
// pairing took 26 s. It did not: the loop was still waiting for a GAME link
// that, in the broken-path arm, is never going to come up. Time the event, not
// the wait for the next one.
const waitPair = async (h, g, ms) => {
  const t0 = Date.now();
  let a, b, reqMs = null;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 250));
    a = await read(h); b = await read(g);
    if (reqMs === null && a.req) reqMs = Date.now() - t0;
    if (a.state === 'failed' || b.state === 'failed') break;
    // ⚠ NOT 'connected' ALONE. With the input fallback the broken-path arm also
    // reaches 'connected', but only after ICE_CONNECT_MS expires and relay mode
    // engages — so waiting for the relay to be measured is what makes the cell
    // below able to tell the two apart.
    if (a.state === 'connected' && b.state === 'connected'
        && (!a.relay || a.relay.oneWayMs != null)) break;
    if (reqMs !== null && b.state === 'closed') break;
  }
  return { h: a, g: b, ms: Date.now() - t0, reqMs };
};

// ---------------------------------------------------------------------------
console.log('\n== arm 1: two isolated contexts, the real relay, direct path ALLOWED ==');
const A = await mk(false), B = await mk(false);
const code1 = await A.page.evaluate(() => Netplay.makeCode(5));
info('code', code1 + '  (never transmitted — the topic is derived from it)');

const started = await Promise.all([boot(A.page, true, code1, 'ws'), boot(B.page, false, code1, 'ws')]);
started[0] && started[1] ? ok('ws-transport-starts', 'both sessions returned from start()')
                         : bad('ws-transport-starts', JSON.stringify(started));

const r1 = await waitPair(A.page, B.page, 45000);
r1.h.kind === 'ws' && r1.g.kind === 'ws'
  ? ok('transport-is-ws', `host=${r1.h.kind} guest=${r1.g.kind}`)
  : bad('transport-is-ws', `host=${r1.h.kind} guest=${r1.g.kind} — the session did not open the relay`);
r1.h.url ? ok('broker-named', `${r1.h.url} (guest: ${r1.g.url})`)
         : bad('broker-named', 'no broker url on the transport');

// THE ONE THAT MATTERS: the hello crossed and a human was asked.
r1.h.req ? ok('HELLO-REACHED-THE-HOST', `join request raised ${r1.reqMs} ms after start(), sas=${r1.h.req.sas}`)
         : bad('HELLO-REACHED-THE-HOST', `no join request after ${r1.ms} ms — host=${JSON.stringify(r1.h.log)} guest=${JSON.stringify(r1.g.log)}`);
r1.h.req && /^[A-HJ-NP-Z2-9]{4}$/.test(r1.h.req.sas || '')
  ? ok('confirmation-code-derived', r1.h.req.sas + ' — both sides can read it out')
  : bad('confirmation-code-derived', String(r1.h.req && r1.h.req.sas));
r1.h.state === 'connected' && r1.g.state === 'connected'
  ? ok('game-link-opened', `both connected in ${r1.ms} ms`)
  : bad('game-link-opened', `host=${r1.h.state} guest=${r1.g.state} err=${r1.h.err}/${r1.g.err}`);

// ---- what the broker and any eavesdropper on the topic actually saw --------
console.log('\n== what went on the wire ==');
const wire = await A.page.evaluate(() => ({
  urls: window.__wsUrls,
  out: window.__wsOut.join(' '),
  in: window.__wsIn.join(' '),
  frames: window.__wsOut.length + window.__wsIn.length,
}));
info('ws-frames', `${wire.frames} frames on ${JSON.stringify(wire.urls)}`);
const all = wire.out + ' ' + wire.in;
!all.includes(code1)
  ? ok('ROOM-CODE-NEVER-ON-THE-WIRE', `"${code1}" appears 0 times in ${all.length} bytes of WebSocket traffic`)
  : bad('ROOM-CODE-NEVER-ON-THE-WIRE', `the code "${code1}" IS in the frames the broker received`);
!/v=0|a=candidate|m=application|typ host|typ srflx/.test(all)
  ? ok('SDP-AND-ICE-ARE-SEALED', 'no SDP or ICE candidate is legible in the frames')
  : bad('SDP-AND-ICE-ARE-SEALED', 'raw SDP/ICE text is readable on the public topic');
!/"t":"(hello|ready|join|offer|answer|ice)"/.test(all)
  ? ok('handshake-is-sealed', 'no message type is legible either')
  : bad('handshake-is-sealed', 'the handshake is in clear on a public topic');
/bemental\/np\/[0-9a-f]{32}/.test(all)
  ? ok('topic-is-derived', 'the topic is 128 bits of HMAC output: ' + (all.match(/bemental\/np\/[0-9a-f]{32}/) || [])[0])
  : bad('topic-is-derived', 'could not find a derived topic in the frames');

await A.ctx.close(); await B.ctx.close();

// ---------------------------------------------------------------------------
// ARM 2: THE PROOF. Break the direct path on BOTH sides and pair again.
console.log('\n== arm 2: direct path DELIBERATELY BROKEN (iceTransportPolicy:relay, no relay) ==');
const C = await mk(true), D = await mk(true);
const code2 = await C.page.evaluate(() => Netplay.makeCode(5));
await Promise.all([boot(C.page, true, code2, 'ws'), boot(D.page, false, code2, 'ws')]);
const r2 = await waitPair(C.page, D.page, 60000);
const brokeIt = await D.page.evaluate(() => window.__iceCfg && window.__iceCfg.iceTransportPolicy);
// ARM-DIFFERENCE PROOF: if the flag did not actually take, this cell proves
// nothing and must say so rather than print a verdict.
brokeIt === 'relay'
  ? ok('arm-difference-proof', 'every RTCPeerConnection on both pages is relay-only with no relay')
  : bad('arm-difference-proof', `iceTransportPolicy=${brokeIt} — the arm did not apply, everything below is VOID`);
if (brokeIt === 'relay') {
  r2.h.req
    ? ok('PAIRING-SURVIVES-A-DEAD-DIRECT-PATH', `hello crossed and the host was asked ${r2.reqMs} ms after start() (sas=${r2.h.req.sas}) with WebRTC unable to connect AT ALL`)
    : bad('PAIRING-SURVIVES-A-DEAD-DIRECT-PATH', `no join request in ${r2.ms} ms — host=${JSON.stringify(r2.h.log)} guest=${JSON.stringify(r2.g.log)}`);
  // ⚠ THIS CELL CHANGED WHEN THE INPUT FALLBACK LANDED, AND IT GOT STRONGER.
  // It used to assert the session must NOT reach 'connected' here, because no
  // direct path can exist. That is still true of the DIRECT path — but the room
  // now carries the pads over the relay instead of dying, so 'connected' is the
  // correct outcome and the old assertion would have scored the fix as a bug.
  // What must be proved is that the connection exists ONLY because of the
  // fallback: connected AND relay.active. A direct link cannot satisfy that,
  // so this cannot be passed by the thing the arm was built to rule out.
  const relayed2 = !!(r2.h.relay && r2.h.relay.active) && !!(r2.g.relay && r2.g.relay.active);
  (r2.h.state === 'connected' && relayed2)
    ? ok('connected-ONLY-BECAUSE-IT-FELL-BACK-TO-THE-RELAY', `host=${r2.h.state} guest=${r2.g.state}, both with relay.active — no direct path exists, so this room is the fallback working`)
    : bad('connected-ONLY-BECAUSE-IT-FELL-BACK-TO-THE-RELAY', `host=${r2.h.state} relay=${JSON.stringify(r2.h.relay)} · guest=${r2.g.state} relay=${JSON.stringify(r2.g.relay)}`);
}
await C.ctx.close(); await D.ctx.close();

// ---------------------------------------------------------------------------
// ARM 4: THE SHIPPED CONFIGURATION. Every page asks for transport 'peerjs';
// that now opens the relay AND the peerjs DataConnection concurrently. Broken
// direct path again, because the whole claim is that a visitor no longer needs
// one to be let into a room.
console.log('\n== arm 4: the SHIPPED plan (transport:"peerjs"), direct path BROKEN ==');
const plan = await mk(false);
const shipped = await plan.page.evaluate(() => ({
  peerjs: Netplay.signalPlan('peerjs'),
  none: Netplay.signalPlan(),
  local: Netplay.signalPlan('local'),
  ws: Netplay.signalPlan('ws'),
  only: Netplay.signalPlan('peerjs-only'),
  brokers: Netplay.signalBrokers(),
}));
JSON.stringify(shipped.peerjs) === '["ws","peerjs"]' && JSON.stringify(shipped.none) === '["ws","peerjs"]'
  ? ok('SHIPPED-PLAN-IS-RELAY-FIRST', 'signalPlan("peerjs") = ' + JSON.stringify(shipped.peerjs) + ' — every page gets the relay without a page edit')
  : bad('SHIPPED-PLAN-IS-RELAY-FIRST', JSON.stringify(shipped));
JSON.stringify(shipped.local) === '["local"]' && JSON.stringify(shipped.ws) === '["ws"]' && JSON.stringify(shipped.only) === '["peerjs"]'
  ? ok('forced-plans-are-honoured', 'local/ws/peerjs-only each open exactly one path')
  : bad('forced-plans-are-honoured', JSON.stringify(shipped));
shipped.brokers.length >= 2
  ? ok('broker-list-has-a-spare', shipped.brokers.length + ' brokers: ' + shipped.brokers.join(' '))
  : bad('broker-list-has-a-spare', JSON.stringify(shipped.brokers));
await plan.ctx.close();

const F = await mk(true), G = await mk(true);
const code4 = await F.page.evaluate(() => Netplay.makeCode(5));
await Promise.all([boot(F.page, true, code4, 'peerjs'), boot(G.page, false, code4, 'peerjs')]);
const r4 = await waitPair(F.page, G.page, 60000);
const broke4 = await G.page.evaluate(() => window.__iceCfg && window.__iceCfg.iceTransportPolicy);
broke4 === 'relay'
  ? ok('arm4-difference-proof', 'relay-only ICE with no relay on both pages')
  : bad('arm4-difference-proof', `iceTransportPolicy=${broke4} — arm did not apply, the cell below is VOID`);
if (broke4 === 'relay') {
  r4.h.req
    ? ok('SHIPPED-PLAN-PAIRS-WITH-NO-DIRECT-PATH', `host asked to admit the joiner ${r4.reqMs} ms after start() over ${r4.h.kind} (${r4.h.url})`)
    : bad('SHIPPED-PLAN-PAIRS-WITH-NO-DIRECT-PATH', `no join request in ${r4.ms} ms — host=${JSON.stringify(r4.h.log)} guest=${JSON.stringify(r4.g.log)}`);
  // EXACTLY-ONCE DELIVERY. Two paths carrying the same handshake must not
  // produce a duplicate 'answer': the second setRemoteDescription throws
  // "Called in wrong state: stable" into the catch in _onSignal and fails a
  // session that was connecting fine.
  // ⚠ THE FIRST VERSION OF THIS CELL MATCHED /failed/ AND WAS WRONG. In this
  // arm a 'failed' status is the CORRECT outcome — the game link genuinely
  // cannot open with relay-only ICE and no relay, and saying so is the whole
  // point of the ICE watchdog. Matching any failure scored a working diagnosis
  // as a bug. Match the duplicate's own signature instead.
  const dupe = JSON.stringify([r4.h.log, r4.g.log, r4.h.err, r4.g.err]);
  !/wrong state|stable|InvalidStateError/i.test(dupe)
    ? ok('no-duplicate-message-failure', 'no setRemoteDescription state error with both paths carrying the same handshake')
    : bad('no-duplicate-message-failure', dupe);
  // And the failure that IS expected here must be the honest one.
  /blocking direct peer-to-peer/.test(dupe)
    ? ok('broken-game-path-is-diagnosed', 'both sides named the real fault instead of hanging on "signalling"')
    : bad('broken-game-path-is-diagnosed', dupe);
}
await F.ctx.close(); await G.ctx.close();

// ---------------------------------------------------------------------------
if (process.env.WS_QUIET === '1') {
  console.log('\n== arm 3: a code nobody is hosting is DIAGNOSED, not hung ==');
  const E = await mk(false);
  await boot(E.page, false, await E.page.evaluate(() => Netplay.makeCode(5)), 'ws');
  const t0 = Date.now();
  let e = null;
  while (Date.now() - t0 < 45000) {
    await new Promise((r) => setTimeout(r, 1000));
    e = await read(E.page);
    if (e.state === 'failed') break;
  }
  /nobody is hosting that code/.test(String(e && e.err))
    ? ok('wrong-code-is-named', `"${e.err}" after ${Date.now() - t0} ms`)
    : bad('wrong-code-is-named', `state=${e && e.state} err=${e && e.err}`);
  await E.ctx.close();
} else {
  info('arm 3 skipped', 'the wrong-code arm waits 30 s by design — WS_QUIET=1 to run it');
}

await browser.close();
const pass = res.filter((r) => r.ok).length;
console.log(`\n${pass}/${res.length} passed`);
process.exit(pass === res.length ? 0 : 1);

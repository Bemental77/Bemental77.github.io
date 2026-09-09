#!/usr/bin/env node
// CAN A CONFIGURED RELAY ACTUALLY CARRY A WHOLE SESSION?
//
// iceTransportPolicy:'relay' discards every host and server-reflexive
// candidate, so the session can only succeed through TURN. That makes this the
// closest thing to "two machines on networks that will not carry a direct path"
// that can be run on one box, and the arm a STUN-only build MUST fail.
//
// USAGE  npm run web && node tools/netplay_relay_check.mjs
//        NETPLAY_TURN='turn:host:3478|user|pass' node tools/netplay_relay_check.mjs
import puppeteer from 'puppeteer';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = 'http://localhost:8080';
const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import('/Users/caseybement/Bemental77.github.io/tools/browser_leak_guard.js')).default.guard(b, 'relay_check'); } catch (_e) {}
const mk = async () => {
  const p = await b.newPage();
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  // Force relay-only on every connection this page makes, and hand the page any
  // relay the operator named — the same string lib/netplay.js accepts.
  await p.evaluate((turn) => {
    if (turn) window.NETPLAY_TURN = turn;
    const Real = window.RTCPeerConnection;
    window.RTCPeerConnection = function (cfg) {
      const c = Object.assign({}, cfg, { iceTransportPolicy: 'relay' });
      window.__iceCfg = c;
      return new Real(c);
    };
    window.RTCPeerConnection.prototype = Real.prototype;
  }, process.env.NETPLAY_TURN || '');
  return p;
};
const host = await mk(), guest = await mk();
const CODE = 'RELAY';
const boot = (p, isHost) => p.evaluate(async (code, isHost) => {
  window.__st = [];
  const s = new Netplay.Session({ game: 'g', host: isHost, code, transport: 'local', delayFrames: 0 });
  window.__s = s;
  s.on('status', (e) => window.__st.push(e.state + (e.detail ? ':' + e.detail : '')));
  if (isHost) s.on('join-request', (r) => r.approve());
  await s.start();
}, CODE, isHost);
await boot(host, true); await boot(guest, false);
const read = (p) => p.evaluate(() => ({ st: window.__s.state, log: window.__st }));
let h, g;
for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 750));
  h = await read(host); g = await read(guest);
  if (h.st === 'connected' && g.st === 'connected') break;
  if (h.st === 'failed' || g.st === 'failed') break;
}
// What pair actually carried it?
const stats = await guest.evaluate(async () => {
  const pc = window.__s._pc; if (!pc) return null;
  const s = await pc.getStats(); const out = [];
  s.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded') out.push(r); });
  const cands = {}; s.forEach((r) => { if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r.candidateType + '/' + (r.protocol||''); });
  return out.map((p) => ({ local: cands[p.localCandidateId], remote: cands[p.remoteCandidateId], bytes: p.bytesReceived }));
});
console.log('iceTransportPolicy =', (await guest.evaluate(() => window.__iceCfg && window.__iceCfg.iceTransportPolicy)));
console.log('iceServers        =', JSON.stringify(await guest.evaluate(() => window.__iceCfg && window.__iceCfg.iceServers)));
console.log('host  =', h.st, JSON.stringify(h.log));
console.log('guest =', g.st, JSON.stringify(g.log));
console.log('succeeded candidate pairs =', JSON.stringify(stats));
const connected = h.st === 'connected' && g.st === 'connected';
const turn = process.env.NETPLAY_TURN || '';
let code = 0;
if (turn) {
  // A relay was named: it must actually carry the session.
  console.log(connected ? 'RESULT: PASS — the configured relay carried a whole session'
                        : 'RESULT: FAIL — a relay was configured and the session still could not connect');
  code = connected ? 0 : 1;
} else {
  // ⚠ THIS ARM'S PASS CONDITION INVERTED WHEN THE PRODUCT IMPROVED, and it
  // spent a while calling the improvement a failure. It was written when a
  // relay-only ICE policy with no TURN server meant the room COULD NOT CONNECT,
  // so the only thing worth testing was whether the dead end was DIAGNOSED
  // rather than left hanging on "signalling". Since the WSS fallback landed,
  // the same configuration CONNECTS — the pads go down the relay — and both
  // sides say "connected over a relay — slower than a direct link". The old
  // check read that success as "no diagnosis" and printed "this is the frozen
  // screen" about a room that was working.
  //
  // Two outcomes are now correct, and the wrong one is silence:
  //   connected over a relay          -> the fallback carried it, and SAID so
  //   failed, naming the network      -> no path at all, diagnosed
  // A room that neither connects nor explains itself is the only failure.
  const said = JSON.stringify([h.log, g.log]);
  const relayed = (h.st === 'connected' && g.st === 'connected') && /relay/i.test(said);
  const diagnosed = /blocking direct peer-to-peer/.test(said);
  if (relayed) {
    console.log('RESULT: PASS — no TURN configured and no direct path, and the room still connected');
    console.log('              over the WSS relay, telling both players it is slower than a direct link');
    code = 0;
  } else if (diagnosed) {
    console.log('RESULT: PASS — the room could not connect and both sides NAMED the network as the cause');
    code = 0;
  } else {
    console.log(`RESULT: FAIL — host=${h.st} guest=${g.st}, neither connected nor explained (the frozen screen)`);
    code = 1;
  }
}
await b.close();
process.exit(code);

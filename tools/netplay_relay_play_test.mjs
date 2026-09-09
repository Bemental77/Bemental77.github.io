#!/usr/bin/env node
// ============================================================================
// netplay_relay_play_test.mjs — WHEN THE GAME PATH CANNOT OPEN, DOES THE ROOM
//                               STILL PLAY, AND IS THE PLAYER TOLD THE TRUTH?
// ============================================================================
//
// Pairing no longer needs the two networks to reach each other. The GAME still
// does: once the offer and answer are exchanged, ICE either finds a path or it
// does not, and when it does not the session used to say "one of these networks
// is blocking direct peer-to-peer traffic … needs a relay server" and end.
// That sentence is true and it is a dead end, because there is no working free
// TURN server to point anybody at (every public one measured 701/400).
//
// So the room now carries the pads over the same WebSocket the handshake used.
// This file asserts the three things that makes true or false:
//
//   1. IT PLAYS. With every RTCPeerConnection on both pages forced relay-only
//      and no relay configured — so no direct path can exist — a pad pressed on
//      one machine is readable on the other.
//   2. THE PLAYER IS TOLD. A relayed room is slower, and hiding that makes the
//      product feel broken rather than degraded. session.relay carries the
//      MEASURED one-way time and the input delay it forces, and relayNotice()
//      says so in a sentence a person can read.
//   3. IT IS STILL SHUT. A relayed frame arrives on a topic anyone can publish
//      to, so unlike a DataChannel — which cannot exist before approval — this
//      path has to prove for itself that the sender is a seated player. An
//      unapproved caller on the same topic must get nowhere.
//
// ⚠ THE HONEST COST, which this rig prints rather than hides: at a relay's
// one-way time the input delay must rise a long way. The number is measured
// here, not assumed, and cell `delay-is-derived-from-the-measurement` fails if
// the session reports a delay that does not follow from the latency it saw.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # mandatory gate
//   npm run web                                           # port 8080, gate #2
//   node tools/netplay_relay_play_test.mjs
// ============================================================================
import puppeteer from 'puppeteer';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok = (n, d) => { res.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import('/Users/caseybement/Bemental77.github.io/tools/browser_leak_guard.js')).default.guard(browser, 'relay_play'); } catch (_e) {}

// Every RTCPeerConnection relay-only with no relay configured: the game path
// CANNOT come up, which is the whole premise of the file.
const BREAK = () => {
  const Real = window.RTCPeerConnection;
  window.__iceCfg = null;
  function Broken(cfg) {
    const c = Object.assign({}, cfg, { iceTransportPolicy: 'relay' });
    window.__iceCfg = c;
    return new Real(c);
  }
  Broken.prototype = Real.prototype;
  window.RTCPeerConnection = Broken;
};

const mk = async (breakDirect) => {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('    [pageerror]', String(e).slice(0, 200)));
  if (breakDirect) await p.evaluateOnNewDocument(BREAK);
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return { ctx, page: p };
};

const boot = (p, isHost, code) => p.evaluate(async (code, isHost) => {
  window.__log = []; window.__req = null; window.__relay = [];
  const s = new Netplay.Session({ game: 'relayrig', host: isHost, code, transport: 'ws', delayFrames: 3 });
  window.__s = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  s.on('relay', (r) => window.__relay.push(r));
  if (isHost) s.on('join-request', (r) => { window.__req = { sas: r.sas }; r.approve(); });
  return await s.start();
}, code, isHost);

const look = (p) => p.evaluate(() => ({
  state: window.__s.state, err: window.__s.lastError,
  relay: window.__s.relay ? JSON.parse(JSON.stringify(window.__s.relay)) : null,
  info: window.__s.relayInfo ? window.__s.relayInfo() : null,
  notice: window.__s.relayNotice ? window.__s.relayNotice() : null,
  room: window.__s.roomInfo ? window.__s.roomInfo() : null,
  pad: window.__s.remotePad ? window.__s.remotePad() : null,
  events: window.__relay.length,
  log: window.__log,
  req: window.__req,
}));

console.log('\n== the game path CANNOT open; does the room still play? ==');
const H = await mk(true), G = await mk(true);
const code = await H.page.evaluate(() => Netplay.makeCode(5));
await Promise.all([boot(H.page, true, code), boot(G.page, false, code)]);

const broke = await G.page.evaluate(() => window.__iceCfg && window.__iceCfg.iceTransportPolicy);
broke === 'relay'
  ? ok('arm-difference-proof', 'relay-only ICE with NO relay on both pages — no direct path can exist')
  : bad('arm-difference-proof', `iceTransportPolicy=${broke} — everything below is VOID`);

// The ICE watchdog is ICE_CONNECT_MS = 25 s, so relay mode cannot engage before
// then. Wait past it.
let h = null, g = null;
const t0 = Date.now();
while (Date.now() - t0 < 70000) {
  await sleep(1000);
  h = await look(H.page); g = await look(G.page);
  if (h.relay && g.relay && h.relay.oneWayMs != null) break;
  if (h.state === 'failed' && g.state === 'failed' && Date.now() - t0 > 45000) break;
}
info('elapsed', `${Date.now() - t0} ms`);

h.req ? ok('paired-over-the-relay', `host was asked to admit the joiner (sas=${h.req.sas})`)
      : bad('paired-over-the-relay', JSON.stringify(h.log));

(h.relay && h.relay.active && g.relay && g.relay.active)
  ? ok('ROOM-FELL-BACK-TO-THE-RELAY-INSTEAD-OF-FAILING', `host=${h.state} guest=${g.state} — both sides in relay mode`)
  : bad('ROOM-FELL-BACK-TO-THE-RELAY-INSTEAD-OF-FAILING', `host relay=${JSON.stringify(h.relay)} state=${h.state} err=${h.err} · guest relay=${JSON.stringify(g.relay)} state=${g.state} err=${g.err}`);

// ---- the honest cost ------------------------------------------------------
console.log('\n== what it costs, measured ==');
const w = h.relay && h.relay.oneWayMs;
const d = h.relay && h.relay.delayFrames;
(w != null && w > 0)
  ? ok('one-way-time-is-MEASURED', `${Math.round(w)} ms one way over ${h.relay.path}`)
  : bad('one-way-time-is-MEASURED', `oneWayMs=${w} — a relayed room that has not measured itself cannot report a delay`);
if (w != null && d != null) {
  // My input for frame F+delay must be in your hands before you run F+delay,
  // so the delay has to cover one-way time. Assert the arithmetic, not a
  // hardcoded number: a rig that pins the constant tests the constant.
  const need = Math.ceil(w / (1000 / 60));
  (d >= need && d <= need + 8 && d <= 30)
    ? ok('delay-is-derived-from-the-measurement', `${d} frames (${Math.round(d * 1000 / 60)} ms) covers ${Math.round(w)} ms one way, which needs at least ${need}`)
    : bad('delay-is-derived-from-the-measurement', `delay=${d} frames but ${Math.round(w)} ms one way needs at least ${need}`);
}
const notice = h.notice || '';
(/relay/i.test(notice) && /slower|behind/i.test(notice))
  ? ok('THE-PLAYER-IS-TOLD', '"' + notice + '"')
  : bad('THE-PLAYER-IS-TOLD', 'the notice does not say the room is on a relay and slower: ' + JSON.stringify(notice));
(h.room && h.room.relay && h.room.relay.active)
  ? ok('roomInfo-carries-it', 'the room panel can read it without reaching into the session')
  : bad('roomInfo-carries-it', JSON.stringify(h.room && h.room.relay));
h.events > 0 ? ok('a-relay-event-fired', `${h.events} 'relay' events — a page does not have to poll`)
             : bad('a-relay-event-fired', 'no relay event was emitted');

// ---- does it actually carry input? ---------------------------------------
console.log('\n== does a button press cross? ==');
await G.page.evaluate(() => { for (let i = 0; i < 10; i++) window.__s.sendPad(0x5A5); });
let pad = null;
for (let i = 0; i < 30; i++) { await sleep(300); pad = (await look(H.page)).pad; if (pad === 0x5A5) break; }
pad === 0x5A5
  ? ok('A-PAD-PRESS-CROSSES-THE-RELAY', `host reads 0x${(pad >>> 0).toString(16)} with no peer-to-peer path in existence`)
  : bad('A-PAD-PRESS-CROSSES-THE-RELAY', `host remotePad()=${pad}`);

// ---- and it is still shut -------------------------------------------------
console.log('\n== an unapproved caller on the same topic ==');
const X = await mk(true);
await X.page.evaluate(async (code) => {
  window.__x = new Netplay.Session({ game: 'relayrig', host: false, code, transport: 'ws', delayFrames: 3 });
  window.__xlog = [];
  window.__x.on('status', (e) => window.__xlog.push(e.state + (e.detail ? ':' + e.detail : '')));
  await window.__x.start();
}, code);
await sleep(6000);
// It knows the code (it derived the same topic) but nobody approved it. It must
// not be able to put a byte into the running game.
await X.page.evaluate(() => { for (let i = 0; i < 10; i++) window.__x.sendPad(0x3C3); });
await sleep(4000);
const after = await look(H.page);
// ⚠ THIS CELL IS VOID IF THE APPROVED PLAYER'S PAD NEVER ARRIVED. The first
// version asserted `pad === 0x5A5` outright, so when nothing at all was
// crossing it printed "an unapproved caller reached the core" — a confidently
// wrong accusation about a run in which the intruder had achieved nothing. A
// security cell that cannot tell "refused" from "nothing happened" is not a
// security cell.
if (pad !== 0x5A5) {
  info('UNAPPROVED-CALLER-PUTS-NOTHING-IN-THE-GAME', 'VOID — the approved pad never crossed, so there is no admission to test');
} else {
  after.pad === 0x5A5
    ? ok('UNAPPROVED-CALLER-PUTS-NOTHING-IN-THE-GAME', `host still reads the approved player's 0x${(after.pad >>> 0).toString(16)}, and never the intruder's 0x3c3`)
    : bad('UNAPPROVED-CALLER-PUTS-NOTHING-IN-THE-GAME', `host remotePad()=0x${(after.pad >>> 0).toString(16)} — an unapproved caller reached the core`);
}
const xs = await X.page.evaluate(() => ({ st: window.__x.state, relay: !!window.__x.relay, log: window.__xlog }));
!xs.relay
  ? ok('unapproved-caller-gets-no-relay-link', `state=${xs.st} — it was never seated, so there is nothing for it to relay over`)
  : bad('unapproved-caller-gets-no-relay-link', JSON.stringify(xs));

await H.ctx.close(); await G.ctx.close(); await X.ctx.close();
await browser.close();
const pass = res.filter((r) => r.ok).length;
console.log(`\n${pass}/${res.length} passed`);
process.exit(pass === res.length ? 0 : 1);

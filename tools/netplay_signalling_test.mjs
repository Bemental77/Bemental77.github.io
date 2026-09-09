#!/usr/bin/env node
// Does a BROKEN SIGNALLING BROKER produce a message, or a frozen screen?
//
// WHY THIS EXISTS. A user hosted a game on production and tried to join from a
// second machine. The host sat on "Waiting for someone to join with code
// EUQTF…" and the guest sat on "Looking for the host…" — forever, both of them,
// with nothing anywhere saying why. Both strings are the page's rendering of
// session state 'signalling', so ANY stall before the data channel opens looks
// exactly like that, and lib/netplay.js had three ways to stall there and
// report nothing:
//
//   1. `new Peer()` that never fires 'open' left peerSignal's promise pending
//      forever, so `await peerSignal(...)` never returned and no status after
//      'signalling' was ever emitted.
//   2. A broker error AFTER 'open' called reject() on an already-resolved
//      promise — a no-op. The socket could drop and nothing noticed.
//   3. 'peer-unavailable' (nobody is registered under that id) retried forever
//      and silently, so a MISTYPED CODE was indistinguishable from a host who
//      had not pressed Host yet.
//
// Each arm below drives one of those three by substituting `window.Peer` with a
// broker that fails in exactly that way, and asserts the session says something
// a person can act on. THE POINT IS THE FAILURE PATH, so the fake is the
// subject of the test, not a shortcut around it — the real peerjs library is
// exercised by tools/netplay_realui_pair_test.mjs and
// tools/audit_peerjs_crossdevice.mjs.
//
// ⚠ THE TRANSPORT NAME BELOW IS 'peerjs-only', AND IT HAS TO BE. Pairing is no
// longer carried by the peerjs DataConnection alone: a page that asks for
// 'peerjs' now opens the WebSocket relay AND peerjs concurrently, because a
// DataConnection is itself a WebRTC connection and two devices on different
// networks could not open one (lib/netplay.js, the 'ws' block). In that
// arrangement a peerjs broker that dies is CORRECTLY silent — the relay is
// still carrying the session, and shouting about a path nobody needs is how a
// working room gets reported as broken. So every diagnosis this file asserts
// is, by design, suppressed under the shipped plan. 'peerjs-only' names the
// subject these arms were always about and keeps them measuring it.
//
// USAGE  npm run web  &&  node tools/netplay_signalling_test.mjs
import puppeteer from 'puppeteer';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok  = (n, d) => { res.push({ n, ok: true  }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'netplay_signalling'); } catch (_e) {}

// A page that does NOT install coi-serviceworker, so an injected script tag is
// not raced away by the reload it performs.
const mk = async () => {
  const p = await browser.newPage();
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return p;
};

// Install a fake broker. `mode` selects which real-world failure it imitates.
const installFakePeer = (page, mode) => page.evaluate((mode) => {
  window.__peerLog = [];
  window.Peer = function (id) {
    const h = {};
    this.on = (ev, f) => { (h[ev] = h[ev] || []).push(f); };
    const fire = (ev, a) => (h[ev] || []).forEach((f) => f(a));
    this.destroy = () => { window.__peerLog.push('destroy'); };
    this.connect = () => {
      window.__peerLog.push('connect');
      // Nobody is registered under the host id — the broker's answer to a
      // wrong code, and to a host who has not started yet.
      if (mode === 'unavailable') { setTimeout(() => fire('error', { type: 'peer-unavailable' }), 5); return { on: () => {}, open: false }; }
      // The host IS registered, but the connection to it never comes up and
      // never errors — what a peerjs DataConnection does when neither network
      // will carry a direct path. This is the stall with no error to catch.
      return { on: () => {}, open: false, close: () => { window.__peerLog.push('hangup'); } };
    };
    window.__peerLog.push('new Peer ' + id);
    // 1. never answers: no 'open', no 'error'. The old code hung here.
    if (mode === 'silent') return;
    // 2. answers, then the socket dies. The old code called reject() on an
    //    already-resolved promise and swallowed it whole.
    if (mode === 'dies-after-open') {
      setTimeout(() => fire('open', id), 5);
      setTimeout(() => fire('error', { type: 'network' }), 400);
      return;
    }
    // 3. answers, but the peer being dialled is not there. Bounded knocking.
    if (mode === 'unavailable') { setTimeout(() => fire('open', id), 5); return; }
    // 4. the broker knows the host, but the dial never opens and never errors.
    if (mode === 'dial-never-opens') { setTimeout(() => fire('open', id), 5); return; }
  };
}, mode);

const run = (page, isHost) => page.evaluate((isHost) => {
  window.__st = []; window.__threw = null;
  const s = new Netplay.Session({ game: 'g', host: isHost, code: 'ABCDE', transport: 'peerjs-only' });
  window.__s = s;
  s.on('status', (e) => window.__st.push(e.state + (e.detail ? ': ' + e.detail : '')));
  s.start().then((v) => { window.__started = v; }, (e) => { window.__threw = String(e && e.message || e); });
  return true;
}, isHost);

const read = (page) => page.evaluate(() => ({
  state: window.__s && window.__s.state,
  started: window.__started,
  threw: window.__threw,
  st: window.__st,
  last: window.__s && window.__s.lastError,
  peerLog: window.__peerLog,
}));

const waitFor = async (page, pred, ms) => {
  const t0 = Date.now();
  for (;;) {
    const v = await read(page);
    if (pred(v)) return v;
    if (Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
};

// ---- ARM 1: a broker that never answers must TIME OUT, not hang -------------
console.log('\n== 1. broker never issues an id ==');
{
  const p = await mk();
  await installFakePeer(p, 'silent');
  const t0 = Date.now();
  await run(p, true);
  const v = await waitFor(p, (x) => x.state === 'failed', 30000);
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  if (v.state === 'failed' && /did not answer/.test(String(v.last)))
    ok('silent-broker-times-out', `state=failed after ${took}s — "${v.last}"`);
  else
    bad('silent-broker-times-out', `state=${v.state} after ${took}s, lastError=${JSON.stringify(v.last)}, statuses=${JSON.stringify(v.st)}`);
  // The old code's tell: 'signalling' is the ONLY status ever emitted.
  if (v.st.length > 1) ok('silent-broker-says-something', `statuses = ${JSON.stringify(v.st)}`);
  else bad('silent-broker-says-something', `only ever emitted ${JSON.stringify(v.st)} — this is the frozen screen`);
  await p.close();
}

// ---- ARM 2: a broker that drops AFTER handing over must be reported ---------
console.log('\n== 2. broker socket dies after open ==');
{
  const p = await mk();
  await installFakePeer(p, 'dies-after-open');
  await run(p, true);
  const v = await waitFor(p, (x) => x.state === 'failed', 15000);
  if (v.state === 'failed' && /broker error/.test(String(v.last)))
    ok('post-open-error-surfaces', `"${v.last}"`);
  else
    bad('post-open-error-surfaces', `state=${v.state} lastError=${JSON.stringify(v.last)} statuses=${JSON.stringify(v.st)}`);
  await p.close();
}

// ---- ARM 3: nobody hosting that code must be SAID, and knocking bounded -----
console.log('\n== 3. no host registered under that code ==');
{
  const p = await mk();
  await installFakePeer(p, 'unavailable');
  await run(p, false);
  const v = await waitFor(p, (x) => x.state === 'failed', 90000);
  if (v.state === 'failed' && /nobody is hosting that code/.test(String(v.last)))
    ok('mistyped-code-is-named', `"${v.last}"`);
  else
    bad('mistyped-code-is-named', `state=${v.state} lastError=${JSON.stringify(v.last)} statuses=${JSON.stringify(v.st)}`);
  const knocks = (v.peerLog || []).filter((l) => l === 'connect').length;
  if (knocks > 1 && knocks <= 40) ok('knocking-is-bounded', `${knocks} attempts, then it stopped and reported`);
  else bad('knocking-is-bounded', `${knocks} connect attempts — unbounded silent retry is the bug`);
  await p.close();
}

// ---- ARM 4: host registered, but the dial never opens ----------------------
// The stall that best fits the reported failure: a peerjs DataConnection is
// itself a WebRTC connection, so on networks that will not carry a direct path
// it is created, emits NO error, and simply never opens. Nothing timed it.
console.log('\n== 4. host is there, but the connection never comes up ==');
{
  const p = await mk();
  await installFakePeer(p, 'dial-never-opens');
  await run(p, false);
  const v = await waitFor(p, (x) => x.state === 'failed', 240000);
  if (v.state === 'failed' && /blocking direct peer-to-peer/.test(String(v.last)))
    ok('dead-dial-is-diagnosed', `"${v.last}"`);
  else
    bad('dead-dial-is-diagnosed', `state=${v.state} lastError=${JSON.stringify(v.last)} statuses=${JSON.stringify(v.st)}`);
  const hangups = (v.peerLog || []).filter((l) => l === 'hangup').length;
  if (hangups > 1) ok('dead-dial-is-retried', `${hangups} dials hung up and re-placed instead of waiting forever`);
  else bad('dead-dial-is-retried', `${hangups} hangups — a dial that never opens is never retried`);
  await p.close();
}

// ---- ARM 5: no dead relay is shipped ---------------------------------------
// peerjs 1.5.4 hardcodes turn:eu-0/us-0.turn.peerjs.com as its defaults and
// NEITHER RESOLVES (dig +short A ... @8.8.8.8 is empty). Shipping them here
// would look like a fix and relay nothing.
console.log('\n== 5. no decorative relay ==');
{
  const p = await mk();
  const cfg = await p.evaluate(() => window.Netplay.iceConfig());
  const j = JSON.stringify(cfg);
  if (/stun:/.test(j)) ok('stun-is-configured', j);
  else bad('stun-is-configured', j);
  if (!/turn\.peerjs\.com/.test(j)) ok('no-dead-relay-shipped', 'the unresolvable peerjs TURN hosts are not in the config');
  else bad('no-dead-relay-shipped', `ships a relay whose DNS does not resolve :: ${j}`);
  const withRelay = await p.evaluate(() => {
    const r = window.Netplay.useRelay([{ urls: 'turn:relay.example:3478', username: 'u', credential: 'p' }]);
    window.Netplay.useRelay([]);
    return r;
  });
  if (/turn:relay\.example:3478/.test(JSON.stringify(withRelay))) ok('a-real-relay-is-one-setting', JSON.stringify(withRelay));
  else bad('a-real-relay-is-one-setting', JSON.stringify(withRelay));
  await p.close();
}

await browser.close();
const fail = res.filter((r) => !r.ok).length;
console.log(`\n[netplay-signalling] ${res.length - fail}/${res.length} passed`);
process.exit(fail ? 1 : 0);

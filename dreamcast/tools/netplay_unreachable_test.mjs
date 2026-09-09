#!/usr/bin/env node
// ============================================================================
// netplay_unreachable_test.mjs — A ROOM THAT CANNOT CONNECT MUST SAY SO
// ============================================================================
//
// THE BUG THIS EXISTS TO PREVENT, reported 2026-09-08 from two real devices (a
// PC and a phone, on DIFFERENT networks) against the deployed page:
//
//     PC    "LOCKSTEP  waiting for players — nothing starts until everyone is in"
//     phone "LOCKSTEP  waiting for players — nothing starts until everyone is in"
//
// forever, on both screens, while the two browsers had already stopped trying to
// reach each other. lib/netplay.js KNEW: its per-link ICE watchdog
// (_armIce/ICE_CONNECT_MS, netplay.js:1622-1639) had fired and produced a
// message that names the cause AND the cure — "the two browsers agreed on a
// connection but could not open one … one of these networks is blocking direct
// peer-to-peer traffic. Playing across it needs a relay server". It reached
// `lastError`, it was raised as 'warning'/'failed', and NOTHING ON THE PAGE
// LISTENED. The one place it did surface, netStatus(), writes into the LOBBY
// panel — which a player who has closed the lobby cannot see, which is exactly
// what both of them had done.
//
// "Waiting" and "this can never connect" look identical to a player, and only
// one of them is worth waiting through. So:
//
//   THE CLAIM UNDER TEST — a room that cannot connect says so, on the canvas,
//   in words that name it as a NETWORK problem, and never keeps claiming it is
//   merely waiting for players.
//
// ---------------------------------------------------------------------------
// WHY THE ARMS ARE SHAPED THIS WAY
//
// ⚠ WHY NOT JUST RUN TWO BROWSERS. Two profiles on one box SHARE A NAT, so they
// pair happily over host candidates — which is precisely why every existing rig
// here passes while two real devices deadlock. A rig that cannot fail the way
// production failed is not evidence. So arm A FORCES the failure with
// `iceTransportPolicy:'relay'` and no relay configured: that discards every
// host and server-reflexive candidate, so the only way through is a TURN relay
// that does not exist. It is the same mechanism tools/netplay_relay_check.mjs
// uses, applied to the REAL PAGE instead of a bare session.
//
// ⚠ WHY ARM A SIGNALS OVER BroadcastChannel (?net=local). A peerjs
// DataConnection is ITSELF a WebRTC connection, so forcing relay-only would
// break SIGNALLING too and the guest would never reach the host at all — a
// different failure (covered by arm B). Signalling over BroadcastChannel keeps
// the handshake working so the GAME link is the only thing that cannot come up,
// which is what isolates the ICE watchdog.
//
// ⚠ NOBODY IS APPROVED FROM THE HARNESS. Every arm clicks the real
// #npApproveAllow control that lib/netplay.js mounts. An earlier generation of
// these rigs registered its own 'join-request' handler and called approve()
// itself, which exercises the engine and bypasses the shipped UI entirely.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web
//   node dreamcast/tools/netplay_unreachable_test.mjs
//
// RED/GREEN. --url points the whole run at another origin, which is how the
// pre-change baseline is proved to FAIL these arms:
//   git show <before>:dreamcast.html > /tmp/dc-baseline/dreamcast.html
//   ln -s $PWD/lib $PWD/dreamcast /tmp/dc-baseline/
//   WEB_ROOT=/tmp/dc-baseline PORT=8099 node tools/devserver.mjs &
//   node dreamcast/tools/netplay_unreachable_test.mjs --url http://localhost:8099
//
// FLAGS
//   --url U     origin to test (default http://localhost:8080)
//   --only N    run one arm by name substring
//   --headful
// ============================================================================
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const ORIGIN = arg('url', 'http://localhost:8080');
const ONLY = arg('only', null);
const HEADFUL = has('headful');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFBASE = '/private/tmp/claude-501/dc-unreachable';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);
const say = (s) => console.log(s);
const CELLS = [];
function cell(ok, name, pass, fail) {
  CELLS.push({ name, ok: !!ok });
  say((ok ? '  PASS  ' : '  FAIL  ') + name + '\n          ' + (ok ? pass : fail));
}

const browsers = [];
async function launch(tag) {
  const dir = path.join(PROFBASE, tag);
  // FRESH PER ARM. Cross-origin isolation and the coi-serviceworker are
  // origin-scoped and PERSIST in a profile, and a reused profile made arm B
  // fail once behind arm A while passing alone — a contaminated profile reads
  // exactly like a product bug.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: HEADFUL ? false : 'new', userDataDir: dir,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
  });
  try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(b, 'netplay_unreachable'); }
  catch (e) { say('  ⚠ leak-guard registration FAILED: ' + (e.message || e)); }
  browsers.push(b);
  return b;
}

// Force every RTCPeerConnection this page builds to relay-only. Installed
// BEFORE any page script runs, so lib/netplay.js gets the patched constructor.
const RELAY_ONLY = () => {
  const Real = window.RTCPeerConnection;
  window.RTCPeerConnection = function (cfg) {
    const c = Object.assign({}, cfg, { iceTransportPolicy: 'relay' });
    window.__iceCfg = c;
    return new Real(c);
  };
  window.RTCPeerConnection.prototype = Real.prototype;
};

async function openPage(b, url, { relayOnly = false } = {}) {
  const pg = await b.newPage();
  if (relayOnly) await pg.evaluateOnNewDocument(RELAY_ONLY);
  pg.on('pageerror', (e) => say('    [!] ' + String((e && e.message) || e).slice(0, 180)));
  await pg.setViewport({ width: 1100, height: 780 });
  try { const cdp = await pg.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  // The coi-serviceworker installs on first load and RELOADS the page, so a
  // single goto lands on a context that is about to be destroyed.
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2500);
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(1500);
  return pg;
}
const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);

// What the PLAYER can see, read the way the player sees it.
const hud = (pg) => pg.evaluate(() => {
  const h = (window.__dcNetHud && window.__dcNetHud()) || {};
  const S = (window.Netplay && window.Netplay.sessions) || [];
  const s = S[S.length - 1] || null;
  return {
    text: h.text || '',
    fault: h.fault || null,            // absent on the pre-change build
    faultShown: !!h.faultShown,
    relay: h.relay || null,
    visible: !!h.visible,
    state: s ? s.state : null,
    lastError: s ? s.lastError : null,
    lobbyStatus: (document.getElementById('netStatus') || {}).textContent || '',
  };
});

async function hostAndJoin(hostPg, guestPg, { approve = true } = {}) {
  await click(hostPg, '#btnNet'); await sleep(300);
  await click(hostPg, '#netHostBtn'); await sleep(2500);
  const code = await hostPg.evaluate(() => (document.getElementById('netCode') || {}).textContent || '');
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) throw new Error('no room code minted: ' + J(code));
  await click(guestPg, '#btnNet'); await sleep(300);
  await click(guestPg, '#netJoinBtn'); await sleep(200);
  await guestPg.evaluate(() => {
    const el = document.getElementById('netGame'), src = document.getElementById('romSelect');
    if (el && src) el.value = src.value;
  });
  await guestPg.click('#netCodeIn');
  await guestPg.type('#netCodeIn', code, { delay: 20 });
  await click(guestPg, '#netGo');
  if (!approve) return code;
  // THE REAL CONTROL, not approve() from here.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const got = await hostPg.evaluate(() => {
      const b = document.getElementById('npApproveAllow');
      if (!b) return false;
      b.click(); return true;
    });
    if (got) { say('    .. clicked the real #npApproveAllow on the host'); return code; }
  }
  const dbg = async (pg) => pg.evaluate(() => {
    const S = (window.Netplay && window.Netplay.sessions) || [];
    const s = S[S.length - 1] || null;
    let adm = null; try { adm = s && s.admission ? s.admission() : null; } catch (e) {}
    return { state: s && s.state, host: s && s.isHost, code: s && s.code, transport: s && s.transport,
             game: s && s.game, lastError: s && s.lastError, adm,
             status: (document.getElementById('netStatus') || {}).textContent };
  });
  say('    !! host  ' + J(await dbg(hostPg)));
  say('    !! guest ' + J(await dbg(guestPg)));
  throw new Error('the built-in approval prompt never mounted on the host (code ' + code + ')');
}

// ---------------------------------------------------------------------------
async function armCannotConnect() {
  say('\n== A. the game link cannot come up — the room must say so ==');
  const b = await launch('A');
  // ?net=local keeps SIGNALLING on BroadcastChannel (same profile, two tabs) so
  // only the GAME link is broken by relay-only. See the header.
  const url = ORIGIN + '/dreamcast.html?net=local';
  const hostPg = await openPage(b, url, { relayOnly: true });
  const guestPg = await openPage(b, url, { relayOnly: true });
  await hostAndJoin(hostPg, guestPg, { approve: true });

  // ICE_CONNECT_MS is 25 s; give it that plus slack.
  let h = null, g = null;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    h = await hud(hostPg); g = await hud(guestPg);
    if ((h.fault && g.fault) || (h.state === 'failed' && g.state === 'failed')) break;
  }
  say('    host  state=' + h.state + ' fault=' + J(h.fault && h.fault.text));
  say('    guest state=' + g.state + ' fault=' + J(g.fault && g.fault.text));
  say('    host  HUD: ' + J(h.text.slice(0, 150)));
  say('    guest HUD: ' + J(g.text.slice(0, 150)));

  const bothFaulted = !!(h.fault && g.fault);
  cell(bothFaulted, 'A1-both-sides-report-a-connection-fault',
    'host and guest each raised a fault: ' + J([h.fault && h.fault.kind, g.fault && g.fault.kind]),
    'a room whose game link can NEVER come up reported no fault at all. ' +
    'host=' + J(h.fault) + ' guest=' + J(g.fault) + '. This is the reported bug: the engine ' +
    'knows (lastError host=' + J(h.lastError) + ') and the page throws it away.');

  const stillClaimsWaiting = /waiting for players/i.test(h.text) || /waiting for players/i.test(g.text);
  cell(!stillClaimsWaiting, 'A2-the-HUD-stops-claiming-it-is-waiting-for-players',
    'neither HUD says "waiting for players" any more',
    'a HUD still reads "waiting for players" over a room that cannot connect — which is the exact ' +
    'string both of the user\'s screens showed forever. host=' + J(h.text.slice(0, 120)) +
    ' guest=' + J(g.text.slice(0, 120)));

  const namesTheCause = [h, g].every((x) => /network|relay|peer-to-peer/i.test(x.text));
  cell(namesTheCause, 'A3-the-message-names-it-as-a-network-problem',
    'both HUDs name the network/relay as the cause, so the player has a next step',
    'the fault is shown but does not say it is a NETWORK problem, so a player cannot act on it. ' +
    'host=' + J(h.text.slice(0, 160)) + ' guest=' + J(g.text.slice(0, 160)));

  const relayStated = !!(h.relay && h.relay.configured === false) && /none configured|no relay/i.test(h.text);
  cell(relayStated, 'A4-whether-a-relay-is-configured-is-stated',
    'the HUD says no relay is configured — the difference between a room that works across two houses and one that does not',
    'the HUD does not say whether a relay is configured. relay=' + J(h.relay) + ' text=' + J(h.text.slice(0, 160)));

  await b.close(); browsers.splice(browsers.indexOf(b), 1);
}

// ---------------------------------------------------------------------------
async function armNoFalseAlarm() {
  say('\n== B. a room that CAN connect must raise no fault ==');
  const b = await launch('B');
  const url = ORIGIN + '/dreamcast.html?net=local';
  const hostPg = await openPage(b, url);
  const guestPg = await openPage(b, url);
  await hostAndJoin(hostPg, guestPg, { approve: true });
  let h = null, g = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    h = await hud(hostPg); g = await hud(guestPg);
    if (h.state === 'connected' && g.state === 'connected') break;
  }
  say('    host  state=' + h.state + ' fault=' + J(h.fault));
  say('    guest state=' + g.state + ' fault=' + J(g.fault));
  cell(h.state === 'connected' && g.state === 'connected', 'B1-the-ordinary-room-still-connects',
    'both sides reached connected through the real Allow control — the fault path did not break pairing',
    'pairing itself regressed: host=' + J(h.state) + ' guest=' + J(g.state));
  cell(!h.fault && !g.fault, 'B2-no-fault-is-invented-on-a-healthy-room',
    'neither side raised a fault',
    'a healthy room raised a fault — a false alarm is the same class of bug as the silence it replaced. ' +
    'host=' + J(h.fault) + ' guest=' + J(g.fault));
  await b.close(); browsers.splice(browsers.indexOf(b), 1);
}

// ---------------------------------------------------------------------------
async function armRelaySetting() {
  say('\n== C. a relay can be supplied, and whether one is set is visible ==');
  const b = await launch('C');
  const plain = await openPage(b, ORIGIN + '/dreamcast.html');
  const before = await plain.evaluate(() => {
    const h = (window.__dcNetHud && window.__dcNetHud()) || {};
    document.getElementById('btnNet').click();
    return { relay: h.relay || null, state: (document.getElementById('netRelayState') || {}).textContent || '' };
  });
  say('    default: relay=' + J(before.relay));
  cell(before.relay && before.relay.configured === false, 'C1-ships-with-no-relay-and-says-so',
    'no relay is configured by default and the lobby says so — no dead relay is baked in',
    'the default relay state is wrong or unreported: ' + J(before));

  // ?turn= is the documented testing route (lib/netplay.js turnFromEnv()).
  const withTurn = await openPage(b, ORIGIN + '/dreamcast.html?turn=turn:relay.example:3478|u|p');
  const after = await withTurn.evaluate(() => {
    document.getElementById('btnNet').click();
    const h = (window.__dcNetHud && window.__dcNetHud()) || {};
    return { relay: h.relay || null, state: (document.getElementById('netRelayState') || {}).textContent || '' };
  });
  say('    with ?turn=: relay=' + J(after.relay));
  say('    lobby says: ' + J(after.state.slice(0, 140)));
  cell(!!(after.relay && after.relay.configured === true), 'C2-a-supplied-relay-is-picked-up-and-shown',
    'the supplied relay is reported as configured: ' + J(after.relay && after.relay.urls),
    'a supplied relay was not picked up: ' + J(after));
  // ⚠ CONFIGURED IS NOT WORKING, and the page must not imply otherwise.
  cell(!/\bworking\b/i.test(after.state) && /not proof|not working|only that one is set/i.test(after.state),
    'C3-the-page-says-configured-not-working',
    'the lobby distinguishes "a relay is configured" from "a relay works" — only a gathered relay candidate proves the latter',
    'the lobby implies a configured relay works: ' + J(after.state));
  await b.close(); browsers.splice(browsers.indexOf(b), 1);
}

// ---------------------------------------------------------------------------
(async () => {
  say('== netplay_unreachable_test ==');
  say('   origin  ' + ORIGIN);
  say('   uptime  ' + execSync('uptime').toString().trim());
  const arms = [
    ['cannot-connect', armCannotConnect],
    ['no-false-alarm', armNoFalseAlarm],
    ['relay-setting', armRelaySetting],
  ];
  for (const [name, fn] of arms) {
    if (ONLY && !name.includes(ONLY)) continue;
    try { await fn(); }
    catch (e) { cell(false, name + '-ARM-THREW', '', String((e && e.stack) || e).slice(0, 400)); }
  }
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  const pass = CELLS.filter((c) => c.ok).length;
  say('\n== ' + pass + '/' + CELLS.length + ' cells pass ==');
  for (const c of CELLS) if (!c.ok) say('   FAILED: ' + c.name);
  process.exit(pass === CELLS.length ? 0 : 1);
})().catch(async (e) => {
  say('THREW: ' + ((e && e.stack) || e));
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  process.exit(1);
});

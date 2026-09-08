#!/usr/bin/env node
// ============================================================================
// netplay_realui_pair_test.mjs — TWO BROWSERS, THE INLINE PANEL, THE REAL
//                                BROKER, AND THE ORDER THE PRODUCT ACTUALLY HAS
// ============================================================================
//
// ⚠ REWRITTEN 2026-09-08. THIS FILE USED TO ASSERT THE WRONG PRODUCT, AND THAT
// IS THE MOST IMPORTANT THING IN THIS HEADER.
//
// The old version drove: #romSelect -> #btnStart -> wait for the host to be
// LIVE -> #netHostBtn -> guest joins -> assert the guest DECODES VIDEO FRAMES
// and that its own canvas is HIDDEN behind a <video>. Its own comment cited
// "dreamcast.html:4669 refuses to host without it" as though the boot-first
// refusal were a requirement rather than a defect. Both halves are now wrong:
//
//   * STREAMING IS CANCELLED (user, 2026-09-08: "WE WILL NOT USE STREAMING!
//     WTF!"). Every machine runs its own core. There is no <video>, no capture
//     surface, and no guest watching a picture of somebody else's game — so
//     `guest-decodes-frames` and `guest-view-swapped` asserted an architecture
//     the product no longer has.
//   * PLAYERS JOIN BEFORE THE EMULATOR STARTS (user: "PLAYERS CAN JOIN ONLINE
//     BEFORE THE EMULATOR STARTS!"). The boot-first gate existed only because
//     you cannot captureStream() a canvas that is not drawing. Requiring a
//     1,131 MB download before a player may find out whether they even got a
//     port is backwards.
//
// A TEST THAT ASSERTS THE WRONG FLOW KEEPS PASSING WHILE THE PRODUCT IS WRONG.
// This one passed 27/27 the whole time the page was doing the wrong thing, and
// that is exactly why none of it was flagged by the auditor. The cells below
// assert the order the product is supposed to have, and they FAIL — never VOID
// — when a piece of it is missing. VOID is for a precondition that never
// happened; a missing product requirement printed as void is a green light on a
// broken product.
//
// WHAT THIS FILE COVERS, AND WHAT IT DELIBERATELY DOES NOT
//   COVERS: the inline panel in dreamcast.html (#netHostBtn etc. — grep says it
//   is still the only page with one; every other emulator page navigates to a
//   */_multiplayer.html lobby, covered by tools/audit_peerjs_crossdevice.mjs),
//   two SEPARATE Chrome profiles, and the transport the page picks for itself,
//   which is the broker two real machines need.
//
//   DOES NOT: boot a disc. Two cores booting Gauntlet is minutes of download
//   and gigabytes of RAM, and it belongs in the end-to-end rig rather than in a
//   gate that runs on every audit. THE FULL PROOF — N browsers, N cores, N
//   distinct characters, per-player latency and screenshots — is
//   `dreamcast/tools/netplay_room_e2e.mjs`. Run that for evidence; run this for
//   a fast regression gate on the FLOW.
//
// WHY SEPARATE PROFILES ARE NOT OPTIONAL. BroadcastChannel cannot cross a
// profile, so `?net=local` is unavailable even by accident and only the broker
// can pair the two sides — proved below rather than assumed. And cross-origin
// isolation is origin-scoped AND PERSISTS, so a shared profile hides a
// first-visit fault, which is the state a real second PC is in.
//
// WHAT A PASS HERE STILL DOES NOT PROVE. Both browsers are on ONE machine
// behind ONE NAT, so ICE resolves to loopback. This proves broker signalling,
// the offer/answer exchange and the data path; it proves NOTHING about NAT
// traversal between two genuinely remote networks, which no rig on one box can
// supply.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime     # mandatory gate
//   npm run web                                          # port 8080, gate #2
//   node tools/netplay_realui_pair_test.mjs
//   node tools/netplay_realui_pair_test.mjs --url=https://caseybement.com/dreamcast.html
// ============================================================================
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const argv = process.argv.slice(2);
const flag = (n) => {
  const hit = argv.find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};
const URL_IN = flag('url') || process.env.URL || 'http://localhost:8080/dreamcast.html';
let target;
try { target = new global.URL(URL_IN); } catch (e) { console.error('bad --url: ' + URL_IN); process.exit(2); }
if (!target.pathname.endsWith('dreamcast.html')) {
  console.error('This rig drives the INLINE room panel, which (per `grep -rn "netHostBtn" --include=*.html\n' +
    '--include=*.js .`) exists only in dreamcast.html. Other pages navigate to a */_multiplayer.html\n' +
    'lobby and are covered by tools/audit_peerjs_crossdevice.mjs.');
  process.exit(2);
}
const GAME       = flag('game') || process.env.GAME || 'gauntlet';
const TRANSPORT  = flag('transport') || '';
const KEEP       = !!(flag('keep') || process.env.KEEP);
const CHROME     = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAIR_MS    = parseInt(process.env.PAIR_MS || '90000', 10);
const APPROVE_MS = parseInt(process.env.APPROVE_MS || '45000', 10);
const OUT = process.env.OUT || `/tmp/netplay-realui-${target.hostname.replace(/[^a-z0-9]/gi, '-')}.json`;
const SCRATCH = process.env.SCRATCH || '/private/tmp/claude-501/realui';
const QUERY = TRANSPORT === 'local' ? '?net=local' : '';
const PAGE_URL = target.origin + target.pathname + QUERY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const rec = [];
const T = {
  ok:  (n, d) => { rec.push({ n, ok: true,  d }); console.log(`  PASS  ${n}  ${d}`); },
  bad: (n, d) => { rec.push({ n, ok: false, d }); console.log(`  FAIL  ${n}  ${d}`); },
  info:(n, d) => { console.log(`  ....  ${n}  ${d}`); },
  cell:(p, n, good, badMsg) => (p ? T.ok(n, good) : T.bad(n, badMsg)),
};

// Poll from Node, never page.waitForFunction: that polls on rAF and one of these
// two windows is always backgrounded, which has produced false negatives on a
// session whose own log already read connected.
async function until(page, body, ms, everyMs = 400) {
  const fn = new Function(body);
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(everyMs);
  }
}

const profiles = [];
async function launch(tag) {
  const dir = path.join(SCRATCH, `${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  profiles.push(dir);
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', userDataDir: dir,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
      // Only one window can be foreground and headless Chromium throttles rAF in
      // the other — which would stop the input pump and read as a netplay fault.
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
  });
  // MANDATORY. A SIGKILLed parent orphans its browser and no in-process handler
  // can prevent it; two such orphans once held 230% of this box's CPU for days.
  try { (await import('./browser_leak_guard.js')).default.guard(b, 'realui_pair'); } catch (_e) {}
  return b;
}
const SIDE = {};
function watch(page, label) {
  const s = SIDE[label] = { console: [], netConsole: [], errors: [], thirdParty: [] };
  page.on('console', (m) => {
    const t = m.text();
    if (s.console.push(t.slice(0, 300)) > 400) s.console.shift();
    if (/\[net\]|netplay|peerjs|\bpeer\b|signal|\bice\b|broker/i.test(t)) {
      s.netConsole.push(t.slice(0, 300));
      console.log(`  [${label}] ${t.slice(0, 200)}`);
    }
  });
  page.on('pageerror', (e) => {
    const t = (e && (e.message || e.type)) || (e === null ? 'null (no detail)' : String(e));
    s.errors.push(String(t).slice(0, 300));
    console.log(`  [${label}!] ${String(t).slice(0, 200)}`);
  });
  page.on('request', (r) => { const u = r.url(); if (/peerjs|unpkg|stun|turn/i.test(u)) s.thirdParty.push(u.slice(0, 140)); });
}
// coi-serviceworker installs on the FIRST visit and reloads; land on the
// already-isolated document instead of racing it.
async function gotoSettled(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2500);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
}
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return 'MISSING'; e.click(); return 'ok'; }, sel);

async function diagnose(pages, why) {
  console.log(`\n== DIAGNOSIS (${why}) ==`);
  const out = { why, sides: {} };
  for (const [label, page] of Object.entries(pages)) {
    const s = SIDE[label] || {};
    let d = {};
    try {
      d = await page.evaluate(() => ({
        url: location.href, coi: !!self.crossOriginIsolated, sab: (typeof SharedArrayBuffer === 'function'),
        peerLoaded: (typeof window.Peer), netplayLoaded: (typeof window.Netplay),
        proto: (window.Netplay && window.Netplay.PROTO) || null,
        sessions: (window.Netplay && window.Netplay.sessions)
          ? window.Netplay.sessions.map((x) => ({ state: x.state, host: x.isHost, code: x.code, game: x.game, err: x.lastError })) : null,
        net: window.__dcNet ? window.__dcNet() : null,
        hud: window.__dcNetHud ? window.__dcNetHud() : null,
        room: window.__dcNetRoom ? window.__dcNetRoom() : null,
        probe: window.__dcProbe ? window.__dcProbe() : null,
        status: (document.getElementById('netStatus') || {}).textContent,
        approvePrompt: !!document.getElementById('npApproveAllow'),
      }));
    } catch (e) { d = { evaluateFailed: String(e).slice(0, 300) }; }
    d.netConsole = (s.netConsole || []).slice(-20);
    d.pageErrors = s.errors || [];
    d.thirdPartyRequests = Array.from(new Set(s.thirdParty || []));
    out.sides[label] = d;
    console.log(`  -- ${label} --`);
    console.log(`     coi/sab        ${d.coi} / ${d.sab}     Netplay=${d.netplayLoaded} PROTO=${d.proto}`);
    console.log(`     sessions       ${J(d.sessions)}`);
    console.log(`     __dcNet()      ${J(d.net)}`);
    console.log(`     __dcNetHud()   ${J(d.hud && { mode: d.hud.mode, telemetry: d.hud.telemetry })}`);
    console.log(`     __dcNetRoom()  ${J(d.room && { ports: d.room.ports, rows: d.room.rows.map((r) => r.text), barrier: d.room.barrier })}`);
    console.log(`     #netStatus     ${J(d.status)}`);
    console.log(`     third-party    ${d.thirdPartyRequests.length ? d.thirdPartyRequests.join(' ') : 'NONE — the broker script was never fetched'}`);
    console.log(`     pageerrors     ${d.pageErrors.length ? d.pageErrors.join(' | ') : 'none'}`);
    for (const ln of d.netConsole) console.log(`       * ${ln}`);
  }
  return out;
}

const uptime = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
console.log('\n== netplay_realui_pair_test  (lockstep room flow) ==');
console.log(`  uptime      ${uptime}`);
console.log(`  loadavg     ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);
console.log(`  url         ${PAGE_URL}`);
console.log(`  transport   ${TRANSPORT === 'local' ? '?net=local (CONTROL ARM — cannot pair across profiles)' : 'the page picks its own'}`);
console.log('  NOTE        this rig does NOT boot a disc. The N-core proof is dreamcast/tools/netplay_room_e2e.mjs.');

const summary = { when: new Date().toISOString(), url: PAGE_URL, game: GAME, uptime, results: null };
const t0 = Date.now();
const hostB = await launch('opener'), guestB = await launch('joiner');
let host = null, guest = null, exitCode = 1;
try {
  host = (await hostB.pages())[0]; guest = (await guestB.pages())[0];
  watch(host, 'opener'); watch(guest, 'joiner');
  await host.setViewport({ width: 1200, height: 820 });
  await guest.setViewport({ width: 1200, height: 820 });
  for (const p of [host, guest]) {
    try { const cdp = await p.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  }

  console.log('\n== both browsers open the page ==');
  await Promise.all([gotoSettled(host, PAGE_URL), gotoSettled(guest, PAGE_URL)]);
  const hReady = await until(host, "return (typeof window.__dcNet === 'function') ? true : null;", 60000);
  const gReady = await until(guest, "return (typeof window.__dcNet === 'function') ? true : null;", 60000);
  T.cell(hReady && gReady, 'pages-mount', 'both browsers published window.__dcNet',
    `opener=${hReady} joiner=${gReady} — the page never wired its panel`);

  const seams = await host.evaluate(() => ({ hud: typeof window.__dcNetHud, room: typeof window.__dcNetRoom }));
  T.cell(seams.hud === 'function' && seams.room === 'function', 'room-and-hud-seams-exist',
    '__dcNetHud and __dcNetRoom are published — the panel that reports stalls and desyncs is present',
    `seams: ${J(seams)}`);

  const hNet0 = await host.evaluate(() => window.__dcNet());
  T.cell(hNet0 && hNet0.supported, 'netplay-supported',
    `Netplay.supported() is true; transport = "${hNet0 && hNet0.transport}"`, `__dcNet() = ${J(hNet0)}`);
  summary.transport = hNet0 && hNet0.transport;
  if (TRANSPORT !== 'local') {
    T.cell(hNet0 && hNet0.transport === 'peerjs', 'transport-is-the-shipped-default',
      'transport = "peerjs" — the broker path a second machine needs, not the BroadcastChannel path',
      `transport = ${J(hNet0 && hNet0.transport)} with no ?net= in the URL`);
  }

  const echoed = await guest.evaluate(() => new Promise((res) => {
    const ch = new BroadcastChannel('realui-isolation-probe'); let heard = false;
    ch.onmessage = () => { heard = true; }; ch.postMessage('ping');
    setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 900);
  }));
  T.cell(!echoed, 'profile-isolation',
    'no BroadcastChannel echo between the two browsers — anything that pairs did it through the broker',
    'a BroadcastChannel echo crossed the two profiles; this run proves nothing');

  // =========================================================================
  // THE ARCHITECTURE: streaming must not be reachable
  // =========================================================================
  console.log('\n== streaming is cancelled and must not be reachable ==');
  const surface = await host.evaluate(() => {
    const net = window.__dcNet();
    return {
      videoEl: !!document.getElementById('netVideo'),
      netStreamSeam: (typeof window.__dcNetStream),
      captureField: Object.prototype.hasOwnProperty.call(net, 'capture'),
      videoTracksField: Object.prototype.hasOwnProperty.call(net, 'videoTracks'),
      guestAudioField: Object.prototype.hasOwnProperty.call(net, 'guestAudio'),
      lead: (document.querySelector('#netBox p.lead').textContent || '').replace(/\s+/g, ' ').trim(),
    };
  });
  T.cell(!surface.videoEl && surface.netStreamSeam === 'undefined' && !surface.captureField &&
         !surface.videoTracksField && !surface.guestAudioField,
    'no-streaming-surface-remains',
    'no #netVideo element, no __dcNetStream seam, and __dcNet() carries no capture/videoTracks/guestAudio — ' +
    'the streaming path is gone from the page, not hidden behind a flag',
    `streaming surface still present: ${J(surface)}`);
  T.cell(!/streams? (picture|video)|the only Dreamcast|watching a video/i.test(surface.lead) &&
         /own machine|everyone runs/i.test(surface.lead),
    'the-panel-describes-lockstep',
    `the panel reads "${surface.lead.slice(0, 130)}…"`,
    `the panel's own copy still describes streaming: "${surface.lead}"`);

  // =========================================================================
  // THE ORDER: the room opens BEFORE the emulator
  // =========================================================================
  console.log('\n== the room opens with NOTHING booted ==');
  const booted0 = await Promise.all([host, guest].map((p) => p.evaluate(() => window.__dcProbe().booted)));
  T.cell(booted0.every((b) => b === false), 'nothing-is-booted',
    'neither browser has fetched a disc — this is the state a player opens a room from',
    `booted: ${J(booted0)}`);

  T.info('open-panel', await click(host, '#btnNet'));
  const statusText = await host.evaluate(() => (document.getElementById('netStatus').textContent || '').trim());
  T.cell(!/press Start first|needs a running game/i.test(statusText), 'no-boot-first-gate',
    `#netStatus reads "${statusText}" — it no longer tells a player to Start a game before hosting. That gate ` +
    'was a streaming requirement (you cannot capture a canvas that is not drawing) and its removal is the ' +
    'whole point of the new order',
    `#netStatus reads "${statusText}" — THE BOOT-FIRST GATE IS BACK`);

  await click(host, '#netHostBtn');
  const code = await until(host, "const t=(document.getElementById('netCode').textContent||'').trim(); " +
    "return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;", 30000);
  summary.code = code;
  const stillCold = await host.evaluate(() => window.__dcProbe().booted);
  T.cell(!!code && stillCold === false, 'room-opens-before-the-emulator',
    `room code "${code}" minted with booted=${stillCold} — no disc fetched, nothing started`,
    `code=${J(code)} booted=${stillCold}. #netStatus: ${J(await host.evaluate(() => document.getElementById('netStatus').textContent))}`);
  if (!code) { summary.diagnosis = await diagnose({ opener: host, joiner: guest }, 'no room code was minted'); throw new Error('no room code'); }

  const roomVisible = await host.evaluate(() => window.__dcNetRoom().visible);
  T.cell(roomVisible, 'the-room-panel-appears-immediately',
    'the room panel is on screen as soon as the room exists — the opener watches the seats fill',
    'the room panel stayed hidden after a room was opened');

  // =========================================================================
  // the joiner
  // =========================================================================
  console.log('\n== the joiner joins from a SEPARATE browser profile ==');
  await click(guest, '#btnNet');
  await click(guest, '#netJoinBtn');
  await guest.evaluate((g) => { const el = document.querySelector('#netGame'); if (el) el.value = g; }, GAME);
  // TYPE the code. dreamcast.html hangs a keydown handler with stopPropagation on
  // this field precisely because the page's window keydown handler eats letters
  // for the emulator; assigning .value would skip the line that makes it usable.
  let typed = null;
  try {
    await guest.click('#netCodeIn');
    await guest.type('#netCodeIn', code, { delay: 25 });
    typed = await guest.evaluate(() => document.querySelector('#netCodeIn').value);
  } catch (e) { typed = 'THREW: ' + (e.message || e); }
  T.cell(typed === code, 'code-field-accepts-typing',
    `typed "${code}" character by character and the field reads "${typed}"`,
    `typed "${code}", the field reads ${J(typed)}`);
  await click(guest, '#netGo');

  const proto = await host.evaluate(() => (window.Netplay && window.Netplay.PROTO) || null);
  summary.proto = proto;
  const prompt = await until(host, "return document.getElementById('npApproveAllow') ? true : null;", APPROVE_MS, 500);
  T.cell(!!prompt, 'the-opener-is-asked-before-anyone-is-let-in',
    `Allow/Deny raised on the room opener before anything flows (lib/netplay.js PROTO=${proto})`,
    `PROTO=${proto} raised no Allow/Deny prompt in ${APPROVE_MS} ms — either the joiner never reached the ` +
    'opener, or a code guesser would be let in unasked');
  if (prompt) await host.evaluate(() => document.getElementById('npApproveAllow').click());

  console.log('\n== do both sides reach the room? ==');
  const gConn = await until(guest, "return window.__dcNet().state === 'connected' ? true : null;", PAIR_MS, 500);
  const hConn = await until(host,  "return window.__dcNet().state === 'connected' ? true : null;", PAIR_MS, 500);
  const hNet = await host.evaluate(() => window.__dcNet()), gNet = await guest.evaluate(() => window.__dcNet());
  const hTxt = await host.evaluate(() => document.getElementById('netStatus').textContent.trim());
  const gTxt = await guest.evaluate(() => document.getElementById('netStatus').textContent.trim());
  summary.host = hNet; summary.guest = gNet; summary.hostStatusText = hTxt; summary.guestStatusText = gTxt;
  T.cell(!!(gConn && hConn), 'both-sides-are-in-the-room',
    `both report state "connected" (opener role=${hNet.role}, joiner role=${gNet.role})`,
    `opener.state=${J(hNet.state)} joiner.state=${J(gNet.state)} after ${PAIR_MS} ms. ` +
    `Opener says "${hTxt}", joiner says "${gTxt}".`);

  if (!(gConn && hConn)) {
    summary.diagnosis = await diagnose({ opener: host, joiner: guest }, 'the two sides never paired');
  } else {
    // ⚠ THE ONE LINE THAT MADE THIS PAGE TWO-MACHINES-ONE-EMULATOR.
    // netGuestStartLock() used to DISABLE Start for whoever joined.
    console.log('\n== a joiner runs their OWN console ==');
    const startState = await Promise.all([host, guest].map((p) => p.evaluate(() => {
      const b = document.getElementById('btnStart');
      return { disabled: !!b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), title: b.title };
    })));
    T.cell(startState.every((s) => !s.disabled), 'the-joiner-can-start-its-own-core',
      `Start is enabled on both machines: ${J(startState)} — the guest start lock is gone`,
      `Start states ${J(startState)} — a joiner that cannot press Start has no core of its own, ` +
      'which is the streaming architecture wearing a new name');

    console.log('\n== the room reports ports ==');
    const huds = await Promise.all([host, guest].map((p) => p.evaluate(() => window.__dcNetHud())));
    const rooms = await Promise.all([host, guest].map((p) => p.evaluate(() => window.__dcNetRoom())));
    summary.huds = huds; summary.rooms = rooms;
    const published = huds.every((h) => h.telemetry && h.telemetry.ports != null);
    T.cell(published, 'the-engine-publishes-a-room',
      `both sides report a port count: ${J(huds.map((h) => h.telemetry.ports))}`,
      'neither side published a room (netTelemetry().ports is null). THIS IS A PRODUCT REQUIREMENT: without ' +
      'it nobody can be told which player they are, and which port a player holds is which character they ' +
      `get. Telemetry seen: ${J(huds.map((h) => h.telemetry))}`);
    if (published) {
      const ports = huds.map((h) => h.telemetry.you && h.telemetry.you.port);
      T.cell(ports[0] != null && ports[1] != null && ports[0] !== ports[1],
        'the-two-players-hold-different-ports',
        `opener port ${ports[0]}, joiner port ${ports[1]} — two players on one port would drive the same ` +
        'character, which is a gameplay-visible failure',
        `ports ${J(ports)}`);
      T.cell(rooms.every((r) => r.rows.length === huds[0].telemetry.ports),
        'one-seat-per-port',
        `both sides drew ${rooms[0].rows.length} seats for a ${huds[0].telemetry.ports}-port console`,
        `seat counts ${J(rooms.map((r) => r.rows.length))} vs ports ${huds[0].telemetry.ports}`);
      T.info('rooms', rooms.map((r, i) => `${i ? 'joiner' : 'opener'}: ${r.ports} | ${r.rows.map((x) => x.text).join(' | ')}`).join('   ||   '));
    } else {
      T.bad('the-two-players-hold-different-ports', 'not assertable: no room was published (see above). ' +
        'Recorded as a FAILURE, not a void: a missing product requirement must not read as a green cell.');
    }

    console.log('\n== the session-truth panel is up ==');
    T.cell(huds.every((h) => h.visible), 'the-truth-panel-is-on-screen',
      `both sides show the session panel: ${J(huds.map((h) => h.text.replace(/\s+/g, ' ').slice(0, 60)))}`,
      `panel not visible on both sides: ${J(huds.map((h) => ({ on: h.on, visible: h.visible })))}`);
    T.cell(huds.every((h) => !h.desyncLatched), 'no-desync-was-raised',
      'neither side latched a desync', `desync latched: ${J(huds.map((h) => h.bannerText))}`);

    console.log('\n== leaving ==');
    await click(guest, '#netLeave');
    const sawLeave = await until(host, "const s=window.__dcNet().state; return (s==='closed'||s==='failed') ? s : null;", 30000);
    T.cell(!!sawLeave, 'the-opener-sees-the-joiner-leave', `opener session state = ${sawLeave}`,
      `opener still reports ${J((await host.evaluate(() => window.__dcNet())).state)}`);
  }

  try {
    const tag = target.hostname.replace(/[^a-z0-9]/gi, '-');
    await host.screenshot({ path: `/tmp/realui-${tag}-opener.png` });
    await guest.screenshot({ path: `/tmp/realui-${tag}-joiner.png` });
    T.info('screenshots', `/tmp/realui-${tag}-opener.png  /tmp/realui-${tag}-joiner.png`);
  } catch (e) { T.info('screenshots', 'failed: ' + (e.message || e)); }

  const errs = [SIDE.opener, SIDE.joiner].map((s) => (s.errors || []).length);
  T.cell(errs.every((n) => n === 0), 'no-page-errors', 'neither browser threw anything',
    `page errors: ${J([SIDE.opener.errors, SIDE.joiner.errors])}`);

  if (!summary.diagnosis) summary.diagnosis = await diagnose({ opener: host, joiner: guest }, 'end-of-run state, recorded on pass and fail alike');
} catch (e) {
  T.bad('rig', 'the run threw: ' + ((e && e.message) || e));
  try { if (host && guest) summary.diagnosis = await diagnose({ opener: host, joiner: guest }, 'the rig threw'); } catch (e2) {}
} finally {
  summary.results = rec;
  summary.elapsedMs = Date.now() - t0;
  summary.loadavgEnd = os.loadavg();
  try { fs.writeFileSync(OUT, JSON.stringify(summary, null, 2)); } catch (e) {}
  if (!KEEP) {
    try { await hostB.close(); } catch (e) {}
    try { await guestB.close(); } catch (e) {}
    for (const d of profiles) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  }
  const pass = rec.filter((r) => r.ok === true).length, fail = rec.filter((r) => r.ok === false).length;
  console.log(`\n  json        ${OUT}`);
  console.log(`[netplay-realui] ${pass}/${pass + fail} passed, ${(summary.elapsedMs / 1000).toFixed(1)} s  (${PAGE_URL})`);
  exitCode = fail ? 1 : 0;
}
process.exit(exitCode);

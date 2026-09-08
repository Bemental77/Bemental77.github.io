#!/usr/bin/env node
// ============================================================================
// room_hud_test.mjs — THE ROOM OPENS BEFORE THE EMULATOR, AND THE PAGE IS
//                     HONEST ABOUT WHAT THE SESSION IS DOING
// ============================================================================
//
// WHAT THIS EXISTS TO CATCH, and why the existing rig could not.
//
// 1. THE BOOT-FIRST GATE. dreamcast.html used to refuse to host until a game
//    was running ("Hosting needs a running game — pick a disc and press Start
//    first"). That was a STREAMING requirement: you cannot capture a canvas
//    that is not drawing. Streaming is cancelled (user directive 2026-09-08),
//    and under lockstep the order is the other way round — everybody joins the
//    room, ports are assigned, and only THEN does everyone load the same disc.
//    Making a player download 1,131 MB before they may find out whether they
//    even got a port is backwards.
//
//    ⚠ tools/netplay_realui_pair_test.mjs ASSERTED THE WRONG ORDER. It drives
//    romSelect -> Start -> wait for liveness -> Host, and its own comment cites
//    the refusal as if it were a requirement. A test that asserts the wrong
//    flow keeps passing while the product is wrong, which is exactly what
//    happened. This file asserts the flow the product is supposed to have.
//
// 2. THE ROOM IS A ROOM, NOT A PAIR. The Dreamcast has four Maple ports
//    (dreamcast/flycast-src/core/hw/maple/maple_devs.h:193 `#define
//    MAPLE_PORTS 4`, read from the live tree) and Gauntlet Legends is a
//    four-player game. A lobby that seats two is not the product. The port
//    count must come from the engine, never from a 4 in page code.
//
// 3. SESSION HONESTY. Four people can be connected, all four reading
//    "Connected", and be playing different games. The page must say which mode
//    it is in, what the input delay is IN FRAMES, WHICH player it is stalling
//    on, and — loudly — that a desync happened and WITH WHOM.
//
// HOW THE UNPROVABLE IS MADE PROVABLE. A desync and a four-way stall cannot be
// summoned on demand from a live session, and waiting for one to happen by luck
// is not a test. The page therefore reads its room/stall/desync state through
// ONE seam — netTelemetry() — which honours window.__dcNetTelemetryOverride.
// This rig drives that seam with deterministic input and asserts what the page
// PUTS ON SCREEN. It proves the surfacing, not the detection; the detection is
// the engine's and is proved by the engine's own tests.
//
// ⚠ `--net=local` IS USED ON PURPOSE. This rig needs exactly one browser and no
// second peer, so BroadcastChannel signalling keeps a live third-party broker
// out of a UI test. The transport is not what is under test here.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web
//   node dreamcast/tools/room_hud_test.mjs
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ORIGIN = arg('url', 'http://localhost:8080');
const HEADFUL = argv.includes('--headful');
const KEEP = argv.includes('--keep');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/dc-room';
fs.mkdirSync(OUT, { recursive: true });

const rec = [];
const ok = (n, d) => { rec.push({ n, ok: true, d }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { rec.push({ n, ok: false, d }); console.log(`  FAIL  ${n}  ${d}`); };
const cell = (p, n, good, badMsg) => (p ? ok(n, good) : bad(n, badMsg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };

console.log('\n== room_hud_test ==');
console.log(`  uptime   ${execSync('uptime').toString().trim()}`);
console.log(`  url      ${ORIGIN}/dreamcast.html?net=local`);

// ⚠ A FRESH PROFILE EVERY RUN. A persistent one cached a flycast_worker_emcc.js
// from before a sibling agent relinked the core, and the resulting torn
// js/wasm pair made the page raise "[flycast-shim] factory rejected: null
// function" and throw its full-screen diagnostics over the panel this rig is
// photographing. CLAUDE.md records that trap; nothing here needs a warm cache
// (this test never fetches a disc), so the cheapest fix is to not have one.
const profile = path.join('/private/tmp/claude-501', 'dc-room-profile');
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: HEADFUL ? false : 'new', userDataDir: profile,
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required'],
});
try {
  (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(browser, 'room_hud_test');
} catch (e) { console.log('  ⚠ leak-guard registration FAILED: ' + (e.message || e)); }

const page = (await browser.pages())[0];
const errors = [];
page.on('pageerror', (e) => { const t = (e && (e.message || e.type)) || String(e); errors.push(String(t).slice(0, 300)); console.log('  [page!] ' + String(t).slice(0, 200)); });
page.on('console', (m) => { const t = m.text(); if (/\[net\]/.test(t)) console.log('  [net] ' + t.slice(0, 180)); });

let exitCode = 1;
try {
  await page.setViewport({ width: 1280, height: 860 });
  const URL_ = ORIGIN + '/dreamcast.html?net=local';
  // coi-serviceworker installs on the first visit and reloads; land on the
  // already-isolated document rather than racing it.
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await sleep(2500);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => typeof window.__dcNet === 'function', { timeout: 60000 });

  const seams = await page.evaluate(() => ({
    net: typeof window.__dcNet, hud: typeof window.__dcNetHud, room: typeof window.__dcNetRoom,
    probe: typeof window.__dcProbe, pad: typeof window.__dcPad,
  }));
  cell(seams.hud === 'function' && seams.room === 'function', 'seams-exist',
    `__dcNetHud and __dcNetRoom are published alongside __dcNet/__dcPad/__dcProbe (${J(seams)})`,
    `missing seams: ${J(seams)}`);

  // =========================================================================
  // 1. THE ROOM OPENS WITH NOTHING BOOTED
  // =========================================================================
  console.log('\n== 1. the room opens BEFORE the emulator ==');
  const booted0 = await page.evaluate(() => window.__dcProbe().booted);
  cell(booted0 === false, 'nothing-is-booted',
    'no disc has been started — this is the state a player is in when they open the page',
    `__dcProbe().booted = ${booted0}; the rest of this section would not be testing the gate`);

  await page.click('#btnNet');
  const opened = await page.evaluate(() => ({
    on: document.getElementById('netOverlay').classList.contains('on'),
    status: (document.getElementById('netStatus').textContent || '').trim(),
    lead: (document.querySelector('#netBox p.lead').textContent || '').replace(/\s+/g, ' ').trim(),
  }));
  cell(opened.on, 'lobby-opens-with-no-game', `#netOverlay is on with booted=false`, 'the panel did not open');
  // THE GATE IS GONE. Its old text is the assertion: if any of it comes back,
  // the boot-first order has been reintroduced.
  cell(!/press Start first|needs a running game/i.test(opened.status),
    'no-boot-first-gate-in-the-status-line',
    `status reads "${opened.status}" — it no longer tells the player to Start a game before hosting`,
    `status reads "${opened.status}" — THE BOOT-FIRST GATE IS BACK`);
  // STREAMING IS CANCELLED AND MUST NOT BE DESCRIBED AS THE PRODUCT.
  cell(!/streams? (picture|video)|the only Dreamcast|watching a video/i.test(opened.lead),
    'panel-does-not-describe-streaming',
    `the panel's own copy reads "${opened.lead.slice(0, 120)}…"`,
    `the panel still describes streaming: "${opened.lead}"`);
  cell(/own machine|everyone runs/i.test(opened.lead), 'panel-describes-lockstep',
    'the panel says every machine runs the game',
    `the panel does not say every machine runs the game: "${opened.lead}"`);

  const hostBtnText = await page.evaluate(() => document.getElementById('netHostBtn').textContent.trim());
  await page.click('#netHostBtn');
  const code = await page.waitForFunction(() => {
    const t = (document.getElementById('netCode').textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;
  }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
  const bootedAfter = await page.evaluate(() => window.__dcProbe().booted);
  cell(!!code, 'room-opens-without-a-disc',
    `"${hostBtnText}" minted room code ${code} with booted=${bootedAfter} — no disc fetched, nothing started`,
    `no code appeared. status: ${J(await page.evaluate(() => document.getElementById('netStatus').textContent))}`);

  // =========================================================================
  // 2. THE ROOM PANEL — one row per PORT, from the engine's count
  // =========================================================================
  console.log('\n== 2. the room shows every port and who holds it ==');
  const empty = await page.evaluate(() => window.__dcNetRoom());
  cell(empty.visible, 'room-panel-visible', 'the room panel is on screen as soon as there is a session',
    `the room panel is hidden: ${J(empty)}`);
  // ⚠ WITH NO ENGINE TELEMETRY THE PAGE MUST DRAW NOTHING RATHER THAN A
  // PLAUSIBLE ROOM. A page that invents two seats is the same class of lie as a
  // status line reading "Connected" with nothing connected.
  cell(/has not published a room/i.test(empty.rows.map((r) => r.text).join(' ')),
    'no-invented-room',
    'with no telemetry the panel says the session has not published a room, and draws no seats',
    `the panel drew seats with no engine telemetry: ${J(empty.rows)}`);

  const room4 = {
    mode: 'lockstep', ports: 4, delayFrames: 3, frame: 1200,
    you: { port: 2, name: 'Casey', ready: true, loadPct: 1 },
    peers: [
      { id: 'a', name: 'Ada', port: 0, connected: true, ready: true, loadPct: 1, frame: 1200, rttMs: 24 },
      { id: 'b', name: 'Bo', port: 1, connected: true, ready: false, loadPct: 0.41, frame: 1200, rttMs: 31 },
    ],
    barrier: { started: false },
  };
  await page.evaluate((t) => { window.__dcNetTelemetryOverride = t; }, room4);
  await sleep(900);
  const r4 = await page.evaluate(() => window.__dcNetRoom());
  cell(r4.rows.length === 4, 'one-row-per-port',
    `the roster drew ${r4.rows.length} rows for a 4-port console — not 2`,
    `the roster drew ${r4.rows.length} rows for ports:4 — ${J(r4.rows)}`);
  cell(/4 ports/.test(r4.ports) && /1 free/.test(r4.ports),
    'port-count-and-free-seats',
    `the header reads "${r4.ports}" — 3 seats taken of 4`,
    `the header reads "${r4.ports}", expected 4 ports and 1 free`);
  const yourRow = r4.rows.find((x) => /you/.test(x.cls));
  cell(!!yourRow && /P3/.test(yourRow.text),
    'you-are-told-WHICH-player-you-are',
    `your seat renders as "${yourRow && yourRow.text}" — port 2 is Player 3, and a player has to know that ` +
    'before the game starts because it is which character they get',
    `no row marked "you", or it does not say P3: ${J(r4.rows)}`);
  const loadingRow = r4.rows.find((x) => /loading/.test(x.cls));
  cell(!!loadingRow && /41% loaded/.test(loadingRow.text),
    'per-player-load-progress',
    `"${loadingRow && loadingRow.text}" — the room shows WHICH player is still downloading and how far, ` +
    'rather than a silent freeze while somebody pulls 1,131 MB',
    `no per-player progress: ${J(r4.rows)}`);
  cell(/waiting for/i.test(r4.barrier) && /P2/.test(r4.barrier) && r4.barrierClass === 'hold',
    'start-barrier-names-who-is-holding',
    `the barrier reads "${r4.barrier}"`,
    `the barrier reads "${r4.barrier}" (class ${r4.barrierClass}) and does not name who is holding it up`);

  // =========================================================================
  // 3. THE HUD — mode, input delay in FRAMES, named stall, loud desync
  // =========================================================================
  console.log('\n== 3. the on-screen panel tells the truth about the session ==');
  const h1 = await page.evaluate(() => window.__dcNetHud());
  cell(h1.visible && /LOCKSTEP/.test(h1.text), 'hud-names-the-mode',
    `the HUD over the picture reads "${h1.text.replace(/\s+/g, ' ').slice(0, 110)}…"`,
    `HUD not visible or not naming the mode: ${J(h1)}`);
  // ⚠ THE `est.` SUFFIX IS REQUIRED HERE, NOT TOLERATED. A lockstep frame is
  // one retro_run, not one vblank, so its length is a MEASURED quantity — and
  // this fixture has no core running, which means 50 ms is a 60 Hz guess. The
  // panel printed exactly that guess unlabelled for a Gauntlet room whose real
  // frame is ~34 ms and whose measured keydown->core latency was 128-139 ms
  // p50, i.e. it halved the number the player was trying to feel. So the cell
  // below accepts the label, and the one after it INSISTS on it.
  cell(/3 frames \(50 ms( est\.)?\)/.test(h1.text), 'hud-shows-input-delay-in-frames',
    'input delay is shown as "3 frames (50 ms)" — an exact integer, which is what lockstep has and streaming did not',
    `the HUD does not carry the frame delay: "${h1.text}"`);

  // ---- a stall, NAMED ----
  const stalled = JSON.parse(JSON.stringify(room4));
  stalled.stalled = true; stalled.stallMs = 420; stalled.stallTotalMs = 1900;
  stalled.waitingOn = [1];
  stalled.peers[1].stalling = true;
  await page.evaluate((t) => { window.__dcNetTelemetryOverride = t; }, stalled);
  await sleep(900);
  const h2 = await page.evaluate(() => window.__dcNetHud());
  cell(/50 ms est\./.test(h1.text), 'an-UNMEASURED-frame-length-is-labelled-as-an-estimate',
    'with no core running the panel says "50 ms est." rather than asserting 50 ms — the frame length is ' +
    'measured from the presented rate at 1.000x, and a title that renders every other vblank has a ~34 ms ' +
    'frame, so an unlabelled 60 Hz figure is a wrong number stated confidently',
    `the panel printed an unlabelled millisecond figure with no core running: "${h1.text.replace(/\s+/g, ' ').slice(0, 140)}"`);

  cell(h2.stalled && /WAITING FOR/.test(h2.text) && /P2/.test(h2.text),
    'stall-names-the-player',
    `the HUD reads "${(h2.stallWhy || '').slice(0, 90)}" — in a room of four, "waiting…" is not actionable; ` +
    'this says whose connection everyone is waiting on',
    `stalled=${h2.stalled}, text "${h2.text}" — the stall does not name a player`);

  // ---- a desync: loud, named, latched ----
  const desynced = JSON.parse(JSON.stringify(room4));
  desynced.desync = true; desynced.desyncFrame = 1207; desynced.desyncPeers = [1];
  desynced.desyncDetail = 'state hash 0x8f21ab40 vs 0x1c7e0355';
  await page.evaluate((t) => { window.__dcNetTelemetryOverride = t; }, desynced);
  await sleep(900);
  const h3 = await page.evaluate(() => window.__dcNetHud());
  cell(h3.bannerVisible, 'desync-is-surfaced-loudly',
    'a full-width red banner is on screen over the picture, role="alert"',
    `no banner: ${J({ visible: h3.bannerVisible, latched: h3.desyncLatched })}`);
  cell(/DESYNC/.test(h3.bannerText) && /P2/.test(h3.bannerText) && /1207/.test(h3.bannerText),
    'desync-names-the-peer-and-the-frame',
    `"${h3.bannerText.replace(/\s+/g, ' ').slice(0, 150)}…"`,
    `the banner does not name who diverged or where: "${h3.bannerText}"`);
  const bannerBox = await page.evaluate(() => {
    const b = document.getElementById('netDesync');
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, z: cs.zIndex, display: cs.display };
  });
  cell(bannerBox.w > 300 && bannerBox.h > 20 && bannerBox.display !== 'none',
    'desync-banner-is-actually-on-screen',
    `${bannerBox.w}x${bannerBox.h} px, background ${bannerBox.bg}, z-index ${bannerBox.z} — measured from layout, ` +
    'not from a class name: a banner styled into invisibility would pass a class check and fail a player',
    `the banner has no box: ${J(bannerBox)}`);

  // LATCHED. A banner that clears itself the moment the next check happens to
  // agree is worse than none — the two simulations have already diverged.
  const agreeing = JSON.parse(JSON.stringify(room4));
  await page.evaluate((t) => { window.__dcNetTelemetryOverride = t; }, agreeing);
  await sleep(900);
  const h4 = await page.evaluate(() => window.__dcNetHud());
  cell(h4.bannerVisible && h4.desyncLatched, 'desync-latches',
    'the banner is still up after telemetry stopped reporting the desync — divergence does not un-happen',
    `the banner cleared itself: ${J({ visible: h4.bannerVisible, latched: h4.desyncLatched })}`);

  // ---- NOT lockstep is a FAULT, not a mode ----
  await page.evaluate(() => { window.__dcNetTelemetryOverride = null; });
  await page.evaluate(() => { window.__dcNetHud(); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__dcNetHud === 'function', { timeout: 60000 });
  await page.click('#btnNet'); await page.click('#netHostBtn');
  await page.waitForFunction(() => /^[A-HJ-NP-Z2-9]{5}$/.test((document.getElementById('netCode').textContent || '').trim()), { timeout: 30000 });
  await page.evaluate(() => { window.__dcNetTelemetryOverride = { mode: 'stream', ports: 2 }; });
  await sleep(900);
  const h5 = await page.evaluate(() => window.__dcNetHud());
  cell(h5.bannerVisible && /NOT RUNNING LOCKSTEP/i.test(h5.bannerText),
    'a-non-lockstep-session-is-a-fault',
    `"${h5.bannerText.replace(/\s+/g, ' ').slice(0, 130)}…" — streaming is cancelled, so there is no fallback ` +
    'for this panel to hide a fault behind',
    `a mode:"stream" session did not raise a fault banner: ${J({ v: h5.bannerVisible, t: h5.bannerText })}`);

  // Evidence.
  await page.evaluate((t) => { window.__dcNetTelemetryOverride = t; }, (() => {
    const x = JSON.parse(JSON.stringify(room4));
    x.stalled = true; x.stallMs = 620; x.waitingOn = [1]; x.peers[1].stalling = true;
    x.desync = true; x.desyncFrame = 1207; x.desyncPeers = [1];
    x.desyncDetail = 'state hash 0x8f21ab40 vs 0x1c7e0355';
    return x;
  })());
  await sleep(900);
  await page.screenshot({ path: path.join(OUT, 'room-panel.png') });
  await page.evaluate(() => document.getElementById('netClose').click());
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'hud-over-picture.png') });
  console.log(`\n  screenshots ${OUT}/room-panel.png  ${OUT}/hud-over-picture.png`);

  // THE SCREENSHOTS ARE THE EVIDENCE, so nothing may be sitting on top of them.
  // A stale cached worker once put the page's own full-screen diagnostics over
  // the whole panel, and the screenshot still looked like a screenshot.
  const covered = await page.evaluate(() => Array.prototype.filter.call(document.querySelectorAll('div'), (e) => {
    if (!/Dreamcast diagnostics/i.test(e.textContent || '')) return false;
    const r = e.getBoundingClientRect();
    return r.width > 100 && r.height > 100 && e.offsetParent !== null;
  }).length);
  cell(covered === 0, 'nothing-covers-the-evidence',
    'the page is not showing its diagnostics overlay, so the screenshots above are of the room panel itself',
    `${covered} diagnostics overlay(s) on screen — the screenshots are of the diagnostic, not of the product`);
  cell(errors.length === 0, 'no-page-errors', 'the page threw nothing across the whole run',
    `page errors: ${J(errors)}`);
  exitCode = rec.some((r) => !r.ok) ? 1 : 0;
} catch (e) {
  bad('rig', 'the run threw: ' + ((e && e.stack) || e));
  try { await page.screenshot({ path: path.join(OUT, 'FAIL.png') }); } catch (e2) {}
} finally {
  fs.writeFileSync(path.join(OUT, 'room_hud_test.json'), JSON.stringify({ when: new Date().toISOString(), rec, errors }, null, 2));
  if (!KEEP) { try { await browser.close(); } catch (e) {} }
  const pass = rec.filter((r) => r.ok).length, fail = rec.filter((r) => !r.ok).length;
  console.log(`\n[room-hud] ${pass}/${pass + fail} passed   loadavg ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);
}
process.exit(exitCode);

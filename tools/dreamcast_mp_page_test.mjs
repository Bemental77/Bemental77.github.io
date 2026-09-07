#!/usr/bin/env node
// Does the DEDICATED multiplayer page actually put a second player on the host's
// Dreamcast — and does it stay light while doing it?
//
// WHAT THIS PROVES THAT tools/dreamcast_netplay_test.mjs DOES NOT.
// That test runs BOTH sides on dreamcast.html, so both tabs load the emulator.
// The whole reason dreamcast_multiplayer.html exists is that PLAYER 2 NEEDS
// NEITHER: no core, no SharedArrayBuffer, no disc. So this rig asserts the
// negative as hard as the positive — the guest tab must issue ZERO requests
// under /dreamcast/ while it is being player 2. A "light" page that quietly
// pulls 563 MB is the failure mode, and it would be invisible from the UI.
//
// It also drives the HANDOFF, which is the only part neither existing test can
// reach: the lobby mints a code, navigates to
// dreamcast.html?np=<code>&game=<key>, and that page must auto-select the disc,
// boot it, and host under THAT EXACT CODE. A page that minted a fresh code
// would look identical until a guest tried to join.
//
// ⚠ WHAT IS DELIBERATELY NOT CLAIMED. The shipped core has no Maple device on
// controller port 1 (dreamcast/docs/core-relink-broken/), so the guest's bytes
// reach the emulator worker and nothing polls them. The chain is therefore
// asserted UP TO AND INCLUDING the exact byte array the host hands the worker
// for port 1 — window.__dcNet().sentP2 — and stops there. Two characters moving
// on screen is not tested and must not be claimed from this rig.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # gate, per CLAUDE.md
//   npm run web                                          # port 8080, gate #2
//   node tools/dreamcast_mp_page_test.mjs
//
// ENV
//   CHROME_PATH    path to Chrome (default: the macOS bundle)
//   ORIGIN         default http://localhost:8080
//   DCMP_GAME      romSelect key (default 'gauntlet' — the co-op target)
//   DCMP_BOOT_MS   how long to wait for the host to boot (default 300000)
//   DCMP_KEEP      leave the browser open at the end (debugging)
import puppeteer from 'puppeteer';
import fs from 'fs';
import { execSync } from 'child_process';

const CHROME  = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN  = process.env.ORIGIN || 'http://localhost:8080';
const GAME    = process.env.DCMP_GAME || 'gauntlet';
const BOOT_MS = parseInt(process.env.DCMP_BOOT_MS || '300000', 10);

const res = [];
const ok   = (n, d) => { res.push({ n, ok: true });  console.log(`  PASS  ${n}  ${d}`); };
const bad  = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ POLL FROM NODE, never page.waitForFunction — it polls on rAF and one of
// these two tabs is always in the background. tools/netplay_test.mjs records
// that trap producing a false negative on a session whose own log read
// connected.
async function until(page, fn, ms, everyMs = 250, onTick = null) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (onTick) onTick(Date.now() - t0);
    await sleep(everyMs);
  }
}

const load = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
console.log('\n== machine ==');
info('uptime', load);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    // Both tabs must keep running: only one can be foreground and Chromium
    // throttles rAF in the other, which would stop the host's input pump and
    // the guest's pad send at the same time.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // The guest attaches a <video> carrying the host's audio; without this the
    // element is refused playback and the picture never starts.
    '--autoplay-policy=no-user-gesture-required',
    '--disk-cache-size=33554432',
  ],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'dreamcast_mp_page_test'); } catch (_e) {}

// ---------------------------------------------------------------------------
// 1. THE LOBBY
// ---------------------------------------------------------------------------
console.log('\n== the lobby page ==');
const lobby = await browser.newPage();
lobby.on('pageerror', (e) => console.log(`  [lobby!] ${e.message}`));
// EVERY request this tab makes, from the very first byte. The host tab
// eventually becomes dreamcast.html and legitimately fetches a disc, so the
// counter is snapshotted at the moment of handoff and the guest gets its own.
const lobbyReqs = [];
lobby.on('request', (r) => lobbyReqs.push(r.url()));
await lobby.goto(ORIGIN + '/dreamcast_multiplayer.html?net=local', { waitUntil: 'domcontentloaded', timeout: 60000 });
const mounted = await until(lobby, () => typeof window.__dcmp === 'function' && window.__dcmp().supported, 30000);
mounted ? ok('lobby-mounts', 'window.__dcmp reports supported')
        : bad('lobby-mounts', 'the page never published a supported test seam');

const shape = await lobby.evaluate(() => ({
  lobbyShown: !document.getElementById('lobby').hidden,
  unsupportedShown: !document.getElementById('unsupported').hidden,
  card: !!document.querySelector('#lobbyCard .np-card'),
  floatingBtn: !!document.querySelector('.np-btn'),
  select: !!document.querySelector('#lobbyCard .np-sel'),
  transport: window.__dcmp().transport,
}));
(shape.lobbyShown && !shape.unsupportedShown && shape.card && shape.select && !shape.floatingBtn)
  ? ok('lobby-inline', `the netplay card is mounted inline (no floating .np-btn), with a disc picker; transport=${shape.transport}`)
  : bad('lobby-inline', JSON.stringify(shape));

// DRIFT GUARD. lib/netplay.js refuses a pairing whose game names differ, so this
// page's copied disc list and dreamcast.html's <select id="romSelect"> must
// agree exactly — including order, since the picker's default depends on it.
const dcHtml = fs.readFileSync('dreamcast.html', 'utf8');
const selBlock = dcHtml.slice(dcHtml.indexOf('<select id="romSelect">'));
const dcGames = [...selBlock.slice(0, selBlock.indexOf('</select>')).matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
const mpGames = await lobby.evaluate(() => window.__dcmp().games);
JSON.stringify(dcGames) === JSON.stringify(mpGames)
  ? ok('game-list-matches-dreamcast-html', `[${mpGames.join(', ')}]`)
  : bad('game-list-matches-dreamcast-html', `dreamcast.html=[${dcGames.join(', ')}] lobby=[${mpGames.join(', ')}] — a mismatched key fails the pairing with "the other player is on <game>"`);

// ---------------------------------------------------------------------------
// 2. THE HANDOFF
// ---------------------------------------------------------------------------
console.log('\n== host hands off to the emulator page ==');
const code = await lobby.evaluate((g) => {
  document.querySelector('#lobbyCard .np-sel').value = g;
  document.querySelectorAll('#lobbyCard .np-row button')[0].click();   // Host
  return document.querySelector('#lobbyCard .np-code').textContent.trim();
}, GAME);
/^[A-HJ-NP-Z2-9]{5}$/.test(code) ? ok('lobby-mints-a-code', `"${code}" — shown before anything is downloaded`)
                                 : bad('lobby-mints-a-code', code);
const preHandoffReqs = lobbyReqs.length;
await lobby.evaluate((g) => {
  document.querySelector('#lobbyCard .np-sel').value = g;
  document.querySelector('#lobbyCard .np-act button').click();          // "Host — load the game"
}, GAME);
const landed = await until(lobby, () => (location.pathname === '/dreamcast.html') ? location.search : null, 20000);
const host = lobby;
if (landed) {
  const q = new URLSearchParams(landed);
  (q.get('np') === code && q.get('game') === GAME && q.get('net') === 'local')
    ? ok('handoff-url', `dreamcast.html${landed} — the code the other player was already shown travels verbatim`)
    : bad('handoff-url', `dreamcast.html${landed} wanted np=${code} game=${GAME} net=local`);
} else bad('handoff-url', 'the lobby never navigated to dreamcast.html');
info('lobby-weight', `${preHandoffReqs} network requests to form the party and show a code`);

// dreamcast.html installs /coi-serviceworker.js and RELOADS ITSELF to become
// cross-origin isolated. Anything touched during that reload throws "Execution
// context destroyed", which reads exactly like a crash.
const hostReady = await until(host, () => (self.crossOriginIsolated === true) && typeof window.__dcNet === 'function', 90000);
hostReady ? ok('host-page-ready', 'dreamcast.html is cross-origin isolated and exposes __dcNet')
          : bad('host-page-ready', 'the emulator page never settled after the coi reload');
const picked = await host.evaluate(() => document.getElementById('romSelect').value);
picked === GAME ? ok('handoff-selects-the-disc', `#romSelect = "${picked}" with no click from anyone`)
                : bad('handoff-selects-the-disc', `#romSelect = "${picked}", wanted "${GAME}"`);

console.log('\n== the host boots, unattended ==');
let lastPhase = '';
const booted = await until(host, () => (window.__dcProbe && window.__dcProbe().booted) || false,
  BOOT_MS, 1000, async () => {
    const p = await host.evaluate(() => { const d = window.__dcProbe(); return d.phase + ' ' + Math.round(100 * d.discBytes / (d.discTotal || 1)) + '%'; }).catch(() => '');
    if (p && p !== lastPhase) { lastPhase = p; process.stdout.write(`  ....  booting  ${p}   \r`); }
  });
process.stdout.write('\n');
const probe = await host.evaluate(() => window.__dcProbe()).catch(() => ({}));
booted ? ok('host-auto-booted', `the handoff pressed Start itself — phase=${probe.phase} webgl2=${probe.webgl2}`)
       : bad('host-auto-booted', `phase=${probe.phase} why=${probe.why}`);
// A frozen emulator would hand the guest a still image that passes "non-black".
const flowing = await until(host, () => { const d = window.__dcProbe(); return d.fps > 0 || d.framesEver; }, 90000);
const rate = [];
for (let i = 0; i < 5; i++) { rate.push(await host.evaluate(() => window.__dcProbe().fps).catch(() => null)); await sleep(1000); }
flowing ? ok('host-rendering', `fps over 5 s = [${rate.join(', ')}] guest=${(await host.evaluate(() => window.__dcProbe().guestX)).toFixed(3)}x`)
        : bad('host-rendering', 'the emulator never reported a frame — nothing to stream');

// THE POINT OF THE HANDOFF: the SAME code, not a fresh one.
const armed = await until(host, () => { const n = window.__dcNet(); return (n.role === 'host' && n.code) ? n : null; }, 60000);
(armed && armed.code === code)
  ? ok('host-arms-the-handed-code', `__dcNet().code = "${armed.code}" (capture arm: ${armed.capture})`)
  : bad('host-arms-the-handed-code', `wanted "${code}", got ${JSON.stringify(armed)} — a fresh code strands the guest silently`);

// ---------------------------------------------------------------------------
// 3. THE GUEST — light, and really player 2
// ---------------------------------------------------------------------------
console.log('\n== the guest joins from the light page ==');
const guest = await browser.newPage();
guest.on('pageerror', (e) => console.log(`  [guest!] ${e.message}`));
const guestReqs = [];
guest.on('request', (r) => guestReqs.push(r.url()));
await guest.goto(ORIGIN + '/dreamcast_multiplayer.html?net=local&pad=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await until(guest, () => typeof window.__dcmp === 'function', 30000);
await guest.evaluate((g, c) => {
  document.querySelector('#lobbyCard .np-sel').value = g;
  document.querySelectorAll('#lobbyCard .np-row button')[1].click();    // Join
  document.querySelector('#lobbyCard .np-in').value = c;
  document.querySelector('#lobbyCard .np-act button').click();          // Join
}, GAME, code || '');
const gConn = await until(guest, () => window.__dcmp().state === 'connected', 60000);
const hConn = await until(host,  () => window.__dcNet().state === 'connected', 60000);
(gConn && hConn) ? ok('peers-connected', 'both sides report connected')
                 : bad('peers-connected', `host=${hConn} guest=${gConn} — ${JSON.stringify(await guest.evaluate(() => window.__dcmp()))}`);

console.log('\n== the guest gets REAL GAME PIXELS ==');
const tracks = await until(guest, () => window.__dcmp().tracks, 30000);
(tracks && tracks.some((t) => t.startsWith('video:live')))
  ? ok('guest-track-live', JSON.stringify(tracks))
  : bad('guest-track-live', JSON.stringify(tracks));
await until(guest, () => window.__dcmp().videoW > 0, 30000);
const view = await guest.evaluate(() => window.__dcmp());
(view.playing && view.videoW > 0)
  ? ok('guest-view-is-the-video', `<video> ${view.videoW}x${view.videoH} readyState=${view.readyState} paused=${view.paused} muted=${view.muted}`)
  : bad('guest-view-is-the-video', JSON.stringify(view));

// THE ASSERTION THAT MATTERS. A black track, a frozen track and a live one are
// three different answers and only the third passes.
// ⚠ AN EXACT PIXEL HASH OVER-COUNTS "CHANGE": the video arrives through a LOSSY
// codec, so two decodes of ONE identical source frame differ in the low bits and
// every sample looks distinct. A COARSE 4x3 grid of block means, quantised, is
// what survives codec noise and only moves when the picture really moves. Both
// counts are reported; only the coarse one is evidence.
const samples = [];
for (let i = 0; i < 16; i++) {
  samples.push(await guest.evaluate(() => {
    const v = document.getElementById('mpVideo');
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, 160, 120);
    try { g.drawImage(v, 0, 0, 160, 120); } catch (e) { return { err: e.message }; }
    const d = g.getImageData(0, 0, 160, 120).data;
    let nonBlack = 0, sum = 0, h = 2166136261;
    const gw = 4, gh = 3, acc = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
      const k = (y * 160 + x) * 4;
      const lum = d[k] + d[k + 1] + d[k + 2];
      if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
      sum += lum;
      h = Math.imul(h ^ (d[k] + d[k + 1] * 3 + d[k + 2] * 7), 16777619) >>> 0;
      acc[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)] += lum / 3;
      cnt[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)]++;
    }
    return { nonBlack, total: d.length / 4, mean: +(sum / (3 * d.length / 4)).toFixed(2), h,
             coarse: Array.from(acc, (a, i2) => Math.round(a / cnt[i2] / 32)).join('.') };
  }));
  await sleep(400);
}
const good = samples.filter((s) => !s.err);
const maxNonBlack = Math.max(...good.map((s) => s.nonBlack), 0);
const distinct = new Set(good.map((s) => s.coarse)).size;
info('frame-signatures', `${new Set(good.map((s) => s.h)).size} distinct exact hashes vs ${distinct} distinct coarse — the gap is lossy-codec noise`);
(maxNonBlack > 0)
  ? ok('guest-frames-non-black', `${maxNonBlack}/${good[0] ? good[0].total : 0} pixels lit at peak; means ${good.map((s) => s.mean).join(', ')}`)
  : bad('guest-frames-non-black', `every sample was pure black — a live track carrying nothing`);
(distinct >= 2)
  ? ok('guest-frames-changing', `${distinct} distinct COARSE signatures over ~6.4 s (${[...new Set(good.map((s) => s.coarse))].slice(0, 3).join('  ')})`)
  : bad('guest-frames-changing', `only ${distinct} distinct coarse signature(s) — the picture is frozen, not live`);

// ---------------------------------------------------------------------------
// 4. THE WHOLE POINT: the guest is LIGHT
// ---------------------------------------------------------------------------
console.log('\n== the guest never touched a disc ==');
const discReqs = guestReqs.filter((u) => new URL(u).pathname.startsWith('/dreamcast/'));
discReqs.length === 0
  ? ok('guest-loads-no-disc', `${guestReqs.length} requests total, ZERO under /dreamcast/ — no core, no wasm, no disc image`)
  : bad('guest-loads-no-disc', `${discReqs.length} request(s) under /dreamcast/: ${discReqs.slice(0, 5).join(' ')}`);
info('guest-requests', guestReqs.map((u) => new URL(u).pathname).join(' '));

// ---------------------------------------------------------------------------
// 5. THE GUEST IS PLAYER 2 — asserted on the literal bytes the host hands the core
// ---------------------------------------------------------------------------
console.log('\n== the guest is PLAYER 2 ==');
// Port 1 occupies bytes 64..127 of the 256-byte pad buffer; __dcNet().sentP2 is
// bytes 64..75 of the buffer dreamcast.html's frameStep ACTUALLY posted to the
// emulator worker. Nothing below reads a session field or a UI state.
const p2 = () => host.evaluate(() => window.__dcNet().sentP2);
const p1 = () => host.evaluate(() => window.__dcPad().slice(0, 12));
const s16 = (a, o) => (a ? ((a[o] | (a[o + 1] << 8)) << 16) >> 16 : 0);
const RB = { B: 0, RIGHT: 7, A: 8 };

const idle = { p2: await p2(), p1: await p1() };
(idle.p2 && idle.p2.every((b) => b === 0))
  ? ok('player2-idle-before', 'port 1 is all zero with nobody pressing anything')
  : bad('player2-idle-before', JSON.stringify(idle.p2));

const press = (keys, down) => guest.evaluate((k, d) => {
  k.forEach((key) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key })));
}, keys, down);

// KEYBOARD ARM. m = RETRO B (id 0, the Dreamcast CONFIRM); d = RIGHT (id 7)
// which also drives FULL analog deflection — the stick is what walks in these
// games, so a digital-only remote pad reproduces "unable to move".
await press(['m', 'd'], true);
await sleep(1200);
const kb = { p2: await p2(), p1: await p1(), mask: await guest.evaluate(() => window.__dcmp().mask) };
await press(['m', 'd'], false);
await sleep(1200);
const kbAfter = { p2: await p2(), p1: await p1() };

const kbBits = kb.p2 ? kb.p2[0] : 0, kbLx = s16(kb.p2, 8);
((kbBits & (1 << RB.B)) && (kbBits & (1 << RB.RIGHT)))
  ? ok('guest-keyboard-lands-on-port-1', `worker byte 64 = 0x${kbBits.toString(16)} (B|RIGHT) while the guest holds m+d; guest mask = 0x${(kb.mask >>> 0).toString(16)}`)
  : bad('guest-keyboard-lands-on-port-1', `worker byte 64 = 0x${Number(kbBits).toString(16)}, wanted bits 0 and 7 — ${JSON.stringify(kb.p2)}`);
(kbLx > 30000)
  ? ok('guest-analog-crosses', `port 1 left-stick X = ${kbLx} (full right) in the bytes handed to the core`)
  : bad('guest-analog-crosses', `port 1 left-stick X = ${kbLx}`);
// PORT 0 IS THE HOST'S OWN CONTROLLER. Nobody is touching it, so the guest's
// input must not appear there — if the two ports were one buffer this fails.
(kb.p1 && kb.p1.every((b) => b === 0))
  ? ok('guest-does-not-touch-port-0', 'port 0 stayed all-zero while port 1 carried the guest')
  : bad('guest-does-not-touch-port-0', JSON.stringify(kb.p1));
(kbAfter.p2 && kbAfter.p2.every((b) => b === 0))
  ? ok('guest-pad-releases', 'port 1 returned to all-zero on key release')
  : bad('guest-pad-releases', JSON.stringify(kbAfter.p2));

// TOUCH ARM — the on-screen controls, which are the whole interface on a phone
// and share no code with the keyboard path above.
const padVisible = await guest.evaluate(() => window.__dcmp().padShown);
padVisible ? ok('touch-controls-shown', '#pad is on') : bad('touch-controls-shown', 'the on-screen pad is hidden');
await guest.evaluate(() => {
  ['tA', 'tS'].forEach((id) => document.getElementById(id).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
});
await sleep(1200);
const touch = { p2: await p2(), mask: await guest.evaluate(() => window.__dcmp().mask) };
await guest.evaluate(() => {
  ['tA', 'tS'].forEach((id) => document.getElementById(id).dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
});
await sleep(1200);
const touchAfter = await p2();
// On-screen A = RETRO_B (id 0, DC confirm) and Start = id 3.
const tBits = touch.p2 ? touch.p2[0] : 0;
((tBits & (1 << 0)) && (tBits & (1 << 3)))
  ? ok('guest-touch-lands-on-port-1', `worker byte 64 = 0x${tBits.toString(16)} (A|START) from the on-screen buttons; guest mask = 0x${(touch.mask >>> 0).toString(16)}`)
  : bad('guest-touch-lands-on-port-1', `worker byte 64 = 0x${Number(tBits).toString(16)}, wanted bits 0 and 3 — ${JSON.stringify(touch.p2)}`);
(touchAfter && touchAfter.every((b) => b === 0))
  ? ok('guest-touch-releases', 'port 1 returned to all-zero on release')
  : bad('guest-touch-releases', JSON.stringify(touchAfter));

// Evidence, not decoration. A screenshot is the only thing that answers "was
// there really a game on that guest's screen" after the fact.
try {
  await guest.screenshot({ path: '/tmp/dcmp-guest.png' });
  await host.screenshot({ path: '/tmp/dcmp-host.png' });
  info('screenshots', '/tmp/dcmp-guest.png  /tmp/dcmp-host.png');
} catch (e) { info('screenshots', 'failed: ' + e.message); }

// ---------------------------------------------------------------------------
// 6. LEAVING
// ---------------------------------------------------------------------------
console.log('\n== leaving ==');
await guest.evaluate(() => document.getElementById('btnLeave').click());
const hostSawLeave = await until(host, () => { const s = window.__dcNet().state; return (s === 'closed' || s === 'failed') ? s : null; }, 25000);
hostSawLeave ? ok('host-sees-peer-leave', `host session state = ${hostSawLeave}`)
             : bad('host-sees-peer-leave', `host still reports ${await host.evaluate(() => window.__dcNet().state)}`);
const stillRunning = await host.evaluate(() => window.__dcProbe().booted);
stillRunning ? ok('host-keeps-playing', 'the emulator is still booted after the guest left')
             : bad('host-keeps-playing', 'the host stopped when the session ended');
const backToLobby = await until(guest, () => (typeof window.__dcmp === 'function' && !document.getElementById('lobby').hidden) || null, 20000);
backToLobby ? ok('guest-back-to-lobby', 'the guest is on a clean lobby again, with no emulator ever loaded')
            : bad('guest-back-to-lobby', 'the guest did not return to the lobby');

const summary = {
  when: new Date().toISOString(), uptime: load, game: GAME, code,
  handoffUrl: landed, lobbyRequestsBeforeHandoff: preHandoffReqs,
  guestRequests: guestReqs.map((u) => new URL(u).pathname),
  host: await host.evaluate(() => ({ net: window.__dcNet(), probe: window.__dcProbe() })).catch(() => null),
  videoSamples: samples,
  pad: { idle, kb, kbAfter, touch, touchAfter },
  results: res,
};
fs.writeFileSync('/tmp/dcmp-result.json', JSON.stringify(summary, null, 2));
info('json', '/tmp/dcmp-result.json');

if (!process.env.DCMP_KEEP) await browser.close();
const failed = res.filter((r) => !r.ok);
console.log(`\n[dreamcast-mp-page] ${res.length - failed.length}/${res.length} passed   (load at start: ${load.split('load averages:').pop().trim()})`);
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// Does the DEDICATED GameCube multiplayer page put a second player on the host's
// emulator — and does it stay light while doing it?
//
// The sibling of tools/dreamcast_mp_page_test.mjs, asserting the same three
// things on this console:
//   1. THE HANDOFF. The lobby mints a code and navigates to
//      gamecube.html?np=<code>&game=<base>, which must select that ROM, press
//      its own Start, and host under THAT EXACT CODE. A page that minted a
//      fresh code would look identical until a guest tried to join.
//   2. THE GUEST IS LIGHT. Zero requests under /gamecube/ from the guest tab —
//      no core, no ROM, no SharedArrayBuffer, no WebGPU requirement. That is the
//      entire reason the page exists and it would be invisible from the UI.
//   3. THE GUEST IS PLAYER 2, asserted on the LITERAL BYTES gamecube.html hands
//      the emulator worker for port 1 (window.__gcNet().sentP2 — bytes 8..15 of
//      the 16-byte buffer), never on a session field.
//
// ⚠ WHAT IS NOT CLAIMED. Whether Dolphin has a second GameCube controller
// configured to READ port 1 is a core question, not a page one, and is not
// tested here. This rig proves the chain up to the handoff to the core.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # gate, per CLAUDE.md
//   npm run web                                          # port 8080, gate #2
//   node tools/gamecube_mp_page_test.mjs
//
// ENV
//   CHROME_PATH    path to Chrome (default: the macOS bundle)
//   ORIGIN         default http://localhost:8080
//   GCMP_GAME      ROMS[].base (default '240pSuite-1.10b' — a 1.5 MB .dol on the
//                  JIT path, so the rig is not measuring a disc download.
//                  ⚠ NOT MarioParty4: gamecube.html routes that title to the
//                  RECOMP engine with no query parameter, and the recomp does
//                  not go through pollController, which is where port 1 is fed.)
//   GCMP_BOOT_MS   how long to wait for the host's core to come up (default 300000)
//   GCMP_HEADLESS  '1' forces headless. DEFAULT IS HEADFUL, deliberately: the
//                  documented GameCube inner loop runs its probe with
//                  PROBE_HEADLESS=0 (CLAUDE.md, GameCube build flow), and
//                  MEASURED 2026-09-07 this page produced ZERO frames for a whole
//                  run under headless Chrome even with --enable-unsafe-webgpu —
//                  its own status line read "render: NO FIRST FRAME". A headless
//                  arm therefore cannot answer any question about the picture.
//   GCMP_KEEP      leave the browser open at the end (debugging)
import puppeteer from 'puppeteer';
import fs from 'fs';
import { execSync } from 'child_process';

const CHROME  = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN  = process.env.ORIGIN || 'http://localhost:8080';
const GAME    = process.env.GCMP_GAME || '240pSuite-1.10b';
const BOOT_MS = parseInt(process.env.GCMP_BOOT_MS || '300000', 10);

const res = [];
const ok   = (n, d) => { res.push({ n, ok: true });  console.log(`  PASS  ${n}  ${d}`); };
const bad  = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ POLL FROM NODE, never page.waitForFunction — it polls on rAF and one of
// these two tabs is always in the background.
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

const HEADLESS = process.env.GCMP_HEADLESS === '1' ? 'new' : false;
info('headless', String(HEADLESS));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=IntensiveWakeUpThrottling',
    '--autoplay-policy=no-user-gesture-required',
    // gamecube.html's own render-path note: WITHOUT WebGPU Dolphin force-selects
    // the CPU Software Renderer and this build draws a flat green frame. The
    // same flags gamecube/tools/dolphin_render_probe.js uses, so this rig is not
    // measuring a configuration the GC probe already rejected.
    '--enable-unsafe-webgpu',
    '--disable-features=DelegatedCompositing,UseMultipleOverlays,MacOverlays,CanvasOopRasterization',
    '--disable-mac-overlays',
    '--js-flags=--max-old-space-size=4096',
    '--disk-cache-size=33554432',
  ],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'gamecube_mp_page_test'); } catch (_e) {}

// ---------------------------------------------------------------------------
// 1. THE LOBBY
// ---------------------------------------------------------------------------
console.log('\n== the lobby page ==');
const lobby = await browser.newPage();
lobby.on('pageerror', (e) => console.log(`  [lobby!] ${e ? e.message : 'null (no detail from the page)'}`));
const lobbyReqs = [];
lobby.on('request', (r) => lobbyReqs.push(r.url()));
await lobby.goto(ORIGIN + '/gamecube_multiplayer.html?net=local', { waitUntil: 'domcontentloaded', timeout: 60000 });
const mounted = await until(lobby, () => typeof window.__gcmp === 'function' && window.__gcmp().supported, 30000);
mounted ? ok('lobby-mounts', 'window.__gcmp reports supported')
        : bad('lobby-mounts', 'the page never published a supported test seam');

const shape = await lobby.evaluate(() => ({
  lobbyShown: !document.getElementById('lobby').hidden,
  unsupportedShown: !document.getElementById('unsupported').hidden,
  card: !!document.querySelector('#lobbyCard .np-card'),
  floatingBtn: !!document.querySelector('.np-btn'),
  select: !!document.querySelector('#lobbyCard .np-sel'),
  transport: window.__gcmp().transport,
}));
(shape.lobbyShown && !shape.unsupportedShown && shape.card && shape.select && !shape.floatingBtn)
  ? ok('lobby-inline', `the netplay card is mounted inline (no floating .np-btn), with a game picker; transport=${shape.transport}`)
  : bad('lobby-inline', JSON.stringify(shape));

// DRIFT GUARD. lib/netplay.js refuses a pairing whose game names differ, so this
// page's copied list and gamecube.html's ROMS[] must agree exactly.
const gcHtml = fs.readFileSync('gamecube.html', 'utf8');
const romsBlock = gcHtml.slice(gcHtml.indexOf('const ROMS = ['));
const gcGames = [...romsBlock.slice(0, romsBlock.indexOf('\n  ];')).matchAll(/base:\s*'([^']+)'/g)].map((m) => m[1]);
const mpGames = await lobby.evaluate(() => window.__gcmp().games);
JSON.stringify(gcGames) === JSON.stringify(mpGames)
  ? ok('game-list-matches-gamecube-html', `[${mpGames.join(', ')}]`)
  : bad('game-list-matches-gamecube-html', `gamecube.html=[${gcGames.join(', ')}] lobby=[${mpGames.join(', ')}] — a mismatched key fails the pairing with "the other player is on <game>"`);

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
const landed = await until(lobby, () => (location.pathname === '/gamecube.html') ? location.search : null, 20000);
const host = lobby;
if (landed) {
  const q = new URLSearchParams(landed);
  (q.get('np') === code && q.get('game') === GAME && q.get('net') === 'local')
    ? ok('handoff-url', `gamecube.html${landed} — the code the other player was already shown travels verbatim`)
    : bad('handoff-url', `gamecube.html${landed} wanted np=${code} game=${GAME} net=local`);
} else bad('handoff-url', 'the lobby never navigated to gamecube.html');
info('lobby-weight', `${preHandoffReqs} network requests to form the party and show a code`);

// gamecube.html installs /coi-serviceworker.js and RELOADS to become
// cross-origin isolated; anything touched during that reload throws "Execution
// context destroyed", which reads exactly like a crash.
const hostReady = await until(host, () => (self.crossOriginIsolated === true) && typeof window.__gcNet === 'function', 90000);
hostReady ? ok('host-page-ready', 'gamecube.html is cross-origin isolated and exposes __gcNet')
          : bad('host-page-ready', 'the emulator page never settled after the coi reload');
const picked = await host.evaluate(() => {
  const s = document.getElementById('romSelect');
  return s ? { idx: s.value, label: s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : null } : null;
});
const wantIdx = String(gcGames.indexOf(GAME));
(picked && picked.idx === wantIdx)
  ? ok('handoff-selects-the-rom', `#romSelect = ${picked.idx} ("${picked.label}") with no click from anyone — resolved from the BASE NAME "${GAME}", never an index`)
  : bad('handoff-selects-the-rom', `${JSON.stringify(picked)}, wanted index ${wantIdx}`);

console.log('\n== the host boots, unattended ==');
// TWO DIFFERENT QUESTIONS, kept apart on purpose.
//   coreUp — the CPU is running and pollController is shipping the pad buffer.
//            This is what PLAYER 2 depends on, and it is what the page arms
//            hosting on.
//   live   — frames are being produced. That is the RENDER path, which this page
//            has a standing, separately-tracked fault in, and conflating the two
//            would report a render bug as a co-op bug.
let lastPhase = '';
const coreUp = await until(host, () => (window.__gcNet && window.__gcNet().coreUp) || false,
  BOOT_MS, 1000, async () => {
    const p = await host.evaluate(() => {
      const R = window.__gcRate || {};
      return (document.getElementById('status') || {}).textContent + ' pub=' + (R.published || 0);
    }).catch(() => '');
    if (p && p !== lastPhase) { lastPhase = p; process.stdout.write(`  ....  booting  ${String(p).slice(0, 90)}   \r`); }
  });
process.stdout.write('\n');
coreUp ? ok('host-core-up', 'the handoff pressed Start itself and the core is running — the pad wire to the emulator is open')
       : bad('host-core-up', `the core never came up. status="${lastPhase}"`);
const rate = [];
for (let i = 0; i < 5; i++) { rate.push(await host.evaluate(() => { const R = window.__gcRate || {}; return { pub: R.published, shown: R.shown }; }).catch(() => null)); await sleep(1000); }
const hostFrames = rate.some((r) => r && ((r.pub > 0) || (r.shown > 0)));
hostFrames
  ? ok('host-producing-frames', `__gcRate over 5 s = ${JSON.stringify(rate)}`)
  : info('host-producing-frames', `ZERO frames: __gcRate over 5 s = ${JSON.stringify(rate)}, status "${lastPhase}". ` +
      `That is this page's RENDER path, not the netplay path — every picture claim below is VOID for this run, ` +
      `and nothing about the guest's picture can be concluded from it either way.`);

// THE POINT OF THE HANDOFF: the SAME code, not a fresh one.
const armed = await until(host, () => { const n = window.__gcNet(); return (n.role === 'host' && n.code) ? n : null; }, 90000);
(armed && armed.code === code)
  ? ok('host-arms-the-handed-code', `__gcNet().code = "${armed.code}" (capture arm: ${armed.capture})`)
  : bad('host-arms-the-handed-code', `wanted "${code}", got ${JSON.stringify(armed)} — a fresh code strands the guest silently`);

// ---------------------------------------------------------------------------
// 3. THE GUEST
// ---------------------------------------------------------------------------
console.log('\n== the guest joins from the light page ==');
const guest = await browser.newPage();
guest.on('pageerror', (e) => console.log(`  [guest!] ${e ? e.message : 'null'}`));
const guestReqs = [];
guest.on('request', (r) => guestReqs.push(r.url()));
await guest.goto(ORIGIN + '/gamecube_multiplayer.html?net=local&pad=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await until(guest, () => typeof window.__gcmp === 'function', 30000);
await guest.evaluate((g, c) => {
  document.querySelector('#lobbyCard .np-sel').value = g;
  document.querySelectorAll('#lobbyCard .np-row button')[1].click();    // Join
  document.querySelector('#lobbyCard .np-in').value = c;
  document.querySelector('#lobbyCard .np-act button').click();          // Join
}, GAME, code || '');

// ⚠ THE HOST IS ASKED FIRST — docs/audit-2026-09-08.md. Knowing the 5-character
// code used to be enough to receive gamecube.html's live video and audio, inject
// player-2 input and take the end-of-session save. lib/netplay.js now holds an
// inbound peer with none of that until a human allows it, and draws the dialog
// itself, so gamecube.html needed no change to get it.
console.log('\n== the host is asked before anything flows ==');
const prompt = await until(host, () => {
  const p = document.getElementById('npApprove');
  if (!p) return null;
  const s = document.getElementById('npApproveSas');
  return { sas: s ? s.getAttribute('data-sas') : null, allow: !!document.getElementById('npApproveAllow') };
}, 90000);
prompt && prompt.allow
  ? ok('host-is-asked-before-anything-flows', `Allow/Deny raised on gamecube.html with confirmation code ${prompt.sas}`)
  : bad('host-is-asked-before-anything-flows', 'no approval dialog — a code guesser would have been let straight in');
const preAllow = await host.evaluate(() => {
  const s = window.Netplay && Netplay.hostSession();
  return s ? s.admission() : null;
}).catch(() => null);
(preAllow && preAllow.approved === false && preAllow.offered === false)
  ? ok('no-offer-before-allow', 'the host has created no SDP offer yet — the tracks have not left the page')
  : bad('no-offer-before-allow', JSON.stringify(preAllow));
await host.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); });

const gConn = await until(guest, () => window.__gcmp().state === 'connected', 60000);
const hConn = await until(host,  () => window.__gcNet().state === 'connected', 60000);
(gConn && hConn) ? ok('peers-connected', 'both sides report connected')
                 : bad('peers-connected', `host=${hConn} guest=${gConn} — ${JSON.stringify(await guest.evaluate(() => window.__gcmp()))}`);

console.log('\n== the guest gets REAL GAME PIXELS ==');
const tracks = await until(guest, () => window.__gcmp().tracks, 30000);
(tracks && tracks.some((t) => t.startsWith('video:live')))
  ? ok('guest-track-live', JSON.stringify(tracks))
  : bad('guest-track-live', JSON.stringify(tracks));
await until(guest, () => window.__gcmp().videoW > 0, 30000);
const view = await guest.evaluate(() => window.__gcmp());
(view.playing && view.videoW > 0)
  ? ok('guest-view-is-the-video', `<video> ${view.videoW}x${view.videoH} readyState=${view.readyState} paused=${view.paused} muted=${view.muted}`)
  : bad('guest-view-is-the-video', JSON.stringify(view));
// The stream's intrinsic size is gamecube.html's 640x528 backing store, which is
// 1.2121 — NOT the 4:3 a GameCube outputs. The page has to correct it, and this
// reads the LAID-OUT box rather than the video's own ratio.
const boxRatio = await guest.evaluate(() => {
  const r = document.getElementById('stage').getBoundingClientRect();
  return r.height > 0 ? +(r.width / r.height).toFixed(4) : null;
});
(boxRatio && Math.abs(boxRatio - 4 / 3) < 0.01)
  ? ok('guest-presents-4-3', `#stage lays out at ${boxRatio} (4:3) while the stream's own ratio is ${(view.videoW / view.videoH).toFixed(4)} — the backing store is not the picture's shape`)
  : bad('guest-presents-4-3', `#stage lays out at ${boxRatio}, wanted 1.3333`);

// ⚠ AN EXACT PIXEL HASH OVER-COUNTS "CHANGE": the video arrives through a LOSSY
// codec, so two decodes of one identical source frame differ in the low bits.
// The COARSE 4x3 grid of quantised block means is what survives codec noise.
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
      const b = ((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0);
      acc[b] += lum / 3; cnt[b]++;
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
// ⚠ VOID RATHER THAN FAIL when the source produced nothing. tools/device_matrix.mjs
// established the rule this follows: an arm that could not have measured what it
// claims prints no verdict at all, because a red mark on the streaming path for a
// host that never drew a frame is a false accusation, and a green one would be worse.
if (!hostFrames) {
  info('guest-picture-VOID', `the host produced 0 frames (${JSON.stringify(rate)}), so neither "non-black" nor ` +
    `"changing" can be asserted from this run. Observed anyway: ${maxNonBlack} lit pixels at peak, ` +
    `${distinct} distinct coarse signature(s), host capture arm "${armed ? armed.capture : '?'}".`);
} else {
  (maxNonBlack > 0)
    ? ok('guest-frames-non-black', `${maxNonBlack}/${good[0] ? good[0].total : 0} pixels lit at peak; means ${good.map((s) => s.mean).join(', ')}`)
    : bad('guest-frames-non-black', 'every sample was pure black — a live track carrying nothing');
  (distinct >= 2)
    ? ok('guest-frames-changing', `${distinct} distinct COARSE signatures over ~6.4 s (${[...new Set(good.map((s) => s.coarse))].slice(0, 3).join('  ')})`)
    : bad('guest-frames-changing', `only ${distinct} distinct coarse signature(s) — the picture is frozen, not live. ` +
        `Host capture arm was "${armed ? armed.capture : '?'}" and __gcRate read ${JSON.stringify(rate)}`);
}

// ---------------------------------------------------------------------------
// 4. THE WHOLE POINT: the guest is LIGHT
// ---------------------------------------------------------------------------
console.log('\n== the guest never touched a ROM or a core ==');
const heavy = guestReqs.filter((u) => new URL(u).pathname.startsWith('/gamecube/'));
heavy.length === 0
  ? ok('guest-loads-no-rom', `${guestReqs.length} requests total, ZERO under /gamecube/ — no core, no wasm, no ROM, no WebGPU requirement`)
  : bad('guest-loads-no-rom', `${heavy.length} request(s) under /gamecube/: ${heavy.slice(0, 5).join(' ')}`);
info('guest-requests', guestReqs.map((u) => new URL(u).pathname).join(' '));

// ---------------------------------------------------------------------------
// 5. THE GUEST IS PLAYER 2 — on the literal bytes handed to the core
// ---------------------------------------------------------------------------
console.log('\n== the guest is PLAYER 2 ==');
// The pad buffer is 16 bytes = 2 ports x 8; input_state_cb reads
// g_pad[port*8 + id/8] bit (id%8). __gcNet().sentP2 is bytes 8..15 of the buffer
// pollController ACTUALLY posted to the worker, snapshotted before the transfer.
const p2 = () => host.evaluate(() => window.__gcNet().sentP2);
const p1 = () => host.evaluate(() => window.__gcNet().sentP1);
const idle = { p2: await p2(), p1: await p1() };
(idle.p2 && idle.p2.every((b) => b === 0))
  ? ok('player2-idle-before', 'port 1 is all zero with nobody pressing anything')
  : bad('player2-idle-before', JSON.stringify(idle.p2));

const press = (keys, down) => guest.evaluate((k, d) => {
  k.forEach((key) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key })));
}, keys, down);

// KEYBOARD ARM. 'm' = GC A (RETRO id 8 -> byte 9 bit 0, i.e. sentP2[1] bit 0).
// 'd' = RIGHT (id 7 -> sentP2[0] bit 7), which is ALSO what walks: the emulator
// worker synthesizes the main stick from these d-pad bits, so a digital bit IS
// the analog input on this console.
await press(['m', 'd'], true);
await sleep(1200);
const kb = { p2: await p2(), p1: await p1(), mask: await guest.evaluate(() => window.__gcmp().mask) };
await press(['m', 'd'], false);
await sleep(1200);
const kbAfter = { p2: await p2(), p1: await p1() };
const kb0 = kb.p2 ? kb.p2[0] : 0, kb1 = kb.p2 ? kb.p2[1] : 0;
((kb0 & (1 << 7)) && (kb1 & (1 << 0)))
  ? ok('guest-keyboard-lands-on-port-1', `worker bytes 8,9 = 0x${kb0.toString(16)},0x${kb1.toString(16)} (RIGHT | A) while the guest holds m+d; guest mask = 0x${(kb.mask >>> 0).toString(16)}`)
  : bad('guest-keyboard-lands-on-port-1', `worker bytes 8,9 = 0x${Number(kb0).toString(16)},0x${Number(kb1).toString(16)}, wanted byte8 bit7 and byte9 bit0 — ${JSON.stringify(kb.p2)}`);
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
const padVisible = await guest.evaluate(() => window.__gcmp().padShown);
padVisible ? ok('touch-controls-shown', '#pad is on') : bad('touch-controls-shown', 'the on-screen pad is hidden');
await guest.evaluate(() => ['tA', 'tS'].forEach((id) => document.getElementById(id).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))));
await sleep(1200);
const touch = { p2: await p2(), mask: await guest.evaluate(() => window.__gcmp().mask) };
await guest.evaluate(() => ['tA', 'tS'].forEach((id) => document.getElementById(id).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))));
await sleep(1200);
const touchAfter = await p2();
const t0 = touch.p2 ? touch.p2[0] : 0, t1 = touch.p2 ? touch.p2[1] : 0;
((t0 & (1 << 3)) && (t1 & (1 << 0)))
  ? ok('guest-touch-lands-on-port-1', `worker bytes 8,9 = 0x${t0.toString(16)},0x${t1.toString(16)} (START | A) from the on-screen buttons; guest mask = 0x${(touch.mask >>> 0).toString(16)}`)
  : bad('guest-touch-lands-on-port-1', `worker bytes 8,9 = 0x${Number(t0).toString(16)},0x${Number(t1).toString(16)}, wanted byte8 bit3 and byte9 bit0 — ${JSON.stringify(touch.p2)}`);
(touchAfter && touchAfter.every((b) => b === 0))
  ? ok('guest-touch-releases', 'port 1 returned to all-zero on release')
  : bad('guest-touch-releases', JSON.stringify(touchAfter));

try {
  await guest.screenshot({ path: '/tmp/gcmp-guest.png' });
  await host.screenshot({ path: '/tmp/gcmp-host.png' });
  info('screenshots', '/tmp/gcmp-guest.png  /tmp/gcmp-host.png');
} catch (e) { info('screenshots', 'failed: ' + e.message); }

// ---------------------------------------------------------------------------
// 6. LEAVING
// ---------------------------------------------------------------------------
console.log('\n== leaving ==');
await guest.evaluate(() => document.getElementById('btnLeave').click());
const hostSawLeave = await until(host, () => { const s = window.__gcNet().state; return (s === 'closed' || s === 'failed') ? s : null; }, 25000);
hostSawLeave ? ok('host-sees-peer-leave', `host session state = ${hostSawLeave}`)
             : bad('host-sees-peer-leave', `host still reports ${await host.evaluate(() => window.__gcNet().state)}`);
const stillUp = await host.evaluate(() => window.__gcNet().coreUp);
stillUp ? ok('host-keeps-playing', 'the emulator core is still running after the guest left')
        : bad('host-keeps-playing', 'the host stopped when the session ended');
const backToLobby = await until(guest, () => (typeof window.__gcmp === 'function' && !document.getElementById('lobby').hidden) || null, 20000);
backToLobby ? ok('guest-back-to-lobby', 'the guest is on a clean lobby again, with no emulator ever loaded')
            : bad('guest-back-to-lobby', 'the guest did not return to the lobby');

const summary = {
  when: new Date().toISOString(), uptime: load, game: GAME, code,
  handoffUrl: landed, lobbyRequestsBeforeHandoff: preHandoffReqs,
  guestRequests: guestReqs.map((u) => new URL(u).pathname),
  host: await host.evaluate(() => window.__gcNet()).catch(() => null),
  headless: HEADLESS, hostFrames, rate, videoSamples: samples,
  pad: { idle, kb, kbAfter, touch, touchAfter },
  results: res,
};
fs.writeFileSync('/tmp/gcmp-result.json', JSON.stringify(summary, null, 2));
info('json', '/tmp/gcmp-result.json');

if (!process.env.GCMP_KEEP) await browser.close();
const failed = res.filter((r) => !r.ok);
console.log(`\n[gamecube-mp-page] ${res.length - failed.length}/${res.length} passed   (load at start: ${load.split('load averages:').pop().trim()})`);
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// Does online co-op actually work on the five pages that got it last —
// ps1, snes, gba, genesis, n64 — and does the guest stay LIGHT while doing it?
//
// One file for five consoles on purpose. tools/dreamcast_mp_page_test.mjs is the
// shape this follows, and five copies of it would drift the way six hand-rolled
// lobbies would; the only per-console parts are a config block and one
// player-2 judge, both of which are right here in PLATFORMS below.
//
// WHAT IT PROVES, PER PLATFORM
//   1  the lobby mounts INLINE on the dedicated page, with a game picker and no
//      floating button, and publishes a test seam
//   2  that page's game list matches the EMULATOR page's ROM list exactly —
//      lib/netplay.js REFUSES a pairing whose game names differ, so drift here
//      is a session that cannot be joined, and it would be invisible from the UI
//   3  the HANDOFF: the lobby mints a code, navigates to
//      <emulator>?np=<code>&game=<label>, and that page selects the ROM, presses
//      its own Start, boots, and hosts under THAT EXACT CODE. A page that minted
//      a fresh code would look identical until a guest tried to join.
//   4  the guest gets REAL GAME PIXELS: a live video track, non-black, and
//      CHANGING — measured on a COARSE 4x3 block signature, because an exact
//      pixel hash differs on every decode of the SAME frame (lossy codec) and
//      would call a frozen picture live
//   5  the guest is LIGHT: ZERO requests for the core or the ROM. A "light" page
//      that quietly pulls 451 MB is the failure mode, and it is invisible from
//      the UI
//   6  a guest button press changes the EXACT BYTES THE CORE IS HANDED. Not a
//      session field, not a UI state — the literal value passed to
//      _gpx_set_pad / _setJoypadInput / _emuRunFrame / the port-2 KeyStatus
//      bytes / the Gamepad object the core pulled
//   7  leaving: the host sees it, the host keeps playing, the guest is returned
//      to a clean lobby having never loaded an emulator
//
// ⚠ WHAT IS AND IS NOT CLAIMED ABOUT "PLAYER 2". It differs per console and the
// judges below differ with it. Two of the five reach a genuinely separate second
// controller (ps1 port 2, genesis port B); two cannot, because the core or the
// machine has one pad (snes, gba); n64's core has four ports but its JavaScript
// bridge can only write the first. Each platform's `players` field says which,
// the assertion matches it, and NOTHING here claims two players where the core
// has one. See each *_multiplayer.html header for the source citations.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime     # gate, per CLAUDE.md
//   npm run web                                         # port 8080, gate #2
//   node tools/mp_page_test.mjs                         # snes genesis gba n64
//   node tools/mp_page_test.mjs ps1                     # opt-in: a 451 MB disc
//   node tools/mp_page_test.mjs all
//
// ENV
//   CHROME_PATH   path to Chrome (default: the macOS bundle)
//   ORIGIN        default http://localhost:8080
//   MP_BOOT_MS    override the per-platform boot timeout
//   MP_KEEP       leave the browser open at the end (debugging)
import puppeteer from 'puppeteer';
import fs from 'fs';
import { execSync } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// THE PER-CONSOLE FACTS. Everything console-specific lives here.
// ---------------------------------------------------------------------------
const PLATFORMS = {
  ps1: {
    label: 'PlayStation',
    hostPage: '/ps1.html', lobby: '/ps1_multiplayer.html',
    guestSeam: '__ps1mp', hostSeam: '__ps1Net',
    game: 'Monster Rancher 2',
    // Every request under this prefix is a core/ROM fetch the guest must not make.
    assetPrefix: ['/ps1/'],
    // 451,280,592 B of split, gzipped disc reassembled in the browser.
    bootMs: 900000,
    players: 'p2',
    romLabels: () => labelsFrom('ps1.html'),
    // The guest holds CROSS and RIGHT. On this console the host writes port 2's
    // KeyStatus bytes directly, and the register is ACTIVE-LOW: 0xFF at rest, a
    // press CLEARS a bit. DKEY_RIGHT = 5 lives in byte +6; DKEY_CROSS = 14 is
    // bit 6 of byte +7.
    press: ['z', 'ArrowRight'],
    judge(idle, held, released) {
      const bad = [];
      if (!(Array.isArray(idle.p2) && idle.p2[0] === 0xFF && idle.p2[1] === 0xFF))
        bad.push('port 2 was not idle-high before the press: ' + JSON.stringify(idle.p2));
      if (!held.p2 || (held.p2[0] & (1 << 5))) bad.push('DKEY_RIGHT (byte+6 bit 5) never cleared');
      if (!held.p2 || (held.p2[1] & (1 << 6))) bad.push('DKEY_CROSS (byte+7 bit 6) never cleared');
      // PORT 1 IS THE HOST'S OWN CONTROLLER. Nobody is touching it, so the
      // guest's input must not appear there — if the two ports were one buffer
      // this catches it.
      if (!held.p1 || held.p1[0] !== 0xFF || held.p1[1] !== 0xFF)
        bad.push('port 1 moved while only the guest was pressing: ' + JSON.stringify(held.p1));
      if (!released.p2 || released.p2[0] !== 0xFF || released.p2[1] !== 0xFF)
        bad.push('port 2 did not return to idle on release: ' + JSON.stringify(released.p2));
      return { ok: !bad.length, why: bad.join('; '),
               detail: `port2 idle=${J(idle.p2)} held=${J(held.p2)} released=${J(released.p2)}; port1 held=${J(held.p1)}` };
    },
  },

  genesis: {
    label: 'Genesis',
    hostPage: '/genesis.html', lobby: '/genesis_multiplayer.html',
    guestSeam: '__genmp', hostSeam: '__genNet',
    game: 'Sonic the Hedgehog 3',
    assetPrefix: ['/genesis/'],
    bootMs: 180000,
    players: 'p2',
    romLabels: () => labelsFrom('genesis.html'),
    // 'a' = Mega Drive A = RETRO_Y = bit 1; Enter = START = bit 3.
    press: ['a', 'Enter'],
    judge(idle, held, released) {
      const bad = [];
      if (idle.p2 !== 0) bad.push('port B was not zero before the press: ' + idle.p2);
      if (!(held.p2 & (1 << 1))) bad.push('A (bit 1) never reached port B');
      if (!(held.p2 & (1 << 3))) bad.push('START (bit 3) never reached port B');
      if (held.p1 !== 0) bad.push('port A moved while only the guest was pressing: 0x' + (held.p1 >>> 0).toString(16));
      if (released.p2 !== 0) bad.push('port B did not return to zero on release: ' + released.p2);
      return { ok: !bad.length, why: bad.join('; '),
               detail: `portB idle=0x${h(idle.p2)} held=0x${h(held.p2)} released=0x${h(released.p2)}; portA held=0x${h(held.p1)}` };
    },
  },

  snes: {
    label: 'SNES',
    hostPage: '/snes.html', lobby: '/snes_multiplayer.html',
    guestSeam: '__snesmp', hostSeam: '__snesNet',
    game: 'SimCity',
    assetPrefix: ['/snes/'],
    bootMs: 180000,
    // ⚠ SHARED, NOT p2. snes/snesWasm/source/exports.c:37-40 answers port 0 and
    // returns 0 for every other port; the wasm exports one joypad symbol taking
    // one i32. See snes_multiplayer.html's header.
    players: 'shared',
    romLabels: () => labelsFrom('snes.html'),
    // 'a' = SNES A = bit 7; Enter = START = bit 12.
    press: ['a', 'Enter'],
    judge(idle, held, released) {
      const bad = [];
      if (idle.p1 !== 0) bad.push('the mask was not zero before the press: ' + idle.p1);
      // p1 here is the MERGED mask actually handed to _setJoypadInput, which is
      // the only thing the core ever sees. p2 is the remote contribution alone.
      if (!(held.p1 & (1 << 7))) bad.push('A (bit 7) never reached _setJoypadInput');
      if (!(held.p1 & (1 << 12))) bad.push('START (bit 12) never reached _setJoypadInput');
      if (!(held.p2 & (1 << 7))) bad.push('A was in the mask but not attributed to the remote player');
      if (released.p1 !== 0) bad.push('the mask did not return to zero on release: ' + released.p1);
      return { ok: !bad.length, why: bad.join('; '),
               detail: `_setJoypadInput idle=0x${h(idle.p1)} held=0x${h(held.p1)} released=0x${h(released.p1)}; remote share=0x${h(held.p2)}` };
    },
  },

  gba: {
    label: 'Game Boy Advance',
    hostPage: '/gba.html', lobby: '/gba_multiplayer.html',
    guestSeam: '__gbamp', hostSeam: '__gbaNet',
    game: 'Sonic Advance 3',
    assetPrefix: ['/gba/'],
    bootMs: 180000,
    // ⚠ SHARED, NOT p2 — a Game Boy Advance has one controller. See
    // gba_multiplayer.html's header for the export-table measurement.
    players: 'shared',
    romLabels: () => [...fs.readFileSync('gba/gbaWasm/dist/romlist.js', 'utf8')
      .matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]),
    // 'm' = A = 0x001; Enter = START = 0x008.
    press: ['m', 'Enter'],
    judge(idle, held, released) {
      const bad = [];
      if (idle.p1 !== 0) bad.push('the key mask was not zero before the press: ' + idle.p1);
      if (!(held.p1 & 0x001)) bad.push('A (0x001) never reached _emuRunFrame');
      if (!(held.p1 & 0x008)) bad.push('START (0x008) never reached _emuRunFrame');
      if (!(held.p2 & 0x001)) bad.push('A was in the mask but not attributed to the remote player');
      if (released.p1 !== 0) bad.push('the key mask did not return to zero on release: ' + released.p1);
      return { ok: !bad.length, why: bad.join('; '),
               detail: `_emuRunFrame idle=0x${h(idle.p1)} held=0x${h(held.p1)} released=0x${h(released.p1)}; remote share=0x${h(held.p2)}` };
    },
  },

  n64: {
    label: 'N64',
    hostPage: '/n64/', lobby: '/n64_multiplayer.html',
    guestSeam: '__n64mp', hostSeam: '__n64Net',
    game: 'Mario Kart 64',
    assetPrefix: ['/n64/N64Wasm/'],
    bootMs: 300000,
    // ⚠ The core has four ports; its JS bridge writes only the first. On a
    // desktop host the remote player is presented as an extra GAMEPAD, so the
    // answer depends on the host's own hardware. See n64_multiplayer.html.
    players: 'p2-if-host-has-a-pad',
    romLabels: () => labelsFrom('n64/index.html'),
    // 'm' = A = bit 4; Enter = START = bit 6. On a desktop host these arrive
    // through the synthetic pad, where standard-mapping button 0 is A and
    // button 9 is START.
    press: ['m', 'Enter'],
    // The core pulls the pad through navigator.getGamepads, so the measurement
    // point is the literal object it pulled — recorded by the page at the moment
    // emscripten sampled it, not what the page intended to send.
    hostPad: () => {
      const s = window.__n64NetPad ? window.__n64NetPad() : null;
      return s ? { p1: s.gamepadServed, p2: s.gamepadLast, extra: s } : { p1: 0, p2: null };
    },
    judge(idle, held, released) {
      const bad = [];
      if (!held.extra || !held.extra.gamepadInstalled) bad.push('the synthetic pad was never installed');
      if (!(held.p1 > 0)) bad.push('the core never pulled the synthetic pad (gamepadServed = ' + held.p1 + ')');
      const hb = held.p2 ? held.p2.buttons : 0;
      const rb = released.p2 ? released.p2.buttons : 0;
      if (!(hb & (1 << 0))) bad.push('A (standard button 0) was not in the pad the core pulled');
      if (!(hb & (1 << 9))) bad.push('START (standard button 9) was not in the pad the core pulled');
      if (rb & ((1 << 0) | (1 << 9))) bad.push('the pad did not release: buttons still 0x' + h(rb));
      return { ok: !bad.length, why: bad.join('; '),
               detail: `pad pulled ${held.p1}x; buttons held=0x${h(hb)} released=0x${h(rb)}; `
                     + `path=${held.extra ? held.extra.padPath : '?'}` };
    },
  },
};

const J = (v) => JSON.stringify(v);
const h = (v) => ((v || 0) >>> 0).toString(16);

// The emulator pages all declare `const ROMS = [ { label: '…' … } ]`. Parsing the
// page rather than trusting a copy is the whole point: the guest page's list is a
// COPY and this is what catches it drifting.
function labelsFrom(file) {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf('const ROMS = [');
  if (i < 0) throw new Error('no ROMS array in ' + file);
  const block = src.slice(i, src.indexOf('\n  ];', i));
  return [...block.matchAll(/label:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)]
    .map((m) => (m[1] !== undefined ? m[1] : m[2]).replace(/\\(.)/g, '$1'));
}

// ⚠ KEEP BOTH TABS AWAKE, AND NOT WITH bringToFront().
// These four cores run their emulator on the MAIN THREAD's requestAnimationFrame
// (snes.html's runFrame, genesis.html's runFrame, gba's _emuLoop, n64's rAF pump),
// and Chromium does not throttle rAF in a background tab so much as STOP it. Only
// one tab can be in front, so whichever one is behind dies: measured here on the
// first run, with the guest in front, the HOST's own status line read
// `guest 0.42/s (0.007x hardware) · presented 0.3/s` and the guest's <video> never
// reached readyState 1 — a frozen host has no frames to send, which reads exactly
// like a broken stream.
// (dreamcast_mp_page_test.mjs does not need this: its emulator runs in a worker.)
// Emulation.setFocusEmulationEnabled makes a renderer behave as though it were the
// focused tab, so BOTH keep painting. --disable-backgrounding-occluded-windows and
// friends are already passed at launch and are NOT sufficient on their own.
async function keepAwake(page) {
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch (e) { return false; }
}

// ⚠ POLL FROM NODE, never page.waitForFunction — it polls on rAF and one of these
// two tabs is always in the background. tools/netplay_test.mjs records that trap
// producing a false negative on a session whose own log read connected.
async function until(page, fn, ms, everyMs = 250, onTick = null, arg = undefined) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (onTick) onTick(Date.now() - t0);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
async function run(key, browser, res) {
  const P = PLATFORMS[key];
  const rec = [];
  const ok = (n, d) => { rec.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
  const bad = (n, d) => { rec.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
  const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
  const bootMs = +(process.env.MP_BOOT_MS || P.bootMs);

  console.log(`\n╔══ ${key} — ${P.label} ${'═'.repeat(Math.max(0, 46 - P.label.length))}`);

  // ---- 1. the lobby -------------------------------------------------------
  const lobby = await browser.newPage();
  lobby.on('pageerror', (e) => console.log(`  [lobby!] ${e.message}`));
  const lobbyReqs = [];
  lobby.on('request', (r) => lobbyReqs.push(r.url()));
  const lobbyAwake = await keepAwake(lobby);
  await lobby.goto(ORIGIN + P.lobby + '?net=local', { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The seam name is passed as an argument because page.evaluate runs in the
  // page realm and cannot close over anything in this file.
  const mounted = await until(lobby, (s) => (typeof window[s] === 'function' && window[s]().supported) || null,
                              30000, 250, null, P.guestSeam);
  mounted ? ok('lobby-mounts', `window.${P.guestSeam} reports supported`)
          : bad('lobby-mounts', 'the page never published a supported test seam');
  const shape = await lobby.evaluate((s) => {
    const r = (typeof window[s] === 'function') ? window[s]() : null;
    return {
      supported: !!(r && r.supported),
      lobbyShown: !!(document.getElementById('lobby') && !document.getElementById('lobby').hidden),
      unsupportedShown: !!(document.getElementById('unsupported') && !document.getElementById('unsupported').hidden),
      card: !!document.querySelector('#lobbyCard .np-card'),
      floatingBtn: !!document.querySelector('.np-btn'),
      select: !!document.querySelector('#lobbyCard .np-sel'),
      transport: r ? r.transport : null,
      players: r ? r.players : null,
      games: r ? r.games : null,
    };
  }, P.guestSeam);
  (shape.supported && shape.lobbyShown && !shape.unsupportedShown && shape.card && shape.select && !shape.floatingBtn)
    ? ok('lobby-inline', `the netplay card is mounted inline (no floating .np-btn), with a game picker; transport=${shape.transport} players=${shape.players}`)
    : bad('lobby-inline', J(shape));
  (shape.players === P.players)
    ? ok('players-declared', `the page declares "${shape.players}" — matching what this core can actually do`)
    : bad('players-declared', `page says "${shape.players}", this rig expects "${P.players}"`);

  // ---- 2. the drift guard -------------------------------------------------
  let emuLabels = [];
  try { emuLabels = P.romLabels(); } catch (e) { emuLabels = ['<parse failed: ' + e.message + '>']; }
  J(emuLabels) === J(shape.games)
    ? ok('game-list-matches-the-emulator-page', `${emuLabels.length} title(s), identical and in order`)
    : bad('game-list-matches-the-emulator-page',
          `emulator=${J(emuLabels)} lobby=${J(shape.games)} — a mismatched key fails the pairing with "the other player is on <game>"`);

  // ---- 3. the handoff -----------------------------------------------------
  console.log('  ── the host hands off to the emulator page');
  const code = await lobby.evaluate((g) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelectorAll('#lobbyCard .np-row button')[0].click();      // Host
    return document.querySelector('#lobbyCard .np-code').textContent.trim();
  }, P.game);
  /^[A-HJ-NP-Z2-9]{5}$/.test(code)
    ? ok('lobby-mints-a-code', `"${code}" — shown before anything is downloaded`)
    : bad('lobby-mints-a-code', code);
  const preHandoffReqs = lobbyReqs.length;
  await lobby.evaluate((g) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelector('#lobbyCard .np-act button').click();            // "Host — load the game"
  }, P.game);
  const host = lobby;
  const landed = await until(host, () => (location.search.indexOf('np=') >= 0) ? (location.pathname + location.search) : null, 20000);
  if (landed) {
    const q = new URLSearchParams(landed.slice(landed.indexOf('?')));
    (q.get('np') === code && q.get('game') === P.game && q.get('net') === 'local')
      ? ok('handoff-url', `${landed} — the code the other player was already shown travels verbatim`)
      : bad('handoff-url', `${landed} wanted np=${code} game=${P.game} net=local`);
  } else bad('handoff-url', 'the lobby never navigated to the emulator page');
  info('lobby-weight', `${preHandoffReqs} network requests to form the party and show a code`);

  const armExists = await until(host, (s) => (typeof window[s] === 'function') ? true : null, 90000, 500, null, P.hostSeam);
  armExists ? ok('host-page-ready', `the emulator page exposes ${P.hostSeam}`)
            : bad('host-page-ready', `${P.hostSeam} never appeared`);

  console.log('  ── the host boots, unattended');
  let lastPhase = '';
  const booted = await until(host, (s) => (window[s]() || {}).live || null, bootMs, 1000, async () => {
    const p = await host.evaluate((s) => {
      const n = window[s]();
      const el = document.getElementById('status');
      return (el ? el.textContent : '') + ' coreUp=' + n.coreUp;
    }, P.hostSeam).catch(() => '');
    if (p && p !== lastPhase) { lastPhase = p; process.stdout.write(`  ....  booting  ${p.slice(0, 90)}          \r`); }
  }, P.hostSeam);
  process.stdout.write('\n');
  booted ? ok('host-booted', 'the handoff pressed Start itself and the core is producing frames')
         : bad('host-booted', 'the emulator never reported a frame — nothing to stream. last status: ' + lastPhase);

  const armed = await until(host, (s) => { const n = window[s](); return (n.role === 'host' && n.code) ? n : null; }, 90000, 500, null, P.hostSeam);
  (armed && armed.code === code)
    ? ok('host-arms-the-handed-code', `${P.hostSeam}().code = "${armed.code}" (capture: ${armed.capture}; audio: ${armed.audio || 'none'})`)
    : bad('host-arms-the-handed-code', `wanted "${code}", got ${J(armed)} — a fresh code strands the guest silently`);

  // ---- 4. the guest -------------------------------------------------------
  console.log('  ── the guest joins from the light page');
  const guest = await browser.newPage();
  guest.on('pageerror', (e) => console.log(`  [guest!] ${e.message}`));
  const guestReqs = [];
  guest.on('request', (r) => guestReqs.push(r.url()));
  const guestAwake = await keepAwake(guest);
  (lobbyAwake && guestAwake)
    ? ok('both-tabs-kept-awake', 'Emulation.setFocusEmulationEnabled on both — a backgrounded rAF would freeze the host emulator outright')
    : bad('both-tabs-kept-awake', `host=${lobbyAwake} guest=${guestAwake} — without this the result is not interpretable`);
  await guest.goto(ORIGIN + P.lobby + '?net=local&pad=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await until(guest, (s) => typeof window[s] === 'function' || null, 30000, 250, null, P.guestSeam);
  await guest.evaluate((g, c) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelectorAll('#lobbyCard .np-row button')[1].click();      // Join
    document.querySelector('#lobbyCard .np-in').value = c;
    document.querySelector('#lobbyCard .np-act button').click();            // Join
  }, P.game, code || '');

  // ---- 4b. THE HOST IS ASKED FIRST ---------------------------------------
  // docs/audit-2026-09-08.md found that knowing the 5-character code was enough
  // to receive the host's live video and audio, inject player-2 input and take
  // the end-of-session save. An inbound peer is now held with none of that
  // until a human on the host's machine allows it. lib/netplay.js draws the
  // dialog itself, so every one of these pages gets it without a page edit —
  // and reaching 'connected' below now REQUIRES this click.
  console.log('  ── the host is asked before anything flows');
  const prompt = await until(host, () => {
    const p = document.getElementById('npApprove');
    if (!p) return null;
    const s = document.getElementById('npApproveSas');
    return { sas: s ? s.getAttribute('data-sas') : null, allow: !!document.getElementById('npApproveAllow') };
  }, 90000, 250);
  prompt && prompt.allow
    ? ok('host-is-asked-before-anything-flows', `Allow/Deny raised on ${P.hostPage} with confirmation code ${prompt.sas}`)
    : bad('host-is-asked-before-anything-flows', 'no approval dialog — a code guesser would have been let straight in');
  const preAllow = await host.evaluate(() => {
    const sess = window.Netplay && Netplay.hostSession();
    return sess ? sess.admission() : null;
  }).catch(() => null);
  (preAllow && preAllow.approved === false && preAllow.offered === false)
    ? ok('no-offer-before-allow', 'the host has created no SDP offer yet — the tracks have not left the page')
    : bad('no-offer-before-allow', J(preAllow));
  await host.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); });

  const gConn = await until(guest, (s) => window[s]().state === 'connected' || null, 90000, 250, null, P.guestSeam);
  const hConn = await until(host, (s) => window[s]().state === 'connected' || null, 90000, 250, null, P.hostSeam);
  (gConn && hConn) ? ok('peers-connected', 'both sides report connected')
                   : bad('peers-connected', `host=${!!hConn} guest=${!!gConn} — ${J(await guest.evaluate((s) => window[s](), P.guestSeam))}`);

  console.log('  ── the guest gets REAL GAME PIXELS');
  const tracks = await until(guest, (s) => window[s]().tracks || null, 30000, 250, null, P.guestSeam);
  (tracks && tracks.some((t) => t.startsWith('video:live')))
    ? ok('guest-track-live', J(tracks)) : bad('guest-track-live', J(tracks));
  await until(guest, (s) => window[s]().videoW > 0 || null, 30000, 250, null, P.guestSeam);
  const view = await guest.evaluate((s) => window[s](), P.guestSeam);
  (view.playing && view.videoW > 0)
    ? ok('guest-view-is-the-video', `<video> ${view.videoW}x${view.videoH} readyState=${view.readyState} paused=${view.paused} muted=${view.muted}`)
    : bad('guest-view-is-the-video', J(view));

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
      let nonBlack = 0, sum = 0, hh = 2166136261;
      const gw = 4, gh = 3, acc = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
      for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
        const k = (y * 160 + x) * 4;
        const lum = d[k] + d[k + 1] + d[k + 2];
        if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
        sum += lum;
        hh = Math.imul(hh ^ (d[k] + d[k + 1] * 3 + d[k + 2] * 7), 16777619) >>> 0;
        acc[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)] += lum / 3;
        cnt[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)]++;
      }
      const means = Array.from(acc, (a, i2) => a / cnt[i2]);
      return { nonBlack, total: d.length / 4, mean: +(sum / (3 * d.length / 4)).toFixed(2), h: hh,
               means: means.map((m) => +m.toFixed(2)),
               // ⚠ QUANTISED, and the divisor is the whole argument. Each cell is
               // the mean of ~1600 pixels, which averages lossy-codec noise almost
               // to nothing, so /8 (32 levels) still cannot manufacture a change —
               // while /32 was coarse enough to call a moving title screen frozen
               // (measured: Sonic Advance 3 scored 2 distinct on one run and 1 on
               // the next, off the same live stream).
               coarse: means.map((m) => Math.round(m / 8)).join('.') };
    }));
    await sleep(400);
  }
  const good = samples.filter((s) => !s.err);
  const maxNonBlack = Math.max(...good.map((s) => s.nonBlack), 0);
  const distinct = new Set(good.map((s) => s.coarse)).size;
  // The largest excursion ANY one cell made across the window, in luminance
  // levels. This is the raw number behind the verdict: a frozen picture cannot
  // move a 1600-pixel block mean, so a large value here is motion, not noise.
  let spread = 0;
  if (good.length && good[0].means) {
    for (let c = 0; c < good[0].means.length; c++) {
      const col = good.map((s) => s.means[c]);
      spread = Math.max(spread, Math.max(...col) - Math.min(...col));
    }
  }
  info('frame-signatures', `${new Set(good.map((s) => s.h)).size} distinct exact hashes vs ${distinct} distinct coarse — the gap is lossy-codec noise`);
  info('block-mean-spread', `${spread.toFixed(2)} luminance levels — the largest excursion any 4x3 cell made over the window`);
  (maxNonBlack > 0)
    ? ok('guest-frames-non-black', `${maxNonBlack}/${good[0] ? good[0].total : 0} pixels lit at peak; means ${good.slice(0, 6).map((s) => s.mean).join(', ')}…`)
    : bad('guest-frames-non-black', 'every sample was pure black — a live track carrying nothing');
  (distinct >= 2)
    ? ok('guest-frames-changing', `${distinct} distinct COARSE signatures over ~6.4 s (${[...new Set(good.map((s) => s.coarse))].slice(0, 3).join('  ')})`)
    : bad('guest-frames-changing', `only ${distinct} distinct coarse signature(s) — the picture is frozen, not live`);

  // ---- 5. the guest is LIGHT ---------------------------------------------
  console.log('  ── the guest never touched a core or a ROM');
  const heavy = guestReqs.filter((u) => {
    const path = new URL(u).pathname;
    return P.assetPrefix.some((pre) => path.startsWith(pre));
  });
  heavy.length === 0
    ? ok('guest-loads-no-core', `${guestReqs.length} requests total, ZERO under ${P.assetPrefix.join(' or ')} — no core, no wasm, no ROM`)
    : bad('guest-loads-no-core', `${heavy.length} request(s): ${heavy.slice(0, 5).map((u) => new URL(u).pathname).join(' ')}`);
  info('guest-requests', guestReqs.map((u) => new URL(u).pathname).join(' '));

  // ---- 6. the guest's press reaches the CORE ------------------------------
  console.log('  ── the guest\'s press reaches the core');
  const readPad = P.hostPad
    ? () => host.evaluate(P.hostPad)
    : () => host.evaluate((s) => { const n = window[s](); return { p1: n.sentP1, p2: n.sentP2 }; }, P.hostSeam);
  const press = (keys, down) => guest.evaluate((k, d) => {
    k.forEach((key) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key })));
  }, keys, down);

  const idle = await readPad();
  await press(P.press, true);
  await sleep(1500);
  const held = await readPad();
  // The guest's own view of what it is SENDING, sampled while the keys are still
  // down. Without this a failure cannot be attributed: a zero at the core is
  // either "the guest never packed the bits" or "they never crossed the wire",
  // and those are different bugs in different files.
  const guestHeld = await guest.evaluate((s) => window[s]().mask, P.guestSeam);
  const hostSees = await host.evaluate((s) => window[s]().remotePad, P.hostSeam);
  await press(P.press, false);
  await sleep(1500);
  const released = await readPad();
  const guestMask = await guest.evaluate((s) => window[s]().mask, P.guestSeam);
  const v = P.judge(idle, held, released);
  v.ok ? ok('guest-press-reaches-the-core', v.detail)
       : bad('guest-press-reaches-the-core', v.why + '   [' + v.detail + ']');
  info('wire', `guest packed 0x${h(guestHeld)} -> host remotePad 0x${h(hostSees)} -> guest mask after release 0x${h(guestMask)}`);
  (guestHeld !== 0 && hostSees === guestHeld)
    ? ok('mask-crosses-the-wire', `0x${h(guestHeld)} packed on the guest arrived byte-identical on the host`)
    : bad('mask-crosses-the-wire', `guest packed 0x${h(guestHeld)}, host saw 0x${h(hostSees)}`);

  // Evidence, not decoration. A screenshot is the only thing that answers "was
  // there really a game on that guest's screen" after the fact.
  try {
    await guest.screenshot({ path: `/tmp/mp-${key}-guest.png` });
    await host.screenshot({ path: `/tmp/mp-${key}-host.png` });
    info('screenshots', `/tmp/mp-${key}-guest.png  /tmp/mp-${key}-host.png`);
  } catch (e) { info('screenshots', 'failed: ' + e.message); }

  // ---- 7. leaving ---------------------------------------------------------
  console.log('  ── leaving');
  await guest.evaluate(() => document.getElementById('btnLeave').click());
  const sawLeave = await until(host, (s) => { const st = window[s]().state; return (st === 'closed' || st === 'failed') ? st : null; }, 30000, 250, null, P.hostSeam);
  sawLeave ? ok('host-sees-peer-leave', `host session state = ${sawLeave}`)
           : bad('host-sees-peer-leave', `host still reports ${await host.evaluate((s) => window[s]().state, P.hostSeam)}`);
  const stillLive = await host.evaluate((s) => window[s]().live, P.hostSeam);
  stillLive ? ok('host-keeps-playing', 'the emulator is still producing frames after the guest left')
            : bad('host-keeps-playing', 'the host stopped when the session ended');
  const backToLobby = await until(guest, () => (document.getElementById('lobby') && !document.getElementById('lobby').hidden) || null, 25000);
  backToLobby ? ok('guest-back-to-lobby', 'the guest is on a clean lobby again, with no emulator ever loaded')
              : bad('guest-back-to-lobby', 'the guest did not return to the lobby');

  const hostFinal = await host.evaluate((s) => window[s](), P.hostSeam).catch(() => null);
  res[key] = { code, handoffUrl: landed, lobbyRequestsBeforeHandoff: preHandoffReqs,
               guestRequests: guestReqs.map((u) => new URL(u).pathname),
               host: hostFinal, videoSamples: samples,
               pad: { idle, held, released, guestHeld, hostSees, guestMask }, results: rec };
  await guest.close(); await host.close();
  const failed = rec.filter((r) => !r.ok).length;
  console.log(`╚══ ${key}: ${rec.length - failed}/${rec.length} passed`);
  return failed;
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
// ps1 is opt-in by default: its smallest disc is 451,280,592 bytes of split,
// gzipped image reassembled in the browser, which is minutes even from localhost.
const want = args.length ? (args[0] === 'all' ? Object.keys(PLATFORMS) : args) : ['snes', 'genesis', 'gba', 'n64'];
const unknown = want.filter((w) => !PLATFORMS[w]);
if (unknown.length) { console.error('unknown platform(s): ' + unknown.join(', ')); process.exit(2); }

const load = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
console.log('\n== machine ==');
console.log('  ....  uptime  ' + load);
console.log('  ....  arms    ' + want.join(', '));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    // Both tabs must keep running: only one can be foreground and Chromium
    // throttles rAF in the other, which would stop the host's input path and the
    // guest's pad send at the same time.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // The guest attaches a <video> carrying the host's audio; without this the
    // element is refused playback and the picture never starts.
    '--autoplay-policy=no-user-gesture-required',
    '--disk-cache-size=134217728',
  ],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'mp_page_test'); } catch (_e) {}

const res = {};
let failed = 0;
for (const k of want) {
  try { failed += await run(k, browser, res); }
  catch (e) { failed++; console.log(`  FAIL  ${k}/harness  ${e && e.stack ? e.stack.split('\n')[0] : e}`); res[k] = { harnessError: String(e) }; }
}

fs.writeFileSync('/tmp/mp-result.json', JSON.stringify({ when: new Date().toISOString(), uptime: load, res }, null, 2));
console.log('\n  ....  json  /tmp/mp-result.json');
if (!process.env.MP_KEEP) await browser.close();
console.log(`\n[mp-page] ${failed ? failed + ' FAILED' : 'all passed'}   (load at start: ${load.split('load averages:').pop().trim()})`);
process.exit(failed ? 1 : 0);

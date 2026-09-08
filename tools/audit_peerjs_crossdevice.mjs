#!/usr/bin/env node
// AUDIT RIG — written 2026-09-08 by an independent auditor.
//
// WHY THIS EXISTS
// ---------------
// EVERY netplay test in this repo runs on `?net=local`:
//     tools/netplay_test.mjs            transport: 'local'   (x4 sessions)
//     tools/netplay_ui_test.mjs         transport: 'local'
//     tools/dreamcast_netplay_test.mjs  ?net=local
//     tools/dreamcast_mp_page_test.mjs  ?net=local
//     tools/gamecube_mp_page_test.mjs   ?net=local
//     tools/mp_page_test.mjs            ?net=local   (all five consoles)
// `local` selects the BroadcastChannel signalling transport (lib/netplay.js:59),
// which only works between two contexts of the SAME browser profile.
//
// But every page defaults to the OTHER transport:
//     lib/netplay-host.js:110   net === 'local' ? 'local' : 'peerjs'
//     lib/netplay-guest.js:217  net === 'local' ? 'local' : 'peerjs'
//     dreamcast.html:4470, gamecube.html:7330, and both dedicated pages: same.
// So the transport a REAL VISITOR uses — a third-party script from unpkg, the
// public PeerJS broker, an ICE negotiation over the network — is the one nothing
// exercises. Commit a54cc0af ("CROSS-DEVICE pairing did not work at all — two
// bugs, both mine") fixed that path and no standing test covers the fix.
//
// WHAT THIS RIG DOES
//   Two SEPARATE Chrome instances with SEPARATE user-data directories. That is
//   the point: two profiles share no BroadcastChannel, no storage and no service
//   worker registration, so `local` signalling is physically unavailable and a
//   pairing can only happen through the PeerJS broker. Neither page is passed
//   ?net=local, so both take their shipped default.
//
//   Then, on the guest: connected? real tracks? non-black CHANGING pixels? does a
//   button press reach the host's core? — the same questions mp_page_test.mjs
//   asks over BroadcastChannel, asked over the wire the product actually uses.
//
// ⚠ WHAT A PASS HERE DOES **NOT** PROVE
//   Both browsers sit on ONE machine behind ONE NAT, so ICE resolves to host
//   candidates on the same interface. This proves BROKER SIGNALLING, the offer/
//   answer exchange, and the media/data path. It does NOT prove NAT traversal
//   between two real remote devices. lib/netplay.js:266 configures STUN only —
//   `stun:stun.l.google.com:19302`, with NO TURN relay — so a pair of peers on
//   symmetric NATs has no fallback and would fail where this rig passes. That
//   residual needs two real networks and is uncovered, not implied covered.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   node tools/audit_peerjs_crossdevice.mjs                      # production
//   TARGET=http://localhost:8080 node tools/audit_peerjs_crossdevice.mjs snes
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.TARGET || 'https://caseybement.com';
const SCRATCH = process.env.SCRATCH ||
  '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const h = (v) => ((v || 0) >>> 0).toString(16);

const PLATFORMS = {
  snes:    { lobby: '/snes_multiplayer.html',    guestSeam: '__snesmp', hostSeam: '__snesNet', game: 'SimCity',              bootMs: 300000, press: ['a', 'Enter'], liveField: 'live' },
  genesis: { lobby: '/genesis_multiplayer.html', guestSeam: '__genmp',  hostSeam: '__genNet',  game: 'Sonic the Hedgehog 3', bootMs: 300000, press: ['a', 'Enter'], liveField: 'live' },
  gba:     { lobby: '/gba_multiplayer.html',     guestSeam: '__gbamp',  hostSeam: '__gbaNet',  game: 'Sonic Advance 3',      bootMs: 300000, press: ['m', 'Enter'], liveField: 'live' },

  // Dreamcast is the claim-2 case. dreamcast/docs/gauntlet-two-players/TASKS.md
  // proves the GAME reacts to port 1, but drove port 1 from a SYNTHETIC GAMEPAD
  // in ONE tab — "Method — two ports, one tab, no WebRTC". The composition it
  // then asserts is: [netplay puts the guest's bytes at 64..127] x [those bytes
  // move a second character]. This arm measures the FIRST half over a REAL
  // WebRTC link between two browsers, and in particular the exact analog value,
  // because the two halves do NOT agree on it:
  //     synthetic gamepad path  axv(0) = 1.0 * 32767      -> port1 byte 8 = +32767
  //     netplay path            q(32767) = 127; 127 * 258 -> port1 byte 8 = +32766
  // (dreamcast.html netPadMask/netApplyPadMask, :4309-4324.)
  dreamcast: {
    lobby: '/dreamcast_multiplayer.html', guestSeam: '__dcmp', hostSeam: '__dcNet',
    // ⚠ THE PICKER'S VALUE IS NOT ITS LABEL on this page. dreamcast_multiplayer.html:195-201
    // is [{value:'gauntlet', label:'Gauntlet Legends (USA)'}, …]; the other five
    // consoles happen to use the label as the value, so a rig written against
    // them silently sets an unmatched select value here, `select.value` becomes
    // "", and the handoff URL carries `game=` EMPTY — which still pairs, because
    // lib/netplay.js:331 skips the game check when either side is falsy, and
    // still boots, because DEFAULT_GAME re-defaults. It just boots a DIFFERENT
    // DISC than the one under test, with nothing anywhere reporting a fault.
    game: 'gauntlet', gameLabel: 'Gauntlet Legends (USA)', bootMs: 1200000,
    // guest: 'm' = RETRO B (id 0, the DC CONFIRM), 'd' = RIGHT (id 7) + full
    // analog right. Same two keys tools/dreamcast_netplay_test.mjs uses.
    press: ['m', 'd'],
    liveField: 'booted',
    coi: true,
    // dreamcast.html exposes port 0 separately from the netplay seam.
    padRead: (s) => ({ p2: window[s]().sentP2, remote: window[s]().remotePad,
                       p1: (window.__dcPad ? window.__dcPad().slice(0, 12) : null) }),
  },
};

// Poll from Node, never page.waitForFunction — these tabs are in separate
// browsers but still background each other's compositor on one display.
async function until(page, fn, ms, everyMs = 400, arg = undefined) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(everyMs);
  }
}

async function launch(tag) {
  const profile = path.join(SCRATCH, 'audit-peerjs-' + tag);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: profile,          // ← the whole experiment: no shared anything
    args: ['--no-sandbox', '--disable-background-timer-throttling',
           '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
           '--autoplay-policy=no-user-gesture-required', '--disk-cache-size=268435456'],
  });
  try { (await import('./browser_leak_guard.js')).default.guard(b, 'audit_peerjs'); } catch (_e) {}
  return b;
}

async function keepAwake(page) {
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch (e) { return false; }
}

// coi-serviceworker installs on first visit and RELOADS the page. A second goto
// lands on the already-isolated page instead of racing that reload.
async function gotoSettled(page, url, coi) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  if (coi) { await sleep(2000); await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }); }
}

const rec = [];
const ok  = (n, d) => { rec.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { rec.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);

const key = (process.argv.slice(2).filter((a) => !a.startsWith('-'))[0]) || 'snes';
const P = PLATFORMS[key];
if (!P) { console.error('unknown platform ' + key); process.exit(2); }

const load = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
console.log('== audit_peerjs_crossdevice ==');
console.log('  uptime    ' + load);
console.log('  target    ' + ORIGIN);
console.log('  platform  ' + key + '  (' + (P.gameLabel || P.game) + ', picker value "' + P.game + '")');
console.log('  NOTE      two SEPARATE browser profiles; no ?net=local, so both take the shipped default');

const hostB = await launch('host');
const guestB = await launch('guest');
const out = { origin: ORIGIN, platform: key, when: new Date().toISOString(), uptime: load };

try {
  // ---- host ---------------------------------------------------------------
  const host = (await hostB.pages())[0];
  const hostConsole = [];
  host.on('console', (m) => { const t = m.text(); if (/peer|signal|netplay|host|ice/i.test(t)) hostConsole.push(t.slice(0, 200)); });
  host.on('pageerror', (e) => console.log(`  [host!] ${String(e).slice(0, 200)}`));
  const hostReqs = [];
  host.on('request', (r) => hostReqs.push(r.url()));
  await keepAwake(host);
  await gotoSettled(host, ORIGIN + P.lobby, true);

  const mounted = await until(host, (s) => (typeof window[s] === 'function' && window[s]().supported) || null, 40000, 400, P.guestSeam);
  mounted ? ok('host-lobby-mounts', `window.${P.guestSeam} reports supported`)
          : bad('host-lobby-mounts', 'the lobby never published a supported seam');
  const shape = await host.evaluate((s) => window[s](), P.guestSeam).catch(() => ({}));
  (shape.transport === 'peerjs')
    ? ok('transport-is-the-shipped-default', 'transport = "peerjs" — the cross-device path, NOT the BroadcastChannel one every existing test uses')
    : bad('transport-is-the-shipped-default', `transport = ${J(shape.transport)}`);
  out.transport = shape.transport;

  // Setting .value on a <select> is a SILENT NO-OP when nothing matches, so the
  // rig asserts the option really took rather than trusting the assignment.
  const picked = await host.evaluate((g) => {
    const sel = document.querySelector('#lobbyCard .np-sel');
    sel.value = g;
    return sel.value;
  }, P.game);
  (picked === P.game)
    ? ok('game-picker-took-the-value', `select.value = "${picked}"`)
    : bad('game-picker-took-the-value', `set "${P.game}", select reads "${picked}" — a different disc would boot with nothing reporting it`);
  const code = await host.evaluate((g) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelectorAll('#lobbyCard .np-row button')[0].click();
    return document.querySelector('#lobbyCard .np-code').textContent.trim();
  }, P.game);
  out.code = code;
  /^[A-HJ-NP-Z2-9]{5}$/.test(code) ? ok('code-minted', `"${code}"`) : bad('code-minted', code);

  await host.evaluate((g) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelector('#lobbyCard .np-act button').click();
  }, P.game);
  const landed = await until(host, () => (location.search.indexOf('np=') >= 0) ? (location.pathname + location.search) : null, 40000);
  landed ? ok('handoff', landed) : bad('handoff', 'the lobby never navigated to the emulator page');
  out.handoffUrl = landed;
  // The emulator page registers the coi service worker on a fresh profile and
  // RELOADS. If the np= code did not survive that reload the host would arm a
  // fresh code and silently strand the guest — a cold-visitor path no existing
  // test covers, because mp_page_test.mjs shares one browser across all five
  // consoles and pays the service-worker reload only on the first one.
  await until(host, (s) => (typeof window[s] === 'function') ? true : null, 120000, 500, P.hostSeam);
  const booted = await until(host, (a) => (window[a[0]]() || {})[a[1]] || null, P.bootMs, 2000, [P.hostSeam, P.liveField]);
  booted ? ok('host-booted', 'the core is producing frames')
         : bad('host-booted', 'the emulator never reported a frame');
  const armed = await until(host, (s) => { const n = window[s](); return (n.role === 'host' && n.code) ? n : null; }, 120000, 500, P.hostSeam);
  (armed && armed.code === code)
    ? ok('host-armed-the-handed-code-across-the-coi-reload', `${P.hostSeam}().code = "${armed.code}" (capture: ${armed.capture})`)
    : bad('host-armed-the-handed-code-across-the-coi-reload', `wanted "${code}", got ${J(armed && armed.code)}`);
  (armed && armed.transport === 'peerjs')
    ? ok('host-session-is-peerjs', 'the emulator page is hosting over the broker, not BroadcastChannel')
    : bad('host-session-is-peerjs', `host transport = ${J(armed && armed.transport)}`);
  out.host = armed;

  // The third-party dependency, named. If unpkg is blocked or the broker is
  // down, this is where it shows.
  const brokerReqs = hostReqs.filter((u) => /peerjs|unpkg/i.test(u));
  info('third-party', brokerReqs.length ? brokerReqs.slice(0, 4).join('  ') : 'NONE seen from the host page');
  out.hostThirdParty = brokerReqs;

  // ---- guest: a DIFFERENT BROWSER PROFILE ---------------------------------
  console.log('  ── the guest joins from a separate browser profile');
  const guest = (await guestB.pages())[0];
  guest.on('pageerror', (e) => console.log(`  [guest!] ${String(e).slice(0, 200)}`));
  const guestReqs = [];
  guest.on('request', (r) => guestReqs.push(r.url()));
  await keepAwake(guest);
  await gotoSettled(guest, ORIGIN + P.lobby + '?pad=1', true);
  await until(guest, (s) => typeof window[s] === 'function' || null, 40000, 400, P.guestSeam);
  // Prove the two profiles really are isolated: if a BroadcastChannel could
  // reach across them, this experiment would be measuring `local` after all.
  const isolated = await guest.evaluate(() => new Promise((res) => {
    const ch = new BroadcastChannel('audit-isolation-probe');
    let heard = false;
    ch.onmessage = () => { heard = true; };
    ch.postMessage('ping');
    setTimeout(() => { ch.close(); res(!heard); }, 800);
  }));
  info('profile-isolation', isolated ? 'no BroadcastChannel echo — the two profiles are separate browsers'
                                     : 'a BroadcastChannel echo was heard (unexpected)');

  await guest.evaluate((g, c) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelectorAll('#lobbyCard .np-row button')[1].click();
    document.querySelector('#lobbyCard .np-in').value = c;
    document.querySelector('#lobbyCard .np-act button').click();
  }, P.game, code || '');

  const gConn = await until(guest, (s) => window[s]().state === 'connected' || null, 150000, 500, P.guestSeam);
  const hConn = await until(host,  (s) => window[s]().state === 'connected' || null, 30000,  500, P.hostSeam);
  (gConn && hConn)
    ? ok('CROSS-BROWSER-PAIRING', 'two separate browser profiles paired through the PeerJS broker — the path no existing test covers')
    : bad('CROSS-BROWSER-PAIRING',
          `host=${!!hConn} guest=${!!gConn}; guest seam = ${J(await guest.evaluate((s) => window[s](), P.guestSeam).catch(() => null))}`);
  const guestPeerReqs = guestReqs.filter((u) => /peerjs|unpkg/i.test(u));
  info('guest third-party', guestPeerReqs.length ? guestPeerReqs.slice(0, 4).join('  ') : 'NONE');

  if (gConn && hConn) {
    const tracks = await until(guest, (s) => window[s]().tracks || null, 60000, 500, P.guestSeam);
    (tracks && tracks.some((t) => t.startsWith('video:live')))
      ? ok('guest-track-live', J(tracks)) : bad('guest-track-live', J(tracks));
    await until(guest, (s) => window[s]().videoW > 0 || null, 60000, 500, P.guestSeam);
    const view = await guest.evaluate((s) => window[s](), P.guestSeam);
    (view.playing && view.videoW > 0)
      ? ok('guest-view-is-the-video', `<video> ${view.videoW}x${view.videoH} readyState=${view.readyState}`)
      : bad('guest-view-is-the-video', J(view));
    out.guestView = view;

    // Same coarse 4x3 /8 signature rule mp_page_test.mjs uses.
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await guest.evaluate(() => {
        const v = document.getElementById('mpVideo');
        const c = document.createElement('canvas'); c.width = 160; c.height = 120;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.clearRect(0, 0, 160, 120);
        try { g.drawImage(v, 0, 0, 160, 120); } catch (e) { return { err: e.message }; }
        const d = g.getImageData(0, 0, 160, 120).data;
        let nonBlack = 0;
        const gw = 4, gh = 3, acc = new Float64Array(12), cnt = new Float64Array(12);
        for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
          const k = (y * 160 + x) * 4, lum = d[k] + d[k + 1] + d[k + 2];
          if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
          acc[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)] += lum / 3;
          cnt[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)]++;
        }
        const means = Array.from(acc, (a, i2) => a / cnt[i2]);
        return { nonBlack, coarse: means.map((m) => Math.round(m / 8)).join('.') };
      }));
      await sleep(400);
    }
    const good = samples.filter((s) => !s.err);
    const distinct = new Set(good.map((s) => s.coarse)).size;
    const maxNB = Math.max(...good.map((s) => s.nonBlack), 0);
    (maxNB > 0) ? ok('guest-frames-non-black', `${maxNB}/19200 pixels lit at peak`)
                : bad('guest-frames-non-black', 'every sample was pure black over the broker path');
    (distinct >= 2) ? ok('guest-frames-changing', `${distinct} distinct coarse signatures over ~4.8 s`)
                    : bad('guest-frames-changing', `only ${distinct} — frozen`);
    out.video = { distinct, maxNonBlack: maxNB };

    // Real received rate over the broker-negotiated connection.
    const fps = await guest.evaluate(async () => {
      const v = document.getElementById('mpVideo');
      const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      await new Promise((r) => setTimeout(r, 6000));
      const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      return (q0 && q1) ? +(((q1.totalVideoFrames - q0.totalVideoFrames) * 1000) / 6000).toFixed(2) : null;
    });
    info('guest received fps', fps === null ? 'unavailable' : fps + ' fps decoded over the broker path');
    out.guestFps = fps;

    // Does a press cross the REAL wire and reach the host's core?
    const readPad = P.padRead
      ? () => host.evaluate(P.padRead, P.hostSeam)
      : () => host.evaluate((s) => { const n = window[s](); return { p1: n.sentP1, p2: n.sentP2, remote: n.remotePad }; }, P.hostSeam);
    const press = (keys, down) => guest.evaluate((k, d) => {
      k.forEach((key2) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key: key2 })));
    }, keys, down);
    const idle = await readPad();
    await press(P.press, true);
    await sleep(2000);
    const held = await readPad();
    const guestMask = await guest.evaluate((s) => window[s]().mask, P.guestSeam);
    await press(P.press, false);
    await sleep(2000);
    const released = await readPad();
    out.pad = { idle, held, released, guestMask };
    (guestMask !== 0 && held.remote === guestMask && released.remote === 0)
      ? ok('guest-input-crosses-the-BROKER-path', `guest packed 0x${h(guestMask)}, host remotePad 0x${h(held.remote)}, released 0x${h(released.remote)}`)
      : bad('guest-input-crosses-the-BROKER-path', `guest 0x${h(guestMask)} -> host 0x${h(held.remote)} (released 0x${h(released.remote)})`);

    // ---- claim 2: the port-1 BYTES, over a real WebRTC link -----------------
    // dreamcast/docs/gauntlet-two-players/TASKS.md proves those bytes create and
    // move a second character. It produced them from a synthetic gamepad in one
    // tab. This reads what the netplay path ACTUALLY writes there, so the two
    // halves of the composition can be compared byte for byte.
    if (P.padRead && held.p2) {
      const s16 = (a, o) => (((a[o] | (a[o + 1] << 8)) << 16) >> 16);
      const B_BIT = 1 << 0, RIGHT_BIT = 1 << 7;
      const d0 = held.p2[0] | 0, lx = s16(held.p2, 8);
      const p1lx = held.p1 ? s16(held.p1, 8) : 0;
      const idleZero = idle.p2 && idle.p2.every((b) => b === 0);
      const relZero = released.p2 && released.p2.every((b) => b === 0);
      const digitalOk = !!(d0 & B_BIT) && !!(d0 & RIGHT_BIT);
      (idleZero && digitalOk && relZero)
        ? ok('port1-digital-over-webrtc', `port 1 byte0 = 0x${h(d0)} (B|RIGHT), idle and release both all-zero`)
        : bad('port1-digital-over-webrtc', `idleZero=${idleZero} byte0=0x${h(d0)} relZero=${relZero}`);
      // THE NUMBER THE COMPOSITION TURNS ON.
      (lx === 32766)
        ? ok('port1-analog-is-32766-NOT-32767',
             `port 1 left-stick X = ${lx} over the wire. The Gauntlet proof drove +32767 from a synthetic pad; `
             + `the netplay path quantises to a signed byte and reconstructs 127*258. Both saturate the DC's `
             + `8-bit analog, so the composition holds — but the two halves are NOT the same value.`)
        : bad('port1-analog-is-32766-NOT-32767', `port 1 left-stick X = ${lx} (expected 32766 from 127*258)`);
      // Port 0 is the HOST's own controller and nobody is touching it.
      (held.p1 && held.p1.every((b) => b === 0))
        ? ok('port0-untouched-by-the-remote-player', 'the host keeps its own controller: port 0 all-zero while port 1 is held')
        : bad('port0-untouched-by-the-remote-player', `port 0 = ${J(held.p1)} lx=${p1lx}`);
      out.dcPorts = { idle: idle.p2, held: held.p2, released: released.p2, p1: held.p1, lx };
    }

    try {
      await guest.screenshot({ path: `/tmp/audit-peerjs-${key}-guest.png` });
      await host.screenshot({ path: `/tmp/audit-peerjs-${key}-host.png` });
      info('screenshots', `/tmp/audit-peerjs-${key}-guest.png  /tmp/audit-peerjs-${key}-host.png`);
    } catch (e) {}
  }
  if (hostConsole.length) info('host log tail', hostConsole.slice(-6).join(' | '));
} catch (e) {
  bad('harness', (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' ') : String(e)));
} finally {
  await hostB.close().catch(() => {});
  await guestB.close().catch(() => {});
}

out.results = rec;
fs.writeFileSync('/tmp/audit-peerjs.json', JSON.stringify(out, null, 2));
const failed = rec.filter((r) => !r.ok).length;
console.log(`\n[audit-peerjs] ${failed ? failed + ' FAILED' : 'all ' + rec.length + ' passed'}   json /tmp/audit-peerjs.json`);
console.log(`load at start: ${load.split('load averages:').pop().trim()}`);
process.exit(failed ? 1 : 0);

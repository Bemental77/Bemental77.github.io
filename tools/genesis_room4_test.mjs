#!/usr/bin/env node
// DOES genesis.html PLAY A 3- OR 4-PLAYER ROOM, WITH EVERY PLAYER'S PAD IN THE GAME?
//
// The Genesis twin of tools/snes_room4_test.mjs (read it for the rig's
// reasoning): N real genesis.html windows (?net=local), the host holding its
// load until N are in, and the MULTITAP genesis.html plugs in when the agreed
// roster seats 3+ AND the cartridge takes one (genMultitapPlan).
//
// THE GAME. No shipped ROM takes a multitap (Sonic 3 and X-Men are two-player).
// Every window's request for the built-in Sonic 3 is answered with
// tools/genesis_multitap_rom.mjs — 68000 code that reads four pads through a
// Sega Team Player AND an EA 4-Way Play, whose header's I/O field says "J4", so
// the page's own rule plugs a Team Player into port A. Every "the game saw the
// pad" assertion is on what that GUEST CODE stored in work RAM (the Team
// Player data nibble for pad k at $FF0047+2k, active low), read out of the
// core (gpx_wram_ptr), on EVERY window. A commercial Team Player / 4-Way Play
// title would be needed to see it in a real game; none is shipped.
//
// USAGE
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/genesis_room4_test.mjs [--players 3|4] [--seconds N] [--headful] [--url BASE]
import { createRequire } from 'module';
import { execSync } from 'child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const { buildGenesisMultitapRom, ramByte } = await import(new URL('./genesis_multitap_rom.mjs', import.meta.url).href);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const N = Math.max(3, Math.min(4, parseInt(flag('players', '4'), 10) || 4));
const SECONDS = parseInt(flag('seconds', '8'), 10);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = Buffer.from(buildGenesisMultitapRom());
const POLL_MS = 250;   // never rAF polling: see tools/snes_netplay_test.mjs

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  ${detail == null ? '' : detail}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail == null ? '' : detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One WINDOW per peer (a hidden tab gets no rAF and would run zero frames).
async function openWindowPage(browser) {
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  await cdp.detach();
  for (let i = 0; i < 100; i++) {
    for (const t of browser.targets()) {
      const id = t._targetId || (t._targetInfo && t._targetInfo.targetId);
      if (id === targetId) { const p = await t.page(); if (p) return p; }
    }
    await sleep(100);
  }
  throw new Error('could not open a separate browser window for a peer');
}

async function openPeer(browser, tag) {
  const page = await openWindowPage(browser);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  // THE GAME: the built-in ROM's URL answers with the multitap test ROM, on
  // every window, so every console loads the same bytes (lsDisc agrees).
  await page.setRequestInterception(true);
  let served = 0;
  page.on('request', (req) => {
    if (/\/genesis\/genesisWasm\/roms\/Sonic(%20| )the(%20| )Hedgehog(%20| )3(%20| )\(USA\)\.gen(\?|$)/.test(req.url())) {
      served++;
      req.respond({ status: 200, contentType: 'application/octet-stream', body: ROM, headers: { 'content-length': String(ROM.length) } });
    } else req.continue();
  });
  await page.goto(`${BASE}/genesis.html?net=local`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!(window.Module && typeof window.Module._gpx_run === 'function'
    && typeof window.Module._gpx_set_multitap === 'function' && window.__genNet && window.__genNet().supported),
    { timeout: 120000, polling: POLL_MS });
  return { page, errs, tag, served: () => served };
}

(async () => {
  console.log(`=== genesis ${N}-player room test (Team Player) ===`);
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: has('headful') ? false : 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
  });
  try {
    const P = [];
    for (let i = 0; i < N; i++) P.push(await openPeer(browser, i ? 'G' + i : 'H'));
    const vis = await Promise.all(P.map((p) => p.page.evaluate(() => document.visibilityState)));
    ok('every-peer-can-render', vis.every((v) => v === 'visible'), `visibilityState ${vis.join('/')}`);

    // ---- the host opens a room and asks for N ----------------------------
    const code = await P[0].page.evaluate((n) => {
      document.getElementById('btnNet').click();
      document.getElementById('netHostBtn').click();
      const sel = document.getElementById('netSeats');
      sel.value = String(n); sel.dispatchEvent(new Event('change'));
      return document.getElementById('netCode').textContent.trim();
    }, N);
    // ---- each guest joins in turn, and the host admits each ----------------
    for (let i = 1; i < N; i++) {
      await P[i].page.evaluate((c) => {
        document.getElementById('btnNet').click();
        document.getElementById('netJoinBtn').click();
        document.getElementById('netCodeIn').value = c;
        document.getElementById('netGo').click();
      }, code);
      const allowed = await P[0].page.waitForFunction(() => !!document.getElementById('npApproveAllow'), { timeout: 30000, polling: POLL_MS })
        .then(() => P[0].page.evaluate(() => { document.getElementById('npApproveAllow').click(); return true; })).catch(() => false);
      const seated = await P[i].page.waitForFunction(() => { const n = window.__genNet(); return n.localPorts && n.localPorts.length > 0; },
        { timeout: 30000, polling: POLL_MS }).then(() => true).catch(() => false);
      ok(`player-${i + 1}-admitted-and-seated`, allowed && seated, `allowed=${allowed} seated=${seated}`);
      if (i < N - 1) {
        // THE HOST HOLDS ITS LOAD until N are in — the window a third and fourth
        // player need, since a running room seats nobody.
        const h = await P[0].page.evaluate(() => { const n = window.__genNet(); return { armed: n.armed, autoStarted: n.party.autoStarted, seated: n.party.seated, barrier: n.party.barrier }; });
        ok(`the-host-waits-with-${i + 1}-of-${N}`, !h.armed && !h.autoStarted, JSON.stringify(h));
      }
    }

    const armed = (p) => p.page.waitForFunction(() => window.__genNet().armed, { timeout: 60000, polling: POLL_MS }).then(() => true).catch(() => false);
    const arm = await Promise.all(P.map(armed));
    ok('every-console-loaded-by-itself', arm.every(Boolean), `armed ${arm.join('/')} with no Start click`);
    const going = (p) => p.page.waitForFunction(() => window.__genNet().frames > 60, { timeout: 60000, polling: POLL_MS }).then(() => true).catch(() => false);
    const go = await Promise.all(P.map(going));
    ok('every-console-advances', go.every(Boolean), `running ${go.join('/')}`);

    const snap = () => Promise.all(P.map((p) => p.page.evaluate(() => {
      const n = window.__genNet(), M = window.Module, w = M._gpx_wram_ptr(), R = M.HEAPU8, b = (o) => R[w + (o ^ 1)];
      // Team Player data: pad k's RLDU nibble was read at counter 8+2k -> $40 + 7 + 2k (active low)
      const pads = []; for (let k = 0; k < 4; k++) pads.push(b(0x47 + 2 * k) & 0x0f);
      const eng = n.rollback && n.rollback.engine;
      return { ports: n.ports, localPorts: n.localPorts, roster: n.roster, multitap: n.multitap, tpStart: b(0x40),
               pads, gated: n.frames, hashes: n.hashes, state: n.state, fault: n.fault, mode: n.mode, label: n.party.label,
               engine: eng ? { desync: eng.desync, hashesCompared: eng.hashesCompared, confirmed: eng.confirmed } : null };
    })));
    const s0 = await snap();
    const mine = s0.map((x) => (x.localPorts || [])[0]);
    ok('a-four-port-room-and-N-different-seats', s0.every((x) => x.ports === 4) && new Set(mine).size === N && mine.every((p) => p != null),
       `ports ${s0.map((x) => x.ports).join('/')} seats ${JSON.stringify(mine)} labels ${JSON.stringify(s0.map((x) => x.label))}`);
    // kind 2 = Team Player in port A; input.system[0] = 13 = SYSTEM_TEAMPLAYER (core/input_hw/input.h)
    ok('every-console-plugged-the-multitap-in', s0.every((x) => x.multitap && x.multitap.decided && x.multitap.kind === 2 && x.multitap.core && x.multitap.core[0] === 13 && x.multitap.seated === N),
       `multitap ${JSON.stringify(s0.map((x) => x.multitap))}`);
    ok('the-game-saw-the-adaptor', s0.every((x) => x.tpStart === 0x0f),
       `Team Player start-request nibble (counter 1: xxx1111) per console: ${s0.map((x) => x.tpStart.toString(16)).join('/')}`);

    // ---- every player's pad reaches every console's GAME ----------------------
    // ArrowUp = UP (genesis.html KEYMAP); the Team Player hands it back as bit 0
    // of the pad's RLDU nibble, ACTIVE LOW. Each window drives the seat it holds.
    const UP = 1;
    for (let i = 0; i < N; i++) {
      const port = mine[i];
      await P[i].page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
      await sleep(1500);
      const s = await snap();
      await P[i].page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true })); });
      const onIts = s.every((x) => (x.pads[port] & UP) === 0);
      const notOthers = s.every((x) => x.pads.every((w, q) => q === port || (w & UP) !== 0));
      ok(`player-${i + 1}-(port ${port + 1})-drives-its-own-pad-in-every-game`, onIts && notOthers,
         `guest-read RLDU nibbles (active low) per console: ${s.map((x) => '[' + x.pads.map((w) => w.toString(16)).join(' ') + ']').join(' ')}`);
      await sleep(600);
    }

    await sleep(SECONDS * 1000);
    const s1 = await snap();
    const g = s1.map((x) => x.gated);
    ok('every-console-kept-running', g.every((f) => f > SECONDS * 30), `gated frames ${g.join('/')}`);
    ok('frames-stay-in-step', Math.max(...g) - Math.min(...g) <= 30, `spread ${Math.max(...g) - Math.min(...g)}`);
    ok('the-room-runs-rollback', s1.every((x) => x.mode === 'rollback'), `mode ${s1.map((x) => x.mode).join('/')}`);
    ok('fingerprints-compared-no-desync', s1.every((x) => x.hashes > 0 && x.state !== 'desync' && !x.fault && !(x.engine && x.engine.desync)),
       `hashes ${s1.map((x) => x.hashes).join('/')} compared ${s1.map((x) => x.engine && x.engine.hashesCompared).join('/')} state ${s1.map((x) => x.state).join('/')} fault ${s1.map((x) => x.fault).join('/')}`);
    const rate = (p) => p.page.evaluate(async () => {
      const hz = (window.Module && window.Module._gpx_fps && window.Module._gpx_fps()) || 59.922751, f0 = window.__genFrames | 0, t0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      return (((window.__genFrames | 0) - f0) / ((performance.now() - t0) / 1000)) / hz;
    });
    const rates = await Promise.all(P.map(rate));
    ok('guest-rate-1.000x-on-every-console', rates.every((x) => x >= 0.9 && x <= 1.02), rates.map((x) => x.toFixed(4) + 'x').join(' / '));
    ok('every-window-was-served-the-test-rom', P.every((p) => p.served() >= 1), P.map((p) => p.served()).join('/'));
    const errs = P.flatMap((p) => p.errs).filter((e) => !/favicon/i.test(e));
    ok('no-page-errors', errs.length === 0, errs.slice(0, 4).join(' | ') || 'none');
  } catch (e) {
    fail++;
    console.log('  FAIL  harness  ' + ((e && e.stack) || e));
  } finally {
    if (!has('keep')) { try { await browser.close(); } catch (e) {} }
  }
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
  console.log(`\n[genesis-room${N}] ${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();

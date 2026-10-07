#!/usr/bin/env node
// DOES ps1.html PLAY A 3- OR 4-PLAYER ROOM, WITH EVERY PLAYER'S PAD IN THE GAME?
//
// The two-player room is tools/ps1_netplay_test.mjs. This is the room past the
// front of the console: N real ps1.html windows (?net=local, one browser, so
// lib/netplay.js's BroadcastChannel signalling pairs them with no broker), the
// host holding its load until N are in ("Start when N players are in"), and the
// MULTITAP ps1.html plugs into port 1 once the agreed roster seats 3+.
//
// THE GAME. No shipped disc reads a multitap (ps1.html ROMS[]). Every window's
// request for the Harry Potter disc (ROMS[3], the smallest) is answered with
// tools/ps1_multitap_disc.mjs instead — guest code, booted by the BIOS, that
// reads all four slots through the multitap (an "all four" read and each slot
// on its own) by driving the SIO registers itself — and every assertion about
// "the game saw the pad" is on what that GUEST CODE stored in main RAM, read
// out of the core (the worker's netSnapMap / netPeek), on EVERY window. For a
// commercial check, Crash Team Racing (SCUS-94426) is a 4-player multitap game.
//
// WHAT IS CHECKED
//   1. N windows seat N DIFFERENT ports of a 4-port room; nobody presses Start
//      (the host waits for N, then everyone loads by itself).
//   2. Every console plugged the multitap in (the page's decision AND the
//      core's answer to 'netMultitap'), and the guest saw it: its "all four"
//      read answered 0x80, slots A..N hold pads (ID 0x41), the rest are empty
//      (0xFF), and the console's port 2 is empty.
//   3. For EACH player in turn: ArrowUp held on THAT window shows up as THAT
//      port's slot — in the all-four read AND in the one-slot read — in the
//      guest RAM of EVERY window's game, and on no other slot.
//   4. The room runs rollback, fingerprints were compared, no desync, frames in
//      step, guest rate ~1.000x on every window (never above, not wedged).
//
// USAGE
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/ps1_room4_test.mjs [--players 3|4] [--seconds N] [--headful] [--url BASE]
import { createRequire } from 'module';
import { execSync } from 'child_process';
import zlib from 'node:zlib';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const { buildMultitapDisc, RAM, MAGIC } = await import(new URL('./ps1_multitap_disc.mjs', import.meta.url).href);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const N = Math.max(3, Math.min(4, parseInt(flag('players', '4'), 10) || 4));
const SECONDS = parseInt(flag('seconds', '8'), 10);
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const POLL_MS = 250;   // never rAF polling: see tools/ps1_netplay_test.mjs
const ROM = 3;         // ps1.html ROMS[3] = Harry Potter, chunks a..d
const CHUNK_SIZES = [89128960, 89128960, 89128960, 78645764];
const DISC = buildMultitapDisc();
// The disc in chunk a, zero-padded to that chunk's size; the other chunks zeros.
const GZ = CHUNK_SIZES.map((n, i) => { const b = Buffer.alloc(n); if (i === 0) b.set(DISC, 0); return zlib.gzipSync(b, { level: 1 }); });

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  ${detail == null ? '' : detail}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail == null ? '' : detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One WINDOW per peer (a hidden tab gets no rAF and would feed zero frames).
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
  // THE GAME: the Harry Potter disc's chunks answer with the multitap test
  // disc, on every window, so every console loads the same bytes (lsDisc agrees).
  await page.setRequestInterception(true);
  let served = 0;
  page.on('request', (req) => {
    const m = /\/HarryPotterSorcerersStone\.bin\.parta([a-d])\.gz(\?|$)/.exec(req.url());
    if (m) {
      served++;
      const body = GZ[m[1].charCodeAt(0) - 97];
      req.respond({ status: 200, contentType: 'application/gzip', body, headers: { 'content-length': String(body.length) } });
    } else req.continue();
  });
  await page.goto(`${BASE}/ps1.html?net=local`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !!(window.__ps1Net && window.__ps1Net().supported && window.Netplay), { timeout: 120000, polling: POLL_MS });
  return { page, errs, tag, served: () => served };
}

// What the GUEST stored (tools/ps1_multitap_disc.mjs RAM map), read out of
// this window's core through its own worker.
const guestRead = (page) => page.evaluate(async (R) => {
  const w = window.pcsx_worker; if (!w) return null;
  const once = (cmd, msg) => new Promise((res) => {
    const h = (e) => { if (e.data && e.data.cmd === cmd) { w.removeEventListener('message', h); res(e.data); } };
    w.addEventListener('message', h); w.postMessage(msg);
  });
  if (!window.__mtRig) { const m = await once('netSnapMapResult', { cmd: 'netSnapMap', block: 1 << 20 }); window.__mtRig = { m: m.mem.m >>> 0 }; }
  const base = window.__mtRig.m + R.base;
  const offs = [R.loops, R.magic, R.fullBtn, R.fullBtn + 4, R.fullHdr, R.passBtn, R.passBtn + 4, R.port2Btn, R.fullId, R.passId, R.port2Id];
  const r = await once('netPeekResult', { cmd: 'netPeek', addrs: offs.map((o) => base + o), tag: 'mtrig' });
  const v = r.vals.map((x) => x >>> 0);
  const lo = (x) => x & 0xffff, hi = (x) => x >>> 16, b = (x, i) => (x >>> (8 * i)) & 0xff;
  return { loops: v[0], magic: v[1], full: [lo(v[2]), hi(v[2]), lo(v[3]), hi(v[3])], fullHdr: b(v[4], 0),
           pass: [lo(v[5]), hi(v[5]), lo(v[6]), hi(v[6])], port2: lo(v[7]),
           fullId: [0, 1, 2, 3].map((i) => b(v[8], i)), passId: [0, 1, 2, 3].map((i) => b(v[9], i)), port2Id: b(v[10], 0) };
}, RAM);

(async () => {
  console.log(`=== ps1 ${N}-player room test (multitap) ===`);
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
  try {
    const md5 = (f) => require('node:crypto').createHash('md5').update(require('node:fs').readFileSync(f)).digest('hex');
    console.log('worker: js=' + md5('ps1/ps1Wasm/dist/wasmpsx_worker.js') + ' wasm=' + md5('ps1/ps1Wasm/dist/wasmpsx_worker.wasm'));
  } catch (e) {}
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: has('headful') ? false : 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
  });
  try { const g = require('./browser_leak_guard.js'); if (g && g.guard) g.guard(browser, 'ps1_room4_test'); } catch (e) {}
  try {
    const P = [];
    for (let i = 0; i < N; i++) P.push(await openPeer(browser, i ? 'G' + i : 'H'));
    const vis = await Promise.all(P.map((p) => p.page.evaluate(() => document.visibilityState)));
    ok('every-peer-can-render', vis.every((v) => v === 'visible'), `visibilityState ${vis.join('/')}`);

    // ---- the host picks the disc, opens a room and asks for N ---------------
    const code = await P[0].page.evaluate((n, rom) => {
      const s = document.getElementById('romSelect'); s.value = String(rom); s.dispatchEvent(new Event('change'));
      document.getElementById('btnNet').click();
      document.getElementById('netHostBtn').click();
      const sel = document.getElementById('netSeats');
      sel.value = String(n); sel.dispatchEvent(new Event('change'));
      return document.getElementById('netCode').textContent.trim();
    }, N, ROM);
    ok('host-mints-a-code', /^[A-HJ-NP-Z2-9]{5}$/.test(code), `code=${code}`);
    // ---- each guest joins in turn, and the host admits each ----------------
    for (let i = 1; i < N; i++) {
      await P[i].page.evaluate((c, rom) => {
        document.getElementById('btnNet').click();
        document.getElementById('netJoinBtn').click();
        document.getElementById('netGame').value = String(rom);
        document.getElementById('netCodeIn').value = c;
        document.getElementById('netGo').click();
      }, code, ROM);
      const allowed = await P[0].page.waitForFunction(() => !!document.getElementById('npApproveAllow'), { timeout: 30000, polling: POLL_MS })
        .then(() => P[0].page.evaluate(() => { document.getElementById('npApproveAllow').click(); return true; })).catch(() => false);
      const seated = await P[i].page.waitForFunction(() => { const n = window.__ps1Net(); return n.localPorts && n.localPorts.length > 0; },
        { timeout: 30000, polling: POLL_MS }).then(() => true).catch(() => false);
      ok(`player-${i + 1}-admitted-and-seated`, allowed && seated, `allowed=${allowed} seated=${seated}`);
      if (i < N - 1) {
        // THE HOST HOLDS ITS LOAD until N are in — the window a third and fourth
        // player need, since a running room seats nobody.
        const h = await P[0].page.evaluate(() => { const n = window.__ps1Net(); return { armed: n.armed, autoStarted: n.party.autoStarted, seated: n.party.seated, barrier: n.party.barrier }; });
        ok(`the-host-waits-with-${i + 1}-of-${N}`, !h.armed && !h.autoStarted, JSON.stringify(h));
      }
    }

    const armed = (p) => p.page.waitForFunction(() => window.__ps1Net().armed, { timeout: 90000, polling: POLL_MS }).then(() => true).catch(() => false);
    const arm = await Promise.all(P.map(armed));
    ok('every-console-loaded-by-itself', arm.every(Boolean), `armed ${arm.join('/')} with no Start click`);
    // The BIOS boots the disc (~4 s of guest time) before the program runs.
    const going = (p) => p.page.waitForFunction(() => window.__ps1Net().workerFrames > 420, { timeout: 180000, polling: POLL_MS }).then(() => true).catch(() => false);
    const go = await Promise.all(P.map(going));
    ok('every-console-advances', go.every(Boolean), `running ${go.join('/')}`);

    const snap = () => Promise.all(P.map(async (p) => {
      const n = await p.page.evaluate(() => { const n = window.__ps1Net(); return { ports: n.portCount, localPorts: n.localPorts, multitap: n.multitap,
        frames: n.workerFrames, hashes: n.hashes, state: n.state, fault: n.fault, mode: n.netMode, label: n.party.label, hz: n.hz,
        engine: n.engine ? { desync: n.engine.desync, hashesCompared: n.engine.hashesCompared } : null }; });
      n.guest = await guestRead(p.page);
      return n;
    }));
    const s0 = await snap();
    const mine = s0.map((x) => (x.localPorts || [])[0]);
    ok('a-four-port-room-and-N-different-seats', s0.every((x) => x.ports === 4) && new Set(mine).size === N && mine.every((p) => p != null),
       `ports ${s0.map((x) => x.ports).join('/')} seats ${JSON.stringify(mine)} labels ${JSON.stringify(s0.map((x) => x.label))}`);
    ok('every-console-plugged-the-multitap-in', s0.every((x) => x.multitap && x.multitap.decided && x.multitap.on && x.multitap.slots === N && x.multitap.core === N && x.multitap.seated === N),
       `multitap ${JSON.stringify(s0.map((x) => x.multitap))}`);
    const expId = [0, 1, 2, 3].map((i) => (i < N ? 0x41 : 0xff)), expPassId = [0, 1, 2, 3].map((i) => (i < N ? 0x41 : 0xee));
    ok('the-game-runs-and-saw-the-adaptor', s0.every((x) => x.guest && x.guest.magic === MAGIC && x.guest.fullHdr === 0x80
         && x.guest.fullId.every((v, i) => v === expId[i]) && x.guest.passId.every((v, i) => v === expPassId[i]) && x.guest.port2Id === 0xee && x.guest.port2 === 0xeeee),
       `guest per console: ${s0.map((x) => JSON.stringify(x.guest && { loops: x.guest.loops, hdr: x.guest.fullHdr, fullId: x.guest.fullId, passId: x.guest.passId, port2Id: x.guest.port2Id })).join(' ')}`);

    // ---- every player's pad reaches every console's GAME ----------------------
    // ArrowUp = the D-pad's Up = KeyStatus bit 4, ACTIVE-LOW (ps1.html ps1LocalMask).
    const UP = 1 << 4;
    for (let i = 0; i < N; i++) {
      const port = mine[i];
      await P[i].page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
      await sleep(1500);
      const s = await snap();
      await P[i].page.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true })); });
      const held = (w) => (w & UP) === 0;
      const onIts = s.every((x) => x.guest && held(x.guest.full[port]) && held(x.guest.pass[port]));
      const notOthers = s.every((x) => x.guest && [0, 1, 2, 3].every((q) => q === port || (!held(x.guest.full[q]) && !held(x.guest.pass[q]))));
      ok(`player-${i + 1}-(port ${port + 1})-drives-its-own-slot-in-every-game`, onIts && notOthers,
         `guest-read slots per console (all-four | one-at-a-time): ${s.map((x) => x.guest ? '[' + x.guest.full.map((w) => w.toString(16)).join(' ') + ' | ' + x.guest.pass.map((w) => w.toString(16)).join(' ') + ']' : 'null').join(' ')}`);
      await sleep(800);
    }

    await sleep(SECONDS * 1000);
    const s1 = await snap();
    const g = s1.map((x) => x.frames);
    ok('every-console-kept-running', g.every((f) => f > SECONDS * 30), `worker frames ${g.join('/')}`);
    ok('frames-stay-in-step', Math.max(...g) - Math.min(...g) <= 30, `spread ${Math.max(...g) - Math.min(...g)}`);
    ok('the-room-runs-rollback', s1.every((x) => x.mode === 'rollback'), `mode ${s1.map((x) => x.mode).join('/')}`);
    ok('fingerprints-compared-no-desync', s1.every((x) => x.hashes > 0 && x.state !== 'desync' && !x.fault && !(x.engine && x.engine.desync)),
       `hashes ${s1.map((x) => x.hashes).join('/')} compared ${s1.map((x) => x.engine && x.engine.hashesCompared).join('/')} state ${s1.map((x) => x.state).join('/')} fault ${s1.map((x) => x.fault).join('/')}`);
    ok('the-guest-program-kept-reading', s1.every((x, i) => x.guest && x.guest.loops > s0[i].guest.loops), `loops ${s0.map((x) => x.guest.loops).join('/')} -> ${s1.map((x) => x.guest.loops).join('/')}`);
    const rate = (p) => p.page.evaluate(async () => {
      const n0 = window.__ps1Net(), f0 = n0.workerFrames, t0 = performance.now();
      await new Promise((r) => setTimeout(r, 4000));
      const n1 = window.__ps1Net();
      return ((n1.workerFrames - f0) / ((performance.now() - t0) / 1000)) / n1.hz;
    });
    const rates = await Promise.all(P.map(rate));
    ok('guest-rate-~1.000x-on-every-console', rates.every((x) => x >= 0.9 && x <= 1.02), rates.map((x) => x.toFixed(4) + 'x').join(' / '));
    ok('every-window-was-served-the-test-disc', P.every((p) => p.served() >= 4), P.map((p) => p.served()).join('/'));
    const errs = P.flatMap((p) => p.errs).filter((e) => !/favicon/i.test(e));
    ok('no-page-errors', errs.length === 0, errs.slice(0, 4).join(' | ') || 'none');
  } catch (e) {
    fail++;
    console.log('  FAIL  harness  ' + ((e && e.stack) || e));
  } finally {
    if (!has('keep')) { try { await browser.close(); } catch (e) {} }
  }
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
  console.log(`\n[ps1-room${N}] ${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();

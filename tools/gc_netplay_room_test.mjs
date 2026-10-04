#!/usr/bin/env node
// tools/gc_netplay_room_test.mjs — N MARIO PARTY 4s IN ONE ROOM, FOR A LONG TIME, WITH INPUT.
//
// The GameCube room runs on the recomp engine's frame gate (gamecube.html THE LOCKSTEP
// INTERLOCK): one credit == one guest frame with the room's agreed pad image latched before it.
// This drives PLAYERS real gamecube.html tabs (one browser, the same-browser transport ?net=local)
// through the shared Party panel — host opens, every guest joins by code, the host admits each —
// and then LEAVES THEM PLAYING for RUN_MS while every tab presses buttons, asking:
//
//   1. the Party control is offered for Mario Party 4 and REFUSED for the titles that cannot run
//      a room (lib/mpgames.js ROOMABLE) — on a plain visit, before anything is paired;
//   2. every console agreed the SAME memory card (the host's / one blank card) and the same build,
//      and the barrier compared those in the disc tag;
//   3. nobody ran frame 0 before the room released, and then everyone runs;
//   4. 0 DESYNCS over the whole run: the whole-guest-state fingerprint (recomp_worker.js THE
//      STATE FINGERPRINT) is published, actually COMPARED against every peer, and never differs;
//   5. the ROOM RATE: guest frames per wall second / 60, per console, per window — 1.000x is a
//      ceiling the gate can only withhold from, so this reports how close the room holds to it;
//   6. every console's input reaches the HOST's game on that console's own port, read back out
//      of MP4's own HuPadBtnDown (the pad witness), and never on someone else's;
//   7. the party panel says what is true: every row 'playing', the room's sentence;
//   8. LAST, the detector fires: perturb one console's fingerprint and every console names it.
//   9. THE MODE: every console runs ROLLBACK with 0 frames of added input delay (the recomp worker's
//      rollback ring — gamecube.html THE ROLLBACK RING), the rings actually rewound and
//      re-simulated, and the local-input-lag witness reads 0 frames. RB=0 expects input delay
//      instead (the page's ?rb=0 arm).
//
// Usage (hermetic snapshot, see CLAUDE.md gate #10/#11 on torn pairs):
//   WEB_ROOT=<snapshot> PROBE_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   NODE_PATH=~/probe-deps/node_modules node tools/gc_netplay_room_test.mjs
// Env: PLAYERS (2..4, default 2)  RUN_MS (the long run, default 600000)  BOOT_MS (default 600000)
//      PORT (default 18905)  WEB_ROOT  OUT (JSON)  SHOTS (screenshot dir)  HEADLESS (default new)
//      FORCE_DESYNC (default 1)
// Modes:
//   (default)  PLAYERS tabs in ONE browser, same-browser transport (?net=local), paired by typing
//              the code into the Party panel.
//   SEPARATE=1 one browser PROCESS + fresh profile per player, arriving by the lobby's hand-off URL
//              (?np=&game=[&join=1]) over the SHIPPED signalling (MQTT relay against
//              tools/mqtt_ws_broker.mjs, mqtt.js injected as the device matrix does) and real WebRTC.
//   HOST_CARD=<.raw> seed the host's IndexedDB card; with SEPARATE=1 each guest gets a DIFFERENT
//              card and the run proves the room played the host's and left the guest's untouched.
//   CHAIN=1    into a BOARD: ?board=1 on every console, the host presses the board chain keyed on
//              the room's guest frame, then everyone mashes non-Start buttons. Default input: the
//              host walks (Start, then A) while the others mash.
//   MOBILE=i,j those tabs emulate a phone (the mobile shell; the room presses the splash's Start).
//   CONTROL=1  the MATCHED CONTROL for the rate: the same tabs and input, solo, no room.
//   NO_WEBGPU=1 every browser without WebGPU (device matrix no-webgpu arm): the WebGL2 fallback.
// Every window prints the room rate per console AND where the time went: held for the ROOM's
// input (the other console's frames had not arrived) vs held for this console's OWN worker.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(REPO + '/tools/_anchor.js');
const puppeteer = require('puppeteer');
let guard = null; try { guard = require(REPO + '/tools/browser_leak_guard.js'); } catch (e) {}
const CHROME = process.env.PROBE_CHROME || process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PLAYERS = Math.max(2, Math.min(4, parseInt(process.env.PLAYERS || '2', 10)));
const RUN_MS = parseInt(process.env.RUN_MS || '600000', 10);
const BOOT_MS = parseInt(process.env.BOOT_MS || '600000', 10);
const PORT = parseInt(process.env.PORT || '18905', 10);
const WEB_ROOT = process.env.WEB_ROOT || REPO;
const OUT = process.env.OUT || path.join(os.tmpdir(), 'gc_netplay_room.json');
const SHOTS = process.env.SHOTS || os.tmpdir();
const FORCE_DESYNC = process.env.FORCE_DESYNC !== '0';
const MOBILE = (process.env.MOBILE || '').split(',').filter(Boolean).map((x) => x | 0);
// SEPARATE=1: one browser PROCESS and one fresh PROFILE per player, paired over the SHIPPED
// signalling path (MQTT relay, ?signal=ws) against a local broker (tools/mqtt_ws_broker.mjs — the
// public brokers reset from this sandbox) and a real RTCPeerConnection. Default (0): PLAYERS tabs
// in one browser over the same-browser transport (?net=local).
const SEPARATE = process.env.SEPARATE === '1';
// HOST_CARD=<.raw>: seed the HOST's IndexedDB with that memory card; every guest gets a DIFFERENT
// card (the same image with its first block's bytes inverted). Only meaningful with SEPARATE=1:
// tabs of one browser share one IndexedDB.
const HOST_CARD = process.env.HOST_CARD ? fs.readFileSync(process.env.HOST_CARD) : null;
// CONTROL=1: the MATCHED CONTROL for the room rate. The same PLAYERS tabs, the same disc, the same
// masher, the same windows — but NO room: each tab presses its own Start and plays solo. The rate
// the room reaches is only interpretable next to what this box gives the same load without a gate
// (CLAUDE.md gate #10: report the machine load; ratios are the durable part).
const CONTROL = process.env.CONTROL === '1';
const NO_WEBGPU = process.env.NO_WEBGPU === '1';
const RB = process.env.RB !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const hex = (v) => '0x' + (v >>> 0).toString(16);
const load = () => os.loadavg().map((v) => v.toFixed(2)).join(' ');
const report = { players: PLAYERS, runMs: RUN_MS, windows: [], load0: os.loadavg() };

// ---- server + hash guard -----------------------------------------------------------------------
const srv = spawn(process.execPath, [path.join(REPO, 'tools', 'devserver.mjs')],
                  { env: Object.assign({}, process.env, { WEB_ROOT, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write('[devserver] ' + d));
const ORIGIN = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { const r = await fetch(ORIGIN + '/coi-serviceworker.js'); if (r.ok) break; } catch (e) {} await sleep(100); }
const WATCH = ['/gamecube.html', '/gamecube/recomp/recomp_worker.js', '/gamecube/recomp/mp4_game.wasm',
               '/lib/netplay.js', '/lib/netplay-ui.js', '/lib/mpgames.js', '/gamecube/dolphin_libretro/dolphin_worker_emcc.wasm'];
async function servedMd5() {
  const out = {};
  for (const p of WATCH) out[p] = crypto.createHash('md5').update(Buffer.from(await (await fetch(ORIGIN + p)).arrayBuffer())).digest('hex');
  return out;
}
report.md5 = await servedMd5();
console.log('[room] served md5 ' + JSON.stringify(report.md5));
console.log(`[room] ${PLAYERS} players, run ${RUN_MS / 1000}s, root ${WEB_ROOT}, load ${load()}`);

const browsers = [], dirs = [];
async function launch() {
  const dir = SEPARATE ? fs.mkdtempSync(path.join(os.tmpdir(), 'gcroom-')) : null;
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: process.env.HEADLESS === '0' ? false : 'new',
    userDataDir: dir || undefined,
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           // NO_WEBGPU=1: the device matrix's no-webgpu arm (tools/device_matrix.mjs — the one spelling
           // measured to remove the adapter while leaving WebGL2), so the room runs the WebGL2 fallback.
           // One --disable-features list: a second copy of the switch replaces the first.
           NO_WEBGPU ? '--disable-features=IntensiveWakeUpThrottling,WebGPUService,Dawn'
                     : '--disable-features=IntensiveWakeUpThrottling',
           ...(NO_WEBGPU ? [] : ['--enable-unsafe-webgpu']), '--js-flags=--max-old-space-size=4096', '--disk-cache-size=1'],
  });
  if (guard) try { guard.guard(b, 'gc_netplay_room_test'); } catch (e) {}
  browsers.push(b); if (dir) dirs.push(dir);
  return b;
}
let broker = null, mqttSrc = null;
if (SEPARATE) {
  // lib/netplay.js loads mqtt.js from cdnjs unless window.mqtt already exists (loadMqtt); Chromium
  // here has no route to cdnjs, so — exactly as tools/netplay_device_matrix.mjs does — the SAME
  // file is fetched once through this process's proxy and defined before any page script runs.
  const MQTT_CACHE = path.join(os.tmpdir(), 'npdm', 'mqtt-5.3.4.min.js');
  if (!fs.existsSync(MQTT_CACHE) || fs.statSync(MQTT_CACHE).size < 100000) {
    fs.mkdirSync(path.dirname(MQTT_CACHE), { recursive: true });
    const { execSync } = await import('node:child_process');
    execSync(`curl -sS -f -o ${MQTT_CACHE} https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js`);
  }
  mqttSrc = fs.readFileSync(MQTT_CACHE, 'utf8');
  const { startBroker } = await import('./mqtt_ws_broker.mjs');
  broker = await startBroker({ port: 0 });
  console.log('[room] local MQTT broker ' + broker.url);
}
async function finish(code) {
  try { report.md5After = await servedMd5(); } catch (e) {}
  try { fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); } catch (e) {}
  for (const b of browsers) { try { await b.close(); } catch (e) {} }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  if (broker) { try { await broker.close(); } catch (e) {} }
  srv.kill();
  console.log(`\n[gc-netplay-room] ${pass} passed, ${fail} failed  (report ${OUT}; load ${load()})`);
  process.exit(code);
}

async function coiSettle(page) {
  for (let i = 0; i < 160; i++) {
    try { if (await page.evaluate(() => window.crossOriginIsolated === true && !!window.NetplayUI)) break; } catch (e) {}
    await sleep(250);
  }
  let stable = 0, last = '';
  for (let i = 0; i < 20 && stable < 3; i++) {
    try { const h = await page.evaluate(() => location.href); if (h === last) stable++; else { stable = 1; last = h; } } catch (e) { stable = 0; }
    await sleep(250);
  }
}
// THE INPUT, one definition for the room and its control: console 0 WALKS INTO THE GAME the way a
// person does (Start at the title, then A every WALK_EVERY_MS for WALK_MS), every other console
// mashes the non-Start buttons and the stick; after the walk everyone mashes.
const WALK_MS = parseInt(process.env.WALK_MS || '120000', 10), WALK_EVERY_MS = parseInt(process.env.WALK_EVERY_MS || '2500', 10);
function startMasher(page, i) {
  return page.evaluate((seed, walk, walkMs, everyMs) => {
    let x = seed >>> 0 || 1;
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
    const BTN = [0x100, 0x100, 0x200, 0x400, 0x800, 0x40, 0x20, 0x10, 0, 0];   // A A B X Y L R Z (no Start)
    const t0 = performance.now(); let lastWalk = 0, walked = 0;
    window.__mash = { n: 0, walked: 0, timer: setInterval(() => {
      const now = performance.now();
      if (walk && now - t0 < walkMs) {
        if (now - lastWalk >= everyMs) { lastWalk = now; window.__gcPad.edge(0, walked++ === 0 ? 0x1000 : 0x100, 0); window.__mash.walked = walked; window.__mash.n++; }
        return;
      }
      const r = rnd();
      if ((r & 3) === 0) { window.__gcPad.edge(0, BTN[(r >>> 2) % BTN.length], (r >>> 8) & 0xf); window.__mash.n++; }
      window.__gcPad.stick(0, ((r >>> 12) & 0x7f) - 64, ((r >>> 20) & 0x7f) - 64);
    }, 33) };
  }, 0x9e3779b9 ^ (i * 7919), i === 0, WALK_MS, WALK_EVERY_MS);
}
// CHAIN=1: into a BOARD, not the title. Every console's URL carries ?board=1 (so the recomp's
// autoboard shortcut is armed IDENTICALLY everywhere — under a room the worker ignores ?board=1's
// frame script, LS_ARMED), and the HOST presses gamecube.html's own ?board=1 chain keyed on the
// ROOM's guest frame (title -> save prompts -> mode carousel -> Party Mode -> 1 human -> char
// select -> board) through the room like any other input. Guests are idle until the chain ends at
// frame CHAIN_END; then everyone mashes the non-Start buttons — dice, board, minigames.
const CHAIN = process.env.CHAIN === '1';
const CHAIN_STEPS = [[1000, 0x1000, 0, 0, 0], [1300, 0x100, 0, 0, 0], [1600, 0, 8, 0, 0], [1700, 0x100, 0, 0, 0],
                     [2100, 0x100, 0, 0, 0], [2500, 0x100, 0, 0, 0], [3400, 0x100, 0, 0, 0], [3800, 0x100, 0, 0, 0],
                     [4300, 0x100, 0, 0, 0], [4400, 0, 0, -80, 0], [4450, 0, 0, -80, 0], [4500, 0, 0, -80, 0], [4650, 0x100, 0, 0, 0]];
const CHAIN_END = 4800;
function startChainMasher(page, i) {
  return page.evaluate((steps, end, isHost, seed) => {
    let x = seed >>> 0 || 1;
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
    const BTN = [0x100, 0x100, 0x200, 0x400, 0x800, 0x40, 0x20, 0x10, 0, 0];   // A A B X Y L R Z (no Start)
    let k = 0, stickUntil = 0;
    window.__mash = { n: 0, walked: 0, timer: setInterval(() => {
      const f = window.__gcLockstep().guestFrames, now = performance.now();
      if (stickUntil && now > stickUntil) { window.__gcPad.stick(0, 0, 0); stickUntil = 0; }
      if (f < end) {
        if (isHost && k < steps.length && f >= steps[k][0]) {
          const st = steps[k++];
          if (st[1] || st[2]) window.__gcPad.edge(0, st[1], st[2]);
          if (st[3] || st[4]) { window.__gcPad.stick(0, st[3], st[4]); stickUntil = now + 250; }
          window.__mash.walked = k; window.__mash.n++;
        }
        return;
      }
      const r = rnd();
      if ((r & 3) === 0) { window.__gcPad.edge(0, BTN[(r >>> 2) % BTN.length], (r >>> 8) & 0xf); window.__mash.n++; }
      window.__gcPad.stick(0, ((r >>> 12) & 0x7f) - 64, ((r >>> 20) & 0x7f) - 64);
    }, 16) };
  }, CHAIN_STEPS, CHAIN_END, i === 0, 0x9e3779b9 ^ (i * 7919));
}
const ovlOf = (p) => p.evaluate(() => { const w = window.__gcPad && window.__gcPad.witness(); return w ? w.ovl : null; }).catch(() => null);

// SEPARATE profiles arrive the way multiplayer.html sends them: the lobby's hand-off URL
// (?np=<code>&game=<label>[&join=1]), over the shipped signalling against the local broker.
const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HCODE = Array.from({ length: 5 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join('');
const URL_BASE = (SEPARATE && !CONTROL)
  ? `${ORIGIN}/gamecube.html?np=${HCODE}&game=${encodeURIComponent('Mario Party 4')}&signal=ws&wsbroker=${encodeURIComponent(broker.url)}&v=${Date.now()}`
  : `${ORIGIN}/gamecube.html?net=local&v=${Date.now()}`;
const URL_EXTRA = (CHAIN ? '&board=1' : '') + (RB ? '' : '&rb=0');
const pages = [];
const shared = SEPARATE ? null : await launch();
for (let i = 0; i < PLAYERS; i++) {
  const p = await (SEPARATE ? await launch() : shared).newPage();
  const who = i === 0 ? 'host' : 'p' + (i + 1);
  p.on('console', (m) => { const t = m.text(); if (/gc-lockstep|desync|DIVERG|recomp-live\] (failed|REFUS)|SPIN|main stopped/i.test(t)) console.log(`  [${who}] ${t.slice(0, 220)}`); });
  p.on('pageerror', (e) => console.log(`  [${who}] PAGEERROR ${String(e).slice(0, 220)}`));
  // MOBILE=<i,j>: those tabs emulate a phone (viewport, touch, UA) — gamecube.html then runs its
  // MOBILE SHELL and the room has to press the splash's Start (a pointerdown handler, not a
  // click). Chrome's engine, not WebKit: a phone-SHAPED page, not a real iPhone.
  if (MOBILE.includes(i)) await p.emulate(puppeteer.KnownDevices['Pixel 5']);
  else await p.setViewport({ width: 1100, height: 760 });
  try { const cdp = await p.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  if (mqttSrc) await p.evaluateOnNewDocument(mqttSrc);
  await p.goto(URL_BASE + URL_EXTRA + (SEPARATE && !CONTROL && i > 0 ? '&join=1' : ''), { waitUntil: 'load', timeout: 120000 });
  pages.push({ p, who });
}
for (const { p } of pages) await coiSettle(p);
const host = pages[0].p;

// ---- the memory cards: the host's, and a DIFFERENT one on every guest --------------------------
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function idbCard(page, buf) {
  return page.evaluate((b64) => new Promise((res, rej) => {
    const rq = indexedDB.open('GCRECOMPCARD', 1);
    rq.onupgradeneeded = (e) => e.target.result.createObjectStore('card');
    rq.onerror = () => rej(String(rq.error));
    rq.onsuccess = (e) => {
      const db = e.target.result, tx = db.transaction('card', b64 == null ? 'readonly' : 'readwrite'), st = tx.objectStore('card');
      if (b64 == null) {
        const g = st.get('MarioParty4.raw');
        g.onsuccess = () => { const v = g.result; if (!v) return res(null); const u = new Uint8Array(v); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); res(btoa(s)); };
        g.onerror = () => rej(String(g.error));
        return;
      }
      const bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      st.put(u8.buffer, 'MarioParty4.raw');
      tx.oncomplete = () => res(true); tx.onerror = () => rej(String(tx.error));
    };
  }), buf == null ? null : buf.toString('base64'));
}
const seeded = [];
if (HOST_CARD) {
  if (!SEPARATE) console.log('  (HOST_CARD without SEPARATE=1: every tab shares one IndexedDB, so the guests hold the same card)');
  for (let i = 0; i < PLAYERS; i++) {
    let buf = HOST_CARD;
    if (i > 0 && SEPARATE) { buf = Buffer.from(HOST_CARD); for (let k = 0; k < 8192; k++) buf[k] ^= 0xff; }
    if (i === 0 || SEPARATE) await idbCard(pages[i].p, buf);
    seeded.push(md5(buf));
  }
  console.log('[room] seeded cards: ' + seeded.map((m, i) => `${pages[i].who}=${m.slice(0, 8)}`).join(' '));
}

if (CONTROL) {
  for (const { p } of pages) await p.evaluate(() => {
    const sel = document.getElementById('romSelect');
    for (let i = 0; i < sel.options.length; i++) if (sel.options[i].textContent === 'Mario Party 4') sel.value = sel.options[i].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btnStart').click();
  });
  const t0c = Date.now();
  let up = false;
  while (Date.now() - t0c < BOOT_MS && !up) {
    await sleep(2000);
    const f = await Promise.all(pages.map(({ p }) => p.evaluate(() => window.__gcLockstep ? window.__gcLockstep().guestFrames : 0).catch(() => 0)));
    up = f.every((x) => x > 60);
  }
  console.log(`[control] ${PLAYERS} solo tabs running after ${((Date.now() - t0c) / 1000).toFixed(0)}s (no room)`);
  for (let i = 0; i < PLAYERS; i++) await (CHAIN ? startChainMasher : startMasher)(pages[i].p, i);
  const frames = () => Promise.all(pages.map(({ p }) => p.evaluate(() => window.__gcLockstep().guestFrames)));
  let prevF = await frames(), prevT = Date.now(); const f0 = prevF.slice(), tc = Date.now();
  while (Date.now() - tc < RUN_MS) {
    await sleep(15000);
    const nf = await frames(), dt = (Date.now() - prevT) / 1000; prevT = Date.now();
    const rates = nf.map((v, i) => (v - prevF[i]) / dt / 60); prevF = nf;
    const ovls = await Promise.all(pages.map(({ p }) => ovlOf(p)));
    report.windows.push({ t: Math.round((Date.now() - tc) / 1000), load: os.loadavg()[0], rates, ovls });
    console.log(`  [control t=${Math.round((Date.now() - tc) / 1000)}s] rate ${rates.map((r) => r.toFixed(3) + 'x').join(' ')}  ovl ${ovls.join('/')}  load ${os.loadavg()[0].toFixed(1)}`);
  }
  const runS = (Date.now() - tc) / 1000;
  report.meanRate = prevF.map((v, i) => (v - f0[i]) / runS / 60);
  console.log(`  [control] mean ${report.meanRate.map((r) => r.toFixed(4) + 'x').join(' ')} over ${runS.toFixed(0)}s, load ${load()}`);
  ok('control-measured', `solo x${PLAYERS}: mean ${report.meanRate.map((r) => r.toFixed(4) + 'x').join(' ')}`);
  await finish(0);
}

// ---- 1. the Party control follows lib/mpgames.js ---------------------------------------------
// (Not under a hand-off: inside a room — ?np= on the URL — the game is the room's, so
// MPGames.gateParty deliberately does not gate; the single-browser mode proves the gate.)
if (!SEPARATE) {
  const g = await host.evaluate(async () => {
    const sel = document.getElementById('romSelect'), btn = document.querySelector('.np-btn');
    if (!sel || !btn) return { err: 'no select or no .np-btn' };
    const out = {}, prev = sel.value;
    for (let i = 0; i < sel.options.length; i++) {
      sel.value = sel.options[i].value; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      out[sel.options[i].textContent] = { disabled: btn.disabled, title: btn.title };
    }
    for (let i = 0; i < sel.options.length; i++) if (sel.options[i].textContent === 'Mario Party 4') sel.value = sel.options[i].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return out;
  });
  report.partyGate = g;
  const mp4 = g['Mario Party 4'];
  const others = Object.entries(g).filter(([k]) => k !== 'Mario Party 4');
  (mp4 && !mp4.disabled && others.length && others.every(([, v]) => v.disabled && v.title))
    ? ok('party-offered-only-for-a-title-that-can-run-a-room',
         `Mario Party 4 enabled; refused with a reason: ${others.map(([k]) => k).join(' · ')} — e.g. "${others[0][1].title.slice(0, 110)}…"`)
    : bad('party-offered-only-for-a-title-that-can-run-a-room', JSON.stringify(g).slice(0, 400));
}

// ---- pair --------------------------------------------------------------------------------------
let code = HCODE;
if (!SEPARATE) {
  await host.evaluate(() => document.querySelector('.np-btn').click());
  await sleep(800);
  code = await host.evaluate(() => document.querySelector('.np-code').textContent.trim());
}
console.log('[host] room code ' + code + (SEPARATE ? ' (hand-off URLs, MQTT relay signalling, WebRTC)' : ' (panel, same-browser transport)'));
for (let i = 1; i < PLAYERS; i++) {
  if (!SEPARATE) await pages[i].p.evaluate((c) => {
    document.querySelector('.np-btn').click();
    document.querySelectorAll('.np-row button')[1].click();      // Join
    const inp = document.querySelector('.np-in'); inp.value = c;
    inp.dispatchEvent(new Event('change'));
  }, code);
  let approved = false;
  for (let k = 0; k < 160 && !approved; k++) {
    approved = await host.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) { b.click(); return true; } return false; });
    if (!approved) await sleep(250);
  }
  let seated = false;
  for (let k = 0; k < 160 && !seated; k++) {
    seated = await pages[i].p.evaluate(() => !!(NetplayUI.session && NetplayUI.session.state === 'connected'));
    if (!seated) await sleep(250);
  }
  console.log(`[${pages[i].who}] admitted=${approved} connected=${seated}`);
}
const seatedAll = await host.evaluate((n) => { try { return (NetplayUI.session.roomInfo().seats || []).filter((s) => s.peer != null).length; } catch (e) { return -1; } }, PLAYERS);
seatedAll === PLAYERS ? ok('room-seats-every-player', `${seatedAll}/${PLAYERS} seats taken in the host's roster, code ${code}`)
                      : bad('room-seats-every-player', `${seatedAll}/${PLAYERS}`);

// ---- boot: the room presses Start on every console; wait for the barrier --------------------
const snap = (p) => p.evaluate(() => (window.__gcLockstep ? window.__gcLockstep() : null)).catch((e) => ({ err: String(e).slice(0, 120) }));
const t0 = Date.now();
let ranEarly = null, released = false, last = [];
let armedAt = new Array(PLAYERS).fill(null);
while (Date.now() - t0 < BOOT_MS) {
  await sleep(1000);
  last = await Promise.all(pages.map(({ p }) => snap(p)));
  last.forEach((g, i) => {
    if (g && g.gated && armedAt[i] == null) { armedAt[i] = (Date.now() - t0) / 1000; console.log(`[${pages[i].who}] gate armed at t=${armedAt[i].toFixed(0)}s, disc tag ${g.disc}`); }
    if (g && g.gated && !g.running && g.guestFrames > 0 && !ranEarly) ranEarly = `${pages[i].who} ran ${g.guestFrames} frame(s) while the barrier held`;
  });
  if (last.every((g) => g && g.running)) { released = true; break; }
  if (((Date.now() - t0) / 1000 | 0) % 30 === 0)
    console.log(`  [boot t=${((Date.now() - t0) / 1000).toFixed(0)}s] ` + last.map((g, i) => `${pages[i].who}:${g ? (g.running ? 'running' : g.gated ? 'gated' : (g.card && g.card.state) || 'loading') : '-'}`).join(' ') + `  load ${load()}`);
}
report.armedAt = armedAt;
report.boot = last.map((g) => g && { disc: g.disc, card: g.card, buildTag: g.buildTag, delay: g.delay, ports: g.ports, roster: g.roster, rttMs: g.rttMs, pressed: g.party && g.party.pressed });
console.log('  [boot] start pressed by the room on: ' + last.map((g, i) => `${pages[i].who}=${g && g.party && g.party.pressed}`).join(' ') +
            `; delay ${last[0] && last[0].delay} frame(s) from RTT ${last[0] && last[0].rttMs} ms`);
if (MOBILE.length)
  MOBILE.every((i) => last[i] && last[i].party && last[i].party.pressed === 'mobile-splash')
    ? ok('a-phone-shaped-console-is-started-through-its-own-splash', MOBILE.map((i) => pages[i].who).join(','))
    : bad('a-phone-shaped-console-is-started-through-its-own-splash', JSON.stringify(MOBILE.map((i) => last[i] && last[i].party && last[i].party.pressed)));
const tags = last.map((g) => g && g.disc);
(last.every((g) => g && g.card && g.card.state === 'agreed') && new Set(last.map((g) => g.card.key)).size === 1)
  ? ok('every-console-booted-the-SAME-agreed-card', `key ${last[0].card.key} (${last[0].card.size ? 'the host\'s card, ' + last[0].card.size + ' B' : 'one blank card'}); persisted by host only: ${last.map((g) => g.card.persist).join('/')}`)
  : bad('every-console-booted-the-SAME-agreed-card', JSON.stringify(last.map((g) => g && g.card)));
(tags.every(Boolean) && new Set(tags).size === 1 && /#b:[0-9a-f]{8}/.test(tags[0]))
  ? ok('the-barrier-compared-one-disc-tag', tags[0])
  : bad('the-barrier-compared-one-disc-tag', JSON.stringify(tags));
ranEarly ? bad('nobody-runs-frame-0-before-the-room', ranEarly)
         : ok('nobody-runs-frame-0-before-the-room', 'PAD_ACK stayed 0 on every console while the barrier held');
released ? ok('the-barrier-releases-and-every-console-runs', `after ${((Date.now() - t0) / 1000).toFixed(0)}s; delay ${last[0].delay} frame(s); roster ${JSON.stringify(last[0].roster)}`)
         : bad('the-barrier-releases-and-every-console-runs', JSON.stringify(last.map((g) => g && { state: g.state, gated: g.gated, running: g.running, fault: g.fault, card: g.card, why: g.stallReason }).slice(0, 4)));
if (!released) {
  for (const { p, who } of pages) await p.screenshot({ path: path.join(SHOTS, `gc-room-${who}.png`) }).catch(() => {});
  await finish(1);
}
// ---- 9a. the mode the room actually runs -----------------------------------------------------
report.mode = last.map((g) => ({ mode: g.mode, delay: g.delay, window: g.rollback && g.rollback.window, capGate: g.rollback && g.rollback.capGate,
                                 workerOk: g.rollback && g.rollback.workerOk }));
if (RB) {
  last.every((g) => g.mode === 'rollback' && g.delay === 0)
    ? ok('every-console-runs-ROLLBACK-with-zero-added-input-delay', last.map((g, i) => `${pages[i].who}: ${g.mode}, delay ${g.delay}, window ${g.rollback.window}${g.rollback.capGate ? ' (capacity-gated)' : ''}`).join(' · '))
    : bad('every-console-runs-ROLLBACK-with-zero-added-input-delay', JSON.stringify(report.mode));
} else {
  last.every((g) => g.mode !== 'rollback' && g.delay > 0)
    ? ok('the-rb0-arm-runs-input-delay', last.map((g) => `${g.mode} ${g.delay}`).join(' · '))
    : bad('the-rb0-arm-runs-input-delay', JSON.stringify(report.mode));
}
const ports = last.map((g) => (g.ports || [])[0]);
(new Set(ports).size === PLAYERS && ports.every((x) => x >= 0))
  ? ok('every-console-holds-its-own-port', ports.map((pt, i) => `${pages[i].who}=${pt}`).join(' '))
  : bad('every-console-holds-its-own-port', JSON.stringify(ports));

// ---- the long run, with input on every console ------------------------------------------------
// Each tab presses its own buttons through its own local device 0 (window.__gcPad.edge), which in
// a room is staged into the agreed image for THAT console's port. A seeded masher of
// menu-advancing and inert buttons, so the game keeps moving and every frame has input.
for (let i = 0; i < PLAYERS; i++) await (CHAIN ? startChainMasher : startMasher)(pages[i].p, i);
const tRun = Date.now();
let prev = await Promise.all(pages.map(({ p }) => snap(p)));
let prevAt = Date.now();
let desyncs = [], minRate = Infinity, maxRate = 0, stallWins = 0, maxCompared = 0;
const WIN = 15000;
while (Date.now() - tRun < RUN_MS) {
  await sleep(WIN);
  const now = await Promise.all(pages.map(({ p }) => snap(p)));
  const dt = (Date.now() - prevAt) / 1000; prevAt = Date.now();
  const rates = now.map((g, i) => (g.guestFrames - prev[i].guestFrames) / dt / 60);
  // WHERE THE TIME WENT this window, per console: held for the ROOM's input vs held for this
  // console's own worker (gamecube.html gcLsStep WHERE THE TIME GOES), as shares of the window.
  const wIn = now.map((g, i) => (g.waitInputMs - prev[i].waitInputMs) / 1000 / dt);
  const wWk = now.map((g, i) => (g.waitWorkerMs - prev[i].waitWorkerMs) / 1000 / dt);
  const ovl = await ovlOf(host);
  const row = { t: Math.round((Date.now() - tRun) / 1000), load: os.loadavg()[0], rates: rates.map((r) => +r.toFixed(4)),
                frames: now.map((g) => g.guestFrames), compared: now.map((g) => g.hashesCompared),
                agreed: now.map((g) => g.lastAgreedFrame), stalls: now.map((g) => g.bfStall), delay: now[0].delay,
                desync: now.map((g) => g.desync), waitInput: wIn.map((v) => +v.toFixed(3)), waitWorker: wWk.map((v) => +v.toFixed(3)), ovl,
                mode: now.map((g) => g.mode), rb: now.map((g) => g.rollback && g.rollback.worker ? [g.rollback.page.rollbacks, g.rollback.page.resimFrames, g.rollback.worker.slots, g.rollback.selfStepMs] : null) };
  report.windows.push(row);
  // the GAME stopping (a recomp trap) is not the ROOM failing — say which it is
  if (rates.every((r) => r === 0) && now.every((g) => !g.desync)) {
    const why = await Promise.all(pages.map(({ p }) => p.evaluate(() => window.__gcTrap || null).catch(() => null)));
    console.log(`  [run] every console STOPPED at guest frame ${row.frames.join('/')} with no desync — the guest itself stopped (see the worker log), on every console at once`);
    report.stoppedAt = row.frames;
  }
  for (let i = 0; i < PLAYERS; i++) if (now[i].desync && !desyncs.find((d) => d.who === pages[i].who)) desyncs.push({ who: pages[i].who, d: now[i].desync });
  rates.forEach((r) => { minRate = Math.min(minRate, r); maxRate = Math.max(maxRate, r); });
  maxCompared = Math.max(maxCompared, ...now.map((g) => g.hashesCompared | 0));
  console.log(`  [run t=${row.t}s] rate ${rates.map((r) => r.toFixed(3) + 'x').join(' ')}  frames ${row.frames.join('/')}  ` +
              `compared ${row.compared.join('/')}  agreed≤f${row.agreed.join('/')}  delay ${row.delay}  ` +
              `held-for-room ${wIn.map((v) => (v * 100).toFixed(0) + '%').join('/')} held-for-own-worker ${wWk.map((v) => (v * 100).toFixed(0) + '%').join('/')}  ovl ${ovl}  load ${row.load.toFixed(1)}` +
              `  mode ${row.mode.join('/')}  rollbacks/resim/slots/stepMs ${row.rb.map((x) => x ? x.join('/') : '-').join(' ')}` +
              (desyncs.length ? '  DESYNC ' + JSON.stringify(desyncs) : ''));
  prev = now;
  if (desyncs.length) break;
}
const mashN = await Promise.all(pages.map(({ p }) => p.evaluate(() => { clearInterval(window.__mash.timer); return window.__mash.n; })));
const fin = await Promise.all(pages.map(({ p }) => snap(p)));
const runS = (Date.now() - tRun) / 1000;
report.final = fin.map((g) => ({ guestFrames: g.guestFrames, hashesSent: g.hashesSent, hashesCompared: g.hashesCompared,
                                 lastAgreedFrame: g.lastAgreedFrame, desync: g.desync, bfStall: g.bfStall, delay: g.delay, fpDiag: g.fpDiag,
                                 mode: g.mode, rollback: g.rollback, lat: g.lat }));
// ---- 9b. the rollback rings worked, and the room added no input lag ---------------------------
if (RB) {
  const rbs = fin.map((g) => g.rollback || {});
  const tot = rbs.reduce((a, r) => a + ((r.worker && r.worker.rollbacks) | 0), 0);
  const resim = rbs.reduce((a, r) => a + ((r.worker && r.worker.resimFrames) | 0), 0);
  console.log('  rollback rings: ' + rbs.map((r, i) => r.worker ? `${pages[i].who}: ${r.worker.rollbacks} rewinds / ${r.worker.resimFrames} re-simulated (max depth ${r.worker.maxDepth}), ` +
              `step ${r.selfStepMs} ms (presented guest ${r.worker.guestMsPresented} + pump ${r.worker.viMsPresented}, re-simulated guest ${r.worker.guestMsResim} + pump ${r.worker.viMsResim}), ` +
              `modes ${JSON.stringify(r.mode && r.mode.history ? r.mode.history.slice(-4) : r.mode)}, ${r.worker.slots} undo pages held (peak budget ${r.worker.budget}), window ${r.window}, hidden ${r.page.hidden}, stale hashes ${r.page.staleHashes}, mem stalls ${r.page.memStalls}` : `${pages[i].who}: -`).join(' · '));
  (fin.every((g) => g.mode === 'rollback') && tot > 0 && resim >= tot && rbs.every((r) => r.worker && !r.worker.fault && !r.worker.overflows))
    ? ok('the-rollback-rings-rewound-and-re-simulated-without-a-fault', `${tot} rewinds, ${resim} re-simulated frames across ${PLAYERS} consoles, no ring fault, no log overflow`)
    : bad('the-rollback-rings-rewound-and-re-simulated-without-a-fault', JSON.stringify(rbs.map((r) => r.worker)));
  const lat = [].concat(...fin.map((g) => (g.lat && g.lat.samples) || []));
  const rbLat = lat.filter((x) => x.mode === 'rollback');
  (rbLat.length >= 5 && rbLat.every((x) => x.frames === 0))
    ? ok('zero-added-input-lag-a-press-runs-on-the-frame-it-was-sampled-for', `${rbLat.length} presses across ${PLAYERS} consoles, every one 0 frames (the game's own lag frames come on top, as on hardware)`)
    : bad('zero-added-input-lag-a-press-runs-on-the-frame-it-was-sampled-for', JSON.stringify(lat.slice(0, 20)));
}
desyncs.length
  ? bad('ZERO-desyncs-over-the-long-run', JSON.stringify(desyncs))
  : ok('ZERO-desyncs-over-the-long-run', `${runS.toFixed(0)}s of play with ${mashN.join('/')} button presses; ` +
       `every console compared ${fin.map((g) => g.hashesCompared).join('/')} whole-state fingerprints (each one ${fin[0].fpDiag} pages = the whole guest) and agreed through frame ${fin.map((g) => g.lastAgreedFrame).join('/')}`);
// One sweep per 60 GUEST frames (recomp_worker.js FP_EVERY) — counted against guest frames, not
// wall seconds, so a room the box runs below 1.000x is not mistaken for a detector that skips.
(fin.every((g) => g.hashesCompared >= Math.floor(g.guestFrames / 60) - 3))
  ? ok('every-60-guest-frames-a-fingerprint-is-COMPARED', `${fin.map((g) => g.hashesCompared).join('/')} comparisons for ${fin.map((g) => g.guestFrames).join('/')} guest frames`)
  : bad('every-60-guest-frames-a-fingerprint-is-COMPARED', `${fin.map((g) => g.hashesCompared).join('/')} for ${fin.map((g) => g.guestFrames).join('/')} guest frames`);
const meanRate = fin.map((g, i) => {
  const f0 = report.windows.length ? (report.windows[0].frames[i] - report.windows[0].rates[i] * 60 * (WIN / 1000)) : 0;
  return (g.guestFrames - f0) / runS / 60;
});
report.meanRate = meanRate; report.minRate = minRate; report.maxRate = maxRate;
(maxRate <= 1.02)
  ? ok('the-room-never-runs-the-guest-faster-than-hardware', `max window ${maxRate.toFixed(4)}x`)
  : bad('the-room-never-runs-the-guest-faster-than-hardware', `max window ${maxRate.toFixed(4)}x`);
{
  const tot = (k) => fin.map((g) => g[k] / Math.max(1, g.runMs));
  report.waitShare = { input: tot('waitInputMs'), worker: tot('waitWorkerMs') };
  console.log(`  where the room's time went (whole run, per console): held for the ROOM's input ${report.waitShare.input.map((v) => (v * 100).toFixed(1) + '%').join('/')}, ` +
              `held for the console's OWN worker ${report.waitShare.worker.map((v) => (v * 100).toFixed(1) + '%').join('/')}`);
}
console.log(`  room rate: mean ${meanRate.map((r) => r.toFixed(4) + 'x').join(' ')}, windows min ${minRate.toFixed(4)}x max ${maxRate.toFixed(4)}x over ${report.windows.length} windows of ${WIN / 1000}s (load ${load()})`);
(meanRate.every((r) => r >= 0.97))
  ? ok('the-room-holds-1.000x', `mean ${meanRate.map((r) => r.toFixed(4) + 'x').join(' ')} over ${runS.toFixed(0)}s`)
  : bad('the-room-holds-1.000x', `mean ${meanRate.map((r) => r.toFixed(4) + 'x').join(' ')} — min window ${minRate.toFixed(4)}x at load ${load()}`);

// ---- every console's button reaches the host's game on ITS port and no other -----------------
const PRESS = [0x400, 0x800, 0x40, 0x20];                  // X, Y, L, R — distinct per console
const witness = [];
for (let i = 0; i < PLAYERS; i++) {
  const bit = PRESS[i], port = ports[i];
  await pages[i].p.evaluate((b) => { window.__hold = setInterval(() => window.__gcPad.edge(0, b, 0), 8); }, bit);
  let w = null, hit = false;
  for (let k = 0; k < 80 && !hit; k++) {
    await sleep(100);
    w = await host.evaluate(() => window.__gcPad.witness());
    hit = !!w && (w.btnDown[port] & bit) === bit;
  }
  await pages[i].p.evaluate(() => clearInterval(window.__hold));
  const leaked = w ? ports.filter((q) => q !== port && (w.btnDown[q] & bit) === bit) : [];
  witness.push({ who: pages[i].who, port, bit, hit, leaked, btnDown: w && w.btnDown.map(hex) });
  await sleep(300);
}
report.witness = witness;
witness.every((x) => x.hit && !x.leaked.length)
  ? ok('every-consoles-button-reaches-the-hosts-game-on-its-own-port',
       witness.map((x) => `${x.who}:${hex(x.bit)}→port ${x.port}`).join(' · ') + ' (read from MP4\'s own HuPadBtnDown on the HOST)')
  : bad('every-consoles-button-reaches-the-hosts-game-on-its-own-port', JSON.stringify(witness));

// ---- the party panel says what is true --------------------------------------------------------
const party = await Promise.all(pages.map(({ p }) => p.evaluate(() => ({
  party: window.__gcNetParty ? window.__gcNetParty() : null,
  label: (document.querySelector('.np-btn') || {}).textContent,
  msg: (document.querySelector('.np-msg') || {}).textContent,
  net: window.__gcNet ? window.__gcNet() : null,
}))));
report.party = party;
(party.every((x) => x.party && x.party.rows.filter((r) => r.state !== 'open').length === PLAYERS &&
                    x.party.rows.filter((r) => r.state !== 'open').every((r) => r.state === 'playing') && /^Playing/.test(x.msg || '')))
  ? ok('the-party-panel-says-playing-on-every-console', `"${party[0].label}" · "${party[0].msg}"`)
  : bad('the-party-panel-says-playing-on-every-console', JSON.stringify(party.map((x) => ({ label: x.label, msg: x.msg, rows: x.party && x.party.rows }))).slice(0, 600));
(party.every((x) => x.net && x.net.lockstep === true && x.net.architecture === 'lockstep'))
  ? ok('__gcNet-reports-the-room-truthfully', JSON.stringify({ supported: party[0].net.supported, lockstep: party[0].net.lockstep, engine: party[0].net.engine }))
  : bad('__gcNet-reports-the-room-truthfully', JSON.stringify(party[0].net).slice(0, 300));
for (let i = 0; i < PLAYERS; i++) {
  await pages[i].p.evaluate(() => { const w = document.querySelector('.np-wrap'); if (w && !w.classList.contains('open')) document.querySelector('.np-btn').click(); });
  await sleep(300);
  await pages[i].p.screenshot({ path: path.join(SHOTS, `gc-room-${pages[i].who}.png`) }).catch(() => {});
}
console.log('  screenshots -> ' + pages.map(({ who }) => path.join(SHOTS, `gc-room-${who}.png`)).join(' '));

if (HOST_CARD && SEPARATE) {
  const after = [];
  for (let i = 0; i < PLAYERS; i++) { const b64 = await idbCard(pages[i].p, null); after.push(b64 ? md5(Buffer.from(b64, 'base64')) : null); }
  report.cardsAfter = after;
  (after.slice(1).every((m, k) => m === seeded[k + 1]))
    ? ok('a-guests-own-saved-card-is-never-overwritten-by-the-room', after.slice(1).map((m, k) => `${pages[k + 1].who} still ${m.slice(0, 8)}`).join(' · ') +
         ` (the room played on the host's ${seeded[0].slice(0, 8)})`)
    : bad('a-guests-own-saved-card-is-never-overwritten-by-the-room', JSON.stringify({ seeded, after }));
  (report.boot.every((b) => b && b.card && b.card.size === 2097152))
    ? ok('every-console-booted-the-HOSTS-card-not-its-own', `room card ${report.boot[0].card.key} on all ${PLAYERS}; guests held ${seeded.slice(1).map((m) => m.slice(0, 8)).join(',')}`)
    : bad('every-console-booted-the-HOSTS-card-not-its-own', JSON.stringify(report.boot.map((b) => b && b.card)));
}

// ---- LAST: the detector fires (this halts the room on purpose) --------------------------------
if (FORCE_DESYNC) {
  await pages[PLAYERS - 1].p.evaluate(() => window.__gcForceDesync(0x1234abcd));
  let named = null;
  for (let k = 0; k < 60 && !named; k++) {
    await sleep(500);
    const s = await Promise.all(pages.map(({ p }) => snap(p)));
    if (s.every((g) => g.desync)) named = s.map((g) => g.desync);
  }
  named ? ok('a-real-divergence-is-detected-by-EVERY-console', JSON.stringify(named[0]))
        : bad('a-real-divergence-is-detected-by-EVERY-console', 'perturbed one console\'s fingerprint; not every console reported it');
}
report.md5After = await servedMd5();
JSON.stringify(report.md5After) === JSON.stringify(report.md5)
  ? ok('served-files-unchanged-through-the-run', 'md5 before == after')
  : bad('served-files-unchanged-through-the-run', JSON.stringify(report.md5After));
await finish(fail ? 1 : 0);

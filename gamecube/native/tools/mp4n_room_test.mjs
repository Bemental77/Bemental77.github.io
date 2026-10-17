#!/usr/bin/env node
// gamecube/native/tools/mp4n_room_test.mjs — DOES A MARIO PARTY 4 (NATIVE) ROOM STAY IN SYNC?
//
// N real mp4-native.html windows in one browser (?net=local: BroadcastChannel), handed one room
// code the way multiplayer.html hands it (?np=CODE&game=…, guests &join=1). The host's built-in
// approval prompt is answered for each guest. Every window then presses keys at its own times
// (real keyboard events, so each console's input is a genuine local pad that reaches the others
// late and makes the room roll back).
//
// Asserted:
//   in-sync      the engine compared fingerprints and found no desync, AND an independent
//                cross-check: every fingerprint each console submitted equals every other
//                console's for the same frame
//   rollback     the room ran rollback (0 frames of input delay) and actually rewound
//   no-sprint    room frames per 5 s window, every console: <= 1.0167x of 60 Hz
//   control      --break epoch boots the last guest on its own clock: the room must report a desync
//
// usage (from the repo root; the rig starts its own tools/devserver.mjs):
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node gamecube/native/tools/mp4n_room_test.mjs [--players 2|3|4]
//        [--frames N] [--break epoch] [--timeout S] [--shots DIR]
import { createRequire } from 'module';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawn, execSync } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
let guard = null; try { guard = (await import(path.join(REPO, 'tools/browser_leak_guard.js'))).default; } catch (_e) {}

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const N = Math.max(2, Math.min(4, parseInt(flag('players', '2'), 10) || 2));
const FRAMES = parseInt(flag('frames', '900'), 10);
const BREAK = flag('break', '');
const TIMEOUT = parseInt(flag('timeout', '1500'), 10) * 1000;
const SHOTS = flag('shots', '');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail == null ? '' : detail}`); };
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

const srv = spawn('node', [path.join(REPO, 'tools/devserver.mjs')], { cwd: REPO, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
await sleep(1500);
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4room-'));
console.log(`=== mp4-native ${N}-player room ${CODE}${BREAK ? ' (control: --break ' + BREAK + ')' : ''} ===`);
try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (_e) {}
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', userDataDir: udd,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu',
         '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--disable-features=CalculateNativeWinOcclusion', '--window-size=900,800'],
});
try { if (guard) guard.guard(browser, 'mp4n_room_test'); } catch (_e) {}

async function openWindowPage() {
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  await cdp.detach();
  for (let i = 0; i < 100; i++) {
    for (const t of browser.targets()) { const id = t._targetId || (t._targetInfo && t._targetInfo.targetId); if (id === targetId) { const p = await t.page(); if (p) return p; } }
    await sleep(100);
  }
  throw new Error('no window');
}
const P = [];
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
try {
  for (let i = 0; i < N; i++) {
    const page = await openWindowPage();
    await page.setViewport({ width: 880, height: 760 });
    const tag = i ? 'G' + i : 'H';
    const errs = [], logs = [];
    page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
    page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
    page.on('console', (msg) => { const t = msg.text(); if (/^\[mp4n\] room|desync|DESYNC/.test(t)) { logs.push(T() + ' ' + t); console.log(`  [${tag} ${T()}] ${t.slice(0, 220)}`); } if (msg.type() === 'error' && !/favicon|Failed to load resource/i.test(t)) errs.push(t.slice(0, 300)); });
    let q = `np=${CODE}&game=${encodeURIComponent('Mario Party 4')}&net=local&players=${N}`;
    if (i) q += '&join=1';
    if (BREAK && i === N - 1) q += '&npbreak=' + BREAK;
    await page.goto(`http://127.0.0.1:${PORT}/mp4-native.html?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    P.push({ page, tag, errs, logs });
    if (i) {
      const allowed = await P[0].page.waitForFunction(() => !!document.getElementById('npApproveAllow'), { timeout: 60000, polling: 250 })
        .then(() => P[0].page.evaluate(() => { document.getElementById('npApproveAllow').click(); return true; })).catch(() => false);
      const seated = await page.waitForFunction(() => { const r = window.Mp4Room && Mp4Room.report(); return r && r.engine && r.engine.localPorts && r.engine.localPorts.length > 0; },
        { timeout: 60000, polling: 250 }).then(() => true).catch(() => false);
      ok(`player-${i + 1}-admitted-and-seated`, allowed && seated, `allowed=${allowed} seated=${seated}`);
    }
  }
  const rep = () => Promise.all(P.map((p) => p.page.evaluate(() => ({ r: window.Mp4Room ? Mp4Room.report() : null, phase: window.__mp4n && window.__mp4n.phase, errors: window.__mp4n && window.__mp4n.errors })).catch((e) => ({ err: String(e) }))));
  // every console boots by itself and the room starts
  const started = await Promise.all(P.map((p) => p.page.waitForFunction(() => { const r = window.Mp4Room && Mp4Room.report(); return r && (r.running || (r.engine && r.engine.desync)); }, { timeout: 600000, polling: 1000 }).then(() => true).catch(() => false)));
  const r0 = await rep();
  ok('every-console-started-by-itself-and-the-room-runs', started.every(Boolean), `running ${started.join('/')} seats ${JSON.stringify(r0.map((x) => x.r && x.r.engine && x.r.engine.localPorts))} at ${T()}`);

  // input: each window presses keys at its own pace (Start / A / stick), so predictions miss
  const KEYS = ['Enter', 'Space', 'ArrowDown', 'ArrowRight', 'Space', 'ArrowUp', 'KeyX', 'Enter'];
  let stop = false; let presses = 0;
  const pressers = P.map((p, i) => (async () => {
    let k = i;
    while (!stop) {
      await sleep(2500 + 1700 * i + Math.floor(Math.random() * 1500));
      if (stop) break;
      try { const code = KEYS[k++ % KEYS.length]; await p.page.keyboard.down(code); await sleep(250 + 90 * i); await p.page.keyboard.up(code); presses++; } catch (_e) {}
    }
  })());
  // run until every console has FRAMES live frames, a desync, or the timeout
  let last = null; let shot = 0;
  for (;;) {
    await sleep(10000);
    last = await rep();
    const fr = last.map((x) => x.r ? x.r.next : -1);
    const des = last.some((x) => x.r && (x.r.stopReason === 'desync' || (x.r.engine && x.r.engine.desync)));
    console.log(`  [${T()}] frames ${fr.join('/')} rewinds ${last.map((x) => x.r && x.r.stats.rollbacks).join('/')} compared ${last.map((x) => x.r && x.r.engine && x.r.engine.hashesCompared).join('/')} states ${last.map((x) => x.r && x.r.engine && x.r.engine.state).join('/')}`);
    if (SHOTS && shot++ % 6 === 0) { fs.mkdirSync(SHOTS, { recursive: true }); for (const p of P) await p.page.screenshot({ path: path.join(SHOTS, `${p.tag}_${T()}.png`) }).catch(() => {}); }
    if (des || last.some((x) => x.r && x.r.failed) || fr.every((f) => f >= FRAMES) || Date.now() - t0 > TIMEOUT) break;
  }
  stop = true; await Promise.all(pressers);
  if (SHOTS) for (const p of P) await p.page.screenshot({ path: path.join(SHOTS, `${p.tag}_end.png`) }).catch(() => {});
  const sent = await Promise.all(P.map((p) => p.page.evaluate(() => Mp4Room.sent()).catch(() => ({}))));
  const win = await Promise.all(P.map((p) => p.page.evaluate(() => Mp4Room.windows(5000)).catch(() => [])));
  const fr = last.map((x) => x.r ? x.r.next : -1);
  // independent cross-check of the fingerprints
  const frames = new Set(); sent.forEach((s) => Object.keys(s).forEach((k) => frames.add(+k)));
  let common = 0, differ = [];
  for (const f of [...frames].sort((a, b) => a - b)) {
    const hs = sent.map((s) => s[f]).filter((h) => h != null);
    if (hs.length < N) continue;
    common++;
    if (new Set(hs).size > 1) differ.push(f);
  }
  const desynced = last.some((x) => x.r && (x.r.stopReason === 'desync' || (x.r.engine && x.r.engine.desync)));
  const compared = last.map((x) => (x.r && x.r.engine && x.r.engine.hashesCompared) || 0);
  console.log(`  frames ${fr.join('/')} presses ${presses} at ${T()}`);
  console.log('  stats ' + JSON.stringify(last.map((x) => x.r && x.r.stats)));
  if (BREAK) {
    ok('control-the-broken-console-is-caught', desynced || differ.length > 0,
       `engine desync=${desynced}, fingerprints differing at ${differ.length} of ${common} common frames (first ${differ.slice(0, 3).join(',')})`);
  } else {
    ok('every-console-ran-the-frames', fr.every((f) => f >= FRAMES), `room frames ${fr.join('/')} (want ${FRAMES})`);
    ok('room-runs-rollback-at-zero-delay', last.every((x) => x.r && x.r.engine && x.r.engine.rollback > 0), `window ${last.map((x) => x.r && x.r.engine && x.r.engine.rollback).join('/')}`);
    ok('the-room-actually-rewound', last.some((x) => x.r && x.r.stats.rollbacks > 0), `rewinds ${last.map((x) => x.r && x.r.stats.rollbacks).join('/')} re-run ${last.map((x) => x.r && x.r.stats.resim).join('/')} max depth ${last.map((x) => x.r && x.r.stats.maxDepth).join('/')} max restore ms ${last.map((x) => x.r && x.r.stats.maxRestoreMs.toFixed(2)).join('/')}`);
    ok('in-sync-engine', !desynced && compared.every((c) => c > 0) && last.every((x) => x.r && !x.r.failed), `compared ${compared.join('/')} states ${last.map((x) => x.r && x.r.engine && x.r.engine.state).join('/')} failed ${last.map((x) => x.r && x.r.failed).join('/')}`);
    ok('in-sync-cross-check', common >= 3 && differ.length === 0, `${common} frames fingerprinted by all ${N} consoles, ${differ.length} differ`);
    const maxW = win.map((w) => w.length ? Math.max(...w) : 0);
    ok('no-sprint-<=1.0167x-per-5s-window', maxW.every((x) => x <= 1.0167) && win.every((w) => w.length > 0), `max window ${maxW.map((x) => x.toFixed(4) + 'x').join(' / ')}, mean ${win.map((w) => (w.reduce((a, b) => a + b, 0) / Math.max(1, w.length)).toFixed(3) + 'x').join(' / ')} over ${win.map((w) => w.length).join('/')} windows`);
  }
  const errs = P.flatMap((p) => p.errs);
  ok('no-page-errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  fail++; console.log('  FAIL  harness  ' + ((e && e.stack) || e));
} finally {
  try { await browser.close(); } catch (_e) {}
  srv.kill(); fs.rmSync(udd, { recursive: true, force: true });
}
try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (_e) {}
console.log(`\n[mp4n-room${N}${BREAK ? '-break-' + BREAK : ''}] ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);

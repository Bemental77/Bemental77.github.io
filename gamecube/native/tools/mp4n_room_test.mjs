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
//        [--frames N] [--break epoch] [--solo-host] [--timeout S] [--shots DIR] [--npmode auto|rollback|delay] [--script route.json]
//   --mixed: odd seats emulate a phone (390x844, DPR 3, touch, CPU x2 slower) — host-side differences must not reach game state
//   --script gamecube/native/tools/route_party_minigames.json --frames 40000 --npmode rollback: Party Mode on
//        Toad's Midway Madness through three minigames (overlays differ by the room's epoch)
//   --solo-host: the host page starts a solo game, then opens the Party panel; it must reopen itself in the room
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
const SOLO_HOST = argv.includes('--solo-host');   // the host starts a solo game first, then opens a party from it
const MIXED = argv.includes('--mixed');   // odd seats are a 'phone': 390x844 at DPR 3, touch, CPU slowed 2x
const TIMEOUT = parseInt(flag('timeout', '1500'), 10) * 1000;
const SHOTS = flag('shots', '');
// Each console picks rollback or delay from a 100 ms CPU probe at page load. Seats sharing ONE machine
// contend for it while siblings boot (measured: 4 seats on this 4-vCPU VM, one probed 41,480 < 45,000
// and the whole room correctly fell back to delay lockstep). --npmode rollback|delay pins every seat;
// the default (auto) leaves the decision to the page, as on real separate devices.
const NPMODE = flag('npmode', 'auto');
// --script FILE: the host's pad also follows a frame-keyed route ([[f0,f1,buttons(,overlay)],..], the format of
// mp4n_probe.mjs SCRIPT; an entry with a 4th element applies only while that overlay is the current one), so the room plays through boards/minigames; the host presses no random keys
// then (the guests still do, so the room still rolls back). Every console must see the same overlays.
const SCRIPT = flag('script', '') ? JSON.parse(fs.readFileSync(flag('script', ''), 'utf8')) : null;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = 18000 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail == null ? '' : detail}`); };
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let CODE = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

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
    // SENDTIME=1 (diagnostic): time every RTCDataChannel / WebSocket send on the page
    if (process.env.SENDTIME === '1') await page.evaluateOnNewDocument(() => {
      const T = window.__sendT = { dc: 0, dcN: 0, ws: 0, wsN: 0, dcMax: 0 };
      const wrap = (proto, k, kn) => { const f = proto.send; proto.send = function () { const t0 = performance.now(); try { return f.apply(this, arguments); } finally { const d = performance.now() - t0; T[k] += d; T[kn]++; if (k === 'dc' && d > T.dcMax) T.dcMax = d; } }; };
      if (window.RTCDataChannel) wrap(RTCDataChannel.prototype, 'dc', 'dcN');
      if (window.WebSocket) wrap(WebSocket.prototype, 'ws', 'wsN');
    });
    if (MIXED && i % 2) {
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const cdp = await page.target().createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
    } else await page.setViewport({ width: 880, height: 760 });
    const tag = i ? 'G' + i : 'H';
    const errs = [], logs = [], ovl = [];
    page.on('pageerror', (e) => { errs.push(String((e && e.message) || e)); if (e && e.stack) console.log(`  [${tag} ${T()}] PAGEERROR ${String(e.stack).split('\n').slice(0, 8).join(' | ').slice(0, 900)}`); });
    page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errs.push('HTTP ' + r.status() + ' ' + r.url()); });
    page.on('console', (msg) => { const t = msg.text(); const om = /DLLStart (\d+)/.exec(t); if (om) { ovl.push(+om[1]); page.evaluate((o) => { window.__routeOvl = o; }, +om[1]).catch(() => {}); console.log(`  [${tag} ${T()}] overlay ${om[1]}`); } if (/^\[mp4n\] room|desync|DESYNC/.test(t)) { logs.push(T() + ' ' + t); console.log(`  [${tag} ${T()}] ${t.slice(0, 220)}`); } if (msg.type() === 'error' && !/favicon|Failed to load resource/i.test(t)) errs.push(t.slice(0, 300)); });
    let q = `np=${CODE}&game=${encodeURIComponent('Mario Party 4')}&net=local&players=${N}`;
    if (i) q += '&join=1';
    if (NPMODE !== 'auto') q += '&npmode=' + NPMODE;
    if (BREAK && i === N - 1) q += '&npbreak=' + BREAK;
    if (SOLO_HOST && i === 0) {
      // solo first: the game runs, THEN its player opens the Party panel (which hosts by itself);
      // the page must re-open itself inside that room with the panel's code
      await page.goto(`http://127.0.0.1:${PORT}/mp4-native.html?autostart=1&net=local&players=${N}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const soloRan = await page.waitForFunction(() => { const m = window.__mp4n && window.__mp4n.module; return m && m._mp4web_total() > 120; }, { timeout: 300000, polling: 500 }).then(() => true).catch(() => false);
      const nav = page.waitForNavigation({ timeout: 60000 }).catch(() => null);
      await page.evaluate(() => document.querySelector('.np-btn').click());
      await nav;
      await page.waitForFunction(() => /[?&]np=/.test(location.search), { timeout: 60000, polling: 250 }).catch(() => {});
      CODE = await page.evaluate(() => new URLSearchParams(location.search).get('np'));
      ok('solo-game-reopens-inside-the-room', soloRan && /^[A-Z2-9]{5}$/.test(CODE || ''), `ran solo ${soloRan}, reopened as ${await page.evaluate(() => location.search)}`);
    } else
    await page.goto(`http://127.0.0.1:${PORT}/mp4-native.html?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    P.push({ page, tag, errs, logs, ovl });
    // the page loads mp4n_input.js only once the game starts (after the party is in): install the route
    // as soon as it exists — room frame 0 waits for every player, so this lands before any frame runs
    if (SCRIPT && i === 0) P[0].scriptSet = page.waitForFunction(() => window.Mp4Input && Mp4Input.script, { timeout: 600000, polling: 50 })
      .then(() => page.evaluate((sc) => { Mp4Input.script((f) => { let b = 0; for (const [a, z, k, ov] of sc) if (f >= a && f < z && (ov == null || window.__routeOvl === ov)) b |= k; return b; }); return window.__mp4n && window.__mp4n.module ? window.__mp4n.module._mp4web_total() : -1; }, SCRIPT))
      .then((f) => { console.log(`  [H] route installed at game frame ${f}`); return f; });
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
  // With --script a guest's pad is a second HUMAN player in the game, so the guests must press through the
  // menus (measured: with no guest presses the route waited in party setup for good). Once the route is on
  // the board (past its fourth overlay) they press only A and the stick: still input the room must roll
  // back for, but no Start/B (measured: with Start/B a 40,000-frame route room quit the board to the title).
  const KEYS = ['Enter', 'Space', 'ArrowDown', 'ArrowRight', 'Space', 'ArrowUp', 'KeyX', 'Enter'];
  const BOARD_KEYS = ['Space', 'ArrowDown', 'Space', 'ArrowRight', 'Space', 'ArrowLeft'];
  let stop = false; let presses = 0;
  const pressers = P.map((p, i) => (async () => {
    let k = i;
    if (SCRIPT && i === 0) return;   // the host's pad is the route
    while (!stop) {
      await sleep(2500 + 1700 * i + Math.floor(Math.random() * 1500));
      if (stop) break;
      try { const ks = SCRIPT && P[0].ovl.length >= 4 ? BOARD_KEYS : KEYS; const code = ks[k++ % ks.length]; await p.page.keyboard.down(code); await sleep(250 + 90 * i); await p.page.keyboard.up(code); presses++; } catch (_e) {}
    }
  })());
  // run until every console has FRAMES live frames, a desync, or the timeout
  let last = null; let shot = 0; let lastKey = '', sameFor = 0, stalled = false;
  for (;;) {
    await sleep(10000);
    last = await rep();
    const fr = last.map((x) => x.r ? x.r.next : -1);
    const des = last.some((x) => x.r && (x.r.stopReason === 'desync' || (x.r.engine && x.r.engine.desync)));
    console.log(`  [${T()}] frames ${fr.join('/')} rewinds ${last.map((x) => x.r && x.r.stats.rollbacks).join('/')} compared ${last.map((x) => x.r && x.r.engine && x.r.engine.hashesCompared).join('/')} states ${last.map((x) => x.r && x.r.engine && x.r.engine.state).join('/')}`);
    if (SHOTS && shot++ % 6 === 0) { fs.mkdirSync(SHOTS, { recursive: true }); for (const p of P) await p.page.screenshot({ path: path.join(SHOTS, `${p.tag}_${T()}.png`) }).catch(() => {}); }
    // A ROOM THAT STOPS MOVING is reported, not waited out: 60 s with no console advancing ends the run
    // with what each console says it is waiting for, its phase and its errors.
    const key = fr.join('/');
    if (key === lastKey) { if (++sameFor >= 6) {
      const why = await Promise.all(P.map((p) => p.page.evaluate(() => { const r = window.Mp4Room && Mp4Room.report(); return { phase: window.__mp4n && window.__mp4n.phase, errors: window.__mp4n && window.__mp4n.errors, waiting: r && r.waiting, holdWhy: r && r.stats && r.stats.holdWhy, state: r && r.engine && r.engine.state, total: window.__mp4n && window.__mp4n.module && window.__mp4n.module._mp4web_total() }; }).catch((e) => ({ err: String(e) }))));
      console.log('  STALLED ' + JSON.stringify(why).slice(0, 2000)); stalled = true; break; } }
    else { sameFor = 0; lastKey = key; }
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
  if (process.env.SENDTIME === '1') console.log('  sendtime ' + JSON.stringify(await Promise.all(P.map((p) => p.page.evaluate(() => window.__sendT).catch(() => null)))));
  if (BREAK) {
    ok('control-the-broken-console-is-caught', desynced || differ.length > 0,
       `engine desync=${desynced}, fingerprints differing at ${differ.length} of ${common} common frames (first ${differ.slice(0, 3).join(',')})`);
  } else {
    ok('every-console-ran-the-frames', fr.every((f) => f >= FRAMES), `room frames ${fr.join('/')} (want ${FRAMES})`);
    // auto mode: a console whose CPU probe says it cannot afford rollback takes the whole room to delay
    // lockstep (mp4n_room.js decideMode) — that is the policy working, so the test then asserts the delay
    // room it chose instead of a rollback room. --npmode rollback pins rollback and asserts it.
    const probeDelay = P.some((p) => p.logs.some((l) => /cannot afford rollback/.test(l)));
    if (NPMODE === 'auto' && probeDelay) {
      ok('room-runs-delay-lockstep-as-a-cpu-probe-chose', last.every((x) => x.r && x.r.engine && !(x.r.engine.rollback > 0) && x.r.engine.delay > 0),
        `delay ${last.map((x) => x.r && x.r.engine && x.r.engine.delay).join('/')} (${P.map((p) => p.tag + ' ' + ((p.logs.find((l) => /CPU probe/.test(l)) || '').match(/CPU probe \d+/) || ['?'])[0]).join(', ')})`);
    } else {
      ok('room-runs-rollback-at-zero-delay', last.every((x) => x.r && x.r.engine && x.r.engine.rollback > 0), `window ${last.map((x) => x.r && x.r.engine && x.r.engine.rollback).join('/')}`);
      ok('the-room-actually-rewound', last.some((x) => x.r && x.r.stats.rollbacks > 0), `rewinds ${last.map((x) => x.r && x.r.stats.rollbacks).join('/')} re-run ${last.map((x) => x.r && x.r.stats.resim).join('/')} max depth ${last.map((x) => x.r && x.r.stats.maxDepth).join('/')} max restore ms ${last.map((x) => x.r && x.r.stats.maxRestoreMs.toFixed(2)).join('/')}`);
    }
    ok('in-sync-engine', !desynced && compared.every((c) => c > 0) && last.every((x) => x.r && !x.r.failed), `compared ${compared.join('/')} states ${last.map((x) => x.r && x.r.engine && x.r.engine.state).join('/')} failed ${last.map((x) => x.r && x.r.failed).join('/')}`);
    ok('in-sync-cross-check', common >= 3 && differ.length === 0, `${common} frames fingerprinted by all ${N} consoles, ${differ.length} differ`);
    if (SCRIPT) {
      // the route: every console loaded the same overlays in the same order (a prefix: one may be a load behind)
      // a rollback across an overlay's first frame runs its DLLStart again on that console: collapse repeats
      const seqs = P.map((p) => p.ovl.filter((o, k, a) => k === 0 || a[k - 1] !== o)), n = Math.min(...seqs.map((q) => q.length));
      const same = seqs.every((q) => q.slice(0, n).join() === seqs[0].slice(0, n).join());
      ok('route-same-overlays-on-every-console', same && n >= 4, seqs.map((q, k) => P[k].tag + ':' + q.join(' ')).join('  '));
    }
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

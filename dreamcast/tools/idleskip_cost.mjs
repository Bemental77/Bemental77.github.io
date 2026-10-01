#!/usr/bin/env node
// ============================================================================
// idleskip_cost.mjs — WHAT DOES A DREAMCAST SETTING COST, IN HEADROOM, SOLO?
// ============================================================================
//
// Built to price `?noidleskip=1` (rec_wasm.cpp g_idleskip — PSO's frame-wait
// spin burn) before anything turns it off in a room, but it prices ANY query
// arm against the shipping page: same snapshot, same seed, same scene, fresh
// browser per cell, arms INTERLEAVED (A B A B ...) so drift in machine load
// lands on both arms alike (CLAUDE.md gate #10: matched pairs, never one run).
//
// THE INSTRUMENT IS THE WORKER'S OWN PUMP PARTITION, read on the PAGE side by
// listening to the messages the shipped worker already posts — no CDP into the
// emulator worker (evaluating into it every 100 ms measured 0.69x -> 0.16x):
//   'ips'  {busyMs, wallMs}  per ~1 s: time inside _emscripten_run_iter vs wall
//   'fps'  {kcyc}            per ~1 s: guest SH4 kilo-cycles (x1024)
// Over the measured window:
//   guestX    = cycles / 200e6 / wall_s        (1.000 = hardware; governed)
//   duty      = busy / wall
//   capacityX = guestX / duty                  guest seconds per BUSY second —
//               the most this machine could run the scene at, i.e. headroom.
// The cost of an arm is its capacity ratio against the baseline arm. The guest
// is GOVERNED (shipping config): nothing here runs the game above 1.000x.
//
// USAGE (a perf number: take the probe lock, report load)
//   WEB_ROOT=<snapshot> PORT=18803 node tools/devserver.mjs &
//   bash tools/probe_lock.sh run -- node dreamcast/tools/idleskip_cost.mjs \
//        --url http://localhost:18803 --arms ",noidleskip=1" --reps 3
//   (an arm may also be a whole origin, e.g. --arms ",http://localhost:18801"
//    prices the page in another snapshot against --url's)
// The snapshot's dreamcast/states/pso2_boot.state is the SCENE: the page's
// solo seed path applies it on the first frames (a PSO 3D scene for the
// numbers in dreamcast/docs/room-determinism/TASKS.md).
// FLAGS  --settle S (default 20)  --window S (default 40)  --game pso2
// OUTPUT /tmp/dc-cost/<name>.json + .log
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const requireFrom = (() => {
  for (const base of [process.cwd() + '/', path.join(os.homedir(), 'probe-deps') + '/', import.meta.url]) {
    try { const r = createRequire(base); r.resolve('puppeteer'); return r; } catch (e) {}
  }
  return createRequire(import.meta.url);
})();
const puppeteer = requireFrom('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = String(flag('url', '')).replace(/\/$/, '');
if (!BASE) { console.error('--url required'); process.exit(2); }
const ARMS = String(flag('arms', ',noidleskip=1')).split(',');   // '' = the baseline arm
const REPS = +flag('reps', '3');
const SETTLE = +flag('settle', '20');
const WINDOW = +flag('window', '40');
const GAME = flag('game', 'pso2');
const NAME = flag('name', 'cost-' + Date.now());
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const OUT = '/tmp/dc-cost';
fs.mkdirSync(OUT, { recursive: true });
const logS = fs.createWriteStream(path.join(OUT, NAME + '.log'));
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s] ${s}`; console.log(l); logS.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uptime = () => { try { return execSync('uptime').toString().trim(); } catch (e) { return '?'; } };

const TAP = `(() => {
  const RW = window.Worker; const C = window.__cost = { ips: [], fps: [], stateOk: null };
  window.Worker = function (url, opts) {
    const w = new RW(url, opts);
    if (/flycast_worker\\.js/.test(String(url))) w.addEventListener('message', (e) => {
      const d = e.data; if (!d) return; const t = performance.now();
      if (d.cmd === 'ips' && d.wallMs !== undefined) C.ips.push([t, d.busyMs, d.wallMs, d.pacedMs]);
      else if (d.cmd === 'fps') C.fps.push([t, d.kcyc, d.fps]);
      else if (d.cmd === 'stateLoaded') { C.stateOk = !!d.success; C.stateAt = t; }
    });
    return w;
  };
  window.Worker.prototype = RW.prototype;
})();`;

async function cell(arm, rep) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dccost-'));
  const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
           '--autoplay-policy=no-user-gesture-required', '--disk-cache-size=1'] });
  try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(b, fileURLToPath(import.meta.url)); } catch (e) {}
  const r = { arm, rep, loadBefore: os.loadavg()[0] };
  try {
    const page = (await b.pages())[0];
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(TAP);
    // An arm is a query string against --url, or a whole origin+query
    // ("http://localhost:18801?x=1") to price one SNAPSHOT against another.
    const url = /^https?:/.test(arm)
      ? arm.replace(/\?.*$/, '').replace(/\/$/, '') + '/dreamcast.html' + (arm.includes('?') ? '?' + arm.split('?')[1] : '')
      : BASE + '/dreamcast.html' + (arm ? '?' + arm : '');
    r.url = url;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 40 && !(await page.evaluate(() => self.crossOriginIsolated).catch(() => false)); i++) await sleep(300);
    await page.evaluate((g) => { const s = document.getElementById('romSelect'); s.value = g; s.dispatchEvent(new Event('change')); document.getElementById('btnStart').click(); }, GAME);
    const t0 = Date.now();
    let ok = null;
    while (Date.now() - t0 < 300000) { ok = await page.evaluate(() => window.__cost && window.__cost.stateOk).catch(() => null); if (ok != null) break; await sleep(1000); }
    if (!ok) { r.void = 'the seed state never loaded (stateOk=' + ok + ')'; return r; }
    await sleep(SETTLE * 1000);
    const tA = await page.evaluate(() => performance.now());
    await sleep(WINDOW * 1000);
    const d = await page.evaluate((tA) => {
      const C = window.__cost; const ips = C.ips.filter((x) => x[0] > tA); const fps = C.fps.filter((x) => x[0] > tA);
      const p = window.__dcProbe ? window.__dcProbe() : null;
      return { ips, fps, guestX: p && p.guestX, arms: document.getElementById('armBanner') ? document.getElementById('armBanner').textContent.slice(0, 120) : null };
    }, tA);
    const busy = d.ips.reduce((a, x) => a + x[1], 0), wall = d.ips.reduce((a, x) => a + x[2], 0);
    const cyc = d.fps.reduce((a, x) => a + x[1] * 1024, 0);
    const wallS = d.fps.length ? (d.fps[d.fps.length - 1][0] - d.fps[0][0]) / 1000 * (d.fps.length / Math.max(1, d.fps.length - 1)) : 0;
    r.samples = { ips: d.ips.length, fps: d.fps.length };
    r.guestX = wallS > 0 ? +(cyc / 200e6 / wallS).toFixed(4) : null;
    r.duty = wall > 0 ? +(busy / wall).toFixed(4) : null;
    r.capacityX = (r.guestX && r.duty) ? +(r.guestX / r.duty).toFixed(4) : null;
    r.presentedPerS = d.fps.length ? +(d.fps.reduce((a, x) => a + x[2], 0) / d.fps.length).toFixed(2) : null;
    r.banner = d.arms;
    await page.screenshot({ path: path.join(OUT, `${NAME}-${rep}-${(arm || 'base').replace(/[^a-z0-9]+/gi, '_')}.png`) }).catch(() => {});
  } catch (e) { r.void = 'threw: ' + (e && e.message); }
  finally {
    r.loadAfter = os.loadavg()[0];
    try { await b.close(); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  return r;
}

const RES = { name: NAME, base: BASE, arms: ARMS, reps: REPS, settle: SETTLE, window: WINDOW, uptimeStart: uptime(), cells: [] };
say('uptime ' + RES.uptimeStart + ' · arms ' + JSON.stringify(ARMS));
for (let rep = 0; rep < REPS; rep++) {
  for (const arm of (rep % 2 ? ARMS.slice().reverse() : ARMS)) {
    const r = await cell(arm, rep);
    RES.cells.push(r);
    say(`rep ${rep} arm '${arm || 'base'}': ${JSON.stringify(r)}`);
  }
}
const by = {};
for (const c of RES.cells) if (!c.void && c.capacityX) (by[c.arm] = by[c.arm] || []).push(c);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
RES.summary = {};
for (const [arm, cs] of Object.entries(by)) RES.summary[arm || 'base'] = { n: cs.length, capacityX: cs.map((c) => c.capacityX), medianCapacityX: med(cs.map((c) => c.capacityX)), guestX: cs.map((c) => c.guestX), duty: cs.map((c) => c.duty), presented: cs.map((c) => c.presentedPerS) };
const base = RES.summary.base && RES.summary.base.medianCapacityX;
for (const [k, v] of Object.entries(RES.summary)) if (k !== 'base' && base) v.capacityVsBase = +(v.medianCapacityX / base).toFixed(4);
// Pairwise ratios (rep-matched), the durable number under load.
RES.pairs = [];
for (let rep = 0; rep < REPS; rep++) {
  const b0 = RES.cells.find((c) => c.rep === rep && !c.arm && c.capacityX);
  for (const c of RES.cells.filter((c) => c.rep === rep && c.arm && c.capacityX)) if (b0) RES.pairs.push({ rep, arm: c.arm, ratio: +(c.capacityX / b0.capacityX).toFixed(4) });
}
RES.uptimeEnd = uptime();
say('SUMMARY ' + JSON.stringify(RES.summary));
say('PAIRS   ' + JSON.stringify(RES.pairs));
say('uptime ' + RES.uptimeEnd);
fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(RES, null, 1));
logS.end();
setTimeout(() => process.exit(0), 200);

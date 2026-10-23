// SM64 daily-challenge route explorer (n64/daily/README.md).
//
//   node n64/tools/sm64_daily_explore.mjs [iterations]      (needs the devserver; URL=... to override)
//
// Boots sm64.z64 on /n64/, presses through the intro until Mario stands idle in
// Castle Grounds, saves that as the challenge START STATE, then runs a
// Go-Explore search with the core's lockstep API (neil_ls_set_pad /
// neil_ls_run_frame — one VI per call, mymain.cpp neil_ls_run_frame): pick an
// archived cell, restore its savestate, play a random input macro, archive any
// new grounded cell Mario lands in. Every archived cell therefore carries a
// PROOF it is reachable from the start state — the parent chain of input
// segments that got there — and the number of VIs that proof took.
//
// Writes n64/daily/states/<name>.gz (start state) and n64/daily/routes/<name>.json.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ITERS = +(process.argv[2] || 1200);
const NAME = process.env.ROUTE_NAME || 'castle_grounds';
const base = process.env.URL || 'http://localhost:8080/n64/';
const CELL_XZ = 400, CELL_Y = 200, MAX_STATES = 400;

const browser = await puppeteer.launch({ headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // --mute-audio: a probe must never play the game out of the user's speakers.
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (_e) {}
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await page.goto(base + '?game=sm64.z64&autostart', { waitUntil: 'load' });
await page.waitForFunction('window.myApp && myApp.rivetsData && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 90000 });
const wait = ms => new Promise(r => setTimeout(r, ms));
const tap = async (k) => { await page.keyboard.down(k); await wait(120); await page.keyboard.up(k); };

// Shared RAM reader — the same addresses n64/daily/daily.js uses (verified live, see README).
await page.evaluate(() => {
  const M = window.Module;
  window.__sm = {
    p: M._neil_rdram_ptr(),
    f32(a) { return M.HEAPF32[(this.p + (a & 0x1FFFFFFF)) >>> 2]; },
    u32(a) { return M.HEAPU32[(this.p + (a & 0x1FFFFFFF)) >>> 2] >>> 0; },
    s16(a) { return M.HEAP16[(this.p + ((a & 0x1FFFFFFF) ^ 2)) >>> 1]; },
    mario() { const m = 0x8033B170; return { act: this.u32(m + 0x0C), x: this.f32(m + 0x3C), y: this.f32(m + 0x40), z: this.f32(m + 0x44), hp: this.s16(m + 0xAE), level: this.s16(0x8032DDF8) }; },
  };
  // The page's SaveStateEvent files every serialize into IndexedDB; the explorer's must not.
  myApp.SaveStateEvent = function () {};
  window.__cells = {};
  window.__save = (id) => { M._neil_serialize(); window.__cells[id] = M.FS.readFile('/savestate.gz'); return window.__cells[id].length; };
  window.__load = (id) => { M.FS.writeFile('/savestate.gz', window.__cells[id]); return M._neil_unserialize(); };
  window.__drop = (id) => { delete window.__cells[id]; };
});

// ── 1. Through the intro to an idle Mario in Castle Grounds ──────────────────
await wait(4000);
for (let i = 0; i < 14; i++) { await tap('Enter'); await wait(900); }
for (let i = 0; i < 10; i++) { await tap('m'); await wait(900); }
let m0;
for (let i = 0; i < 160; i++) { m0 = await page.evaluate(() => __sm.mario()); if (m0.act === 0x0C400201 && m0.level === 16) break; await tap(i % 2 ? 'm' : 'n'); await wait(700); }
if (m0.act !== 0x0C400201) { console.error('never reached idle Mario', m0); await browser.close(); process.exit(1); }
// Let the camera settle, then freeze the guest under lockstep for the whole search.
await wait(1500);
await page.evaluate(() => { Module._neil_ls_arm(1); for (let i = 0; i < 4; i++) Module._neil_ls_run_frame(); });
const startBytes = await page.evaluate(() => (__save('root'), Array.from(__cells.root)));
const start = await page.evaluate(() => __sm.mario());
fs.mkdirSync(path.join(ROOT, 'n64/daily/states'), { recursive: true });
fs.writeFileSync(path.join(ROOT, `n64/daily/states/${NAME}.gz`), Buffer.from(startBytes));
console.log('start', JSON.stringify(start), 'state bytes', startBytes.length);

// ── 2. Go-Explore ────────────────────────────────────────────────────────────
// A segment is a random macro: hold the stick at an angle for `len` VIs and
// press A / Z on a schedule. SM64 polls input at 30 Hz (two VIs per game
// frame), so every press is held >= 4 VIs or the game may never see it.
const segScript = (seed) => {
  let s = seed >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const len = 30 + Math.floor(rnd() * 70);
  const ang = rnd() * Math.PI * 2, mag = rnd() < 0.1 ? 0 : 32000;
  const kind = Math.floor(rnd() * 6);   // 0 walk, 1 jump, 2 double, 3 triple, 4 long jump, 5 backflip
  const t0 = 6 + Math.floor(rnd() * Math.max(1, len - 40));
  const ev = [];                       // [vi, mask]
  if (kind === 1) ev.push([t0, 16]);
  if (kind === 2) ev.push([t0, 16], [t0 + 16, 16]);
  if (kind === 3) ev.push([t0, 16], [t0 + 16, 16], [t0 + 32, 16]);
  if (kind === 4) ev.push([t0, 128], [t0 + 2, 128 | 16]);
  if (kind === 5) ev.push([0, 128], [t0, 128 | 16]);
  return { len, ax: Math.round(Math.cos(ang) * mag), ay: Math.round(Math.sin(ang) * mag), ev, stand: kind === 5 };
};
const runSegment = (seg) => page.evaluate((seg) => {
  const M = Module; let last = null, ok = true;
  for (let t = 0; t < seg.len; t++) {
    let mask = 0;
    for (const [vi, m] of seg.ev) if (t >= vi && t < vi + 4) mask |= m;
    const stick = !(seg.stand && t < (seg.ev[1] ? seg.ev[1][0] + 4 : 0));
    M._neil_ls_set_pad(0, mask, stick ? seg.ax : 0, stick ? seg.ay : 0);
    M._neil_ls_run_frame();
    last = __sm.mario();
    if (last.level !== 16 || last.hp < 0x100) { ok = false; break; }
  }
  // Settle with no input so the cell is where Mario actually comes to rest.
  for (let t = 0; ok && t < 24; t++) { M._neil_ls_set_pad(0, 0, 0, 0); M._neil_ls_run_frame(); last = __sm.mario(); if (last.level !== 16 || last.hp < 0x100) ok = false; }
  return { ok, m: last };
}, seg);

// Grounded = stationary (0x000) or moving (0x040) action group, not swimming (ACT_FLAG_SWIMMING 0x2000)
// and not airborne (ACT_FLAG_AIR 0x800). Checkpoints only ever go where Mario can stand.
const grounded = (a) => ((a & 0x1C0) === 0x000 || (a & 0x1C0) === 0x040) && !(a & 0x2000) && !(a & 0x800);
const key = (m) => `${Math.floor(m.x / CELL_XZ)},${Math.floor(m.y / CELL_Y)},${Math.floor(m.z / CELL_XZ)}`;
const cells = new Map();   // key -> { id, parent, x,y,z, t, seg, visits }
cells.set(key(start), { id: 'root', hasState: true, parent: null, x: start.x, y: start.y, z: start.z, t: 0, seg: null, visits: 0 });
let nextId = 1, stateCount = 1, segSeed = 12345;
const t0 = Date.now();
for (let it = 0; it < ITERS; it++) {
  // Prefer rarely-tried cells, and higher ones: "up" is where parkour lives.
  const live = [...cells.values()].filter(c => c.hasState);
  let best = null, bestW = -1;
  for (const c of live) { const w = (1 / Math.sqrt(c.visits + 1)) * (1 + Math.max(0, c.y - start.y) / 1500) * Math.random(); if (w > bestW) { bestW = w; best = c; } }
  best.visits++;
  await page.evaluate((id) => __load(id), best.id);
  const seg = segScript(segSeed++);
  const r = await runSegment(seg);
  if (!r.ok || !grounded(r.m.act)) continue;
  const k = key(r.m), t = best.t + seg.len + 24;
  const prev = cells.get(k);
  if (prev && prev.t <= t) continue;
  // A node keeps its id for life so children's parent links never dangle.
  const id = prev ? prev.id : 'c' + nextId++;
  await page.evaluate((id) => __save(id), id);
  if (!prev || !prev.hasState) stateCount++;
  cells.set(k, { id, hasState: true, parent: best.id, x: r.m.x, y: r.m.y, z: r.m.z, t, seg, visits: prev ? prev.visits : 0 });
  // Bound memory: drop the savestate of the most-visited cell, keep it as a route node.
  if (stateCount > MAX_STATES) {
    const victim = [...cells.values()].filter(c => c.hasState && c.id !== 'root').sort((a, b) => b.visits - a.visits)[0];
    await page.evaluate((id) => __drop(id), victim.id);
    victim.hasState = false; stateCount--;
  }
  if (it % 100 === 0) console.log(`it ${it} cells ${cells.size} maxY ${Math.max(...[...cells.values()].map(c => c.y)).toFixed(0)} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ── 3. Route file ────────────────────────────────────────────────────────────
// Each node: position, the parent it was reached from, and `t` = VIs from the
// start state along its proof chain (an upper bound on the fastest route).
const nodes = [...cells.values()].map(c => ({ id: c.id, parent: c.parent, x: +c.x.toFixed(1), y: +c.y.toFixed(1), z: +c.z.toFixed(1), t: c.t }));
const out = { name: NAME, level: 16, viHz: 60, start: { x: start.x, y: start.y, z: start.z }, generated: new Date().toISOString(), iterations: ITERS, nodes };
fs.mkdirSync(path.join(ROOT, 'n64/daily/routes'), { recursive: true });
fs.writeFileSync(path.join(ROOT, `n64/daily/routes/${NAME}.json`), JSON.stringify(out));
console.log('wrote', nodes.length, 'nodes; maxT', Math.max(...nodes.map(n => n.t)), 'VIs; pageErrors', JSON.stringify(errs));
await browser.close(); process.exit(0);

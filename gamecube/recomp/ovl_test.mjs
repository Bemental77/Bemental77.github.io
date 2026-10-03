#!/usr/bin/env node
// gamecube/recomp/ovl_test.mjs — PROVE EACH OVERLAY OF THE MARIO PARTY 4 RECOMP WITH A RUN.
//
// For every case it boots the recomp worker alone (gamecube/recomp/ovl_test.html, no renderer),
// lets the board chain reach Party-Mode character select, fires the AUTOTEST hook
// (shims/src/gc_autoboard.c) into one board or one minigame (four COMs, instructions skipped),
// and runs to a frame budget. A case is judged on what the GAME did, read off its own overlay
// transitions (objman's "Start New OVL N", exempt from the worker's OSReport rate limit):
//   PASS     the target overlay was entered and the run ended with no trap and no missing overlay
//            (a minigame that finishes goes on to resultDll; one still playing at the budget is
//            reported as still running, which is also a pass for "does this overlay run")
//   MISSING  the game asked for an overlay this build does not carry (recomp_worker.js stops at
//            OSLink and names it)
//   TRAP     `main stopped: ...` — with the wasm stack
//   HANG     no new frame for 60 s
//   NOT-REACHED  the target overlay never started
//
// Usage (hermetic snapshot root served by tools/devserver.mjs, md5-checked before and after):
//   ROOT=<snapshot> NODE_PATH=~/probe-deps/node_modules node gamecube/recomp/ovl_test.mjs [cases]
//   cases: 'boards' | 'mg' | 'mg:0-9' | 'board:2' | 'all' (default all)
// Env: PORT (19031), FRAMES (12000), OUT (/tmp/ovl_test.json), PROBE_CHROME, SCRIPT (board; amash = Start
//      then A every 24 frames — reaches character select on every build), ALLCOM=1 (all four COM)
//      DET=1: run every case TWICE, each arm in its own browser process with a fresh profile, in
//      the worker's DETERMINISM MODE (whole-guest hash every frame: LOW statics+heap, MEM1, HIGH),
//      and compare frame by frame — the lockstep property a room depends on, now over overlays
//      the four-overlay build never reached. The first differing frame and region are reported.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(REPO + '/tools/_anchor.js');
const puppeteer = require('puppeteer');
let guard = null; try { guard = require(REPO + '/tools/browser_leak_guard.js'); } catch (e) {}
const ROOT = process.env.ROOT || REPO, PORT = +(process.env.PORT || 19031);
const FRAMES = +(process.env.FRAMES || 12000), SCRIPT = process.env.SCRIPT || 'board';
const OUT = process.env.OUT || path.join(os.tmpdir(), 'ovl_test.json');
const DET = process.env.DET === '1';
const CHROME = process.env.PROBE_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// overlay numbers -> names, from the decomp table this build was made from (USA order)
const OVL = ['_minigameDLL', 'bootDll', 'E3setupDLL', 'instDll', 'm300', 'm302', 'm303', 'm330', 'm333'];
for (let n = 401; n <= 463; n++) if (![452, 454].includes(n)) OVL.push('m' + n + 'Dll');
OVL.push('mentDll', 'messDll', 'mgmodedll', 'modeltestDll', 'modeseldll', 'mpexDll', 'msetupDll', 'mstory2Dll',
         'mstory3Dll', 'mstory4Dll', 'mstoryDll', 'nisDll', 'option', 'present', 'resultDll', 'safDll', 'selmenuDll',
         'staffDll', 'subchrselDll', 'w01Dll', 'w02Dll', 'w03Dll', 'w04Dll', 'w05Dll', 'w06Dll', 'w10Dll', 'w20Dll',
         'w21Dll', 'ztardll');
const ovlName = (n) => OVL[n] || ('#' + n);

function parseCases(arg) {
  const cases = [];
  const addMg = (a, b) => { for (let i = a; i <= b; i++) cases.push({ name: 'mg' + i, mg: i }); };
  const addBoard = (a, b) => { for (let i = a; i <= b; i++) cases.push({ name: 'board' + i, board: i }); };
  for (const tok of (arg || 'all').split(',')) {
    let m;
    if (tok === 'all') { addBoard(0, 5); addMg(0, 61); }
    else if (tok === 'boards') addBoard(0, 5);
    else if (tok === 'mg') addMg(0, 61);
    else if ((m = /^mg:(\d+)(?:-(\d+))?$/.exec(tok))) addMg(+m[1], +(m[2] || m[1]));
    else if ((m = /^board:(\d+)(?:-(\d+))?$/.exec(tok))) addBoard(+m[1], +(m[2] || m[1]));
  }
  return cases;
}

const srv = spawn(process.execPath, [path.join(REPO, 'tools', 'devserver.mjs')],
                  { env: { ...process.env, WEB_ROOT: ROOT, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
const ORIGIN = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(ORIGIN + '/coi-serviceworker.js')).ok) break; } catch (e) {} await sleep(100); }
async function md5s() {
  const o = {};
  for (const p of ['/gamecube/recomp/ovl_test.html', '/gamecube/recomp/recomp_worker.js',
                   '/gamecube/recomp/mp4_game.wasm', '/gamecube/recomp/mp4_game.js']) {
    const b = Buffer.from(await (await fetch(ORIGIN + p)).arrayBuffer());
    o[p.split('/').pop()] = crypto.createHash('md5').update(b).digest('hex');
  }
  return o;
}
const md5Before = await md5s();
console.log('[ovl] served md5 ' + JSON.stringify(md5Before) + '  load ' + os.loadavg()[0].toFixed(1));

const dirs = [];
async function launch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovltest-')); dirs.push(dir);
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: dir,
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--js-flags=--max-old-space-size=4096'] });
  if (guard) try { guard.guard(b, 'ovl_test.mjs'); } catch (e) {}
  return b;
}
const browser = await launch();
const browserB = DET ? await launch() : null;     // arm B: a SEPARATE browser process

async function runCase(c, br = browser, det = false) {
  const pg = await br.newPage();
  const qs = new URLSearchParams({ frames: String(c.frames || FRAMES), script: SCRIPT });
  if (det) qs.set('det', '1');
  if (process.env.ALLCOM === '1') qs.set('allcom', '1');
  if (c.board != null) qs.set('board', String(c.board));
  if (c.mg != null) qs.set('mg', String(c.mg));
  await pg.goto(`${ORIGIN}/gamecube/recomp/ovl_test.html?${qs}`);
  const t0 = Date.now(); let last = -1, lastT = Date.now(), res = null, s = null;
  while (!res) {
    await sleep(1000);
    try { s = await pg.evaluate(() => { const R = window.__ovl; return R ? { vi: R.vi, done: R.done, error: R.error, missing: R.missing, ovls: R.ovls, nrows: R.rows.length } : null; }); }
    catch (e) { continue; }                                    // coi reload in progress
    if (!s) { if (Date.now() - t0 > 300000) res = 'NO-BOOT'; continue; }
    if (s.missing) res = 'MISSING';
    else if (s.error) res = 'TRAP';
    else if (s.done) res = 'END';
    else if (s.vi !== last) { last = s.vi; lastT = Date.now(); }
    else if (s.vi > 0 && Date.now() - lastT > 60000) res = 'HANG';
    else if (Date.now() - t0 > 1200000) res = 'TIMEOUT';
  }
  const fin = await pg.evaluate((det) => { const R = window.__ovl; return { tail: R.log.slice(-80), rows: det ? R.rows : null }; }, det).catch(() => ({ tail: [], rows: null }));
  await pg.close();
  const seq = (s && s.ovls) || [];
  const names = seq.map(([f, n]) => ovlName(n) + '@' + f);
  // the target: the first overlay entered after the hook fired (after mentDll)
  const iMent = seq.findIndex(([, n]) => ovlName(n) === 'mentDll');
  const after = iMent >= 0 ? seq.slice(iMent + 1) : [];
  let target = null;
  if (c.board != null) target = 'w0' + (c.board + 1) + 'Dll';
  else if (c.mg != null) { const e = after.find(([, n]) => ovlName(n) !== 'instDll'); target = e ? ovlName(e[1]) : null; }
  const entered = target && after.some(([, n]) => ovlName(n) === target);
  let verdict;
  if (res === 'MISSING') verdict = 'MISSING ' + (s.missing && s.missing.dll);
  else if (res === 'TRAP') verdict = 'TRAP';
  else if (res === 'HANG' || res === 'TIMEOUT' || res === 'NO-BOOT') verdict = res;
  else verdict = entered ? 'PASS' : 'NOT-REACHED';
  const r = { case: c.name, target, verdict, vi: s && s.vi, wallS: Math.round((Date.now() - t0) / 1000),
              ovls: names, error: s && s.error, missing: s && s.missing,
              stack: res === 'TRAP' ? fin.tail.filter((l) => /wasm-function|main stopped/.test(l)).slice(0, 8) : undefined,
              load: +os.loadavg()[0].toFixed(1) };
  if (det) { r.rows = fin.rows; return r; }
  console.log(`[ovl] ${c.name.padEnd(8)} ${verdict.padEnd(12)} target=${target} vi=${r.vi} ${r.wallS}s  ${names.slice(-6).join(' > ')}` +
              (r.error ? '\n        ' + r.error.slice(0, 200) : ''));
  return r;
}

// Two arms, two browser processes, run concurrently; compare the per-frame whole-guest hashes.
async function runDet(c) {
  const [a, b] = await Promise.all([runCase(c, browser, true), runCase(c, browserB, true)]);
  const ra = a.rows || [], rb = b.rows || [];
  const n = Math.min(ra.length, rb.length) / 6 | 0;
  let first = null, changedFrames = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (ra[o + 5]) changedFrames++;
    if (ra[o] !== rb[o] || ra[o + 1] !== rb[o + 1] || ra[o + 2] !== rb[o + 2] || ra[o + 3] !== rb[o + 3]) {
      first = { frame: ra[o], low: ra[o + 1] !== rb[o + 1], mem1: ra[o + 2] !== rb[o + 2], high: ra[o + 3] !== rb[o + 3] };
      break;
    }
  }
  const same = !first && n > 0 && a.verdict === b.verdict;
  const r = { case: c.name, target: a.target, verdict: a.verdict, verdictB: b.verdict, framesCompared: n,
              changedFrames, firstDivergence: first, deterministic: same, ovls: a.ovls, ovlsB: b.ovls,
              error: a.error || b.error, load: +os.loadavg()[0].toFixed(1) };
  console.log(`[det] ${c.name.padEnd(8)} ${a.verdict}/${b.verdict}  ${same ? 'IDENTICAL' : 'DIVERGED'} over ${n} frames ` +
              `(${changedFrames} changed the hash)` + (first ? '  first diff f' + first.frame + JSON.stringify(first) : '') +
              `  ${a.ovls.slice(-5).join(' > ')}`);
  return r;
}

const results = [];
for (const c of parseCases(process.argv[2])) {
  results.push(DET ? await runDet(c) : await runCase(c));
  fs.writeFileSync(OUT, JSON.stringify({ md5: md5Before, frames: FRAMES, results }, null, 1));
}
const md5After = await md5s();
const torn = JSON.stringify(md5After) !== JSON.stringify(md5Before);
const tally = {};
for (const r of results) { const k = DET ? (r.deterministic ? 'IDENTICAL' : 'DIVERGED') : r.verdict.split(' ')[0]; tally[k] = (tally[k] || 0) + 1; }
console.log('[ovl] ' + JSON.stringify(tally) + (torn ? '  !! SERVED FILES CHANGED MID-RUN — VOID' : '  (served files unchanged)') + '  -> ' + OUT);
fs.writeFileSync(OUT, JSON.stringify({ md5: md5Before, md5After, torn, frames: FRAMES, results, tally }, null, 1));
await browser.close(); if (browserB) await browserB.close(); srv.kill();
for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });

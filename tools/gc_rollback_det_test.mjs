#!/usr/bin/env node
// tools/gc_rollback_det_test.mjs — DOES A MARIO PARTY 4 THAT KEEPS GUESSING, REWINDING AND
// RE-SIMULATING END EVERY FRAME IN EXACTLY THE STATE OF ONE THAT NEVER GUESSED?
//
// A rollback room is only correct if a rewind + re-simulation reproduces, bit for bit, the state a
// console that waited for the real inputs would have reached. That is a property of THE ROLLBACK
// RING (gamecube/recomp/recomp_worker.js + rb_instrument.js), and it is measured here, not argued.
//
// Three arms, each a SEPARATE BROWSER PROCESS with a fresh profile running tools/gc_netplay_det.html
// (the recomp worker alone, a scripted input stream that is a pure function of the frame number,
// whole-state hashes every frame: LOW + MEM1 + HIGH, and every 64 KiB page at checkpoints):
//   ref     the never-guessing reference: the shipped, UNINSTRUMENTED module, inputs on time.
//   rb      the instrumented module with the worker's rollback driver: port 0's input arrives 1..D
//           frames late (seeded), every unknown frame runs on a PREDICTION (the last known input
//           repeated — lib/netplay.js _rbPredict), and a wrong guess is rewound and re-simulated.
//   broken  the same, but the re-simulation re-runs the SAME wrong guesses (BROKEN=nocorrect; also
//           nojs | noundo). It must DISAGREE with ref, or agreement proves nothing.
// For every frame the LAST row each arm posted is its final state (a re-simulated frame posts
// again). rb must equal ref on every frame whose input was confirmed (all but the last MARGIN).
//
// Usage (hermetic snapshot; CLAUDE.md gates on torn pairs and probe serialization):
//   WEB_ROOT=<snapshot> PROBE_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   NODE_PATH=/root/probe-deps/node_modules bash tools/probe_lock.sh run -- node tools/gc_rollback_det_test.mjs
// Env: FRAMES (default 3000)  SCRIPT (mash3)  DMAX (7)  SEED (7)  BROKEN (nocorrect)  PAGE_EVERY (600)
//      PORT (18911)  WEB_ROOT  OUT
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
const FRAMES = parseInt(process.env.FRAMES || '3000', 10);
const SCRIPT = process.env.SCRIPT || 'mash3';
const DMAX = parseInt(process.env.DMAX || '7', 10);
const SEED = parseInt(process.env.SEED || '7', 10);
const BROKEN = (process.env.BROKEN || 'nocorrect').split(',').filter(Boolean);
const PAGE_EVERY = parseInt(process.env.PAGE_EVERY || '600', 10);
const PORT = parseInt(process.env.PORT || '18911', 10);
const WEB_ROOT = process.env.WEB_ROOT || REPO;
const OUT = process.env.OUT || path.join(os.tmpdir(), 'gc_rollback_det.json');
const MARGIN = DMAX + 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const hex = (v) => ('0000000' + ((v >>> 0).toString(16))).slice(-8);
const load = () => os.loadavg().map((v) => v.toFixed(2)).join(' ');

const srv = spawn(process.execPath, [path.join(REPO, 'tools', 'devserver.mjs')],
                  { env: Object.assign({}, process.env, { WEB_ROOT, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write('[devserver] ' + d));
const ORIGIN = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { const r = await fetch(ORIGIN + '/coi-serviceworker.js'); if (r.ok) break; } catch (e) {} await sleep(100); }
const WATCH = ['/tools/gc_netplay_det.html', '/gamecube/recomp/recomp_worker.js', '/gamecube/recomp/rb_instrument.js',
               '/gamecube/recomp/mp4_game.wasm', '/gamecube/recomp/mp4_game.js'];
async function servedMd5() {
  const out = {};
  for (const p of WATCH) out[p] = crypto.createHash('md5').update(Buffer.from(await (await fetch(ORIGIN + p)).arrayBuffer())).digest('hex');
  return out;
}
const md5Before = await servedMd5();
console.log('[rbdet] served md5 ' + JSON.stringify(md5Before));
console.log(`[rbdet] ${FRAMES} frames, script=${SCRIPT}, input late by 1..${DMAX} frames (seed ${SEED}), broken arms: ${BROKEN.join(',') || 'none'}; load ${load()}`);

async function runArm(name, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcrbdet-'));
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: dir,
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=IntensiveWakeUpThrottling',
           '--js-flags=--max-old-space-size=4096', '--disk-cache-size=1'] });
  if (guard) try { guard.guard(b, 'gc_rollback_det_test'); } catch (e) {}
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log(`  [${name}] PAGEERROR ${String(e).slice(0, 200)}`));
  const url = `${ORIGIN}/tools/gc_netplay_det.html?frames=${FRAMES}&pace=free&script=${SCRIPT}&pageevery=${PAGE_EVERY}&arm=${name}${extra}`;
  await p.goto(url, { waitUntil: 'load', timeout: 120000 });
  const t0 = Date.now();
  let st = null, lastSay = 0, lastFrame = -1, lastMoveAt = Date.now(), stalled = null;
  for (;;) {
    await sleep(1000);
    try { st = await p.evaluate(() => ({ frames: window.__det && window.__det.frames, done: window.__det && window.__det.done, error: window.__det && window.__det.error })); }
    catch (e) { continue; }
    if (!st || st.frames == null) continue;
    if (st.error) { console.log(`  [${name}] ERROR ${st.error}`); break; }
    if (st.done) break;
    if (st.frames !== lastFrame) { lastFrame = st.frames; lastMoveAt = Date.now(); }
    else if (Date.now() - lastMoveAt > 120000) { stalled = st.frames; console.log(`  [${name}] STALLED at frame ${st.frames}`); break; }
    if (Date.now() - lastSay > 20000) { lastSay = Date.now(); console.log(`  [${name}] frame ${st.frames} at ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
    if (Date.now() - t0 > 2400000) { console.log(`  [${name}] TIMEOUT`); break; }
  }
  const R = await p.evaluate(() => { const d = window.__det; return { rows: d.rows, pages: d.pages, done: d.done, error: d.error, frames: d.frames, rb: d.rb || null,
    log: d.log.filter((t) => /rollback ring|main stopped|RING FAULT|instrument/.test(t)).slice(0, 30) }; });
  R.stalled = stalled; R.name = name;
  await b.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return R;
}

const arms = [['ref', ''], ['rb', `&rbtest=1&rbdmax=${DMAX}&rbseed=${SEED}`]]
  .concat(BROKEN.map((k) => ['broken-' + k, `&rbtest=1&rbdmax=${DMAX}&rbseed=${SEED}&rbbroken=${k}`]));
const results = await Promise.all(arms.map(([n, e]) => runArm(n, e)));
const md5After = await servedMd5();
srv.kill();
JSON.stringify(md5Before) === JSON.stringify(md5After) ? ok('served-files-unchanged-through-the-run', 'md5 before == after')
                                                        : bad('served-files-unchanged-through-the-run', JSON.stringify(md5After));

const W = 6;
// LAST row per frame = the final state (a re-simulated frame posts its row again, later).
function byFrame(rows) { const m = new Map(); for (let i = 0; i + W <= rows.length; i += W) m.set(rows[i], rows.slice(i + 1, i + 4)); return m; }
const maps = results.map((r) => byFrame(r.rows));
const report = { frames: FRAMES, script: SCRIPT, dMax: DMAX, seed: SEED, md5: md5Before, load: os.loadavg(), arms: [] };
for (const r of results) {
  console.log(`  [${r.name}] ${byFrame(r.rows).size} frames hashed, ${r.rows.length / W} rows posted, done=${r.done}, error=${r.error || 'none'}` +
              (r.rb ? `; ring: ${r.rb.rollbacks} rollbacks, ${r.rb.resimFrames} re-simulated frames, max depth ${r.rb.maxDepth}, ` +
                      `save ${(r.rb.saveUs / 1000 / Math.max(1, r.frames)).toFixed(3)} ms/frame, restore ${(r.rb.restoreUs / 1000 / Math.max(1, r.rb.rollbacks)).toFixed(3)} ms/rollback, ` +
                      `${r.rb.touches} pages logged (${(r.rb.touches / Math.max(1, r.frames + r.rb.resimFrames)).toFixed(1)}/frame), slots held at end ${r.rb.slots}, overflows ${r.rb.overflows}, fault ${r.rb.fault}` : ''));
  for (const t of r.log) console.log(`      ${t.slice(0, 220)}`);
  report.arms.push({ name: r.name, done: r.done, error: r.error, rb: r.rb, rows: r.rows.length / W });
}
results.every((r) => r.done && !r.error) ? ok('every-arm-ran-to-the-end', `${FRAMES} frames each`)
  : bad('every-arm-ran-to-the-end', results.map((r) => `${r.name}:${r.frames}${r.error ? ' ' + String(r.error).slice(0, 100) : ''}`).join(' · '));
const ref = maps[0];
const upto = FRAMES - MARGIN;
function cmp(i) {
  let compared = 0, differ = 0, first = null;
  for (const [f, v] of ref) {
    if (f > upto) continue;
    const w = maps[i].get(f); if (!w) continue;
    compared++;
    if (v[0] !== w[0] || v[1] !== w[1] || v[2] !== w[2]) {
      differ++;
      if (!first) first = { frame: f, low: v[0] !== w[0], mem1: v[1] !== w[1], high: v[2] !== w[2], a: v.map(hex), b: w.map(hex) };
    }
  }
  const pageDiffs = [];
  for (const f of Object.keys(results[0].pages)) {
    if (+f > upto) continue;
    const A = results[0].pages[f], B = results[i].pages[f]; if (!A || !B) continue;
    const d = []; for (let k = 0; k < Math.min(A.length, B.length); k++) if (A[k] !== B[k]) d.push(k);
    pageDiffs.push({ frame: +f, differ: d.length, pages: d.slice(0, 12).map((k) => '0x' + (k * 65536).toString(16)) });
  }
  return { compared, differ, first, pageDiffs };
}
const rbArm = results[1];
const c1 = cmp(1);
report.rb = c1;
const rolled = rbArm.rb && rbArm.rb.rollbacks;
(rolled > 20 && rbArm.rb.resimFrames > rolled) ? ok('the-rollback-arm-actually-rolled-back', `${rbArm.rb.rollbacks} rollbacks re-simulating ${rbArm.rb.resimFrames} frames (max depth ${rbArm.rb.maxDepth})`)
                                               : bad('the-rollback-arm-actually-rolled-back', JSON.stringify(rbArm.rb));
(c1.compared >= upto * 0.95 && c1.differ === 0 && c1.pageDiffs.every((x) => !x.differ))
  ? ok('a-console-that-guessed-and-rewound-EQUALS-one-that-never-guessed',
       `${c1.compared} frames: LOW + MEM1 + HIGH identical on every one; every 64 KiB page identical at ${c1.pageDiffs.length} checkpoints (${c1.pageDiffs.map((x) => 'f' + x.frame).join(' ')})`)
  : bad('a-console-that-guessed-and-rewound-EQUALS-one-that-never-guessed',
        `${c1.differ} of ${c1.compared} frames differ; first ${JSON.stringify(c1.first)}; pages ${JSON.stringify(c1.pageDiffs.filter((x) => x.differ).slice(0, 3))}`);
for (let i = 2; i < results.length; i++) {
  const c = cmp(i);
  report['broken_' + results[i].name] = c;
  (c.differ > 0)
    ? ok(`the-${results[i].name}-control-FAILS-the-same-comparison`, `${c.differ} of ${c.compared} frames differ from the reference, first at frame ${c.first.frame} (${['low', 'mem1', 'high'].filter((k) => c.first[k]).join('+')})`)
    : bad(`the-${results[i].name}-control-FAILS-the-same-comparison`, `it agreed on all ${c.compared} frames — the comparison cannot tell a broken rollback from a correct one`);
}
{
  let changes = 0, prev = null;
  for (const [, v] of ref) { const k = v[0] + ':' + v[1]; if (prev !== null && k !== prev) changes++; prev = k; }
  (changes > ref.size * 0.5) ? ok('the-hashed-state-actually-moves', `${changes} of ${ref.size} frames changed the LOW/MEM1 hash`)
                             : bad('the-hashed-state-actually-moves', `only ${changes} of ${ref.size}`);
}
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`\n[gc-rollback-det] ${pass} passed, ${fail} failed  (report ${OUT}; load ${load()})`);
process.exit(fail ? 1 : 0);

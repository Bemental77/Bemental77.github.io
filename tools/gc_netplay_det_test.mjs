#!/usr/bin/env node
// tools/gc_netplay_det_test.mjs — IS THE MARIO PARTY 4 RECOMP GUEST DETERMINISTIC ACROSS MACHINES?
//
// Lockstep netplay sends inputs, never state: it is only correct if two machines that run the
// same frames with the same inputs end every frame in the SAME STATE. That is a property of the
// guest, and it is measured here rather than assumed.
//
// Each ARM is a SEPARATE BROWSER PROCESS with its own fresh profile (nothing shared: no
// IndexedDB card, no cache, no origin state) running tools/gc_netplay_det.html — the recomp
// worker alone, fed a scripted input stream that is a pure function of the frame number, in its
// DETERMINISM MODE: every frame it hashes the WHOLE guest state (LOW = MP4's C statics + heap +
// fiber stacks at the bottom of linear memory, MEM1 = the game's arena at 0x80000000, HIGH =
// the FST page and above) and every PAGE_EVERY frames it hashes each 64 KiB page of the entire
// linear memory. Rows are compared frame by frame; the first disagreement is named with the
// region and the pages that differ.
//
// ARMS="free,hw" runs one context UNCAPPED and one at 1.000x off the wall clock, so agreement
// also proves the state does not depend on how fast or how unevenly a machine runs — which is
// what two real players' machines will do.
//
// Usage (hermetic snapshot served on 18900+; see the GameCube CLAUDE.md gate on torn pairs):
//   WEB_ROOT=<snapshot> PROBE_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   NODE_PATH=~/probe-deps/node_modules node tools/gc_netplay_det_test.mjs
// Env: FRAMES (default 6000)  ARMS (default "free,free")  SCRIPT (board|mash, default mash)
//      CARDTIME (secs since 2000 | 'wall', default pinned)  PAGE_EVERY (default 600)
//      PORT (default 18901)  WEB_ROOT (default: this repo)  OUT (JSON report path)
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
const FRAMES = parseInt(process.env.FRAMES || '6000', 10);
const ARMS = (process.env.ARMS || 'free,free').split(',').map((s) => s.trim()).filter(Boolean);
const SCRIPT = process.env.SCRIPT || 'mash';
const CARDTIME = process.env.CARDTIME || '700000000';
const PAGE_EVERY = parseInt(process.env.PAGE_EVERY || '600', 10);
const PORT = parseInt(process.env.PORT || '18901', 10);
const STALL_MS = parseInt(process.env.STALL_MS || '90000', 10);
const WEB_ROOT = process.env.WEB_ROOT || REPO;
const OUT = process.env.OUT || path.join(os.tmpdir(), 'gc_netplay_det.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const hex = (v) => ('0000000' + ((v >>> 0).toString(16))).slice(-8);

// ---- the server: tools/devserver.mjs (gate #2) over the hermetic root -------------------------
const srv = spawn(process.execPath, [path.join(REPO, 'tools', 'devserver.mjs')],
                  { env: Object.assign({}, process.env, { WEB_ROOT, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write('[devserver] ' + d));
const ORIGIN = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { const r = await fetch(ORIGIN + '/coi-serviceworker.js'); if (r.ok) break; } catch (e) {} await sleep(100); }
// md5 of exactly what is SERVED, before and after (a torn or swapped file mid-run voids it)
async function servedMd5() {
  const out = {};
  for (const p of ['/tools/gc_netplay_det.html', '/gamecube/recomp/recomp_worker.js',
                   '/gamecube/recomp/mp4_game.wasm', '/gamecube/recomp/mp4_game.js']) {
    const b = Buffer.from(await (await fetch(ORIGIN + p)).arrayBuffer());
    out[p] = crypto.createHash('md5').update(b).digest('hex');
  }
  return out;
}
const md5Before = await servedMd5();
console.log('[det] served md5 ' + JSON.stringify(md5Before));
console.log(`[det] ${ARMS.length} arms (${ARMS.join(', ')}), ${FRAMES} frames, script=${SCRIPT}, cardtime=${CARDTIME}, web root ${WEB_ROOT}`);
console.log('[det] load: ' + os.loadavg().map((v) => v.toFixed(2)).join(' '));

// ---- one arm = one browser process, one fresh profile ----------------------------------------
async function runArm(pace, idx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcdet-'));
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: dir,
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=IntensiveWakeUpThrottling',
           '--js-flags=--max-old-space-size=4096', '--disk-cache-size=1'] });
  if (guard) try { guard.guard(b, 'gc_netplay_det_test'); } catch (e) {}
  const p = await b.newPage();
  p.on('pageerror', (e) => console.log(`  [arm${idx}] PAGEERROR ${String(e).slice(0, 200)}`));
  const url = `${ORIGIN}/tools/gc_netplay_det.html?frames=${FRAMES}&pace=${pace}&script=${SCRIPT}` +
              `&cardtime=${CARDTIME}&pageevery=${PAGE_EVERY}&arm=${idx}`;
  await p.goto(url, { waitUntil: 'load', timeout: 120000 });
  const t0 = Date.now();
  let st = null, lastSay = 0, lastFrame = -1, lastMoveAt = Date.now(), stalled = null;
  for (;;) {
    await sleep(1000);
    try { st = await p.evaluate(() => ({ frames: window.__det && window.__det.frames, done: window.__det && window.__det.done,
                                         error: window.__det && window.__det.error, coi: window.crossOriginIsolated })); }
    catch (e) { continue; }                            // the coi reload tears the context down once
    if (!st || st.frames == null) continue;
    if (st.error) { console.log(`  [arm${idx}] ERROR ${st.error}`); break; }
    if (st.done) break;
    if (st.frames !== lastFrame) { lastFrame = st.frames; lastMoveAt = Date.now(); }
    else if (Date.now() - lastMoveAt > STALL_MS) { stalled = st.frames; console.log(`  [arm${idx}] STALLED at frame ${st.frames} (no progress for ${STALL_MS / 1000}s)`); break; }
    if (Date.now() - lastSay > 15000) { lastSay = Date.now(); console.log(`  [arm${idx} ${pace}] frame ${st.frames} at ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
    if (Date.now() - t0 > 1800000) { console.log(`  [arm${idx}] TIMEOUT`); break; }
  }
  const R = await p.evaluate(() => {
    const d = window.__det;
    return { rows: d.rows, pages: d.pages, pageMeta: d.pageMeta, done: d.done, error: d.error,
             hashMs: d.hashMs, frames: d.frames, wallMs: (d.doneAt || performance.now()) - d.startedAt,
             log: d.log.filter((t) => /main stopped|memcard|DETERMINISM|SPIN|stack/.test(t)).slice(0, 20),
             tail: d.log.slice(-25) };
  });
  R.stalled = stalled;
  await b.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  R.pace = pace;
  return R;
}

const results = await Promise.all(ARMS.map((pace, i) => runArm(pace, i)));
const md5After = await servedMd5();
srv.kill();
const stable = JSON.stringify(md5Before) === JSON.stringify(md5After);
stable ? ok('served-files-unchanged-through-the-run', 'md5 before == after')
       : bad('served-files-unchanged-through-the-run', JSON.stringify(md5After));

// ---- compare ----------------------------------------------------------------------------------
const W = 6;   // row width: frame, hLow, hMem1, hHigh, guestUs, pages changed since the previous frame
function byFrame(rows) { const m = new Map(); for (let i = 0; i + W <= rows.length; i += W) m.set(rows[i], rows.slice(i + 1, i + W)); return m; }
const maps = results.map((r) => byFrame(r.rows));
const report = { frames: FRAMES, arms: ARMS, script: SCRIPT, cardtime: CARDTIME, md5: md5Before, stable, load: os.loadavg(), cmp: [] };
results.forEach((r, i) => {
  const gus = []; for (let k = 0; k + W <= r.rows.length; k += W) if (r.rows[k + 4] > 0) gus.push(r.rows[k + 4] / 1000);
  gus.sort((a, b) => a - b);
  const pct = (q) => gus.length ? gus[Math.min(gus.length - 1, Math.floor(q * gus.length))].toFixed(2) : '-';
  const ch = []; for (let k = 0; k + W <= r.rows.length; k += W) if (r.rows[k] > 600) ch.push(r.rows[k + 5]);
  ch.sort((a, b) => a - b);
  const cq = (q) => ch.length ? ch[Math.min(ch.length - 1, Math.floor(q * ch.length))] : 0;
  if (i === 0) report.changedPages = { p50: cq(0.5), p95: cq(0.95), max: ch.length ? ch[ch.length - 1] : 0 };
  console.log(`  arm${i} pages CHANGED per frame (after f600): p50 ${cq(0.5)} (${(cq(0.5) / 16).toFixed(1)} MB) · p95 ${cq(0.95)} (${(cq(0.95) / 16).toFixed(1)} MB) · max ${ch.length ? ch[ch.length - 1] : 0} (${((ch.length ? ch[ch.length - 1] : 0) / 16).toFixed(1)} MB)`);
  console.log(`  arm${i} (${r.pace}): ${maps[i].size} frames hashed, done=${r.done}, error=${r.error || 'none'}, ` +
              `wall ${(r.wallMs / 1000).toFixed(0)}s, hashing ${(r.hashMs / Math.max(1, maps[i].size)).toFixed(2)} ms/frame, ` +
              `guest compute p50 ${pct(0.5)} / p95 ${pct(0.95)} / max ${pct(0.999)} ms per frame`);
  for (const t of r.log) console.log(`      ${t.slice(0, 240)}`);
  if (r.stalled != null) { console.log(`    arm${i} STALLED at frame ${r.stalled}; last worker lines:`); for (const t of r.tail) console.log(`      ${t.slice(0, 240)}`); }
});
const ref = maps[0];
let allDone = results.every((r) => r.done && !r.error);
allDone ? ok('every-arm-ran-to-the-end', `${FRAMES} frames each`) : bad('every-arm-ran-to-the-end', results.map((r) => `${r.pace}:${r.frames}${r.error ? ' ' + r.error.slice(0, 80) : ''}`).join(' · '));
for (let i = 1; i < maps.length; i++) {
  let compared = 0, first = null;
  for (const [f, v] of ref) {
    const w = maps[i].get(f); if (!w) continue;
    compared++;
    if (!first && (v[0] !== w[0] || v[1] !== w[1] || v[2] !== w[2]))
      first = { frame: f, low: v[0] !== w[0], mem1: v[1] !== w[1], high: v[2] !== w[2],
                a: [hex(v[0]), hex(v[1]), hex(v[2])], b: [hex(w[0]), hex(w[1]), hex(w[2])] };
  }
  // page-level localisation at every checkpoint both arms reached
  const pageDiffs = [];
  for (const f of Object.keys(results[0].pages)) {
    const A = results[0].pages[f], B = results[i].pages[f]; if (!A || !B) continue;
    const d = []; for (let k = 0; k < Math.min(A.length, B.length); k++) if (A[k] !== B[k]) d.push(k);
    pageDiffs.push({ frame: +f, differ: d.length, pages: d.slice(0, 24).map((k) => '0x' + (k * 65536).toString(16)) });
  }
  report.cmp.push({ arm: i, compared, first, pageDiffs });
  const pd = pageDiffs.filter((x) => x.differ);
  console.log(`  arm0 vs arm${i}: ${compared} frames compared; page checkpoints: ` +
              pageDiffs.map((x) => `f${x.frame}:${x.differ}`).join(' '));
  (compared >= FRAMES * 0.95 && !first && !pd.length)
    ? ok(`arm0-and-arm${i}-agree-on-EVERY-frame`,
         `${compared} consecutive frames, LOW+MEM1+HIGH identical every frame; every 64 KiB page of linear memory identical at ${pageDiffs.length} checkpoints`)
    : bad(`arm0-and-arm${i}-agree-on-EVERY-frame`,
          first ? `first divergence at frame ${first.frame}: LOW ${first.low ? 'DIFFERS' : 'same'}, MEM1 ${first.mem1 ? 'DIFFERS' : 'same'}, HIGH ${first.high ? 'DIFFERS' : 'same'} ` +
                  `(${first.a.join('/')} vs ${first.b.join('/')}); differing pages ${JSON.stringify(pd.slice(0, 3))}`
                : `compared ${compared}/${FRAMES}; page diffs ${JSON.stringify(pd.slice(0, 3))}`);
}
// the state is not constant (a hash of a frozen memory would "agree" trivially)
{
  let changes = 0, prev = null;
  for (const [, v] of ref) { const k = v[0] + ':' + v[1]; if (prev !== null && k !== prev) changes++; prev = k; }
  (changes > ref.size * 0.5)
    ? ok('the-hashed-state-actually-moves', `${changes} of ${ref.size} frames changed the LOW/MEM1 hash — agreement is not over frozen bytes`)
    : bad('the-hashed-state-actually-moves', `only ${changes} of ${ref.size} frames changed the hash`);
}
// what a rollback snapshot of the guest state costs, as measured inside the worker
for (const [f, m] of Object.entries(results[0].pageMeta))
  console.log(`  rollback-cost f${f}: lowTop ${(m.lowTop / 1048576).toFixed(1)} MB + MEM1 24 MB = ${(m.snapBytes / 1048576).toFixed(1)} MB; ` +
              `copy-out ${m.snapMs.toFixed(1)} ms, copy-in ${m.restoreMs.toFixed(1)} ms; non-zero pages ${m.nonZeroPages} of ${m.memSize / 65536}`);
report.pageMeta = results[0].pageMeta;
report.hashMsPerFrame = results.map((r, i) => r.hashMs / Math.max(1, maps[i].size));
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`\n[gc-netplay-det] ${pass} passed, ${fail} failed  (report ${OUT}; load ${os.loadavg().map((v) => v.toFixed(2)).join(' ')})`);
process.exit(fail ? 1 : 0);

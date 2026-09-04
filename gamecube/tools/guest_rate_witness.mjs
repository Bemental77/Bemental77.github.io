#!/usr/bin/env node
// guest_rate_witness.mjs — the GameCube guest-clock rig.
//
// WHY THIS EXISTS. Every GameCube speed number this project published before
// 2026-09-04 came from the `[mips]` meter, which CLAUDE.md gate #10 records as
// "NOT validated — it has produced 98.2/94.5/75.2/97.8% across runs and once
// disagreed with MP4's own GlobalCounter by ~1.7x". Dreamcast by contrast has a
// real witness (AICA emits one frame per AICA_TICK=4535 SH4 cycles at 200 MHz,
// so production rate / 44101.43 IS the guest clock). This is the GC analogue,
// built to the same standard and cross-checked four ways.
//
// THE WITNESSES (all four are read in the SAME window, per window):
//
//   W1 ai_dma_cb   Raw entries to DSPManager::UpdateAudioDMA. That callback
//                  reschedules itself every GetAudioDMACallbackPeriod() ticks
//                  (SystemTimers.cpp:87-95) and consults nothing but CoreTiming.
//                  Counted at DSP.cpp:604, BEFORE the Enable gate.
//   W2 aid_fire    The DMA block wrap inside the same callback (DSP.cpp:625),
//                  i.e. one per AudioDMAControl.NumBlocks callbacks. Different
//                  branch, different divisor, same clock.
//   W3 gt          CoreTiming's global_timer itself, mirrored to SAB
//                  0x026B3424/28 on every Advance() (CoreTiming.cpp:404-410).
//                  Divided by the emulator's OWN published ticks/sec, never by
//                  a 486e6 literal.
//   W4 guest-side  MP4 only: GlobalCounter @0x801D3A54 (main.c:115, one bump per
//                  main-loop iteration) and retraceCount @0x801D4428 (bumped by
//                  the guest's VI retrace ISR). These require the GUEST to
//                  execute and interrupts to be delivered, so W4 is the only
//                  witness that is independent of the host clock AND doubles as
//                  a liveness proof.
//
// HONEST FRAMING, do not overstate it: W1, W2 and W3 are three different code
// paths onto ONE clock (global_timer). Their agreement validates the callback
// period arithmetic, the event scheduler and the SAB mirror — it is not three
// independent confirmations that emulated time equals wall time. W4 is the only
// genuinely independent axis and it exists only where a guest symbol is known.
//
// THE IDLE-SKIP CAVEAT IS MANDATORY OUTPUT. Emulated time advances both by
// executing guest code and by CLOCK-JUMPING over detected idle loops
// (ppc_emit.cpp:1050-1057 writes downcount=0 for branchIsIdleLoop blocks;
// block_cache.cpp:1128-1131 does the same for the multi-block poll). A scene
// that is 80% idle-skipped reads 1.00x while the JIT does 20% of the work. So
// every row carries idle-skip%, and where the meter that measures it is OFF the
// rig prints METER-OFF, never 0%.
//
// USAGE
//   node gamecube/tools/guest_rate_witness.mjs --list
//   node gamecube/tools/guest_rate_witness.mjs                 # whole matrix
//   node gamecube/tools/guest_rate_witness.mjs --only sab-ingame,pso-ingame
//   OUT_DIR=/tmp/gcw node gamecube/tools/guest_rate_witness.mjs
//
// Each cell reaps orphaned browsers, records uptime and the worker .wasm md5
// before AND after, and runs the canonical probe under tools/probe_lock.sh so
// concurrent agents cannot corrupt each other's numbers.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const OUT = process.env.OUT_DIR || '/tmp/gcw';
const WORKER_WASM = path.join(REPO, 'gamecube/dolphin_libretro/dolphin_worker_emcc.wasm');
const WORKER_JS = path.join(REPO, 'gamecube/dolphin_libretro/dolphin_worker_emcc.js');

// ROM_IDX indexes the live gamecube.html ROMS[] (gamecube.html:1899-1904):
//   0 Mario Party 4 · 1 Sonic Adventure 2 Battle · 2 PSO Ep I&II Plus · 3 240pSuite
// RECOMP_TITLES = { MarioParty4: 1 } (gamecube.html:1044), so a plain visit with
// ROM_IDX=0 routes to the RECOMP engine and dolphin's CoreTiming never advances;
// ?recomp=0 (gamecube.html:1046-1047) forces the JIT for every title.
const HOME = os.homedir();
const CELLS = [
  { name: 'mp4-cold-recomp', rom: 0, ms: 130000, query: '',
    note: 'MP4 cold boot, DEFAULT routing = recomp engine (no query param)' },
  { name: 'mp4-cold-jit', rom: 0, ms: 130000, query: 'recomp=0',
    note: 'MP4 cold boot, JIT forced' },
  { name: 'mp4-ingame-jit', rom: 0, ms: 150000, query: 'recomp=0',
    state: `${HOME}/Downloads/MarioParty4 (10).gcs.gz`, stateMs: 30000,
    note: 'MP4 board scene from a page-exported state, JIT forced' },
  { name: 'mp4-ingame-jit-mips', rom: 0, ms: 150000, query: 'recomp=0&bjit_mips=1',
    state: `${HOME}/Downloads/MarioParty4 (10).gcs.gz`, stateMs: 30000,
    note: 'as mp4-ingame-jit + the executed-cycle meter armed (idle-skip arm)' },
  { name: 'mp4-cold-jit-mips', rom: 0, ms: 130000, query: 'recomp=0&bjit_mips=1',
    note: 'MP4 cold boot, JIT forced + executed-cycle meter armed (idle-skip arm)' },
  { name: 'sab-cold', rom: 1, ms: 130000, query: '', note: 'SAB cold boot (JIT — no recomp build)' },
  { name: 'sab-cold-mips', rom: 1, ms: 130000, query: 'bjit_mips=1',
    note: 'SAB cold boot + executed-cycle meter armed (idle-skip arm)' },
  { name: 'sab-ingame', rom: 1, ms: 150000, query: '',
    state: path.join(REPO, 'gamecube/states/sab-citye-gameplay.gcs.gz'), stateMs: 30000,
    note: 'SAB City Escape gameplay from the in-repo state' },
  { name: 'sab-ingame-mips', rom: 1, ms: 150000, query: 'bjit_mips=1',
    state: path.join(REPO, 'gamecube/states/sab-citye-gameplay.gcs.gz'), stateMs: 30000,
    note: 'as sab-ingame + executed-cycle meter armed (idle-skip arm)' },
  { name: 'pso-cold', rom: 2, ms: 130000, query: '', note: 'PSO cold boot (JIT)' },
  { name: 'pso-cold-mips', rom: 2, ms: 130000, query: 'bjit_mips=1',
    note: 'PSO cold boot + executed-cycle meter armed — THE 1.00x case, arm it or the reading is meaningless' },
  { name: 'pso-ingame', rom: 2, ms: 150000, query: '',
    state: `${HOME}/Downloads/PhantasyStarOnline1And2Plus (8).gcs.gz`, stateMs: 30000,
    note: 'PSO gameplay from a page-exported state' },
  { name: 'pso-ingame-mips', rom: 2, ms: 150000, query: 'bjit_mips=1',
    state: `${HOME}/Downloads/PhantasyStarOnline1And2Plus (8).gcs.gz`, stateMs: 30000,
    note: 'as pso-ingame + executed-cycle meter armed (idle-skip arm)' },
  { name: 'suite240p-cold', rom: 3, ms: 130000, query: '',
    note: '240pSuite homebrew .dol — smallest workload in the set' },
];

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const c of CELLS) console.log(`${c.name.padEnd(20)} rom=${c.rom} ${c.state ? 'state' : 'cold '} — ${c.note}`);
  process.exit(0);
}
const only = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? new Set(args[i + 1].split(',').map((s) => s.trim())) : null;
})();

fs.mkdirSync(OUT, { recursive: true });

// NOT `bash -lc`. A login shell sources the bash profile, which sources
// emsdk_env.sh and puts /usr/local/bin ahead of nvm — `node` there is v14.15.1,
// which dies on puppeteer-core's `Symbol.dispose ??=` with a SyntaxError that
// reads like a probe bug. Measured 2026-09-04: interactive `node --version` =
// v24.15.0, `bash -lc 'node --version'` = v14.15.1. Every node invocation below
// therefore uses this process's own interpreter by absolute path.
const NODE = JSON.stringify(process.execPath);
const sh = (cmd) => spawnSync('bash', ['-c', cmd], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
const md5 = (f) => { const r = sh(`md5 -q ${JSON.stringify(f)}`); return (r.stdout || '').trim() || 'missing'; };
const load1 = () => { const r = sh('uptime'); return (r.stdout || '').trim(); };

// Median / percentile over a small sample. Median, not mean: one GC pause or one
// scheduler steal from a co-tenant probe skews a mean of ~20 windows badly.
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const r4 = (v) => (v == null ? null : +v.toFixed(4));

// ---- hermetic snapshot ------------------------------------------------------
// Sibling agents relink gamecube/dolphin_libretro while a campaign is in flight
// — MEASURED here on 2026-09-04: the worker .wasm md5 went e4a2abd0… ->
// 82bc8f8b… between two of this rig's own cells. A torn .js/.wasm pair reads as
// "WebAssembly.instantiate(): Import #0 \"env\": module is not an object or
// function", i.e. like an emulator bug. So the whole campaign is served from a
// symlink farm whose link outputs are REAL COPIES and therefore frozen.
// SNAPSHOT=0 measures the live tree instead (and says so).
function makeSnapshot() {
  if (process.env.SNAPSHOT === '0') return { root: REPO, frozen: false };
  const snap = path.join(OUT, 'snap');
  const COPY = ['dolphin_libretro', 'recomp', 'ppc-worker'];
  sh(`rm -rf ${JSON.stringify(snap)} && mkdir -p ${JSON.stringify(snap)}/gamecube`);
  for (const e of fs.readdirSync(REPO)) {
    if (e === 'gamecube') continue;
    fs.symlinkSync(path.join(REPO, e), path.join(snap, e));
  }
  for (const e of fs.readdirSync(path.join(REPO, 'gamecube'))) {
    if (COPY.includes(e)) continue;
    fs.symlinkSync(path.join(REPO, 'gamecube', e), path.join(snap, 'gamecube', e));
  }
  for (const e of COPY) {
    const r = sh(`cp -R ${JSON.stringify(path.join(REPO, 'gamecube', e))} ${JSON.stringify(path.join(snap, 'gamecube', e))}`);
    if (r.status !== 0) console.log(`  snapshot copy of gamecube/${e} failed: ${r.stderr}`);
  }
  return { root: snap, frozen: true };
}

function runCell(cell) {
  const log = path.join(OUT, `${cell.name}.log`);
  const json = path.join(OUT, `${cell.name}.rows.json`);
  const shot = path.join(OUT, `${cell.name}.png`);

  console.log(`\n=== [${cell.name}] ${cell.note}`);
  if (cell.state && !fs.existsSync(cell.state)) {
    console.log(`  SKIPPED — state file missing: ${cell.state}`);
    return { cell: cell.name, skipped: `state missing: ${cell.state}` };
  }

  const reap = sh(`${NODE} tools/browser_leak_guard.js reap`);
  console.log('  ' + (reap.stdout || '').trim().split('\n')[0]);
  const upBefore = load1();
  const wasmBefore = md5(SNAP_WASM), jsBefore = md5(SNAP_JS);
  console.log(`  before: ${upBefore}`);
  console.log(`  wasm md5 ${wasmBefore}  js md5 ${jsBefore}  (root ${SNAP.frozen ? 'FROZEN snapshot' : 'LIVE TREE'})`);

  // Screenshot near the end of the measured window — CLAUDE.md gate #10 makes a
  // screenshot mandatory evidence for any "I measured scene X" claim.
  const shotAt = cell.ms - 12000;
  const env = [
    'PROBE_HEADLESS=0',
    `ROM_IDX=${cell.rom}`,
    `PROBE_DURATION_MS=${cell.ms}`,
    'PROBE_SCENE_RATE=5000',
    `PROBE_SCENE_RATE_JSON=${json}`,
    `PROBE_SHOT=${shot}@${shotAt}`,
    cell.query ? `PROBE_QUERY=${JSON.stringify(cell.query)}` : null,
    cell.state ? `PROBE_LOAD_STATE=${JSON.stringify(cell.state)}` : null,
    cell.state ? `PROBE_LOAD_STATE_MS=${cell.stateMs}` : null,
    cell.state ? 'PROBE_RESTORE_WITNESS=1' : null,
  ].filter(Boolean).join(' ');

  const cmd = `bash tools/probe_lock.sh run -- env PROBE_ROOT=${JSON.stringify(SNAP.root)} ${env} ${NODE} gamecube/tools/dolphin_render_probe.js > ${JSON.stringify(log)} 2>&1`;
  const t0 = Date.now();
  const r = sh(cmd);
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const upAfter = load1();
  const wasmAfter = md5(SNAP_WASM), jsAfter = md5(SNAP_JS);
  console.log(`  probe exit=${r.status} wall=${wall}s`);
  console.log(`  after:  ${upAfter}`);
  if (wasmAfter !== wasmBefore || jsAfter !== jsBefore) {
    console.log(`  !! WORKER CHANGED MID-RUN (wasm ${wasmBefore}->${wasmAfter}, js ${jsBefore}->${jsAfter}) — VOID`);
  }
  return analyse(cell, { log, json, shot, upBefore, upAfter, wasmBefore, wasmAfter, jsBefore, jsAfter, exit: r.status, wall });
}

function analyse(cell, io) {
  const out = { cell: cell.name, rom: cell.rom, note: cell.note, query: cell.query || '(none)',
                state: cell.state || null, ...io };
  const txt = fs.existsSync(io.log) ? fs.readFileSync(io.log, 'utf8') : '';
  out.logLines = txt ? txt.split('\n').length : 0;
  out.shotExists = fs.existsSync(io.shot);

  // --- restore proof (gate #10: "loaded N bytes" proves nothing) -------------
  if (cell.state) {
    const m = txt.match(/PROBE_LOAD_STATE @\d+ms -> ([^\n]*)/);
    out.restoreLine = m ? m[1] : null;
    out.restoreAck = m ? /worker ack ok=true/.test(m[1]) : false;
    // Worker-independent proof: the credited clock is REPLACED by the saved
    // run's clock on a restore, so a restore is a step discontinuity in a
    // signal that is otherwise monotone. Read it out of the scene-rate rows,
    // which sample the same 0x026B3424/28 pair.
    out.restoreDiscontinuity = null;
  }

  // --- rows ------------------------------------------------------------------
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(io.json, 'utf8')); } catch (_e) { rows = []; }
  out.windows = rows.length;
  if (!rows.length) { out.verdict = 'NO ROWS — probe produced no scene-rate windows'; return out; }

  if (cell.state) {
    // A restore rewrites 24MB of MEM1 and swaps the credited clock; the window
    // that straddles it therefore reports a meaningless rate. Find it and
    // measure only AFTER it.
    let step = null;
    for (let i = 1; i < rows.length; i++) {
      const t = rows[i].tsec * 1000;
      if (t < cell.stateMs - 1000) continue;
      // credMHz collapses or explodes across the restore boundary
      const a = rows[i - 1].credMHz || 0, b = rows[i].credMHz || 0;
      if (t <= cell.stateMs + 25000 && (b < 0.2 * a || b > 5 * a + 10)) { step = rows[i].tsec; break; }
    }
    out.restoreDiscontinuity = step;
  }

  // Steady window: skip boot/restore transients. Cold cells drop the first 45s;
  // state cells drop everything up to restore + 25s.
  const from = cell.state ? (cell.stateMs / 1000 + 25) : 45;
  const steady = rows.filter((r) => r.tsec >= from);
  out.steadyFrom = from;
  out.steadyWindows = steady.length;
  if (!steady.length) { out.verdict = 'NO STEADY WINDOWS'; return out; }

  const parked = steady.filter((r) => r.dolphinParked).length;
  out.parkedWindows = parked;
  out.path = steady.map((r) => r.path).filter(Boolean).pop() || null;

  const col = (k) => steady.map((r) => r[k]).filter((v) => v != null && Number.isFinite(v));
  const agg = (k) => { const a = col(k); return a.length ? { n: a.length, p10: r4(pct(a, 0.1)), med: r4(pct(a, 0.5)), p90: r4(pct(a, 0.9)) } : null; };

  out.W1_ai_dma_cb = agg('gAi');
  out.W2_aid_fire = agg('gAid');
  out.W3_global_timer = agg('gCred');
  out.spread = agg('spread');
  out.idleSkipFrac = agg('idleFrac');
  out.drawnPerS = agg('drawn');
  out.publishedPerS = agg('pub');
  // W4 reads MP4's OWN symbols (GlobalCounter 0x801D3A54, retraceCount
  // 0x801D4428, config/GMPE01_00/symbols.txt:5145,5782). On any other disc those
  // addresses are unrelated data and read a CONSTANT — which comes out as a rate
  // of exactly 0/s and reads like "the guest is dead". Gate on the ROM so a
  // meaningless address is reported as N/A, never as a measurement.
  out.W4_applies = cell.rom === 0;
  out.W4_guestGCPerS = out.W4_applies ? agg('gcps') : null;
  out.W4_retracePerS = out.W4_applies ? agg('rtps') : null;
  out.hz = steady.map((r) => r.hz).pop();
  out.aiPeriod = steady.map((r) => r.aiPer).pop();
  out.numBlocks = steady.map((r) => r.nblk).pop();
  out.hwAiPerS = steady.map((r) => r.hzAi).pop();
  out.hwAidPerS = steady.map((r) => r.hzAid).pop();
  out.pageSpeed = agg('speed');
  out.creditedMHz = agg('credMHz');
  out.executedMHz = agg('execMHz');
  // Executed cycles as a fraction of a real 486 MHz Gekko. THIS IS NOT THE GUEST
  // CLOCK and must never be printed as one — it is what the JIT actually did,
  // with the idle-skipped time removed. Only meaningful when the meter is armed.
  if (out.idleSkipFrac && out.executedMHz) out.executedVsGekko = r4(out.executedMHz.med / 486);
  out.pageNativeHz = steady.map((r) => (r.rate && r.rate.nativeHz) || null).filter(Boolean).pop() || null;

  // ---- W4 as a RATE, not just a liveness flag -------------------------------
  // retraceCount is bumped by the GUEST's VI retrace ISR, once per VI field.
  // NTSC field rate is 59.94/s, so d(retraceCount)/59.94 is a guest-rate estimate
  // that passes through interrupt delivery and guest ISR execution and touches
  // CoreTiming's global_timer nowhere. Comparing it to W1 is the one comparison
  // in this rig that is not a clock talking to itself. MP4 only.
  if (out.W4_retracePerS && out.W1_ai_dma_cb) {
    const g = out.W4_retracePerS.med / 59.94;
    out.W4_retraceDerivedGuest = r4(g);
    out.W4_vs_W1_relErr = r4(Math.abs(g - out.W1_ai_dma_cb.med) / out.W1_ai_dma_cb.med);
  }

  // ---- W5: the GUEST-RENDER cross-check -------------------------------------
  // W1/W2/W3 are three code paths onto ONE clock (CoreTiming's global_timer), so
  // their agreement proves the callback-period arithmetic and the SAB mirror,
  // NOT that emulated time equals wall time. drawn/s is different in kind:
  // PixelEngineManager::SetFinish (PixelEngine.cpp:266-268) is called from the
  // VIDEO thread when the GUEST's GX stream finishes a frame, and a VI-locked
  // title emits exactly nativeFps frames per emulated second. So
  //     drawn/s ÷ guest-rate  ==  the title's native frame rate
  // is a prediction the host clock cannot fake. Report the IMPLIED native fps
  // rather than hardcoding 60/30: if it lands on a real VI-locked rate the two
  // witness families corroborate each other; if it does not, either the game is
  // dropping frames or a witness is wrong — and the rig says which it cannot
  // tell apart.
  const implied = steady.map((r) => (r.gAi && r.drawn != null && r.gAi > 0.02 ? r.drawn / r.gAi : null))
                        .filter((v) => v != null && Number.isFinite(v));
  if (implied.length) {
    const med = pct(implied, 0.5);
    out.W5_impliedNativeFps = { n: implied.length, p10: r4(pct(implied, 0.1)), med: r4(med), p90: r4(pct(implied, 0.9)) };
    const candidates = [60, 59.94, 30, 29.97, 20, 15];
    let best = null;
    for (const c of candidates) { const e = Math.abs(med - c) / c; if (best == null || e < best.err) best = { fps: c, err: e }; }
    out.W5_nearestVIRate = best.fps;
    out.W5_errVsNearest = r4(best.err);
    out.W5_corroborates = best.err <= 0.05;
  }

  // --- verdict ---------------------------------------------------------------
  const notes = [];
  if (parked === steady.length) {
    // Two very different causes produce the same zero. Distinguish them or the
    // reader will assume the benign one.
    if (out.path === 'recomp') {
      out.verdict = 'DOLPHIN CORETIMING PARKED (recomp path) — W1/W2/W3 do not apply, this is NOT 0.000x';
      notes.push('the recomp worker owns the game; dolphin CoreTiming never advances by design. Read the recomp path with the page\'s own rate model, not with these witnesses.');
    } else {
      out.verdict = `DEAD/WEDGED on path=${out.path} — 0 AI-DMA callbacks AND 0 credited cycles AND drawn=${out.drawnPerS ? out.drawnPerS.med : '?'}/s`;
      notes.push('the JIT path is supposed to advance CoreTiming. Zero on all four witnesses with zero drawn/s is a dead core, not a slow one.');
    }
  } else if (parked > 0) {
    notes.push(`${parked}/${steady.length} steady windows had dolphin parked — mixed path, treat the aggregate with suspicion`);
  }
  if (out.spread && out.spread.p90 != null && out.spread.p90 > 0.01) {
    notes.push(`WITNESS DISAGREEMENT: p90 spread ${out.spread.p90} between W1/W2/W3 — they share one clock, so a spread means a sampling artifact, not a real difference`);
  }
  if (!out.idleSkipFrac) {
    notes.push('idle-skip fraction UNMEASURED (executed-cycle meter off — add bjit_mips=1). This is NOT 0% idle.');
  }
  if (out.W4_retraceDerivedGuest != null) {
    notes.push(`W4 INDEPENDENT: guest retraceCount ${out.W4_retracePerS.med}/s ÷ 59.94 = ${out.W4_retraceDerivedGuest}x vs W1 ${out.W1_ai_dma_cb.med}x — ${(100 * out.W4_vs_W1_relErr).toFixed(2)}% apart. This one does NOT share a clock with W1/W2/W3.`);
  }
  if (out.W5_impliedNativeFps) {
    notes.push(out.W5_corroborates
      ? `W5 CORROBORATES: drawn/s ÷ W1 implies a native ${out.W5_impliedNativeFps.med} fps, ${(100 * out.W5_errVsNearest).toFixed(1)}% off the VI-locked ${out.W5_nearestVIRate} fps — an independent (guest-render, not host-clock) confirmation`
      : `W5 DOES NOT corroborate: drawn/s ÷ W1 implies ${out.W5_impliedNativeFps.med} fps, ${(100 * out.W5_errVsNearest).toFixed(1)}% off the nearest VI-locked rate (${out.W5_nearestVIRate}). Either the title drops frames in this scene or a witness is wrong — this rig cannot tell those apart.`);
  }
  if (out.drawnPerS && out.drawnPerS.med === 0) {
    notes.push('drawn/s = 0 — the run is WEDGED regardless of what the rate witnesses say (gate #10)');
  }
  if (cell.state && !out.restoreAck) {
    notes.push('RESTORE NOT PROVEN — the worker did not ack ok=true; this may be a silent COLD BOOT');
  }
  out.notes = notes;
  if (!out.verdict) out.verdict = notes.length ? 'MEASURED with caveats' : 'MEASURED';
  return out;
}

// ---- truth table ------------------------------------------------------------
function report(results) {
  const outFile = path.join(OUT, 'guest-rate-truth-table.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  const f = (a) => (a ? String(a.med) : '--');
  const fp = (a) => (a ? (100 * a.med).toFixed(1) + '%' : 'METER-OFF');
  console.log('\n\n================ GUEST-RATE TRUTH TABLE ================');
  console.log('cell                 path      W1      W2      W3    spread  idle-skip   drawn/s  pub/s  wins  W5impliedFps');
  for (const r of results) {
    if (r.skipped) { console.log(`${r.cell.padEnd(20)} SKIPPED: ${r.skipped}`); continue; }
    console.log(
      r.cell.padEnd(20) +
      String(r.path || '?').padEnd(9) +
      String(f(r.W1_ai_dma_cb)).padStart(7) +
      String(f(r.W2_aid_fire)).padStart(8) +
      String(f(r.W3_global_timer)).padStart(8) +
      String(r.spread ? r.spread.p90 : '--').padStart(9) +
      String(fp(r.idleSkipFrac)).padStart(11) +
      String(f(r.drawnPerS)).padStart(10) +
      String(f(r.publishedPerS)).padStart(7) +
      String(r.steadyWindows).padStart(6) +
      String(r.W5_impliedNativeFps ? `${r.W5_impliedNativeFps.med}${r.W5_corroborates ? ' ok' : ' XX'}` : '--').padStart(15));
  }
  console.log('\nnotes:');
  for (const r of results) {
    if (r.skipped) continue;
    console.log(`  [${r.cell}] ${r.verdict}`);
    for (const n of r.notes || []) console.log(`      - ${n}`);
    console.log(r.W4_applies
      ? `      W4 guest-side: GlobalCounter ${f(r.W4_guestGCPerS)}/s  retraceCount ${f(r.W4_retracePerS)}/s`
      : '      W4 guest-side: N/A — the symbols are MP4\'s; this disc has no known guest counter');
    console.log(`      load before: ${r.upBefore}`);
    console.log(`      load after : ${r.upAfter}`);
    console.log(`      wasm md5 ${r.wasmBefore} -> ${r.wasmAfter}${r.wasmBefore !== r.wasmAfter ? '  !! CHANGED — VOID' : ''}`);
    if (r.state) console.log(`      restore: ack=${r.restoreAck} line="${r.restoreLine}" discontinuity@${r.restoreDiscontinuity}s  shot=${r.shotExists}`);
  }
  console.log(`\nfull JSON -> ${outFile}`);
  if (args.includes('--markdown')) {
    console.log('\n\n<!-- --markdown: paste into gamecube/docs/guest-rate-witness/TASKS.md -->\n');
    console.log('| cell | path | W1 `ai_dma_cb` | W2 `aid_fire` | W3 `global_timer` | max spread | idle-skip | drawn/s | published/s | W4 retrace→guest | W5 implied fps |');
    console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of results) {
      if (r.skipped) { console.log(`| \`${r.cell}\` | — | SKIPPED: ${r.skipped} | | | | | | | | |`); continue; }
      const g = (a) => (a ? `${a.med}x` : '—');
      const n = (a) => (a ? String(a.med) : '—');
      console.log(`| \`${r.cell}\` | ${r.path || '?'} | ${g(r.W1_ai_dma_cb)} | ${g(r.W2_aid_fire)} | ${g(r.W3_global_timer)} | ${r.spread ? r.spread.p90 : '—'} | ${r.idleSkipFrac ? (100 * r.idleSkipFrac.med).toFixed(1) + '%' : '**METER-OFF**'} | ${n(r.drawnPerS)} | ${n(r.publishedPerS)} | ${r.W4_retraceDerivedGuest != null ? `${r.W4_retraceDerivedGuest}x (${(100 * r.W4_vs_W1_relErr).toFixed(2)}% off W1)` : (r.W4_applies ? '—' : 'n/a (MP4 symbols)')} | ${r.W5_impliedNativeFps ? `${r.W5_impliedNativeFps.med}${r.W5_corroborates ? ' ✓' : ' ✗'}` : '—'} |`);
    }
    console.log('\n| cell | guest clock (W1) | credited MHz | **executed MHz** | executed ÷ 486 MHz Gekko |');
    console.log('|---|---:|---:|---:|---:|');
    for (const r of results) {
      if (r.skipped || !r.executedVsGekko) continue;
      console.log(`| \`${r.cell}\` | ${r.W1_ai_dma_cb.med}x | ${r.creditedMHz.med} | **${r.executedMHz.med}** | **${r.executedVsGekko}x** |`);
    }
  }
}

// --reanalyse recomputes the truth table from rows already on disk. Analysis is
// pure — it never touches the browser — so a new derived column can be added
// without re-running (and re-perturbing) a whole campaign.
const REANALYSE = args.includes('--reanalyse');
if (REANALYSE) {
  const results = [];
  for (const cell of CELLS) {
    if (only && !only.has(cell.name)) continue;
    const io = { log: path.join(OUT, `${cell.name}.log`), json: path.join(OUT, `${cell.name}.rows.json`),
                 shot: path.join(OUT, `${cell.name}.png`), upBefore: '(reanalyse)', upAfter: '(reanalyse)',
                 wasmBefore: '(reanalyse)', wasmAfter: '(reanalyse)', exit: null, wall: null };
    if (!fs.existsSync(io.json)) { console.log(`skip ${cell.name}: no rows on disk`); continue; }
    results.push(analyse(cell, io));
  }
  report(results);
  process.exit(0);
}

const SNAP = makeSnapshot();
const SNAP_WASM = path.join(SNAP.root, 'gamecube/dolphin_libretro/dolphin_worker_emcc.wasm');
const SNAP_JS = path.join(SNAP.root, 'gamecube/dolphin_libretro/dolphin_worker_emcc.js');
console.log(`root = ${SNAP.root} (${SNAP.frozen ? 'FROZEN snapshot — link outputs are real copies' : 'LIVE TREE — a sibling relink can void a run'})`);
console.log(`live repo worker md5 = ${md5(WORKER_WASM)}   snapshot worker md5 = ${md5(SNAP_WASM)}`);
console.log(`node = ${process.execPath} (${process.version})`);

const results = [];
for (const cell of CELLS) {
  if (only && !only.has(cell.name)) continue;
  results.push(runCell(cell));
}

report(results);

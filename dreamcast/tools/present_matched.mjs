#!/usr/bin/env node
// ============================================================================
// present_matched.mjs — DOES THE LOCKSTEP GATE COST PRESENTED FRAMES?
// ============================================================================
//
// WHY THIS EXISTS. The blocker was handed over as "four gated cores advanced
// ~23 frames/s against ~45 run_iter/s for one solo core". That comparison
// differs in THREE variables at once and cannot separate any of them:
//
//   1. LOAD          — four browsers at load 10.33 vs one at 2.4.
//   2. SCENE         — the gated figure spanned the boot from frame 0; the solo
//                      figure came from a settled attract window.
//   3. WHAT IS COUNTED — `run_iter/s` is video_cb CALLS/s, and Gauntlet's dupe
//                      fraction is scene-dependent (measured 13.3% settled vs
//                      20.3% including boot, /tmp/probe-dcx-pr-solo.log). So
//                      calls/s moves between scenes even at a fixed guest rate.
//
// CLAUDE.md gate #10 is explicit that comparing across unmatched arms has
// produced wrong conclusions in this repo repeatedly. So this rig holds all
// three fixed and moves exactly ONE thing: whether the room's frame gate is on.
//
//   ARM U (--gated 0):  N browsers, each booting its own core, NO room, NO
//                       transport, NO gate. Free-running governor.
//   ARM G (--gated 1):  N browsers in ONE room, every core frame-gated on every
//                       seated player's input.
//
// Everything else is identical BY CONSTRUCTION: same N (so the same CPU
// contention), same disc, same adaptive drive past the title card, same settle,
// same measurement window, same box, back to back.
//
// THE INSTRUMENT IS THE CORE'S OWN HEARTBEAT, not a page counter and not the
// canvas sampler. EmscriptenWorker.cpp:571-581 prints, about once a second:
//
//   [vbl] n=.. vbi=.. cyc=<guest cycles> t=<wall ms> dt=.. win=../s
//         wguest=<guest ratio>x pred=../s wdelta=..% fcyc=.. calls=N pres=M
//
//   * `calls` = retro_run invocations (libretro.cpp calls video_cb exactly once
//     per retro_run, unconditionally).
//   * `pres`  = the subset that carried a real frame. calls - pres = libretro's
//     dupe sentinel, i.e. retro_runs that produced NO new image.
//   * `cyc`   = the monotonic guest cycle counter, so the guest rate over the
//     window is (Δcyc / 200e6) / (Δt / 1000) — computed over the WHOLE window
//     rather than averaging the core's per-second `wguest`, because a mean of
//     ratios is not the ratio over the span.
//
// ⚠ PRESENTS/s IS THE PLAYER-FACING NUMBER, CALLS/s IS NOT. A retro_run that
// emits a dupe advances `calls` and shows the player nothing. Both are reported
// here; quote presents/s when the question is "what does a player see".
//
// ⚠ AND THE GUEST RATE IS THE ACCEPTANCE GATE, NOT A STATISTIC (CLAUDE.md #9).
// A change that raises presents/s by running the guest FASTER than 1.000x is a
// regression, not a fix, and this rig prints the guest ratio beside every rate
// so the two can never be quoted apart.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web
//   bash tools/probe_lock.sh run -- node dreamcast/tools/present_matched.mjs \
//        --players 4 --gated 1 --name g4
//   bash tools/probe_lock.sh run -- node dreamcast/tools/present_matched.mjs \
//        --players 4 --gated 0 --name u4
//
// FLAGS
//   --players N   browsers in this arm (default 4). Contention is the N-trend.
//   --gated 0|1   the ONE variable. 1 = room + frame gate, 0 = solo free-run.
//   --measure MS  measurement window after the settle (default 30000).
//   --settle MS   quiet time between the drive and the window (default 25000).
//   --name X      artifacts land at /tmp/dc-e2e/X.{log,json}.
// ============================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const PLAYERS   = Math.max(1, parseInt(arg('players', '4'), 10));
const GATED     = arg('gated', '1') === '1';
const GAME      = arg('game', 'gauntlet');
const NAME      = arg('name', (GATED ? 'g' : 'u') + PLAYERS);
const ORIGIN    = arg('url', 'http://localhost:8080');
const PROFBASE  = arg('profile-base', '/private/tmp/claude-501/dc-pm');
const HEADFUL   = has('headful');
const MEASURE_MS= parseInt(arg('measure', '30000'), 10);
const SETTLE_MS = parseInt(arg('settle', '25000'), 10);
const BOOT_MS   = parseInt(arg('bootms', '900000'), 10);
const PAIR_MS   = parseInt(arg('pairms', '120000'), 10);
const CHROME    = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SH4_HZ    = 200000000;   // flycast_worker.js:332; EmscriptenWorker.cpp:91

const OUT = '/tmp/dc-e2e';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); logStream.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };

const RESULT = {
  when: new Date().toISOString(), arm: GATED ? 'gated' : 'ungated', players: PLAYERS, game: GAME,
  measureMs: MEASURE_MS, settleMs: SETTLE_MS,
  uptimeStart: execSync('uptime').toString().trim(), loadavgStart: os.loadavg(),
  wasm: null, code: null, perMachine: [], notes: [],
};

const wasmPath = path.join(REPO, 'dreamcast', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const hashOf = (p) => { try { return execSync(`shasum -a 256 ${JSON.stringify(p)}`).toString().slice(0, 16); } catch (e) { return 'missing'; } };
const wasmBefore = hashOf(wasmPath);

const browsers = [], pages = [], vbl = [];

say(`present_matched — arm=${RESULT.arm} players=${PLAYERS} game=${GAME}`);
say(`  uptime      ${RESULT.uptimeStart}`);
say(`  wasm        ${wasmBefore}`);

async function launch(i) {
  const dir = path.join(PROFBASE, NAME, 'p' + i);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: HEADFUL ? false : 'new', userDataDir: dir,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
      '--disk-cache-size=1073741824'],
  });
  try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(b, 'present_matched'); }
  catch (e) { say('  ⚠ leak-guard registration FAILED: ' + (e.message || e)); }
  browsers.push(b);
  const pg = (await b.pages())[0];
  const mine = []; vbl[i] = mine;
  // THE INSTRUMENT. Every [vbl] heartbeat this machine prints, with the wall
  // clock this rig saw it at, so a window can be cut on either clock.
  pg.on('console', (m) => {
    const t = m.text();
    const hit = /\[vbl\] n=(\d+) .*cyc=(\d+(?:\.\d+)?) t=(\d+(?:\.\d+)?) .*wguest=([\d.]+)x .*calls=(\d+) pres=(\d+)/.exec(t);
    // `n` is spg_vblank_frames — DELIVERED VIDEO FIELDS. fields/present is what
    // separates "the game is 30 fps content" from "we are dropping every other
    // frame": a 30 fps game on a 60 Hz field clock reads exactly 2.0000.
    if (hit) mine.push({ host: Date.now(), n: +hit[1], cyc: +hit[2], t: +hit[3], wguest: +hit[4], calls: +hit[5], pres: +hit[6] });
  });
  await pg.setViewport({ width: 1100, height: 780 });
  try { const cdp = await pg.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  pages.push(pg);
  return pg;
}
async function gotoSettled(pg, url) {
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await sleep(2500);
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
}
async function until(pg, fn, ms, every = 500) {
  const t = Date.now();
  for (;;) {
    let v = null; try { v = await pg.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(every);
  }
}
const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) { e.click(); return true; } return false; }, sel);

// The picture sampler, byte-for-byte the one netplay_room_e2e.mjs installs, so
// "distinct signatures" means the same thing in both rigs.
async function installSampler(pg) {
  await pg.evaluate(() => {
    if (window.__e2e) return;
    const W = 24, H = 18;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true, alpha: false });
    const S = window.__e2e = { sigs: [], err: null, n: 0 };
    const tick = () => {
      const src = document.getElementById('dc-canvas');
      try {
        g.drawImage(src, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let acc = 0, nb = 0, sig = '';
        for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; acc += l; if (d[i] | d[i + 1] | d[i + 2]) nb++; }
        for (let b = 0; b < 6; b++) {
          let s = 0, n = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (((y < H / 2 ? 0 : 3) + ((x * 3 / W) | 0)) !== b) continue;
            const k = (y * W + x) * 4; s += (d[k] + d[k + 1] + d[k + 2]) / 3; n++;
          }
          sig += Math.round(s / Math.max(1, n)) + '.';
        }
        S.sigs.push({ t: Date.now(), sig, nb, mean: Math.round(acc / (W * H)) });
        if (S.sigs.length > 8000) S.sigs.shift();
        S.n++;
      } catch (e) { S.err = String((e && e.message) || e); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const tap = async (pg, key) => {
  await pg.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); }, key);
  await sleep(120);
  await pg.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keyup', { key: k })); }, key);
};

(async () => {
  // ---- 1. open the page on every machine ----------------------------------
  say(`\n== 1. ${PLAYERS} browser(s) open the page ==`);
  for (let i = 0; i < PLAYERS; i++) await launch(i);
  await Promise.all(pages.map((pg) => gotoSettled(pg, ORIGIN + '/dreamcast.html')));
  await Promise.all(pages.map((pg) => until(pg, () => (typeof window.__dcProbe === 'function') || null, 90000)));
  for (const pg of pages) await installSampler(pg);

  // ---- 2. the ONE variable: form a room, or do not -------------------------
  if (GATED) {
    say('\n== 2. P1 opens a room; the rest join (THE GATED ARM) ==');
    await pages[0].evaluate((g) => { const el = document.querySelector('#romSelect'); if (el) { el.value = g; el.dispatchEvent(new Event('change')); } }, GAME);
    await click(pages[0], '#btnNet');
    await click(pages[0], '#netHostBtn');
    const code = await until(pages[0], () => {
      const t = (document.getElementById('netCode').textContent || '').trim();
      return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;
    }, 45000);
    RESULT.code = code;
    if (!code) { say('  ⚠ no room code — ABORTING, a gated arm without a room is not a gated arm'); process.exit(2); }
    say(`  ....  room ${code}`);
    for (let i = 1; i < PLAYERS; i++) {
      await click(pages[i], '#btnNet');
      await click(pages[i], '#netJoinBtn');
      await pages[i].evaluate((g) => { const el = document.querySelector('#netGame'); if (el) el.value = g; }, GAME);
      await pages[i].click('#netCodeIn');
      await pages[i].type('#netCodeIn', code, { delay: 20 });
      await click(pages[i], '#netGo');
      const prompt = await until(pages[0], () => (document.getElementById('npApproveAllow') ? true : null), 45000, 400);
      if (prompt) await pages[0].evaluate(() => document.getElementById('npApproveAllow').click());
      await sleep(1200);
    }
    const conn = await Promise.all(pages.map((pg) => until(pg, () => (window.__dcNet().state === 'connected') || null, PAIR_MS, 500)));
    if (!conn.every(Boolean)) { say(`  ⚠ not everyone connected: ${J(conn)} — ABORTING`); process.exit(2); }
    say(`  ....  all ${PLAYERS} connected`);
  } else {
    say(`\n== 2. NO room, NO transport, NO gate — ${PLAYERS} independent cores (THE UNGATED ARM) ==`);
  }

  // ---- 3. everyone boots the same disc -------------------------------------
  say(`\n== 3. all ${PLAYERS} machines boot "${GAME}" ==`);
  for (const pg of pages) {
    await pg.evaluate((g) => { const el = document.querySelector('#romSelect'); if (el) { el.value = g; el.dispatchEvent(new Event('change')); } }, GAME);
  }
  for (const pg of pages) await click(pg, '#btnStart');
  const bootDeadline = Date.now() + BOOT_MS;
  for (let i = 0; i < PLAYERS; i++) {
    // A gated core parks on frame 0 with fps=0 by design, so "booted" cannot
    // require frames here — that is what the gate DOES before the barrier.
    const v = await until(pages[i], () => {
      const p = window.__dcProbe();
      let ls = null;
      try { const n = window.__dcNet(); ls = (n && n.lockstep) || null; } catch (e) {}
      const parked = !!(ls && ls.armed);
      return (p.booted && (parked || p.fps > 0 || p.framesEver)) ? p : null;
    }, Math.max(30000, bootDeadline - Date.now()), 2000);
    if (!v) { say(`  ⚠ P${i + 1} never booted — ABORTING`); process.exit(2); }
    say(`  ....  P${i + 1} booted`);
  }

  // ---- 3b. RELEASE THE START BARRIER (gated arm only) ----------------------
  // ⚠ SOMEBODY HAS TO PRESS READY. Under lockstep the page arms the frame gate
  // between the disc load and {cmd:'freerun',on:1}, so every core parks on an
  // EMPTY queue at frame 0 until the last player declares ready. Skipping this
  // does not produce a slow room — it produces four cores that have run zero
  // frames, emit no [vbl] heartbeat at all, and hold a static picture. Measured
  // here first time out: 0 samples and distinct signatures [1,1,1,1] after 90 s
  // of key taps. That is the barrier working, not a wedge.
  if (GATED) {
    const readyPath = [];
    for (let i = 0; i < PLAYERS; i++) {
      readyPath.push(await pages[i].evaluate(() => {
        const b = document.getElementById('netReady');
        if (b && !b.disabled && b.style.display !== 'none') { b.click(); return 'button'; }
        const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
        if (s && typeof s.setReady === 'function') { s.setReady(true); return 'api'; }
        return 'none';
      }));
      await sleep(500);
    }
    await sleep(2000);
    const st = await Promise.all(pages.map((pg) => pg.evaluate(() => {
      const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
      return s && s.ls ? s.ls.state : null;
    })));
    say(`  ....  ready via ${J(readyPath)} — engine states ${J(st)}`);
    if (!st.every((s) => s === 'running' || s === 'stalled')) {
      say('  ⚠ the barrier did not release — ABORTING rather than measuring four parked cores');
      process.exit(2);
    }
  }

  // ---- 4. drive past the title card, ADAPTIVELY ----------------------------
  // Gauntlet's copyright card is a static image and its attract loop ignores
  // input for a while; a fixed tap count photographs a still screen. Identical
  // loop in both arms, so the scene reached is the same by construction.
  const moving = async () => Promise.all(pages.map((pg) => pg.evaluate(() => {
    const S = window.__e2e || { sigs: [] };
    const recent = S.sigs.slice(-150);
    return new Set(recent.map((x) => x.sig)).size;
  })));
  let drove = 0, sig = await moving();
  for (let k = 0; k < 45 && !sig.every((n) => n >= 8); k++) {
    for (const pg of pages) await tap(pg, 'Enter');
    await sleep(2000);
    drove += 2;
    if ((k % 3) === 2) sig = await moving();
  }
  for (const pg of pages) await tap(pg, 'm');
  say(`  ....  drove ${drove} s past the boot; distinct signatures ${J(await moving())}`);

  // ---- 5. settle, then measure --------------------------------------------
  say(`  ....  settling ${(SETTLE_MS / 1000) | 0} s before the window opens`);
  await sleep(SETTLE_MS);

  const markIdx = vbl.map((v) => v.length);          // window opens here
  const loadAtOpen = os.loadavg();
  say(`\n== 4. MEASURING ${(MEASURE_MS / 1000) | 0} s (load1 at open ${loadAtOpen[0].toFixed(2)}) ==`);
  await sleep(MEASURE_MS);
  const loadAtClose = os.loadavg();

  // ---- 6. read the window off the core's own heartbeat ---------------------
  // ⚠ THE GATE STATE IS CAPTURED WHOLESALE, NOT FIELD BY FIELD. Cherry-picking
  // names invents fields that do not exist and reports them as undefined, which
  // reads like a missing feature. window.__dcNet().lockstep is the seam
  // netplay_room_e2e.mjs:542 uses; the hud's telemetry rides along beside it.
  const gate = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    let ls = null, tel = null;
    try { const n = window.__dcNet(); ls = (n && n.lockstep) || null; } catch (e) {}
    try { const h = window.__dcNetHud(); tel = (h && h.telemetry) || null; } catch (e) {}
    const p = window.__dcProbe();
    const S = window.__e2e || { sigs: [] };
    const recent = S.sigs.slice(-300);
    const span = recent.length > 1 ? (recent[recent.length - 1].t - recent[0].t) : 0;
    return {
      iters: p.iters, fps: p.fps, guestXPage: p.guestX, headline: p.headline,
      sampler: { n: recent.length, spanMs: span,
                 distinct: new Set(recent.map((x) => x.sig)).size,
                 sampleHz: span > 0 ? +(1000 * (recent.length - 1) / span).toFixed(2) : null },
      ls, tel,
    };
  })));

  for (let i = 0; i < PLAYERS; i++) {
    const all = vbl[i], a = all[markIdx[i]], b = all[all.length - 1];
    const label = `P${i + 1}`;
    if (!a || !b || b === a) {
      say(`  ${label}  NO HEARTBEAT IN THE WINDOW — ${all.length} samples total, window opened at index ${markIdx[i]}. ` +
          'A core that prints no [vbl] in 30 s is stopped; this machine reports no rate rather than a zero.');
      RESULT.perMachine.push({ label, void: true, samples: all.length, gate: gate[i] });
      continue;
    }
    const dt = (b.t - a.t) / 1000;                       // worker clock, seconds
    const dCalls = b.calls - a.calls, dPres = b.pres - a.pres, dCyc = b.cyc - a.cyc;
    const dFields = b.n - a.n;
    const guestX = (dCyc / SH4_HZ) / dt;
    const m = {
      label, windowS: +dt.toFixed(3), samples: all.length - markIdx[i],
      callsPerS: +(dCalls / dt).toFixed(4),
      presentsPerS: +(dPres / dt).toFixed(4),
      dupePct: dCalls ? +(((dCalls - dPres) / dCalls) * 100).toFixed(3) : null,
      fieldsPerS: +(dFields / dt).toFixed(4),
      fieldsPerPresent: dPres ? +(dFields / dPres).toFixed(4) : null,
      guestX: +guestX.toFixed(5),
      wguestMedian: med(all.slice(markIdx[i]).map((x) => x.wguest)),
      gate: gate[i],
    };
    RESULT.perMachine.push(m);
    say(`  ${label}  presents/s ${m.presentsPerS}  calls/s ${m.callsPerS}  dupes ${m.dupePct}%  ` +
        `fields/s ${m.fieldsPerS} (${m.fieldsPerPresent}/present)  ` +
        `guestX ${m.guestX} (wguest median ${m.wguestMedian})  window ${m.windowS}s`);
    if (m.gate.ls) say(`        gate: ${J(m.gate.ls)}`);
    if (m.gate.tel) say(`        tel:  ${J(m.gate.tel)}`);
    say(`        page: iters=${m.gate.iters} fps=${m.gate.fps} | sampler ${m.gate.sampler.distinct} distinct / ` +
        `${m.gate.sampler.n} samples over ${m.gate.sampler.spanMs}ms (${m.gate.sampler.sampleHz} Hz)`);
  }

  const live = RESULT.perMachine.filter((m) => !m.void);
  RESULT.summary = {
    presentsPerS: live.map((m) => m.presentsPerS),
    fieldsPerPresent: live.map((m) => m.fieldsPerPresent),
    callsPerS: live.map((m) => m.callsPerS),
    guestX: live.map((m) => m.guestX),
    medianPresents: med(live.map((m) => m.presentsPerS)),
    medianCalls: med(live.map((m) => m.callsPerS)),
    medianGuestX: med(live.map((m) => m.guestX)),
    loadAtOpen, loadAtClose,
  };
  const wasmAfter = hashOf(wasmPath);
  RESULT.wasm = { before: wasmBefore, after: wasmAfter, stable: wasmBefore === wasmAfter };
  RESULT.uptimeEnd = execSync('uptime').toString().trim();
  RESULT.loadavgEnd = os.loadavg();

  say(`\n== ${RESULT.arm.toUpperCase()} N=${PLAYERS} ==`);
  say(`  presents/s  ${J(RESULT.summary.presentsPerS)}  median ${RESULT.summary.medianPresents}`);
  say(`  calls/s     ${J(RESULT.summary.callsPerS)}  median ${RESULT.summary.medianCalls}`);
  say(`  guestX      ${J(RESULT.summary.guestX)}  median ${RESULT.summary.medianGuestX}`);
  say(`  wasm        ${wasmBefore} -> ${wasmAfter} ${RESULT.wasm.stable ? 'STABLE' : '*** CHANGED — THIS RUN IS VOID ***'}`);
  say(`  uptime@end  ${RESULT.uptimeEnd}`);

  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(RESULT, null, 2));
  say(`  json        ${path.join(OUT, NAME + '.json')}`);
  for (const b of browsers) { try { await b.close(); } catch (e) {} }
  process.exit(0);
})().catch(async (e) => {
  say('FATAL ' + (e && e.stack || e));
  for (const b of browsers) { try { await b.close(); } catch (_) {} }
  process.exit(1);
});

#!/usr/bin/env node
// ps1_determinism_probe.mjs — does the PS1 core execute deterministically?
//
// WHY THIS RUNS BEFORE ANY NETPLAY CODE. Deterministic lockstep is only sound if
// two independent cores, fed the identical ROM and the identical pad bytes per
// emulated frame, stay in identical guest state. Shipping a frame gate over an
// unmeasured core produces two consoles that silently diverge, which is worse
// than no online play because it looks like it is working (ps1.html:1112-1116).
//
// WHAT IT MEASURES. N independent wasmpsx_worker instances in one page, each
// booted from the same bytes, each stepped one frame at a time by an explicit
// message (the gate — see the LOCKSTEP FRAME GATE block appended to
// ps1/ps1Wasm/dist/wasmpsx_worker.js). Every `--every` frames it fingerprints
// each core with FNV-1a over a SAVESTATE — the canonical full guest state — and
// compares.
//
// THE NAMED SUSPECT. plugins/dfxvideo/fps.c FrameCap() derives `updated_display`
// from gettimeofday, and one_iter() gates GPUupdateLace1()+EmuUpdate() on it.
// Whether that path is live in the SHIPPED binary cannot be settled from source
// — the guard is `#ifdef EMSCRIPTEN`, the OLD macro name, while the rest of the
// tree uses `__EMSCRIPTEN__`. The probe reports the scheduler-delay
// distribution (`sched`) so the answer is measured, not argued: a delay that is
// always 0 means `updated_display` never left -1 and the limiter never ran.
//
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/ps1_determinism_probe.mjs
//
// Flags: --frames N (900) --every N (150) --cores N (2) --rom-bytes N (33554432)
//        --rom PATH --url BASE (http://localhost:8080) --name NAME (det)
//        --headful --keep
// Env: CHROME_PATH
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
function flag(n) { return argv.includes('--' + n); }
function arg(n, d) {
  const i = argv.indexOf('--' + n);
  if (i < 0 || i + 1 >= argv.length) return d;
  const v = argv[i + 1];
  if (typeof v === 'string' && v.startsWith('--')) return d;
  return v;
}

const FRAMES = +arg('frames', 900);
const EVERY = +arg('every', 150);
const CORES = +arg('cores', 2);
const ROM_BYTES = +arg('rom-bytes', 33554432);
const ROM = arg('rom', '/ps1/ps1Wasm/roms/MonsterRancher2.bin');
const BASE = arg('url', 'http://localhost:8080');
const NAME = arg('name', 'det');
const SKEW = +arg('skew', 0);
const OUT = '/tmp/ps1-det';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const lines = [];
function say(s) { const t = String(s); lines.push(t); console.log(t); }

function md5(f) {
  try {
    return require('node:crypto').createHash('md5').update(fs.readFileSync(f)).digest('hex');
  } catch (e) { return 'missing'; }
}

const WORKER_JS = 'ps1/ps1Wasm/dist/wasmpsx_worker.js';
const WORKER_WASM = 'ps1/ps1Wasm/dist/wasmpsx_worker.wasm';

const results = { name: NAME, frames: FRAMES, every: EVERY, cores: CORES, romBytes: ROM_BYTES, rom: ROM };

(async () => {
  // CLAUDE.md gate #10: hash-guard the artifact before AND after, and report load.
  results.md5Before = { js: md5(WORKER_JS), wasm: md5(WORKER_WASM) };
  const os = await import('node:os');
  results.loadBefore = os.loadavg().map((x) => +x.toFixed(2));
  results.skewMs = SKEW;
  say('skew: ' + (SKEW > 0 ? SKEW + ' ms' : 'off'));
  say('artifact before: js=' + results.md5Before.js + ' wasm=' + results.md5Before.wasm);
  say('load before: ' + results.loadBefore.join(' '));

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: flag('headful') ? false : 'new',
    args: [
      '--no-sandbox',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
  });
  try {
    const g = (await import('./browser_leak_guard.js')).default;
    if (g && g.guard) g.guard(browser, 'ps1_determinism_probe');
  } catch (e) { say('leak guard not attached: ' + e.message); }

  let verdict = 1;
  try {
    const pg = await browser.newPage();
    pg.on('console', (m) => { const t = m.text(); if (/error|fail|DIVERG/i.test(t)) say('[page] ' + t); });
    pg.on('pageerror', (e) => say('[pageerror] ' + e.message));

    const url = BASE + '/tools/ps1_determinism_harness.html';
    say('opening ' + url);
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await pg.evaluate(
      (o) => window.__start(o),
      { cores: CORES, romUrl: BASE + ROM, romBytes: ROM_BYTES, frames: FRAMES, hashEvery: EVERY, romName: 'probe.bin', skewMs: SKEW },
    );

    // Poll. A multi-minute run inside one evaluate blows CDP's protocolTimeout
    // and reports a rig failure as an emulator failure.
    const deadline = Date.now() + 30 * 60 * 1000;
    let last = '';
    for (;;) {
      const st = await pg.evaluate(() => ({ done: window.__state.done, error: window.__state.error, progress: window.__state.progress }));
      if (st.progress && st.progress !== last) { last = st.progress; say('  … ' + st.progress); }
      if (st.done) { if (st.error) throw new Error(st.error); break; }
      if (Date.now() > deadline) throw new Error('run did not finish within 30 min (last: ' + last + ')');
      await new Promise((r) => setTimeout(r, 500));
    }
    const res = await pg.evaluate(() => window.__state.result);

    results.run = res;
    say('');
    say('booted/ran: framesRan=' + JSON.stringify(res.framesRan));
    if (res.prints) res.prints.forEach((p, i) => say('core' + i + ' last prints: ' + JSON.stringify(p)));

    // The scheduler-delay distribution answers the FrameCap question.
    if (res.sched) {
      say('');
      res.sched.forEach((s, i) => say('core' + i + ' sched: calls=' + s.calls + ' nonZero=' + s.nonZero + ' min=' + s.min + ' max=' + s.max + ' gate=' + s.gate));
      // ⚠ DO NOT OVER-READ THIS. one_iter passes `updated_display / 1000` as an
      // INTEGER division, so a delay of 0 is consistent with BOTH
      // `updated_display == -1` (FrameCap never ran) AND `updated_display == 0`
      // (FrameCap ran and set it at fps.c:84 on entry). This cell therefore
      // proves only that the sleep-hint branch (fps.c:119, tickstogo*10-300)
      // never fired — NOT that the limiter is dead. The determinism question is
      // settled by the SKEW arm below, not by this.
      const anyNonZero = res.sched.some((s) => (s.nonZero | 0) > 0);
      say('reschedule delay nonzero on any call: ' + (anyNonZero ? 'YES — fps.c:119 sleep-hint fired, so FrameCap() is live'
        : 'NO — delay was 0 on all calls (consistent with updated_display == -1 OR == 0; not decisive on its own)'));
      results.schedSleepHintFired = anyNonZero;
    }

    say('');
    const nHash = (res.hashes || []).length;
    const nMatch = (res.hashes || []).filter((h) => h.hash.every((x) => x === h.hash[0]) && h.len.every((l) => l === h.len[0])).length;
    say('fingerprint checkpoints: ' + nMatch + '/' + nHash + ' matched across ' + CORES + ' cores');
    if (res.firstDiverge !== null && res.firstDiverge !== undefined) say('FIRST DIVERGENCE at frame ' + res.firstDiverge);

    // The check is only meaningful if the cores actually ran and actually hashed.
    // An empty framesRan or an empty hash list is a FAILED run, never a pass —
    // `[].every()` is true, which would turn "nothing ran" into a green cell.
    const fr = Array.isArray(res.framesRan) ? res.framesRan : [];
    const hs = Array.isArray(res.hashes) ? res.hashes : [];
    const ran = fr.length === CORES && fr.every((f) => f >= FRAMES);
    const hashed = nHash > 0 && hs.every((h) => Array.isArray(h.len) && h.len.every((l) => l > 0));
    say('');
    if (res.reason) say('run stopped early: ' + res.reason);
    say('cells:');
    say('  cores-all-ran-every-frame   ' + (ran ? 'PASS' : 'FAIL') + '  (' + JSON.stringify(res.framesRan) + ' of ' + FRAMES + ')');
    say('  fingerprints-are-real       ' + (hashed ? 'PASS' : 'FAIL') + '  (savestate lengths ' + JSON.stringify((hs[0] || {}).len) + ')');
    say('  all-cores-agree             ' + (res.ok ? 'PASS' : 'FAIL'));
    const pass = ran && hashed && res.ok === true;
    results.pass = pass;
    say('');
    say('GATE: ' + (pass ? 'PASS' : 'FAIL'));
    verdict = pass ? 0 : 1;
  } catch (e) {
    say('THREW: ' + (e && e.stack || e));
    results.error = String(e && e.message || e);
  } finally {
    if (!flag('keep')) await browser.close();
  }

  results.md5After = { js: md5(WORKER_JS), wasm: md5(WORKER_WASM) };
  const os2 = await import('node:os');
  results.loadAfter = os2.loadavg().map((x) => +x.toFixed(2));
  say('artifact after:  js=' + results.md5After.js + ' wasm=' + results.md5After.wasm);
  say('load after: ' + results.loadAfter.join(' '));
  if (results.md5Before.js !== results.md5After.js || results.md5Before.wasm !== results.md5After.wasm) {
    say('⚠ ARTIFACT CHANGED DURING THE RUN — this result is VOID');
    verdict = 1;
  }

  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(results, null, 2));
  say('log: ' + LOG);
  process.exit(verdict);
})();

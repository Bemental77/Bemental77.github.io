#!/usr/bin/env node
// fbasync_race_probe.mjs — IS THE ASYNC FRAMEBUFFER READBACK DETERMINISTIC IN A
// REAL GAME, WHATEVER THE GPU IS DOING, AND DOES IT LOOK RIGHT?
//
// One Mario Kart 64 core per arm, in a FRESH browser context, armed into
// lockstep BEFORE main() runs (the page's own ordering: myApp.beforeRun ->
// _neil_ls_arm), then stepped by this rig one frame at a time
// (_neil_ls_set_pad on all FOUR ports + _neil_ls_run_frame) with a scripted
// input that is a pure function of the frame number. So every arm runs the
// same guest from the same power-on, and any difference between arms is the
// readback path and nothing else. The arms:
//
//   sync     the shipped synchronous readback (?fbwitness=1 only)
//   async0   ?fbasync=1, frames run back to back with no task boundary inside a
//            chunk: the fence has had no chance to be seen signalled -> the
//            read BLOCKS nearly every time
//   async20  ?fbasync=1, a 20 ms task boundary after every frame: the GPU has
//            long finished -> the read almost never blocks
//
// What is compared (all per call / per frame, from power-on):
//   * the CPU fingerprint (_neil_last_fp: GPRs, CP0, FPRs, FCR31, PC) of every
//     frame — async0 vs async20 MUST match (GPU timing may not reach the
//     guest); sync vs async says whether this game's CPU ever reads the copy;
//   * the readback witness (hash of the bytes handed to the core per call):
//     async0 vs async20 identical position for position; async[i] == sync[i-1]
//     (the offset is exactly one call);
//   * screenshots at --shots frames, for the visual A/B.
//
// ⚠ LIMITS: one Chrome build, SwiftShader, one machine. "The GPU" here is
// SwiftShader in Chrome's GPU process; the arms move WHEN the core asks for
// the copy relative to it, which is the property that matters, but a real
// mobile GPU is not exercised. The CPU fingerprint does not cover RDRAM.
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node n64/tools/fbasync_race_probe.mjs \
//     --arms sync,async0,async20 --frames 3600 --shots 3000,3600 --out DIR
//   --explore: one sync arm, a screenshot every --every frames (menu timing).
//   --plan NAME: the input schedule (see PLANS).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const GAME = flag('game', 'Mario Kart 64');
const FRAMES = +flag('frames', '3600');
const EXPLORE = has('explore');
const EVERY = +flag('every', '60');
const ARMS = EXPLORE ? ['sync'] : flag('arms', 'sync,async0,async20').split(',');
const SHOTS = EXPLORE ? Array.from({ length: Math.floor(FRAMES / EVERY) }, (_, i) => (i + 1) * EVERY)
                      : flag('shots', '').split(',').filter(Boolean).map(Number);
const OUT = flag('out', '/tmp/fbrace');
const PLAN = flag('plan', 'idle');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
fs.mkdirSync(OUT, { recursive: true });

// Input plans: [fromFrame, toFrame, port(s), mask, ax, ay] — held for the whole
// span. Bits: 0 up 1 down 2 left 3 right 4 A 5 B 6 Start 7 Z 8 L 9 R.
// ⚠ Menu timings were read off --explore screenshots; see the header of the
// plan for the frames at which each screen was seen.
const A = 1 << 4, START = 1 << 6;
const PLANS = {
  idle: [],
  // --plan steps:'f0-f1:ports:mask:ax:ay;...'  (ports: 0 or 0123)
};
function parsePlan(s) {
  if (PLANS[s]) return PLANS[s];
  if (!s.startsWith('steps:')) throw new Error('unknown plan ' + s);
  return s.slice(6).split(';').filter(Boolean).map((t) => {
    const [span, ports, mask, ax, ay] = t.split(':');
    const [f0, f1] = span.split('-').map(Number);
    return [f0, f1 == null || isNaN(f1) ? f0 + 5 : f1, ports.split('').map(Number), +mask, +(ax || 0), +(ay || 0)];
  });
}
const plan = parsePlan(PLAN);

// Arm before main(), exactly as the page does in a room; note when main() returns.
const PRE = `(() => {
  const iv = setInterval(() => {
    const app = window.myApp; if (!app || app.__fbrHooked) return;
    app.__fbrHooked = true; clearInterval(iv);
    const prev = app.beforeRun ? app.beforeRun.bind(app) : () => {};
    app.beforeRun = function () {
      const r = prev.apply(this, arguments);
      const M = window.Module;
      M._neil_ls_arm(1); if (M._neil_fp_always) M._neil_fp_always(1);
      window.__fbrArmed = true;
      const cm = M.callMain;
      M.callMain = function () { const x = cm.apply(this, arguments); window.__fbrMain = true; return x; };
      return r;
    };
  }, 1);
})();`;

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,900'] });
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

const res = {};
try {
  for (const arm of ARMS) {
    const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    await page.evaluateOnNewDocument(PRE);
    const q = '&fbwitness=1' + (arm.startsWith('async') ? '&fbasync=1' : '');
    const t0 = Date.now();
    await page.goto(`${BASE}/n64/?game=${encodeURIComponent(GAME)}&autostart${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__fbrMain === true, { timeout: 240000 });
    const gap = arm === 'async20' ? 20 : 0;
    const fps = [];
    let f = 0;
    const stops = [...SHOTS.filter((s) => s <= FRAMES), FRAMES].sort((x, y) => x - y);
    for (const stop of stops) {
      if (stop <= f) continue;
      const chunk = await page.evaluate(async (from, to, gap, plan) => {
        const M = window.Module, out = [];
        for (let f = from; f < to; f++) {
          const pads = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (const [f0, f1, ports, mask, ax, ay] of plan) {
            if (f >= f0 && f < f1) for (const p of ports) { pads[p][0] |= mask; if (ax) pads[p][1] = ax; if (ay) pads[p][2] = ay; }
          }
          for (let p = 0; p < 4; p++) M._neil_ls_set_pad(p, pads[p][0], Math.round(pads[p][1] * 32000), Math.round(pads[p][2] * 32000));
          M._neil_ls_run_frame();
          out.push(M._neil_last_fp() >>> 0);
          if (gap) await new Promise((r) => setTimeout(r, gap));
        }
        return out;
      }, f, stop, gap, plan);
      fps.push(...chunk); f = stop;
      if (SHOTS.includes(stop)) {
        await new Promise((r) => setTimeout(r, 100));        // let the last frame composite
        const el = await page.$('#canvas');
        const file = path.join(OUT, `${arm}_f${String(stop).padStart(5, '0')}.png`);
        if (el) await el.screenshot({ path: file }); else await page.screenshot({ path: file });
      }
    }
    const fb = await page.evaluate(() => { const s = window.__fbAsync; return { on: s.on, calls: s.calls, async: s.async, sync: s.sync,
      blocked: s.blocked, invalidations: s.invalidations, last: s.lastInvalidation || null, seq: s.seq }; });
    res[arm] = { ms: Date.now() - t0, fps, fb, errs };
    console.log(JSON.stringify({ arm, frames: fps.length, wallMs: res[arm].ms, calls: fb.calls, witnessed: fb.seq.length,
      distinct: new Set(fb.seq.map((x) => x[1])).size, async: fb.async, sync: fb.sync, blocked: fb.blocked,
      invalidations: fb.invalidations, last: fb.last, errs: errs.slice(0, 3) }));
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
}

// ---- verdicts ------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); };
const firstDiff = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return -1; };
const S = res.sync, A0 = res.async0, A20 = res.async20;
if (A0 && A20) {
  const d = firstDiff(A0.fps, A20.fps);
  d < 0 ? ok('CPU fingerprints identical, async0 vs async20, every frame', `${Math.min(A0.fps.length, A20.fps.length)} frames`)
        : bad('CPU fingerprints DIFFER async0 vs async20', 'first at frame ' + d);
  const h0 = A0.fb.seq.map((x) => x[1]), h20 = A20.fb.seq.map((x) => x[1]);
  const dw = firstDiff(h0, h20);
  (dw < 0 && h0.length === h20.length)
    ? ok('readback witness identical, async0 vs async20, every call', `${h0.length} calls, ${new Set(h0).size} distinct copies`)
    : bad('readback witness DIFFERS async0 vs async20', `first at call ${dw}, lengths ${h0.length}/${h20.length}`);
  const b0 = A0.fb.async ? A0.fb.blocked / A0.fb.async : 0, b20 = A20.fb.async ? A20.fb.blocked / A20.fb.async : 0;
  (b0 - b20 >= 0.5)
    ? ok('the arms really differ at the read point', `fence unsignalled at read: async0 ${(b0 * 100).toFixed(0)}%, async20 ${(b20 * 100).toFixed(0)}%`)
    : bad('VOID: the arms did not differ at the read point', `async0 ${(b0 * 100).toFixed(0)}%, async20 ${(b20 * 100).toFixed(0)}%`);
}
if (S && A0) {
  const hs = S.fb.seq, ha = A0.fb.seq;
  let compared = 0, bad1 = null;
  for (let i = 1; i < Math.min(hs.length, ha.length); i++) {
    if (ha[i][2] !== 1) continue;                         // a primed (sync) call is compared at offset 0 below
    compared++; if (ha[i][1] !== hs[i - 1][1] && !bad1) bad1 = i;
  }
  (compared > 0 && bad1 == null)
    ? ok('offset is exactly one call: async[i] == sync[i-1] for every async call', `${compared} calls`)
    : bad('offset', compared ? 'first mismatch at call ' + bad1 : 'no async calls to compare');
  const d = firstDiff(S.fps, A0.fps);
  console.log('  INFO  CPU fingerprints sync vs async: ' + (d < 0 ? `identical over ${Math.min(S.fps.length, A0.fps.length)} frames (this game's CPU did not read the copy in this span)` : `first differ at frame ${d} (the CPU reads the copy: a room MUST agree on the mode)`));
}
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(res));
console.log(`\n[fbasync-race] ${pass} passed, ${fail} failed; shots in ${OUT}`);
process.exit(fail ? 1 : 0);

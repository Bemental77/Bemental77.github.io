// Headless boot/rate/capacity probe for the SM64 native port (decomp -> wasm).
//
//   node tools/sm64_native_probe.mjs [pageUrl]
//
// This measures TWO INDEPENDENT KNOBS (CLAUDE.md gate #9), never conflating them:
//
//   1. GUEST RATE -- witness: sm64-port/src/pc/gfx/gfx_opengl.c:490-496,
//      gfx_opengl_start_frame() issues exactly ONE
//      glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT) (mask 0x4100) per
//      produce_one_frame(). So clears/sec == produce_one_frame()/sec == the
//      guest simulation rate. sm64-port/src/pc/pc_main.c:113 paces that loop
//      at `time *= 0.03` ms->frames, i.e. 33.333 ms/frame = 30.000 Hz, which
//      is SM64 NTSC's native game-logic rate. Expected reading: 30.00.
//
//   2. PRODUCIBLE CAPACITY -- the host CPU cost of one produced frame, timed
//      by wrapping requestAnimationFrame (produce_one_frame runs inside the
//      rAF callback registered by pc_main.c:98 request_anim_frame). Capacity
//      is reported as 1000/cost_ms and as headroom = 33.333/cost_ms.
//      This is NOT a presented-frame count and must never be quoted as fps.
//
// Emits one JSON line on stdout.
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';

const pageUrl = process.argv[2] || 'http://localhost:8080/n64/sm64-native/sm64.us.html';
const SETTLE_MS = +(process.env.SM64_SETTLE_MS || 12000);
const MEASURE_MS = +(process.env.SM64_MEASURE_MS || 10000);
const SHOT = process.env.SM64_SHOT || '/tmp/sm64-native.png';

function loadavg() {
  try { return execSync('uptime', { encoding: 'utf8' }).trim(); } catch { return null; }
}

const result = {
  pageUrl, loadavgAtStart: loadavg(), loadavgAtEnd: null,
  launched: false, wasmInstantiated: false,
  guestFramesPerSec: null, rafPerSec: null,
  frameCostMsMean: null, frameCostMsP50: null, frameCostMsP95: null,
  uncappedProduceRateNotFps: null, headroomVs30Hz: null,
  blackScreen: null, staticScreen: null, luminance: null,
  consoleErrors: [], pageErrors: [], failedRequests: [], coreLog: [],
};

const PRESERVE = process.env.SM64_PRESERVE === '1';
const HEARTBEAT = process.env.SM64_HEARTBEAT === '1';
const INSTRUMENT = `
  (() => {
    const __PRESERVE__ = ${PRESERVE};
    const __HEARTBEAT__ = ${HEARTBEAT};
    window.__probe = { clears: 0, raf: 0, costs: [], t0: 0 };
    const P = window.__probe;
    // Report the actual GL backend once -- software (SwiftShader) vs hardware
    // changes every capacity number by an order of magnitude.
    const origGetCtx = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      // Off by default: it costs real per-frame time, so the capacity arm must
      // run without it. Enabled only for the screenshot arm.
      if (__PRESERVE__ && /webgl/i.test(type)) {
        attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
      }
      const ctx = origGetCtx.call(this, type, attrs);
      if (ctx && !P.glReported && /webgl/i.test(type)) {
        P.glReported = true;
        try {
          const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
          console.log('PROBE_GL ' + type + ' | ' +
            (dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER)));
        } catch (e) { console.log('PROBE_GL ' + type + ' | (renderer query failed)'); }
      }
      return ctx;
    };
    // Guest-rate witness: one glClear(COLOR|DEPTH) per produce_one_frame().
    for (const K of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
      if (!K) continue;
      const orig = K.prototype.clear;
      K.prototype.clear = function (mask) {
        // GL_COLOR_BUFFER_BIT 0x4000 | GL_DEPTH_BUFFER_BIT 0x100
        if ((mask & 0x4000) && (mask & 0x100)) P.clears++;
        return orig.call(this, mask);
      };
    }
    // Capacity witness: wall time spent inside each rAF callback.
    const rawRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
      return rawRaf(function (t) {
        const a = performance.now();
        const c0 = P.clears;
        try { return cb(t); } finally {
          const d = performance.now() - a;
          P.raf++;
          // Only ticks that actually ran produce_one_frame() carry guest work.
          // At 30 Hz guest on a 120 Hz panel, 3 of every 4 ticks are no-ops --
          // including them would drive the median to 0 and the capacity to Inf.
          if (P.clears > c0) P.costs.push(d);
          if (P.costs.length > 20000) P.costs.splice(0, 10000);
          // Heartbeat: survives a blocked page.evaluate, so we can tell
          // "wedged" from "merely very slow" without guessing. OFF by default
          // (SM64_HEARTBEAT=1) -- ~20 console.log/s over CDP is not free, and a
          // capacity number must come from a clean, uninstrumented run.
          if (__HEARTBEAT__ && P.raf % 10 === 0) {
            console.log('PROBE_HB raf=' + P.raf + ' clears=' + P.clears +
                        ' lastCostMs=' + d.toFixed(1));
          }
        }
      });
    };
  })();
`;

const browser = await puppeteer.launch({
  protocolTimeout: 240000,
  headless: 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: +(process.env.SM64_W||320), height: +(process.env.SM64_H||240) });
  await page.evaluateOnNewDocument(INSTRUMENT);
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') result.consoleErrors.push(t);
    if (result.coreLog.length < 400) result.coreLog.push(`[${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => result.pageErrors.push(String(e)));
  page.on('requestfailed', (r) => result.failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  result.launched = true;

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  // NOTE: do NOT touch Module.wasmExports -- on emscripten >=4 that accessor
  // aborts the runtime when the symbol is not in EXPORTED_RUNTIME_METHODS.
  result.wasmInstantiated = await page.evaluate(
    () => !!(window.Module && typeof window.Module.canvas === 'object')
  );

  // --- measurement window ---
  const before = await page.evaluate(() => {
    const P = window.__probe; P.costs.length = 0;
    return { clears: P.clears, raf: P.raf, t: performance.now() };
  });
  await new Promise((r) => setTimeout(r, MEASURE_MS));
  const after = await page.evaluate(() => {
    const P = window.__probe;
    const c = P.costs.slice().sort((a, b) => a - b);
    const sum = c.reduce((a, b) => a + b, 0);
    return {
      clears: P.clears, raf: P.raf, t: performance.now(), n: c.length,
      mean: c.length ? sum / c.length : null,
      p50: c.length ? c[Math.floor(c.length * 0.5)] : null,
      p95: c.length ? c[Math.floor(c.length * 0.95)] : null,
    };
  });

  const secs = (after.t - before.t) / 1000;
  result.guestFramesPerSec = +((after.clears - before.clears) / secs).toFixed(3);
  result.rafPerSec = +((after.raf - before.raf) / secs).toFixed(3);
  if (after.p50 != null) {
    result.frameCostMsMean = +after.mean.toFixed(3);
    result.frameCostMsP50 = +after.p50.toFixed(3);
    result.frameCostMsP95 = +after.p95.toFixed(3);
    // Capacity is derived from the p50 cost of a rAF tick that produced work.
    if (after.p50 > 0) {
      // NOT an fps figure and must never be quoted as one (CLAUDE.md gate #9):
      // at 1.000x there are only 30 distinct SM64 frames per second IN
      // EXISTENCE. This is "how fast the host COULD produce one", i.e. the
      // headroom denominator. Report as "30 presented, Mx headroom".
      result.uncappedProduceRateNotFps = +(1000 / after.p50).toFixed(1);
      result.headroomVs30Hz = +((1000 / 30) / after.p50).toFixed(2);
    }
    result.producingTicksSampled = after.n;
  }

  // --- screen classification ---
  const shot = await page.evaluate(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return null;
    return cv.toDataURL('image/png');
  });
  if (shot) {
    const buf = Buffer.from(shot.split(',')[1], 'base64');
    (await import('node:fs')).writeFileSync(SHOT, buf);
    result.screenshot = SHOT;
  }
  const lum = await page.evaluate(async () => {
    const cv = document.querySelector('canvas');
    if (!cv) return null;
    const read = () => {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      c.getContext('2d').drawImage(cv, 0, 0, 160, 120);
      return Array.from(c.getContext('2d').getImageData(0, 0, 160, 120).data);
    };
    const a = read();
    await new Promise((r) => setTimeout(r, 900));
    const b = read();
    let sum = 0, diff = 0;
    for (let i = 0; i < a.length; i += 4) sum += (a[i] + a[i + 1] + a[i + 2]) / 3;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return { lum: sum / (a.length / 4), diff };
  });
  if (lum) {
    result.luminance = +lum.lum.toFixed(2);
    result.blackScreen = lum.lum < 2.0;
    result.staticScreen = lum.diff === 0;
  }
} catch (e) {
  result.pageErrors.push('PROBE: ' + String(e));
} finally {
  result.loadavgAtEnd = loadavg();
  await browser.close();
  console.log(JSON.stringify(result));
}

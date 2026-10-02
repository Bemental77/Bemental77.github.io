#!/usr/bin/env node
// n64_present_probe.mjs — HOW MANY OF THE PICTURES THE GAME MADE REACHED THE SCREEN?
//
// Asked by a real phone (Android Chrome, ?worker=1, MK64): the meter read
// "12 shown" while Mario Kart draws a new picture on every second field
// (25/s at 1.000x). This rig measures the three numbers that question needs,
// each from its own witness, on the REAL page:
//
//   made     distinct pictures the GAME produced per second — the core's own
//            GameFPS (fps_text), read by the page's meter (`__n64Rate.made`).
//   shown    what the page's meter CLAIMS reached the screen (`__n64Rate.shown`).
//   screen   what DID reach the screen: on every main-thread animation frame the
//            rig draws #canvas (in worker mode, the OffscreenCanvas PLACEHOLDER,
//            which holds the last frame the worker committed) into a small 2D
//            canvas, hashes the pixels, and counts the frames whose hash differs
//            from the previous one. A picture that was rendered and overwritten
//            before a commit never shows up here, whatever any counter says.
//            ⚠ It is a LOWER bound on distinct pictures: two consecutive game
//            frames whose 96x72 thumbnails are identical count once.
//
// Plus the guest rate (speed, viSpeed), the worker's frame-clock counters, and
// worklet underruns over the same window.
//
// USAGE (dev server on its own port; hermetic snapshot):
//   node n64/tools/n64_present_probe.mjs --url http://localhost:18600 --rom mariokart.z64 \
//        --query worker=1 [--warm 15000] [--secs 20] [--out DIR]
// Emits one JSON object on stdout.
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:18600');
const ROM = flag('rom', 'mariokart.z64');
const XQ = flag('query', 'worker=1');
const WARM = +flag('warm', '15000');
const SECS = +flag('secs', '20');
const OUT = flag('out', path.join(os.tmpdir(), 'n64-present-probe'));
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
fs.mkdirSync(OUT, { recursive: true });
const load1 = () => { try { return +fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Installed before the page runs: a screen witness on the RAW requestAnimationFrame.
const PRE = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const S = window.__scr = { on: false, frames: 0, changes: 0, last: -1, err: null, t0: 0 };
  let cv = null, cx = null;
  (function f() {
    raf(f);
    if (!S.on) return;
    try {
      const src = document.getElementById('canvas');
      if (!src) return;
      if (!cv) { cv = document.createElement('canvas'); cv.width = 96; cv.height = 72; cx = cv.getContext('2d', { willReadFrequently: true }); }
      cx.drawImage(src, 0, 0, 96, 72);
      const d = cx.getImageData(0, 0, 96, 72).data;
      let h = 0x811c9dc5 | 0;
      for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619);
      S.frames++;
      if (h !== S.last) { S.changes++; S.last = h; }
    } catch (e) { S.err = String(e && e.message || e).slice(0, 200); }
  })();
})();`;

const browser = await puppeteer.launch({
  headless: 'new', executablePath: fs.existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 900000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,900'],
});
try { require(path.join(path.dirname(__filename), '../../tools/browser_leak_guard.js')).guard(browser, __filename); } catch (_e) {}
const out = { rom: ROM, query: XQ, warmMs: WARM, secs: SECS, load: [load1()], errs: [] };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => out.errs.push(String(e.message).slice(0, 300)));
  await page.evaluateOnNewDocument(PRE);
  await page.goto(`${BASE}/n64/?game=${encodeURIComponent(ROM)}&autostart${XQ ? '&' + XQ : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Module && window.Module._neil_vi_total && window.Module._neil_vi_total() > 30, { timeout: 240000, polling: 500 });
  await sleep(WARM);
  const snap = () => page.evaluate(() => {
    const ws = window.__n64Worker && window.__n64Worker.state();
    const r = window.__n64Rate || {};
    return { now: performance.now(), scrFrames: window.__scr.frames, scrChanges: window.__scr.changes, scrErr: window.__scr.err,
             rate: { speed: r.speed, viSpeed: r.viSpeed, shown: r.shown, made: r.made, gameHz: r.gameHz, windowMs: r.windowMs, duty: r.duty, e2eHwX: r.e2eHwX, lost: r.lost, hwX: r.hwX },
             headline: (document.getElementById('fps') || {}).textContent || '',
             u: window.__audioDbg ? window.__audioDbg.u : null, m: window.__audioDbg ? window.__audioDbg.m : null,
             worker: !!(ws && ws.on), stat: ws && ws.stat ? ws.stat : null, present: ws ? ws.present || null : null, pace: window.__n64Pace ? window.__n64Pace() : null };
  });
  await page.evaluate(() => { window.__scr.on = true; });
  const a = await snap();
  const per = [];
  for (let i = 0; i < SECS; i++) {
    await sleep(1000);
    const s = await snap();
    per.push({ shown: s.rate.shown, made: s.rate.made, speed: s.rate.speed && +s.rate.speed.toFixed(3), screen: null });
    per[per.length - 1].scrTotal = s.scrChanges;
  }
  const b = await snap();
  for (let i = per.length - 1; i > 0; i--) per[i].screen = per[i].scrTotal - per[i - 1].scrTotal;
  if (per.length) per[0].screen = per[0].scrTotal - a.scrChanges;
  const wallS = (b.now - a.now) / 1000;
  const nums = (k) => per.map((x) => x[k]).filter((v) => typeof v === 'number' && isFinite(v));
  const mean = (v) => v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : null;
  out.window = { wallS: +wallS.toFixed(2) };
  out.screenPerS = +((b.scrChanges - a.scrChanges) / wallS).toFixed(2);
  out.screenRafPerS = +((b.scrFrames - a.scrFrames) / wallS).toFixed(2);
  out.screenErr = b.scrErr;
  out.meter = { shownMean: mean(nums('shown')), madeMean: mean(nums('made')), speedMean: mean(nums('speed')) };
  out.underruns = (a.u != null && b.u != null) ? b.u - a.u : null;
  out.missingEntries = (a.m != null && b.m != null) ? b.m - a.m : null;
  out.worker = b.worker;
  if (b.worker && a.stat && b.stat) {
    const d = (k) => (b.stat[k] != null && a.stat[k] != null) ? b.stat[k] - a.stat[k] : null;
    const coreS = (b.stat.at - a.stat.at) / 1000;
    out.workerClock = { fieldsPerS: +(d('frame') / coreS).toFixed(2), presentsPerS: d('presents') != null ? +(d('presents') / coreS).toFixed(2) : null,
                        ticksPerS: +(d('ticks') / coreS).toFixed(2), rafTicksPerS: +(d('rafTicks') / coreS).toFixed(2),
                        immTicksPerS: +(d('immTicks') / coreS).toFixed(2), tmrTicksPerS: +(d('tmrTicks') / coreS).toFixed(2),
                        shownPerS: d('shown') != null ? +(d('shown') / coreS).toFixed(2) : null,
                        busyFrac: d('busyMs') != null ? +(d('busyMs') / 1000 / coreS).toFixed(3) : null,
                        reanchors: d('reanchors'), lostMsPerS: d('lostMs') != null ? +(d('lostMs') / coreS).toFixed(1) : null,
                        audioSentPerS: d('audioSent') != null ? +(d('audioSent') / coreS).toFixed(0) : null };
  }
  out.headline = b.headline;
  if (a.present && b.present) out.present = { mode: b.present.mode, in: (b.present.in | 0) - (a.present.in | 0), shown: (b.present.shown | 0) - (a.present.shown | 0),
                                              dropped: (b.present.dropped | 0) - (a.present.dropped | 0), err: b.present.err || null,
                                              workerMs: (b.stat && a.stat && b.stat.pb && a.stat.pb) ? b.stat.pb.ms - a.stat.pb.ms : null };
  if (b.stat) { out.dbg = b.stat.dbg || null; out.fb = b.stat.fb || null;
    if (a.stat && a.stat.fb && b.stat.fb) out.fbDelta = { async: b.stat.fb.async - a.stat.fb.async, blocked: b.stat.fb.blocked - a.stat.fb.blocked }; }
  out.pace = b.pace;
  out.perSecond = per;
  await page.screenshot({ path: path.join(OUT, `present-${ROM.replace(/\.z64$/, '')}-${(XQ || 'default').replace(/[^a-z0-9]+/gi, '_')}.png`) });
} catch (e) { out.fault = String(e && e.message || e).slice(0, 400); }
finally { out.load.push(load1()); await browser.close(); }
console.log(JSON.stringify(out));

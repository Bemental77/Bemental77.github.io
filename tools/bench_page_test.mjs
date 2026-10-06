#!/usr/bin/env node
// ============================================================================
// bench_page_test.mjs — drives lib/bench.js (?bench=1) headless on emulator
// pages and checks the results JSON has the collector's shape.
//
//   npm run web            (port 8080, CLAUDE.md gate #2)
//   node tools/browser_leak_guard.js reap && uptime
//   node tools/bench_page_test.mjs [--pages n64,ps1,snes,genesis] [--sec 10] [--room 0|1] [--q costdbg=1] [--headful]
//                                  [--chrome-args "--enable-unsafe-webgpu"]
//
// Also checks the inert path: WITHOUT ?bench=1 the page must have no
// window.__bench, no #benchPanel, and an unwrapped window.Worker.
// Headless Chrome runs SwiftShader on a loaded box, so the PASS/FAIL verdict
// the page prints is NOT the point here — the shape and the wiring are.
// ============================================================================
import { createRequire } from 'module';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const PAGES = flag('pages', 'n64,ps1').split(',');
const SEC = +flag('sec', 10);
const ROOM = flag('room', '1') !== '0';
const HEADFUL = argv.includes('--headful');
const EXTRA = flag('q', '');   // extra query, e.g. --q costdbg=1
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PATHS = { n64: '/n64/index.html', ps1: '/ps1.html', snes: '/snes.html', genesis: '/genesis.html', gba: '/gba.html', gamecube: '/gamecube.html', dreamcast: '/dreamcast.html' };
// Pages that play through lib/cart_audio.js: each window must carry `audio` (latency + underruns).
const CART_AUDIO = { snes: 1, genesis: 1, gba: 1 };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail == null ? '' : '  ' + detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (x) => typeof x === 'number' && isFinite(x);
function checkWindow(tag, w, room) {
  ok(tag + ' present', !!w);
  if (!w) return;
  ok(tag + ' ms stats numeric', ['mean', 'p50', 'p95', 'p99', 'max'].every((k) => isNum(w.ms[k])), JSON.stringify(w.ms));
  ok(tag + ' budget/over/frames', isNum(w.budgetMs) && isNum(w.over) && w.frames > 0, `budget=${w.budgetMs} over=${w.over} frames=${w.frames}`);
  ok(tag + ' speed numeric', isNum(w.speed), 'speed=' + w.speed);
  ok(tag + ' fps numeric', isNum(w.fps), 'fps=' + w.fps);
  if (room) ok(tag + ' room fields', ['mode', 'delay', 'resims', 'players'].every((k) => k in w), `mode=${w.mode} delay=${w.delay} resims=${w.resims} players=${w.players}`);
}
// The audio path (lib/cart_audio.js pages): the latency the AudioContext reports and
// ZERO underruns in the window (a gap the worklet counted is a gap a player heard).
function checkAudio(tag, w) {
  const a = w && w.audio;
  ok(tag + ' audio reported', !!a && a.mode === 'worklet', JSON.stringify(a));
  if (!a) return;
  ok(tag + ' audio latency numeric', isNum(a.baseLatencyMs), `base=${a.baseLatencyMs} ms output=${a.outputLatencyMs} ms`);
  ok(tag + ' audio 0 underruns', a.underruns === 0, `underruns=${a.underruns} silent=${a.missingMs} ms cushion=${a.backlogMs} ms`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: HEADFUL ? false : 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,900',
    // --chrome-args "--enable-unsafe-webgpu": the gamecube recomp hand-off race only shows when
    // the WGPU renderer publishes frames before the takeover, i.e. with WebGPU on.
    ...flag('chrome-args', '').split(' ').filter(Boolean)],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'bench_page_test'); } catch (_e) {}
const results = {};
try {
  for (const pg of PAGES) {
    console.log(`\n== ${pg}`);
    // 1. inert without ?bench=1
    const p0 = await browser.newPage();
    await p0.goto(BASE + PATHS[pg], { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const inert = await p0.evaluate(() => ({ bench: typeof window.__bench, panel: !!document.getElementById('benchPanel'),
      worker: String(window.Worker).indexOf('[native code]') >= 0 }));
    ok('inert without ?bench=1', inert.bench === 'undefined' && !inert.panel && inert.worker, JSON.stringify(inert));
    await p0.close();

    // 2. the benchmark
    const page = await browser.newPage();
    const logs = [];
    page.on('console', (m) => { const t = m.text(); if (t.startsWith('[bench]')) { logs.push(t); console.log('    ' + t.slice(0, 200)); } });
    page.on('pageerror', (e) => console.log('    pageerror: ' + String(e.message || e).slice(0, 200)));
    const q = `?bench=1&benchsec=${SEC}&benchauto=1${ROOM ? '' : '&benchroom=0'}${EXTRA ? '&' + EXTRA : ''}`;
    await page.goto(BASE + PATHS[pg] + q, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + (ROOM ? 900000 : 420000);
    let res = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      res = await page.evaluate(() => window.__benchResult || null).catch(() => null);
      if (res) break;
    }
    ok('result produced', !!res);
    if (!res) continue;
    results[pg] = res;
    ok('shape: top-level keys', ['v', 'page', 'title', 'ts', 'device', 'cap', 'solo', 'room', 'bursts', 'pass'].every((k) => k in res), Object.keys(res).join(','));
    ok('page id', res.page === pg, res.page);
    ok('title', typeof res.title === 'string' && res.title.length > 0, res.title);
    ok('device', !!res.device.ua && isNum(res.device.cores) && /^\d+x\d+@/.test(res.device.screen || ''), `renderer=${res.device.renderer} screen=${res.device.screen}`);
    ok('cap report', res.cap && typeof res.cap === 'object', res.cap ? Object.keys(res.cap).slice(0, 6).join(',') : 'null');
    checkWindow('solo', res.solo, false);
    if (ROOM) checkWindow('room', res.room, true);
    if (CART_AUDIO[pg]) { checkAudio('solo', res.solo); if (ROOM) checkAudio('room', res.room); }
    ok('bursts array', Array.isArray(res.bursts) && res.bursts.every((b) => isNum(b.ms) && typeof b.cause === 'string' && isNum(b.t)), res.bursts.length + ' bursts');
    ok('pass is boolean', typeof res.pass === 'boolean', 'pass=' + res.pass);
    const ui = await page.evaluate(() => ({ verdict: document.getElementById('benchVerdict')?.textContent, copy: !!document.getElementById('benchCopy') && document.getElementById('benchCopy').style.display !== 'none' }));
    ok('on-screen verdict + Copy button', /^(PASS|FAIL)$/.test(ui.verdict || '') && ui.copy, JSON.stringify(ui));
    const shot = `/tmp/bench-${pg}.png`;
    await page.screenshot({ path: shot }).catch(() => {});
    console.log('    screenshot ' + shot);
    await page.close();
  }
} finally {
  await browser.close();
}
for (const [pg, r] of Object.entries(results)) console.log(`\nRESULT ${pg} ${JSON.stringify(Object.assign({}, r, { cap: r.cap ? '<omitted>' : null }))}`);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

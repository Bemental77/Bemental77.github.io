#!/usr/bin/env node
// n64_worker_fallback_probe.mjs — WHEN THE CORE WORKER FAILS WHILE IT BOOTS, DOES THE PAGE
// END UP RUNNING THE GAME ON THE MAIN THREAD, BY ITSELF?
//
// The core worker is the page's default (n64/index.html WK_DEFAULT). A browser can pass
// every capability check and still fail inside the worker — WebGL2 refused there, a core
// abort while it boots — and the page's answer is wkFallback: reload ONCE with ?worker=0
// (a solo console restarts its game by itself; a room keeps its ?np= and rejoins). This rig
// drives that path through the page's rig seam ?workerfail=boot|main, which makes the worker
// report exactly such a failure at the two points it can happen:
//   boot  — before the core loads (where the worker's own WebGL2 preflight would fail),
//   main  — after the runtime initialised, just before main() (where a core abort lands).
// PASS = the page navigated to ?worker=0 on its own, the new load says it is the automatic
// fallback (facts.workerFallback, from sessionStorage), the core is on the MAIN thread (no
// worker facade), its field counter advances, and no page error fired.
//
// USAGE: node n64/tools/n64_worker_fallback_probe.mjs --url http://localhost:18600 [--rom mariokart.z64]
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:18600');
const ROM = flag('rom', 'mariokart.z64');
const CASES = flag('cases', 'boot,main').split(',');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new', executablePath: fs.existsSync(CHROME) ? CHROME : undefined, protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
         '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try { require(path.join(path.dirname(__filename), '../../tools/browser_leak_guard.js')).guard(browser, __filename); } catch (_e) {}
const results = [];
for (const c of CASES) {
  const ctx = await (browser.createBrowserContext ? browser.createBrowserContext() : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  const r = { case: c, errs: [], navigations: [] };
  page.on('pageerror', (e) => r.errs.push(String(e.message).slice(0, 200)));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) r.navigations.push(f.url().replace(BASE, '')); });
  const lines = [];
  page.on('console', (m) => { const t = m.text(); if (/\[worker|fallback|worker-err/i.test(t)) lines.push(t.slice(0, 240)); });
  try {
    await page.goto(`${BASE}/n64/?game=${encodeURIComponent(ROM)}&autostart&workerfail=${c}`, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    let st = null;
    while (Date.now() - t0 < 240000) {
      try {
        st = await page.evaluate(() => {
          const M = window.Module, q = new URLSearchParams(location.search);
          return { search: location.search, worker: q.get('worker'), facade: !!(M && M.__worker),
                   vi: (M && M._neil_vi_total && !M.__worker) ? (M._neil_vi_total() >>> 0) : null,
                   wk: window.__n64Worker ? window.__n64Worker.state().on : null,
                   status: (document.getElementById('status') || {}).textContent || '' };
        });
      } catch (e) { st = null; }   // mid-navigation
      if (st && st.worker === '0' && st.vi > 60) break;
      await sleep(500);
    }
    const vi0 = st && st.vi;
    await sleep(2000);
    const fin = await page.evaluate(() => {
      const M = window.Module;
      return { vi: (M && M._neil_vi_total && !M.__worker) ? (M._neil_vi_total() >>> 0) : null,
               facade: !!(M && M.__worker), fact: (document.getElementById('log') || {}).textContent.indexOf('AUTOMATIC FALLBACK') >= 0,
               rate: window.__n64Rate ? { speed: window.__n64Rate.speed, shown: window.__n64Rate.shown, made: window.__n64Rate.made } : null };
    }).catch((e) => ({ err: String(e.message || e) }));
    Object.assign(r, { final: st, advanced: (fin.vi != null && vi0 != null) ? fin.vi - vi0 : null, fact: fin.fact, facade: fin.facade, rate: fin.rate, lines: lines.slice(0, 12) });
    r.pass = !!(st && st.worker === '0' && !fin.facade && fin.fact && r.advanced > 0 && r.errs.length === 0 && r.navigations.length >= 2);
  } catch (e) { r.fault = String(e.message || e).slice(0, 300); r.pass = false; }
  results.push(r);
  console.log(JSON.stringify(r));
  await ctx.close();
}
await browser.close();
const pass = results.filter((r) => r.pass).length;
console.log(`\n[n64-worker-fallback] ${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);

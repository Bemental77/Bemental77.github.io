#!/usr/bin/env node
// ps1_core_equiv.mjs — ARE TWO PS1 WORKER BUILDS THE SAME CONSOLE?
// Drives tools/ps1_core_equiv.html: two gated workers boot the same disc bytes
// and run the same frames with the same scripted pads; every --every frames
// their guest main RAM + hardware page (and every --vram-every frames their
// VRAM) must hash equal. The fingerprint is layout-independent, so a rebuilt
// core (different static addresses) can be held to the shipped one.
//
//   npm run web                      (or any devserver root that serves both URLs)
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/ps1_core_equiv.mjs --b /some/other/wasmpsx_worker.js
//
// Flags: --a URL (/ps1/ps1Wasm/dist/wasmpsx_worker.js)  --b URL (required)
//        --frames N (3600) --every N (60) --vram-every N (600) --ports 2|4 (2)
//        --rom BASE (MonsterRancher2) | --disc URL  --mb N (89)
//        --parts N  boot the WHOLE disc: parts parta{a..} of --disc concatenated,
//                   as ps1.html loads it (0 = the first part only, capped at --mb).
//                   ⚠ Monster Rancher 2 truncated to 89 MB never draws a picture
//                   in 1500 frames (its VRAM does not change at all, measured
//                   2026-10-08), so a VRAM check on it compares zeros.
//        --mt-a N / --mt-b N  multitap slots plugged into A / B before frame 0 (0)
//        --peek-ram HEX,HEX..  main-RAM word offsets to print from both cores at the end
//        --url BASE (http://localhost:8080)
// Exit 0 only if every compared fingerprint matched, both cores took over the
// governor, and the RAM fingerprint moved (distinct > 1).
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const opts = {
  a: arg('a', '/ps1/ps1Wasm/dist/wasmpsx_worker.js'), b: arg('b', null),
  frames: +arg('frames', 3600), every: +arg('every', 60), vramEvery: +arg('vram-every', 600), ports: +arg('ports', 2),
  disc: arg('disc', '/ps1/ps1Wasm/roms/' + arg('rom', 'MonsterRancher2') + '.bin.partaa.gz'), bytes: (+arg('mb', 89)) * 1048576,
  mtA: +arg('mt-a', 0), mtB: +arg('mt-b', 0),
  parts: +arg('parts', 0),
  peekRam: arg('peek-ram', '') ? arg('peek-ram', '').split(',').map((x) => parseInt(x, 16)) : [],
};
if (!opts.b) { console.error('--b URL is required'); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: 'new', args: ['--no-sandbox'], protocolTimeout: 1200000,
});
try { require('./browser_leak_guard.js').guard(browser, 'ps1_core_equiv'); } catch (e) {}
let result;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto(arg('url', 'http://localhost:8080') + '/tools/ps1_core_equiv.html', { waitUntil: 'load' });
  await page.evaluate((o) => window.__start(o), opts);
  let last = '';
  for (;;) {
    const s = await page.evaluate(() => ({ done: window.__state.done, p: window.__state.progress, r: window.__state.result, e: window.__state.error }));
    if (s.p !== last) { console.log('  ' + s.p); last = s.p; }
    if (s.done) { result = s.e ? { ok: false, error: s.e } : s.r; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally { await browser.close(); }
console.log(JSON.stringify({ opts, result, load: os.loadavg().map((x) => +x.toFixed(2)) }, null, 1));
process.exit(result && result.ok ? 0 : 1);

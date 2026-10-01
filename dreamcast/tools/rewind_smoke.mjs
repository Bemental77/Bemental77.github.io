#!/usr/bin/env node
// ============================================================================
// rewind_smoke.mjs — DOES THE SOLO CRASH REWIND (37a651c) STILL WORK?
// ============================================================================
//
// The real trigger (SA2's story-select crash, dreamcast/docs/sa2-story-select-
// crash) needs a 1.1 GB disc driven ~54 s into the game. This rig exercises the
// SAME recovery path cheaply: one solo page, the worker's own retained
// snapshot, and ONE injected throw out of _emscripten_run_iter — the exact
// shape the pump's catch sees from a real guest crash (an exception escaping
// the export). It then asserts, from the page's own log and probe:
//   1. the worker took a recover snapshot ("[recover] snapshot #"),
//   2. the injected throw was caught as a crash ("run_iter threw (recovering)"),
//   3. the machine was REWOUND ("[recover] REWOUND"), and
//   4. frames keep flowing afterwards (the pump was restarted, not stopped).
// The injection is evaluated into the worker over raw CDP (puppeteer's
// WebWorker.evaluate never resolves for this worker — rollback_measure.mjs).
//
// USAGE   node dreamcast/tools/rewind_smoke.mjs --url http://localhost:18804 [--game pso2]
// Exit 0 = all four held; 1 = one failed (named); 3 = void (never booted).
// ============================================================================
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const requireFrom = (() => {
  for (const base of [process.cwd() + '/', path.join(os.homedir(), 'probe-deps') + '/', import.meta.url]) {
    try { const r = createRequire(base); r.resolve('puppeteer'); return r; } catch (e) {}
  }
  return createRequire(import.meta.url);
})();
const puppeteer = requireFrom('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = String(flag('url', 'http://localhost:8080')).replace(/\/$/, '');
const GAME = flag('game', 'pso2');
// --query '&norecover=1' is the CONTROL: the same injected crash with the
// rewind turned off must FAIL here (pump stopped), or this rig proves nothing.
const QUERY = flag('query', '');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const say = (s) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const until = async (fn, ms, every = 1000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(every); } };

const b = await puppeteer.launch({ headless: 'new', executablePath: CHROME, protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(b, fileURLToPath(import.meta.url)); } catch (e) {}
let code = 0;
try {
  const page = (await b.pages())[0];
  const log = [];
  page.on('console', (m) => log.push(m.text()));
  await page.goto(BASE + '/dreamcast.html?nogate=1' + QUERY, { waitUntil: 'domcontentloaded' });
  await until(() => page.evaluate(() => self.crossOriginIsolated), 15000, 300);
  await page.evaluate((g) => { const s = document.getElementById('romSelect'); s.value = g; s.dispatchEvent(new Event('change')); document.getElementById('btnStart').click(); }, GAME);
  const flowing = await until(() => page.evaluate(() => { const d = window.__dcProbe && window.__dcProbe(); return d && d.framesEver && d.distinctEver; }), 400000);
  if (!flowing) { say('VOID: frames never flowed'); code = 3; throw new Error('void'); }
  say('frames flowing');
  const snap = await until(async () => log.some((l) => /\[recover\] snapshot #/.test(l)), /norecover/.test(QUERY) ? 20000 : 120000);
  say('1. recover snapshot taken: ' + !!snap);
  let w = null;
  for (let i = 0; i < 60 && !w; i++) {
    for (const x of page.workers()) {
      if (!/flycast_worker\.js/.test(x.url())) continue;
      const r = await Promise.race([x.client.send('Runtime.evaluate', { expression: '!!(self.Module&&self.Module._emscripten_run_iter)', returnByValue: true }).then((r) => r.result.value).catch(() => false), sleep(3000).then(() => false)]);
      if (r) { w = x; break; }
    }
    if (!w) await sleep(500);
  }
  const inj = await w.client.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const M = self.Module; const real = M._emscripten_run_iter; let armed = true;
    M._emscripten_run_iter = function () { if (armed) { armed = false; M._emscripten_run_iter = real; throw new Error('rewind_smoke: injected guest crash'); } return real.apply(this, arguments); };
    return true; })()` });
  say('throw injected into the next run_iter: ' + JSON.stringify(inj.result && inj.result.value));
  const caught = await until(async () => log.some((l) => /run_iter threw \(recovering\)/.test(l)), 60000, 250);
  const rewound = await until(async () => log.find((l) => /\[recover\] REWOUND/.test(l)), 60000, 250);
  say('2. caught as a crash (recovering): ' + !!caught);
  say('3. rewound: ' + (rewound ? rewound.slice(0, 200) : 'NO'));
  const t1 = Date.now();
  await sleep(15000);
  const after = await page.evaluate(() => { const d = window.__dcProbe(); return { fps: d.fps, guestX: d.guestX, live: d.live, why: d.why }; });
  const stopped = log.some((l) => /pump stopped/.test(l));
  say('4. after the rewind: ' + JSON.stringify(after) + ' pumpStopped=' + stopped + ' (' + Math.round((Date.now() - t1) / 1000) + ' s later)');
  const ok = !!snap && !!caught && !!rewound && after.fps > 0 && !stopped;
  say(ok ? 'PASS — the solo rewind recovered an injected crash and the game kept running' : 'FAIL');
  for (const l of log.filter((l) => /\[recover\]|run_iter threw|\[vmu\] the loaded/.test(l)).slice(-8)) say('   ' + l.slice(0, 220));
  code = ok ? 0 : 1;
} catch (e) { if (code === 0) { say('THREW ' + (e && e.message)); code = 1; } }
finally { await b.close(); }
process.exit(code);

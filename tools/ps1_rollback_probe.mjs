#!/usr/bin/env node
// ps1_rollback_probe.mjs — is the PS1 raw-memory savestate exact under rollback?
// Drives tools/ps1_rollback_harness.html (see its header): a reference core that
// never guesses against a core that predicts, rewinds and re-simulates, compared
// by full-guest fingerprints (psxM + psxH + VRAM) of confirmed frames.
//
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/ps1_rollback_probe.mjs
//
// Flags: --frames N (1800) --every N (30) --max-lag N (6) --ring N (12)
//        --warm N (600) --rom BASE (MonsterRancher2) --mb N (89)
//        --broken  negative control: rollbacks that do not correct; MUST fail
//        --budget B  the undo ring's log budget in bytes (1 = trim to the frontier every step)
//        --switch-every S  alternate S rollback frames with S delay-lockstep frames
//                  (a capacity-gated room going to input delay and back: the ring
//                  re-armed at every return, a timed save every --remeasure-every
//                  delay frames) — the page side of lib/netplay.js opts.rbResume
//        --url BASE  (http://localhost:8080)
//        --worker PATH  a worker build to test instead of /ps1/ps1Wasm/dist/wasmpsx_worker.js
//        --query Q  appended to every worker's URL (e.g. urcheck=1: the worker runs the
//                  full page compare beside its write-tracked one on every save, and
//                  any page the tracked one missed FAILS the run — result.trackMiss)
//        --parts N  boot the whole disc (parts parta{a..}, as ps1.html does) instead of
//                  its first --mb bytes
//   THREE AND FOUR PLAYERS (tools/ps1_rollback_harness.html __runN):
//        --players 3|4  N rollback consoles (console c owns port c and predicts
//                  every other port, each with its own random lateness) against a
//                  reference that never guesses; the multitap in port 1 of every
//                  core; the disc is tools/ps1_multitap_disc.mjs (guest code that
//                  reads all four slots through the multitap, continuously) unless
//                  --rom/--disc-file says otherwise. Teeth after the run: each
//                  port held at rest, and no multitap, MUST change the state.
//        --broken-mt  the consoles have no multitap, the reference has. MUST fail.
//        --mt-poke restore  scramble the multitap's state before every step that
//                  rolls back — MUST pass (a rollback load restores it);
//        --mt-poke live     ... before steps that do not — MUST fail (it reaches the guest).
//        --no-teeth  skip the per-port / no-multitap reference runs
// Env: CHROME_PATH
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const opts = {
  frames: +arg('frames', 1800), every: +arg('every', 30), maxLag: +arg('max-lag', 6), ring: +arg('ring', 12),
  warm: +arg('warm', 600), bytes: (+arg('mb', 89)) * 1048576,
  broken: argv.includes('--broken'), budget: +arg('budget', 0),
  switchEvery: +arg('switch-every', 0), remeasureEvery: +arg('remeasure-every', 10),
  url: '/ps1/ps1Wasm/roms/' + arg('rom', 'MonsterRancher2') + '.bin.partaa.gz',
  worker: arg('worker', null), players: +arg('players', 2), parts: +arg('parts', 0),
  brokenMt: argv.includes('--broken-mt'), mtPoke: arg('mt-poke', null), noTeeth: argv.includes('--no-teeth'),
};
if (opts.players > 2) {
  // The multitap test disc unless a real one is named; it is handed to the page as bytes.
  if (!argv.includes('--rom')) {
    const { buildMultitapDisc } = await import(new URL('./ps1_multitap_disc.mjs', import.meta.url).href);
    opts.discB64 = Buffer.from(buildMultitapDisc()).toString('base64');
  }
  if (!argv.includes('--warm')) opts.warm = 240;
  if (!argv.includes('--frames')) opts.frames = 1200;
}
const md5 = (f) => { try { return crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return 'missing'; } };
const W = opts.worker && process.env.PS1_WORKER_DIR ? process.env.PS1_WORKER_DIR + '/wasmpsx_worker.' : 'ps1/ps1Wasm/dist/wasmpsx_worker.';
const before = { js: md5(W + 'js'), wasm: md5(W + 'wasm') };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  headless: 'new', args: ['--no-sandbox'], protocolTimeout: 600000,
});
try { require('./browser_leak_guard.js').guard(browser, 'ps1_rollback_probe'); } catch (e) {}
let result;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto(arg('url', 'http://localhost:8080') + '/tools/ps1_rollback_harness.html' + (arg('query', '') ? '?' + arg('query', '') : ''), { waitUntil: 'load' });
  await page.evaluate((o) => window.__start(o), opts);
  let last = '';
  for (;;) {
    const s = await page.evaluate(() => ({ done: window.__state.done, p: window.__state.progress, r: window.__state.result, e: window.__state.error }));
    if (s.p !== last) { console.log('  ' + s.p); last = s.p; }
    if (s.done) { result = s.e ? { ok: false, error: s.e } : s.r; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally { await browser.close(); }
const after = { js: md5(W + 'js'), wasm: md5(W + 'wasm') };
if (opts.discB64) opts.discB64 = '(' + opts.discB64.length + ' base64 chars)';
console.log(JSON.stringify({ opts, result, md5Before: before, md5After: after, load: os.loadavg().map((x) => +x.toFixed(2)) }, null, 1));
process.exit(result && result.ok ? 0 : 1);

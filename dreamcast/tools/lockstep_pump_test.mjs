#!/usr/bin/env node
// DOES THE FRAME-GATED PUMP ACTUALLY GATE?
//
// The lockstep claim is a claim about the WORKER: it must advance exactly one
// emulated frame per delivered input pair, refuse to advance without one, and
// never make up the lost time afterwards. This runs the REAL
// dreamcast/flycast_libretro/flycast_worker.js in a real Worker, against a stub
// core (dreamcast/tools/pump_fixture/stub_core.js) whose frames are exact and
// free — so a 40 ms stall cannot be confused with a 40 ms frame, which is
// exactly what the real core would make ambiguous.
//
// WHAT IT WOULD CATCH: the gate running a frame it has no input for; the
// governor repaying a stall as a burst (the forbidden speed-up, CLAUDE.md gate
// #9); inputs applied out of order; a fingerprint taken mid-asyncify-suspend
// (a false desync generator); and lockstep leaking into single-player.
//
// USAGE  npm run web  &&  node dreamcast/tools/lockstep_pump_test.mjs
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(root, 'dreamcast/tools/pump_fixture');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';

let pass = 0, fail = 0;
const ok  = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); };
const is  = (n, a, b) => (a === b ? ok(n, `= ${a}`) : bad(n, `expected ${b}, got ${a}`));

// The fixture pretends to be the link output so the shim's own relative
// importScripts('flycast_worker_emcc.js') resolves to the stub. Both copies are
// temporary: the shim under test is always the live file.
const copies = [
  [path.join(root, 'dreamcast/flycast_libretro/flycast_worker.js'), path.join(FIX, 'flycast_worker.js')],
  [path.join(FIX, 'stub_core.js'), path.join(FIX, 'flycast_worker_emcc.js')],
];
for (const [src, dst] of copies) fs.copyFileSync(src, dst);
const cleanup = () => { for (const [, dst] of copies) { try { fs.unlinkSync(dst); } catch (e) {} } };
process.on('exit', cleanup);

// ⚠ THE MEMORY MUST BE SHARED OR IT CANNOT EVEN BE POSTED. A non-shared
// WebAssembly.Memory is not structured-cloneable ("#<Memory> could not be
// cloned"), which is unrelated to the pump and cost one run. Measured here on
// Chrome 152: `new WebAssembly.Memory({shared:true})` CONSTRUCTS with
// crossOriginIsolated=false — only the SharedArrayBuffer *constructor* is
// gated — so the fixture needs the shared memory and not the isolation.
const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME,
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'] });
try { (await import(path.join(root, 'tools/browser_leak_guard.js'))).default.guard(browser, 'dc_lockstep_pump'); } catch (e) {}

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // ---- boot the worker ----------------------------------------------------
  await page.evaluate(async () => {
    window.__msgs = [];
    window.__hist = [];
    window.__frameAt = [];
    const w = window.__w = new Worker('/dreamcast/tools/pump_fixture/flycast_worker.js', { type: 'classic' });
    w.onmessage = (e) => {
      const m = e.data || {};
      window.__msgs.push(m);
      if (m.cmd === 'lsFrame') window.__frameAt.push(performance.now());
      if (window.__msgs.length > 20000) window.__msgs.splice(0, 10000);
    };
    // The shim only checks `instanceof WebAssembly.Memory` and hands it to the
    // factory, which the stub ignores — the fixture is not testing wasm memory.
    w.postMessage({ cmd: 'mem-init', memory: new WebAssembly.Memory({ initial: 16, maximum: 256, shared: true }),
                    fbOffset: 0, fbW: 64, fbH: 64, audioOffset: 0, audioFrames: 256 });
  });
  const waitFor = async (pred, ms, what) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await page.evaluate(pred)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    console.log(`  [timeout] ${what}`);
    return false;
  };
  const ready = await waitFor(() => window.__msgs.some((m) => m.cmd === 'ready'), 20000, 'worker ready');
  if (!ready) {
    const log = await page.evaluate(() => window.__msgs.filter((m) => m.cmd === 'print').map((m) => m.txt).slice(-12));
    console.log(log.join('\n'));
    bad('worker-ready', 'the shim never reported ready');
    throw new Error('worker never came up');
  }
  ok('worker-ready', 'the real shim booted against the stub core');
  const send = (o, t) => page.evaluate((o, t) => window.__w.postMessage(o, t || []), o, t);
  const msgs = (cmd) => page.evaluate((c) => window.__msgs.filter((m) => m.cmd === c), cmd);
  // ⚠ clear() MOVES messages to a history rather than dropping them. The first
  // version dropped, and three arms then asserted on messages an intervening
  // clear had already eaten — which reads exactly like the worker never sent
  // them. `all()` searches both.
  const all = (cmd) => page.evaluate((c) => window.__hist.concat(window.__msgs).filter((m) => m.cmd === c), cmd);
  const clear = () => page.evaluate(() => { window.__hist.push(...window.__msgs); window.__msgs.length = 0; });
  const stats = async () => { await clear(); await send({ cmd: 'lsStats' });
    await waitFor(() => window.__msgs.some((m) => m.cmd === 'lsStats'), 2000, 'lsStats');
    return (await msgs('lsStats'))[0]; };

  // ---- 1. single player is untouched -------------------------------------
  console.log('\n== single player still free-runs, governed to 1.000x ==');
  await send({ cmd: 'freerun', on: true });
  await clear();
  await new Promise((r) => setTimeout(r, 4500));
  const ips = (await msgs('ips')).map((m) => m.ips);
  const mid = ips.slice(1);          // drop only the first, partial, window
  const meanIps = mid.reduce((a, c) => a + c, 0) / (mid.length || 1);
  mid.length >= 1 && meanIps > 50 && meanIps < 70
    ? ok('freerun-governed', `${mid.join(', ')} iters/s (mean ${meanIps.toFixed(1)}) — the stub advances one 60 Hz frame of guest cycles per iter, so 60 IS 1.000x`)
    : bad('freerun-governed', `iters/s = ${ips.join(', ')}`);

  // ---- 2. the gate ---------------------------------------------------------
  console.log('\n== lockstep: exactly one frame per delivered input, and not one more ==');
  await clear();
  await send({ cmd: 'lockstep', on: true, frame: 0, hashEvery: 10 });
  await waitFor(() => window.__msgs.some((m) => m.cmd === 'lsState'), 2000, 'lsState');
  // Nothing queued: the core must be parked, not running.
  await new Promise((r) => setTimeout(r, 400));
  const ranDry = (await msgs('lsFrame')).length;
  is('gate-holds-empty', ranDry, 0);
  const stalled = (await msgs('lsStall')).filter((m) => m.on === 1).length;
  stalled >= 1 ? ok('gate-reports-stall', `${stalled} stall notice(s) — the page can say WHY it is frozen`)
               : bad('gate-reports-stall', 'the pump froze silently');

  // ⚠ Snapshot the stub's running pad digest FIRST. It already absorbed the
  // free-run frames above, so the expected value continues from here rather
  // than from the FNV seed.
  await clear();
  await send({ cmd: 'lsFingerprint' });
  await waitFor(() => window.__msgs.some((m) => m.cmd === 'lsFingerprint'), 2000, 'digest base');
  const base = (await msgs('lsFingerprint'))[0].w[0] >>> 0;

  // Feed exactly 30 frames. Deliberately OUT OF ORDER: a reliable channel
  // preserves order but a page timer and a network do not have to.
  await clear();
  const order = [];
  for (let i = 0; i < 30; i++) order.push(i);
  order.sort(() => Math.random() - 0.5);
  for (const f of order) {
    await page.evaluate((f) => {
      const st = new Uint8Array(256);
      st[0] = f & 255; st[64] = (200 - f) & 255;     // port 0 = host, port 1 = joiner
      window.__w.postMessage({ cmd: 'lsInput', f, states: st.buffer }, [st.buffer]);
    }, f);
  }
  await waitFor(() => window.__msgs.filter((m) => m.cmd === 'lsFrame').length >= 30, 5000, '30 frames');
  await new Promise((r) => setTimeout(r, 300));
  const ran = (await msgs('lsFrame')).map((m) => m.f);
  is('gate-ran-exactly-30', ran.length, 30);
  ran.every((f, i) => f === i) ? ok('gate-in-order', 'frames ran 0..29 in order despite being queued shuffled')
                               : bad('gate-in-order', ran.join(','));
  const st1 = await stats();
  is('gate-stopped-at-30', st1.f, 30);
  is('gate-queue-drained', st1.queued, 0);

  // ---- 3. the pads really reach the core ----------------------------------
  console.log('\n== the delivered pads are what the core actually ran ==');
  await clear();
  await send({ cmd: 'lsFingerprint' });
  await waitFor(() => window.__msgs.some((m) => m.cmd === 'lsFingerprint'), 2000, 'fingerprint');
  const fp = (await msgs('lsFingerprint'))[0];
  fp.ok ? ok('fingerprint-ok', `${fp.w.length} words, h=0x${(fp.h >>> 0).toString(16)}`) : bad('fingerprint-ok', fp.error);
  is('fingerprint-width', fp.w.length, 14);
  // Recompute the stub's own pad digest here. If the pump had skipped,
  // duplicated or reordered ANY frame this would not match.
  let want = base;
  const mix = (v) => { want = (want ^ v) >>> 0; want = Math.imul(want, 0x01000193) >>> 0; };
  for (let f = 0; f < 30; f++) { const st = new Uint8Array(256); st[0] = f & 255; st[64] = (200 - f) & 255;
                                 for (let i = 0; i < 256; i++) mix(st[i]); }
  is('pads-reached-core', fp.w[0] >>> 0, want >>> 0);

  // ---- 4. the fingerprint the peers compare -------------------------------
  console.log('\n== the fingerprint is exchanged on schedule and is reproducible ==');
  const hashes = await all('lsHash');
  const hf = hashes.map((m) => m.f);
  hf.length >= 3 && hf.every((f) => f % 10 === 0)
    ? ok('hash-cadence', `frames ${hf.join(', ')} at hashEvery=10`) : bad('hash-cadence', hf.join(','));
  const h0 = hashes[0];
  let hh = 0x811c9dc5 >>> 0;
  for (const w of h0.w) { hh = (hh ^ (w >>> 0)) >>> 0; hh = Math.imul(hh, 0x01000193) >>> 0; }
  is('hash-is-fnv-of-words', h0.h >>> 0, hh >>> 0);

  // ---- 5. a stall is NOT repaid — the forbidden speed-up ------------------
  console.log('\n== a stall is lost time, never repaid as a sprint ==');
  await clear();
  const cyc0 = fp.w[12] >>> 0;
  // Drip-feed 30 frames over ~1 s: half the rate the core could run at. Under
  // lockstep the core must run 30, not 60 — and when the drip ends it must not
  // burst through a backlog.
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    await page.evaluate((f) => { const st = new Uint8Array(256); st[0] = f & 255;
      window.__w.postMessage({ cmd: 'lsInput', f, states: st.buffer }, [st.buffer]); }, 30 + i);
    await new Promise((r) => setTimeout(r, 33));
  }
  await new Promise((r) => setTimeout(r, 400));
  const wall = Date.now() - t0;
  const drip = (await msgs('lsFrame')).length;
  drip === 30 ? ok('drip-exact', `30 frames over ${wall} ms — the core did NOT run the ~${Math.round(wall / 16.67)} it had time for`)
              : bad('drip-exact', `${drip} frames in ${wall} ms`);
  // Now hand it a backlog all at once. If the governor had banked the stalled
  // time it would sprint through this; it must still be paced.
  await page.evaluate(() => {
    for (let i = 0; i < 480; i++) {
      const st = new Uint8Array(256); st[0] = i & 255;
      window.__w.postMessage({ cmd: 'lsInput', f: 60 + i, states: st.buffer }, [st.buffer]);
    }
  });
  // ⚠ MEASURE FROM FRAME TIMESTAMPS, NOT FROM A WINDOW COUNT. Posting 480
  // messages takes real time and the pump runs the whole while, so "frames
  // since I cleared, divided by my sleep" credits the window with work done
  // before it opened — which is what made the first version of this arm read
  // 159.6/s. Let it settle, then read the INTERVALS between frames.
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => { window.__frameAt.length = 0; });
  await new Promise((r) => setTimeout(r, 2000));
  const iv = await page.evaluate(() => {
    const a = window.__frameAt.slice();
    const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
    d.sort((x, y) => x - y);
    return { n: a.length, span: a.length > 1 ? a[a.length - 1] - a[0] : 0, med: d.length ? d[d.length >> 1] : 0 };
  });
  const rate = iv.span > 0 ? (iv.n - 1) / (iv.span / 1000) : 0;
  rate > 0 && rate < 75
    ? ok('no-catch-up-sprint', `${iv.n} frames over ${Math.round(iv.span)} ms = ${rate.toFixed(1)}/s (median gap ${iv.med.toFixed(1)} ms) with a 480-frame backlog in hand — still ~1.000x, the stall was not repaid`)
    : bad('no-catch-up-sprint', `${rate.toFixed(1)} frames/s, median gap ${iv.med.toFixed(2)} ms — the guest sped up to burn the backlog`);

  // ---- 6. a stale fingerprint is refused, not returned -------------------
  console.log('\n== a mid-suspend fingerprint is refused, not guessed ==');
  await clear();
  await page.evaluate(() => {
    const st = new Uint8Array(256); st[63] = 0xab;      // the stub's "suspend now" marker
    window.__w.postMessage({ cmd: 'lsInput', f: 900, states: st.buffer }, [st.buffer]);
  });
  await send({ cmd: 'lockstep', on: false });
  await send({ cmd: 'lockstep', on: true, frame: 900, hashEvery: 0 });
  await page.evaluate(() => {
    const st = new Uint8Array(256); st[63] = 0xab;
    window.__w.postMessage({ cmd: 'lsInput', f: 900, states: st.buffer }, [st.buffer]);
  });
  await waitFor(() => window.__msgs.some((m) => m.cmd === 'lsFrame' && m.f === 900), 3000, 'suspend frame');
  await new Promise((r) => setTimeout(r, 200));
  await clear();
  await send({ cmd: 'lsFingerprint' });
  await waitFor(() => window.__msgs.some((m) => m.cmd === 'lsFingerprint'), 2000, 'refusal');
  const fp2 = (await msgs('lsFingerprint'))[0];
  fp2 && fp2.ok === false && /stale/.test(fp2.error || '')
    ? ok('suspend-refused', fp2.error) : bad('suspend-refused', JSON.stringify(fp2));

  // ---- 7. turning it off gives single player back --------------------------
  console.log('\n== lockstep does not leak into single player ==');
  await page.evaluate(() => {                   // clear the stub's suspend marker
    const st = new Uint8Array(256);
    window.__w.postMessage({ cmd: 'lsInput', f: 901, states: st.buffer }, [st.buffer]);
  });
  await new Promise((r) => setTimeout(r, 2500));   // let the stub's suspension decay
  await send({ cmd: 'lockstep', on: false });
  await clear();
  await new Promise((r) => setTimeout(r, 4500));
  const ips2 = (await msgs('ips')).map((m) => m.ips).slice(1);   // drop the partial first window
  const mean2 = ips2.reduce((a, c) => a + c, 0) / (ips2.length || 1);
  mean2 > 50 && mean2 < 70
    ? ok('freerun-restored', `${ips2.join(', ')} iters/s with no inputs queued — the gate is gone`)
    : bad('freerun-restored', `iters/s = ${ips2.join(', ')}`);
} catch (e) {
  bad('harness', e.message);
} finally {
  await browser.close();
  cleanup();
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

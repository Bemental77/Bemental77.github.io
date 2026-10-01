#!/usr/bin/env node
// genesis.html ROLLBACK, END TO END — two real pages, two real cores, one room.
//
// Same rig shape as tools/genesis_netplay_test.mjs (two WINDOWS in one Chrome,
// `?net=local` BroadcastChannel signalling, the host admits the joiner through
// the real Allow button, nobody presses Start). Each arm adds:
//   &nplag=MS   — the page's test seam: every incoming frame-input message is
//                 held MS ms before the engine sees it (an injected one-way
//                 network delay; the loopback wire itself is ~1 ms)
//   &rb=1 / &rb=0 — the HOST proposes rollback (the page default) or delay
//                 lockstep; the guest adopts the host's choice from 'lsgo'
//
// For each arm it drives both keyboards with a scripted pattern for --seconds
// and reports, from the pages' own seams (never a UI flag):
//   * local input-to-simulated-frame latency (window.__genNet().latency:
//     frames between the pad change and the first frame that RAN on it);
//   * rollbacks, re-simulated frames and their rate, max depth, the slowest
//     tick (a rollback burst has to fit the display tick);
//   * fingerprints compared on CONFIRMED frames, last agreed frame, no desync;
//   * the guest rate on both consoles over a 3 s window: must be <= 1.000x
//     hardware (+ sampling slack) and not wedged.
//
// USAGE   npm run web, then (holding the probe lock)
//   node tools/genesis_rollback_test.mjs --arms lockstep,rollback --lag 50 --seconds 60
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const SECONDS = +flag('seconds', 60);
const LAG = +flag('lag', 50);
const ARMS = flag('arms', 'lockstep,rollback').split(',');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const info = (name, cond, detail) => console.log(`  ${cond ? 'info' : 'INFO'}  ${name}  ${detail == null ? '' : detail}${cond ? '' : '  (BEFORE baseline — reported, not gated)'}`);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  ${detail == null ? '' : detail}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail == null ? '' : detail}`); }
};

async function openWindowPage(browser) {
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  await cdp.detach();
  for (let i = 0; i < 100; i++) {
    for (const t of browser.targets()) {
      const id = t._targetId || (t._targetInfo && t._targetInfo.targetId);
      if (id === targetId) { const p = await t.page(); if (p) return p; }
    }
    await sleep(100);
  }
  throw new Error('could not open a separate browser window for a peer');
}
async function openPeer(browser, query) {
  const page = await openWindowPage(browser);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`${BASE}/genesis.html?net=local${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!(window.Module && typeof window.Module._gpx_run === 'function'
    && window.__genNet && window.__genNet().supported), { timeout: 120000, polling: POLL_MS });
  return { page, errs };
}

async function arm(name, rb) {
  console.log(`\n=== arm: ${name} (rb=${rb ? 1 : 0}, injected one-way delay ${LAG} ms, ${SECONDS} s) ===`);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: has('headful') ? false : 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
  });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, 'genesis_rollback'); } catch (_e) {}
  const out = { name, rb, lag: LAG };
  try {
    // rollback is the page default; the lockstep arm opts out explicitly
    const q = `&nplag=${LAG}` + (rb ? '&rb=1' : '&rb=0');
    const A = await openPeer(browser, q), B = await openPeer(browser, q);
    const code = await A.page.evaluate(() => {
      document.getElementById('btnNet').click();
      document.getElementById('netHostBtn').click();
      return document.getElementById('netCode').textContent.trim();
    });
    await B.page.evaluate((c) => {
      document.getElementById('btnNet').click();
      document.getElementById('netJoinBtn').click();
      document.getElementById('netCodeIn').value = c;
      document.getElementById('netGo').click();
    }, code);
    const allowed = await A.page.waitForFunction(() => !!document.getElementById('npApproveAllow'), { timeout: 30000, polling: POLL_MS })
      .then(() => A.page.evaluate(() => { document.getElementById('npApproveAllow').click(); return true; })).catch(() => false);
    ok(`${name}: host-admits-the-joiner`, allowed, 'clicked the real Allow button');
    const running = (p) => p.page.waitForFunction(() => window.__genNet().frames > 60, { timeout: 90000, polling: POLL_MS })
      .then(() => true).catch(() => false);
    const [ra, rbb] = await Promise.all([running(A), running(B)]);
    ok(`${name}: both-cores-run`, ra && rbb, `host ${ra} guest ${rbb}`);
    const modes = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__genNet().mode)));
    ok(`${name}: mode-is-${rb ? 'rollback' : 'lockstep'}-on-both`, modes.every((m) => m === (rb ? 'rollback' : 'lockstep')),
       `host ${modes[0]}, guest ${modes[1]} (the guest was ${rb ? 'also given &rb=1; the HOST decides' : 'not asked for rollback'})`);

    // ---- play: scripted presses on BOTH consoles ------------------------------
    const keys = ['a', 's', 'ArrowLeft', 'ArrowRight', 'd'];
    const press = (p, k, down) => p.page.evaluate((k, down) => {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, bubbles: true }));
    }, k, down);
    // the LONG-WINDOW guest rate: frames over the whole play period, one clock
    const mark = () => Promise.all([A, B].map((p) => p.page.evaluate(() => ({ f: window.__genFrames | 0, t: performance.now(), hz: window.Module._gpx_fps() }))));
    const m0 = await mark();
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < SECONDS * 1000) {
      const who = (i % 3 === 2) ? B : (i % 2 ? B : A);
      const k = keys[i % keys.length];
      await press(who, k, true);
      await sleep(90 + (i * 37) % 160);
      await press(who, k, false);
      await sleep(60 + (i * 53) % 140);
      i++;
    }
    out.presses = i;
    const m1 = await mark();
    const longRate = m0.map((a, j) => ((m1[j].f - a.f) / ((m1[j].t - a.t) / 1000)) / (a.hz || 59.922751));
    out.longRate = longRate;
    // The lockstep arm is the BEFORE baseline: it is reported, not gated — a
    // lockstep room under injected delay stalls, which is its known cost.
    (rb ? ok : info)(`${name}: guest-rate-over-the-whole-run`, longRate.every((x) => x >= 0.9 && x <= 1.002),
       `host ${longRate[0].toFixed(4)}x guest ${longRate[1].toFixed(4)}x over ${SECONDS} s (${m1[0].f - m0[0].f} / ${m1[1].f - m0[1].f} frames; `
       + `bound 1.002 = one frame of sampling slack per ~8 s)`);
    // ---- guest rate (gate 9) --------------------------------------------------
    const rate = (p) => p.page.evaluate(async () => {
      const hz = window.Module._gpx_fps() || 59.922751;
      const f0 = window.__genFrames | 0, t0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      return (((window.__genFrames | 0) - f0) / ((performance.now() - t0) / 1000)) / hz;
    });
    const [xa, xb] = await Promise.all([rate(A), rate(B)]);
    const [na, nb] = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__genNet())));
    out.host = na; out.guest = nb; out.rate = [xa, xb];
    const lat = [...(na.latency || []), ...(nb.latency || [])];
    const hist = {}; for (const s of lat) hist[s.frames] = (hist[s.frames] || 0) + 1;
    const msSorted = lat.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
    out.latency = { n: lat.length, framesHistogram: hist, msP50: pct(msSorted, 0.5), msP90: pct(msSorted, 0.9) };
    console.log(`  ....  ${name}: ${i} presses; local input lag histogram (frames) ${JSON.stringify(hist)} over ${lat.length} pad changes (${(na.latencyOverlapped | 0) + (nb.latencyOverlapped | 0)} overlapping changes left out); `
      + `press->frame-that-ran-it p50 ${out.latency.msP50} ms p90 ${out.latency.msP90} ms; engine delay host ${na.engine && na.engine.delay} guest ${nb.engine && nb.engine.delay}`);
    if (rb) {
      ok(`${name}: zero-local-input-lag`, lat.length > 20 && Object.keys(hist).every((f) => +f === 0),
         `histogram ${JSON.stringify(hist)} — every pad change ran on the frame it was sampled for`);
      const eh = na.rollback.engine, eg = nb.rollback.engine, ph = na.rollback.page, pg = nb.rollback.page;
      const secs = SECONDS + 3;
      // lib/netplay.js ADAPTIVE ROOM: both pages declare rbCatchUp, so the host
      // must have made the room adaptive; the window may move, and the ring must
      // have followed it (a depth is bounded by the LARGEST window run).
      ok(`${name}: the-room-is-adaptive-and-the-ring-follows-the-window`, eh.adaptive && eg.adaptive
           && ph.ringFrames >= eh.ringFrames && pg.ringFrames >= eg.ringFrames,
         `adaptive ${eh.adaptive}/${eg.adaptive}; window ${eh.window}/${eg.window} (peak ${eh.windowPeak}/${eg.windowPeak}, ${eh.windowChanges}/${eg.windowChanges} changes); `
         + `ring ${ph.ringFrames}/${pg.ringFrames} savestates (engine asks ${eh.ringFrames}/${eg.ringFrames}); hidden catch-up frames ${ph.hidden}/${pg.hidden}; `
         + `step ${ph.stepMs}/${pg.stepMs} ms; late p99 ${eh.lateP99}/${eg.lateP99} frames`);
      // With NO injected delay a console whose display tick trails the other's
      // gets every input before it runs the frame and may never roll back at all
      // — that is the premise of "under injected delay", so it needs a delay.
      ok(`${name}: rollbacks-under-injected-delay`, (LAG > 0 ? (ph.rollbacks > 0 && pg.rollbacks > 0) : true) && ph.maxDepth <= (eh.windowPeak || eh.window) + 1 && pg.maxDepth <= (eg.windowPeak || eg.window) + 1
           && ph.missingSlot === 0 && pg.missingSlot === 0,
         `host ${ph.rollbacks} rollbacks / ${ph.resimFrames} re-sim frames (${(ph.resimFrames / secs).toFixed(1)}/s, max depth ${ph.maxDepth}, `
         + `mean ${eh.meanDepth}, ${eh.mispredicted} mispredicted inputs, slowest tick ${ph.maxTickMs} ms); `
         + `guest ${pg.rollbacks} / ${pg.resimFrames} (${(pg.resimFrames / secs).toFixed(1)}/s, max ${pg.maxDepth}, mean ${eg.meanDepth}, `
         + `slowest tick ${pg.maxTickMs} ms); window stalls ${eh.windowStalls}/${eg.windowStalls}, advantage waits ${eh.advantageWaits}/${eg.advantageWaits}`);
    } else {
      info(`${name}: lockstep-local-lag-is-the-delay`, lat.length > 20 && Object.keys(hist).every((f) => +f >= 2),
         `histogram ${JSON.stringify(hist)} — every pad change waited >= 2 frames (the delay floor)`);
    }
    const eA = na.engine || {}, eB = nb.engine || {};
    ok(`${name}: fingerprints-agree-on-confirmed-frames`, na.state !== 'desync' && nb.state !== 'desync'
         && eA.hashesCompared > 10 && eB.hashesCompared > 10 && eA.lastAgreedFrame > 60 * (SECONDS - 10),
       `state ${na.state}/${nb.state}; compared ${eA.hashesCompared}/${eB.hashesCompared}; last agreed frame ${eA.lastAgreedFrame}/${eB.lastAgreedFrame} `
       + `(host frame ${na.frame}); desync ${JSON.stringify(eA.desync || eB.desync || null)}`);
    const rOk = (x) => x >= 0.9 && x <= 1.02;
    (rb ? ok : info)(`${name}: guest-rate-1.000x`, rOk(xa) && rOk(xb), `host ${xa.toFixed(4)}x guest ${xb.toFixed(4)}x hardware (never above; not wedged)`);
    const errs = [...A.errs, ...B.errs].filter((e) => !/favicon/i.test(e));
    ok(`${name}: no-page-errors`, errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  } catch (e) {
    fail++; console.log('  FAIL  harness  ' + ((e && e.stack) || e));
  } finally {
    try { await browser.close(); } catch (e) {}
  }
  return out;
}

const res = { when: new Date().toISOString(), load: '', arms: [] };
try { res.load = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) {}
console.log('load: ' + res.load);
for (const a of ARMS) res.arms.push(await arm(a, a === 'rollback'));
try { res.loadAfter = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) {}
console.log('load after: ' + res.loadAfter);
writeFileSync('/tmp/genesis-rollback-test.json', JSON.stringify(res, (k, v) => (k === 'image' ? undefined : v), 1));
console.log(`\n[genesis-rollback] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

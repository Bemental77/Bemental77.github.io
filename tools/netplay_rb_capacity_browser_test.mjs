#!/usr/bin/env node
// ============================================================================
// netplay_rb_capacity_browser_test.mjs — CAPACITY-GATED ROLLBACK IN A REAL
// BROWSER: a console that cannot afford rollback switches the room to delay
// lockstep, at the same frame on both pages, with 0 desyncs.
//
// Two real genesis.html pages (two windows, one Chrome, `?net=local`, the host
// admits the joiner through the real Allow button, rollback — the page default
// — with `&nplag=MS` injected one-way delay so the room re-simulates). After a
// few seconds the GUEST page's CPU is throttled through CDP
// (Emulation.setCPUThrottlingRate) — a phone, in effect. Its measured rollback
// step (genesis.html rbStep: load + run + save, published as ls.selfStepMs)
// rises; the host's capacity gate (lib/netplay.js _capDecide) must switch the
// room to delay lockstep: both pages emit 'mode' -> delay at the SAME frame, the
// slow page's own text says "this device is too slow for zero-lag mode", the
// room goes on comparing fingerprints with 0 desyncs, and neither console runs
// above 1.000x (gate 9). genesis.html declares no rbResume and has run rollback
// frames, so the room stays in delay after the throttle is lifted (its ring
// cannot be re-armed mid-session) — asserted too.
// USAGE  npm run web, then (holding the probe lock)
//   bash tools/probe_lock.sh run -- node tools/netplay_rb_capacity_browser_test.mjs [--throttle 6] [--lag 50]
// ============================================================================
import { createRequire } from 'module';
import { execSync } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const THROTTLE = +flag('throttle', 6);
const LAG = +flag('lag', 50);
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const POLL_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const SNAP = () => {
  const s = (window.Netplay.sessions || []).filter((x) => x && x.ls).slice(-1)[0];
  if (!s) return null;
  const r = s.ls.report();
  return { state: r.state, frame: r.frame, mode: s.ls.rollback ? 'rollback' : 'delay', delay: s.ls.delay, compared: r.hashesCompared,
           lastAgreed: r.lastAgreedFrame, desync: r.desync, error: r.error, st: +(+s.ls.selfStepMs || 0).toFixed(2),
           need: r.mode ? r.mode.need : null, modes: (window.__modes || []).slice() };
};
const rate = (p, ms) => p.page.evaluate(async (ms) => {
  const hz = window.Module._gpx_fps() || 59.922751;
  const f0 = window.__genFrames | 0, t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  return (((window.__genFrames | 0) - f0) / ((performance.now() - t0) / 1000)) / hz;
}, ms);

const load0 = (() => { try { return execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) { return ''; } })();
console.log('load: ' + load0);
console.log(`=== capacity gating in the browser: guest CPU throttled ${THROTTLE}x, ${LAG} ms injected one-way delay ===`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: has('headful') ? false : 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'netplay_rb_capacity'); } catch (_e) {}
try {
  const q = `&rb=1&nplag=${LAG}`;
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
  ok('host-admits-the-joiner', allowed, 'clicked the real Allow button');
  const running = (p) => p.page.waitForFunction(() => window.__genNet().frames > 60, { timeout: 90000, polling: POLL_MS })
    .then(() => true).catch(() => false);
  const [ra, rb] = await Promise.all([running(A), running(B)]);
  ok('both-cores-run', ra && rb, `host ${ra} guest ${rb}`);
  for (const P of [A, B]) {
    await P.page.evaluate(() => {
      window.__modes = [];
      const s = window.Netplay.sessions.filter((x) => x && x.ls).slice(-1)[0];
      s.ls.on('mode', (e) => window.__modes.push({ frame: e.frame, to: e.to, delay: e.delay, mine: e.mine, text: e.text, t: Math.round(performance.now()) }));
    });
  }
  const keys = ['a', 's', 'ArrowLeft', 'ArrowRight', 'd'];
  const press = (p, k, down) => p.page.evaluate((k, down) => {
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, bubbles: true }));
  }, k, down);
  let playing = true;
  const player = (async () => {
    let i = 0;
    while (playing) {
      const p = i % 2 ? B : A, k = keys[i % keys.length];
      try { await press(p, k, true); await sleep(80 + (i * 37) % 120); await press(p, k, false); } catch (e) {}
      await sleep(60 + (i * 53) % 100); i++;
    }
  })();
  await sleep(6000);
  const s0 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  const r0 = await Promise.all([rate(A, 3000), rate(B, 3000)]);
  ok('before-the-throttle-the-room-is-rollback', s0.every((x) => x.mode === 'rollback') && !s0[0].modes.length,
     `modes ${s0[0].mode}/${s0[1].mode}; guest step ${s0[1].st} ms; rate host ${r0[0].toFixed(4)}x guest ${r0[1].toFixed(4)}x`);
  // ---- the guest becomes a slow device -----------------------------------
  const cdp = await B.page.target().createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const t0 = Date.now();
  const switched = await A.page.waitForFunction(() => (window.__modes || []).some((m) => m.to === 'delay'), { timeout: 60000, polling: POLL_MS })
    .then(() => true).catch(() => false);
  const tSw = ((Date.now() - t0) / 1000).toFixed(1);
  await sleep(3000);
  const s1 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  const ha = s1[0].modes.find((m) => m.to === 'delay'), gb = s1[1].modes.find((m) => m.to === 'delay');
  ok('the-room-switches-to-delay-on-both-at-the-same-frame', switched && ha && gb && ha.frame === gb.frame && s1.every((x) => x.mode === 'delay'),
     `switched ${tSw} s after the throttle; host at frame ${ha && ha.frame}, guest at ${gb && gb.frame}; delay ${s1[0].delay}/${s1[1].delay}; guest step ${s1[1].st} ms`);
  ok('the-slow-device-is-told-why', !!(gb && gb.mine && /^this device is too slow for zero-lag mode; using input delay/.test(gb.text)) && !!(ha && /too slow for zero-lag mode/.test(ha.text)),
     `guest: "${gb && gb.text}" | host: "${ha && ha.text}"`);
  await sleep(8000);
  const r1 = await Promise.all([rate(A, 5000), rate(B, 5000)]);
  const s2 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  ok('zero-desyncs-and-fingerprints-compared-after-the-switch', s2.every((x) => x.state !== 'desync' && !x.desync && x.state !== 'failed')
       && s2[0].compared > s1[0].compared && s2[0].lastAgreed > (ha ? ha.frame : 1e9),
     `state ${s2[0].state}/${s2[1].state}; compared host ${s1[0].compared}->${s2[0].compared}; last agreed ${s2[0].lastAgreed} (> switch frame ${ha && ha.frame})`);
  ok('never-above-1.000x', r1.every((x) => x <= 1.02), `throttled guest in delay lockstep: host ${r1[0].toFixed(4)}x guest ${r1[1].toFixed(4)}x hardware (rollback before the throttle: ${r0[0].toFixed(4)}x / ${r0[1].toFixed(4)}x)`);
  // ---- the throttle lifts: genesis.html cannot re-arm its ring mid-session --
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await sleep(15000);
  const s3 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  ok('a-page-without-rbResume-stays-in-delay', s3.every((x) => x.mode === 'delay') && s3[0].modes.length === 1,
     `modes ${s3[0].mode}/${s3[1].mode}; switches ${s3[0].modes.map((m) => m.to + '@' + m.frame).join(',')}`);
  playing = false; await player;
  const errs = [...A.errs, ...B.errs].filter((e) => !/favicon/i.test(e));
  ok('no-page-errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  fail++; console.log('  FAIL  harness  ' + ((e && e.stack) || e));
} finally {
  try { await browser.close(); } catch (e) {}
}
try { console.log('load after: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
console.log(`\n[rb-capacity-browser] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

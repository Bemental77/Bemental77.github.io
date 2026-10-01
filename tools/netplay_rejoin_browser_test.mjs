#!/usr/bin/env node
// ============================================================================
// netplay_rejoin_browser_test.mjs — A PLAYER WHOSE LINK DIED OUTRIGHT COMES
// BACK INTO THE GAME.
//
// Engine side, a rollback room already takes a silent player back (refill
// from the host's input store, hidden catch-up, 'lsrejoin' -> 'lsundrop';
// tools/netplay_rb_drop_test.mjs). What was missing was the SESSION: a link
// dead for longer than DISCONNECT_GRACE_MS closed both sessions (the pages
// disarmed), a re-knock was refused "this room has already started", and a
// re-admitted link would have been re-seat()ed mid-game. lib/netplay.js now
// keeps both sessions open in an adaptive rollback room, the guest re-knocks,
// the host lets a known seated player straight back in, and nobody is
// re-seated.
//
// THE RIG. Two real genesis.html pages (two windows, one Chrome, `?net=local`
// BroadcastChannel signalling, the host admits the joiner through the real
// Allow button, rollback — the page default). Both keyboards play. Then the
// GUEST's network dies, seen from the guest page:
//   t+0     every DataChannel message in or out of the guest is dropped, and
//           every signalling message too (a phone that lost its network);
//   t+12.5s its peer connection is closed and the session told the link is
//           gone — what DISCONNECT_GRACE_MS (12 s) does to a link that never
//           came back (Session._armDisconnectGrace -> _linkGone);
//   t+20s   the network returns: signalling flows again.
// The guest must re-knock, be let back in WITHOUT a human, be refilled, catch
// up, get its controller back (host 'rejoin'), and the room must go on
// comparing fingerprints with 0 desyncs — and the guest's own pad must reach
// the host's core again.
//
// USAGE  npm run web, then (holding the probe lock)
//   bash tools/probe_lock.sh run -- node tools/netplay_rejoin_browser_test.mjs [--dead 20] [--headful]
// ============================================================================
import { createRequire } from 'module';
import { execSync } from 'child_process';
const require = createRequire(process.env.PUPPETEER_FROM || (process.env.HOME + '/probe-deps/'));
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const DEAD_S = +flag('dead', 20);
const GRACE_S = 12.5;
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
// The session and its engine, from the page's own global (lib/netplay.js
// publishes every live session as Netplay.sessions).
const SNAP = () => {
  const s = (window.Netplay.sessions || []).filter((x) => x && x.ls).slice(-1)[0];
  if (!s) return null;
  const r = s.ls.report();
  return { sess: s.state, state: r.state, frame: r.frame, mode: r.rollback ? 'rollback' : 'delay', compared: r.hashesCompared,
           lastAgreed: r.lastAgreedFrame, desync: r.desync, error: r.error, limp: r.rollback ? r.rollback.limp : null,
           rejoins: r.rollback ? r.rollback.rejoins : 0, silentDrops: r.rollback ? r.rollback.silentDrops : 0,
           dropped: Array.from(s.ls.dropped.keys()), local: s.ls.localPorts.slice(), events: (window.__rj || []).slice(-12) };
};

const load0 = (() => { try { return execSync('uptime', { encoding: 'utf8' }).trim(); } catch (e) { return ''; } })();
console.log('load: ' + load0);
console.log(`=== a guest whose link is DEAD for ${DEAD_S} s (> the 12 s grace) rejoins a running rollback room ===`);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: has('headful') ? false : 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'netplay_rejoin'); } catch (_e) {}
try {
  const A = await openPeer(browser, '&rb=1'), B = await openPeer(browser, '&rb=1');
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
  ok('host-admits-the-joiner', allowed, 'clicked the real Allow button (the only human approval in this test)');
  const running = (p) => p.page.waitForFunction(() => window.__genNet().frames > 60, { timeout: 90000, polling: POLL_MS })
    .then(() => true).catch(() => false);
  const [ra, rb] = await Promise.all([running(A), running(B)]);
  ok('both-cores-run', ra && rb, `host ${ra} guest ${rb}`);
  // record the engines' leave/rejoin events and the sessions' status changes
  for (const P of [A, B]) {
    await P.page.evaluate(() => {
      window.__rj = [];
      const s = window.Netplay.sessions.filter((x) => x && x.ls).slice(-1)[0];
      const t0 = performance.now(), at = () => Math.round(performance.now() - t0);
      s.ls.on('leave', (e) => window.__rj.push(['leave', at(), e.at, e.who]));
      s.ls.on('rejoin', (e) => window.__rj.push(['rejoin', at(), e.at, e.who]));
      s.on('status', (e) => window.__rj.push(['status', at(), e.state, e.detail || '']));
    });
  }
  const s0 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  ok('the-room-is-rollback', s0.every((x) => x && x.mode === 'rollback'), `host ${s0[0] && s0[0].mode} guest ${s0[1] && s0[1].mode}`);

  const keys = ['a', 's', 'ArrowLeft', 'ArrowRight', 'd'];
  const press = (p, k, down) => p.page.evaluate((k, down) => {
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, bubbles: true }));
  }, k, down);
  const play = async (ms, who) => {
    const t0 = Date.now(); let i = 0;
    while (Date.now() - t0 < ms) {
      const p = who ? who : (i % 2 ? B : A), k = keys[i % keys.length];
      await press(p, k, true); await sleep(80 + (i * 37) % 120); await press(p, k, false); await sleep(60 + (i * 53) % 100); i++;
    }
  };
  await play(5000);

  // ---- THE GUEST'S NETWORK DIES ---------------------------------------------
  const cutAt = Date.now();
  await B.page.evaluate(() => {
    const s = window.Netplay.sessions.filter((x) => x && x.ls).slice(-1)[0];
    window.__cut = true;
    // signalling: nothing in, nothing out
    const sig = s._sig, send0 = sig.send.bind(sig), on0 = s._onSignal.bind(s);
    sig.send = (m) => { if (!window.__cut) return send0(m); };
    s._onSignal = (m) => { if (!window.__cut) return on0(m); };
    // every DataChannel message on the links that exist now, both ways
    for (const L of s._links.values()) {
      for (const dc of [L.dc, L.dcu]) {
        if (!dc) continue;
        const ds = dc.send.bind(dc), om = dc.onmessage;
        dc.send = (x) => { if (!window.__cut) return ds(x); };
        dc.onmessage = (e) => { if (!window.__cut && om) return om(e); };
      }
    }
    window.__cutLinks = Array.from(s._links.values());
  });
  console.log(`  ....  t+0: the guest's network is down (DataChannels and signalling both silent)`);
  await sleep(GRACE_S * 1000);
  // the grace runs out: the link is declared dead (what _armDisconnectGrace does)
  await B.page.evaluate(() => {
    const s = window.Netplay.sessions.filter((x) => x && x.ls).slice(-1)[0];
    for (const L of window.__cutLinks || []) { try { L.pc && L.pc.close(); } catch (e) {} s._linkGone(L, 'disconnected'); }
  });
  const mid = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  console.log(`  ....  t+${GRACE_S}s: guest link declared dead — host session '${mid[0].sess}' engine ${mid[0].state} f${mid[0].frame} dropped ${JSON.stringify(mid[0].dropped)}; `
    + `guest session '${mid[1].sess}' engine ${mid[1].state} f${mid[1].frame}`);
  ok('neither-session-closes-on-a-dead-link', mid[0].sess !== 'closed' && mid[1].sess !== 'closed' && mid[0].state !== 'failed' && mid[1].state !== 'failed',
     `host session '${mid[0].sess}', guest session '${mid[1].sess}' (the guest is re-knocking); engines ${mid[0].state}/${mid[1].state}`);
  ok('the-host-plays-on-without-them', mid[0].dropped.length === 1 && mid[0].frame > s0[0].frame + 60 * 10,
     `host dropped port(s) ${JSON.stringify(mid[0].dropped)} and ran ${mid[0].frame - s0[0].frame} frames since the cut`);
  await sleep(Math.max(0, DEAD_S * 1000 - (Date.now() - cutAt)));
  // ---- THE NETWORK RETURNS --------------------------------------------------
  await B.page.evaluate(() => { window.__cut = false; });
  console.log(`  ....  t+${((Date.now() - cutAt) / 1000).toFixed(1)}s: the guest's network is back`);
  const back = await A.page.waitForFunction(() => (window.__rj || []).some((e) => e[0] === 'rejoin'), { timeout: 60000, polling: POLL_MS })
    .then(() => true).catch(() => false);
  const tBack = (Date.now() - cutAt) / 1000;
  const s1 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  ok('the-guest-rejoins', back && s1[0].dropped.length === 0 && s1[1].sess === 'connected',
     `host 'rejoin' at t+${tBack.toFixed(1)}s; host dropped ${JSON.stringify(s1[0].dropped)}; guest session '${s1[1].sess}'; `
     + `host events ${JSON.stringify(s1[0].events.filter((e) => e[0] !== 'status'))}; guest events ${JSON.stringify(s1[1].events.slice(-6))}`);
  ok('no-human-was-asked', !(await A.page.evaluate(() => !!document.getElementById('npApproveAllow'))), 'no Allow prompt on the host for the returning player');

  // ---- PLAY ON, BOTH KEYBOARDS; THE GUEST'S PAD REACHES THE HOST'S CORE ----
  const imgP2 = () => A.page.evaluate(() => {
    const s = window.Netplay.sessions.filter((x) => x && x.ls).slice(-1)[0];
    const im = window.__genLsImage || [], pb = s.ls.padBytes | 0;
    return (im[pb] | 0) + ',' + (im[pb + 1] | 0);
  });
  const seen = new Set();
  const t1 = Date.now();
  let i = 0;
  while (Date.now() - t1 < 10000) {
    const k = keys[i % keys.length];
    await press(B, k, true); await sleep(120); seen.add(await imgP2()); await press(B, k, false); await sleep(90); seen.add(await imgP2());
    if (i % 2) { await press(A, keys[(i + 2) % keys.length], true); await sleep(60); await press(A, keys[(i + 2) % keys.length], false); }
    i++;
  }
  ok('the-guests-pad-drives-the-hosts-core-again', seen.size >= 3, `host's core saw ${seen.size} distinct port-2 pads in 10 s of the guest playing: ${[...seen].slice(0, 6).join(' | ')}`);
  await sleep(3000);
  const s2 = await Promise.all([A, B].map((p) => p.page.evaluate(SNAP)));
  ok('zero-desyncs', s2.every((x) => x.state !== 'desync' && !x.desync && x.state !== 'failed'),
     `host ${s2[0].state} guest ${s2[1].state}; desync ${JSON.stringify(s2[0].desync || s2[1].desync || null)}; errors ${s2[0].error || '-'} / ${s2[1].error || '-'}`);
  ok('fingerprints-compared-after-the-rejoin', s2[0].compared > s1[0].compared + 3 && s2[1].compared > s1[1].compared + 3
       && s2[0].lastAgreed > s1[0].frame && s2[1].lastAgreed > s1[0].frame,
     `compared host ${s1[0].compared}->${s2[0].compared}, guest ${s1[1].compared}->${s2[1].compared}; last agreed frame ${s2[0].lastAgreed}/${s2[1].lastAgreed} `
     + `(> ${s1[0].frame}, the host's frame at the rejoin)`);
  // gate 9 on both: never faster than the hardware
  const rate = (p) => p.page.evaluate(async () => {
    const hz = window.Module._gpx_fps() || 59.922751;
    const f0 = window.__genFrames | 0, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    return (((window.__genFrames | 0) - f0) / ((performance.now() - t0) / 1000)) / hz;
  });
  const [xa, xb] = await Promise.all([rate(A), rate(B)]);
  ok('guest-rate-1.000x-after-the-rejoin', xa >= 0.9 && xa <= 1.02 && xb >= 0.9 && xb <= 1.02, `host ${xa.toFixed(4)}x guest ${xb.toFixed(4)}x hardware`);
  const errs = [...A.errs, ...B.errs].filter((e) => !/favicon/i.test(e));
  ok('no-page-errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
} catch (e) {
  fail++; console.log('  FAIL  harness  ' + ((e && e.stack) || e));
} finally {
  try { await browser.close(); } catch (e) {}
}
try { console.log('load after: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
console.log(`\n[netplay-rejoin] ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

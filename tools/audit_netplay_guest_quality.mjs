#!/usr/bin/env node
// AUDIT RIG — written 2026-09-08 by an independent auditor, not by the author of
// the code under test. It exists to attack two things tools/mp_page_test.mjs
// asserts, and one thing it never asks at all.
//
// WHAT mp_page_test.mjs PROVES ABOUT THE GUEST'S PICTURE
//   `guest-frames-changing` passes when >= 2 of 16 samples, taken 400 ms apart,
//   differ in a 4x3 grid of block-mean luminance quantised by /8. That is a
//   LIVENESS test with a floor of roughly 0.3 frames per second. It is not a
//   quality test, and nothing else in that file is either.
//
// WHAT THIS RIG ADDS
//   A1  THE GUEST'S REAL RECEIVED FRAME RATE, from three independent instruments
//       that disagree in useful ways when something is wrong:
//         * video.requestVideoFrameCallback  — frames the compositor actually
//           presented to that <video>. This is what the human sees.
//         * video.getVideoPlaybackQuality()  — totalVideoFrames / droppedVideoFrames
//         * RTCPeerConnection.getStats() inbound-rtp — framesDecoded,
//           framesPerSecond, freezeCount, totalFreezesDuration
//       A stream can be `video:live`, non-black and "changing" at 1 fps. Only
//       these numbers say whether a person could play on it.
//
//   A2  A FALSIFICATION OF THE LIVENESS JUDGE ITSELF. The judge is only evidence
//       if it can FAIL. So the host's JS is suspended with CDP Debugger.pause,
//       which stops the emulator drawing to the canvas captureStream is reading —
//       the picture the guest sees becomes genuinely frozen while the track stays
//       live and connected, which is precisely the failure mode the judge claims
//       to catch. The IDENTICAL sampler and the IDENTICAL >= 2-distinct rule from
//       mp_page_test.mjs are then re-run against it.
//         judge says FROZEN  -> the instrument is real, and its PASS means something
//         judge says CHANGING-> the instrument over-reports and every
//                               `guest-frames-changing` PASS in the suite is void
//       This matters most on gba: the suite's own comment records that the
//       quantiser was WIDENED from /32 to /8 because Sonic Advance 3 scored 1-2
//       distinct on a live stream, i.e. the threshold was calibrated on the case
//       that was failing.
//
// The sampler below is a VERBATIM copy of tools/mp_page_test.mjs:407-437 so that
// a difference in verdict cannot be blamed on a difference in measurement.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web
//   node tools/audit_netplay_guest_quality.mjs gba genesis
//   AUDIT_MEASURE_MS=10000 node tools/audit_netplay_guest_quality.mjs snes
import puppeteer from 'puppeteer';
import fs from 'fs';
import { execSync } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const MEASURE_MS = +(process.env.AUDIT_MEASURE_MS || 10000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only the fields this rig needs; the emulator pages are the source of truth for
// everything else and mp_page_test.mjs already checks the rest.
const PLATFORMS = {
  ps1:     { lobby: '/ps1_multiplayer.html',     guestSeam: '__ps1mp',  hostSeam: '__ps1Net',  game: 'Monster Rancher 2',      bootMs: 900000 },
  genesis: { lobby: '/genesis_multiplayer.html', guestSeam: '__genmp',  hostSeam: '__genNet',  game: 'Sonic the Hedgehog 3',   bootMs: 180000 },
  snes:    { lobby: '/snes_multiplayer.html',    guestSeam: '__snesmp', hostSeam: '__snesNet', game: 'SimCity',                bootMs: 180000 },
  gba:     { lobby: '/gba_multiplayer.html',     guestSeam: '__gbamp',  hostSeam: '__gbaNet',  game: 'Sonic Advance 3',        bootMs: 180000 },
  n64:     { lobby: '/n64_multiplayer.html',     guestSeam: '__n64mp',  hostSeam: '__n64Net',  game: 'Mario Kart 64',          bootMs: 300000 },
};

const J = (v) => JSON.stringify(v);

// Poll from Node, never page.waitForFunction — one of the two tabs is always in
// the background and waitForFunction polls on rAF. mp_page_test.mjs records that
// trap producing a false negative.
async function until(page, fn, ms, everyMs = 250, arg = undefined) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(everyMs);
  }
}

async function keepAwake(page) {
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return cdp;
  } catch (e) { return null; }
}

// ── VERBATIM from tools/mp_page_test.mjs:407-437 ────────────────────────────
// Same canvas size, same 4x3 grid, same /8 quantiser, same 16 samples 400 ms
// apart. Copied rather than imported because that file is a script, not a module
// with exports; any drift between the two would invalidate the comparison, so the
// text is kept identical on purpose.
async function sampleSignatures(guest, n = 16, gapMs = 400) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(await guest.evaluate(() => {
      const v = document.getElementById('mpVideo');
      const c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, 160, 120);
      try { g.drawImage(v, 0, 0, 160, 120); } catch (e) { return { err: e.message }; }
      const d = g.getImageData(0, 0, 160, 120).data;
      let nonBlack = 0, sum = 0, hh = 2166136261;
      const gw = 4, gh = 3, acc = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
      for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
        const k = (y * 160 + x) * 4;
        const lum = d[k] + d[k + 1] + d[k + 2];
        if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
        sum += lum;
        hh = Math.imul(hh ^ (d[k] + d[k + 1] * 3 + d[k + 2] * 7), 16777619) >>> 0;
        acc[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)] += lum / 3;
        cnt[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)]++;
      }
      const means = Array.from(acc, (a, i2) => a / cnt[i2]);
      return { nonBlack, total: d.length / 4, mean: +(sum / (3 * d.length / 4)).toFixed(2), h: hh,
               means: means.map((m) => +m.toFixed(2)),
               coarse: means.map((m) => Math.round(m / 8)).join('.') };
    }));
    await sleep(gapMs);
  }
  const good = samples.filter((s) => !s.err);
  let spread = 0;
  if (good.length && good[0].means) {
    for (let c = 0; c < good[0].means.length; c++) {
      const col = good.map((s) => s.means[c]);
      spread = Math.max(spread, Math.max(...col) - Math.min(...col));
    }
  }
  return {
    distinctCoarse: new Set(good.map((s) => s.coarse)).size,
    distinctExact: new Set(good.map((s) => s.h)).size,
    spread: +spread.toFixed(2),
    maxNonBlack: Math.max(...good.map((s) => s.nonBlack), 0),
    // The suite's rule, applied unchanged.
    verdict: new Set(good.map((s) => s.coarse)).size >= 2 ? 'CHANGING' : 'FROZEN',
  };
}

// ── A1: what frame rate is this guest ACTUALLY receiving? ───────────────────
async function measureGuestFps(guest, ms) {
  return guest.evaluate(async (ms) => {
    const v = document.getElementById('mpVideo');
    if (!v) return { err: 'no #mpVideo' };
    const out = { ms, rvfc: null, presentedFrames: 0, quality: null };
    const q0 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;

    // requestVideoFrameCallback fires once per frame the compositor presents from
    // this element — the count a human would perceive as the frame rate.
    let n = 0, first = null, last = null;
    const done = new Promise((res) => {
      if (typeof v.requestVideoFrameCallback !== 'function') return res('unsupported');
      const step = (now, meta) => {
        n++;
        if (first === null) first = now;
        last = now;
        if (!stop) v.requestVideoFrameCallback(step);
      };
      let stop = false;
      v.requestVideoFrameCallback(step);
      setTimeout(() => { stop = true; res('ok'); }, ms);
    });
    const how = await done;
    const q1 = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    out.presentedFrames = n;
    out.rvfc = (how === 'ok' && n > 1 && last > first)
      ? +((n - 1) * 1000 / (last - first)).toFixed(2)
      : (how === 'unsupported' ? null : 0);
    if (q0 && q1) {
      out.quality = {
        totalVideoFrames: q1.totalVideoFrames - q0.totalVideoFrames,
        droppedVideoFrames: q1.droppedVideoFrames - q0.droppedVideoFrames,
        fpsFromTotal: +(((q1.totalVideoFrames - q0.totalVideoFrames) * 1000) / ms).toFixed(2),
      };
    }
    out.videoW = v.videoWidth; out.videoH = v.videoHeight;
    out.readyState = v.readyState; out.paused = v.paused;
    return out;
  }, ms);
}

// The guest pages call NetplayGuest.mount() and DISCARD its return value, so the
// RTCPeerConnection is not reachable from the page realm at all. Rather than ask
// the product to expose one for the auditor's convenience, wrap the constructor
// before any page script runs and keep every instance. This changes no product
// code and observes the real object the session built.
async function installPcRecorder(page) {
  await page.evaluateOnNewDocument(() => {
    const Real = window.RTCPeerConnection;
    if (!Real) return;
    window.__auditPcs = [];
    window.RTCPeerConnection = function (...a) {
      const pc = new Real(...a);
      window.__auditPcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Real.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Real);
  });
}

// The transport's own opinion, which is independent of anything the page renders.
async function measureInboundRtp(guest, seam, ms) {
  return guest.evaluate(async (arg) => {
    const [seam, ms] = arg;
    const pcs = window.__auditPcs || [];
    const pc = pcs[pcs.length - 1] || null;
    if (!pc || typeof pc.getStats !== 'function') return { err: 'no RTCPeerConnection recorded (' + pcs.length + ' seen)' };
    const read = async () => {
      const s = await pc.getStats();
      let v = null;
      s.forEach((rep) => { if (rep.type === 'inbound-rtp' && rep.kind === 'video') v = rep; });
      return v;
    };
    const a = await read();
    await new Promise((r2) => setTimeout(r2, ms));
    const b = await read();
    if (!a || !b) return { err: 'no inbound-rtp video report' };
    return {
      framesDecoded: b.framesDecoded - a.framesDecoded,
      framesReceived: (b.framesReceived || 0) - (a.framesReceived || 0),
      fpsFromDecoded: +(((b.framesDecoded - a.framesDecoded) * 1000) / ms).toFixed(2),
      framesPerSecondReported: b.framesPerSecond,
      freezeCount: b.freezeCount,
      totalFreezesDuration: b.totalFreezesDuration,
      frameWidth: b.frameWidth, frameHeight: b.frameHeight,
      bytesPerSec: +((((b.bytesReceived || 0) - (a.bytesReceived || 0)) * 1000) / ms).toFixed(0),
    };
  }, [seam, ms]);
}

// ───────────────────────────────────────────────────────────────────────────
async function run(key, browser, res) {
  const P = PLATFORMS[key];
  const out = { platform: key };
  const say = (t, d) => console.log(`  ${t.padEnd(30)} ${d}`);
  console.log(`\n╔══ ${key} ${'═'.repeat(50)}`);

  const host = await browser.newPage();
  host.on('pageerror', (e) => console.log(`  [host!] ${e.message}`));
  const hostCdp = await keepAwake(host);
  await host.goto(ORIGIN + P.lobby + '?net=local', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await until(host, (s) => (typeof window[s] === 'function' && window[s]().supported) || null, 30000, 250, P.guestSeam);
  const code = await host.evaluate((g) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelectorAll('#lobbyCard .np-row button')[0].click();
    return document.querySelector('#lobbyCard .np-code').textContent.trim();
  }, P.game);
  await host.evaluate((g) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelector('#lobbyCard .np-act button').click();
  }, P.game);
  say('code', code);
  await until(host, (s) => (typeof window[s] === 'function') ? true : null, 90000, 500, P.hostSeam);
  const booted = await until(host, (s) => (window[s]() || {}).live || null, P.bootMs, 1000, P.hostSeam);
  if (!booted) { say('host-booted', 'NO — aborting this platform'); out.error = 'host never booted'; res[key] = out; return 1; }
  const hostState = await host.evaluate((s) => window[s](), P.hostSeam);
  say('host capture', hostState.capture + '   audio: ' + (hostState.audio || 'none'));
  out.hostCapture = hostState.capture;

  const guest = await browser.newPage();
  guest.on('pageerror', (e) => console.log(`  [guest!] ${e.message}`));
  await installPcRecorder(guest);
  await keepAwake(guest);
  await guest.goto(ORIGIN + P.lobby + '?net=local&pad=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await until(guest, (s) => typeof window[s] === 'function' || null, 30000, 250, P.guestSeam);
  await guest.evaluate((g, c) => {
    document.querySelector('#lobbyCard .np-sel').value = g;
    document.querySelectorAll('#lobbyCard .np-row button')[1].click();
    document.querySelector('#lobbyCard .np-in').value = c;
    document.querySelector('#lobbyCard .np-act button').click();
  }, P.game, code);
  const conn = await until(guest, (s) => window[s]().state === 'connected' || null, 90000, 250, P.guestSeam);
  say('peers-connected', conn ? 'yes' : 'NO');
  await until(guest, (s) => window[s]().videoW > 0 || null, 30000, 250, P.guestSeam);
  await sleep(2500);   // let the stream settle before timing it

  // ---- A1 ------------------------------------------------------------------
  console.log('  ── A1: the frame rate the guest is ACTUALLY receiving');
  const [fps, rtp] = await Promise.all([
    measureGuestFps(guest, MEASURE_MS),
    measureInboundRtp(guest, P.guestSeam, MEASURE_MS),
  ]);
  out.fps = fps; out.rtp = rtp;
  say('presented (rVFC)', fps.rvfc === null ? 'rVFC unsupported'
      : `${fps.rvfc} fps  (${fps.presentedFrames} frames in ${MEASURE_MS} ms, ${fps.videoW}x${fps.videoH})`);
  if (fps.quality) say('decoder totals', `${fps.quality.fpsFromTotal} fps  dropped=${fps.quality.droppedVideoFrames}`);
  say('inbound-rtp', rtp.err ? rtp.err
      : `${rtp.fpsFromDecoded} fps decoded (reported ${rtp.framesPerSecondReported}), `
        + `${rtp.frameWidth}x${rtp.frameHeight}, ${rtp.bytesPerSec} B/s, freezes=${rtp.freezeCount}`);

  // ---- A2: does the suite's liveness judge FAIL when it should? ------------
  console.log('  ── A2: falsifying the `guest-frames-changing` judge');
  const live = await sampleSignatures(guest);
  out.liveJudge = live;
  say('host running', `${live.verdict}  (${live.distinctCoarse} distinct coarse, spread ${live.spread} levels, exact ${live.distinctExact})`);

  // Suspend the HOST's JS. The emulator stops drawing, so captureStream stops
  // producing new content — the guest's track stays live and connected while the
  // PICTURE is genuinely frozen. That is exactly the state the judge exists to
  // catch, so if it still says CHANGING it cannot catch anything.
  let paused = false;
  try {
    await hostCdp.send('Debugger.enable');
    await hostCdp.send('Debugger.pause');
    paused = true;
  } catch (e) { say('host-pause', 'FAILED: ' + e.message); }
  if (paused) {
    await sleep(2000);   // let the last frame settle on the guest
    const frozen = await sampleSignatures(guest);
    out.frozenJudge = frozen;
    say('host PAUSED', `${frozen.verdict}  (${frozen.distinctCoarse} distinct coarse, spread ${frozen.spread} levels, exact ${frozen.distinctExact})`);
    out.judgeFalsifiable = frozen.verdict === 'FROZEN';
    console.log(out.judgeFalsifiable
      ? '  VERDICT  the judge CAN fail -> its PASS on a running host is real evidence'
      : '  VERDICT  ** the judge reports CHANGING on a FROZEN picture — it over-reports **');
    try { await hostCdp.send('Debugger.resume'); await hostCdp.send('Debugger.disable'); } catch (e) {}
  }

  try {
    await guest.screenshot({ path: `/tmp/audit-mpq-${key}-guest.png` });
    say('screenshot', `/tmp/audit-mpq-${key}-guest.png`);
  } catch (e) {}

  await guest.close().catch(() => {});
  await host.close().catch(() => {});
  res[key] = out;
  console.log(`╚══ ${key} done`);
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const want = args.length ? args : ['gba', 'genesis'];
const load = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
console.log('== audit_netplay_guest_quality ==');
console.log('  uptime   ' + load);
console.log('  arms     ' + want.join(', ') + `   (${MEASURE_MS} ms measurement window)`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-background-timer-throttling',
         '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
         '--autoplay-policy=no-user-gesture-required', '--disk-cache-size=134217728'],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'audit_netplay_guest_quality'); } catch (_e) {}

const res = {};
for (const k of want) {
  if (!PLATFORMS[k]) { console.log('unknown platform ' + k); continue; }
  try { await run(k, browser, res); }
  catch (e) { console.log(`  HARNESS ${k}: ${e && e.stack ? e.stack.split('\n')[0] : e}`); res[k] = { harnessError: String(e) }; }
}
await browser.close().catch(() => {});
fs.writeFileSync('/tmp/audit-mpq.json', JSON.stringify({ when: new Date().toISOString(), uptime: load, res }, null, 2));

console.log('\n================ SUMMARY ================');
console.log('platform  presented-fps  decoded-fps  live-judge  host-PAUSED-judge  falsifiable');
for (const [k, v] of Object.entries(res)) {
  if (v.error || v.harnessError) { console.log(`${k.padEnd(9)} ${v.error || v.harnessError}`); continue; }
  console.log(`${k.padEnd(9)} ${String(v.fps && v.fps.rvfc).padEnd(14)} `
    + `${String(v.rtp && v.rtp.fpsFromDecoded).padEnd(12)} `
    + `${String(v.liveJudge && v.liveJudge.verdict).padEnd(11)} `
    + `${String(v.frozenJudge && v.frozenJudge.verdict).padEnd(18)} `
    + `${v.judgeFalsifiable === undefined ? '?' : v.judgeFalsifiable}`);
}
console.log('\njson  /tmp/audit-mpq.json');
console.log(`load at start: ${load.split('load averages:').pop().trim()}`);

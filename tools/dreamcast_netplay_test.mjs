#!/usr/bin/env node
// Does dreamcast.html actually stream a RUNNING GAME to a second browser tab,
// and does that tab's controller land on PLAYER 2?
//
// Modelled on tools/netplay_test.mjs, which proves lib/netplay.js in isolation
// on a synthetic canvas. This one proves the part that library cannot: the page
// TRANSFERS ITS CANVAS TO THE WORKER (dreamcast.html calls
// transferControlToOffscreen on #dc-canvas), so the surface the emulator draws
// on is not a surface the main thread owns. A netplay session that reports
// "video:live" while carrying nothing looks identical from the outside to one
// that works, so nothing here is asserted from a track's readyState alone:
// every video claim below is a PIXEL READING taken from the guest's own
// <video>, and the player-2 claim is the literal byte array the host handed to
// the emulator worker.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # gate, per CLAUDE.md
//   npm run web                                          # port 8080, gate #2
//   node tools/dreamcast_netplay_test.mjs
//
// ENV
//   CHROME_PATH   path to Chrome (default: the macOS bundle)
//   ORIGIN        default http://localhost:8080
//   DCNET_GAME    romSelect key (default 'gauntlet' — Gauntlet Legends is the
//                 co-op target; it is a two-player game, which is the point)
//   DCNET_BOOT_MS how long to wait for the host to boot (default 300000 — the
//                 disc is 563 MB of gzipped parts served by python http.server)
//   DCNET_AUDIO_WAIT_MS how long to WAIT FOR THE GAME TO MAKE A SOUND before
//                 voiding the audio cell (default 120000). Gauntlet Legends is
//                 silent through its VMU-check and logo screens and first went
//                 audible 22 s after the guest connected on this box.
//   DCNET_KEEP    leave the browser open at the end (debugging)
import puppeteer from 'puppeteer';
import fs from 'fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const GAME   = process.env.DCNET_GAME || 'gauntlet';
const BOOT_MS = parseInt(process.env.DCNET_BOOT_MS || '300000', 10);

const res = [];
const ok  = (n, d) => { res.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
// ⚠ A THIRD OUTCOME, and leaving it out is what made this rig publish a bare
// zero as if it were a reading. A cell whose PRECONDITION never happened has
// not passed and has not failed — it measured nothing, and printing it as
// either is a lie in one direction or the other. VOID says so, names the
// precondition, and is excluded from the tally.
const voidc = (n, d) => console.log(`  VOID  ${n}  ${d}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ POLL FROM NODE, never page.waitForFunction — it polls on rAF, and one of
// these two tabs is always in the background. tools/netplay_test.mjs records
// that exact trap producing a false "host=false" on a session whose own log
// already read connected.
async function until(page, fn, ms, everyMs = 250, onTick = null) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (onTick) onTick(Date.now() - t0);
    await sleep(everyMs);
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    // Both tabs must keep running: only one can be foreground, and headless
    // Chromium throttles rAF in the other — which would stop the host's input
    // pump, the mirror capture pump and the guest's pad send all at once.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // The guest attaches a <video> carrying the host's audio; without this the
    // element would be refused playback and the picture would never start.
    '--autoplay-policy=no-user-gesture-required',
    // A 563 MB disc per run, into a throwaway profile that only gets removed on
    // a clean exit (the flycast probe hit ENOSPC this way on 2026-09-01).
    '--disk-cache-size=33554432',
  ],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'dreamcast_netplay_test'); } catch (_e) {}

// dreamcast.html installs /coi-serviceworker.js and RELOADS ITSELF to become
// cross-origin isolated. Anything injected before that reload is thrown away,
// and a page evaluated during it throws "Execution context destroyed" — which
// reads exactly like a page crash. So: navigate, then wait for the isolated
// document to settle before touching anything.
const openPage = async (label, query) => {
  const p = await browser.newPage();
  // ⚠ NOT `e.message`. A wasm trap reaches this hook as an object with no
  // `message` — puppeteer's #handleException emitted a bare `ErrorEvent` and a
  // null — so reading it threw INSIDE the listener and took the whole run down
  // with a TypeError at this line, after the host had already booted. The rig
  // then looked like it had crashed when what it had actually done was
  // faithfully observe the core trapping.
  p.on('pageerror', (e) => console.log(`  [${label}!] ` +
    ((e && (e.message || e.type)) || (e === null ? 'null (no detail from the page)' : String(e)))));
  p.on('console', (m) => {
    const t = m.text();
    if (/\[net\]|\[flycast-worker\] load_disc|\[page\] worker ready|audio init failed/.test(t))
      console.log(`  [${label}] ${t}`);
  });
  await p.goto(ORIGIN + '/dreamcast.html' + query, { waitUntil: 'domcontentloaded', timeout: 120000 });
  const isolated = await until(p, () => (self.crossOriginIsolated === true) &&
    typeof window.__dcNet === 'function', 60000);
  return { page: p, isolated: !!isolated };
};

console.log('\n== two tabs, one origin ==');
// ?net=local -> BroadcastChannel signalling. Same browser, no third party, no
// network: the exact reason tools/netplay_test.mjs uses it. The shipped default
// is PeerJS, which is what pairs two DEVICES and is not testable headlessly
// here without depending on someone else's broker.
const H = await openPage('host',  '?net=local');
const G = await openPage('guest', '?net=local');
const host = H.page, guest = G.page;
(H.isolated && G.isolated)
  ? ok('pages-isolated', 'both tabs are cross-origin isolated and expose window.__dcNet')
  : bad('pages-isolated', `host=${H.isolated} guest=${G.isolated} — the coi service worker never took`);

const sup = await host.evaluate(() => window.__dcNet());
sup.supported ? ok('netplay-supported', `transport=${sup.transport}`)
              : bad('netplay-supported', 'Netplay.supported() is false in this browser');
// A control that cannot work must never be shown, and one that can must be.
const btnShown = await host.evaluate(() => {
  const b = document.getElementById('btnNet');
  return b ? getComputedStyle(b).display !== 'none' : null;
});
btnShown ? ok('button-gated-on-support', '#btnNet is visible because Netplay.supported() is true')
         : bad('button-gated-on-support', `#btnNet display resolved to ${btnShown}`);

console.log('\n== host boots ' + GAME + ' ==');
await host.evaluate((g) => {
  const s = document.getElementById('romSelect');
  s.value = g;
  document.getElementById('btnStart').click();
}, GAME);
let lastPhase = '';
const booted = await until(host, () => (window.__dcProbe && window.__dcProbe().booted) || false,
  BOOT_MS, 1000, async () => {
    const p = await host.evaluate(() => { const d = window.__dcProbe(); return d.phase + ' ' + Math.round(100 * d.discBytes / (d.discTotal || 1)) + '%'; }).catch(() => '');
    if (p && p !== lastPhase) { lastPhase = p; process.stdout.write(`  ....  booting  ${p}\r`); }
  });
process.stdout.write('\n');
const probe = await host.evaluate(() => window.__dcProbe());
booted ? ok('host-booted', `phase=${probe.phase} webgl2=${probe.webgl2} coi=${probe.coi}`)
       : bad('host-booted', `phase=${probe.phase} live=${probe.live} why=${probe.why}`);
// Frames have to be FLOWING before capture means anything — a frozen emulator
// would hand the guest a still image that passes a "non-black" check.
const flowing = await until(host, () => { const d = window.__dcProbe(); return d.fps > 0 || d.framesEver; }, 90000);
// And the rate has to be reported, not assumed: this runs in headless Chrome on
// a shared box, so how fast the host is actually producing distinct frames is
// the ceiling on everything the guest can be shown.
const rate = [];
for (let i = 0; i < 6; i++) { rate.push(await host.evaluate(() => window.__dcProbe().fps)); await sleep(1000); }
const vis = {
  host: await host.evaluate(() => document.visibilityState + (document.hidden ? '/hidden' : '')),
  guest: await guest.evaluate(() => document.visibilityState + (document.hidden ? '/hidden' : '')),
};
info('tab-visibility', `host=${vis.host} guest=${vis.guest} (rAF only runs in a presented tab; the pump has a timer watchdog for the other one)`);
flowing ? ok('host-rendering', `fps over 6 s = [${rate.join(', ')}] guest=${(await host.evaluate(() => window.__dcProbe().guestX)).toFixed(3)}x`)
        : bad('host-rendering', 'the emulator never reported a frame — nothing to stream');

console.log('\n== host opens the lobby and hosts ==');
// Driven through the UI, not by calling internals: a panel that does not open
// is a feature that does not exist.
await host.evaluate(() => document.getElementById('btnNet').click());
const panelOpen = await host.evaluate(() => document.getElementById('netOverlay').classList.contains('on'));
panelOpen ? ok('lobby-opens', '#netOverlay is on') : bad('lobby-opens', 'the panel did not open');
await host.evaluate(() => document.getElementById('netHostBtn').click());
const code = await until(host, () => {
  const t = document.getElementById('netCode').textContent.trim();
  return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;
}, 20000);
code ? ok('host-shows-code', `"${code}"`) : bad('host-shows-code', 'no code appeared');

// WHICH CAPTURE ARM WON. This is the answer to the transferred-canvas problem,
// measured rather than assumed, and it is reported either way.
const capture = await until(host, () => window.__dcNet().capture, 20000);
capture ? ok('capture-arm-chosen', capture) : bad('capture-arm-chosen', 'netCaptureSurface never resolved');

console.log('\n== guest joins ==');
await guest.evaluate((g, c) => {
  document.getElementById('btnNet').click();
  document.getElementById('netJoinBtn').click();
  document.getElementById('netGame').value = g;
  document.getElementById('netCodeIn').value = c;
  document.getElementById('netGo').click();
}, GAME, code || '');

// ⚠ THE HOST IS ASKED FIRST — docs/audit-2026-09-08.md. An inbound peer is held
// with no media, no input and no save until a human allows it; lib/netplay.js
// draws the dialog, so dreamcast.html needed no change to get it.
const prompt = await until(host, () => !!document.getElementById('npApproveAllow'), 60000);
prompt ? ok('host-is-asked-before-anything-flows', 'Allow/Deny raised on the host before any media or input')
       : bad('host-is-asked-before-anything-flows', 'no approval dialog — a code guesser would have been let in');
await host.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); });

const gConn = await until(guest, () => window.__dcNet().state === 'connected', 60000);
const hConn = await until(host,  () => window.__dcNet().state === 'connected', 60000);
(gConn && hConn) ? ok('peers-connected', 'both sides report connected')
                 : bad('peers-connected', `host=${hConn} guest=${gConn} — ` +
                     JSON.stringify(await host.evaluate(() => window.__dcNet())));

console.log('\n== the guest gets REAL GAME PIXELS, not a live-but-empty track ==');
const tracks = await until(guest, () => window.__dcNet().videoTracks, 30000);
(tracks && tracks.some((t) => t.startsWith('video:live')))
  ? ok('guest-track-live', JSON.stringify(tracks))
  : bad('guest-track-live', JSON.stringify(tracks));
// The element is the guest's whole screen: it must be VISIBLE and the local
// (permanently black) canvas must be out of the way. Wait for a decoded frame
// first — videoWidth stays 0 until one arrives, and reading it too early is a
// rig timing artifact rather than a finding.
await until(guest, () => { const v = document.getElementById('netVideo'); return v.videoWidth > 0; }, 30000);
const view = await guest.evaluate(() => {
  const v = document.getElementById('netVideo'), c = document.getElementById('dc-canvas');
  return { videoShown: getComputedStyle(v).display !== 'none',
           canvasHidden: getComputedStyle(c).display === 'none',
           w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, paused: v.paused };
});
(view.videoShown && view.canvasHidden && view.w > 0)
  ? ok('guest-view-swapped', `<video> ${view.w}x${view.h} readyState=${view.readyState} paused=${view.paused}, local canvas hidden`)
  : bad('guest-view-swapped', JSON.stringify(view));

// THE ASSERTION THAT MATTERS. Sample the guest's own <video> repeatedly and
// read the pixels: a black track, a frozen track and a live one are three
// different answers and only the third passes.
// 16 samples at 400 ms = ~6.4 s. Deliberately long: the host's DISTINCT frame
// rate is the ceiling on how fast this picture can change, and on a starved
// headless rig that can be single digits per second.
const samples = [];
for (let i = 0; i < 16; i++) {
  const s = await guest.evaluate(() => {
    const v = document.getElementById('netVideo');
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, 160, 120);
    try { g.drawImage(v, 0, 0, 160, 120); } catch (e) { return { err: e.message }; }
    const d = g.getImageData(0, 0, 160, 120).data;
    let nonBlack = 0, sum = 0, h = 2166136261;
    // ⚠ AN EXACT PIXEL HASH OVER-COUNTS "CHANGE". The video arrives through a
    // LOSSY codec, so two decodes of one identical source frame differ in the
    // low bits and every sample looks distinct — the first run of this test
    // reported "16 distinct frames" off a host producing about one frame per
    // second. So a COARSE signature is computed alongside it: a 4x3 grid of
    // block means, quantised to 8 levels. That survives codec noise and only
    // moves when the picture really moves.
    const gw = 4, gh = 3, acc = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
      const k = (y * 160 + x) * 4;
      const lum = d[k] + d[k + 1] + d[k + 2];
      if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
      sum += lum;
      h = Math.imul(h ^ (d[k] + d[k + 1] * 3 + d[k + 2] * 7), 16777619) >>> 0;
      const b = ((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0);
      acc[b] += lum / 3; cnt[b]++;
    }
    const coarse = Array.from(acc, (v, i) => Math.round(v / cnt[i] / 32)).join('.');
    return { nonBlack, total: d.length / 4, mean: +(sum / (3 * d.length / 4)).toFixed(2), h, coarse };
  });
  samples.push(s);
  await sleep(400);
}
const good = samples.filter((s) => !s.err);
const maxNonBlack = Math.max(...good.map((s) => s.nonBlack), 0);
const distinct = new Set(good.map((s) => s.coarse)).size;
const distinctExact = new Set(good.map((s) => s.h)).size;
info('frame-signatures', `${distinctExact} distinct exact hashes vs ${distinct} distinct coarse ` +
  `signatures — the gap is lossy-codec noise, and only the coarse count is evidence of motion`);
(maxNonBlack > 0)
  ? ok('guest-frames-non-black', `${maxNonBlack}/${good[0] ? good[0].total : 0} pixels lit at peak; means ${good.map((s) => s.mean).join(', ')}`)
  : bad('guest-frames-non-black', `every sample was pure black — a live track carrying nothing. ${JSON.stringify(samples)}`);
(distinct >= 2)
  ? ok('guest-frames-changing', `${distinct} distinct COARSE signatures across ${good.length} samples over ~6.4 s ` +
      `(block means ${[...new Set(good.map((s) => s.coarse))].slice(0, 4).join('  ')})`)
  : bad('guest-frames-changing', `only ${distinct} distinct coarse signature(s) — the picture is frozen, not live`);

console.log('\n== the guest can HEAR the game ==');
// Sound, MEASURED rather than inferred from a track's readyState. `audio:live`
// says a track exists, NOT that anything is coming out of it: an inbound WebRTC
// audio track produces no samples at all until an HTMLMediaElement renders it,
// and a guest measuring the track through Web Audio alone read peak 0.00000
// while packets were arriving. lib/netplay.js now sinks the track itself.
//
// ⚠ THE WINDOW IS THE WHOLE PROBLEM, and a fixed one is why this section used
// to publish a bare zero. Until 2026-09-07 it read the level ONCE for 2 s
// immediately after the video samples and reported whatever it found. MEASURED
// on the two-tab run that produced that zero: the host's own captured track sat
// at exactly 0.00000 for the first 20 s after the guest connected and then went
// to 0.21875 at t+22s, with the guest reading 0.20911 in the same second and a
// peak of 0.25337 over the session. The screenshot at the moment of the zero is
// Gauntlet Legends' "VMU has adequate storage space" screen — the game had not
// made a sound yet. So the 2 s window was landing ~20 s early on a SILENT part
// of the boot, and the rig reported the game's own silence as if it were a
// finding about netplay.
//
// A LEVEL OF ZERO IS THEREFORE NOT A RESULT UNLESS THE HOST IS AUDIBLE. What is
// asserted is the implication that is a fault no matter what is on screen:
//   host makes a sound  =>  the guest hears it.
// The rig WAITS for the antecedent (polling a persistent analyser on each side)
// and, if the game never makes a sound inside the window, VOIDs the cell and
// says which screen it was looking at instead of scoring it.
//
// What IS asserted unconditionally is the pair of things that are faults
// regardless of what the game is playing: an audio track must be there, and the
// guest's element must be AUDIBLE.
const AUDIO_WAIT_MS = parseInt(process.env.DCNET_AUDIO_WAIT_MS || '120000', 10);
const AUDIBLE = 0.0001;   // above Opus comfort noise: a silent track reads 0.00003

// AUDIBILITY IS AN ELEMENT STATE, NOT A TRACK STATE. A muted element renders
// the samples exactly the same (measured: peak 0.506 through a muted <audio>),
// so an analyser reading cannot tell you whether a person hears anything —
// only #netVideo.muted can.
const ga = await guest.evaluate(() => window.__dcNet().guestAudio);
(ga && ga.hasAudioTrack)
  ? ok('guest-has-audio-track', 'the received stream carries an audio track')
  : bad('guest-has-audio-track', JSON.stringify(ga) + ' — the host published no sound');
(ga && ga.audible)
  ? ok('guest-audio-audible', `#netVideo muted=${ga.muted} paused=${ga.paused} — the sound is actually being played, not just received`)
  : bad('guest-audio-audible', JSON.stringify(ga) +
      ' — a connected guest that cannot hear anything. A muted element still ' +
      'decodes, so this is invisible to a track-state or analyser check.');

// ⚠ MEASURE THE SENDER TOO, ALWAYS. A guest reading zero has two completely
// different causes and the guest-side number alone cannot separate them: the
// transport dropped the sound, or the EMULATOR ISN'T MAKING ANY. Reading the
// host's own captured MediaStreamDestination track back — the same track that
// was published, before it goes anywhere — makes every zero attributable.
//
// ⚠ AND ARM THE HOST ANALYSER ONLY AFTER THE SESSION EXISTS. netStartHost()
// awaits netCaptureSurface() (a 900 ms capture probe) BEFORE it constructs the
// Session, so __dcNetStream() returns null for about a second after the button
// click and an early read reports "the host published no audio track" for a
// session that has not been built yet. By this point the guest is connected, so
// the stream is there — but the failure mode is worth naming.
const armLevel = (page, side) => page.evaluate((side) => {
  const s = side === 'host' ? (window.__dcNetStream && window.__dcNetStream())
                            : document.getElementById('netVideo').srcObject;
  const at = s ? s.getAudioTracks() : [];
  if (!at.length) return { err: 'no audio track on this side' };
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(new MediaStream([at[0]]));
  const an = ac.createAnalyser(); an.fftSize = 2048;
  src.connect(an);
  window.__dcLevel = { ac, an, buf: new Float32Array(an.fftSize) };
  return { rate: ac.sampleRate, state: ac.state };
}, side);
const readLevel = (page) => page.evaluate(() => {
  const L = window.__dcLevel;
  if (!L) return null;
  L.an.getFloatTimeDomainData(L.buf);
  let p = 0;
  for (let k = 0; k < L.buf.length; k++) { const a = Math.abs(L.buf[k]); if (a > p) p = a; }
  return +p.toFixed(5);
});
const dropLevel = (page) => page.evaluate(() => {
  try { window.__dcLevel && window.__dcLevel.ac.close(); } catch (e) {}
  window.__dcLevel = null;
}).catch(() => {});

const hArm = await armLevel(host, 'host');
const gArm = await armLevel(guest, 'guest');
// Poll both sides together. The host is the trigger; the guest's peak is
// accumulated across the whole window and for a grace period afterwards,
// because the sound has to be encoded, sent and decoded before it can be read.
let hPeak = 0, gPeak = 0, firstSoundMs = null, hLast = 0, gLast = 0;
const tAudio0 = Date.now();
if (!hArm.err && !gArm.err) {
  for (;;) {
    const el = Date.now() - tAudio0;
    const h = await readLevel(host), g = await readLevel(guest);
    if (h != null && h > hPeak) hPeak = h;
    if (g != null && g > gPeak) gPeak = g;
    if (h != null) hLast = h;
    if (g != null) gLast = g;
    if (firstSoundMs == null && hPeak > AUDIBLE) {
      firstSoundMs = el;
      info('host-first-sound', `the emulator's own captured track went audible ${(el / 1000).toFixed(1)} s ` +
        `into the audio window (peak ${hPeak}) — everything before that was the game being silent, not a fault`);
    }
    // Stop as soon as the implication is settled either way, or the window ends.
    if (firstSoundMs != null && (gPeak > AUDIBLE || el > firstSoundMs + 5000)) break;
    if (el > AUDIO_WAIT_MS) break;
    await sleep(250);
  }
}
info('host-audio-tap', hArm.err ? hArm.err
  : `peak ${hPeak} on the host's OWN captured track, before the wire ` +
    `(${((Date.now() - tAudio0) / 1000).toFixed(1)} s window, last read ${hLast})`);
info('guest-audio-level', gArm.err ? gArm.err
  : `peak ${gPeak} on the received audio track over the same window (last read ${gLast})`);

// THE VERDICT IS THE IMPLICATION, and it is only scoreable once the host is
// audible. A guest zero under a host zero is the game being quiet; a guest zero
// under a host peak is a transport fault; both non-zero is the feature working.
if (hArm.err || gArm.err) {
  bad('guest-hears-the-game', `could not arm an analyser: host=${JSON.stringify(hArm)} guest=${JSON.stringify(gArm)}`);
} else if (hPeak <= AUDIBLE) {
  // Name the screen. "Zero" with a picture attached is diagnosable; "zero" is not.
  let shot = 'screenshot failed';
  try { await guest.screenshot({ path: '/tmp/dcnet-guest-silent-window.png' }); shot = '/tmp/dcnet-guest-silent-window.png'; }
  catch (e) {}
  voidc('guest-hears-the-game',
    `NOT MEASURED: the HOST'S OWN captured track never rose above ${AUDIBLE} in ` +
    `${(AUDIO_WAIT_MS / 1000).toFixed(0)} s (peak ${hPeak}), so ${GAME} produced digital silence for the ` +
    `whole window and the guest's ${gPeak} says nothing about the transport either way. ` +
    `This is what the emulator was showing: ${shot}. ` +
    `Gauntlet is silent through its VMU/logo screens — raise DCNET_AUDIO_WAIT_MS, ` +
    `or pick a disc that makes noise sooner.`);
} else if (gPeak > AUDIBLE) {
  ok('guest-hears-the-game',
    `host tap ${hPeak} -> guest ${gPeak}: the sound the EMULATOR made crossed a real ` +
    `RTCPeerConnection and came out of the other browser's element`);
} else {
  bad('guest-hears-the-game',
    `host tap ${hPeak} but guest ${gPeak} — the emulator WAS making sound and it did NOT cross. ` +
    `That is a transport fault, not a silent game.`);
}
await dropLevel(host); await dropLevel(guest);

// Evidence WHILE CONNECTED, which is the only moment the claim is about.
try {
  await guest.evaluate(() => document.getElementById('netClose').click());
  await guest.screenshot({ path: '/tmp/dcnet-guest-playing.png' });
  await guest.evaluate(() => document.getElementById('btnNet').click());
  info('screenshot-live', '/tmp/dcnet-guest-playing.png — the guest mid-session, lobby closed');
} catch (e) { info('screenshot-live', 'failed: ' + e.message); }

// A guest must NOT be able to boot a second emulator behind the video.
const startLocked = await guest.evaluate(() => {
  const b = document.getElementById('btnStart');
  return { disabled: b.disabled, title: b.title };
});
startLocked.disabled
  ? ok('guest-cannot-start-its-own', `#btnStart disabled: "${startLocked.title}"`)
  : bad('guest-cannot-start-its-own', 'a guest could boot a second Dreamcast behind the stream');

console.log('\n== the guest is PLAYER 2 ==');
// RETRO ids, from dreamcast.html's RB table: B=0 ('m', the Dreamcast CONFIRM)
// and RIGHT=7 ('d', which drives the d-pad AND full analog deflection).
// Port 1 occupies bytes 64..127 of the 256-byte pad buffer; __dcNet().sentP2 is
// bytes 64..75 of the buffer frameLoop ACTUALLY posted to the worker.
const p2 = () => host.evaluate(() => window.__dcNet().sentP2);
const p1 = () => host.evaluate(() => window.__dcPad().slice(0, 12));
const before = { p2: await p2(), p1: await p1() };
(before.p2 && before.p2.every((b) => b === 0))
  ? ok('player2-idle-before', 'port 1 is all zero with nobody pressing anything')
  : bad('player2-idle-before', JSON.stringify(before.p2));

const press = (page, keys, down) => page.evaluate((keys, down) => {
  keys.forEach((k) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k })));
}, keys, down);
// BOTH PLAYERS PRESS AT ONCE, and they press DIFFERENT things. This is the
// closest a headless rig gets to "two characters move independently": if the
// two ports were the same buffer, or the remote pad overwrote the local one,
// one of these two readings would have to be wrong.
//   guest: m = RETRO B (id 0)   d = RIGHT (id 7) + full analog RIGHT
//   host:  k = RETRO A (id 8)   a = LEFT  (id 6) + full analog LEFT
await press(guest, ['m', 'd'], true);
await press(host,  ['k', 'a'], true);
await sleep(900);
const during = { p2: await p2(), p1: await p1() };
await press(guest, ['m', 'd'], false);
await press(host,  ['k', 'a'], false);
await sleep(900);
const after = { p2: await p2(), p1: await p1() };

const s16 = (a, o) => a ? ((a[o] | (a[o + 1] << 8)) << 16) >> 16 : 0;
const B_BIT = 1 << 0, RIGHT_BIT = 1 << 7, LEFT_BIT = 1 << 6, A_BIT = 1 << 0;
const digital = during.p2 ? during.p2[0] : 0;
const lx = s16(during.p2, 8);
((digital & B_BIT) && (digital & RIGHT_BIT))
  ? ok('guest-pad-lands-on-port-1', `worker byte 64 = 0x${digital.toString(16)} (B|RIGHT) while the guest holds m+d`)
  : bad('guest-pad-lands-on-port-1', `worker byte 64 = 0x${Number(digital).toString(16)}, wanted bits 0 and 7 — ${JSON.stringify(during.p2)}`);
(lx > 30000)
  ? ok('guest-analog-crosses', `port 1 left-stick X = ${lx} (full right); the stick is what walks in these games`)
  : bad('guest-analog-crosses', `port 1 left-stick X = ${lx}`);
// PLAYER 1 IS THE HOST'S OWN CONTROLLER and must carry the HOST's input, not
// the guest's. Opposite stick direction, different face button.
const p1d0 = during.p1 ? during.p1[0] : 0, p1d1 = during.p1 ? during.p1[1] : 0;
const p1lx = s16(during.p1, 8);
((p1d0 & LEFT_BIT) && (p1d1 & A_BIT) && p1lx < -30000 && !(p1d0 & RIGHT_BIT))
  ? ok('two-independent-controllers', `port 0 = 0x${p1d0.toString(16)},0x${p1d1.toString(16)} lx=${p1lx} (host: A+LEFT) ` +
      `while port 1 = 0x${digital.toString(16)} lx=${lx} (guest: B+RIGHT) — opposite sticks, different buttons, same frame`)
  : bad('two-independent-controllers', `port 0 = ${JSON.stringify(during.p1)} port 1 = ${JSON.stringify(during.p2)}`);
(after.p2 && after.p2.every((b) => b === 0) && after.p1 && after.p1.every((b) => b === 0))
  ? ok('both-pads-release', 'ports 0 and 1 both returned to all-zero on key release')
  : bad('both-pads-release', `p1=${JSON.stringify(after.p1)} p2=${JSON.stringify(after.p2)}`);

console.log('\n== leaving ==');
await guest.evaluate(() => document.getElementById('netLeave').click());
const hostSawLeave = await until(host, () => {
  const s = window.__dcNet().state;
  return s === 'closed' || s === 'failed';
}, 20000);
hostSawLeave ? ok('host-sees-peer-leave', `host session state = ${hostSawLeave === true ? 'closed/failed' : hostSawLeave}`)
             : bad('host-sees-peer-leave', `host still reports ${await host.evaluate(() => window.__dcNet().state)}`);
// And the host must keep playing. A netplay session ending is not a reason for
// the emulator to stop.
const stillRunning = await host.evaluate(() => window.__dcProbe().booted);
stillRunning ? ok('host-keeps-playing', 'the emulator is still booted after the guest left')
             : bad('host-keeps-playing', 'the host stopped when the session ended');
// …and the guest gets its own Start back, so leaving is not a one-way door.
const guestAfter = await guest.evaluate(() => ({
  start: document.getElementById('btnStart').disabled,
  status: document.getElementById('netStatus').textContent,
  video: getComputedStyle(document.getElementById('netVideo')).display,
}));
(!guestAfter.start && guestAfter.video === 'none' && /Left the session/.test(guestAfter.status))
  ? ok('guest-restored-after-leave', `Start re-enabled, video hidden, status "${guestAfter.status}"`)
  : bad('guest-restored-after-leave', JSON.stringify(guestAfter));

// Evidence, not decoration: a screenshot is the only thing that answers "was
// there really a game on screen" after the fact.
try {
  await host.screenshot({ path: '/tmp/dcnet-host.png' });
  await guest.screenshot({ path: '/tmp/dcnet-guest.png' });
  info('screenshots', '/tmp/dcnet-host.png  /tmp/dcnet-guest.png');
} catch (e) { info('screenshots', 'failed: ' + e.message); }

const summary = {
  when: new Date().toISOString(), game: GAME, code,
  host: await host.evaluate(() => ({ net: window.__dcNet(), probe: window.__dcProbe() })).catch(() => null),
  guest: await guest.evaluate(() => window.__dcNet()).catch(() => null),
  videoSamples: samples,
  pad: { before, during, after },
  results: res,
};
fs.writeFileSync('/tmp/dcnet-result.json', JSON.stringify(summary, null, 2));
info('json', '/tmp/dcnet-result.json');

if (!process.env.DCNET_KEEP) await browser.close();
const failed = res.filter((r) => !r.ok);
console.log(`\n[dreamcast-netplay] ${res.length - failed.length}/${res.length} passed`);
process.exit(failed.length ? 1 : 0);

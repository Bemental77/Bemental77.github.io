#!/usr/bin/env node
// ============================================================================
// netplay_stream_baseline.mjs — WHAT THE CURRENT STREAMING NETPLAY COSTS
//                               PLAYER 2, IN NUMBERS
// ============================================================================
//
// WHY THIS EXISTS. The complaint about dreamcast.html's online play is stated
// in adjectives — "streaming old audio that is already past", "streaming shitty
// low pixel", player 2's input "costs a network round trip". None of that is
// falsifiable and none of it can be shown to have improved. This rig replaces
// each adjective with a measured figure, on the SHIPPED streaming path, so that
// a later lockstep build has something to beat.
//
// WHAT IS MEASURED, AND HOW EACH NUMBER IS OBTAINED
//
//   (a) INPUT-TO-VISIBLE, decomposed. A single end-to-end stopwatch cannot be
//       read on this content: Gauntlet's own scenes animate every frame, so
//       "the picture changed" is true continuously and a discrete stimulus is
//       buried in churn. So the latency is measured in the two legs that
//       STREAMING ADDS, each on its own instrument, plus the game's own
//       reaction time which is IDENTICAL on both sides because there is only
//       one emulator:
//
//         wire-in   guest keydown  ->  the host's emulator holds the byte
//                   Measured on BOTH processes' Date.now(), which is one system
//                   clock because both browsers are on one box. Two stamps:
//                   `remotePad` (the datachannel delivered it) and `sentP2`
//                   (the host's frameStep handed it to the emulator worker).
//                   `sentP2` is the one that counts — it is where the guest's
//                   press becomes emulator input.
//
//         video-out host's picture  ->  the same picture on player 2's screen
//                   NOT a discrete event. Both sides sample the SAME SIGNAL —
//                   the host samples #dc-canvas with drawImage (the page's own
//                   mirror arm proves that works on the transferred
//                   placeholder), the guest samples #netVideo on
//                   requestVideoFrameCallback — into 2x2 block-mean luminance,
//                   stamped with Date.now(). The guest's series IS the host's
//                   series delayed. Cross-correlating them recovers the delay,
//                   and the animation that defeats a discrete stopwatch is
//                   exactly what makes this instrument work.
//
//       player 2's total = the local console's own input-to-visible + wire-in +
//       video-out. The two added legs are what streaming costs and are what a
//       lockstep build removes.
//
//   (b) THE PICTURE PLAYER 2 ACTUALLY GETS. Resolution and frame rate are read
//       from `RTCRtpReceiver.getStats()` inbound-rtp (frameWidth/frameHeight/
//       framesPerSecond/framesDecoded/framesDropped/bytesReceived) and from the
//       element's own getVideoPlaybackQuality, then compared against the host's
//       native canvas size and the host's presented fps from __dcProbe.
//
//   (c) AUDIO DELAY RELATIVE TO THE HOST. Same cross-correlation, on sound.
//       The host taps its OUTGOING audio track — the copy lib/netplay.js:527-530
//       makes off the page's AudioWorkletNode, i.e. the same samples the host
//       is hearing — and the guest taps the received track off #netVideo's
//       srcObject. Both produce an RMS envelope at ~200 Hz stamped with
//       Date.now(); the lag that maximises correlation is how far behind the
//       host player 2's sound is. The receiver's own jitterBufferDelay /
//       jitterBufferEmittedCount is reported alongside as a corroborating
//       lower bound.
//
// WHAT THIS RIG CANNOT SAY, STATED UP FRONT RATHER THAN BURIED
//   * BOTH BROWSERS ARE ON ONE MACHINE. ICE resolves to loopback and the
//     candidate-pair RTT is reported precisely so that this is visible. Every
//     latency here is therefore a LOWER BOUND: a real second player adds their
//     network RTT to wire-in and (roughly) another RTT/2 to video-out. A
//     measured 0-ish RTT in the output is the rig telling you it did not test
//     the internet, not the internet being fast.
//   * A cross-correlation lag is only meaningful if the correlation is strong.
//     Every lag printed carries its peak r, and a peak below --minr is reported
//     as VOID with its r rather than as a number.
//   * The instruments themselves cost something. The host's extra drawImage per
//     rAF is the same work its own mirror capture arm does, and the guest rate
//     (__dcProbe().guestX) is recorded BEFORE and AFTER the whole run so that a
//     perturbation shows up instead of hiding. CLAUDE.md gate #9: the guest must
//     stay at 1.000x and this rig must not move it.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # mandatory gate
//   npm run web                                          # port 8080, gate #2
//   node dreamcast/tools/netplay_stream_baseline.mjs --name base1
//
// FLAGS
//   --name N        output basename. Log /tmp/dc-netbase/<N>.log, JSON <N>.json,
//                   screenshots <N>-host.png / <N>-guest.png
//   --game G        #romSelect value, default gauntlet
//   --url U         page origin, default http://localhost:8080
//   --profile-base D  parent dir for the TWO SEPARATE Chrome profiles. They are
//                   persistent by default so the 548 MB disc is fetched once
//                   rather than once per run; --fresh deletes them first.
//                   Separate is not optional: BroadcastChannel cannot cross a
//                   profile, which is what forces the real broker transport, and
//                   the rig proves the isolation rather than assuming it.
//   --fresh         delete both profiles before launching
//   --secs N        length of each steady-state sampling window, default 12
//   --reps N        wire-latency repetitions, default 20
//   --minr R        minimum cross-correlation peak to report a lag, default 0.5
//   --headful       show the browsers
//   --keep          leave them open at the end
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const NAME     = arg('name', 'base');
const GAME     = arg('game', 'gauntlet');
const ORIGIN   = arg('url', 'http://localhost:8080');
const PROFBASE = arg('profile-base', '/private/tmp/claude-501/dc-netbase');
const SECS     = parseInt(arg('secs', '12'), 10);
const REPS     = parseInt(arg('reps', '20'), 10);
const MINR     = parseFloat(arg('minr', '0.5'));
const FRESH    = has('fresh');
const HEADFUL  = has('headful');
const KEEP     = has('keep');
const BOOT_MS  = parseInt(arg('bootms', '900000'), 10);
const PAIR_MS  = parseInt(arg('pairms', '90000'), 10);
const CHROME   = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const OUTDIR = '/tmp/dc-netbase';
fs.mkdirSync(OUTDIR, { recursive: true });
const LOG = path.join(OUTDIR, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => {
  const line = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`;
  console.log(line); logStream.write(line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };

const RESULT = {
  when: new Date().toISOString(), name: NAME, game: GAME, origin: ORIGIN,
  uptimeStart: null, uptimeEnd: null, loadavgStart: os.loadavg(), loadavgEnd: null,
  wasm: null, transport: null, code: null,
  guestRate: { before: null, after: null },
  measurements: {}, stats: {}, notes: [],
};
const note = (s) => { RESULT.notes.push(s); say('  NOTE  ' + s); };

// ---------------------------------------------------------------------------
// signal maths — resample, high-pass, cross-correlate
//
// Both series are irregularly sampled (rAF on one side, requestVideoFrameCallback
// on the other) so they are put on a common uniform grid with a zero-order hold
// before anything is correlated. The high-pass removes slow brightness/loudness
// drift, which would otherwise dominate the correlation and put the peak at
// lag 0 no matter what the actual delay is.
// ---------------------------------------------------------------------------
const DT = 4;   // ms per grid step

function grid(samples, get, t0, t1) {
  const n = Math.floor((t1 - t0) / DT);
  const out = new Float64Array(n);
  let i = 0, last = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * DT;
    while (i < samples.length && samples[i].t <= t) { last = get(samples[i]); i++; }
    out[k] = last;
  }
  return out;
}
function highpass(a, winMs) {
  const w = Math.max(2, Math.round(winMs / DT));
  const out = new Float64Array(a.length);
  let sum = 0;
  const q = [];
  for (let i = 0; i < a.length; i++) {
    q.push(a[i]); sum += a[i];
    if (q.length > w) sum -= q.shift();
    out[i] = a[i] - sum / q.length;
  }
  return out;
}
function norm(a) {
  let m = 0; for (let i = 0; i < a.length; i++) m += a[i];
  m /= a.length || 1;
  let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
  s = Math.sqrt(s / (a.length || 1));
  const out = new Float64Array(a.length);
  if (s < 1e-12) return { out, sd: 0 };
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - m) / s;
  return { out, sd: s };
}
// r at lag L: guest[i] compared with host[i-L]. L>0 means the guest is BEHIND.
function corrAt(host, guest, L) {
  let s = 0, n = 0;
  for (let i = Math.max(0, L); i < guest.length; i++) {
    const j = i - L;
    if (j < 0 || j >= host.length) continue;
    s += host[j] * guest[i]; n++;
  }
  return n > 30 ? s / n : 0;
}
function xcorr(hostCh, guestCh, maxLagMs) {
  // hostCh / guestCh are arrays of channels (already gridded over the same t0..t1)
  const maxL = Math.round(maxLagMs / DT);
  const H = hostCh.map((c) => norm(highpass(c, 400)));
  const G = guestCh.map((c) => norm(highpass(c, 400)));
  const usable = H.filter((x) => x.sd > 0).length && G.filter((x) => x.sd > 0).length;
  if (!usable) return { lagMs: null, r: 0, why: 'one side has no variance at all — nothing to align' };
  const curve = [];
  for (let L = 0; L <= maxL; L++) {
    let acc = 0, k = 0;
    for (let c = 0; c < H.length && c < G.length; c++) {
      if (H[c].sd <= 0 || G[c].sd <= 0) continue;
      acc += corrAt(H[c].out, G[c].out, L); k++;
    }
    curve.push(k ? acc / k : 0);
  }
  let best = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] > curve[best]) best = i;
  // negative lags too: a peak below zero means the alignment is nonsense
  let bestNeg = 0, negR = -2;
  for (let L = 1; L <= maxL; L++) {
    let acc = 0, k = 0;
    for (let c = 0; c < H.length && c < G.length; c++) {
      if (H[c].sd <= 0 || G[c].sd <= 0) continue;
      acc += corrAt(G[c].out, H[c].out, L); k++;   // swapped: guest ahead
    }
    const r = k ? acc / k : 0;
    if (r > negR) { negR = r; bestNeg = L; }
  }
  return {
    lagMs: best * DT, r: curve[best], r0: curve[0],
    negPeak: { lagMs: -bestNeg * DT, r: negR },
    curve: curve.map((r, i) => ({ lagMs: i * DT, r: +r.toFixed(4) })),
  };
}
const pct = (a, p) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ---------------------------------------------------------------------------
// browsers
// ---------------------------------------------------------------------------
const browsers = [];
async function launch(tag) {
  const dir = path.join(PROFBASE, tag);
  if (FRESH) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : 'new',
    userDataDir: dir,
    args: [
      '--no-sandbox',
      '--enable-features=SharedArrayBuffer',
      // Only one window is foreground; without these the other's rAF stops and
      // the capture pump, the input pump and the pad send all die at once.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // The guest's <video> carries the host's audio; without this the element
      // is refused playback and the PICTURE never starts either.
      '--autoplay-policy=no-user-gesture-required',
      '--disk-cache-size=1073741824',
    ],
  });
  // MANDATORY per CLAUDE.md: a SIGKILLed parent orphans its browser and no
  // in-process handler can prevent it.
  // ⚠ file:// URL, not a bare absolute path: dynamic import() of an absolute
  // POSIX path is deprecated in Node and throws under some resolvers, and a
  // swallowed failure here is exactly how orphaned Chromes accumulate.
  try {
    const url = pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href;
    (await import(url)).default.guard(b, 'dc_netplay_baseline');
    say(`  leak-guard registered ${tag} browser (pid ${b.process() ? b.process().pid : '?'})`);
  } catch (e) { say('  ⚠ leak-guard registration FAILED: ' + ((e && e.message) || e)); }
  browsers.push(b);
  return b;
}

const SIDELOG = {};
function watch(page, label) {
  const s = SIDELOG[label] = { console: [], errors: [] };
  page.on('console', (m) => {
    const t = m.text();
    if (s.console.push(t.slice(0, 300)) > 600) s.console.shift();
    if (/\[net\]|netplay|peer|signal|\bice\b/i.test(t)) say(`  [${label}] ${t.slice(0, 200)}`);
  });
  page.on('pageerror', (e) => {
    const t = (e && (e.message || e.type)) || String(e);
    s.errors.push(String(t).slice(0, 300));
    say(`  [${label}!] ${String(t).slice(0, 200)}`);
  });
}

async function until(page, fn, ms, everyMs = 400, onTick = null) {
  const t = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) return null;
    if (onTick) { try { await onTick(Date.now() - t); } catch (e) {} }
    await sleep(everyMs);
  }
}
async function clickReal(page, sel) {
  try {
    await page.waitForSelector(sel, { visible: true, timeout: 15000 });
    await page.click(sel);
    return 'mouse';
  } catch (e) {
    try {
      const did = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
      return did ? 'el.click' : 'MISSING';
    } catch (e2) { return 'MISSING'; }
  }
}
// coi-serviceworker installs on the FIRST visit and reloads; land on the
// already-isolated document instead of racing it.
async function gotoSettled(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await sleep(2500);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
}

// ---------------------------------------------------------------------------
// the page-side instrument. ONE function, installed on both sides; which
// surface it samples is decided by which elements exist.
// ---------------------------------------------------------------------------
function installInstrument(page, role) {
  return page.evaluate((role) => {
    if (window.__nb) return 'already';
    const NB = window.__nb = {
      role, vid: [], net: [], aud: [],
      vidErr: null, audErr: null, audOn: false, vidOn: false,
      rafId: 0, netTimer: 0, audTimer: 0, frames: 0,
    };
    const W = 32, H = 24;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true, alpha: false });

    // 2x2 block-mean luminance. Four channels rather than one, because a scene
    // can hold its overall brightness while its contents move.
    function blocks(src) {
      try { g.drawImage(src, 0, 0, W, H); } catch (e) { NB.vidErr = String((e && e.message) || e); return null; }
      let d;
      try { d = g.getImageData(0, 0, W, H).data; } catch (e) { NB.vidErr = String((e && e.message) || e); return null; }
      const acc = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
      let nonBlack = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = (y * W + x) * 4;
          const lum = (d[k] + d[k + 1] + d[k + 2]) / 3;
          if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
          const b = (y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1);
          acc[b] += lum; cnt[b]++;
        }
      }
      return { b: acc.map((v, i) => v / cnt[i]), nonBlack };
    }

    NB.startVideo = function () {
      if (NB.vidOn) return true;
      const src = (role === 'host')
        ? document.getElementById('dc-canvas')      // the transferred placeholder
        : document.getElementById('netVideo');      // what player 2 sees
      if (!src) { NB.vidErr = 'no source element'; return false; }
      NB.vidOn = true;
      if (role === 'guest' && typeof src.requestVideoFrameCallback === 'function') {
        // ONE CALLBACK PER FRAME ACTUALLY PRESENTED — the only sampler that
        // cannot invent frames the decoder never produced.
        const tick = (now, meta) => {
          const s = blocks(src);
          if (s) NB.vid.push({ t: Date.now(), b: s.b, nb: s.nonBlack, mt: meta ? meta.mediaTime : null });
          if (NB.vid.length > 30000) NB.vid.shift();
          NB.frames++;
          if (NB.vidOn) { try { src.requestVideoFrameCallback(tick); } catch (e) {} }
        };
        try { src.requestVideoFrameCallback(tick); } catch (e) { NB.vidErr = 'rVFC threw: ' + e.message; }
      } else {
        const tick = () => {
          const s = blocks(src);
          if (s) NB.vid.push({ t: Date.now(), b: s.b, nb: s.nonBlack });
          if (NB.vid.length > 30000) NB.vid.shift();
          NB.frames++;
          if (NB.vidOn) NB.rafId = requestAnimationFrame(tick);
        };
        NB.rafId = requestAnimationFrame(tick);
      }
      return true;
    };
    NB.stopVideo = function () { NB.vidOn = false; if (NB.rafId) cancelAnimationFrame(NB.rafId); NB.rafId = 0; };

    // HOST ONLY: when did the guest's byte arrive, and when did the emulator get it.
    NB.startNet = function () {
      if (NB.netTimer) return true;
      let lastR = null, lastS = null;
      NB.netTimer = setInterval(() => {
        let n = null;
        try { n = window.__dcNet(); } catch (e) { return; }
        if (!n) return;
        const r = n.remotePad | 0;
        const s = n.sentP2 ? n.sentP2.some((b) => b !== 0) : false;
        if (r !== lastR || s !== lastS) {
          NB.net.push({ t: Date.now(), r, s, p2: n.sentP2 ? n.sentP2.slice(0, 12) : null });
          if (NB.net.length > 4000) NB.net.shift();
          lastR = r; lastS = s;
        }
      }, 1);
      return true;
    };
    NB.stopNet = function () { if (NB.netTimer) clearInterval(NB.netTimer); NB.netTimer = 0; };

    // RMS envelope at ~200 Hz. The host taps its OUTGOING track (the copy of the
    // AudioWorkletNode that lib/netplay.js:527-530 routes into the peer
    // connection = the samples the host is hearing); the guest taps the received
    // track off #netVideo's srcObject.
    NB.startAudio = function () {
      if (NB.audOn) return true;
      let track = null;
      try {
        if (role === 'host') {
          const sessions = (window.Netplay && window.Netplay.sessions) || [];
          const s = sessions.filter((x) => x.isHost).pop();
          const pc = s && s._pc;
          if (!pc) { NB.audErr = 'no RTCPeerConnection on the host session'; return false; }
          const snd = pc.getSenders().filter((x) => x.track && x.track.kind === 'audio');
          if (!snd.length) { NB.audErr = 'the host is sending NO audio track at all'; return false; }
          track = snd[0].track;
        } else {
          const v = document.getElementById('netVideo');
          const ms = v && v.srcObject;
          const at = ms ? ms.getAudioTracks() : [];
          if (!at.length) { NB.audErr = 'no audio track on the received stream'; return false; }
          track = at[0];
        }
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const an = ctx.createAnalyser();
        an.fftSize = 512; an.smoothingTimeConstant = 0;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        NB.audCtx = ctx; NB.audOn = true;
        NB.audMeta = { ctxRate: ctx.sampleRate, baseLatency: ctx.baseLatency || 0, outputLatency: ctx.outputLatency || 0, trackId: track.id };
        NB.audTimer = setInterval(() => {
          an.getFloatTimeDomainData(buf);
          let s2 = 0, peak = 0;
          for (let i = 0; i < buf.length; i++) { s2 += buf[i] * buf[i]; const a = Math.abs(buf[i]); if (a > peak) peak = a; }
          NB.aud.push({ t: Date.now(), r: Math.sqrt(s2 / buf.length), p: peak });
          if (NB.aud.length > 40000) NB.aud.shift();
        }, 5);
        return true;
      } catch (e) { NB.audErr = String((e && e.message) || e); return false; }
    };
    NB.stopAudio = function () { NB.audOn = false; if (NB.audTimer) clearInterval(NB.audTimer); NB.audTimer = 0; };

    NB.clear = function () { NB.vid.length = 0; NB.aud.length = 0; NB.net.length = 0; };
    NB.dump = function () {
      return {
        role: NB.role, vid: NB.vid.slice(), aud: NB.aud.slice(), net: NB.net.slice(),
        vidErr: NB.vidErr, audErr: NB.audErr, audMeta: NB.audMeta || null, frames: NB.frames,
      };
    };
    // Key press with the dispatch time captured in the SAME expression, so the
    // stamp is not an await away from the event.
    NB.press = function (keys, down) {
      const t = Date.now();
      keys.forEach((k) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k })));
      return t;
    };
    return 'installed';
  }, role);
}

// getStats, flattened to the rows that answer (b) and (c).
function readStats(page, wantInbound) {
  return page.evaluate(async (wantInbound) => {
    const sessions = (window.Netplay && window.Netplay.sessions) || [];
    const s = sessions[sessions.length - 1];
    const pc = s && s._pc;
    if (!pc) return { err: 'no RTCPeerConnection' };
    const out = { inboundVideo: null, inboundAudio: null, outboundVideo: null, outboundAudio: null, candidatePair: null, remoteInbound: null };
    const rep = await pc.getStats();
    rep.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') out.inboundVideo = r;
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.inboundAudio = r;
      if (r.type === 'outbound-rtp' && r.kind === 'video') out.outboundVideo = r;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.outboundAudio = r;
      if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded')) out.candidatePair = r;
      if (r.type === 'remote-inbound-rtp') out.remoteInbound = r;
    });
    const pick = (o, keys) => { if (!o) return null; const x = {}; keys.forEach((k) => { if (o[k] !== undefined) x[k] = o[k]; }); return x; };
    return {
      inboundVideo: pick(out.inboundVideo, ['timestamp', 'frameWidth', 'frameHeight', 'framesPerSecond', 'framesDecoded',
        'framesReceived', 'framesDropped', 'bytesReceived', 'packetsReceived', 'packetsLost', 'jitter',
        'jitterBufferDelay', 'jitterBufferEmittedCount', 'totalDecodeTime', 'totalInterFrameDelay', 'decoderImplementation', 'mimeType']),
      inboundAudio: pick(out.inboundAudio, ['timestamp', 'bytesReceived', 'packetsReceived', 'packetsLost', 'jitter',
        'jitterBufferDelay', 'jitterBufferEmittedCount', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
        'totalSamplesReceived', 'concealedSamples', 'audioLevel', 'totalAudioEnergy', 'playoutId']),
      outboundVideo: pick(out.outboundVideo, ['timestamp', 'frameWidth', 'frameHeight', 'framesPerSecond', 'framesSent',
        'framesEncoded', 'bytesSent', 'totalEncodeTime', 'qualityLimitationReason', 'scalabilityMode', 'encoderImplementation', 'mimeType']),
      outboundAudio: pick(out.outboundAudio, ['timestamp', 'bytesSent', 'packetsSent', 'totalSamplesSent', 'audioLevel']),
      candidatePair: pick(out.candidatePair, ['currentRoundTripTime', 'totalRoundTripTime', 'responsesReceived',
        'availableOutgoingBitrate', 'bytesSent', 'bytesReceived', 'state', 'nominated']),
      remoteInbound: pick(out.remoteInbound, ['roundTripTime', 'jitter', 'packetsLost', 'kind']),
    };
  }, wantInbound);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
RESULT.uptimeStart = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
const wasmPath = path.join(REPO, 'dreamcast', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const wasmHash = () => { try { return execSync(`shasum -a 256 "${wasmPath}"`).toString().split(' ')[0].slice(0, 16); } catch (e) { return 'unknown'; } };
RESULT.wasm = { path: wasmPath, sha256_16_before: wasmHash(), bytes: (() => { try { return fs.statSync(wasmPath).size; } catch (e) { return null; } })() };

say('== netplay_stream_baseline ==');
say(`  uptime      ${RESULT.uptimeStart}`);
say(`  loadavg     ${RESULT.loadavgStart.map((n) => n.toFixed(2)).join(' ')}`);
say(`  page        ${ORIGIN}/dreamcast.html   game "${GAME}"`);
say(`  wasm        ${RESULT.wasm.sha256_16_before}  ${RESULT.wasm.bytes} B`);
say(`  profiles    ${PROFBASE}/{host,guest}  ${FRESH ? '(deleted first)' : '(persistent — the disc is cached)'}`);
say(`  windows     ${SECS} s per steady-state arm, ${REPS} wire-latency reps`);

let hostB = null, guestB = null, host = null, guest = null, exitCode = 1;
try {
  hostB = await launch('host');
  guestB = await launch('guest');
  host = (await hostB.pages())[0];
  guest = (await guestB.pages())[0];
  watch(host, 'host'); watch(guest, 'guest');
  await host.setViewport({ width: 1280, height: 860 });
  await guest.setViewport({ width: 1280, height: 860 });
  for (const p of [host, guest]) {
    try { const cdp = await p.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  }

  const PAGE_URL = ORIGIN + '/dreamcast.html';
  say('\n== both browsers open the page ==');
  await Promise.all([gotoSettled(host, PAGE_URL), gotoSettled(guest, PAGE_URL)]);
  const ready = await Promise.all([
    until(host, () => (typeof window.__dcNet === 'function') || null, 60000),
    until(guest, () => (typeof window.__dcNet === 'function') || null, 60000),
  ]);
  if (!ready[0] || !ready[1]) throw new Error('a page never wired its lobby: host=' + ready[0] + ' guest=' + ready[1]);

  // The isolation the whole transport claim rests on.
  const echoed = await guest.evaluate(() => new Promise((res) => {
    const ch = new BroadcastChannel('nb-isolation-probe');
    let heard = false;
    ch.onmessage = () => { heard = true; };
    ch.postMessage('ping');
    setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 900);
  }));
  if (echoed) throw new Error('a BroadcastChannel echo crossed the two profiles — they are NOT isolated and nothing here would be about the real transport');
  say('  profile isolation: no BroadcastChannel echo between the two browsers — only the broker can pair them');
  RESULT.transport = (await host.evaluate(() => window.__dcNet().transport));
  say(`  transport   ${RESULT.transport}`);

  // ---- host boots ----------------------------------------------------------
  say(`\n== host picks "${GAME}" and presses Start ==`);
  const took = await host.evaluate((g) => { const el = document.querySelector('#romSelect'); if (!el) return null; el.value = g; el.dispatchEvent(new Event('change')); return el.value; }, GAME);
  if (took !== GAME) throw new Error(`#romSelect would not take "${GAME}" (reads ${J(took)}) — a different disc would boot silently`);
  await clickReal(host, '#btnStart');
  let lastLine = '';
  const live = await until(host, () => {
    const p = window.__dcProbe();
    return (p.booted && (p.fps > 0 || p.framesEver)) ? p : null;
  }, BOOT_MS, 1500, async () => {
    const p = await host.evaluate(() => window.__dcProbe()).catch(() => null);
    if (!p) return;
    const l = `${p.phase} ${Math.round(100 * (p.discBytes || 0) / (p.discTotal || 1))}% fps=${p.fps}`;
    if (l !== lastLine) { lastLine = l; process.stdout.write('  ....  booting  ' + l + '            \r'); }
  });
  process.stdout.write('\n');
  if (!live) throw new Error('the host never reached booted+frames — there is nothing to stream and nothing to measure');
  say(`  host live   booted=${live.booted} fps=${live.fps} guestX=${live.guestX} framesEver=${live.framesEver} phase=${live.phase}`);

  // Let the boot settle before reading a rate: the guest-rate figure ramps.
  await sleep(20000);
  RESULT.guestRate.before = await host.evaluate(() => { const p = window.__dcProbe(); return { guestX: p.guestX, fps: p.fps, iters: p.iters, t: p.t }; });
  say(`  GATE #9 rate BEFORE the rig touches anything: guestX=${RESULT.guestRate.before.guestX} fps=${RESULT.guestRate.before.fps}`);

  // ---- pair ----------------------------------------------------------------
  say('\n== host opens the inline lobby and hosts ==');
  await clickReal(host, '#btnNet');
  await clickReal(host, '#netHostBtn');
  const code = await until(host, () => {
    const t = (document.querySelector('#netCode') || {}).textContent || '';
    return /^[A-HJ-NP-Z2-9]{5}$/.test(t.trim()) ? t.trim() : null;
  }, 30000);
  if (!code) throw new Error('the host never minted a code');
  RESULT.code = code;
  const capture = await until(host, () => window.__dcNet().capture || null, 30000);
  say(`  code ${code}   capture arm: ${capture}`);
  RESULT.capture = capture;

  say('== guest joins from the OTHER browser ==');
  await clickReal(guest, '#btnNet');
  await clickReal(guest, '#netJoinBtn');
  await guest.evaluate((g) => { const el = document.querySelector('#netGame'); if (el) el.value = g; }, GAME);
  await guest.click('#netCodeIn');
  await guest.type('#netCodeIn', code, { delay: 25 });
  await clickReal(guest, '#netGo');

  const prompt = await until(host, () => (document.getElementById('npApproveAllow') ? true : null), 45000, 500);
  if (prompt) {
    await host.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); });
    say('  host approved the join');
  } else {
    const proto = await host.evaluate(() => (window.Netplay && window.Netplay.PROTO) || null);
    say(`  no approval prompt appeared (PROTO=${proto})`);
  }

  const gConn = await until(guest, () => (window.__dcNet().state === 'connected') || null, PAIR_MS, 500);
  const hConn = await until(host, () => (window.__dcNet().state === 'connected') || null, PAIR_MS, 500);
  if (!(gConn && hConn)) {
    const h = await host.evaluate(() => window.__dcNet()), g = await guest.evaluate(() => window.__dcNet());
    throw new Error('the two sides never paired: host=' + J(h) + ' guest=' + J(g));
  }
  say('  both sides report connected');

  // Picture must actually be decoding before anything is timed.
  const vOK = await until(guest, () => {
    const v = document.querySelector('#netVideo');
    if (!v || !v.videoWidth) return null;
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return (q && q.totalVideoFrames > 0) ? { w: v.videoWidth, h: v.videoHeight, decoded: q.totalVideoFrames } : null;
  }, 60000, 500);
  if (!vOK) throw new Error('the guest never decoded a frame — there is no picture to measure');
  say(`  guest picture ${vOK.w}x${vOK.h}, ${vOK.decoded} frames decoded so far`);

  // ---- instruments ---------------------------------------------------------
  say('\n== installing instruments ==');
  say('  host  ' + await installInstrument(host, 'host'));
  say('  guest ' + await installInstrument(guest, 'guest'));
  // ⚠ THE NET POLLER IS NOT STARTED HERE. It runs a ~1 kHz callback on the
  // HOST's main thread, which is the thread the emulator's presentation and
  // input pump live on; leaving it running through the picture and audio
  // windows would be measuring the rig. It is armed just before the wire phase
  // and stopped straight after.
  const startedH = await host.evaluate(() => ({ v: window.__nb.startVideo(), a: window.__nb.startAudio(), e: window.__nb.audErr }));
  const startedG = await guest.evaluate(() => ({ v: window.__nb.startVideo(), a: window.__nb.startAudio(), e: window.__nb.audErr }));
  say(`  host  video=${startedH.v} audio=${startedH.a} ${startedH.e ? '(' + startedH.e + ')' : ''}`);
  say(`  guest video=${startedG.v} audio=${startedG.a} ${startedG.e ? '(' + startedG.e + ')' : ''}`);

  // =========================================================================
  // (b) WHAT PICTURE PLAYER 2 GETS — steady state, no input
  // =========================================================================
  say(`\n== (b) the picture player 2 receives — ${SECS} s steady state ==`);
  const s0 = await readStats(guest, true);
  const hs0 = await readStats(host, false);
  const q0 = await guest.evaluate(() => {
    const v = document.querySelector('#netVideo');
    const q = v.getVideoPlaybackQuality();
    return { w: v.videoWidth, h: v.videoHeight, decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames, t: Date.now() };
  });
  const hostFps0 = await host.evaluate(() => { const p = window.__dcProbe(); return { fps: p.fps, guestX: p.guestX, t: Date.now() }; });
  await host.evaluate(() => window.__nb.clear());
  await guest.evaluate(() => window.__nb.clear());
  await sleep(SECS * 1000);
  const s1 = await readStats(guest, true);
  const hs1 = await readStats(host, false);
  const q1 = await guest.evaluate(() => {
    const v = document.querySelector('#netVideo');
    const q = v.getVideoPlaybackQuality();
    return { w: v.videoWidth, h: v.videoHeight, decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames, t: Date.now() };
  });
  const hostFps1 = await host.evaluate(() => { const p = window.__dcProbe(); return { fps: p.fps, guestX: p.guestX, t: Date.now() }; });

  const dtS = (q1.t - q0.t) / 1000;
  const dDecoded = q1.decoded - q0.decoded;
  const iv0 = s0.inboundVideo || {}, iv1 = s1.inboundVideo || {};
  const ov1 = hs1.outboundVideo || {}, ov0 = hs0.outboundVideo || {};
  const picture = {
    windowSec: +dtS.toFixed(2),
    guestElement: { w: q1.w, h: q1.h },
    hostCanvas: await host.evaluate(() => { const c = document.getElementById('dc-canvas'); return { w: c.width, h: c.height }; }),
    inboundWidth: iv1.frameWidth, inboundHeight: iv1.frameHeight,
    inboundFps: iv1.framesPerSecond,
    decodedPerSec: +(dDecoded / dtS).toFixed(2),
    receivedPerSec: (iv1.framesReceived != null && iv0.framesReceived != null) ? +((iv1.framesReceived - iv0.framesReceived) / dtS).toFixed(2) : null,
    droppedInWindow: q1.dropped - q0.dropped,
    kbps: (iv1.bytesReceived != null && iv0.bytesReceived != null) ? +(((iv1.bytesReceived - iv0.bytesReceived) * 8 / 1000) / dtS).toFixed(1) : null,
    packetsLost: iv1.packetsLost,
    codec: iv1.mimeType || null, decoder: iv1.decoderImplementation || null,
    encoderQualityLimit: ov1.qualityLimitationReason || null,
    hostEncodedPerSec: (ov1.framesEncoded != null && ov0.framesEncoded != null) ? +((ov1.framesEncoded - ov0.framesEncoded) / dtS).toFixed(2) : null,
    hostSentWidth: ov1.frameWidth, hostSentHeight: ov1.frameHeight,
    hostPresentedFps: hostFps1.fps, hostGuestX: hostFps1.guestX,
    rttMs: s1.candidatePair && s1.candidatePair.currentRoundTripTime != null ? +(s1.candidatePair.currentRoundTripTime * 1000).toFixed(2) : null,
  };
  RESULT.measurements.picture = picture;
  RESULT.stats.guestEnd = s1; RESULT.stats.hostEnd = hs1;
  say(`  host canvas          ${picture.hostCanvas.w}x${picture.hostCanvas.h}   host presented fps ${picture.hostPresentedFps}  guestX ${picture.hostGuestX}`);
  say(`  host ENCODES         ${picture.hostSentWidth}x${picture.hostSentHeight} @ ${picture.hostEncodedPerSec}/s  (qualityLimitationReason=${picture.encoderQualityLimit})`);
  say(`  player 2 RECEIVES    ${picture.inboundWidth}x${picture.inboundHeight} @ ${picture.inboundFps} fps reported, ${picture.decodedPerSec} decoded/s over ${picture.windowSec}s`);
  say(`  <video> element      ${picture.guestElement.w}x${picture.guestElement.h}   dropped in window ${picture.droppedInWindow}   lost packets ${picture.packetsLost}`);
  say(`  bitrate              ${picture.kbps} kbps   codec ${picture.codec}  decoder ${picture.decoder}`);
  say(`  candidate-pair RTT   ${picture.rttMs} ms  <-- BOTH BROWSERS ARE ON ONE BOX. A real second player adds their own RTT on top of every latency below.`);

  // =========================================================================
  // (a2) VIDEO-OUT — how far behind the host's picture player 2's picture is
  // =========================================================================
  say(`\n== (a) video-out: cross-correlating the two picture streams ==`);
  const dumpH = await host.evaluate(() => window.__nb.dump());
  const dumpG = await guest.evaluate(() => window.__nb.dump());
  const vidLag = (() => {
    if (!dumpH.vid.length || !dumpG.vid.length) return { lagMs: null, r: 0, why: `host samples ${dumpH.vid.length}, guest samples ${dumpG.vid.length} — one side produced nothing` };
    const t0 = Math.max(dumpH.vid[0].t, dumpG.vid[0].t) + 500;
    const t1 = Math.min(dumpH.vid[dumpH.vid.length - 1].t, dumpG.vid[dumpG.vid.length - 1].t);
    if (t1 - t0 < 3000) return { lagMs: null, r: 0, why: `only ${t1 - t0} ms of overlap` };
    const hCh = [0, 1, 2, 3].map((i) => grid(dumpH.vid, (s) => s.b[i], t0, t1));
    const gCh = [0, 1, 2, 3].map((i) => grid(dumpG.vid, (s) => s.b[i], t0, t1));
    const r = xcorr(hCh, gCh, 1200);
    r.overlapMs = t1 - t0;
    r.hostSamples = dumpH.vid.length; r.guestSamples = dumpG.vid.length;
    r.hostSampleHz = +(dumpH.vid.length / ((dumpH.vid[dumpH.vid.length - 1].t - dumpH.vid[0].t) / 1000)).toFixed(1);
    r.guestSampleHz = +(dumpG.vid.length / ((dumpG.vid[dumpG.vid.length - 1].t - dumpG.vid[0].t) / 1000)).toFixed(1);
    return r;
  })();
  RESULT.measurements.videoLag = vidLag;
  if (vidLag.lagMs == null || vidLag.r < MINR) {
    say(`  VOID  video-out lag NOT measurable this run: peak r=${(vidLag.r || 0).toFixed(3)} (< ${MINR})${vidLag.why ? ' — ' + vidLag.why : ''}`);
    say(`        A weak correlation means the two picture series do not line up at any lag — reporting a number off that would be fiction.`);
  } else {
    say(`  video-out lag        ${vidLag.lagMs} ms   (peak correlation r=${vidLag.r.toFixed(3)}; r at lag 0 = ${vidLag.r0.toFixed(3)}; best NEGATIVE lag ${vidLag.negPeak.lagMs} ms r=${vidLag.negPeak.r.toFixed(3)})`);
    say(`        host sampled at ${vidLag.hostSampleHz} Hz, guest at ${vidLag.guestSampleHz} Hz (rVFC = one per PRESENTED frame), ${vidLag.overlapMs} ms overlap`);
  }

  // =========================================================================
  // (c) AUDIO DELAY RELATIVE TO THE HOST
  // =========================================================================
  say(`\n== (c) audio delay relative to the host ==`);
  const audLag = (() => {
    if (dumpH.audErr || dumpG.audErr) return { lagMs: null, r: 0, why: `host tap: ${dumpH.audErr || 'ok'}; guest tap: ${dumpG.audErr || 'ok'}` };
    if (!dumpH.aud.length || !dumpG.aud.length) return { lagMs: null, r: 0, why: `host ${dumpH.aud.length} samples, guest ${dumpG.aud.length}` };
    const t0 = Math.max(dumpH.aud[0].t, dumpG.aud[0].t) + 500;
    const t1 = Math.min(dumpH.aud[dumpH.aud.length - 1].t, dumpG.aud[dumpG.aud.length - 1].t);
    if (t1 - t0 < 3000) return { lagMs: null, r: 0, why: `only ${t1 - t0} ms of overlap` };
    const hE = [grid(dumpH.aud, (s) => s.r, t0, t1)];
    const gE = [grid(dumpG.aud, (s) => s.r, t0, t1)];
    const hMax = Math.max(...dumpH.aud.map((s) => s.p));
    const gMax = Math.max(...dumpG.aud.map((s) => s.p));
    const r = xcorr(hE, gE, 1200);
    r.overlapMs = t1 - t0; r.hostPeakAmp = +hMax.toFixed(5); r.guestPeakAmp = +gMax.toFixed(5);
    r.hostMeta = dumpH.audMeta; r.guestMeta = dumpG.audMeta;
    return r;
  })();
  RESULT.measurements.audioLag = audLag;
  const ia1 = s1.inboundAudio || {}, ia0 = s0.inboundAudio || {};
  const jbDelta = (ia1.jitterBufferDelay != null && ia0.jitterBufferDelay != null &&
                   ia1.jitterBufferEmittedCount != null && ia0.jitterBufferEmittedCount != null &&
                   (ia1.jitterBufferEmittedCount - ia0.jitterBufferEmittedCount) > 0)
    ? ((ia1.jitterBufferDelay - ia0.jitterBufferDelay) / (ia1.jitterBufferEmittedCount - ia0.jitterBufferEmittedCount)) * 1000 : null;
  RESULT.measurements.audioJitterBufferMs = jbDelta != null ? +jbDelta.toFixed(1) : null;
  if (audLag.lagMs == null || audLag.r < MINR) {
    say(`  VOID  audio lag NOT measurable this run: peak r=${(audLag.r || 0).toFixed(3)}${audLag.why ? ' — ' + audLag.why : ''}`);
    if (audLag.hostPeakAmp != null) say(`        host outgoing peak amplitude ${audLag.hostPeakAmp}, guest received peak ${audLag.guestPeakAmp} — a near-zero host peak means the game was silent, not that the pipeline is broken`);
  } else {
    say(`  audio lag            ${audLag.lagMs} ms behind the host (peak r=${audLag.r.toFixed(3)}, r at lag 0 = ${audLag.r0.toFixed(3)}, best NEGATIVE lag ${audLag.negPeak.lagMs} ms r=${audLag.negPeak.r.toFixed(3)})`);
    say(`        host outgoing peak amplitude ${audLag.hostPeakAmp}, guest received peak ${audLag.guestPeakAmp}, ${audLag.overlapMs} ms overlap`);
  }
  say(`  jitter buffer        ${RESULT.measurements.audioJitterBufferMs} ms mean time a sample spent buffered (inbound-rtp, corroborating lower bound)`);
  say(`  audio received       ${ia1.totalSamplesReceived} samples total, ${ia1.concealedSamples} concealed, level ${ia1.audioLevel}`);

  // =========================================================================
  // (a1) WIRE-IN — guest keydown to the byte in the host's emulator
  // =========================================================================
  say(`\n== (a) wire-in: ${REPS} reps of guest keydown -> the host's emulator holding the byte ==`);
  await host.evaluate(() => window.__nb.startNet());
  const wire = { toRemotePad: [], toSentP2: [], releaseToZero: [], misses: 0 };
  for (let i = 0; i < REPS; i++) {
    await host.evaluate(() => { window.__nb.net.length = 0; });
    // Settle: everything must read zero before the press, or "it changed" means nothing.
    await guest.evaluate(() => window.__nb.press(['m'], false));
    await sleep(250);
    const t0k = await guest.evaluate(() => window.__nb.press(['m'], true));
    await sleep(500);
    const t1k = await guest.evaluate(() => window.__nb.press(['m'], false));
    await sleep(400);
    const ev = await host.evaluate(() => window.__nb.net.slice());
    const firstR = ev.find((e) => e.r !== 0);
    const firstS = ev.find((e) => e.s === true);
    const zeroAgain = firstS ? ev.find((e) => e.t > firstS.t && e.s === false) : null;
    if (firstR) wire.toRemotePad.push(firstR.t - t0k); else wire.misses++;
    if (firstS) wire.toSentP2.push(firstS.t - t0k);
    if (zeroAgain) wire.releaseToZero.push(zeroAgain.t - t1k);
    process.stdout.write(`  ....  rep ${i + 1}/${REPS}  remotePad ${firstR ? (firstR.t - t0k) + 'ms' : 'MISSED'}  sentP2 ${firstS ? (firstS.t - t0k) + 'ms' : 'MISSED'}      \r`);
  }
  process.stdout.write('\n');
  await host.evaluate(() => window.__nb.stopNet());
  const summarise = (a) => a.length ? { n: a.length, min: Math.min(...a), p50: pct(a, 50), p95: pct(a, 95), max: Math.max(...a), mean: +mean(a).toFixed(1) } : { n: 0 };
  RESULT.measurements.wireIn = {
    toRemotePad: summarise(wire.toRemotePad),
    toSentP2: summarise(wire.toSentP2),
    releaseToZero: summarise(wire.releaseToZero),
    misses: wire.misses, reps: REPS,
  };
  const w = RESULT.measurements.wireIn;
  say(`  keydown -> datachannel delivered (remotePad)  n=${w.toRemotePad.n} min ${w.toRemotePad.min} p50 ${w.toRemotePad.p50} p95 ${w.toRemotePad.p95} max ${w.toRemotePad.max} ms`);
  say(`  keydown -> HANDED TO THE EMULATOR (sentP2)    n=${w.toSentP2.n} min ${w.toSentP2.min} p50 ${w.toSentP2.p50} p95 ${w.toSentP2.p95} max ${w.toSentP2.max} ms`);
  say(`  keyup   -> emulator sees the release          n=${w.releaseToZero.n} p50 ${w.releaseToZero.p50} ms`);
  if (wire.misses) say(`  ⚠ ${wire.misses}/${REPS} presses NEVER REACHED THE HOST AT ALL`);

  // =========================================================================
  // THE HEADLINE
  // =========================================================================
  const wireP50 = w.toSentP2.p50, vidMs = (vidLag.r >= MINR) ? vidLag.lagMs : null;
  RESULT.measurements.addedLatencyMs = (wireP50 != null && vidMs != null) ? wireP50 + vidMs : null;
  say('\n== HEADLINE — what streaming costs PLAYER 2 over a local console ==');
  if (RESULT.measurements.addedLatencyMs != null) {
    say(`  player 2's input travels ${wireP50} ms before the emulator sees it,`);
    say(`  and the resulting picture reaches them ${vidMs} ms after the host sees it.`);
    say(`  ADDED INPUT-TO-VISIBLE LATENCY = ${RESULT.measurements.addedLatencyMs} ms on top of whatever the game's own reaction costs,`);
    say(`  = ${(RESULT.measurements.addedLatencyMs / 16.67).toFixed(1)} frames at 60 Hz. Player 1 pays none of it.`);
    say(`  AND BOTH BROWSERS ARE ON ONE BOX (RTT ${picture.rttMs} ms) — a real second player adds their network on top.`);
  } else {
    say(`  NOT COMPOSABLE this run: wire-in p50 = ${wireP50} ms, video-out = ${vidMs == null ? 'VOID' : vidMs + ' ms'}`);
  }

  // ---- gate #9 -------------------------------------------------------------
  RESULT.guestRate.after = await host.evaluate(() => { const p = window.__dcProbe(); return { guestX: p.guestX, fps: p.fps, iters: p.iters, t: p.t }; });
  say(`\n  GATE #9 rate AFTER: guestX=${RESULT.guestRate.after.guestX} fps=${RESULT.guestRate.after.fps}  (before: guestX=${RESULT.guestRate.before.guestX} fps=${RESULT.guestRate.before.fps})`);

  // ---- evidence ------------------------------------------------------------
  await host.evaluate(() => { window.__nb.stopVideo(); window.__nb.stopNet(); window.__nb.stopAudio(); });
  await guest.evaluate(() => { window.__nb.stopVideo(); window.__nb.stopAudio(); });
  const shotH = path.join(OUTDIR, NAME + '-host.png'), shotG = path.join(OUTDIR, NAME + '-guest.png');
  await host.screenshot({ path: shotH });
  await guest.screenshot({ path: shotG });
  RESULT.screenshots = [shotH, shotG];
  say(`  screenshots ${shotH}  ${shotG}`);
  // LIVENESS, not a screenshot. CLAUDE.md gate #10: a wedged run screenshots a
  // live-looking stale frame, so the picture is recorded WITH the frame counters.
  RESULT.liveness = {
    hostProbe: await host.evaluate(() => { const p = window.__dcProbe(); return { fps: p.fps, guestX: p.guestX, framesEver: p.framesEver, distinctEver: p.distinctEver, booted: p.booted }; }),
    guestVideo: await guest.evaluate(() => { const v = document.querySelector('#netVideo'); const q = v.getVideoPlaybackQuality(); return { w: v.videoWidth, h: v.videoHeight, decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames, currentTime: +v.currentTime.toFixed(2) }; }),
    guestDistinctSignatures: new Set(dumpG.vid.map((s) => s.b.map((x) => Math.round(x)).join('.'))).size,
    guestSamples: dumpG.vid.length,
  };
  say(`  liveness    host ${J(RESULT.liveness.hostProbe)}`);
  say(`              guest video ${J(RESULT.liveness.guestVideo)}, ${RESULT.liveness.guestDistinctSignatures} distinct picture signatures across ${RESULT.liveness.guestSamples} sampled frames`);
  exitCode = 0;
} catch (e) {
  say('\n!! THE RIG FAILED: ' + ((e && e.stack) || e));
  RESULT.error = String((e && e.message) || e);
  try {
    if (host) await host.screenshot({ path: path.join(OUTDIR, NAME + '-host-FAIL.png') });
    if (guest) await guest.screenshot({ path: path.join(OUTDIR, NAME + '-guest-FAIL.png') });
  } catch (e2) {}
} finally {
  RESULT.wasm.sha256_16_after = wasmHash();
  RESULT.uptimeEnd = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
  RESULT.loadavgEnd = os.loadavg();
  RESULT.elapsedMs = Date.now() - T0;
  RESULT.sideErrors = { host: (SIDELOG.host || {}).errors || [], guest: (SIDELOG.guest || {}).errors || [] };
  const jsonPath = path.join(OUTDIR, NAME + '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(RESULT, null, 2));
  say(`\n  json        ${jsonPath}`);
  say(`  log         ${LOG}`);
  say(`  wasm        before ${RESULT.wasm.sha256_16_before}  after ${RESULT.wasm.sha256_16_after}  ${RESULT.wasm.sha256_16_before === RESULT.wasm.sha256_16_after ? 'STABLE' : '⚠ CHANGED MID-RUN — this run is void'}`);
  say(`  uptime@end  ${RESULT.uptimeEnd}`);
  if (!KEEP) for (const b of browsers) { try { await b.close(); } catch (e) {} }
  await new Promise((r) => logStream.end(r));
}
process.exit(exitCode);

#!/usr/bin/env node
// audio_probe.mjs — measure REAL audio output of an emulator page.
//
//   node tools/audio_probe.mjs <page> [romIndex]
//
//   page: gamecube | dreamcast | n64 | ps1 | gba   (or a full URL)
//
// Requires `npm run web` (python3 -m http.server 8080) — CLAUDE.md gate #2.
//
// WHY THIS EXISTS
//   Every audio number this project has quoted came from a producer-side
//   counter ("callbacks/s", "samples queued"). A counter cannot tell you the
//   output was AUDIBLE: a worker can push buffers into a graph whose gain is 0,
//   whose context is suspended, or whose destination was never connected, and
//   every counter still reads healthy. This probe shadows ctx.destination with
//   a pass-through AudioWorklet (tools/audio_tap.js) and measures the PCM that
//   actually reached the output node.
//
// WHAT IT REPORTS  (all measured, none inferred)
//   audibleFrames / silentPct     — is there sound at all
//   gapsOverMin, longestSilenceMs — dropouts after audio started
//   discontinuities, maxStep      — sample-to-sample jumps = clicks/crackle
//   ctxWallRatio                  — audio clock vs wall clock (device drift)
//   stateLog                      — autoplay suspends and whether it recovered
//   series[]                      — the above sampled over time, so a buffer
//                                   that fills-then-stalls is distinguishable
//                                   from one that never started
//
// GATE #9: this probe NEVER writes to the guest clock. It is read-only with
// respect to emulation rate. Any audio fix that changes gameplay speed is out
// of scope by construction.
//
// ENV
//   AUDIO_DURATION_MS   measurement window after start (default 30000)
//   AUDIO_SETTLE_MS     wait after clicking Start before measuring (default 15000)
//   AUDIO_AUTOPLAY      '1' = pass --autoplay-policy=no-user-gesture-required
//                       (default '0': we WANT to see the real autoplay behaviour)
//   AUDIO_HEADLESS      '0' for a visible window
//   AUDIO_OUT           JSON output path (default /tmp/audio-<page>.json)
//   AUDIO_QUERY         extra query string appended to the page URL
//   AUDIO_ROM_NAME      substring match to pick the ROM option instead of index

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8080';

const PAGES = {
  gamecube:  { url: `${BASE}/gamecube.html`,  kind: 'std', coi: true },
  dreamcast: { url: `${BASE}/dreamcast.html`, kind: 'std', coi: true },
  n64:       { url: `${BASE}/n64/index.html`, kind: 'std', coi: false },
  ps1:       { url: `${BASE}/ps1.html`,       kind: 'std', coi: true },
  gba:       { url: `${BASE}/gba.html`,       kind: 'gba', coi: false },
};

const pageKey = process.argv[2];
const romIdx = parseInt(process.argv[3] ?? '0', 10);
if (!pageKey) {
  console.error('usage: node tools/audio_probe.mjs <gamecube|dreamcast|n64|ps1|gba> [romIndex]');
  process.exit(2);
}
const spec = PAGES[pageKey] || { url: pageKey, kind: 'std', coi: true };

const DURATION_MS = +(process.env.AUDIO_DURATION_MS || 30000);
const SETTLE_MS   = +(process.env.AUDIO_SETTLE_MS   || 15000);
const AUTOPLAY    = process.env.AUDIO_AUTOPLAY === '1';
const HEADLESS    = process.env.AUDIO_HEADLESS !== '0';
const OUT         = process.env.AUDIO_OUT || `/tmp/audio-${pageKey.replace(/\W/g, '_')}.json`;
const QUERY       = process.env.AUDIO_QUERY || '';
const ROM_NAME    = process.env.AUDIO_ROM_NAME || '';

const TAP_SRC = fs.readFileSync(path.join(REPO, 'tools', 'audio_tap.js'), 'utf8');
const PROD_SRC = fs.readFileSync(path.join(REPO, 'tools', 'audio_producer_shim.js'), 'utf8');

const result = {
  page: pageKey, url: spec.url, romIdx, romLabel: null,
  autoplayFlagUsed: AUTOPLAY,
  settleMs: SETTLE_MS, durationMs: DURATION_MS,
  startedAt: new Date().toISOString(),
  crossOriginIsolated: null,
  started: false, startError: null,
  tap: null, series: [], producer: null,
  consoleErrors: [], pageErrors: [], failedRequests: [],
  audioConsole: [],
  verdict: {},
};

const args = [
  '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-features=SharedArrayBuffer',
  '--disable-features=IsolateOrigins,site-per-process',
  '--enable-blink-features=SharedArrayBuffer',
  // A real output device is required or Chrome renders the graph with a null
  // sink and every measurement below is of a silence the user would not hear.
  '--use-fake-device-for-media-stream',
];
if (AUTOPLAY) args.push('--autoplay-policy=no-user-gesture-required');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS ? 'new' : false,
  args,
  defaultViewport: { width: 1280, height: 800 },
});
// [leak-guard] a SIGKILLed parent orphans this browser; reap() cleans it up.
try {
  const g = (await import('./browser_leak_guard.js')).default;
  g.guard(browser, 'tools/audio_probe.mjs');
} catch (_e) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a start control to be ENABLED before clicking it.
 *
 * WHY THIS EXISTS — it produced a false defect report and was caught only by
 * chasing a "no audio" verdict that had no error behind it. gba.html:466 binds
 * `rv-disabled="data.moduleInitializing"`, so #btnPlayGame stays disabled until
 * the core finishes initialising, while #romselect is populated immediately
 * from ROMLIST. Clicking on the ROM list being ready therefore clicked a
 * DISABLED button: puppeteer reports no error, the inline onclick never fires,
 * the emulator never starts, and the page constructs no AudioContext — which
 * reads exactly like "this page has no audio", with zero pageErrors and zero
 * console errors to contradict it.
 *
 * Also treats aria-disabled as authoritative: per CLAUDE.md, lib/capability.js
 * is the sole writer of aria-disabled/data-cap-blocked on start controls, and a
 * control it is holding down must not be clicked or force-enabled — if the
 * capability layer is blocking, that is a real finding, not something to
 * bulldoze.
 */
async function waitEnabled(page, sel, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { present: false };
      return {
        present: true,
        disabled: !!el.disabled,
        ariaDisabled: el.getAttribute('aria-disabled') === 'true',
        capBlocked: el.hasAttribute('data-cap-blocked'),
      };
    }, sel).catch(() => ({ present: false }));
    if (st.present && !st.disabled && !st.ariaDisabled) return st;
    if (st.present && (st.ariaDisabled || st.capBlocked)) {
      // Capability layer is deliberately holding it down. Record and stop
      // waiting — this is a verdict, not a race.
      result.startBlockedByCapability = true;
      return st;
    }
    if (Date.now() - t0 > timeoutMs) {
      result.startEnableTimedOut = sel;
      return st;
    }
    await sleep(500);
  }
}

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  await page.evaluateOnNewDocument(TAP_SRC);
  await page.evaluateOnNewDocument(PROD_SRC);

  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') result.consoleErrors.push(t.slice(0, 300));
    if (/audio|sample|pcm|sound|underrun|starv|xrun|buffer|aica|dsp|\bai\b/i.test(t)) {
      if (result.audioConsole.length < 400) result.audioConsole.push(t.slice(0, 300));
    }
  });
  page.on('pageerror', (e) => result.pageErrors.push(String(e).slice(0, 300)));
  page.on('requestfailed', (r) => result.failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) result.failedRequests.push(`${r.url()} HTTP${r.status()}`); });

  const url = spec.url + (QUERY ? (spec.url.includes('?') ? '&' : '?') + QUERY : '');
  result.url = url;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // coi-serviceworker reloads once to install COOP/COEP. Wait it out.
  if (spec.coi) {
    for (let i = 0; i < 12; i++) {
      const ok = await page.evaluate(() => self.crossOriginIsolated === true).catch(() => false);
      if (ok) break;
      await sleep(1000);
    }
  }
  result.crossOriginIsolated = await page.evaluate(() => self.crossOriginIsolated).catch(() => null);

  // --- start emulation -----------------------------------------------------
  try {
    if (spec.kind === 'gba') {
      await page.waitForSelector('#romselect option', { timeout: 60000 });
      result.romLabel = await page.evaluate((i, nameMatch) => {
        const sel = document.getElementById('romselect');
        let idx = i;
        if (nameMatch) {
          const j = [...sel.options].findIndex((o) => o.textContent.includes(nameMatch));
          if (j >= 0) idx = j;
        }
        sel.selectedIndex = Math.min(idx, sel.options.length - 1);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.options[sel.selectedIndex]?.textContent?.trim() ?? null;
      }, romIdx, ROM_NAME);
      await waitEnabled(page, '#btnPlayGame');
      await page.click('#btnPlayGame');
    } else {
      await page.waitForSelector('#romSelect option', { timeout: 60000 });
      result.romLabel = await page.evaluate((i, nameMatch) => {
        const sel = document.getElementById('romSelect');
        let idx = i;
        if (nameMatch) {
          const j = [...sel.options].findIndex((o) => o.textContent.includes(nameMatch));
          if (j >= 0) idx = j;
        }
        sel.selectedIndex = Math.min(idx, sel.options.length - 1);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.options[sel.selectedIndex]?.textContent?.trim() ?? null;
      }, romIdx, ROM_NAME);
      // real click => a real user gesture, so autoplay unblocking is exercised
      // exactly as a visitor would exercise it.
      await waitEnabled(page, '#btnStart');
      await page.click('#btnStart');
    }
    result.started = true;
  } catch (e) {
    result.startError = String(e).slice(0, 400);
  }

  await sleep(SETTLE_MS);

  // --- optional mute/unmute cycle -----------------------------------------
  // AUDIO_MUTE_CYCLE=1 mutes for a few seconds mid-run and unmutes again, then
  // checks that audio COMES BACK. This is a real regression arm, not a
  // curiosity: on PS1 the mute path used to drop worker PCM without crediting
  // the worker's buffered-byte counter, and because that counter's only
  // decrement is the main side draining audio it had none of, muting walked it
  // above dfsound's TESTSIZE and left it there — after which SPUasync bailed
  // on every call and sound never returned for the rest of the session.
  if (process.env.AUDIO_MUTE_CYCLE === '1') {
    // Pick the context that is actually playing, exactly as the verdict does.
    // Reading contexts[0] here measured ps1.html's vestigial
    // Module.preCreatedAudioContext (destConnects 0, permanently 0 audible) and
    // reported "did not recover" on a page whose real context was playing.
    const pick = () => {
      const cs = window.__audioTap?.summary()?.contexts || [];
      if (!cs.length) return null;
      const c = cs.slice().sort((a, b) =>
        (b.audibleFrames - a.audibleFrames) || (b.frames - a.frames))[0];
      return { id: c.id, sampleRate: c.sampleRate, frames: c.frames,
               audibleFrames: c.audibleFrames, state: c.state };
    };
    const before = await page.evaluate(pick).catch(() => null);
    const clicked = await page.evaluate(() => {
      const b = document.getElementById('btnMute');
      if (!b) return 'no-btnMute';
      b.click(); return 'muted';
    }).catch((e) => 'err:' + e);
    await sleep(4000);
    const during = await page.evaluate(pick).catch(() => null);
    await page.evaluate(() => { const b = document.getElementById('btnMute'); if (b) b.click(); }).catch(() => {});
    await sleep(6000);
    const after = await page.evaluate(pick).catch(() => null);
    result.muteCycle = {
      clicked, before, during, after,
      audibleGainedDuringMute: (during && before) ? during.audibleFrames - before.audibleFrames : null,
      audibleGainedAfterUnmute: (after && during) ? after.audibleFrames - during.audibleFrames : null,
    };
    // The whole point: audible frames must resume accumulating after unmute.
    result.muteCycle.recovered = (result.muteCycle.audibleGainedAfterUnmute ?? 0) > 1000;
  }

  // --- measurement window --------------------------------------------------
  const SAMPLE_MS = 2000;
  const n = Math.max(1, Math.round(DURATION_MS / SAMPLE_MS));
  for (let i = 0; i < n; i++) {
    await sleep(SAMPLE_MS);
    const s = await page.evaluate(() => {
      const out = { t: performance.now() };
      try { out.tap = window.__audioTap ? window.__audioTap.summary() : null; } catch (e) { out.tapErr = String(e); }
      // Page-side producer counters, if the page exposes any. Read defensively:
      // absence is a finding, not an error.
      try {
        out.producer = window.__audioProd ? window.__audioProd.summary() : null;
      } catch (e) { out.producerErr = String(e); }
      return out;
    }).catch((e) => ({ t: null, evalErr: String(e) }));
    result.series.push(s);
  }

  const last = result.series[result.series.length - 1];
  result.tap = last?.tap ?? null;
  result.producer = last?.producer ?? null;

  // --- verdict -------------------------------------------------------------
  // PICK THE CONTEXT THAT ACTUALLY PLAYS, NOT contexts[0].
  // Several pages construct more than one AudioContext: gamecube.html:6570
  // makes a vestigial `Module.preCreatedAudioContext` inside the Start click
  // (to satisfy the autoplay gesture) and then gamecube.html:6065 makes the
  // REAL one at the core's sample rate. ps1.html does the same thing. Reading
  // contexts[0] would therefore measure a context wired to nothing and report
  // "no audio" on a page that is playing perfectly — a false negative of
  // exactly the kind this probe exists to prevent. Rank by audible frames,
  // then by rendered frames.
  const ctxs = result.tap?.contexts ?? [];
  const c = ctxs.length
    ? ctxs.slice().sort((a, b) =>
        (b.audibleFrames - a.audibleFrames) || (b.frames - a.frames))[0]
    : null;
  result.chosenContextId = c ? c.id : null;
  result.allContexts = ctxs.map((x) => ({
    id: x.id, sampleRate: x.sampleRate, state: x.state, tapMode: x.tapMode,
    frames: x.frames, audibleFrames: x.audibleFrames, destConnects: x.destConnects,
  }));
  if (!result.tap) {
    result.verdict = { audible: 'UNKNOWN', reason: 'tap did not report' };
  } else if (result.tap.nContexts === 0) {
    result.verdict = { audible: 'NO', reason: 'page never constructed an AudioContext' };
  } else if (c && c.tapMode !== 'worklet') {
    result.verdict = { audible: 'UNKNOWN', reason: `tap not active: ${c.tapMode}` };
  } else if (!c || c.frames === 0) {
    result.verdict = { audible: 'NO', reason: 'AudioContext exists but rendered 0 frames (suspended?)', state: c?.state };
  } else if (c.audibleFrames === 0) {
    result.verdict = { audible: 'NO', reason: 'rendered frames were all exactly zero', destConnects: c.destConnects };
  } else {
    result.verdict = {
      audible: 'YES',
      audibleSeconds: +c.audibleSeconds.toFixed(3),
      silentPct: +Number(c.silentPct).toFixed(2),
      gaps: c.gapsOverMin,
      longestSilenceMs: c.longestSilenceMs != null ? +c.longestSilenceMs.toFixed(1) : null,
      discontinuities: c.discontinuities,
      maxStep: +Number(c.maxStep).toFixed(4),
      peak: +Number(c.peak).toFixed(4),
      ctxWallRatio: c.ctxWallRatio != null ? +c.ctxWallRatio.toFixed(4) : null,
    };
  }

  // Producer-vs-consumer drift. The consumer rate is device-driven, so this
  // ratio is the honest "is the emulator feeding the sink fast enough" number.
  // NOTE: it is a DIAGNOSTIC. A ratio below 1.0 must never be corrected by
  // changing the guest rate or by resampling to fit (gate #9 / the rejected
  // N64 stretch bandaid) — it means fix the producer or the buffering.
  try {
    const prod = result.producer || {};
    const consumedPerSec = (c && c.wallSpanSec > 0.5) ? (c.frames / c.wallSpanSec) : null;
    const producedKey = Object.keys(prod).find((k) =>
      prod[k] && typeof prod[k] === 'object' && typeof prod[k].framesPerSec === 'number');
    const producedPerSec = producedKey ? prod[producedKey].framesPerSec : null;
    result.verdict.rates = {
      consumedFramesPerSec: consumedPerSec != null ? +consumedPerSec.toFixed(1) : null,
      producerHook: producedKey ?? null,
      producedFramesPerSec: producedPerSec,
      producedOverConsumed: (producedPerSec && consumedPerSec)
        ? +(producedPerSec / consumedPerSec).toFixed(4) : null,
      ctxSampleRate: c?.sampleRate ?? null,
    };
  } catch (_e) {}

  try {
    result.screenshot = `/tmp/audio-${pageKey}-shot.png`;
    await page.screenshot({ path: result.screenshot });
  } catch (_e) { result.screenshot = null; }
} catch (e) {
  result.fatal = String(e).slice(0, 800);
} finally {
  await browser.close().catch(() => {});
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  page: result.page, url: result.url, rom: result.romLabel,
  coi: result.crossOriginIsolated, started: result.started, startError: result.startError,
  verdict: result.verdict,
  nContexts: result.tap?.nContexts ?? null,
  chosenContextId: result.chosenContextId ?? null,
  allContexts: result.allContexts ?? null,
  producer: result.producer,
  audioConsoleTail: result.audioConsole.slice(-12),
  muteCycle: result.muteCycle ?? null,
  fatal: result.fatal ?? null,
  out: OUT,
}, null, 2));

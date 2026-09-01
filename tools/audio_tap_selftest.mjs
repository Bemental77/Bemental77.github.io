#!/usr/bin/env node
// audio_tap_selftest.mjs — prove tools/audio_tap.js is not a placebo.
//
//   node tools/audio_tap_selftest.mjs        (needs `npm run web` on :8080)
//
// Runs tools/fixtures/audio_selftest.html through five arms whose ground truth
// is known by construction, and asserts the tap REPORTS THEM DIFFERENTLY.
//
// This exists because the probe is about to be used to say "this emulator page
// produces no audio". That claim is only admissible if the instrument has been
// shown to say something else when audio is present. An instrument whose arms
// do not differ reports nothing — the same rule tools/device_matrix.mjs applies
// to its own arms.
//
// Exit 0 = tap validated. Exit 1 = tap is not trustworthy; no audio verdict
// taken with it may be reported.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8080/tools/fixtures/audio_selftest.html';
const RUN_MS = +(process.env.SELFTEST_MS || 6000);

const TAP_SRC = fs.readFileSync(path.join(REPO, 'tools', 'audio_tap.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
try {
  const g = (await import('./browser_leak_guard.js')).default;
  g.guard(browser, 'tools/audio_tap_selftest.mjs');
} catch (_e) {}

const arms = ['tone', 'silent', 'nograph', 'gaps', 'click'];
const got = {};

try {
  for (const arm of arms) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(TAP_SRC);
    await page.goto(`${BASE}?arm=${arm}`, { waitUntil: 'load', timeout: 30000 });
    await sleep(RUN_MS);
    const s = await page.evaluate(() => window.__audioTap ? window.__audioTap.summary() : null);
    const c = s?.contexts?.[0] ?? null;
    got[arm] = c ? {
      tapMode: c.tapMode, frames: c.frames, audibleFrames: c.audibleFrames,
      peak: +Number(c.peak).toFixed(4), rmsMean: +Number(c.rmsMean).toFixed(5),
      gaps: c.gapsOverMin, discontinuities: c.discontinuities,
      maxStep: +Number(c.maxStep).toFixed(4),
      ctxWallRatio: c.ctxWallRatio != null ? +c.ctxWallRatio.toFixed(4) : null,
      state: c.state,
    } : { error: 'no context', summary: s };
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
}

const A = [];
const t = (name, cond, detail) => A.push({ name, pass: !!cond, detail });

t('tap/worklet-active', got.tone?.tapMode === 'worklet', `tapMode=${got.tone?.tapMode}`);
t('tap/renders-frames', (got.tone?.frames ?? 0) > 48000, `frames=${got.tone?.frames}`);

// The arm difference itself: the whole point of this file.
t('arm-diff/tone-is-audible', (got.tone?.audibleFrames ?? 0) > 10000,
  `tone audibleFrames=${got.tone?.audibleFrames}`);
t('arm-diff/silent-is-not-audible', got.silent?.audibleFrames === 0,
  `silent audibleFrames=${got.silent?.audibleFrames}`);
t('arm-diff/nograph-is-not-audible', got.nograph?.audibleFrames === 0,
  `nograph audibleFrames=${got.nograph?.audibleFrames}`);
t('arm-diff/silent-still-rendered', (got.silent?.frames ?? 0) > 48000,
  `silent frames=${got.silent?.frames} (must be >0: proves "0 audible" is not "0 rendered")`);
t('arm-diff/tone-peak-above-silent', (got.tone?.peak ?? 0) > 0.1 && (got.silent?.peak ?? 1) === 0,
  `tone peak=${got.tone?.peak} silent peak=${got.silent?.peak}`);

// Gap detection actually detects gaps.
t('gaps/detected', (got.gaps?.gaps ?? 0) >= 1,
  `gaps arm reported ${got.gaps?.gaps} gaps; tone arm reported ${got.tone?.gaps}`);
t('gaps/tone-arm-has-none', (got.tone?.gaps ?? 99) === 0,
  `tone gaps=${got.tone?.gaps} (a continuous tone must not register gaps)`);

// Discontinuity detection actually detects clicks.
t('click/square-has-steps', (got.click?.discontinuities ?? 0) > 100,
  `square discontinuities=${got.click?.discontinuities}`);
t('click/sine-has-none', (got.tone?.discontinuities ?? 99) === 0,
  `sine discontinuities=${got.tone?.discontinuities} (a 440Hz sine steps ~0.04/sample)`);

// The audio clock must track wall clock on a healthy device.
t('clock/ctx-tracks-wall', got.tone?.ctxWallRatio != null
  && Math.abs(got.tone.ctxWallRatio - 1) < 0.05,
  `ctxWallRatio=${got.tone?.ctxWallRatio}`);

const failed = A.filter((a) => !a.pass);
console.log(JSON.stringify({ arms: got, assertions: A, passed: A.length - failed.length, failed: failed.length }, null, 2));
if (failed.length) {
  console.error(`\nTAP SELF-TEST FAILED (${failed.length}): ` + failed.map((f) => f.name).join(', '));
  console.error('No audio verdict taken with this tap may be reported.');
  process.exit(1);
}
console.error(`\nTAP SELF-TEST PASSED (${A.length} assertions) — tap arms differ, instrument is valid.`);

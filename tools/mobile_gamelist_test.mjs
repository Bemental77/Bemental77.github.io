#!/usr/bin/env node
// DOES THE PHONE OFFER THE SAME GAMES AS THE DESKTOP?
//
// WHY THIS FILE EXISTS
//   dreamcast.html shipped its phone-shell picker as a hand-written
//   `<select id="mobileRomSelect"><option value="pso2">…</option></select>`
//   while the desktop `<select id="romSelect">` grew to five discs. Nothing
//   connected the two, so four of the five games were UNREACHABLE FROM A PHONE
//   and the page looked completely healthy from a desktop browser, from the
//   HTML source read casually, and from every existing test. A user found it.
//
//   That is a whole CLASS of defect — two lists of the same thing, one of which
//   is only visible on a device the developer is not using. This test is the
//   mechanical check that closes the class rather than the one instance.
//
// WHAT IT PROVES, PER PAGE
//   1  RUNTIME  — under a mobile viewport + mobile UA, in a real browser, the
//      set of `value`s in the mobile picker EQUALS the set in the desktop
//      picker. Sets, not arrays: order is cosmetic, membership is not. This is
//      the assertion that would have caught the bug.
//   2  RUNTIME  — each value's visible LABEL matches too. dreamcast.html
//      relabels an undeployed disc "… — not deployed yet" (markUnhostedDiscs),
//      so a mirror built BEFORE that step passes (1) while telling the phone a
//      game is playable that the desktop says is not.
//   3  RUNTIME  — the mobile picker's selected value is one of those options.
//      An empty `<select>` that mirrors an empty `<select>` passes (1) while
//      offering the visitor nothing, so a non-empty list is required too.
//   4  STATIC   — the page SOURCE contains no literal `<option>` inside the
//      mobile `<select>`. A mirrored list that is ALSO hardcoded is the bug
//      waiting to come back the next time someone adds a disc; the only safe
//      markup is an empty element filled from the one catalog.
//
// WHICH PAGES — DISCOVERED, NOT LISTED. Every `.html` under the repo root and
//   `n64/` is scanned for `id="mobileRomSelect"`; whatever has one is tested. A
//   sixth emulator page added tomorrow is covered without editing this file.
//   Pages with only one picker (gba.html, whose single rivets-bound
//   `#romselect` has no mobile twin) are reported as SKIP, not as a pass.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime   # gate, per CLAUDE.md
//   npm run web                                       # port 8080, gate #2
//   node tools/mobile_gamelist_test.mjs
//
//   If nothing is serving on 8080 this starts `npm run web` itself and stops it
//   again on the way out; if something already is, it is left alone.
//
// ENV
//   CHROME_PATH   path to Chrome (default: the macOS bundle)
//   ORIGIN        default http://localhost:8080
//   MGL_KEEP      leave the browser open at the end (debugging)
//
// EXIT   0 = every discovered page agrees. Non-zero = drift, and the report
//        names the page and the exact values each side is missing.
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.SCRATCH ||
  '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESKTOP_SEL = '#romSelect';
const MOBILE_SEL  = '#mobileRomSelect';
// The picker is filled by page script, and two of these pages are reloaded once
// by coi-serviceworker before that script runs, so "populated" is polled rather
// than awaited on a single navigation.
const POPULATE_MS = 25000;

// An iPhone 14 Pro. The pages branch on the UA string, so it is set BEFORE
// navigation — a UA applied after load reaches a page that already decided it
// was a desktop.
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ' +
                  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MOBILE_VIEWPORT = { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------
function discoverPages() {
  const dirs = ['.', 'n64'];
  const found = [];
  for (const d of dirs) {
    const abs = path.join(ROOT, d);
    let names = [];
    try { names = fs.readdirSync(abs); } catch (_e) { continue; }
    for (const n of names.sort()) {
      if (!n.endsWith('.html')) continue;
      const rel = d === '.' ? n : d + '/' + n;
      const src = fs.readFileSync(path.join(abs, n), 'utf8');
      // CASE-INSENSITIVE ON PURPOSE. gba.html spells its picker `id="romselect"`
      // (gba.html:612) — it is a rivets-bound Bootstrap page, not a port of the
      // other five, and a case-sensitive scan would have silently not-discovered
      // it and reported nothing at all rather than SKIP.
      const hasMobile = /id=["']mobileRomSelect["']/i.test(src);
      const hasDesktop = /id=["']romSelect["']/i.test(src);
      if (hasMobile || hasDesktop) found.push({ rel, src, hasMobile, hasDesktop });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// static check: no literal <option> inside the mobile <select>
// ---------------------------------------------------------------------------
function staticHardcodedOptions(src) {
  const m = src.match(/<select[^>]*id=["']mobileRomSelect["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!m) return null;                    // no closing tag found — nothing to judge
  const inner = m[1];
  const opts = inner.match(/<option\b[^>]*>/gi) || [];
  return opts;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
async function originIsUp() {
  try {
    const r = await fetch(ORIGIN + '/', { method: 'GET' });
    return r.ok || r.status === 404;      // anything that answers HTTP counts
  } catch (_e) { return false; }
}

async function ensureServer() {
  if (await originIsUp()) { console.log(`[serve] ${ORIGIN} already answering — leaving it alone`); return null; }
  if (!/^http:\/\/localhost:8080\/?$/.test(ORIGIN)) {
    console.error(`[serve] ${ORIGIN} is not answering and is not the canonical origin — start it yourself`);
    process.exit(2);
  }
  console.log('[serve] nothing on 8080 — starting `npm run web` (python3 -m http.server 8080)');
  const p = spawn('npm', ['run', 'web'], { cwd: ROOT, stdio: 'ignore', detached: false });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await originIsUp()) return p; }
  console.error('[serve] npm run web never came up on 8080');
  try { p.kill('SIGTERM'); } catch (_e) {}
  process.exit(2);
}

// ---------------------------------------------------------------------------
// the measurement
// ---------------------------------------------------------------------------
const READ_PICKERS = (dSel, mSel) => {
  const read = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      values: Array.prototype.map.call(el.options, (o) => o.value),
      labels: Array.prototype.map.call(el.options, (o) => (o.textContent || '').trim()),
      selected: el.value,
    };
  };
  return { desktop: read(dSel), mobile: read(mSel), href: location.href };
};

async function readPickers(page) {
  // The coi-serviceworker reload destroys the execution context mid-evaluate on
  // the SW-controlled pages; that is a race in the rig, not a page fault, so it
  // is retried rather than reported.
  const deadline = Date.now() + POPULATE_MS;
  let last = null, lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await page.evaluate(READ_PICKERS, DESKTOP_SEL, MOBILE_SEL);
      last = r;
      if (r.desktop && r.mobile && r.desktop.values.length > 0 && r.mobile.values.length > 0) return r;
    } catch (e) { lastErr = e; }
    await sleep(400);
  }
  if (last) return last;
  throw lastErr || new Error('never read the pickers');
}

async function testPage(browser, entry) {
  const page = await browser.newPage();
  const res = { rel: entry.rel, ok: false, notes: [] };
  try {
    await page.setUserAgent(MOBILE_UA);
    await page.setViewport(MOBILE_VIEWPORT);
    try {
      await page.goto(ORIGIN + '/' + entry.rel, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      // A coi-serviceworker reload can abort the navigation puppeteer is
      // awaiting. The page is still there; keep going and let the poll decide.
      res.notes.push('nav: ' + String(e.message || e).split('\n')[0]);
    }
    const r = await readPickers(page);
    res.raw = r;

    if (!r.desktop) { res.notes.push(`FAIL no ${DESKTOP_SEL} in the live DOM`); return res; }
    if (!r.mobile)  { res.notes.push(`FAIL no ${MOBILE_SEL} in the live DOM`);  return res; }

    const dSet = new Set(r.desktop.values);
    const mSet = new Set(r.mobile.values);
    const missingOnMobile  = [...dSet].filter((v) => !mSet.has(v));
    const extraOnMobile    = [...mSet].filter((v) => !dSet.has(v));

    res.desktopCount = r.desktop.values.length;
    res.mobileCount  = r.mobile.values.length;
    res.missingOnMobile = missingOnMobile;
    res.extraOnMobile   = extraOnMobile;

    // 1 — set equality
    if (missingOnMobile.length || extraOnMobile.length) {
      res.notes.push(`FAIL picker drift: desktop has ${r.desktop.values.length}, mobile has ${r.mobile.values.length}`);
      if (missingOnMobile.length) res.notes.push('       UNREACHABLE FROM A PHONE: ' + JSON.stringify(missingOnMobile));
      if (extraOnMobile.length)   res.notes.push('       on mobile only: ' + JSON.stringify(extraOnMobile));
      return res;
    }
    // 2 — the LABEL for each value matches too. Values alone would pass a mirror
    // that ran BEFORE dreamcast.html's markUnhostedDiscs(), leaving the phone
    // offering a disc as playable that the desktop marks "— not deployed yet".
    const dLabel = new Map(r.desktop.values.map((v, i) => [v, r.desktop.labels[i]]));
    const labelDrift = r.mobile.values
      .map((v, i) => ({ v, mobile: r.mobile.labels[i], desktop: dLabel.get(v) }))
      .filter((x) => x.mobile !== x.desktop);
    if (labelDrift.length) {
      res.labelDrift = labelDrift;
      res.notes.push(`FAIL ${labelDrift.length} option label(s) differ between the pickers`);
      for (const x of labelDrift) {
        res.notes.push(`       ${JSON.stringify(x.v)}  desktop=${JSON.stringify(x.desktop)}  mobile=${JSON.stringify(x.mobile)}`);
      }
      return res;
    }
    // 3 — the mirror is not two empty lists, and it has a live selection
    if (r.mobile.values.length === 0) { res.notes.push('FAIL mobile picker is empty'); return res; }
    if (!mSet.has(r.mobile.selected)) {
      res.notes.push(`FAIL mobile picker selection ${JSON.stringify(r.mobile.selected)} is not one of its options`);
      return res;
    }
    // 4 — static: nothing hardcoded in the markup
    const hard = staticHardcodedOptions(entry.src);
    if (hard === null) {
      res.notes.push(`WARN could not locate the ${MOBILE_SEL} element in the source to static-check it`);
    } else if (hard.length) {
      res.notes.push(`FAIL ${hard.length} literal <option> in the ${MOBILE_SEL} markup — populate it from ${DESKTOP_SEL} instead`);
      res.notes.push('       ' + hard.join(' '));
      return res;
    }
    res.ok = true;
    return res;
  } catch (e) {
    res.notes.push('FAIL ' + String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
    return res;
  } finally {
    if (!process.env.MGL_KEEP) { try { await page.close(); } catch (_e) {} }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const load = (() => { try { return execSync('uptime').toString().trim(); } catch (_e) { return 'unknown'; } })();
console.log('=== mobile_gamelist_test — does the phone offer the same games as the desktop?');
console.log('load: ' + load);
console.log('origin: ' + ORIGIN);

const all = discoverPages();
const both = all.filter((e) => e.hasMobile && e.hasDesktop);
const oneOnly = all.filter((e) => !(e.hasMobile && e.hasDesktop));
console.log(`discovered ${all.length} page(s) with a rom picker; ${both.length} have BOTH a desktop and a mobile picker`);
for (const e of oneOnly) {
  console.log(`  SKIP ${e.rel} — ${e.hasDesktop ? 'desktop picker only' : 'mobile picker only'} (nothing to compare)`);
}
if (!both.length) {
  console.error('FAIL discovery found no page with both pickers — the selectors are wrong or the pages moved');
  process.exit(2);
}

const server = await ensureServer();
const profile = path.join(SCRATCH, 'mobile-gamelist');
fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: profile,
  args: ['--no-sandbox', '--disable-background-timer-throttling',
         '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
         '--autoplay-policy=no-user-gesture-required'],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'mobile_gamelist_test'); } catch (_e) {}

const results = [];
try {
  for (const entry of both) {
    console.log('\n--- ' + entry.rel);
    const r = await testPage(browser, entry);
    results.push(r);
    if (r.raw && r.raw.desktop && r.raw.mobile) {
      console.log('    desktop: ' + JSON.stringify(r.raw.desktop.values));
      console.log('    mobile : ' + JSON.stringify(r.raw.mobile.values));
    }
    for (const n of r.notes) console.log('    ' + n);
    console.log('    ' + (r.ok ? 'PASS' : 'FAIL'));
  }
} finally {
  if (!process.env.MGL_KEEP) { try { await browser.close(); } catch (_e) {} }
  if (server) { try { server.kill('SIGTERM'); } catch (_e) {} }
}

console.log('\n=== SUMMARY');
let failed = 0;
for (const r of results) {
  const detail = r.ok
    ? `${r.mobileCount} game(s), identical on both pickers`
    : (r.missingOnMobile && r.missingOnMobile.length
        ? `UNREACHABLE FROM A PHONE: ${JSON.stringify(r.missingOnMobile)}`
        : r.notes.filter((n) => n.startsWith('FAIL')).join('; ') || 'failed');
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.rel.padEnd(22)} ${detail}`);
  if (!r.ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} pages agree.`);
if (failed) {
  console.error(`FAIL ${failed} page(s) offer a different game list on a phone than on a desktop.`);
  process.exit(1);
}
console.log('PASS every page offers the same games on a phone as on a desktop.');

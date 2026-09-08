#!/usr/bin/env node
// tools/mobile_chrome_test.mjs — THE PHONE CHROME IS REACHABLE IN BOTH ORIENTATIONS.
//
// WHY THIS EXISTS (user-reported 2026-09-08, verbatim):
//   "hamburger button on dreamcast.html mobile flashes and disappears on portrait
//    view, and only shows the play online options when landscape."
//
// Two separate defects produced that one sentence, and NEITHER was covered by any
// existing harness — `grep -l 'setViewport\|hasTouch\|isMobile' tools/*.mjs` did not
// include a single test that opened a phone-sized menu and pressed it.
//
//   1. THE GHOST CLICK. dreamcast.html's ≡ was bound through tapBind, which handles
//      the tap on `pointerdown`. The browser still synthesises a `click` from the
//      same tap, and hit-tests it against the tree AS IT IS THEN — so the click
//      lands on whatever the pointerdown handler just opened over the finger.
//      MEASURED, capture-phase trace of one real touch tap of #mobileMenuBtn:
//        390x844  click -> #mobileMenu  (the BACKDROP) -> final menuOpen=false
//        844x390  click -> #mNet                       -> final netOverlay=flex
//      i.e. the menu flashes open and vanishes in portrait, and in landscape the
//      same tap lands you in Play Online. That IS the report, both halves.
//   2. THE FULL-SCREEN "HINT". #rotateHint shipped as `position:fixed; inset:0;
//      background:#111; z-index:3000` on SIX pages, shown whenever the emulator was
//      running and the device was portrait. MEASURED on dreamcast.html at 390x844
//      after boot: elementFromPoint at the ≡ centre returned #rotateHint, hint rect
//      = 0,0,390x844. Four of the six pages had no dismiss gesture at all.
//
// WHAT IT ASSERTS, per page, in PORTRAIT and LANDSCAPE:
//   a. the menu button is VISIBLE and HIT-TESTABLE — elementFromPoint at its centre
//      returns the button or a descendant, not an overlay;
//   b. it stays that way across SAMPLE_MS of repeated sampling, so a flash-then-
//      vanish fails rather than passing on a lucky single read;
//   c. one tap of it leaves the menu OPEN — not closed by a ghost click, and not
//      redirected into some other overlay;
//   d. where the page has a Play Online control, it is visible and hit-testable
//      (in the menu where the page puts it there, on the splash where it does not).
//
// ARM PROOF (CLAUDE.md "every arm carries an arm-difference proof"). An emulator
// page that never starts cannot exhibit defect 2 at all — `started`/`running`/
// `booted` gates the overlay — so a cell that never reaches its live witness is
// reported VOID, not PASS. VOID still exits non-zero: a gate that could not
// establish its own precondition has not cleared anything.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web                                   # serves :8080 (gate #2)
//   node tools/mobile_chrome_test.mjs             # every page, both orientations
//   node tools/mobile_chrome_test.mjs dreamcast   # one page
//   TARGET=http://localhost:8080 ONLY_ORIENT=portrait node tools/mobile_chrome_test.mjs
//   MOBILE_CHROME_JSON=/tmp/mobile-chrome.json node tools/mobile_chrome_test.mjs
//
// Exit code: 0 only if every selected cell PASSes.

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

process.setMaxListeners(0);   // one exit listener per guarded browser; 30 cells is normal here

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.TARGET || 'http://localhost:8080';
const SCRATCH = process.env.SCRATCH || '/tmp/mobile-chrome-test';
const JSON_OUT = process.env.MOBILE_CHROME_JSON || '/tmp/mobile-chrome.json';
const SAMPLE_MS = +(process.env.SAMPLE_MS || 6000);   // "several seconds" — a flash must fail
const SAMPLE_EVERY = 400;
const UA_IPHONE = process.env.UA ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.5 Mobile/15E148 Safari/604.1';

const PORTRAIT  = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const LANDSCAPE = { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// THE PAGES. Every selector below was read out of the live file, not assumed —
// the six emulator shells are near-copies of each other but they are NOT
// identical: only dreamcast.html carries a Play Online entry INSIDE the mobile
// menu (#mNet); ps1/snes/genesis/n64 put theirs on the splash only; gamecube.html
// has no mobile netplay entry at all; gba.html has its own shell ids entirely.
// ---------------------------------------------------------------------------
const PAGES = [
  { name: 'dreamcast', url: '/dreamcast.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__dcNet', liveField: 'booted', liveMs: 240000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: '#mNet', splashNet: '#mobileSplashNet' },

  // ⚠ gamecube's witness is `started`, NOT frames. #rotateHint there is gated on
  // `started` (gamecube.html:7098), and window.__gcStartedAtMs is set six lines
  // later in the same function — an exact proxy. __gcNet().live means FRAMES ARE
  // BEING PRODUCED, which additionally needs a GPU path this page may not get in
  // a headless browser: measured, it stayed false for 300 s and VOIDed both cells
  // while the overlay's own precondition had been true the whole time.
  { name: 'gamecube', url: '/gamecube.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    liveExpr: '!!window.__gcStartedAtMs', liveMs: 120000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: null },       // this page has no mobile netplay entry

  { name: 'ps1', url: '/ps1.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__ps1Net', liveField: 'live', liveMs: 240000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: '#mobileSplashNet' },

  { name: 'snes', url: '/snes.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__snesNet', liveField: 'live', liveMs: 180000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: '#mobileSplashNet' },

  { name: 'genesis', url: '/genesis.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__genNet', liveField: 'live', liveMs: 180000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: '#mobileSplashNet' },

  { name: 'n64', url: '/n64/',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__n64Net', liveField: 'live', liveMs: 240000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: '#mobileSplashNet' },

  // gba.html is the odd one out in every respect: its shell is #spShell (not
  // #mobileShell), it has NO splash — the desktop Play button starts it and the
  // vendored script.js:866 calls spActivate() — and its Play Online entry lives
  // INSIDE the menu as #spNetBtn. It is also the one page of the six that never
  // had a #rotateHint at all.
  { name: 'gba', url: '/gba.html',
    shell: '#spShell', start: '#btnPlayGame',
    seam: '__gbaNet', liveField: 'live', liveMs: 240000,
    menuBtn: '#spMenuBtn', menu: '#spMenuOverlay', menuOpenClass: 'open',
    menuNet: '#spNetBtn', splashNet: null },

  // The seven lobby pages. They have no emulator, no splash and no hamburger —
  // their whole chrome is the lobby card lib/netplay-guest.js mounts. What can
  // go wrong here is the same class: a control that a 390px-tall landscape
  // viewport pushes off-screen or an overlay covers.
  ...['dreamcast', 'gamecube', 'ps1', 'snes', 'genesis', 'gba', 'n64'].map((c) => ({
    name: c + '_multiplayer', url: '/' + c + '_multiplayer.html',
    lobbyOnly: true, chrome: ['#lobbyCard .np-row button', '#back'],
  })),
];

// ---------------------------------------------------------------------------
// In-page probe. EVERY FIELD IS THE RESULT OF DOING THE THING: the hit test is a
// real document.elementFromPoint at the control's centre, not a check that some
// property looks right. A control can be `display:block; opacity:1` and still be
// under an opaque overlay — that is exactly the bug this file exists for.
// ---------------------------------------------------------------------------
const PROBE = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return { sel, present: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const out = {
    sel, present: true,
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity, zIndex: cs.zIndex,
    onScreen: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
              r.left < innerWidth && r.top < innerHeight,
  };
  out.visible = out.onScreen && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0;
  if (out.rect[2] > 0 && out.rect[3] > 0) {
    const cx = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1));
    const cy = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
    const top = document.elementFromPoint(cx, cy);
    out.point = [cx, cy];
    out.hit = !top ? 'null'
            : (top === el || el.contains(top) || top.contains(el)) ? 'SELF'
            : 'COVERED-BY:' + (top.id ? '#' + top.id : top.tagName.toLowerCase() +
                               (top.className ? '.' + String(top.className).split(/\s+/)[0] : ''));
  } else {
    out.hit = 'zero-rect';
  }
  out.ok = !!(out.visible && out.hit === 'SELF');
  return out;
};

const fmt = (s) => !s ? 'null'
  : !s.present ? s.sel + ' NOT-PRESENT'
  : `${s.sel} ${s.display}/${s.visibility}/op${s.opacity}/z${s.zIndex} ` +
    `rect=${s.rect[0]},${s.rect[1]},${s.rect[2]}x${s.rect[3]} hit=${s.hit}`;

async function probe(page, sel) { return page.evaluate(PROBE, sel); }

// A menu entry inside a SCROLLABLE panel is legitimately reachable once scrolled
// to — what is NOT acceptable is an entry that no scroll can bring into view, or
// one that something covers. So scroll it into view first, then hit-test where it
// lands. (The pre-fix page fails this too: its panel was `align-items: center`
// with no overflow, so the entry could not be scrolled to at all.)
async function probeScrolled(page, sel) {
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
  }, sel);
  await sleep(150);
  return probe(page, sel);
}

// Sample one control repeatedly. A flash-then-vanish MUST fail, so every sample
// has to be ok — the verdict is the AND across the window, and the first bad
// sample is reported verbatim.
async function sampleStable(page, sel, ms, label, out, opts = {}) {
  const t0 = Date.now();
  let n = 0, bad = null, last = null;
  while (Date.now() - t0 < ms) {
    last = await (opts.scroll ? probeScrolled(page, sel) : probe(page, sel)); n++;
    if (!last.ok && !bad) bad = { at: Date.now() - t0, s: last };
    await sleep(SAMPLE_EVERY);
  }
  out.push(`    ${label}: ${n} samples over ${ms}ms — ` +
           (bad ? `FAIL at +${bad.at}ms: ${fmt(bad.s)}` : `all ok: ${fmt(last)}`));
  return { ok: !bad, first: bad ? bad.s : last, samples: n };
}

async function launch(tag) {
  const profile = path.join(SCRATCH, 'prof-' + tag);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.HEADFUL ? false : 'new',
    userDataDir: profile,              // cross-origin isolation is origin-scoped and PERSISTS
    args: ['--no-sandbox', '--disable-background-timer-throttling',
           '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
           '--autoplay-policy=no-user-gesture-required', '--disk-cache-size=268435456'],
  });
  try { (await import('./browser_leak_guard.js')).default.guard(b, 'mobile_chrome'); } catch (_e) {}
  return { b, profile };
}

async function cell(spec, orient) {
  const view = orient === 'portrait' ? PORTRAIT : LANDSCAPE;
  const other = orient === 'portrait' ? LANDSCAPE : PORTRAIT;
  const out = [];
  // ⚠ 'FAIL' AS THE INITIAL VERDICT MADE EVERY EMULATOR-PAGE CELL FAIL, and an
  // earlier build of this file did exactly that: the final verdict ANDed in
  // `rec.verdict !== 'FAIL'` to preserve an explicit failure, which cannot tell
  // "a check failed" from "nothing has been decided yet" — so the initial value
  // alone failed cells whose every line read `all ok`. It reported 12 false
  // failures across gamecube/ps1/snes/genesis/n64/gba, on pages where the menu
  // demonstrably opened (`one tap of #mobileMenuBtn -> #mobileMenu.open=true
  // display=flex` in the very same record). Undecided is null; only `failed`
  // says failed.
  const rec = { page: spec.name, orient, verdict: null, lines: out, checks: {} };
  let failed = false;
  const { b, profile } = await launch(spec.name + '-' + orient);
  try {
    const page = await b.newPage();
    await page.setUserAgent(UA_IPHONE);
    await page.setViewport(view);
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
    await page.goto(ORIGIN + spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3500);                     // coi-serviceworker's guaranteed first reload
    rec.pageErrors = errs.slice(0, 5);

    // ---------------- lobby pages: chrome only ----------------
    if (spec.lobbyOnly) {
      let allOk = true;
      // The lobby is an ordinary scrolling document, so "reachable" here means
      // reachable AFTER scrolling to it — a landscape phone is 390 px tall and
      // this card is taller than that. What must not happen is a control that no
      // scroll brings into view, or one something covers. (Observed and left for
      // the netplay owner: in landscape every lobby's Host/Join row and its
      // "single player" link start BELOW the fold — reachable, but with no
      // affordance saying so.)
      for (const sel of spec.chrome) {
        const r = await sampleStable(page, sel, SAMPLE_MS, 'chrome ' + sel, out, { scroll: true });
        rec.checks[sel] = r.first;
        allOk = allOk && r.ok;
      }
      rec.verdict = allOk ? 'PASS' : 'FAIL';
      return rec;
    }

    // ---------------- emulator pages ----------------
    // The shell has to be up at all before anything else means anything.
    const shell = await probe(page, spec.shell);
    out.push('    shell: ' + fmt(shell));
    if (!shell.present || shell.display === 'none') {
      // gba has no isMobile branch — its shell only appears once a ROM loads.
      if (!spec.start) { rec.verdict = 'VOID'; out.push('    VOID: shell never shown'); return rec; }
    }

    // Play Online where the page puts it on the SPLASH: that is the only route a
    // GUEST has (they never start a game), so it must be reachable BEFORE Start,
    // in this orientation.
    if (spec.splashNet) {
      const r = await sampleStable(page, spec.splashNet, 2000, 'splash Play Online', out);
      rec.checks.splashNet = r.first;
      if (!r.ok) failed = true;
    }

    // Start the emulator. The overlay under test is gated on the page's own
    // started/running/booted flag, so without this the cell proves nothing.
    try { await page.tap(spec.start); } catch (e) { out.push('    tap(' + spec.start + ') threw: ' + e.message); }

    const t0 = Date.now();
    let live = false;
    while (Date.now() - t0 < spec.liveMs) {
      live = await page.evaluate((s, f, expr) => {
        try {
          if (expr) return !!eval(expr);
          const r = window[s] && window[s](); return !!(r && r[f]);
        } catch (e) { return false; }
      }, spec.seam || '', spec.liveField || '', spec.liveExpr || '').catch(() => false);
      if (live) break;
      await sleep(2000);
    }
    const witness = spec.liveExpr || ('window.' + spec.seam + '().' + spec.liveField);
    out.push(`    live witness ${witness} = ${live}` +
             ` after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!live) {
      rec.verdict = 'VOID';
      out.push('    VOID: the emulator never reported live, so the orientation gate was never armed —');
      out.push('          this cell cannot distinguish a fixed page from a broken one.');
      return rec;
    }

    // A phone fires orientation signals constantly (URL-bar collapse, rotation,
    // app switch). Replay the real ones: rotate away and back, then a bare resize.
    await page.setViewport(other); await sleep(1200);
    await page.setViewport(view);  await sleep(1800);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await sleep(600);

    // (a)+(b) the menu button, sampled.
    const btn = await sampleStable(page, spec.menuBtn, SAMPLE_MS, 'menu button', out);
    rec.checks.menuBtn = btn.first;

    // (c) one tap must leave the menu OPEN.
    let opened = null;
    if (btn.ok) {
      try { await page.tap(spec.menuBtn); } catch (e) { out.push('    tap threw: ' + e.message); }
      await sleep(800);
      opened = await page.evaluate((sel, cls) => {
        const m = document.querySelector(sel);
        return { open: !!(m && m.classList.contains(cls)), display: m ? getComputedStyle(m).display : null };
      }, spec.menu, spec.menuOpenClass);
      out.push(`    one tap of ${spec.menuBtn} -> ${spec.menu}.${spec.menuOpenClass}=${opened.open} display=${opened.display}`);
    }
    rec.checks.menuOpens = opened;

    // (d) Play Online inside the menu, where the page has one.
    let net = null;
    if (spec.menuNet && opened && opened.open) {
      net = await sampleStable(page, spec.menuNet, 2000, 'menu Play Online', out, { scroll: true });
      rec.checks.menuNet = net.first;
    } else if (spec.menuNet) {
      out.push('    menu Play Online: NOT CHECKED (menu did not open)');
    }

    if (!btn.ok) failed = true;
    if (opened && !opened.open) failed = true;
    if (net && !net.ok) failed = true;
    rec.verdict = failed ? 'FAIL' : 'PASS';
    if (rec.verdict !== 'PASS') {
      const shot = path.join(SCRATCH, `fail-${spec.name}-${orient}.png`);
      try { await page.screenshot({ path: shot }); out.push('    screenshot: ' + shot); } catch (_e) {}
    }
    return rec;
  } catch (e) {
    out.push('    EXCEPTION: ' + e.message);
    rec.verdict = 'FAIL';
    return rec;
  } finally {
    try { await b.close(); } catch (_e) {}
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// Red-then-green proof support. Point one page row at a different URL — e.g. a
// pre-fix copy of the page dropped next to it and served from the SAME origin, so
// every relative asset still resolves — without editing this file:
//   git show HEAD:dreamcast.html > dreamcast_unfixed_fixture.html
//   URL_OVERRIDE=dreamcast=/dreamcast_unfixed_fixture.html node tools/mobile_chrome_test.mjs dreamcast
// The fixture is a throwaway; delete it when the proof is recorded.
if (process.env.URL_OVERRIDE) {
  for (const pair of process.env.URL_OVERRIDE.split(',')) {
    const i = pair.indexOf('=');
    const row = PAGES.find((p) => p.name === pair.slice(0, i));
    if (row) { row.url = pair.slice(i + 1); console.log('URL_OVERRIDE ' + row.name + ' -> ' + row.url); }
  }
}

// ---------------------------------------------------------------------------
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const orients = process.env.ONLY_ORIENT ? [process.env.ONLY_ORIENT] : ['portrait', 'landscape'];
const selected = only.length ? PAGES.filter((p) => only.includes(p.name)) : PAGES;
if (!selected.length) { console.error('no page matched: ' + only.join(',')); process.exit(2); }

fs.mkdirSync(SCRATCH, { recursive: true });
console.log('mobile_chrome_test — ' + ORIGIN + ' — ' +
            selected.length + ' page(s) x ' + orients.length + ' orientation(s)');
console.log('  portrait=390x844  landscape=844x390  UA=iPhone  sample window=' + SAMPLE_MS + 'ms\n');

const results = [];
for (const spec of selected) {
  for (const o of orients) {
    const r = await cell(spec, o);          // serialized on purpose: shared box, CPU contention
    results.push(r);
    console.log(`[${r.verdict.padEnd(4)}] ${spec.name} / ${o}`);
    r.lines.forEach((l) => console.log(l));
    if (r.pageErrors && r.pageErrors.length) r.pageErrors.forEach((e) => console.log('    pageerror: ' + e));
    console.log('');
  }
}

fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
const pass = results.filter((r) => r.verdict === 'PASS').length;
const fail = results.filter((r) => r.verdict === 'FAIL');
const voids = results.filter((r) => r.verdict === 'VOID');
console.log('--------------------------------------------------------------');
console.log(`PASS ${pass}  FAIL ${fail.length}  VOID ${voids.length}   (json: ${JSON_OUT})`);
fail.forEach((r) => console.log('  FAIL ' + r.page + '/' + r.orient));
voids.forEach((r) => console.log('  VOID ' + r.page + '/' + r.orient + ' — precondition not established'));
process.exit(fail.length + voids.length ? 1 : 0);

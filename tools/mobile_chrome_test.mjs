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
// AND ON THE SEVEN /*_multiplayer.html PAGES, in PORTRAIT and LANDSCAPE:
//   e. every control the page actually has is reachable after scrolling to it and
//      hit-tests to itself — the picker, Create a room, I have a code, and the
//      link back to single player;
//   f. on the two real lobbies (dreamcast, n64) the HANDOFF, end to end and in
//      this orientation: Create mints a five-character code that is on screen,
//      "Start my console" issues a navigation to the emulator page under that
//      code as the host, and a code typed into the box sends Join to the same
//      room carrying join=1. Reachable-but-inert is the failure this catches;
//   g. on the four redirect pages the invitation survives — the scripted replace
//      fires with ?np= intact and the visible fallback link agrees with it.
// The per-page selector lists live in PAGES and are read out of the live files,
// because these seven pages are NOT one shape any more — see the block there.
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

process.setMaxListeners(0);   // one exit listener per guarded browser; 28 cells is normal here

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

  // ⚠ splashNet is null since 2026-09-08: ps1.html no longer has an online
  // button. Streaming was cancelled and this core cannot yet be frame-gated (it
  // drives its own loop from inside wasm), so the control was REMOVED rather
  // than left pointing at a lobby that streams. `__ps1Net().live` survives as a
  // pure liveness witness and still arms this cell.
  { name: 'ps1', url: '/ps1.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__ps1Net', liveField: 'live', liveMs: 240000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: null },

  // ⚠ splashNet is null since 2026-09-08 — the shipped snes9x_2005 core answers
  // ONE controller (exports.c S9xReadJoypad returns 0 for every port but 0), so
  // a lockstep room could seat one person and the button was removed instead of
  // presenting a control that cannot work.
  { name: 'snes', url: '/snes.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__snesNet', liveField: 'live', liveMs: 180000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: null },

  { name: 'genesis', url: '/genesis.html',
    shell: '#mobileShell', start: '#mobileSplashStart',
    seam: '__genNet', liveField: 'live', liveMs: 180000,
    menuBtn: '#mobileMenuBtn', menu: '#mobileMenu', menuOpenClass: 'open',
    menuNet: null, splashNet: '#mobileSplashNet' },

  // ⚠ n64's witness is NOT `__n64Net().live` any more, and asking for it VOIDed
  // BOTH n64 cells while the page was booting perfectly. Commit f94d74d9
  // (2026-09-08 20:05, "online play is DETERMINISTIC LOCKSTEP") replaced
  // window.__n64Net wholesale with a lockstep seam; MEASURED on the live file,
  // `grep -c '      live:' n64/index.html` is 0 at HEAD and in the working tree,
  // so the field this row asked for does not exist and never becomes true. The
  // run at 2026-09-09 00:24 read `live witness window.__n64Net().live = false
  // after 240.4s` in both orientations — 8 minutes spent proving a typo.
  // A SILENT HARNESS FAILURE IS NOT A PAGE FAILURE (CLAUDE.md records the same
  // trap costing a whole n64 investigation via Module.calledRun).
  // window.__n64Rate is repainted every second by paintRate (n64/index.html:2044)
  // and its `made` is "distinct frames the game actually produced this second"
  // (:704, from coreFps.gameFps) — a DRAWN count, which is the only thing
  // CLAUDE.md accepts as proof of liveness, and strictly stronger than the
  // boolean it replaces. #rotateHint's own gate is `started` (:2955), so a page
  // producing frames has cleared that precondition by definition.
  { name: 'n64', url: '/n64/',
    shell: '#mobileShell', start: '#mobileSplashStart',
    liveExpr: '!!(window.__n64Rate && window.__n64Rate.made > 0)', liveMs: 240000,
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
    // ⚠ menuNet is null since 2026-09-08 — a Game Boy Advance has one KEYINPUT
    // register and this core implements no link cable, so there is no second
    // controller to give anybody and #spNetBtn was removed.
    menuNet: null, splashNet: null },

  // ---- the seven /*_multiplayer.html pages --------------------------------
  // They have no emulator, no splash and no hamburger, and what can go wrong is
  // the same class as above: a control that a 390px-tall landscape viewport
  // pushes off-screen, or one something covers.
  //
  // ⚠ THEY ARE NO LONGER ONE SHAPE, AND ONE BLANKET SELECTOR LIST IS WHAT WENT
  // STALE HERE. This file used to ask all seven for `#lobbyCard .np-row button`
  // + `#back` — the card lib/netplay-ui.js mounted inside a `.np-wrap` overlay —
  // and the seven landscape FAILs recorded in /tmp/mobile-chrome.json at
  // 2026-09-08 11:22 were that card's own `div.np-code` / `select.np-sel`
  // hit-testing on top of the page's Back link. Commits f94d74d9..5af7d18e THE
  // SAME EVENING (20:05-21:03) replaced streaming with deterministic lockstep
  // and took the card out of every page with it. MEASURED on the live tree:
  // `grep -c lobbyCard *_multiplayer.html` is 0 on all seven, `grep -rln
  // 'np-wrap\|NetplayUI' *.html` is EMPTY, and no shipping page loads
  // lib/netplay-ui.js at all. Asking for that card again reports NOT-PRESENT
  // seven times and says nothing whatever about whether a landscape phone can
  // use these pages — a red that cannot go green by fixing the product is not a
  // gate, it is noise.
  //
  // So every page is asked for the chrome IT ACTUALLY HAS, and there are three
  // kinds of page now. Each kind is checked to the END of what it promises,
  // because "the button is visible" was never the requirement — leaving the
  // lobby and getting into a room was:
  //
  //   lobby     dreamcast + n64. A real room: a disc/ROM picker, Create/Join, a
  //             minted code, and a Back link. Checked through the HANDOFF —
  //             Create really mints, and Start / Join really issue a navigation
  //             to the emulator page carrying that exact code.
  //   static    gamecube. It has NO room and says so out loud (its dual-core
  //             path cannot advance exactly one emulated frame on demand), so
  //             its chrome is its two links and there is no handoff to check.
  //   redirect  ps1 / snes / genesis / gba. Online play moved onto the emulator
  //             page itself; these only carry an invitation across. The contract
  //             is that the redirect fires with ?np= intact AND that the visible
  //             fallback link says the same thing, which is the half that has to
  //             work when the scripted replace is slow or blocked.
  { name: 'dreamcast_multiplayer', url: '/dreamcast_multiplayer.html',
    lobby: { seam: '__dcmp', emu: '/dreamcast.html',
             chrome: ['#game', '#btnHost', '#btnJoinPane', '#back'] } },
  // ⚠ n64's Back link carries no id (dreamcast's is `#back`). Selected by href
  // rather than adding one: n64_multiplayer.html is being edited by another
  // agent in this same working tree, and CLAUDE.md's pathspec rule does NOT
  // protect a file two agents share — `git commit -- <path>` commits the
  // WORKING TREE, so a one-character id here would carry their unstaged hunks
  // into this commit. A selector costs nothing and touches nothing.
  { name: 'n64_multiplayer', url: '/n64_multiplayer.html',
    lobby: { seam: '__n64mp', emu: '/n64/',
             chrome: ['#game', '#btnHost', '#btnJoinPane', '#wrap > .hint > a[href="/n64/"]'] } },
  { name: 'gamecube_multiplayer', url: '/gamecube_multiplayer.html',
    staticChrome: ['a.cta', 'a[href="/gamecube.html"]'] },
  ...[['ps1', '/ps1.html'], ['snes', '/snes.html'],
      ['genesis', '/genesis.html'], ['gba', '/gba.html']].map(([c, to]) => ({
    name: c + '_multiplayer', url: '/' + c + '_multiplayer.html?np=ABCDE',
    selfPath: '/' + c + '_multiplayer.html',
    redirect: { to, chrome: ['#go'] },
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

// Sweep a list of controls, ANDing the verdicts. Every one is scrolled to first,
// so "below the fold" is reachable and "no scroll reaches it / something covers
// it" is not — which is the whole distinction on a 390px-tall viewport.
async function chromeSweep(page, sels, label, out, rec) {
  let ok = true;
  for (const sel of sels) {
    const r = await sampleStable(page, sel, SAMPLE_MS, label + ' ' + sel, out, { scroll: true });
    rec.checks[label + ' ' + sel] = r.first;
    ok = ok && r.ok;
  }
  return ok;
}

// ⚠ THE HANDOFF IS PROVED BY THE NAVIGATION THE BUTTON ACTUALLY ISSUES, not by
// reading a URL back out of the page's own test seam. A seam that computes the
// string correctly and a button that never fires it are indistinguishable from
// the seam, and "the code was minted" was never the promise — "pressing Start
// puts me in the room" was.
//
// The document request is captured and ABORTED rather than followed: following
// it would boot a whole emulator page per cell (dreamcast.html loads a disc)
// for no extra signal, and aborting leaves this page alive so the join half can
// be driven straight afterwards. The click, the handler and the URL are all
// real; only the download is refused.
//
// ⚠ THE ERROR CODE IS LOAD-BEARING: it MUST be 'aborted'. puppeteer's bare
// request.abort() defaults to `failed` (net::ERR_FAILED), and a FAILED main-frame
// navigation COMMITS CHROME'S ERROR PAGE — which replaces the document. Measured
// here, first run of this code: the host handoff was captured correctly and then
// `tap(#btnJoinPane) threw: No element found`, `#codeIn NOT-PRESENT` and
// `EXCEPTION: Cannot set properties of null` on both lobbies, and `#go
// NOT-PRESENT` on all four redirect pages — six red cells that were the harness
// demolishing the page it was measuring. net::ERR_ABORTED is the code a
// user-cancelled navigation uses and it leaves the current document untouched.
async function armNavCapture(page, selfPath) {
  const seen = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        const u = new URL(req.url());
        if (u.pathname !== selfPath) { seen.push(u.pathname + u.search); return req.abort('aborted'); }
      }
      req.continue();
    } catch (_e) { try { req.continue(); } catch (_e2) {} }
  });
  return { seen, last: () => (seen.length ? seen[seen.length - 1] : null) };
}

async function tapSel(page, sel, out) {
  try { await page.tap(sel); return true; }
  catch (e) { out.push('    tap(' + sel + ') threw: ' + e.message); return false; }
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

    // A redirect page leaves on its own, so the capture has to be armed BEFORE
    // the navigation that triggers it.
    let nav = null;
    if (spec.redirect) nav = await armNavCapture(page, spec.selfPath);
    await page.goto(ORIGIN + spec.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch((e) => out.push('    goto: ' + e.message));
    await sleep(3500);                     // coi-serviceworker's guaranteed first reload
    rec.pageErrors = errs.slice(0, 5);

    // ---------------- redirect pages (ps1 / snes / genesis / gba) -----------
    // Their whole job is to carry an invitation onto the emulator page. Two
    // halves, and the second is the one a slow or blocked script exposes: the
    // scripted replace must fire with ?np= intact, AND the visible fallback link
    // must be reachable and point at the same place.
    if (spec.redirect) {
      const to = nav.last();
      out.push(`    redirect ${spec.url} -> ${to || '(none fired)'}`);
      rec.redirect = to;
      let ok = !!to && to.split('?')[0] === spec.redirect.to && /(^|[?&])np=ABCDE(&|$)/.test(to);
      if (!ok) out.push(`    FAIL: expected a navigation to ${spec.redirect.to}?np=ABCDE`);
      const href = await page.evaluate(() => {
        const a = document.getElementById('go'); return a ? a.getAttribute('href') : null;
      });
      out.push('    fallback link #go href=' + href);
      rec.fallbackHref = href;
      if (href !== spec.redirect.to + '?np=ABCDE') {
        ok = false;
        out.push(`    FAIL: the visible fallback disagrees with the redirect — expected ${spec.redirect.to}?np=ABCDE`);
      }
      ok = (await chromeSweep(page, spec.redirect.chrome, 'chrome', out, rec)) && ok;
      rec.verdict = ok ? 'PASS' : 'FAIL';
      return rec;
    }

    // ---------------- the static explainer page (gamecube) ------------------
    if (spec.staticChrome) {
      const ok = await chromeSweep(page, spec.staticChrome, 'chrome', out, rec);
      rec.verdict = ok ? 'PASS' : 'FAIL';
      return rec;
    }

    // ---------------- lobby pages (dreamcast / n64) -------------------------
    // An ordinary scrolling document, so "reachable" means reachable AFTER
    // scrolling to it — a landscape phone is 390px tall and the card is taller
    // than that. What must not happen is a control no scroll brings into view,
    // or one something covers. Then the handoff, end to end, in THIS
    // orientation: a lobby whose Create button is reachable and whose Start
    // button is under something is still a lobby nobody can leave.
    if (spec.lobby) {
      const L = spec.lobby;
      const seam = await page.evaluate((s) => {
        try { return window[s] ? window[s]() : null; } catch (_e) { return null; }
      }, L.seam);
      rec.seam = seam;
      // ARM PROOF. A browser with no WebRTC gets the explanation, not the
      // controls — that page is CORRECT and has no Create button, so demanding
      // one would fail a page doing exactly the right thing.
      if (!seam) {
        out.push(`    VOID: window.${L.seam}() is not published — the lobby script did not run`);
        rec.verdict = 'VOID'; return rec;
      }
      if (!seam.supported) {
        out.push(`    VOID: the page reports online play unsupported (missing ${seam.missing}) —`);
        out.push('          it is showing its explanation, so there is no lobby here to reach.');
        rec.verdict = 'VOID'; return rec;
      }

      let ok = await chromeSweep(page, L.chrome, 'chrome', out, rec);

      // HOST: press Create a room for real, then everything the code arrives with.
      await tapSel(page, '#btnHost', out);
      await sleep(500);
      ok = (await chromeSweep(page, ['#code', '#btnCopy', '#btnGo'], 'host', out, rec)) && ok;
      const hosted = await page.evaluate((s) => window[s](), L.seam);
      const shown = await page.evaluate(() =>
        (document.getElementById('code') || {}).textContent.trim());
      out.push(`    host: code=${hosted.code} shown="${shown}" hostUrl=${hosted.hostUrl}`);
      rec.host = { code: hosted.code, shown, hostUrl: hosted.hostUrl };
      if (!/^[A-HJ-NP-Z2-9]{5}$/.test(String(hosted.code || '')) || shown !== hosted.code) {
        ok = false;
        out.push('    FAIL: Create a room did not put a readable five-character code on screen');
      }

      // The handoff itself. The navigation is captured and aborted; the tap, the
      // handler and the URL are real.
      nav = await armNavCapture(page, spec.url);
      await tapSel(page, '#btnGo', out);
      await sleep(1200);
      const hostGo = nav.last();
      out.push('    host handoff: #btnGo -> ' + (hostGo || '(no navigation)'));
      rec.hostGo = hostGo;
      if (!hostGo || hostGo.split('?')[0] !== L.emu ||
          !new RegExp('(^|[?&])np=' + hosted.code + '(&|$)').test(hostGo) ||
          /(^|[?&])join=1(&|$)/.test(hostGo)) {
        ok = false;
        out.push(`    FAIL: Start my console must open ${L.emu} under np=${hosted.code} as the HOST`);
      }

      // JOIN: the other side of the same room, driven the way a person does it.
      await tapSel(page, '#btnJoinPane', out);
      await sleep(500);
      ok = (await chromeSweep(page, ['#codeIn', '#btnJoin'], 'join', out, rec)) && ok;
      // Guarded: a cell that throws here reports EXCEPTION and loses every line
      // it had already earned, which is how the abort-code bug above read as six
      // unrelated failures instead of one.
      await page.evaluate(() => { const i = document.getElementById('codeIn'); if (i) i.value = ''; });
      await page.focus('#codeIn').catch((e) => out.push('    focus(#codeIn): ' + e.message));
      await page.keyboard.type(hosted.code, { delay: 30 });
      const typed = await page.evaluate(() => {
        const i = document.getElementById('codeIn'); return i ? i.value : null;
      });
      out.push('    join: typed "' + typed + '" into #codeIn');
      if (typed !== hosted.code) {
        ok = false;
        out.push('    FAIL: the code box did not accept the characters that were typed into it');
      }
      await tapSel(page, '#btnJoin', out);
      await sleep(1200);
      const joinGo = nav.last();
      out.push('    join handoff: #btnJoin -> ' + (joinGo || '(no navigation)'));
      rec.joinGo = joinGo;
      if (!joinGo || joinGo === hostGo || joinGo.split('?')[0] !== L.emu ||
          !new RegExp('(^|[?&])np=' + hosted.code + '(&|$)').test(joinGo) ||
          !/(^|[?&])join=1(&|$)/.test(joinGo)) {
        ok = false;
        out.push(`    FAIL: Join must open ${L.emu} under np=${hosted.code} carrying join=1`);
      }

      rec.verdict = ok ? 'PASS' : 'FAIL';
      if (!ok) {
        const shot = path.join(SCRATCH, `fail-${spec.name}-${orient}.png`);
        try { await page.screenshot({ path: shot }); out.push('    screenshot: ' + shot); } catch (_e) {}
      }
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

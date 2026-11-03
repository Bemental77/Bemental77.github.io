#!/usr/bin/env node
// tools/multiplayer_page_browser_test.mjs — DOES THE ONE-URL LOBBY ACTUALLY
// HAND A PLAYER TO THE RIGHT PAGE, WITH THE RIGHT CODE, ON EVERY CONSOLE?
//
// tools/multiplayer_page_test.mjs proves the catalogue statically. This drives
// the page in Chrome and proves the part a grep cannot: that the controls are
// REACHABLE (dreamcast_multiplayer.html records a lobby that minted a code and
// then hid the only button that carried it — a stylesheet display:none the
// script could not clear), that "Open a party" mints a code and an invite link,
// that "Start my console" and "Join" really issue a NAVIGATION to the console's
// emulator page carrying that exact code and game, and that an invite link
// opened cold lands on one Join button that goes to the same place.
//
// Navigations to the emulator pages are INTERCEPTED AND ANSWERED 204, so no
// console boots and no disc downloads: the URL the page asked for is the
// evidence. ⚠ 204, not abort(): aborting a top-level navigation swaps in a
// chrome-error:// document and every control on the lobby vanishes with it —
// measured here as `No element found for selector: #btnJoinPane` right after
// the first host hand-off. A 204 on a navigation is ignored by the browser and
// the current document stays.
//
// HARNESS (2026-11-02, stage GR4). This file used to drive Chrome through
// puppeteer with a macOS executable path ('/Applications/Google Chrome.app/...'):
// on this box it died at launch ("Browser was not found at the configured
// executablePath"), so the lobby's browser gate had not run here at all — and a
// puppeteer launch cannot carry --mute-audio through the shared harness. It now
// runs on tools/headless_cdp.mjs / headless_cdp_multi.mjs: ONE headless Chrome
// over bare CDP, --mute-audio, a throwaway profile, the machine-wide browser
// lock. Every cell below is the cell that was there before; the Page methods
// the old cells used (evaluate / click / type / tap / goto / the 204 request
// interception) are the small adapter just under this comment.
//
//   node tools/browser_leak_guard.js reap
//   npm run web                                 # port 8080 — the only server (gate #2); ORIGIN=http://localhost:<port> to use another
//   node tools/multiplayer_page_browser_test.mjs
//   LOBBY_OUT=<dir> ...                         # where the screenshots go (default <tmp>/lobby-browser)
//   LOBBY_CDP=<port> ...                        # the CDP port (default 9311)
//   LOBBY_ONLY=gba,join ... / LOBBY_SKIP=e2e  # sections: core, gba, join, invite, unsupported, e2e (e2e skips itself, visibly, where the ROM is not served)
//   LOBBY_MUTANT=<name> ...                     # serve a DELIBERATELY BROKEN multiplayer.html (see MUTANTS): the run must exit non-zero
//
// THE GAME BOY ADVANCE (stage GR4). gba.html forms lockstep link-cable rooms, so the lobby now hands a host to
// /gba.html?np=<code>&game=<title>&host=1&seats=N and a joiner to /gba.html?np=<code>&game=<title>&join=1. Section
// `gba` drives that from the lobby (every control by a real mouse/touch event, navigations answered 204), and
// section `e2e` lets the hand-off through to the REAL gba.html in two windows of one browser and watches the room
// form and run. The lobby offers only the titles in gba/mgba/room.js ROOMABLE (tools/multiplayer_page_test.mjs pins
// the lists; this file checks what a visitor actually sees).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withBrowserMulti } from './headless_cdp_multi.mjs';

const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const CDP_PORT = Number(process.env.LOBBY_CDP || 9311);
const OUT = process.env.LOBBY_OUT ? path.resolve(process.env.LOBBY_OUT) : path.join(os.tmpdir(), 'lobby-browser');
fs.mkdirSync(OUT, { recursive: true });
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const csv = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ONLY = csv(process.env.LOBBY_ONLY), SKIP = csv(process.env.LOBBY_SKIP);
const want = (s) => (!ONLY.length || ONLY.includes(s)) && !SKIP.includes(s);
// Deliberately broken lobbies, served in place of the real multiplayer.html by the request interception below. Each
// must make this file FAIL; a mutant whose anchor is not found aborts the run (a control that changed nothing proves nothing).
const MUTANTS = {
  'ps1-wrong-page':           [/handoff: '\/ps1\.html\?np='/, "handoff: '/snes.html?np='"],
  'gba-no-host-flag':         [/handoff: '\/gba\.html\?np=', hostFlag: 'host=1'/, "handoff: '/gba.html?np=', hostFlag: ''"],
  'gba-seats-dropped':        [/if \(n\) u \+= '&seats=' \+ n;/, ''],
  'gba-unroomable-title':     [/(\{ key: 'Sonic Advance 3',[^}]*\},)/, "$1 { key: 'Monster Rancher Advance 2', label: 'Monster Rancher Advance 2', seats: [2] },"],
  'gba-code-minted-untagged': [/code = Netplay\.makeCode\(5, c\.key\);/, 'code = Netplay.makeCode(5);'],       // the console-change re-mint forgets the console key: an untagged code on /multiplayer.html
  'gba-seat-row-never-shown': [/\$\('seatsRow'\)\.hidden = !\(all && all\.length > 1\);/, "$('seatsRow').hidden = true;"],
  'join-stale-chip':          [/if \(!jManual && jSys && !\(codeSays && jSys\.key === codeSays\)\) clearJoin\(\);/, ''],                 // FV2's quirk back: the earlier code's pick stays pressed
  'gba-lobby-ignores-consoleOfCode':        [/var det = Netplay\.consoleOfCode \? Netplay\.consoleOfCode\(v\) : null;/, 'var det = null;'],                                       // a joiner is always asked which console
  'gba-lobby-reuses-another-consoles-code': [/if \(!code \|\| \(named && named !== sys\.key\)\) code = Netplay\.makeCode\(5, sys\.key\);/, 'if (!code) code = Netplay.makeCode(5, sys.key);'],   // Open a party after a console change keeps the old console's code
};
const MUTANT = process.env.LOBBY_MUTANT || '';
if (MUTANT && !MUTANTS[MUTANT]) { console.log(`  FAIL  LOBBY_MUTANT=${MUTANT} — unknown mutant (known: ${Object.keys(MUTANTS).join(', ')})`); process.exit(2); }
let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  PASS  ${n} — ${d}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n} — ${d}`); };
// A negative control: `caught` is true when the check REJECTED the broken thing it was shown.
const control = (n, caught, d) => (caught ? ok(n, d) : bad(n + ' (the control did NOT trip)', d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuLoad = () => {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 });
    const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v + '% CPU busy (Win32_Processor LoadPercentage)' : '?';
  } catch (e) { return '?'; }
};
console.log('  ....  load ' + cpuLoad() + '  origin ' + ORIGIN);
try { if (!(await fetch(ORIGIN + '/multiplayer.html')).ok) throw new Error('not ok'); }
catch (e) { console.log(`  FAIL  server — nothing answers ${ORIGIN}/multiplayer.html (start it with: npm run web)`); process.exit(2); }

// ⚠ POLL FROM NODE — page.waitForFunction polls on rAF and stalls in a
// background tab (tools/netplay_test.mjs records that false negative).
async function until(fn, ms = 5000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } }
const decoded = (u) => { try { const x = new URL(u); return { path: x.pathname, q: Object.fromEntries(x.searchParams) }; } catch (e) { return { path: null, q: {} }; } };

// ---------------------------------------------------------------------------
// The adapter. A Tab wraps one tools/headless_cdp.mjs Page with the handful of
// verbs the cells use. click/tap find the element's centre and send a REAL
// mouse / touch event at that point, so an element that is covered, hidden or
// disabled is NOT clicked — which is what a reachability test must measure.
// ---------------------------------------------------------------------------
function tab(pg, { allow = /\/multiplayer\.html(?:\?|$)/ } = {}) {
  const t = {
    pg, nav: { url: null },
    evaluate: (fn, ...args) => pg.eval(`(${fn.toString()})(...${JSON.stringify(args)})`),
    async goto(url) { await pg.navigate(url); },
    async center(sel) {
      const r = await pg.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center',inline:'center'});var b=e.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};})()`);
      if (!r) throw new Error('No element found for selector: ' + sel);
      return r;
    },
    async click(sel) { const c = await t.center(sel); await pg.click(c.x, c.y); },
    async tap(sel) { const c = await t.center(sel); await pg.tap(c.x, c.y); },
    async type(sel, text) {
      await pg.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      await pg.send('Input.insertText', { text });
    },
    async shot(name) { return pg.screenshot(path.join(OUT, name)); },
    async close() { await t.closer(); },
  };
  // Every top-level navigation that is not the lobby itself is caught and answered 204: the URL asked for is
  // the evidence, and the lobby document stays where it is.
  t.intercept = async () => {
    await pg.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document' }] });
    const frame = (await pg.send('Page.getFrameTree')).frameTree.frame.id;
    pg.handlers.push((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request, frameId, resourceType } = m.params;
      if (resourceType === 'Document' && frameId === frame && !allow.test(request.url)) {
        t.nav.url = request.url;
        pg.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [], body: '' }).catch(() => {});
      } else if (MUTANT && resourceType === 'Document' && /\/multiplayer\.html(?:\?|$)/.test(request.url)) {
        // LOBBY_MUTANT: serve the real page with one deliberate defect (the anchor must be found, or the run aborts)
        const [re, to] = MUTANTS[MUTANT];
        fetch(request.url).then((r) => r.text()).then((txt) => {
          if (!re.test(txt)) { console.log(`  FAIL  LOBBY_MUTANT=${MUTANT} — anchor ${re} not found in multiplayer.html, so the control changed nothing`); process.exit(2); }
          const body = Buffer.from(txt.replace(re, to), 'utf8').toString('base64');
          return pg.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body });
        }).catch((e) => { console.log('  FAIL  mutant serve failed: ' + e.message); process.exit(2); });
      } else pg.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });
  };
  return t;
}
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && e.checkVisibility() && e.getBoundingClientRect().height > 0; }, sel);
const seam = (p) => p.evaluate(() => window.__mp());

await withBrowserMulti({ port: CDP_PORT, windows: 1, width: 1280, height: 800 }, async ({ pages, openWindow, closeWindow }) => {
  // A page whose navigations AWAY from the lobby are caught and answered 204.
  async function lobbyPage(mobile, allow, { intercept = true } = {}) {
    const pg = await openWindow(mobile ? { width: 390, height: 844, mobile: true } : { width: 1280, height: 800 });
    if (mobile) await pg.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
    const t = tab(pg, allow ? { allow } : undefined);
    t.closer = async () => { await closeWindow(pg); };
    if (intercept) await t.intercept();
    return { p: t, nav: t.nav };
  }

  // ---------------------------------------------------------------------------
  // 1. EVERY CONSOLE: host hand-off and join hand-off, from the same page.
  // ---------------------------------------------------------------------------
  console.log('\n== host + join hand-off, per console ==');
  const EXPECT = {
    dreamcast: { path: '/dreamcast.html', host: {}, join: { join: '1' } },
    n64:       { path: '/n64/',           host: {}, join: { join: '1' } },
    gamecube:  { path: '/gamecube.html',  host: {}, join: { join: '1' } },
    genesis:   { path: '/genesis.html',   host: { host: '1' }, join: { join: '1' } },
    snes:      { path: '/snes.html',      host: { host: '1' }, join: { join: '1' } },
    ps1:       { path: '/ps1.html',       host: { host: '1' }, join: { join: '1' } },
    pokemonarena: { path: '/pokemonarena/battle.html', host: { host: '1' }, join: { join: '1' } },
  };
  if (want('core')) {
    const { p, nav } = await lobbyPage(false);
    await p.goto(ORIGIN + '/multiplayer.html?net=local');
    const s0 = await seam(p);
    s0 && s0.supported ? ok('page-renders-supported', `default console ${s0.sys}, game "${s0.game}"`) : bad('page-renders-supported', JSON.stringify(s0));
    for (const sel of ['#consoles button[aria-pressed]', '#game', '#btnHost', '#btnJoinPane', '#wrap > .hint > a[href="/playground.html"]']) {
      (await visible(p, sel)) ? ok(`chrome-visible ${sel}`, 'in the layout, non-zero height') : bad(`chrome-visible ${sel}`, 'not visible');
    }
    // THE GAME BOY ADVANCE IS ONLINE since gba.html formed lockstep rooms (stage GR2); this cell used to assert the chip was
    // DISABLED ("No online play"), which would now keep a visitor away from a working feature.
    const gbaChip = await p.evaluate(() => { const b = [...document.querySelectorAll('#consoles button')].find((x) => /Game Boy/.test(x.textContent)); return b ? { disabled: b.disabled, text: b.textContent } : null; });
    gbaChip && gbaChip.disabled === false && /3 games · up to 4 players/.test(gbaChip.text)
      ? ok('gba-chip-is-pressable', gbaChip.text) : bad('gba-chip-is-pressable', JSON.stringify(gbaChip));

    for (const [key, ex] of Object.entries(EXPECT)) {
      // A console with no multiplayer game in the catalogue (lib/mpgames.js drops single-player titles)
      // has a disabled chip and no room to host or join: nothing to hand off. Today: SNES (SimCity).
      const offered = await p.evaluate((k) => { const c = window.__mpCatalog.find((x) => x.key === k); return !!(c && c.games.length); }, key);
      if (!offered) { ok(`${key}-not-offered`, 'no multiplayer game listed — chip disabled, nothing to hand off'); continue; }
      // pick the console by its chip
      await p.evaluate((k) => { const c = window.__mpCatalog.find((x) => x.key === k); [...document.querySelectorAll('#consoles button')].find((b) => b.firstChild.textContent === c.name).click(); }, key);
      const game = await p.evaluate(() => document.getElementById('game').value);
      // HOST: Open a party -> code + invite shown -> Start my console navigates
      await p.click('#btnHost');
      const shown = await until(async () => (await visible(p, '#btnGo')) && (await visible(p, '#code')) ? await p.evaluate(() => document.getElementById('code').textContent.trim()) : null);
      CODE_RE.test(shown || '') ? ok(`${key}-open-party-mints-a-code`, `"${shown}", #btnGo and #code visible`) : bad(`${key}-open-party-mints-a-code`, `code="${shown}"`);
      const s = await seam(p);
      const inv = decoded(s.invite || '');
      inv.path === '/multiplayer.html' && inv.q.np === shown && inv.q.sys === key && inv.q.game === game
        ? ok(`${key}-invite-link`, s.invite) : bad(`${key}-invite-link`, `${s.invite} (wanted np=${shown} sys=${key} game=${game})`);
      nav.url = null;
      await p.click('#btnGo');
      const hostNav = await until(async () => nav.url);
      const h = decoded(hostNav || '');
      const hostOk = h.path === ex.path && h.q.np === shown && h.q.game === game && h.q.net === 'local' && !('join' in h.q)
        && Object.entries(ex.host).every(([k, v]) => h.q[k] === v) && (('host' in ex.host) || !('host' in h.q));
      hostOk ? ok(`${key}-start-navigates-as-host`, hostNav) : bad(`${key}-start-navigates-as-host`, `${hostNav} (wanted ${ex.path} np=${shown} game="${game}" ${JSON.stringify(ex.host)})`);
      // JOIN: I have a code -> type it -> Join navigates with join=1
      await p.click('#btnJoinPane');
      await p.evaluate(() => { document.getElementById('codeIn').value = ''; });
      await p.type('#codeIn', shown);
      nav.url = null;
      await p.click('#btnJoin');
      const joinNav = await until(async () => nav.url);
      const j = decoded(joinNav || '');
      // A JOINER TYPES THE CODE AND NOTHING ELSE (d2ad2e3: room codes name their console). It cannot
      // know the host's game, so the hand-off carries the console's first game only as a starting point:
      // every room page follows the host's roster ('room-game') before it boots, and the joiner's
      // session is built with no game so the pairing never compares one (dreamcast.html netStartGuest).
      // What must hold: the right page, the code, join=1, never host, and a game of THAT console.
      const consoleGames = ((s.consoles || []).find((c) => c.key === key) || {}).games || null;   // the page's own catalogue (window.__mp)
      const gameOkForConsole = !('game' in j.q) || !consoleGames || consoleGames.includes(j.q.game);
      const joinOk = j.path === ex.path && j.q.np === shown && gameOkForConsole && j.q.join === '1' && !('host' in j.q);
      joinOk ? ok(`${key}-join-navigates-as-joiner`, joinNav) : bad(`${key}-join-navigates-as-joiner`, `${joinNav} (wanted ${ex.path} np=${shown} join=1, a ${key} game)`);
      // The join pane hides the host's picker (the joiner gets its own card), so go Back to it, as a
      // person would, before picking the next console.
      await p.click('#btnJoinBack');
    }
    await p.click('#btnJoinPane');
    // a malformed code is refused HERE, on the page it was typed on
    await p.evaluate(() => { document.getElementById('codeIn').value = 'AB01I'; });
    nav.url = null; await p.click('#btnJoin'); await sleep(300);
    const warned = await visible(p, '#joinWarn');
    warned && !nav.url ? ok('malformed-code-refused-on-the-lobby', 'warning shown, no navigation') : bad('malformed-code-refused-on-the-lobby', `warn=${warned} nav=${nav.url}`);

    // ---- THE LINK MUST NAME THE CONSOLE THE PAGE IS SHOWING -------------------
    // pickConsole() rebuilds the game list and repoints `sys`, but it did NOT
    // re-point #invite — only the game <select>'s own change handler did
    // (multiplayer.html:372). So a host could mint a code, change their mind
    // about the console, and hand out a link still naming the OLD console while
    // "Start my console" took THEM to the new one. Two players, two different
    // pages, one code they can never meet on. Nothing else here catches it: every
    // other cell picks a console and then never changes it.
    {
      const chip = (k) => p.evaluate((key) => {
        const c = window.__mpCatalog.find((x) => x.key === key);
        [...document.querySelectorAll('#consoles button')].find((b) => b.firstChild.textContent === c.name).click();
      }, k);
      await p.click('#btnJoinBack');   // the malformed-code cell above left the join pane open
      await chip('dreamcast');
      await p.click('#btnHost');
      const code = await until(async () => {
        const t = await p.evaluate(() => (document.getElementById('code').textContent || '').trim());
        return CODE_RE.test(t) ? t : null;
      });
      await chip('genesis');
      await sleep(150);
      const after = await seam(p);
      const gameNow = await p.evaluate(() => document.getElementById('game').value);
      // ⚠ READ THE INPUT, NOT THE SEAM. window.__mp() RECOMPUTES `invite` from the
      // live `sys` and `sel.value`, so it is right even when the field the host
      // copies is stale — asserting the seam here passed against the defect and
      // proved nothing. What a person hands over is #invite's value and the Copy
      // link button, which reads that same field.
      const shownInvite = await p.evaluate(() => document.getElementById('invite').value);
      const iv = decoded(shownInvite || '');
      // A CODE NAMES ITS CONSOLE (d2ad2e3), so the console change mints a new one: the link must carry
      // the code now on screen, and that code must name the new console.
      const codeNow = await p.evaluate(() => (document.getElementById('code').textContent || '').trim());
      const named = await p.evaluate((c) => (window.Netplay && Netplay.consoleOfCode) ? Netplay.consoleOfCode(c) : null, codeNow);
      (iv.q.np === codeNow && codeNow !== code && named === 'genesis' && iv.q.sys === 'genesis' && iv.q.game === gameNow && after.sys === 'genesis')
        ? ok('invite-follows-a-console-change', shownInvite)
        : bad('invite-follows-a-console-change',
              `#invite=${shownInvite} — but the page now shows sys=${after.sys} game="${gameNow}" code=${codeNow} (was ${code}, names ${named})`);
    }
    await p.close();

    // ---- A PARTY THAT IS ALREADY OPEN IS NOT RE-OPENED SILENTLY ---------------
    // #pick stays visible while the host pane is open (showHost touches only
    // hostPane/joinPane), so "Open a party" remains one click away the whole time
    // the code is on screen — and it minted a NEW code every time. A host who
    // pressed it again, or who came back to the tab and pressed the button they
    // remembered, invalidated the code their friend was typing, with no sign that
    // anything had changed but five characters.
    {
      const { p: p2 } = await lobbyPage(false);
      const chip = (k) => p2.evaluate((key) => {
        const c = window.__mpCatalog.find((x) => x.key === key);
        [...document.querySelectorAll('#consoles button')].find((b) => b.firstChild.textContent === c.name).click();
      }, k);
      await p2.goto(ORIGIN + '/multiplayer.html?net=local');
      await chip('dreamcast');
      await p2.click('#btnHost');
      const first = await until(async () => {
        const t = await p2.evaluate(() => (document.getElementById('code').textContent || '').trim());
        return CODE_RE.test(t) ? t : null;
      });
      await p2.click('#btnHost');
      await sleep(150);
      const second = await p2.evaluate(() => (document.getElementById('code').textContent || '').trim());
      first === second
        ? ok('open-a-party-twice-keeps-the-code', `${first} survived a second press`)
        : bad('open-a-party-twice-keeps-the-code',
              `${first} -> ${second} — the code a friend is typing was replaced with no warning`);
      await p2.close();
    }

    // ---- A PASTED INVITE LINK IS A CODE ---------------------------------------
    // The host is handed two things to share, a code and a LINK, and the join box
    // is the obvious place a person pastes either. CODE_RE rejected the link with
    // "That does not look like a code", which is true and useless: the code is
    // right there in the ?np= of the thing they pasted, along with the console
    // and the game, and the lobby already knows how to read all three from a URL
    // — it does exactly that for ?np= in its own address bar.
    {
      const { p: p3, nav: nav3 } = await lobbyPage(false);
      await p3.goto(ORIGIN + '/multiplayer.html?net=local');
      await p3.evaluate(() => {
        const c = window.__mpCatalog.find((x) => x.key === 'dreamcast');
        [...document.querySelectorAll('#consoles button')].find((b) => b.firstChild.textContent === c.name).click();
      });
      await p3.click('#btnJoinPane');
      const link = ORIGIN + '/multiplayer.html?np=K7MQ2&sys=genesis&game=' + encodeURIComponent('X-Men') + '&net=local';
      // a paste fires 'input' (the lobby collapses the link to its code there and enables Join)
      await p3.evaluate((v) => { const el = document.getElementById('codeIn'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, link);
      nav3.url = null;
      await p3.click('#btnJoin');
      const pasted = await until(async () => nav3.url, 4000);
      const d = decoded(pasted || '');
      (d.path === '/genesis.html' && d.q.np === 'K7MQ2' && d.q.game === 'X-Men' && d.q.join === '1')
        ? ok('a-pasted-invite-link-joins', pasted)
        : bad('a-pasted-invite-link-joins',
              `${pasted} — pasting the link the host was told to send was refused as "not a code"`);
      await p3.close();
    }
  }

  // ---------------------------------------------------------------------------
  // 2. THE INVITE LINK, opened cold on a phone: one button, right destination.
  // ---------------------------------------------------------------------------
  console.log('\n== invite link, cold, phone viewport ==');
  if (want('invite')) {
    const { p, nav } = await lobbyPage(true);
    await p.goto(ORIGIN + '/multiplayer.html?np=K7MQ2&sys=n64&game=' + encodeURIComponent('Mario Kart 64') + '&net=local');
    const s = await seam(p);
    s.invited && s.invited.code === 'K7MQ2' && s.invited.sys === 'n64' && s.invited.game === 'Mario Kart 64'
      ? ok('invite-parsed', JSON.stringify(s.invited)) : bad('invite-parsed', JSON.stringify(s.invited));
    (await visible(p, '#btnInvitedJoin')) && !(await visible(p, '#pick'))
      ? ok('invite-shows-one-join-button', 'pickers hidden, Join visible on a 390px viewport') : bad('invite-shows-one-join-button', 'Join not visible or pickers still shown');
    const text = await p.evaluate(() => document.getElementById('invitedText').textContent);
    /Mario Kart 64/.test(text) && /Nintendo 64/.test(text) && /K7MQ2/.test(text)
      ? ok('invite-names-game-console-code', text) : bad('invite-names-game-console-code', text);
    nav.url = null;
    await p.tap('#btnInvitedJoin');
    const u = decoded((await until(async () => nav.url)) || '');
    u.path === '/n64/' && u.q.np === 'K7MQ2' && u.q.game === 'Mario Kart 64' && u.q.join === '1'
      ? ok('invite-join-navigates', nav.url) : bad('invite-join-navigates', String(nav.url));
    // "not the game they meant" opens the JOINER'S own pane with the code kept (d2ad2e3: the joiner gets
    // its own card; the host's picker is never shown over a joiner's screen)
    await p.tap('#btnInvitedPick');
    const kept = await p.evaluate(() => ({ join: document.getElementById('joinPane').checkVisibility(), hostPick: document.getElementById('pick').checkVisibility(), code: document.getElementById('codeIn').value }));
    kept.join && !kept.hostPick && kept.code === 'K7MQ2' ? ok('invite-fallback-keeps-the-code', JSON.stringify(kept)) : bad('invite-fallback-keeps-the-code', JSON.stringify(kept));
    await p.close();
  }
  // An invite naming a game the site does not offer: join pane, code kept, told why.
  if (want('invite')) {
    const { p } = await lobbyPage(false);
    await p.goto(ORIGIN + '/multiplayer.html?np=K7MQ2&sys=gba&game=Anything');
    const st = await p.evaluate(() => ({ join: document.getElementById('joinPane').checkVisibility(), warn: document.getElementById('joinWarn').textContent, code: document.getElementById('codeIn').value, invited: window.__mp().invited }));
    st.join && st.code === 'K7MQ2' && /does not offer/.test(st.warn) && st.invited === null
      ? ok('invite-to-unavailable-game-falls-back', st.warn) : bad('invite-to-unavailable-game-falls-back', JSON.stringify(st));
    await p.close();
  }

  // ---------------------------------------------------------------------------
  // 2b. THE GAME BOY ADVANCE (stage GR4): the lobby hands a host to /gba.html?np=&game=&host=1&seats=N and a
  //     joiner to /gba.html?np=&game=&join=1, offers only the titles that linked, and mints codes that cannot be
  //     mistaken for another console's.
  // ---------------------------------------------------------------------------
  console.log('\n== Game Boy Advance (stage GR4) ==');
  const SBAM = 'Super Bust-A-Move', KIRBY = 'Kirby Nightmare in Dreamland', SA3 = 'Sonic Advance 3';
  // A REAL click on the console's chip (the cells above call element.click(); these press the mouse/touch at the chip).
  const chipSel = async (p, key) => `#consoles button:nth-child(${(await p.evaluate((k) => window.__mpCatalog.findIndex((x) => x.key === k), key)) + 1})`;
  const chipClick = async (p, key) => p.click(await chipSel(p, key));
  const setSelect = (p, id, value) => p.evaluate((i, v) => { const s = document.getElementById(i); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; }, id, value);
  const optionValues = (p, id) => p.evaluate((i) => [...document.getElementById(i).options].map((o) => o.value), id);
  const codeShown = (p) => until(async () => { const t = await p.evaluate(() => (document.getElementById('code').textContent || '').trim()); return CODE_RE.test(t) ? t : null; });
  const namedBy = (p, c) => p.evaluate((x) => (window.Netplay && Netplay.consoleOfCode) ? Netplay.consoleOfCode(x) : null, c);
  const waitNav = async (nav) => decoded((await until(async () => nav.url)) || '');
  const js = (v) => JSON.stringify(v);
  if (want('gba')) {
    const { p, nav } = await lobbyPage(false);
    await p.goto(ORIGIN + '/multiplayer.html?net=local');
    await chipClick(p, 'gba');
    const s1 = await seam(p);
    const opts = await optionValues(p, 'game');
    js(opts) === js([SBAM, KIRBY, SA3]) && s1.sys === 'gba'
      ? ok('gba-picker-lists-exactly-the-roomable-titles', opts.join(' | ')) : bad('gba-picker-lists-exactly-the-roomable-titles', `sys=${s1.sys} options=${js(opts)}`);
    const unroomable = ['Monster Rancher Advance 2', 'Pokemon SoulGold', 'PKMN Ultra Violet', 'Sim City 2000'].filter((t) => opts.includes(t));
    unroomable.length ? bad('gba-picker-hides-every-title-with-no-passing-row', `offered: ${unroomable.join(', ')}`)
                      : ok('gba-picker-hides-every-title-with-no-passing-row', 'Monster Rancher Advance 2, Pokemon SoulGold, PKMN Ultra Violet and Sim City 2000 are not listed');
    // the seat control follows the game: hidden for a two-seat title, 2/3/4 for Kirby
    const hiddenForSbam = !(await visible(p, '#seatsRow'));
    await setSelect(p, 'game', KIRBY);
    const shownForKirby = await visible(p, '#seatsRow');
    const seatOpts = await optionValues(p, 'seats');
    hiddenForSbam && shownForKirby && js(seatOpts) === js(['2', '3', '4']) && (await p.evaluate(() => document.getElementById('seats').value)) === '2'
      ? ok('gba-seat-control-follows-the-game', `Super Bust-A-Move: hidden; Kirby: ${seatOpts.join('/')} (default 2)`) : bad('gba-seat-control-follows-the-game', `hiddenForSbam=${hiddenForSbam} shownForKirby=${shownForKirby} options=${js(seatOpts)}`);
    await setSelect(p, 'seats', '3');
    await p.shot('gba_kirby_3p_desktop_1280x800.png');

    // HOST: Open a party -> a code that NAMES the GBA (lib/netplay.js CODE_TAGS gba:'B') -> Start hands off with host=1 and seats=3
    await p.click('#btnHost');
    const code = await codeShown(p);
    const named = await namedBy(p, code);
    CODE_RE.test(code || '') && code.charAt(0) === 'B' && named === 'gba'
      ? ok('gba-open-party-mints-a-code-that-names-the-gba', `"${code}" consoleOfCode=${named}`) : bad('gba-open-party-mints-a-code-that-names-the-gba', `code=${code} consoleOfCode=${named} (the registry says gba is 'B')`);
    const s2 = await seam(p);
    const inv = decoded(s2.invite || '');
    inv.path === '/multiplayer.html' && inv.q.np === code && inv.q.sys === 'gba' && inv.q.game === KIRBY && !('seats' in inv.q)
      ? ok('gba-invite-link-names-console-and-game', s2.invite) : bad('gba-invite-link-names-console-and-game', `${s2.invite} (wanted np=${code} sys=gba game=${KIRBY}, no seats: the joiner learns the size from the host)`);
    await p.pg.eval(`document.getElementById('hostPane').scrollIntoView({ block: 'center' })`);
    await p.shot('gba_host_pane_desktop_1280x800.png');
    nav.url = null;
    await p.click('#btnGo');
    const h3 = await waitNav(nav);
    h3.path === '/gba.html' && h3.q.np === code && h3.q.game === KIRBY && h3.q.host === '1' && h3.q.seats === '3' && h3.q.net === 'local' && !('join' in h3.q)
      ? ok('gba-start-navigates-as-host-with-seats', nav.url) : bad('gba-start-navigates-as-host-with-seats', `${nav.url} (wanted /gba.html np=${code} game=${KIRBY} host=1 seats=3 net=local, no join)`);
    // the host changes the room's size AFTER the code is out: the code and link stay, the next hand-off carries the new size
    await setSelect(p, 'seats', '4');
    nav.url = null; await p.click('#btnGo');
    const h4 = await waitNav(nav);
    const codeAfter = await p.evaluate(() => document.getElementById('code').textContent.trim());
    h4.q.seats === '4' && h4.q.np === code && codeAfter === code
      ? ok('gba-seat-change-after-minting-keeps-the-code', nav.url) : bad('gba-seat-change-after-minting-keeps-the-code', `${nav.url} code ${code} -> ${codeAfter}`);
    // a two-seat title: no choice offered, and seats=2 is still sent (gba.html defaults to its smallest count otherwise)
    await setSelect(p, 'game', SBAM);
    const hiddenAgain = !(await visible(p, '#seatsRow'));
    nav.url = null; await p.click('#btnGo');
    const h2 = await waitNav(nav);
    const inv2 = decoded((await seam(p)).invite || '');
    hiddenAgain && h2.q.game === SBAM && h2.q.seats === '2' && h2.q.host === '1' && inv2.q.game === SBAM && inv2.q.np === code
      ? ok('gba-two-seat-title-hands-off-with-seats-2', nav.url) : bad('gba-two-seat-title-hands-off-with-seats-2', `${nav.url} seatsRowHidden=${hiddenAgain} invite=${(await seam(p)).invite}`);
    await setSelect(p, 'game', SA3);
    nav.url = null; await p.click('#btnGo');
    const hs = await waitNav(nav);
    hs.q.game === SA3 && hs.q.seats === '2' && hs.q.host === '1' ? ok('gba-sonic-advance-3-hands-off-with-seats-2', nav.url) : bad('gba-sonic-advance-3-hands-off-with-seats-2', String(nav.url));

    // JOIN, a GBA code: it names its console ('B'), so the joiner is NOT asked which console; Join is enabled at once and hands off with join=1.
    await p.click('#btnJoinPane');
    await p.evaluate(() => { document.getElementById('codeIn').value = ''; });
    await p.type('#codeIn', code);
    const askedToPick = await visible(p, '#jPick');
    const joinEnabledBefore = await p.evaluate(() => !document.getElementById('btnJoin').disabled);
    const detectedText = await p.evaluate(() => document.getElementById('jDetected').textContent);
    !askedToPick && joinEnabledBefore && /Game Boy Advance room/.test(detectedText) && /Ready/.test(await p.evaluate(() => document.getElementById('joinSummary').textContent))
      ? ok('gba-joiner-is-not-asked-the-code-names-the-console', `#jPick hidden, Join enabled: "${detectedText}"`) : bad('gba-joiner-is-not-asked-the-code-names-the-console', `asked=${askedToPick} joinEnabled=${joinEnabledBefore} detected="${detectedText}"`);
    nav.url = null;
    await p.click('#btnJoin');
    const jn = await waitNav(nav);
    jn.path === '/gba.html' && jn.q.np === code && jn.q.join === '1' && !('host' in jn.q) && !('seats' in jn.q) && [SBAM, KIRBY, SA3].includes(jn.q.game) && jn.q.net === 'local'
      ? ok('gba-join-navigates-as-joiner', nav.url) : bad('gba-join-navigates-as-joiner', `${nav.url} (wanted /gba.html np=${code} join=1, a GBA game, no host, no seats)`);

    // A GBA code that pressed the GBA chip, replaced by a code that names no console: nothing may stay pressed (FV2's chip quirk; section `join` covers
    // the general sequence). This used to be printed as a NOTE because the lobby left the chip pressed.
    await p.evaluate(() => { document.getElementById('codeIn').value = ''; });
    await p.type('#codeIn', 'K7MQ2');
    const staleChips = await p.evaluate(() => [...document.querySelectorAll('#jConsoles button[aria-pressed="true"]')].map((b) => b.textContent));
    const staleJoin = await p.evaluate(() => !document.getElementById('btnJoin').disabled);
    !staleChips.length && !staleJoin ? ok('gba-code-then-an-untagged-one-leaves-no-console-pressed', 'nothing pressed, Join disabled') : bad('gba-code-then-an-untagged-one-leaves-no-console-pressed', `pressed chips=${js(staleChips)}, Join enabled=${staleJoin}`);
    await p.click('#btnJoinBack');

    // JOIN, an OLDER code (random first character, no tag), on a FRESH lobby page: the fallback is kept. The joiner is asked ONCE, Join stays
    // disabled until they answer, and nothing is pre-selected. 'K7MQ2' starts with K, which no console owns.
    {
      const { p: f, nav: fn } = await lobbyPage(false);
      await f.goto(ORIGIN + '/multiplayer.html?net=local');
      await f.click('#btnJoinPane'); await f.type('#codeIn', 'K7MQ2');
      const oldAsked = await visible(f, '#jPick');
      const oldEnabled = await f.evaluate(() => !document.getElementById('btnJoin').disabled);
      oldAsked && !oldEnabled && /older code that does not say its console/.test(await f.evaluate(() => document.getElementById('joinSummary').textContent))
        ? ok('gba-an-older-untagged-code-still-asks-which-console', '#jPick shown, Join disabled, "older code" summary') : bad('gba-an-older-untagged-code-still-asks-which-console', `asked=${oldAsked} joinEnabled=${oldEnabled}`);
      // THE JOINER HAS NO DEFAULT CONSOLE (multiplayer.html): nothing is pre-selected. The pointer is moved off the chips first, because
      // a chip under the last click's position shows its :hover colour, which reads as "selected" in a screenshot.
      await f.pg.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
      const preselected = await f.evaluate(() => [...document.querySelectorAll('#jConsoles button[aria-pressed="true"]')].map((b) => b.textContent));
      !preselected.length ? ok('gba-joiner-picker-preselects-no-console', 'no chip is aria-pressed') : bad('gba-joiner-picker-preselects-no-console', js(preselected));
      await f.shot('gba_join_pick_desktop_1280x800.png');
      fn.url = null; await f.pg.eval(`document.getElementById('btnJoin').click()`); await sleep(400);
      !fn.url ? ok('[control] a disabled Join does not navigate before the console is chosen', 'no navigation') : bad('[control] a disabled Join does not navigate before the console is chosen', String(fn.url));
      await f.evaluate(() => { [...document.querySelectorAll('#jConsoles button')].find((b) => /Game Boy/.test(b.textContent)).click(); });
      fn.url = null; await f.click('#btnJoin');
      const jo = await waitNav(fn);
      jo.path === '/gba.html' && jo.q.np === 'K7MQ2' && jo.q.join === '1' && !('host' in jo.q) ? ok('gba-an-older-code-joins-once-the-console-is-chosen', fn.url) : bad('gba-an-older-code-joins-once-the-console-is-chosen', String(fn.url));
      await f.close();
    }

    // The code follows the console (the registry names both, so Open a party can tell a code made for another console).
    // Back from the join pane the host pane is hidden: picking Dreamcast and pressing Open a party must NOT hand back the GBA code.
    await chipClick(p, 'dreamcast');
    await p.click('#btnHost');
    const dcCode = await codeShown(p);
    const dcInv = decoded(await p.evaluate(() => document.getElementById('invite').value));
    await chipClick(p, 'gba');
    const gbaCode2 = await p.evaluate(() => document.getElementById('code').textContent.trim());
    const gbaInv = decoded(await p.evaluate(() => document.getElementById('invite').value));
    const named2 = await namedBy(p, gbaCode2);
    dcCode !== code && (await namedBy(p, dcCode)) === 'dreamcast' && dcInv.q.sys === 'dreamcast' && gbaCode2 !== dcCode && named2 === 'gba' && gbaInv.q.sys === 'gba' && gbaInv.q.np === gbaCode2
      ? ok('gba-code-and-link-follow-a-console-change-both-ways', `${code} -> ${dcCode} (dreamcast) -> ${gbaCode2} (gba)`) : bad('gba-code-and-link-follow-a-console-change-both-ways', `${code} -> ${dcCode} (${dcInv.q.sys}) -> ${gbaCode2} (${gbaInv.q.sys}, names ${named2})`);
    await p.click('#btnHost'); await sleep(120);
    const again = await p.evaluate(() => document.getElementById('code').textContent.trim());
    again === gbaCode2 ? ok('gba-open-a-party-twice-keeps-the-code', `${again} survived a second press`) : bad('gba-open-a-party-twice-keeps-the-code', `${gbaCode2} -> ${again}`);
    await p.close();

    // A party opened for one console must not be handed to another through Open a party (the code's tag is what tells the lobby)
    {
      const { p: q } = await lobbyPage(false);
      await q.goto(ORIGIN + '/multiplayer.html?net=local');
      await chipClick(q, 'gba'); await q.click('#btnHost');
      const g1 = await codeShown(q);
      await q.click('#btnJoinPane'); await q.click('#btnJoinBack');      // the join pane hides the host pane without re-minting
      await chipClick(q, 'dreamcast'); await q.click('#btnHost');
      const d1 = await codeShown(q);
      const dInv = decoded(await q.evaluate(() => document.getElementById('invite').value));
      d1 !== g1 && (await namedBy(q, d1)) === 'dreamcast' && dInv.q.sys === 'dreamcast' && dInv.q.np === d1
        ? ok('gba-party-is-not-reused-for-another-console', `${g1} (gba) then Dreamcast -> ${d1} (names dreamcast)`) : bad('gba-party-is-not-reused-for-another-console', `${g1} -> ${d1} (names ${await namedBy(q, d1)}), invite sys=${dInv.q.sys}`);
      await q.close();
    }

    // EVERY GBA CODE THE LOBBY MINTS NAMES THE GBA. Driven through the UI (chip toggling re-mints at the console change; fresh page loads mint at
    // Open a party), then the engine's own makeCode over 300 draws.
    {
      const { p: q } = await lobbyPage(false);
      await q.goto(ORIGIN + '/multiplayer.html?net=local');
      await chipClick(q, 'gba'); await q.click('#btnHost');
      const seen = new Set(); let wrong = 0, first = null;
      const note = (c, n) => { seen.add(c); if (n !== 'gba' || c.charAt(0) !== 'B') { wrong++; if (!first) first = `${c} names ${n}`; } };
      note(await codeShown(q), await namedBy(q, await codeShown(q)));
      for (let i = 0; i < 100; i++) {
        await chipClick(q, 'dreamcast'); await chipClick(q, 'gba');
        const c = await q.evaluate(() => document.getElementById('code').textContent.trim());
        note(c, await namedBy(q, c));
      }
      for (let i = 0; i < 25; i++) {
        await q.goto(ORIGIN + '/multiplayer.html?net=local');
        await chipClick(q, 'gba'); await q.click('#btnHost');
        const c = await codeShown(q);
        note(c, await namedBy(q, c));
      }
      !wrong && seen.size > 100 ? ok('gba-126-codes-minted-through-the-ui-all-start-B-and-name-the-gba', `${seen.size} distinct codes, 0 untagged or misread`) : bad('gba-126-codes-minted-through-the-ui-all-start-B-and-name-the-gba', `${wrong} not B/gba, first: ${first}, distinct ${seen.size}`);
      const draws = await q.evaluate(() => {
        const out = { gba: 0, arena: 0, dc: 0, readBack: Netplay.consoleOfCode('B2345') + '/' + Netplay.consoleOfCode('A2345') };
        for (let i = 0; i < 300; i++) {
          const g = Netplay.makeCode(5, 'gba'); if (g.charAt(0) !== 'B' || Netplay.consoleOfCode(g) !== 'gba') out.gba++;
          const a = Netplay.makeCode(5, 'pokemonarena'); if (a.charAt(0) !== 'A' || Netplay.consoleOfCode(a) !== 'pokemonarena') out.arena++;
          if (Netplay.makeCode(5, 'dreamcast').charAt(0) !== 'D') out.dc++;
        }
        return out;
      });
      draws.gba === 0 && draws.arena === 0 && draws.dc === 0 && draws.readBack === 'gba/pokemonarena'
        ? ok('gba-engine-300-draws-gba-B-arena-A-dreamcast-D', `0 of 300 off in each; consoleOfCode('B2345')/('A2345') = ${draws.readBack}`) : bad('gba-engine-300-draws-gba-B-arena-A-dreamcast-D', js(draws));
      await q.close();
    }

    // Unroomable titles named by an invite fall back to the joiner's own pane; the single-player note names Sim City 2000
    for (const title of ['Monster Rancher Advance 2', 'Pokemon SoulGold', 'PKMN Ultra Violet', 'Sim City 2000']) {
      const { p: q } = await lobbyPage(false);
      await q.goto(ORIGIN + '/multiplayer.html?np=K7MQ2&sys=gba&game=' + encodeURIComponent(title) + '&net=local');
      const st = await q.evaluate(() => ({ join: document.getElementById('joinPane').checkVisibility(), warn: document.getElementById('joinWarn').textContent, code: document.getElementById('codeIn').value, invited: window.__mp().invited }));
      st.join && st.code === 'K7MQ2' && /does not offer/.test(st.warn) && st.invited === null
        ? ok(`gba-invite-to-${title.replace(/\W+/g, '-').toLowerCase()}-falls-back`, 'join pane, code kept, told it is not offered') : bad(`gba-invite-to-${title.replace(/\W+/g, '-').toLowerCase()}-falls-back`, js(st));
      await q.close();
    }
    {
      const { p: q } = await lobbyPage(false);
      await q.goto(ORIGIN + '/multiplayer.html?sys=gba&game=' + encodeURIComponent('Sim City 2000') + '&net=local');
      const note = await q.evaluate(() => document.getElementById('sysNote').textContent);
      /Sim City 2000 is single-player/.test(note) ? ok('gba-sim-city-2000-is-named-single-player', note) : bad('gba-sim-city-2000-is-named-single-player', note);
      await q.close();
    }

    // The old redirect still carries a lobby hand-off (GR2 finished it; the lobby no longer uses it, but links in the wild do)
    {
      const { p: q, nav: qn } = await lobbyPage(false, /\/(?:gba_)?multiplayer\.html(?:\?|$)/);
      const cases = [
        ['carries a full host hand-off', '?np=K7MQ2&game=' + encodeURIComponent(KIRBY) + '&host=1&seats=3&net=local', (u) => u.path === '/gba.html' && u.q.np === 'K7MQ2' && u.q.game === KIRBY && u.q.host === '1' && u.q.seats === '3' && u.q.net === 'local'],
        ['carries a join hand-off', '?np=K7MQ2&game=' + encodeURIComponent(SA3) + '&join=1', (u) => u.path === '/gba.html' && u.q.np === 'K7MQ2' && u.q.join === '1' && !('host' in u.q)],
        ['drops a malformed code', '?np=AB01I&host=1', (u) => u.path === '/gba.html' && Object.keys(u.q).length === 0],
        ['with no code is a plain visit', '', (u) => u.path === '/gba.html' && Object.keys(u.q).length === 0],
      ];
      for (const [name, qs, judge] of cases) {
        qn.url = null;
        await q.goto(ORIGIN + '/gba_multiplayer.html' + qs);
        const u = decoded((await until(async () => qn.url)) || '');
        judge(u) ? ok(`gba_multiplayer.html-${name.replace(/\W+/g, '-')}`, qn.url) : bad(`gba_multiplayer.html-${name.replace(/\W+/g, '-')}`, String(qn.url));
      }
      await q.close();
    }

    // PHONE: the picker with the seat control, and an invite opened cold
    {
      const { p: m, nav: mn } = await lobbyPage(true);
      await m.goto(ORIGIN + '/multiplayer.html?net=local');
      await m.tap(await chipSel(m, 'gba'));
      await setSelect(m, 'game', KIRBY); await setSelect(m, 'seats', '4');
      const lay = await m.evaluate(() => { const r = document.getElementById('seatsRow').getBoundingClientRect(), s = document.getElementById('seats').getBoundingClientRect(); return { rowVisible: document.getElementById('seatsRow').checkVisibility(), right: Math.round(s.right), vw: innerWidth, scrollW: document.documentElement.scrollWidth, h: Math.round(s.height) }; });
      lay.rowVisible && lay.right <= lay.vw && lay.scrollW <= lay.vw
        ? ok('gba-phone-seat-control-fits-390px', js(lay)) : bad('gba-phone-seat-control-fits-390px', js(lay));
      await m.shot('gba_kirby_4p_phone_390x844.png');
      await m.tap('#btnHost');
      const mc = await codeShown(m);
      mn.url = null; await m.tap('#btnGo');
      const mh = await waitNav(mn);
      mh.path === '/gba.html' && mh.q.np === mc && mh.q.game === KIRBY && mh.q.host === '1' && mh.q.seats === '4'
        ? ok('gba-phone-tap-start-navigates-as-host-with-seats-4', mn.url) : bad('gba-phone-tap-start-navigates-as-host-with-seats-4', String(mn.url));
      await m.goto(ORIGIN + '/multiplayer.html?np=K7MQ2&sys=gba&game=' + encodeURIComponent(KIRBY) + '&net=local');
      const si = await seam(m);
      const txt = await m.evaluate(() => document.getElementById('invitedText').textContent);
      si.invited && si.invited.sys === 'gba' && si.invited.game === KIRBY && /Kirby Nightmare in Dreamland on the Game Boy Advance/.test(txt) && (await visible(m, '#btnInvitedJoin')) && !(await visible(m, '#pick'))
        ? ok('gba-invite-cold-on-a-phone-shows-one-join-button', txt) : bad('gba-invite-cold-on-a-phone-shows-one-join-button', `${js(si.invited)} ${txt}`);
      await m.shot('gba_invite_phone_390x844.png');
      mn.url = null; await m.tap('#btnInvitedJoin');
      const mj = await waitNav(mn);
      mj.path === '/gba.html' && mj.q.np === 'K7MQ2' && mj.q.game === KIRBY && mj.q.join === '1' && !('host' in mj.q) && !('seats' in mj.q)
        ? ok('gba-invite-join-navigates', mn.url) : bad('gba-invite-join-navigates', String(mn.url));
      await m.close();
    }
  }

  // ---------------------------------------------------------------------------
  // 2c. THE JOIN PANE: WHAT IS PRESSED IS WHAT JOIN WILL USE. FV2 reproduced a quirk: type a code that names no console, press Nintendo 64,
  //     then EDIT the code to another that names none -> the chips came back with Nintendo 64 still pressed and Join disabled, until the
  //     pressed chip was clicked again. The invariant below is checked after every step of a long sequence that mixes untagged, tagged and
  //     hand-picked codes; the mutant `join-stale-chip` removes the fix and must trip it.
  // ---------------------------------------------------------------------------
  if (want('join')) {
    console.log('\n== join pane: the pressed console is always the one Join will use ==');
    const { p, nav } = await lobbyPage(false);
    await p.goto(ORIGIN + '/multiplayer.html?net=local');
    await p.click('#btnJoinPane');
    const jstate = () => p.evaluate(() => ({
      code: document.getElementById('codeIn').value,
      pressed: [...document.querySelectorAll('#jConsoles button[aria-pressed="true"]')].map((b) => b.textContent),
      pickShown: document.getElementById('jPick').checkVisibility(), joinEnabled: !document.getElementById('btnJoin').disabled,
      detected: document.getElementById('jDetected').checkVisibility() ? document.getElementById('jDetected').textContent : '',
      summary: document.getElementById('joinSummary').textContent,
    }));
    const violations = [];
    // The invariant: Join enabled <=> exactly one chip pressed and the picker closed; the picker open (asking) <=> nothing pressed.
    const check = (label, st) => {
      if (st.joinEnabled && st.pressed.length !== 1) violations.push(`${label}: Join enabled with ${st.pressed.length} chip(s) pressed ${js(st.pressed)}`);
      if (st.pickShown && st.pressed.length) violations.push(`${label}: the picker is asking but ${js(st.pressed)} is pressed`);
      if (!st.pickShown && !st.joinEnabled && /^[A-HJ-NP-Z2-9]{5}$/.test(st.code) && !st.detected) violations.push(`${label}: a full code, no question and no Join`);
    };
    // "replace the code" = select all + type (ONE input event carrying the whole new code, as a paste or an overtype does)
    const replaceWith = async (v) => { await p.evaluate(() => { document.getElementById('codeIn').value = ''; }); await p.type('#codeIn', v); };
    // "edit the code" = delete the last character (an input event with a 4-character code), then type another
    const editLast = async (ch) => { await p.evaluate(() => { const e = document.getElementById('codeIn'); e.value = e.value.slice(0, -1); e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.type('#codeIn', ch); };
    const pressChip = async (name) => {
      const i = await p.evaluate((t) => [...document.querySelectorAll('#jConsoles button')].findIndex((b) => b.textContent === t), name);
      await p.click(`#jConsoles button:nth-child(${i + 1})`);
    };
    const step = async (label, expect) => { const st = await jstate(); check(label, st); const bad1 = expect(st); bad1 ? bad(label, `${bad1} — ${js(st)}`) : ok(label, js({ code: st.code, pressed: st.pressed, pickShown: st.pickShown, joinEnabled: st.joinEnabled })); return st; };
    const none = (st) => (st.pressed.length ? `${js(st.pressed)} is pressed` : !st.pickShown ? 'the picker is not asking' : st.joinEnabled ? 'Join is enabled' : !/older code/.test(st.summary) ? `summary "${st.summary}"` : null);
    const one = (name, room) => (st) => (st.pressed.length !== 1 || st.pressed[0] !== name ? `pressed ${js(st.pressed)}, wanted [${name}]` : st.pickShown ? 'the picker is still open' : !st.joinEnabled ? 'Join is disabled' : !new RegExp(`${name} room ${room}`).test(st.detected) ? `detected "${st.detected}"` : null);

    await p.type('#codeIn', 'K7M2Q');
    await step('join-1-a-code-that-names-no-console-asks-and-presses-nothing', none);
    await pressChip('Nintendo 64');
    await step('join-2-pressing-Nintendo-64-presses-it-and-enables-Join', one('Nintendo 64', 'K7M2Q'));
    await replaceWith('H7M2Q');                                             // FV2's exact step
    await step('join-3-replacing-it-with-another-untagged-code-UNPRESSES-the-chip', none);
    nav.url = null; await p.click('#btnJoin'); await sleep(300);
    !nav.url ? ok('[control] join-3b-a-real-click-on-the-disabled-Join-navigates-nowhere', 'no navigation') : bad('[control] join-3b-a-real-click-on-the-disabled-Join-navigates-nowhere', String(nav.url));
    await pressChip('Nintendo 64');
    await step('join-4-pressing-it-again-enables-Join', one('Nintendo 64', 'H7M2Q'));
    nav.url = null; await p.click('#btnJoin');
    const j4 = await waitNav(nav);
    j4.path === '/n64/' && j4.q.np === 'H7M2Q' && j4.q.join === '1' && !('host' in j4.q) ? ok('join-4b-Join-hands-off-to-the-pressed-console', nav.url) : bad('join-4b-Join-hands-off-to-the-pressed-console', String(nav.url));
    await editLast('R');                                                    // delete a character, type another: H7M2Q -> H7M2R
    await step('join-5-editing-one-character-of-a-picked-code-asks-again', none);
    await pressChip('Nintendo 64');
    await replaceWith('B7M2Q');                                             // a GBA-tagged code over a pressed chip
    await step('join-6-a-tagged-code-replaces-the-pick-with-the-console-it-names', one('Game Boy Advance', 'B7M2Q'));
    await replaceWith('K7M2Q');                                             // tagged -> untagged (the case printed as a NOTE before)
    await step('join-7-a-tagged-code-then-an-untagged-one-leaves-nothing-pressed', none);
    await replaceWith('D7M2Q');
    await step('join-8-a-Dreamcast-tagged-code-presses-Dreamcast', one('Dreamcast', 'D7M2Q'));
    await replaceWith('N7M2Q');
    await step('join-9-then-an-N64-tagged-code-presses-only-Nintendo-64', one('Nintendo 64', 'N7M2Q'));
    await editLast('R');
    await step('join-10-editing-a-tagged-code-to-another-of-the-same-console-keeps-it', one('Nintendo 64', 'N7M2R'));
    violations.length ? bad('join-pane-invariant-holds-at-every-step', violations.join(' | ')) : ok('join-pane-invariant-holds-at-every-step', 'Join enabled <=> exactly one chip pressed and the picker closed; picker asking <=> nothing pressed; 12 states checked');
    await p.shot('join_pane_after_sequence_1280x800.png');
    await p.close();
  }

  // ---------------------------------------------------------------------------
  // 2d. END TO END, NO INTERCEPTION: the lobby hands two windows to the REAL gba.html, which forms the room.
  //     Skipped, visibly, where the ROM or the core is not served (a CI box without /gamedata).
  // ---------------------------------------------------------------------------
  if (want('e2e')) {
    console.log('\n== Game Boy Advance: lobby -> the real gba.html -> a running room (two windows, ?net=local) ==');
    const served = async (u) => { try { return (await fetch(ORIGIN + u, { method: 'HEAD' })).ok; } catch (e) { return false; } };
    const needs = ['/gba/mgba/dist/mgba_core.wasm', '/gamedata/gba/gbaWasm/roms/' + encodeURIComponent('Super Bust-A-Move (U).gba'), '/gamedata/gba/gbaWasm/roms/' + encodeURIComponent('Kirby - Nightmare in Dream Land (U).gba')];
    const missing = []; for (const u of needs) if (!(await served(u))) missing.push(u);
    if (missing.length) console.log(`  SKIP  gba-lobby-to-room-end-to-end — not served here: ${missing.join(', ')}`);
    else {
      const A = (await lobbyPage(false, undefined, { intercept: false })).p, B = (await lobbyPage(false, undefined, { intercept: false })).p;
      // host: lobby -> real clicks -> real navigation
      await A.goto(ORIGIN + '/multiplayer.html?net=local');
      await chipClick(A, 'gba'); await A.click('#btnHost');
      const code = await codeShown(A);
      await A.click('#btnGo');
      const hosted = await A.pg.waitFor(`!!(window.__gbaNet && __gbaNet().session && __gbaNet().party.code === ${js(code)})`, { timeoutMs: 60000, pollMs: 250 }).then(() => true).catch(() => false);
      const ha = hosted ? await A.evaluate(() => { const g = __gbaNet(); return { role: g.role, title: g.title, seatsWant: g.party.seatsWant, handoff: g.handoff }; }) : null;
      ha && ha.role === 'host' && ha.title === SBAM && ha.seatsWant === 2 && ha.handoff && ha.handoff.host === true && ha.handoff.code === code
        ? ok('e2e-host-lands-in-gba.html-as-host-under-the-lobbys-code', js(ha)) : bad('e2e-host-lands-in-gba.html-as-host-under-the-lobbys-code', js(ha));
      // the real gba.html's own makeCode (no console key: it reads location.pathname) is tagged 'B' too
      const ownCodes = await A.evaluate(() => Array.from({ length: 20 }, () => Netplay.makeCode(5)));
      ownCodes.every((c) => c.charAt(0) === 'B') && code.charAt(0) === 'B'
        ? ok('e2e-gba.html-own-makeCode-and-the-lobbys-code-are-tagged-B', `${ownCodes.slice(0, 3).join(',')}… (20 of 20 start B); lobby code ${code}`) : bad('e2e-gba.html-own-makeCode-and-the-lobbys-code-are-tagged-B', `${ownCodes.join(',')} lobby code ${code}`);
      // joiner: lobby (code only) -> NOT asked which console (the code names it) -> real navigation
      await B.goto(ORIGIN + '/multiplayer.html?net=local');
      await B.click('#btnJoinPane'); await B.type('#codeIn', code);
      const bAsked = await visible(B, '#jPick'), bEnabled = await B.evaluate(() => !document.getElementById('btnJoin').disabled);
      !bAsked && bEnabled ? ok('e2e-joiner-is-not-asked-which-console', 'the code names the GBA: Join is enabled at once') : bad('e2e-joiner-is-not-asked-which-console', `asked=${bAsked} joinEnabled=${bEnabled}`);
      await B.click('#btnJoin');
      const joined = await B.pg.waitFor(`!!(window.__gbaNet && __gbaNet().session && __gbaNet().role === 'guest' && __gbaNet().party.code === ${js(code)})`, { timeoutMs: 60000, pollMs: 250 }).then(() => true).catch(() => false);
      joined ? ok('e2e-joiner-lands-in-gba.html-as-guest-under-the-same-code', code) : bad('e2e-joiner-lands-in-gba.html-as-guest-under-the-same-code', 'no guest session');
      // the host's own Allow prompt (knowing the code is not enough), then the room loads and starts by itself
      const asked = await A.pg.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 60000, pollMs: 200 }).then(() => true).catch(() => false);
      if (asked) await A.pg.eval(`document.getElementById('npApproveAllow').click(); true`);
      asked ? ok('e2e-host-is-asked-to-allow-the-joiner', 'npApproveAllow clicked') : bad('e2e-host-is-asked-to-allow-the-joiner', 'no prompt');
      const running = await Promise.all([A, B].map((w) => w.pg.waitFor(`window.__gbaNet().running && window.__gbaNet().roomFrames >= 240`, { timeoutMs: 150000, pollMs: 300 }).then(() => true).catch(() => false)));
      running[0] && running[1] ? ok('e2e-both-windows-run-the-room', 'running, >= 240 room frames on both') : bad('e2e-both-windows-run-the-room', `running=${js(running)}`);
      if (running[0] && running[1]) {
        const st = await Promise.all([A, B].map((w) => w.evaluate(() => { const g = __gbaNet(); return { state: g.state, error: g.error, frames: g.roomFrames, title: g.config && g.config.game, seats: g.config && g.config.seats, roomLocked: g.roomLocked, chain: g.chain.slice(-60) }; })));
        const mA = new Map(st[0].chain.map((r) => [r[0], r.slice(1).join(',')])), common = st[1].chain.filter((r) => mA.has(r[0]));
        const same = common.length > 0 && common.every((r) => mA.get(r[0]) === r.slice(1).join(','));
        st.every((x) => x.state !== 'desync' && !x.error && x.title === SBAM && x.seats === 2 && x.roomLocked) && same
          ? ok('e2e-room-runs-equal-fingerprints-on-both-windows', `${common.length} common fingerprint(s) equal, state ${st.map((x) => x.state).join('/')}, frames ${st.map((x) => x.frames).join('/')}`) : bad('e2e-room-runs-equal-fingerprints-on-both-windows', js(st.map((x) => ({ ...x, chain: x.chain.length }))));
        await A.shot('e2e_host_room_running.png'); await B.shot('e2e_guest_room_running.png');
      }
      // Kirby at three seats: only the HOST side (nobody joins), to prove &seats=3 lands in the page's own room config
      await A.goto(ORIGIN + '/multiplayer.html?net=local');
      await chipClick(A, 'gba'); await setSelect(A, 'game', KIRBY); await setSelect(A, 'seats', '3'); await A.click('#btnHost');
      const kcode = await codeShown(A);
      await A.click('#btnGo');
      const k = await A.pg.waitFor(`!!(window.__gbaNet && __gbaNet().session && __gbaNet().party.code === ${js(kcode)} && __gbaNet().config)`, { timeoutMs: 60000, pollMs: 250 }).then(() => A.evaluate(() => { const g = __gbaNet(); return { title: g.title, seatsWant: g.party.seatsWant, cfgSeats: g.config.seats, cfgGame: g.config.game, handoff: g.handoff }; })).catch(() => null);
      k && k.title === KIRBY && k.seatsWant === 3 && k.cfgSeats === 3 && k.cfgGame === KIRBY && k.handoff && k.handoff.seats === 3
        ? ok('e2e-kirby-3-seats-reaches-the-rooms-own-config', js(k)) : bad('e2e-kirby-3-seats-reaches-the-rooms-own-config', js(k));
      await A.shot('e2e_kirby_3p_host_waiting.png');
      await A.close(); await B.close();
    }
  }

  // ---------------------------------------------------------------------------
  // 3. NO WEBRTC: nothing pressable is rendered, and the visitor is told.
  // ---------------------------------------------------------------------------
  console.log('\n== unsupported browser ==');
  if (want('unsupported')) {
    const { p } = await lobbyPage(false);
    await p.pg.send('Page.addScriptToEvaluateOnNewDocument', { source: 'try { delete window.RTCPeerConnection; window.RTCPeerConnection = undefined; } catch (e) {}' });
    await p.goto(ORIGIN + '/multiplayer.html');
    const st = await p.evaluate(() => ({ un: document.getElementById('unsupported').checkVisibility(), pick: document.getElementById('pick').checkVisibility(), seam: window.__mp() }));
    st.un && !st.pick && st.seam && st.seam.supported === false
      ? ok('unsupported-renders-no-controls', `missing: ${st.seam.missing}`) : bad('unsupported-renders-no-controls', JSON.stringify(st));
    await p.close();
  }
});

console.log(`\n[multiplayer-page-browser] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

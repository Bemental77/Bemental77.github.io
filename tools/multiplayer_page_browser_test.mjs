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
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web                                 # port 8080 — the only server (gate #2)
//   node tools/multiplayer_page_browser_test.mjs
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  PASS  ${n} — ${d}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n} — ${d}`); };
console.log('  ....  uptime ' + (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return '?'; } })());

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import('./browser_leak_guard.js')).default.guard(browser, fileURLToPath(import.meta.url)); } catch (e) {}

// A page whose navigations AWAY from the lobby are caught and answered 204. The
// caught URL is returned to the test; the lobby document stays where it is.
async function lobbyPage(mobile) {
  const p = await browser.newPage();
  if (mobile) {
    await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  }
  const nav = { url: null };
  await p.setRequestInterception(true);
  p.on('request', (r) => {
    const u = r.url();
    if (r.isNavigationRequest() && r.frame() === p.mainFrame() && !/\/multiplayer\.html/.test(u)) {
      nav.url = u; return r.respond({ status: 204 });
    }
    r.continue();
  });
  return { p, nav };
}
const visible = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && e.checkVisibility() && e.getBoundingClientRect().height > 0; }, sel);
const seam = (p) => p.evaluate(() => window.__mp());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ⚠ POLL FROM NODE — page.waitForFunction polls on rAF and stalls in a
// background tab (tools/netplay_test.mjs records that false negative).
async function until(fn, ms = 5000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } }
const decoded = (u) => { try { const x = new URL(u); return { path: x.pathname, q: Object.fromEntries(x.searchParams) }; } catch (e) { return { path: null, q: {} }; } };

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
};
{
  const { p, nav } = await lobbyPage(false);
  await p.goto(ORIGIN + '/multiplayer.html?net=local', { waitUntil: 'domcontentloaded' });
  const s0 = await seam(p);
  s0 && s0.supported ? ok('page-renders-supported', `default console ${s0.sys}, game "${s0.game}"`) : bad('page-renders-supported', JSON.stringify(s0));
  for (const sel of ['#consoles button[aria-pressed]', '#game', '#btnHost', '#btnJoinPane', '#wrap > .hint > a[href="/playground.html"]']) {
    (await visible(p, sel)) ? ok(`chrome-visible ${sel}`, 'in the layout, non-zero height') : bad(`chrome-visible ${sel}`, 'not visible');
  }
  const gbaDisabled = await p.evaluate(() => [...document.querySelectorAll('#consoles button')].find((b) => /Game Boy/.test(b.textContent))?.disabled);
  gbaDisabled === true ? ok('gba-chip-is-disabled', 'listed, not pressable — the visitor is told rather than left to wonder') : bad('gba-chip-is-disabled', String(gbaDisabled));

  for (const [key, ex] of Object.entries(EXPECT)) {
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
    const joinOk = j.path === ex.path && j.q.np === shown && j.q.game === game && j.q.join === '1' && !('host' in j.q);
    joinOk ? ok(`${key}-join-navigates-as-joiner`, joinNav) : bad(`${key}-join-navigates-as-joiner`, `${joinNav} (wanted ${ex.path} np=${shown} game="${game}" join=1)`);
  }
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
    (iv.q.np === code && iv.q.sys === 'genesis' && iv.q.game === gameNow && after.sys === 'genesis')
      ? ok('invite-follows-a-console-change', shownInvite)
      : bad('invite-follows-a-console-change',
            `#invite=${shownInvite} — but the page now shows sys=${after.sys} game="${gameNow}" code=${code}`);
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
    const chip = (k) => p2.evaluate((key) => {
      const c = window.__mpCatalog.find((x) => x.key === key);
      [...document.querySelectorAll('#consoles button')].find((b) => b.firstChild.textContent === c.name).click();
    }, k);
    const { p: p2 } = await lobbyPage(false);
    await p2.goto(ORIGIN + '/multiplayer.html?net=local', { waitUntil: 'domcontentloaded' });
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
    await p3.goto(ORIGIN + '/multiplayer.html?net=local', { waitUntil: 'domcontentloaded' });
    await p3.evaluate(() => {
      const c = window.__mpCatalog.find((x) => x.key === 'dreamcast');
      [...document.querySelectorAll('#consoles button')].find((b) => b.firstChild.textContent === c.name).click();
    });
    await p3.click('#btnJoinPane');
    const link = ORIGIN + '/multiplayer.html?np=K7MQ2&sys=genesis&game=' + encodeURIComponent('X-Men') + '&net=local';
    await p3.evaluate((v) => { document.getElementById('codeIn').value = v; }, link);
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
{
  const { p, nav } = await lobbyPage(true);
  await p.goto(ORIGIN + '/multiplayer.html?np=K7MQ2&sys=n64&game=' + encodeURIComponent('Mario Kart 64') + '&net=local', { waitUntil: 'domcontentloaded' });
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
  // "not the game they meant" reveals the pickers with the code kept
  await p.tap('#btnInvitedPick');
  const kept = await p.evaluate(() => ({ pick: document.getElementById('pick').checkVisibility(), code: document.getElementById('codeIn').value }));
  kept.pick && kept.code === 'K7MQ2' ? ok('invite-fallback-keeps-the-code', JSON.stringify(kept)) : bad('invite-fallback-keeps-the-code', JSON.stringify(kept));
  await p.close();
}
// An invite naming a game the site does not offer: join pane, code kept, told why.
{
  const { p } = await lobbyPage(false);
  await p.goto(ORIGIN + '/multiplayer.html?np=K7MQ2&sys=gba&game=Anything', { waitUntil: 'domcontentloaded' });
  const st = await p.evaluate(() => ({ join: document.getElementById('joinPane').checkVisibility(), warn: document.getElementById('joinWarn').textContent, code: document.getElementById('codeIn').value, invited: window.__mp().invited }));
  st.join && st.code === 'K7MQ2' && /does not offer/.test(st.warn) && st.invited === null
    ? ok('invite-to-unavailable-game-falls-back', st.warn) : bad('invite-to-unavailable-game-falls-back', JSON.stringify(st));
  await p.close();
}

// ---------------------------------------------------------------------------
// 3. NO WEBRTC: nothing pressable is rendered, and the visitor is told.
// ---------------------------------------------------------------------------
console.log('\n== unsupported browser ==');
{
  const p = await browser.newPage();
  await p.evaluateOnNewDocument(() => { try { delete window.RTCPeerConnection; window.RTCPeerConnection = undefined; } catch (e) {} });
  await p.goto(ORIGIN + '/multiplayer.html', { waitUntil: 'domcontentloaded' });
  const st = await p.evaluate(() => ({ un: document.getElementById('unsupported').checkVisibility(), pick: document.getElementById('pick').checkVisibility(), seam: window.__mp() }));
  st.un && !st.pick && st.seam && st.seam.supported === false
    ? ok('unsupported-renders-no-controls', `missing: ${st.seam.missing}`) : bad('unsupported-renders-no-controls', JSON.stringify(st));
  await p.close();
}

await browser.close();
console.log(`\n[multiplayer-page-browser] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

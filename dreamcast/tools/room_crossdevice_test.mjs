#!/usr/bin/env node
// ============================================================================
// room_crossdevice_test.mjs — TWO BROWSERS, DRIVEN THE WAY A PERSON DRIVES THEM
// ============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// On 2026-09-08 a real pairing deadlocked on production while every netplay
// harness in this repo was green. The two devices reported, in their own words:
//
//     PC   (opened the room):  "you are Player 1 (maple port 0)"
//                              roster: P1 you · P2 open · P3 open · P4 open
//     PHONE(joined):           "you are Player 2 (maple port 1)"
//                              roster: P1 80710319f8eea143 · P2 you · P3 open …
//     BOTH:                    "waiting for players" · "frame 0 · core ran 0"
//
// A ONE-WAY ROSTER: the joiner sees the host, the host never sees the joiner,
// and nothing ever starts.
//
// The reason no test caught it is the shape of the tests, not their coverage.
// dreamcast/tools/netplay_room_e2e.mjs APPROVES THE JOINER FROM INSIDE THE
// TEST — it clicks the engine's own prompt if one happens to be there and
// otherwise reaches past the page — and tools/netplay_room_test.mjs drives the
// Netplay engine directly with no page at all. Both step straight over any
// human action the product fails to offer. A rig that supplies the missing
// human action can never discover that the human action is missing.
//
// SO THIS RIG'S ONE RULE: IT ONLY DOES WHAT A PERSON CAN DO.
//   * It CLICKS, with a real mouse at real coordinates, and it checks
//     document.elementFromPoint first — a control covered by something else is
//     reported as unreachable rather than clicked through.
//   * It TYPES with the keyboard.
//   * It SELECTS from the page's own <select> elements.
//   * It NEVER calls the session's approve / deny / seat / setReady / start /
//     close, or any other engine method, and never reaches for the page's
//     Netplay object at all. A self-audit at startup greps this file for those
//     patterns and REFUSES TO RUN if one appears (see FORBIDDEN below), so the
//     cheat cannot come back by accident. It fired on this very comment in the
//     first draft, which is how it earned its keep before the first run.
//   * It READS state through the page's read-only test seams (__dcProbe,
//     __dcNet, __dcNetHud, __dcNetRoom, __dcPad) and, for everything the user
//     photographed, out of the DOM itself — the roster is asserted on the text
//     in #netRoster, because that is what the user was looking at.
//
// If a pairing needs a human action that NO CONTROL PROVIDES, this rig FAILS
// and names it, with an inventory of every visible control that did exist.
//
// ⚠⚠ THE HONEST LIMIT — READ THIS BEFORE QUOTING A GREEN RUN ⚠⚠
// Two browsers on ONE box share a NAT, a network stack, and a loopback-fast
// path between them. This rig closes the "real UI" gap. It does NOT close the
// "two real networks" gap, and nothing in this repo ever has:
//   * every peer here is behind the same router, so ICE succeeds host-to-host
//     or via a server-reflexive candidate that a symmetric NAT would break;
//   * there is no working TURN relay. Measured (tools/audit_peerjs_crossdevice
//     .mjs and the relay audit): every public relay tried returns 701/400 and
//     peerjs's own two do not resolve. With no relay, symmetric-NAT peers
//     CANNOT CONNECT AT ALL, and this rig cannot tell you that they can't.
// A PASS here means "two people on one network, clicking only real controls,
// can pair and play". It does not mean two phones on two carriers can.
//
// WHAT IT ASSERTS (the things the user's screenshots disproved)
//   1. both sides' rosters agree on who is in the room;
//   2. THE HOST'S ROSTER SHOWS THE JOINER (the exact one-way failure above is
//      a NAMED cell, ROSTER-IS-ONE-WAY, never a timeout);
//   3. each side is told a DIFFERENT maple port;
//   4. the start barrier releases on both sides;
//   5. `core ran` advances past 0 on both, sampled twice so a frozen counter
//      cannot pass;
//   6. each side's own pad reaches its OWN core, and (as a separate cell) the
//      other side's core too.
//
// ARMS — the third and fourth reproduce page states the passing rigs never had
//   panel-open    baseline: the host leaves the lobby panel open and waits.
//   panel-closed  THE USER'S PC. The host opens the room, then CLOSES the
//                 lobby panel (a real button, #netClose) before anyone joins.
//                 Any prompt that only exists inside an open panel strands
//                 every joiner from here on.
//   host-busy     the joiner arrives while the host is in a DIFFERENT PAGE
//                 STATE: lobby closed and the emulator already started, i.e.
//                 mid disc-download. The rig does not wait for that download.
//   mobile-joiner the joiner is a phone (iPhone viewport, touch, iOS UA), so
//                 it drives the mobile splash controls rather than the desktop
//                 toolbar — which is the pair the user actually had.
//   host-ignores  THE HOST NEVER ANSWERS THE PROMPT. A person walks away, or
//                 does not notice a dialog on a second monitor, or the phone
//                 knocked while they were reading the code out loud. Nothing
//                 in the product forces an answer, so this is an ordinary
//                 state, and the question it asks is the one the user's two
//                 screenshots pose: WHAT DOES EACH SIDE CLAIM while nobody has
//                 been let in? A joiner that paints itself a seat, a port and
//                 a roster it was never granted is the deadlock — both people
//                 then sit in what looks like a room, waiting for each other.
//   late-joiner   the room sits open and untouched for --latems (default 90 s)
//                 before anyone knocks — the time it takes to read a code out,
//                 pick up a phone and load the page. Every other rig here
//                 joins about one second after the room opens, so an idle
//                 broker connection has never been held open this long.
//   rejoin        the joiner is left unadmitted, gives up, RELOADS THE PAGE and
//                 tries the same code again. The host is then holding a stale
//                 request from a peer that no longer exists while a second one
//                 arrives, and the engine allows only one pending request at a
//                 time. This is the first rig here that reloads anything.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node dreamcast/tools/room_crossdevice_test.mjs
//   node dreamcast/tools/room_crossdevice_test.mjs --url http://localhost:8080
//   node dreamcast/tools/room_crossdevice_test.mjs --arms panel-closed --play none
//
// FLAGS
//   --url U        origin under test. DEFAULT https://caseybement.com — the
//                  deadlock happened on production and a localhost run does not
//                  exercise the deployed page, the deployed lib/netplay.js, or
//                  Pages' Range behaviour.
//   --arms A,B     default panel-open,panel-closed,host-busy,mobile-joiner
//   --ignorems N --latems N --rejoinms N   timings for the three
//                  arms above that are ABOUT waiting
//   --play A,B     which arms also boot a disc and run the play-phase cells
//                  (barrier / core ran / pads). Default `panel-open`. `none`
//                  or `all` accepted. Each play arm downloads the disc on BOTH
//                  machines, so this is the expensive half and it is opt-in per
//                  arm rather than silently on everywhere.
//   --game G       #romSelect value, default gauntlet
//   --name N       output basename under /tmp/dc-xdev
//   --fresh        wipe the two persistent Chrome profiles first (re-downloads
//                  the disc; the profiles are per-ROLE and never shared,
//                  because cross-origin isolation is origin-scoped and STICKY —
//                  a shared profile would invalidate the whole test)
//   --headful --keep
//   --admitms N    how long to wait for a human-pressable admission control
//   --pairms N --bootms N
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const ORIGIN   = arg('url', 'https://caseybement.com').replace(/\/$/, '');
const GAME     = arg('game', 'gauntlet');
const NAME     = arg('name', 'xdev');
const ARMS     = arg('arms', 'panel-open,panel-closed,host-busy,mobile-joiner').split(',').map((s) => s.trim()).filter(Boolean);
const PLAYARG  = arg('play', 'panel-open');
const FRESH    = has('fresh');
const HEADFUL  = has('headful');
const KEEP     = has('keep');
const ADMIT_MS = parseInt(arg('admitms', '60000'), 10);
// How long the `host-ignores` arm leaves the prompt unanswered. The engine
// itself gives up at 120 s (lib/netplay.js _ask: a 120000 ms timer that denies
// with "nobody answered the request"), so --ignorems 130000 walks past that
// deadline and reads what BOTH sides say afterwards.
const IGNORE_MS = parseInt(arg('ignorems', '25000'), 10);
// `late-joiner`: how long the room sits open, untouched, before anyone knocks.
const LATE_MS  = parseInt(arg('latems', '90000'), 10);
// `rejoin`: how long the joiner waits, unadmitted, before giving up and
// reloading the page — which is what a person does when nothing happens.
const REJOIN_MS = parseInt(arg('rejoinms', '20000'), 10);
const PAIR_MS  = parseInt(arg('pairms', '90000'), 10);
const BOOT_MS  = parseInt(arg('bootms', '900000'), 10);
const PROFBASE = arg('profile-base', '/private/tmp/claude-501/dc-xdev');
const CHROME   = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PLAY_ARMS = PLAYARG === 'all' ? ARMS.slice() : PLAYARG === 'none' ? [] : PLAYARG.split(',').map((s) => s.trim()).filter(Boolean);

const OUT = path.join('/tmp', 'dc-xdev');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); logStream.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const load1 = () => { try { return os.loadavg()[0].toFixed(2); } catch (e) { return '?'; } };

// ---------------------------------------------------------------------------
// THE SELF-AUDIT. A rig that can reach past the UI will eventually reach past
// the UI, and the last one did. These patterns are what "driving the engine"
// looks like in JavaScript; if any of them appears in this file outside the
// declaration below, the run REFUSES TO START. The sentinel comment marks the
// only lines allowed to contain them.
// ---------------------------------------------------------------------------
// ⚠ EVERY LINE OF THIS ARRAY CARRIES THE SENTINEL. The first draft put it on
// the opening and closing lines only, so the patterns in the middle matched
// themselves and the audit would have refused to run — a self-check that fails
// closed on its own declaration is not a self-check.
const FORBIDDEN = [ /*selfaudit-allow*/
  '.approve(', '.deny(', '.setReady(', '.seat(',        /*selfaudit-allow*/
  'Netplay.sessions', 'NET.session', 'window.Netplay',  /*selfaudit-allow*/
  'sess.start(', 'session.close(', '__dcNetForce',      /*selfaudit-allow*/
]; /*selfaudit-allow*/
function selfAudit() {
  const src = fs.readFileSync(SELF, 'utf8').split('\n')
    .filter((l) => !/selfaudit-allow/.test(l)).join('\n');
  const hits = FORBIDDEN.filter((p) => src.includes(p));
  if (hits.length) {
    console.error('\n  REFUSING TO RUN. This rig exists because the last one drove the engine instead of the UI,\n' +
      '  and it now contains: ' + J(hits) + '\n' +
      '  Every pairing action here must be a click, a keystroke or a <select>. Remove it or the rig proves nothing.\n');
    process.exit(2);
  }
  return src.split('\n').length;
}

// ---------------------------------------------------------------------------
// Cells. PASS / FAIL / VOID, with VOID reserved for a precondition that never
// happened — NEVER for a missing feature. "the product has no way to do this"
// is a FAILURE; printing it as void is how a broken product keeps a green test.
// ---------------------------------------------------------------------------
const rec = [];
let ARM = '-';
const ok    = (n, d) => { rec.push({ arm: ARM, n, ok: true,  d }); say(`  PASS  [${ARM}] ${n}  ${d}`); };
const bad   = (n, d) => { rec.push({ arm: ARM, n, ok: false, d }); say(`  FAIL  [${ARM}] ${n}  ${d}`); };
const voidc = (n, d) => { rec.push({ arm: ARM, n, ok: null,  d }); say(`  VOID  [${ARM}] ${n}  ${d}`); };
const cell  = (p, n, good, badMsg) => (p ? ok(n, good) : bad(n, badMsg));

const RESULT = {
  when: new Date().toISOString(), origin: ORIGIN, game: GAME,
  arms: ARMS, playArms: PLAY_ARMS,
  uptimeStart: (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return '?'; } })(),
  loadavgStart: os.loadavg(),
  limits: {
    oneBox: 'both browsers run on ONE machine behind ONE NAT. This rig closes the real-UI gap, not the two-networks gap.',
    noRelay: 'no working TURN relay exists (public relays measured returning 701/400; peerjs\'s own two do not resolve), ' +
             'so symmetric-NAT peers cannot connect at all and nothing here can detect that.',
    engineNotDriven: 'no engine method is called by this harness; a self-audit over its own source enforces it.',
  },
  arms_detail: {}, rec: null,
};

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------
const IPHONE = {
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};
const browsers = [];

async function launch(role, mobile) {
  // ⚠ SEPARATE, PER-ROLE userDataDir. Cross-origin isolation is origin-scoped
  // and it PERSISTS: the device-matrix rig's own self-test reproduces the leak
  // (visit one COI page, then another in the same profile reports
  // crossOriginIsolated=true). Two sides sharing a profile is not two devices.
  const dir = path.join(PROFBASE, role);
  if (FRESH) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: HEADFUL ? false : 'new', userDataDir: dir,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
      '--disk-cache-size=2147483648'],
  });
  try {
    const g = (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default;
    g.guard(b, 'room_crossdevice_test');
  } catch (e) { say('  ⚠ leak-guard registration FAILED: ' + ((e && e.message) || e)); }
  browsers.push(b);
  const pg = (await b.pages())[0];
  const errs = [], nets = [];
  pg.on('pageerror', (e) => { const t = String((e && (e.message || e.type)) || e).slice(0, 240); errs.push(t); say(`  [${role}!] ${t.slice(0, 170)}`); });
  pg.on('console', (m) => {
    const t = m.text();
    if (/\[net\]|\[lockstep\]|DESYNC|join|approve|allow/i.test(t)) { nets.push(t.slice(0, 240)); say(`  [${role}] ${t.slice(0, 170)}`); }
  });
  if (mobile) { await pg.setUserAgent(IPHONE.ua); await pg.setViewport(IPHONE.viewport); }
  else await pg.setViewport({ width: 1280, height: 860 });
  // Without this a backgrounded window's rAF is throttled and the two sides
  // measure different clocks — an artefact, not a product fault.
  try { const cdp = await pg.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  pg.__role = role; pg.__errs = errs; pg.__net = nets; pg.__mobile = !!mobile;
  return pg;
}

async function gotoSettled(pg, url) {
  // coi-serviceworker reloads the page the first time it installs, so the first
  // navigation can be torn out from under us. Two navigations, then settle.
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await sleep(2500);
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await sleep(1500);
}

// ---------------------------------------------------------------------------
// HUMAN ACTIONS — the only way this rig is allowed to change anything.
// ---------------------------------------------------------------------------

// What a person can see and press. Used both to click and, on failure, to say
// exactly what WAS on screen instead of the control that should have been.
const visibleControls = (pg) => pg.evaluate(() => {
  const out = [];
  const sel = 'button,[role="button"],input[type="button"],input[type="submit"],a[href]';
  // ⚠ NOT `el.offsetParent !== null`. offsetParent is null for anything inside
  // a position:fixed subtree, and the engine's built-in approval dialog is
  // EXACTLY that (position:fixed;inset:0) — so an offsetParent test would have
  // made this rig blind to the one control it was written to look for.
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0)) return false;
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') <= 0.05) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return true;
  };
  document.querySelectorAll(sel).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!seen(el)) return;
    out.push({
      id: el.id || null, tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      disabled: !!el.disabled, aria: el.getAttribute('aria-disabled'),
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
    });
  });
  return out;
});

// A real mouse click at real coordinates, with the hit test a person is subject
// to. `elementFromPoint` is checked FIRST: a control that exists but is covered
// by an overlay is a finding, not something to click through with el.click().
async function clickAt(pg, box, wantLabel) {
  const x = Math.round(box.x + box.w / 2), y = Math.round(box.y + box.h / 2);
  const top = await pg.evaluate((px, py) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return null;
    return { id: el.id || null, tag: el.tagName.toLowerCase(), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) };
  }, x, y);
  await pg.mouse.click(x, y);
  return { x, y, topmost: top, wanted: wantLabel || null };
}

// Click a control by selector the way a person does: scroll it into view, check
// it is really the thing under the cursor, then click. NO el.click() fallback —
// a control that cannot be pressed by a mouse is a product finding.
async function human(pg, selector, what) {
  const box = await pg.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const vis = (typeof el.checkVisibility === 'function')
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : (cs.visibility !== 'hidden' && cs.display !== 'none');
    return {
      x: r.x, y: r.y, w: r.width, h: r.height,
      shown: r.width > 0 && r.height > 0 && vis,
      disabled: !!el.disabled, aria: el.getAttribute('aria-disabled'),
    };
  }, selector);
  if (!box) return { ok: false, why: `${what || selector}: no such control on the page` };
  if (!box.shown) return { ok: false, why: `${what || selector}: the control exists but is not visible` };
  if (box.disabled) return { ok: false, why: `${what || selector}: the control is disabled` };
  const r = await clickAt(pg, box, what || selector);
  const covered = r.topmost && r.topmost.id && selector.startsWith('#') && r.topmost.id !== selector.slice(1);
  return { ok: true, click: r, covered: covered ? r.topmost : null };
}

const type = async (pg, selector, text) => {
  const c = await human(pg, selector, selector);
  if (!c.ok) return c;
  await pg.keyboard.type(text, { delay: 45 });
  return c;
};
const pick = async (pg, selector, value) => {
  // <select> is a native control; puppeteer's select() sets the value and fires
  // input+change exactly as a person's choice does. There is no way to drive a
  // native option list with the mouse in headless Chrome.
  try { const v = await pg.select(selector, value); return { ok: v && v.length > 0, v }; }
  catch (e) { return { ok: false, why: (e && e.message) || String(e) }; }
};
const tap = async (pg, key) => {
  await pg.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k })), key);
  await sleep(110);
  await pg.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keyup', { key: k })), key);
};

async function until(pg, fn, ms, every = 500) {
  const t = Date.now();
  for (;;) {
    let v = null; try { v = await pg.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(every);
  }
}

// ---------------------------------------------------------------------------
// READING — DOM first, because the DOM is what the user photographed.
// ---------------------------------------------------------------------------
const readRoster = (pg) => pg.evaluate(() => {
  const ul = document.getElementById('netRoster');
  const box = document.getElementById('netRoom');
  const rows = ul ? Array.prototype.map.call(ul.children, (li) => ({
    cls: li.className,
    port: ((li.querySelector('.port') || {}).textContent || '').trim(),
    who: ((li.querySelector('.who') || {}).textContent || '').trim(),
    state: ((li.querySelector('.state') || {}).textContent || '').trim(),
    text: (li.textContent || '').replace(/\s+/g, ' ').trim(),
  })) : [];
  return {
    visible: !!(box && box.style.display !== 'none'),
    ports: (document.getElementById('netRoomPorts') || {}).textContent || '',
    barrier: ((document.getElementById('netBarrier') || {}).textContent || '').trim(),
    status: ((document.getElementById('netStatus') || {}).textContent || '').trim(),
    hud: ((document.getElementById('netHud') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
    overlayOpen: (() => { const o = document.getElementById('netOverlay'); return !!(o && o.classList.contains('on')); })(),
    rows,
  };
});
// Seats that are actually held by somebody. The placeholder row the page draws
// before the engine publishes a room ("the session has not published a room
// yet") is NOT a seat and must not be counted as one.
const occupied = (r) => (r && r.rows ? r.rows : [])
  .map((x, i) => ({ i, ...x }))
  .filter((x) => x.who && !/^open$/i.test(x.who) && !/has not published a room/i.test(x.who));
// WHICH PORT THIS MACHINE WAS TOLD IT HOLDS. Read from the HUD sentence the
// user photographed ("you are Player 2 (maple port 1)"), and — because the HUD
// is a separate element that can be absent while the roster is fine — falling
// back to the roster row this page marks "(you)". Both are DOM; neither asks
// the engine.
const hudPort = (r) => {
  const m = /maple port (\d+)/.exec((r && r.hud) || '');
  if (m) return +m[1];
  const mine = ((r && r.rows) || []).find((x) => /\(you\)/i.test(x.who || ''));
  const p = mine && /^P(\d+)$/.exec((mine.port || '').trim());
  return p ? (+p[1] - 1) : null;
};
const hudCoreRan = (r) => { const m = /core ran\s+(\d+)/.exec(r.hud || ''); return m ? +m[1] : null; };

const probe = (pg) => pg.evaluate(() => {
  const p = (typeof window.__dcProbe === 'function') ? window.__dcProbe() : null;
  const n = (typeof window.__dcNet === 'function') ? window.__dcNet() : null;
  const h = (typeof window.__dcNetHud === 'function') ? window.__dcNetHud() : null;
  return {
    booted: p ? p.booted : null, fps: p ? p.fps : null, iters: p ? p.iters : null,
    guestX: p ? p.guestX : null, phase: p ? p.phase : null,
    discBytes: p ? p.discBytes : null, discTotal: p ? p.discTotal : null,
    netState: n ? n.state : null,
    lockstep: n && n.lockstep ? { armed: n.lockstep.armed, running: n.lockstep.running, coreFrame: n.lockstep.coreFrame } : null,
    telPorts: h && h.telemetry ? h.telemetry.ports : null,
    telYou: h && h.telemetry ? h.telemetry.you : null,
    telPeers: h && h.telemetry ? h.telemetry.peers : null,
  };
});
const pad = (pg) => pg.evaluate(() => (typeof window.__dcPad === 'function' ? Array.from(window.__dcPad()) : null));

const shot = async (pg, tag) => {
  const f = path.join(OUT, `${NAME}-${ARM}-${pg.__role}-${tag}.png`);
  try { await pg.screenshot({ path: f }); RESULT.shots = (RESULT.shots || []).concat(f); } catch (e) {}
  return f;
};

// ---------------------------------------------------------------------------
// THE ADMISSION SCAN — the cell this whole rig was written for.
//
// It does NOT know the id of the Allow button. It looks for ANY control a
// person could press to let the joiner in, anywhere on the host's page,
// visible and enabled. That is deliberate: hardcoding #npApproveAllow would
// make the rig blind to a page that ships a different control, and — worse —
// blind to a page that ships NONE, which is the bug it exists to catch.
// ---------------------------------------------------------------------------
const ADMIT_RE  = /\b(allow|approve|admit|accept|let\s+\w+\s+in)\b/i;
const REFUSE_RE = /\b(deny|decline|reject|block|cancel|close|leave|no,)\b/i;
async function findAdmitControl(pg) {
  const ctrls = await visibleControls(pg);
  const hit = ctrls.find((c) => !c.disabled && c.aria !== 'true' &&
    (ADMIT_RE.test(c.text) || ADMIT_RE.test(c.id || '')) &&
    !REFUSE_RE.test(c.text));
  return { hit: hit || null, all: ctrls };
}

// ---------------------------------------------------------------------------
// THE `host-ignores` ARM. Nothing is pressed. The only question is what each
// machine TELLS ITS PLAYER while nobody has been admitted, because the user's
// two screenshots are a pair of claims — "you are Player 1" on one device and
// "you are Player 2, P1 is 80710319f8eea143" on the other — that cannot both
// be true of a room nobody was let into.
// ---------------------------------------------------------------------------
async function ignoreArm(host, join, admit, D) {
  say(`\n-- host: DELIBERATELY NOT ANSWERING for ${(IGNORE_MS / 1000).toFixed(0)} s (the engine gives up at 120 s)`);
  cell(!!admit.hit, 'the-host-is-asked-before-anyone-is-let-in',
    `the host was shown "${admit.hit && admit.hit.text}" — nobody is in until a person answers it`,
    'no prompt ever appeared on the host, so there is nothing for a person to ignore or to answer');
  await shot(host, '4-prompt-unanswered');
  const t = Date.now();
  while (Date.now() - t < IGNORE_MS) {
    await sleep(5000);
    const [h, j] = await Promise.all([readRoster(host), readRoster(join)]);
    say(`  ....  ${((Date.now() - t) / 1000).toFixed(0)}s  host "${h.status}" | joiner "${j.status}" | joiner seats ${occupied(j).length} port ${J(hudPort(j))}`);
  }
  const [h, j] = await Promise.all([readRoster(host), readRoster(join)]);
  D.ignored = { host: h, join: j, waited: IGNORE_MS };
  await shot(host, '5-ignored'); await shot(join, '5-ignored');
  say(`  ....  host roster  ${J(h.rows.map((r) => r.text))}`);
  say(`  ....  joiner roster ${J(j.rows.map((r) => r.text))}`);
  say(`  ....  host HUD "${(h.hud || '').slice(0, 160)}"`);
  say(`  ....  joiner HUD "${(j.hud || '').slice(0, 160)}"`);

  const jSeats = occupied(j).length, jPort = hudPort(j);
  cell(jSeats < 2 && jPort == null, 'an-unadmitted-joiner-is-NOT-given-a-seat',
    `the joiner has not been told it is in the room: ${jSeats} seat(s) drawn, no maple port claimed`,
    `THE JOINER HAS PAINTED ITSELF INTO A ROOM NOBODY LET IT INTO: it draws ${jSeats} occupied seat(s) ` +
    `${J(occupied(j).map((x) => x.port + ' ' + x.who))} and claims maple port ${J(jPort)} while the host has ` +
    'admitted nobody. That is the user\'s phone screenshot exactly — "you are Player 2 (maple port 1)" with the ' +
    'host in seat 1 — and the matching PC screenshot ("P2 open") is not a bug on the host at all: the host is ' +
    'telling the truth and the joiner is not. Two people then sit in a room only one of them is in.');
  cell(/wait|let you in|looking for/i.test(j.status), 'an-unadmitted-joiner-is-TOLD-what-it-is-waiting-for',
    `the joiner's status line says: "${j.status}"`,
    `the joiner's status line reads "${j.status}" — it does not say it is waiting to be let in, so the person ` +
    'holding it has no way to know the other player has to press something');
  const stillAsking = await findAdmitControl(host);
  if (IGNORE_MS < 115000) {
    cell(!!stillAsking.hit, 'the-request-is-still-on-screen-for-the-host',
      `the prompt is still there after ${(IGNORE_MS / 1000).toFixed(0)} s — the host can still say yes`,
      `the prompt is GONE after ${(IGNORE_MS / 1000).toFixed(0)} s and nobody answered it. The joiner is now ` +
      'waiting on a question that no longer exists on the other machine, and no control anywhere brings it back');
  } else {
    cell(!stillAsking.hit && /refus|declin|could not|no one|nobody|closed/i.test(j.status),
      'an-expired-request-TELLS-THE-JOINER-it-expired',
      `the prompt expired and the joiner was told: "${j.status}"`,
      `the prompt is ${stillAsking.hit ? 'still up' : 'gone'} and the joiner's status reads "${j.status}". An ` +
      'expired request that leaves the joiner saying anything other than "you were not let in" strands that ' +
      'person in a room that no longer has a pending request in it');
  }
}

// ===========================================================================
// ONE ARM
// ===========================================================================
async function runArm(armName) {
  ARM = armName;
  const D = RESULT.arms_detail[armName] = { load: load1(), steps: [] };
  say(`\n${'='.repeat(78)}\n== ARM ${armName}  (load ${D.load})\n${'='.repeat(78)}`);

  const mobileJoiner = armName === 'mobile-joiner';
  const host = await launch('host', false);
  const join = await launch('join', mobileJoiner);
  const pages = [host, join];

  try {
    await Promise.all(pages.map((pg) => gotoSettled(pg, ORIGIN + '/dreamcast.html')));

    // -- 0. the rig's own preconditions ------------------------------------
    const mounted = await Promise.all(pages.map((pg) => until(pg, () =>
      (typeof window.__dcNetRoom === 'function' && document.getElementById('netOverlay')) ? true : null, 90000)));
    cell(mounted.every(Boolean), 'both-pages-load',
      `${ORIGIN}/dreamcast.html loaded and wired on both machines`,
      `pages did not finish wiring: ${J(mounted)} — nothing below this line means anything`);
    if (!mounted.every(Boolean)) return;

    // The entry point must be VISIBLE, not merely present: the page hides
    // #btnNet unless Netplay.supported(), and a hidden button is a product that
    // offers no online play at all on that device.
    const entry = await Promise.all(pages.map(async (pg) => {
      const ids = pg.__mobile ? ['mobileSplashNet', 'mNet', 'btnNet'] : ['btnNet', 'mNet', 'mobileSplashNet'];
      const ctrls = await visibleControls(pg);
      const found = ids.map((id) => ctrls.find((c) => c.id === id)).filter(Boolean);
      return { role: pg.__role, mobile: pg.__mobile, found: found.map((c) => c.id), all: ctrls.length };
    }));
    D.entry = entry;
    cell(entry.every((e) => e.found.length > 0), 'both-machines-offer-a-way-in',
      `a visible "Play Online" control on both: ${J(entry.map((e) => e.role + ':' + e.found[0]))}`,
      `no visible online-play control: ${J(entry)} — on that device the product cannot be entered at all`);

    // Two profiles must not be able to hear each other except through the
    // broker, or the transport under test is not the one two devices use.
    const echoed = await join.evaluate(() => new Promise((res) => {
      const ch = new BroadcastChannel('xdev-isolation'); let heard = false;
      ch.onmessage = () => { heard = true; }; ch.postMessage('ping');
      setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 900);
    }));
    cell(!echoed, 'the-two-browsers-are-really-separate',
      'no BroadcastChannel echo between the profiles — only the broker + ICE can pair these two',
      'a BroadcastChannel crossed the two profiles: this run proves nothing about two devices');

    // -- 1. THE HOST OPENS A ROOM, clicking only what a person clicks -------
    say(`\n-- host: picks ${GAME}, opens the lobby, opens a room`);
    const hostPick = await pick(host, '#romSelect', GAME);
    cell(hostPick.ok, 'host-can-pick-the-disc', `#romSelect set to ${GAME}`,
      `could not pick ${GAME}: ${J(hostPick)}`);
    const openLobby = await human(host, '#btnNet', 'Play Online');
    cell(openLobby.ok, 'host-can-open-the-lobby', 'the host pressed "Play Online" with the mouse',
      `the host could not press "Play Online": ${openLobby.why}`);
    await sleep(600);
    const hostRoom = await human(host, '#netHostBtn', 'Open a room');
    cell(hostRoom.ok, 'host-can-open-a-room', 'the host pressed "Open a room"',
      `the host could not press "Open a room": ${hostRoom.why}`);
    const code = await until(host, () => {
      const t = (document.getElementById('netCode').textContent || '').trim();
      return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;
    }, 45000);
    D.code = code;
    cell(!!code, 'the-room-code-is-readable',
      `the host can read the code off the page: ${code}`,
      'no room code ever appeared on the host — there is nothing to tell the other player');
    await shot(host, '1-room-open');
    if (!code) return;

    // -- 1b. ARM-SPECIFIC HOST STATE ---------------------------------------
    if (armName === 'panel-closed' || armName === 'host-busy') {
      // THE USER'S PC. Nothing about opening a room says "keep this panel
      // open", and the page's own Close button is right there.
      const c = await human(host, '#netClose', 'Close');
      cell(c.ok, 'host-can-close-the-lobby-panel',
        'the host closed the lobby panel after opening the room — which is what the user did',
        `could not close the panel: ${c.why}`);
      D.hostPanelClosed = c.ok;
      await sleep(400);
    }
    if (armName === 'host-busy') {
      // A DIFFERENT PAGE STATE: the host got bored and started the game. The
      // rig does NOT wait for the download; the point is that the joiner
      // knocks while the host page is busy elsewhere.
      const s = await human(host, host.__mobile ? '#mobileSplashStart' : '#btnStart', 'Start');
      cell(s.ok, 'host-can-start-while-waiting',
        'the host pressed Start while waiting for someone to join — a real thing to do with a room open',
        `the host could not press Start: ${s.why}`);
      await sleep(6000);
      D.hostBusyProbe = await probe(host);
      say(`  ....  host is now ${J(D.hostBusyProbe.phase)} disc ${D.hostBusyProbe.discBytes}/${D.hostBusyProbe.discTotal}`);
    }
    await shot(host, '2-host-state');

    // -- 1c. THE WAIT A REAL PAIRING HAS AND A ONE-BOX RIG DOES NOT ---------
    // Every rig here joins about a second after the room opens. A person reads
    // the code out, picks up the other device, waits for a page to load on a
    // phone, and types five characters. That is a minute or more of an idle
    // broker connection and an unanswered room, and NOTHING in this repo has
    // ever held one open that long before a joiner arrived.
    if (armName === 'late-joiner') {
      say(`\n-- nobody touches anything for ${(LATE_MS / 1000).toFixed(0)} s — the time it takes to walk to a phone`);
      const tw = Date.now();
      while (Date.now() - tw < LATE_MS) {
        await sleep(15000);
        const h = await readRoster(host);
        const stillCode = await host.evaluate(() => (document.getElementById('netCode').textContent || '').trim());
        say(`  ....  ${((Date.now() - tw) / 1000).toFixed(0)}s  host "${h.status}" · code on screen: ${stillCode}`);
      }
    }

    // -- 2. THE JOINER JOINS ------------------------------------------------
    // A named function, because the `rejoin` arm has to do the whole thing a
    // SECOND time: reloading the page and trying again is what every stuck
    // person does, and no rig in this repo has ever done it.
    // If nothing visible was found the entry cell above has already FAILED;
    // falling back to #btnNet keeps the arm reporting, and the click below
    // fails loudly with its own reason.
    const jEntryId = entry[1].found[0] || 'btnNet';
    const joinerJoins = async (label) => {
      say(`\n-- joiner${mobileJoiner ? ' (phone)' : ''}${label}: picks ${GAME}, opens the lobby, types ${code}`);
      const jPick = await pick(join, join.__mobile ? '#mobileRomSelect' : '#romSelect', GAME);
      cell(jPick.ok, 'joiner-can-pick-the-disc' + label, `the joiner picked ${GAME} from its own picker`,
        `the joiner could not pick the disc: ${J(jPick)}`);
      const jOpen = await human(join, '#' + jEntryId, 'Play Online');
      cell(jOpen.ok, 'joiner-can-open-the-lobby' + label, `the joiner pressed #${jEntryId}`,
        `the joiner could not open the lobby: ${jOpen.why}`);
      await sleep(600);
      const jJoin = await human(join, '#netJoinBtn', 'Join a room');
      cell(jJoin.ok, 'joiner-can-open-the-join-pane' + label, 'the joiner pressed "Join a room"',
        `the joiner could not press "Join a room": ${jJoin.why}`);
      await sleep(300);
      // The join pane carries its own game picker; a person checks it matches.
      const jGame = await pick(join, '#netGame', GAME);
      cell(jGame.ok, 'the-join-pane-offers-the-same-disc' + label,
        `#netGame set to ${GAME} — the engine refuses a pairing whose game names differ`,
        `the joiner could not name ${GAME} in the join pane: ${J(jGame)}`);
      const typed = await type(join, '#netCodeIn', code);
      cell(typed.ok, 'joiner-can-type-the-code' + label, `typed ${code} into the code field with the keyboard`,
        `the joiner could not type into the code field: ${typed.why}`);
      const jGo = await human(join, '#netGo', 'Join');
      cell(jGo.ok, 'joiner-can-press-join' + label, 'the joiner pressed "Join"',
        `the joiner could not press "Join": ${jGo.why}`);
      await shot(join, '3-joined' + label);
    };
    await joinerJoins('');

    // -- 3. THE ADMISSION — THE CELL THIS RIG EXISTS FOR --------------------
    say('\n-- host: is there anything a person can press to let them in?');
    const tAdmit = Date.now();
    let admit = { hit: null, all: [] };
    while (Date.now() - tAdmit < ADMIT_MS) {
      admit = await findAdmitControl(host);
      if (admit.hit) break;
      // A room can also seat somebody with no prompt at all. If the roster
      // fills on its own, admission is not required and this is not a failure.
      const r = await readRoster(host);
      if (occupied(r).length >= 2) break;
      await sleep(700);
    }
    D.admit = { found: admit.hit, waitedMs: Date.now() - tAdmit, visibleControls: admit.all };
    const hostRosterNow = await readRoster(host);
    // The one arm that presses NOTHING here, and reads instead.
    if (armName === 'host-ignores') { await ignoreArm(host, join, admit, D); return; }

    // THE `rejoin` ARM. The joiner is left unadmitted long enough to give up,
    // then does the single most common thing a stuck person does: reloads the
    // page and tries the same code again. The host is now holding a stale
    // request from a peer that no longer exists, and a second one arrives.
    // lib/netplay.js allows only ONE pending request at a time (a second caller
    // is told 'busy'), so whether the second attempt can ever be admitted is a
    // real product question and nothing has asked it.
    if (armName === 'rejoin') {
      say(`\n-- nobody admits the joiner for ${(REJOIN_MS / 1000).toFixed(0)} s; then it RELOADS and tries again`);
      await sleep(REJOIN_MS);
      const before = await readRoster(join);
      say(`  ....  before the reload the joiner said "${before.status}"`);
      D.rejoin = { beforeStatus: before.status };
      await gotoSettled(join, ORIGIN + '/dreamcast.html');
      await joinerJoins('-again');
      const t2 = Date.now();
      let a2 = { hit: null, all: [] };
      while (Date.now() - t2 < ADMIT_MS) {
        a2 = await findAdmitControl(host);
        if (a2.hit) break;
        const r = await readRoster(host);
        if (occupied(r).length >= 2) break;
        await sleep(700);
      }
      D.rejoin.secondPrompt = !!a2.hit;
      if (a2.hit) {
        const c = await clickAt(host, a2.hit.box, a2.hit.text);
        ok('a-second-attempt-can-still-be-admitted',
          `after the joiner reloaded, the host was asked again and "${a2.hit.text}" was pressed at ${c.x},${c.y}`);
      } else {
        bad('a-second-attempt-can-still-be-admitted',
          `the joiner reloaded and knocked again, and NOTHING on the host page asks about it. The host is still ` +
          `holding the first request from a peer that no longer exists, and the only pressable controls were ` +
          `${J(a2.all.filter((c) => !c.disabled).map((c) => (c.id ? '#' + c.id : '') + '"' + c.text + '"'))}. ` +
          'A room that cannot survive one reload cannot survive a real pairing.');
      }
      await sleep(1500);
    } else if (admit.hit) {
      await shot(host, '4-prompt');
      const clicked = await clickAt(host, admit.hit.box, admit.hit.text);
      const landed = clicked.topmost && (clicked.topmost.id === admit.hit.id ||
        (clicked.topmost.text || '').includes(admit.hit.text));
      D.admit.click = clicked;
      cell(landed, 'the-admit-control-is-REACHABLE-by-a-mouse',
        `pressed "${admit.hit.text}"${admit.hit.id ? ' (#' + admit.hit.id + ')' : ''} at ${clicked.x},${clicked.y} ` +
        `after ${((Date.now() - tAdmit) / 1000).toFixed(1)} s${D.hostPanelClosed ? ' — WITH THE LOBBY PANEL CLOSED' : ''}`,
        `a control reading "${admit.hit.text}" exists but the mouse hit ${J(clicked.topmost)} instead — ` +
        'something is covering it, so a person cannot press it either');
      ok('a-human-can-admit-the-joiner',
        `the host page offered "${admit.hit.text}" and it was pressed with the mouse` +
        (D.hostPanelClosed ? ' even though the lobby panel was closed' : ''));
    } else if (occupied(hostRosterNow).length >= 2) {
      ok('a-human-can-admit-the-joiner',
        'no admission was required — the joiner was seated without anyone pressing anything, and the host roster shows them');
    } else {
      // ⚠ THIS IS A FAILURE, NOT A VOID, AND NOT A TIMEOUT.
      const names = admit.all.filter((c) => !c.disabled).map((c) => (c.id ? '#' + c.id : '') + '"' + c.text + '"');
      bad('a-human-can-admit-the-joiner',
        `NOTHING ON THE HOST PAGE ADMITS THE JOINER. After ${(ADMIT_MS / 1000).toFixed(0)} s the host's roster still reads ` +
        `${J(hostRosterNow.rows.map((r) => r.text))} and the only pressable controls on the whole page were ` +
        `${J(names)}. The pairing needs a human action that no control provides` +
        (D.hostPanelClosed ? ', and this arm had the lobby panel CLOSED — a prompt that only lives inside an open panel strands every joiner' : '') +
        '. This is the deadlock the user hit on two real devices.');
    }

    // -- 4. THE ROSTERS -----------------------------------------------------
    say('\n-- both sides: what does the room look like from each machine?');
    const tPair = Date.now();
    let hr = null, jr = null;
    while (Date.now() - tPair < PAIR_MS) {
      hr = await readRoster(host); jr = await readRoster(join);
      if (occupied(hr).length >= 2 && occupied(jr).length >= 2) break;
      await sleep(800);
    }
    D.rosters = { host: hr, join: jr, waitedMs: Date.now() - tPair };
    await shot(host, '5-roster'); await shot(join, '5-roster');
    const ho = occupied(hr), jo = occupied(jr);
    say(`  ....  host sees ${ho.length} seat(s): ${J(hr.rows.map((r) => r.text))}`);
    say(`  ....  join sees ${jo.length} seat(s): ${J(jr.rows.map((r) => r.text))}`);
    say(`  ....  host status "${hr.status}"  |  join status "${jr.status}"`);

    // THE NAMED ONE-WAY FAILURE. The user's screenshots are exactly this shape,
    // and it must never present as a timeout: a timeout says "slow", this says
    // "the host was never told".
    const oneWay = (ho.length >= 2) !== (jo.length >= 2);
    if (oneWay) {
      bad('ROSTER-IS-ONE-WAY',
        `${ho.length >= 2 ? 'the HOST sees the joiner but the JOINER does not see the host' :
          'THE JOINER SEES THE HOST AND THE HOST NEVER SEES THE JOINER'} — ` +
        `host roster ${J(hr.rows.map((r) => r.text))} vs joiner roster ${J(jr.rows.map((r) => r.text))}. ` +
        'This is the production deadlock: one side believes it is in a room with somebody, the other believes ' +
        'it is alone, and nothing can start because the side that is alone never becomes ready.');
    } else {
      ok('ROSTER-IS-ONE-WAY', `not one-way: both sides agree there ${ho.length >= 2 ? 'are two players' : 'is nobody else'}`);
    }
    cell(ho.length >= 2, 'the-hosts-roster-shows-the-joiner',
      `the host's own roster names ${ho.length} players: ${J(ho.map((x) => x.who))}`,
      `the host's roster shows only ${J(ho.map((x) => x.who))} — the person who joined is invisible on the machine ` +
      'that has to let them play');
    cell(jo.length >= 2, 'the-joiners-roster-shows-the-host',
      `the joiner's roster names ${jo.length} players: ${J(jo.map((x) => x.who))}`,
      `the joiner's roster shows only ${J(jo.map((x) => x.who))}`);
    const hPorts = ho.map((x) => x.port).sort(), jPorts = jo.map((x) => x.port).sort();
    cell(ho.length >= 2 && jo.length >= 2 && J(hPorts) === J(jPorts),
      'both-rosters-agree-on-which-seats-are-taken',
      `both machines show the same seats taken: ${J(hPorts)}`,
      `the two machines disagree about the room: host ${J(hPorts)} vs joiner ${J(jPorts)}`);
    const hPort = hudPort(hr), jPort = hudPort(jr);
    D.ports = { host: hPort, join: jPort };
    cell(hPort != null && jPort != null && hPort !== jPort,
      'each-side-is-told-a-DIFFERENT-maple-port',
      `the host is told port ${hPort} and the joiner port ${jPort} — two players on one port drive the same character`,
      `maple ports: host ${J(hPort)}, joiner ${J(jPort)} (read from each page's own HUD text)`);

    // -- 4b. THE `host-reload` ARM ------------------------------------------
    // THE ONE ACTION THAT PRODUCES THE USER'S EXACT PAIR OF SCREENSHOTS.
    // A seated joiner cannot seat itself — the `host-ignores` arm proves an
    // unadmitted joiner draws no seats and claims no port — so the user's phone
    // ("you are Player 2, P1 is 80710319f8eea143") HAD been admitted, and the
    // PC ("P1 you, P2 open") had then lost it. A page reload is the cheapest
    // way for one side to lose a room the other side still believes in: it is
    // an ordinary key on the host's keyboard, and on a phone the browser does
    // it unasked when a backgrounded tab is discarded.
    // The product requirement is NOT that a reload preserves the room. It is
    // that the SURVIVOR IS TOLD. A peer left holding a room that no longer
    // exists, with a port and a roster and no error, is the deadlock.
    if (armName === 'host-reload') {
      say('\n-- the HOST reloads its page. The room it was hosting is gone; what is the joiner told?');
      await gotoSettled(host, ORIGIN + '/dreamcast.html');
      await sleep(15000);
      const [h2, j2] = await Promise.all([readRoster(host), readRoster(join)]);
      D.afterReload = { host: h2, join: j2 };
      await shot(host, '6-after-host-reload'); await shot(join, '6-after-host-reload');
      say(`  ....  host roster  ${J(h2.rows.map((r) => r.text))} | status "${h2.status}"`);
      say(`  ....  joiner roster ${J(j2.rows.map((r) => r.text))} | status "${j2.status}"`);
      say(`  ....  joiner HUD "${(j2.hud || '').slice(0, 170)}"`);
      const jStill = occupied(j2).length, jPort2 = hudPort(j2);
      const told = /closed|left|lost|disconnect|could not|not connected/i.test(j2.status);
      cell(told || jStill === 0, 'a-side-whose-peer-VANISHED-is-told-so',
        `the joiner was told the room is gone: "${j2.status}" (${jStill} seat(s) still drawn)`,
        `THE JOINER IS STILL SITTING IN A ROOM THAT NO LONGER EXISTS. Its status reads "${j2.status}", it still ` +
        `draws ${jStill} occupied seat(s) ${J(occupied(j2).map((x) => x.port + ' ' + x.who))} and still claims ` +
        `maple port ${J(jPort2)}, while the host that was hosting it now shows ${J(h2.rows.map((r) => r.text))}. ` +
        'THIS IS THE USER\'S PAIR OF SCREENSHOTS: one device says "you are Player 2, P1 is <peer>", the other ' +
        'says "P1 you, P2 open", both say "waiting for players", and neither is ever told why. Nothing in the ' +
        'product reconciles them and no control on either page recovers.');
      D.reproducedUserScreenshots = !(told || jStill === 0);
      return;
    }

    // -- 5. THE PLAY PHASE --------------------------------------------------
    if (!PLAY_ARMS.includes(armName)) {
      say(`\n-- play phase not requested for this arm (--play ${PLAYARG})`);
      D.play = 'not requested';
      return;
    }
    if (ho.length < 2 || jo.length < 2) {
      voidc('the-barrier-releases', 'not measurable: the two machines are not in one room (see the roster failures above)');
      voidc('core-ran-advances-past-0-on-both', 'not measurable: the two machines are not in one room');
      voidc('each-sides-own-pad-reaches-its-OWN-core', 'not measurable: the two machines are not in one room');
      return;
    }

    say('\n-- both machines load the disc and start their own core');
    // The lobby overlay covers the toolbar, so a person closes it to reach
    // Start. If Start cannot be pressed from here, that is a finding.
    for (const pg of pages) {
      const r = await readRoster(pg);
      if (r.overlayOpen) await human(pg, '#netClose', 'Close');
    }
    const starts = [];
    for (const pg of pages) {
      const already = (await probe(pg)).phase;
      if (armName === 'host-busy' && pg.__role === 'host') { starts.push({ ok: true, why: 'already started for this arm' }); continue; }
      starts.push(await human(pg, pg.__mobile ? '#mobileSplashStart' : '#btnStart', 'Start'));
      say(`  ....  ${pg.__role} pressed Start (was ${already})`);
    }
    cell(starts.every((s) => s.ok), 'both-machines-can-start-their-own-core',
      'Start was pressable on both machines — each player runs their own console',
      `Start could not be pressed: ${J(starts.map((s) => s.why || 'ok'))}`);

    const bootDeadline = Date.now() + BOOT_MS;
    const booted = [];
    for (const pg of pages) {
      let last = '';
      const v = await (async () => {
        while (Date.now() < bootDeadline) {
          const p = await probe(pg).catch(() => null);
          if (p) {
            const l = `${pg.__role} ${p.phase} ${Math.round(100 * (p.discBytes || 0) / (p.discTotal || 1))}%`;
            if (l !== last) { last = l; process.stdout.write('  ....  loading  ' + l + '            \r'); }
            // A core in a room parks at frame 0 on an empty queue until the
            // barrier releases, so "booted with fps 0" is CORRECT here and
            // waiting for frames would call a working gate a dead core.
            if (p.booted) return p;
          }
          await sleep(2500);
        }
        return null;
      })();
      booted.push(v);
    }
    process.stdout.write('\n');
    D.booted = booted;
    cell(booted.every(Boolean), 'both-machines-reach-a-booted-core',
      `both cores loaded ${GAME}: ${J(booted.map((b) => b && b.phase))}`,
      `a machine never booted within ${(BOOT_MS / 1000).toFixed(0)} s: ${J(booted.map((b) => !!b))}`);
    if (!booted.every(Boolean)) {
      voidc('the-barrier-releases', 'not measurable: a core never booted');
      return;
    }

    // -- 5b. READY, pressed as a button, on both ---------------------------
    say('\n-- both players press "I\'m ready" — the only control the barrier has');
    for (const pg of pages) {
      const r = await readRoster(pg);
      if (!r.overlayOpen) await human(pg, '#' + ((pg.__mobile ? entry[1].found[0] : entry[0].found[0]) || 'btnNet'), 'Play Online');
      await sleep(500);
      // The button is disabled until this machine's own disc is fully loaded.
      const gotReady = await until(pg, () => {
        const b = document.getElementById('netReady');
        return (b && b.style.display !== 'none' && !b.disabled) ? true : null;
      }, 120000, 1000);
      if (!gotReady) {
        bad('both-players-can-press-ready',
          `${pg.__role}: "I'm ready" never became pressable (shown/enabled) — the barrier has no other control, so ` +
          'this room can never start');
        continue;
      }
      const c = await human(pg, '#netReady', "I'm ready");
      cell(c.ok, 'both-players-can-press-ready', `${pg.__role} pressed "I'm ready"`,
        `${pg.__role} could not press ready: ${c.why}`);
      await sleep(800);
    }
    await sleep(4000);
    const bars = await Promise.all(pages.map(readRoster));
    D.barrier = bars.map((b) => b.barrier);
    await shot(host, '6-barrier'); await shot(join, '6-barrier');
    say(`  ....  host barrier: "${bars[0].barrier}"  |  join barrier: "${bars[1].barrier}"`);
    cell(bars.every((b) => /started together at frame/i.test(b.barrier)),
      'the-barrier-releases',
      `both machines print the release: ${J(bars.map((b) => b.barrier))}`,
      `the barrier never released: ${J(bars.map((b) => b.barrier))} — this is the "waiting for players" the user was ` +
      'left staring at');

    // -- 5c. core ran advances, sampled twice ------------------------------
    for (const pg of pages) { const r = await readRoster(pg); if (r.overlayOpen) await human(pg, '#netClose', 'Close'); }
    await sleep(3000);
    const a1 = await Promise.all(pages.map(readRoster));
    await sleep(6000);
    const a2 = await Promise.all(pages.map(readRoster));
    const ran1 = a1.map(hudCoreRan), ran2 = a2.map(hudCoreRan);
    D.coreRan = { first: ran1, second: ran2 };
    say(`  ....  core ran: ${J(ran1)} -> ${J(ran2)} over ~6 s`);
    cell(ran2.every((n, i) => n != null && n > 0 && n > (ran1[i] || 0)),
      'core-ran-advances-past-0-on-both',
      `both cores are advancing: ${J(ran1)} -> ${J(ran2)} in 6 s, read off each page's own HUD`,
      `core ran ${J(ran1)} -> ${J(ran2)}. The user's two devices both read "frame 0 · core ran 0" forever; a counter ` +
      'that does not move is the deadlock, whatever else the panel says');

    // -- 5d. each side's own pad reaches its OWN core ----------------------
    say('\n-- each player presses a key; does it reach their own core, and the other one?');
    const KEYS = ['a', 'd'];
    const before = await Promise.all(pages.map(pad));
    for (let i = 0; i < pages.length; i++) {
      await pages[i].evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k })), KEYS[i]);
    }
    await sleep(1800);
    const during = await Promise.all(pages.map(pad));
    for (let i = 0; i < pages.length; i++) {
      await pages[i].evaluate((k) => window.dispatchEvent(new KeyboardEvent('keyup', { key: k })), KEYS[i]);
    }
    await sleep(1200);
    const after = await Promise.all(pages.map(pad));
    const ports = [hudPort(a2[0]), hudPort(a2[1])];
    D.pads = { ports, before, during, after };
    if (ports.every((p) => p != null) && during.every(Boolean)) {
      const own = pages.map((pg, i) => during[i].slice(ports[i] * 64, ports[i] * 64 + 12).some((b) => b !== 0));
      cell(own.every(Boolean), 'each-sides-own-pad-reaches-its-OWN-core',
        `each machine's own maple port carries its own key: ${J(pages.map((pg, i) => pg.__role + '->port' + ports[i]))}`,
        `a machine's own key never reached its own port: ${J(pages.map((pg, i) => pg.__role + ' port' + ports[i] + '=' + own[i]))}`);
      const cross = [];
      for (let viewer = 0; viewer < 2; viewer++) for (let actor = 0; actor < 2; actor++) {
        const nz = during[viewer].slice(ports[actor] * 64, ports[actor] * 64 + 12).some((b) => b !== 0);
        cross.push(`${pages[viewer].__role} sees port ${ports[actor]} = ${nz ? 'PRESSED' : 'idle'}`);
      }
      cell(cross.every((s) => /PRESSED/.test(s)), 'every-core-holds-BOTH-players-input',
        `all four viewer/actor pairs agree — ${cross.join('; ')}`,
        `not every core saw both pads — ${cross.join('; ')}`);
      cell(after.every((p) => p.every((b) => b === 0)), 'the-pads-release',
        'both maple images returned to zero when the keys came up',
        `pads after release: ${J(after.map((p) => p.slice(0, 12)))}`);
    } else {
      voidc('each-sides-own-pad-reaches-its-OWN-core', `not measurable: ports ${J(ports)} / pad images ${J(during.map(Boolean))}`);
    }
    await shot(host, '7-play'); await shot(join, '7-play');
  } finally {
    D.hostErrors = host.__errs.slice(0, 12);
    D.joinErrors = join.__errs.slice(0, 12);
    D.hostNetLog = host.__net.slice(-40);
    D.joinNetLog = join.__net.slice(-40);
    D.loadEnd = load1();
    if (!KEEP) { for (const b of browsers.splice(0)) { try { await b.close(); } catch (e) {} } }
  }
}

// ===========================================================================
(async () => {
  const lines = selfAudit();
  say('== room_crossdevice_test ==');
  say(`  origin      ${ORIGIN}`);
  say(`  arms        ${J(ARMS)}   play phase on ${J(PLAY_ARMS)}`);
  say(`  game        ${GAME}`);
  say(`  uptime      ${RESULT.uptimeStart}`);
  say(`  self-audit  ${lines} lines scanned, no engine-driving pattern present`);
  say('  ⚠ LIMIT      both browsers are on ONE box behind ONE NAT. This closes the real-UI gap, NOT the');
  say('               two-networks gap — and with no working TURN relay, symmetric-NAT peers cannot connect');
  say('               at all and nothing here can detect that. A green run does not mean two carriers work.');

  let fatal = null;
  for (const a of ARMS) {
    try { await runArm(a); }
    catch (e) { ARM = a; bad('arm-crashed', `${a}: ${(e && e.stack) || e}`); fatal = e; }
    finally { for (const b of browsers.splice(0)) { try { await b.close(); } catch (e) {} } }
  }

  ARM = '-';
  RESULT.rec = rec;
  RESULT.loadavgEnd = os.loadavg();
  const pass = rec.filter((r) => r.ok === true).length;
  const fail = rec.filter((r) => r.ok === false);
  const vd   = rec.filter((r) => r.ok === null).length;
  say(`\n${'='.repeat(78)}`);
  say(`  ${pass} pass · ${fail.length} FAIL · ${vd} void   (load ${RESULT.loadavgStart[0].toFixed(2)} -> ${load1()})`);
  if (fail.length) { say('  FAILURES:'); fail.forEach((f) => say(`    [${f.arm}] ${f.n}`)); }
  say('  ⚠ ONE BOX, ONE NAT, NO RELAY — see the header. This rig cannot green-light two real networks.');
  const jsonPath = path.join(OUT, NAME + '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(RESULT, null, 2));
  say(`  log ${LOG}\n  json ${jsonPath}`);
  logStream.end();
  process.exit(fail.length ? 1 : 0);
})();

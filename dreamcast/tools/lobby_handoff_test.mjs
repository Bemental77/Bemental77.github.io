#!/usr/bin/env node
// ============================================================================
// lobby_handoff_test.mjs — THE LOBBY HANDS OFF, AND THE PLAYER ARRIVES IN A ROOM
// ============================================================================
//
// WHY THIS FILE EXISTS
// --------------------
// dreamcast_multiplayer.html was the LAST page in this repo still running the
// cancelled streaming architecture: a <video id="mpVideo">, a touch pad, a mask
// packer and a live session that read the host's media. Under the user's
// directive ("WE WILL NOT USE STREAMING!") every player runs their own core and
// only pad bytes cross the wire, so that page had to become what
// n64_multiplayer.html already is — A LOBBY THAT HANDS OFF.
//
// tools/no_streaming_test.mjs proves the machinery is GONE. It is a source
// check on purpose and it cannot prove the replacement WORKS: a lobby that
// deleted its <video> and navigates to a URL nobody can pair on would pass that
// gate and strand every player. This rig is the other half — it drives the
// lobby with a real mouse and a real keyboard, follows the hand-off, and asks
// what the two people actually end up with.
//
// THE ONE RULE, INHERITED VERBATIM FROM dreamcast/tools/room_crossdevice_test.mjs:
// IT ONLY DOES WHAT A PERSON CAN DO. It clicks at real coordinates after an
// elementFromPoint hit test, it types with the keyboard, it chooses from the
// page's own <select>. It NEVER calls the session's approve / deny / seat /
// setReady / start / close, and never touches the page's Netplay object. A
// self-audit greps this file for those patterns at startup and REFUSES TO RUN
// if one appears. State is READ through the pages' read-only seams (__dcmp,
// __dcNet, __dcNetRoom) and out of the DOM, because the DOM is what a player
// looks at.
//
// WHAT IT ASSERTS
//   1. THE LOBBY IS NOT A VIEWER — no <video> and no #mpVideo exist in the live
//      DOM on either side. Asserted at runtime, not by grep, because the grep
//      gate already ran and a page can build an element at runtime.
//   2. a person can mint a code on the lobby and read it off the screen;
//   3. pressing "Start my console" LANDS ON dreamcast.html carrying that code;
//   4. pressing "Join and start my console" lands there too, carrying &join=1 —
//      the flag that is the whole difference between the two sides. Before this
//      existed EVERY arrival was hosted, so two lobby players became two hosts
//      under one code and paired with nobody;
//   5. the two arrivals take DIFFERENT ROLES (host / guest) — read off each
//      page's own seam;
//   6. the joiner can be admitted by pressing a control a person can see;
//   7. both rosters agree, and each side is told a DIFFERENT maple port —
//      SEATED, WITH A PORT;
//   8. GATED: with a disc loaded, lockstep is ARMED and the core is parked at
//      frame 0, i.e. a core in a room runs ZERO free-running frames. Nobody
//      presses "I'm ready" here, so the barrier must never release and the
//      frame counter must stay at 0.
//
// ⚠ CELL 8 CURRENTLY FAILS, AND IT IS NOT THE HAND-OFF THAT FAILS IT.
// Measured with the hand-off taken out of the picture completely — plain
// dreamcast.html, driven through its OWN "Open a room" and Start buttons, no
// ?np= and no lobby page — a core that boots before any peer has connected
// reports `armed:false` with "the room published no lockstep engine". The cause
// is an ordering one in the page, not in the lobby: lsArmBeforeFreerun() is
// called EXACTLY ONCE, between the disc load and {cmd:'freerun',on:1}
// (dreamcast.html:3861), while session.ls is not created until a peer's game
// channel opens (lib/netplay.js:3029 _onPeerUp -> _ensureLockstep). Whenever
// the disc wins that race — a warm cache, a lazily-read disc, or just a host
// who opens a room and waits for somebody — there is no engine to arm against
// and nothing re-arms afterwards. The fix is a re-arm when the room goes live,
// inside the lockstep core. It is left FAILING here rather than softened to a
// void, because a room whose cores are not frame-gated is a real defect and a
// green test over it is how this architecture got lost the first time.
//
// ⚠⚠ THE HONEST LIMITS — READ BEFORE QUOTING A GREEN RUN ⚠⚠
//   * Both browsers are on ONE box behind ONE NAT, so ICE always has a friendly
//     path. This closes the real-UI gap, not the two-networks gap, and there is
//     no working TURN relay (see room_crossdevice_test.mjs's header).
//   * `--net local` exists but is NOT the default: a sibling measured that the
//     'local' BroadcastChannel transport CANNOT PAIR TWO PEERS (host stuck at
//     "someone is asking to join", guest at "waiting for the host to let you
//     in", 12 samples over 24 s, never connected). A failure under --net local
//     is therefore not evidence about this hand-off. The default is peerjs.
//   * Cell 8 needs a real disc load on BOTH machines. If a disc does not finish
//     inside --bootms the gating cells are VOID with the reason, never PASS.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web    # tools/devserver.mjs on :8080, in another shell
//   bash tools/probe_lock.sh run -- node dreamcast/tools/lobby_handoff_test.mjs
//
// FLAGS
//   --url U       origin under test, default http://localhost:8080
//   --game G      the disc BOTH sides pick, default mvc2 (the smallest image
//                 here at 148 MB — this rig is about the room, not the disc)
//   --net T       peerjs (default) | local
//   --boot        also run the gating cells, which download the disc on BOTH
//                 machines. Off by default so the room cells stay cheap.
//   --bootms N --admitms N --pairms N
//   --headful --keep --fresh --name N
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

const ORIGIN  = arg('url', 'http://localhost:8080').replace(/\/$/, '');
const GAME    = arg('game', 'mvc2');
const NET     = arg('net', 'peerjs');
const NAME    = arg('name', 'handoff');
const BOOT    = has('boot');
const FRESH   = has('fresh');
const HEADFUL = has('headful');
const KEEP    = has('keep');
const ADMIT_MS = parseInt(arg('admitms', '60000'), 10);
const PAIR_MS  = parseInt(arg('pairms', '60000'), 10);
const BOOT_MS  = parseInt(arg('bootms', '600000'), 10);
const PROFBASE = arg('profile-base', '/private/tmp/claude-501/dc-handoff');
const CHROME   = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const LOBBY = ORIGIN + '/dreamcast_multiplayer.html' + (NET === 'local' ? '?net=local' : '');

const OUT = path.join('/tmp', 'dc-handoff');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); logStream.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const load1 = () => { try { return os.loadavg()[0].toFixed(2); } catch (e) { return '?'; } };

// ---------------------------------------------------------------------------
// THE SELF-AUDIT, same contract as room_crossdevice_test.mjs. A rig that CAN
// reach past the UI eventually WILL, and the rig before that one did. Every
// line of the array carries the sentinel: a self-check that matches its own
// declaration fails closed and proves nothing.
// ---------------------------------------------------------------------------
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
    console.error('\n  REFUSING TO RUN. Every pairing action here must be a click, a keystroke or a <select>,\n' +
      '  and this file now contains: ' + J(hits) + '\n');
    process.exit(2);
  }
  return src.split('\n').length;
}

// PASS / FAIL / VOID. VOID is ONLY for a precondition that never happened —
// never for a missing feature. "the product has no way to do this" is a FAILURE.
const rec = [];
const ok    = (n, d) => { rec.push({ n, ok: true,  d }); say(`  PASS  ${n}  ${d}`); };
const bad   = (n, d) => { rec.push({ n, ok: false, d }); say(`  FAIL  ${n}  ${d}`); };
const voidc = (n, d) => { rec.push({ n, ok: null,  d }); say(`  VOID  ${n}  ${d}`); };
const cell  = (p, n, good, badMsg) => (p ? ok(n, good) : bad(n, badMsg));

const RESULT = {
  when: new Date().toISOString(), origin: ORIGIN, game: GAME, transport: NET, bootPhase: BOOT,
  uptimeStart: (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return '?'; } })(),
  loadavgStart: os.loadavg(),
  limits: {
    oneBox: 'both browsers run on ONE machine behind ONE NAT; this closes the real-UI gap, not the two-networks gap',
    engineNotDriven: 'no engine method is called by this harness; a self-audit over its own source enforces it',
    localTransport: "the 'local' transport is known not to pair two peers; the default here is peerjs",
  },
  steps: {}, rec: null,
};

const browsers = [];
async function launch(role) {
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
    g.guard(b, 'lobby_handoff_test');
  } catch (e) { say('  ⚠ leak-guard registration FAILED: ' + ((e && e.message) || e)); }
  browsers.push(b);
  const pg = (await b.pages())[0];
  const errs = [], nets = [];
  pg.on('pageerror', (e) => { const t = String((e && (e.message || e.type)) || e).slice(0, 240); errs.push(t); say(`  [${role}!] ${t.slice(0, 170)}`); });
  pg.on('console', (m) => {
    const t = m.text();
    if (/\[net\]|\[lockstep\]|DESYNC|join|approve|allow/i.test(t)) { nets.push(t.slice(0, 240)); say(`  [${role}] ${t.slice(0, 170)}`); }
  });
  await pg.setViewport({ width: 1280, height: 900 });
  try { const cdp = await pg.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  pg.__role = role; pg.__errs = errs; pg.__net = nets;
  return pg;
}

// ---------------------------------------------------------------------------
// HUMAN ACTIONS — the only way this rig may change anything.
// ---------------------------------------------------------------------------
const visibleControls = (pg) => pg.evaluate(() => {
  const out = [];
  const sel = 'button,[role="button"],input[type="button"],input[type="submit"],a[href]';
  // ⚠ NOT `offsetParent !== null`: that is null for anything inside a
  // position:fixed subtree, and the engine's approval dialog is exactly that.
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

// Click by selector the way a person does: scroll into view, confirm it is
// really the thing under the cursor, then click. NO el.click() fallback — a
// control a mouse cannot press is a product finding, not something to route
// around.
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
    return { x: r.x, y: r.y, w: r.width, h: r.height,
             shown: r.width > 0 && r.height > 0 && vis,
             disabled: !!el.disabled, aria: el.getAttribute('aria-disabled') };
  }, selector);
  if (!box) return { ok: false, why: `${what || selector}: no such control on the page` };
  if (!box.shown) return { ok: false, why: `${what || selector}: the control exists but is not visible` };
  if (box.disabled) return { ok: false, why: `${what || selector}: the control is disabled` };
  const r = await clickAt(pg, box, what || selector);
  return { ok: true, click: r };
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
// READING — DOM first, because the DOM is what the player looks at.
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
    href: location.href,
    visible: !!(box && box.style.display !== 'none'),
    barrier: ((document.getElementById('netBarrier') || {}).textContent || '').trim(),
    status: ((document.getElementById('netStatus') || {}).textContent || '').trim(),
    hud: ((document.getElementById('netHud') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
    rows,
  };
});
// A seat somebody actually holds. The placeholder the page draws before the
// engine publishes a room ("the session has not published a room yet") is NOT
// a seat and must never be counted as one.
const occupied = (r) => (r && r.rows ? r.rows : [])
  .map((x, i) => ({ i, ...x }))
  .filter((x) => x.who && !/^open$/i.test(x.who) && !/has not published a room/i.test(x.who));
// WHICH PORT THIS MACHINE WAS TOLD IT HOLDS — from the HUD sentence a player
// reads ("you are Player 2 (maple port 1)"), falling back to the roster row
// this page marks "(you)". Both are DOM; neither asks the engine.
const hudPort = (r) => {
  const m = /maple port (\d+)/.exec((r && r.hud) || '');
  if (m) return +m[1];
  const mine = ((r && r.rows) || []).find((x) => /\(you\)/i.test(x.who || ''));
  const p = mine && /^P(\d+)$/.exec((mine.port || '').trim());
  return p ? (+p[1] - 1) : null;
};

const probe = (pg) => pg.evaluate(() => {
  const p = (typeof window.__dcProbe === 'function') ? window.__dcProbe() : null;
  const n = (typeof window.__dcNet === 'function') ? window.__dcNet() : null;
  return {
    href: location.href,
    booted: p ? p.booted : null, phase: p ? p.phase : null,
    discBytes: p ? p.discBytes : null, discTotal: p ? p.discTotal : null,
    role: n ? n.role : null, netState: n ? n.state : null, code: n ? n.code : null,
    lockstep: n && n.lockstep
      ? { armed: n.lockstep.armed, running: n.lockstep.running, coreFrame: n.lockstep.coreFrame,
          fault: n.lockstep.fault, normalize: n.lockstep.normalize }
      : null,
  };
});

const shot = async (pg, tag) => {
  const f = path.join(OUT, `${NAME}-${pg.__role}-${tag}.png`);
  try { await pg.screenshot({ path: f }); RESULT.shots = (RESULT.shots || []).concat(f); } catch (e) {}
  return f;
};

// THE ADMISSION SCAN — it does NOT know the id of the Allow button. It looks
// for ANY control a person could press to let the joiner in. Hardcoding an id
// would make the rig blind to a page that ships NONE, which is the bug worth
// catching.
const ADMIT_RE  = /\b(allow|approve|admit|accept|let\s+\w+\s+in)\b/i;
const REFUSE_RE = /\b(deny|decline|reject|block|cancel|close|leave|no,)\b/i;
async function findAdmitControl(pg) {
  const ctrls = await visibleControls(pg);
  const hit = ctrls.find((c) => !c.disabled && c.aria !== 'true' &&
    (ADMIT_RE.test(c.text) || ADMIT_RE.test(c.id || '')) && !REFUSE_RE.test(c.text));
  return { hit: hit || null, all: ctrls };
}

// ===========================================================================
(async () => {
  const lines = selfAudit();
  say('== lobby_handoff_test ==');
  say(`  origin      ${ORIGIN}`);
  say(`  lobby       ${LOBBY}`);
  say(`  game        ${GAME}   transport ${NET}   boot phase ${BOOT ? 'ON' : 'off (--boot to enable)'}`);
  say(`  uptime      ${RESULT.uptimeStart}`);
  say(`  self-audit  ${lines} lines scanned, no engine-driving pattern present`);
  say('  ⚠ LIMIT      one box, one NAT. Closes the real-UI gap, not the two-networks gap.');

  const host = await launch('host');
  const join = await launch('join');
  const pages = [host, join];

  try {
    // -- 0. BOTH PLAYERS OPEN THE LOBBY ------------------------------------
    for (const pg of pages) {
      await pg.goto(LOBBY, { waitUntil: 'domcontentloaded', timeout: 120000 });
    }
    await sleep(1200);
    const mounted = await Promise.all(pages.map((pg) => until(pg, () =>
      (typeof window.__dcmp === 'function' && document.getElementById('btnHost')) ? true : null, 30000)));
    cell(mounted.every(Boolean), 'both-players-can-open-the-lobby',
      `${LOBBY} loaded and wired on both machines`,
      `the lobby did not finish wiring: ${J(mounted)} — nothing below this line means anything`);
    if (!mounted.every(Boolean)) return;

    // -- 1. THE LOBBY IS NOT A VIEWER --------------------------------------
    // Asserted on the LIVE DOM, not by grep. tools/no_streaming_test.mjs is the
    // source check; this is the runtime one, because a page can build an
    // element after load and a grep cannot see that.
    const shape = await Promise.all(pages.map((pg) => pg.evaluate(() => ({
      videos: document.querySelectorAll('video').length,
      mpVideo: !!document.getElementById('mpVideo'),
      pad: !!document.getElementById('pad'),
      arch: (typeof window.__dcmp === 'function') ? (window.__dcmp().architecture || null) : null,
      seamKeys: (typeof window.__dcmp === 'function') ? Object.keys(window.__dcmp()).sort() : null,
      maskSeam: typeof window.__dcmpMask,
    }))));
    RESULT.steps.shape = shape;
    cell(shape.every((s) => s.videos === 0 && !s.mpVideo && !s.pad),
      'THE-LOBBY-IS-NOT-A-VIEWER',
      `no <video>, no #mpVideo and no touch pad exist in the live DOM on either side: ${J(shape.map((s) => s.videos))} video element(s)`,
      `the lobby still builds streaming machinery at runtime: ${J(shape)} — a guest here would watch a picture ` +
      'instead of running a core, which is the architecture that was cancelled');
    cell(shape.every((s) => s.arch === 'lockstep' && s.maskSeam === 'undefined'),
      'the-lobbys-own-seam-says-lockstep-and-has-no-mask-packer',
      `__dcmp().architecture = ${J(shape.map((s) => s.arch))} and window.__dcmpMask is gone (${J(shape.map((s) => s.maskSeam))})`,
      `__dcmp still describes the streaming path: ${J(shape)}`);

    // -- 2. THE HOST MINTS A CODE ------------------------------------------
    say(`\n-- host: picks ${GAME}, presses "Create a room", reads the code`);
    const hPick = await pick(host, '#game', GAME);
    cell(hPick.ok, 'host-can-pick-the-disc', `#game set to ${GAME}`, `could not pick ${GAME}: ${J(hPick)}`);
    const hCreate = await human(host, '#btnHost', 'Create a room');
    cell(hCreate.ok, 'host-can-create-a-room', 'the host pressed "Create a room" with the mouse',
      `the host could not press "Create a room": ${hCreate.why}`);
    const code = await until(host, () => {
      const t = (document.getElementById('code').textContent || '').trim();
      return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;
    }, 20000);
    RESULT.steps.code = code;
    cell(!!code, 'the-room-code-is-readable-on-the-lobby',
      `the host can read the code off the page before anything downloads: ${code}`,
      'no room code ever appeared — there is nothing to tell the other player');
    await shot(host, '1-code');
    if (!code) return;

    // -- 3. THE HAND-OFF ----------------------------------------------------
    // A person presses Start; the browser navigates. The cell is the LANDING,
    // not the click: a lobby that navigates somewhere unpairable would pass a
    // click assertion and strand both players.
    say('\n-- host: presses "Start my console" — the hand-off');
    const hGo = await human(host, '#btnGo', 'Start my console');
    cell(hGo.ok, 'host-can-press-start', 'the host pressed "Start my console"',
      `the host could not press Start: ${hGo.why}`);
    const hLanded = await until(host, () => (/\/dreamcast\.html/.test(location.pathname + location.search) ? location.href : null), 60000);
    RESULT.steps.hostHref = hLanded;
    cell(!!hLanded && hLanded.includes('np=' + code),
      'the-host-lands-on-the-EMULATOR-page-carrying-the-code',
      `the host is now on ${hLanded} — the page with a core on it, under the code it published`,
      `the host did not reach dreamcast.html with np=${code}: ${J(hLanded)}`);
    cell(!!hLanded && !/[?&]join=1/.test(hLanded),
      'the-host-hand-off-does-NOT-carry-join',
      'the host URL has no &join=1, so this side opens the room',
      `the host URL carries &join=1 (${J(hLanded)}) — both sides would knock and nobody would answer`);

    say(`\n-- joiner: picks ${GAME}, presses "I have a code", types ${code}, joins`);
    const jPick = await pick(join, '#game', GAME);
    cell(jPick.ok, 'joiner-can-pick-the-disc', `the joiner picked ${GAME} from its own picker`,
      `the joiner could not pick the disc: ${J(jPick)}`);
    const jPane = await human(join, '#btnJoinPane', 'I have a code');
    cell(jPane.ok, 'joiner-can-open-the-code-field', 'the joiner pressed "I have a code"',
      `the joiner could not press "I have a code": ${jPane.why}`);
    await sleep(250);
    const jTyped = await type(join, '#codeIn', code);
    cell(jTyped.ok, 'joiner-can-type-the-code', `typed ${code} with the keyboard`,
      `the joiner could not type into the code field: ${jTyped.why}`);
    const jGo = await human(join, '#btnJoin', 'Join and start my console');
    cell(jGo.ok, 'joiner-can-press-join', 'the joiner pressed "Join and start my console"',
      `the joiner could not press Join: ${jGo.why}`);
    const jLanded = await until(join, () => (/\/dreamcast\.html/.test(location.pathname + location.search) ? location.href : null), 60000);
    RESULT.steps.joinHref = jLanded;
    cell(!!jLanded && jLanded.includes('np=' + code),
      'the-joiner-lands-on-the-EMULATOR-page-TOO',
      `the joiner is on ${jLanded} — under lockstep a joiner runs its own core, so it needs this page as much as the host`,
      `the joiner did not reach dreamcast.html with np=${code}: ${J(jLanded)}`);
    cell(!!jLanded && /[?&]join=1/.test(jLanded),
      'the-joiner-hand-off-CARRIES-join=1',
      'the joiner URL carries &join=1 — the one flag that makes this side knock instead of host',
      `the joiner URL has no &join=1 (${J(jLanded)}); without it this arrival is hosted too, so two hosts sit ` +
      'under one code and nobody ever pairs — which is what this page did before the flag existed');

    // -- 4. TWO DIFFERENT ROLES --------------------------------------------
    const roles = await Promise.all(pages.map((pg) => until(pg, () => {
      const n = (typeof window.__dcNet === 'function') ? window.__dcNet() : null;
      return (n && n.role) ? n.role : null;
    }, 60000)));
    RESULT.steps.roles = roles;
    say(`  ....  roles: ${J(roles)}`);
    cell(roles[0] === 'host' && roles[1] === 'guest',
      'the-two-arrivals-take-DIFFERENT-roles',
      `the host page hosts and the joiner page joins: ${J(roles)}`,
      `both arrivals took ${J(roles)} — the hand-off did not distinguish them`);
    await shot(host, '2-arrived'); await shot(join, '2-arrived');

    // -- 5. ADMISSION — a control a PERSON can see and press ----------------
    say('\n-- host: is there anything a person can press to let the joiner in?');
    const tAdmit = Date.now();
    let admit = { hit: null, all: [] };
    while (Date.now() - tAdmit < ADMIT_MS) {
      admit = await findAdmitControl(host);
      if (admit.hit) break;
      const r = await readRoster(host);
      if (occupied(r).length >= 2) break;   // seated with no prompt is not a failure
      await sleep(700);
    }
    RESULT.steps.admit = { found: admit.hit, waitedMs: Date.now() - tAdmit };
    const hostRosterNow = await readRoster(host);
    if (admit.hit) {
      await shot(host, '3-prompt');
      const clicked = await clickAt(host, admit.hit.box, admit.hit.text);
      const landed = clicked.topmost && (clicked.topmost.id === admit.hit.id ||
        (clicked.topmost.text || '').includes(admit.hit.text));
      RESULT.steps.admit.click = clicked;
      cell(landed, 'the-admit-control-is-REACHABLE-by-a-mouse',
        `pressed "${admit.hit.text}"${admit.hit.id ? ' (#' + admit.hit.id + ')' : ''} at ${clicked.x},${clicked.y}`,
        `a control reading "${admit.hit.text}" exists but the mouse hit ${J(clicked.topmost)} — something covers it`);
      ok('a-human-can-admit-the-joiner', `the host page offered "${admit.hit.text}" and it was pressed with the mouse`);
    } else if (occupied(hostRosterNow).length >= 2) {
      ok('a-human-can-admit-the-joiner', 'no admission was required — the joiner was seated and the host roster shows them');
    } else {
      const names = admit.all.filter((c) => !c.disabled).map((c) => (c.id ? '#' + c.id : '') + '"' + c.text + '"');
      bad('a-human-can-admit-the-joiner',
        `NOTHING ON THE HOST PAGE ADMITS THE JOINER after ${(ADMIT_MS / 1000).toFixed(0)} s. The host roster reads ` +
        `${J(hostRosterNow.rows.map((r) => r.text))} and the only pressable controls were ${J(names)}.`);
    }

    // -- 6. SEATED, WITH A PORT --------------------------------------------
    say('\n-- both sides: what does the room look like from each machine?');
    const tPair = Date.now();
    let hr = null, jr = null;
    while (Date.now() - tPair < PAIR_MS) {
      hr = await readRoster(host); jr = await readRoster(join);
      if (occupied(hr).length >= 2 && occupied(jr).length >= 2) break;
      await sleep(800);
    }
    RESULT.steps.rosters = { host: hr, join: jr, waitedMs: Date.now() - tPair };
    await shot(host, '4-roster'); await shot(join, '4-roster');
    const ho = occupied(hr), jo = occupied(jr);
    say(`  ....  host sees ${ho.length} seat(s): ${J(hr.rows.map((r) => r.text))}`);
    say(`  ....  join sees ${jo.length} seat(s): ${J(jr.rows.map((r) => r.text))}`);
    cell(ho.length >= 2, 'the-hosts-roster-shows-the-joiner',
      `the host's own roster names ${ho.length} players: ${J(ho.map((x) => x.who))}`,
      `the host's roster shows only ${J(ho.map((x) => x.who))} — the person who joined is invisible to the host`);
    cell(jo.length >= 2, 'the-joiners-roster-shows-the-host',
      `the joiner's roster names ${jo.length} players: ${J(jo.map((x) => x.who))}`,
      `the joiner's roster shows only ${J(jo.map((x) => x.who))}`);
    const hPort = hudPort(hr), jPort = hudPort(jr);
    RESULT.steps.ports = { host: hPort, join: jPort };
    cell(hPort != null && jPort != null && hPort !== jPort,
      'each-side-is-told-a-DIFFERENT-maple-port',
      `the host is told port ${hPort} and the joiner port ${jPort} — SEATED, WITH A PORT, straight off the hand-off`,
      `maple ports: host ${J(hPort)}, joiner ${J(jPort)} (read from each page's own HUD text)`);

    // -- 7. GATED ----------------------------------------------------------
    // ⚠ THIS NEEDS A REAL DISC ON BOTH MACHINES: lsArmBeforeFreerun() runs
    // BETWEEN the disc load and {cmd:'freerun',on:1} (dreamcast.html:3861), so
    // there is nothing to arm before a core exists. Opt-in, and VOID rather
    // than FAIL if a disc does not finish — an unmet precondition is not a
    // product fault.
    if (!BOOT) {
      voidc('a-core-in-a-room-is-GATED', 'not requested: pass --boot to load the disc on both machines and measure the frame gate');
      return;
    }
    say(`\n-- both machines load ${GAME} and arm the gate (nobody presses "I'm ready", so the barrier must NOT release)`);
    const deadline = Date.now() + BOOT_MS;
    const booted = [];
    for (const pg of pages) {
      let last = '';
      booted.push(await (async () => {
        while (Date.now() < deadline) {
          const p = await probe(pg).catch(() => null);
          if (p) {
            const l = `${pg.__role} ${p.phase} ${Math.round(100 * (p.discBytes || 0) / (p.discTotal || 1))}%`;
            if (l !== last) { last = l; process.stdout.write('  ....  loading  ' + l + '            \r'); }
            // A core in a room parks at frame 0 on an empty queue until the
            // barrier releases, so "booted with 0 frames" is CORRECT here.
            if (p.booted) return p;
          }
          await sleep(2500);
        }
        return null;
      })());
    }
    process.stdout.write('\n');
    RESULT.steps.booted = booted;
    if (!booted.every(Boolean)) {
      voidc('a-core-in-a-room-is-GATED',
        `not measurable: a disc never finished inside ${(BOOT_MS / 1000).toFixed(0)} s — ${J(booted.map(Boolean))}`);
      return;
    }
    await sleep(6000);
    const g1 = await Promise.all(pages.map(probe));
    await sleep(6000);
    const g2 = await Promise.all(pages.map(probe));
    RESULT.steps.gate = { first: g1, second: g2 };
    say(`  ....  armed ${J(g2.map((p) => p.lockstep && p.lockstep.armed))} · coreFrame ${J(g1.map((p) => p.lockstep && p.lockstep.coreFrame))} -> ${J(g2.map((p) => p.lockstep && p.lockstep.coreFrame))}`);
    await shot(host, '5-gated'); await shot(join, '5-gated');
    const armed = g2.every((p) => p.lockstep && p.lockstep.armed === true);
    cell(armed,
      'a-core-in-a-room-is-GATED',
      `lockstep is ARMED on both machines after the hand-off: ${J(g2.map((p) => p.lockstep && p.lockstep.armed))}`,
      `lockstep is not armed on both: ${J(g2.map((p) => p.lockstep && p.lockstep.fault))} — a core that free-runs ` +
      'in a room desyncs by construction. ⚠ PROVENANCE: THIS IS NOT THE HAND-OFF. Measured with the hand-off ' +
      'removed entirely — plain dreamcast.html, its own "Open a room" and Start buttons, no ?np= and no lobby ' +
      'page — a core that boots before any peer connects reports armed:false with this same fault. Cause: ' +
      'lsArmBeforeFreerun() is called EXACTLY ONCE, between the disc load and {cmd:freerun,on:1} ' +
      '(dreamcast.html:3861), and session.ls does not exist until a peer\'s game channel opens ' +
      '(lib/netplay.js:3029 _onPeerUp -> _ensureLockstep). Whenever the disc finishes first — a warm cache, a ' +
      'lazily-read disc, or simply a host who opens a room and waits — there is no engine to arm against and ' +
      'nothing ever re-arms. It needs a re-arm on the room becoming live, which is a change to the lockstep ' +
      'core and not to this hand-off.');
    // ⚠ THIS CELL IS VOID WHEN THE GATE IS NOT ARMED, AND THE FIRST VERSION OF
    // IT WAS NOT. LS.framesRun counts frames the core reported completing UNDER
    // LOCKSTEP; an unarmed core is not feeding it at all, so it reads 0 for a
    // core that is free-running as hard as it can. That produced a PASS reading
    // "both cores are parked at frame 0" on the very run whose cell above had
    // just failed for not being gated — a counter that cannot move being quoted
    // as evidence that nothing moved.
    if (!armed) {
      voidc('a-gated-core-runs-ZERO-free-running-frames',
        'not measurable: the gate is not armed (see above), and coreFrame only counts frames run UNDER lockstep — ' +
        'it reads 0 for an ungated core too, so it is not evidence of anything here');
    } else {
      cell(g2.every((p) => p.lockstep && p.lockstep.coreFrame === 0),
        'a-gated-core-runs-ZERO-free-running-frames',
        `both cores are parked at frame 0 over 12 s with nobody ready: ${J(g1.map((p) => p.lockstep.coreFrame))} -> ${J(g2.map((p) => p.lockstep.coreFrame))}`,
        `a core ran frames before the barrier released: ${J(g1.map((p) => p.lockstep.coreFrame))} -> ${J(g2.map((p) => p.lockstep.coreFrame))}`);
    }
  } finally {
    RESULT.hostErrors = host.__errs.slice(0, 12);
    RESULT.joinErrors = join.__errs.slice(0, 12);
    RESULT.hostNetLog = host.__net.slice(-40);
    RESULT.joinNetLog = join.__net.slice(-40);
    RESULT.loadEnd = load1();
    if (!KEEP) { for (const b of browsers.splice(0)) { try { await b.close(); } catch (e) {} } }

    RESULT.rec = rec;
    RESULT.loadavgEnd = os.loadavg();
    const pass = rec.filter((r) => r.ok === true).length;
    const fail = rec.filter((r) => r.ok === false);
    const vd   = rec.filter((r) => r.ok === null).length;
    say(`\n${'='.repeat(78)}`);
    say(`  ${pass} pass · ${fail.length} FAIL · ${vd} void   (load ${RESULT.loadavgStart[0].toFixed(2)} -> ${load1()})`);
    if (fail.length) { say('  FAILURES:'); fail.forEach((f) => say(`    ${f.n}`)); }
    say('  ⚠ ONE BOX, ONE NAT — this closes the real-UI gap, not the two-networks gap.');
    const jsonPath = path.join(OUT, NAME + '.json');
    fs.writeFileSync(jsonPath, JSON.stringify(RESULT, null, 2));
    say(`  log ${LOG}\n  json ${jsonPath}`);
    logStream.end();
    process.exitCode = fail.length ? 1 : 0;
  }
})();

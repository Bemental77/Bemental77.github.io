#!/usr/bin/env node
// ============================================================================
// console_room_crossdevice_test.mjs — IS LOCKSTEP NETPLAY REAL ON N64 AND
// GENESIS, IN THE CONFIGURATION A PLAYER IS ACTUALLY IN?
// ============================================================================
//
// THE QUESTION. Both pages ship a lockstep implementation and both have a rig
// that exercises it in ONE browser over a BroadcastChannel (`?net=local`):
// tools/genesis_netplay_test.mjs and n64/tools/lockstep_probe.mjs's `pair` arm.
// Those answer "is the engine wired to the core". They CANNOT answer "would two
// people in two places actually play", because a BroadcastChannel never leaves
// the browser — no signalling broker, no ICE, no data channel, no NAT.
//
// So this rig runs TWO SEPARATE CHROME PROFILES, which cannot see each other's
// BroadcastChannel, and it PROVES that isolation rather than assuming it (the
// `the-two-profiles-are-really-separate` cell). A room that forms anyway can
// only have formed over the shipped signalling path — `['ws','peerjs']`, i.e.
// the MQTT relay plus a real RTCPeerConnection (lib/netplay.js:1039-1047, which
// returns that pair for anything that is not 'local'/'ws'/'peerjs-only'). That
// is the product path, and it is the whole point of this file.
//
// ⚠ WHAT THIS STILL DOES NOT ESTABLISH, said plainly so a PASS is not
// overclaimed. Both profiles are on ONE machine behind ONE NAT, so:
//   * a host-to-host route is never exercised; ICE almost certainly settles on
//     a host candidate and no TURN relay is proven,
//   * both cores share one CPU, one GPU and one Chrome build, so this is a
//     WEAKER determinism test than two devices, and
//   * the GUEST RATE measured here is contended. Two emulators on one box is
//     not the product configuration and a rate below 1.000x measured this way
//     is not evidence of a gate problem (CLAUDE.md gate #9 and the note in the
//     prompt that PS1 read 0.86x two-in-one-browser and 0.9986x alone). The
//     rate is therefore REPORTED but only FAILS above 1.02x — the direction
//     that would mean the gate had become an accelerator, which is the one
//     thing that must never happen.
// Cross-machine play is UNESTABLISHED and this file does not pretend otherwise.
//
// REAL CLICKS ONLY. Every control is pressed with page.mouse.click() at real
// coordinates, and document.elementFromPoint() is asked FIRST what is on top
// there — a covered button is a finding, not something to click through.
// el.click() would fire the handler regardless and hide exactly that class of
// bug, so this file audits ITSELF for it at startup (selfAudit) and refuses to
// run if it has drifted. It also forbids itself from touching the netplay
// engine: no .seat(), .approve(), .setReady(), no constructing a Session. The
// only page JS it evaluates is READ-ONLY state through the pages' own published
// seams, window.__genNet() / window.__n64Net().
//
// NO CLICK STARTS THE GAME. Each console declares itself ready the instant its
// core is gated and the room starts by itself once two are loaded (the user's
// directive of 2026-09-13; the engine never releases with fewer than two
// distinct seated peers — lib/netplay.js _checkBarrier, `info.alone`). So the
// barrier cells assert the ABSENCE of a click (`no-ready-click-was-needed`) and
// that a console declared ahead of its partner HELD rather than started
// (`a-host-alone-never-starts`).
//
// NEVER A NONCE. The engine's own fail strings name peers by PEER ID, and a
// peer id is a 16-hex stableNonce; a page that renders them raw prints exactly
// what the design forbids. The last cell of every arm FREEZES the joiner with
// the debugger, lets the host stall past its budget, and reads the sentence
// each role draws (`a-stall-fail-never-shows-a-nonce`). And on N64 the save
// file has to stay out of the room — `the-saved-game-is-not-loaded-online`
// reads the page's own log line on both roles, because the neuter that was
// supposed to produce it measured 0 lines across three earlier runs.
//
// ARMS
//   warm  — the profile is reused, i.e. the HTTP cache already holds the core
//           and the ROM. This is a returning player.
//   cold  — the profile directory is deleted first. This is a real phone on its
//           first visit, and a sibling has already found a bug on this project
//           that reproduced ONLY cold, so it is a standing arm and not an extra.
//
// USAGE
//   npm run web                                     # port 8080, CLAUDE.md gate #2
//   node tools/browser_leak_guard.js reap && uptime # before any measured run
//   bash tools/probe_lock.sh run -- node tools/console_room_crossdevice_test.mjs
//
// FLAGS
//   --console n64,genesis   which consoles to run   (default both)
//   --arms warm,cold        which profile arms      (default both)
//   --url BASE              default http://localhost:8080
//   --seconds N             play seconds per arm    (default 10)
//   --name N                basename under /tmp/console-xdev (default xdev)
//   --headful               show the windows
//   --keep                  leave the browsers open at the end
// ============================================================================

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(__filename), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const BASE = arg('url', 'http://localhost:8080').replace(/\/$/, '');
const SECONDS = +arg('seconds', 10);
const NAME = arg('name', 'xdev');
const HEADFUL = has('headful');
const KEEP = has('keep');
const OUT = '/tmp/console-xdev';
const PROFBASE = '/private/tmp/claude-501/console-xdev';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(OUT, { recursive: true });
const logPath = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const T0 = Date.now();
const say = (s) => {
  const line = '[' + ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's] ' + s;
  console.log(line);
  try { logStream.write(line + '\n'); } catch (e) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load1 = () => {
  try { return +execSync('uptime').toString().match(/load averages?: ([\d.]+)/)[1]; }
  catch (e) { return null; }
};

// ---------------------------------------------------------------------------
// SELF-AUDIT. The value of this rig is that it cannot cheat, so that is
// mechanically enforced rather than promised. If any of these appear in this
// file outside a line marked /*selfaudit-allow*/ the run aborts.
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  '.approve(', '.deny(', '.setReady(', '.seat(', '.startLockstep(',   /*selfaudit-allow*/
  'new Netplay', 'NET.session', '__genNetForce', '__n64NetForce',     /*selfaudit-allow*/
];
function selfAudit() {
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  const hits = [];
  src.forEach((line, i) => {
    if (line.includes('selfaudit-allow')) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;          // prose may name them
    for (const f of FORBIDDEN) if (line.includes(f)) hits.push((i + 1) + ': ' + f);
  });
  // el.click() is the one that matters most and it is checked separately, so
  // the message can say why rather than just naming a string.
  src.forEach((line, i) => {
    if (line.includes('selfaudit-allow')) return;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/\.click\(\)/.test(line) && !/mouse\.click/.test(line)) {        /*selfaudit-allow*/
      hits.push((i + 1) + ': a direct DOM click — a real mouse click is the point of this rig');
    }
  });
  if (hits.length) {
    console.error('SELF-AUDIT FAILED — this rig has started driving the page instead of using it:');
    hits.forEach((h) => console.error('  ' + h));
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
const RESULT = {
  when: new Date().toISOString(), origin: BASE, seconds: SECONDS,
  uptimeStart: (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return null; } })(),
  limits: [
    'both profiles are on ONE machine behind ONE NAT — no cross-machine route is proven',
    'the guest rate here is CONTENDED (two emulators, one box) and fails only ABOVE 1.02x',
    'a PASS is necessary, not sufficient, for two physical devices',
  ],
  cells: [], arms: {},
};
let ARM = '';
const cell = (good, name, detail) => {
  RESULT.cells.push({ arm: ARM, name, ok: !!good, detail });
  say((good ? '  PASS  ' : '  FAIL  ') + name + '  ' + detail);
  return !!good;
};
const voidc = (name, detail) => {
  RESULT.cells.push({ arm: ARM, name, ok: null, detail });
  say('  VOID  ' + name + '  ' + detail);
};

// ---------------------------------------------------------------------------
// Real clicking. elementFromPoint FIRST — see the header.
// ---------------------------------------------------------------------------
async function clickReal(page, sel, what) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { why: 'no such control' };
    if (el.disabled) return { why: 'the control is disabled' };
    if (el.getAttribute('aria-disabled') === 'true') return { why: 'aria-disabled (the capability layer is holding it)' };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { why: 'the control has no box (hidden)' };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    if (top !== el && !el.contains(top) && !(top && top.contains(el))) {
      return { why: 'covered by <' + (top ? top.tagName.toLowerCase() : 'nothing') + '>' };
    }
    return { x, y };
  }, sel);
  if (box.why) return { clicked: false, why: box.why };
  await page.mouse.click(box.x, box.y);
  return { clicked: true };
}

async function typeReal(page, sel, text) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { why: 'no such field' };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { why: 'the field has no box' };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (box.why) return { typed: false, why: box.why };
  await page.mouse.click(box.x, box.y);
  await page.keyboard.type(text, { delay: 45 });
  return { typed: true };
}

async function waitFor(page, fn, ms, what, a) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn, a); } catch (e) { /* navigating */ }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
}

// Press Allow the way a person would, as soon as it appears. Started BEFORE the
// joiner can ask: the dialog is transient (the guest gives up on its own), so a
// watcher armed after the fact races it and loses. This exact gap made
// n64/tools/lockstep_probe.mjs's pair arm fail 0/2 with "timed out waiting for
// host core to arm", which reads like a dead core and is not.
function admitWatcher(page, tag) {
  const h = { approved: false, why: null, stop: false };
  (async () => {
    while (!h.stop && !h.approved) {
      try {
        const r = await clickReal(page, '#npApproveAllow');
        if (r.clicked) { h.approved = true; say('  [' + tag + '] pressed Allow — the joiner is admitted'); break; }
        if (r.why && r.why !== 'no such control') h.why = r.why;
      } catch (e) { /* navigation between polls */ }
      await sleep(200);
    }
  })();
  return h;
}

// ---------------------------------------------------------------------------
// THE ONE-DECLARED WINDOW. "A console alone never starts" can only be asserted
// while exactly one console has declared and the other has not, so both seams
// are sampled every 50 ms from the moment a boot can begin and the FIRST sample
// in which exactly one side is declared is kept, with what that side was doing.
// `party.declared` is the page's own statement that it called setReady
// (n64/index.html lsParty); a page that publishes no `party` yet is read through
// the engine's declaredReady (lib/netplay.js report()) — the same fact from the
// other side — so the cell is honest on both consoles. Read-only, like every
// other evaluate in this file.
// ---------------------------------------------------------------------------
const declaredOf = (n) => !!(n && ((n.party && n.party.declared) || (n.engine && n.engine.declaredReady)));
function windowWatcher(pages, seam, ui) {
  const h = { stop: false, first: null, order: [], done: false };
  (async () => {
    while (!h.stop) {
      let a = null, b = null;
      try { [a, b] = await Promise.all([netState(pages.host, seam), netState(pages.join, seam)]); } catch (e) {}
      const dh = declaredOf(a), dj = declaredOf(b);
      if (dh && !h.order.includes('host')) h.order.push('host');
      if (dj && !h.order.includes('join')) h.order.push('join');
      if (!h.first && dh !== dj) {
        h.first = { at: Date.now(), declared: dh ? 'host' : 'join',
          host: { declared: dh, running: !!(a && a.running), frame: (a && a.frame) | 0, party: (a && a.party) || null },
          join: { declared: dj, running: !!(b && b.running), frame: (b && b.frame) | 0, party: (b && b.party) || null } };
        // The DOM is read at once — n64/index.html draws the panel in the same
        // breath it sets `declared` — and, where that read is not yet the
        // loading sentence (a page that only redraws on its 400 ms tick), once
        // more after a tick, but only while the window is still open: a read
        // inside the tick is the PREVIOUS state's words, and it measured
        // exactly that ("waiting for host (you), player 2" with the host
        // already declared on the seam). A stale read is discarded, never
        // asserted; an unread window VOIDs that half of the cell.
        const lone = dh ? 'host' : 'join';
        const fresh = (u) => !!(u && / · loading$/.test(u.button || '') && /^Starts by itself when everyone is loaded/.test(u.msg || ''));
        try { [h.first.host.ui, h.first.join.ui] = await Promise.all([partyUi(pages.host, ui), partyUi(pages.join, ui)]); } catch (e) {}
        if (!fresh(h.first[lone].ui)) {
          await sleep(450);
          let a2 = null, b2 = null;
          try { [a2, b2] = await Promise.all([netState(pages.host, seam), netState(pages.join, seam)]); } catch (e) {}
          if (declaredOf(a2) !== declaredOf(b2)) {
            try { [h.first.host.ui, h.first.join.ui] = await Promise.all([partyUi(pages.host, ui), partyUi(pages.join, ui)]); } catch (e) {}
          } else { h.first.host.ui = null; h.first.join.ui = null; }
        }
      }
      if (dh && dj) { h.done = true; break; }
      await sleep(50);
    }
  })();
  return h;
}

// ---------------------------------------------------------------------------
// THE TWO CONSOLES. Everything that differs between them lives here, so the
// body of the test below is one code path and cannot drift between consoles.
// ---------------------------------------------------------------------------
const CONSOLES = {
  genesis: {
    label: 'Genesis',
    // Two controller ports, and that is the CORE's answer, not this file's:
    // Genesis-Plus-GX sets input.system[0]=input.system[1]=SYSTEM_GAMEPAD
    // (~/gpgx-src/libretro/libretro.c:1035-1036) and the shim never calls
    // retro_set_controller_port_device, which is the only thing that would swap
    // in a TEAMPLAYER/WAYPLAY multitap for four.
    ports: 2,
    seam: '__genNet',
    padBytes: 2,
    // 'a' -> RETRO_DEVICE_ID_JOYPAD_B == bit 1 (genesis.html BIT.b = 0,
    // BIT.a = 1; the page's `a` key is the MD "A" button).
    key: 'a', bit: 1,
    url: () => BASE + '/genesis.html',
    // The room is formed ON the emulator page.
    openHost: async (p) => {
      const a = await clickReal(p, '#btnNet');
      if (!a.clicked) return a;
      await sleep(300);
      return await clickReal(p, '#netHostBtn');
    },
    readCode: (p) => waitFor(p, () => {
      const t = (document.getElementById('netCode') || {}).textContent || '';
      return /^[A-HJ-NP-Z2-9]{5}$/.test(t.trim()) ? t.trim() : null;
    }, 30000),
    openJoin: async (p, code) => {
      const a = await clickReal(p, '#btnNet');
      if (!a.clicked) return a;
      await sleep(300);
      const b = await clickReal(p, '#netJoinBtn');
      if (!b.clicked) return b;
      await sleep(300);
      const t = await typeReal(p, '#netCodeIn', code);
      if (!t.typed) return { clicked: false, why: t.why };
      return await clickReal(p, '#netGo');
    },
    // ⚠ BOTH PLAYERS PRESS START, AND THAT IS THE PRODUCT. Under lockstep a
    // joiner runs their OWN console and must start it; the page says so on
    // connect ("Press Start when you are both ready"). Arming happens inside
    // bootRom() between gpx_load() and `running = true` (genesis.html:965), so
    // without this the core never boots and never arms — which is exactly what
    // this rig measured on its first run, and it reads like a dead core.
    // ⚠ AND THE PANEL HAS TO BE CLOSED FIRST, which this rig learned the hard
    // way: pressing Start with the room panel still up reported
    // "covered by <div>" — #netOverlay sits over the page. That is the
    // elementFromPoint guard doing its job. A player closes the panel the same
    // way, so the rig does too rather than clicking through it.
    closeFirst: '#netClose',
    start: '#btnStart',
    // The one control and the one sentence, read as TEXT (see partyUi).
    ui: { button: '#btnNet', msg: '#netBarrier' },
    // Genesis declares itself ready from inside lsArmBeforeFreerun
    // (genesis.html:753-779) — there is no Ready button to press. Kept as a
    // field so a console that grows one again is a visible edit here.
    ready: null,
    // No save memory reaches a Genesis room's core, so there is no line to
    // read; the cell is skipped, not voided (nothing is missing from the rig).
    bootLog: null,
  },
  n64: {
    label: 'N64',
    // FOUR, and again from the core: NEILNUMCONTROLLERS is 4
    // (n64/N64Wasm/code/neil_controller.h:27) and the core presents all four
    // from boot — `int pad_present[4] = { 1, 1, 1, 1 }`
    // (n64/N64Wasm/code/src/libretro/libretronew.c:179), whose own comment says
    // they must all be present from the beginning or some games never see them.
    ports: 4,
    seam: '__n64Net',
    padBytes: 4,
    // 'm' -> A button, bit 4 (n64/index.html LS_KEYMAP a:['m'], LSN.a = 4).
    key: 'm', bit: 4,
    // The N64 room is minted on the LOBBY page, which then navigates both
    // players to /n64/?np=CODE. That is the only path a player has, so it is
    // the path this drives.
    url: () => BASE + '/n64_multiplayer.html',
    openHost: async (p) => await clickReal(p, '#btnHost'),
    readCode: (p) => waitFor(p, () => {
      const t = (document.getElementById('code') || {}).textContent || '';
      return /^[A-HJ-NP-Z2-9]{5}$/.test(t.trim()) ? t.trim() : null;
    }, 30000),
    // The host presses "Go" and is navigated to the emulator page.
    hostGo: async (p) => await clickReal(p, '#btnGo'),
    openJoin: async (p, code) => {
      const a = await clickReal(p, '#btnJoinPane');
      if (!a.clicked) return a;
      await sleep(300);
      const t = await typeReal(p, '#codeIn', code);
      if (!t.typed) return { clicked: false, why: t.why };
      return await clickReal(p, '#btnJoin');
    },
    ui: { button: '#btnNet', msg: '#lsMsg' },
    // Nothing to press: n64/index.html presses its own Start once the room
    // reports `connected`, because the room is deliberately formed BEFORE
    // anything boots (an earlier cut that booted in parallel had the WebRTC
    // handshake fail every time, the host being busy instantiating a 12 MB ROM).
    start: null,
    // ⚠ NO READY CONTROL ANY MORE, ON PURPOSE. n64/index.html declares by
    // itself the instant lsArmBeforeBoot() gates the core; the failure its old
    // button existed to prevent (an earlier auto-ready let the first machine to
    // boot pass the barrier alone with an empty roster) is closed in the
    // engine, which never releases with fewer than two distinct seated peers
    // (lib/netplay.js _checkBarrier, `info.alone`). A rig that looked for a
    // button here would be testing a path no player has.
    ready: null,
    // The page's own word that dist/script.js's LoadSram was NOT allowed to
    // write this browser's <rom>.sram into /game.savememory before callMain
    // (n64/index.html neuterSram). Read from the console on both roles.
    bootLog: '[lockstep] saved game NOT loaded',
  },
};

// Read-only state, through the page's own seam. Never a private.
const netState = (page, seam) => page.evaluate((s) => {
  try { return window[s] ? window[s]() : null; } catch (e) { return { error: String(e) }; }
}, seam);
// What the page DRAWS — the one control's text and the one sentence — because
// a seam can be right while the pixels say "Press Ready". Null where the page
// has no such element, which VOIDs the cell rather than failing it.
const partyUi = (page, ui) => page.evaluate((u) => {
  const t = (sel) => { const el = sel && document.querySelector(sel); return el ? (el.textContent || '').trim() : null; };
  return { button: t(u && u.button), msg: t(u && u.msg) };
}, ui || null).catch(() => ({ button: null, msg: null }));
// The row vocabulary, exactly (n64/index.html lsParty; the design every page
// converges on). Anything else on a row — a nonce, "in", "—" — fails.
const ROW_STATE = /^(connecting|loading \d{1,3}%|loaded|ready|playing|disconnected|open)$/;
const rowsOk = (p) => !!(p && Array.isArray(p.rows) && p.rows.length && p.rows.every((r) =>
  ROW_STATE.test(String(r.state)) && (r.who === 'host' || r.who === 'player' || r.who === null)));

// ---------------------------------------------------------------------------
// One arm: one console, one profile temperature.
// ---------------------------------------------------------------------------
async function runArm(consoleName, temp) {
  const C = CONSOLES[consoleName];
  ARM = consoleName + '/' + temp;
  say('');
  say('=== ' + C.label + ' — ' + temp + ' profile — two separate Chrome profiles, real signalling ===');
  const detail = { load: load1() };
  const browsers = [];
  const pages = {};
  let watch = null, throttle = null;
  const releaseThrottle = async () => {
    const t = throttle; throttle = null;
    if (!t) return;
    try { await t.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch (e) {}
    try { await t.detach(); } catch (e) {}
  };

  const launch = async (role) => {
    const dir = path.join(PROFBASE, consoleName, role);
    if (temp === 'cold') {
      // A cold profile is what a real phone is on its first visit. Deleting the
      // directory drops the HTTP cache, IndexedDB and the service worker, so
      // the core and the ROM are fetched again from scratch.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
    fs.mkdirSync(dir, { recursive: true });
    const b = await puppeteer.launch({
      headless: HEADFUL ? false : 'new',
      executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
      userDataDir: dir,
      args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
             '--disable-background-timer-throttling',
             '--disable-backgrounding-occluded-windows',
             '--disable-renderer-backgrounding',
             '--autoplay-policy=no-user-gesture-required',
             '--disk-cache-size=2147483648'],
    });
    browsers.push(b);
    try {
      const g = (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default;
      g.guard(b, 'console_room_crossdevice_test');
    } catch (e) { say('  ⚠ leak-guard registration FAILED: ' + e.message); }
    const p = (await b.pages())[0] || await b.newPage();
    await p.setViewport({ width: 1280, height: 860 });
    // A backgrounded window gets no rAF and would run zero frames, which would
    // make every later cell a statement about this harness.
    try {
      const cdp = await p.target().createCDPSession();
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (e) {}
    p.on('pageerror', (e) => { (detail.pageErrors ||= []).push('[' + role + '] ' + e.message); });
    p.on('console', (m) => {
      const t = m.text();
      if (/lockstep|desync|\[net\]/i.test(t)) (detail.netLog ||= []).push('[' + role + '] ' + t);
    });
    return p;
  };

  try {
    pages.host = await launch('host');
    pages.join = await launch('join');

    // ---- 0. THE TWO PROFILES REALLY ARE SEPARATE -------------------------
    // Everything this rig claims rests on this. If a BroadcastChannel DID cross
    // them, the room could have formed without any signalling broker at all and
    // the run would prove nothing about the product path.
    await pages.host.goto(C.url(), { waitUntil: 'domcontentloaded' });
    await pages.join.goto(C.url(), { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const listening = pages.host.evaluate(() => new Promise((res) => {
      const ch = new BroadcastChannel('xdev-isolation');
      let heard = false;
      ch.onmessage = () => { heard = true; };
      setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 2000);
    }));
    await sleep(200);
    await pages.join.evaluate(() => {
      const ch = new BroadcastChannel('xdev-isolation');
      ch.postMessage('ping');
      setTimeout(() => { try { ch.close(); } catch (e) {} }, 500);
    });
    const crossed = await listening;
    if (!cell(!crossed, 'the-two-profiles-are-really-separate',
      crossed ? 'a BroadcastChannel CROSSED the two profiles — this is not a cross-device test'
              : 'no BroadcastChannel crosses them, so any room that forms used the shipped ws/peerjs signalling')) {
      return detail;
    }

    // ---- 0b. THE ONE-DECLARED WINDOW IS WATCHED FROM HERE ----------------
    // Armed BEFORE the room forms. See windowWatcher; a page still navigating
    // (the N64 pair moves lobby -> emulator in step 1) simply reads as not
    // declared until it is there.
    watch = windowWatcher(pages, C.seam, C.ui);
    // ⚠ A CONSOLE THAT PRESSES ITS OWN START BOOTS BOTH SIDES AT THE SAME
    // INSTANT — `connected` fires on both ends of one data channel — so the
    // window in which the host is declared and the joiner is not is a race
    // between two boots on one box, i.e. sometimes unobservable. The joiner is
    // therefore made the slower device until the window has been seen (CDP CPU
    // throttling, the lever a slow phone is emulated with). It slows the
    // JOINER's JS only; nothing in either page is driven. Armed here and not
    // after admission because Genesis starts itself the instant `connected`
    // fires — within the admission poll — and a throttle applied after the
    // Allow click landed on a joiner that had already booted (VOID, measured).
    try {
      throttle = await pages.join.target().createCDPSession();
      await throttle.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      (async () => {
        while (watch && !watch.first && !watch.done && !watch.stop) await sleep(50);
        await releaseThrottle();
      })();
    } catch (e) { throttle = null; say('  ⚠ could not throttle the joiner: ' + e.message); }

    // ---- 1. THE HOST OPENS A ROOM, THE JOINER TYPES THE CODE -------------
    const admit = admitWatcher(pages.host, 'host');
    const oh = await C.openHost(pages.host);
    if (!cell(oh.clicked, 'host-can-open-a-room', oh.clicked ? 'pressed the real Host control' : ('could not press Host: ' + oh.why))) return detail;
    const code = await C.readCode(pages.host);
    if (!cell(!!code, 'the-page-mints-a-room-code', code ? ('code ' + code) : 'no code appeared')) return detail;
    detail.code = code;

    const oj = await C.openJoin(pages.join, code);
    if (!cell(oj.clicked, 'joiner-can-submit-the-code', oj.clicked ? 'typed the code and pressed Join for real' : ('could not join: ' + oj.why))) return detail;

    // N64 only: the host is still on the lobby and must press Go to be taken to
    // the emulator. The joiner's own Join already navigated it.
    if (C.hostGo) {
      await sleep(400);
      const g = await C.hostGo(pages.host);
      cell(g.clicked, 'host-reaches-the-emulator-page', g.clicked ? 'pressed Go on the lobby' : ('could not press Go: ' + g.why));
    }

    // ---- 2. ADMISSION IS A HUMAN DECISION --------------------------------
    const admitDeadline = Date.now() + 90000;
    while (Date.now() < admitDeadline && !admit.approved) await sleep(250);
    const admitted = admit.approved;
    if (!cell(admitted, 'the-host-is-asked-to-admit-the-joiner',
      admitted ? 'the Allow dialog appeared and a real click accepted it'
               : ('no Allow dialog was ever pressable' + (admit.why ? ' — ' + admit.why : '')))) {
      detail.netLogTail = (detail.netLog || []).slice(-25);
      return detail;
    }

    // ---- 2b. BOTH PLAYERS START THEIR OWN CONSOLE ------------------------
    // Only where the page asks for it. This is the line that made the old page
    // two-machines-one-emulator when it was missing: under streaming a guest
    // had no emulator and Start was disabled for them.
    // ⚠ HOST FIRST, JOINER ONLY ONCE THE HOST HAS DECLARED. On a console whose
    // Start is a click, the rig's order IS the one-declared window: the host
    // boots, declares by itself and is seen HOLDING before the joiner's console
    // is even started. A page that presses its own Start (the directive:
    // loading starts by itself once two are seated) leaves nothing to click,
    // and that is recorded as what it is, not as a failure to click.
    if (C.start) {
      if (C.closeFirst) {
        for (const role of ['host', 'join']) {
          const r = await clickReal(pages[role], C.closeFirst);
          if (!r.clicked) say('  [' + role + '] could not close the room panel: ' + r.why);
        }
        await sleep(300);
      }
      const startOwn = async (role) => {
        // Wait for the control to be live — the ROM list has to be in before
        // the page enables it — or for the page to have started by itself.
        const r = await waitFor(pages[role], (a) => {
          const n = window[a.seam] && window[a.seam]();
          if (n && n.armed) return { own: true };
          const b = document.querySelector(a.sel);
          return (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') ? { own: false } : null;
        }, 60000, role + ' Start to become pressable', { sel: C.start, seam: C.seam });
        if (r && r.own) { cell(true, role + '-start-was-pressed-by-the-page', 'the page pressed its own Start — nothing for a person to click'); return; }
        const c = await clickReal(pages[role], C.start);
        if (!c.clicked && /disabled/.test(c.why || '')) {
          const own = await waitFor(pages[role], (s) => { const n = window[s] && window[s](); return (n && n.armed) ? true : null; },
                                    15000, role + ' page-pressed Start to arm', C.seam);
          if (own) { cell(true, role + '-start-was-pressed-by-the-page', 'Start was already taken by the page itself under the rig\'s click, and the core armed'); return; }
        }
        cell(c.clicked, role + '-pressed-Start-for-real',
          c.clicked ? 'a real click on this console\'s own Start' : ('could not press Start: ' + c.why));
      };
      await startOwn('host');
      const held = await waitFor(pages.host, (s) => {
        const n = window[s] && window[s]();
        const d = !!(n && ((n.party && n.party.declared) || (n.engine && n.engine.declaredReady)));
        return d ? { running: !!n.running, frame: n.frame | 0 } : null;
      }, 300000, 'host to declare by itself', C.seam);
      if (held) say('  [host] declared by itself, running=' + held.running + ' frame=' + held.frame + ' — starting the joiner now');
      else say('  [host] never declared — starting the joiner anyway so step 3 can name the failure');
      await startOwn('join');
    }

    // ---- 3. BOTH CORES ARM BEFORE EITHER RUNS A FRAME --------------------
    const armedState = {};
    const armedAt = (s) => (s && s.armedAtFrame != null) ? (s.armedAtFrame | 0) : (s.frame | 0);
    for (const role of ['host', 'join']) {
      const st = await waitFor(pages[role], (s) => {
        const n = window[s] && window[s]();
        return (n && n.armed) ? n : null;
      }, 300000, role + ' core to arm', C.seam);
      if (!cell(!!st, role + '-core-armed-the-frame-gate',
        st ? ('armed with the core at frame ' + armedAt(st) + (st.armedAtFrame != null ? ' (latched at arming)' : ' (sampled — this page latches nothing)')) : 'never armed')) {
        detail.netLogTail = (detail.netLog || []).slice(-25);
        return detail;
      }
      armedState[role] = st;
    }
    // ⚠ ASSERT ON THE LATCHED VALUE, NOT A SAMPLED ONE. This read `s.frame`,
    // which the seam reports LIVE — so it measured the frame at the moment this
    // rig happened to poll, not the frame at the moment the gate closed. The
    // joiner arms second, so if the host is already ready the barrier releases
    // immediately and the joiner's core legitimately advances before the next
    // poll lands. That produced `frames at the moment of arming: host 0, join 2`
    // against a console that had done nothing wrong, intermittently — which is
    // exactly what a race between a poll interval and a barrier release looks
    // like. The page now latches the frame AT arming (`armedAtFrame`), a value
    // that cannot drift. Falls back to the old field where a page does not
    // publish it yet, so this stays honest rather than silently vacuous.
    cell(Object.values(armedState).every((s) => armedAt(s) === 0),
      'no-frame-ran-before-the-gate-closed',
      'frames at the moment of arming: host ' + armedAt(armedState.host) + ', join ' + armedAt(armedState.join));

    // ---- 4. THE START BARRIER — NOBODY PRESSES ANYTHING ------------------
    // Both sides must see two seated ports first, so what follows is a
    // statement about a room of two and not about one machine.
    for (const role of ['host', 'join']) {
      await waitFor(pages[role], (s) => {
        const n = window[s] && window[s]();
        const ports = n && n.engine && n.engine.ports;
        return (ports && ports.filter((p) => p.peer).length >= 2) ? true : null;
      }, 120000, role + ' to see both seats', C.seam);
    }
    // Each console declared BY ITSELF (see declaredOf), and there is no
    // #netReady on either page — the control this rig used to press.
    const declared = {};
    for (const role of ['host', 'join']) {
      declared[role] = await waitFor(pages[role], (s) => {
        const n = window[s] && window[s]();
        const d = !!(n && ((n.party && n.party.declared) || (n.engine && n.engine.declaredReady)));
        return d ? { via: (n.party && n.party.declared) ? 'party.declared' : 'engine.declaredReady',
                     button: !!document.getElementById('netReady') } : null;
      }, 120000, role + ' to declare by itself', C.seam);
    }
    const anyButton = !!((declared.host && declared.host.button) || (declared.join && declared.join.button));
    cell(!!declared.host && !!declared.join && !anyButton,
      'no-ready-click-was-needed',
      'host ' + (declared.host ? 'declared (' + declared.host.via + ')' : 'NEVER declared')
      + ', join ' + (declared.join ? 'declared (' + declared.join.via + ')' : 'NEVER declared')
      + ' — this rig clicked nothing, and #netReady ' + (anyButton ? 'STILL EXISTS' : 'does not exist'));

    // ---- 4b. THE SAVE FILE STAYS OUT OF THE ROOM ---------------------------
    // N64 only. dist/script.js's LoadSram writes THIS browser's <rom>.sram into
    // /game.savememory before callMain, so two peers with different saves boot
    // into different guest state — a frame-0 prerequisite. The page's neuter
    // used to be installed from startSession, before window.myApp existed, and
    // so did nothing: 0 occurrences of its log line in n64.json, n64-warm.json
    // and n64-verify.json while other [lockstep] lines were captured fine. It
    // is installed from window.postLoad now; both roles must say so. By this
    // point both cores have declared, which is after their LoadSram ran.
    if (C.bootLog) {
      const seen = (role) => (detail.netLog || []).some((l) => l.startsWith('[' + role + '] ') && l.includes(C.bootLog));
      cell(seen('host') && seen('join'), 'the-saved-game-is-not-loaded-online',
        'log line "' + C.bootLog + '": host ' + (seen('host') ? 'yes' : 'NO') + ', join ' + (seen('join') ? 'yes' : 'NO'));
    }

    // ---- 5. BOTH CONSOLES ACTUALLY ADVANCE -------------------------------
    const running = {};
    for (const role of ['host', 'join']) {
      const st = await waitFor(pages[role], (s) => {
        const n = window[s] && window[s]();
        return (n && n.frame > 0) ? n : null;
      }, 180000, role + ' to pass the barrier', C.seam);
      running[role] = st;
      if (!cell(!!st, role + '-passed-the-start-barrier', st ? ('running at frame ' + st.frame) : 'never ran a frame')) {
        detail.netLogTail = (detail.netLog || []).slice(-25);
        return detail;
      }
    }

    // ---- 5b. A HOST ALONE NEVER STARTS -----------------------------------
    // The first sample in which exactly one console had declared (see
    // windowWatcher): that console must have been HOLDING — not running, at
    // frame 0 — and both are running now that the other has loaded. VOID, not
    // PASS, when the window was never seen: an unobserved window proves
    // nothing either way.
    if (watch) watch.stop = true;
    await releaseThrottle();
    const w = watch && watch.first;
    if (!w) {
      voidc('a-host-alone-never-starts',
        'both consoles declared within one 50 ms poll of each other, so no sample caught one declared and the other not — nothing to assert');
    } else {
      const lone = w[w.declared], other = w[w.declared === 'host' ? 'join' : 'host'];
      const otherRow = other.party && other.party.rows ? other.party.rows.filter((r) => r.local).map((r) => r.state).join('/') : null;
      cell(!lone.running && lone.frame === 0 && running.host.frame > 0 && running.join.frame > 0,
        'a-host-alone-never-starts',
        w.declared + ' declared first while the ' + (w.declared === 'host' ? 'joiner' : 'host') + ' had not'
        + (otherRow != null ? ' (its own row read "' + otherRow + '")' : '')
        + (lone.party ? (lone.party.alone ? ' and was not even seated' : ' — seated but not loaded') : '')
        + ' — the ' + w.declared + ' was ' + (lone.running ? 'RUNNING' : 'holding') + ' at frame ' + lone.frame
        + '; then the other loaded and both ran (host ' + running.host.frame + ', join ' + running.join.frame + ')');
      detail.window = { declaredFirst: w.declared, lone: { running: lone.running, frame: lone.frame }, otherRow, order: watch.order.slice() };
    }

    // ---- 5c. THE PAGE SAYS SO, IN THE WORDS THE DESIGN FIXES ---------------
    // The control reads "Party · CODE · seated/ports · state" and the sentence
    // is one of the three, read from the DOM at two moments: the one-declared
    // sample (state must be `loading`, sentence "Starts by itself when everyone
    // is loaded — waiting for <who>.") and now, running (state `playing`,
    // sentence "Playing — everyone started together at frame N."). Every row
    // state on the seam is from the fixed vocabulary at both moments.
    // The panel ticks every 400 ms and a room that has just released stalls
    // for a frame or two while the slower core catches up, so this is polled
    // for up to 3 s and the LAST read is asserted on.
    let nowUi = null, nowNet = null;
    for (let i = 0; i < 12; i++) {
      nowUi = await partyUi(pages.host, C.ui); nowNet = await netState(pages.host, C.seam);
      if (nowUi.button && / · playing$/.test(nowUi.button) && /^Playing — everyone started together at frame \d+\.$/.test(nowUi.msg || '')) break;
      await sleep(250);
    }
    if (!C.ui || nowUi.button == null || nowUi.msg == null) {
      voidc('the-party-control-and-sentence-read-the-room',
        'this page has no ' + JSON.stringify(C.ui) + ' to read — the vocabulary cannot be checked from the DOM');
    } else {
      const codeRe = detail.code ? detail.code.replace(/[^A-Z0-9]/g, '') : '[A-HJ-NP-Z2-9]{5}';
      const playingBtn = new RegExp('^Party · ' + codeRe + ' · 2/' + C.ports + ' · playing$');
      // Anchored at the front only: a mid-game stall is APPENDED to this
      // sentence by the page ("… at frame 0. Waiting for player 2…").
      const playingMsg = /^Playing — everyone started together at frame \d+\./;
      const loadingBtn = new RegExp('^Party · ' + codeRe + ' · 2/' + C.ports + ' · loading$');
      const loadingMsg = /^Starts by itself when everyone is loaded — waiting for (host|player \d)( \(you\))?\.$/;
      const wu = w && w[w.declared].ui;
      const atWindow = wu ? (loadingBtn.test(wu.button || '') && loadingMsg.test(wu.msg || '')) : null;
      const rowsNow = rowsOk(nowNet && nowNet.party);
      const rowsThen = w ? rowsOk(w[w.declared].party) : null;
      cell(playingBtn.test(nowUi.button) && playingMsg.test(nowUi.msg) && rowsNow && atWindow !== false && rowsThen !== false,
        'the-party-control-and-sentence-read-the-room',
        'now: button "' + nowUi.button + '", sentence "' + nowUi.msg + '"'
        + ', rows ' + JSON.stringify((nowNet && nowNet.party && nowNet.party.rows || []).map((r) => (r.who || 'open') + ':' + r.state))
        + (wu ? ' · at the one-declared sample: button "' + wu.button + '", sentence "' + wu.msg + '"' : ' · (no one-declared sample to read)'));
    }

    const t0 = Date.now();
    const before = { host: running.host.frame, join: running.join.frame };
    await sleep(SECONDS * 1000);
    const after = {};
    for (const role of ['host', 'join']) after[role] = await netState(pages[role], C.seam);
    const elapsed = (Date.now() - t0) / 1000;

    cell(after.host.frame > before.host && after.join.frame > before.join,
      'both-consoles-advance-together',
      'host ' + before.host + '->' + after.host.frame + ', join ' + before.join + '->' + after.join.frame
      + ' over ' + elapsed.toFixed(1) + ' s');

    // ---- 6. THE DESYNC CHECK IS ON, AND COMPARING ------------------------
    // `armed` alone only means gated. A gated room with nothing comparing the
    // two simulations diverges silently, which is worse than not gating at all.
    cell((after.host.hashes | 0) > 0 && (after.join.hashes | 0) > 0,
      'fingerprints-are-being-produced',
      'host fed ' + (after.host.hashes | 0) + ', join fed ' + (after.join.hashes | 0));
    // ⚠ VOID, NOT FAIL, WHEN THE PAGE PUBLISHES NO ENGINE REPORT. A missing
    // field is a rig limitation and must not read as a broken desync detector:
    // this cell FAILED once for exactly that reason before genesis.html grew an
    // `engine` field, and a false FAIL here would have sent somebody hunting a
    // bug in lib/netplay.js that was not there.
    const eh = after.host.engine, ej = after.join.engine;
    const cmp = { host: (eh && eh.hashesCompared) | 0, join: (ej && ej.hashesCompared) | 0 };
    if (!eh || !ej) {
      voidc('the-desync-check-is-ON-and-comparing',
        'this page publishes no engine report, so whether any fingerprint was COMPARED cannot be read from outside');
    } else {
      cell(cmp.host > 0 || cmp.join > 0,
        'the-desync-check-is-ON-and-comparing',
        'hashesCompared host=' + cmp.host + ' join=' + cmp.join + ' — a room where this is 0 is gated but unchecked');
    }
    const desync = (after.host.engine && after.host.engine.desync) || (after.join.engine && after.join.engine.desync);
    cell(!desync, 'no-desync', desync ? ('DIVERGED: ' + JSON.stringify(desync)) : 'the two simulations still agree');
    cell(!after.host.fault && !after.join.fault,
      'neither-console-reports-a-fault',
      'host fault=' + JSON.stringify(after.host.fault) + ' join fault=' + JSON.stringify(after.join.fault));

    // ---- 7. PORTS ---------------------------------------------------------
    const ph = (after.host.engine && after.host.engine.localPorts) || after.host.localPorts || [];
    const pj = (after.join.engine && after.join.engine.localPorts) || after.join.localPorts || [];
    const portCount = (after.host.engine && after.host.engine.portCount) || after.host.ports;
    cell(portCount === C.ports, 'the-room-seats-the-consoles-own-port-count',
      'portCount=' + portCount + ' — this console has ' + C.ports);
    cell(ph.length && pj.length && ph[0] !== pj[0],
      'each-player-holds-a-different-port', 'host=port ' + ph[0] + ', join=port ' + pj[0]);

    // ---- 8. A PRESS ON ONE MACHINE REACHES THE OTHER MACHINE'S CORE ------
    // THE cell this whole file exists for. It reads the pad bytes the REMOTE
    // core was actually handed — genesis.html publishes them as __genLsImage,
    // n64/index.html as __n64LsImage — so it cannot be satisfied by a roster
    // entry, a `connected` flag, or input that merely reached the network layer.
    const pressKey = C.key;
    await pages.host.bringToFront().catch(() => {});
    await pages.host.evaluate((k) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    }, pressKey);
    await sleep(1500);
    const during = {};
    for (const role of ['host', 'join']) during[role] = await netState(pages[role], C.seam);
    await pages.host.evaluate((k) => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    }, pressKey);

    const maskAt = (n, port) => {
      const img = n && n.image;
      if (!img || port == null) return null;
      const pb = (n.padBytes | 0) || C.padBytes;
      let m = 0;
      for (let i = 0; i < Math.min(2, pb); i++) m |= (img[port * pb + i] | 0) << (8 * i);
      return m & 0xffff;
    };
    const hostPort = ph[0];
    const seenByHost = maskAt(during.host, hostPort);
    const seenByJoin = maskAt(during.join, hostPort);
    if (seenByHost == null || seenByJoin == null) {
      voidc('a-press-on-one-console-reaches-the-other',
        'the page published no pad image (host=' + JSON.stringify(seenByHost) + ' join=' + JSON.stringify(seenByJoin) + ')');
    } else {
      cell((seenByHost & (1 << C.bit)) !== 0, 'the-press-reaches-the-pressers-own-core',
        'host core was handed 0x' + seenByHost.toString(16) + ' at its own port ' + hostPort);
      cell((seenByJoin & (1 << C.bit)) !== 0, 'a-press-on-one-console-reaches-the-OTHER-consoles-core',
        "the JOINER's core was handed 0x" + seenByJoin.toString(16) + ' at the host\'s port ' + hostPort
        + ' — only pad bytes crossed the wire to put it there');
    }

    // ---- 9. THE GUEST RATE (CLAUDE.md gate #9) ---------------------------
    // Reported always; FAILS only above 1.02x. See the header for why a low
    // figure here is not a finding: two emulators on one box is not the
    // product configuration.
    const hz = after.host.viHz || (consoleName === 'genesis' ? 59.92 : 0);
    const ran = after.host.frame - before.host;
    const rate = hz > 0 ? (ran / elapsed) / hz : null;
    detail.guestRateX = rate == null ? null : +rate.toFixed(4);
    detail.viHz = hz;
    if (rate == null) {
      voidc('guest-rate', 'this console did not report a hardware rate, so no ratio can be formed');
    } else {
      cell(rate <= 1.02, 'the-guest-is-never-sped-up',
        rate.toFixed(4) + 'x hardware (' + hz + ' Hz) — lockstep may only ever SLOW the guest; '
        + 'this figure is contended (two cores, one box) and is not a product rate');
    }

    detail.frames = { before, after: { host: after.host.frame, join: after.join.frame } };
    detail.hashes = { host: after.host.hashes, join: after.join.hashes, compared: cmp };

    // ---- 10. A STALL PAST THE BUDGET NEVER PUTS A NONCE ON SCREEN ----------
    // The engine's fail string on the stall budget names the peer it was
    // waiting on BY PEER ID — lib/netplay.js `'no input from ' +
    // waitingPeers.join(', ')`, armed by stallBudgetMs = 8000 when a page
    // passes nothing — and a peer id is the session's 16-hex stableNonce. So
    // the joiner's JS is FROZEN with the debugger (CDP Debugger.pause: nothing
    // in either page is driven, the joiner simply stops answering, as a locked
    // phone would), the host is left to stall past its budget, and the sentence
    // it draws is read back. Then the joiner is resumed and — its host now
    // silent — fails the same way from the guest side, so both roles' words are
    // checked. Runs LAST: it ends the room. A side whose engine never reaches
    // `failed` is VOID for that half, never a PASS.
    const NONCE = /[0-9a-f]{16}/;
    const failedOn = (s) => {
      const n = window[s] && window[s]();
      const e = n && n.engine;
      return (e && e.state === 'failed') ? { error: e.error == null ? null : String(e.error), party: (n.party && n.party.error) || null } : null;
    };
    let dbg = null;
    try {
      dbg = await pages.join.target().createCDPSession();
      await dbg.send('Debugger.enable');
      await dbg.send('Debugger.pause');
    } catch (e) { dbg = null; say('  ⚠ could not freeze the joiner: ' + e.message); }
    if (!dbg) {
      voidc('a-stall-fail-never-shows-a-nonce', 'the joiner could not be frozen, so no stall was forced');
    } else {
      // ⚠ READ AFTER THE PANEL'S OWN TICK, NOT INSIDE IT. The page redraws on
      // a 400 ms interval and this rig polls the seam every 200 ms, so a DOM
      // read taken the instant the engine reports `failed` can be the PREVIOUS
      // state's words — measured on the first run of this cell: both roles'
      // engines carried the fail string while #lsMsg still read "Playing —
      // everyone started together at frame 0. Waiting for player 2…". The
      // same lesson windowWatcher already carries. Polled for up to 3 s until
      // the sentence has left "Playing"; the LAST read is what is judged.
      const settled = async (page) => {
        let u = null;
        for (let i = 0; i < 12; i++) {
          u = await partyUi(page, C.ui);
          if (u && u.msg != null && !/^Playing/.test(u.msg)) break;
          await sleep(250);
        }
        return u;
      };
      const hostFail = await waitFor(pages.host, failedOn, 30000, 'host engine to fail on the stall budget', C.seam);
      const hostUi = hostFail ? await settled(pages.host) : await partyUi(pages.host, C.ui);
      try { await dbg.send('Debugger.resume'); await dbg.send('Debugger.disable'); await dbg.detach(); } catch (e) {}
      const joinFail = await waitFor(pages.join, failedOn, 30000, 'joiner engine to fail once its host fell silent', C.seam);
      const joinUi = joinFail ? await settled(pages.join) : await partyUi(pages.join, C.ui);
      const judge = (role, f, ui) => {
        if (!f) return { ok: null, text: role + ': engine never reached `failed` within 30 s — nothing to read' };
        const msg = (ui && ui.msg) || '';
        const clean = !NONCE.test(msg) && !(f.party && NONCE.test(f.party)) && !/^Playing/.test(msg);
        return { ok: clean, text: role + ': engine "' + f.error + '" (' + (NONCE.test(f.error || '') ? 'a peer id IS in it' : 'no peer id in it')
          + ') -> sentence "' + msg + '"' + (f.party && NONCE.test(f.party) ? ' and party.error carries a nonce' : '') };
      };
      const jh = judge('host', hostFail, hostUi), jj = judge('join', joinFail, joinUi);
      if (jh.ok == null && jj.ok == null) voidc('a-stall-fail-never-shows-a-nonce', jh.text + ' · ' + jj.text);
      else cell(jh.ok !== false && jj.ok !== false, 'a-stall-fail-never-shows-a-nonce', jh.text + ' · ' + jj.text);
      detail.stallFail = { host: hostFail, hostUi, join: joinFail, joinUi };
    }
    detail.loadEnd = load1();
    return detail;
  } catch (e) {
    cell(false, 'arm-crashed', e.message);
    detail.error = e.message;
    return detail;
  } finally {
    if (watch) watch.stop = true;
    await releaseThrottle();
    detail.netLogTail = (detail.netLog || []).slice(-30);
    delete detail.netLog;
    if (!KEEP) for (const b of browsers) { try { await b.close(); } catch (e) {} }
  }
}

// ---------------------------------------------------------------------------
(async () => {
  selfAudit();
  say('console_room_crossdevice_test — ' + BASE);
  say(RESULT.uptimeStart || '');
  const consoles = arg('console', 'n64,genesis').split(',').map((s) => s.trim()).filter(Boolean);
  const arms = arg('arms', 'warm,cold').split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of consoles) {
    if (!CONSOLES[c]) { say('unknown console ' + c); continue; }
    for (const t of arms) {
      RESULT.arms[c + '/' + t] = await runArm(c, t);
    }
  }
  const pass = RESULT.cells.filter((c) => c.ok === true).length;
  const fail = RESULT.cells.filter((c) => c.ok === false);
  const vd = RESULT.cells.filter((c) => c.ok === null).length;
  say('');
  say(pass + ' pass · ' + fail.length + ' FAIL · ' + vd + ' void');
  fail.forEach((f) => say('  FAIL [' + f.arm + '] ' + f.name + ' — ' + f.detail));
  RESULT.uptimeEnd = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return null; } })();
  const jsonPath = path.join(OUT, NAME + '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(RESULT, null, 2));
  say('full result -> ' + jsonPath);
  process.exit(fail.length ? 1 : 0);
})();

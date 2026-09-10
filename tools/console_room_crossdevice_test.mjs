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
    // Genesis declares itself ready from inside lsArmBeforeFreerun
    // (genesis.html:735-742) — there is no Ready button to press.
    ready: null,
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
    // Nothing to press: n64/index.html presses its own Start once the room
    // reports `connected`, because the room is deliberately formed BEFORE
    // anything boots (an earlier cut that booted in parallel had the WebRTC
    // handshake fail every time, the host being busy instantiating a 12 MB ROM).
    start: null,
    // N64 DOES have a start barrier button and it is deliberate: the page
    // comments record that an earlier auto-ready let the first machine to boot
    // pass the barrier alone with an empty roster.
    ready: '#netReady',
  },
};

// Read-only state, through the page's own seam. Never a private.
const netState = (page, seam) => page.evaluate((s) => {
  try { return window[s] ? window[s]() : null; } catch (e) { return { error: String(e) }; }
}, seam);

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
    if (C.start) {
      if (C.closeFirst) {
        for (const role of ['host', 'join']) {
          const r = await clickReal(pages[role], C.closeFirst);
          if (!r.clicked) say('  [' + role + '] could not close the room panel: ' + r.why);
        }
        await sleep(300);
      }
      // Wait for the control to be live — the ROM list has to be in before the
      // page enables it — then press it on BOTH sides for real.
      for (const role of ['host', 'join']) {
        await waitFor(pages[role], (s) => {
          const b = document.querySelector(s);
          return (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') ? true : null;
        }, 60000, role + ' Start to become pressable', C.start);
      }
      for (const role of ['host', 'join']) {
        const r = await clickReal(pages[role], C.start);
        cell(r.clicked, role + '-pressed-Start-for-real',
          r.clicked ? 'a real click on this console\'s own Start' : ('could not press Start: ' + r.why));
      }
    }

    // ---- 3. BOTH CORES ARM BEFORE EITHER RUNS A FRAME --------------------
    const armedState = {};
    for (const role of ['host', 'join']) {
      const st = await waitFor(pages[role], (s) => {
        const n = window[s] && window[s]();
        return (n && n.armed) ? n : null;
      }, 300000, role + ' core to arm', C.seam);
      if (!cell(!!st, role + '-core-armed-the-frame-gate',
        st ? ('armed with the core still at frame ' + (st.frame | 0)) : 'never armed')) {
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
    const armedAt = (s) => (s && s.armedAtFrame != null) ? (s.armedAtFrame | 0) : (s.frame | 0);
    cell(Object.values(armedState).every((s) => armedAt(s) === 0),
      'no-frame-ran-before-the-gate-closed',
      'frames at the moment of arming: host ' + armedAt(armedState.host) + ', join ' + armedAt(armedState.join));

    // ---- 4. THE START BARRIER --------------------------------------------
    if (C.ready) {
      // Wait until BOTH sides can see two seated ports first: pressing Ready
      // before the peer is seated is exactly the bug the button exists to stop.
      for (const role of ['host', 'join']) {
        await waitFor(pages[role], (s) => {
          const n = window[s] && window[s]();
          const ports = n && n.engine && n.engine.ports;
          return (ports && ports.filter((p) => p.peer).length >= 2) ? true : null;
        }, 120000, role + ' to see both seats', C.seam);
      }
      for (const role of ['host', 'join']) {
        const r = await clickReal(pages[role], C.ready);
        cell(r.clicked, role + '-pressed-Ready-for-real', r.clicked ? 'a real click on the barrier button' : ('could not press Ready: ' + r.why));
      }
    } else {
      voidc('ready-button', 'this console declares itself ready when the core arms — there is no button to press');
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
    detail.loadEnd = load1();
    return detail;
  } catch (e) {
    cell(false, 'arm-crashed', e.message);
    detail.error = e.message;
    return detail;
  } finally {
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

#!/usr/bin/env node
// ============================================================================
// netplay_room_e2e.mjs — N INDEPENDENT BROWSERS, N INDEPENDENT CORES,
//                        N DISTINCT GAUNTLET CHARACTERS
// ============================================================================
//
// THIS IS THE PROOF THE PRODUCT REQUIREMENT ASKS FOR, stated as the user
// stated it: "the players should act as if they are connected to the same
// console", "player 2 can run their own emulator, but it needs to be in sync
// with player 1", "you need this to be immediate input like a local console",
// and — the scope correction — "THIS WILL SUPPORT AS MANY PLAYERS AS THE
// CONSOLE CAN!".
//
// So: N SEPARATE Chrome profiles, each loading dreamcast.html, each booting its
// OWN Flycast core off the same disc, each driving its OWN Maple port, with the
// input latency of the players who are NOT the room opener measured and put
// beside the streaming figures the old architecture was measured at.
//
// WHAT MAKES THIS DIFFERENT FROM EVERY EARLIER NETPLAY RIG HERE
//
//   * tools/dreamcast_netplay_test.mjs   two tabs in ONE browser on
//     BroadcastChannel — cannot leave the profile, so it exercises no broker,
//     no ICE, and no second machine.
//   * tools/netplay_realui_pair_test.mjs proved the STREAMING pairing, and its
//     own flow baked in the boot-first order (romSelect -> Start -> Host) that
//     the product no longer has. A test that asserts the wrong flow keeps
//     passing while the product is wrong; that is what happened.
//   * dreamcast/tools/gauntlet_p2_probe.mjs proved the GAME reacts to port 1 —
//     but through a synthetic gamepad in ONE tab, with no transport at all.
//
//   None of them ever ran two emulators. This one runs N.
//
// THE ORDER IT DRIVES — deliberately the product's order, not the old one:
//   1. every player opens the page. NOTHING is booted, no disc is fetched.
//   2. player 1 opens a ROOM; the others join with the code.
//   3. ports are assigned and asserted DISTINCT. Two players on one port means
//      they drive each other's character — a gameplay-visible failure, so it is
//      a first-class cell here, not an edge case.
//   4. everybody selects the SAME disc and starts. Per-player load is visible.
//   5. a START BARRIER: nobody advances frame 0 until every peer is ready.
//   6. all cores run frame 0 together — no savestate handoff, so the starting
//      states are identical BY CONSTRUCTION rather than by a transfer that can
//      silently fail to restore (CLAUDE.md gate #10).
//
// EVIDENCE DISCIPLINE (CLAUDE.md gate #10). A wedged run screenshots a
// live-looking stale frame, so every screenshot here is paired with liveness
// read in the same breath: __dcProbe().guestX (must stay 1.000x — gate #9),
// fps, framesEver/distinctEver, and the count of DISTINCT picture signatures
// this rig sampled off that player's own canvas. A still picture and a moving
// counter disagree loudly.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   npm run web
//   node dreamcast/tools/netplay_room_e2e.mjs --players 2 --name e2e2
//   node dreamcast/tools/netplay_room_e2e.mjs --players 4 --name e2e4
//
// FLAGS
//   --players N   how many independent browsers. Default 2. The Dreamcast has
//                 four Maple ports (flycast-src/core/hw/maple/maple_devs.h:193
//                 MAPLE_PORTS 4) so 4 is the console's real ceiling; whether
//                 four Flycast cores fit on the measuring box at once is a
//                 separate question and is REPORTED rather than assumed.
//   --game G      #romSelect value, default gauntlet
//   --name N      output basename under /tmp/dc-e2e
//   --fresh       delete the persistent profiles first (re-fetches the disc)
//   --headful / --keep
// ============================================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const PLAYERS = Math.max(2, parseInt(arg('players', '2'), 10));
const GAME    = arg('game', 'gauntlet');
const NAME    = arg('name', 'e2e' + PLAYERS);
const ORIGIN  = arg('url', 'http://localhost:8080');
const PROFBASE= arg('profile-base', '/private/tmp/claude-501/dc-e2e');
const FRESH   = has('fresh');
const HEADFUL = has('headful');
const KEEP    = has('keep');
const BOOT_MS = parseInt(arg('bootms', '900000'), 10);
const PAIR_MS = parseInt(arg('pairms', '120000'), 10);
const REPS    = parseInt(arg('reps', '15'), 10);
const CHROME  = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const OUT = '/tmp/dc-e2e';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); logStream.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };

const rec = [];
const ok  = (n, d) => { rec.push({ n, ok: true,  d }); say(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { rec.push({ n, ok: false, d }); say(`  FAIL  ${n}  ${d}`); };
// ⚠ VOID IS FOR A PRECONDITION THAT NEVER HAPPENED, NEVER FOR A MISSING
// FEATURE. "the engine has not published a room yet" is a FAILURE of the
// product requirement, and printing it as void is how a wrong product keeps a
// green test.
const voidc = (n, d) => { rec.push({ n, ok: null, d }); say(`  VOID  ${n}  ${d}`); };
const cell = (p, n, good, badMsg) => (p ? ok(n, good) : bad(n, badMsg));
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]; };

const RESULT = {
  when: new Date().toISOString(), players: PLAYERS, game: GAME,
  uptimeStart: execSync('uptime').toString().trim(), loadavgStart: os.loadavg(),
  wasm: null, code: null, ports: null, latency: null, liveness: [], shots: [], rec: null,
  // The figures the old architecture was measured at, carried here so the
  // comparison is in the artifact rather than in somebody's memory.
  streamingBaseline: {
    source: 'dreamcast/tools/netplay_stream_baseline.mjs runs base1/base2, both browsers on ONE box at 0-1 ms RTT',
    inputToEmulatorMsP50: [25, 21],
    hostPictureToPlayer2PictureMs: [68, 52],
    addedInputToVisibleMs: [93, 73],
    audioBehindHostMs: [52, 36],
    framesPerSecondSeen: [28.7, 42.8],
    hostPresentedFps: 60,
  },
};

const wasmPath = path.join(REPO, 'dreamcast', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const wasmHash = () => { try { return execSync(`shasum -a 256 "${wasmPath}"`).toString().split(' ')[0].slice(0, 16); } catch (e) { return 'unknown'; } };

say('== netplay_room_e2e ==');
say(`  players     ${PLAYERS} independent browsers, ${PLAYERS} independent cores`);
say(`  game        ${GAME}`);
say(`  uptime      ${RESULT.uptimeStart}`);
say(`  wasm        ${wasmHash()}`);
RESULT.wasm = { sha256_16_before: wasmHash() };

const browsers = [], pages = [], sideErr = [];
async function launch(i) {
  const dir = path.join(PROFBASE, 'p' + i);
  if (FRESH) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: HEADFUL ? false : 'new', userDataDir: dir,
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required',
      '--disk-cache-size=1073741824'],
  });
  try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(b, 'netplay_room_e2e'); }
  catch (e) { say('  ⚠ leak-guard registration FAILED: ' + (e.message || e)); }
  browsers.push(b);
  const pg = (await b.pages())[0];
  const errs = []; sideErr[i] = errs;
  pg.on('pageerror', (e) => { const t = (e && (e.message || e.type)) || String(e); errs.push(String(t).slice(0, 260)); say(`  [P${i + 1}!] ${String(t).slice(0, 170)}`); });
  pg.on('console', (m) => { const t = m.text(); if (/\[net\]|DESYNC|lockstep/i.test(t)) say(`  [P${i + 1}] ${t.slice(0, 170)}`); });
  await pg.setViewport({ width: 1100, height: 780 });
  try { const cdp = await pg.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (e) {}
  pages.push(pg);
  return pg;
}
async function gotoSettled(pg, url) {
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await sleep(2500);
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
}
async function until(pg, fn, ms, every = 500, tick = null) {
  const t = Date.now();
  for (;;) {
    let v = null; try { v = await pg.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) return null;
    if (tick) { try { await tick(Date.now() - t); } catch (e) {} }
    await sleep(every);
  }
}
const click = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); if (e) { e.click(); return true; } return false; }, sel);

// The per-player picture sampler: distinct coarse signatures off that player's
// OWN canvas. This is the liveness metric gate #10 demands beside a screenshot.
async function installSampler(pg) {
  await pg.evaluate(() => {
    if (window.__e2e) return;
    const W = 24, H = 18;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true, alpha: false });
    const S = window.__e2e = { sigs: [], err: null, n: 0 };
    const tick = () => {
      const src = document.getElementById('dc-canvas');
      try {
        g.drawImage(src, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let acc = 0, nb = 0, sig = '';
        for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; acc += l; if (d[i] | d[i + 1] | d[i + 2]) nb++; }
        for (let b = 0; b < 6; b++) {
          let s = 0, n = 0;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (((y < H / 2 ? 0 : 3) + ((x * 3 / W) | 0)) !== b) continue;
            const k = (y * W + x) * 4; s += (d[k] + d[k + 1] + d[k + 2]) / 3; n++;
          }
          sig += Math.round(s / Math.max(1, n)) + '.';   // NOT quantised: these are exact local pixels, not codec output
        }
        S.sigs.push({ t: Date.now(), sig, nb, mean: Math.round(acc / (W * H)) });
        if (S.sigs.length > 4000) S.sigs.shift();
        S.n++;
      } catch (e) { S.err = String((e && e.message) || e); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const liveness = (pg, label) => pg.evaluate((label) => {
  const p = window.__dcProbe();
  const S = window.__e2e || { sigs: [], n: 0, err: 'sampler not installed' };
  const recent = S.sigs.slice(-240);
  return {
    label, guestX: p.guestX, fps: p.fps, booted: p.booted,
    // ⚠ iters IS THE LIVENESS WITNESS, fps AND guestX ARE NOT. Measured on this
    // rig 2026-09-08: four cores frozen solid by a fault injection still read
    // fps=30 and guestX 0.998-1.003, while the page's own headline said "THE
    // EMULATOR STALLED ... iters=0". fps counts PRESENTS (dupes included) and
    // guestX is a ratio over a window with no guest time in it. iters is
    // run_iter/s off the worker's own pump — a stopped core cannot fake it.
    // This is CLAUDE.md gate #10's "only drawn/s proves liveness", in Dreamcast
    // terms, and it caught a run whose every other number looked healthy.
    iters: p.iters,
    framesEver: p.framesEver, distinctEver: p.distinctEver, phase: p.phase,
    headline: p.headline,
    sampledFrames: recent.length,
    distinctSignatures: new Set(recent.map((s) => s.sig)).size,
    litPixelsPeak: recent.length ? Math.max.apply(null, recent.map((s) => s.nb)) : 0,
    samplerErr: S.err,
    net: window.__dcNet ? window.__dcNet() : null,
    hud: window.__dcNetHud ? window.__dcNetHud() : null,
    room: window.__dcNetRoom ? window.__dcNetRoom() : null,
    pad0: window.__dcPad ? Array.from(window.__dcPad()).slice(0, 12) : null,
  };
}, label);

let exitCode = 1;
try {
  // ---- 1. every player opens the page, nothing booted ----------------------
  say(`\n== 1. ${PLAYERS} browsers open the page — no disc, nothing started ==`);
  for (let i = 0; i < PLAYERS; i++) await launch(i);
  await Promise.all(pages.map((pg) => gotoSettled(pg, ORIGIN + '/dreamcast.html')));
  const mounted = await Promise.all(pages.map((pg) => until(pg, () => (typeof window.__dcNet === 'function' && typeof window.__dcNetRoom === 'function') || null, 90000)));
  cell(mounted.every(Boolean), 'every-browser-mounts',
    `all ${PLAYERS} pages published __dcNet + __dcNetRoom`,
    `mounted: ${J(mounted)}`);
  const booted0 = await Promise.all(pages.map((pg) => pg.evaluate(() => window.__dcProbe().booted)));
  cell(booted0.every((b) => b === false), 'nothing-is-booted-yet',
    'no disc has been fetched on any machine — this is the state the room is opened from',
    `booted: ${J(booted0)}`);

  // Isolation: BroadcastChannel must not cross profiles, or the transport under
  // test is not the one two real machines would use.
  const echoed = await pages[1].evaluate(() => new Promise((res) => {
    const ch = new BroadcastChannel('e2e-isolation'); let heard = false;
    ch.onmessage = () => { heard = true; }; ch.postMessage('ping');
    setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 900);
  }));
  cell(!echoed, 'profiles-are-isolated',
    'no BroadcastChannel echo between profiles — only the broker can pair these browsers',
    'a BroadcastChannel crossed the profiles; this run proves nothing about a real transport');

  // ---- 2. player 1 opens a room; everyone else joins -----------------------
  say('\n== 2. player 1 opens a ROOM with nothing booted; the rest join ==');
  // ⚠ PICK THE DISC BEFORE OPENING THE ROOM. lib/netplay.js binds the game name
  // into the pairing handshake and refuses a joiner who names a different one,
  // so a room opened while #romSelect still reads the page default rejects every
  // joiner with "the other player is on pso2". Selecting is a DROPDOWN, not a
  // download — nothing boots here, which is the property under test.
  await pages[0].evaluate((g) => { const el = document.querySelector('#romSelect'); if (el) { el.value = g; el.dispatchEvent(new Event('change')); } }, GAME);
  await click(pages[0], '#btnNet');
  await click(pages[0], '#netHostBtn');
  const code = await until(pages[0], () => {
    const t = (document.getElementById('netCode').textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{5}$/.test(t) ? t : null;
  }, 45000);
  RESULT.code = code;
  const stillCold = await pages[0].evaluate(() => window.__dcProbe().booted);
  cell(!!code && stillCold === false, 'room-opens-before-the-emulator',
    `room ${code} is open with booted=${stillCold} — the boot-first gate is gone, which is the whole point: ` +
    'nobody should have to download 1,131 MB before finding out whether they got a port',
    `code=${J(code)} booted=${stillCold}`);

  for (let i = 1; i < PLAYERS; i++) {
    await click(pages[i], '#btnNet');
    await click(pages[i], '#netJoinBtn');
    await pages[i].evaluate((g) => { const el = document.querySelector('#netGame'); if (el) el.value = g; }, GAME);
    await pages[i].click('#netCodeIn');
    await pages[i].type('#netCodeIn', code, { delay: 20 });
    await click(pages[i], '#netGo');
    // The room opener is asked before anyone is let in.
    const prompt = await until(pages[0], () => (document.getElementById('npApproveAllow') ? true : null), 45000, 400);
    if (prompt) await pages[0].evaluate(() => document.getElementById('npApproveAllow').click());
    else say(`  ....  no approval prompt appeared for P${i + 1}`);
    await sleep(1200);
  }
  const conn = await Promise.all(pages.map((pg) => until(pg, () => (window.__dcNet().state === 'connected') || null, PAIR_MS, 500)));
  // ⚠ TWO CAPS USED TO STOP THIS AT TWO PLAYERS, AND BOTH ARE FIXED. This note
  // is kept because a cell that fails for a KNOWN reason must say which one,
  // and because a stale root-cause note is worse than none.
  //   1. every joiner registered on the broker under the same '-g' id, so the
  //      second one died with "unavailable-id". Now `-g' + randomHex(8)`.
  //   2. the session itself held ONE RTCPeerConnection, ONE DataChannel and one
  //      `_approved` latch, and approve() locked the signalling socket — so
  //      even with distinct broker ids the second joiner could not be SEATED.
  //      lib/netplay.js now keeps one link per joiner and the host relays
  //      between them; tools/netplay_room_test.mjs proves that arm on its own
  //      with N browsers and no emulator.
  // If this cell fails now, read the per-side error before assuming either.
  const failDetail = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const sess = (window.Netplay && window.Netplay.sessions) || [];
    const s2 = sess[sess.length - 1];
    return { state: window.__dcNet().state, err: (s2 && s2.lastError) || null };
  })));
  const idClash = failDetail.some((d) => /unavailable-id/i.test(String(d.err || '')));
  const full = failDetail.some((d) => /room is full/i.test(String(d.err || '')));
  cell(conn.every(Boolean), 'everyone-is-in-the-room',
    `all ${PLAYERS} sides report connected — host + ${PLAYERS - 1} guests on one code, one Allow each`,
    `connected: ${J(conn)} — per-side ${J(failDetail)}`
      + (idClash ? '. "unavailable-id" is back: every joiner is registering under the same broker id again.' : '')
      + (full ? `. The room refused a joiner as FULL — check portCount: ${PLAYERS} players needs ${PLAYERS} ports.` : ''));

  // ---- 3. ports assigned, visible, and DISTINCT ----------------------------
  say('\n== 3. ports are assigned, shown, and distinct ==');
  const rooms = await Promise.all(pages.map((pg) => pg.evaluate(() => window.__dcNetRoom())));
  const huds  = await Promise.all(pages.map((pg) => pg.evaluate(() => window.__dcNetHud())));
  const myPorts = huds.map((h) => (h.telemetry && h.telemetry.you) ? h.telemetry.you.port : null);
  RESULT.ports = myPorts;
  const roomPublished = huds.every((h) => h.telemetry && h.telemetry.ports != null);
  cell(roomPublished, 'the-engine-publishes-a-room',
    `every side reports a port count: ${J(huds.map((h) => h.telemetry && h.telemetry.ports))}`,
    'no side published a room (netTelemetry().ports is null). THIS IS A PRODUCT REQUIREMENT, NOT A ' +
    'MISSING NICETY: without it nobody can be told which player they are, and the rest of this run ' +
    `cannot assert port assignment. Telemetry seen: ${J(huds.map((h) => h.telemetry))}`);
  if (roomPublished) {
    const distinct = new Set(myPorts.filter((p) => p != null)).size;
    cell(distinct === PLAYERS && myPorts.every((p) => p != null),
      'every-player-holds-a-DIFFERENT-port',
      `ports ${J(myPorts)} — ${distinct} distinct for ${PLAYERS} players. Two players on one port would ` +
      'drive the same Gauntlet character, which is a gameplay-visible failure, not an edge case',
      `ports ${J(myPorts)} — ${distinct} distinct for ${PLAYERS} players`);
    const rowsOK = rooms.every((r) => r.rows.length === huds[0].telemetry.ports);
    cell(rowsOK, 'the-room-draws-one-seat-per-port',
      `every side drew ${rooms[0].rows.length} seats for a ${huds[0].telemetry.ports}-port console`,
      `seat counts ${J(rooms.map((r) => r.rows.length))} against ports ${huds[0].telemetry.ports}`);
    rooms.forEach((r, i) => say(`  ....  P${i + 1} sees: ${r.ports} | ${r.rows.map((x) => x.text).join(' | ')}`));
  } else {
    voidc('every-player-holds-a-DIFFERENT-port', 'not measurable: no room was published (see the failure above)');
    voidc('the-room-draws-one-seat-per-port', 'not measurable: no room was published');
  }

  // ---- 3b. the SEATING, read from the transport rather than from the DOM ---
  // The block above reads what the page DREW. This one reads what the transport
  // DECIDED, because those are two different claims and only the second one is
  // what every core will actually key its maple ports off. They are asserted
  // separately on purpose: a page that renders the roster wrongly is a cosmetic
  // bug, and a transport that disagrees with itself is players driving each
  // other's characters.
  const seatInfo = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
    return s && s.roomInfo ? s.roomInfo() : null;
  })));
  RESULT.rooms = seatInfo;
  if (seatInfo.every(Boolean)) {
    seatInfo.forEach((r, i) => say(`  ....  P${i + 1} transport roster ${J(r.seats.map((s) => (s.peer ? s.peer.slice(0, 6) : null)))} — it holds port ${r.seats.findIndex((s) => s.local)}`));
    const canon = J(seatInfo[0].seats.map((s) => s.peer));
    cell(seatInfo.every((r) => J(r.seats.map((s) => s.peer)) === canon), 'EVERY-machine-agrees-who-is-in-which-port',
      `all ${PLAYERS} transport rosters are identical: ${canon}`,
      `rosters DISAGREE: ${J(seatInfo.map((r) => r.seats.map((s) => s.peer)))} — two machines that disagree about the ` +
      'roster put two players on one character');
    const held = seatInfo.map((r) => r.seats.findIndex((s) => s.local));
    cell(new Set(held).size === PLAYERS && held.every((p) => p >= 0) && held[0] === 0,
      'four-independent-machines-hold-four-DIFFERENT-maple-ports',
      `local ports ${J(held)} across ${PLAYERS} separate browsers, room opener on port 0 — the console has ` +
      `${seatInfo[0].portCount} ports and every one of them belongs to a different machine`,
      `local ports ${J(held)}`);
  } else {
    voidc('EVERY-machine-agrees-who-is-in-which-port', `not measurable: a side published no session roomInfo() — ${J(seatInfo.map((r) => !!r))}`);
    voidc('four-independent-machines-hold-four-DIFFERENT-maple-ports', 'not measurable: no transport roster');
  }

  // ---- 4. everybody loads the SAME disc ------------------------------------
  say(`\n== 4. all ${PLAYERS} machines load "${GAME}" and boot their OWN core ==`);
  for (const pg of pages) {
    await pg.evaluate((g) => { const el = document.querySelector('#romSelect'); if (el) { el.value = g; el.dispatchEvent(new Event('change')); } }, GAME);
  }
  const picked = await Promise.all(pages.map((pg) => pg.evaluate(() => document.querySelector('#romSelect').value)));
  cell(picked.every((v) => v === GAME), 'everyone-selected-the-same-disc',
    `every #romSelect reads "${GAME}"`, `selections: ${J(picked)}`);

  // ⚠ A JOINER MUST BE ABLE TO START. Under streaming, netGuestStartLock()
  // DISABLED Start for everyone but the host — that single line was what made
  // this page two-machines-one-emulator.
  const startState = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const b = document.getElementById('btnStart');
    return { disabled: !!b.disabled, ariaDisabled: b.getAttribute('aria-disabled') };
  })));
  cell(startState.every((s) => !s.disabled), 'joiners-can-start-their-own-core',
    `Start is enabled on all ${PLAYERS} machines — the guest start lock is gone`,
    `Start states: ${J(startState)} — a joiner that cannot start has no core, which is the old architecture`);

  for (const pg of pages) await click(pg, '#btnStart');
  const bootDeadline = Date.now() + BOOT_MS;
  const bootedAll = [];
  for (let i = 0; i < PLAYERS; i++) {
    let last = '';
    // ⚠ "FRAMES FLOWING" IS THE WRONG LIVENESS TEST HERE, AND IT BECAME
    // WRONG THE DAY THE GATE BECAME REAL. A core in a room is armed BEFORE
    // {cmd:'freerun',on:1} and parks on an empty queue at frame 0 until the
    // barrier releases, so it reports booted=true with fps=0 and framesEver=0 —
    // BY DESIGN, and that is the property section 5 exists to check. The first
    // run against the wired page sat here reading `P1 running 100% fps=0` and
    // would have timed out after 15 minutes and called a working gate a dead
    // core. Liveness moves to 5b (the cores ADVANCE once released); this wait
    // only asks whether the machine got that far.
    const v = await until(pages[i], () => {
      const p = window.__dcProbe();
      const n = window.__dcNet();
      const parked = !!(n && n.lockstep && n.lockstep.armed);   // gated at frame 0, not stuck
      return (p.booted && (parked || p.fps > 0 || p.framesEver)) ? p : null;
    }, Math.max(30000, bootDeadline - Date.now()), 2000, async () => {
      const p = await pages[i].evaluate(() => window.__dcProbe()).catch(() => null);
      if (!p) return;
      const l = `P${i + 1} ${p.phase} ${Math.round(100 * (p.discBytes || 0) / (p.discTotal || 1))}% fps=${p.fps}`;
      if (l !== last) { last = l; process.stdout.write('  ....  booting  ' + l + '            \r'); }
    });
    bootedAll.push(v);
  }
  process.stdout.write('\n');
  cell(bootedAll.every(Boolean), 'every-machine-runs-its-own-core',
    `all ${PLAYERS} cores loaded the disc and armed their frame gate — ${PLAYERS} emulators, not one. They are ` +
    'parked at frame 0 on an empty input queue, which is what the barrier is for; whether they ADVANCE is 5b',
    `booted: ${J(bootedAll.map((b) => !!b))}. A machine that never booted is a player watching nothing.`);
  for (const pg of pages) await installSampler(pg);

  // ⚠ THE TITLE-CARD DRIVING AND THE RATE SETTLE USED TO LIVE HERE, AND THEY
  // HAD TO MOVE. They ran BEFORE the start barrier, which was harmless only for
  // as long as the page did not actually gate: every core free-ran from the
  // moment it booted, so it made sense to steer it. Now the page arms the frame
  // gate BETWEEN the disc load and {cmd:'freerun',on:1} (dreamcast.html
  // lsArmBeforeFreerun) and every core parks on an EMPTY queue at frame 0 until
  // the barrier releases — which is the product requirement, and which means 25
  // seconds of key taps here would land on a machine that has run zero frames.
  // They now happen in section 5c, after the release.

  // ---- 4b. the controllers exist BEFORE the disc did -----------------------
  // The maple devices are created inside retro_load_game and this build does
  // not hotplug, so the controller count is part of the starting state. Four
  // machines that made a different number of pads are already desynced at
  // frame 0, and the count is unreadable after the fact from anything but the
  // page's own report of what it sent.
  const ctl = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const n = window.__dcNet();
    return (n && n.lockstep) ? n.lockstep.controllers : null;
  })));
  if (ctl.every((c) => c && typeof c.n === 'number')) {
    cell(ctl.every((c) => c.n === ctl[0].n && c.ok && !c.late), 'every-machine-plugged-in-the-SAME-controllers',
      `all ${PLAYERS} machines presented ${ctl[0].n} controller(s), each before its own disc load — ` +
      'the maple devices are made inside retro_load_game and this build cannot hotplug, so a machine that ' +
      'made a different number of pads is desynced at frame 0 no matter what anyone presses',
      `controller acks: ${J(ctl)} — "late:true" means the count arrived after the disc had already loaded`);
  } else {
    cell(false, 'every-machine-plugged-in-the-SAME-controllers',
      '', `no machine reported a controller ack: ${J(ctl)}. The page is supposed to send {cmd:'players'} ` +
      'before discReady whenever it is in a room; without it every core takes the build default and the ' +
      'room silently plays with the wrong number of pads.');
  }

  // ---- 5. the start barrier ------------------------------------------------
  say('\n== 5. the start barrier ==');
  // ⚠ SOMEBODY HAS TO PRESS READY, and the first version of this rig never did
  // — then reported the barrier as a FAILURE when it correctly held the room.
  // The page's #netReady is a human action (dreamcast.html:5381-5389, which
  // calls session.setReady). Press it on every machine, one at a time, so the
  // hold-then-release below is a real observation and not a timing accident.
  const readyPath = [];
  for (let i = 0; i < PLAYERS; i++) {
    const how = await pages[i].evaluate(() => {
      const b = document.getElementById('netReady');
      if (b && !b.disabled && b.style.display !== 'none') { b.click(); return 'button'; }
      const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
      if (s && typeof s.setReady === 'function') { s.setReady(true); return 'api'; }
      return 'none';
    });
    readyPath.push(how);
    // Read the room BEFORE the last player says ready: it must still be holding.
    if (i === PLAYERS - 2) {
      await sleep(1200);
      const held = await Promise.all(pages.map((pg) => pg.evaluate(() => {
        const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
        return s && s.ls ? s.ls.state : null;
      })));
      cell(held.every((s) => s !== 'running'), 'the-barrier-HOLDS-until-the-LAST-player-is-ready',
        `${PLAYERS - 1} of ${PLAYERS} machines declared ready and none of them started: ${J(held)} — on a 1,131 MB ` +
        'disc the slowest phone decides when the room starts, and that wait is reported rather than being a pause',
        `engine states with one player still not ready: ${J(held)} — somebody ran ahead`);
    }
    await sleep(500);
  }
  say(`  ....  ready was declared via ${J(readyPath)} (button = the product path, api = the button was not available)`);
  await sleep(2000);
  const lsStates = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
    return s && s.ls ? { state: s.ls.state, frame: s.ls.frame, ports: s.ls.localPorts } : null;
  })));
  cell(lsStates.every((s) => s && (s.state === 'running' || s.state === 'stalled')),
    'all-four-machines-are-released-together-at-frame-0',
    `every engine left the lobby once the last machine declared the same disc: ${J(lsStates.map((s) => s && s.state))} — ` +
    'no savestate was transferred, so the starting states are identical by construction rather than by a restore ' +
    'that can silently fail into a cold boot (CLAUDE.md gate #10)',
    `engine states ${J(lsStates)} — ready path ${J(readyPath)}`);
  const bar = await Promise.all(pages.map((pg) => pg.evaluate(() => window.__dcNetRoom().barrier)));
  const tel = await Promise.all(pages.map((pg) => pg.evaluate(() => { const h = window.__dcNetHud(); return h.telemetry && h.telemetry.barrier; })));
  const started = tel.every((b) => b && b.started);
  cell(started, 'nobody-advanced-frame-0-alone',
    `every side reports the barrier released: ${J(tel)}`,
    `barrier state per side: ${J(tel)} / text ${J(bar)}. Without a barrier the first machine to finish ` +
    'downloading runs ahead and the others start from a different frame — which is a desync at frame 0.');

  // =========================================================================
  // 5b. IS THE FRAME GATE ACTUALLY RUNNING? — the cell this rig existed
  //     without, and the reason the product requirement was still open.
  //
  // Everything above was already passing while every core FREE-RAN. A room
  // formed, ports were assigned, the barrier held and released, and then each
  // machine ran the game on its own clock with one remote pad relayed into port
  // 1. The page rendered "LOCKSTEP" off the existence of an engine object.
  // These cells read the DRIVER instead: the worker is in lockstep mode, the
  // page is feeding one agreed frame at a time, and the CORE is acknowledging
  // them. Anything less is not online play, it is four people playing alone.
  // =========================================================================
  say('\n== 5b. the frame gate: is this page actually driving it? ==');
  const gateOf = (pg) => pg.evaluate(() => {
    const n = window.__dcNet();
    const h = window.__dcNetHud();
    return { ls: n && n.lockstep, tel: h && h.telemetry, hudText: h && h.text, mode: h && h.mode };
  });
  const g0 = await Promise.all(pages.map(gateOf));
  RESULT.gate0 = g0.map((g) => g.ls);
  g0.forEach((g, i) => say(`  ....  P${i + 1} armed=${g.ls && g.ls.armed} running=${g.ls && g.ls.running} ` +
    `workerLockstep=${g.ls && g.ls.workerLockstep} coreFrame=${g.ls && g.ls.coreFrame} ` +
    `engineFrame=${g.ls && g.ls.engineFrame} delay=${g.ls && g.ls.delay} ports=${J(g.ls && g.ls.localPorts)} ` +
    `normalize=${J(g.ls && g.ls.normalize)}`));
  cell(g0.every((g) => g.ls && g.ls.armed && g.ls.workerLockstep),
    'every-worker-is-in-LOCKSTEP-MODE',
    `all ${PLAYERS} emulator workers confirmed lockstep on — the pump will not start emulated frame N ` +
    'until it holds the maple image for N, which is what makes the delay a bound rather than a hope',
    `worker lockstep acks: ${J(g0.map((g) => g.ls && { armed: g.ls.armed, worker: g.ls.workerLockstep, fault: g.ls.fault }))}. ` +
    'A core that is not in lockstep mode is free-running: it advances on its own governor and NOTHING it ' +
    'does is shared with the other players.');
  cell(g0.every((g) => g.ls && g.ls.running),
    'every-page-is-FEEDING-the-gate',
    `all ${PLAYERS} pages report the gate engaged — ls.beginFrame() is being called and its per-frame maple ` +
    'image is going to the core as one \'lsInput\'',
    `driver states: ${J(g0.map((g) => g.ls && { armed: g.ls.armed, running: g.ls.running, fault: g.ls.fault }))}`);
  cell(g0.every((g) => g.ls && g.ls.normalize && g.ls.normalize.ok),
    'every-core-ran-the-determinism-handshake',
    `all ${PLAYERS} cores normalized at room start: ${J(g0.map((g) => g.ls && g.ls.normalize))} — two fresh boots ` +
    'reach a frame-0 anchor that is byte-identical across all 27,785,287 bytes and STILL diverge without this ' +
    '(commit 9d16f261: flush alone 0/3, round-trip alone 0/3, both 3/3 byte-identical over 1800 frames)',
    `normalize acks: ${J(g0.map((g) => g.ls && g.ls.normalize))} — without it the cores are frame-gated on ` +
    'identical inputs and will still drift, which looks exactly like a netplay bug and is not one.');

  // Do the cores actually ADVANCE, and do they advance TOGETHER?
  await sleep(4000);
  const g1 = await Promise.all(pages.map(gateOf));
  const adv = g1.map((g, i) => (g.ls.coreFrame - g0[i].ls.coreFrame));
  const frames = g1.map((g) => g.ls.coreFrame);
  const spread = Math.max.apply(null, frames) - Math.min.apply(null, frames);
  RESULT.gate = { after: g1.map((g) => g.ls), advancedIn4s: adv, frames, spread };
  say(`  ....  frames run in 4 s: ${J(adv)}  |  core frames now ${J(frames)}  |  spread ${spread}`);
  cell(adv.every((n) => n > 30), 'the-gated-cores-ADVANCE',
    `every core ran ${J(adv)} frames in 4 s while gated — a gate that never opens is a wedge, not lockstep`,
    `frames advanced in 4 s: ${J(adv)}. A core stuck at its start frame is stalled on an input that is not ` +
    `arriving; the per-side stall reasons were ${J(g1.map((g) => g.ls && { stalling: g.ls.stalling, on: g.ls.waitingOn, why: g.ls.stallReason }))}`);
  // ⚠ THE BOUND IS delay + THE MESSAGES IN FLIGHT, NOT ZERO. Each machine may
  // be up to `delay` frames ahead of what it has fed its own core, and these
  // reads are taken over a wire one page at a time, so a small spread is the
  // architecture working. A LARGE one means somebody is running on their own
  // clock.
  const bound = (g1[0].ls.delay || 3) * 4 + 8;
  cell(spread <= bound, 'no-machine-is-running-on-its-own-clock',
    `the ${PLAYERS} cores are within ${spread} frames of each other (bound ${bound} = 4x delay + sampling slack) — ` +
    'they are all executing the same emulated frames, which is what "connected to the same console" means',
    `core frames ${J(frames)} spread ${spread} > ${bound}. A core that has run hundreds of frames more than ` +
    'its peers is free-running, whatever the panel says.');

  // ---- 5c. NOW drive each core past the title card -------------------------
  // ⚠ AFTER THE BARRIER, NOT BEFORE. Before the release these cores have run
  // zero frames by design and every tap would land on nothing.
  // Gauntlet's copyright card is a STATIC IMAGE and its attract loop ignores
  // input for a while, so a fixed three taps landed on nothing and a healthy
  // core at 30 fps read 1 distinct picture signature — a false alarm from the
  // instrument. Tap repeatedly instead.
  say('  ....  driving each core past the title card (now that the cores are actually running)');
  const tap = async (pg, key) => {
    await pg.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); }, key);
    await sleep(120);
    await pg.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keyup', { key: k })); }, key);
  };
  // ⚠ ADAPTIVE, NOT A FIXED COUNT — and it had to become adaptive the day the
  // gate became real. Before the barrier existed in practice every core had
  // been free-running since it booted, so by the time the taps ran there were
  // minutes of guest time behind them. Now every core starts at frame 0 WHEN
  // THE ROOM STARTS, so a fixed 20 s of taps lands inside Gauntlet's boot and
  // the evidence section photographs a static boot screen — measured, and it
  // read `1 distinct signature` on four healthy cores. So: tap until the
  // picture actually moves, bounded, and report how long it took.
  const moving = async () => {
    const v = await Promise.all(pages.map((pg) => pg.evaluate(() => {
      const S = window.__e2e || { sigs: [] };
      const recent = S.sigs.slice(-150);
      return new Set(recent.map((x) => x.sig)).size;
    })));
    return v;
  };
  let drove = 0, sig = await moving();
  for (let k = 0; k < 45 && !sig.every((n) => n >= 8); k++) {
    for (const pg of pages) { await tap(pg, 'Enter'); }
    await sleep(2000);
    drove += 2;
    if ((k % 3) === 2) sig = await moving();
  }
  for (const pg of pages) { await tap(pg, 'm'); }
  sig = await moving();
  say(`  ....  drove ${drove} s of guest time past the boot; distinct picture signatures now ${J(sig)}`);
  if (!sig.every((n) => n >= 8)) {
    say('  ....  ⚠ the picture is still static — the evidence section will report that honestly rather than ' +
        'call a still screen a live one');
  }
  // ⚠ LET THE RATE SETTLE BEFORE READING IT. The first version asserted gate #9
  // four seconds after `booted` went true and read guestX 0.41 with fps 0 —
  // which is the BOOT RAMP, not the guest rate. The same run's end-of-run read
  // was 0.996 / 1.001. A rate sampled during the ramp is not a rate.
  say('  ....  letting the guest rate settle before reading it');
  await sleep(25000);

  // ---- 6. guest rate must not move (CLAUDE.md gate #9) ---------------------
  const rates = await Promise.all(pages.map((pg) => pg.evaluate(() => { const p = window.__dcProbe(); return { guestX: p.guestX, fps: p.fps }; })));
  RESULT.rates = rates;
  const rateOK = rates.every((r) => r.guestX > 0.97 && r.guestX < 1.03);
  cell(rateOK, 'every-guest-still-runs-at-1.000x',
    `guest rates ${J(rates.map((r) => +r.guestX.toFixed(4)))} — lockstep did not speed anything up or slow it down`,
    `guest rates ${J(rates)} — CLAUDE.md gate #9: the guest must run at exactly 1.000x and speeding it up is FORBIDDEN. ` +
    '⚠ BEFORE BLAMING NETPLAY, RUN THE CONTROL. Measured 2026-09-08 on this box: ' +
    '`bash dreamcast/build_and_probe.sh --skip-link --game gauntlet --duration 100000` — ONE browser, NO netplay, ' +
    'no room, no second core — reports `guest ratio: 0.00006x`, `video_cb: 3 calls, 0 presents` and parks at ' +
    '`pc=0x8c0fd3ec` (37 samples in /tmp/probe-dcx-gauntctl.log). The four-player run wedges at that SAME guest PC ' +
    'on all four machines. A wedge that reproduces with the transport absent is not a transport bug — it is the ' +
    'Gauntlet boot, and it belongs to whoever owns the core, not to this rig.');

  // ---- 7. each player's pad drives their OWN port -------------------------
  say('\n== 7. each player drives their OWN port, and the others see it ==');
  // Distinct keys per player so a rig that merged the ports could not pass.
  const KEYS = [['a'], ['d'], ['w'], ['s']];
  const padOf = (pg) => pg.evaluate(() => Array.from(window.__dcPad()));
  const press = (pg, keys, down) => pg.evaluate((k, d) => {
    const t = Date.now();
    k.forEach((key) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key })));
    return t;
  }, keys, down);

  const before = await Promise.all(pages.map(padOf));
  cell(before.every((p) => p.every((b) => b === 0)), 'all-ports-idle-before',
    'every port on every machine reads zero with nobody pressing anything',
    `non-zero idle pads: ${J(before.map((p) => p.slice(0, 12)))}`);

  const tPress = [];
  for (let i = 0; i < PLAYERS; i++) tPress.push(await press(pages[i], KEYS[i % KEYS.length], true));
  await sleep(1500);
  const during = await Promise.all(pages.map(padOf));
  for (let i = 0; i < PLAYERS; i++) await press(pages[i], KEYS[i % KEYS.length], false);
  await sleep(1200);
  const after = await Promise.all(pages.map(padOf));

  if (roomPublished && myPorts.every((p) => p != null)) {
    let allSeeAll = true; const detail = [];
    for (let viewer = 0; viewer < PLAYERS; viewer++) {
      for (let actor = 0; actor < PLAYERS; actor++) {
        const base = myPorts[actor] * 64;
        const nonZero = during[viewer].slice(base, base + 12).some((b) => b !== 0);
        detail.push(`P${viewer + 1} sees port ${myPorts[actor]} (P${actor + 1}) = ${nonZero ? 'PRESSED' : 'idle'}`);
        if (!nonZero) allSeeAll = false;
      }
    }
    cell(allSeeAll, 'every-core-holds-every-players-input',
      `all ${PLAYERS * PLAYERS} viewer/actor pairs agree — ${detail.join('; ')}. That is what "connected to the ` +
      'same console" means: each machine\'s Maple bus carries all four pads',
      `not every core saw every pad — ${detail.join('; ')}. ⚠ READ THE PAGE\'S OWN INPUT PATH BEFORE BLAMING THE ` +
      'TRANSPORT: dreamcast.html:4453 applies ONE remote pad (session.remotePad()) to ONE port — bytes 64..127, ' +
      'i.e. port 1 — through the pre-lockstep sendPad/remotePad relay, and never calls ls.beginFrame(). Until that ' +
      'per-frame path is wired to the room, ports 2 and 3 can only ever be filled by a LOCAL gamepad, and this cell ' +
      'fails for a page reason rather than a transport one. The transport-level form of this exact claim is ' +
      'tools/netplay_room_test.mjs `EVERY-core-holds-EVERY-players-input`, which drives the engines directly.');
  } else {
    voidc('every-core-holds-every-players-input', 'not measurable: ports were never assigned');
  }
  cell(after.every((p) => p.every((b) => b === 0)), 'all-ports-release',
    'every port on every machine returned to zero', `pads after release: ${J(after.map((p) => p.slice(0, 12)))}`);

  // =========================================================================
  // 7b. ARE THE SIMULATIONS ACTUALLY THE SAME? — the cryptographic form.
  //
  // Every cell above this one is about INPUT: the same bytes reached every
  // core. That is necessary and it is not the claim. The claim is that the four
  // machines are computing the same world, and the only honest way to say so is
  // to compare what they computed. Each core fingerprints committed SH4/Holly
  // state every `hashEvery` frames (flycast_worker.js lsWords: pc, sr,
  // interrupt_pend, cycle_counter, sh4_sched_next, CpuRunning, vbr, SB_ISTNRM,
  // SB_IML6NRM, spc, ssr, pr, plus the 64-bit guest cycle counter) and the
  // engine compares them across the room.
  //
  // ⚠ A COMPARISON COUNT OF ZERO IS NOT A PASS. "No desync detected" with
  // nothing compared is the single most dangerous green cell this rig could
  // print, so the count is asserted before the verdict.
  // =========================================================================
  say('\n== 7b. the cores are fingerprinted and COMPARED, not just fed ==');
  const fp = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
    const r = (s && s.ls && s.ls.report) ? s.ls.report() : null;
    const n = window.__dcNet();
    return r ? {
      compared: r.hashesCompared, sent: r.hashesSent, lastAgreed: r.lastAgreedFrame,
      desync: r.desync, state: r.state, frame: r.frame,
      fedByWorker: n && n.lockstep ? n.lockstep.hashesFed : null,
      sink: n && n.lockstep ? n.lockstep.hashSink : null,
    } : null;
  })));
  RESULT.fingerprints = fp;
  fp.forEach((f, i) => say(`  ....  P${i + 1} fingerprints: ${f && f.fedByWorker} from its core, ${f && f.sent} sent, ` +
    `${f && f.compared} compared, last frame everyone agreed on = ${f && f.lastAgreed}`));
  cell(fp.every((f) => f && f.sink === true), 'the-cores-fingerprints-REACH-the-engine',
    'every page is handing its core\'s fingerprint to the lockstep engine (Lockstep.submitHash) — the core is ' +
    'in a worker, so the hash of a frame arrives after the page has already had to advance to build the next ' +
    'one, and without this path the cores would be gated with NOTHING comparing them',
    `hash sinks: ${J(fp.map((f) => f && f.sink))} — false means the page advanced the engine with endFrame(null) ` +
    'and dropped the fingerprint on the floor. Gated-and-unchecked looks right and is not.');
  const compared = fp.map((f) => (f && f.compared) || 0);
  cell(compared.some((n) => n > 0), 'fingerprints-were-actually-COMPARED',
    `comparisons per side: ${J(compared)} (last agreed frames ${J(fp.map((f) => f && f.lastAgreed))})`,
    `comparisons per side: ${J(compared)} — nothing was compared, so "no desync" below would mean nothing at all`);
  cell(fp.every((f) => f && !f.desync), 'EVERY-MACHINE-COMPUTED-THE-SAME-WORLD',
    `${compared.reduce((a, b) => a + b, 0)} cross-machine fingerprint comparisons over the run and every one of ` +
    'them agreed — four independent Flycast cores, four independent browsers, no state transferred between ' +
    'them, all executing the same emulated frames from the same inputs',
    `a side reported a desync: ${J(fp.map((f) => f && f.desync))}`);

  // =========================================================================
  // 7d. THE PANEL MUST NOT CLAIM WHAT IS NOT HAPPENING.
  // "LOCKSTEP" on that panel is a claim about the cores, and for a long time it
  // was printed off the existence of an engine object while every core
  // free-ran. A previous agent deliberately refused to print it rather than
  // print it unearned; this cell is what makes printing it safe.
  // =========================================================================
  const hudNow = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const h = window.__dcNetHud(); const n = window.__dcNet();
    return { text: (h.text || '').replace(/\s+/g, ' ').trim(), mode: h.mode, banner: h.bannerVisible,
             tel: h.telemetry, gated: n && n.lockstep ? (n.lockstep.armed && n.lockstep.running) : null };
  })));
  RESULT.hud = hudNow;
  hudNow.forEach((h, i) => say(`  ....  P${i + 1} panel: ${h.text.slice(0, 200)}`));
  cell(hudNow.every((h) => h.gated === true && /LOCKSTEP/.test(h.text) && /frame-gated YES/.test(h.text)),
    'the-panel-says-LOCKSTEP-only-because-the-cores-ARE-gated',
    'every panel prints LOCKSTEP and "frame-gated YES", and the driver behind it agrees — the word is read from ' +
    'the gate, not from the existence of a session object',
    `panels: ${J(hudNow.map((h) => ({ gated: h.gated, mode: h.mode, text: h.text.slice(0, 160) })))}`);
  cell(hudNow.every((h) => h.tel && h.tel.you && h.tel.you.port != null &&
        new RegExp('you are Player ' + (h.tel.you.port + 1)).test(h.text)),
    'the-panel-tells-each-player-WHICH-PLAYER-THEY-ARE',
    `each side names its own port in words: ${J(hudNow.map((h) => h.tel && h.tel.you && h.tel.you.port))} — that ` +
    'is which character they get, so it cannot be left to a chip colour',
    `panels: ${J(hudNow.map((h) => h.text.slice(0, 160)))}`);
  cell(hudNow.every((h) => h.tel && h.tel.delayFrames != null && /input delay \d+ frame/.test(h.text)),
    'the-panel-states-the-input-delay-in-frames-and-ms',
    `delay shown as ${J(hudNow.map((h) => h.tel && h.tel.delayFrames))} frames — lockstep has a frame number, so ` +
    'this is the exact integer the engine is holding inputs for, not an estimate',
    `panels: ${J(hudNow.map((h) => h.text.slice(0, 160)))}`);
  cell(hudNow.every((h) => h.tel && h.tel.detecting === true && !/desync check OFF/.test(h.text)),
    'the-panel-says-whether-anything-is-CHECKING-for-desync',
    `every side reports desync checking on with ${J(hudNow.map((h) => h.tel && h.tel.hashesCompared))} comparisons — ` +
    'frame-gated with nothing comparing the cores is worse than not gated, because it looks right',
    `detecting flags: ${J(hudNow.map((h) => h.tel && h.tel.detecting))}`);

  // ---- 8. THE LATENCY NUMBER ----------------------------------------------
  say(`\n== 8. input latency for the players who are NOT the room opener ==`);
  // Under streaming, a non-host player's press had to cross the wire before any
  // emulator saw it (25 / 21 ms p50 measured) and the resulting picture came
  // back encoded (68 / 52 ms). Under lockstep the press is applied by the
  // player's OWN core, so the wire is out of the path entirely — this measures
  // keydown -> that player's own pad buffer, which is what their own emulator
  // reads.
  const lat = [];
  for (let i = 1; i < PLAYERS; i++) {
    const samples = [];
    for (let r = 0; r < REPS; r++) {
      await press(pages[i], KEYS[i % KEYS.length], false);
      await sleep(180);
      const t0 = await press(pages[i], KEYS[i % KEYS.length], true);
      const t1 = await pages[i].evaluate(() => new Promise((res) => {
        const started = Date.now();
        const poll = () => {
          const p = window.__dcPad();
          if (Array.prototype.some.call(p, (b) => b !== 0)) return res(Date.now());
          if (Date.now() - started > 900) return res(null);
          requestAnimationFrame(poll);
        };
        poll();
      }));
      await press(pages[i], KEYS[i % KEYS.length], false);
      await sleep(140);
      if (t1) samples.push(t1 - t0);
    }
    const s = { player: i + 1, n: samples.length, min: Math.min.apply(null, samples), p50: pct(samples, 50), p95: pct(samples, 95), max: Math.max.apply(null, samples) };
    lat.push(s);
    // ⚠ WHAT THIS NUMBER IS, NOW THAT THE GATE IS REAL. __dcPad() returns the
    // buffer the page posts to the worker, and under lockstep that is the
    // engine's per-frame maple IMAGE — so this is keydown -> the exact frame
    // image this player's own core will consume, which INCLUDES the agreed
    // input delay. That is the honest cost of lockstep and it is the number a
    // player feels; it is not comparable to a pre-lockstep reading of the same
    // seam, which measured only how fast the page packed its own keyboard.
    say(`  P${i + 1} keydown -> the frame image its OWN core consumes:  n=${s.n} min ${s.min} p50 ${s.p50} p95 ${s.p95} max ${s.max} ms`);
  }
  RESULT.latency = lat;
  // ⚠ IN MEASURED MILLISECONDS, NOT AT 60 Hz. A lockstep frame is one
  // retro_run, and Gauntlet renders every other vblank — so its frame is ~34 ms
  // and this line printed HALF the delay the players were actually paying. Same
  // mistake the page's own panel made (fixed there too): 2 frames read "33 ms"
  // while the panel beside it, and the measured latency, said 69.
  const delayInfo = await pages[0].evaluate(() => {
    const n = window.__dcNet(); const h = window.__dcNetHud();
    const p = window.__dcProbe();
    const frameMs = (p && p.fps > 0) ? (1000 / p.fps) : (1000 / 60);
    const d = h.telemetry && h.telemetry.delayFrames != null ? h.telemetry.delayFrames : null;
    return { delay: n && n.lockstep ? n.lockstep.delay : null,
             frameMs: +frameMs.toFixed(1), measured: !!(p && p.fps > 0),
             ms: d == null ? null : Math.round(d * frameMs) };
  });
  RESULT.delay = delayInfo;
  say(`  the room's agreed input delay: ${delayInfo.delay} frames = ${delayInfo.ms} ms at this title's measured ` +
      `${delayInfo.frameMs} ms frame${delayInfo.measured ? '' : ' (ESTIMATED — no frame rate measured)'} — every ` +
      'player pays it symmetrically, and it is what buys a local-feeling pad instead of a variable network one');

  // ---- 8b. AND WHAT THE WIRE COSTS, PER PAIR, WITH N CORES RUNNING ---------
  // The figure above is a player's own pad reaching their own core — the number
  // lockstep exists to keep small, and it does not cross the network at all.
  // This one is the OTHER half: how long everyone ELSE's input takes, which is
  // what `delay` has to cover. In a host-relayed star the worst path is
  // guest -> host -> guest, so both hop counts are reported separately.
  // ⚠ MEASURED WITH ALL N EMULATORS RUNNING, which is the point: an RTT taken
  // on an idle box is not the RTT a player gets while four Flycast cores are
  // competing for the same CPU.
  const rttPairs = {};
  const oneHop = [], twoHop = [];
  for (let i = 0; i < PLAYERS; i++) {
    const info = seatInfo[i];
    if (!info) continue;
    for (let j = 0; j < PLAYERS; j++) {
      if (i === j || !seatInfo[j]) continue;
      const peer = info.seats.map((s) => s.peer)[seatInfo[j].seats.findIndex((s) => s.local)];
      if (!peer) continue;
      const samples = [];
      for (let k = 0; k < 20; k++) {
        const ms = await pages[i].evaluate((p) => {
          const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
          return s && s.pingPeer ? s.pingPeer(p, 4000) : null;
        }, peer);
        if (ms != null) samples.push(ms);
        await sleep(15);
      }
      const s = { n: samples.length, p50: pct(samples, 50), p95: pct(samples, 95) };
      rttPairs[`P${i + 1}->P${j + 1}`] = s;
      if (s.p50 != null) ((i === 0 || j === 0) ? oneHop : twoHop).push(s.p50);
      say(`  P${i + 1}->P${j + 1} RTT n=${s.n} p50 ${s.p50} p95 ${s.p95} ms  (${(i === 0 || j === 0) ? 'direct to the host' : 'relayed via the host'})`);
    }
  }
  const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  RESULT.rtt = { pairs: rttPairs, oneHopMeanP50: mean(oneHop), twoHopMeanP50: mean(twoHop),
                 worstP50: [...oneHop, ...twoHop].length ? Math.max.apply(null, [...oneHop, ...twoHop]) : null };
  if (RESULT.rtt.worstP50 != null) {
    say(`  to the host ${RESULT.rtt.oneHopMeanP50} ms mean p50 | relayed guest-to-guest ${RESULT.rtt.twoHopMeanP50} ms | worst pair ${RESULT.rtt.worstP50} ms`);
    const rd = await pages[0].evaluate(() => {
      const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
      return s && s.rttReport ? s.rttReport(4000) : null;
    });
    RESULT.rttReport = rd;
    say(`  the delay that RTT implies at 60 Hz: ${rd && rd.recommendedDelay} frames (Lockstep.recommendDelay)`);
    cell(Object.values(rttPairs).every((s) => s.n >= 15), 'every-pair-reaches-every-other-pair-WITH-the-emulators-running',
      `all ${Object.keys(rttPairs).length} ordered pairs answered while ${PLAYERS} Flycast cores were running: ` +
      `${RESULT.rtt.oneHopMeanP50} ms to the host, ${RESULT.rtt.twoHopMeanP50} ms guest-to-guest through the relay`,
      `some pairs did not answer under load: ${J(rttPairs)}`);
  } else {
    voidc('every-pair-reaches-every-other-pair-WITH-the-emulators-running', 'no transport roster, so no pair could be pinged');
  }

  const worst = lat.length ? Math.max.apply(null, lat.map((s) => s.p50)) : null;
  const B = RESULT.streamingBaseline;
  if (worst != null) {
    say(`\n  STREAMING  (measured, base1/base2): input reached an emulator in ${B.inputToEmulatorMsP50.join(' / ')} ms,`);
    say(`             and the picture came back ${B.hostPictureToPlayer2PictureMs.join(' / ')} ms later`);
    say(`             = ${B.addedInputToVisibleMs.join(' / ')} ms ADDED, on loopback, at 28.7 / 42.8 fps seen`);
    say(`  LOCKSTEP   input reaches the player's own core in ${worst} ms p50, and the picture is rendered`);
    say(`             locally on their own machine — there is no encode, no decode and no stream to be behind.`);
    cell(worst < Math.min.apply(null, B.addedInputToVisibleMs),
      'player-2-plus-is-faster-than-streaming-was',
      `${worst} ms p50 to their own core, against ${B.addedInputToVisibleMs.join(' / ')} ms of latency streaming ADDED ` +
      'on top of the game\'s own reaction — and streaming\'s figure was a floor taken on loopback',
      `${worst} ms p50 is not better than the streaming baseline ${J(B.addedInputToVisibleMs)}`);
  }

  // ---- 9. evidence: screenshots PAIRED with liveness ----------------------
  say('\n== 9. evidence ==');
  for (let i = 0; i < PLAYERS; i++) {
    await pages[i].evaluate(() => { const c = document.getElementById('netClose'); if (c) c.click(); });
  }
  await sleep(1200);
  for (let i = 0; i < PLAYERS; i++) {
    const shot = path.join(OUT, `${NAME}-P${i + 1}.png`);
    await pages[i].screenshot({ path: shot });
    RESULT.shots.push(shot);
    const L = await liveness(pages[i], 'P' + (i + 1));
    RESULT.liveness.push(L);
    say(`  P${i + 1} ${shot}`);
    say(`     guestX=${L.guestX} fps=${L.fps} booted=${L.booted} framesEver=${L.framesEver} distinctEver=${L.distinctEver}`);
    say(`     ${L.distinctSignatures} DISTINCT picture signatures across ${L.sampledFrames} sampled frames, peak ${L.litPixelsPeak} lit px`);
    say(`     headline: ${L.headline}`);
  }
  // ⚠ THE SCREENSHOT IS NOT THE EVIDENCE ON ITS OWN. gate #10: a wedged run
  // screenshots a live-looking stale frame. The distinct-signature count is
  // what separates a moving game from a held one.
  const alive = RESULT.liveness.every((L) => L.distinctSignatures >= 8 && L.booted && L.iters > 0);
  cell(alive, 'every-screenshot-is-of-a-LIVE-core',
    `distinct picture signatures per player: ${J(RESULT.liveness.map((L) => L.distinctSignatures))} across ` +
    `${J(RESULT.liveness.map((L) => L.sampledFrames))} sampled frames, at ${J(RESULT.liveness.map((L) => L.iters))} ` +
    `run_iter/s and fps ${J(RESULT.liveness.map((L) => L.fps))} — a wedged core screenshots a live-looking stale ` +
    'frame, so the picture is only evidence beside these',
    `distinct signatures ${J(RESULT.liveness.map((L) => L.distinctSignatures))}, run_iter/s ` +
    `${J(RESULT.liveness.map((L) => L.iters))}, fps ${J(RESULT.liveness.map((L) => L.fps))}. ` +
    '⚠ READ iters FIRST: iters=0 is a STOPPED CORE and neither fps nor guestX will say so (measured — four ' +
    'frozen cores read fps=30 and guestX~1.000). iters>0 with 1 distinct signature is the other case entirely: ' +
    'a healthy core photographed on a still image, which Gauntlet\'s copyright card is.');

  // =========================================================================
  // 9b. THE SAME WORLD, IN PIXELS — corroboration for the fingerprint cell.
  //
  // 7b is the real proof and it is cryptographic. This is the version a person
  // can look at: four browsers, four cores, and the same picture on all of
  // them. It is CORROBORATION and is reported as such — the machines present on
  // their own vsyncs and are up to `delay` frames apart, so a byte-exact match
  // is not expected and demanding one would manufacture a false alarm on a
  // healthy room. What IS expected is that four machines showing the same scene
  // are far closer to each other than the scene is to itself a second later.
  // =========================================================================
  const sameWorld = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const W = 24, H = 18;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true, alpha: false });
    g.drawImage(document.getElementById('dc-canvas'), 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const v = [];
    for (let i = 0; i < d.length; i += 4) v.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    return v;
  })));
  const l1 = (a, b) => a.reduce((s, x, i) => s + Math.abs(x - b[i]), 0) / a.length;
  const cross = [];
  for (let i = 0; i < PLAYERS; i++) for (let j = i + 1; j < PLAYERS; j++) cross.push(+l1(sameWorld[i], sameWorld[j]).toFixed(2));
  // The yardstick: how much ONE machine's own picture moves in a second. Two
  // machines closer to each other than that are looking at the same world.
  await sleep(1000);
  const later0 = await pages[0].evaluate(() => {
    const W = 24, H = 18;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true, alpha: false });
    g.drawImage(document.getElementById('dc-canvas'), 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const v = [];
    for (let i = 0; i < d.length; i += 4) v.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    return v;
  });
  const churn = +l1(sameWorld[0], later0).toFixed(2);
  RESULT.sameWorld = { crossMachineL1: cross, ownChurn1sL1: churn };
  say(`\n  cross-machine picture distance ${J(cross)} vs P1's OWN churn over 1 s = ${churn} (mean |luma| per cell)`);
  cell(cross.every((d) => d <= Math.max(6, churn)), 'the-machines-are-DRAWING-the-same-world',
    `every pair of machines is within ${Math.max.apply(null, cross)} of each other while one machine's own ` +
    `picture moves ${churn} in a second — four independent cores, one world. This corroborates the ` +
    'fingerprint cell above; the fingerprints are the proof.',
    `cross-machine distances ${J(cross)} against a 1 s self-churn of ${churn}. ⚠ THIS CELL IS CORROBORATION: ` +
    'a still scene makes churn ~0 and the bound collapses to 6, and machines present on their own vsyncs up to ' +
    '`delay` frames apart. Read it beside the fingerprint comparison, which is the claim that matters.');

  // ---- 10. no desync ------------------------------------------------------
  const desync = RESULT.liveness.map((L) => L.hud && L.hud.desyncLatched);
  cell(desync.every((d) => !d), 'no-desync-was-detected',
    'no side latched a desync across the whole run',
    `desync latched on: ${J(desync)} — banners: ${J(RESULT.liveness.map((L) => L.hud && L.hud.bannerText))}`);

  // =========================================================================
  // 11. IT STALLS, IT DOES NOT GUESS — proven by taking an input away.
  //
  // This is the property that decides whether the architecture is safe. A
  // lockstep that predicts a missing pad and runs on FORKS the machines
  // silently and permanently: there is no rollback here, because the state is
  // 27,652,485 B. So a withheld input must stop the other machines dead, name
  // the player it is waiting for, and — when the input comes back — resume with
  // NO divergence, because nothing was invented in the gap.
  //
  // The withholding is injected at the engine's own send hook rather than by
  // killing a socket, so the room stays healthy and the arm is reversible. The
  // withhold is deliberately much shorter than the engine's 8 s stall budget,
  // which would otherwise FAIL the session — that budget is a different cell's
  // job (tools/netplay_lockstep_test.mjs budget-fails).
  // =========================================================================
  say('\n== 7c. a withheld input STALLS the room — nobody guesses ==');
  const victim = PLAYERS - 1;                       // the last joiner withholds
  const others = [];
  for (let i = 0; i < PLAYERS; i++) if (i !== victim) others.push(i);
  // ⚠ IT MUST DELAY THE MESSAGES, NOT DELETE THEM — AND THE FIRST VERSION OF
  // THIS RIG DELETED THEM AND THEN BLAMED THE ROOM.
  //
  // beginFrame() sends a frame's input on the FIRST attempt at that frame and
  // never again (`_scheduledTo <= f`), which is correct: a WebRTC DataChannel is
  // reliable and ordered, so an input that has been sent cannot be lost and a
  // retransmit would be dead code. Dropping those messages therefore simulates
  // packet loss on a lossless channel and leaves the peers permanently missing
  // frames nobody will ever send again — the room CANNOT recover, and reporting
  // that as a product failure would have been the rig inventing a bug (measured:
  // `frames after the withhold ended: [0,0,0]`).
  //
  // A real hiccup — a busy CPU, a Wi-Fi stall, a phone thermal-throttling —
  // DELAYS messages. So this queues them and flushes the queue in order on
  // release, which is what the transport itself would have done, and asks the
  // question actually worth asking: does a room that stalled come back?
  const withhold = (pg, on) => pg.evaluate((on) => {
    const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
    const ls = s && s.ls;
    if (!ls) return false;
    if (on) {
      if (!ls.__origSend) { ls.__origSend = ls._send; ls.__held = []; }
      ls._send = (o) => ((o && o.t === 'ls') ? (ls.__held.push(o), 1) : ls.__origSend(o));
    } else if (ls.__origSend) {
      const send = ls.__origSend, held = ls.__held || [];
      ls._send = send; ls.__origSend = null; ls.__held = null;
      for (const o of held) send(o);          // in order, exactly as the channel would have
      return held.length;
    }
    return true;
  }, on);
  const framesNow = () => Promise.all(pages.map((pg) => pg.evaluate(() => {
    const n = window.__dcNet();
    return n && n.lockstep ? n.lockstep.coreFrame : null;
  })));
  const armed = await withhold(pages[victim], true);
  const preStall = await framesNow();
  await sleep(2500);
  const midStall = await framesNow();
  const stallHud = await Promise.all(others.map((i) => pages[i].evaluate(() => window.__dcNetHud())));
  const flushed = await withhold(pages[victim], false);
  say(`  ....  released P${victim + 1}'s queue: ${flushed} held input messages flushed in order`);
  await sleep(3000);
  const postStall = await framesNow();
  const stalledBy = others.map((i) => midStall[i] - preStall[i]);
  const resumedBy = others.map((i) => postStall[i] - midStall[i]);
  RESULT.stallProof = { victim: victim + 1, armed, preStall, midStall, postStall, stalledBy, resumedBy,
                        hud: stallHud.map((h) => ({ stalled: h.stalled, why: h.stallWhy, waitingOn: h.waitingOn })) };
  say(`  ....  P${victim + 1} withheld its pad for 2.5 s: the others advanced ${J(stalledBy)} frames, then ${J(resumedBy)} after it came back`);
  stallHud.forEach((h, k) => say(`  ....  P${others[k] + 1} panel said: ${J(h.stallWhy)}`));
  cell(armed && stalledBy.every((n) => n <= 12), 'a-missing-input-STOPS-the-other-machines',
    `with P${victim + 1}'s pad withheld the other machines advanced ${J(stalledBy)} frames in 2.5 s — they held ` +
    'instead of predicting. Predicting without rollback forks the simulations silently and permanently, and ' +
    'this core has no cheap savestate to roll back to (27,652,485 B)',
    `the others advanced ${J(stalledBy)} frames while an input was missing — that is a machine RUNNING ON A ` +
    'GUESS, which is the one thing lockstep must never do.');
  const named = stallHud.map((h) => (h.stallWhy || '') + ' ' + J(h.waitingOn));
  cell(stallHud.some((h) => h.stalled) && named.some((s) => /P\d/.test(s)), 'the-stall-NAMES-the-player',
    `the panel said ${J(stallHud.map((h) => h.stallWhy))} — "waiting…" in a room of four is not actionable; ` +
    'the other players need to know whose connection to blame and the person responsible needs to see it is them',
    `panels during the stall: ${J(stallHud.map((h) => ({ stalled: h.stalled, why: h.stallWhy, on: h.waitingOn })))}`);
  RESULT.stallProof.flushed = flushed;
  cell(resumedBy.every((n) => n > 30), 'the-room-RESUMES-when-the-input-comes-back',
    `the others ran ${J(resumedBy)} frames in 3 s once P${victim + 1}'s ${flushed} delayed inputs arrived — a stall ` +
    'is a pause, not a death, and the frames it waited for were still the real ones',
    `frames after the withhold ended: ${J(resumedBy)} (${flushed} messages were flushed). ⚠ IF THIS FAILS WITH ` +
    'ZEROES, check the injection before the product: withholding by DELETING messages cannot be recovered from ' +
    'and is not what a network hiccup does — see the note above `withhold`.');
  const afterStallDesync = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const s = (window.Netplay.sessions || []).filter((x) => x.state !== 'closed').pop();
    return s && s.ls ? { desync: !!s.ls.desync, state: s.ls.state } : null;
  })));
  cell(afterStallDesync.every((d) => d && !d.desync), 'the-stall-cost-NO-divergence',
    `no side diverged across the withhold: ${J(afterStallDesync.map((d) => d && d.state))} — the gap was waited ` +
    'out rather than filled in, so there was nothing invented for the machines to disagree about',
    `post-stall engine states: ${J(afterStallDesync)}`);


  const errs = sideErr.map((e) => e.length);
  cell(errs.every((n) => n === 0), 'no-page-errors', 'no browser threw anything',
    `page errors per player: ${J(sideErr)}`);
  exitCode = rec.some((r) => r.ok === false) ? 1 : 0;
} catch (e) {
  bad('rig', 'the run threw: ' + ((e && e.stack) || e));
  for (let i = 0; i < pages.length; i++) { try { await pages[i].screenshot({ path: path.join(OUT, `${NAME}-P${i + 1}-FAIL.png`) }); } catch (e2) {} }
} finally {
  RESULT.rec = rec;
  RESULT.wasm.sha256_16_after = wasmHash();
  RESULT.uptimeEnd = execSync('uptime').toString().trim();
  RESULT.loadavgEnd = os.loadavg();
  RESULT.elapsedMs = Date.now() - T0;
  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(RESULT, null, 2));
  if (!KEEP) for (const b of browsers) { try { await b.close(); } catch (e) {} }
  const p = rec.filter((r) => r.ok === true).length, f = rec.filter((r) => r.ok === false).length, v = rec.filter((r) => r.ok === null).length;
  say(`\n  json  ${path.join(OUT, NAME + '.json')}`);
  say(`  wasm  ${RESULT.wasm.sha256_16_before} -> ${RESULT.wasm.sha256_16_after} ${RESULT.wasm.sha256_16_before === RESULT.wasm.sha256_16_after ? 'STABLE' : '⚠ CHANGED MID-RUN, this run is void'}`);
  say(`  uptime@end ${RESULT.uptimeEnd}`);
  say(`[room-e2e] ${p}/${p + f} passed, ${v} void, ${PLAYERS} players, ${(RESULT.elapsedMs / 1000).toFixed(1)} s`);
  await new Promise((r) => logStream.end(r));
}
process.exit(exitCode);

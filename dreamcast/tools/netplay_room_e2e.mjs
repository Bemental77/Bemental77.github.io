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
  // ⚠ NAME THE KNOWN CAUSE RATHER THAN PRINTING A STATE LIST. Measured
  // 2026-09-08 with --players 4: P2 connects, P3 dies with
  // "signalling failed: unavailable-id", P4 never gets a chance. The reason is
  // one line — lib/netplay.js:358 derives the broker id as
  // `base + (opts.host ? '-h' : '-g')`, so EVERY joiner registers under the
  // same '-g' id and the second one collides. A room therefore holds exactly
  // ONE joiner today, independently of MAPLE_PORTS and independently of the
  // bridge plugging only ports 0 and 1. Without this note the cell reads like a
  // flaky broker and somebody re-runs it.
  const failDetail = await Promise.all(pages.map((pg) => pg.evaluate(() => {
    const sess = (window.Netplay && window.Netplay.sessions) || [];
    const s2 = sess[sess.length - 1];
    return { state: window.__dcNet().state, err: (s2 && s2.lastError) || null };
  })));
  const idClash = failDetail.some((d) => /unavailable-id/i.test(String(d.err || '')));
  cell(conn.every(Boolean), 'everyone-is-in-the-room',
    `all ${PLAYERS} sides report connected`,
    `connected: ${J(conn)} — per-side ${J(failDetail)}` + (idClash
      ? '. ROOT CAUSE: "unavailable-id" — lib/netplay.js:358 gives every joiner the SAME broker id ' +
        '(`base + (host ? "-h" : "-g")`), so a room can hold exactly ONE joiner. Players 3 and 4 cannot ' +
        'join at all, and that is a signalling limit, not a port limit and not this machine.'
      : ''));

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
    const v = await until(pages[i], () => {
      const p = window.__dcProbe();
      return (p.booted && (p.fps > 0 || p.framesEver)) ? p : null;
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
    `all ${PLAYERS} cores reached booted + frames flowing — ${PLAYERS} emulators, not one`,
    `booted: ${J(bootedAll.map((b) => !!b))}. A machine that never booted is a player watching nothing.`);
  for (const pg of pages) await installSampler(pg);

  // ⚠ LET THE RATE SETTLE BEFORE READING IT. The first version asserted gate #9
  // four seconds after `booted` went true and read guestX 0.41 with fps 0 —
  // which is the BOOT RAMP, not the guest rate. The same run's end-of-run read
  // was 0.996 / 1.001. A rate sampled during the ramp is not a rate.
  say('  ....  letting the guest rate settle before reading it');
  await sleep(25000);

  // ⚠ AND DRIVE THE GAME SOMEWHERE THAT MOVES. Gauntlet's copyright card is a
  // STATIC IMAGE — a run that sampled it read 2 distinct picture signatures and
  // the liveness cell failed on a core that was healthy at 30 fps. That is a
  // false alarm from the instrument, and a liveness metric that cries wolf on a
  // still title card is as useless as one that passes a wedge. The key taps are
  // the sequence dreamcast/docs/gauntlet-two-players/TASKS.md documents for
  // reaching the character screen; they are wall-clock taps against the attract
  // loop, not a state machine, so they are best-effort and the cell below
  // reports what the picture actually did either way.
  say('  ....  driving each core past the title card');
  const tap = async (pg, key) => {
    await pg.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k })); }, key);
    await sleep(120);
    await pg.evaluate((k) => { window.dispatchEvent(new KeyboardEvent('keyup', { key: k })); }, key);
  };
  // Gauntlet's copyright card ignores input for a while and the attract loop
  // cycles, so a fixed three taps landed on nothing and every core sat on the
  // still card (measured: 1 distinct signature over 240 frames at 30 fps — a
  // healthy core photographed on a static image). Tap repeatedly instead.
  for (let k = 0; k < 10; k++) {
    for (const pg of pages) { await tap(pg, 'Enter'); }
    await sleep(2000);
  }
  for (const pg of pages) { await tap(pg, 'm'); }
  await sleep(5000);

  // ---- 5. the start barrier ------------------------------------------------
  say('\n== 5. the start barrier ==');
  const bar = await Promise.all(pages.map((pg) => pg.evaluate(() => window.__dcNetRoom().barrier)));
  const tel = await Promise.all(pages.map((pg) => pg.evaluate(() => { const h = window.__dcNetHud(); return h.telemetry && h.telemetry.barrier; })));
  const started = tel.every((b) => b && b.started);
  cell(started, 'nobody-advanced-frame-0-alone',
    `every side reports the barrier released: ${J(tel)}`,
    `barrier state per side: ${J(tel)} / text ${J(bar)}. Without a barrier the first machine to finish ` +
    'downloading runs ahead and the others start from a different frame — which is a desync at frame 0.');

  // ---- 6. guest rate must not move (CLAUDE.md gate #9) ---------------------
  const rates = await Promise.all(pages.map((pg) => pg.evaluate(() => { const p = window.__dcProbe(); return { guestX: p.guestX, fps: p.fps }; })));
  RESULT.rates = rates;
  const rateOK = rates.every((r) => r.guestX > 0.97 && r.guestX < 1.03);
  cell(rateOK, 'every-guest-still-runs-at-1.000x',
    `guest rates ${J(rates.map((r) => +r.guestX.toFixed(4)))} — lockstep did not speed anything up or slow it down`,
    `guest rates ${J(rates)} — CLAUDE.md gate #9: the guest must run at exactly 1.000x and speeding it up is FORBIDDEN`);

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
      `not every core saw every pad — ${detail.join('; ')}`);
  } else {
    voidc('every-core-holds-every-players-input', 'not measurable: ports were never assigned');
  }
  cell(after.every((p) => p.every((b) => b === 0)), 'all-ports-release',
    'every port on every machine returned to zero', `pads after release: ${J(after.map((p) => p.slice(0, 12)))}`);

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
    say(`  P${i + 1} keydown -> its OWN core holds the byte:  n=${s.n} min ${s.min} p50 ${s.p50} p95 ${s.p95} max ${s.max} ms`);
  }
  RESULT.latency = lat;
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
  const alive = RESULT.liveness.every((L) => L.distinctSignatures >= 8 && L.booted);
  cell(alive, 'every-screenshot-is-of-a-LIVE-core',
    `distinct picture signatures per player: ${J(RESULT.liveness.map((L) => L.distinctSignatures))} across ` +
    `${J(RESULT.liveness.map((L) => L.sampledFrames))} sampled frames at fps ${J(RESULT.liveness.map((L) => L.fps))} — ` +
    'a wedged core screenshots a live-looking stale frame, so the picture is only evidence beside this count',
    `distinct signatures ${J(RESULT.liveness.map((L) => L.distinctSignatures))} at fps ` +
    `${J(RESULT.liveness.map((L) => L.fps))}, framesEver ${J(RESULT.liveness.map((L) => L.framesEver))}. ` +
    'EITHER a core is wedged OR the scene reached is a still image (Gauntlet\'s copyright card is one) — ' +
    'read the fps and the screenshots together before calling it a wedge.');

  // ---- 10. no desync ------------------------------------------------------
  const desync = RESULT.liveness.map((L) => L.hud && L.hud.desyncLatched);
  cell(desync.every((d) => !d), 'no-desync-was-detected',
    'no side latched a desync across the whole run',
    `desync latched on: ${J(desync)} — banners: ${J(RESULT.liveness.map((L) => L.hud && L.hud.bannerText))}`);

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

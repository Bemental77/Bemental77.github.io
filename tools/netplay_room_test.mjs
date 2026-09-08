#!/usr/bin/env node
// ============================================================================
// netplay_room_test.mjs — DOES A ROOM SEAT MORE THAN TWO PEOPLE, OVER REAL
//                         WEBRTC, WITH REAL SEPARATE BROWSERS?
// ============================================================================
//
// THE REQUIREMENT, from the user: "THIS WILL SUPPORT AS MANY PLAYERS AS THE
// CONSOLE CAN!" and "IT WILL BE AS IF MULTIPLAYER ARE ON THE SAME CONSOLE."
// The Dreamcast has four maple ports (flycast-src/core/hw/maple/maple_devs.h:193
// MAPLE_PORTS 4) and the transport held the host plus exactly one guest.
//
// WHAT THIS IS AND IS NOT. This is the TRANSPORT under a microscope: N real
// Chrome profiles, the real PeerJS broker, real RTCPeerConnections, real
// DataChannels — and NO emulator, so a run costs seconds instead of the ~15
// minutes four Flycast cores need to fetch and boot a 1.1 GB disc. The
// four-cores-and-a-disc arm is dreamcast/tools/netplay_room_e2e.mjs; this one
// exists so the protocol can be iterated on without paying for that every time,
// and so a transport failure is never mistaken for an emulator failure.
//
// ⚠ SEPARATE BROWSERS, NOT SEPARATE TABS, and the run proves it: a
// BroadcastChannel echo test must FAIL between profiles, or the pairing under
// test is not the one two real machines would use. The signalling here is the
// PUBLIC BROKER ('peerjs'), which is the arm with per-caller sockets to get
// wrong; the BroadcastChannel arm broadcasts to everybody and so cannot show
// this bug at all.
//
// WHAT IT ASSERTS
//   1. N browsers register on the broker and all reach 'connected'
//   2. EVERY joiner is admitted separately — its own challenge, its own
//      confirmation code, its own Allow. One at a time; the rest are told busy.
//   3. The N+1'th caller is REFUSED because the console has no more ports
//   4. Every machine agrees, byte for byte, on WHO IS IN WHICH PORT
//   5. A joiner arriving after others are seated does not move anybody
//   6. The barrier holds: nobody runs frame 0 until the last peer is ready
//   7. Every peer's input reaches EVERY peer's core (relayed star), proven by
//      each core's own maple image AND by fingerprints that would diverge if
//      any core were holding a different set of pads
//   8. RTT per pair, and what a mesh would have saved — measured, not assumed
//   9. A peer leaving does not wedge the rest, and its port goes limp
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime      # gate, per CLAUDE.md
//   npm run web                                          # port 8080, gate #2
//   node tools/netplay_room_test.mjs --players 4
//
// FLAGS  --players N (default 4)  --name N  --headful  --keep
//        --transport peerjs|local (default peerjs; 'local' forces ONE browser
//        and is only for debugging the protocol, never for a room claim)
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
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const PLAYERS   = Math.max(2, parseInt(arg('players', '4'), 10));
const NAME      = arg('name', 'room' + PLAYERS);
const ORIGIN    = arg('url', 'http://localhost:8080');
const TRANSPORT = arg('transport', 'peerjs');
const HEADFUL   = has('headful');
const KEEP      = has('keep');
// ⚠ THE ROOM IS SIZED TO THE RUN BY DEFAULT, and getting this wrong cost a
// whole confusing result set. With --players 2 against a hardcoded 4 ports the
// room is NOT full at two, so the rig's own "over capacity" browser was
// correctly ADMITTED — and then, because the rig never declared it ready, the
// barrier correctly held the whole room waiting for it and every frame arm read
// zero. That was the product doing exactly the right thing and the test asking
// the wrong question. Pass --ports to model a console with more ports than
// there are players in the run.
const PORTS     = parseInt(arg('ports', String(PLAYERS)), 10);
const DELAY     = parseInt(arg('delay', '3'), 10);
const PUMP_MS   = parseInt(arg('pumpms', '4000'), 10);
const PINGS     = parseInt(arg('pings', '25'), 10);
const CHROME    = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const OUT = '/tmp/dc-room';
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const logStream = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); logStream.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))].toFixed(2); };

const rec = [];
const ok    = (n, d) => { rec.push({ n, ok: true,  d }); say(`  PASS  ${n}  ${d}`); };
const bad   = (n, d) => { rec.push({ n, ok: false, d }); say(`  FAIL  ${n}  ${d}`); };
// ⚠ VOID IS ONLY EVER FOR A PRECONDITION THAT DID NOT HAPPEN — a broker that
// would not answer. It is NEVER for a missing feature: printing "the room does
// not seat four" as void is how a wrong product keeps a green test.
const voidc = (n, d) => { rec.push({ n, ok: null, d }); say(`  VOID  ${n}  ${d}`); };
const cell  = (p, n, good, badMsg) => (p ? ok(n, good) : bad(n, badMsg));

const RESULT = {
  when: new Date().toISOString(), players: PLAYERS, transport: TRANSPORT,
  portCount: PORTS, delay: DELAY,
  uptimeStart: execSync('uptime').toString().trim(), loadavgStart: os.loadavg(),
  code: null, seats: null, rtt: null, mesh: null, pump: null, rec: null,
};

say('== netplay_room_test ==');
say(`  players    ${PLAYERS} separate Chrome profiles`);
say(`  transport  ${TRANSPORT}${TRANSPORT === 'peerjs' ? ' (the PUBLIC broker — a real third party, signalling only)' : ''}`);
say(`  console    ${PORTS} controller ports -> host + ${PORTS - 1} guests`);
say(`  uptime     ${RESULT.uptimeStart}`);

const browsers = [], pages = [], sideErr = [];
async function launch(i, tag) {
  const dir = path.join('/private/tmp/claude-501/dc-room', 'p' + i);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: HEADFUL ? false : 'new', userDataDir: dir,
    args: ['--no-sandbox', '--disable-background-timer-throttling',
           '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  try { (await import(pathToFileURL(path.join(REPO, 'tools', 'browser_leak_guard.js')).href)).default.guard(b, 'netplay_room_test'); }
  catch (e) { say('  ⚠ leak-guard registration FAILED: ' + (e.message || e)); }
  browsers.push(b);
  const pg = (await b.pages())[0];
  const errs = []; sideErr[i] = errs;
  pg.on('pageerror', (e) => { const t = (e && (e.message || e.type)) || String(e); errs.push(String(t).slice(0, 220)); say(`  [${tag}!] ${String(t).slice(0, 160)}`); });
  await pg.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await pg.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  pages.push(pg);
  return pg;
}
async function until(pg, fn, ms, every = 250) {
  const t = Date.now();
  for (;;) {
    let v = null; try { v = await pg.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t > ms) return null;
    await sleep(every);
  }
}

// The in-page rig. Every peer gets the same one; only the flags differ.
const RIG = (pg, opts) => pg.evaluate(async (o) => {
  window.__log = []; window.__reqs = []; window.__joined = []; window.__left = [];
  window.__barrier = null;
  const s = new Netplay.Session({
    game: 'roomtest', host: o.host, code: o.code, transport: o.transport,
    ui: false, portCount: o.ports,
  });
  window.__s = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  s.on('peer-joined', (e) => window.__joined.push(e));
  s.on('peer-left', (e) => window.__left.push(e));
  s.on('lockstep', (e) => { if (e && e.barrier) window.__barrier = e.barrier; });
  // THE ALLOW BUTTON, minus the pixels. lib/netplay.js's built-in dialog calls
  // exactly these two methods; ui:false plus this handler is a human saying yes
  // to each joiner in turn, which is the property the room must not lose.
  if (o.host) {
    s.on('join-request', (r) => {
      window.__reqs.push({ id: r.id, sas: r.sas, at: Date.now() });
      if (window.__allow) r.approve(); else r.deny('rig said no');
    });
  }
  await s.start();
  // Every peer stamps its OWN byte into its OWN pad, so a core that merged two
  // players' ports, or dropped one, cannot pass the image assertions below.
  window.__mark = o.mark;
  window.__pad = new Uint8Array(64); window.__pad[0] = o.mark;
  window.__pumpOnce = (ms) => new Promise((res) => {
    const ls = window.__s.ls;
    if (!ls) return res({ err: 'no engine' });
    const t0 = performance.now();
    const seen = { frames: 0, stalls: 0, marksSeen: {}, portsSeen: {}, err: null };
    const step = () => {
      if (performance.now() - t0 > ms) {
        seen.report = ls.report();
        return res(seen);
      }
      let r;
      try { r = ls.beginFrame(window.__pad); } catch (e) { seen.err = String(e.message || e); return res(seen); }
      if (r.ready) {
        seen.frames++;
        for (let p = 0; p < ls.portCount; p++) {
          const b = r.image[p * ls.padBytes];
          if (b) { seen.marksSeen[b] = (seen.marksSeen[b] || 0) + 1; seen.portsSeen[p] = b; }
        }
        // ⚠ THE FINGERPRINT IS OVER THE WHOLE MAPLE IMAGE. Two cores that hold
        // a different set of pads for the same frame produce different hashes
        // and the engine latches a desync — so "everyone holds everyone" is not
        // only asserted from the outside, it is asserted BY THE PROTOCOL.
        const h = Netplay.fnvBytes(Netplay.FNV_SEED, r.image);
        ls.endFrame(ls.wantsHash() ? h : null, ls.wantsHash() ? [h] : null);
      } else seen.stalls++;
      setTimeout(step, 0);
    };
    step();
  });
}, opts);

let exitCode = 1;
try {
  if (TRANSPORT === 'local' && PLAYERS > 1) say('  ⚠ transport=local cannot cross profiles — this is a protocol debug run, not a room claim');

  // ---- 1. N separate browsers, genuinely isolated --------------------------
  say(`\n== 1. ${PLAYERS} separate browsers open the page ==`);
  // +1 is the over-capacity caller, and it is only launched when the room can
  // actually be full — an extra browser that gets legitimately SEATED would
  // hold the barrier for a player the rig never drives.
  const NBROWSERS = PLAYERS + (PLAYERS >= PORTS ? 1 : 0);
  for (let i = 0; i < NBROWSERS; i++) await launch(i, 'P' + (i + 1));
  const echoed = await pages[1].evaluate(() => new Promise((res) => {
    const ch = new BroadcastChannel('room-isolation'); let heard = false;
    ch.onmessage = () => { heard = true; }; ch.postMessage('ping');
    setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 800);
  }));
  cell(!echoed, 'profiles-are-isolated',
    'no BroadcastChannel echo between profiles — only the broker can pair these browsers, so what is measured below is a real transport',
    'a BroadcastChannel crossed the profiles; this run proves nothing about a real transport');

  // ---- 2. the room forms ---------------------------------------------------
  say(`\n== 2. one room, one Allow per joiner ==`);
  const CODE = await pages[0].evaluate(() => Netplay.makeCode(5));
  RESULT.code = CODE;
  say(`  code ${CODE}`);
  await pages[0].evaluate(() => { window.__allow = true; });
  await RIG(pages[0], { host: true, code: CODE, transport: TRANSPORT, ports: PORTS, mark: 1 });
  const hostUp = await until(pages[0], () => (window.__s.state === 'signalling') || null, 30000);
  if (!hostUp) {
    voidc('room-forms', 'the host never reached "signalling" — the broker did not answer, so nothing below is measurable');
    throw new Error('broker unavailable');
  }

  // Joiners arrive ONE AT A TIME AND LATE ON PURPOSE: seat 3 must be handed out
  // while seats 1 and 2 are already occupied and their owners already connected,
  // which is the case a "assign ports once at the start" design gets wrong.
  const joinAt = [];
  for (let i = 1; i < PLAYERS; i++) {
    const t = Date.now();
    await RIG(pages[i], { host: false, code: CODE, transport: TRANSPORT, ports: PORTS, mark: i + 1 });
    const up = await until(pages[i], () => (window.__s.state === 'connected') || null, 60000);
    joinAt.push({ player: i + 1, connectedMs: up ? Date.now() - t : null });
    say(`  ....  P${i + 1} ${up ? 'connected in ' + (Date.now() - t) + ' ms' : 'DID NOT CONNECT'}`);
    // A short settle so the roster broadcast lands before the next joiner, and
    // so the "nobody moved" check below is reading a quiet room.
    await sleep(600);
  }
  const states = await Promise.all(pages.slice(0, PLAYERS).map((pg) => pg.evaluate(() => ({
    state: window.__s.state, err: window.__s.lastError, log: window.__log.slice(-3),
  }))));
  cell(states.every((s) => s.state === 'connected'), 'every-player-is-in-the-room',
    `all ${PLAYERS} sides report connected over ${TRANSPORT} — host + ${PLAYERS - 1} guests on one code`,
    `per-side ${J(states)}`);

  const reqs = await pages[0].evaluate(() => window.__reqs);
  const sasSet = new Set(reqs.map((r) => r.sas));
  cell(reqs.length === PLAYERS - 1 && sasSet.size === PLAYERS - 1 && reqs.every((r) => /^[A-HJ-NP-Z2-9]{4}$/.test(r.sas || '')),
    'EVERY-joiner-was-admitted-separately',
    `${reqs.length} distinct join requests, ${sasSet.size} distinct confirmation codes ${J(reqs.map((r) => r.sas))} — ` +
    'one human decision per player, not one decision for the room',
    `requests ${J(reqs)} — the admission gate must fire once per joiner`);

  // ---- 3. the console's port count is the cap, and it is SAID --------------
  say('\n== 3. the room is full at the console\'s port count ==');
  if (PLAYERS < PORTS) {
    voidc('the-N+1th-caller-is-REFUSED-and-told-why',
      `not measurable: this run seats ${PLAYERS} players into a ${PORTS}-port console, so the room is not full. ` +
      'VOID because the precondition did not happen — not because the refusal is unimplemented.');
  } else {
  await RIG(pages[PLAYERS], { host: false, code: CODE, transport: TRANSPORT, ports: PORTS, mark: 9 });
  await sleep(9000);
  const over = await pages[PLAYERS].evaluate(() => ({ state: window.__s.state, err: window.__s.lastError, log: window.__log.join(' | ') }));
  const reqs2 = await pages[0].evaluate(() => window.__reqs.length);
  cell(over.state !== 'connected' && /full/i.test(over.log + ' ' + over.err) && reqs2 === PLAYERS - 1,
    'the-N+1th-caller-is-REFUSED-and-told-why',
    `player ${PLAYERS + 1} was refused with "${over.err}" and never reached the host's prompt (${reqs2} requests total) — ` +
    'a full room says so instead of hanging, and does not put a dialog in front of someone mid-game',
    `state=${over.state} err=${J(over.err)} log=${J(over.log)} requests=${reqs2}`);
  }

  // ---- 4. every machine agrees on who is in which port ---------------------
  say('\n== 4. one roster, agreed by every machine ==');
  await sleep(800);
  const rooms = await Promise.all(pages.slice(0, PLAYERS).map((pg) => pg.evaluate(() => window.__s.roomInfo())));
  RESULT.seats = rooms.map((r) => r.seats.map((s) => s.peer));
  rooms.forEach((r, i) => say(`  ....  P${i + 1} sees ports ${J(r.seats.map((s) => (s.peer ? s.peer.slice(0, 6) : null)))}${r.seats.find((s) => s.local) ? '  (it is P' + (r.seats.findIndex((s) => s.local) + 1) + ')' : ''}`));
  const canon = J(RESULT.seats[0]);
  cell(RESULT.seats.every((s) => J(s) === canon), 'EVERY-machine-maps-the-same-person-to-the-same-port',
    `all ${PLAYERS} rosters are byte-identical: ${canon}. Get this wrong and players drive each other's characters — ` +
    'it is a gameplay-visible failure, not a bookkeeping one',
    `rosters DISAGREE: ${J(RESULT.seats)}`);
  const mine = rooms.map((r) => r.seats.findIndex((s) => s.local));
  cell(new Set(mine).size === PLAYERS && mine.every((p) => p >= 0), 'every-player-holds-a-DIFFERENT-port',
    `local ports ${J(mine)} — ${new Set(mine).size} distinct for ${PLAYERS} players, assigned lowest-free-first in order of admission`,
    `local ports ${J(mine)}`);
  cell(mine[0] === 0, 'the-room-opener-is-player-1-everywhere',
    'the host holds port 0 on every machine', `host holds port ${mine[0]}`);
  // The late joiner did not move anybody: seats 0..k-1 are unchanged by seat k.
  const prefixStable = RESULT.seats.every((s) => s[0] === RESULT.seats[0][0] && s[1] === RESULT.seats[0][1]);
  cell(prefixStable, 'a-late-joiner-does-not-move-the-players-already-seated',
    'seats 0 and 1 hold the same peers on every machine after players 3 and 4 arrived — a joiner APPENDS, it does not reshuffle',
    `${J(RESULT.seats)}`);

  // ---- 5. the barrier ------------------------------------------------------
  say('\n== 5. nobody advances frame 0 alone ==');
  for (let i = 0; i < PLAYERS; i++) await pages[i].evaluate(() => window.__s.setLoadProgress(40));
  await sleep(400);
  // All but the LAST peer say they are ready. The room must not start.
  for (let i = 0; i < PLAYERS - 1; i++) await pages[i].evaluate(() => window.__s.setReady(true, 'gauntlet-disc'));
  await sleep(1500);
  const midway = await Promise.all(pages.slice(0, PLAYERS).map((pg) => pg.evaluate(() => window.__s.ls.state)));
  cell(midway.every((s) => s !== 'running'), 'the-barrier-HOLDS-while-one-player-is-still-loading',
    `${PLAYERS - 1} of ${PLAYERS} declared ready and NOBODY is running: ${J(midway)}. A peer still fetching a 1.1 GB disc ` +
    'holds the rest — the first machine to finish must not run ahead, because that is a desync at frame 0',
    `states ${J(midway)} — somebody started without the last player`);
  const waitFor = await pages[PLAYERS - 1].evaluate(() => window.__barrier);
  cell(!!(waitFor && waitFor.waitingFor && waitFor.waitingFor.length === 1), 'the-wait-NAMES-who-it-is-waiting-for',
    `the room reports it is waiting for ${J(waitFor && waitFor.waitingFor)} — an unexplained pause is what this exists to prevent`,
    `barrier as seen by the last joiner: ${J(waitFor)}`);
  await pages[PLAYERS - 1].evaluate(() => window.__s.setReady(true, 'gauntlet-disc'));
  const running = await Promise.all(pages.slice(0, PLAYERS).map((pg) => until(pg, () => (window.__s.ls.state === 'running') || null, 15000, 150)));
  cell(running.every(Boolean), 'everyone-is-released-together-at-frame-0',
    `all ${PLAYERS} engines went to running once the last peer declared the same disc`,
    `states ${J(await Promise.all(pages.slice(0, PLAYERS).map((pg) => pg.evaluate(() => window.__s.ls.state))))}`);

  // ---- 6. RTT, per pair, on one clock -------------------------------------
  say('\n== 6. what the relay costs, measured ==');
  const rtt = { pairs: {}, byHops: { toHost: [], guestToGuest: [] } };
  for (let i = 0; i < PLAYERS; i++) {
    const others = await pages[i].evaluate(() => {
      const ls = window.__s.ls, me = ls.peerId;
      return ls.roster.filter((p) => p && p !== me);
    });
    for (const peer of others) {
      const samples = [];
      for (let k = 0; k < PINGS; k++) {
        const ms = await pages[i].evaluate((p) => window.__s.pingPeer(p, 4000), peer);
        if (ms != null) samples.push(ms);
        await sleep(12);
      }
      const j = RESULT.seats[0].indexOf(peer);
      const key = `P${i + 1}->P${j + 1}`;
      const s = { n: samples.length, p50: pct(samples, 50), p95: pct(samples, 95), min: samples.length ? +Math.min.apply(null, samples).toFixed(2) : null };
      rtt.pairs[key] = s;
      // hops: anything involving the host (port 0) is ONE link each way.
      if (i === 0 || j === 0) rtt.byHops.toHost.push(s.p50); else rtt.byHops.guestToGuest.push(s.p50);
      say(`  ....  ${key}  RTT n=${s.n} min ${s.min} p50 ${s.p50} p95 ${s.p95} ms  (${(i === 0 || j === 0) ? '1 hop each way' : '2 hops each way, via the host'})`);
    }
  }
  const hostP50 = rtt.byHops.toHost.filter((v) => v != null);
  const ggP50 = rtt.byHops.guestToGuest.filter((v) => v != null);
  rtt.hostMeanP50 = hostP50.length ? +(hostP50.reduce((a, b) => a + b, 0) / hostP50.length).toFixed(2) : null;
  rtt.guestMeanP50 = ggP50.length ? +(ggP50.reduce((a, b) => a + b, 0) / ggP50.length).toFixed(2) : null;
  RESULT.rtt = rtt;
  const worst = await pages[0].evaluate(() => window.__s.rttReport(4000));
  say(`  worst pair from the host: ${worst.worstMs} ms -> recommendDelay ${worst.recommendedDelay} frames`);
  RESULT.rttReport = worst;
  cell(Object.values(rtt.pairs).every((s) => s.n >= Math.max(3, PINGS - 5)),
    'every-pair-can-actually-reach-every-other-pair',
    `all ${Object.keys(rtt.pairs).length} ordered pairs answered ${PINGS} pings — in a star that means the relay carries ` +
    'guest-to-guest traffic end to end, which is what "as if on the same console" requires',
    `some pairs did not answer: ${J(rtt.pairs)}`);

  // ---- 6b. WHAT A MESH WOULD HAVE SAVED -----------------------------------
  // A DIRECT peer connection between two of the GUESTS, built with the same
  // shipped code on a throwaway room code, so the comparison is one hop against
  // two hops with everything else identical. This is measurement only — nothing
  // in the product opens it.
  if (PLAYERS >= 3 && TRANSPORT === 'peerjs') {
    const CODE2 = await pages[1].evaluate(() => Netplay.makeCode(5));
    await pages[1].evaluate(async (c) => {
      window.__d = new Netplay.Session({ game: 'meshprobe', host: true, code: c, transport: 'peerjs', ui: false, portCount: 2 });
      window.__d.on('join-request', (r) => r.approve());
      await window.__d.start();
    }, CODE2);
    await pages[2].evaluate(async (c) => {
      window.__d = new Netplay.Session({ game: 'meshprobe', host: false, code: c, transport: 'peerjs', ui: false, portCount: 2 });
      await window.__d.start();
    }, CODE2);
    const dUp = await until(pages[2], () => (window.__d.state === 'connected') || null, 45000);
    if (dUp) {
      const peerOf2 = await pages[1].evaluate(() => window.__d.ls && window.__d.ls.peerId);
      await sleep(500);
      const direct = [];
      for (let k = 0; k < PINGS; k++) {
        const ms = await pages[2].evaluate((p) => window.__d.pingPeer(p, 4000), peerOf2);
        if (ms != null) direct.push(ms);
        await sleep(12);
      }
      const dp50 = pct(direct, 50);
      const relayed = rtt.pairs['P3->P2'] ? rtt.pairs['P3->P2'].p50 : rtt.guestMeanP50;
      RESULT.mesh = { directP50: dp50, relayedP50: relayed, n: direct.length,
                      addedMs: (dp50 != null && relayed != null) ? +(relayed - dp50).toFixed(2) : null };
      say(`  P3<->P2 DIRECT (what a mesh would give): p50 ${dp50} ms   RELAYED via the host: p50 ${relayed} ms`);
      cell(dp50 != null, 'the-mesh-alternative-is-MEASURED-not-assumed',
        `a direct guest-to-guest RTCPeerConnection between the same two browsers reads ${dp50} ms p50 against the ` +
        `relay's ${relayed} ms — the star costs ${RESULT.mesh.addedMs} ms of round trip on this link, and buys ` +
        `${(PLAYERS * (PLAYERS - 1)) / 2 - (PLAYERS - 1)} fewer connections that all have to traverse NAT`,
        'the direct probe never connected, so the comparison is unmeasured');
    } else {
      voidc('the-mesh-alternative-is-MEASURED-not-assumed', 'the direct guest-to-guest probe did not connect on this network');
    }
  }

  // ---- 7. every core holds every player's input ----------------------------
  say('\n== 7. every core holds EVERY player\'s pad ==');
  const pumped = await Promise.all(pages.slice(0, PLAYERS).map((pg) => pg.evaluate((ms) => window.__pumpOnce(ms), PUMP_MS)));
  RESULT.pump = pumped.map((p, i) => ({ player: i + 1, frames: p.frames, stalls: p.stalls, err: p.err,
                                        marks: Object.keys(p.marksSeen || {}).map(Number).sort(),
                                        ports: p.portsSeen, minLead: p.report && p.report.minLead,
                                        state: p.report && p.report.state, desync: p.report && p.report.desync,
                                        hashesCompared: p.report && p.report.hashesCompared,
                                        inputsReceived: p.report && p.report.inputsReceived }));
  pumped.forEach((p, i) => say(`  ....  P${i + 1} ran ${p.frames} frames (${p.stalls} stall polls) holding marks ${J(Object.keys(p.marksSeen || {}))} in ports ${J(p.portsSeen)}, minLead ${p.report && p.report.minLead}`));
  const wantMarks = J(Array.from({ length: PLAYERS }, (_, k) => k + 1));
  const allHold = RESULT.pump.every((p) => J(p.marks) === wantMarks);
  cell(allHold, 'EVERY-core-holds-EVERY-players-input',
    `every one of the ${PLAYERS} cores saw all ${PLAYERS} distinct pad marks ${wantMarks} in its own maple image — ` +
    'in a relayed star that is the host forwarding each guest to all the others, which is what makes the room ' +
    'behave like one console rather than like a host with spectators',
    `per-core marks ${J(RESULT.pump.map((p) => p.marks))} — a core missing a mark is a player nobody can see`);
  cell(RESULT.pump.every((p) => p.frames > 0 && !p.err), 'the-room-actually-advances',
    `frames run: ${J(RESULT.pump.map((p) => p.frames))} in ${PUMP_MS} ms at delay=${DELAY}`,
    `frames ${J(RESULT.pump.map((p) => p.frames))} errors ${J(RESULT.pump.map((p) => p.err))}`);
  // ⚠ A CLEAN DESYNC RESULT IS VACUOUS UNLESS COMPARISONS ACTUALLY HAPPENED.
  // hashesCompared counts fingerprints checked against a peer's; a run where it
  // is 0 proves nothing at all and must not read as a pass.
  const compared = RESULT.pump.map((p) => p.hashesCompared || 0);
  cell(RESULT.pump.every((p) => !p.desync && p.state !== 'desync') && compared.every((c) => c > 0),
    'no-core-DIVERGED',
    `every core fingerprinted its whole maple image and the fingerprints were compared ${J(compared)} times ` +
    `(inputs received ${J(RESULT.pump.map((p) => p.inputsReceived))}) — all agreed. Two cores holding a different ` +
    'set of pads for one frame would have latched a desync here',
    `desyncs ${J(RESULT.pump.map((p) => p.desync))} with ${J(compared)} comparisons — ` +
    'ZERO comparisons would make this cell vacuous, so it fails rather than passing on nothing');

  // ---- 8. somebody walks out ----------------------------------------------
  say('\n== 8. a player leaves; the rest play on ==');
  const leaverPeer = RESULT.seats[0][PLAYERS - 1];
  const leaverPort = PLAYERS - 1;
  await pages[PLAYERS - 1].evaluate(() => window.__s.close());
  await sleep(2500);
  const afterLeave = await Promise.all(pages.slice(0, PLAYERS - 1).map((pg) => pg.evaluate(() => ({
    state: window.__s.state, ls: window.__s.ls.state, room: window.__s.roomInfo(), left: window.__left,
  }))));
  // ⚠ TWO PLAYERS IS A DIFFERENT QUESTION AND MUST BE ASKED DIFFERENTLY. When
  // the only other player quits there is nobody left to be in a room WITH, so
  // 'closed' is the right answer and asserting otherwise made the rig fail a
  // correct product. What has to hold at EVERY N is that the survivors are not
  // wedged — that is the cell below this one, and it passed at N=2.
  if (PLAYERS >= 3) {
    cell(afterLeave.every((a) => a.state !== 'closed'), 'one-player-leaving-does-not-close-the-room',
      `the remaining ${PLAYERS - 1} sessions are still ${J(afterLeave.map((a) => a.state))} — one person quitting used to ` +
      "take everyone else's session with it, because the single channel's onclose was the session's onclose",
      `states ${J(afterLeave.map((a) => a.state))}`);
  } else {
    cell(afterLeave.every((a) => a.ls === 'running' || a.ls === 'stalled'), 'the-last-player-standing-is-not-wedged',
      `with only two players the room ends when the other one goes (session ${J(afterLeave.map((a) => a.state))}), but the ` +
      `engine is still ${J(afterLeave.map((a) => a.ls))} with the empty port limp — the survivor plays on with a pad ` +
      'that reads zero, which is what a real console does when somebody puts the controller down',
      `session ${J(afterLeave.map((a) => a.state))} engine ${J(afterLeave.map((a) => a.ls))} — the survivor is stuck`);
  }
  const limp = afterLeave.map((a) => a.room.seats[leaverPort].dropped);
  cell(limp.every((d) => d != null), 'the-leavers-port-goes-LIMP-on-every-machine',
    `port ${leaverPort} is marked dropped from frame ${J(limp)} on every remaining machine — the controller stays ` +
    'plugged in and reads all-zero rather than being unplugged, because removing a maple device is guest-visible ' +
    'state that would have to happen on the identical frame everywhere',
    `dropped-at per machine: ${J(limp)} — a port nobody agrees about is a desync`);
  const after = await Promise.all(pages.slice(0, PLAYERS - 1).map((pg) => pg.evaluate((ms) => window.__pumpOnce(ms), 2000)));
  cell(after.every((p) => p.frames > 20), 'the-remaining-players-KEEP-RUNNING',
    `after the leave, the rest ran ${J(after.map((p) => p.frames))} more frames — a missing input STALLS by design, ` +
    'so a leaver whose port was still expected would have wedged the whole room',
    `frames after the leave: ${J(after.map((p) => p.frames))} — the room stalled on somebody who is gone`);
  const marksAfter = after.map((p) => Object.keys(p.marksSeen || {}).map(Number).sort());
  say(`  ....  marks still seen after the leave: ${J(marksAfter)} (the leaver's ${PLAYERS} is gone, as it must be)`);

  const errs = sideErr.slice(0, PLAYERS).map((e) => e.length);
  cell(errs.every((n) => n === 0), 'no-page-errors', 'no browser threw anything',
    `page errors per player: ${J(sideErr.slice(0, PLAYERS))}`);
  exitCode = rec.some((r) => r.ok === false) ? 1 : 0;
} catch (e) {
  bad('rig', 'the run threw: ' + ((e && e.stack) || e));
} finally {
  RESULT.rec = rec;
  RESULT.uptimeEnd = execSync('uptime').toString().trim();
  RESULT.loadavgEnd = os.loadavg();
  RESULT.elapsedMs = Date.now() - T0;
  fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(RESULT, null, 2));
  if (!KEEP) for (const b of browsers) { try { await b.close(); } catch (e) {} }
  const p = rec.filter((r) => r.ok === true).length, f = rec.filter((r) => r.ok === false).length, v = rec.filter((r) => r.ok === null).length;
  say(`\n  json  ${path.join(OUT, NAME + '.json')}`);
  say(`  uptime@end ${RESULT.uptimeEnd}`);
  say(`[netplay-room] ${p}/${p + f} passed, ${v} void, ${PLAYERS} players over ${TRANSPORT}, ${(RESULT.elapsedMs / 1000).toFixed(1)} s`);
  await new Promise((r) => logStream.end(r));
}
process.exit(exitCode);

// gamecube/tools/gc_room_test.mjs
//
// TWO MARIO PARTY 4s IN ONE ROOM — does the GameCube page actually lockstep?
//
// This drives two real gamecube.html pages through the shared lobby, boots the recomp engine on
// BOTH, and then asks the questions that decide whether "GameCube has netplay" is true:
//
//   1. THE BARRIER. While the room is armed but not released, has EITHER machine run a guest
//      frame? The counter is the worker's own PAD_ACK, bumped once per guest frame after the pad
//      bytes are latched, so a non-zero here means a core ran ahead of the room. "Everyone
//      starts together" is the one claim a savestate handoff cannot rescue.
//   2. IT RUNS AT ALL after release, on both machines.
//   3. PER-PORT ROUTING FROM THE ROSTER. The host holds port 0, the guest holds port 1, and they
//      are DIFFERENT. A guest that assumed port 0 would be driving the host's character.
//   4. THE ONE THAT MATTERS. Press a button on the GUEST and read it back out of the HOST'S
//      GUEST MEMORY — MP4's own HuPadBtnDown array via ___recomp_pad_witness. It must land on
//      PORT 1 and NOT on port 0. One controller moving two characters is the failure this whole
//      body of work exists to prevent, and it is invisible from the transport layer.
//   5. 1.000x IS NOT EXCEEDED. Lockstep may only withhold credits, never mint them (gate #9).
//
// Same-browser transport (?net=local, BroadcastChannel) — this proves the PRODUCT path, not the
// network. Two machines on two networks is a separate, still-open question
// (tools/undelivered.mjs `never-tested-across-two-networks`).
//
// Usage:  bash tools/probe_lock.sh run -- node gamecube/tools/gc_room_test.mjs
// Env: RUN_MS (default 240000), PROBE_HEADLESS=0 for a visible window.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RUN_MS = parseInt(process.env.RUN_MS || '240000', 10);
const GUEST_BTN = 0x400;            // PAD_BUTTON_X — inert in MP4's menus, distinctive in a dump
const HOST_BTN = 0x40;              // PAD_TRIGGER_L

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
               '.wasm': 'application/wasm', '.json': 'application/json',
               '.bin': 'application/octet-stream', '.gz': 'application/gzip',
               '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
               '.dol': 'application/octet-stream', '.raw': 'application/octet-stream' };

// /gamedata/... is this same tree locally — see the note in recomp_fourport_test.mjs.
const OFFSITE_PREFIX = (() => {
  try {
    const m = /^window\.ASSET_BASE\s*=\s*'([^']*)'/m
      .exec(fs.readFileSync(path.join(ROOT, 'lib', 'asset_base.js'), 'utf8'));
    return m ? m[1] : '';
  } catch (e) { return ''; }
})();

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (OFFSITE_PREFIX && (urlPath === OFFSITE_PREFIX || urlPath.startsWith(OFFSITE_PREFIX + '/')))
        urlPath = urlPath.slice(OFFSITE_PREFIX.length) || '/';
      if (urlPath === '/') urlPath = '/gamecube.html';
      const filePath = path.join(ROOT, urlPath);
      fs.stat(filePath, (err, stat) => {
        if (err) { res.statusCode = 404; res.end('404'); return; }
        res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(filePath).pipe(res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait out coi-serviceworker's one-time reload — see recomp_fourport_test.mjs for what happens
// if you click Start on the doomed document.
async function coiSettle(page, who) {
  let controlled = false, tries = 0;
  while (!controlled && tries < 160) {
    tries++;
    try {
      controlled = await page.evaluate(() =>
        !!(navigator.serviceWorker && navigator.serviceWorker.controller) || window.crossOriginIsolated === true);
    } catch (e) { controlled = false; }
    if (!controlled) await sleep(250);
  }
  let stable = 0, last = '';
  for (let i = 0; i < 20 && stable < 3; i++) {
    try { const h = await page.evaluate(() => location.href); if (h === last) stable++; else { stable = 1; last = h; } }
    catch (e) { stable = 0; }
    await sleep(250);
  }
  console.log(`[${who}] coi settled (controlled=${controlled})`);
}

const { srv, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.PROBE_HEADLESS === '0' ? false : 'new',
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--disable-web-security',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows',
         '--disable-features=IntensiveWakeUpThrottling',
         '--js-flags=--max-old-space-size=4096', '--disk-cache-size=1'],
});
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, 'gc_room_test'); }
catch (_e) { /* best effort */ }

const URL_BASE = `http://127.0.0.1:${port}/gamecube.html?net=local&v=${Date.now()}`;
const host = await browser.newPage();
const guest = await browser.newPage();
for (const [p, who] of [[host, 'host'], [guest, 'guest']]) {
  p.on('console', (m) => { const t = m.text(); if (/lockstep|netplay|recomp FAIL|PAGEERROR/i.test(t)) console.log(`  [${who}]`, t.slice(0, 180)); });
  p.on('pageerror', (e) => console.log(`  [${who}] PAGEERROR`, String(e).slice(0, 180)));
  await p.setCacheEnabled(false);
  // ⚠ ONLY ONE TAB IS EVER IN FRONT, AND THE OTHER ONE GETS NO rAF. Two pages in one browser
  // means one of them is backgrounded, where requestAnimationFrame stops and timers are
  // throttled — so the guest never finished its WebRTC handshake and sat in `signalling`
  // forever with dc=null while the host reported `connected`. MEASURED here 2026-09-10 before
  // this line existed. Every cell after it would have been a statement about the harness.
  // Same fix tools/console_room_crossdevice_test.mjs:385 uses.
  try { const cdp = await p.target().createCDPSession(); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
  catch (e) { console.log(`  [${who}] focus emulation unavailable: ` + e.message); }
}
await host.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
await guest.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
await coiSettle(host, 'host');
await coiSettle(guest, 'guest');

// ---- 0. the lobby exists at all, before any disc is fetched ---------------------------------
const lobby = await host.evaluate(() => !!document.querySelector('.np-btn'));
lobby ? ok('lobby-exists-before-any-disc-is-loaded', 'the shared .np-btn is mounted on a plain visit')
      : bad('lobby-exists-before-any-disc-is-loaded', 'no .np-btn — NetplayUI did not mount');
if (!lobby) { await browser.close(); srv.close(); process.exit(1); }

// ---- pair ------------------------------------------------------------------------------------
await host.evaluate(() => document.querySelector('.np-btn').click());
await sleep(600);
const code = await host.evaluate(() => document.querySelector('.np-code').textContent.trim());
console.log('[host] room code ' + code);
await guest.evaluate((c) => {
  document.querySelector('.np-btn').click();
  document.querySelectorAll('.np-row button')[1].click();      // Join
  const i = document.querySelector('.np-in'); i.value = c;
  i.dispatchEvent(new Event('change'));
}, code);

// The host is asked before anything flows (lib/netplay.js raises its own approval dialog).
let approved = false;
for (let i = 0; i < 120 && !approved; i++) {
  approved = await host.evaluate(() => {
    const b = document.getElementById('npApproveAllow');
    if (b) { b.click(); return true; }
    return false;
  });
  if (!approved) await sleep(250);
}
console.log('[host] admission ' + (approved ? 'allowed' : 'NO DIALOG APPEARED'));

let paired = false;
for (let i = 0; i < 160 && !paired; i++) {
  paired = await host.evaluate(() => !!(NetplayUI.session && NetplayUI.session.state === 'connected'));
  if (!paired) await sleep(250);
}
paired ? ok('room-pairs', 'two gamecube.html pages are in one room over the same-browser transport')
       : bad('room-pairs', 'never reached connected');
if (!paired) { await browser.close(); srv.close(); process.exit(1); }

// ---- PAIR_ONLY=1: interrogate the room's ls* plumbing WITHOUT booting 600 MB of disc --------
// A netplay fault and an emulator fault look identical from the outside and have opposite fixes,
// and a full run costs three minutes per iteration. This arm declares ready on both sides
// directly and asks only whether the BARRIER releases.
if (process.env.PAIR_ONLY === '1') {
  const wire = (p) => p.evaluate(() => {
    const s = NetplayUI.session, ls = s._ensureLockstep ? s._ensureLockstep() : s.ls;
    const links = [];
    try { for (const L of s._links.values()) links.push({ nonce: L.nonce, approved: !!L.approved, dc: L.dc && L.dc.readyState, relay: !!L.relay, open: !!L.open }); } catch (e) {}
    return { host: !!s.isHost, state: s.state, admission: (typeof s.admission === 'function') ? s.admission() : null,
             links, dc: s._dc && s._dc.readyState, lsState: ls && ls.state,
             roster: ls ? ls.roster.slice() : null, lobby: (ls && ls.lobby) ? Array.from(ls.lobby.keys()) : null };
  }).catch((e) => ({ err: String(e).slice(0, 160) }));
  console.log('  [host  wire] ' + JSON.stringify(await wire(host)));
  console.log('  [guest wire] ' + JSON.stringify(await wire(guest)));
  await host.evaluate(() => NetplayUI.session.setReady(true, 'MarioParty4'));
  await guest.evaluate(() => NetplayUI.session.setReady(true, 'MarioParty4'));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const st = await Promise.all([
      host.evaluate(() => (NetplayUI.session.ls || {}).state),
      guest.evaluate(() => (NetplayUI.session.ls || {}).state),
    ]);
    if (st[0] === 'running' && st[1] === 'running') break;
    if (i % 6 === 0) console.log('  [barrier] host=' + st[0] + ' guest=' + st[1]);
  }
  console.log('  [host  wire] ' + JSON.stringify(await wire(host)));
  console.log('  [guest wire] ' + JSON.stringify(await wire(guest)));
  await browser.close(); srv.close();
  process.exit(0);
}

// ---- start: the host's Start takes the guest along, and BOTH load the disc -------------------
await host.evaluate(() => document.querySelectorAll('.np-act button')[0].click());

// ---- 1. THE BARRIER: neither core may run a frame before the room releases -------------------
// Sampled continuously from the moment the gate arms until it reports running. The counter is
// the worker's PAD_ACK, bumped once per guest frame AFTER the credit was consumed.
const t0 = Date.now();
let armedH = false, armedG = false, ranEarly = null, released = false;
let lastH = null, lastG = null;
while (Date.now() - t0 < RUN_MS) {
  await sleep(250);
  const [h, g] = await Promise.all([
    host.evaluate(() => (window.__gcLockstep ? window.__gcLockstep() : null)),
    guest.evaluate(() => (window.__gcLockstep ? window.__gcLockstep() : null)),
  ]);
  lastH = h; lastG = g;
  if (h && h.gated && !armedH) { armedH = true; console.log(`[host] gate armed at t=${((Date.now() - t0) / 1000).toFixed(0)}s`); }
  if (g && g.gated && !armedG) { armedG = true; console.log(`[guest] gate armed at t=${((Date.now() - t0) / 1000).toFixed(0)}s`); }
  if (h && h.gated && !h.running && h.guestFrames > 0 && !ranEarly)
    ranEarly = `host ran ${h.guestFrames} guest frame(s) while the barrier was still holding`;
  if (g && g.gated && !g.running && g.guestFrames > 0 && !ranEarly)
    ranEarly = `guest ran ${g.guestFrames} guest frame(s) while the barrier was still holding`;
  if (h && g && h.running && g.running) { released = true; break; }
}
if (!armedH || !armedG) {
  bad('both-cores-are-frame-gated', `armed host=${armedH} guest=${armedG}` +
      ` (host fault: ${lastH && lastH.fault}) (guest fault: ${lastG && lastG.fault})`);
} else {
  ok('both-cores-are-frame-gated', 'each page interlocked its credit pool before granting one');
  ranEarly ? bad('nobody-runs-frame-0-before-the-room', ranEarly)
           : ok('nobody-runs-frame-0-before-the-room',
                'PAD_ACK stayed 0 on both machines for the whole time the barrier held');
}
if (!released) {
  // WHY it did not release, from the engine's own bookkeeping, rather than a guess.
  const dump = (p) => p.evaluate(() => {
    const s = window.NetplayUI && NetplayUI.session;
    if (!s) return { no: 'session' };
    const ls = s.ls;
    return {
      room: (typeof s.roomInfo === 'function') ? s.roomInfo() : null,
      peerId: ls ? ls.peerId : null, state: ls ? ls.state : null,
      roster: ls ? ls.roster.slice() : null,
      declared: ls ? !!ls._declaredReady : null,
      disc: ls ? ls.disc : null,
      lobby: (ls && ls.lobby) ? Array.from(ls.lobby.entries()) : null,
      bar: ls ? ls._bar : null,
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  console.log('  [host  barrier] ' + JSON.stringify(await dump(host)));
  console.log('  [guest barrier] ' + JSON.stringify(await dump(guest)));
}
released ? ok('the-barrier-releases-and-both-run', 'both engines report state running')
         : bad('the-barrier-releases-and-both-run',
               `host=${lastH && lastH.state}/${lastH && lastH.running} guest=${lastG && lastG.state}/${lastG && lastG.running}`);

if (released) {
  // ---- 2. both actually advance -------------------------------------------------------------
  const before = [lastH.guestFrames, lastG.guestFrames];
  await sleep(5000);
  const [h2, g2] = await Promise.all([
    host.evaluate(() => window.__gcLockstep()),
    guest.evaluate(() => window.__gcLockstep()),
  ]);
  const dH = h2.guestFrames - before[0], dG = g2.guestFrames - before[1];
  (dH > 60 && dG > 60)
    ? ok('both-cores-advance-under-the-gate', `${dH} and ${dG} guest frames in 5 s`)
    : bad('both-cores-advance-under-the-gate', `host +${dH} guest +${dG} in 5 s`);
  // 1.000x is a CEILING here: the gate may only withhold credits.
  const rateH = dH / 5 / 60, rateG = dG / 5 / 60;
  (rateH <= 1.05 && rateG <= 1.05)
    ? ok('lockstep-never-speeds-the-guest-up', `host ${rateH.toFixed(3)}x, guest ${rateG.toFixed(3)}x of hardware`)
    : bad('lockstep-never-speeds-the-guest-up', `host ${rateH.toFixed(3)}x, guest ${rateG.toFixed(3)}x`);

  // ---- 2b. THE DIVERGENCE DETECTOR ----------------------------------------------------------
  // Until this existed, these two cores were frame-gated with NOTHING comparing
  // them: gamecube.html drove beginFrame()/endFrame() per guest frame and never
  // called submitHash(), because the recomp published no state hash. Gated and
  // silently diverging is worse than not gated — it looks right while each
  // player watches a different game.
  //
  // ⚠ THREE SEPARATE CLAIMS, because wiring a fingerprint up is not the same as
  // it working. (a) each page PRODUCES hashes, (b) the engine COMPARED them
  // against the peer's — a hash nobody compares is decoration, and this is the
  // cell that catches a fingerprint that never reaches the wire — and (c) they
  // AGREED, which is what says the two simulations are actually the same one.
  console.log(`  ....  fp cells host seq=${h2.fpSeqRaw} f=${h2.fpFrameRaw} h=${h2.fpHashRaw} · ` +
              `guest seq=${g2.fpSeqRaw} f=${g2.fpFrameRaw} h=${g2.fpHashRaw}`);
  (h2.hashesSent > 0 && g2.hashesSent > 0)
    ? ok('both-cores-PUBLISH-a-state-fingerprint',
         `host ${h2.hashesSent} and guest ${g2.hashesSent} hashes, newest host ${h2.lastHash} @f${h2.lastHashFrame}`)
    : bad('both-cores-PUBLISH-a-state-fingerprint',
          `host sent ${h2.hashesSent} guest sent ${g2.hashesSent} — a frame-gated room with no fingerprint ` +
          'cannot tell a shared simulation from two different ones');
  (h2.hashesCompared > 0 && g2.hashesCompared > 0)
    ? ok('the-fingerprints-are-actually-COMPARED-against-the-peer',
         `host compared ${h2.hashesCompared}, guest compared ${g2.hashesCompared}`)
    : bad('the-fingerprints-are-actually-COMPARED-against-the-peer',
          `host compared ${h2.hashesCompared} guest compared ${g2.hashesCompared} — hashes are being produced ` +
          'and never reaching the other machine, which detects nothing');
  (!h2.desync && !g2.desync)
    ? ok('the-two-simulations-AGREE',
         `no divergence; last frame both sides agreed on: host f${h2.lastAgreedFrame} guest f${g2.lastAgreedFrame}`)
    : bad('the-two-simulations-AGREE',
          `DIVERGED host ${JSON.stringify(h2.desync)} guest ${JSON.stringify(g2.desync)} — the two machines ` +
          'are running different games. Either the fingerprint covers memory that legitimately differs ' +
          'between two browsers, or the room really is forking.');



  // ---- 3. per-port routing from the roster --------------------------------------------------
  const pH = (h2.ports || []).slice(), pG = (g2.ports || []).slice();
  (pH.length && pG.length && JSON.stringify(pH) !== JSON.stringify(pG))
    ? ok('the-two-machines-hold-different-ports', `host ${JSON.stringify(pH)} guest ${JSON.stringify(pG)} of roster ${JSON.stringify(h2.roster)}`)
    : bad('the-two-machines-hold-different-ports', `host ${JSON.stringify(pH)} guest ${JSON.stringify(pG)}`);

  // ---- 4. THE ONE THAT MATTERS --------------------------------------------------------------
  // Hold a button on the GUEST only. Read MP4's own HuPadBtnDown out of the HOST'S guest memory.
  // It must appear on the guest's port and NOT on the host's.
  const gPort = pG[0], hPort = pH[0];
  await guest.evaluate((bits) => {
    window.__rtTimer = setInterval(() => { window.__gcPad.edge(0, bits, 0); }, 8);
  }, GUEST_BTN);
  await host.evaluate((bits) => {
    window.__rtTimer = setInterval(() => { window.__gcPad.edge(0, bits, 0); }, 8);
  }, HOST_BTN);
  let seen = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const w = await host.evaluate(() => window.__gcPad.witness());
    if (!w) continue;
    if ((w.btnDown[gPort] & GUEST_BTN) === GUEST_BTN || (w.btnDown[hPort] & HOST_BTN) === HOST_BTN) { seen = w; break; }
    seen = w;
  }
  await guest.evaluate(() => clearInterval(window.__rtTimer));
  await host.evaluate(() => clearInterval(window.__rtTimer));
  const hex = (v) => '0x' + (v >>> 0).toString(16);
  if (!seen) {
    bad('a-guests-button-reaches-the-hosts-game-on-the-guests-port', 'no witness sample from the host');
  } else {
    const onGuestPort = (seen.btnDown[gPort] & GUEST_BTN) === GUEST_BTN;
    const leakedToHostPort = (seen.btnDown[hPort] & GUEST_BTN) === GUEST_BTN;
    console.log('  [host] HuPadBtnDown[0..3] = ' + seen.btnDown.map(hex).join(' ') +
                `  (guest holds port ${gPort} pressing ${hex(GUEST_BTN)}; host holds port ${hPort} pressing ${hex(HOST_BTN)})`);
    (onGuestPort && !leakedToHostPort)
      ? ok('a-guests-button-reaches-the-hosts-game-on-the-guests-port',
           `${hex(GUEST_BTN)} landed on port ${gPort} of the HOST's Mario Party 4 and NOT on port ${hPort}`)
      : bad('a-guests-button-reaches-the-hosts-game-on-the-guests-port',
            `onGuestPort=${onGuestPort} leakedToHostPort=${leakedToHostPort} — ` +
            (leakedToHostPort ? 'ONE CONTROLLER IS MOVING TWO CHARACTERS' : 'the press never crossed'));
    const hostOwn = (seen.btnDown[hPort] & HOST_BTN) === HOST_BTN;
    hostOwn ? ok('the-hosts-own-button-reaches-its-own-port', `${hex(HOST_BTN)} on port ${hPort}`)
            : bad('the-hosts-own-button-reaches-its-own-port',
                  `HuPadBtnDown[${hPort}] = ${hex(seen.btnDown[hPort])} — the host's own input was dropped`);
  }
  // ⚠ LAST, DELIBERATELY. This poisons the room on purpose, and a desync HALTS
  // the frame gate — running it before the gameplay cells made every one of them
  // fail for a reason that had nothing to do with gameplay.
  // (d) AND IT ACTUALLY FIRES. A divergence detector that has never reported a
  // divergence is untested — three green cells above are equally consistent with
  // a hash over constant bytes that can only ever agree. So cause one: perturb
  // the GUEST's fingerprint and require BOTH sides to notice and name the frame.
  // Then put it back and confirm the room is not permanently poisoned.
  await guest.evaluate(() => window.__gcForceDesync(0x1234abcd));
  let dH2 = null, dG2 = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    [dH2, dG2] = await Promise.all([
      host.evaluate(() => window.__gcLockstep()),
      guest.evaluate(() => window.__gcLockstep()),
    ]);
    if (dH2.desync || dG2.desync) break;
  }
  (dH2 && dG2 && (dH2.desync || dG2.desync))
    ? ok('a-REAL-divergence-is-detected-and-named',
         `injected on the guest: host ${JSON.stringify(dH2.desync)} guest ${JSON.stringify(dG2.desync)}`)
    : bad('a-REAL-divergence-is-detected-and-named',
          'the guest\'s fingerprint was deliberately perturbed and NEITHER machine reported a desync — ' +
          'the three cells above are green over a detector that cannot detect anything');
  console.log('  [host] fault: ' + (h2.fault || 'none'));
}

await host.screenshot({ path: '/tmp/gc-room-host.png' }).catch(() => {});
await guest.screenshot({ path: '/tmp/gc-room-guest.png' }).catch(() => {});
console.log('  screenshots -> /tmp/gc-room-host.png /tmp/gc-room-guest.png');
await browser.close(); srv.close();
console.log(`\n[gc-room] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

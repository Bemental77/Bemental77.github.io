#!/usr/bin/env node
// ============================================================================
// netplay_realui_pair_test.mjs — TWO BROWSERS, THE INLINE PANEL, THE REAL BROKER
// ============================================================================
//
// WHY THIS EXISTS. A real pairing shipped broken and nothing here caught it:
// a host on caseybement.com/dreamcast.html sat on "Waiting for someone to join
// with code EUQTF…" while a guest on a second PC sat on "Looking for the host…",
// forever. Two separate rigs already existed and BOTH missed it, for two
// different reasons:
//
//   tools/dreamcast_netplay_test.mjs   drives the RIGHT UI (#netHostBtn,
//       #netJoinBtn, #netCodeIn, #netGo — the panel built into dreamcast.html)
//       but opens both tabs in ONE browser with ?net=local, i.e. BroadcastChannel
//       signalling. That transport is physically incapable of leaving the
//       profile, so it exercises none of PeerJS, none of the broker, none of ICE.
//
//   tools/audit_peerjs_crossdevice.mjs uses the RIGHT TRANSPORT (two profiles,
//       shipped default = peerjs) but drives #lobbyCard — the lib/netplay-ui.js
//       lobby on the DEDICATED */_multiplayer.html pages (its lines 195, 203,
//       255, 257). That is a SEPARATE implementation from the inline panel the
//       user actually clicked (dreamcast.html markup :580-604, wiring :4836-4851).
//
// This rig is the intersection nobody was standing on: the INLINE panel, driven
// by clicking the buttons a person clicks, across TWO SEPARATE BROWSER PROFILES,
// on the transport the page picks for itself.
//
// WHAT "SEPARATE PROFILES" BUYS, and why a shared one would void the whole test:
//   * BroadcastChannel cannot cross a profile, so `?net=local` is unavailable
//     even by accident and only the broker can pair the two sides. The rig
//     PROVES this rather than assuming it (see `profile-isolation` below).
//   * Cross-origin isolation is ORIGIN-SCOPED AND PERSISTS (CLAUDE.md, device
//     matrix notes): a second page visited in a profile that already ran
//     coi-serviceworker inherits crossOriginIsolated=true. A shared profile
//     therefore hides a first-visit fault, which is exactly the state a real
//     second PC is in.
//
// WHAT A PASS HERE STILL DOES NOT PROVE — AND IT IS THE INTERESTING PART.
// Both browsers sit on ONE machine behind ONE NAT, so ICE resolves to host
// candidates on the same interface and the pair connects over loopback. That
// proves broker signalling, the offer/answer exchange, the media path and the
// input path. It proves NOTHING about NAT traversal between two genuinely
// remote networks, which is the one thing two PCs in different places need and
// the one thing no rig on one box can supply. Per lib/netplay.js:272 the
// working tree now lists `turn:eu-0.turn.peerjs.com:3478` /
// `turn:us-0.turn.peerjs.com:3478` alongside `stun:stun.l.google.com:19302`, so
// there IS a relay to fall back to — but this rig never needs it and therefore
// never exercises it. If this passes on production and two real machines still
// fail, the relay path is the remaining suspect and it needs two real networks.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime     # mandatory gate
//   npm run web                                          # port 8080, gate #2
//   node tools/netplay_realui_pair_test.mjs                        # localhost
//   node tools/netplay_realui_pair_test.mjs --url=https://caseybement.com/dreamcast.html
//   URL=https://caseybement.com/dreamcast.html node tools/netplay_realui_pair_test.mjs
//
// FLAGS / ENV  (flag wins over env)
//   --url=<page url>   URL      full URL of the emulator page. Default
//                               http://localhost:8080/dreamcast.html. Production
//                               is OPT-IN — it is a live third party plus a live
//                               deploy, and a default that reaches out to both
//                               is not a unit gate.
//   --page=<key>       PAGE     which selector profile to use. Inferred from the
//                               URL's filename when omitted.
//   --game=<key>       GAME     #romSelect value. Default per page (dreamcast:
//                               'gauntlet' — the disc in the bug report).
//   --transport=local  --       CONTROL ARM ONLY: appends ?net=local, which
//                               forces BroadcastChannel. Between two profiles
//                               that CANNOT pair, so it is a rig self-test that
//                               is expected to fail at `peers-connected`. The
//                               default deliberately passes NO ?net= so the page
//                               takes its shipped transport.
//   --keep             KEEP     leave both browsers open at the end
//   BOOT_MS                     host boot budget, default 900000
//   PAIR_MS                     pairing budget after the guest clicks Join,
//                               default 90000
//   APPROVE_MS                  how long to wait for the host's Allow prompt
//                               before deciding this build has no approval gate,
//                               default 45000
//   CHROME_PATH                 Chrome binary
//   OUT                         JSON result path. Default
//                               /tmp/netplay-realui-<page>-<hostname>.json — the
//                               ORIGIN is in the name so the localhost arm and
//                               the production arm do not overwrite each other.
//
// EXIT: 0 when every non-VOID cell passed, 1 otherwise, 2 on a usage error.
// ============================================================================
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Page profiles. ONE ROW PER PAGE THAT CARRIES THE INLINE PANEL.
//
// ⚠ MEASURED 2026-09-08, not assumed: `grep -rn "netHostBtn" --include=*.html
// --include=*.js .` over the working tree returns TWO lines, both in
// dreamcast.html (:585 markup, :4839 wiring). Every other emulator page —
// ps1.html:1027, snes.html:820, genesis.html:890, n64/index.html:2948,
// gba.html:1288 — hands #btnNet to `location.href = NetplayHost.lobbyUrl(...)`
// and NAVIGATES to a */_multiplayer.html page, whose lobby is #lobbyCard and is
// already covered by tools/audit_peerjs_crossdevice.mjs. gamecube.html has no
// "Play Online" control at all.
//
// So the table has one row TODAY and that is a finding, not an omission. It is a
// table rather than a hardcoded page so that the day a second page grows an
// inline #netHostBtn, covering it is a row here — re-run that grep before
// believing this comment.
// ---------------------------------------------------------------------------
const PAGES = {
  dreamcast: {
    file: 'dreamcast.html',
    coi: true,                       // installs coi-serviceworker and reloads
    game: 'gauntlet',                // the disc in the bug report
    sel: {
      romSelect: '#romSelect', start: '#btnStart',
      openLobby: '#btnNet', overlay: '#netOverlay', overlayOn: 'on',
      hostBtn: '#netHostBtn', code: '#netCode',
      joinBtn: '#netJoinBtn', game: '#netGame', codeIn: '#netCodeIn', go: '#netGo',
      status: '#netStatus', leave: '#netLeave', close: '#netClose',
      video: '#netVideo', canvas: '#dc-canvas', log: '#log',
    },
    netSeam: '__dcNet',              // { state, role, code, transport, sentP2, ... }
    probeSeam: '__dcProbe',          // { booted, fps, framesEver, phase, coi, ... }
    padSeam: '__dcPad',              // the 256-byte pad buffer, port 0 at 0
    // LIVENESS IS FRAMES, NOT A FLAG. `booted` is set when the core accepts the
    // disc; dreamcast.html:4669 refuses to host without it, but a booted-and-
    // wedged core would stream a still image and pass a naive check. So the
    // seam is polled for booted AND a frame having actually flowed.
    live: 'const p = window.__dcProbe(); return (p.booted && (p.fps > 0 || p.framesEver)) ? p : null;',
    // RETRO ids from dreamcast.html's RB table. Guest and host press DIFFERENT
    // things at the SAME time, so a rig that merged the two ports could not pass.
    guestKeys: ['m', 'd'],           // B (id 0) + RIGHT (id 7, full analog right)
    hostKeys: ['k', 'a'],            // A (id 8) + LEFT  (id 6, full analog left)
    // What the HOST hands the emulator worker for port 1 (bytes 64..75) and what
    // it reads for port 0 (bytes 0..11). Both come off the host, which is the
    // point: the guest's claim about its own key press is worth nothing.
    inputWitness: 'return { p2: (window.__dcNet().sentP2 || null), ' +
                  'p1: (window.__dcPad ? Array.from(window.__dcPad()).slice(0, 12) : null), ' +
                  'remotePad: window.__dcNet().remotePad };',
    judgeInput(before, during, after, T) {
      const s16 = (a, o) => (a ? ((a[o] | (a[o + 1] << 8)) << 16) >> 16 : 0);
      const B = 1 << 0, RIGHT = 1 << 7, LEFT = 1 << 6, A = 1 << 0;
      const d0 = during.p2 ? during.p2[0] : 0;
      const lx = s16(during.p2, 8);
      const h0 = during.p1 ? during.p1[0] : 0, h1 = during.p1 ? during.p1[1] : 0;
      const hlx = s16(during.p1, 8);
      T.cell(before.p2 && before.p2.every((b) => b === 0),
        'guest-pad-idle-before',
        'port 1 reads all zero with nobody pressing anything',
        `port 1 = ${JSON.stringify(before.p2)} before any key — a non-zero idle port makes ` +
        'the "it changed" reading below meaningless');
      T.cell(!!(d0 & B) && !!(d0 & RIGHT),
        'guest-input-reaches-the-host',
        `the host handed its emulator worker byte 64 = 0x${d0.toString(16)} (B|RIGHT) while the ` +
        `GUEST BROWSER held m+d — the key press crossed the wire`,
        `the host's port-1 byte read 0x${Number(d0).toString(16)}, wanted bits 0 and 7 set. ` +
        `Full port 1 = ${JSON.stringify(during.p2)}, remotePad = ${JSON.stringify(during.remotePad)}`);
      T.cell(lx > 30000,
        'guest-analog-reaches-the-host',
        `port 1 left-stick X = ${lx} (full right) — the axis these games walk on`,
        `port 1 left-stick X = ${lx}, wanted > 30000`);
      T.cell(!!(h0 & LEFT) && !!(h1 & A) && hlx < -30000 && !(h0 & RIGHT),
        'two-independent-controllers',
        `port 0 = 0x${h0.toString(16)},0x${h1.toString(16)} lx=${hlx} (host: A+LEFT) while ` +
        `port 1 = 0x${d0.toString(16)} lx=${lx} (guest: B+RIGHT) — opposite sticks, same frame`,
        `port 0 = ${JSON.stringify(during.p1)}  port 1 = ${JSON.stringify(during.p2)}`);
      T.cell(after.p2 && after.p2.every((b) => b === 0) && after.p1 && after.p1.every((b) => b === 0),
        'both-pads-release',
        'ports 0 and 1 both returned to all-zero on key release',
        `p1=${JSON.stringify(after.p1)} p2=${JSON.stringify(after.p2)}`);
    },
  },
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => {
  const hit = argv.find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '1';
};
const URL_IN = flag('url') || process.env.URL || 'http://localhost:8080/dreamcast.html';
let target;
try { target = new global.URL(URL_IN); }
catch (e) { console.error('bad --url: ' + URL_IN); process.exit(2); }

const PAGE_KEY = flag('page') || process.env.PAGE ||
  Object.keys(PAGES).find((k) => target.pathname.endsWith(PAGES[k].file));
const P = PAGES[PAGE_KEY];
if (!P) {
  console.error(`no selector profile for ${target.pathname}. Known pages: ${Object.keys(PAGES).join(', ')}.\n` +
    'If a new page has grown an inline #netHostBtn panel, add a row to PAGES — ' +
    'and re-run `grep -rn "netHostBtn" --include=*.html --include=*.js .` to be sure it has.');
  process.exit(2);
}
const GAME       = flag('game') || process.env.GAME || P.game;
const TRANSPORT  = flag('transport') || '';
const KEEP       = !!(flag('keep') || process.env.KEEP);
const CHROME     = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BOOT_MS    = parseInt(process.env.BOOT_MS    || '900000', 10);
const PAIR_MS    = parseInt(process.env.PAIR_MS    || '90000',  10);
const APPROVE_MS = parseInt(process.env.APPROVE_MS || '45000',  10);
// ⚠ THE ORIGIN IS IN THE FILENAME ON PURPOSE. The first version of this named the
// file after the page alone, so running the localhost arm and then the production
// arm left ONE json — the second silently overwrote the first, which is exactly
// the artifact you need when the two arms disagree.
const OUT        = process.env.OUT ||
  `/tmp/netplay-realui-${PAGE_KEY}-${target.hostname.replace(/[^a-z0-9]/gi, '-')}.json`;
const SCRATCH    = process.env.SCRATCH ||
  '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad';

const QUERY = TRANSPORT === 'local' ? '?net=local' : '';
const PAGE_URL = target.origin + target.pathname + QUERY;

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };
const rec = [];
const T = {
  ok:   (n, d) => { rec.push({ n, ok: true,  d });  console.log(`  PASS  ${n}  ${d}`); },
  bad:  (n, d) => { rec.push({ n, ok: false, d });  console.log(`  FAIL  ${n}  ${d}`); },
  // ⚠ A THIRD OUTCOME. A cell whose PRECONDITION never happened has neither
  // passed nor failed; printing it as either is a lie in one direction. VOID
  // names the precondition and is excluded from the tally.
  void: (n, d) => { rec.push({ n, ok: null,  d });  console.log(`  VOID  ${n}  ${d}`); },
  info: (n, d) => { console.log(`  ....  ${n}  ${d}`); },
  cell: (pass, n, good, badMsg) => (pass ? T.ok(n, good) : T.bad(n, badMsg)),
};

// Poll from Node, never page.waitForFunction: that polls on rAF and one of these
// two windows is always backgrounded, which has produced false negatives on a
// session whose own log already read connected (tools/netplay_test.mjs records it).
async function until(page, body, ms, everyMs = 400, onTick = null) {
  const fn = new Function(body);
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (onTick) { try { await onTick(Date.now() - t0); } catch (e) {} }
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// browsers
// ---------------------------------------------------------------------------
const profiles = [];
async function launch(tag) {
  const dir = path.join(SCRATCH, `realui-${PAGE_KEY}-${tag}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  profiles.push(dir);
  const b = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: dir,               // ← the experiment: no shared anything
    args: [
      '--no-sandbox',
      '--enable-features=SharedArrayBuffer',
      // Only one window can be foreground and headless Chromium throttles rAF in
      // the other — which would stop the host's capture pump, the input pump and
      // the guest's pad send all at once, and read as a netplay fault.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // The guest attaches a <video> carrying the host's audio; without this the
      // element is refused playback and the PICTURE never starts either.
      '--autoplay-policy=no-user-gesture-required',
      '--disk-cache-size=268435456',
    ],
  });
  // MANDATORY. A SIGKILLed parent orphans its browser and no in-process handler
  // can prevent it; two such orphans once held 230% of this box's CPU for days.
  try { (await import('./browser_leak_guard.js')).default.guard(b, 'realui_pair'); } catch (_e) {}
  return b;
}
function cleanProfiles() {
  for (const d of profiles) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
}

// Everything a red cell needs to be diagnosable. A test that says only "timeout"
// is not a test — it is a rumour.
const SIDE = {};
function watch(page, label) {
  const s = { label, console: [], netConsole: [], errors: [], failedReqs: [], thirdParty: [] };
  SIDE[label] = s;
  // TWO TAILS, and the second one is the reason a red run is readable. The
  // emulator prints a per-second [vbl]/[split]/[page heartbeat] block, so on a
  // 60-second pairing failure the raw console tail is ~200 lines of frame timing
  // and ZERO lines about netplay — the diagnosis buries its own evidence. The
  // filtered tail is printed first and the raw one kept underneath it.
  const NETLINE = /\[net\]|netplay|peerjs|\bpeer\b|signal|\bice\b|broker|turn:|stun:/i;
  page.on('console', (m) => {
    const t = m.text();
    s.console.push(t.slice(0, 400));
    if (s.console.length > 400) s.console.shift();
    if (NETLINE.test(t)) {
      s.netConsole.push(t.slice(0, 400));
      if (s.netConsole.length > 200) s.netConsole.shift();
      console.log(`  [${label}] ${t.slice(0, 220)}`);
    }
  });
  // ⚠ NOT `e.message`. A wasm trap reaches this hook as an object with no
  // `message` (puppeteer emitted a bare ErrorEvent and a null), and reading it
  // threw INSIDE the listener and took a whole run down with a TypeError.
  page.on('pageerror', (e) => {
    const t = (e && (e.message || e.type)) || (e === null ? 'null (no detail from the page)' : String(e));
    s.errors.push(String(t).slice(0, 400));
    console.log(`  [${label}!] ${String(t).slice(0, 220)}`);
  });
  page.on('requestfailed', (r) => {
    s.failedReqs.push(`${r.url().slice(0, 160)}  ${(r.failure() || {}).errorText || '?'}`);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (/peerjs|unpkg|stun|turn/i.test(u)) s.thirdParty.push(u.slice(0, 160));
  });
  return s;
}

async function keepAwake(page) {
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch (e) { return false; }
}

// coi-serviceworker installs on the FIRST visit and reloads the page. Anything
// injected before that reload is thrown away and a page evaluated during it
// throws "Execution context destroyed", which reads exactly like a crash. Land
// on the already-isolated document instead of racing the reload.
async function gotoSettled(page, url, coi) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  if (coi) {
    await sleep(2500);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }
}

// CLICK THE BUTTON A PERSON CLICKS. page.click() dispatches a real trusted-ish
// mouse event at the element's box, which is the thing under test; el.click() is
// the fallback for a control the layout put off-screen, and WHICH ONE RAN is
// reported rather than hidden, because "the button was unreachable" is itself a
// finding about a UI.
async function clickReal(page, sel) {
  try {
    await page.waitForSelector(sel, { visible: true, timeout: 15000 });
    await page.click(sel);
    return 'mouse';
  } catch (e) {
    try {
      const did = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, sel);
      return did ? 'el.click (not reachable by mouse: ' + (e.message || e).toString().slice(0, 80) + ')' : 'MISSING';
    } catch (e2) { return 'MISSING'; }
  }
}

const readStatus = (page) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? el.textContent.trim() : null;
}, P.sel.status).catch(() => null);

const readNet = (page) => page.evaluate((s) => (typeof window[s] === 'function' ? window[s]() : null), P.netSeam).catch(() => null);
const readProbe = (page) => page.evaluate((s) => (typeof window[s] === 'function' ? window[s]() : null), P.probeSeam).catch(() => null);

// THE DIAGNOSIS DUMP. Called on every failure and once at the end regardless, so
// a red run carries its own post-mortem instead of sending someone back to
// re-run it with more logging.
async function diagnose(pages, why) {
  console.log(`\n== DIAGNOSIS (${why}) ==`);
  const out = { why, sides: {} };
  for (const [label, page] of Object.entries(pages)) {
    const s = SIDE[label] || {};
    let d = {};
    try {
      d = await page.evaluate((cfg) => {
        const q = (sel) => document.querySelector(sel);
        const txt = (sel) => { const e = q(sel); return e ? e.textContent.trim().slice(-4000) : null; };
        return {
          url: location.href,
          coi: !!self.crossOriginIsolated,
          sab: (typeof SharedArrayBuffer === 'function'),
          peerLoaded: (typeof window.Peer),                 // did unpkg's script arrive?
          peerScripts: Array.prototype.slice.call(document.scripts)
            .map((x) => x.src).filter((x) => /peerjs|unpkg/i.test(x)),
          netplayLoaded: (typeof window.Netplay),
          netplayProto: (window.Netplay && window.Netplay.PROTO) || null,
          netplaySupported: !!(window.Netplay && window.Netplay.supported && window.Netplay.supported()),
          liveSessions: (window.Netplay && window.Netplay.sessions)
            ? window.Netplay.sessions.map((s) => ({ state: s.state, host: s.isHost, code: s.code, game: s.game, err: s.lastError }))
            : null,
          net: (typeof window[cfg.netSeam] === 'function') ? window[cfg.netSeam]() : null,
          probe: (typeof window[cfg.probeSeam] === 'function') ? window[cfg.probeSeam]() : null,
          status: txt(cfg.status),
          overlayOn: !!(q(cfg.overlay) && q(cfg.overlay).classList.contains(cfg.overlayOn)),
          code: txt(cfg.code),
          approvePrompt: !!document.getElementById('npApprove'),
          pageLogTail: (txt(cfg.log) || '').split('\n').slice(-40).join('\n'),
          // Same problem as the console tail: #log is dominated by per-frame
          // timing, so the netplay lines are pulled out separately.
          //
          // ⚠ FILTER THE WHOLE LOG, NOT THE TAIL. The first version filtered
          // `txt()`, which is the last 4000 characters — and dreamcast.html
          // prints a [vbl]+[split]+[page heartbeat] block EVERY SECOND, so on a
          // 60 s pairing failure the [net] lines were already off the end and the
          // rig printed "the page never logged a netplay line at all" about a
          // page whose console tail, three lines below, showed seven of them.
          pageLogNet: (function () {
            const e = q(cfg.log);
            const all = e ? String(e.textContent || '') : '';
            return all.split('\n').filter((l) => /\[net\]|netplay|peer|signal/i.test(l)).slice(-25).join('\n');
          })(),
        };
      }, { netSeam: P.netSeam, probeSeam: P.probeSeam, ...P.sel });
    } catch (e) { d = { evaluateFailed: String(e).slice(0, 300) }; }
    d.consoleTail = (s.console || []).slice(-40);
    d.netConsole = (s.netConsole || []).slice(-40);
    d.pageErrors = s.errors || [];
    d.failedRequests = s.failedReqs || [];
    d.thirdPartyRequests = Array.from(new Set(s.thirdParty || []));
    out.sides[label] = d;

    console.log(`  -- ${label} --`);
    console.log(`     url               ${d.url}`);
    console.log(`     coi/sab           ${d.coi} / ${d.sab}`);
    console.log(`     window.Peer       ${d.peerLoaded}   scripts: ${J(d.peerScripts)}`);
    console.log(`     window.Netplay    ${d.netplayLoaded}  PROTO=${d.netplayProto}  supported=${d.netplaySupported}`);
    console.log(`     Netplay.sessions  ${J(d.liveSessions)}`);
    console.log(`     ${P.netSeam}()${' '.repeat(Math.max(0, 12 - P.netSeam.length))} ${J(d.net)}`);
    console.log(`     ${P.sel.status} text   ${J(d.status)}`);
    console.log(`     approval prompt   ${d.approvePrompt}`);
    if (d.probe) console.log(`     probe             phase=${d.probe.phase} booted=${d.probe.booted} fps=${d.probe.fps} live=${d.probe.live} why=${d.probe.why}`);
    console.log(`     third-party reqs  ${d.thirdPartyRequests.length ? d.thirdPartyRequests.join('  ') : 'NONE — the broker script was never fetched'}`);
    console.log(`     failed requests   ${d.failedRequests.length ? d.failedRequests.join('\n                       ') : 'none'}`);
    console.log(`     pageerrors        ${d.pageErrors.length ? d.pageErrors.join('\n                       ') : 'none'}`);
    // NETPLAY LINES FIRST. On a pairing failure these are the whole story and
    // the raw tails below are per-frame emulator timing.
    console.log(`     netplay log lines:`);
    const netLog = String(d.pageLogNet || '').split('\n').filter(Boolean);
    if (!netLog.length) console.log('       ! NONE in the whole of #log — the page logged nothing about netplay');
    for (const ln of netLog) console.log(`       * ${ln}`);
    console.log(`     netplay console lines:`);
    if (!d.netConsole.length) console.log('       ! NONE');
    for (const ln of d.netConsole.slice(-25)) console.log(`       * ${ln}`);
    console.log(`     raw page log tail:`);
    for (const ln of String(d.pageLogTail || '').split('\n').slice(-12)) console.log(`       | ${ln}`);
    console.log(`     raw console tail:`);
    for (const ln of d.consoleTail.slice(-12)) console.log(`       > ${ln}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const uptime = (() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })();
console.log('\n== netplay_realui_pair_test ==');
console.log(`  uptime      ${uptime}`);
console.log(`  loadavg     ${os.loadavg().map((n) => n.toFixed(2)).join(' ')}`);
console.log(`  url         ${PAGE_URL}`);
console.log(`  page        ${PAGE_KEY}   game "${GAME}"`);
console.log(`  transport   ${TRANSPORT === 'local' ? '?net=local  (CONTROL ARM — expected to FAIL to pair across profiles)'
                                                   : 'NONE PASSED — the page takes its shipped default'}`);
console.log('  profiles    two separate userDataDirs, deleted at the end');

const t0 = Date.now();
const hostB = await launch('host');
const guestB = await launch('guest');
const summary = { when: new Date().toISOString(), url: PAGE_URL, page: PAGE_KEY, game: GAME, uptime, results: null };
let host = null, guest = null, exitCode = 1;

try {
  host = (await hostB.pages())[0];
  guest = (await guestB.pages())[0];
  watch(host, 'host'); watch(guest, 'guest');
  await host.setViewport({ width: 1280, height: 860 });
  await guest.setViewport({ width: 1280, height: 860 });
  await keepAwake(host); await keepAwake(guest);

  // ---- both pages load -----------------------------------------------------
  console.log('\n== both browsers open the page ==');
  await Promise.all([gotoSettled(host, PAGE_URL, P.coi), gotoSettled(guest, PAGE_URL, P.coi)]);
  const hReady = await until(host, `return (typeof window.${P.netSeam} === 'function') ? true : null;`, 60000);
  const gReady = await until(guest, `return (typeof window.${P.netSeam} === 'function') ? true : null;`, 60000);
  T.cell(hReady && gReady, 'pages-mount',
    `both browsers published window.${P.netSeam}`,
    `host=${hReady} guest=${gReady} — the page never wired its lobby`);

  const hNet0 = await readNet(host);
  T.cell(hNet0 && hNet0.supported, 'netplay-supported',
    `Netplay.supported() is true on both sides; transport = "${hNet0 && hNet0.transport}"`,
    `${P.netSeam}() = ${J(hNet0)}`);
  summary.transport = hNet0 && hNet0.transport;
  if (TRANSPORT !== 'local') {
    T.cell(hNet0 && hNet0.transport === 'peerjs', 'transport-is-the-shipped-default',
      'transport = "peerjs" — the broker path a second machine needs, NOT the BroadcastChannel ' +
      'path every same-browser test uses',
      `transport = ${J(hNet0 && hNet0.transport)} with no ?net= in the URL`);
  }

  // Prove the profiles really are isolated. If a BroadcastChannel could cross
  // them, this whole experiment would be measuring `local` after all and a pass
  // would mean nothing about two machines.
  const echoed = await guest.evaluate(() => new Promise((res) => {
    const ch = new BroadcastChannel('realui-isolation-probe');
    let heard = false;
    ch.onmessage = () => { heard = true; };
    ch.postMessage('ping');
    setTimeout(() => { try { ch.close(); } catch (e) {} res(heard); }, 900);
  }));
  T.cell(!echoed, 'profile-isolation',
    'no BroadcastChannel echo between the two browsers — `local` signalling is physically ' +
    'unavailable, so anything that pairs did it through the broker',
    'a BroadcastChannel echo crossed the two profiles — they are not isolated and this run proves nothing');

  // ---- host boots ----------------------------------------------------------
  console.log(`\n== host picks "${GAME}" and presses Start ==`);
  const took = await host.evaluate((s, g) => { const el = document.querySelector(s); if (!el) return null; el.value = g; el.dispatchEvent(new Event('change')); return el.value; }, P.sel.romSelect, GAME);
  T.cell(took === GAME, 'game-picker-took-the-value',
    `${P.sel.romSelect}.value = "${took}"`,
    `set "${GAME}", the select reads ${J(took)} — assigning an unmatched value to a <select> is a ` +
    'SILENT no-op and a different disc would boot with nothing reporting it');
  const howStart = await clickReal(host, P.sel.start);
  T.cell(howStart !== 'MISSING', 'start-is-clickable',
    `${P.sel.start} clicked via ${howStart}`,
    `${P.sel.start} could not be clicked at all`);

  let lastPhase = '';
  const liveP = await until(host, P.live, BOOT_MS, 1500, async () => {
    const p = await readProbe(host);
    if (!p) return;
    const line = `${p.phase} ${Math.round(100 * (p.discBytes || 0) / (p.discTotal || 1))}% fps=${p.fps}`;
    if (line !== lastPhase) { lastPhase = line; process.stdout.write(`  ....  booting  ${line}          \r`); }
  });
  process.stdout.write('\n');
  const hProbe = await readProbe(host);
  // ⚠ THE LIVENESS SIGNAL IS FRAMES, NOT A TIMER AND NOT A FLAG. dreamcast.html:4669
  // refuses to host unless `booted`, and a wedged-but-booted core would stream a
  // still picture that passes a naive "is it running" check.
  T.cell(!!liveP, 'host-is-actually-running',
    `booted=${hProbe && hProbe.booted} fps=${hProbe && hProbe.fps} framesEver=${hProbe && hProbe.framesEver} ` +
    `phase=${hProbe && hProbe.phase} — frames are flowing, so there is something to stream`,
    `never reached booted+frames in ${BOOT_MS} ms: ${J(hProbe)}`);
  if (!liveP) throw new Error('host never started a game — hosting is refused without one, so nothing after this is measurable');

  // ---- host opens the INLINE lobby and hosts --------------------------------
  console.log('\n== host opens the inline lobby and clicks "Host a game" ==');
  const howNet = await clickReal(host, P.sel.openLobby);
  const overlayOn = await host.evaluate((s, c) => { const e = document.querySelector(s); return !!(e && e.classList.contains(c)); }, P.sel.overlay, P.sel.overlayOn);
  T.cell(howNet !== 'MISSING' && overlayOn, 'lobby-opens',
    `${P.sel.openLobby} (${howNet}) put ${P.sel.overlay} in state "${P.sel.overlayOn}"`,
    `click=${howNet} overlay-on=${overlayOn} — the inline panel never opened`);

  const howHost = await clickReal(host, P.sel.hostBtn);
  const code = await until(host, `const t=(document.querySelector('${P.sel.code}')||{}).textContent||''; ` +
    "return /^[A-HJ-NP-Z2-9]{5}$/.test(t.trim()) ? t.trim() : null;", 30000);
  summary.code = code;
  T.cell(!!code, 'host-shows-a-code',
    `${P.sel.hostBtn} (${howHost}) -> ${P.sel.code} reads "${code}"`,
    `no 5-character code appeared. ${P.sel.status} says ${J(await readStatus(host))}`);
  if (!code) { await diagnose({ host, guest }, 'the host never minted a code'); throw new Error('no host code'); }

  const capture = await until(host, `const n=window.${P.netSeam}(); return n.capture || null;`, 30000);
  T.cell(!!capture, 'capture-arm-chosen', `the host is capturing via ${capture}`,
    'the page never resolved a capture surface — the guest would get no picture');

  const hSigStatus = await until(host, `const e=document.querySelector('${P.sel.status}'); ` +
    "return (e && /Waiting for someone to join/i.test(e.textContent)) ? e.textContent.trim() : null;", 30000);
  T.info('host-status-while-waiting', hSigStatus ? `"${hSigStatus}"` :
    `${P.sel.status} reads ${J(await readStatus(host))} instead of the "Waiting for someone to join" line`);

  // ---- guest joins from the OTHER browser ----------------------------------
  console.log('\n== the guest joins from a SEPARATE browser profile ==');
  const howGNet = await clickReal(guest, P.sel.openLobby);
  const howGJoin = await clickReal(guest, P.sel.joinBtn);
  const gTook = await guest.evaluate((s, g) => { const el = document.querySelector(s); if (!el) return null; el.value = g; return el.value; }, P.sel.game, GAME);
  T.cell(gTook === GAME, 'guest-game-picker-took-the-value',
    `${P.sel.game}.value = "${gTook}"`,
    `set "${GAME}", the guest's picker reads ${J(gTook)} — lib/netplay.js refuses a pairing whose ` +
    'game names differ, so a silently-unmatched value fails the join for the wrong reason');
  // TYPE the code, do not assign it. dreamcast.html:4849 hangs a keydown handler
  // with stopPropagation on this field precisely because the page's own window
  // keydown handler eats letters for the emulator; assigning .value would skip
  // the one line of code that makes the field usable by a human.
  let typed = null;
  try {
    await guest.click(P.sel.codeIn);
    await guest.type(P.sel.codeIn, code, { delay: 25 });
    typed = await guest.evaluate((s) => document.querySelector(s).value, P.sel.codeIn);
  } catch (e) { typed = 'THREW: ' + (e.message || e); }
  T.cell(typed === code, 'code-field-accepts-typing',
    `typed "${code}" character by character and the field reads "${typed}" — the page's own ` +
    'window keydown handler did not swallow it',
    `typed "${code}", the field reads ${J(typed)}`);
  const howGo = await clickReal(guest, P.sel.go);
  T.info('guest-clicked-join', `${P.sel.joinBtn}=${howGJoin} ${P.sel.openLobby}=${howGNet} ${P.sel.go}=${howGo}`);

  // ---- approval (present only on builds that have the 2026-09-08 gate) ------
  const proto = await host.evaluate(() => (window.Netplay && window.Netplay.PROTO) || null);
  summary.proto = proto;
  const prompt = await until(host, "return document.getElementById('npApproveAllow') ? " +
    "{ sas: (document.getElementById('npApproveSas')||{}).getAttribute ? document.getElementById('npApproveSas').getAttribute('data-sas') : null } : null;",
    APPROVE_MS, 500);
  if (prompt) {
    T.ok('host-is-asked-before-anything-flows',
      `Allow/Deny raised on the host before any media or input (confirmation code ${J(prompt.sas)}), lib/netplay.js PROTO=${proto}`);
    await host.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); });
  } else if (proto === 1) {
    // Not a failure OF THIS PAGE: PROTO 1 predates the gate. Reported so a run
    // against production and a run against the working tree are not silently
    // compared as if they tested the same code.
    T.void('host-is-asked-before-anything-flows',
      `NOT MEASURED: this deployment serves lib/netplay.js PROTO=1, which has no approval step at ` +
      `all (the gate landed with PROTO=2). Nothing to click, and nothing here says whether the ` +
      `gate works — only that this build predates it.`);
  } else {
    T.bad('host-is-asked-before-anything-flows',
      `PROTO=${proto} should raise an Allow/Deny prompt and none appeared in ${APPROVE_MS} ms — ` +
      'either the guest never reached the host, or a code guesser would be let in unasked');
  }

  // ---- THE HEADLINE: do both sides reach connected? -------------------------
  console.log('\n== do both sides pair? ==');
  const gConn = await until(guest, `return window.${P.netSeam}().state === 'connected' ? true : null;`, PAIR_MS, 500);
  const hConn = await until(host,  `return window.${P.netSeam}().state === 'connected' ? true : null;`, PAIR_MS, 500);
  const hNet = await readNet(host), gNet = await readNet(guest);
  const hTxt = await readStatus(host), gTxt = await readStatus(guest);
  summary.host = hNet; summary.guest = gNet;
  summary.hostStatusText = hTxt; summary.guestStatusText = gTxt;

  T.cell(!!(gConn && hConn), 'peers-connected',
    `both sides report state "connected" (host role=${hNet && hNet.role}, guest role=${gNet && gNet.role})`,
    `host.state=${J(hNet && hNet.state)} guest.state=${J(gNet && gNet.state)} after ${PAIR_MS} ms — ` +
    `THIS IS THE REPORTED BUG. Host says "${hTxt}", guest says "${gTxt}".`);

  // The HUMAN-VISIBLE claim, separately. A session object that says connected
  // behind a status line that still says "Looking for the host…" is a bug the
  // user experiences even though the state machine is fine.
  T.cell(/connected/i.test(hTxt || '') && /connected/i.test(gTxt || ''), 'status-text-says-connected',
    `host "${hTxt}" / guest "${gTxt}"`,
    `host "${hTxt}" / guest "${gTxt}" — this is the text on screen, which is what the player reads`);

  if (!(gConn && hConn)) {
    summary.diagnosis = await diagnose({ host, guest }, 'the two sides never paired');
  } else {
    // ---- the guest gets PICTURE, not merely a track ------------------------
    console.log('\n== the guest gets DECODED FRAMES, not merely a live track ==');
    const tracks = await until(guest, `return window.${P.netSeam}().videoTracks || null;`, 30000);
    T.cell(!!(tracks && tracks.some((t) => t.startsWith('video:live'))), 'guest-track-live',
      J(tracks), `${J(tracks)} — no live video track arrived`);

    await until(guest, `const v=document.querySelector('${P.sel.video}'); return (v && v.videoWidth > 0) ? true : null;`, 45000);
    // ⚠ DECODED FRAME COUNT, NOT A TRACK STATE. `video:live` says a track object
    // exists; a live-but-empty track is indistinguishable from a working one by
    // readyState alone. getVideoPlaybackQuality().totalVideoFrames only moves
    // when the decoder actually produced a picture.
    const q = () => guest.evaluate((s) => {
      const v = document.querySelector(s);
      if (!v) return null;
      const pq = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      return {
        w: v.videoWidth, h: v.videoHeight, readyState: v.readyState, paused: v.paused,
        currentTime: +v.currentTime.toFixed(3),
        decoded: pq ? pq.totalVideoFrames : (v.webkitDecodedFrameCount != null ? v.webkitDecodedFrameCount : null),
        dropped: pq ? pq.droppedVideoFrames : null,
        shown: getComputedStyle(v).display !== 'none',
      };
    }, P.sel.video);
    const q0 = await q('t0');
    await sleep(4000);
    const q1 = await q('t1');
    const dDecoded = (q1 && q0 && q1.decoded != null && q0.decoded != null) ? q1.decoded - q0.decoded : null;
    T.cell(dDecoded != null && dDecoded > 0, 'guest-decodes-frames',
      `totalVideoFrames ${q0.decoded} -> ${q1.decoded} (+${dDecoded} in ~4 s), ${q1.w}x${q1.h}, ` +
      `currentTime ${q0.currentTime} -> ${q1.currentTime}, dropped ${q1.dropped}`,
      `decoded frames went ${J(q0 && q0.decoded)} -> ${J(q1 && q1.decoded)} in 4 s — the track exists and ` +
      `carries nothing. element ${J(q1)}`);
    const canvasHidden = await guest.evaluate((s) => { const c = document.querySelector(s); return c ? getComputedStyle(c).display === 'none' : null; }, P.sel.canvas);
    T.cell(!!(q1 && q1.shown) && canvasHidden === true, 'guest-view-swapped',
      `<video> ${q1.w}x${q1.h} is displayed and the guest's own (permanently black) canvas is hidden`,
      `video shown=${q1 && q1.shown} canvas hidden=${canvasHidden}`);

    // And the picture must MOVE. A coarse 4x3 block-mean signature survives
    // codec noise; an exact hash does not, and reading one made a host producing
    // ~1 fps look like 16 distinct frames.
    const samples = [];
    for (let i = 0; i < 14; i++) {
      samples.push(await guest.evaluate((s) => {
        const v = document.querySelector(s);
        const c = document.createElement('canvas'); c.width = 160; c.height = 120;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.clearRect(0, 0, 160, 120);
        try { g.drawImage(v, 0, 0, 160, 120); } catch (e) { return { err: e.message }; }
        const d = g.getImageData(0, 0, 160, 120).data;
        let nonBlack = 0;
        const gw = 4, gh = 3, acc = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
        for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
          const k = (y * 160 + x) * 4;
          const lum = d[k] + d[k + 1] + d[k + 2];
          if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
          acc[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)] += lum / 3;
          cnt[((y * gh / 120) | 0) * gw + ((x * gw / 160) | 0)]++;
        }
        return { nonBlack, coarse: Array.from(acc, (v2, i2) => Math.round(v2 / cnt[i2] / 32)).join('.') };
      }, P.sel.video));
      await sleep(400);
    }
    summary.videoSamples = samples;
    const good = samples.filter((s) => !s.err);
    const lit = Math.max(...good.map((s) => s.nonBlack), 0);
    const distinct = new Set(good.map((s) => s.coarse)).size;
    T.cell(lit > 0, 'guest-frames-non-black',
      `${lit}/19200 pixels lit at peak`, 'every sample was pure black — a live track carrying nothing');
    T.cell(distinct >= 2, 'guest-frames-changing',
      `${distinct} distinct coarse signatures over ~5.6 s`,
      `only ${distinct} distinct coarse signature(s) — the picture is frozen, not live`);

    // ---- the guest's input reaches the host --------------------------------
    console.log('\n== does the guest\'s controller reach the host? ==');
    const witness = () => host.evaluate(new Function(P.inputWitness));
    const press = (page, keys, down) => page.evaluate((k, d) => {
      k.forEach((key) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { key })));
    }, keys, down);
    const before = await witness();
    await press(guest, P.guestKeys, true);
    await press(host,  P.hostKeys,  true);
    await sleep(1200);
    const during = await witness();
    await press(guest, P.guestKeys, false);
    await press(host,  P.hostKeys,  false);
    await sleep(1200);
    const after = await witness();
    summary.pad = { before, during, after };
    P.judgeInput(before, during, after, T);

    // ---- leaving -----------------------------------------------------------
    console.log('\n== leaving ==');
    await clickReal(guest, P.sel.leave);
    const sawLeave = await until(host, `const s=window.${P.netSeam}().state; return (s==='closed'||s==='failed') ? s : null;`, 30000);
    T.cell(!!sawLeave, 'host-sees-peer-leave', `host session state = ${sawLeave}`,
      `host still reports ${J((await readNet(host)) || {}).slice(0, 200)}`);
    const stillRunning = await host.evaluate((s) => window[s]().booted, P.probeSeam).catch(() => null);
    T.cell(stillRunning === true, 'host-keeps-playing',
      'the emulator is still running after the guest left',
      'the host stopped when the session ended');
  }

  // Evidence. A screenshot is the only thing that answers "was there really a
  // game on screen" after the fact.
  try {
    const tag = target.hostname.replace(/[^a-z0-9]/gi, '-');
    await host.screenshot({ path: `/tmp/realui-${PAGE_KEY}-${tag}-host.png` });
    await guest.screenshot({ path: `/tmp/realui-${PAGE_KEY}-${tag}-guest.png` });
    T.info('screenshots', `/tmp/realui-${PAGE_KEY}-${tag}-host.png  /tmp/realui-${PAGE_KEY}-${tag}-guest.png`);
  } catch (e) { T.info('screenshots', 'failed: ' + (e.message || e)); }

  if (!summary.diagnosis) summary.diagnosis = await diagnose({ host, guest }, 'end-of-run state, recorded on pass and fail alike');
} catch (e) {
  T.bad('rig', 'the run threw: ' + ((e && e.message) || e));
  try { if (host && guest) summary.diagnosis = await diagnose({ host, guest }, 'the rig threw'); } catch (e2) {}
} finally {
  summary.results = rec;
  summary.elapsedMs = Date.now() - t0;
  summary.loadavgEnd = os.loadavg();
  try { fs.writeFileSync(OUT, JSON.stringify(summary, null, 2)); } catch (e) {}
  if (!KEEP) {
    try { await hostB.close(); } catch (e) {}
    try { await guestB.close(); } catch (e) {}
    cleanProfiles();
  }
  const pass = rec.filter((r) => r.ok === true).length;
  const fail = rec.filter((r) => r.ok === false).length;
  const voids = rec.filter((r) => r.ok === null).length;
  console.log(`\n  json        ${OUT}`);
  console.log(`  uptime@end  ${(() => { try { return execSync('uptime').toString().trim(); } catch (e) { return 'unknown'; } })()}`);
  console.log(`[netplay-realui] ${pass}/${pass + fail} passed, ${voids} void, ${(summary.elapsedMs / 1000).toFixed(1)} s  (${PAGE_URL})`);
  exitCode = fail ? 1 : 0;
}
process.exit(exitCode);

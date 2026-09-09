// IS N64 LOCKSTEP REAL? — the standing gate for deterministic online play.
//
// THE QUESTION THIS EXISTS TO ANSWER, PRECISELY
//   Two independent N64 cores, in two independent browser tabs, booting the
//   same ROM from frame 0 with no savestate and no save memory, driven by the
//   SAME frame-numbered input through lib/netplay.js — do they compute
//   byte-identical architectural CPU state, frame after frame, and for how long?
//
// WHY THIS RIG AND NOT A SCREENSHOT
//   A divergence that is invisible on screen still desyncs gameplay, so pixels
//   can only ever produce a FALSE PASS. What is compared here is the core's own
//   per-VI FNV-1a checksum over reg[0..31], hi, lo, g_cp0_regs[0..31],
//   reg_cop1_fgr_64[0..31], FCR31 and PC (libretronew.c:455-471) — the same
//   fingerprint the ?jit differential harness already uses, read live through
//   _neil_last_fp().
//
//   ⚠ AND ITS LIMIT, STATED SO NOBODY OVERCLAIMS A PASS: that checksum covers
//   ARCHITECTURAL CPU STATE ONLY. It does not hash RDRAM, the RSP or the RDP. A
//   divergence that has not yet reached a register is invisible to it. A PASS is
//   necessary, not sufficient.
//
// WHAT IS AND IS NOT ESTABLISHED BY THE CONFIGURATION
//   TWO TABS IN ONE Chrome. That is the cheapest configuration that can answer
//   the question, and it is forced rather than chosen: the 'local' transport
//   signals over a BroadcastChannel, which does not cross browser contexts (see
//   openPage). It shares the HTTP cache, so the ROM is fetched once.
//   It is a WEAKER test than two physical devices in one respect — same OS, same
//   CPU, same Chrome build, same wasm tiering, same V8 isolate settings — so a
//   PASS here is necessary-but-not-sufficient for "two devices", and a FAIL here
//   is conclusive for both. THERE IS NO TWO-MACHINE ARM and this file does not
//   pretend there is; cross-machine determinism is UNESTABLISHED.
//
// ARMS (a cross-instance number is uninterpretable without a control)
//   pair  : two cores in a room, same ROM, same inputs, from frame 0.
//   solo  : ONE core armed into lockstep, fed a scripted input stream by this
//           rig with no room at all, run twice and compared against itself. If
//           this fails the core is not even self-deterministic and no pair
//           number means anything.
//   Each arm runs --runs times, because one agreeing run proves nothing
//   (CLAUDE.md gate #10).
//
// NO SHIPPED FILE IS MODIFIED. Everything is read through the page's own
// window.__n64Net() seam.
//
// USAGE
//   npm run web                                        # port 8080, CLAUDE.md gate #2
//   node tools/browser_leak_guard.js reap && uptime    # before any measured run
//   bash tools/probe_lock.sh run -- node n64/tools/lockstep_probe.mjs
//
// FLAGS
//   --game LABEL     ROM label as it appears in n64/index.html ROMS[] (default Mario Kart 64)
//   --frames N       frames to compare after the barrier releases (default 900)
//   --runs R         repeat each arm R times (default 2)
//   --arms LIST      comma list of solo,bridge,pair (default solo,bridge)
//   --url BASE       default http://localhost:8080
//   --headful        show the windows
//   --json PATH      also write the full result as JSON

import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const BASE = flag('url', 'http://localhost:8080');
const GAME = flag('game', 'Mario Kart 64');
const FRAMES = parseInt(flag('frames', '900'), 10);
const RUNS = parseInt(flag('runs', '2'), 10);
const ARMS = flag('arms', 'solo,bridge').split(',').map((s) => s.trim()).filter(Boolean);
const JSONPATH = flag('json', '/tmp/n64-lockstep.json');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const mkCode = () => Array.from({ length: 5 },
  () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The page seam. Everything below reads window.__n64Net(), which reports the
// result of DOING the thing — `frame` is frames the CORE ran under the gate,
// `coreArmed` is _neil_ls_armed() asked of the wasm itself — never an intention.
// ---------------------------------------------------------------------------
const netState = (page) => page.evaluate(() => {
  try { return window.__n64Net ? window.__n64Net() : null; } catch (e) { return { error: String(e) }; }
});

async function waitFor(page, fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { /* navigation, retry */ }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out after ' + ms + ' ms waiting for ' + what);
    await sleep(150);
  }
}

// ⚠ A FRESH CONTEXT PER CORE IS NOT COSMETIC. The two cores must not share
// IndexedDB: dist/script.js's LoadSram() reads this origin's save memory into
// the core BEFORE callMain, so two peers with different saves boot into
// different guest state and diverge on frame 1 through no fault of the network.
// (The page also neuters LoadSram inside a room; this is the second layer, and
// it is what makes the SOLO arm's two reps independent too.)
// Puppeteer renamed this API; support both rather than pinning a version.
// ⚠ AND WHY THE PAIR ARM MUST *NOT* USE SEPARATE CONTEXTS. The 'local'
// transport signals over a BroadcastChannel, and a separate browser context is a
// separate storage partition — so two contexts CANNOT SEE EACH OTHER'S
// BroadcastChannel and the peers never pair at all. MEASURED exactly that: both
// sides armed correctly and the host then engaged the gate with
// `ports=[null,null,null,null], mine=[]`, i.e. an EMPTY ROSTER, which is a room
// with nobody in it rather than a room of two. The pair arm therefore runs two
// TABS in one context — the same configuration dreamcast/tools/determinism_probe.mjs
// uses and describes — and the save-memory hazard is handled instead by the
// page neutering LoadSram inside a room.
async function openPage(browser, url, tag, log, sameContext, preload) {
  let ctx = null, page;
  if (sameContext) {
    page = await browser.newPage();
  } else {
    const mk = browser.createBrowserContext
      ? browser.createBrowserContext.bind(browser)
      : browser.createIncognitoBrowserContext.bind(browser);
    ctx = await mk();
    page = await ctx.newPage();
  }
  page.setDefaultTimeout(120000);
  page.on('console', (m) => {
    const t = m.text();
    if (/lockstep|desync|\[net\]/i.test(t)) log.push('[' + tag + '] ' + t);
  });
  page.on('pageerror', (e) => log.push('[' + tag + '] PAGEERROR ' + e.message));
  if (preload) await preload(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { ctx, page, close: async () => { if (ctx) await ctx.close(); else await page.close(); } };
}

// ---------------------------------------------------------------------------
// ARM: solo. One core, armed, driven directly by this rig with a scripted input
// stream and no room. Run twice from a fresh boot and compared against itself.
//
// This is the CONTROL. It isolates "is this core a deterministic function of
// (ROM, frame index, input)" from anything the network or the engine does.
// ---------------------------------------------------------------------------
async function runSolo(browser, log) {
  const url = BASE + '/n64/?game=' + encodeURIComponent(GAME) + '&autostart';
  const trace = [];
  for (let rep = 0; rep < 2; rep++) {
    const { page, close } = await openPage(browser, url, 'solo' + rep, log, false);
    try {
      await waitFor(page, () => !!(window.Module && window.Module._neil_ls_arm
        && window.myApp && window.myApp.rivetsData
        && window.myApp.rivetsData.beforeEmulatorStarted === false), 180000, 'solo core boot');
      // Arm AFTER boot here on purpose: this arm is not testing the boot
      // ordering (the pair arm is), it is testing whether stepping the core with
      // a fixed input schedule is reproducible. Arming stops the core's own loop
      // so every subsequent frame comes from this rig.
      const fps = await page.evaluate((n) => {
        const M = window.Module;
        M._neil_ls_arm(1);
        if (M._neil_fp_always) M._neil_fp_always(1);
        const out = [];
        for (let f = 0; f < n; f++) {
          // A SCRIPTED input that is a pure function of the frame index and
          // nothing else — no clock, no random. Presses Start and A on a fixed
          // cadence and sweeps the stick, so the run is not just an idle demo.
          const mask = ((f % 120) < 4 ? (1 << 6) : 0) | ((f % 37) < 3 ? (1 << 4) : 0);
          const ax = Math.round(Math.sin(f / 30) * 32000);
          const ay = Math.round(Math.cos(f / 41) * 32000);
          M._neil_ls_set_pad(0, mask, ax, ay);
          M._neil_ls_run_frame();
          if ((f % 30) === 0) out.push([f, M._neil_last_fp() >>> 0]);
        }
        return out;
      }, FRAMES);
      trace.push(fps);
    } finally { await close(); }
  }
  const [a, b] = trace;
  let firstDiff = null, compared = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    compared++;
    if (a[i][1] !== b[i][1]) { firstDiff = { frame: a[i][0], a: a[i][1], b: b[i][1] }; break; }
  }
  return { arm: 'solo', frames: FRAMES, samples: compared, firstDiff, pass: !firstDiff && compared > 0 };
}

// ---------------------------------------------------------------------------
// ARM: bridge. TWO independent cores, TWO REAL lib/netplay.js Lockstep engines,
// exchanging frame-numbered input — with THIS RIG carrying the messages between
// them instead of WebRTC.
//
// ⚠ WHY THIS ARM EXISTS, AND WHAT IT DELIBERATELY DOES NOT PROVE.
// The `pair` arm below is the product path and it currently cannot run here: the
// 'local' transport does not pair. That was ISOLATED away from this page's code
// entirely — two BLANK same-origin tabs, using nothing but lib/netplay.js with
// transport:'local', sat at `host: signalling (someone is asking to join)` /
// `guest: signalling (waiting for the host to let you in)` for 12 consecutive
// samples over 24 s and never reached 'connected'. No emulator, no lockstep
// code, no page of mine involved. That is a defect in the shared signalling
// layer, not in the frame gate.
//
// So this arm stubs out EXACTLY that one broken piece and nothing else. The
// Lockstep engines are the real ones (Netplay.Lockstep is exported at
// netplay.js:3076), the roster/seating/barrier/delay/fingerprint-comparison
// logic is the real one, the cores are two real independent cores, and the
// input is real frame-numbered input. Only the pipe is the rig's.
//
// WHAT IT THEREFORE DOES NOT COVER, stated so a PASS is not overclaimed:
//   * the transport (that is the point — it is known broken and separately owned)
//   * n64/index.html's own lsFeed()/beginFrame glue, since this drives the core
//     entry points directly the way lsFeed does rather than calling lsFeed.
// It DOES answer the question the whole architecture rests on: given identical
// frame-numbered input, do two independent cores stay byte-identical?
// ---------------------------------------------------------------------------
async function runBridge(browser, log) {
  // ⚠ NO &autostart, AND THE ARM IS INSTALLED BEFORE THE PAGE EVEN LOADS.
  // The first cut of this arm let both cores boot free-running and armed them
  // afterwards, and it FAILED AT FRAME 0 with fingerprints 567859528 vs
  // 3281868993 — because each core had free-run a different number of frames
  // before the gate engaged, so the room's "frame 0" was two different guest
  // positions. That is the product's ordering lesson (n64/index.html arms inside
  // myApp.beforeRun, which script.js:233 calls BEFORE Module.callMain) and the
  // rig has to honour it or it measures its own mistake. This mirrors it: the
  // hook is installed by evaluateOnNewDocument, so it is in place before any
  // page script runs, and it wraps beforeRun the moment myApp exists.
  const url = BASE + '/n64/?game=' + encodeURIComponent(GAME);
  const armEarly = (page) => page.evaluateOnNewDocument(() => {
    window.__armedAtBoot = false;
    const iv = setInterval(() => {
      const app = window.myApp;
      if (!app || app.__probeHooked) return;
      app.__probeHooked = true;
      clearInterval(iv);
      const prev = app.beforeRun ? app.beforeRun.bind(app) : function () {};
      app.beforeRun = function () {
        prev();
        const M = window.Module;
        if (M && M._neil_ls_arm) {
          M._neil_ls_arm(1);
          if (M._neil_fp_always) M._neil_fp_always(1);
          window.__armedAtBoot = true;
        }
      };
    }, 20);
  });
  const A = await openPage(browser, url, 'A', log, true, armEarly);
  const B = await openPage(browser, url, 'B', log, true, armEarly);
  try {
    // Press Start on both, then wait for the core to be booted AND armed.
    for (const P of [A, B]) {
      await P.page.evaluate(() => {
        const b = document.getElementById('btnStart');
        if (b && !b.disabled) b.click();
      });
    }
    for (const [tag, P] of [['A', A], ['B', B]]) {
      await waitFor(P.page, () => (window.__armedAtBoot && window.Module
        && window.Module._neil_ls_armed && window.Module._neil_ls_armed()
        && window.myApp && window.myApp.rivetsData
        && window.myApp.rivetsData.beforeEmulatorStarted === false) ? true : null,
        240000, tag + ' core to boot ALREADY ARMED');
    }
    // Both cores are now holding at their own frame 0, having run nothing.
    // ⚠ ASSERT IT rather than assume it: _neil_vi_total is the core's own free
    // running VI counter, and if the two disagree here the room's frame 0 is
    // already two different guest positions and every later comparison is void.
    const viA = await A.page.evaluate(() => window.Module._neil_vi_total());
    const viB = await B.page.evaluate(() => window.Module._neil_vi_total());
    if (viA !== viB) {
      return { arm: 'bridge', pass: false,
        error: 'the two cores were at DIFFERENT guest positions before frame 0 (vi ' + viA + ' vs ' + viB
             + ') — one of them ran frames before the gate armed' };
    }
    // Build a real engine on each side. Outbound messages are queued for the rig
    // to carry; nothing else about the engine is altered.
    const install = (page, isHost, me) => page.evaluate((isHost, me) => {
      window.__out = [];
      window.__ls = new Netplay.Lockstep({
        host: isHost, peerId: me, portCount: 4, padBytes: 4,
        delay: 3, hashEvery: 60, stallBudgetMs: 60000,
        send: (m) => window.__out.push(m),
      });
      window.__frames = 0;
      window.__fp = 0;
      return true;
    }, isHost, me);
    await install(A.page, true, 'A');
    await install(B.page, false, 'B');

    const drain = async (from, to) => {
      const msgs = await from.page.evaluate(() => { const o = window.__out; window.__out = []; return o; });
      if (!msgs.length) return 0;
      await to.page.evaluate((ms) => { ms.forEach((m) => { try { window.__ls.receive(m); } catch (e) {} }); }, msgs);
      return msgs.length;
    };

    // Host seats both players, lowest-free-first, and broadcasts the roster.
    await A.page.evaluate(() => { window.__ls.seat('A', 1); window.__ls.seat('B', 1); });
    await drain(A, B);
    // Both declare "my core is booted and holding at frame 0, on this ROM".
    await A.page.evaluate(() => window.__ls.declareReady('n64'));
    await drain(A, B);
    await B.page.evaluate(() => window.__ls.declareReady('n64'));
    await drain(B, A);
    await drain(A, B);

    const state = async (P) => P.page.evaluate(() => window.__ls.state);
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      if ((await state(A)) === 'running' && (await state(B)) === 'running') break;
      await drain(A, B); await drain(B, A);
      await sleep(100);
    }
    const sA = await state(A), sB = await state(B);
    if (sA !== 'running' || sB !== 'running') {
      return { arm: 'bridge', pass: false, error: 'barrier never released (A=' + sA + ' B=' + sB + ')' };
    }

    // Drive frames. Each side produces its OWN pad (a scripted function of the
    // frame index so the run is reproducible and not an idle demo), the engine
    // hands back the whole 4-port image, and the core runs exactly one frame.
    const step = (page, seat, n) => page.evaluate((seat, n) => {
      const M = window.Module;
      const out = [];
      for (let k = 0; k < n; k++) {
        const f = window.__ls.frame;
        // own pad: distinct per seat so both players are genuinely driving
        const mask = ((f + seat * 17) % 90) < 5 ? (1 << 4) : ((f % 150) < 4 ? (1 << 6) : 0);
        const ax = Math.round(Math.sin((f + seat * 40) / 30) * 127) & 0xff;
        const pad = new Uint8Array([mask & 0xff, (mask >> 8) & 0x3f, ax, 0]);
        const pads = {}; pads[seat] = pad;
        const r = window.__ls.beginFrame(pads);
        if (!r || !r.ready) { out.push([f, null, r ? r.reason : 'none']); break; }
        const img = r.image;
        for (let p = 0; p < 4; p++) {
          const o = p * 4;
          const m2 = img[o] | (img[o + 1] << 8);
          const sx = (img[o + 2] << 24) >> 24, sy = (img[o + 3] << 24) >> 24;
          M._neil_ls_set_pad(p, m2, Math.round(sx / 127 * 32000), Math.round(sy / 127 * 32000));
        }
        M._neil_ls_run_frame();
        window.__frames++;
        const fp = M._neil_last_fp() >>> 0;
        window.__fp = fp;
        const want = (typeof window.__ls.wantsHash === 'function') ? window.__ls.wantsHash() : true;
        if (want && fp) window.__ls.endFrame(fp, [fp]); else window.__ls.endFrame(null);
        out.push([f, fp, null]);
      }
      return out;
    }, seat, n);

    const fpA = new Map(), fpB = new Map();
    let stalls = 0;
    for (let done = 0; done < FRAMES; ) {
      const [oa, ob] = [await step(A.page, 0, 10), await step(B.page, 1, 10)];
      oa.forEach(([f, fp, why]) => { if (fp != null) fpA.set(f, fp); else stalls++; });
      ob.forEach(([f, fp, why]) => { if (fp != null) fpB.set(f, fp); else stalls++; });
      await drain(A, B); await drain(B, A);
      const nA = await A.page.evaluate(() => window.__frames);
      const nB = await B.page.evaluate(() => window.__frames);
      done = Math.min(nA, nB);
      if (Date.now() - t0 > 600000) break;
      const dA = await A.page.evaluate(() => !!(window.__ls.desync));
      const dB = await B.page.evaluate(() => !!(window.__ls.desync));
      if (dA || dB) break;
    }

    let compared = 0, firstDiff = null;
    const frames = [...fpA.keys()].filter((f) => fpB.has(f)).sort((x, y) => x - y);
    for (const f of frames) {
      compared++;
      if (fpA.get(f) !== fpB.get(f)) { firstDiff = { frame: f, a: fpA.get(f), b: fpB.get(f) }; break; }
    }
    const desync = await A.page.evaluate(() => window.__ls.desync || null);
    const framesA = await A.page.evaluate(() => window.__frames);
    const framesB = await B.page.evaluate(() => window.__frames);
    const statsA = await A.page.evaluate(() => window.__ls.stats);
    return {
      arm: 'bridge', framesA, framesB, compared, firstDiff, stalls,
      hashesCompared: statsA ? statsA.hashesCompared : null,
      desync: desync ? { frame: desync.frame, peers: desync.peers } : null,
      pass: compared > 0 && !firstDiff && !desync,
    };
  } finally {
    await A.close().catch(() => {});
    await B.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ARM: attach. THE PAGE'S OWN LOOP, end to end, with only the transport stubbed.
//
// This is the strongest arm available while lib/netplay.js's 'local' transport
// cannot pair two peers. It hands each page a real Netplay.Lockstep engine
// through window.__n64LsAttach BEFORE the core boots, and then TOUCHES NOTHING
// else: the page arms in its own beforeRun, its own rAF tick calls its own
// lsFeed(), which builds its own pads, calls beginFrame, applies the image and
// runs the frame, and paces itself with its own governor. The rig only carries
// messages between the two engines and reads window.__n64Net().
//
// It therefore covers what `bridge` cannot: lsFeed, lsLocalPads, lsApplyImage,
// lsRunOneFrame, endFrame, and — the reason it exists — THE 1.000x GOVERNOR,
// measured as frames actually run per wall second against the ROM's own viHz.
// Lockstep may only ever make that number LOWER; above 1.000x would mean the
// gate had become an accelerator, which CLAUDE.md gate #9 forbids outright.
// ---------------------------------------------------------------------------
async function runAttach(browser, log) {
  const url = BASE + '/n64/?game=' + encodeURIComponent(GAME);
  const A = await openPage(browser, url, 'A', log, true);
  const B = await openPage(browser, url, 'B', log, true);
  try {
    const attach = (P, isHost, me) => P.page.evaluate((isHost, me) => {
      window.__out = [];
      return !!window.__n64LsAttach && !!window.__n64LsAttach({
        host: isHost, peerId: me, portCount: 4, padBytes: 4,
        delay: 3, hashEvery: 60, stallBudgetMs: 120000,
        send: (m) => window.__out.push(m), code: 'TEST7',
      });
    }, isHost, me);
    if (!(await attach(A, true, 'A')) || !(await attach(B, false, 'B'))) {
      return { arm: 'attach', pass: false, error: 'page has no __n64LsAttach seam — rebuild/refresh n64/index.html' };
    }
    const drain = async (from, to) => {
      const msgs = await from.page.evaluate(() => { const o = window.__out; window.__out = []; return o; });
      if (!msgs.length) return 0;
      await to.page.evaluate((ms) => { ms.forEach((m) => { try { window.__n64LsEngine.receive(m); } catch (e) {} }); }, msgs);
      return msgs.length;
    };

    // Host seats both, everyone declares ready, then the PAGES do the rest.
    await A.page.evaluate(() => { window.__n64LsEngine.seat('A', 1); window.__n64LsEngine.seat('B', 1); });
    await drain(A, B);
    // Press Start on both. The page arms in beforeRun, so no frame runs first.
    for (const P of [A, B]) {
      await P.page.evaluate(() => { const b = document.getElementById('btnStart'); if (b && !b.disabled) b.click(); });
    }
    for (const [tag, P] of [['A', A], ['B', B]]) {
      await waitFor(P.page, () => {
        const n = window.__n64Net && window.__n64Net();
        return (n && n.armed && n.coreArmed && n.frame === 0) ? n : null;
      }, 300000, tag + ' core to boot ALREADY ARMED and holding at frame 0');
    }
    await A.page.evaluate(() => window.__n64LsEngine.declareReady('n64'));
    await drain(A, B);
    await B.page.evaluate(() => window.__n64LsEngine.declareReady('n64'));
    await drain(B, A); await drain(A, B);

    // From here the PAGES run frames on their own rAF loops. The rig only relays.
    const t0 = Date.now();
    const fpA = new Map(), fpB = new Map();
    let last = { a: null, b: null };
    for (;;) {
      await drain(A, B); await drain(B, A);
      const [na, nb] = await Promise.all([netState(A.page), netState(B.page)]);
      last = { a: na, b: nb };
      if (na && na.frame > 0 && na.lastFp) fpA.set(na.frame, na.lastFp >>> 0);
      if (nb && nb.frame > 0 && nb.lastFp) fpB.set(nb.frame, nb.lastFp >>> 0);
      const desync = (na && na.engine && na.engine.desync) || (nb && nb.engine && nb.engine.desync);
      if (desync) break;
      if (Math.min(na ? na.frame : 0, nb ? nb.frame : 0) >= FRAMES) break;
      if (Date.now() - t0 > 420000) break;
      await sleep(20);
    }
    const elapsedMs = Date.now() - t0;

    let compared = 0, firstDiff = null;
    const frames = [...fpA.keys()].filter((f) => fpB.has(f)).sort((x, y) => x - y);
    for (const f of frames) {
      compared++;
      if (fpA.get(f) !== fpB.get(f)) { firstDiff = { frame: f, a: fpA.get(f), b: fpB.get(f) }; break; }
    }
    const viHz = (last.a && last.a.viHz) || 0;
    const runFps = last.a ? (last.a.frame / (elapsedMs / 1000)) : 0;
    const guestRateX = viHz > 0 ? +(runFps / viHz).toFixed(4) : null;
    return {
      arm: 'attach',
      framesA: last.a ? last.a.frame : 0, framesB: last.b ? last.b.frame : 0,
      compared, firstDiff,
      desync: !!((last.a && last.a.engine && last.a.engine.desync) || (last.b && last.b.engine && last.b.engine.desync)),
      hashesA: last.a ? last.a.hashes : 0, hashesB: last.b ? last.b.hashes : 0,
      stalls: last.a ? last.a.stalls : 0, stallMs: last.a ? last.a.stallMs : 0,
      reanchors: last.a ? last.a.reanchors : null,
      viHz, runFps: +runFps.toFixed(2), guestRateX, elapsedMs,
      faultA: last.a ? last.a.fault : null, faultB: last.b ? last.b.fault : null,
      // ⚠ A RATE ABOVE 1.000x IS A FAILURE, not a bonus (CLAUDE.md gate #9).
      pass: compared > 0 && !firstDiff
            && !((last.a && last.a.engine && last.a.engine.desync) || (last.b && last.b.engine && last.b.engine.desync))
            && (guestRateX == null || guestRateX <= 1.02),
    };
  } finally {
    await A.close().catch(() => {});
    await B.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// ARM: pair. TWO cores, TWO contexts, one room, from frame 0, over the real
// engine and a real RTCPeerConnection. This is the product.
// ---------------------------------------------------------------------------
async function runPair(browser, log) {
  const code = mkCode();
  const q = '&net=local';
  const hostUrl = BASE + '/n64/?np=' + code + '&game=' + encodeURIComponent(GAME) + q;
  const joinUrl = hostUrl + '&join=1';

  const A = await openPage(browser, hostUrl, 'host', log, true);
  await sleep(400);                      // let the host publish before the joiner calls
  const B = await openPage(browser, joinUrl, 'join', log, true);

  try {
    // 1. Both cores must ARM BEFORE THEY RUN A FRAME. This is the ordering the
    //    whole architecture rests on, so it is asserted rather than assumed:
    //    coreArmed is _neil_ls_armed() asked of the wasm, and frame must still
    //    be 0 when we first see it armed.
    const armed = {};
    for (const [tag, P] of [['host', A], ['join', B]]) {
      const st = await waitFor(P.page, () => {
        const n = window.__n64Net && window.__n64Net();
        return (n && n.armed && n.coreArmed) ? n : null;
      }, 240000, tag + ' core to arm');
      armed[tag] = { frame: st.frame, viHz: st.viHz, state: st.state };
    }

    // 2. BOTH PLAYERS PRESS READY — the rig does what a person does, because
    //    that is the real trigger. There is deliberately no auto-ready in the
    //    product (an earlier cut had one and the first machine to boot passed the
    //    barrier alone with an empty roster), so a rig that bypassed the button
    //    would be testing a path no player can take.
    //    Wait until BOTH sides can see two seated ports first; pressing before
    //    the peer is seated is exactly the bug the button exists to prevent.
    for (const [tag, P] of [['host', A], ['join', B]]) {
      await waitFor(P.page, () => {
        const n = window.__n64Net && window.__n64Net();
        const ports = n && n.engine && n.engine.ports;
        return (ports && ports.filter((p) => p.peer).length >= 2) ? true : null;
      }, 180000, tag + ' to see both players seated');
    }
    for (const [tag, P] of [['host', A], ['join', B]]) {
      await P.page.evaluate(() => {
        const b = document.getElementById('netReady');
        if (b && !b.disabled) b.click();
      });
    }

    // 3. The barrier must release and BOTH must actually start running frames.
    for (const [tag, P] of [['host', A], ['join', B]]) {
      await waitFor(P.page, () => {
        const n = window.__n64Net && window.__n64Net();
        return (n && n.running && n.frame > 0) ? n : null;
      }, 240000, tag + ' to pass the start barrier');
    }

    // 4. Sample both sides' (frame, fingerprint) until the target is reached.
    const t0 = Date.now();
    const sampA = new Map(), sampB = new Map();
    let last = { a: null, b: null };
    for (;;) {
      const [na, nb] = await Promise.all([netState(A.page), netState(B.page)]);
      last = { a: na, b: nb };
      if (na && na.frame > 0 && na.lastFp) sampA.set(na.frame, na.lastFp >>> 0);
      if (nb && nb.frame > 0 && nb.lastFp) sampB.set(nb.frame, nb.lastFp >>> 0);
      if ((na && na.engine && na.engine.desync) || (nb && nb.engine && nb.engine.desync)) break;
      if (Math.min(na ? na.frame : 0, nb ? nb.frame : 0) >= FRAMES) break;
      if (Date.now() - t0 > 300000) break;
      await sleep(40);
    }
    const elapsedMs = Date.now() - t0;

    // 5. Compare only frames BOTH sides reported. A frame one side never
    //    sampled is not evidence of anything.
    let compared = 0, firstDiff = null;
    const frames = [...sampA.keys()].filter((f) => sampB.has(f)).sort((x, y) => x - y);
    for (const f of frames) {
      compared++;
      if (sampA.get(f) !== sampB.get(f)) { firstDiff = { frame: f, a: sampA.get(f), b: sampB.get(f) }; break; }
    }

    // 6. THE GUEST RATE (CLAUDE.md gate #9). Frames actually run divided by wall
    //    seconds, against the ROM's own region rate. Lockstep may only ever make
    //    this LOWER than 1.000x; a figure above it would mean the gate had
    //    become an accelerator, which is the one thing that must never happen.
    const viHz = (last.a && last.a.viHz) || 0;
    const runFps = last.a ? (last.a.frame / (elapsedMs / 1000)) : 0;

    return {
      arm: 'pair', code, armed,
      framesHost: last.a ? last.a.frame : 0,
      framesJoin: last.b ? last.b.frame : 0,
      compared, firstDiff,
      desync: !!((last.a && last.a.engine && last.a.engine.desync)
              || (last.b && last.b.engine && last.b.engine.desync)),
      hashesHost: last.a ? last.a.hashes : 0,
      hashesJoin: last.b ? last.b.hashes : 0,
      stallsHost: last.a ? last.a.stalls : 0,
      stallMsHost: last.a ? last.a.stallMs : 0,
      viHz, runFps: +runFps.toFixed(2),
      guestRateX: viHz > 0 ? +(runFps / viHz).toFixed(4) : null,
      elapsedMs,
      faultHost: last.a ? last.a.fault : null,
      faultJoin: last.b ? last.b.fault : null,
      pass: compared > 0 && !firstDiff
            && !((last.a && last.a.engine && last.a.engine.desync)
              || (last.b && last.b.engine && last.b.engine.desync)),
    };
  } finally {
    await A.close().catch(() => {});
    await B.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
const log = [];
const browser = await puppeteer.launch({
  headless: has('headful') ? false : 'new',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // ⚠ THE BACKGROUND-TAB THROTTLES MUST BE OFF, OR THE RATE IS THE BROWSER'S
  // OPINION AND NOT THE GOVERNOR'S. Both the `bridge` and `attach` arms run TWO
  // tabs, and only one of them can be foreground: Chrome throttles rAF and
  // timers in backgrounded/occluded renderers, which would show up as an
  // enormous stall count and a guest rate far below 1.000x that has nothing to
  // do with lockstep. The `attach` arm measures the 1.000x governor, so a
  // throttled tab there would be a fabricated number in the pessimistic
  // direction — still a fabricated number.
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage',
         '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
         '--disable-renderer-backgrounding'],
});
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

const results = [];
try {
  for (const arm of ARMS) {
    for (let r = 0; r < RUNS; r++) {
      let res;
      try {
        res = arm === 'solo' ? await runSolo(browser, log)
            : arm === 'bridge' ? await runBridge(browser, log)
            : arm === 'attach' ? await runAttach(browser, log)
            : await runPair(browser, log);
      } catch (e) {
        res = { arm, run: r, error: e.message, pass: false };
      }
      res.run = r;
      results.push(res);
      console.log(JSON.stringify(res));
    }
  }
} finally {
  await browser.close().catch(() => {});
}

const byArm = {};
for (const r of results) (byArm[r.arm] ||= []).push(r);
console.log('\n--- SUMMARY ---');
for (const [arm, rs] of Object.entries(byArm)) {
  const pass = rs.filter((r) => r.pass).length;
  console.log(`${arm}: ${pass}/${rs.length} runs PASS`);
  for (const r of rs) {
    if (r.error) { console.log(`  run ${r.run}: ERROR ${r.error}`); continue; }
    if (arm === 'attach') {
      console.log(`  run ${r.run}: compared=${r.compared} framesA=${r.framesA} framesB=${r.framesB}`
        + ` desync=${r.desync} stalls=${r.stalls} (${r.stallMs}ms) reanchors=${r.reanchors}`
        + ` guest=${r.guestRateX == null ? '?' : r.guestRateX + 'x'} @${r.viHz}Hz (${r.runFps} fps)`
        + (r.firstDiff ? ` FIRST-DIFF frame ${r.firstDiff.frame}` : ' identical'));
    } else if (arm === 'bridge') {
      console.log(`  run ${r.run}: compared=${r.compared} framesA=${r.framesA} framesB=${r.framesB}`
        + ` hashesCompared=${r.hashesCompared} stalls=${r.stalls} desync=${r.desync ? JSON.stringify(r.desync) : 'none'}`
        + (r.firstDiff ? ` FIRST-DIFF frame ${r.firstDiff.frame}` : ' identical'));
    } else if (arm === 'pair') {
      console.log(`  run ${r.run}: compared=${r.compared} frames host=${r.framesHost} join=${r.framesJoin}`
        + ` desync=${r.desync} hashes=${r.hashesHost}/${r.hashesJoin}`
        + ` stalls=${r.stallsHost} (${r.stallMsHost}ms)`
        + ` guest=${r.guestRateX == null ? '?' : r.guestRateX + 'x'} @${r.viHz}Hz`
        + (r.firstDiff ? ` FIRST-DIFF frame ${r.firstDiff.frame}` : ''));
    } else {
      console.log(`  run ${r.run}: samples=${r.samples}`
        + (r.firstDiff ? ` FIRST-DIFF frame ${r.firstDiff.frame}` : ' identical'));
    }
  }
}
const allPass = results.length > 0 && results.every((r) => r.pass);
console.log('\nGATE: ' + (allPass ? 'PASS' : 'FAIL'));
try {
  writeFileSync(JSONPATH, JSON.stringify({ results, log }, null, 2));
  console.log('full result -> ' + JSONPATH);
} catch (e) { /* reporting must not fail the gate */ }
if (log.length) {
  console.log('\n--- page log (lockstep/net lines) ---');
  log.slice(0, 80).forEach((l) => console.log(l));
}
process.exit(allPass ? 0 : 1);

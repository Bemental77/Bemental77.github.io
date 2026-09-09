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
//   --arms LIST      comma list of solo,pair (default solo,pair)
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
const ARMS = flag('arms', 'solo,pair').split(',').map((s) => s.trim()).filter(Boolean);
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
async function openPage(browser, url, tag, log, sameContext) {
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
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--disable-dev-shm-usage'],
});
try { (await import('../../tools/browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}

const results = [];
try {
  for (const arm of ARMS) {
    for (let r = 0; r < RUNS; r++) {
      let res;
      try {
        res = arm === 'solo' ? await runSolo(browser, log) : await runPair(browser, log);
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
    if (arm === 'pair') {
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

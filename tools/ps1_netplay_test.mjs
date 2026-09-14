#!/usr/bin/env node
// DOES ps1.html ACTUALLY PLAY TWO-PLAYER LOCKSTEP, END TO END?
//
// WHAT THIS ASSERTS THAT NOTHING ELSE DOES.
//   * tools/ps1_determinism_probe.mjs proves the CORE is deterministic, by
//     driving two of them itself and bypassing the page entirely — including a
//     SKEW arm that deliberately desynchronises the two cores' wall clocks.
//   * tools/no_streaming_test.mjs proves the page's SOURCE carries no streaming
//     machinery and does mention the frame gate.
//   Neither proves the PAGE drives that gate correctly. This does: two real
//   pages, a real room, both cores running, and the assertions are on the BYTES
//   the cores were handed and the fingerprints they agreed on — never on a UI
//   flag or a session status, because "connected" was exactly the signal that
//   let a whole page claim online play while every core free-ran.
//
// Structure and every ⚠ below are taken from tools/genesis_netplay_test.mjs,
// which paid for them. The PS1-specific parts are the seam (__ps1Net), the
// ACTIVE-LOW pad encoding, and the fact that this core lives in a WORKER — so
// the page feeds gated frames and the worker retires them, and "frames the page
// fed" and "frames the core ran" are two different numbers that must agree.
//
// THE CONFIGURATION
//   Two windows, `?net=local` — lib/netplay.js's same-browser BroadcastChannel
//   signalling, so this needs no broker and no network. That is a REAL
//   limitation, stated rather than hidden: it exercises the room, the seating,
//   the frame gate and the fingerprint comparison, but NOT NAT traversal.
//
// USAGE
//   npm run web                                       # port 8080
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/ps1_netplay_test.mjs
//
// FLAGS  --headful  --keep  --seconds N (default 8)  --url BASE  --cold
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const SECONDS = parseInt(flag('seconds', '8'), 10);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// The disc. ROMS[3] is Harry Potter & the Sorcerer's Stone, 346,032,644 bytes —
// the smallest disc ps1.html lists (ps1.html ROMS[]); the page default,
// Monster Rancher 2, is 451 MB and every other disc is larger. Two peers stream
// it, so the smallest is the honest default for a gate; --rom N picks another.
const ROM = parseInt(flag('rom', '3'), 10);

// ⚠ EVERY waitForFunction HERE MUST POLL ON A TIMER, NOT ON rAF. Puppeteer's
// default `polling: 'raf'` runs the predicate inside requestAnimationFrame, and
// only one of these two windows is frontmost — the other's rAF can be throttled
// to a stop, so every wait against it times out no matter what the page is
// doing. (genesis_netplay_test.mjs lost a full debugging cycle to this.)
const POLL_MS = 250;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  ${detail == null ? '' : detail}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail == null ? '' : detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ EACH PEER GETS ITS OWN WINDOW, NOT ITS OWN TAB. Chrome gives a HIDDEN tab
// no requestAnimationFrame at all, and this page's lockstep feed loop is
// rAF-driven — a background peer would feed literally zero frames and the
// visible peer would stall forever waiting for a console the HARNESS froze,
// which reads exactly like a broken frame gate. Two separate windows both
// report "visible", and they stay in ONE browser so `local` signalling pairs
// them without a broker.
async function openWindowPage(browser) {
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  await cdp.detach();
  for (let i = 0; i < 100; i++) {
    for (const t of browser.targets()) {
      const id = t._targetId || (t._targetInfo && t._targetInfo.targetId);
      if (id === targetId) { const p = await t.page(); if (p) return p; }
    }
    await sleep(100);
  }
  throw new Error('could not open a separate browser window for a peer');
}

async function openPeer(browser, tag) {
  const page = await openWindowPage(browser);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`${BASE}/ps1.html?net=local`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => !!(window.__ps1Net && window.__ps1Net().supported && window.Netplay),
    { timeout: 120000, polling: POLL_MS });
  return { page, errs, tag };
}

// PS1 pad bytes are an ACTIVE-LOW 16-bit KeyStatus: 0xFFFF at rest, and a press
// CLEARS a bit (plugins/sdlinput/xkb.c:43 `KeyStatus &= ~(1 << j)`). Cross is
// bit 6 of the HIGH byte, i.e. bit 14 of the word (ps1.html updatePadState).
const CROSS_BIT = 1 << 14;
const maskAt = (img, port) => (img ? ((img[port * 2] | (img[port * 2 + 1] << 8)) & 0xffff) : 0xffff);

(async () => {
  console.log('=== ps1 two-peer lockstep test ===');
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
  try {
    const md5 = (f) => require('node:crypto').createHash('md5').update(fs.readFileSync(f)).digest('hex');
    console.log('worker: js=' + md5('ps1/ps1Wasm/dist/wasmpsx_worker.js') + ' wasm=' + md5('ps1/ps1Wasm/dist/wasmpsx_worker.wasm'));
  } catch (e) {}

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: has('headful') ? false : 'new',
    userDataDir: has('cold') ? fs.mkdtempSync('/tmp/ps1np-cold-') : undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
           '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           // Without this a window stacked behind another can still be judged
           // occluded and lose its rAF — the same failure as a hidden tab.
           '--disable-features=CalculateNativeWinOcclusion'],
  });
  try {
    const g = require('./browser_leak_guard.js');
    if (g && g.guard) g.guard(browser, 'ps1_netplay_test');
  } catch (e) {}

  try {
    // ⚠ SAME BROWSER, DELIBERATELY. `local` signalling is a BroadcastChannel on
    // one origin in one browser; two processes cannot see each other on it.
    const A = await openPeer(browser, 'A');
    const B = await openPeer(browser, 'B');

    // ⚠ PROVE BOTH PEERS CAN ACTUALLY RENDER BEFORE MEASURING ANYTHING. If one
    // is hidden it feeds no frames, and every later assertion becomes a
    // statement about the harness rather than about the page.
    const vis = await Promise.all([
      A.page.evaluate(() => document.visibilityState),
      B.page.evaluate(() => document.visibilityState),
    ]);
    ok('both-peers-can-render', vis[0] === 'visible' && vis[1] === 'visible',
       `visibilityState host=${vis[0]} guest=${vis[1]} — a hidden page gets no rAF and would feed zero frames`);

    // ---- 1. FORM THE ROOM BEFORE ANYTHING BOOTS --------------------------
    // The ordering is the product requirement, not a convenience: the gate is
    // armed at WORKER-CONSTRUCTION time (?netgate=1), so a player who pressed
    // Start first would have an ungated worker that free-ran on its own clock.
    // THE ONE CONTROL. With no room it reads exactly "Party"; inside one it is
    // the live status readout (checked again once the room is playing).
    const label0 = await A.page.evaluate(() => document.getElementById('btnNet').textContent.trim());
    ok('the-party-button-reads-Party-with-no-room', label0 === 'Party', `#btnNet reads "${label0}"`);

    // The host PICKS the disc before opening the room — a dropdown, not a
    // download. The room is named for the picker (ps1.html netGameIndex), and
    // the joiner has to name the same disc or lib/netplay.js refuses the pair.
    const picked = await A.page.evaluate((i) => {
      const s = document.getElementById('romSelect');
      s.value = String(i); s.dispatchEvent(new Event('change'));
      return s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : null;
    }, ROM);
    console.log(`  INFO  disc  ROMS[${ROM}] = ${picked}`);

    // Drive the REAL controls: a test that called the session constructor
    // directly would pass on a page whose buttons were wired to nothing.
    const hostCode = await A.page.evaluate(() => {
      document.getElementById('btnNet').click();
      document.getElementById('netHostBtn').click();
      return document.getElementById('netCode').textContent.trim();
    });
    ok('host-mints-a-code', /^[A-HJ-NP-Z2-9]{5}$/.test(hostCode), `code=${hostCode}`);

    // ---- A HOST ALONE NEVER STARTS ----------------------------------------
    // The page auto-declares and auto-loads, so the guard against a party of
    // one has to hold with NOBODY else in the room: three seconds alone, and
    // no worker may have been spawned (that is what `armed` means here), the
    // disc must not be streaming, and the status line must say it is waiting.
    await sleep(3000);
    const alone = await A.page.evaluate(() => {
      const n = window.__ps1Net();
      return { armed: n.armed, live: n.live, party: n.party,
               barrier: (document.getElementById('netBarrier') || {}).textContent || '' };
    });
    ok('a-host-alone-never-starts',
       !alone.armed && !alone.live && alone.party.autoStarted === false && alone.party.loading === false
         && alone.party.seated <= 1 && alone.party.alone === true
         && /^Waiting for another player — share the code [A-HJ-NP-Z2-9]{5}\./.test(alone.barrier.trim()),
       `after 3 s alone: armed=${alone.armed} live=${alone.live} loading=${alone.party.loading} seated=${alone.party.seated} `
       + `alone=${alone.party.alone} autoStarted=${alone.party.autoStarted} label="${alone.party.label}" status="${alone.barrier.trim()}"`);

    await B.page.evaluate((code, i) => {
      document.getElementById('btnNet').click();
      document.getElementById('netJoinBtn').click();
      document.getElementById('netGame').value = String(i);   // the disc the room is on
      document.getElementById('netCodeIn').value = code;
      document.getElementById('netGo').click();
    }, hostCode, ROM);

    // ⚠ A HUMAN HAS TO SAY YES, and that is the design. Knowing the room code is
    // not enough: lib/netplay.js refuses to open a peer connection until the
    // host approves, so this clicks the same Allow button a host would.
    const allowed = await A.page.waitForFunction(
      () => !!document.getElementById('npApproveAllow'), { timeout: 30000, polling: POLL_MS })
      .then(() => A.page.evaluate(() => { document.getElementById('npApproveAllow').click(); return true; }))
      .catch(() => false);
    ok('host-is-asked-to-admit-the-joiner', allowed,
       'knowing the code is not enough — a human approves, and this clicked the real Allow button');

    const seated = async (p) => p.page.waitForFunction(
      () => { const n = window.__ps1Net(); return n.roster && n.roster.some((x) => x != null); },
      { timeout: 30000, polling: POLL_MS }).then(() => true).catch(() => false);
    const [sa, sb] = await Promise.all([seated(A), seated(B)]);
    ok('room-forms', sa && sb, `host seated=${sa} guest seated=${sb} code=${hostCode}`);

    const na0 = await A.page.evaluate(() => window.__ps1Net());
    const nb0 = await B.page.evaluate(() => window.__ps1Net());
    ok('ports-are-the-consoles-own', na0.portCount === 2 && nb0.portCount === 2,
       `portCount=${na0.portCount}/${nb0.portCount} — this core implements exactly two `
       + `(PADSTATE PadState[2]; there is no multitap in it)`);

    const pa = (na0.localPorts || [])[0], pb = (nb0.localPorts || [])[0];
    ok('each-peer-holds-a-different-port', pa != null && pb != null && pa !== pb,
       `host=port ${pa}, guest=port ${pb} — both on port 0 would look like it worked `
       + `and would mean one player driving both controllers`);

    // ---- 2+3. NOBODY PRESSES START ------------------------------------------
    // ⚠ THE CELL THIS FILE NOW EXISTS FOR. User, 2026-09-13: "should start when
    // both are able to start, instead of an I'm ready button and dumb
    // conditions to start the damn game." The old flow clicked #btnStart on
    // both peers right here; a page that still needs that click passes nothing
    // below. On this page `armed` means the worker was spawned GATED
    // (?netgate=1) — i.e. startEmulator() ran — and `party.autoStarted` is the
    // page's own record of having pressed it. The old
    // 'no-core-ran-before-the-room-formed' cell is gone for the reason the
    // genesis rig gives: it read a counter at a moment the product now races
    // past by working; 'no-ungated-frame-was-run' (fed vs ran) is the ordering
    // proof here.
    const armed = async (p, ms) => p.page.waitForFunction(
      () => window.__ps1Net().armed, { timeout: ms, polling: POLL_MS }).then(() => true).catch(() => false);
    let [aa, ab] = await Promise.all([armed(A, 120000), armed(B, 120000)]);
    const autoParty = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__ps1Net().party)));
    const byItself = aa && ab && autoParty.every((q) => q && q.autoStart === true && q.autoStarted === true);
    ok('the-room-started-both-cores-by-itself', byItself,
       `host armed=${aa} guest armed=${ab} with NO Start click · autoStarted=${autoParty.map((q) => q && q.autoStarted).join('/')} `
       + `gameIdx=${autoParty.map((q) => q && q.gameIdx).join('/')} labels=${JSON.stringify(autoParty.map((q) => q && q.label))} `
       + `status=${JSON.stringify(autoParty.map((q) => q && q.barrier))}`);
    if (!(aa && ab)) {
      // FALLBACK, only so the cells below still measure lockstep on a page whose
      // auto-start is broken. The cell above has already FAILED; this cannot
      // un-fail it.
      console.log('  ....  fallback  clicking Start on the peer(s) that did not start by themselves — the cell above stays FAILED');
      await Promise.all([
        aa ? null : A.page.evaluate(() => document.getElementById('btnStart').click()),
        ab ? null : B.page.evaluate(() => document.getElementById('btnStart').click()),
      ]);
      [aa, ab] = await Promise.all([armed(A, 120000), armed(B, 120000)]);
    }
    ok('both-cores-armed-the-frame-gate', aa && ab, `host armed=${aa} guest armed=${ab}`);

    // ---- 4. LET THEM PLAY (the disc has to stream in first) --------------
    const running = async (p) => p.page.waitForFunction(
      () => window.__ps1Net().frames > 30, { timeout: 240000, polling: POLL_MS }).then(() => true).catch(() => false);
    const [ra, rb] = await Promise.all([running(A), running(B)]);
    ok('both-cores-advance', ra && rb, `host running=${ra} guest running=${rb}`);

    // ---- 4b. THE PARTY BUTTON AND THE PANEL SAY SO ------------------------
    // One control, live text; seats in the panel's exact vocabulary; a seat is
    // "host" or "player" and never a peer id; and the status line names the
    // frame everyone started on. Asserted on the seam AND on the rendered
    // roster text, because the nonce defect was in the RENDERED string (this
    // page's HUD printed the whole roster).
    const VOCAB = /^(connecting|loading \d+%|loaded|ready|playing|disconnected|open)$/;
    const partyNow = await Promise.all([A, B].map((p) => p.page.evaluate(() => {
      const n = window.__ps1Net();
      return { party: n.party,
               roster: Array.from(document.querySelectorAll('#netRoster li')).map((li) => li.textContent.trim()),
               hud: (document.getElementById('netHud') || {}).textContent || '' };
    })));
    ok('the-party-button-is-live',
       partyNow.every((q) => /^Party · [A-HJ-NP-Z2-9]{5} · 2\/2 · (starting|playing)$/.test(q.party.label)),
       `#btnNet reads ${JSON.stringify(partyNow.map((q) => q.party.label))}`);
    ok('seats-use-the-vocabulary-and-never-a-nonce',
       partyNow.every((q) => q.party.rows.length === 2
         && q.party.rows.every((r) => VOCAB.test(r.state) && (r.port === 0 ? r.who === 'host' : r.who === 'player'))
         && q.roster.length === 2 && !q.roster.some((t) => /\b[0-9a-f]{16}\b/.test(t)) && !/\b[0-9a-f]{16}\b/.test(q.hud)),
       `rows=${JSON.stringify(partyNow.map((q) => q.party.rows))} rendered=${JSON.stringify(partyNow.map((q) => q.roster))}`);
    ok('the-status-line-says-everyone-started-together',
       partyNow.every((q) => /^Playing — everyone started together at frame \d+\.$/.test(q.party.barrier)),
       `#netBarrier reads ${JSON.stringify(partyNow.map((q) => q.party.barrier))}`);

    // THE ORDERING ASSERTION THAT MATTERS MOST. The worker's pcsx_mainloop pump
    // is itself gated, so the core can only ever have run frames the page fed
    // it. A core that free-ran even one frame is a frame ahead FOREVER.
    const atRun = await Promise.all([
      A.page.evaluate(() => { const n = window.__ps1Net(); return { fed: n.frames, ran: n.workerFrames }; }),
      B.page.evaluate(() => { const n = window.__ps1Net(); return { fed: n.frames, ran: n.workerFrames }; }),
    ]);
    ok('no-ungated-frame-was-run', atRun.every((x) => x.ran <= x.fed && x.fed - x.ran <= 4),
       `every frame the core ran was a frame the page fed: host ran ${atRun[0].ran}/fed ${atRun[0].fed}, `
       + `guest ran ${atRun[1].ran}/fed ${atRun[1].fed} (in-flight lookahead accounts for the difference)`);

    // ---- 5. A KEY ON ONE MACHINE REACHES THE OTHER'S CORE -----------------
    // Held well over the input delay, and asserted on the byte image the REMOTE
    // core was handed, at the LOCAL peer's port index.
    await A.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await sleep(1500);
    const [bImage, aImage] = await Promise.all([
      B.page.evaluate(() => window.__ps1Net().image),
      A.page.evaluate(() => window.__ps1Net().image),
    ]);
    // ACTIVE-LOW: a press CLEARS the bit, so "pressed" is bit == 0.
    ok('remote-pad-reaches-the-other-console',
       !!bImage && (maskAt(bImage, pa) & CROSS_BIT) === 0,
       `guest's core was handed 0x${maskAt(bImage, pa).toString(16)} at port ${pa} `
       + `(Cross is ACTIVE-LOW bit 14; host's own image there: 0x${maskAt(aImage, pa).toString(16)})`);
    // ⚠ BOTH IMAGES MUST EXIST FIRST. Without the null check this passes on
    // `null === null` in a run where neither core gated a single frame — a
    // frozen pair reported as agreeing.
    ok('both-consoles-see-the-same-picture-of-the-pads',
       !!aImage && !!bImage && maskAt(aImage, pa) === maskAt(bImage, pa),
       `host image=${JSON.stringify(aImage)} guest image=${JSON.stringify(bImage)}`);
    await A.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', bubbles: true }));
    });

    // ---- 6. RUN A WHILE, THEN CHECK THEY STAYED TOGETHER ------------------
    await sleep(SECONDS * 1000);
    // ⚠ SAMPLED AS CLOSE TO SIMULTANEOUSLY AS THIS RIG CAN MANAGE. Reading the
    // peers one after the other puts a real gap between samples, and at 60 fps
    // even 30 ms is ~2 frames of apparent drift the cores did not have.
    const [na, nb] = await Promise.all([
      A.page.evaluate(() => window.__ps1Net()),
      B.page.evaluate(() => window.__ps1Net()),
    ]);

    // ⚠ "IN STEP" IS ONLY MEANINGFUL IF THEY MOVED. 0 and 0 are perfectly in
    // step and mean the room is dead.
    const MIN_FRAMES = SECONDS * 20;
    const SLACK = 30;
    ok('both-consoles-kept-running',
       na.frames > MIN_FRAMES && nb.frames > MIN_FRAMES,
       `host ${na.frames} frames, guest ${nb.frames} frames — both required to exceed ${MIN_FRAMES}`);
    ok('frames-stay-in-step', Math.abs(na.frames - nb.frames) <= SLACK,
       `delta ${Math.abs(na.frames - nb.frames)} frames (tolerance ${SLACK}: sampling skew plus the `
       + `engine's input delay; byte-identity is proven by the fingerprints, not by this)`);
    ok('fingerprints-were-exchanged', na.hashes > 0 && nb.hashes > 0,
       `host fed ${na.hashes}, guest fed ${nb.hashes} — the cores are being COMPARED, not just gated`);
    ok('no-desync', na.state !== 'desync' && nb.state !== 'desync',
       `engine state: host ${na.state}, guest ${nb.state}`);
    ok('no-fault', !na.fault && !nb.fault, `host fault=${na.fault} guest fault=${nb.fault}`);

    // ---- 7. THE GUEST RATE IS UNTOUCHED (CLAUDE.md gate #9) ---------------
    // A frame gate may only ever make a console run SLOWER. Anything above
    // 1.000x means the page banked a stall and then sprinted through it, which
    // is the fast-forward the product definition forbids.
    const rate = async (p) => p.page.evaluate(async () => {
      const hz = window.__ps1Net().hz || 59.94;
      const f0 = window.__ps1Frames | 0, t0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      const f1 = window.__ps1Frames | 0, t1 = performance.now();
      return ((f1 - f0) / ((t1 - t0) / 1000)) / hz;
    });
    const [xa, xb] = await Promise.all([rate(A), rate(B)]);
    // ⚠ BOUNDED ON BOTH SIDES. `<= 1.02` alone is satisfied by a WEDGED console
    // reading 0.0000x; the lower bound is what stops a stall being mistaken for
    // compliance.
    ok('guest-rate-is-not-sped-up', xa <= 1.02 && xb <= 1.02,
       `host ${xa.toFixed(4)}x, guest ${xb.toFixed(4)}x of hardware (a gate may only ever slow a console down)`);
    ok('guest-rate-is-actually-running', xa >= 0.5 && xb >= 0.5,
       `host ${xa.toFixed(4)}x, guest ${xb.toFixed(4)}x — below this a "compliant" reading is just a stall`);

    // ---- 8. WHY IS IT NOT 1.000x? ATTRIBUTE IT, DO NOT GUESS -------------
    // A rate below 1.000x has three candidate causes with OPPOSITE fixes, so
    // the page records which one is happening rather than leaving it to be
    // argued: svcAvgMs is the worker's own service time per gated frame. If it
    // approaches the frame budget the CORE is the limiter and no page-side
    // change helps; if it is small while the rate is still low, the page's
    // pacing or its in-flight bound is throttling the guest.
    const [da, db] = await Promise.all([
      A.page.evaluate(() => window.__ps1Net()),
      B.page.evaluate(() => window.__ps1Net()),
    ]);
    console.log(`  INFO  rate-attribution  budget=${da.frameBudgetMs}ms/frame`);
    for (const [tag, d, x] of [['host', da, xa], ['guest', db, xb]]) {
      console.log(`  INFO  ${tag}  rate=${x.toFixed(4)}x  svcAvg=${d.svcAvgMs}ms svcMax=${d.svcMaxMs}ms `
        + `n=${d.svcCount}  capHits=${d.capHits} gateStalls=${d.gateStalls} delay=${d.delay}`);
    }
    const svcBound = (d) => d.svcAvgMs != null && d.svcAvgMs >= d.frameBudgetMs * 0.85;
    console.log('  INFO  verdict  ' + (svcBound(da) || svcBound(db)
      ? 'CORE-BOUND — the worker needs ~a frame budget or more per frame, so the page cannot go faster without speeding the guest up (forbidden)'
      : 'NOT core-bound — service time is well under the frame budget, so the shortfall is page-side pacing or the in-flight bound'));

    const errs = [...A.errs, ...B.errs].filter((e) => !/favicon|404/i.test(e));
    ok('no-page-errors', errs.length === 0, errs.slice(0, 4).join(' | ') || 'none');
  } catch (e) {
    fail++;
    console.log('  FAIL  threw  ' + ((e && e.stack) || e));
  } finally {
    if (!has('keep')) await browser.close();
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'}  ${pass} passed, ${fail} failed`);
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();

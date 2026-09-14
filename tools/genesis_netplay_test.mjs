#!/usr/bin/env node
// DOES genesis.html ACTUALLY PLAY TWO-PLAYER LOCKSTEP, END TO END?
//
// WHAT THIS ASSERTS THAT NOTHING ELSE DOES.
//   * tools/genesis_determinism_probe.mjs proves the CORE is deterministic, by
//     driving it itself and bypassing the page entirely.
//   * tools/no_streaming_test.mjs proves the page's SOURCE carries no streaming
//     machinery and mentions the frame gate.
//   Neither proves the PAGE drives that gate correctly. This does: two real
//   pages, a real room, both cores running, and the assertions are on the bytes
//   the cores were handed and the fingerprints they agreed on — never on a UI
//   flag or a session status, because "connected" was exactly the signal that
//   let a whole page claim online play while every core free-ran.
//
// THE CONFIGURATION
//   Two tabs, `?net=local`, which is lib/netplay.js's same-browser signalling —
//   so this needs no broker and no network. That is a REAL limitation and it is
//   stated rather than hidden: it exercises the room, the seating, the frame
//   gate and the fingerprint comparison, but not NAT traversal. Cross-device
//   pairing is a separate question answered by tools/audit_peerjs_crossdevice.mjs.
//
// WHAT IS CHECKED, IN ORDER
//   1. The room forms and seats TWO ports — the console's real count.
//   2. Each peer holds a DIFFERENT port. (Both on port 0 would look like it
//      worked and would mean one player driving both characters.)
//   3. NOBODY PRESSES START. User, 2026-09-13: "should start when both are
//      able to start, instead of an I'm ready button and dumb conditions to
//      start the damn game." Both cores arm the gate BY THEMSELVES once two are
//      seated (the page presses its own Start); a click here is a FALLBACK
//      that fails the cell. And a host ALONE never starts — checked before the
//      joiner arrives, since the engine refuses a party of one.
//   3b. NEITHER core ran a frame before the gate was armed: `armedAtFrame` is
//      latched at arming and must read 0, and every frame run must be a gated
//      one. (The old cell read the frame counter at a moment the product now
//      legitimately races past; the latched value cannot race.)
//   4. Both cores advance, and advance TOGETHER (frame counts within one).
//   4b. The ONE control reads "Party · CODE · 2/2 · playing", every seat is in
//      the panel's exact vocabulary, no 16-hex nonce reaches the screen, and
//      the status line says everyone started together.
//   5. A key held on peer A appears in peer B's core input image AT PORT A's
//      INDEX — the actual proof that a remote pad reaches the other console.
//   6. Fingerprints were exchanged and the engine reported NO desync.
//   7. Guest rate stays at 1.000x on both — a frame gate may only ever slow a
//      console down, never speed it up (CLAUDE.md gate #9).
//
// USAGE
//   npm run web                                       # port 8080
//   node tools/browser_leak_guard.js reap && uptime
//   bash tools/probe_lock.sh run -- node tools/genesis_netplay_test.mjs
//
// FLAGS  --headful  --keep  --seconds N (default 8)  --url BASE
import { createRequire } from 'module';
import { execSync } from 'child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const BASE = flag('url', 'http://localhost:8080');
const SECONDS = parseInt(flag('seconds', '8'), 10);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ⚠ EVERY waitForFunction IN THIS FILE MUST POLL ON A TIMER, NOT ON rAF.
// Puppeteer's default `polling: 'raf'` runs the predicate inside
// requestAnimationFrame — and only ONE of these two tabs is the foreground tab,
// so the other one's rAF is throttled to a stop. Every wait against the
// background page then times out no matter what the page is doing.
// This cost a full debugging cycle: the test reported that the host was never
// asked to admit the joiner, that no room formed and that both cores were
// wedged at 0.0000x, while a scratch script driving the identical flow with
// page.evaluate() showed the prompt present and the pairing healthy. The PAGE
// was correct throughout; the harness was blind.
const POLL_MS = 250;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}  ${detail == null ? '' : detail}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail == null ? '' : detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// ⚠ EACH PEER GETS ITS OWN WINDOW, NOT ITS OWN TAB, AND THIS IS LOAD-BEARING.
// Chrome gives a HIDDEN tab no requestAnimationFrame at all, and this page
// drives its emulator from rAF. With two tabs in one window the background peer
// runs literally zero frames: measured here, `document.visibilityState` was
// "hidden" with __genFrames = 0 after six seconds while the foreground tab had
// run 344. The room formed, both cores armed, and then the visible peer stalled
// forever waiting for input from a console that was frozen by the HARNESS — a
// failure that reads exactly like a broken frame gate. Two separate windows both
// report "visible" and both run (224 frames each in the same check), and they
// stay in ONE browser so lib/netplay.js's `local` BroadcastChannel signalling
// still pairs them without a broker.
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

async function openPeer(browser, tag, role) {
  const page = await openWindowPage(browser);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`${BASE}/genesis.html?net=local`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!(window.Module && typeof window.Module._gpx_run === 'function'
    && window.__genNet && window.__genNet().supported), { timeout: 120000, polling: POLL_MS });
  return { page, errs, tag, role };
}

(async () => {
  console.log('=== genesis two-peer lockstep test ===');
  try { console.log('load: ' + execSync('uptime', { encoding: 'utf8' }).trim()); } catch (e) {}

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: has('headful') ? false : 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio',
           '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           // Without this a window stacked behind another can still be judged
           // occluded and lose its rAF — the same failure as a hidden tab.
           '--disable-features=CalculateNativeWinOcclusion'],
  });

  try {
    // ⚠ SAME BROWSER, DELIBERATELY. `local` signalling is a BroadcastChannel on
    // one origin in one browser; two processes cannot see each other on it.
    const A = await openPeer(browser, 'A', 'host');
    const B = await openPeer(browser, 'B', 'guest');

    // ---- 1. FORM THE ROOM BEFORE ANYTHING BOOTS --------------------------
    // This ordering is the product requirement, not a convenience: seats are
    // handed out before a cartridge is loaded so nobody downloads a game to
    // find out they had no port.
    // ⚠ PROVE BOTH PEERS CAN ACTUALLY RENDER BEFORE MEASURING ANYTHING. If one
    // is hidden it will run no frames, and every later assertion becomes a
    // statement about the harness rather than about the page.
    const vis = await Promise.all([
      A.page.evaluate(() => document.visibilityState),
      B.page.evaluate(() => document.visibilityState),
    ]);
    ok('both-peers-can-render', vis[0] === 'visible' && vis[1] === 'visible',
       `visibilityState host=${vis[0]} guest=${vis[1]} — a hidden page gets no rAF and would run zero frames`);
    ok('peers-loaded', true, 'two genesis.html windows, core initialised, no game loaded yet');

    // THE ONE CONTROL. With no room it reads exactly "Party"; inside one it is
    // the live status readout (checked again once the room is playing).
    const label0 = await A.page.evaluate(() => document.getElementById('btnNet').textContent.trim());
    ok('the-party-button-reads-Party-with-no-room', label0 === 'Party', `#btnNet reads "${label0}"`);

    // Drive the REAL controls, not an internal API: the host opens the panel and
    // opens a room, the page mints its own code, and the guest types that code
    // in. A test that called the session constructor directly would pass on a
    // page whose buttons were wired to nothing.
    const hostCode = await A.page.evaluate(() => {
      document.getElementById('btnNet').click();
      document.getElementById('netHostBtn').click();
      return document.getElementById('netCode').textContent.trim();
    });

    // ---- A HOST ALONE NEVER STARTS ----------------------------------------
    // The page auto-declares and auto-loads, so the guard against a party of
    // one has to hold with NOBODY else in the room: three seconds alone, and
    // the core must be neither loading, armed nor live, and the status line
    // must say it is waiting for another player.
    await sleep(3000);
    const alone = await A.page.evaluate(() => {
      const n = window.__genNet();
      return { armed: n.armed, live: n.live, party: n.party,
               barrier: (document.getElementById('netBarrier') || {}).textContent || '' };
    });
    ok('a-host-alone-never-starts',
       !alone.armed && !alone.live && alone.party.autoStarted === false && alone.party.seated <= 1
         && alone.party.alone === true && /^Waiting for another player — share the code [A-HJ-NP-Z2-9]{5}\./.test(alone.barrier.trim()),
       `after 3 s alone: armed=${alone.armed} live=${alone.live} seated=${alone.party.seated} alone=${alone.party.alone} `
       + `autoStarted=${alone.party.autoStarted} label="${alone.party.label}" status="${alone.barrier.trim()}"`);

    await B.page.evaluate((code) => {
      document.getElementById('btnNet').click();
      document.getElementById('netJoinBtn').click();
      document.getElementById('netCodeIn').value = code;
      document.getElementById('netGo').click();
    }, hostCode);

    // ---- THE HOST ADMITS THE JOINER --------------------------------------
    // ⚠ A HUMAN HAS TO SAY YES, and that is the design, not an obstacle. Knowing
    // the room code is not enough: lib/netplay.js refuses to open a peer
    // connection until the host approves, so an unapproved caller never learns
    // the host's LAN addresses and never reads as a player. The page gets
    // netplay.js's built-in prompt (#npApproveAllow), so this clicks the same
    // button a host would.
    // The FIRST version of this test skipped this step and read like a page bug:
    // the roster came back empty and the host's engine started with nobody
    // seated, because no game channel had ever opened.
    const allowed = await A.page.waitForFunction(
      () => !!document.getElementById('npApproveAllow'), { timeout: 30000, polling: POLL_MS })
      .then(() => A.page.evaluate(() => { document.getElementById('npApproveAllow').click(); return true; }))
      .catch(() => false);
    ok('host-is-asked-to-admit-the-joiner', allowed,
       'knowing the code is not enough — a human approves, and this clicked the real Allow button');

    // Wait for both sides to be seated.
    const seated = async (p) => p.page.waitForFunction(
      () => { const n = window.__genNet(); return n.session && n.roster && n.roster.some((x) => x != null); },
      { timeout: 30000, polling: POLL_MS }).then(() => true).catch(() => false);
    const [sa, sb] = await Promise.all([seated(A), seated(B)]);
    ok('room-forms', sa && sb, `host seated=${sa} guest seated=${sb} code=${hostCode}`);

    const na0 = await A.page.evaluate(() => window.__genNet());
    const nb0 = await B.page.evaluate(() => window.__genNet());
    ok('ports-are-the-consoles-own', na0.ports === 2 && nb0.ports === 2,
       `portCount=${na0.ports}/${nb0.ports} — a Mega Drive has two controller ports`);

    const pa = (na0.localPorts || [])[0], pb = (nb0.localPorts || [])[0];
    ok('each-peer-holds-a-different-port', pa != null && pb != null && pa !== pb,
       `host=port ${pa}, guest=port ${pb}`);

    // ---- 2+3. NOBODY PRESSES START ------------------------------------------
    // ⚠ THE CELL THIS FILE NOW EXISTS FOR. The old flow clicked #btnStart on
    // both peers right here; a page that still needs that click passes nothing
    // below. `armed` is set inside bootRom() between the core's load call and
    // `running = true`, so an armed core is one the PAGE loaded by itself, and
    // `party.autoStarted` is the page's own record of having pressed it.
    // The old 'no-core-ran-before-the-room-formed' cell read the frame counter
    // here and required 0 — with the room loading and releasing both cores by
    // itself the instant the second seat fills, that read races the product
    // WORKING. The property it stood for is `armedAtFrame === 0` (latched at
    // arming, cannot race) plus 'no-ungated-frame-was-run' below.
    const armed = async (p, ms) => p.page.waitForFunction(
      () => window.__genNet().armed, { timeout: ms, polling: POLL_MS }).then(() => true).catch(() => false);
    let [aa, ab] = await Promise.all([armed(A, 60000), armed(B, 60000)]);
    const autoParty = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__genNet().party)));
    const byItself = aa && ab && autoParty.every((q) => q && q.autoStart === true && q.autoStarted === true);
    ok('the-room-started-both-cores-by-itself', byItself,
       `host armed=${aa} guest armed=${ab} with NO Start click · autoStarted=${autoParty.map((q) => q && q.autoStarted).join('/')} `
       + `declared=${autoParty.map((q) => q && q.declared).join('/')} labels=${JSON.stringify(autoParty.map((q) => q && q.label))} `
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
      [aa, ab] = await Promise.all([armed(A, 60000), armed(B, 60000)]);
    }
    ok('both-cores-armed-the-frame-gate', aa && ab, `host armed=${aa} guest armed=${ab}`);
    const armedAt = await Promise.all([A, B].map((p) => p.page.evaluate(() => window.__genNet().armedAtFrame)));
    ok('the-gate-closed-at-frame-0', armedAt.every((f) => f === 0),
       `armedAtFrame host=${armedAt[0]} guest=${armedAt[1]} — latched at arming, so it cannot race the barrier release`);

    // THE ORDERING ASSERTION THAT MATTERS MOST. `armed` is set inside bootRom()
    // between gpx_load() and `running = true`, with no await in between, so if
    // the gate is armed the core cannot yet have run a frame of its own.
    const atArm = await Promise.all([
      A.page.evaluate(() => ({ frames: window.__genFrames | 0, ls: window.__genNet().frames })),
      B.page.evaluate(() => ({ frames: window.__genFrames | 0, ls: window.__genNet().frames })),
    ]);
    ok('no-ungated-frame-was-run', atArm.every((x) => x.frames === x.ls),
       `every frame run was a GATED frame: host ${atArm[0].ls}/${atArm[0].frames}, `
       + `guest ${atArm[1].ls}/${atArm[1].frames}`);

    // ---- 4. LET THEM PLAY -------------------------------------------------
    const running = async (p) => p.page.waitForFunction(
      () => window.__genNet().frames > 30, { timeout: 60000, polling: POLL_MS }).then(() => true).catch(() => false);
    const [ra, rb] = await Promise.all([running(A), running(B)]);
    ok('both-cores-advance', ra && rb, `host running=${ra} guest running=${rb}`);

    // ---- 4b. THE PARTY BUTTON AND THE PANEL SAY SO ------------------------
    // One control, live text; seats in the panel's exact vocabulary; a seat is
    // "host" or "player" and never a peer id; and the status line names the
    // frame everyone started on. Asserted on the seam AND on the rendered
    // roster text, because the nonce defect was in the RENDERED string.
    const VOCAB = /^(connecting|loading \d+%|loaded|ready|playing|disconnected|open)$/;
    const partyNow = await Promise.all([A, B].map((p) => p.page.evaluate(() => {
      const n = window.__genNet();
      return { party: n.party,
               roster: Array.from(document.querySelectorAll('#netRoster li')).map((li) => li.textContent.trim()) };
    })));
    ok('the-party-button-is-live',
       partyNow.every((q) => /^Party · [A-HJ-NP-Z2-9]{5} · 2\/2 · (starting|playing)$/.test(q.party.label)),
       `#btnNet reads ${JSON.stringify(partyNow.map((q) => q.party.label))}`);
    ok('seats-use-the-vocabulary-and-never-a-nonce',
       partyNow.every((q) => q.party.rows.length === 2
         && q.party.rows.every((r) => VOCAB.test(r.state) && (r.port === 0 ? r.who === 'host' : r.who === 'player'))
         && q.roster.length === 2 && !q.roster.some((t) => /\b[0-9a-f]{16}\b/.test(t))),
       `rows=${JSON.stringify(partyNow.map((q) => q.party.rows))} rendered=${JSON.stringify(partyNow.map((q) => q.roster))}`);
    ok('the-status-line-says-everyone-started-together',
       partyNow.every((q) => /^Playing — everyone started together at frame \d+\.$/.test(q.party.barrier)),
       `#netBarrier reads ${JSON.stringify(partyNow.map((q) => q.party.barrier))}`);

    // ---- 5. A KEY ON ONE MACHINE REACHES THE OTHER'S CORE -----------------
    // Held for well over the input delay so it cannot be missed, and asserted on
    // the byte image the REMOTE core was handed, at the LOCAL peer's port index.
    await A.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    await sleep(1200);
    const bImage = await B.page.evaluate(() => window.__genNet().image);
    const aImage = await A.page.evaluate(() => window.__genNet().image);
    // BIT.a = 1 (genesis.html BIT table); pad bytes are little-endian 16-bit.
    const maskAt = (img, port) => img ? ((img[port * 2] | (img[port * 2 + 1] << 8)) & 0xffff) : 0;
    const A_BIT = 1 << 1;
    ok('remote-pad-reaches-the-other-console',
       (maskAt(bImage, pa) & A_BIT) !== 0,
       `guest's core was handed 0x${maskAt(bImage, pa).toString(16)} at port ${pa} `
       + `(host's own image there: 0x${maskAt(aImage, pa).toString(16)})`);
    // ⚠ BOTH IMAGES MUST EXIST FIRST. Without the null check this assertion
    // passed on `null === null` in a run where neither core had gated a single
    // frame — a frozen pair reported as agreeing.
    ok('both-consoles-see-the-same-picture-of-the-pads',
       !!aImage && !!bImage && maskAt(aImage, pa) === maskAt(bImage, pa),
       `host image=${JSON.stringify(aImage)} guest image=${JSON.stringify(bImage)}`);
    await A.page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    });

    // ---- 6. RUN A WHILE, THEN CHECK THEY STAYED TOGETHER ------------------
    await sleep(SECONDS * 1000);
    // ⚠ SAMPLED AS CLOSE TO SIMULTANEOUSLY AS THIS RIG CAN MANAGE. Reading the
    // two peers one after the other puts a real gap between the samples, and at
    // 60 frames a second even 30 ms of gap is ~2 frames of apparent drift that
    // the cores did not actually have.
    const [na, nb] = await Promise.all([
      A.page.evaluate(() => window.__genNet()),
      B.page.evaluate(() => window.__genNet()),
    ]);

    // ⚠ "IN STEP" IS ONLY MEANINGFUL IF THEY MOVED. 0 and 0 are perfectly in
    // step and mean the room is dead; an earlier run of this test reported
    // exactly that as a PASS. Require real progress as well as agreement.
    //
    // ⚠ AND THE TOLERANCE IS SAMPLING SLACK, NOT ALLOWED DRIFT. Even sampled in
    // parallel these two counters are read at slightly different instants, and
    // one peer may legitimately be up to `delay` frames ahead of the other by
    // construction — the engine schedules an input for frame F+delay, so a
    // machine can run ahead until it runs out of covered frames. The real
    // "did they stay identical" proof is the FINGERPRINT comparison below
    // (no-desync), which is exact; this check exists to catch a console that
    // silently stopped, so its bound is deliberately loose.
    const MIN_FRAMES = SECONDS * 30;        // half of NTSC rate, generous for a loaded box
    // 30 frames = half a second: comfortably more than the engine's input delay
    // (a few frames) plus any sampling skew, and far less than the gap a stopped
    // console would open in the SECONDS-long window above.
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
      const hz = window.Module._gpx_fps() || 59.922751;
      const f0 = window.__genFrames | 0, t0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      const f1 = window.__genFrames | 0, t1 = performance.now();
      return ((f1 - f0) / ((t1 - t0) / 1000)) / hz;
    });
    const [xa, xb] = await Promise.all([rate(A), rate(B)]);
    // ⚠ BOUNDED ON BOTH SIDES. `<= 1.02` alone is satisfied by a WEDGED console
    // reading 0.0000x, and an earlier run of this test duly reported two frozen
    // cores as passing the guest-rate gate. The upper bound is the product
    // requirement (a frame gate may only ever slow a console down); the lower
    // bound is what stops a stall being mistaken for compliance.
    const rateOk = (x) => x >= 0.9 && x <= 1.02;
    ok('guest-rate-host-1.000x', rateOk(xa),
       `${xa.toFixed(4)}x hardware (must be 1.000x: never above, and not wedged below)`);
    ok('guest-rate-guest-1.000x', rateOk(xb),
       `${xb.toFixed(4)}x hardware (must be 1.000x: never above, and not wedged below)`);

    const errs = [...A.errs, ...B.errs].filter((e) => !/favicon/i.test(e));
    ok('no-page-errors', errs.length === 0, errs.slice(0, 4).join(' | ') || 'none');

    if (!has('keep')) { await A.page.close(); await B.page.close(); }
  } catch (e) {
    fail++;
    console.log('  FAIL  harness  ' + ((e && e.stack) || e));
  } finally {
    if (!has('keep')) { try { await browser.close(); } catch (e) {} }
  }

  console.log(`\n[genesis-netplay] ${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
})();

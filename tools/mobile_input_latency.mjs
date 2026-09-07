#!/usr/bin/env node
// MOBILE TOUCH INPUT LATENCY — end-to-end, measured where THE CORE reads the button.
//
// The owner's report was "the input mobile seems slow". This rig turns that into
// two numbers per page, both taken with ONE clock inside the page:
//
//   latency  = (time the CORE first sees the button down)
//              - (event.timeStamp of the touchstart that pressed it)
//   drop     = fraction of taps of a given DURATION that the core NEVER sees at all
//
// WHY THE CORE-SIDE SAMPLE POINT AND NOT THE HANDLER. Every one of these pages
// sets a flag on a JS object in its touchstart handler — that part is instant on
// all six and proves nothing. What the guest actually experiences is the moment
// that flag is COPIED to the core, and each page does that on its own periodic
// sampler:
//   ps1        pollController -> pcsx_worker.postMessage({cmd:'padStatus'})   ps1.html:490-497
//   gamecube   pollController -> dolphin_worker.postMessage({cmd:'input'})    gamecube.html:5637-5646
//   dreamcast  frameLoop      -> worker.postMessage({cmd:'input'})            dreamcast.html:4042-4048
//   snes       runFrame       -> Module._setJoypadInput(padMask())            snes.html:322-323
//   gba        _runFrame      -> Module._emuRunFrame(this._getKeyMask())      gba/gbaWasm/dist/script.js:296
//   n64        core pull      -> myApp.sendMobileControls(...)                n64/index.html:2053-2062
// The hooks below wrap exactly those call sites, so a sample is recorded at the
// instant the core is handed the state — no polling from Node, no CDP round-trip
// in the measured interval.
//
// WHY DURATION-SWEPT DROP RATE. None of the six LATCHES a press. A press that
// starts and ends between two samples is invisible to the guest, and a dropped
// input feels far worse than a late one. The sweep finds the duration at which
// each page starts losing taps.
//
// USAGE   npm run web                                   # required: :8080
//         node tools/mobile_input_latency.mjs           # ps1 snes gba n64
//         node tools/mobile_input_latency.mjs snes gba
//         node tools/mobile_input_latency.mjs gamecube dreamcast   # heavy boots
//         MIL_JSON=/tmp/mil.json node tools/mobile_input_latency.mjs
// Serialize against other browser harnesses; a number taken above ~load 25 is
// not interpretable (CLAUDE.md gate #10).
import puppeteer from 'puppeteer';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HOLD_REPS = +(process.env.MIL_HOLD_REPS || 12);
const DROP_REPS = +(process.env.MIL_DROP_REPS || 10);
// NOMINAL hold requested of the rig. The ACTUAL hold the page saw is measured
// (touchend.timeStamp - touchstart.timeStamp) and reported, because a Node-side
// sleep plus two CDP round-trips is always longer than the number asked for.
const DROP_MS = (process.env.MIL_DROP_MS || '0,8,16,25,33,50,80').split(',').map(Number);
const VIEW = { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── page table ──────────────────────────────────────────────────────────────
// kind        which sampler hook to install
// probeId     the DOM id of the control the rig presses
// bitDesc     human description of the bit checked in the core-bound payload
const PAGES = {
  ps1: {
    url: '/ps1.html?lazy', kind: 'worker', cmd: 'padStatus', probeId: 'mobileCross',
    // states = HEAPU8[padStatus1 .. +48]; byte 7 is KeyStatus high, ACTIVE LOW,
    // Cross = bit 6 (ps1.html:359-361).
    bit: { byte: 7, mask: 0x40, activeLow: true },
    bitDesc: 'states[7] bit6 clear = Cross',
    // b0 -> states[6]: left = bit7, right = bit5, both ACTIVE LOW (ps1.html updatePadState)
    dpad: 'mobileDpadDisc',
    dir: { left: { byte: 6, mask: 0x80, activeLow: true }, right: { byte: 6, mask: 0x20, activeLow: true } },
  },
  snes: {
    url: '/snes.html', kind: 'snes', probeId: 'mobileA',
    bit: { shift: 7 }, bitDesc: 'setJoypadInput mask bit7 = A (snes.html:221)',
    dpad: 'mobileDpadDisc', dir: { left: { shift: 9 }, right: { shift: 8 } },   // BIT.left/right
  },
  gba: {
    url: '/gba.html', kind: 'gba', probeId: 'mobileA', romIdx: 4,
    bit: { shift: 0 }, bitDesc: 'emuRunFrame mask bit0 = GBA_KEY.A (script.js:21)',
    dpad: 'spDpadH', dir: { left: { shift: 5 }, right: { shift: 4 } },          // GBA_KEY.LEFT=32 RIGHT=16
  },
  n64: {
    url: '/n64/index.html?mobile&game=sm64.z64', kind: 'n64', probeId: 'mobileA',
    bit: { charIdx: 4 }, bitDesc: 'sendMobileControls s[4] = A (n64/index.html:2057)',
    // n64 ships an analog stick, NOT a touch d-pad, so there is no flick to test.
    // Its C directions are four independent buttons and MUST be able to coexist —
    // that is what cPair asserts.
    cPair: ['mobileCLeft', 'mobileCRight'], dir: { left: { charIdx: 12 }, right: { charIdx: 13 } },
  },
  gamecube: {
    url: '/gamecube.html?mobile', kind: 'worker', cmd: 'input', probeId: 'mobileA', romIdx: 3,
    // states = HEAPU8[padStatus1 .. +16]; byte 1 bit 0 = A (gamecube.html:5569).
    bit: { byte: 1, mask: 0x01 }, bitDesc: 'states[1] bit0 = A',
    dpad: 'mobileDpadDisc',
    dir: { left: { byte: 0, mask: 0x40 }, right: { byte: 0, mask: 0x80 } },     // gamecube.html updatePadState b0
  },
  dreamcast: {
    url: '/dreamcast.html?mobile', kind: 'worker', cmd: 'input', probeId: 'mobileA',
    // mobileA -> key 'm' -> RB.B = retro id 0 -> byte 0 bit 0 (dreamcast.html:3855,3867,4165).
    bit: { byte: 0, mask: 0x01 }, bitDesc: 'states[0] bit0 = RETRO_B (DC_A)',
    dpad: 'mobileDpadDisc',
    dir: { left: { byte: 0, mask: 0x40 }, right: { byte: 0, mask: 0x80 } },     // RB.LEFT=6 RB.RIGHT=7
  },
};

// ── the in-page instrument ──────────────────────────────────────────────────
// Installed with evaluateOnNewDocument so the Worker.prototype patch is in place
// before any page script constructs a worker.
function instrument(cfg) {
  const M = { taps: [], samples: [], hooked: null, cfg };
  window.__mil = M;
  // One reader for every payload shape: a byte+mask on a Uint8Array (ps1 /
  // gamecube / dreamcast), a bit shift on an integer mask (snes / gba), or a
  // character in the string n64 hands the core.
  const read = (payload, spec) => {
    if (!spec) return null;
    if (spec.charIdx !== undefined) return String(payload)[spec.charIdx] === '1';
    if (spec.byte !== undefined) { const raw = payload[spec.byte] & spec.mask; return spec.activeLow ? raw === 0 : raw !== 0; }
    return !!((payload >>> spec.shift) & 1);
  };
  const push = (payload) => {
    const d = cfg.dir || {};
    M.samples.push({ at: performance.now(), v: read(payload, cfg.bit),
                     l: read(payload, d.left), r: read(payload, d.right) });
    if (M.samples.length > 6000) M.samples.splice(0, 3000);
  };
  for (const t of ['touchstart', 'touchend']) {
    window.addEventListener(t, (e) => {
      M.taps.push({ type: t, ts: e.timeStamp, at: performance.now(), id: (e.target && e.target.id) || '' });
      if (M.taps.length > 2000) M.taps.splice(0, 1000);
    }, true);
  }
  // LATCH ARM. CDP cannot dispatch a touchstart/touchend pair closer together
  // than ~20 ms, so the drop sweep above cannot reach the interesting region —
  // a press SHORTER than one sampler period. This dispatches the pair in-page
  // with a controlled gap, which is the exact shape a real quick tap takes once
  // Chrome has queued both events behind a long main-thread task and then
  // delivers them back to back. Nothing here fakes the sampler: the core-side
  // hook is the same one every other arm uses.
  M.latch = async (id, gapMs) => {
    const el = document.getElementById(id); if (!el) return { err: 'no ' + id };
    const r = el.getBoundingClientRect();
    const mk = (type) => {
      const t = new Touch({ identifier: 7, target: el, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
      const empty = type === 'touchend';
      return new TouchEvent(type, { bubbles: true, cancelable: true, composed: true,
        touches: empty ? [] : [t], targetTouches: empty ? [] : [t], changedTouches: [t] });
    };
    M.samples.length = 0;
    const t0 = performance.now();
    el.dispatchEvent(mk('touchstart'));
    if (gapMs > 0) await new Promise((res) => setTimeout(res, gapMs));
    const gapReal = performance.now() - t0;
    el.dispatchEvent(mk('touchend'));
    await new Promise((res) => setTimeout(res, 320));
    return { saw: M.samples.some((s) => s.v), gapReal, n: M.samples.length };
  };

  // FLICK. Drag across the d-pad from the LEFT edge to the RIGHT edge faster
  // than the minimum-press floor. The floor defers a release, so without an
  // opposite-direction guard the old direction is still held when the new one
  // goes down and the core is handed Left+Right at once — a state no physical
  // pad can produce. This asserts on what the CORE saw, not on page state.
  M.flick = async (discId, gapMs) => {
    const el = document.getElementById(discId); if (!el) return { err: 'no ' + discId };
    const r = el.getBoundingClientRect();
    const y = r.y + r.height / 2;
    const xL = r.x + r.width * 0.10, xR = r.x + r.width * 0.90;
    const ev = (type, x) => {
      const t = new Touch({ identifier: 9, target: el, clientX: x, clientY: y });
      const empty = type === 'touchend';
      return new TouchEvent(type, { bubbles: true, cancelable: true, composed: true,
        touches: empty ? [] : [t], targetTouches: empty ? [] : [t], changedTouches: [t] });
    };
    M.samples.length = 0;
    el.dispatchEvent(ev('touchstart', xL));
    await new Promise((res) => setTimeout(res, gapMs));
    el.dispatchEvent(ev('touchmove', xR));
    await new Promise((res) => setTimeout(res, 320));
    el.dispatchEvent(ev('touchend', xR));
    await new Promise((res) => setTimeout(res, 120));
    const seen = M.samples.filter((s) => s.l !== null && s.r !== null);
    return { both: seen.filter((s) => s.l && s.r).length, sawL: seen.some((s) => s.l),
             sawR: seen.some((s) => s.r), n: seen.length };  // sawL/sawR prove the d-pad still WORKS
  };

  // C-PAIR. The mirror image: two INDEPENDENT digital buttons that the hardware
  // allows to be held together must still both reach the core. An
  // opposite-suppression rule applied to them would be a capability REMOVED.
  M.cPair = async (idA, idB) => {
    const els = [idA, idB].map((i) => document.getElementById(i));
    if (els.some((e) => !e)) return { err: 'missing control' };
    const mk = (el, type) => {
      const r = el.getBoundingClientRect();
      const t = new Touch({ identifier: el === els[0] ? 11 : 12, target: el,
                            clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
      const empty = type === 'touchend';
      return new TouchEvent(type, { bubbles: true, cancelable: true, composed: true,
        touches: empty ? [] : [t], targetTouches: empty ? [] : [t], changedTouches: [t] });
    };
    M.samples.length = 0;
    els[0].dispatchEvent(mk(els[0], 'touchstart'));
    await new Promise((res) => setTimeout(res, 20));
    els[1].dispatchEvent(mk(els[1], 'touchstart'));
    await new Promise((res) => setTimeout(res, 320));
    els.forEach((e) => e.dispatchEvent(mk(e, 'touchend')));
    await new Promise((res) => setTimeout(res, 120));
    const seen = M.samples.filter((s) => s.l !== null && s.r !== null);
    return { both: seen.filter((s) => s.l && s.r).length, n: seen.length };
  };
  if (cfg.kind === 'worker') {
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, transfer) {
      try {
        if (msg && msg.cmd === cfg.cmd && msg.states) {
          push(msg.states);                   // read BEFORE the buffer is transferred
          M.hooked = 'Worker.postMessage/' + cfg.cmd;
        }
      } catch (_e) {}
      return orig.call(this, msg, transfer);
    };
    M.hooked = 'armed';
  } else {
    // Re-arm on EVERY tick, never once. Emscripten replaces the whole `Module`
    // object during runtime init, which silently discards a one-shot hook — a
    // first attempt recorded 1 sample across 470 emulated frames because of it.
    M.timer = setInterval(() => {
      try {
        if (cfg.kind === 'snes' && window.Module && Module._setJoypadInput && !Module._setJoypadInput.__mil) {
          const o = Module._setJoypadInput;
          const w = function (m) { push(m); return o.call(Module, m); };
          w.__mil = 1; Module._setJoypadInput = w; M.hooked = 'Module._setJoypadInput'; M.rehooks = (M.rehooks || 0) + 1;
        } else if (cfg.kind === 'gba' && window.Module && Module._emuRunFrame && !Module._emuRunFrame.__mil) {
          const o = Module._emuRunFrame;
          const w = function (m) { push(m); return o.call(Module, m); };
          w.__mil = 1; Module._emuRunFrame = w; M.hooked = 'Module._emuRunFrame'; M.rehooks = (M.rehooks || 0) + 1;
        } else if (cfg.kind === 'n64' && window.myApp && myApp.sendMobileControls && !myApp.sendMobileControls.__mil) {
          const o = myApp.sendMobileControls.bind(myApp);
          const w = function (s, x, y) { push(String(s)); return o(s, x, y); };
          w.__mil = 1; myApp.sendMobileControls = w; M.hooked = 'myApp.sendMobileControls'; M.rehooks = (M.rehooks || 0) + 1;
        }
      } catch (_e) {}
    }, 40);
  }
}

// ── driver ──────────────────────────────────────────────────────────────────
async function launch() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, 'mobile_input_latency'); } catch (_e) {}
  return browser;
}
async function ev(page, fn, arg) {
  for (let i = 0; i < 60; i++) {
    try { return await page.evaluate(fn, arg); }
    catch (e) {
      if (!/main frame too early|Execution context|detached|destroyed/i.test(String(e))) throw e;
      await sleep(400);
    }
  }
  throw new Error('evaluate never settled');
}

async function centre(page, id) {
  return ev(page, (i) => {
    const e = document.getElementById(i); if (!e) return null;
    const r = e.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, id);
}

async function boot(page, name, cfg) {
  // cfg, NOT PAGES[name] — this read PAGES[name].url once and silently sent BOTH
  // arms of an A/B to the live page, so an old-vs-new pair came back identical
  // and looked like "the fix does nothing". An arm that cannot be shown to have
  // changed anything is a placebo, not a result.
  const p = cfg;
  await page.goto(ORIGIN + p.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  if (name === 'gba') {
    await page.waitForFunction(() => window.myApp && myApp.isWasmReady, { timeout: 90000 });
    await ev(page, (i) => { document.getElementById('romselect').value = window.ROMLIST[i].url; }, p.romIdx);
    await ev(page, () => myClass.loadRom());
    await page.waitForFunction(() => window.myApp && myApp.isRunning, { timeout: 90000 });
    return;
  }
  // every other page: wait for the splash Start to be usable, then tap it
  if (name === 'ps1') {
    let stable = 0;
    for (let i = 0; i < 60 && stable < 2; i++) {
      await sleep(1000);
      const ok = await ev(page, () => window.crossOriginIsolated === true && document.readyState === 'complete').catch(() => false);
      stable = ok ? stable + 1 : 0;
    }
  }
  await page.waitForFunction(() => {
    const m = document.getElementById('mobileSplashStart');
    return m && !m.disabled && m.getBoundingClientRect().width > 0;
  }, { timeout: 120000 });
  if (p.romIdx !== undefined) {
    await ev(page, (i) => {
      const s = document.getElementById('mobileRomSelect') || document.getElementById('romSelect');
      if (s) { s.value = String(i); s.dispatchEvent(new Event('change', { bubbles: true })); }
    }, p.romIdx);
  }
  const c = await centre(page, 'mobileSplashStart');
  const cdp = await page.target().createCDPSession();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [c] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function run(name) {
  const cfg = { ...PAGES[name] };
  // MIL_URL_<PAGE> points an arm at a different copy of the same page — the ONLY
  // honest way to A/B a page edit here, because both arms then run interleaved at
  // the same machine load instead of one before the edit and one after it.
  const over = process.env['MIL_URL_' + name.toUpperCase()];
  if (over) { cfg.url = over; console.log('  URL OVERRIDE -> ' + over); }
  console.log('\n===== ' + name + ' =====');
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport(VIEW);
  await page.setUserAgent(IPHONE);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  const out = { page: name, hook: null, errs };
  try {
    await page.evaluateOnNewDocument(instrument, cfg);

    // ── CONTROL ARM: the browser's input->JS floor with NOTHING emulating.
    // Without it a big "handler entry" number cannot be told apart from Chrome's
    // own touch dispatch cost, and main-thread contention (hypothesis 6) would be
    // asserted rather than measured. Same page, same viewport, pre-Start.
    await page.goto(ORIGIN + cfg.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(3000);
    {
      const cdp0 = await page.target().createCDPSession();
      const idle = [];
      for (let i = 0; i < 8; i++) {
        await ev(page, () => { window.__mil.taps.length = 0; });
        await cdp0.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 6, y: 6 }] });
        await sleep(60);
        await cdp0.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(140);
        const d = await ev(page, () => {
          const t = window.__mil.taps.find((x) => x.type === 'touchstart');
          return t ? t.at - t.ts : null;
        });
        if (d !== null) idle.push(d);
      }
      await cdp0.detach();
      out.idleHandler = { n: idle.length, p50: pct(idle, 0.5), p90: pct(idle, 0.9), max: idle.length ? Math.max(...idle) : null };
      console.log(`  idle handler entry (pre-Start, nothing emulating): p50=${fmt(out.idleHandler.p50)} p90=${fmt(out.idleHandler.p90)} max=${fmt(out.idleHandler.max)} ms`);
    }

    await boot(page, name, cfg);
    // readiness = the core-bound sampler is actually firing
    await page.waitForFunction(() => window.__mil && window.__mil.samples.length > 60, { timeout: 180000 });
    out.hook = await ev(page, () => window.__mil.hooked);
    console.log('  hook: ' + out.hook + '  (' + cfg.bitDesc + ')');

    // sampler cadence, idle
    await ev(page, () => { window.__mil.samples.length = 0; });
    await sleep(3000);
    const cad = await ev(page, () => {
      const s = window.__mil.samples; const d = [];
      for (let i = 1; i < s.length; i++) d.push(s[i].at - s[i - 1].at);
      d.sort((a, b) => a - b);
      return { n: d.length, p50: d[Math.floor(d.length * 0.5)], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] };
    });
    out.cadence = cad;
    console.log(`  sampler cadence over 3 s: n=${cad.n} p50=${fmt(cad.p50)}ms p95=${fmt(cad.p95)}ms max=${fmt(cad.max)}ms`);

    const c = await centre(page, cfg.probeId);
    if (!c) throw new Error('probe control #' + cfg.probeId + ' has no box');
    const cdp = await page.target().createCDPSession();
    const tap = async (holdMs) => {
      await ev(page, () => { window.__mil.taps.length = 0; window.__mil.samples.length = 0; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [c] });
      await sleep(holdMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(260);
      return ev(page, () => {
        const M = window.__mil;
        const down = M.taps.find((t) => t.type === 'touchstart');
        const up = M.taps.find((t) => t.type === 'touchend');
        if (!down) return { noTap: true };
        const on = M.samples.find((s) => s.v && s.at >= down.ts);
        const off = on && up ? M.samples.find((s) => !s.v && s.at >= up.ts && s.at >= on.at) : null;
        return {
          handler: down.at - down.ts,                  // input->JS handler (main-thread queueing)
          latency: on ? on.at - down.ts : null,        // input->core sees DOWN
          release: off ? off.at - up.ts : null,        // release->core sees UP
          hold: up ? up.ts - down.ts : null,           // ACTUAL hold, by input timestamp
          holdJs: up ? up.at - down.at : null,         // hold as the HANDLERS saw it (compression)
          saw: !!on,
          samples: M.samples.length,
        };
      });
    };

    // 1. HOLD arm — long press, so a drop is impossible and the number is pure latency
    const hold = [];
    for (let i = 0; i < HOLD_REPS; i++) hold.push(await tap(250));
    out.hold = summarise(hold);
    const h = out.hold;
    console.log(`  press  latency  n=${h.n}  p50=${fmt(h.lat.p50)}  p90=${fmt(h.lat.p90)}  max=${fmt(h.lat.max)} ms   (250 ms holds)`);
    console.log(`  release latency n=${h.nRel} p50=${fmt(h.rel.p50)}  p90=${fmt(h.rel.p90)}  max=${fmt(h.rel.max)} ms`);
    console.log(`  handler entry   p50=${fmt(h.hand.p50)}  p90=${fmt(h.hand.p90)}  max=${fmt(h.hand.max)} ms   (touch -> JS listener; main-thread contention)`);

    // 2. DROP arm — sweep the hold duration
    out.drop = [];
    for (const ms of DROP_MS) {
      let seen = 0; const holds = [], holdsJs = [];
      for (let i = 0; i < DROP_REPS; i++) {
        const r = await tap(ms);
        if (r.saw) seen++;
        if (r.hold !== null && r.hold !== undefined) holds.push(r.hold);
        if (r.holdJs !== null && r.holdJs !== undefined) holdsJs.push(r.holdJs);
      }
      const lost = DROP_REPS - seen;
      const actual = pct(holds, 0.5), actualJs = pct(holdsJs, 0.5);
      out.drop.push({ ms, actualHoldP50: actual, handlerHoldP50: actualJs, reps: DROP_REPS, lost });
      console.log(`  drop  ask=${String(ms).padStart(3)} ms  hold p50: input=${fmt(actual)} handlers=${fmt(actualJs)} ms:  ${lost}/${DROP_REPS} never reached the core`);
    }

    // 3. LATCH arm — press shorter than one sampler period, dispatched in-page
    out.latch = [];
    for (const gap of [0, 4, 8, 12, 16, 24]) {
      let lost = 0; const reals = [];
      for (let i = 0; i < 8; i++) {
        const r = await ev(page, ([id, g]) => window.__mil.latch(id, g), [cfg.probeId, gap]);
        if (!r.saw) lost++;
        if (r.gapReal !== undefined) reals.push(r.gapReal);
        await sleep(60);
      }
      out.latch.push({ gap, realP50: pct(reals, 0.5), reps: 8, lost });
      console.log(`  latch gap=${String(gap).padStart(2)} ms (real p50=${fmt(pct(reals, 0.5))}): ${lost}/8 presses DROPPED — core never saw them`);
    }

    // 4. D-PAD arm — the minimum-press floor must never invent an impossible state
    if (cfg.dpad) {
      out.flick = [];
      for (const gap of [0, 8, 16, 40]) {
        let both = 0, sawBoth = 0, n = 0;
        for (let i = 0; i < 5; i++) {
          const r = await ev(page, ([d, g]) => window.__mil.flick(d, g), [cfg.dpad, gap]);
          if (r.err) { console.log('  flick: ' + r.err); break; }
          both += r.both; n += r.n; if (r.both) sawBoth++;
          if (r.sawL) out._sawL = true; if (r.sawR) out._sawR = true;
          await sleep(80);
        }
        out.flick.push({ gap, runs: 5, runsWithBoth: sawBoth, samplesBoth: both, samples: n });
        console.log(`  flick L->R after ${String(gap).padStart(2)} ms: ${sawBoth}/5 runs handed the core LEFT+RIGHT together (${both}/${n} samples)`);
      }
      console.log(`  flick sanity: core saw LEFT=${!!out._sawL} RIGHT=${!!out._sawR} (both must be true, else the arm is vacuous)`);
      {
      }
    }
    if (cfg.cPair) {
      const r = await ev(page, (ids) => window.__mil.cPair(ids[0], ids[1]), cfg.cPair);
      out.cPair = r;
      console.log(`  ${cfg.cPair[0]}+${cfg.cPair[1]} held together: ${r.both}/${r.n} samples had BOTH (must be > 0 — they are independent buttons)`);
    }
    await cdp.detach();
  } catch (e) {
    out.error = String(e).slice(0, 300);
    console.log('  ERROR ' + out.error);
  } finally { await browser.close(); }
  if (errs.length) console.log('  pageerrors: ' + errs.slice(0, 3).join(' | '));
  return out;
}

const fmt = (v) => (v === null || v === undefined || Number.isNaN(v)) ? ' n/a' : v.toFixed(1);
function pct(a, q) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; }
function summarise(rows) {
  const lat = rows.map((r) => r.latency).filter((v) => v !== null && v !== undefined);
  const rel = rows.map((r) => r.release).filter((v) => v !== null && v !== undefined);
  const hand = rows.map((r) => r.handler).filter((v) => v !== null && v !== undefined);
  const q = (a) => ({ p50: pct(a, 0.5), p90: pct(a, 0.9), max: a.length ? Math.max(...a) : null });
  return { n: lat.length, nRel: rel.length, lat: q(lat), rel: q(rel), hand: q(hand), raw: rows };
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = want.length ? want : ['ps1', 'snes', 'gba', 'n64'];
let load = 'unknown';
try { load = execSync('uptime', { encoding: 'utf8' }).trim(); } catch (_e) {}
console.log('[mil] ' + load);
console.log('[mil] latency is measured from event.timeStamp of the touchstart to the moment the CORE is handed the state');
const all = [];
for (const n of list) { if (!PAGES[n]) { console.log('unknown page ' + n); continue; } all.push(await run(n)); }
if (process.env.MIL_JSON) fs.writeFileSync(process.env.MIL_JSON, JSON.stringify({ load, all }, null, 2));
console.log('\n[mil] done — ' + load);

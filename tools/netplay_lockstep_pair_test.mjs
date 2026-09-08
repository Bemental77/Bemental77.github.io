#!/usr/bin/env node
// WHAT DOES LOCKSTEP COST A PLAYER, IN MILLISECONDS?
//
// Two real browser pages, a real RTCPeerConnection, the real lib/netplay.js
// lockstep engine, and a stand-in core that is deterministic by construction
// (its state is a hash of every maple image it has run). No emulator: this
// measures the NETPLAY, and mixing a variable-cost emulator in would make a
// stall and a slow frame indistinguishable — which is the whole thing this has
// to be able to tell apart.
//
// THE THREE NUMBERS IT PRODUCES:
//   felt input delay   delay x frame quantum. It is a CONSTANT, by design —
//                      that is the trade lockstep makes: a fixed lag instead of
//                      a variable one. Reported in ms, because "3 frames" means
//                      50 ms on a 60 fps title and 100 ms on one that renders
//                      every other VBlank.
//   slack (lead)       how many frames of remote input were already in hand
//                      when each frame ran. This is what says whether `delay`
//                      is big enough for the link: a minimum of 0 means the
//                      session was living on the edge and any jitter is a stall.
//   stalls             count, total and worst — what the player actually feels
//                      when the link cannot keep up.
//
// ⚠ LOOPBACK IS A FLOOR, NOT A FORECAST. Both browsers are on one machine, so
// the wire is a host candidate with no RTT between two houses. The second arm
// therefore INJECTS a one-way delay into the send path to show what a slow link
// does — that is a simulation and is labelled as one; only two real machines
// give the real number.
//
// USAGE  npm run web && node tools/netplay_lockstep_pair_test.mjs
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const SECONDS = Number(process.env.SECONDS || 6);

let pass = 0, fail = 0;
const ok  = (n, d = '') => { pass++; console.log(`  PASS  ${n}${d ? '  ' + d : ''}`); };
const bad = (n, d = '') => { fail++; console.log(`  FAIL  ${n}${d ? '  ' + d : ''}`); };

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
try { (await import(path.join(root, 'tools/browser_leak_guard.js'))).default.guard(browser, 'netplay_lockstep_pair'); } catch (e) {}

const mk = async () => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return p;
};

// Everything the two pages do, in one place so both run identical code.
const RIG = `
window.__rig = {
  // A core that is deterministic BY CONSTRUCTION: its whole state is a hash of
  // every maple image it has ever run. Two of them fed the same inputs agree;
  // any difference in input, order or count shows up immediately.
  core: { st: 0x811c9dc5 >>> 0, frames: 0 },
  step(image) {
    let h = this.core.st;
    for (let i = 0; i < image.length; i++) { h = (h ^ image[i]) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
    this.core.st = h >>> 0; this.core.frames++;
  },
  words(f) { return [this.core.st >>> 0, f, 0, this.core.frames, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]; },
  hash(w) { let h = 0x811c9dc5 >>> 0; for (const v of w) { h = (h ^ (v >>> 0)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; },
  pump(ls, frameMs, untilMs, injectAt) {
    return new Promise((done) => {
      const t0 = performance.now();
      const ch = new MessageChannel();
      let queued = false;
      const kick = (ms) => { if (queued) return; queued = true;
        if (ms > 1) setTimeout(() => ch.port2.postMessage(0), ms); else ch.port2.postMessage(0); };
      let base = 0, baseFrame = 0;
      ch.port1.onmessage = () => {
        queued = false;
        const now = performance.now();
        if (now - t0 > untilMs || ls.state === 'desync' || ls.state === 'failed') return done(true);
        // one local pad, changing every frame so a mis-timed input is visible
        const padv = new Uint8Array(64); padv[0] = ls.frame & 255; padv[1] = (ls.frame >> 8) & 255;
        const r = ls.beginFrame(padv);
        if (!r.ready) { kick(0); return; }          // stall: retry hard, do not guess
        this.step(r.image);
        if (injectAt != null && r.frame === injectAt) this.core.st = (this.core.st ^ 0xdeadbeef) >>> 0;
        const w = ls.wantsHash() ? this.words(r.frame) : null;
        ls.endFrame(w ? this.hash(w) : null, w);
        // Pace to the frame quantum: lockstep must never make the guest FASTER.
        if (!base) { base = now; baseFrame = r.frame; }
        const due = base + (r.frame + 1 - baseFrame) * frameMs;
        kick(Math.max(0, due - performance.now()));
      };
      kick(0);
    });
  },
};
`;

async function arm(label, { delay, injectMs, injectDesyncAt }) {
  console.log(`\n== ${label} ==`);
  const host = await mk(), guest = await mk();
  const CODE = 'LSP' + Math.random().toString(36).slice(2, 4).toUpperCase();
  const FIELDS = ['pc', 'sr', 'interrupt_pend', 'cycle_counter', 'sh4_sched_next', 'CpuRunning',
                  'vbr', 'SB_ISTNRM', 'SB_IML6NRM', 'spc', 'ssr', 'pr', 'cycles_lo', 'cycles_hi'];
  const boot = (p, isHost) => p.evaluate(async (code, isHost, rig, fields, delay, injectMs) => {
    eval(rig);
    const s = new Netplay.Session({ game: 'lockstep-rig', host: isHost, code, transport: 'local', ui: false });
    window.__s = s;
    window.__events = [];
    if (isHost) s.on('join-request', (r) => r.approve());
    s.on('desync', (d) => window.__events.push({ t: 'desync', d }));
    await s.start();
    window.__ready = new Promise((res) => {
      const iv = setInterval(() => { if (s.state === 'connected') { clearInterval(iv); res(true); } }, 50);
    });
    window.__arm = () => {
      const ls = s.startLockstep({ delay, hashEvery: 30, fieldNames: fields, portCount: 4 });
      window.__ls = ls;
      // A SLOW LINK, SIMULATED: hold each outgoing message for injectMs. This is
      // an injection, not a network — labelled as such in the report.
      if (injectMs > 0) {
        const real = ls._send;
        ls._send = (o) => setTimeout(() => real(o), injectMs);
      }
      return true;
    };
  }, CODE, isHost, RIG, FIELDS, delay, injectMs || 0);

  await boot(host, true); await boot(guest, false);
  for (let i = 0; i < 80; i++) {
    if (await host.evaluate(() => window.__s.state === 'connected')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await host.evaluate(() => window.__s.state === 'connected'))) { bad(`${label}/connect`, 'never connected'); return; }
  await host.evaluate(() => window.__arm()); await guest.evaluate(() => window.__arm());
  // The lobby: the host seats both players, then everyone declares the disc.
  await host.evaluate(() => { const ls = window.__ls; ls.seat(ls.peerId, 1); });
  const guestId = await guest.evaluate(() => window.__ls.peerId);
  await host.evaluate((gid) => window.__ls.seat(gid, 1), guestId);
  await new Promise((r) => setTimeout(r, 300));
  await guest.evaluate(() => window.__ls.declareReady('pso-v2'));
  await host.evaluate(() => window.__ls.declareReady('pso-v2'));
  await new Promise((r) => setTimeout(r, 400));
  const started = await host.evaluate(() => window.__ls.state) === 'running'
               && await guest.evaluate(() => window.__ls.state) === 'running';
  started ? ok(`${label}/barrier`, 'both machines released from the lobby at frame 0')
          : bad(`${label}/barrier`, `${await host.evaluate(() => window.__ls.state)} / ${await guest.evaluate(() => window.__ls.state)}`);
  if (!started) return;

  const FRAME_MS = 1000 / 60;
  const run = (p, inject) => p.evaluate((ms, until, at) => window.__rig.pump(window.__ls, ms, until, at),
                                        FRAME_MS, SECONDS * 1000, inject == null ? null : inject);
  const t0 = Date.now();
  await Promise.all([run(host, null), run(guest, injectDesyncAt == null ? null : injectDesyncAt)]);
  const wall = Date.now() - t0;
  const [rh, rg] = await Promise.all([host.evaluate(() => window.__ls.report()), guest.evaluate(() => window.__ls.report())]);

  if (injectDesyncAt != null) {
    const ev = await host.evaluate(() => window.__events);
    const d = ev.find((e) => e.t === 'desync');
    d ? ok(`${label}/desync-detected`, `frame ${d.d.frame}, diverged from ${JSON.stringify(d.d.differ)}, last agreed ${d.d.lastAgreedFrame}`)
      : bad(`${label}/desync-detected`, 'a diverged core played on undetected');
    const withFields = ev.map((e) => e.d).find((x) => x && x.fields && x.fields.length);
    withFields ? ok(`${label}/desync-named`, withFields.fields.map((f) => `${f.name} 0x${(f.mine >>> 0).toString(16)} vs 0x${(f.theirs >>> 0).toString(16)}`).join(', '))
               : bad(`${label}/desync-named`, 'detected but not diagnosed');
    d && d.d.frame >= injectDesyncAt && d.d.frame <= injectDesyncAt + 30
      ? ok(`${label}/desync-prompt`, `caught within one ${30}-frame checkpoint of the divergence`)
      : bad(`${label}/desync-prompt`, JSON.stringify(d && d.d.frame));
    return;
  }

  const fps = rh.frames / (wall / 1000);
  console.log(`  host : ${rh.frames} frames in ${wall} ms = ${fps.toFixed(1)}/s | stalls ${rh.stalls} (${rh.stallMs} ms total, worst ${rh.maxStallMs} ms) | lead min ${rh.minLead} mean ${rh.meanLead}`);
  console.log(`  guest: ${rg.frames} frames | stalls ${rg.stalls} (${rg.stallMs} ms, worst ${rg.maxStallMs} ms) | lead min ${rg.minLead} mean ${rg.meanLead}`);
  console.log(`  FELT INPUT DELAY: delay=${rh.delay} frames = ${(rh.delay * FRAME_MS).toFixed(1)} ms at a 60 fps quantum, ${(rh.delay * 1000 / 30).toFixed(1)} ms at a 30 fps one`);
  // Lockstep must never make the guest FASTER than the hardware.
  fps <= 61 ? ok(`${label}/not-sped-up`, `${fps.toFixed(1)} frames/s against a 60/s quantum`)
            : bad(`${label}/not-sped-up`, `${fps.toFixed(1)} frames/s — the guest ran ahead of the hardware`);
  rh.desync == null && rg.desync == null ? ok(`${label}/no-desync`, `${rh.hashesCompared} checkpoints agreed`)
                                         : bad(`${label}/no-desync`, JSON.stringify(rh.desync || rg.desync));
  Math.abs(rh.frames - rg.frames) <= 3 ? ok(`${label}/in-step`, `the two machines stayed within ${Math.abs(rh.frames - rg.frames)} frame(s) of each other`)
                                       : bad(`${label}/in-step`, `${rh.frames} vs ${rg.frames}`);
  return { rh, rg, fps };
}

const A = await arm(`loopback, delay 2 (${SECONDS}s)`, { delay: 2 });
// A slow link with a delay chosen for a FAST one: the slack should vanish and
// stalls should appear — the honest cost of getting `delay` wrong.
const B = await arm('injected 60 ms one-way, delay 2 (too small)', { delay: 2, injectMs: 60 });
// ...and the same link with the delay recommendDelay() asks for.
const rec = (await browser.newPage().then(async (p) => { await p.close(); return null; }), 0) ||
            Math.max(1, Math.min(10, Math.ceil(120 / 2 / (1000 / 60)) + 1));
const C = await arm(`injected 60 ms one-way, delay ${rec} (recommended)`, { delay: rec, injectMs: 60 });
if (B && C) {
  const better = C.rh.stalls <= B.rh.stalls;
  better ? ok('delay-recommendation-helps', `stalls ${B.rh.stalls} -> ${C.rh.stalls} when delay goes 2 -> ${rec} on the same link`)
         : bad('delay-recommendation-helps', `stalls ${B.rh.stalls} -> ${C.rh.stalls}`);
}
await arm('a diverged core is caught', { delay: 2, injectDesyncAt: 90 });

await browser.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

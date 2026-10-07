#!/usr/bin/env node
// ============================================================================
// netplay_firewall_room_test.mjs — DOES A ROOM PAIR AND PLAY WHEN ONE PLAYER
//                                  CAN ONLY REACH TCP 443?
// ============================================================================
//
// Two SEPARATE Chrome processes. The host is on an open network. The joiner's
// browser runs behind a KERNEL firewall (tools/netplay_firewall.mjs): TCP 443
// out and nothing else — every other TCP port refused, every UDP datagram
// dropped. Nothing in either page is shimmed: the production lib/netplay.js
// has to discover for itself that
//   * the broker listed FIRST (wss on 8084) is unreachable and the 443 one is
//     not (both are this rig's broker behind TLS fronts — PORT 443 FIRST in
//     lib/netplay.js), and
//   * WebRTC cannot open (UDP is gone), so the room goes to the relay.
// The broker is impaired to the shape of the public 443 brokers measured from
// this sandbox (tools/netplay_broker_check.mjs): --delay ms one way, --loss.
//
// NO EMULATOR, deliberately, like tools/netplay_lockstep_pair_test.mjs: the
// "core" is deterministic by construction (its state is a hash of every pad
// image it ran), paced to a 60 Hz quantum. So the rate, the stalls and the
// RTT printed here are the NETPLAY over the relay, not a CPU contending with a
// second emulator on a shared 4-core box — that is what the emulator arms of
// tools/netplay_device_matrix.mjs (fw, fw300) measure, against their own
// direct-link control.
//
// PASS = paired; both sides on the relay (and the joiner's broker is the 443
// one); the firewall proof (UDP dropped > 0, a TCP connection refused, 443
// carried the room); both engines ran >= 0.99x and never above 1.02x of the
// 60/s quantum over the measured window; 0 desyncs with fingerprints compared;
// the relay chip is on screen on both; the relay's own publish rate is printed.
//
// USAGE (root; holding the probe lock):
//   npm run web
//   bash tools/probe_lock.sh run -- node tools/netplay_firewall_room_test.mjs [--seconds 60] [--delay 150] [--loss 0.01] [--lockstep-delay 0]
//   (--lockstep-delay 0 = let the session size it from the relay's measured one-way time)
// ============================================================================
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBroker } from './mqtt_ws_broker.mjs';
import { startFirewall, startBrokerFronts, fwProfileDir, counters } from './netplay_firewall.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(os.homedir(), 'probe-deps') + '/');
const puppeteer = require('puppeteer');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const SECONDS = +flag('seconds', 60);
const DELAY_MS = +flag('delay', 150);
const LOSS = +flag('loss', 0.01);
const LS_DELAY = +flag('lockstep-delay', 0);
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MQTT_CACHE = '/tmp/npdm/mqtt-5.3.4.min.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log(`  PASS  ${n}  ${d || ''}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n}  ${d || ''}`); };
const up = () => execSync('uptime').toString().trim();

if (!fs.existsSync(MQTT_CACHE)) {
  fs.mkdirSync(path.dirname(MQTT_CACHE), { recursive: true });
  execSync(`curl -sS -f -o ${MQTT_CACHE} https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js`);
}
const MQTT_SRC = fs.readFileSync(MQTT_CACHE, 'utf8');
console.log(`[fw-room] ${up()}`);
console.log(`[fw-room] netplay.js md5 ${execSync(`md5sum ${REPO}/lib/netplay.js`).toString().slice(0, 8)} · broker ${DELAY_MS} ms one way, ${LOSS * 100}% loss · ${SECONDS}s`);

const broker = await startBroker({ port: 0 });
broker.setImpair({ delayMs: DELAY_MS, loss: LOSS });
const fronts = await startBrokerFronts(broker.port);
const fw = startFirewall({ webPort: +(new URL(BASE).port || 80), chrome: CHROME });
const BROKERS = fronts.urls.p8084 + ',' + fronts.urls.p443;     // the refused one FIRST
const ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--ignore-certificate-errors',
              `--host-resolver-rules=${fronts.resolverRule}`, '--disable-background-timer-throttling',
              '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const browsers = [];
const cleanup = async () => {
  for (const b of browsers) { try { await b.close(); } catch (e) {} }
  try { await fronts.close(); } catch (e) {}
  try { await broker.close(); } catch (e) {}
  fw.close();
};

async function player(role) {
  const behind = role === 'joiner';
  const dir = behind ? fwProfileDir('npfw-room-') : fs.mkdtempSync(path.join(os.tmpdir(), 'npfw-room-'));
  const b = await puppeteer.launch({ headless: 'new', executablePath: behind ? fw.wrapper : CHROME, userDataDir: dir,
                                     args: ARGS, ...(behind ? { pipe: true } : {}), protocolTimeout: SECONDS * 1000 + 120000 });
  try { (await import('./browser_leak_guard.js')).default.guard(b, 'netplay_firewall_room_test'); } catch (e) {}
  browsers.push(b);
  const p = (await b.pages())[0] || await b.newPage();
  p.on('pageerror', (e) => console.log(`  [${role} pageerror] ${String(e.message || e).slice(0, 200)}`));
  p.on('console', (m) => { if (m.type() === 'error') console.log(`  [${role} console] ${m.text().slice(0, 200)}`); });
  await p.evaluateOnNewDocument(MQTT_SRC);
  await p.evaluateOnNewDocument((brokers) => { window.NETPLAY_WS_BROKERS = brokers; }, BROKERS);
  await p.goto(BASE + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: BASE + '/lib/netplay.js?fw=' + Date.now() });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return p;
}

// A core that is deterministic BY CONSTRUCTION (tools/netplay_lockstep_pair_test.mjs).
const RIG = `
window.__rig = {
  core: { st: 0x811c9dc5 >>> 0, frames: 0 },
  step(image) { let h = this.core.st; for (let i = 0; i < image.length; i++) { h = (h ^ image[i]) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } this.core.st = h >>> 0; this.core.frames++; },
  words(f) { return [this.core.st >>> 0, f, 0, this.core.frames, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]; },
  hash(w) { let h = 0x811c9dc5 >>> 0; for (const v of w) { h = (h ^ (v >>> 0)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; },
  win: [],
  pump(ls, frameMs, untilMs) {
    return new Promise((done) => {
      const t0 = performance.now();
      const ch = new MessageChannel();
      let queued = false, lastSec = t0, lastFrames = 0;
      const kick = (ms) => { if (queued) return; queued = true; if (ms > 1) setTimeout(() => ch.port2.postMessage(0), ms); else ch.port2.postMessage(0); };
      let base = 0, baseFrame = 0;
      ch.port1.onmessage = () => {
        queued = false;
        const now = performance.now();
        if (now - lastSec >= 1000) { this.win.push({ t: Math.round(now - t0), frames: this.core.frames - lastFrames, ms: now - lastSec }); lastSec = now; lastFrames = this.core.frames; }
        if (now - t0 > untilMs || ls.state === 'desync' || ls.state === 'failed') return done(true);
        // A PLAYER'S PAD, not a counter: 8 bytes (a PS1/N64-sized image) whose
        // buttons change every 12 frames — five presses a second, faster than
        // a person mashes. A pad that changed EVERY frame would defeat the
        // relay window's run-length coding and measure a wire cost no player
        // can produce (the first draft did: 159 KB/s).
        const padv = new Uint8Array(8); const k = (ls.frame / 12) | 0; padv[0] = (k * 37) & 255; padv[1] = (k * 11) & 15;
        const r = ls.beginFrame(padv);
        if (!r.ready) { kick(2); return; }
        this.step(r.image);
        const w = ls.wantsHash() ? this.words(r.frame) : null;
        ls.endFrame(w ? this.hash(w) : null, w);
        // Paced to the 60/s quantum — never faster than the hardware (gate 9).
        if (!base) { base = now; baseFrame = r.frame; }
        const due = base + (r.frame + 1 - baseFrame) * frameMs;
        // A stall re-bases: frames lost to a stall are lost, not repaid at 2x.
        if (due < now - 2 * frameMs) { base = now; baseFrame = r.frame + 1; kick(frameMs); return; }
        kick(Math.max(0, due - performance.now()));
      };
      kick(0);
    });
  },
};`;

let H, J;
try {
  H = await player('host'); J = await player('joiner');
  const CODE = await H.evaluate(() => Netplay.makeCode(5));
  const boot = (p, isHost) => p.evaluate(async (code, isHost, rig) => {
    eval(rig);
    // 'peerjs' is what every page asks for: the ws + peerjs plan (signalPlan).
    const s = new Netplay.Session({ game: 'fw-rig', host: isHost, code, transport: 'peerjs' });
    window.__s = s; window.__st = []; window.__relayEv = [];
    s.on('status', (e) => window.__st.push(Math.round(performance.now()) + ' ' + e.state + (e.detail ? ': ' + e.detail : '')));
    s.on('relay', (r) => window.__relayEv.push(r));
    if (isHost) s.on('join-request', (r) => r.approve());
    window.__t0 = performance.now();
    s.start();
    return true;
  }, CODE, isHost, RIG);
  await boot(H, true);
  await sleep(1500);
  await boot(J, false);
  const tPair = Date.now();
  let hs, js;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    [hs, js] = await Promise.all([H.evaluate(() => ({ st: window.__s.state, relay: !!(window.__s.relay && window.__s.relay.active) })),
                                  J.evaluate(() => ({ st: window.__s.state, relay: !!(window.__s.relay && window.__s.relay.active) }))]);
    if (hs.st === 'connected' && js.st === 'connected' && hs.relay && js.relay) break;
    if (hs.st === 'failed' || js.st === 'failed') break;
  }
  const pairS = ((Date.now() - tPair) / 1000).toFixed(1);
  const log = async (p) => p.evaluate(() => window.__st.slice(-12));
  if (hs.st === 'connected' && js.st === 'connected' && hs.relay && js.relay) ok('paired-on-the-relay', `both connected over the relay ${pairS}s after the joiner opened`);
  else { bad('paired-on-the-relay', `host ${JSON.stringify(hs)} joiner ${JSON.stringify(js)}\n    host: ${(await log(H)).join(' | ')}\n    joiner: ${(await log(J)).join(' | ')}`); throw new Error('no room'); }
  const sigJ = await J.evaluate(() => String(window.__s._sig && window.__s._sig.url));
  const sigH = await H.evaluate(() => String(window.__s._sig && window.__s._sig.url));
  (/relay443/.test(sigJ) && !/relay8084/.test(sigJ))
    ? ok('joiner-on-the-443-broker-only', `joiner ${sigJ} · host ${sigH}`)
    : bad('joiner-on-the-443-broker-only', `joiner ${sigJ} · host ${sigH}`);

  // ---- the lockstep room ----------------------------------------------------
  // The start delay is the relay's own answer (lib/netplay.js _relayHeard), so
  // let its first ping burst land before the room is armed.
  for (let i = 0; i < 40; i++) {
    const n = await H.evaluate(() => (window.__s._relayOw || []).length);
    if (n >= 5) break;
    await sleep(250);
  }
  const arm = (p, delay) => p.evaluate((delay) => {
    const s = window.__s;
    const d = delay || (s.relay && s.relay.delayFrames) || 8;
    const ls = s.startLockstep({ delay: d, hashEvery: 30, portCount: 2, padBytes: 8 });
    window.__ls = ls;
    return d;
  }, delay);
  const d = await arm(H, LS_DELAY);
  await arm(J, d);
  await H.evaluate(() => { const ls = window.__ls; ls.seat(ls.peerId, 1); });
  const jid = await J.evaluate(() => window.__ls.peerId);
  await H.evaluate((g) => window.__ls.seat(g, 1), jid);
  await sleep(1500);
  await J.evaluate(() => window.__ls.declareReady('fw-rig-v1'));
  await H.evaluate(() => window.__ls.declareReady('fw-rig-v1'));
  for (let i = 0; i < 40; i++) {
    const s = await Promise.all([H.evaluate(() => window.__ls.state), J.evaluate(() => window.__ls.state)]);
    if (s[0] === 'running' && s[1] === 'running') break;
    await sleep(250);
  }
  const st0 = await Promise.all([H.evaluate(() => window.__ls.state), J.evaluate(() => window.__ls.state)]);
  st0.every((x) => x === 'running') ? ok('barrier', `both released at frame 0, delay ${d} frames (sized from the relay's measured one-way time)`)
                                    : bad('barrier', JSON.stringify(st0));
  const FRAME_MS = 1000 / 60;
  const t0 = Date.now();
  await Promise.all([H.evaluate((ms, u) => window.__rig.pump(window.__ls, ms, u), FRAME_MS, SECONDS * 1000),
                     J.evaluate((ms, u) => window.__rig.pump(window.__ls, ms, u), FRAME_MS, SECONDS * 1000)]);
  const wall = (Date.now() - t0) / 1000;
  const read = (p) => p.evaluate(() => ({ rep: window.__ls.report(), win: window.__rig.win, relay: window.__s.relayInfo(),
    chip: (document.getElementById('npRelay') || {}).textContent || null, frames: window.__rig.core.frames }));
  const [rh, rj] = await Promise.all([read(H), read(J)]);
  const fc = counters();
  // ---- verdicts -------------------------------------------------------------
  const rate = (r) => {
    const W = r.win.slice(5);   // the first seconds include the barrier's start
    const fr = W.reduce((a, w) => a + w.frames, 0), ms = W.reduce((a, w) => a + w.ms, 0);
    let max5 = 0; for (let i = 0; i + 5 <= W.length; i++) { const s5 = W.slice(i, i + 5); const x = s5.reduce((a, w) => a + w.frames, 0) / (s5.reduce((a, w) => a + w.ms, 0) / 1000) / 60; if (x > max5) max5 = x; }
    return { x: ms ? +(fr / (ms / 1000) / 60).toFixed(4) : null, max5: +max5.toFixed(4), secs: W.length };
  };
  const xh = rate(rh), xj = rate(rj);
  for (const [n, x] of [['host', xh], ['joiner', xj]]) {
    (x.x >= 0.99) ? ok(`${n}-rate`, `${x.x}x of the 60/s quantum over ${x.secs}s (fastest 5 s ${x.max5}x)`) : bad(`${n}-rate`, `${x.x}x over ${x.secs}s`);
    (x.max5 <= 1.02) ? ok(`${n}-not-sped-up`, `fastest 5 s window ${x.max5}x`) : bad(`${n}-not-sped-up`, `a 5 s window ran at ${x.max5}x`);
  }
  (!rh.rep.desync && !rj.rep.desync && rh.rep.hashesCompared > 0 && rj.rep.hashesCompared > 0)
    ? ok('zero-desyncs', `${rh.rep.hashesCompared}/${rj.rep.hashesCompared} fingerprints compared, all agreed`)
    : bad('zero-desyncs', JSON.stringify({ h: rh.rep.desync, j: rj.rep.desync, hc: rh.rep.hashesCompared, jc: rj.rep.hashesCompared }));
  (fc.udp && fc.udp.pkts > 0 && fc['tcp-other'] && fc['tcp-other'].pkts > 0 && fc.tcp443 && fc.tcp443.pkts > 0)
    ? ok('firewall-arm-proof', `joiner: ${fc.udp.pkts} UDP datagrams dropped, ${fc['tcp-other'].pkts} TCP SYN refused (the 8084 broker), ${fc.tcp443.pkts} packets out on 443; fronts ${JSON.stringify(fronts.stats)}`)
    : bad('firewall-arm-proof', JSON.stringify(fc));
  (rh.chip && rj.chip) ? ok('relay-on-screen', `host "${rh.chip}" · joiner "${rj.chip}"`) : bad('relay-on-screen', `host ${rh.chip} joiner ${rj.chip}`);
  for (const [n, r] of [['host', rh], ['joiner', rj]]) {
    const ri = r.relay || {};
    console.log(`  ....  ${n}: frames ${r.rep.frames} in ${wall.toFixed(1)}s · delay ${r.rep.delay} (${Math.round(r.rep.delay * FRAME_MS)} ms) · stalls ${r.rep.stalls} (${r.rep.stallMs} ms, worst ${r.rep.maxStallMs} ms) · lead min ${r.rep.minLead} mean ${r.rep.meanLead}`);
    console.log(`  ....  ${n}: relay one-way ${ri.oneWayMs != null ? Math.round(ri.oneWayMs) : '-'} ms (RTT ~${ri.oneWayMs != null ? Math.round(ri.oneWayMs * 2) : '-'}) · ${ri.rate ? ri.rate.pubPerSec + ' publishes/s, ' + ri.rate.bytesOutPerSec + ' B/s out, ' + ri.rate.bytesInPerSec + ' B/s in' : '-'} · gapSeq ${ri.stats && ri.stats.gapSeq} relIn ${ri.stats && ri.stats.relIn} relDup ${ri.stats && ri.stats.relDup} · why: ${ri.why}`);
  }
  console.log(`  ....  broker: ${JSON.stringify(broker.stats)} (pubBytes = MQTT payload bytes published by all three connections)`);
} catch (e) {
  if (!/no room/.test(String(e))) bad('rig', String(e && e.stack || e).slice(0, 400));
} finally {
  await cleanup();
}
console.log(`[fw-room] ${up()}`);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

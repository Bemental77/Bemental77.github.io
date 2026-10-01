#!/usr/bin/env node
// ============================================================================
// netplay_lsu_rig.mjs — THE UNRELIABLE INPUT CHANNEL OVER REAL WEBRTC, BETWEEN
// SEPARATE BROWSER PROCESSES, 2 AND 4 PLAYERS, WITH AN OLDER PEER.
// ============================================================================
//
// WHAT IT PROVES, per arm, on the SHIPPED lib/netplay.js Session:
//   * lscap is exchanged and the host opens 'lsu' to every guest, with the
//     options it claims (ordered:false, maxRetransmits:0), read off the live
//     RTCDataChannel objects;
//   * input actually flows on 'lsu' (per-label send counters in each page) and
//     the reliable 'play' channel carries only control / NAK answers;
//   * a forced close of 'lsu' mid-room falls back to the reliable channel with
//     no stall that the room does not recover from, and no desync;
//   * a peer running the DEPLOYED engine (lib/netplay.js a644057b, 408f085 —
//     no lscap) still plays against the new one, in either role;
//   * 0 desyncs (the engine compares fingerprints every 30 frames) and the
//     room's delivered rate.
//
// HOW. Each player is its own `puppeteer.launch` (own profile): no
// BroadcastChannel can cross that, so pairing uses the product's 'ws'
// signalling (?signal=ws) against tools/mqtt_ws_broker.mjs, and game traffic
// is a real RTCPeerConnection on loopback (mDNS host-name obfuscation off so
// the processes can resolve each other). The "console" is
// tools/netplay_lsu_harness.html: synthetic, 60 frames/s under the page
// governor, fingerprinted — so four players fit on this box and the rate is a
// statement about transport and engine, not CPU. mqtt.js is injected from the
// device-matrix cache (Chromium has no route to cdnjs here).
//
// IMPAIRMENT, stated honestly: kernel netem would hit every loopback user on a
// shared box, and CDP network conditions do not reach SCTP. So loss and delay
// are applied at RTCDataChannel.send in each page: on 'lsu' a lost message is
// dropped (what maxRetransmits:0 does); on 'play' a lost message is delivered
// after an extra RTO and holds everything behind it (what SCTP's reliable
// ordered delivery does). Real SCTP loss/retransmission is NOT exercised.
//
// USAGE (npm run web first):
//   bash tools/probe_lock.sh run -- node tools/netplay_lsu_rig.mjs [--arms old-both,p2,p4,old-guest,old-host,lsu-close] [--secs 40] [--loss 1]
//   old-both (two DEPLOYED engines) runs first: it is the baseline a reliable-only room is judged against.
// ============================================================================
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBroker } from './mqtt_ws_broker.mjs';
const require = createRequire(process.env.HOME + '/probe-deps/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const BASE = flag('url', 'http://localhost:8080');
const SECS = +flag('secs', '40');
const ARMS = flag('arms', 'old-both,p2,p4,old-guest,old-host,lsu-close').split(',');
const LAT = +flag('lat', '40'), JIT = +flag('jitter', '15'), LOSS = +flag('loss', '1'), RTO = +flag('rto', '200');
const OLD_REV = flag('old', '408f085');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MQTT_CACHE = '/tmp/npdm/mqtt-5.3.4.min.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let pass = 0, fail = 0;
process.setMaxListeners(64);             // browser_leak_guard adds an exit listener per launch
let baseline = null;                     // the old-both room's rate: what a reliable-only room does under THIS impairment
const ok = (n, d) => { pass++; console.log('  PASS  ' + n + (d ? '  ' + d : '')); };
const bad = (n, d) => { fail++; console.log('  FAIL  ' + n + (d ? '  ' + d : '')); };

if (!fs.existsSync(MQTT_CACHE)) {
  fs.mkdirSync(path.dirname(MQTT_CACHE), { recursive: true });
  execSync(`curl -sS -f -o ${MQTT_CACHE} https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js`);
}
const MQTT_SRC = fs.readFileSync(MQTT_CACHE, 'utf8');
const OLD_NETPLAY = execSync(`git -C ${root} show ${OLD_REV}:lib/netplay.js`, { maxBuffer: 16 << 20 }).toString();

const impairSrc = (lat, jit, loss, rto) => `(() => {
  const send = RTCDataChannel.prototype.send;
  window.__imp = { lsuDropped: 0, lsuSent: 0, playSent: 0, playResent: 0 };
  RTCDataChannel.prototype.send = function (m) {
    const self = this, now = performance.now();
    const lat = Math.max(0, ${lat} + (Math.random() * 2 - 1) * ${jit});
    const lost = Math.random() * 100 < ${loss};
    if (self.label === 'lsu') {
      window.__imp.lsuSent++;
      if (lost) { window.__imp.lsuDropped++; return; }
      setTimeout(() => { try { if (self.readyState === 'open') send.call(self, m); } catch (e) {} }, lat);
      return;
    }
    window.__imp.playSent++; if (lost) window.__imp.playResent++;
    const q = self.__q || (self.__q = []);
    const at = Math.max(q.length ? q[q.length - 1].at : 0, now + lat + (lost ? ${rto} : 0));
    q.push({ at, m });
    const drain = () => { self.__t = 0; const t = performance.now();
      while (q.length && q[0].at <= t) { const x = q.shift(); try { if (self.readyState === 'open') send.call(self, x.m); } catch (e) {} }
      if (q.length) self.__t = setTimeout(drain, Math.max(0, q[0].at - t)); };
    if (!self.__t) self.__t = setTimeout(drain, Math.max(0, q[0].at - now));
  };
})();`;

async function launch(tag, old) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsurig-' + tag + '-'));
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 120000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}
  const page = (await browser.pages())[0] || await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  await page.evaluateOnNewDocument(MQTT_SRC);
  await page.evaluateOnNewDocument(impairSrc(LAT, JIT, LOSS, RTO));
  if (old) {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (/\/lib\/netplay\.js/.test(r.url())) r.respond({ status: 200, contentType: 'application/javascript', body: OLD_NETPLAY });
      else r.continue();
    });
  }
  return { tag, browser, page, dir, errs, old: !!old };
}

async function runArm(arm) {
  const n = arm === 'p4' ? 4 : 2;
  const oldIdx = arm === 'old-guest' ? 1 : arm === 'old-host' ? 0 : -1;
  const isOld = (i) => i === oldIdx || arm === 'old-both';
  const code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  const broker = await startBroker({ port: 0 });
  const P = [];
  const res = { arm, n, code };
  try {
    for (let i = 0; i < n; i++) P.push(await launch(arm + i, isOld(i)));
    for (let i = 0; i < n; i++) {
      const url = `${BASE}/tools/netplay_lsu_harness.html?code=${code}&host=${i === 0 ? 1 : 0}&n=${n}`
                + `&signal=ws&wsbroker=${encodeURIComponent(broker.url)}`;
      await P[i].page.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(i === 0 ? 1500 : 700);
    }
    const snap = (p) => p.page.evaluate(() => window.__H && window.__H.snap()).catch((e) => ({ err: String(e.message) }));
    const t0 = Date.now();
    let S;
    for (;;) {
      S = await Promise.all(P.map(snap));
      if (S.every((x) => x && x.frames > 120)) break;
      if (Date.now() - t0 > 120000) { res.error = 'room did not start: ' + JSON.stringify(S.map((x) => x && { st: x.state, f: x.frames, err: x.err, log: (x.log || []).slice(-4) })); return res; }
      await sleep(1000);
    }
    res.startMs = Date.now() - t0;
    await sleep(3000);                              // past the start-up transient
    const a = await Promise.all(P.map(snap));
    let closedAt = null;
    for (let s = 0; s < SECS; s++) {
      await sleep(1000);
      if (arm === 'lsu-close' && s === Math.floor(SECS / 4)) { res.lsuClosed = await P[0].page.evaluate(() => window.__H.closeLsu()); closedAt = s; }
    }
    const z = await Promise.all(P.map(snap));
    const imp = await Promise.all(P.map((p) => p.page.evaluate(() => window.__imp).catch(() => null)));
    res.players = z.map((x, i) => ({
      role: x.role, old: P[i].old, hasLsu: x.hasLsu,
      rate: +((x.frames - a[i].frames) / ((x.now - a[i].now) / 1000) / 60).toFixed(4),
      stalls: x.stalls - a[i].stalls, stallMs: x.stallMs - a[i].stallMs, reanchors: x.reanchors - a[i].reanchors,
      delay: x.delay, rtt: x.rtt, lostMs: x.lostMs - a[i].lostMs, delayHistory: x.delayHistory, desync: x.desync, err: x.err, hashesCompared: x.hashesCompared, naks: x.naks, naksAnswered: x.naksAnswered,
      links: x.links, chan: x.chan, imp: imp[i], errs: P[i].errs.slice(0, 3),
    }));
    res.closedAt = closedAt;
    res.broker = broker.stats;
  } finally {
    for (const p of P) { try { await p.browser.close(); } catch (e) {} try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch (e) {} }
    await broker.close().catch(() => {});
  }
  return res;
}

console.log(`=== lsu rig · arms ${ARMS.join(',')} · ${SECS} s · impair lat ${LAT}+-${JIT} ms, loss ${LOSS}% (lsu: dropped; play: +${RTO} ms, head-of-line) · old = ${OLD_REV} ===`);
for (const arm of ARMS) {
  const r = await runArm(arm);
  results.push(r);
  if (r.error) { bad(arm + ': room', r.error.slice(0, 600)); continue; }
  const pl = r.players;
  const lsuArm = arm === 'p2' || arm === 'p4' || arm === 'lsu-close';
  console.log(`  ....  ${arm}: ` + pl.map((p) => `${p.role}${p.old ? '(old)' : ''} rate ${p.rate} stalls ${p.stalls}/${p.stallMs}ms reanchors ${p.reanchors}/${p.lostMs}ms delay ${p.delay}${p.rtt ? ' (rtt ' + p.rtt.worstMs + ' -> ' + p.rtt.recommendedDelay + ')' : ''} lsu ${JSON.stringify((p.links || []).map((l) => l.dcu && l.dcu.state))} chan ${JSON.stringify(p.chan)}`).join(' | '));
  (pl.every((p) => !p.desync) && pl.every((p) => p.hashesCompared > 0))
    ? ok(arm + ': 0 desyncs', 'fingerprints compared: ' + pl.map((p) => p.hashesCompared).join('/'))
    : bad(arm + ': desync or no fingerprints', JSON.stringify(pl.map((p) => ({ d: p.desync, h: p.hashesCompared }))));
  const minRate = Math.min(...pl.map((p) => p.rate));
  const ahead = Math.max(...pl.map((p) => p.rate)) > 1.02;
  // THE RATE GATE DEPENDS ON THE CHANNEL. With lsu the room must hold 1.000x
  // under the impairment. Without it (an older peer, or lsu closed) input rides
  // the reliable ordered channel, whose loss recovery is head-of-line blocking
  // — so the honest gate is NO WORSE THAN TWO DEPLOYED ENGINES under the same
  // impairment (old-both, run first), or 0.999x when there is no loss at all.
  if (arm === 'old-both') {
    baseline = minRate;
    ahead ? bad(arm + ': a console ran ahead', pl.map((p) => p.rate).join(' / '))
          : ok(arm + ': baseline recorded (two deployed engines, reliable only)', pl.map((p) => p.rate).join(' / '));
  } else if (lsuArm && arm !== 'lsu-close' || LOSS === 0) {
    (minRate >= 0.999 && !ahead)
      ? ok(arm + ': room >= 0.999x on every console, never ahead', pl.map((p) => p.rate).join(' / '))
      : bad(arm + ': room rate', pl.map((p) => p.rate).join(' / '));
  } else if (baseline == null) {
    bad(arm + ': no old-both baseline in this run to judge a reliable-only room against', pl.map((p) => p.rate).join(' / '));
  } else {
    (minRate >= baseline - 0.02 && !ahead)
      ? ok(arm + ': reliable-only room no worse than two deployed engines', `${pl.map((p) => p.rate).join(' / ')} vs old-both ${baseline}`)
      : bad(arm + ': reliable-only room WORSE than two deployed engines', `${pl.map((p) => p.rate).join(' / ')} vs old-both ${baseline}`);
  }
  if (lsuArm && arm !== 'lsu-close') {
    const host = pl[0];
    const good = (host.links || []).length === r.n - 1 && host.links.every((l) => l.dcu && l.dcu.label === 'lsu' && l.dcu.ordered === false
      && l.dcu.maxRetransmits === 0 && l.dcu.state === 'open');
    good ? ok(arm + ': the host holds an open lsu {ordered:false, maxRetransmits:0} to every guest', JSON.stringify(host.links.map((l) => l.dcu)))
         : bad(arm + ': lsu not open to every guest', JSON.stringify(host.links));
    const flows = pl.every((p) => p.chan.lsu && p.chan.lsu.ls > 100 && (!p.chan.play || p.chan.play.ls < p.chan.lsu.ls / 20));
    flows ? ok(arm + ': input rides lsu on every console (reliable carries only NAK answers)', pl.map((p) => `lsu ${p.chan.lsu && p.chan.lsu.ls} / play ${p.chan.play && p.chan.play.ls}`).join(', '))
          : bad(arm + ': input not on lsu', JSON.stringify(pl.map((p) => p.chan)));
  }
  if (arm === 'lsu-close') {
    const after = pl.every((p) => (p.links || []).every((l) => !l.dcu || l.dcu.state !== 'open'));
    const reliableAfter = pl.every((p) => p.chan.play && p.chan.play.ls > 100);
    (r.lsuClosed > 0 && after && reliableAfter)
      ? ok('lsu-close: closing lsu mid-room falls back to the reliable channel', `closed ${r.lsuClosed} at ${r.closedAt} s; play ls ${pl.map((p) => p.chan.play.ls).join('/')}`)
      : bad('lsu-close: fallback', JSON.stringify({ closed: r.lsuClosed, links: pl.map((p) => p.links), chan: pl.map((p) => p.chan) }));
  }
  if (arm === 'old-guest' || arm === 'old-host' || arm === 'old-both') {
    const none = pl.every((p) => (p.links || []).every((l) => !l.dcu));
    none ? ok(arm + ': no lsu is opened with an older peer, and the room plays', pl.map((p) => (p.old ? 'old ' : 'new ') + p.role + ' ' + p.rate).join(', '))
         : bad(arm + ': an lsu was opened with an older peer', JSON.stringify(pl.map((p) => p.links)));
  }
}
const out = flag('json', ''); if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
console.log(`\n[lsu-rig] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

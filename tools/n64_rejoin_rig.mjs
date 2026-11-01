#!/usr/bin/env node
// ============================================================================
// n64_rejoin_rig.mjs — A REAL TWO-PROCESS N64 ROOM, one Chrome PROCESS per player (so a reopened tab is not a tab-visibility
// artifact), a local MQTT broker for signalling, real WebRTC for the game. At frame --at the joiner (or the host's link) is
// disturbed (--mode close | tab | reload | pcdrop | dcdrop | hpcdrop | hdcdrop | none), and the rig samples both pages every
// --rowms for --secs, then writes <out>/out.json: per-sample frame difference, the room's message, the joiner's checkpoint base,
// the host's stall, and a fingerprint comparison of EVERY frame both consoles ran (the pages' (frame, fingerprint) ring, replays
// included -- never the (frame, lastFp) pair, which can name an unconfirmed frame).
//   node tools/n64_rejoin_rig.mjs --mode close --at 1900 --gap 7000 --secs 40 --name x [--query rb=0] [--joiners 2] [--out DIR]
// tools/n64_rejoin_rig_test.mjs drives it through the scenarios and asserts.
// ⚠ Needs `npm run web` (port 8080). --gap < 7000 with --mode close reopens inside the heartbeat ticket's 6 s window, which
// (correctly) reads as a SECOND live tab of the same player, i.e. a new player: use >= 7000 for a killed browser.
// ============================================================================
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
let puppeteer;
try { puppeteer = createRequire(process.env.HOME + '/probe-deps/')('puppeteer'); } catch (_e) { try { puppeteer = createRequire('C:/Users/Admin/probe-deps/')('puppeteer'); } catch (_e2) { puppeteer = (await import('puppeteer')).default; } }
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startBroker } = await import(pathToFileURL(path.join(REPO, 'tools/mqtt_ws_broker.mjs')).href);
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const MODE = flag('mode', 'close'), NJ = +flag('joiners', 1), EXTRA = flag('query', ''), GAME = flag('game', 'Smash Remix 1.0.1');
const AT = +flag('at', 300), GAP = +flag('gap', 7000), SECS = +flag('secs', 90), NAME = flag('name', 'rj'), DROPMS = +flag('dropms', 4000);
const WRIG = flag('wrig','0')==='1'; const CUW = '';
const ROWMS = +flag('rowms', 1000);
const BASE = flag('url', 'http://localhost:8080'), PRE_SEC = +flag('presecs', 0);
const OUT = path.join(flag('out', path.join(os.tmpdir(), 'n64-rejoin-rig')), NAME);
fs.mkdirSync(OUT, { recursive: true });
const LOG = (...a) => { const s = ((Date.now() - T0) / 1000).toFixed(1) + ' ' + a.join(' '); console.log(s); fs.appendFileSync(path.join(OUT, 'log.txt'), s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || (fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : (fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'));
const T0 = Date.now();
const PRE = `(() => { window.__pcs = []; window.__dcs = []; const _cdc = RTCPeerConnection.prototype.createDataChannel; RTCPeerConnection.prototype.createDataChannel = function (...a) { const d = _cdc.apply(this, a); window.__dcs.push(d); return d; }; const P = window.RTCPeerConnection; window.RTCPeerConnection = function (...a) { const pc = new P(...a); window.__pcs.push(pc); pc.addEventListener('datachannel', (e) => window.__dcs.push(e.channel)); return pc; }; window.RTCPeerConnection.prototype = P.prototype; Object.setPrototypeOf(window.RTCPeerConnection, P); })();`;
const broker = await startBroker({ port: 0 });
const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const code = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join('');
const url = (r) => `${BASE}/n64/index.html?np=${code}&game=${encodeURIComponent(GAME)}${r === 'host' ? '' : '&join=1'}&signal=ws&wsbroker=${encodeURIComponent(broker.url)}${EXTRA ? '&' + EXTRA : ''}${WRIG ? '&workerrig=1' : ''}`;
const procs = {};
async function launch(role, dir) {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, userDataDir: dir, protocolTimeout: 240000,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,800'] });
  try { (await import(pathToFileURL(path.join(REPO, 'tools/browser_leak_guard.js')).href)).default.guard(browser, 'n64_rejoin_rig.mjs'); } catch (e) {}
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(PRE);
  const o = { role, browser, page, dir, errs: [], logs: [] };
  page.on('pageerror', (e) => o.errs.push(String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { const t = m.text(); if (/rejoin|replay|desync|restart|drop|limp|undrop|⚠|stall|reconnect|link|FAULT|checkpoint/i.test(t) && o.logs.length < 400) { const s = ((Date.now() - T0) / 1000).toFixed(1) + ' [' + role + '] ' + t.slice(0, 220); o.logs.push(s); fs.appendFileSync(path.join(OUT, 'console.txt'), s + '\n'); } });
  procs[role] = o; return o;
}
const tmo = (p, ms, v) => Promise.race([p, new Promise((r) => setTimeout(() => r(v), ms))]);   // a page that is busy for 30 s must not hang the rig
const netRaw = (o) => o.page.evaluate(() => { try { const n = window.__n64Net && window.__n64Net(); if (!n) return null; const e = n.engine || {}; const r = (n.rollback && n.rollback.engine) || {};
  const m = document.getElementById('lsMsg'); return { frame: n.frame, fp: n.lastFp, fps: n.fps, state: n.state, desync: e.desync || (n.rollback && n.rollback.engine && n.rollback.engine.desync) || null, oc: r.ownClock || e.ownClock, adv: r.myAdvantage, rtt: r.rttFrames, lag: r.lag, win: r.window, limp: r.limp, ck: n.engine && n.engine.replay && n.engine.replay.ck, replay: n.engine && n.engine.replay ? { active: n.engine.replay.active, next: n.engine.replay.next, hostFrame: n.engine.replay.hostFrame } : null, msg: m && m.textContent, mode: n.mode, vis: document.visibilityState, stallMs: n.stallMs, cu: r.catchUps, cuf: r.catchUpFrames, ws: r.windowStalls, wp: r.windowPeak, rb: r.rollbacks, mis: r.mispredicted, lp99: r.lateP99, gr: r.ownClock && r.ownClock.granted, pg: n.rollback && n.rollback.page && { cap: n.rollback.page.cap, k: n.rollback.page.k, load: n.rollback.page.loadMs, run: n.rollback.page.runMs, save: n.rollback.page.saveMs } }; } catch (er) { return { err: String(er) }; } }).catch(() => null);
const net = (o) => tmo(netRaw(o), 6000, null);
const shot = async (o, tag) => { try { await tmo(o.page.screenshot({ path: path.join(OUT, `${tag}-${o.role}.png`) }), 10000, null); } catch (e) {} };
async function clickAllow(o) { return o.page.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b && b.offsetParent !== null) { b.click(); return true; } return false; }).catch(() => false); }
const mk = (r) => fs.mkdtempSync(path.join(os.tmpdir(), 'rj-' + r + '-'));
const H = await launch('host', mk('host'));
const Js = [];
for (let i = 1; i <= NJ; i++) Js.push(await launch('j' + i, mk('j' + i)));
await H.page.goto(url('host'), { waitUntil: 'domcontentloaded' }); await sleep(2500);
for (const J of Js) { await J.page.goto(url('join'), { waitUntil: 'domcontentloaded' }); await sleep(500); }
const samp = {}; const samp2 = {}; const rows = [];
let admitted = 0;
async function waitRunning(os_, ms) { const t = Date.now(); for (;;) { await Promise.all(os_.map(clickAllow)); const ns = await Promise.all(os_.map(net)); if (Date.now()-(globalThis.__lw||0)>5000){globalThis.__lw=Date.now();LOG('wait',JSON.stringify(ns.map((n)=>n&&[n.state,n.frame,n.err])));}
 if (ns.every((n) => n && n.frame > 30)) return ns; if (Date.now() - t > ms) throw new Error('timeout running ' + JSON.stringify(ns.map((n) => n && [n.state, n.frame]))); await sleep(500); } }
const all = () => [H, ...Js];
const rec = (o, n) => { if (!n || !(n.frame > 0)) return; const m = samp[o.role] || (samp[o.role] = new Map()); if (n.fp) (samp2[o.role] || (samp2[o.role] = new Map())).set(n.frame, n.fp >>> 0); if (Array.isArray(n.fps)) for (const [f, v] of n.fps) if (f > 0 && v) m.set(f, v >>> 0); };
const out = { name: NAME, mode: MODE, code };
try {
  await waitRunning(all(), 240000);
  LOG('all running');
  // let the match run
  for (;;) { const ns = await Promise.all(all().map(net)); all().forEach((o, i) => rec(o, ns[i])); if (ns[1] && ns[1].frame >= AT + PRE_SEC * 60) break; await sleep(100); }
  await shot(H, 'pre'); await shot(Js[0], 'pre');
  const J = Js[0]; const jdir = J.dir;
  const nb = await net(J), hb = await net(H);
  out.stallAtAct = hb.stallMs || 0; out.frameAtAct = hb.frame; LOG('ACT', MODE, 'j1 frame', nb.frame, 'host frame', hb.frame, 'rtt', hb.rtt);
  const tAct = Date.now();
  if (MODE === 'reload') { await J.page.reload({ waitUntil: 'domcontentloaded' }); }
  else if (MODE === 'tab') { const old = J.page; const np = await J.browser.newPage(); await np.setViewport({ width: 1280, height: 800 }); await np.evaluateOnNewDocument(PRE); await old.close(); await sleep(GAP); J.page = np; np.on('pageerror', (e) => J.errs.push(String(e.message || e).slice(0, 200))); np.on('console', (m) => { const t = m.text(); if (/rejoin|replay|desync|restart|drop|limp|undrop|⚠|stall/i.test(t)) fs.appendFileSync(path.join(OUT, 'console.txt'), '[j1b] ' + t.slice(0, 220) + '\n'); }); await np.goto(url('join'), { waitUntil: 'domcontentloaded' }); }
  else if (MODE === 'close') { await J.browser.close(); await sleep(GAP); const J2 = await launch('j1', jdir); Js[0] = J2; await J2.page.goto(url('join'), { waitUntil: 'domcontentloaded' }); }
  else if (MODE === 'pcdrop') {
    const r = await J.page.evaluate((m) => { let n = 0; for (const pc of window.__pcs || []) { try { if (m === 'pcdrop') pc.close(); else { /* handled below */ } n++; } catch (e) {} } return n; }, MODE);
    LOG('closed', r, 'peer connections on j1');
    if (MODE === 'dcdrop' || MODE === 'hdcdrop') { /* see below */ }
  }
  else if (MODE === 'dcdrop') { const r = await J.page.evaluate(() => { let n = 0; for (const d of window.__dcs || []) { try { d.close(); n++; } catch (e) {} } return n; }); LOG('closed', r, 'data channels on j1'); }
  else if (MODE === 'hpcdrop' || MODE === 'hdcdrop') { const r = await H.page.evaluate((m) => { let n = 0; if (m === 'hpcdrop') { for (const pc of window.__pcs || []) { try { pc.close(); n++; } catch (e) {} } } else { for (const d of window.__dcs || []) { try { d.close(); n++; } catch (e) {} } } return n; }, MODE); LOG('closed on host', MODE, r); }
  else if (MODE === 'none') {}
  const J1 = Js[0];
  if (WRIG && flag('probehost','0')==='1') (async () => { await sleep(20000); for (let k = 0; k < 3; k++) { try { const hh = await H.page.evaluate(() => window.__n64Worker.eval('JSON.stringify({ad:RM.eng._rbAdaptive,rr:RM.eng._rsRoom,cg:RM.eng._capGate,st:RM.eng.state,dr:RM.eng._dropRoom(),rs:RM.eng._rsRestartable(),exp:Array.from(RM.eng._rsExpecting),roster:RM.eng.roster,histTo:RM.eng._histTo,hist:RM.eng._hist.size,mn:RM.eng._modeNext,dropped:Array.from(RM.eng.dropped),rsSent:Array.from(RM.eng._rsSentAt),lob:Array.from(RM.eng.lobby.entries()).map(function(x){return [x[0],x[1].rs]})})')); let jj = null; try { jj = await Js[0].page.evaluate(() => window.__n64Worker.eval('JSON.stringify({st:RM.eng.state,rsA:RM.eng._rsActive,fr:RM.eng._rsFrames,nx:RM.eng._rsNext,ready:RM.eng.declaredReady})')); } catch (e) { jj = 'jerr ' + String(e).slice(0,80); } LOG('PROBEHOST', hh); LOG('PROBEJ', jj); } catch (e) { LOG('probehost err', String(e).slice(0, 200)); } await sleep(8000); } })();
  if (WRIG) (async () => { for (let i = 0; i < 400; i++) { try { const r = await J1.page.evaluate((src) => window.__n64Worker && window.__n64Worker.eval(src), CUW); if (r === 'ok') { LOG('cuwrap installed'); return; } } catch (e) {} await sleep(150); } })();
  // observe
  let lastRow = 0; const tEnd = Date.now() + SECS * 1000; let backAt = null, levelAt = null;
  while (Date.now() < tEnd) {
    const ns = await Promise.all(all().map(net)); all().forEach((o, i) => rec(o, ns[i]));
    await Promise.all(all().map(clickAllow));
    if (Date.now() - lastRow > ROWMS) {
      lastRow = Date.now(); const [h, j] = [ns[0], ns[1]];
      const row = { j2: ns[2] && ns[2].frame, j2m: ns[2] && ns[2].msg && ns[2].msg.slice(0,12), t: +((Date.now() - tAct) / 1000).toFixed(1), h: h && h.frame, j: j && j.frame, d: h && j && j.frame != null ? h.frame - j.frame : null, st: j && j.state, msg: j && j.msg && j.msg.slice(0, 50), limp: j && JSON.stringify(j.limp), rtt: j && j.rtt, adv: j && j.adv, ref: j && j.oc && j.oc.refused, lead: j && j.oc && j.oc.lead, vis: j && j.vis, rp: j && j.replay && j.replay.active, ck: j && j.ck, cu: j && j.cu, cuf: j && j.cuf, ws: j && j.ws, wp: j && j.wp, win: j && j.win, rb: j && j.rb, mis: j && j.mis, lp99: j && j.lp99, gr: j && j.gr, pg: j && j.pg, hrb: h && h.rb, hst: h && h.stallMs, jst: j && j.stallMs, hmode: h && h.state, hwin: h && h.win, hlp99: h && h.lp99 };
      if (WRIG) { try { row.W = await J1.page.evaluate(() => window.__n64Worker.eval('JSON.stringify(self.__cu)')); } catch (e) {} } rows.push(row); LOG('ROW', JSON.stringify(row));
    }
    await sleep(100);
  }
  await shot(H, 'end'); await shot(Js[0], 'end');
  const cmp = {}; const hs = samp.host || new Map();
  for (const o of Js) { const m = samp[o.role] || new Map(); const fr = [...hs.keys()].filter((f) => m.has(f)).sort((a, b) => a - b); let first = null; const bad = []; for (const f of fr) if (hs.get(f) !== m.get(f)) { bad.push(f); if (!first) first = { f, a: hs.get(f), b: m.get(f) }; } cmp[o.role] = { compared: fr.length, firstDiff: first, nBad: bad.length, bad: bad.slice(0, 20) }; }
  for (const o of Js) { const m = samp2[o.role] || new Map(); const hh = samp2.host || new Map(); const fr = [...hh.keys()].filter((f) => m.has(f)); out.pairCmp = out.pairCmp || {}; out.pairCmp[o.role] = { compared: fr.length, nBad: fr.filter((f) => hh.get(f) !== m.get(f)).length }; }
  out.cmp = cmp; out.rows = rows; out.errs = all().map((o) => o.errs);
  out.final = await Promise.all(all().map(net));
  out.hostStallDelta = (out.final[0] && out.final[0].stallMs || 0) - (out.stallAtAct || 0);
  out.ckBase = out.final[1] && out.final[1].ck ? out.final[1].ck.base : null;
  out.ckWhy = out.final[1] && out.final[1].ck ? out.final[1].ck.why : null;
} catch (e) { out.error = String(e && e.stack || e).slice(0, 600); LOG('ERROR', out.error); }
fs.writeFileSync(path.join(OUT, 'out.json'), JSON.stringify(out, null, 1));
console.log('CMP', JSON.stringify(out.cmp), 'PAIR', JSON.stringify(out.pairCmp), 'ERR', out.error || '');
const tail = rows.slice(-3).map((r) => r.d); console.log('FINAL host-j1 frame diffs', tail.join(','));
for (const o of all()) { try { await tmo(o.browser.close(), 8000, null); } catch (e) {} try { fs.rmSync(o.dir, { recursive: true, force: true }); } catch (e) {} }
await broker.close(); process.exit(0);

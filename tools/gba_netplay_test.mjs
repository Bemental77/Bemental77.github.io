#!/usr/bin/env node
// tools/gba_netplay_test.mjs - exit tests for stage GR2: gba.html LOCKSTEP LINK-CABLE ROOMS.
//
//   node tools/gba_netplay_test.mjs                          # the static section only (Node, ~1 s)
//   node tools/gba_netplay_test.mjs --browser                # + every two-page / N-page scenario in headless Chrome (one browser at a time, muted)
//   node tools/gba_netplay_test.mjs --browser --only two,desync,kill      # pick sections (static,redirect,audio,bind,alloc,ux,cap,picker,hostleft,race,third,solofetch,savenote,two,kirby,desync,refuse,save,recover,kill,leave,boot,mobile,speed)
//   node tools/gba_netplay_test.mjs --browser --only two --sbam-frames 20000   # a longer fingerprint run (default: the 4,800-frame menu walk + 600)
//   GBA_NETPLAY_OUT=<dir> ...                                # where PNGs and the JSON report go (default: <tmp>/gba-netplay)
//
// WHAT IS REAL HERE. Every browser scenario drives the REAL gba.html in REAL headless Chrome windows (tools/headless_cdp_multi.mjs: one
// browser, one window per player, --mute-audio, machine-wide browser lock), through the page's own buttons, over lib/netplay.js's
// `?net=local` signalling (a BroadcastChannel) - so the room, the seating, the host's Allow prompt, the card exchange, the start barrier,
// the lockstep frame gate and the fingerprint comparison are the product's own. The emulation is the real mGBA core. What is NOT real:
// there is no second human, no network (loopback, ~1 ms), no phone, no audio device, and `local` signalling skips NAT traversal.
// Fault injection (a ROM that differs, a disc string that differs, a one-bit input flip on ONE machine only, a crash between two storage
// steps) goes through window.__gbaRoomTest, which exists only with ?roomtest=1.
//
// Every check that matters has a NEGATIVE CONTROL printed as [control]: a mutant or a changed condition that must trip it, next to the
// unmutated twin that must stay quiet.
//
// Exit code is non-zero on any failure. This file does NOT edit the page, lib/netplay.js or any other emulator's test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { withBrowserMulti } from './headless_cdp_multi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = opt('--only', '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const PORT = Number(process.env.GBA_TEST_PORT || 8092);
const CDP_BASE = Number(process.env.GBA_NETPLAY_CDP || 9251);
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.GBA_NETPLAY_OUT ? path.resolve(process.env.GBA_NETPLAY_OUT) : path.join(os.tmpdir(), 'gba-netplay');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
// GBA_NETPLAY_PHONE=1 runs every multi-window section with every window on a 390x844 touch viewport (Chrome's engine, not WebKit): the way the changed panel
// states were captured for a PHONE (use with GBA_NETPLAY_OUT=<dir> and --only audio,alloc,ux,desync). Unset = the desktop default (900x700).
const VIEW = process.env.GBA_NETPLAY_PHONE === '1' ? { width: 390, height: 844, mobile: true } : {};
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const info = (s) => console.log(`       ${s}`);
const section = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

function cpuLoad() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'], { encoding: 'utf8', timeout: 20000 });
    const v = parseFloat(String(r.stdout).trim()); return Number.isFinite(v) ? v : null;
  } catch (_e) { return null; }
}
async function ensureServer() {
  const url = `http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`;
  try { if ((await fetch(url)).ok) return { stop() {}, reused: true }; } catch (_e) { /* start one */ }
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch (_e) { await sleep(250); } }
  return { stop() { try { srv.kill(); } catch (_e) { /* gone */ } }, reused: false };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// STATIC: the page's source, with a mutant for every check
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
function staticChecks(html, scriptJs, roomJs, label) {
  const live = stripComments(html), liveScript = stripComments(scriptJs);
  const R = {};
  R['loads-the-lockstep-engine'] = /<script src="\/lib\/netplay\.js\?v=[0-9a-f]{8}"><\/script>/.test(live);
  R['never-loads-the-streaming-host'] = !/netplay-host/.test(live);
  R['no-streaming-machinery'] = !['attachMedia(', 'netCaptureSurface', 'captureStream(', 'mpVideo', 'netVideo', 'remoteStream('].some((k) => live.includes(k) || liveScript.includes(k));
  R['drives-the-frame-gate'] = /beginFrame\(/.test(live) && /endFrame\(/.test(live) && /wantsHash\(/.test(live);
  const tok = /room\.js\?v=([0-9a-f]{8})/.exec(live);
  R['room.js-token-is-md5'] = !!tok && tok[1] === md5(roomJs).slice(0, 8);
  R['no-coi-worker'] = !/coi-serviceworker/.test(live);
  R['sab-free'] = !/SharedArrayBuffer|new Worker\(|Atomics\./.test(live) && !/SharedArrayBuffer|new Worker\(|Atomics\./.test(liveScript);
  R['test-seams-only-behind-roomtest'] = /var TEST = TESTING \? \(window\.__gbaRoomTest = /.test(html) && (html.match(/__gbaRoomTest\s*=/g) || []).length === 1;
  R['room-lock-pins-the-guest'] = /if \(this\.roomLocked\) \{ this\.gameSpeed = 1; return false; \}/.test(scriptJs) && /_roomTick\(now\)/.test(scriptJs) && !/_roomTick[\s\S]{0,1200}this\.gameSpeed/.test(scriptJs.slice(scriptJs.indexOf('_roomTick(now) {')));
  R['party-unhidden-only-by-the-room-wiring'] = /<button id="btnNet" type="button" hidden>/.test(html) && /<button id="mobileSplashNet" type="button" hidden/.test(html) && /function wireNetplay\(\) \{\s*if \(!netSupported\(\)\) return;/.test(html);
  R['persistence-is-only-the-room-plan'] = /roomClean/.test(html) && /m\.commitPlan\(/.test(html) && !/exportSave\(/.test(html.slice(html.indexOf('THE ROOM — GBA LINK-CABLE'))) ;
  R['audio-on-first-activation'] = /\['pointerdown', 'pointerup', 'keydown', 'touchend', 'click'\]\.forEach\(function \(ev\) \{ document\.addEventListener\(ev, onActivation, true\); \}\);/.test(html) && /function onActivation\(\) \{ if \(NET\.session \|\| ROOM\.machine\) gesture\(\); \}/.test(html);
  R['test-seam-loopback-only'] = html.includes("Q.get('roomtest') === '1' && /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)") && scriptJs.includes("q.get('roomtest') === '1' && /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)");
  R['card-cap-opt-in'] = (html.match(/cardLimits: R\.ROOM_CARD_LIMITS/g) || []).length === 2 && /lockstep: Object\.assign\(R\.lockstepOptions\(cfg\), \{ cardLimits: R\.ROOM_CARD_LIMITS \}\)/.test(html) && /lockstep: Object\.assign\(R\.baseLockstepOptions\(\), \{ cardLimits: R\.ROOM_CARD_LIMITS \}\)/.test(html) && /c\.code === 'CARD_LIMIT'/.test(html);
  R['rom-picker-follows-room'] = /function syncRomPicker\(\) \{/.test(html) && /function netRoomRender\(\) \{\s*\n\s*syncRomPicker\(\);/.test(html) && scriptJs.includes("setDis(['romSelect', 'mobileRomSelect'], inRoom);");
  R['host-says-goodbye'] = /function sayHostBye\(\) \{/.test(html) && /if \(!\(ev && ev\.persisted\)\) sayHostBye\(\);/.test(html) && /sayHostBye\(\);\s*\n\s*try \{ s\.close\(\); \} catch \(e\) \{ \}\s*\n\s*roomEnded\(/.test(html) && /if \(m && m\.t === 'lsgbahostbye'\) \{ hostGone\('bye'\); return true; \}/.test(html) && /Lost contact with the host — trying to get back in for another/.test(html) && /\(ROOM\.machine \|\| NET\.hostBye \|\| NET\.hostLost\)/.test(html);
  R['dead-page-is-not-a-refusal'] = /\^\(TypeError\|AbortError\|NetworkError\)\$/.test(html) && /announceDelayMs/.test(html) && /if \(!unloading && NET\.session === sess && ROOM\.phase === 'refused'\) announce\(\);/.test(html);
  R['refused-visitor-shows-only-refusal'] = /if \(!inRoom \|\| NET\.connectFailed\) \{ box\.style\.display = 'none'; return; \}/.test(html) && /function words\(s\) \{/.test(html) && /replace\(\/\\bdisc\\b\/g, 'cartridge'\)/.test(html) && /showRefusal\('Could not join the room'/.test(html);
  R['finished-room-says-finished'] = /var over = ROOM\.phase === 'saved' \? 'finished' : ROOM\.phase === 'saving' \? 'finishing' : null;/.test(html) && /if \(ROOM\.phase === 'saved'\) return 'finished';/.test(html) && /if \(ROOM\.phase === 'saved'\) return '';/.test(html);
  R['room-cancels-the-solo-fetch'] = scriptJs.includes('this._soloLoadToken = (this._soloLoadToken | 0) + 1;') && scriptJs.includes('const stale = () => token !== this._soloLoadToken || this.roomLocked || this.roomForming;') && (scriptJs.match(/if \(stale\(\)\) return;/g) || []).length === 2 && scriptJs.includes('this.setStatus(ROOM_FORMING_STATUS)');
  R['journal-gates-the-frame'] = /journalDurable\(lp\.journal\)/.test(html) && /return false; \}\s*\n\s*var t0/.test(html);
  return R;
}

async function sectionStatic() {
  section('static: gba.html is a LOCKSTEP page and nothing else');
  const html = read('gba.html'), scriptJs = read('gba/gbaWasm/dist/script.js'), roomJs = fs.readFileSync(path.join(ROOT, 'gba/mgba/room.js'));
  const base = staticChecks(html, scriptJs, roomJs, 'live');
  for (const [k, v] of Object.entries(base)) ok(k, v);
  // controls: each mutant must trip exactly the check it names
  const ctl = (name, key, mut) => { const m = staticChecks(mut.html || html, mut.script || scriptJs, mut.room || roomJs, name); control(`${name} -> ${key}`, m[key] === false); };
  ctl('dropping netplay.js', 'loads-the-lockstep-engine', { html: html.replace(/<script src="\/lib\/netplay\.js\?v=[0-9a-f]{8}"><\/script>/, '') });
  ctl('loading the streaming host', 'never-loads-the-streaming-host', { html: html.replace('<script src="/lib/cart_audio.js', '<script src="/lib/netplay-host.js"></script><script src="/lib/cart_audio.js') });
  ctl('a captureStream( in live code', 'no-streaming-machinery', { html: html.replace('</body>', '<script>var c = canvas.captureStream(30);</script></body>') });
  ctl('a stale room.js token', 'room.js-token-is-md5', { html: html.replace(/room\.js\?v=[0-9a-f]{8}/, 'room.js?v=deadbeef') });
  ctl('re-adding the coi worker', 'no-coi-worker', { html: html.replace('<script src="/lib/wakelock.js">', '<script src="/coi-serviceworker.js"></script><script src="/lib/wakelock.js">') });
  ctl('a SharedArrayBuffer in the page', 'sab-free', { html: html.replace('</body>', '<script>var s = new SharedArrayBuffer(8);</script></body>') });
  ctl('the test seam without its query gate', 'test-seams-only-behind-roomtest', { html: html.replace('var TEST = TESTING ? (window.__gbaRoomTest = ', 'var TEST = (window.__gbaRoomTest = ') });
  ctl('the room tick reading gameSpeed', 'room-lock-pins-the-guest', { script: scriptJs.replace('_roomTick(now) {', '_roomTick(now) { const sp = this.gameSpeed;') });
  ctl('the activation listeners removed (only the three buttons create the audio context)', 'audio-on-first-activation', { html: html.replace("document.addEventListener(ev, onActivation, true);", "void ev;") });
  ctl('the test seam reachable from a public host', 'test-seam-loopback-only', { html: html.replace(" && /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname);", ";") });
  ctl('the storage seam reachable from a public host', 'test-seam-loopback-only', { script: scriptJs.replace(" && /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname)", "") });
  { // the gate is what it says: the regex both files carry accepts this machine and rejects the public site
    const re = /^(localhost|127\.0\.0\.1|\[::1\])$/;
    ok('the loopback gate accepts localhost, 127.0.0.1 and [::1] and rejects caseybement.com, www.caseybement.com, localhost.evil.com and an empty host', ['localhost', '127.0.0.1', '[::1]'].every((h) => re.test(h)) && !['caseybement.com', 'www.caseybement.com', 'localhost.evil.com', '127.0.0.1.evil.com', ''].some((h) => re.test(h)));
  }
  ctl("the guest room not opting in to the engine card cap", 'card-cap-opt-in', { html: html.replace('lockstep: Object.assign(R.baseLockstepOptions(), { cardLimits: R.ROOM_CARD_LIMITS })', 'lockstep: R.baseLockstepOptions()') });
  ctl("the host room not opting in to the engine card cap", 'card-cap-opt-in', { html: html.replace('lockstep: Object.assign(R.lockstepOptions(cfg), { cardLimits: R.ROOM_CARD_LIMITS })', 'lockstep: R.lockstepOptions(cfg)') });
  ctl('the picker following the room removed from netRoomRender', 'rom-picker-follows-room', { html: html.replace(/(function netRoomRender\(\) \{\s*\n\s*)syncRomPicker\(\);/, '$1') });
  ctl('the pickers left enabled in a room', 'rom-picker-follows-room', { script: scriptJs.replace("setDis(['romSelect', 'mobileRomSelect'], inRoom);", '') });
  ctl('the host not saying goodbye when it leaves', 'host-says-goodbye', { html: html.replace(/sayHostBye\(\);(\s*\n\s*try \{ s\.close\(\); \} catch \(e\) \{ \}\s*\n\s*roomEnded\()/, '$1') });
  ctl('the host not saying goodbye when its tab closes', 'host-says-goodbye', { html: html.replace('if (!(ev && ev.persisted)) sayHostBye();', '') });
  ctl('the guest not listening for the goodbye', 'host-says-goodbye', { html: html.replace("if (m && m.t === 'lsgbahostbye') { hostGone('bye'); return true; }", '') });
  ctl('the countdown removed', 'host-says-goodbye', { html: html.replace('Lost contact with the host — trying to get back in for another', 'Looking for the host') });
  ctl('a transport failure announced at once again', 'dead-page-is-not-a-refusal', { html: html.replace("if (!err.field && /^(TypeError|AbortError|NetworkError)$/.test(String((e && e.name) || '')))", 'if (false)') });
  ctl('the refused visitor shown the room again', 'refused-visitor-shows-only-refusal', { html: html.replace("if (!inRoom || NET.connectFailed) { box.style.display = 'none'; return; }", "if (!inRoom) { box.style.display = 'none'; return; }") });
  ctl('disc words left as the engine wrote them', 'refused-visitor-shows-only-refusal', { html: html.replace(".replace(/\\bdisc\\b/g, 'cartridge')", '') });
  ctl('a finished room still saying playing', 'finished-room-says-finished', { html: html.replace("var over = ROOM.phase === 'saved' ? 'finished' : ROOM.phase === 'saving' ? 'finishing' : null;", 'var over = null;') });
  ctl('the solo fetch not cancelled by a room', 'room-cancels-the-solo-fetch', { script: scriptJs.replace('if (stale()) return;', '/* removed */') });
  ctl('the journal gate removed', 'journal-gates-the-frame', { html: html.replace('if (lp.journal && !journalDurable(lp.journal)) { ROOM.stalling = true; ROOM.waitingOn = []; return false; }', '') });
  ctl('the room exporting a battery', 'persistence-is-only-the-room-plan', { html: html.replace('var prev = await dbGet(key);', 'var prev = await dbGet(key); ROOM.machine.core.exportSave(0);') });
  // the standing gates this stage must keep green
  const ns = spawnSync(process.execPath, ['tools/no_streaming_test.mjs'], { cwd: ROOT, encoding: 'utf8' });
  ok('tools/no_streaming_test.mjs passes with gba.html counted as an ONLINE lockstep page', ns.status === 0 && /PASS\s+gba\.html — lockstep/.test(ns.stdout), (/(\d+\/\d+ online pages[^\n]*)/.exec(ns.stdout) || [])[1]);
  const STALE = /does not offer online play|implements no link cable|no link cable|ONLINE PLAY IS NOT OFFERED|not wired on this page|later stage and is not wired/i;
  const mp = read('gba_multiplayer.html');
  ok('no STALE "gba has no link cable / online play is not offered" claim is left in gba.html or gba_multiplayer.html', !STALE.test(html) && !STALE.test(mp), [html, mp].map((s, i) => (STALE.exec(s) || [])[0] || '-').join(' / '));
  control('the stale-claim detector fires on the old sentence', STALE.test('this core implements no link cable') && STALE.test('ONLINE PLAY IS NOT OFFERED ON THIS PAGE YET'));
  ok('gba_multiplayer.html is still a REDIRECT that carries ?np= (and the rest of a lobby hand-off) to /gba.html', /location\.replace\(to\)/.test(mp) && /'\/gba\.html' \+ q/.test(mp) && /\['game', 'host', 'join', 'seats', 'net'\]/.test(mp) && !/streaming|captureStream|<video/i.test(stripComments(mp)));
  // lib/netplay.js is the shared engine for every emulator. This stage may only ADD to it (the opt-in card cap, cardLimits, off unless a page
  // passes it); nothing the engine already did may be removed or edited for it. The one line another stage changed (CODE_TAGS: gba 'B',
  // pokemonarena 'A', lobby/GR4) is the single removed line allowed. tools/gba_card_cap_test.mjs proves the behaviour without the option is
  // unchanged; this proves the diff is only additions. Empty (everything committed) passes too.
  const diffOnlyAdditive = (diffText) => { const ls = String(diffText || '').replace(/\r/g, '').split('\n'); return ls.filter((l) => /^-[^-]/.test(l)).every((l) => /const CODE_TAGS = /.test(l)); };
  const gd = spawnSync('git', ['diff', '-U0', '--', 'lib/netplay.js'], { cwd: ROOT, encoding: 'utf8' });
  ok('lib/netplay.js differs from the committed engine ONLY by additions (the opt-in card cap) plus the CODE_TAGS line: no line the engine already had was removed or edited', gd.status === 0 && diffOnlyAdditive(gd.stdout), (String(gd.stdout || '').match(/^@@/gm) || []).length + ' hunks');
  control('the additive-only check fires on an edited engine line', diffOnlyAdditive('-    _cardTake(store, key, m) {\n+    _cardTake(store, key, m, x) {') === false && diffOnlyAdditive('-  const CODE_TAGS = { a: 1 };\n+  const CODE_TAGS = { a: 1, b: 2 };') === true && diffOnlyAdditive('') === true);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// BROWSER HARNESS
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const smoke = await import(pathToFileURL(path.join(ROOT, 'tools/gba_link_smoke.mjs')).href);
const LINK = Object.fromEntries(smoke.TITLES.map((t) => [t.id, t]));
// gba_link_smoke script -> keys per frame, per seat (same step semantics as its runScript).
const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };
function keysByFrame(steps, seats) {
  const out = [], keys = new Array(seats).fill(0);
  const sel = (t) => (t === 'all' ? [...Array(seats).keys()] : Array.isArray(t) ? t : [t]);
  const maskOf = (names) => String(names).split('+').reduce((m, n) => m | (n === 'NONE' ? 0 : KEY[n.toUpperCase()]), 0);
  const step = (n) => { for (let i = 0; i < n; i++) out.push(keys.slice()); };
  for (const st of steps) {
    const c = st[0];
    if (c === 'wait') step(st[1]);
    else if (c === 'tap') { const hold = st[3] === undefined ? 6 : st[3], gap = st[4] === undefined ? 12 : st[4]; for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(hold); for (const s of sel(st[1])) keys[s] = 0; step(gap); }
    else if (c === 'hold') { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(st[3]); for (const s of sel(st[1])) keys[s] = 0; }
    else if (c === 'mash') { for (let i = 0; i < st[3]; i++) { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(3); for (const s of sel(st[1])) keys[s] = 0; step(5); } }
  }
  return out;
}
const seatKeys = (script, seats, seat) => keysByFrame(script, seats).map((row) => row[seat]);

// ⚠ ONE INDEXEDDB PER WINDOW. Two real players have two browsers; two windows of ONE profile share one origin and therefore one database,
// so both would read and write the same battery key. ?roomtest=1&gbadb=NAME (script.js _dbName) gives each simulated player its own.
const URLQ = (extra = '', db = null) => `${BASE}/gba.html?net=local&roomtest=1${db ? '&gbadb=' + db : ''}${extra}`;
const DBNAMES = ['pA', 'pB', 'pC', 'pD'];
async function openAll(pages, extra = '') {
  if (VIEW.mobile) {   // GBA_NETPLAY_PHONE=1: EVERY window must be a phone, not just window 0 (tools/headless_cdp_multi.mjs openWindow used to drop the flag)
    await Promise.all(pages.map(async (p, i) => { p.dbName = DBNAMES[i]; await p.navigate(URLQ(extra, p.dbName)); await p.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 60000 }); }));
    const phones = await Promise.all(pages.map((p) => p.eval('({ w: innerWidth, mobile: !!window.myApp.mobileMode, touch: navigator.maxTouchPoints > 0 })')));
    ok('phone arm: every one of the ' + pages.length + ' windows is a 390 px touch window with the phone shell (window ' + phones.map((x, i) => i + ':' + x.w + (x.mobile ? 'm' : 'd') + (x.touch ? 't' : '-')).join(' ') + ')', phones.every((x) => x.w === 390 && x.mobile), JSON.stringify(phones));
    return;
  }
  await Promise.all(pages.map(async (p, i) => { p.dbName = DBNAMES[i]; await p.navigate(URLQ(extra, p.dbName)); await p.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp && window.myApp.isWasmReady)', { timeoutMs: 60000, pollMs: 250 }); }));
}
const net = (p) => p.eval('window.__gbaNet()').then((n) => n);
// the seam's function members do not survive JSON; ask for plain data
const netData = (p) => p.eval('(() => { const n = window.__gbaNet(); delete n.leave; delete n.finish; return JSON.parse(JSON.stringify(n)); })()');
async function setKeys(p, arr) { await p.eval(`window.__gbaRoomTest.keyArr = ${JSON.stringify(arr)}; window.__gbaRoomTest.keys = (f) => window.__gbaRoomTest.keyArr[f] || 0; true`); }
async function hostOpen(A, title, seats) {
  return A.eval(`(async () => {
    document.getElementById('btnNet').click(); document.getElementById('netHostBtn').click();
    const t = document.getElementById('netTitle'); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event('change'));
    const s = document.getElementById('netSeats'); s.value = ${JSON.stringify(String(seats))};
    document.getElementById('netOpen').click();
    for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 100)); const c = document.getElementById('netCode').textContent.trim(); if (/^[A-Z2-9]{5}$/.test(c)) return c; }
    return null; })()`);
}
async function guestJoin(B, code) {
  await B.eval(`(() => { document.getElementById('btnNet').click(); document.getElementById('netJoinBtn').click(); document.getElementById('netCodeIn').value = ${JSON.stringify(code)}; document.getElementById('netGo').click(); true; })()`);
}
async function admit(A, n = 1) {
  for (let i = 0; i < n; i++) {
    await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 30000, pollMs: 200 });
    await A.eval(`document.getElementById('npApproveAllow').click(); true`);
    await sleep(400);
  }
}
async function formRoom(pages, title, seats) {
  const [A, ...guests] = pages;
  const code = await hostOpen(A, title, seats);
  for (const g of guests) {
    await guestJoin(g, code);
    await admit(A, 1);
    await g.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000, pollMs: 200 });
  }
  return code;
}
const allRunning = (pages, min = 1) => Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().running && window.__gbaNet().roomFrames >= ${min}`, { timeoutMs: 90000, pollMs: 250 })));

// Fingerprint chains: poll every few seconds into a per-page Map(frame -> words) so the page's 800-sample window never loses any.
function chainCollector(pages) {
  const maps = pages.map(() => new Map());
  const poll = async () => {
    const all = await Promise.all(pages.map((p) => p.eval('window.__gbaNet().chain').catch(() => [])));
    all.forEach((c, i) => (c || []).forEach((row) => maps[i].set(row[0], row.slice(1).join(','))));
  };
  return { maps, poll };
}
function compareChains(maps) {
  const [m0, ...rest] = maps;
  let common = 0, bad = 0, first = null, firstBad = null, last = null;
  for (const [f, v] of m0) {
    if (!rest.every((m) => m.has(f))) continue;
    common++; if (first === null) first = f; last = f;
    if (!rest.every((m) => m.get(f) === v)) { bad++; if (firstBad === null) firstBad = f; }
  }
  return { common, bad, first, last, firstBad };
}
async function clearOrigin(p) { try { await p.send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'all' }); } catch (_e) { /* best effort */ } }
async function shot(p, name) { const f = path.join(OUT, name + '.png'); await p.screenshot(f); info('screenshot ' + f); return f; }
const pageErrs = (pages) => pages.flatMap((p, i) => p.errors.filter((e) => !/favicon/i.test(e)).map((e) => `[win ${i}] ${e}`));

const dbOf = (p) => (p.dbName ? 'GBAWASMDB-test-' + p.dbName : 'GBAWASMDB');
// ── dbs: reading what a page persisted, from the TEST side (the page's own IndexedDB) ────────────────────────────────────────
const dbRead = (p, key) => p.eval(`(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(dbOf(p))}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const v = await new Promise((res) => { const r = db.transaction('GBAWASMSTATES', 'readonly').objectStore('GBAWASMSTATES').get(${JSON.stringify(key)}); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); });
  db.close(); if (v == null) return null;
  const u = v instanceof Uint8Array ? v : new Uint8Array(v.buffer ? v.buffer : v);
  let h = 0x811C9DC5; for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193); }
  return v && v.state ? { record: v } : { len: u.length, fnv: (h >>> 0).toString(16), head: Array.from(u.slice(0, 8)) }; })()`);
const dbPutBytes = (p, key, arr) => p.eval(`(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(dbOf(p))}); r.onupgradeneeded = (e) => { if (!e.target.result.objectStoreNames.contains('GBAWASMSTATES')) e.target.result.createObjectStore('GBAWASMSTATES', { autoIncrement: true }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => { const tx = db.transaction('GBAWASMSTATES', 'readwrite'); tx.objectStore('GBAWASMSTATES').put(new Uint8Array(${JSON.stringify(arr)}), ${JSON.stringify(key)}); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close(); return true; })()`);
const KIRBY = 'Kirby Nightmare in Dreamland', SBAM = 'Super Bust-A-Move', SA3 = 'Sonic Advance 3';
const KIRBY_FILE = 'Kirby - Nightmare in Dream Land (U).gba';

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// two: a real two-page Super Bust-A-Move room, a scripted 1P-vs-2P battle, fingerprints for thousands of frames, the guest rate
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionTwo(report) {
  section('two: Super Bust-A-Move, 2 pages, a scripted menu walk into the linked 1P-vs-2P battle, fingerprints compared every 60 frames');
  const script = LINK['sbam-2p'].script, total = smoke.framesOf(script), extra = Number(opt('--sbam-frames', '0'));
  const target = extra > total ? extra : total + 600;
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    const vis = await Promise.all(pages.map((p) => p.eval('document.visibilityState')));
    ok('both windows can render (visible)', vis.every((v) => v === 'visible'), vis.join('/'));
    await Promise.all(pages.map(clearOrigin));
    await openAll(pages);
    const d0 = await Promise.all(pages.map((p) => netData(p)));
    ok('Party reads exactly "Party" with no room, on both pages', (await Promise.all(pages.map((p) => p.eval("document.getElementById('btnNet').textContent.trim()")))).every((t) => t === 'Party'));
    ok('before any room: solo core is up, roomLocked false, not live', d0.every((n) => n.supported && !n.roomLocked && !n.live && !n.session));
    const code = await hostOpen(A, SBAM, 2);
    ok('the host opens a room and gets a 5-character code', /^[A-HJ-NP-Z2-9]{5}$/.test(code || ''), code);
    await shot(A, 'two_host_lobby');
    await sleep(3000);
    const alone = await netData(A);
    ok('a host ALONE never starts (3 s: nothing loading, not armed, not live)', !alone.party.started && !alone.running && !alone.live && alone.party.seated <= 1 && /^Waiting for another player — share the code/.test(alone.party.barrier), `seated=${alone.party.seated} barrier="${alone.party.barrier}"`);
    await guestJoin(B, code);
    const asked = await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 30000, pollMs: 200 }).then(() => true).catch(() => false);
    ok('knowing the code is not enough: the host is asked to Allow the joiner (a human clicks the real Allow button)', asked);
    await shot(A, 'two_host_allow_prompt');
    await A.eval(`document.getElementById('npApproveAllow').click(); true`);
    await B.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000, pollMs: 200 });
    await shot(B, 'two_joiner_seated');
    const mine = await Promise.all(pages.map((p) => p.eval('window.__gbaNet().localPorts[0]')));
    ok('each player holds a DIFFERENT seat; the host is seat 1 (the link master)', mine[0] === 0 && mine[1] === 1, JSON.stringify(mine));
    // scripted, DIFFERENT inputs per player: seat 0 plays the first three shots, then seat 1
    await Promise.all([setKeys(A, seatKeys(script, 2, 0)), setKeys(B, seatKeys(script, 2, 1))]);
    await allRunning(pages, 1);
    const n1 = await Promise.all(pages.map(netData));
    ok('NOBODY pressed Start: both pages loaded, booted and armed by themselves', n1.every((n) => n.declared && n.party.started && n.roomLocked), `phases ${n1.map((n) => n.phase).join('/')}`);
    ok('the room started both machines at the SAME frame 0 (barrier), delay-lockstep, 2 linked cores each', n1.every((n) => n.startedAtFrame === 0 && n.seats === 2 && n.state !== 'desync'), `started ${n1.map((n) => n.startedAtFrame).join('/')} delay ${n1.map((n) => n.delay).join('/')}`);
    ok('the Party button is the live status line, seats are in the panel vocabulary, and no peer id reaches the screen',
       n1.every((n) => /^Party · [A-HJ-NP-Z2-9]{5} · 2\/2 · (starting|playing)$/.test(n.party.label) && n.party.rows.every((r) => /^(connecting|loading \d+%|loaded|ready|playing|disconnected|open)$/.test(r.state)) && !/\b[0-9a-f]{16}\b/.test(JSON.stringify(n.party))), JSON.stringify(n1.map((n) => n.party.label)));
    const col = chainCollector(pages);
    const t0 = Date.now(), load0 = cpuLoad();
    const f0 = n1.map((n) => n.roomFrames);
    let shotsDone = 0;
    while (true) {
      await sleep(4000); await col.poll();
      const ns = await Promise.all(pages.map((p) => p.eval('({f: window.__gbaNet().roomFrames, st: window.__gbaNet().state})')));
      if (ns.some((n) => n.st === 'desync' || n.st === 'failed')) break;
      if (!shotsDone && ns.every((n) => n.f > total - 700)) { shotsDone = 1; }
      if (ns.every((n) => n.f >= target)) break;
      if (Date.now() - t0 > (target / 55 + 120) * 1000) break;
    }
    await col.poll();
    const dt = (Date.now() - t0) / 1000, nEnd = await Promise.all(pages.map(netData));
    await shot(A, 'two_sbam_linked_host'); await shot(B, 'two_sbam_linked_guest');
    const cmp = compareChains(col.maps);
    ok(`fingerprints (all seats + the link, hash() strict) are IDENTICAL on both pages: ${cmp.common} comparable samples over frames ${cmp.first}..${cmp.last}`, cmp.common >= 60 && cmp.bad === 0 && nEnd.every((n) => n.state !== 'desync'), `bad=${cmp.bad} firstBad=${cmp.firstBad}`);
    control('the chain comparison can fail: one corrupted sample on one page is caught', (() => { const m = col.maps.map((x) => new Map(x)); const k = [...m[1].keys()][3]; m[1].set(k, m[1].get(k) + 'x'); return compareChains(m).bad === 1; })());
    const eng = nEnd.map((n) => n.engine || {});
    ok('the ENGINE compared fingerprints (not just produced them) and reported no desync', nEnd.every((n) => n.hashes > 20) && eng.every((e) => (e.hashesCompared || 0) > 20 && !e.desync), `produced ${nEnd.map((n) => n.hashes)} compared ${eng.map((e) => e.hashesCompared)}`);
    const wit = nEnd.map((n) => n.witnesses);
    ok('the cores are ACTUALLY LINKED on both machines (SIO multi-play rounds, serial IRQs, zero incidents) - not just running in parallel', wit.every((w) => w && w.attached === 2 && w.linked && w.multiRounds > 1000 && w.incidents === 0 && w.recoverCount === 0 && w.stalls === 0), JSON.stringify(wit.map((w) => w && { linked: w.linked, rounds: w.multiRounds, irq: w.serialIrqsPerFrame, inc: w.incidents })));
    const framesNow = nEnd.map((n) => n.roomFrames);
    ok('frames stay in step between the two pages', Math.abs(framesNow[0] - framesNow[1]) <= 30, `${framesNow.join(' vs ')}`);
    // the guest rate: frames run per wall second over a measured window, against 59.7275 (gate 9)
    const rateOf = (p) => p.eval(`(async () => { const hz = 16777216 / 280896; const f0 = window.__gbaNet().roomFrames, t0 = performance.now(); await new Promise((r) => setTimeout(r, 12000)); const f1 = window.__gbaNet().roomFrames; return ((f1 - f0) / ((performance.now() - t0) / 1000)) / hz; })()`);
    const loadR = cpuLoad();
    const rates = await Promise.all(pages.map(rateOf));
    ok('GATE 9: the guest rate of BOTH pages is 1.000x hardware (59.7275 Hz) - never above, not wedged below', rates.every((x) => x >= 0.97 && x <= 1.02), `${rates.map((x) => x.toFixed(4) + 'x').join(' / ')} over 12 s; Windows CPU busy ${loadR}% (before run ${load0}%)`);
    report.two = { frames: framesNow, samples: cmp.common, rates, load: [load0, loadR], seconds: +dt.toFixed(1) };
    // AUDIO (verified by plumbing, never by listening: the browser is --mute-audio): the sink is fed by the LOCAL seat only
    const aud = await Promise.all(pages.map((p) => p.eval(`(async () => { const hz = 16777216 / 280896, a0 = (window.__cartAudio || {}).rxFrames | 0, f0 = window.__gbaNet().roomFrames; await new Promise((r) => setTimeout(r, 6000)); const a1 = (window.__cartAudio || {}).rxFrames | 0, f1 = window.__gbaNet().roomFrames; return { ctx: myApp.audioContext ? myApp.audioContext.state : null, sink: !!myApp.audioSink, rxPerGuestSec: (a1 - a0) / ((f1 - f0) / hz), guestSecs: (f1 - f0) / hz }; })()`)));
    ok('audio: the AudioContext was created by the click that opened/joined the room, and the sink is fed ~48,000 frames per GUEST second - ONE seat (the local one), not the two seats\' ~96,000', aud.every((a) => a.sink && a.ctx && Math.abs(a.rxPerGuestSec - 48000) < 2500), JSON.stringify(aud.map((a) => ({ ctx: a.ctx, rx: Math.round(a.rxPerGuestSec) }))));
    // VIDEO: the canvas shows the LOCAL seat's screen
    const vid = await Promise.all(pages.map((p) => p.eval(`(() => { const m = window.__gbaRoomTest.machine(), c = document.getElementById('canvas').getContext('2d').getImageData(0, 0, 240, 160).data, L = m.localSeat; const eq = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }; return { local: L, equalsLocalSeatVideo: eq(c, m.core.video(L)), equalsOtherSeatVideo: eq(c, m.core.video(1 - L)) }; })()`)));
    ok('video: the canvas shows the LOCAL seat\'s screen (equals core.video(localSeat) on each page)', vid.every((v) => v.equalsLocalSeatVideo), JSON.stringify(vid));
    if (vid.every((v) => v.equalsOtherSeatVideo)) info('(in this SBAM scene both seats draw the same board, so this cannot tell the local seat from the other; the check above is against the local seat\'s buffer by construction)');
    // screenshots of the linked screen are opened by the human reviewer; the machine check is the witness above.
    // gate 9 + the speed lock inside the live room
    const lock = await A.eval(`(() => { const a = myApp.setGameSpeed(5); const s1 = myApp.gameSpeed; myApp.cycleSpeed(); return { refused: a === false, s1, s2: myApp.gameSpeed, locked: myApp.roomLocked, speedBtnDisabled: document.getElementById('mSpeed').disabled }; })()`);
    ok('the speed control is LOCKED while the room is live: setGameSpeed(5) refused, cycleSpeed() leaves it at 1x, the menu button is disabled', lock.refused && lock.s1 === 1 && lock.s2 === 1 && lock.locked && lock.speedBtnDisabled, JSON.stringify(lock));
    const iso = await Promise.all(pages.map((p) => p.eval(`({ coi: crossOriginIsolated, sab: typeof SharedArrayBuffer, sw: !!(navigator.serviceWorker && navigator.serviceWorker.controller), heap: window.__gbaRoomTest.machine().core.memory().heapBytes })`)));
    ok('the room page is NOT cross-origin isolated, has no SharedArrayBuffer and no coi service worker - while running ALL linked cores of the room (one 192 MiB wasm heap per page)', iso.every((x) => x.coi === false && x.sab === 'undefined' && x.sw === false && x.heap === 201326592), JSON.stringify(iso));
    const errs = pageErrs(pages);
    ok('no page errors on either window', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
    // the room's end: leave
    await B.eval('window.__gbaNet().leave(true)');
    await A.eval('window.__gbaNet().leave(true)');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// kirby: 2, 3 and 4 seats, the multi-secondary ack barrier, the Quick Draw tutorial
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionKirby(report) {
  for (const n of [2, 3, 4]) {
    section(`kirby: ${n} pages, ${n} linked cores per machine, the SUB-GAMES -> Quick Draw -> MULTIPLAYER walk`);
    const t = LINK[`kirby-${n}p`], total = smoke.framesOf(t.script);
    await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: n }, async ({ pages }) => {
      await Promise.all(pages.map(clearOrigin));
      await openAll(pages);
      const code = await formRoom(pages, KIRBY, n);
      ok(`${n} players seated in ${n} DIFFERENT seats`, new Set((await Promise.all(pages.map((p) => p.eval('window.__gbaNet().localPorts[0]'))))).size === n, code);
      await Promise.all(pages.map((p, i) => setKeys(p, seatKeys(t.script, n, i))));
      await allRunning(pages, 1);
      const col = chainCollector(pages), t0 = Date.now();
      while (Date.now() - t0 < (total / 50 + 90) * 1000) {
        await sleep(3000); await col.poll();
        const fr = await Promise.all(pages.map((p) => p.eval('({f: window.__gbaNet().roomFrames, st: window.__gbaNet().state})')));
        if (fr.some((x) => x.st === 'desync' || x.st === 'failed') || fr.every((x) => x.f >= total + 120)) break;
      }
      await col.poll();
      const ns = await Promise.all(pages.map(netData));
      const cmp = compareChains(col.maps);
      await shot(pages[0], `kirby${n}_host_quickdraw`); await shot(pages[n - 1], `kirby${n}_last_player_quickdraw`);
      ok(`identical fingerprint chains on all ${n} pages (${cmp.common} samples)`, cmp.common >= 20 && cmp.bad === 0 && ns.every((x) => x.state !== 'desync' && x.state !== 'failed'), `bad=${cmp.bad} frames ${ns.map((x) => x.roomFrames)}`);
      const wit = ns.map((x) => x.witnesses);
      ok(`the ${n} cores are LINKED on every machine (the multi-secondary ack barrier ran: ${n - 1} secondaries answer, zero incidents)`, wit.every((w) => w && w.attached === n && w.linked && w.multiRounds > 50 && w.incidents === 0 && w.recoverCount === 0), JSON.stringify(wit.map((w) => w && { rounds: w.multiRounds, irq: w.serialIrqsPerFrame })));
      report[`kirby${n}`] = { frames: ns.map((x) => x.roomFrames), samples: cmp.common };
      const errs = pageErrs(pages);
      ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// desync: a one-bit input flip on ONE machine (not over the wire) is detected within the fingerprint cadence and NAMED
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionDesync(report) {
  section('desync: flip input on ONE machine only, mid-battle; the engine must stop the room and the page must name the diverged field');
  const script = LINK['sbam-2p'].script;
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await Promise.all(pages.map(clearOrigin));
    await openAll(pages);
    await formRoom(pages, SBAM, 2);
    await Promise.all([setKeys(A, seatKeys(script, 2, 0)), setKeys(B, seatKeys(script, 2, 1))]);
    await allRunning(pages, 1);
    // wait until both are well inside the battle, then flip seat 0's LEFT on page B only, for 90 frames
    const FLIP_FROM = 4050;
    await Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().roomFrames >= ${FLIP_FROM - 120}`, { timeoutMs: 180000, pollMs: 500 })));
    const nowF = await B.eval('window.__gbaNet().frame');
    const from = nowF + 30, to = from + 90;
    await B.eval(`window.__gbaRoomTest.flip = { from: ${from}, to: ${to}, seat: 0, xor: 0x20 }; true`);
    const base = await netData(B);
    ok('precondition: no desync before the flip, chains equal so far', base.state !== 'desync' && !base.desync);
    const t0 = Date.now();
    await Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().state === 'desync'`, { timeoutMs: 60000, pollMs: 200 }).catch(() => null)));
    const det = await Promise.all(pages.map(netData));
    const detectedAt = det.map((n) => n.desync && n.desync.frame);
    ok('BOTH pages detected the divergence and stopped (engine state desync)', det.every((n) => n.state === 'desync'), `states ${det.map((n) => n.state)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const cadence = 60;
    ok(`detected within the fingerprint cadence (a sampled frame within ${cadence} frames of the first flipped frame)`, detectedAt.every((f) => f != null && f >= from && f <= to + cadence + 6), `flip frames ${from}..${to}, reported at ${detectedAt.join('/')}`);
    // the field name arrives with the detail report; give it a moment
    await Promise.all(pages.map((p) => p.waitFor(`!!(window.__gbaNet().desync && window.__gbaNet().desync.fields)`, { timeoutMs: 15000, pollMs: 200 }).catch(() => null)));
    const named = await Promise.all(pages.map(netData));
    const fields = named.map((n) => n.desync && n.desync.fields);
    ok('the report NAMES the diverged field(s) by seat/link ("seat0", "seat1", "link"), not "w1"', fields.every((f) => f && f.length > 0 && f.every((x) => /^(seat[0-3]|link)$/.test(x))), JSON.stringify(fields));
    const ui = await Promise.all(pages.map((p) => p.eval(`({ banner: document.getElementById('netDesync').textContent, on: document.getElementById('netDesync').classList.contains('on'), refusal: document.getElementById('netRefusal').textContent })`)));
    ok('the UI shows it: frame number, the named field in the PAGE\'s words ("Seat 1", "the cable link" - never "seat0"), "nothing was saved"', ui.every((u) => u.on && /Frame \d+/.test(u.banner) && /Seat \d|cable link/.test(u.banner) && !/seat\d/.test(u.banner) && /nothing was saved/i.test(u.banner)), JSON.stringify(ui[0].banner));
    const dsy = await Promise.all(pages.map((p) => p.eval(`(() => { const n = window.__gbaNet(); return { cls: document.getElementById('netStatus').className, status: document.getElementById('netStatus').textContent, endShown: document.getElementById('netEnd').style.display !== 'none', leaveLabel: document.getElementById('netLeave').textContent, running: n.running, phase: n.phase, rows: n.party.rows.filter((r) => r.who).map((r) => r.state), label: n.party.label, toasts: (window.__gbaToasts || []).filter((x) => /stopped agreeing/.test(x)).length, refusal: document.getElementById('netRefusal').textContent }; })()`)));
    ok('B2: a desynced room CONTRADICTS NOTHING: red status that says it stopped, seats read "stopped" (not "ready"), the Party label says stopped, __gbaNet().running is false, no "Finish room and save", and Leave is a SINGLE press labelled "Leave"', dsy.every((d) => d.cls === 'bad' && /stopped agreeing/.test(d.status) && d.rows.length === 2 && d.rows.every((s) => s === 'stopped') && /· stopped$/.test(d.label) && d.running === false && d.phase === 'desync' && !d.endShown && d.leaveLabel === 'Leave'), JSON.stringify(dsy[0]));
    ok('B5/B6: the refusal lists the field in the page\'s words and the error toast really fires (the old window.notify guard never did)', dsy.every((d) => /Seat \d|cable link/.test(d.refusal) && !/seat\d/.test(d.refusal) && d.toasts >= 1), JSON.stringify(dsy.map((d) => [d.toasts, d.refusal.slice(0, 120)])));
    await shot(B, 'desync_report_flipped_machine'); await shot(A, 'desync_report_other_machine');
    ok('the room stopped: no new frames after the report (both pages frozen)', await (async () => { const a = await B.eval('window.__gbaNet().roomFrames'); await sleep(1500); const b = await B.eval('window.__gbaNet().roomFrames'); return a === b; })());
    ok('the flip really was applied on machine B only (never via the wire)', (await B.eval('window.__gbaRoomTest.flip.hit')) > 0 && !(await A.eval('!!window.__gbaRoomTest.flip')));
    report.desync = { flip: [from, to], reported: detectedAt, fields };
    // ONE press of the real Leave button is enough: nothing can be saved from a stopped room, so there is nothing to confirm
    await B.eval("document.getElementById('btnNet').click(); document.getElementById('netLeave').click(); true");
    const left = await B.waitFor('!window.__gbaNet().session && window.myApp.isWasmReady', { timeoutMs: 30000, pollMs: 200 }).then(() => true, () => false);
    ok('B2: a single press of Leave leaves a desynced room and hands the page back to solo play', left);
    await A.eval('window.__gbaNet().leave(true)');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// refuse: a peer that cannot take part is refused BY NAME in the UI
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function refusalRun(label, guestSetup, hostSetup, expectCode, expectWhere, shotName, title = SBAM) {
  let out = null;
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await Promise.all(pages.map(clearOrigin));
    await openAll(pages);
    if (hostSetup) await A.eval(hostSetup);
    if (guestSetup) await B.eval(guestSetup);
    await formRoom(pages, title, 2);
    // wait for a named refusal to appear somewhere
    await Promise.all(pages.map((p) => p.waitFor(`!!window.__gbaNet().refusal`, { timeoutMs: 60000, pollMs: 300 }).catch(() => null)));
    await sleep(1200);
    const ns = await Promise.all(pages.map(netData));
    const ui = await Promise.all(pages.map((p) => p.eval(`({ box: document.getElementById('netRefusal').textContent, on: document.getElementById('netRefusal').classList.contains('on'), status: document.getElementById('netStatus').textContent, overlay: document.getElementById('netOverlay').classList.contains('on') })`)));
    await shot(A, shotName + '_host'); await shot(B, shotName + '_joiner');
    out = { ns, ui, running: ns.map((n) => n.running) };
  });
  return out;
}
async function sectionRefuse(report) {
  section('refuse: a mismatched peer is refused BY NAME (machine code + sentence) in the UI, and nobody starts');
  // untampered twin is the 'two' section: it starts. Each mutant below must not.
  const romBad = await refusalRun('wrong ROM', `window.__gbaRoomTest.romXor = [0x1000, 0x01]; true`, null, 'ROOM_ROM', 'guest', 'refuse_wrong_rom');
  ok('wrong ROM file (one byte differs): the joiner refuses itself BY NAME - ROOM_ROM - and nobody starts', romBad.ns[1].refusal && romBad.ns[1].refusal.items.some((i) => i.code === 'ROOM_ROM') && /ROOM_ROM/.test(romBad.ui[1].box) && romBad.ui[1].on && romBad.running.every((r) => !r), JSON.stringify(romBad.ns[1].refusal && romBad.ns[1].refusal.items.map((i) => i.code)));
  ok('...and the HOST is told which player could not join, by the same code', romBad.ns[0].refusal && romBad.ns[0].refusal.items.some((i) => i.code === 'ROOM_ROM') && /ROOM_ROM/.test(romBad.ui[0].box), JSON.stringify(romBad.ns[0].refusal));
  const clk = await refusalRun('wrong clock', `window.__gbaRoomTest.discTamper = ['|clk=', '|clk=9']; true`, null, 'ROOM_CLOCK', 'both', 'refuse_wrong_clock');
  ok('a peer on a different cartridge CLOCK is refused by name - ROOM_CLOCK - on BOTH pages, and nobody starts', clk.ns.every((n) => n.refusal && n.refusal.items.some((i) => i.code === 'ROOM_CLOCK')) && clk.running.every((r) => !r) && clk.ui.every((u) => /ROOM_CLOCK/.test(u.box)), JSON.stringify(clk.ns.map((n) => n.refusal && n.refusal.items.map((i) => i.code))));
  const core = await refusalRun('wrong core build', `window.__gbaRoomTest.discTamper = ['|core=', '|core=0']; true`, null, 'ROOM_CORE', 'both', 'refuse_wrong_core');
  ok('a peer on a different emulator BUILD is refused by name - ROOM_CORE', core.ns.every((n) => n.refusal && n.refusal.items.some((i) => i.code === 'ROOM_CORE')) && core.running.every((r) => !r), JSON.stringify(core.ns.map((n) => n.refusal && n.refusal.items.map((i) => i.code))));
  const st = await refusalRun('wrong save type', `window.__gbaRoomTest.discTamper = ['|st=', '|st=flash1m,']; true`, null, 'ROOM_SAVETYPE', 'both', 'refuse_wrong_savetype');
  ok('a peer on a different SAVE TYPE is refused by name - ROOM_SAVETYPE', st.ns.every((n) => n.refusal && n.refusal.items.some((i) => i.code === 'ROOM_SAVETYPE')) && st.running.every((r) => !r), JSON.stringify(st.ns.map((n) => n.refusal && n.refusal.items.map((i) => i.code))));
  const seats = await refusalRun('wrong seat count', `window.__gbaRoomTest.discTamper = ['|n=2|', '|n=3|']; true`, null, 'ROOM_SEATS', 'both', 'refuse_wrong_seats');
  ok('a peer that believes the room has a different PLAYER COUNT is refused by name - ROOM_SEATS', seats.ns.every((n) => n.refusal && n.refusal.items.some((i) => i.code === 'ROOM_SEATS')) && seats.running.every((r) => !r), JSON.stringify(seats.ns.map((n) => n.refusal && n.refusal.items.map((i) => i.code))));
  const tam = await refusalRun('tampered save chunk', `window.__gbaRoomTest.tamperEntry = { fromEnd: 3 }; true`, null, 'SAVE_TAMPERED_CHUNK', 'both', 'refuse_tampered_save', KIRBY);
  ok('a joiner whose battery image is corrupted in flight is refused BY NAME on both pages - SAVE_TAMPERED_CHUNK, with the seat and chunk - and nobody starts', tam.ns.every((n) => n.refusal && n.refusal.items.some((i) => i.code === 'SAVE_TAMPERED_CHUNK')) && tam.running.every((r) => !r), JSON.stringify(tam.ns.map((n) => n.refusal && n.refusal.items.map((i) => i.code + ': ' + i.message.slice(0, 90)))));
  report.refuse = { rom: romBad.ns.map((n) => n.refusal), clock: clk.ns.map((n) => n.refusal), tamper: tam.ns.map((n) => n.refusal) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// helpers shared by the save-shaped scenarios
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const fnvHex = (bytes) => { let h = 0x811C9DC5; for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const seedImg = (k) => Array.from({ length: 32768 }, (_, i) => (i * 7 + k * 31 + 3) & 255);
const BATKEY = KIRBY_FILE + '.mgba.sav';
const JKEY = 'gba-room-journal:' + KIRBY;
// spy on every storage write the page makes (the page's _dbPut is the ONLY write path of both the solo and the room code)
const spy = (p) => p.eval(`(() => { window.__puts = []; const o = myApp._dbPut.bind(myApp); myApp._dbPut = (k, d) => { const u = d && d.buffer && d.byteLength != null ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null; window.__puts.push({ key: k, len: u ? u.length : -1, fnv: u ? fnv1a(u).toString(16).padStart(8, '0') : null, state: (d && d.state) || null }); return o(k, d); }; return true; })()`);
const rdStored = async (p, key) => { const v = await dbRead(p, key); return v && v.len != null ? { len: v.len, fnv: v.fnv.padStart(8, '0') } : v; };
const SEED_HASH = [fnvHex(seedImg(1)), fnvHex(seedImg(2))];
async function kirbyRoom(pages, { seedBoth = true, frames = 600 } = {}) {
  await openAll(pages);
  if (seedBoth) { await dbPutBytes(pages[0], BATKEY, seedImg(1)); await dbPutBytes(pages[1], BATKEY, seedImg(2)); }
  await Promise.all(pages.map(spy));
  const code = await formRoom(pages, KIRBY, 2);
  const script = LINK['kirby-2p'].script;
  await Promise.all(pages.map((p, i) => setKeys(p, seatKeys(script, 2, i))));
  await allRunning(pages, 1);
  await Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().roomFrames >= ${frames}`, { timeoutMs: 120000, pollMs: 300 })));
  return code;
}
async function pressFinish(pages) {
  // the REAL controls: open the Party panel, press "Finish room and save" on every page
  for (const p of pages) await p.eval(`(() => { document.getElementById('btnNet').click(); const b = document.getElementById('netEnd'); if (b.style.display === 'none') throw new Error('Finish button not shown'); b.click(); return true; })()`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// save: a clean end every seat reached writes ONLY the local seat, in room.js's order; leaving any other way writes nothing
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionSave(report) {
  section('save: clean end (everyone agrees) commits ONLY the local seat\'s battery; unclean ends and "Leave without saving" write nothing');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await kirbyRoom(pages, { frames: 700 });
    const pre = await Promise.all(pages.map((p) => rdStored(p, BATKEY)));
    ok('precondition: each player has its OWN stored battery (different images), untouched by the room so far', pre[0] && pre[1] && pre[0].fnv === SEED_HASH[0] && pre[1].fnv === SEED_HASH[1] && SEED_HASH[0] !== SEED_HASH[1], JSON.stringify(pre));
    const midPuts = await Promise.all(pages.map((p) => p.eval('window.__puts.filter((x) => x.key.indexOf("mgba.sav") >= 0).length')));
    ok('NOTHING was written to a battery key while the room ran (the local seat lives in core memory only)', midPuts.every((n) => n === 0), `battery writes during play: ${midPuts.join('/')}`);
    // one player alone asks to finish: nothing happens until the OTHER agrees (a vote, not a command)
    await A.eval(`(() => { document.getElementById('btnNet').click(); document.getElementById('netEnd').click(); return true; })()`);
    await sleep(2500);
    const lone = await netData(A);
    ok('one seat asking to finish is only a VOTE: the room keeps running, nothing is saved, the panel says who it is waiting for', lone.running && lone.endPhase === 'run' && lone.phase === 'playing' && /Waiting for seat 2/.test(lone.party.barrier) && (await rdStored(A, BATKEY)).fnv === SEED_HASH[0], lone.party.barrier);
    await shot(A, 'save_waiting_for_the_other_vote');
    await pressFinish([B]);
    await Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().phase === 'saved' || window.__gbaNet().phase === 'unclean' || window.__gbaNet().phase === 'save-failed'`, { timeoutMs: 90000, pollMs: 300 })));
    const ns = await Promise.all(pages.map((p) => p.eval(`(() => { const n = window.__gbaNet(); const m = window.__gbaRoomModule; return { phase: n.phase, endPhase: n.endPhase, F: n.endF, G: n.endG, saved: n.saved, localSeat: n.localSeat, endHashes: n.endHashes, initialHashes: n.initialHashes, puts: window.__puts, status: n.party.status, journalFail: n.journal.fail }; })()`)));
    await shot(A, 'save_clean_end_host'); await shot(B, 'save_clean_end_guest');
    ok('the in-band END handshake agreed: both machines committed at the SAME frame (F, G equal), phase "saved"', ns.every((n) => n.phase === 'saved' && n.endPhase === 'commit') && ns[0].F === ns[1].F && ns[0].G === ns[1].G, `F ${ns[0].F}/${ns[1].F} G ${ns[0].G}/${ns[1].G}`);
    const differ = ns[0].endHashes[0] !== ns[0].endHashes[1];
    ok('both machines hold the SAME end-of-room images for every seat (the digest handshake compared them)', JSON.stringify(ns[0].endHashes) === JSON.stringify(ns[1].endHashes), JSON.stringify(ns.map((n) => n.endHashes)));
    info(`the two seats' final images ${differ ? 'DIFFER' : 'are IDENTICAL in this run'} (${ns[0].endHashes.join(' vs ')}); seat 1 started from ${ns[0].initialHashes[0]}, seat 2 from ${ns[0].initialHashes[1]}`);
    const stored = await Promise.all(pages.map((p) => rdStored(p, BATKEY)));
    const backup = await Promise.all(pages.map((p) => rdStored(p, BATKEY + '.pre-room')));
    const journal = await Promise.all(pages.map((p) => dbRead(p, JKEY)));
    ok('each player\'s stored battery is now THEIR OWN seat\'s final image (host = seat 1, guest = seat 2)', stored[0].fnv === ns[0].endHashes[0] && stored[1].fnv === ns[1].endHashes[1], JSON.stringify(stored));
    ok('...and a peer\'s seat image was NEVER written: every battery put on every page is this player\'s own seat (or its .pre-room backup)', ns.every((n, i) => n.puts.filter((x) => x.key === BATKEY).every((x) => x.fnv === n.endHashes[n.localSeat]) && n.puts.every((x) => [BATKEY, BATKEY + '.pre-room', JKEY].includes(x.key))), JSON.stringify(ns.map((n) => n.puts.map((x) => x.key.slice(-12) + ':' + (x.state || x.fnv)))));
    if (differ) ok('...(the seats differ, so this really distinguishes "own seat" from "someone else\'s")', stored[0].fnv !== ns[0].endHashes[1] && stored[1].fnv !== ns[1].endHashes[0]);
    ok('the previous save is kept as <key>.pre-room (one generation)', backup[0] && backup[0].fnv === SEED_HASH[0] && backup[1] && backup[1].fnv === SEED_HASH[1], JSON.stringify(backup));
    ok('the storage steps ran in room.js order: journal "committing" < backup < battery < journal "committed"', ns.every((n) => { const k = n.puts.map((x) => x.key === JKEY ? 'J:' + x.state : x.key === BATKEY ? 'BAT' : x.key === BATKEY + '.pre-room' ? 'BAK' : '?'); const s = k.join(','); return /J:staged/.test(s) && s.indexOf('J:committing') > s.indexOf('J:last-symbol') && s.indexOf('BAK') > s.indexOf('J:committing') && s.indexOf('BAT') > s.indexOf('BAK') && s.lastIndexOf('J:committed') > s.indexOf('BAT'); }), ns.map((n) => n.puts.map((x) => x.key === JKEY ? x.state : x.key.slice(-9)).join('>')).join(' | '));
    ok('the journal ends "committed" (a restarted page has nothing to recover)', journal.every((j) => j && j.record && j.record.state === 'committed'), JSON.stringify(journal.map((j) => j && j.record && j.record.state)));
    report.save = { differ, ends: ns.map((n) => n.endHashes), stored, backup };
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  });

  // ── unclean ends and the explicit "Leave without saving" ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await kirbyRoom(pages, { frames: 500 });
    // the DOM path: the real Leave button asks twice
    await B.eval(`document.getElementById('btnNet').click(); true`);
    const lab0 = await B.eval(`document.getElementById('netLeave').textContent`);
    await B.eval(`document.getElementById('netLeave').click(); true`);
    const mid = await B.eval(`({ label: document.getElementById('netLeave').textContent, stillThere: !!window.__gbaNet().session, status: document.getElementById('netStatus').textContent })`);
    await shot(B, 'leave_confirm_without_saving');
    ok('"Leave without saving" is an EXPLICIT choice: the first press only arms it and says nothing will be written', lab0 === 'Leave without saving' && mid.stillThere && /Really leave/.test(mid.label) && /Nothing from this room is written/.test(mid.status), JSON.stringify({ lab0, mid }));
    await B.eval(`document.getElementById('netLeave').click(); true`);
    await B.waitFor(`!window.__gbaNet().session && window.myApp.isWasmReady`, { timeoutMs: 30000 });
    const after = await netData(B);
    ok('the second press leaves: solo play is back (core re-created, Start enabled, roomLocked false)', !after.roomLocked && !after.session && (await B.eval(`!document.getElementById('btnStart').disabled`)), `phase ${after.phase}`);
    // the other player sees the seat drop; the room plays on; it cannot end cleanly any more
    await A.waitFor(`/dropped out/.test(window.__gbaNet().party.barrier) || /dropped out/.test(document.getElementById('netHud').textContent)`, { timeoutMs: 30000, pollMs: 400 }).catch(() => null);
    const fA0 = await A.eval('window.__gbaNet().roomFrames'); await sleep(2000); const fA1 = await A.eval('window.__gbaNet().roomFrames');
    ok('the room PLAYS ON for the player who stayed (the leaver\'s controller goes neutral at an agreed frame)', fA1 - fA0 > 60, `+${fA1 - fA0} frames in 2 s`);
    await shot(A, 'leave_other_player_plays_on');
    await A.eval('window.__gbaNet().leave(true)');
    await sleep(500);
    const st = await Promise.all(pages.map((p) => rdStored(p, BATKEY)));
    const jr = await Promise.all(pages.map((p) => dbRead(p, JKEY)));
    ok('NEITHER player\'s save changed (the leaver left explicitly; the other left without a clean end)', st[0].fnv === SEED_HASH[0] && st[1].fnv === SEED_HASH[1], JSON.stringify(st));
    ok('...and no storage write touched a battery key at all', (await Promise.all(pages.map((p) => p.eval('window.__puts.filter((x) => x.key.indexOf("mgba.sav") >= 0).length')))).every((n) => n === 0));
    ok('...and no journal record was left behind (the room never began to end)', jr.every((j) => j === null), JSON.stringify(jr));
    control('the "unchanged" check can fail: an image that differs from the seed is read as different', fnvHex(seedImg(3)) !== SEED_HASH[0]);
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// recover: a page that died between two storage steps of the commit (and the in-doubt window) is repaired at its next start
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function crashRun(limits, choose) {
  const out = [];
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    await kirbyRoom(pages, { frames: 700 });
    await Promise.all(pages.map((p, i) => p.eval(`window.__gbaRoomTest.commitLimit = ${limits[i]}; true`)));
    await pressFinish(pages);
    // a crashed page never reaches 'saved': wait for the machines to commit (the engine's end), then for the writes to stop
    await Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().endPhase === 'commit'`, { timeoutMs: 90000, pollMs: 300 })));
    await sleep(2500);
    const pre = await Promise.all(pages.map((p) => p.eval(`({ saved: window.__gbaNet().saved, hashes: window.__gbaNet().endHashes, local: window.__gbaNet().localSeat })`)));
    const mid = await Promise.all(pages.map(async (p) => ({ bat: await rdStored(p, BATKEY), bak: await rdStored(p, BATKEY + '.pre-room'), j: (await dbRead(p, JKEY)) })));
    // KILL the page (navigate the window away: nothing of it survives) and bring it back as a plain page start
    for (let i = 0; i < 2; i++) {
      const p = pages[i];
      await p.navigate(URLQ('', p.dbName));
      // the in-doubt dialog BLOCKS roomRecover() until the player answers, so `recovery` appears only after the click
      if (!choose[i]) await p.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.__gbaNet().recovery)', { timeoutMs: 60000, pollMs: 300 });
      if (choose[i]) {
        await p.waitFor('!!(window.__gbaNet && window.__gbaNet().supported)', { timeoutMs: 60000, pollMs: 300 });
        await p.waitFor(`document.getElementById('netRecover').classList.contains('on')`, { timeoutMs: 30000, pollMs: 200 });
        await shot(p, `recover_in_doubt_${i}`);
        const text = await p.eval(`document.getElementById('netRecoverText').textContent`);
        out[i] = { asked: text };
        await p.eval(`document.getElementById(${JSON.stringify(choose[i] === 'apply' ? 'netRecoverApply' : 'netRecoverKeep')}).click(); true`);
        await p.waitFor('!!(window.__gbaNet && window.__gbaNet().recovery)', { timeoutMs: 30000, pollMs: 300 });
        await sleep(600);
      }
      const rec = await p.eval('window.__gbaNet().recovery');
      const after = { bat: await rdStored(p, BATKEY), bak: await rdStored(p, BATKEY + '.pre-room'), j: await dbRead(p, JKEY) };
      out[i] = Object.assign(out[i] || {}, { limit: limits[i], pre: pre[i], mid: mid[i], rec, after });
    }
  });
  return out;
}
async function sectionRecover(report) {
  section('recover: a page killed BETWEEN storage steps of the commit is repaired at its next start; the in-doubt window asks the player');
  const r1 = await crashRun([1, 3], [null, null]);
  const [a1, b1] = r1;
  info(`run 1 end states: host stopped after ${a1.pre.saved && a1.pre.saved.steps} of ${a1.pre.saved && a1.pre.saved.of} steps, guest after ${b1.pre.saved && b1.pre.saved.steps} of ${b1.pre.saved && b1.pre.saved.of}`);
  const finalOf = (r) => r.pre.hashes[r.pre.local];
  ok('precondition: the room produced a final image that differs from the seed (so there IS a commit to interrupt)', a1.pre.saved && a1.pre.saved.of === 4 && b1.pre.saved && b1.pre.saved.of === 4, JSON.stringify([a1.pre.saved, b1.pre.saved]));
  ok('crash after step 1 (only the journal "committing" record exists): the battery is UNTOUCHED at the moment of death', a1.mid.bat.fnv === SEED_HASH[0] && a1.mid.j.record.state === 'committing', JSON.stringify([a1.mid.bat, a1.mid.j.record && a1.mid.j.record.state]));
  ok('...and at the next start the page FINISHES the commit: battery = this seat\'s final image, backup = the old save, journal closed', a1.rec.length === 1 && a1.rec[0].action === 'finish-commit' && a1.rec[0].outcome === 'completed' && a1.after.bat.fnv === finalOf(a1) && a1.after.bak.fnv === SEED_HASH[0] && a1.after.j.record.state === 'committed', JSON.stringify(a1.rec));
  ok('crash after step 3 (battery already written, journal still "committing"): the next start writes NOTHING more - it does not copy the new value over the backup - and closes the record', b1.mid.bat.fnv === finalOf(b1) && b1.rec[0].outcome === 'already-written' && b1.after.bat.fnv === finalOf(b1) && b1.after.bak.fnv === SEED_HASH[1] && b1.after.j.record.state === 'committed', JSON.stringify([b1.mid.bat, b1.rec]));
  const r2 = await crashRun([0, 2], ['apply', null]);
  const [a2, b2] = r2;
  ok('crash before any commit step (the journal holds the in-doubt "last-symbol" record): at the next start the player is ASKED, with the documented wording', typeof a2.asked === 'string' && /may have kept its result/.test(a2.asked) && /pre-room/.test(a2.asked), JSON.stringify(a2.asked));
  ok('...choosing "Use the room\'s result" completes the commit (final image stored, old save backed up)', a2.rec.length === 1 && a2.rec[0].asked === true && a2.after.bat.fnv === finalOf(a2) && a2.after.bak.fnv === SEED_HASH[0] && a2.after.j.record.state === 'committed', JSON.stringify(a2.rec));
  ok('crash after step 2 (backup written, battery not yet): the next start completes it without asking', b2.mid.bat.fnv === SEED_HASH[1] && b2.mid.bak && b2.rec[0].action === 'finish-commit' && b2.rec[0].asked === false && b2.after.bat.fnv === finalOf(b2) && b2.after.j.record.state === 'committed', JSON.stringify([b2.mid, b2.rec]));
  report.recover = { run1: [a1.rec, b1.rec], run2: [a2.rec, b2.rec] };

  // ── the in-doubt record, "keep my save", and a damaged record, on a page started cold ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 1 }, async ({ pages }) => {
    const [A] = pages;
    A.dbName = 'pR';
    await A.navigate(URLQ('', 'pR'));
    await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.__gbaNet().recovery)', { timeoutMs: 60000 });
    const seed = seedImg(5), fin = Array.from({ length: 32768 }, (_, i) => (i * 3 + 9) & 255);
    const mkRec = (extra) => A.eval(`(async () => { const R = window.__gbaRoomModule; const ini = new Uint8Array(${JSON.stringify(seed)}), fin = new Uint8Array(${JSON.stringify(fin)});
      const rec = Object.assign({ state: 'last-symbol', room: '0123456789abcdef', seat: 0, source: 'stored', initialHash: R.cardHash(ini), F: 99, digest: [1, 2, 3, 4], image: fin, imageHash: R.cardHash(fin) }, ${JSON.stringify(extra || {})});
      const db = await new Promise((res, rej) => { const r = indexedDB.open('GBAWASMDB-test-pR'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      await new Promise((res, rej) => { const tx = db.transaction('GBAWASMSTATES', 'readwrite'); const s = tx.objectStore('GBAWASMSTATES'); s.put(ini, ${JSON.stringify(BATKEY)}); s.delete(${JSON.stringify(BATKEY + '.pre-room')}); s.put(rec, ${JSON.stringify(JKEY)}); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      db.close(); return true; })()`);
    const restart = async (choice) => {
      await A.navigate(URLQ('', 'pR'));
      await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported)', { timeoutMs: 60000 });
      if (choice) { await A.waitFor(`document.getElementById('netRecover').classList.contains('on')`, { timeoutMs: 20000, pollMs: 200 }); await A.eval(`document.getElementById(${JSON.stringify(choice === 'apply' ? 'netRecoverApply' : 'netRecoverKeep')}).click(); true`); await sleep(1000); }
      else await sleep(1500);
      return { rec: await A.eval('window.__gbaNet().recovery'), bat: await rdStored(A, BATKEY), bak: await rdStored(A, BATKEY + '.pre-room'), j: await dbRead(A, JKEY), shown: await A.eval(`document.getElementById('netRecover').classList.contains('on')`) };
    };
    await mkRec();
    const keep = await restart('discard');
    ok('in-doubt + "Keep my save as it was": the stored save is untouched, the record is closed "aborted", no backup is made', keep.bat.fnv === fnvHex(seed) && !keep.bak && keep.j.record.state === 'aborted' && keep.rec[0].asked === true, JSON.stringify([keep.bat, keep.j.record && keep.j.record.state]));
    await mkRec();
    const apply = await restart('apply');
    ok('in-doubt + "Use this room\'s result": the final image is stored and the old save is kept as .pre-room', apply.bat.fnv === fnvHex(fin) && apply.bak && apply.bak.fnv === fnvHex(seed) && apply.j.record.state === 'committed', JSON.stringify([apply.bat, apply.bak]));
    await mkRec({ imageHash: 'deadbeef' });
    const bad = await restart(null);
    ok('a DAMAGED record (its image does not match its own hash) writes nothing and says so', bad.bat.fnv === fnvHex(seed) && bad.rec[0].action === 'journal-invalid' && !bad.shown, JSON.stringify(bad.rec));
    await mkRec({ state: 'staged', image: null });
    const staged = await restart(null);
    ok('a "staged" record (the page died before its last digest symbol left, so no peer can have committed) is DISCARDED: the save is untouched, the record is closed "aborted", nobody is asked', staged.rec[0].action === 'discard' && staged.bat.fnv === fnvHex(seed) && staged.j.record.state === 'aborted' && !staged.shown, JSON.stringify(staged.rec));
    control('a record the page must act on really does change storage (the apply run above differs from the keep run)', apply.bat.fnv !== keep.bat.fnv);
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// kill: a peer killed mid-session comes back and is REPLAYED into the room (the rsReplay decision), saves untouched
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionKill(report) {
  section('kill: the guest\'s page dies mid-room; the room plays on; the same player reloads and is replayed into it (rsReplay), fingerprints equal, save untouched');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    const code = await kirbyRoom(pages, { frames: 600 });
    const col = chainCollector(pages);
    await col.poll();
    const fA0 = await A.eval('window.__gbaNet().roomFrames');
    // KILL: the window navigates away (pagehide -> the engine tells the host); nothing of the page survives
    await B.navigate('about:blank');
    await sleep(500);
    await shot(A, 'kill_host_after_guest_died');
    await sleep(7000);
    const fA1 = await A.eval('window.__gbaNet().roomFrames');
    const hostNow = await netData(A);
    ok('the room PLAYS ON without the dead page (the host kept running; the seat is dropped, its pad neutral)', fA1 - fA0 > 300 && hostNow.state !== 'desync' && hostNow.state !== 'failed', `+${fA1 - fA0} frames in ~7.5 s, state ${hostNow.state}`);
    ok('the host SAYS so, by seat (never a peer id)', /Seat 2 dropped out/.test(hostNow.party.barrier + ' ' + (await A.eval(`document.getElementById('netHud').textContent`))), hostNow.party.barrier);
    // the same player comes back: same window, so the same identity; the invitation link is what they would click
    await B.navigate(URLQ(`&np=${code}&game=${encodeURIComponent(KIRBY)}&join=1`, B.dbName));
    await B.waitFor('!!(window.__gbaNet && window.__gbaNet().supported)', { timeoutMs: 60000 });
    const asked = await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 6000, pollMs: 250 }).then(() => true).catch(() => false);
    if (asked) await A.eval(`document.getElementById('npApproveAllow').click(); true`);
    info(`the host was ${asked ? '' : 'NOT '}asked to Allow the returning player a second time`);
    const t0 = Date.now();
    await B.waitFor(`window.__gbaNet().running`, { timeoutMs: 90000, pollMs: 300 });
    const sawRejoin = await B.eval(`window.__gbaNet().party.barrier + ' | ' + document.getElementById('netHud').textContent`);
    await B.waitFor(`window.__gbaNet().roomFrames > 0 && Math.abs(window.__gbaNet().frame - ${0}) >= 0`, { timeoutMs: 30000 });
    // catch up: B's frame counter must reach the room's
    const caught = await (async () => { for (let i = 0; i < 120; i++) { const [a, b] = await Promise.all([A, B].map((p) => p.eval('window.__gbaNet().frame'))); if (Math.abs(a - b) <= 12) return { a, b, secs: (Date.now() - t0) / 1000 }; await sleep(500); } return null; })();
    ok('the returning page is REPLAYED into the room: it re-simulated the match from frame 0 and is level with the room', !!caught, JSON.stringify(caught));
    await sleep(6000); await col.poll();
    const [na, nb] = await Promise.all(pages.map(netData));
    ok('the replay reproduced the match: BOTH pages agree on every fingerprint, including the frames the new page replayed hidden, and the engine reports no desync', na.state !== 'desync' && nb.state !== 'desync' && !nb.desync && (nb.engine && nb.engine.hashesCompared > 5), `A ${na.state}/${na.roomFrames}, B ${nb.state}/${nb.roomFrames}, compared ${nb.engine && nb.engine.hashesCompared}`);
    // fingerprints of the NEW page cover the whole match: its chain (frames from 0) must equal the host's on every common frame
    const colB = chainCollector([A, B]); await colB.poll();
    const cmp = compareChains(colB.maps);
    ok(`the new page's fingerprints for frames ${cmp.first}..${cmp.last} equal the host's (${cmp.common} samples)`, cmp.common >= 10 && cmp.bad === 0 && cmp.first <= 60, `bad=${cmp.bad} first=${cmp.first}`);
    await shot(B, 'kill_returned_player'); await shot(A, 'kill_host_after_return');
    ok('the returning page used the room\'s AGREED saves, not a fresh contribution (it did not re-contribute into a running room)', await B.eval('window.__gbaNet().phase') === 'playing' && (await B.eval('window.__gbaNet().returning')) === true, String(await B.eval('window.__gbaNet().returning')));
    // after the replay the guest runs at 1.000x again
    const rate = await B.eval(`(async () => { const hz = 16777216 / 280896, f0 = window.__gbaNet().roomFrames, t0 = performance.now(); await new Promise((r) => setTimeout(r, 10000)); return (((window.__gbaNet().roomFrames - f0) / ((performance.now() - t0) / 1000)) / hz); })()`);
    ok('GATE 9: once caught up the returned page runs at 1.000x (not above)', rate >= 0.95 && rate <= 1.02, rate.toFixed(4) + 'x');
    const stored = await Promise.all(pages.map((p) => rdStored(p, BATKEY)));
    ok('the killed player\'s save was NOT corrupted or changed by dying, rejoining, or replaying', stored[1].fnv === SEED_HASH[1] && stored[0].fnv === SEED_HASH[0], JSON.stringify(stored));
    report.kill = { catchUp: caught, rate, rejoinText: sawRejoin };
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
  // ── the same player's page dies BEFORE the room starts (while it is loading): the host's barrier waits, the player comes back, the room starts ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await Promise.all(pages.map(spy));
    const code = await formRoom(pages, KIRBY, 2);
    await B.navigate('about:blank');                       // killed straight after being seated: loading / exchanging
    await sleep(1500);
    const hostWait = await netData(A);
    ok('while the guest\'s page is dead BEFORE the start, the host waits at the barrier (nothing runs, nothing is refused)', !hostWait.running && hostWait.state !== 'failed' && !hostWait.refusal, `phase ${hostWait.phase} state ${hostWait.state} barrier "${hostWait.party.barrier}" refusal ${JSON.stringify(hostWait.refusal)} cannot ${hostWait.cannot} running ${hostWait.running}`);
    ok('B8 wording: while the host waits at the barrier its OWN seat row reads "loaded", not "connecting" (its own load is done)', /^(loaded|ready)$/.test((hostWait.party.rows.find((r) => r.local) || {}).state || ''), JSON.stringify(hostWait.party.rows));
    await B.navigate(URLQ(`&np=${code}&game=${encodeURIComponent(KIRBY)}&join=1`, B.dbName));
    await B.waitFor('!!(window.__gbaNet && window.__gbaNet().supported)', { timeoutMs: 60000 });
    const asked = await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 6000, pollMs: 250 }).then(() => true).catch(() => false);
    if (asked) await A.eval(`document.getElementById('npApproveAllow').click(); true`);
    const script = LINK['kirby-2p'].script;
    await Promise.all(pages.map((p, i) => setKeys(p, seatKeys(script, 2, i))));
    await allRunning(pages, 200);
    const col = chainCollector(pages); await sleep(8000); await col.poll();
    const cmp = compareChains(col.maps), ns = await Promise.all(pages.map(netData));
    ok('the returned player is seated again and the room STARTS: both pages run, fingerprints equal, no desync', ns.every((n) => n.running && n.state !== 'desync') && cmp.common >= 3 && cmp.bad === 0, `samples ${cmp.common} bad ${cmp.bad} frames ${ns.map((n) => n.roomFrames)} (host asked to Allow again: ${asked})`);
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// leave: the link master (the host) leaves -> the room ends by a NAMED rule
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionLeave(report) {
  section('leave: when the HOST (seat 1, the SIO master) leaves, the room ends for everyone by a NAMED rule and nobody\'s save changes');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages, closeWindow }) => {
    const [A, B] = pages;
    await kirbyRoom(pages, { frames: 400 });
    await closeWindow(A);                                   // the host's window is closed: no goodbye but the pagehide
    await B.waitFor(`!!window.__gbaNet().closedWhy || !window.__gbaNet().session`, { timeoutMs: 60000, pollMs: 400 });
    await sleep(1500);
    const n = await netData(B);
    const ui = await B.eval(`({ status: document.getElementById('netStatus').textContent, refusal: document.getElementById('netRefusal').textContent })`);
    await shot(B, 'leave_host_left_guest_view');
    ok('the guest is told by name: "the host left, so the room is over" (ROOM_HOST_LEFT) and that nothing was saved', /ROOM_HOST_LEFT/.test(ui.refusal + ui.status) && /Nothing was saved/.test(ui.refusal + ui.status), JSON.stringify(ui));
    ok('the page is back in solo play: core re-created, roomLocked false, Start enabled, no session', !n.roomLocked && !n.session && (await B.eval(`!document.getElementById('btnStart').disabled`)), `phase ${n.phase}`);
    ok('the guest\'s save is untouched', (await rdStored(B, BATKEY)).fnv === SEED_HASH[1]);
    // solo play really works again, on a fresh core
    await B.eval(`(async () => { document.getElementById('romSelect').selectedIndex = [...document.getElementById('romSelect').options].findIndex((o) => /Super Bust/.test(o.textContent)); await myApp.startFromList(); return true; })()`);
    await B.waitFor('window.myApp.isRunning && window.myApp.frameCnt > 60', { timeoutMs: 60000 });
    ok('solo play works again after the room (a Super Bust-A-Move core runs frames; no room state left)', !(await B.eval('myApp.roomLocked')) && !(await B.eval('!!myApp.roomHandle')));
    report.leave = { ui };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// boot: the page's error path when the linked cores cannot be allocated (a phone with little memory)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionBoot(report) {
  section('boot: when the linked cores cannot be allocated the page says so, by name, and solo play still works');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await B.eval(`(() => { const o = window.MgbaCore.create; window.MgbaCore.create = async (opts) => { if (opts && opts.seats >= 2) throw new RangeError('WebAssembly.Memory(): could not allocate memory'); return o(opts); }; return true; })()`);
    await formRoom(pages, SBAM, 2);
    await Promise.all(pages.map((p) => p.waitFor(`!!window.__gbaNet().refusal`, { timeoutMs: 60000, pollMs: 300 }).catch(() => null)));
    await sleep(1500);
    const ns = await Promise.all(pages.map(netData));
    const ui = await B.eval(`({ box: document.getElementById('netRefusal').textContent, status: document.getElementById('netStatus').textContent })`);
    await shot(B, 'boot_failure_guest'); await shot(A, 'boot_failure_host');
    ok('the guest names the failure (CORE_BOOT_FAILED + the reason + what a low-memory phone should expect)', /CORE_BOOT_FAILED/.test(ui.box) && /could not allocate memory/.test(ui.box) && /memory/i.test(ui.box), JSON.stringify(ui.box));
    ok('the HOST is told which player could not start, by the same code', ns[0].refusal && ns[0].refusal.items.some((i) => i.code === 'CORE_BOOT_FAILED'), JSON.stringify(ns[0].refusal));
    ok('nobody started, and the guest page is back to a usable solo state (core ready, Start enabled)', ns.every((n) => !n.running) && (await B.eval('window.myApp.isWasmReady && !window.myApp.roomLocked && !document.getElementById("btnStart").disabled')), JSON.stringify(ns.map((n) => n.phase)));
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// mobile: the same flow on a 390x844 phone viewport (emulation: Chrome's engine, not WebKit)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionMobile(report) {
  section('mobile: Party on a 390x844 touch viewport (and 320x568): reachable, 44 px targets, no horizontal scroll, the room plays on the SP shell');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 1 }, async ({ pages, openWindow }) => {
    const [A] = pages;
    A.dbName = 'pA';
    const B = await openWindow({ width: 390, height: 844, mobile: true });
    B.dbName = 'pB';
    await A.navigate(URLQ('', 'pA')); await A.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp.isWasmReady)', { timeoutMs: 60000 });
    await B.navigate(URLQ('', 'pB')); await B.waitFor('!!(window.__gbaNet && window.__gbaNet().supported && window.myApp.isWasmReady)', { timeoutMs: 60000 });
    ok('the phone viewport got the touch shell (mobileMode) and a visible Party button on the splash', await B.eval(`window.myApp.mobileMode && document.getElementById('mobileSplashNet').offsetWidth > 0 && !document.getElementById('mobileSplashNet').hidden`));
    await shot(B, 'mobile_splash_with_party');
    const code = await hostOpen(A, SBAM, 2);
    await B.eval(`document.getElementById('mobileSplashNet').click(); document.getElementById('netJoinBtn').click(); document.getElementById('netCodeIn').value = ${JSON.stringify(code)}; true`);
    await shot(B, 'mobile_join_panel');
    const targets = async (p) => p.eval(`(() => { const out = []; document.querySelectorAll('#netBox button, #netBox select, #netBox input').forEach((e) => { const r = e.getBoundingClientRect(); if (r.width > 0 && getComputedStyle(e).display !== 'none') out.push({ id: e.id, w: Math.round(r.width), h: Math.round(r.height) }); }); return { small: out.filter((x) => x.h < 44 || x.w < 44), n: out.length, scrollX: document.documentElement.scrollWidth - window.innerWidth }; })()`);
    const t390 = await targets(B);
    ok('every control in the Party panel is at least 44x44 CSS px on a 390x844 phone, with no horizontal scroll', t390.small.length === 0 && t390.scrollX <= 0, JSON.stringify(t390));
    await B.eval(`document.getElementById('netGo').click(); true`);
    await admit(A, 1);
    await B.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000 });
    const script = LINK['sbam-2p'].script;
    await Promise.all([setKeys(A, seatKeys(script, 2, 0)), setKeys(B, seatKeys(script, 2, 1))]);
    await Promise.all([A, B].map((p) => p.waitFor(`window.__gbaNet().running && window.__gbaNet().roomFrames > 120`, { timeoutMs: 120000, pollMs: 300 })));
    await B.eval(`document.getElementById('mobileSplash').style.display`);
    await sleep(1500);
    await shot(B, 'mobile_in_room');
    const inRoom = await B.eval(`({ splash: getComputedStyle(document.getElementById('mobileSplash')).display, shell: getComputedStyle(document.getElementById('mobileShell')).display, canvasInShell: !!document.querySelector('#mobileScreen canvas'), mNet: !document.getElementById('mNet').hidden, scrollX: document.documentElement.scrollWidth - window.innerWidth, label: window.__gbaNet().party.label })`);
    ok('on the phone the SP touch shell shows the room (splash gone, canvas in #mobileScreen), the menu has a Party entry, no horizontal scroll', inRoom.splash === 'none' && inRoom.shell === 'flex' && inRoom.canvasInShell && inRoom.mNet && inRoom.scrollX <= 0, JSON.stringify(inRoom));
    await B.eval(`document.getElementById('mobileMenuBtn').click(); true`);
    await shot(B, 'mobile_menu_in_room');
    const menu = await B.eval(`({ open: document.getElementById('mobileMenu').classList.contains('open'), save: document.getElementById('mSave').disabled, speed: document.getElementById('mSpeed').disabled, reset: document.getElementById('mReset').disabled, imp: document.getElementById('mImportSav').disabled, party: document.getElementById('mNet').offsetWidth > 0 })`);
    const mnH = await B.eval(`Math.round(document.getElementById('mNet').getBoundingClientRect().height)`);
    ok('B9: the touch menu\'s Party entry (this page\'s own control) is a full 44 px target (the family\'s hamburger keeps the family size)', mnH >= 44, mnH + ' px');
    ok('the touch menu in a room: Party present; Save State / Reset / Import / Speed are disabled (solo-only)', menu.open && menu.save && menu.speed && menu.reset && menu.imp && menu.party, JSON.stringify(menu));
    await B.eval(`document.getElementById('mNet').click(); true`);
    await sleep(400);
    await shot(B, 'mobile_party_panel_in_room');
    const t2 = await targets(B);
    ok('the in-room Party panel (Finish / Leave / Close) keeps 44 px targets on the phone', t2.small.length === 0 && t2.scrollX <= 0, JSON.stringify(t2));
    await B.setViewport(320, 568, { mobile: true });
    await sleep(600);
    await shot(B, 'mobile_party_panel_320x568');
    const t320 = await targets(B);
    ok('...and at 320x568: still 44 px targets and no horizontal scroll', t320.small.length === 0 && t320.scrollX <= 0, JSON.stringify(t320));
    await B.setViewport(844, 390, { mobile: true });
    await sleep(600);
    await shot(B, 'mobile_party_panel_landscape_844x390');
    const tL = await targets(B);
    ok('...and in LANDSCAPE (844x390): the panel scrolls inside the viewport (no horizontal scroll, 44 px targets)', tL.small.length === 0 && tL.scrollX <= 0, JSON.stringify(tL));
    await B.eval('document.getElementById("netClose").click(); true'); await sleep(400);
    await shot(B, 'mobile_in_room_landscape_844x390');
    await B.setViewport(390, 844, { mobile: true });
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
    report.mobile = { t390, t320 };
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// speed: nothing the page exposes moves the guest above 1.000x inside a room
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
async function sectionSpeed(report) {
  section('speed: query parameters, hotkeys and devtools-callable functions cannot make a room run faster than 1.000x (gate 9)');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages, '&speed=5&fps=240&uncap=1&gamespeed=5&turbo=1');
    const code = await formRoom(pages, SBAM, 2);
    await allRunning(pages, 60);
    // hotkeys: every key a speed feature could plausibly use, plus the page's own speed entry points
    // REAL keys reach the RIGHT seat: B (seat 2) holds the A button for 1.2 s; the bytes the cores were handed show it at seat 2's word only
    const seen = B.eval(`(async () => { let s0 = 0, s1 = 0; const t0 = performance.now(); while (performance.now() - t0 < 2200) { const im = window.__gbaNet().image; if (im) { if (im[0] & 1) s0++; if (im[4] & 1) s1++; } await new Promise((r) => setTimeout(r, 8)); } return { s0, s1 }; })()`);
    await sleep(300); await B.press('m', 'KeyM', 77, 1200);
    const keyed = await seen;
    ok('a REAL keypress (m = A) on the guest page reaches the guest\'s OWN seat (seat 2) in the input image the cores were handed, and never seat 1', keyed.s1 > 20 && keyed.s0 === 0, JSON.stringify(keyed));
    for (const k of ['+', '=', ']', 'Tab', 'f', 'F', 'Shift', 'PageUp', ' ']) { await B.press(k, k.length === 1 ? 'Key' + k.toUpperCase() : k, 0, 30); }
    const calls = await B.eval(`(() => { const r = []; r.push(myApp.setGameSpeed(5)); r.push(myApp.setGameSpeed(2)); myApp.cycleSpeed(); myApp.cycleSpeed(); myApp.gameSpeed = 5; document.getElementById('mSpeed').click(); return { returns: r, gameSpeedNow: myApp.gameSpeed, locked: myApp.roomLocked }; })()`);
    const rate = (p) => p.eval(`(async () => { const hz = 16777216 / 280896, f0 = window.__gbaNet().roomFrames, t0 = performance.now(); await new Promise((r) => setTimeout(r, 12000)); return (((window.__gbaNet().roomFrames - f0) / ((performance.now() - t0) / 1000)) / hz); })()`);
    const load = cpuLoad();
    const rates = await Promise.all(pages.map(rate));
    ok('with ?speed=5&fps=240&uncap=1&gamespeed=5&turbo=1, a dozen hotkeys, setGameSpeed(5/2), cycleSpeed() x2, gameSpeed=5 and the menu button, the guest still runs at 1.000x on BOTH pages', rates.every((x) => x >= 0.97 && x <= 1.02), `${rates.map((x) => x.toFixed(4) + 'x').join(' / ')} (Windows CPU busy ${load}%)  calls=${JSON.stringify(calls)}`);
    ok('...and the page itself refused every speed call (all returned false while roomLocked)', calls.returns.every((r) => r === false) && calls.locked);
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
    // the control: on a SOLO page (no room) the same call is ACCEPTED, so the lock is what refused it
    await A.waitFor('window.myApp.isWasmReady', { timeoutMs: 30000 });
    const solo = await A.eval(`(() => { const r = myApp.setGameSpeed(5); const s = myApp.gameSpeed; myApp.setGameSpeed(1); return { accepted: r, speed: s }; })()`);
    control('without a room the SAME setGameSpeed(5) is accepted (speed 5): it is roomLocked, nothing else, that held the room at 1x', solo.accepted === true && solo.speed === 5, JSON.stringify(solo));
    report.speed = { rates, calls, solo };
  });
  // a SLOW peer slows the room; nobody sprints (Kirby: ~3 ms a frame x6 = more than a 16.7 ms frame; a CPU throttle is a stand-in, not a phone)
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await kirbyRoom(pages, { frames: 200 });
    const rate = (p) => p.eval(`(async () => { const hz = 16777216 / 280896, f0 = window.__gbaNet().roomFrames, t0 = performance.now(); await new Promise((r) => setTimeout(r, 12000)); return (((window.__gbaNet().roomFrames - f0) / ((performance.now() - t0) / 1000)) / hz); })()`);
    const base = await Promise.all(pages.map(rate));
    await B.send('Emulation.setCPUThrottlingRate', { rate: 8 });
    const load = cpuLoad();
    const slow = await Promise.all(pages.map(rate));
    const stalledA = await A.eval('window.__gbaNet().engine && window.__gbaNet().engine.stalls');
    await B.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const errs = pageErrs(pages);
    ok('with page B CPU-throttled 8x (a STAND-IN for a slow phone, not a device), NEITHER page runs faster than 1.000x: the room waits for the slow console (a stall never sprints)', slow.every((x) => x <= 1.02) && base.every((x) => x >= 0.97 && x <= 1.02), `unthrottled ${base.map((x) => x.toFixed(3) + 'x').join('/')} -> throttled ${slow.map((x) => x.toFixed(3) + 'x').join('/')}; host stalls counted by the engine: ${JSON.stringify(stalledA)}; Windows CPU busy ${load}%`);
    info(slow.some((x) => x < 0.95) ? 'the room ran SLOWER than hardware while it waited for the throttled peer (allowed: gate 9 forbids faster, never slower)' : 'the throttled peer still held 1.000x at this throttle, so nothing had to wait');
    ok('no page errors under throttle', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
    report.throttle = { base, slow };
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
}

async function sectionRedirect(report) {
  section('redirect: /gba_multiplayer.html?np=... lands on gba.html with the whole hand-off intact, and the page reads it');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 1 }, async ({ pages }) => {
    const [A] = pages;
    await A.navigate(`${BASE}/gba_multiplayer.html?np=ABCD2&game=${encodeURIComponent(KIRBY)}&join=1&net=local&roomtest=1`);
    await A.waitFor(`location.pathname === '/gba.html' && !!(window.__gbaNet && window.__gbaNet().supported)`, { timeoutMs: 60000 });
    const r = await A.eval(`({ search: location.search, handoff: window.__gbaNet().handoff, codeIn: document.getElementById('netCodeIn').value, panel: document.getElementById('netOverlay').classList.contains('on') })`);
    ok('the redirect kept np, game, join and net; the page parsed the hand-off, filled the code and opened the panel on the JOIN side', /np=ABCD2/.test(r.search) && /join=1/.test(r.search) && /net=local/.test(r.search) && r.handoff && r.handoff.code === 'ABCD2' && r.handoff.join === true && r.handoff.game === KIRBY && r.codeIn === 'ABCD2' && r.panel, JSON.stringify(r));
    await A.navigate(`${BASE}/gba_multiplayer.html?np=ZZZZ&roomtest=1`);
    await sleep(2500);
    const bad = await A.eval('location.pathname + location.search');
    ok('a malformed code is NOT carried (a bare redirect to /gba.html)', /^\/gba\.html(\?roomtest|$)/.test(bad) || bad === '/gba.html' || !/np=/.test(bad), bad);
  });
}
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// GR2 FIX ROUND sections: M1 audio, M2 bind, B1 alloc, B2-B8 ux
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const encU = encodeURIComponent;
// the sound state of a page, read through the seam (the AudioContext, the hint pill, the sink's counter)
const audioOf = (p) => p.eval(`(() => { const n = window.__gbaNet(); const h = document.getElementById('netSoundHint'); return { ctx: n.audio.ctx, hint: n.audio.hint, hintText: h ? h.textContent : null, hintVisible: !!(h && h.style.display !== 'none' && h.offsetWidth > 0), rx: n.audio.rxFrames, label: n.party.label, running: n.running }; })()`);
const rxPerGuestSec = (p, ms = 6000) => p.eval(`(async () => { const hz = 16777216 / 280896, a0 = (window.__cartAudio || {}).rxFrames | 0, f0 = window.__gbaNet().roomFrames; await new Promise((r) => setTimeout(r, ${ms})); const a1 = (window.__cartAudio || {}).rxFrames | 0, f1 = window.__gbaNet().roomFrames; return (a1 - a0) / ((f1 - f0) / hz); })()`);

async function sectionAudio(report) {
  section('audio (M1): a joiner who arrives by INVITATION LINK, and a reloaded rejoiner, never click Party - the sound must still start on their first touch of the page');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    const code = await hostOpen(A, KIRBY, 2);
    const link = URLQ(`&np=${code}&game=${encU(KIRBY)}&join=1`, B.dbName);
    const goLive = async () => {
      await B.navigate(link);
      await B.waitFor('!!(window.__gbaNet && window.__gbaNet().supported)', { timeoutMs: 60000 });
      const asked = await A.waitFor(`!!document.getElementById('npApproveAllow')`, { timeoutMs: 8000, pollMs: 250 }).then(() => true).catch(() => false);
      if (asked) await A.eval(`document.getElementById('npApproveAllow').click(); true`);
      await B.waitFor('window.__gbaNet().running && window.__gbaNet().roomFrames > 90', { timeoutMs: 90000, pollMs: 300 });
    };
    // ── arm 1: the documented invitation flow ──
    await goLive();
    const pre = await audioOf(B);
    ok('link joiner, before any input: the room is LIVE but the page has NO audio context yet (the failing state this fix is about)', pre.running && pre.ctx === null, JSON.stringify(pre));
    ok('...and the page SAYS so: a visible "Click or press a key to turn the sound on" pill', pre.hint && pre.hintVisible && /Click or press a key/.test(pre.hintText || ''), pre.hintText);
    ok('...and a joiner\'s Party label never shows "n/?" (the room size is not known until the host\'s envelope arrives)', !/\/\?/.test(pre.label), pre.label);
    await shot(B, 'audio_link_joiner_hint');
    await B.press('m', 'KeyM', 77, 80);                       // a REAL key event: the first user activation this page ever sees
    await B.waitFor(`window.__gbaNet().audio.ctx === 'running'`, { timeoutMs: 8000, pollMs: 150 }).catch(() => null);
    const post = await audioOf(B);
    ok('the first real keypress CREATES and RUNS the audio context, and the hint goes away', post.ctx === 'running' && !post.hint && !post.hintVisible, JSON.stringify(post));
    const rx = await rxPerGuestSec(B);
    ok('the sink is fed ~48,000 frames per GUEST second after the first touch (one seat\'s sound; counters, never listening: the browser is muted)', Math.abs(rx - 48000) < 2500, Math.round(rx) + ' per guest second');
    // ── arm 2: the same player's page dies and comes back by the same link ──
    await B.navigate('about:blank'); await sleep(2500);
    await goLive();
    const pre2 = await audioOf(B);
    ok('REJOINER (reloaded page, same link): live again, no audio context, hint shown', pre2.running && pre2.ctx === null && pre2.hintVisible, JSON.stringify(pre2));
    await B.press('n', 'KeyN', 78, 80);
    await B.waitFor(`window.__gbaNet().audio.ctx === 'running'`, { timeoutMs: 8000, pollMs: 150 }).catch(() => null);
    const post2 = await audioOf(B);
    ok('...and its first real keypress turns the sound on', post2.ctx === 'running' && !post2.hintVisible, JSON.stringify(post2));
    const rx2 = await rxPerGuestSec(B, 4000);
    ok('...with the sink fed at one seat\'s rate (~48,000 per guest second) - the rejoiner\'s hidden replay frames are NOT pushed', Math.abs(rx2 - 48000) < 3500, Math.round(rx2) + ' per guest second');
    const errs = pageErrs(pages);
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
    report.audio = { pre, post, rx: Math.round(rx), rx2: Math.round(rx2) };
  });
}

// ── M2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WASM_PATH = path.join(ROOT, 'gba/mgba/dist/mgba_core.wasm');
// the same module plus one valid empty custom section: different bytes, same behaviour - exactly what a stale CDN copy or a tampering proxy would look like
const tamperedWasm = () => { const w = fs.readFileSync(WASM_PATH); return Buffer.concat([w, Buffer.from([0, 6, 4, 0x74, 0x65, 0x73, 0x74, 0x01])]); };
async function interceptWasm(p, mode) {   // mode: 'bare' tampers the un-versioned URL, 'versioned' tampers the ?v= URL; counts both
  const st = { bare: 0, versioned: 0, tampered: 0 }, bad = tamperedWasm().toString('base64');
  p.handlers.push((m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params, url = request.url, isV = /[?&]v=/.test(url);
    if (isV) st.versioned++; else st.bare++;
    if ((mode === 'bare' && !isV) || (mode === 'versioned' && isV)) { st.tampered++; p.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/wasm' }, { name: 'Cache-Control', value: 'no-store' }], body: bad }).catch(() => {}); }
    else p.send('Fetch.continueRequest', { requestId }).catch(() => {});
  });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*mgba_core.wasm*', requestStage: 'Request' }] });
  return st;
}
async function bindUnit() {
  const text = read('gba/mgba/mgba_core.js');
  const load = (t) => { const m = { exports: {} }; new Function('module', 'require', t)(m, createRequire(import.meta.url)); return m.exports; };
  const probe = async (api) => {
    const tiny = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), seen = [], orig = WebAssembly.instantiate;
    WebAssembly.instantiate = function (b) { seen.push(b); return orig.apply(this, arguments); };
    let hook = false, fileFetch = false;
    const factory = (args) => new Promise((res, rej) => {
      if (typeof args.instantiateWasm === 'function') { hook = true; args.instantiateWasm({}, (inst) => res({ fake: inst })); }
      else { fileFetch = true; rej(new Error('the glue would fetch the file named by locateFile')); }
    });
    try { await api.create({ seats: 1, wasmBinary: tiny, factory }); } catch (_e) { /* the fake module has no _bgb_init: only the flags matter */ }
    WebAssembly.instantiate = orig;
    return { hook, fileFetch, instantiatedTheGivenBytes: seen.some((b) => b === tiny) };
  };
  // a failure INSIDE new Core (an allocation that fails, a module without its exports) must REJECT create(): not hang, not escape as an
  // unhandled rejection. The first browser run of this file died on exactly that (M._malloc is not a function) because the M2 hunk settled
  // resolve() from inside a two-argument then().
  const failing = async (api) => {
    const tiny = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), saved = process.listeners('unhandledRejection');
    let unhandled = 0; process.removeAllListeners('unhandledRejection'); process.on('unhandledRejection', () => { unhandled++; });
    const factory = (args) => new Promise((res) => { args.instantiateWasm({}, (inst) => res({ fake: inst })); });
    const outcome = await Promise.race([api.create({ seats: 1, wasmBinary: tiny, factory }).then(() => 'resolved', (e) => 'rejected: ' + (e && e.message)), new Promise((r) => setTimeout(() => r('pending'), 800))]);
    await new Promise((r) => setTimeout(r, 100));
    process.removeAllListeners('unhandledRejection'); saved.forEach((l) => process.on('unhandledRejection', l));
    return { outcome, unhandled };
  };
  const oldThen = 'then(function (M) { return new Core(M, seats, o); }).then(resolve, reject);';
  if (!text.includes(oldThen)) throw new Error('bindUnit anchor missing in mgba_core.js: ' + oldThen);
  return { real: await probe(load(text)), reverted: await probe(load(text.replace('args.instantiateWasm = function', 'args.__reverted = function'))), throwing: await failing(load(text)), throwingReverted: await failing(load(text.replace(oldThen, 'then(function (M) { resolve(new Core(M, seats, o)); }, reject);'))) };
}
async function sectionBind(report) {
  section('bind (M2): the bytes the room VERIFIED are the bytes that RUN - a different wasm served for the bare URL never executes; a different one for the ?v= URL is refused by name');
  const u = await bindUnit();
  ok('Node: with wasmBinary given, create() registers Emscripten\'s instantiateWasm hook and the hook instantiates EXACTLY the bytes it was given (no second request)', u.real.hook && u.real.instantiatedTheGivenBytes && !u.real.fileFetch, JSON.stringify(u.real));
  control('Node: the hook reverted (a mutated copy of mgba_core.js) falls back to the glue\'s own file fetch and never instantiates the given bytes', !u.reverted.hook && !u.reverted.instantiatedTheGivenBytes && u.reverted.fileFetch, JSON.stringify(u.reverted));
  ok('Node: a failure inside the Core constructor REJECTS create() by name - not pending, no unhandled rejection (so a page that cannot allocate its cores reaches its error path)', /^rejected: /.test(u.throwing.outcome) && u.throwing.unhandled === 0, JSON.stringify(u.throwing));
  control('Node: with create() settling resolve() from inside a two-argument then() (the first form of the M2 hunk), the same failure leaves create() PENDING and raises an unhandled rejection', u.throwingReverted.outcome === 'pending' && u.throwingReverted.unhandled >= 1, JSON.stringify(u.throwingReverted));
  const wasmMd5 = md5(fs.readFileSync(WASM_PATH));
  const spyInstantiate = `(() => { window.__inst = []; const o = WebAssembly.instantiate; WebAssembly.instantiate = function (b) { try { if (b && b.byteLength) window.__inst.push({ len: b.byteLength, md5: window.__gbaRoomModule.md5(b) }); } catch (e) {} return o.apply(this, arguments); }; return true; })()`;
  // ── arm 1: the BARE url is tampered, the versioned one is honest: the room must run the verified bytes ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    const st = await interceptWasm(B, 'bare');
    await openAll(pages);
    await B.eval(spyInstantiate);
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 90);
    const nB = await netData(B), inst = await B.eval('window.__inst');
    ok('the room GOES LIVE on both pages and the tampered bare URL was NEVER requested (0 bare requests; the verified ?v= bytes were instantiated directly)', nB.running && !nB.refusal && st.bare === 0 && st.tampered === 0 && st.versioned >= 1, JSON.stringify({ bare: st.bare, versioned: st.versioned, running: nB.running }));
    ok('the instantiate call the ROOM made was on bytes whose md5 is the verified build ' + wasmMd5.slice(0, 8) + ' (the one named in the disc string)', inst.length >= 1 && inst.every((x) => x.md5 === wasmMd5) && /core=13474b3883009819a5ac7304e568cb0a/.test(nB.disc || ''), JSON.stringify(inst));
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
  // ── control: the pre-fix behaviour (the verified bytes are NOT handed to the instance) is observable and the test sees it ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    const st = await interceptWasm(B, 'bare');
    await openAll(pages);
    await B.eval(`(() => { const o = window.MgbaCore.create; window.MgbaCore.create = (opts) => o(Object.assign({}, opts, { wasmBinary: undefined, locateFile: (p) => '/gba/mgba/dist/' + p })); return true; })()`);   // revert the fix on this page only
    const before = st.bare;
    await formRoom(pages, SBAM, 2);
    await allRunning(pages, 90);
    const nB = await netData(B);
    control('with the fix reverted on one page, the room boots from a SECOND, un-versioned request that is served TAMPERED and nothing refuses it (the failure the verifier reproduced) - so the check above has teeth', nB.running && !nB.refusal && st.bare >= 1 && st.tampered >= 1, JSON.stringify({ bareBefore: before, bareAfter: st.bare, tampered: st.tampered, running: nB.running }));
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
  // ── arm 2: the VERSIONED url is tampered on one page: that page's md5 differs, so it is refused by name before frame 0 ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await interceptWasm(B, 'versioned');
    await openAll(pages);
    await formRoom(pages, SBAM, 2);
    await Promise.all(pages.map((p) => p.waitFor(`!!window.__gbaNet().refusal`, { timeoutMs: 60000, pollMs: 300 }).catch(() => null)));
    await sleep(1000);
    const ns = await Promise.all(pages.map(netData));
    await shot(B, 'bind_tampered_versioned_wasm_guest');
    ok('a peer whose ?v= wasm bytes differ is refused BY NAME on that page (ROOM_CORE) and the host is told the same code; nobody ran a frame', ns[1].refusal && ns[1].refusal.items.some((i) => i.code === 'ROOM_CORE') && ns[0].refusal && ns[0].refusal.items.some((i) => i.code === 'ROOM_CORE') && ns.every((n) => !n.running), JSON.stringify(ns.map((n) => n.refusal && n.refusal.items.map((i) => i.code))));
  });
}

// ── B1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionAlloc(report) {
  section('alloc (B1): a REAL failure of every wasm instantiate entry point (not a mock of create()) - the text is clean, the size is the real one, and the page does not lie about solo play');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await B.eval(`(() => { const orig = { i: WebAssembly.instantiate, s: WebAssembly.instantiateStreaming }; window.__failWasm = false;
      const bad = () => Promise.reject(new Error('Aborted(RangeError: WebAssembly.Memory(): could not allocate memory). Build with -sASSERTIONS for more info.'));
      WebAssembly.instantiate = function () { return window.__failWasm ? bad() : orig.i.apply(this, arguments); };
      WebAssembly.instantiateStreaming = function () { return window.__failWasm ? bad() : orig.s.apply(this, arguments); };
      window.__failWasm = true; return true; })()`);
    await formRoom(pages, SBAM, 2);
    await Promise.all(pages.map((p) => p.waitFor(`!!window.__gbaNet().refusal`, { timeoutMs: 60000, pollMs: 300 }).catch(() => null)));
    await sleep(2500);
    const ns = await Promise.all(pages.map(netData));
    const ui = await B.eval(`({ box: document.getElementById('netRefusal').textContent, status: document.getElementById('netStatus').textContent, banner: document.getElementById('banner').textContent, reloadShown: document.getElementById('netReload').style.display !== 'none', startDisabled: document.getElementById('btnStart').disabled, partyHidden: document.getElementById('btnNet').hidden, ready: window.myApp.isWasmReady })`);
    await shot(B, 'alloc_real_failure_guest');
    ok('the refusal names CORE_BOOT_FAILED, carries NO Emscripten developer text ("Aborted(" / "-sASSERTIONS"), and states the REAL requirement: a fixed 192 MB block per page, the same for 2-4 players', /CORE_BOOT_FAILED/.test(ui.box) && !/Aborted\(|ASSERTIONS/.test(ui.box) && /could not allocate memory/.test(ui.box) && /192 MB/.test(ui.box) && !/about 100 MB|about 200 MB/.test(ui.box), JSON.stringify(ui.box.slice(0, 380)));
    ok('the host is told which player could not start, by the same code, also without developer text', ns[0].refusal && ns[0].refusal.items.some((i) => i.code === 'CORE_BOOT_FAILED' && !/Aborted\(|ASSERTIONS/.test(i.message)), JSON.stringify(ns[0].refusal && ns[0].refusal.items.map((i) => i.code)));
    ok('the page does NOT claim "back in solo play" when solo play is gone: the status and the banner agree (the emulator could not start), a Reload button is offered, Start is disabled', /no solo play/.test(ui.status) && /Reload/.test(ui.status) && !/back in solo play/.test(ui.status) && /Could not start the emulator core/.test(ui.banner) && !/Aborted\(|ASSERTIONS/.test(ui.banner) && ui.reloadShown && ui.startDisabled && !ui.ready, JSON.stringify({ status: ui.status, banner: ui.banner.slice(0, 120), reload: ui.reloadShown, startDisabled: ui.startDisabled }));
    await B.eval(`document.getElementById('netClose').click(); true`);
    await sleep(1300);
    ok('Party is not offered on a page whose core failed (hidden, so nothing it opens could ever start)', await B.eval(`document.getElementById('btnNet').hidden`) === true);
    // the repair path: stop failing, press Reload
    await B.eval(`window.__failWasm = false; true`);
    await B.eval(`(() => { const b = document.getElementById('netReload'); b.style.display = ''; b.click(); return true; })()`).catch(() => null);
    await B.waitFor('window.__gbaNet && window.__gbaNet().supported && window.myApp.isWasmReady', { timeoutMs: 90000, pollMs: 400 });
    ok('...and the Reload button really brings a working page back (core ready, Start enabled)', await B.eval(`!document.getElementById('btnStart').disabled && window.myApp.isWasmReady`));
    report.alloc = { ui: { status: ui.status, box: ui.box.slice(0, 300) } };
  });
}

// ── B2-B8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionUx(report) {
  section('ux (B3 B4 B7 B8 A2): end-of-room wording from the real outcome, Leave while loading, Copy debug in the panel, solo controls locked while a room forms, the readout window');
  // ── an SBAM room (a title with NO battery) finished cleanly: the text says "keeps no save", never "progress was saved"; plus the forming lock, Copy debug, the fps window ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await Promise.all(pages.map((p) => p.eval(`(() => { window.__dbg = 0; const o = DebugReport.copy; DebugReport.copy = function () { window.__dbg++; return o.apply(this, arguments); }; return true; })()`)));
    const before = await A.eval(`({ startDisabled: document.getElementById('btnStart').disabled, forming: window.__gbaNet().forming })`);
    ok('control: with NO room, Start is enabled and nothing is forming', before.startDisabled === false && before.forming === false, JSON.stringify(before));
    const code = await hostOpen(A, SBAM, 2);
    const forming = await A.eval(`(async () => { const f0 = myApp.frameCnt, run0 = myApp.isRunning; await myApp.startFromList(); document.getElementById('btnBrowse').click(); return { startDisabled: document.getElementById('btnStart').disabled, browseDisabled: document.getElementById('btnBrowse').disabled, splashStart: document.getElementById('mobileSplashStart').disabled, forming: window.__gbaNet().forming, started: myApp.isRunning !== run0 || myApp.frameCnt !== f0 }; })()`);
    ok('B8: from the moment the room OPENS (before anyone joins) the solo Start / Browse are disabled and startFromList() is a no-op - no stale "Fetching..." status, no "Emulator not ready" toast', forming.startDisabled && forming.browseDisabled && forming.forming && !forming.started, JSON.stringify(forming));
    // lib/debugreport.js (SPOTS.gba) places the buttons now; gba.html carries no mount of its own, so every spot holds exactly ONE.
    const dbgCounts = await A.eval(`(() => { const c = {}; document.querySelectorAll('[data-debugreport]').forEach((e) => { const k = e.getAttribute('data-debugreport'); c[k] = (c[k] || 0) + 1; }); return c; })()`);
    ok('Copy debug: the shared library places ONE button in each spot (toolbar, touch menu, splash, Party panel) - no duplicate from a page-side mount', ['bar', 'menu', 'splash', 'party'].every((k) => dbgCounts[k] === 1) && Object.keys(dbgCounts).every((k) => ['bar', 'menu', 'splash', 'party'].includes(k)), JSON.stringify(dbgCounts));
    await shot(A, 'ux_party_panel_with_copy_debug');   // BEFORE the press: the picture shows the button as a player sees it
    const pb = await A.eval(`(() => { const b = document.querySelector('#netBox [data-debugreport="party"]'); if (!b) return null; const r = b.getBoundingClientRect(), text = b.textContent.trim(); b.click(); return { text, h: Math.round(r.height), lib: b.className.indexOf('debugReportBtn') >= 0 }; })()`);
    // the library's own button calls its internal copy(), not the public property, so the press is proved by its EFFECT: the shared report (with this page's room data) opens
    await A.waitFor(`!!document.getElementById('debugReportOverlay')`, { timeoutMs: 15000, pollMs: 200 }).catch(() => null);
    const rpt = await A.eval(`(() => { const o = document.getElementById('debugReportOverlay'), ta = o && o.querySelector('textarea'); return ta ? ta.value : (o ? o.textContent : ''); })()`);
    ok('B7: the Party panel carries "Copy debug" (placed by lib/debugreport.js), at least 44 px tall, and pressing it opens the shared report with this page\'s room section (PAGE SEAMS + __gbaNet)', !!pb && /Copy debug/.test(pb.text) && pb.h >= 44 && pb.lib && /PAGE SEAMS/.test(rpt) && /__gbaNet\(\)/.test(rpt) && /ROOM/i.test(rpt), JSON.stringify({ btn: pb, reportBytes: String(rpt || '').length }));
    await A.eval(`(() => { const o = document.getElementById('debugReportOverlay'); if (!o) return false; const b = Array.from(o.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Close'); if (b) b.click(); return true; })()`);
    await guestJoin(B, code); await admit(A, 1);
    const script = LINK['sbam-2p'].script;
    await Promise.all([setKeys(A, seatKeys(script, 2, 0)), setKeys(B, seatKeys(script, 2, 1))]);
    await allRunning(pages, 800);
    // A2: the readout is a rate over >= 10 s, so it does not read 1.004x for a guest at 1.000x
    const reads = [];
    for (let i = 0; i < 4; i++) { await sleep(3000); reads.push(await Promise.all(pages.map((p) => p.eval(`({ t: document.getElementById('fps').textContent, title: document.getElementById('fps').title })`)))); }
    const xs = reads.flat().map((r) => +((/\(([\d.]+)x hardware\)/.exec(r.t) || [])[1]));
    ok('A2: the status-bar "guest N/s (x hardware)" readout is a >= 10 s rate: every sample over 12 s on both pages is within 0.997-1.003x (a one-second window printed 1.004x for a guest at 1.0000x), same text format as the family', xs.length === 8 && xs.every((x) => x >= 0.997 && x <= 1.003) && reads.flat().every((r) => /^guest [\d.]+\/s \([\d.]+x hardware\) · presented [\d.]+\/s$/.test(r.t) && /last \d+ s/.test(r.title)), `${xs.join(' ')}  title="${reads[3][0].title}"`);
    // finish cleanly
    const live = await Promise.all(pages.map((p) => p.eval(`({ rows: window.__gbaNet().party.rows.filter((r) => r.who).map((r) => r.state), label: window.__gbaNet().party.label })`)));
    await pressFinish(pages);
    await Promise.all(pages.map((p) => p.waitFor(`window.__gbaNet().phase === 'saved'`, { timeoutMs: 90000, pollMs: 300 })));
    const endState = (p) => p.eval(`(() => { const n = window.__gbaNet(); return { bar: document.getElementById('netBarrier').textContent, barShown: document.getElementById('netBarrier').style.display !== 'none', status: document.getElementById('netStatus').textContent, saved: n.saved, rows: n.party.rows.filter((r) => r.who).map((r) => r.state), label: n.party.label, panel: document.getElementById('netOverlay').innerText, frames: n.roomFrames, frame: n.frame }; })()`);
    const txt = await Promise.all(pages.map(endState));
    await shot(A, 'ux_end_text_no_battery');
    const sentence = 'keeps no save, so nothing was written';
    ok('B3 + D5: a no-battery title\'s clean end says it ONCE, in ONE place (the status line; the panel\'s room line is empty and hidden) and truthfully - "' + sentence + '" - never "Your progress was saved", and the sentence is on screen exactly once', txt.every((t) => /keeps no save/.test(t.status) && !/keeps no save/.test(t.bar) && !t.barShown && !/progress was saved/i.test(t.bar + ' ' + t.status) && t.saved.skip === 'no-battery' && (t.panel.split(sentence).length - 1) === 1), JSON.stringify(txt.map((t) => [t.bar, t.status, t.panel.split(sentence).length - 1])));
    ok('D5: after a clean end every seat row says "finished" (it said "playing") and the Party label ends "finished"; during play they said "playing"', live.every((l) => l.rows.every((r) => r === 'playing') && /playing$/.test(l.label)) && txt.every((t) => t.rows.length === 2 && t.rows.every((r) => r === 'finished') && /finished$/.test(t.label)), JSON.stringify([live.map((l) => [l.rows, l.label]), txt.map((t) => [t.rows, t.label])]));
    await sleep(2500);
    const later = await Promise.all(pages.map(endState));
    ok('D5: the finished room is HELD - the cores are done: no frame is stepped on either page in the 2.5 s after the end (frames ' + txt.map((t) => t.frames).join('/') + ' -> ' + later.map((t) => t.frames).join('/') + ')', later.every((t, i) => t.frames === txt[i].frames && t.frame === txt[i].frame), JSON.stringify([txt.map((t) => [t.frames, t.frame]), later.map((t) => [t.frames, t.frame])]));
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
    await sleep(800);
    const after = await A.eval(`({ startDisabled: document.getElementById('btnStart').disabled, forming: window.__gbaNet().forming })`);
    ok('B8: after the room is left the solo controls come back (Start enabled, nothing forming)', after.startDisabled === false && after.forming === false, JSON.stringify(after));
  });
  // ── Leave while the ROM is still downloading ──
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await B.eval(`(() => { const o = myApp._fetchRom.bind(myApp); window.__slow = 0; myApp._fetchRom = async (u, cb) => { window.__slow++; await new Promise((r) => setTimeout(r, 4000)); return o(u, cb); }; return true; })()`);   // a slow download, on purpose
    await formRoom(pages, KIRBY, 2);
    await B.waitFor(`window.__slow >= 1 && window.__gbaNet().phase === 'loading'`, { timeoutMs: 30000, pollMs: 100 });
    await B.eval('window.__gbaNet().leave(true)');
    await sleep(6500);                                       // the abandoned download finishes and must find nothing to do
    const n = await netData(B);
    const st = await B.eval(`document.getElementById('netStatus').textContent`);
    ok('B4: Leave while the ROM is still downloading leaves NOTHING behind: phase idle, no session, nothing started, no "Loaded. Waiting for every player\'s save…" status afterwards', n.phase === 'idle' && !n.session && !n.party.started && !/Loaded\. Waiting/.test(st), JSON.stringify({ phase: n.phase, started: n.party.started, status: st }));
    ok('...and the page is back to a usable solo state (Start enabled, no room lock)', await B.eval(`!document.getElementById('btnStart').disabled && !window.myApp.roomLocked && !window.__gbaNet().forming`));
    await A.eval('window.__gbaNet().leave(true)');
  });
}

// ── CARD CAP on the real page (lib/netplay.js cardLimits, opted into by gba.html) ────────────────────────────────────────────────
async function sectionCap(report) {
  section('cap: gba.html opts in to the engine card cap - a seated peer\'s hostile pieces are refused BY SEAT on the real page and nothing is held; without the opt-in the same flood IS held');
  const D = Buffer.alloc(12 * 1024, 0xab).toString('base64');
  const flood = (limitsOn) => `(() => { const ls = window.__gbaRoomTest.engine(); const peer = ls.roster[1]; if (!peer) return { err: 'no seat 2 in the roster yet' };
    ${limitsOn ? '' : 'ls.cardLimits = null;'}
    for (let i = 0; i < 300; i++) ls.receive({ t: 'lsvmu', peer, port: 1, size: 0x7fffffff, hash: 'deadbeef', enc: 'gba1;raw', len: 0x7fffffff, n: 0x7fffffff, i, d: ${JSON.stringify(D)} });
    const slot = ls._cardParts.get(peer + '#1'), n = window.__gbaNet();
    return { limits: JSON.stringify(ls.cardLimits), slots: ls._cardParts.size, held: slot ? slot.got : 0, refusal: n.refusal, status: document.getElementById('netStatus').textContent }; })()`;
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await formRoom(pages, SBAM, 2);
    await A.waitFor(`!!(window.__gbaRoomTest.engine() && window.__gbaRoomTest.engine().roster[1])`, { timeoutMs: 30000, pollMs: 200 });
    const r = await A.eval(flood(true));
    ok('the host engine carries the room limits (opted in by the page): {maxCardBytes 135240, maxPieces 12, maxCards 4}', r.limits === JSON.stringify({ maxCardBytes: 135240, maxPieces: 12, maxCards: 4 }), r.limits);
    ok('300 hostile pieces announced as one 2^31-1 byte card from seat 2: NOTHING is held (no reassembly slot, 0 pieces)', r.slots === 0 && r.held === 0, JSON.stringify({ slots: r.slots, held: r.held }));
    ok('...and the page names the seat: "Seat 2\'s save was refused", code SAVE_TOO_BIG, the announced size in the sentence, and the status says which seat', !!r.refusal && /Seat 2's save was refused/.test(r.refusal.title) && r.refusal.items.length === 1 && r.refusal.items[0].code === 'SAVE_TOO_BIG' && /announces 2147483647 bytes/.test(r.refusal.items[0].message) && /Seat 2/.test(r.status), JSON.stringify(r.refusal));
    await shot(A, 'cap_hostile_card_refused_host');
    await allRunning(pages, 60);
    const ns = await Promise.all(pages.map(netData));
    ok('...and the room still forms and runs with the HONEST cards (the refusal wedged nothing): both pages running', ns.every((n) => n.running), JSON.stringify(ns.map((n) => [n.running, n.roomFrames])));
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await formRoom(pages, SBAM, 2);
    await A.waitFor(`!!(window.__gbaRoomTest.engine() && window.__gbaRoomTest.engine().roster[1])`, { timeoutMs: 30000, pollMs: 200 });
    const r = await A.eval(flood(false));
    control('with the cap switched off on this page (ls.cardLimits = null: what every other emulator runs), the SAME 300 pieces ARE held (300 pieces of 12 KiB, a slot open) and nobody is told - so the checks above have teeth', r.limits === 'null' && r.slots === 1 && r.held === 300 && !r.refusal, JSON.stringify({ limits: r.limits, slots: r.slots, held: r.held, refusal: r.refusal }));
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
}

// ── GR4 finding: the toolbar's game picker must not contradict the room ──────────────────────────────────────────────────────
async function sectionPicker(report) {
  section('picker: while a room forms or runs the toolbar game picker shows the ROOM\'s game (not the page\'s solo choice); the solo choice comes back after Leave');
  const read = (p) => p.eval(`(() => { const t = (id) => { const s = document.getElementById(id); return { text: s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent : null, disabled: s.disabled }; }; return { desktop: t('romSelect'), mobile: t('mobileRomSelect'), status: document.getElementById('status').textContent }; })()`);
  const pick = (p, title) => p.eval(`(() => { for (const id of ['romSelect', 'mobileRomSelect']) { const s = document.getElementById(id); const o = Array.from(s.options).find((x) => x.textContent === ${JSON.stringify(title)}); s.value = o.value; s.dispatchEvent(new Event('change')); } return true; })()`);
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await pick(A, KIRBY);
    const before = await read(A), beforeB = await read(B);
    ok('control, no room: the host page\'s picker shows ITS OWN choice (' + KIRBY + ') and is enabled; the other page shows the default, enabled', before.desktop.text === KIRBY && before.mobile.text === KIRBY && !before.desktop.disabled && !before.mobile.disabled && beforeB.desktop.text !== SBAM && !beforeB.desktop.disabled, JSON.stringify([before.desktop, beforeB.desktop]));
    const code = await hostOpen(A, SBAM, 2);
    const forming = await read(A);
    ok('the moment the room OPENS (nobody has joined) the host\'s picker shows the ROOM\'s game "' + SBAM + '" in both pickers, and they are disabled', forming.desktop.text === SBAM && forming.mobile.text === SBAM && forming.desktop.disabled && forming.mobile.disabled, JSON.stringify(forming));
    await shot(A, 'picker_host_forming');
    await guestJoin(B, code); await admit(A, 1);
    await B.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000, pollMs: 200 });
    await allRunning(pages, 30);
    const live = await Promise.all(pages.map(read));
    ok('while the room RUNS both pages\' pickers show "' + SBAM + '" (the guest never chose it: the host named it) and the status line agrees', live.every((s) => s.desktop.text === SBAM && s.mobile.text === SBAM && s.desktop.disabled && /^Room . Super Bust-A-Move/.test(s.status)), JSON.stringify(live.map((s) => [s.desktop.text, s.desktop.disabled, s.status])));
    await shot(B, 'picker_guest_live');
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
    await Promise.all(pages.map((p) => p.waitFor(`!window.__gbaNet().session && window.myApp.isWasmReady`, { timeoutMs: 40000, pollMs: 200 })));
    await sleep(500);
    const after = await Promise.all(pages.map(read));
    ok('after Leave the host\'s picker is back on ITS OWN choice (' + KIRBY + ') and enabled; the guest\'s is back on what it had; Start is usable again', after[0].desktop.text === KIRBY && after[0].mobile.text === KIRBY && !after[0].desktop.disabled && after[1].desktop.text === beforeB.desktop.text && !after[1].desktop.disabled, JSON.stringify(after.map((s) => [s.desktop, s.mobile])));
  });
  // control: a page that CANNOT move its pickers (selectedIndex writes blocked in this window only) shows the contradiction GR4 saw
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 1 }, async ({ pages }) => {
    const [A] = pages;
    await openAll(pages);
    await pick(A, KIRBY);
    await A.eval(`(() => { const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex'); for (const id of ['romSelect', 'mobileRomSelect']) Object.defineProperty(document.getElementById(id), 'selectedIndex', { configurable: true, get() { return d.get.call(this); }, set() { /* blocked */ } }); return true; })()`);
    await hostOpen(A, SBAM, 2);
    const s = await read(A);
    control('with the page unable to move its pickers (blocked in this window only), the room is on ' + SBAM + ' while the picker still reads "' + KIRBY + '" - the contradiction GR4 saw - and the assertion above reads it as wrong', s.desktop.text === KIRBY && s.desktop.text !== SBAM, JSON.stringify(s.desktop));
    await A.eval('window.__gbaNet().leave(true)');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 4 (verifier FV2): the host leaving (D1, D2), a dead page is not a refusal (D3), a refused visitor's panel (D4), a solo ROM
// still arriving when a room forms (D6), the stored-save note. D5 (a finished room) lives in the `ux` section's end-of-room check.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
const guestState = (p) => p.eval(`(() => { const n = window.__gbaNet(), g = (id) => document.getElementById(id); return { session: n.session, closedWhy: n.closedWhy, status: g('netStatus').textContent, label: n.party && n.party.label,
  refusalTitle: n.refusal && n.refusal.title, codes: n.refusal ? n.refusal.items.map((i) => i.code) : [], startDisabled: g('btnStart').disabled, pickerDisabled: g('romSelect').disabled, mobilePickerDisabled: g('mobileRomSelect').disabled,
  wasm: !!window.myApp.isWasmReady, forming: n.forming, romSelect: g('romSelect').options[g('romSelect').selectedIndex].textContent, mainStatus: g('status').textContent }; })()`);

// Hold every request whose URL matches `pattern` (a ROM download) until the test releases or fails it.
async function holdRequests(p, pattern) {
  const st = { held: [], urls: [] };
  p.handlers.push((m) => { if (m.method !== 'Fetch.requestPaused') return; st.held.push(m.params.requestId); st.urls.push(m.params.request.url); });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] });
  st.release = async () => { for (const id of st.held.splice(0)) await p.send('Fetch.continueRequest', { requestId: id }).catch(() => {}); };
  st.fail = async () => { for (const id of st.held.splice(0)) await p.send('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }).catch(() => {}); };
  st.waitHeld = async (ms = 60000) => { const t0 = Date.now(); while (!st.held.length && Date.now() - t0 < ms) await sleep(100); return st.held.length > 0; };
  return st;
}

// ── D1 + D2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionHostleft(report) {
  section('hostleft (D1, D2): when the host leaves - a live room, or before the game started - the guest is told AT ONCE (ROOM_HOST_LEFT) and is back in solo play; a host that could not say so is reported with a visible countdown, never a frozen "Looking for the host..."');
  const arm = async (name, o) => withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    if (o.noBye) await A.eval('window.__gbaRoomTest.noHostBye = true; true');
    if (o.grace) await B.eval(`window.__gbaRoomTest.hostGraceMs = ${o.grace}; true`);
    await formRoom(pages, SBAM, 2);
    if (!o.preStart) await allRunning(pages, 120);
    const pre = await B.eval(`({ machine: !!window.__gbaRoomTest.machine(), phase: window.__gbaNet().phase, session: window.__gbaNet().session })`);
    ok(name + ': the guest is ' + (o.preStart ? 'seated and still loading / exchanging saves (no machine yet)' : 'in a LIVE room') + ' when the host leaves', o.preStart ? (!pre.machine && pre.session) : (pre.machine && pre.session), JSON.stringify(pre));
    const t0 = Date.now();
    if (o.how === 'leave') await A.eval('window.__gbaNet().leave(true)'); else await A.navigate('about:blank');
    const statuses = []; let told = null, last = null;
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      last = await guestState(B);
      if (statuses.length === 0 || statuses[statuses.length - 1] !== last.status) statuses.push(last.status);
      if (!last.session) { told = (Date.now() - t0) / 1000; break; }
    }
    const final = await guestState(B);
    if (told == null) told = 999;
    await shot(B, 'hostleft_' + name.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '_guest');
    if (!o.noBye) {
      ok(name + ': the guest is told within 3 s of the host leaving (' + told.toFixed(1) + ' s; it was ~31 s in a live room and never before the start)', told <= 3, told.toFixed(2) + ' s');
      ok(name + ': it never sat on a frozen "Looking for the host..." - the statuses it showed were ' + JSON.stringify(statuses), !statuses.some((s) => /Looking for the host/.test(s)), JSON.stringify(statuses));
    } else {
      ok(name + ': it saw the COUNTDOWN ("Lost contact with the host - trying to get back in for another N s") and not a frozen "Looking for the host..."', statuses.some((s) => /Lost contact with the host — trying to get back in for another \d+ s/.test(s)) && !statuses.some((s) => /Looking for the host/.test(s)), JSON.stringify(statuses.slice(0, 4)));
      ok(name + ': it was told when the grace ran out (' + told.toFixed(1) + ' s, grace ' + o.grace / 1000 + ' s) - NOT at once: the goodbye is what made the announced arms immediate', told >= o.grace / 1000 - 0.5 && told <= o.grace / 1000 + 4, told.toFixed(2) + ' s');
    }
    ok(name + ': the outcome is named - ROOM_HOST_LEFT, "' + (o.noBye ? 'the host stopped answering' : 'the host left') + '", ' + (o.preStart ? 'nothing was changed (the game had not started)' : 'nothing was saved, your previous save is untouched'), /ROOM_HOST_LEFT/.test(final.closedWhy || '') && (o.noBye ? /stopped answering/ : /The host left/).test(final.closedWhy || '') && (o.preStart ? /had not started/ : /Nothing was saved/).test(final.closedWhy || '') && final.codes.indexOf('ROOM_HOST_LEFT') >= 0, JSON.stringify([final.closedWhy, final.codes]));
    await B.waitFor('window.myApp.isWasmReady', { timeoutMs: 30000, pollMs: 250 }).catch(() => null);
    const back = await guestState(B);
    ok(name + ': the guest is back in solo play - no session, Start and both pickers usable, the Party label plain, not "forming"', !back.session && !back.startDisabled && !back.pickerDisabled && !back.mobilePickerDisabled && back.label === 'Party' && !back.forming && back.wasm, JSON.stringify({ session: back.session, startDisabled: back.startDisabled, pickerDisabled: back.pickerDisabled, label: back.label, forming: back.forming, wasm: back.wasm }));
    if (o.how === 'leave') { await A.eval('window.__gbaNet().leave(true)').catch(() => {}); }
  });
  await arm('D1 live room, host presses Leave', { how: 'leave', preStart: false });
  await arm('D1 live room, host closes the tab (pagehide)', { how: 'navigate', preStart: false });
  await arm('D2 before the start, host presses Leave', { how: 'leave', preStart: true });
  await arm('D1 CONTROL live room, host dies WITHOUT saying so', { how: 'leave', preStart: false, noBye: true, grace: 6000 });
  await arm('D2 CONTROL before the start, host dies WITHOUT saying so', { how: 'leave', preStart: true, noBye: true, grace: 6000 });
}

// ── D3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionRace(report) {
  section('race (D3): a peer disconnecting before the start is a WAIT for the host, not a refusal - a download that dies with its page is never announced; a real failure still is');
  const arm = async (name, o) => withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    if (o.delay != null) await B.eval(`window.__gbaRoomTest.announceDelayMs = ${o.delay}; true`);
    const st = await holdRequests(B, '*Bust-A-Move*');
    const code = await hostOpen(A, SBAM, 2);
    await guestJoin(B, code); await admit(A, 1);
    const got = await st.waitHeld(60000);
    ok(name + ': the guest\'s ROM download was caught in flight', got, JSON.stringify(st.urls.map((u) => u.slice(-40))));
    const t0 = Date.now();
    await st.fail();                                          // the download dies (a network failure, or the page tearing down: the page cannot tell)
    if (o.die) { await sleep(o.die); await B.navigate('about:blank'); }
    let shownAt = null, refusal = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const n = await A.eval(`({ refusal: window.__gbaNet().refusal, running: window.__gbaNet().running })`);
      if (n.refusal) { shownAt = (Date.now() - t0) / 1000; refusal = n.refusal; break; }
    }
    const host = await A.eval(`({ running: window.__gbaNet().running, phase: window.__gbaNet().phase, status: document.getElementById('netStatus').textContent })`);
    await o.check({ shownAt, refusal, host });
    await A.eval('window.__gbaNet().leave(true)').catch(() => {});
    if (!o.die) await B.eval('window.__gbaNet().leave(true)').catch(() => {});
  });
  await arm('guest page dies 0.4 s after its download failed', { die: 400, check: ({ shownAt, refusal, host }) => ok('the host shows NO refusal (nothing was announced for a page that went away) and nothing runs - it just waits at the barrier', shownAt == null && !refusal && !host.running, JSON.stringify({ shownAt, refusal, host })) });
  await arm('CONTROL, the pre-fix timing (announce at once) with the same page death', { die: 400, delay: 0, check: ({ shownAt, refusal }) => control('the host shows the FALSE refusal "A player could not join: [ROOM_ERROR] ..." within a second - the race, restored (this is what the guest\'s page sent before the fix)', shownAt != null && shownAt < 1.5 && /could not join/.test((refusal || {}).title || ''), JSON.stringify({ shownAt, refusal })) });
  await arm('guest page stays alive and its download really failed', { check: ({ shownAt, refusal }) => ok('a REAL failure is still reported to the host, after the grace (2.5 s), by name', shownAt != null && shownAt >= 2.0 && shownAt <= 9 && /could not join/.test((refusal || {}).title || '') && refusal.items.some((i) => /ROOM_ERROR/.test(i.code) || /ROOM_ERROR/.test(i.message)), JSON.stringify({ shownAt, refusal })) });
}

// ── D4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionThird(report) {
  section('third (D4): a visitor the room refuses sees ONLY the refusal, in cartridge words - not the room\'s roster and "waiting for another player"');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 3 }, async ({ pages }) => {
    const [A, B, C] = pages;
    await openAll(pages);
    const code = await formRoom([A, B], SBAM, 2);
    await allRunning([A, B], 60);
    await guestJoin(C, code);
    await C.waitFor(`!!window.__gbaNet().refusal`, { timeoutMs: 30000, pollMs: 250 });
    await sleep(600);
    const s = await C.eval(`(() => { const g = (id) => document.getElementById(id), n = window.__gbaNet(); return { room: g('netRoom').style.display, panel: g('netOverlay').innerText, refusal: n.refusal, status: g('netStatus').textContent, label: n.party && n.party.label, raw: window.__gbaRoomTest.lastFailed || '' }; })()`);
    await shot(C, 'third_visitor_refused');
    ok('only the refusal is shown: the room box is hidden, no "Seat 1 - open", no "Waiting for another player - share the code"', s.room === 'none' && !/Seat \d — (open|host|player)/.test(s.panel) && !/Waiting for another player/.test(s.panel), JSON.stringify(s.panel.slice(0, 200)));
    ok('the refusal is named: "Could not join the room", code ROOM_STARTED, in cartridge words (no "disc", no "controllers were plugged in")', !!s.refusal && s.refusal.title === 'Could not join the room' && s.refusal.items.length === 1 && s.refusal.items[0].code === 'ROOM_STARTED' && /cartridge|game started/.test(s.refusal.items[0].message) && !/\bdisc\b|plugged in/.test(s.panel), JSON.stringify(s.refusal));
    ok('the status line is short and does not repeat it: "Could not join the room."; the Party label is plain "Party"', s.status === 'Could not join the room.' && s.label === 'Party', JSON.stringify([s.status, s.label]));
    control('the ENGINE\'s own sentence (what the page had to rewrite) says "disc" and "the controllers were plugged in when the disc loaded" - so the wording check above has teeth', /\bdisc\b/.test(s.raw) && /controllers were plugged in/.test(s.raw), JSON.stringify(s.raw));
    await C.eval('window.__gbaNet().leave(true)').catch(() => {});
    await B.eval('window.__gbaNet().leave(true)').catch(() => {}); await A.eval('window.__gbaNet().leave(true)').catch(() => {});
  });
}

// ── D6 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionSolofetch(report) {
  section('solofetch (D6): a solo ROM still arriving when a room forms is cancelled - its "Fetching ..." does not stay in the status bar and it never starts a solo game; the room is unaffected');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    const st = await holdRequests(B, '*SoulGold*');
    await B.eval(`document.getElementById('btnStart').click(); true`);
    const got = await st.waitHeld(30000);
    await sleep(300);
    const before = await guestState(B);
    ok('control: with a solo ROM in flight the status bar reads "Fetching Pokemon SoulGold..." (the state the room must not inherit)', got && /^Fetching Pokemon SoulGold/.test(before.mainStatus), JSON.stringify(before.mainStatus));
    const code = await hostOpen(A, SBAM, 2);
    await guestJoin(B, code); await admit(A, 1);
    await B.waitFor(`(window.__gbaNet().localPorts || []).length > 0`, { timeoutMs: 30000, pollMs: 200 });
    await sleep(500);
    const during = await guestState(B);
    ok('once the room forms the status bar no longer says "Fetching ..." (it says the room is forming) and the picker shows the ROOM\'s game', !/Fetching/.test(during.mainStatus) && /Party room/.test(during.mainStatus) && during.romSelect === 'Super Bust-A-Move', JSON.stringify([during.mainStatus, during.romSelect]));
    await shot(B, 'solofetch_room_forming');
    await st.release();                                       // the stale solo ROM now "arrives"
    await allRunning(pages, 60);
    const after = await B.eval(`({ main: document.getElementById('status').textContent, banner: document.getElementById('banner').textContent, running: window.__gbaNet().running, rom: window.myApp.rom_name })`);
    ok('the late solo ROM changes nothing: no "ROM fetch failed" / "Could not load" banner, no solo game, and the room runs ("Room - Super Bust-A-Move")', /^Room — Super Bust-A-Move/.test(after.main) && !/Could not load|failed/i.test(after.banner + after.main) && after.running, JSON.stringify(after));
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
    await B.waitFor('!window.__gbaNet().session && window.myApp.isWasmReady', { timeoutMs: 40000, pollMs: 250 });
    const done = await guestState(B);
    ok('after Leave the status bar is the plain idle line again', /^Core ready\./.test(done.mainStatus), JSON.stringify(done.mainStatus));
  });
}

// ── the stored-save note ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function sectionSavenote(report) {
  section('savenote: a stored save of the WRONG SIZE is told to its owner at the start, in one sentence - not only by the end-of-room sentence');
  await withBrowserMulti({ ...VIEW, port: CDP_BASE, windows: 2 }, async ({ pages }) => {
    const [A, B] = pages;
    await openAll(pages);
    await A.eval(`(async () => { await myApp._dbPut('${KIRBY_FILE}.mgba.sav', new Uint8Array([1, 2, 3, 4, 5])); return true; })()`);
    await formRoom(pages, KIRBY, 2);
    await A.waitFor(`/does not fit/.test(document.getElementById('netBarrier').textContent)`, { timeoutMs: 60000, pollMs: 250 }).catch(() => null);
    const a = await A.eval(`document.getElementById('netBarrier').textContent`), b = await B.eval(`document.getElementById('netBarrier').textContent`);
    await shot(A, 'savenote_wrong_size');
    ok('the player with the wrong-size stored save is told at the start, in ONE sentence: "Your stored save does not fit <game> (it is 5 bytes; this game keeps 32768), so this room starts from a blank save and your stored one is left untouched."', /Your stored save does not fit Kirby Nightmare in Dreamland \(it is 5 bytes; this game keeps 32768\), so this room starts from a blank save and your stored one is left untouched\./.test(a), JSON.stringify(a));
    control('the other player (a normal save) is told nothing of the kind', !/does not fit/.test(b), JSON.stringify(b));
    await allRunning(pages, 30);
    const st = await A.eval(`window.__gbaNet().phase`);
    ok('the room still forms and runs from a blank save for that seat', st === 'playing', st);
    await B.eval('window.__gbaNet().leave(true)'); await A.eval('window.__gbaNet().leave(true)');
  });
}

const sections = { redirect: sectionRedirect, audio: sectionAudio, bind: sectionBind, alloc: sectionAlloc, ux: sectionUx, cap: sectionCap, picker: sectionPicker, hostleft: sectionHostleft, race: sectionRace, third: sectionThird, solofetch: sectionSolofetch, savenote: sectionSavenote, two: sectionTwo, kirby: sectionKirby, desync: sectionDesync, refuse: sectionRefuse, save: sectionSave, recover: sectionRecover, kill: sectionKill, leave: sectionLeave, boot: sectionBoot, mobile: sectionMobile, speed: sectionSpeed };
process.on('unhandledRejection', (e) => { fail++; console.log('  FAIL unhandled promise rejection  ' + ((e && e.stack) || e)); });
(async () => {
  const report = {};
  console.log('=== gba.html lockstep link-cable rooms (stage GR2) ===');
  console.log('load before: Windows CPU busy ' + cpuLoad() + '%');
  const wasmBefore = md5(fs.readFileSync(path.join(ROOT, 'gba/mgba/dist/mgba_core.wasm'))), jsBefore = md5(fs.readFileSync(path.join(ROOT, 'gba/mgba/dist/mgba_core.js')));
  let srv = null, releaseLock = () => {};
  try {
    if (want('static')) await sectionStatic();
    if (flag('--browser')) {
      // GBA_NETPLAY_HOLD_LOCK=1: take the machine-wide browser lock ONCE for the whole run instead of once per section. Other agents hold it for
      // long stretches and every section re-queues behind them (a full run starved for most of an hour); holding it is what a long suite on this
      // box does anyway. Off by default (a section releases it so a sibling rig can interleave).
      if (process.env.GBA_NETPLAY_HOLD_LOCK === '1') {
        const { acquireBrowserLock } = await import('./headless_cdp.mjs');
        releaseLock = await acquireBrowserLock({ timeoutMs: 4 * 3600 * 1000, pollMs: 500 });
        VIEW.lock = false;
        console.log('holding the browser lock for the whole run');
      }
      srv = await ensureServer();
      // one section throwing is ONE failed section, reported by name - never the end of the run (the first browser run of this file lost every
      // later section to a single uncaught TypeError)
      // GBA_NETPLAY_REPEAT=N runs the selected sections N times in this one run (the flaky-gate evidence: `--only kill` five times under one lock hold)
      for (let rep = 1; rep <= Math.max(1, Number(process.env.GBA_NETPLAY_REPEAT) || 1); rep++) {
        if (rep > 1) console.log('\n##### repeat ' + rep + ' of ' + process.env.GBA_NETPLAY_REPEAT + ' #####');
        for (const name of Object.keys(sections)) if (only.length ? only.includes(name) : true) {
          try { await sections[name](report); } catch (e) { fail++; console.log('  FAIL section ' + name + ' threw  ' + ((e && e.stack) || e)); }
        }
      }
    }
  } catch (e) { fail++; console.log('  FAIL harness  ' + ((e && e.stack) || e)); }
  finally { if (srv) srv.stop(); releaseLock(); }
  const wasmAfter = md5(fs.readFileSync(path.join(ROOT, 'gba/mgba/dist/mgba_core.wasm'))), jsAfter = md5(fs.readFileSync(path.join(ROOT, 'gba/mgba/dist/mgba_core.js')));
  ok('the core artifact is byte-identical before and after (wasm ' + wasmBefore.slice(0, 8) + ', glue ' + jsBefore.slice(0, 8) + ')', wasmBefore === wasmAfter && jsBefore === jsAfter);
  console.log('load after: Windows CPU busy ' + cpuLoad() + '%');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\n[gba-netplay] ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();

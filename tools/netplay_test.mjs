#!/usr/bin/env node
// Does lib/netplay.js actually pair two independent page contexts and carry
// input between them? Everything here is MEASURED on two real tabs with a real
// RTCPeerConnection — no mocks, because a mocked data channel would prove
// nothing about the part that breaks.
//
// USAGE  npm run web  &&  node tools/netplay_test.mjs
import puppeteer from 'puppeteer';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok  = (n, d) => { res.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
const mk = async () => {
  const p = await browser.newPage();
  // A LIGHT page on the same origin. dreamcast.html installs coi-serviceworker
  // and reloads itself, which races an injected script tag away — that is a rig
  // artifact, not a netplay failure, and it cost one confusing run.
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return p;
};
const host = await mk(), guest = await mk();

console.log('\n== pairing ==');
const supported = await host.evaluate(() => Netplay.supported());
supported ? ok('supported', 'RTCPeerConnection + BroadcastChannel present')
          : bad('supported', 'browser lacks the primitives');

const code = await host.evaluate(() => Netplay.makeCode(5));
/^[A-HJ-NP-Z2-9]{5}$/.test(code) ? ok('code-format', `"${code}" — no look-alike characters`)
                                 : bad('code-format', code);

const boot = async (page, isHost) => page.evaluate(async (code, isHost) => {
  window.__log = [];
  const s = new Netplay.Session({ game: 'gauntlet', host: isHost, code, transport: 'local', delayFrames: 0 });
  window.__s = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  s.on('sync', (m) => { window.__sync = m.payload; });
  await s.start();
  return true;
}, code, isHost);
await boot(host, true);
await boot(guest, false);

// ⚠ POLL FROM NODE, not page.waitForFunction. waitForFunction polls on rAF, and
// a BACKGROUND TAB has its rAF throttled to near-nothing — so the host reported
// host=false while its own status log already read "connected" and the input
// exchange below passed in both directions. That was the rig timing out, not the
// session failing.
const wait = async (p) => {
  for (let i = 0; i < 150; i++) {
    if (await p.evaluate(() => window.__s && window.__s.state === 'connected')) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};
const [hc, gc] = [await wait(host), await wait(guest)];
(hc && gc) ? ok('datachannel-open', 'both peers report connected')
           : bad('datachannel-open', `host=${hc} guest=${gc} hostLog=${JSON.stringify(await host.evaluate(() => window.__log))}`);

console.log('\n== input exchange ==');
// Each side pushes a distinct value per frame; each must SEE the other's value.
await host.evaluate(() => { window.__got = []; for (let f = 0; f < 8; f++) window.__got.push(window.__s.exchange(0x100 + f)); });
await guest.evaluate(() => { window.__got = []; for (let f = 0; f < 8; f++) window.__got.push(window.__s.exchange(0x200 + f)); });
await new Promise(r => setTimeout(r, 800));
const hRemote = await host.evaluate(() => [...window.__s.remoteInputs.entries()].sort((a,b)=>a[0]-b[0]).map(e => e[1]));
const gRemote = await guest.evaluate(() => [...window.__s.remoteInputs.entries()].sort((a,b)=>a[0]-b[0]).map(e => e[1]));
const wantG = [0x200,0x201,0x202,0x203,0x204,0x205,0x206,0x207];
const wantH = [0x100,0x101,0x102,0x103,0x104,0x105,0x106,0x107];
JSON.stringify(hRemote) === JSON.stringify(wantG) ? ok('host-receives-guest-input', hRemote.map(v=>'0x'+v.toString(16)).join(','))
  : bad('host-receives-guest-input', JSON.stringify(hRemote));
JSON.stringify(gRemote) === JSON.stringify(wantH) ? ok('guest-receives-host-input', gRemote.map(v=>'0x'+v.toString(16)).join(','))
  : bad('guest-receives-host-input', JSON.stringify(gRemote));

// A frame with no remote input MUST return null, not a stale or invented value:
// guessing is what turns one dropped packet into a permanent desync.
const stall = await host.evaluate(() => window.__s.exchange(0xdead));
stall === null ? ok('missing-input-returns-null', 'caller is told to stall rather than guess')
               : bad('missing-input-returns-null', 'got ' + stall);

console.log('\n== savestate handoff ==');
await host.evaluate(() => window.__s.sendSync('STATE-BLOB-abc123'));
await new Promise(r => setTimeout(r, 500));
const got = await guest.evaluate(() => window.__sync);
got === 'STATE-BLOB-abc123' ? ok('sync-payload-crosses', got) : bad('sync-payload-crosses', String(got));

console.log('\n== host streams the game, guest sends the pad ==');
// The host paints a canvas and captures it; the guest must RECEIVE a live video
// track. This is the whole architecture in one assertion.
const code3 = await host.evaluate(() => Netplay.makeCode(5));
await host.evaluate(async (c) => {
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  let i = 0;
  setInterval(() => { g.fillStyle = ['#f00','#0f0','#00f'][i++ % 3]; g.fillRect(0,0,320,240); }, 33);
  const s = new Netplay.Session({ game: 'gauntlet', host: true, code: c, transport: 'local' });
  window.__h2 = s;
  window.__captured = s.attachMedia(cv, null);     // BEFORE start(), or no track
  await s.start();
}, code3);
await guest.evaluate(async (c) => {
  const s = new Netplay.Session({ game: 'gauntlet', host: false, code: c, transport: 'local' });
  window.__g2 = s;
  s.on('stream', (ms) => { window.__tracks = ms.getTracks().map(t => t.kind + ':' + t.readyState); });
  await s.start();
}, code3);
const captured = await host.evaluate(() => window.__captured);
captured ? ok('host-captures-canvas', 'canvas.captureStream attached before the offer')
         : bad('host-captures-canvas', 'attachMedia returned false');
let tracks = null;
for (let i = 0; i < 100 && !tracks; i++) { tracks = await guest.evaluate(() => window.__tracks); await new Promise(r => setTimeout(r, 200)); }
(tracks && tracks.some(t => t.startsWith('video:live')))
  ? ok('guest-receives-video', JSON.stringify(tracks))
  : bad('guest-receives-video', JSON.stringify(tracks));

// pad travels guest -> host and is readable as player 2
for (let i = 0; i < 60 && !(await host.evaluate(() => window.__h2.state === 'connected')); i++) await new Promise(r => setTimeout(r, 200));
await guest.evaluate(() => window.__g2.sendPad(0x0A5));
await new Promise(r => setTimeout(r, 600));
const pad = await host.evaluate(() => window.__h2.remotePad());
pad === 0x0A5 ? ok('guest-pad-reaches-host', '0x' + pad.toString(16) + ' — readable as player 2')
              : bad('guest-pad-reaches-host', '0x' + Number(pad).toString(16));
// an out-of-order pad must be DISCARDED: a stale pad state is worse than none
await guest.evaluate(() => { const s = window.__g2; s._padSeq = -5; s.sendPad(0xFFF); });
await new Promise(r => setTimeout(r, 500));
const pad2 = await host.evaluate(() => window.__h2.remotePad());
pad2 === 0x0A5 ? ok('stale-pad-discarded', 'out-of-order packet ignored, still 0x' + pad2.toString(16))
               : bad('stale-pad-discarded', 'stale value applied: 0x' + Number(pad2).toString(16));

console.log('\n== refuses a mismatched game ==');
const code2 = await host.evaluate(() => Netplay.makeCode(5));
await host.evaluate(async (c) => { const s = new Netplay.Session({ game: 'gauntlet', host: true, code: c, transport: 'local' }); window.__m = s; await s.start(); }, code2);
await guest.evaluate(async (c) => {
  window.__mlog = [];
  const s = new Netplay.Session({ game: 'pso2', host: false, code: c, transport: 'local' });
  s.on('status', e => window.__mlog.push(e.state + (e.detail ? ':' + e.detail : '')));
  window.__m = s; await s.start();
}, code2);
await new Promise(r => setTimeout(r, 1200));
const mlog = await guest.evaluate(() => window.__mlog);
mlog.some(l => l.startsWith('failed')) ? ok('mismatched-game-refused', JSON.stringify(mlog))
  : bad('mismatched-game-refused', JSON.stringify(mlog) + ' — two different discs would have desynced');

await browser.close();
const bad_ = res.filter(r => !r.ok);
console.log(`\n[netplay] ${res.length - bad_.length}/${res.length} passed`);
process.exit(bad_.length ? 1 : 0);

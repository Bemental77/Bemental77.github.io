#!/usr/bin/env node
// THE ATTACK ARM. An uninvited peer that KNOWS THE ROOM CODE must get nothing.
//
// WHY THIS EXISTS. docs/audit-2026-09-08.md, "New finding: any session can be
// joined by a stranger": lib/netplay.js registered the host on the PUBLIC PeerJS
// broker as `bemental-<CODE>-h`, accepted EVERY inbound connection, and sent an
// SDP offer carrying its video and audio the moment start() returned. The
// 5-character code (32^5 = 33,554,432) was the only secret and it was written
// into the broker id in the clear. Anyone who guessed one got the host's live
// screen and sound, player-2 input into the running game, and the save.
//
// ⚠ THE ATTACKER HERE IS HANDED THE CODE. That is the whole point. A test where
// the attacker fails to reach the host proves nothing — it could be failing for
// any reason. This one PROVES it got as far as the host (the host raises a join
// request for it) and still receives no picture, no sound, no input path and no
// save, because a human never said yes.
//
// EVERY NEGATIVE IS MEASURED AT THE PLACE IT WOULD LEAK, not read off a flag:
//   video   the attacker's own RTCPeerConnection: ontrack never fired, there is
//           no MediaStream, and getStats has no inbound video
//   audio   same, plus totalSamplesReceived — the field that catches a live
//           track carrying silence (tools/netplay_test.mjs documents that trap)
//   SDP     a raw BroadcastChannel spy on the signalling room. Zero 'offer' and
//           zero 'ice' messages ever appear, so neither the media description
//           nor the host's local addresses left the host page at all
//   input   the attacker holds a pad for seconds; the host's remotePad() — the
//           exact value an emulator reads as player 2 — stays 0x0
//   save    the host CALLS sendSave() and it refuses; the attacker's 'save'
//           handler never fires
//
// Then the happy path runs on the same host, with the same code, and must still
// work end to end — a gate that also breaks the invited player is not a fix.
//
// USAGE   npm run web  &&  node tools/netplay_attack_test.mjs
//   node tools/browser_leak_guard.js reap && uptime      # gate, per CLAUDE.md
import puppeteer from 'puppeteer';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
const res = [];
const ok  = (n, d) => { res.push({ n, ok: true }); console.log(`  PASS  ${n}  ${d}`); };
const bad = (n, d) => { res.push({ n, ok: false }); console.log(`  FAIL  ${n}  ${d}`); };
const info = (n, d) => console.log(`  ....  ${n}  ${d}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

// ATTACK_HEADLESS=0 runs this with a visible window. Headless is the default and
// grants fullscreen fine for the last arm, given a trusted CDP click.
const HEADLESS = process.env.ATTACK_HEADLESS === '0' ? false : 'new';
const browser = await puppeteer.launch({
  headless: HEADLESS, executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1100,800'],
});
try { (await import('./browser_leak_guard.js')).default.guard(browser, 'netplay_attack_test'); } catch (_e) {}

const mk = async (label) => {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.log(`  [${label}!] ${e.message}`));
  await p.goto(ORIGIN + '/contact.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.addScriptTag({ url: ORIGIN + '/lib/netplay.js' });
  await p.waitForFunction(() => typeof window.Netplay === 'object', { timeout: 20000 });
  return p;
};
const host = await mk('host'), attacker = await mk('attacker'), friend = await mk('friend');

// ---------------------------------------------------------------------------
// The host: a real canvas, a real 440 Hz tone, real attachMedia. This is the
// same rig tools/netplay_test.mjs uses for its streaming arm, so "the attacker
// saw nothing" cannot be explained by there being nothing to see — the friend
// arm at the end reads the same stream and gets 60 fps of it.
const CODE = await host.evaluate(() => Netplay.makeCode(5));
console.log(`\n== a host is streaming a real game under code ${CODE} ==`);
await host.evaluate(async (c) => {
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  let i = 0;
  setInterval(() => { g.fillStyle = ['#f00', '#0f0', '#00f'][i++ % 3]; g.fillRect(0, 0, 320, 240); }, 33);
  const ctx = new AudioContext({ sampleRate: 44100 });
  await ctx.resume();
  const osc = ctx.createOscillator(); osc.frequency.value = 440;
  const tone = ctx.createGain(); tone.gain.value = 0.5;
  osc.connect(tone); tone.connect(ctx.destination); osc.start();

  window.__reqs = [];          // every join request the host was asked
  window.__allow = null;       // the rig fills this in with an id to approve
  const s = new Netplay.Session({ game: 'gauntlet', host: true, code: c, transport: 'local' });
  window.__h = s;
  // THIS IS THE ALLOW BUTTON, minus the pixels: the built-in dialog in
  // lib/netplay.js calls exactly these two methods. Nothing is approved until
  // the rig arms window.__allow, which stands in for a person clicking.
  s.on('join-request', (r) => {
    window.__reqs.push({ id: r.id, sas: r.sas, game: r.game, at: Date.now() });
    window.__lastReq = r;
    if (window.__allow === 'next' || window.__allow === r.id) { window.__approvedId = r.id; r.approve(); }
  });
  s.on('reject', (r) => { (window.__rejects = window.__rejects || []).push(r); });
  window.__captured = s.attachMedia(cv, tone);
  await s.start();
}, CODE);
const captured = await host.evaluate(() => window.__captured);
captured ? ok('host-has-a-real-stream-to-lose', 'canvas + 440 Hz tone attached before the offer — there IS something to steal')
         : bad('host-has-a-real-stream-to-lose', 'attachMedia returned false; the rest of this file would prove nothing');

// ---------------------------------------------------------------------------
console.log(`\n== an uninvited peer that KNOWS the code tries to join ==`);
// A passive spy on the signalling room, opened BEFORE the attacker's session so
// nothing can be missed. On the BroadcastChannel transport this hears every
// message in the room — a strictly better vantage point than a real attacker
// gets — so "no offer was ever sent" is measured, not inferred.
await attacker.evaluate((c) => {
  window.__spy = [];
  const ch = new BroadcastChannel('netplay:' + c);
  ch.onmessage = (e) => { if (e.data && e.data.room === c) window.__spy.push(e.data.t); };
  window.__spyCh = ch;
}, CODE);
await attacker.evaluate(async (c) => {
  window.__tracks = null; window.__save = null; window.__log = []; window.__ontrack = 0;
  const s = new Netplay.Session({ game: 'gauntlet', host: false, code: c, transport: 'local' });
  window.__a = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  s.on('stream', (ms) => { window.__ontrack++; window.__tracks = ms.getTracks().map((t) => t.kind + ':' + t.readyState); });
  s.on('save', (e) => { window.__save = e.ok ? { ok: true, len: e.bytes.length } : { ok: false, error: e.error }; });
  await s.start();
}, CODE);

// Let it try for as long as a real pairing takes. tools/netplay_test.mjs sees a
// local-transport pairing complete well inside 2 s; 8 s is four times that.
await sleep(8000);

// 1. It really did reach the host — the negative below is a REFUSAL, not a miss.
const reqs = await host.evaluate(() => window.__reqs);
(reqs.length === 1 && /^[A-HJ-NP-Z2-9]{4}$/.test(reqs[0].sas || ''))
  ? ok('ATTACKER-REACHED-THE-HOST', `the host was asked to admit it (confirmation code ${reqs[0].sas}) — it knew the code and still gets nothing below`)
  : bad('ATTACKER-REACHED-THE-HOST', `${J(reqs)} — if it never reached the host, every negative below is vacuous`);

const aState = await attacker.evaluate(() => window.__a.state);
(aState !== 'connected')
  ? ok('attacker-is-NOT-connected', `attacker session state = "${aState}" after 8 s with the correct code`)
  : bad('attacker-is-NOT-connected', 'the attacker is connected');

// 2. NO VIDEO, NO AUDIO — measured on the attacker's own peer connection.
const media = await attacker.evaluate(async () => {
  const s = window.__a;
  const ms = s.remoteStream && s.remoteStream();
  const out = { ontrackFired: window.__ontrack, tracks: window.__tracks,
                streamTracks: ms ? ms.getTracks().map((t) => t.kind) : null, inbound: [] };
  try {
    (await s._pc.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp') out.inbound.push({ kind: r.kind, packets: r.packetsReceived || 0,
                                                       bytes: r.bytesReceived || 0, samples: r.totalSamplesReceived || 0,
                                                       frames: r.framesDecoded || 0 });
    });
  } catch (e) { out.statsErr = e.message; }
  return out;
});
const vid = media.inbound.filter((r) => r.kind === 'video');
const aud = media.inbound.filter((r) => r.kind === 'audio');
(media.ontrackFired === 0 && !media.streamTracks && vid.every((r) => r.frames === 0 && r.bytes === 0))
  ? ok('attacker-gets-NO-VIDEO', `ontrack never fired, remoteStream() is null, inbound video ${vid.length ? J(vid) : '(no report at all)'}`)
  : bad('attacker-gets-NO-VIDEO', J(media));
(!media.streamTracks && aud.every((r) => (r.samples || 0) === 0 && r.bytes === 0))
  ? ok('attacker-gets-NO-AUDIO', `no audio track; totalSamplesReceived ${aud.length ? J(aud) : '(no inbound audio report at all)'} — the field that catches a live track carrying silence`)
  : bad('attacker-gets-NO-AUDIO', J(media));

// 3. THE OFFER NEVER LEFT THE HOST. The media is IN the SDP offer, so this is
//    the assertion that says the picture was never published in the first place
//    rather than published and then discarded. ICE candidates are the host's
//    local addresses — those did not leave either.
const spy = await attacker.evaluate(() => window.__spy.slice());
const hostAdm = await host.evaluate(() => window.__h.admission());
info('signalling-seen-by-the-attacker', spy.join(', ') || '(nothing)');
(!spy.includes('offer') && !spy.includes('ice'))
  ? ok('no-SDP-OFFER-and-no-ICE-on-the-wire', `the room carried [${spy.join(', ')}] — no offer, so no track description and no host addresses ever left the page`)
  : bad('no-SDP-OFFER-and-no-ICE-on-the-wire', `saw [${spy.join(', ')}]`);
(hostAdm.approved === false && hostAdm.offered === false)
  ? ok('host-created-no-offer-at-all', `admission() = ${J(hostAdm)} — localDescription is still null, so nothing was even gathered`)
  : bad('host-created-no-offer-at-all', J(hostAdm));

// 4. INPUT. The attacker holds a pad; the host's remotePad() is what an emulator
//    reads as player 2.
await attacker.evaluate(() => { for (let i = 0; i < 20; i++) window.__a.sendPad(0x5A5); });
await sleep(1200);
const pad = await host.evaluate(() => ({ remotePad: window.__h.remotePad(),
                                         dc: window.__h._dc ? window.__h._dc.readyState : null }));
(pad.remotePad === 0 && pad.dc !== 'open')
  ? ok('attacker-INPUT-never-reaches-the-core', `host remotePad() = 0x${pad.remotePad.toString(16)} with the attacker holding 0x5a5; the DataChannel is "${pad.dc}", not open`)
  : bad('attacker-INPUT-never-reaches-the-core', J(pad));

// 5. THE SAVE. The host actively tries to send one.
const saveSend = await host.evaluate(async () => {
  const u = new Uint8Array(64 * 1024); for (let i = 0; i < u.length; i++) u[i] = i & 0xff;
  const r = await window.__h.sendSave(u, { kind: 'vmu', slot: 'A1' });
  return { returned: r, why: window.__h.lastError };
});
await sleep(1200);
const gotSave = await attacker.evaluate(() => window.__save);
(saveSend.returned === false && gotSave === null)
  ? ok('attacker-gets-NO-SAVE', `sendSave() refused ("${saveSend.why}") and the attacker's save handler never fired`)
  : bad('attacker-gets-NO-SAVE', `sendSave returned ${saveSend.returned}, attacker got ${J(gotSave)}`);

// 6. A pending request is not replaced by a later caller — otherwise an Allow
//    meant for the invited player could land on whoever knocked last.
await friend.evaluate(async (c) => {
  window.__log = [];
  const s = new Netplay.Session({ game: 'gauntlet', host: false, code: c, transport: 'local' });
  window.__f = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  s.on('stream', (ms) => { window.__tracks = ms.getTracks().map((t) => t.kind + ':' + t.readyState); });
  s.on('save', (e) => {
    if (!e.ok) { window.__save = { ok: false, error: e.error }; return; }
    let sum = 0; for (let i = 0; i < e.bytes.length; i++) sum = (sum + e.bytes[i]) >>> 0;
    window.__save = { ok: true, len: e.bytes.length, sum, encoding: e.encoding };
  });
  await s.start();
}, CODE);
await sleep(3000);
const fLog = await friend.evaluate(() => window.__log.join(' | '));
const stillOne = await host.evaluate(() => window.__reqs.length);
(stillOne === 1 && /already talking to someone else/.test(fLog))
  ? ok('a-pending-request-is-not-replaced', `the second caller was told "busy" (${fLog}) — the prompt on screen still belongs to the first`)
  : bad('a-pending-request-is-not-replaced', `reqs=${stillOne} friendLog="${fLog}"`);

// 7. DENY, and the attacker is told so rather than left hanging.
//    ⚠ ARM THE APPROVAL FIRST. The moment the attacker's slot frees, the friend
//    that has been retrying since step 6 will claim it — if the rig were not
//    armed yet, that request would raise a prompt nobody answers and the happy
//    path below would sit behind a 'busy' forever. This ordering is a property
//    of the rig, not of the product.
await host.evaluate(() => { window.__allow = 'next'; });
await host.evaluate(() => window.__lastReq.deny('no thanks'));
await sleep(1500);
const aLog = await attacker.evaluate(() => window.__log.join(' | '));
/failed/.test(aLog)
  ? ok('deny-tells-the-caller', `attacker status log: ${aLog}`)
  : bad('deny-tells-the-caller', aLog);

// ---------------------------------------------------------------------------
console.log('\n== and the INVITED player still gets everything ==');
// Same host, same code, same session — the one waiting player is now allowed
// in, and its hello retry is what carries it there without a page reload.
let connected = false;
for (let i = 0; i < 100 && !connected; i++) {
  connected = await friend.evaluate(() => window.__f.state === 'connected');
  if (!connected) await sleep(200);
}
connected ? ok('approved-guest-connects', 'the invited player paired after the host allowed it')
          : bad('approved-guest-connects', `friend log: ${await friend.evaluate(() => window.__log.join(' | '))}`);

let ftracks = null;
for (let i = 0; i < 80 && !ftracks; i++) { ftracks = await friend.evaluate(() => window.__tracks); await sleep(200); }
(ftracks && ftracks.some((t) => t.startsWith('video:live')))
  ? ok('approved-guest-gets-the-video', J(ftracks))
  : bad('approved-guest-gets-the-video', J(ftracks));

await friend.evaluate(() => window.__f.sendPad(0x0A5));
await sleep(800);
const fpad = await host.evaluate(() => window.__h.remotePad());
fpad === 0x0A5 ? ok('approved-guest-input-reaches-the-core', `host remotePad() = 0x${fpad.toString(16)}`)
               : bad('approved-guest-input-reaches-the-core', `0x${Number(fpad).toString(16)}`);

const fsave = await host.evaluate(async () => {
  const N = 256 * 1024;
  const u = new Uint8Array(N);
  let x = 987654321;
  for (let i = 0; i < N; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; u[i] = x & 0xff; }
  let sum = 0; for (let i = 0; i < N; i++) sum = (sum + u[i]) >>> 0;
  window.__sentSum = sum;
  return { sent: await window.__h.sendSave(u, { kind: 'vmu' }), sum };
});
let rx = null;
for (let i = 0; i < 100 && !rx; i++) { rx = await friend.evaluate(() => window.__save); await sleep(200); }
(fsave.sent && rx && rx.ok && rx.sum === fsave.sum)
  ? ok('approved-guest-gets-the-save', `${rx.len} B, encoding=${rx.encoding}, checksum ${rx.sum} matches the sender`)
  : bad('approved-guest-gets-the-save', `sent=${fsave.sent} got=${J(rx)}`);

// And the attacker, still sitting there with the correct code, still has nothing
// — including now that an offer HAS been created and (on this broadcast
// transport) was visible to it. It is addressed to the approved joiner's nonce.
const after = await attacker.evaluate(async () => {
  const s = window.__a;
  const ms = s.remoteStream && s.remoteStream();
  let frames = 0;
  try { (await s._pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') frames += (r.framesDecoded || 0); }); } catch (e) {}
  return { state: s.state, stream: ms ? ms.getTracks().map((t) => t.kind) : null, frames, save: window.__save };
});
(after.stream === null && after.frames === 0 && after.save === null)
  ? ok('DENIED-PEER-STILL-HAS-NOTHING', `after a real pairing completed in the same room: state="${after.state}", no stream, 0 frames decoded, no save`)
  : bad('DENIED-PEER-STILL-HAS-NOTHING', J(after));

// ---------------------------------------------------------------------------
console.log('\n== a host with no way to ask REFUSES rather than defaults open ==');
// ui:false and no 'join-request' handler means there is nobody to ask. Failing
// open there would put the whole hole straight back.
const CODE2 = await host.evaluate(() => Netplay.makeCode(5));
await host.evaluate(async (c) => {
  const s = new Netplay.Session({ game: 'gauntlet', host: true, code: c, transport: 'local', ui: false });
  window.__h2 = s; await s.start();
}, CODE2);
await friend.evaluate(async (c) => {
  window.__log2 = [];
  const s = new Netplay.Session({ game: 'gauntlet', host: false, code: c, transport: 'local' });
  window.__f2 = s;
  s.on('status', (e) => window.__log2.push(e.state + (e.detail ? ':' + e.detail : '')));
  await s.start();
}, CODE2);
await sleep(4000);
const log2 = await friend.evaluate(() => window.__log2.join(' | '));
const adm2 = await host.evaluate(() => window.__h2.admission());
(/failed/.test(log2) && adm2.approved === false && adm2.offered === false)
  ? ok('no-human-means-NO', `refused with "${log2}"; the host never created an offer`)
  : bad('no-human-means-NO', `log=${log2} admission=${J(adm2)}`);

// ---------------------------------------------------------------------------
console.log('\n== the prompt reaches a host who is playing FULLSCREEN ==');
// ⚠ ALL SEVEN HOST PAGES CALL requestFullscreen. While an element is
// fullscreen the browser renders ONLY that element's subtree, so a dialog on
// <body> is invisible: the person playing is never asked, and the invited
// player is auto-denied two minutes later with nothing said on either side.
// This arm takes a REAL fullscreen (a real click, for the user activation the
// API requires) and asserts the dialog lands inside it.
// A FRESH page, not the busy host above: requestFullscreen needs a TRUSTED
// click (element.click() from script carries no user activation), and CDP is
// how a rig produces one.
const fsHost = await mk('fs-host');
const fsOk = await (async () => {
  try {
    await fsHost.evaluate(() => {
      const d = document.createElement('div');
      d.id = 'fsbox';
      d.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px;background:#111;z-index:2147483000';
      const b = document.createElement('button');
      b.id = 'fsgo'; b.textContent = 'fs';
      // ⚠ ON TOP OF EVERYTHING, or the trusted click below lands on whatever
      // the page has at those coordinates and no activation reaches the button.
      b.style.cssText = 'position:fixed;left:20px;top:20px;width:80px;height:40px;z-index:2147483001';
      b.onclick = () => { d.requestFullscreen().catch((e) => { window.__fsErr = e.message; }); };
      document.body.append(d, b);
    });
    const at = await fsHost.evaluate(() => {
      const r = document.getElementById('fsgo').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const cdp = await fsHost.target().createCDPSession();
    // buttons:1 and a preceding mouseMoved are both load-bearing: without them
    // the click is delivered but carries no user activation and
    // requestFullscreen resolves to nothing.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(1200);
    return await fsHost.evaluate(() => (document.fullscreenElement && document.fullscreenElement.id) || window.__fsErr || 'not granted');
  } catch (e) { return 'rig error: ' + e.message; }
})();
if (fsOk !== 'fsbox') {
  info('prompt-reaches-a-FULLSCREEN-host', `SKIPPED — this browser would not grant fullscreen (${fsOk}); the branch is unmeasured here, NOT proven`);
} else {
  const CODE3 = await fsHost.evaluate(() => Netplay.makeCode(5));
  // No 'join-request' handler on this one, so the BUILT-IN dialog is what runs
  // — which is what every page ships with.
  await fsHost.evaluate(async (c) => {
    const s = new Netplay.Session({ game: 'gauntlet', host: true, code: c, transport: 'local' });
    window.__h3 = s; await s.start();
  }, CODE3);
  await attacker.evaluate(async (c) => {
    const s = new Netplay.Session({ game: 'gauntlet', host: false, code: c, transport: 'local' });
    window.__a3 = s; await s.start();
  }, CODE3);
  let where = null;
  for (let i = 0; i < 60 && !where; i++) {
    where = await fsHost.evaluate(() => {
      const p = document.getElementById('npApprove');
      return p ? { parent: p.parentElement ? (p.parentElement.id || p.parentElement.tagName) : null,
                   inFullscreen: !!(document.fullscreenElement && document.fullscreenElement.contains(p)) } : null;
    });
    if (!where) await sleep(250);
  }
  (where && where.inFullscreen)
    ? ok('prompt-reaches-a-FULLSCREEN-host', `the Allow/Deny dialog mounted inside <#${where.parent}>, the fullscreen element — a host mid-game is still asked`)
    : bad('prompt-reaches-a-FULLSCREEN-host', `${J(where)} — a fullscreen host would never see the request`);
}

await browser.close();
const nbad = res.filter((r) => !r.ok).length;
console.log(`\n[netplay-attack] ${res.length - nbad}/${res.length} passed`);
process.exit(nbad ? 1 : 0);

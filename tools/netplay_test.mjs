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

const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME, args: [
  '--no-sandbox',
  // The audio arm below needs an AudioContext that RUNS. Without this the
  // context starts 'suspended' with no gesture to resume it and the host's tone
  // would be a real zero — a rig artifact indistinguishable from the bug the
  // arm exists to catch. The arm asserts the context state anyway, so a
  // suspended one is REPORTED rather than silently scored as silence.
  '--autoplay-policy=no-user-gesture-required',
] });
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

// ⚠ A HOST NOW ADMITS NOBODY UNTIL A HUMAN SAYS SO (docs/audit-2026-09-08.md:
// "any session can be joined by a stranger"). Registering a 'join-request'
// handler is what a page does instead of taking the built-in Allow/Deny dialog;
// this rig approves from it, which is also how the arm below asserts that the
// request really was raised and carried a confirmation code.
const boot = async (page, isHost) => page.evaluate(async (code, isHost) => {
  window.__log = [];
  window.__req = null;
  const s = new Netplay.Session({ game: 'gauntlet', host: isHost, code, transport: 'local', delayFrames: 0 });
  window.__s = s;
  s.on('status', (e) => window.__log.push(e.state + (e.detail ? ':' + e.detail : '')));
  s.on('sync', (m) => { window.__sync = m.payload; });
  if (isHost) s.on('join-request', (r) => { window.__req = { id: r.id, sas: r.sas, game: r.game }; r.approve(); });
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

// The pairing above only happened because the host was ASKED and answered. The
// request itself is the new thing: it carries a confirmation code both sides
// derive from the room key, so a host reading it out can tell whether they are
// talking to the person they invited.
const req = await host.evaluate(() => window.__req);
const gsas = await guest.evaluate(() => window.__s.sas);
(req && /^[A-HJ-NP-Z2-9]{4}$/.test(req.sas || ''))
  ? ok('host-was-asked-first', `join-request raised for game="${req.game}" with confirmation code ${req.sas} — no media, no input, no save until approve()`)
  : bad('host-was-asked-first', JSON.stringify(req));
(req && gsas && req.sas === gsas)
  ? ok('confirmation-code-matches-on-both-sides', `${req.sas} — derived from the room key and the challenge, not sent in the clear`)
  : bad('confirmation-code-matches-on-both-sides', `host=${req && req.sas} guest=${gsas}`);

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
  // A KNOWN TONE, so "did sound cross?" is a number and not an impression.
  // 440 Hz at amplitude 0.5, wired the way dreamcast.html wires its worklet:
  // node -> ctx.destination, and attachMedia takes a COPY off that same node.
  const ctx = new AudioContext({ sampleRate: 44100 });
  await ctx.resume();
  const osc = ctx.createOscillator(); osc.frequency.value = 440;
  const tone = ctx.createGain(); tone.gain.value = 0.5;
  osc.connect(tone); tone.connect(ctx.destination); osc.start();
  window.__hctx = ctx; window.__htone = tone;
  const s = new Netplay.Session({ game: 'gauntlet', host: true, code: c, transport: 'local' });
  window.__h2 = s;
  window.__h2req = null;
  // Same as above: the stream does not leave this page until this fires and is
  // answered. window.__h2.admission().offered stays false until then.
  s.on('join-request', (r) => { window.__h2req = { id: r.id, sas: r.sas }; r.approve(); });
  window.__captured = s.attachMedia(cv, tone);     // BEFORE start(), or no track
  await s.start();
}, code3);
await guest.evaluate(async (c) => {
  const s = new Netplay.Session({ game: 'gauntlet', host: false, code: c, transport: 'local' });
  window.__g2 = s;
  s.on('stream', (ms) => { window.__tracks = ms.getTracks().map(t => t.kind + ':' + t.readyState); });
  s.on('save', (e) => {
    if (!e.ok) { window.__save = { ok: false, error: e.error }; return; }
    let sum = 0; for (let i = 0; i < e.bytes.length; i++) sum = (sum + e.bytes[i]) >>> 0;
    window.__save = { ok: true, len: e.bytes.length, sum, encoding: e.encoding, kind: e.meta && e.meta.kind };
  });
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

console.log('\n== the guest can HEAR the host ==');
// ⚠ `audio:live` IS NOT EVIDENCE OF SOUND. A guest sat on exactly that track
// reading peak 0.00000 is what this arm was written for: an inbound WebRTC audio
// track produces NO SAMPLES until an HTMLMediaElement renders it, so a session
// whose page only ran Web Audio over the track was silent while every status in
// sight said connected. lib/netplay.js now owns a muted sink for precisely this;
// with that removed, this arm reads 0 again.
//
// A KNOWN AMPLITUDE, measured at three points, so a zero says WHERE it broke:
//   host-tone-at-source   the host's own captured track, before the wire
//   guest-audio-audible   the guest's received track, through Web Audio
//   (getStats)            totalSamplesReceived — no Web Audio involved at all
const PEAK = `
  window.__peak = async function (ctx, node, ms) {
    const an = ctx.createAnalyser(); an.fftSize = 2048; node.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    for (let i = 0; i < ms / 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      an.getFloatTimeDomainData(buf);
      for (let k = 0; k < buf.length; k++) if (Math.abs(buf[k]) > peak) peak = Math.abs(buf[k]);
    }
    return +peak.toFixed(5);
  };`;
await host.evaluate(PEAK); await guest.evaluate(PEAK);

// 1. IS THE TAP EVEN CARRYING THE TONE? Read the host's OWN captured
//    MediaStreamDestination track back. A zero here means attachMedia was handed
//    a node that is not on the path the game's sound takes, and nothing
//    downstream could ever have worked.
const srcSide = await host.evaluate(async () => {
  const at = window.__h2._stream.getAudioTracks();
  if (!at.length) return { err: 'attachMedia added no audio track' };
  const c2 = new AudioContext({ sampleRate: 44100 }); await c2.resume();
  const peak = await __peak(c2, c2.createMediaStreamSource(new MediaStream([at[0]])), 1000);
  await c2.close();
  return { ctx: __hctx.state, peak };
});
(!srcSide.err && srcSide.ctx === 'running' && srcSide.peak > 0.1)
  ? ok('host-tone-at-source', `the host's own captured track reads peak ${srcSide.peak} (440 Hz @ 0.5) — the tap is live before the wire`)
  : bad('host-tone-at-source', JSON.stringify(srcSide));

// 2. THE ONE THAT MATTERS. Deliberately NO media element of the test's own: this
//    is the bare pattern a page would use, and it is the pattern that measured
//    silence before lib/netplay.js started sinking the track itself.
await new Promise(r => setTimeout(r, 1500));       // let RTP flow
const heard = await guest.evaluate(async () => {
  const ms = window.__g2.remoteStream();
  const at = ms ? ms.getAudioTracks() : [];
  if (!at.length) return { err: 'no audio track on the received stream' };
  const c2 = new AudioContext({ sampleRate: 44100 }); await c2.resume();
  const peak = await __peak(c2, c2.createMediaStreamSource(new MediaStream([at[0]])), 2000);
  await c2.close();
  let stats = null;
  (await window.__g2._pc.getStats()).forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio')
      stats = { packets: r.packetsReceived, bytes: r.bytesReceived,
                samples: r.totalSamplesReceived, audioLevel: r.audioLevel };
  });
  return { peak, track: at[0].readyState, ctx: c2.state, stats };
});
(!heard.err && heard.peak > 0.1)
  ? ok('guest-audio-audible', `peak ${heard.peak} on the received track (host sent 0.5) — sound crosses the wire`)
  : bad('guest-audio-audible', `peak ${heard.err ? 'n/a' : heard.peak} — a live track carrying silence. ${JSON.stringify(heard)}`);
// The independent witness: samples the DECODER produced, with no Web Audio
// anywhere in the path. This is the field that read 0 WHILE PACKETS WERE
// ARRIVING, which is what proved the break was rendering and not transport.
// ⚠ Do not read audioLevel here. It is the level of what was RENDERED, and the
// session's sink is deliberately muted, so it reads 0.0000 on a perfectly
// working stream — through an AUDIBLE element the same track measured 0.5045.
// totalSamplesReceived is the field that means "the decoder ran".
(heard.stats && heard.stats.samples > 0)
  ? ok('guest-audio-decoded', `totalSamplesReceived=${heard.stats.samples} from ${heard.stats.packets} packets / ` +
      `${heard.stats.bytes} B — getStats agrees, independently of Web Audio`)
  : bad('guest-audio-decoded', `packets arrived but the decoder produced no samples: ${JSON.stringify(heard.stats)}`);

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

console.log('\n== every player keeps a save (chunked + compressed) ==');
// A Dreamcast state is ~27 MB against a ~256 KB DataChannel message limit, so the
// only interesting question is whether a payload far larger than one message
// survives the round trip INTACT. 3 MB of non-trivial bytes, not zeros: zeros
// would compress to nothing and prove the chunker was never exercised.
const bigOk = await host.evaluate(async () => {
  const N = 3 * 1024 * 1024;
  const u = new Uint8Array(N);
  let x = 123456789;
  for (let i = 0; i < N; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; u[i] = x & 0xff; }
  window.__sent = u;
  let sum = 0; for (let i = 0; i < N; i++) sum = (sum + u[i]) >>> 0;
  window.__sentSum = sum;
  return await window.__h2.sendSave(u, { kind: 'vmu', slot: 'A1' });
});
bigOk ? ok('save-send-accepted', '3 MB queued in 16 KB chunks with backpressure')
      : bad('save-send-accepted', 'sendSave returned false');
let rx = null;
for (let i = 0; i < 200 && !rx; i++) { rx = await guest.evaluate(() => window.__save || null); await new Promise(r => setTimeout(r, 200)); }
const sv = rx;
if (!sv) {
  // wire the listener late-safe: re-check after attaching
  bad('save-arrives', 'nothing received');
} else if (!sv.ok) {
  bad('save-arrives', sv.error);
} else {
  ok('save-arrives', `${sv.len} B, encoding=${sv.encoding}, meta.kind=${sv.kind}`);
  const sentSum = await host.evaluate(() => window.__sentSum);
  sv.sum === sentSum ? ok('save-byte-exact', `checksum ${sv.sum} matches the sender`)
                      : bad('save-byte-exact', `got ${sv.sum} want ${sentSum}`);
}

console.log('\n== the multiplayer save is kept SEPARATE from single-player ==');
const keys = await host.evaluate(() => [Netplay.Session.saveKey('gauntlet','state'), Netplay.Session.saveKey('gauntlet','vmu')]);
(keys[0] === 'mp:gauntlet:state' && keys[1] === 'mp:gauntlet:vmu')
  ? ok('save-key-namespaced', keys.join(' , ') + ' — cannot collide with a solo save')
  : bad('save-key-namespaced', JSON.stringify(keys));

const stored = await guest.evaluate(async () => {
  const k = Netplay.Session.saveKey('gauntlet', 'vmu');
  await Netplay.SaveStore.put(k, new Uint8Array([1,2,3,4,5]), { from: 'host' });
  const back = await Netplay.SaveStore.get(k);
  const fits = await Netplay.SaveStore.fits(27652485);
  return { len: back && back.bytes.length, meta: back && back.meta, fits };
});
stored.len === 5 ? ok('save-persists-locally', `read back ${stored.len} B, meta.from=${stored.meta.from}`)
                 : bad('save-persists-locally', JSON.stringify(stored));
stored.fits.known ? ok('capacity-known-before-committing', `free=${(stored.fits.free/1048576).toFixed(0)} MB, a 27 MB state fits=${stored.fits.fits}`)
                  : ok('capacity-known-before-committing', 'estimate() unavailable — reported as unknown rather than assumed');

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

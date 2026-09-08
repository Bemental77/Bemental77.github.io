#!/usr/bin/env node
// disc_bytes_probe.mjs — HOW MANY BYTES DOES IT COST TO START A GAME?
//
// The one number the disc-loading path is actually judged on. A phone starting
// Gauntlet Legends on the deployed site had to download every part of every
// track before the first frame — photographed stalled at "Track5.bin 59.3% ·
// 670/1131 MB" — so "does it stream?" is not a yes/no question, it is this
// measurement.
//
// WHAT IS COUNTED. `encodedDataLength` from CDP Network events, i.e. bytes ON
// THE WIRE including headers, accumulated from navigation until the emulator
// produces its first frame. Not Content-Length, not the page's own progress
// counter — both of those describe intent rather than transfer, and the page's
// counter deliberately reports UNCOMPRESSED disc bytes (that is why the phone
// read "1131 MB" while the network moved ~526 MB of gzip).
//
// ⚠ RUN THE BASELINE ARM AGAINST THE DEPLOYED ORIGIN. A local run proves
// nothing on its own about HTTP Range, and until recently could not test it at
// all: `npm run web` used to be `python3 -m http.server`, which answers a Range
// request with 200 and the whole file, so every local run silently took the
// eager path. That is fixed — package.json now runs tools/devserver.mjs, which
// implements 206 — but the deployed origin is still the only thing that proves
// GitHub Pages' behaviour, and it has its own answer: verified 2026-09-08,
// caseybement.com returns "HTTP/2 206 · content-range: bytes 0-99/48363136" for
// a .gz disc part, with NO content-encoding, so compressed bytes are
// range-addressable there.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime
//   node tools/disc_bytes_probe.mjs --game gauntlet                    # deployed
//   node tools/disc_bytes_probe.mjs --game gauntlet --target http://localhost:8080
//   ... [--query 'lazydisc=1'] [--timeout 900] [--label before] [--fresh]
//
// Writes a per-URL breakdown to /tmp/disc-bytes-<label>.json.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCRATCH = process.env.SCRATCH ||
  '/private/tmp/claude-501/-Users-caseybement-Bemental77-github-io/67bfe5d2-d703-4b56-897a-da90f004135a/scratchpad';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const GAME = arg('--game', 'gauntlet');
const TARGET = arg('--target', 'https://caseybement.com');
const QUERY = arg('--query', '');
const TIMEOUT = Number(arg('--timeout', 900)) * 1000;
const LABEL = arg('--label', 'run');
const FRESH = argv.includes('--fresh');
// --device-memory <GiB>: report a constrained device, the way a phone does.
// dreamcast.html derives its whole disc policy from this
// (MEM_BUDGET = navigator.deviceMemory x 1024 x 0.45, dreamcast.html:1103), so
// it is the one knob that decides eager-vs-streaming for a given track WITHOUT
// a query parameter no visitor would ever type.
const DEVICE_MEM = arg('--device-memory', '');

const url = `${TARGET}/dreamcast.html` + (QUERY ? '?' + QUERY : '');
// A PERSISTENT profile by default: a disc then comes from HTTP cache on a
// re-run instead of off the network every time, which matters when several
// agents share this box and a 526 MB fetch is in play. --fresh forces the
// cold-cache number, which is the one a first-time visitor actually pays.
const profile = path.join(SCRATCH, 'disc-bytes-profile' + (FRESH ? '-fresh-' + Date.now() : ''));
if (FRESH) fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', userDataDir: profile,
  args: ['--no-sandbox', '--disable-background-timer-throttling',
         '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
         '--autoplay-policy=no-user-gesture-required', '--disk-cache-size=1073741824'],
});
try { (await import('./browser_leak_guard.js')).default.guard(b, 'disc_bytes_probe'); } catch (_) {}

const page = await b.newPage();
if (DEVICE_MEM) {
  await page.evaluateOnNewDocument((gib) => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => gib, configurable: true });
  }, Number(DEVICE_MEM));
}

const perUrl = new Map();          // requestId -> { url, bytes }
const byUrl = new Map();           // url -> bytes
let totalBytes = 0;
let fromCache = 0;

// ---- THE COUNTER MUST REACH THE SERVICE WORKER ----------------------------
// ⚠ A PAGE-SCOPED Network DOMAIN SEES NONE OF THE DISC TRAFFIC. coi-serviceworker.js
// re-issues EVERY request through its own fetch() inside a SERVICE WORKER, which
// is a separate CDP target. Measured here on 2026-09-08: with Network enabled only
// on the page target, a Gauntlet run on the deployed site reported
// "0.2 MB transferred" after 96 SECONDS and "DISC bytes only 0 B over 16 URLs",
// while the browser was in fact pulling half a gigabyte. The 16 URLs showed up
// because requestWillBeSent fires on the page; the BYTES never do.
//
// This is the same defect device_matrix.mjs:604-616 documents for its slow-net
// arm, where page-scoped throttling measured 1.1x on the two service-worker
// pages and 214x on the one page without a service worker. Same fix: enable the
// domain on every target, and on any that appear later — the SW registers
// asynchronously, and coi-serviceworker deliberately RELOADS the page once it
// is in control, so the interesting target does not exist at launch.
const attached = new Set();
function wire(session, tag) {
  session.on('Network.requestWillBeSent', (e) => {
    if (!perUrl.has(e.requestId)) perUrl.set(e.requestId, { url: e.request.url, bytes: 0, tag });
  });
  session.on('Network.dataReceived', (e) => {
    const r = perUrl.get(e.requestId);
    const n = e.encodedDataLength || 0;
    if (r) { r.bytes += n; byUrl.set(r.url, (byUrl.get(r.url) || 0) + n); }
    totalBytes += n;
  });
  session.on('Network.requestServedFromCache', (e) => {
    const r = perUrl.get(e.requestId);
    if (r) r.cached = true;
  });
  session.on('Network.loadingFinished', (e) => {
    const r = perUrl.get(e.requestId);
    if (!r) return;
    const authoritative = e.encodedDataLength || 0;
    const extra = Math.max(0, authoritative - r.bytes);
    r.final = Math.max(r.bytes, authoritative);
    totalBytes += extra;
    if (extra) byUrl.set(r.url, (byUrl.get(r.url) || 0) + extra);
    if (r.cached) fromCache++;
    r.done = true;
  });
}
async function attachAll() {
  for (const t of b.targets()) {
    const type = t.type();
    if (!['page', 'service_worker', 'worker', 'shared_worker'].includes(type)) continue;
    const key = t.url() + '|' + type;
    if (attached.has(key)) continue;
    try {
      const s = await t.createCDPSession();
      await s.send('Network.enable');
      wire(s, type);
      attached.add(key);
    } catch (_) { /* not every target accepts the Network domain */ }
  }
}
await attachAll();
// Targets keep appearing: the SW registers asynchronously and emscripten spawns
// pthread workers well after Start.
const attachTimer = setInterval(() => { attachAll().catch(() => {}); }, 500);

// FIRST FRAME is the start signal. The worker prints a line containing
// "video_cb" once the core has produced a frame — the same signal
// dreamcast/tools/flycast_probe.js keys on (its classifier is /video_cb /).
// A canvas sample is kept as a second, independent witness because a log line
// alone has been wrong here before ("nonBlack: 0" on a run whose screenshot was
// a full 3D scene).
// ⚠ A LOG LINE ALONE IS NOT A FRAME. The first version of this probe stopped on
// /video_cb/ and reported "first frame 25.4 s, 0.2 MB" for a run whose canvas
// was still entirely black and whose disc requests had transferred ZERO bytes —
// they were merely in flight. The regex had matched a line that mentions
// video_cb without being a frame; the real classifier in
// dreamcast/tools/flycast_probe.js:557 is /video_cb / WITH A TRAILING SPACE.
// So the stop condition is now a PIXEL witness, polled, with the log line kept
// only as corroboration.
let firstFrameAt = 0;
let bytesAtFirstFrame = 0;
let frameLogAt = 0, frameLogLine = '';
let lastRealFrames = 0;
// THE LOADER BOUNDARY, and the primary number this tool exists to report:
// bytes on the wire before the emulator is handed a playable disc.
// dreamcast.html posts 'discReady' once every file is in place, and the worker
// answers by printing the disc's product id. It is well defined for BOTH arms —
// the eager path cannot post it until the whole disc has been assembled, and
// the lazy path posts it as soon as the virtual node exists — which is exactly
// the difference being measured. It is also independent of whether the GAME
// then boots, so a title that hangs later still yields a usable loader figure.
let discReadyAt = 0, bytesAtDiscReady = 0;
const logLines = [];
page.on('console', (m) => {
  const t = m.text();
  logLines.push(t);
  // ⚠ NOT EVERY video_cb IS A FRAME. The deployed page prints
  //   "[flycast-worker] video_cb #1 data=0 w=853 h=480 pitch=0 real_frames=0"
  // BEFORE the disc has loaded — a null callback with no framebuffer behind it.
  // Stopping on that reported "first frame 23.7 s, 0.2 MB" for Gauntlet, a run
  // in which not one disc byte had finished arriving. The line carries its own
  // disqualifier, real_frames, so use it.
  if (!discReadyAt && /\[flycast-shim\] disc product id/.test(t)) {
    discReadyAt = Date.now();
    bytesAtDiscReady = totalBytes;
  }
  const vm = /video_cb .*real_frames=(\d+)/.exec(t);
  if (vm) {
    lastRealFrames = Number(vm[1]);
    if (!frameLogAt && lastRealFrames >= 1) { frameLogAt = Date.now(); frameLogLine = t; }
  }
});

// Is the canvas showing a real picture? Sampled down to 64x64 and counted, so a
// single stray pixel cannot pass for a booted game.
async function canvasWitness() {
  try {
    return await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return { ok: false, why: 'no canvas' };
      const t = document.createElement('canvas');
      t.width = 64; t.height = 64;
      const g = t.getContext('2d');
      g.drawImage(c, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      let nonBlack = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nonBlack++;
      return { ok: true, w: c.width, h: c.height, nonBlack, of: 4096 };
    });
  } catch (e) { return { ok: false, why: String(e) }; }
}
const NONBLACK_MIN = 32;      // of 4096 sampled pixels

const t0 = Date.now();
// A BRAND-NEW profile races Chrome's own certificate verifier coming up:
// the first navigation to an https origin can die with
// net::ERR_CERT_VERIFIER_CHANGED, which is a startup race and not a site
// problem. Retry rather than reporting it as a failed measurement.
for (let attempt = 1; ; attempt++) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    break;
  } catch (e) {
    const msg = String(e && e.message);
    if (attempt >= 4 || !/ERR_CERT_VERIFIER_CHANGED|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET/.test(msg)) throw e;
    console.log('[disc-bytes] navigation attempt ' + attempt + ' failed (' + msg.split('\n')[0] + ') — retrying');
    await new Promise((r) => setTimeout(r, 2000));
  }
}
// coi-serviceworker reloads once on a fresh profile to install COOP/COEP.
await new Promise((r) => setTimeout(r, 3000));

const sel = await page.evaluate((key) => {
  const el = document.getElementById('romSelect');
  if (!el) return { ok: false, how: 'no #romSelect' };
  if (!Array.from(el.options).some((o) => o.value === key)) {
    return { ok: false, how: 'no such option; have ' + Array.from(el.options).map((o) => o.value).join(',') };
  }
  el.value = key;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, how: el.value };
}, GAME);
console.log('[disc-bytes] game select: ' + (sel.ok ? 'OK -> ' + sel.how : 'FAILED — ' + sel.how));
if (!sel.ok) { await b.close(); process.exit(2); }

const bytesAtStart = totalBytes;
await page.click('#btnStart');
console.log('[disc-bytes] clicked Start; counting bytes until the first frame…');

const deadline = Date.now() + TIMEOUT;
let lastReport = 0;
let canvas = null;
let stableSince = 0, lastTotal = -1;
while (Date.now() < deadline && !firstFrameAt) {
  // Stop early if the disc is ready and the wire has gone quiet for 30 s: the
  // loader question is answered at that point, and whether this particular
  // title then reaches a rendered frame is a different question from how many
  // bytes it cost to get there.
  if (totalBytes === lastTotal) { if (!stableSince) stableSince = Date.now(); }
  else { stableSince = 0; lastTotal = totalBytes; }
  if (discReadyAt && stableSince && Date.now() - stableSince > 30000) {
    console.log('    (disc ready and the network has been quiet 30 s — stopping)');
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
  canvas = await canvasWitness();
  // BOTH witnesses, because each one alone has already produced a false
  // positive here: the canvas is non-black from the loading splash long before
  // any disc byte lands, and video_cb fires with real_frames=0 before that.
  if (frameLogAt && canvas.ok && canvas.nonBlack >= NONBLACK_MIN) {
    firstFrameAt = Date.now();
    bytesAtFirstFrame = totalBytes;
    break;
  }
  if (Date.now() - lastReport > 15000) {
    lastReport = Date.now();
    console.log(`    … ${(totalBytes / 1e6).toFixed(1)} MB transferred, ` +
                `${((Date.now() - t0) / 1000) | 0}s, canvas nonBlack ` +
                `${canvas.ok ? canvas.nonBlack : canvas.why}, real_frames ${lastRealFrames}`);
  }
}
if (!canvas) canvas = await canvasWitness();
// Let the picture settle a moment and re-sample, so the reported witness is not
// a single lucky frame.
if (firstFrameAt) {
  await new Promise((r) => setTimeout(r, 2000));
  canvas = await canvasWitness();
}

const discBytes = [...byUrl.entries()]
  .filter(([u]) => /\/dreamcast\/discs\//.test(u))
  .sort((a, b2) => b2[1] - a[1]);
const discTotal = discBytes.reduce((s, [, n]) => s + n, 0);

console.log('\n================ disc bytes to start: ' + LABEL + ' ================');
console.log('target            ' + url);
console.log('game              ' + GAME + (DEVICE_MEM ? '   navigator.deviceMemory=' + DEVICE_MEM + ' GiB' : ''));
console.log('first frame       ' + (firstFrameAt ? ((firstFrameAt - t0) / 1000).toFixed(1) + ' s' : 'NEVER (timed out)'));
console.log('  witness         canvas nonBlack >= ' + NONBLACK_MIN + ' of 4096' +
            (frameLogAt ? '; video_cb log at ' + ((frameLogAt - t0) / 1000).toFixed(1) + ' s: ' +
             frameLogLine.slice(0, 100) : '; NO video_cb log line seen'));
console.log('DISC READY at     ' + (discReadyAt ? ((discReadyAt - t0) / 1000).toFixed(1) + ' s' : 'never') +
            '  <- the loader boundary');
console.log('  bytes to there  ' + (discReadyAt ? bytesAtDiscReady : 0) + ' B = ' +
            ((discReadyAt ? bytesAtDiscReady : 0) / 1e6).toFixed(1) + ' MB   *** THE HEADLINE ***');
console.log('TOTAL on the wire ' + totalBytes + ' B = ' + (totalBytes / 1e6).toFixed(1) + ' MB');
console.log('  at first frame  ' + (bytesAtFirstFrame || totalBytes) + ' B = ' +
            ((bytesAtFirstFrame || totalBytes) / 1e6).toFixed(1) + ' MB');
console.log('  before Start    ' + bytesAtStart + ' B (page, worker, wasm — not disc)');
console.log('DISC bytes only   ' + discTotal + ' B = ' + (discTotal / 1e6).toFixed(1) + ' MB over ' +
            discBytes.length + ' URLs');
console.log('CDP targets wired ' + attached.size + ' (' + [...attached].map(k=>k.split('|')[1]).join(', ') + ')');
console.log('canvas            ' + JSON.stringify(canvas));
console.log('lazydisc log      ' + (logLines.filter((l) => /lazydisc|bgz/i.test(l)).slice(0, 8).join('\n                  ') || '(none)'));
console.log('top disc URLs:');
for (const [u, n] of discBytes.slice(0, 12)) {
  console.log('  ' + String(n).padStart(11) + '  ' + u.replace(/^https?:\/\/[^/]+/, ''));
}

fs.writeFileSync('/tmp/disc-bytes-' + LABEL + '.json', JSON.stringify({
  label: LABEL, url, game: GAME, totalBytes, bytesAtFirstFrame, bytesAtStart, discTotal,
  firstFrameMs: firstFrameAt ? firstFrameAt - t0 : null, canvas,
  discReadyMs: discReadyAt ? discReadyAt - t0 : null, bytesAtDiscReady,
  frameLogMs: frameLogAt ? frameLogAt - t0 : null, frameLogLine,
  allLog: logLines,
  disc: discBytes.map(([u, n]) => ({ url: u, bytes: n })),
  log: logLines.filter((l) => /lazydisc|bgz|disc|Track/i.test(l)).slice(0, 200),
}, null, 2));
console.log('\nfull breakdown -> /tmp/disc-bytes-' + LABEL + '.json');
clearInterval(attachTimer);
await b.close();
process.exit(firstFrameAt ? 0 : 1);

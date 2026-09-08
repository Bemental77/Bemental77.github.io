// DOES A SECOND CHARACTER ACTUALLY EXIST AND MOVE IN GAUNTLET LEGENDS?
//
// WHAT IS ALREADY PROVEN AND IS NOT RE-PROVEN HERE
//   * `tools/dreamcast_netplay_test.mjs` proves the BYTES: port 0 and port 1 of
//     the 256-byte pad buffer carry different buttons and opposite sticks in the
//     same frame, and that buffer is what frameLoop posts to the emulator worker.
//   * `dreamcast/docs/core-relink-broken/TASKS.md` records the maple bus showing a
//     real device on BOTH ports.
//   Neither of those says the GAME reacts to port 1. That is this rig's only job.
//
// WHY ONE PAGE AND NO WEBRTC
//   packPad() (dreamcast.html:4237) reads navigator.getGamepads() and writes pad
//   `p` into bytes `p*64 ..`, so a SYNTHETIC GAMEPAD AT INDEX 1 lands on port 1
//   through the page's own shipped code path — the same bytes the netplay guest
//   would produce, with the transport removed from the experiment. The keyboard
//   keeps port 0. Two ports, one tab, no peer.
//
// THE GATE THAT MAKES A NEGATIVE MEANINGFUL
//   A rig whose input never lands looks EXACTLY like "the game ignores player 2".
//   So before any pixel claim this asserts, through the page's own
//   window.__dcPad(), that pressing the synthetic pad moves bytes 64..75 and
//   leaves bytes 0..11 alone. If that gate fails the run aborts and reports
//   nothing about the game.
//
// THE EVIDENCE
//   A COARSE block signature (8x6 grid of mean luminance), not an exact hash:
//   these scenes animate every frame, so an exact hash is distinct every sample
//   and proves nothing (this already misled one agent — see the same note in
//   tools/dreamcast_netplay_test.mjs). Each arm is sampled repeatedly so the
//   scene's OWN natural variation is measured, and a port-1 press only counts as
//   an effect if it moves the picture further than that.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime     # gate, per CLAUDE.md
//   npm run web                                         # port 8080, gate #2
//   node dreamcast/tools/gauntlet_p2_probe.mjs --script "..." --name attract
//
// FLAGS
//   --game KEY        romSelect key (default gauntlet)
//   --name TAG        log/screenshot suffix (default p2)
//   --url BASE        default http://localhost:8080
//   --profile DIR     persistent Chrome profile (keeps the IndexedDB savestate
//                     and the disc in the HTTP cache between runs)
//   --loadstate       click Load State once booted (needs a state in the profile)
//   --savestate       click Save State at the end of the script
//   --bootms MS       boot timeout (default 420000)
//   --script "S"      ';'-separated steps, each `<ms>:<action>` where <ms> is the
//                     delay AFTER the previous step:
//                        k:enter       tap a port-0 key (60 ms)
//                        kd:enter      hold a port-0 key
//                        ku:enter      release it
//                        p2:9          tap port-1 gamepad button 9 (= START)
//                        p2d:9 / p2u:9 hold / release it
//                        p2ax:0,1      port-1 left stick x=1 (-1..1)
//                        shot:label    screenshot -> /tmp/dc-p2/<name>-<label>.png
//                        sig:label     record a coarse signature sample
//                        arm:label,N   N signature samples 250 ms apart
//                        log:text      note in the log
//   --headful         run with a visible window
//   --keep            leave the browser open at the end
// OUTPUT
//   /tmp/dc-p2/<name>.log, /tmp/dc-p2/<name>-*.png, /tmp/dc-p2/<name>.json
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

// HASH-GUARD, BEFORE AND AFTER (CLAUDE.md gate #10). Agents share this tree; a
// concurrent relink mid-run produces a torn .js/.wasm pair whose failure reads
// like an emulator bug. Both hashes are printed so a run can be discarded on
// sight if they differ.
const WASM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const wasmHash = () => {
  try { const b = fs.readFileSync(WASM); return crypto.createHash('sha256').update(b).digest('hex').slice(0, 16) + ' (' + b.length + ' B)'; }
  catch (e) { return 'unreadable: ' + e.message; }
};

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const GAME     = arg('--game', 'gauntlet');
const NAME     = arg('--name', 'p2');
const URLBASE  = arg('--url', 'http://localhost:8080');
const PROFILE  = arg('--profile', '/private/tmp/claude-501/dc-p2-profile');
const BOOT_MS  = parseInt(arg('--bootms', '420000'), 10);
const SCRIPT   = arg('--script', '');
const LOADST   = has('--loadstate');
const SAVEST   = has('--savestate');
const HEADFUL  = has('--headful');
const KEEP     = has('--keep');

const OUT = '/tmp/dc-p2';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });
const LOG = path.join(OUT, NAME + '.log');
const out = fs.createWriteStream(LOG, { flags: 'w' });
const T0 = Date.now();
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); out.write(l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠ POLL FROM NODE, never page.waitForFunction — that polls on rAF and this page
// spends real time with rAF starved by the emulator worker.
async function until(page, fn, ms, everyMs = 500, onTick = null) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await page.evaluate(fn); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    if (onTick) await onTick(Date.now() - t0);
    await sleep(everyMs);
  }
}

const results = [];
const record = (o) => { results.push(o); };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  userDataDir: PROFILE,
  args: [
    '--no-sandbox',
    '--enable-features=SharedArrayBuffer',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    // Persistent profile: the 1.1 GB disc is worth caching between runs, and the
    // savestate lives in this profile's IndexedDB.
    '--disk-cache-size=2000000000',
  ],
});
try { require('../../tools/browser_leak_guard.js').guard(browser, 'gauntlet_p2_probe'); } catch (_e) {}

const page = (await browser.pages())[0] || await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on('pageerror', (e) => say('  [page!] ' + ((e && (e.message || e.type)) || String(e))));
page.on('console', (m) => {
  const t = m.text();
  if (/\[net\]|\[page\]|\[flycast|\[pad\]|\[input\]|\[maple\]|state loaded|state load/.test(t)) say('  [console] ' + t);
});

const HASH_BEFORE = wasmHash();
say(`profile=${PROFILE} game=${GAME} url=${URLBASE}`);
say(`wasm BEFORE: ${HASH_BEFORE}`);
await page.goto(URLBASE + '/dreamcast.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
// dreamcast.html registers /coi-serviceworker.js and RELOADS ITSELF. Anything
// injected before that reload is thrown away and an evaluate during it throws
// "Execution context destroyed", which reads exactly like a page crash.
const isolated = await until(page, () => (self.crossOriginIsolated === true) && typeof window.__dcPad === 'function', 90000);
say('cross-origin isolated + __dcPad present: ' + !!isolated);
if (!isolated) { say('ABORT: page never became isolated'); await finish(2); }

// ---------------------------------------------------------------------------
// PORT 1 = a synthetic gamepad at index 1. packPad() writes pad p at byte p*64.
// ---------------------------------------------------------------------------
await page.evaluate(() => {
  const st = { buttons: new Array(17).fill(0), axes: [0, 0, 0, 0], on: true };
  window.__p2 = st;
  const orig = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : () => [];
  const mk = () => ({
    index: 1, id: 'Bemental P2 Test Pad (STANDARD GAMEPAD)', connected: true,
    mapping: 'standard', timestamp: performance.now(),
    buttons: st.buttons.map((v) => ({ pressed: v > 0, touched: v > 0, value: v })),
    axes: st.axes.slice(),
  });
  navigator.getGamepads = function () {
    let real = [];
    try { real = orig() || []; } catch (e) {}
    return [real[0] || null, st.on ? mk() : null, real[2] || null, real[3] || null];
  };
  // lib/xboxinput.js raises a full-screen "Use game controls?" card the moment a
  // pad appears, which is correct product behaviour and pure obstruction here: it
  // covers the canvas in every screenshot. Dismissed with "Keep pointer", which is
  // the arm that installs NOTHING — it does not touch navigator.getGamepads and
  // dispatches no synthetic key events (grep: 0 KeyboardEvent in that file), so
  // the pad path under test is unchanged.
  setInterval(() => {
    const el = document.getElementById('xboxInputPrompt');
    if (el && el.style.display !== 'none') {
      const no = document.getElementById('xboxInputPromptNo');
      if (no) no.click(); else el.style.display = 'none';
    }
  }, 250);
  // In-page pixel sampler. The canvas is transferred to the worker
  // (transferControlToOffscreen), so the page cannot getContext it — but the
  // PLACEHOLDER element is still a valid drawImage source, which is exactly what
  // dreamcast.html's own netPumpMirror() relies on.
  const GW = 8, GH = 6, SW = 256, SH = 192;
  let mc = null, mg = null;
  window.__p2sig = () => {
    if (!mc) { mc = document.createElement('canvas'); mc.width = SW; mc.height = SH; mg = mc.getContext('2d', { alpha: false, willReadFrequently: true }); }
    const dc = document.getElementById('dc-canvas');
    mg.clearRect(0, 0, SW, SH);
    try { mg.drawImage(dc, 0, 0, SW, SH); } catch (e) { return { err: String(e && e.message || e) }; }
    const d = mg.getImageData(0, 0, SW, SH).data;
    const acc = new Float64Array(GW * GH), cnt = new Float64Array(GW * GH);
    let nonBlack = 0, sum = 0;
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const k = (y * SW + x) * 4;
      const lum = (d[k] + d[k + 1] + d[k + 2]) / 3;
      if (d[k] | d[k + 1] | d[k + 2]) nonBlack++;
      sum += lum;
      const b = ((y * GH / SH) | 0) * GW + ((x * GW / SW) | 0);
      acc[b] += lum; cnt[b]++;
    }
    return {
      t: Date.now(),
      blocks: Array.from(acc, (v, i) => +(v / cnt[i]).toFixed(2)),
      nonBlack, total: SW * SH, mean: +(sum / (SW * SH)).toFixed(3),
    };
  };
  // WHERE EACH CHARACTER IS. Gauntlet Legends hands player 1 the WIZARD (white
  // and gold) and player 2 the VALKYRIE (saturated blue), so a colour-keyed
  // centroid over the PLAY AREA ONLY — the bottom ~24% is the two-panel HUD,
  // which carries both colours and never moves — separates the two bodies
  // without any knowledge of guest memory.
  //
  // ⚠ This is a WEAK instrument on its own: the level's brickwork is tan and its
  // lava is orange, so the yellow key catches scenery too, and the camera tracks
  // the players so the background is not fixed. It is only ever read as a
  // DIFFERENCE BETWEEN TWO ARMS of the same scene, where the scenery is common
  // to both and the pixel counts are reported so the reader can see how much of
  // the signal is the character.
  const PW = 512, PH = 384;
  let pc = null, pg = null;
  window.__p2pos = () => {
    if (!pc) { pc = document.createElement('canvas'); pc.width = PW; pc.height = PH; pg = pc.getContext('2d', { alpha: false, willReadFrequently: true }); }
    const dc = document.getElementById('dc-canvas');
    pg.clearRect(0, 0, PW, PH);
    try { pg.drawImage(dc, 0, 0, PW, PH); } catch (e) { return { err: String(e && e.message || e) }; }
    const bot = Math.floor(PH * 0.76);
    const d = pg.getImageData(0, 0, PW, bot).data;
    let yx = 0, yy = 0, yn = 0, bx = 0, by = 0, bn = 0;
    for (let y = 0; y < bot; y++) for (let x = 0; x < PW; x++) {
      const k = (y * PW + x) * 4, r = d[k], g = d[k + 1], b = d[k + 2];
      if (r > 170 && g > 140 && r - b > 90) { yx += x; yy += y; yn++; }
      if (b > 100 && b - r > 60 && b - g > 40) { bx += x; by += y; bn++; }
    }
    return { t: Date.now(), w: PW, h: bot,
             yellow: yn ? { x: +(yx / yn).toFixed(2), y: +(yy / yn).toFixed(2), n: yn } : { n: 0 },
             blue:   bn ? { x: +(bx / bn).toFixed(2), y: +(by / bn).toFixed(2), n: bn } : { n: 0 } };
  };
});
say('port-1 synthetic gamepad installed at getGamepads()[1]; __p2sig() sampler installed');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
await page.evaluate((g) => {
  const s = document.getElementById('romSelect');
  s.value = g; s.dispatchEvent(new Event('change'));
  document.getElementById('btnStart').click();
}, GAME);
let lastPhase = '';
const booted = await until(page, () => (window.__dcProbe && window.__dcProbe().booted) || false, BOOT_MS, 1000, async () => {
  const p = await page.evaluate(() => { const d = window.__dcProbe(); return d.phase + ' ' + Math.round(100 * d.discBytes / (d.discTotal || 1)) + '%'; }).catch(() => '');
  if (p && p !== lastPhase) { lastPhase = p; say('booting ' + p); }
});
const pr = await page.evaluate(() => window.__dcProbe());
say(`booted=${!!booted} phase=${pr.phase} webgl2=${pr.webgl2} coi=${pr.coi} fps=${pr.fps} guestX=${(pr.guestX || 0).toFixed(3)}`);
if (!booted) { say('ABORT: never booted'); await finish(2); }
const flowing = await until(page, () => { const d = window.__dcProbe(); return d.framesEver && d.distinctEver; }, 180000);
say('frames flowing (distinct): ' + !!flowing);

if (LOADST) {
  const has1 = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('dc-savestates', 1);
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('states', 'readonly'); const q = tx.objectStore('states').getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); };
    r.onerror = () => res([]);
  }));
  say('savestate keys in this profile: ' + JSON.stringify(has1));
  await page.evaluate(() => document.getElementById('btnLoad').click());
  await sleep(8000);
  say('Load State clicked — the "[page] state loaded OK / load FAILED" console line above is the verdict. ' +
      'A FAILED restore SILENTLY leaves the cold boot running (CLAUDE.md gate #10), so do not read a scene claim without it.');
}

// ---------------------------------------------------------------------------
// THE GATE — prove the synthetic pad moves the bytes the core reads, and that
// it moves ONLY port 1.
// ---------------------------------------------------------------------------
const padSlice = () => page.evaluate(() => ({ p0: window.__dcPad().slice(0, 12), p1: window.__dcPad().slice(64, 76) }));
const idle0 = await padSlice();
await page.evaluate(() => { window.__p2.buttons[9] = 1; window.__p2.axes[0] = 1; });   // btn 9 -> RB.START, axis0 -> stick right
await sleep(600);
const p2on = await padSlice();
await page.evaluate(() => { window.__p2.buttons[9] = 0; window.__p2.axes[0] = 0; });
await sleep(600);
const p2off = await padSlice();
const s16 = (a, o) => ((a[o] | (a[o + 1] << 8)) << 16) >> 16;
const gate = {
  idle: idle0, pressed: p2on, released: p2off,
  p1StartBit: !!(p2on.p1[0] & (1 << 3)),          // RB.START = 3
  p1Lx: s16(p2on.p1, 8),
  p0Untouched: p2on.p0.every((b) => b === 0),
  releases: p2off.p1.every((b) => b === 0),
};
say('GATE port-1 press -> p1 bytes ' + JSON.stringify(p2on.p1) + '  p0 bytes ' + JSON.stringify(p2on.p0));
say(`GATE startBit=${gate.p1StartBit} p1Lx=${gate.p1Lx} p0Untouched=${gate.p0Untouched} releases=${gate.releases}`);
record({ gate });
if (!gate.p1StartBit || !gate.p0Untouched) {
  say('ABORT: the synthetic port-1 pad did NOT reach the worker pad buffer. ' +
      'Any negative result about the game would be meaningless — this is a rig fault, not a game finding.');
  await finish(3);
}

// A sampler that returns nothing is also a rig fault, so say so once, loudly.
const sig0 = await page.evaluate(() => window.__p2sig());
say('sampler: ' + JSON.stringify({ err: sig0.err, nonBlack: sig0.nonBlack, mean: sig0.mean }));
if (sig0.err) { say('ABORT: __p2sig() could not read the canvas: ' + sig0.err); await finish(3); }

// ---------------------------------------------------------------------------
// Scripted drive
// ---------------------------------------------------------------------------
const arms = {};   // label -> [samples]
const shots = [];
const key = (k, down) => page.evaluate((k, down) => {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: k, bubbles: true }));
}, k, down);
const shot = async (label) => {
  const p = path.join(OUT, `${NAME}-${label}.png`);
  try { await page.screenshot({ path: p }); shots.push(p); say('shot ' + p); }
  catch (e) { say('shot failed: ' + e.message); }
};
const sample = async (label) => {
  const s = await page.evaluate(() => window.__p2sig());
  (arms[label] = arms[label] || []).push(s);
  return s;
};
// EVERY POSITION SAMPLE CARRIES ITS OWN PAD WITNESS. A rig whose input stopped
// landing mid-run would otherwise produce a clean-looking "the game ignores
// player 2" arm, which is the exact trap this whole exercise exists to avoid —
// so the pad bytes the worker is being handed are read in the same breath as
// the pixels, not once at the start.
const poses = {};   // label -> [ {yellow, blue, pad} ]
const pose = async (label) => {
  const s = await page.evaluate(() => {
    const p = window.__dcPad();
    const s16 = (o) => ((p[o] | (p[o + 1] << 8)) << 16) >> 16;
    return Object.assign(window.__p2pos(),
      { pad: { p0btn: p[0], p0lx: s16(8), p1btn: p[64], p1lx: s16(72) } });
  });
  (poses[label] = poses[label] || []).push(s);
  return s;
};

const steps = SCRIPT.split(';').map((s) => s.trim()).filter(Boolean);
for (const st of steps) {
  const c = st.indexOf(':');
  const ms = parseInt(st.slice(0, c), 10) || 0;
  const rest = st.slice(c + 1);
  if (ms > 0) await sleep(ms);
  const [verb, ...restArr] = rest.split(':');
  const a = restArr.join(':');
  try {
    if (verb === 'k')        { await key(a, true); await sleep(80); await key(a, false); say(`tap p0 ${a}`); }
    else if (verb === 'kd')  { await key(a, true);  say(`hold p0 ${a}`); }
    else if (verb === 'ku')  { await key(a, false); say(`release p0 ${a}`); }
    else if (verb === 'p2')  { const b = +a; await page.evaluate((b) => { window.__p2.buttons[b] = 1; }, b); await sleep(120); await page.evaluate((b) => { window.__p2.buttons[b] = 0; }, b); say(`tap p1 btn${b}`); }
    else if (verb === 'p2d') { const b = +a; await page.evaluate((b) => { window.__p2.buttons[b] = 1; }, b); say(`hold p1 btn${b}`); }
    else if (verb === 'p2u') { const b = +a; await page.evaluate((b) => { window.__p2.buttons[b] = 0; }, b); say(`release p1 btn${b}`); }
    else if (verb === 'p2ax'){ const [i, v] = a.split(',').map(Number); await page.evaluate((i, v) => { window.__p2.axes[i] = v; }, i, v); say(`p1 axis${i}=${v}`); }
    else if (verb === 'shot'){ await shot(a); }
    else if (verb === 'sig') { const s = await sample(a); say(`sig ${a} mean=${s.mean} nonBlack=${s.nonBlack}`); }
    else if (verb === 'arm') { const [lbl, n] = a.split(','); for (let i = 0; i < (+n || 8); i++) { await sample(lbl); await sleep(250); } const A = arms[lbl]; say(`arm ${lbl}: ${A.length} samples, mean ${(A.reduce((s, x) => s + x.mean, 0) / A.length).toFixed(3)}`); }
    else if (verb === 'pos') { const [lbl, n] = a.split(','); for (let i = 0; i < (+n || 8); i++) { await pose(lbl); await sleep(200); } const P = poses[lbl].filter((p) => !p.err); const ym = P.reduce((s, p) => s + (p.yellow.n ? p.yellow.x : 0), 0) / P.length; const bm = P.reduce((s, p) => s + (p.blue.n ? p.blue.x : 0), 0) / P.length; const pw = P[0] ? P[0].pad : {}; say(`pos ${lbl}: n=${P.length} yellowX=${ym.toFixed(2)} (px ${Math.round(P.reduce((s, p) => s + p.yellow.n, 0) / P.length)}) blueX=${bm.toFixed(2)} (px ${Math.round(P.reduce((s, p) => s + p.blue.n, 0) / P.length)})  PAD p0[btn=0x${(pw.p0btn || 0).toString(16)} lx=${pw.p0lx}] p1[btn=0x${(pw.p1btn || 0).toString(16)} lx=${pw.p1lx}]`); }
    else if (verb === 'log') { say('NOTE ' + a); }
    else say('unknown step: ' + st);
  } catch (e) { say('step "' + st + '" threw: ' + e.message); }
}

if (SAVEST) {
  await page.evaluate(() => document.getElementById('btnSave').click());
  await sleep(8000);
  say('Save State clicked (see the page log for the persisted line)');
}

// ---------------------------------------------------------------------------
// Arm comparison. WITHIN-arm spread is the yardstick, not zero.
// ---------------------------------------------------------------------------
const stats = {};
for (const [lbl, S] of Object.entries(arms)) {
  const good = S.filter((s) => !s.err && s.blocks);
  if (!good.length) { stats[lbl] = { n: 0 }; continue; }
  const n = good[0].blocks.length;
  const mean = new Array(n).fill(0);
  for (const s of good) for (let i = 0; i < n; i++) mean[i] += s.blocks[i] / good.length;
  // mean |sample - armMean| over blocks, averaged over samples: the arm's own churn
  let churn = 0;
  for (const s of good) { let d = 0; for (let i = 0; i < n; i++) d += Math.abs(s.blocks[i] - mean[i]); churn += d / n; }
  churn /= good.length;
  stats[lbl] = { n: good.length, mean, churn: +churn.toFixed(3), meanLum: +(good.reduce((a, s) => a + s.mean, 0) / good.length).toFixed(3), nonBlack: Math.max(...good.map((s) => s.nonBlack)) };
}
const labels = Object.keys(stats).filter((l) => stats[l].n);
say('\n=== ARM STATISTICS (8x6 block-mean luminance) ===');
for (const l of labels) say(`  ${l.padEnd(18)} n=${stats[l].n} meanLum=${stats[l].meanLum} nonBlack=${stats[l].nonBlack} within-arm churn=${stats[l].churn}`);
const pairs = [];
for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
  const A = stats[labels[i]], B = stats[labels[j]];
  let d = 0; for (let k = 0; k < A.mean.length; k++) d += Math.abs(A.mean[k] - B.mean[k]);
  d /= A.mean.length;
  const noise = Math.max(A.churn, B.churn);
  pairs.push({ a: labels[i], b: labels[j], dist: +d.toFixed(3), noise: +noise.toFixed(3), ratio: +(d / (noise || 1e-9)).toFixed(2) });
}
say('\n=== BETWEEN-ARM DISTANCE vs WITHIN-ARM CHURN ===');
for (const p of pairs) say(`  ${p.a} -> ${p.b}: distance ${p.dist}, churn ${p.noise}, ratio ${p.ratio}x`);

// ---------------------------------------------------------------------------
// Per-character position. Reported as an arm table plus the deltas between
// consecutive arms, because only the DELTA is meaningful (see __p2pos above).
// ---------------------------------------------------------------------------
const posStats = {};
for (const [lbl, P0] of Object.entries(poses)) {
  const P = P0.filter((p) => !p.err && p.yellow && p.blue);
  if (!P.length) { posStats[lbl] = { n: 0 }; continue; }
  const avg = (f) => +(P.reduce((s, p) => s + f(p), 0) / P.length).toFixed(2);
  const sd = (f, m) => +Math.sqrt(P.reduce((s, p) => s + (f(p) - m) ** 2, 0) / P.length).toFixed(2);
  const yx = avg((p) => p.yellow.x || 0), bx = avg((p) => p.blue.x || 0);
  posStats[lbl] = { n: P.length, yellowX: yx, yellowSd: sd((p) => p.yellow.x || 0, yx), yellowPx: Math.round(avg((p) => p.yellow.n)),
                    blueX: bx, blueSd: sd((p) => p.blue.x || 0, bx), bluePx: Math.round(avg((p) => p.blue.n)) };
}
const posLabels = Object.keys(posStats).filter((l) => posStats[l].n);
if (posLabels.length) {
  say('\n=== PER-CHARACTER X POSITION (colour-keyed centroid, play area only, 512 px wide) ===');
  for (const l of posLabels) {
    const s = posStats[l];
    say(`  ${l.padEnd(16)} n=${s.n}  WIZARD/yellow x=${s.yellowX} (sd ${s.yellowSd}, ${s.yellowPx} px)   VALKYRIE/blue x=${s.blueX} (sd ${s.blueSd}, ${s.bluePx} px)`);
  }
  say('\n=== DELTAS BETWEEN CONSECUTIVE ARMS ===');
  for (let i = 1; i < posLabels.length; i++) {
    const A = posStats[posLabels[i - 1]], B = posStats[posLabels[i]];
    say(`  ${posLabels[i - 1]} -> ${posLabels[i]}: WIZARD dx=${(B.yellowX - A.yellowX).toFixed(2)}   VALKYRIE dx=${(B.blueX - A.blueX).toFixed(2)}`);
  }
}

const HASH_AFTER = wasmHash();
say(`\nwasm BEFORE: ${HASH_BEFORE}\nwasm AFTER:  ${HASH_AFTER}  ${HASH_BEFORE === HASH_AFTER ? '(STABLE)' : '(⚠ CHANGED MID-RUN — discard this run)'}`);
const summary = { when: new Date().toISOString(), game: GAME, name: NAME, wasmBefore: HASH_BEFORE, wasmAfter: HASH_AFTER, gate, stats, pairs, posStats, poses, shots, probe: await page.evaluate(() => window.__dcProbe()).catch(() => null), arms };
fs.writeFileSync(path.join(OUT, NAME + '.json'), JSON.stringify(summary, null, 2));
say('json -> ' + path.join(OUT, NAME + '.json'));
await finish(0);

async function finish(code) {
  try { if (!KEEP) await browser.close(); } catch (e) {}
  out.end();
  await sleep(200);
  process.exit(code);
}

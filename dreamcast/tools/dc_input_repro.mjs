// Drive dreamcast.html with REAL keyboard input and watch for a guest crash.
//
// WHY IT EXISTS. dreamcast/tools/flycast_probe.js boots the page and measures,
// but it cannot select a disc (the picker is `#romSelect`, not a query param)
// and it never presses a button. Sonic Adventure 2's reported crash
// ("[flycast-shim] freerun run_iter threw (pump stopped) ... sh4_pc=0xac000012")
// is UNREACHABLE without input: 301 s of attract mode is clean, and the fault
// needs the guest driven through the title -> 1P PLAY -> STORY SELECT menus.
// See dreamcast/docs/sa2-story-select-crash/TASKS.md for the finding.
//
// THE INPUT GATE IS THE POINT. The first attempt at this repro was VOID because
// input never reached the guest at all and nothing said so. This rig holds a
// key, reads the page's own packPad() output through window.__dcPad(), and
// refuses to call a run a negative result unless the pad bytes actually moved.
//
// Usage (needs a server; `npm run web` on :8080, or point --url at the DC
// probe's own server: `PROBE_ROOT=<tree> node dreamcast/tools/flycast_probe.js --serve`):
//
//   node dreamcast/tools/dc_input_repro.mjs --game sa2 --mash --nodirs --dur 200000
//   node dreamcast/tools/dc_input_repro.mjs --noinput --dur 300000        # control arm
//   node dreamcast/tools/dc_input_repro.mjs --q nochain=1 --mash --nodirs # JIT-lever arm
//   node dreamcast/tools/dc_input_repro.mjs --script "3000:Enter;9000:m"  # exact taps
//
// Flags: --url BASE  --game KEY  --dur MS (measured from the first DISTINCT
//        frame)  --mash (Start/A/B too)  --nodirs (buttons only)  --dirsonly
//        --noinput  --script "ms:Key;ms:Key"  --q "a=1&b=2"  --shotevery MS
//        --cpuslow RATE (CDP CPU throttle)  --name TAG (log/screenshot suffix)
// Output: /tmp/dc-repro-<name>.log, /tmp/dc-repro-<name>.png, exit 2 on a crash.

import fs from 'fs';
import { createRequire } from 'module';
// puppeteer is installed ABOVE the repo (~/node_modules); createRequire from
// this file's own URL walks up and finds it, and finds the leak guard too.
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const guard = require('../../tools/browser_leak_guard.js');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const DUR      = parseInt(arg('--dur', '240000'), 10);   // ms AFTER first distinct frame
const NAME     = arg('--name', 'sa2-input');
const GAME     = arg('--game', 'sa2');
const NO_INPUT = has('--noinput');
const MASH     = has('--mash');
const NODIRS   = has('--nodirs');     // buttons only
const DIRSONLY = has('--dirsonly');   // directions only
// --script "3000:Enter;9000:m"  — exact timed taps (ms AFTER first distinct frame),
// then nothing.  The minimal-input arm: how FEW presses still reach the fault?
const SCRIPT   = arg('--script', '');
const SHOTEVERY= parseInt(arg('--shotevery', '0'), 10);
const URLBASE  = arg('--url', 'http://localhost:8080');
const CPUSLOW  = parseFloat(arg('--cpuslow', '0'));  // CDP CPU throttling rate
const QUERY    = arg('--q', '');       // extra page query params, e.g. --q nochain=1
const LOG      = `/tmp/dc-repro-${NAME}.log`;

const out = fs.createWriteStream(LOG, { flags: 'w' });
const say = (s) => { const l = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); out.write(l + '\n'); };
const T0 = Date.now();

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
         '--disable-backgrounding-occluded-windows',
         '--disable-renderer-backgrounding',
         '--disable-background-timer-throttling'],
});
guard.guard(browser);

const page = (await browser.pages())[0];
await page.setViewport({ width: 1280, height: 800 });
// SPEED CONTROL for the ?nochain arm. nochain avoids the fault but also drops
// the guest to 0.73x, so "chaining is the bug" and "slower timing hides it" are
// confounded. Throttling the CPU slows the guest with chaining left ON, which
// separates them: a crash here says the null is chain-specific, not speed.
if (CPUSLOW > 0) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPUSLOW });
  console.log('[rig] CPU throttling rate = ' + CPUSLOW);
}

let CRASH = null;
const tail = [];
page.on('console', (m) => {
  const t = m.text();
  tail.push(t); if (tail.length > 400) tail.shift();
  out.write(t + '\n');
  if (/pump stopped|run_iter threw|ABORT|abort\(|RuntimeError|watchdog #/i.test(t)) {
    say('!!! ' + t.slice(0, 400));
    if (/pump stopped|run_iter threw/i.test(t) && !CRASH) CRASH = t;
  }
});
page.on('pageerror', (e) => { const s = '[pageerror] ' + String(e).slice(0, 300); say(s); out.write(s + '\n'); });

say('goto');
const PAGEURL = URLBASE + '/dreamcast.html' + (QUERY ? ('?' + QUERY) : '');
say('url ' + PAGEURL);
await page.goto(PAGEURL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });   // coi-serviceworker
await page.waitForFunction(() => self.crossOriginIsolated === true, { timeout: 60000 });
await page.waitForSelector('#btnStart:not([disabled])', { timeout: 120000 });
await page.select('#romSelect', GAME);
await page.click('#btnStart');
say('Start clicked for ' + GAME);

// Wait for the first DISTINCT frame — that is the clock the owner's report uses.
try {
  await page.waitForFunction(() => { const p = window.__dcProbe && window.__dcProbe(); return !!(p && p.distinctEver); },
                             { timeout: 420000, polling: 1000 });
  say('first-distinct-frame');
} catch (e) { say('NEVER reached first-distinct-frame: ' + e.message); }

// ---- input primitives -----------------------------------------------------
const down = (k) => page.keyboard.down(k).catch(() => {});
const up   = (k) => page.keyboard.up(k).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tap(k, hold = 120) { await down(k); await sleep(hold); await up(k); }

const BOOT_AT = Date.now();

// ---------------------------------------------------------------------------
// HARD INPUT GATE. The first attempt at this repro was VOID because input never
// reached the guest at all (a sibling agent's in-progress edit to dreamcast.html
// threw `netRemotePad is not defined` out of the pad path) and nothing in the
// run said so. Never again: hold a key, read the page's OWN packPad() output,
// and refuse to report a negative result unless the pad bytes actually moved.
// ---------------------------------------------------------------------------
let INPUT_PROVEN = false;
try {
  await down('ArrowLeft'); await sleep(400);
  const held = await page.evaluate(() => (window.__dcPad ? window.__dcPad().slice(0, 12) : null));
  await up('ArrowLeft'); await sleep(300);
  const rest = await page.evaluate(() => (window.__dcPad ? window.__dcPad().slice(0, 12) : null));
  say('pad held=' + JSON.stringify(held) + ' released=' + JSON.stringify(rest));
  INPUT_PROVEN = !!(held && (held[8] !== 0 || held[9] !== 0) && rest && rest[8] === 0 && rest[9] === 0);
} catch (e) { say('input gate threw: ' + e.message); }
say('INPUT GATE: ' + (INPUT_PROVEN ? 'PASS (pad bytes move with the key)' : 'FAIL — input does NOT reach packPad'));


// ---------------------------------------------------------------------------
// Type-info layout self-check for the shim's new C++ throw decoder. The decoder
// reads the mangled name at HEAPU32[(type+4)>>2]; this locates the real
// `16FlycastException` C string in the worker's heap and asserts that SOME word
// in memory points at it (i.e. a type_info object exists with the name at +4).
// It runs in the PAGE realm, so it can only reach the page's own SAB view of
// the worker heap — reported as best-effort, never as a gate.
// ---------------------------------------------------------------------------

// ---- input driver ---------------------------------------------------------
let inputStopped = false;
async function inputDriver() {
  // The report's own signal is `[input] analog engaged x=-32767 y=0` — a
  // ONE-SHOT that fires the first time an arrow/WASD key is held. So the first
  // thing this does is hold ArrowLeft, exactly reproducing that value.
  await sleep(1500);
  if (!NODIRS) {
    say('input: ArrowLeft (x=-32767 y=0)');
    await down('ArrowLeft'); await sleep(2500); await up('ArrowLeft');
  } else { say('input: BUTTONS ONLY (no arrows/WASD)'); }
  const dirs = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  let n = 0;
  while (!inputStopped) {
    // Start / confirm mashing pushes past logos and menus, which is how a player
    // reaches new code in the first 45 s.
    if (MASH && !DIRSONLY && (n % 4) === 0) { await tap('Enter', 150); await sleep(400); await tap('m', 150); }
    if (!NODIRS) {
      const d = dirs[n % dirs.length];
      await down(d); await sleep(1200); await up(d);
      // diagonals: two axes at once (the 23170 branch in packPad)
      await down('ArrowLeft'); await down('ArrowUp'); await sleep(900);
      await up('ArrowLeft'); await up('ArrowUp');
      // d-pad keys drive BOTH the digital bits and the analog stick
      await down('a'); await sleep(700); await up('a');
      await down('d'); await sleep(700); await up('d');
    } else { await sleep(3500); }
    if (MASH && !DIRSONLY) { await tap('m', 120); await sleep(200); await tap('k', 120); }
    await sleep(600);
    n++;
  }
}
async function scriptDriver() {
  const steps = SCRIPT.split(';').filter(Boolean).map((x) => {
    const [ms, k] = x.split(':'); return { at: +ms, key: k };
  }).sort((a, b) => a.at - b.at);
  const t0 = Date.now();
  for (const st of steps) {
    const wait = st.at - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    say('script tap ' + st.key + ' @' + st.at + 'ms');
    await tap(st.key, 150);
  }
  say('script done — no further input');
}
if (SCRIPT) scriptDriver();
else if (!NO_INPUT) inputDriver();
else say('input: DISABLED (--noinput control arm)');
if (SHOTEVERY > 0) {
  let sn = 0;
  const st = setInterval(async () => {
    try { await page.screenshot({ path: `/tmp/dc-shot-${NAME}-${String(sn++).padStart(3, '0')}.png`, clip: { x: 0, y: 160, width: 1280, height: 560 } }); } catch (e) {}
    if (inputStopped) clearInterval(st);
  }, SHOTEVERY);
}

// ---- progress sampling ----------------------------------------------------
const samples = [];
const poll = setInterval(async () => {
  try {
    const p = await page.evaluate(() => (window.__dcProbe && window.__dcProbe()) || null);
    if (p) {
      samples.push(p);
      if (samples.length % 5 === 0)
        say(`prog seq=${p.seq} phase=${p.phase} fps=${p.fps} fields=${p.fields} iters=${p.iters} pc=0x${(p.pc >>> 0).toString(16)} guest=${p.guestX} idle=${p.idleMs}`);
    }
  } catch (e) {}
}, 2000);

const deadline = BOOT_AT + DUR;
while (Date.now() < deadline && !CRASH) await sleep(1000);
inputStopped = true;
clearInterval(poll);

if (CRASH) {
  say('=== REPRODUCED ===');
  say(CRASH);
  say('--- last 60 console lines before/around the crash ---');
  for (const l of tail.slice(-60)) out.write('    ' + l + '\n');
} else {
  say('=== NOT reproduced in ' + ((Date.now() - BOOT_AT) / 1000).toFixed(0) + 's after first frame ===');
  if (!INPUT_PROVEN) say('*** RESULT IS VOID: the input gate FAILED, so this run never tested input at all. ***');
}

try {
  const px = await page.evaluate(() => {
    const c = document.querySelector('canvas'); if (!c) return { err: 'no canvas' };
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    try { t.getContext('2d').drawImage(c, 0, 0); } catch (e) { return { err: String(e) }; }
    const d = t.getContext('2d').getImageData(0, 0, t.width, t.height).data;
    let nb = 0; const s = new Set();
    for (let i = 0; i < d.length; i += 4) { if (d[i] | d[i + 1] | d[i + 2]) nb++; if (s.size < 400) s.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); }
    return { w: t.width, h: t.height, nonBlackPct: +(100 * nb / (t.width * t.height)).toFixed(1), distinct: s.size };
  });
  say('pixels: ' + JSON.stringify(px));
  await page.screenshot({ path: `/tmp/dc-repro-${NAME}.png` });
  say('screenshot -> /tmp/dc-repro-' + NAME + '.png');
} catch (e) { say('screenshot failed: ' + e.message); }

const last = samples.slice(-1)[0];
if (last) say('final probe: ' + JSON.stringify(last).slice(0, 500));
say('log -> ' + LOG);
out.end();
await browser.close();
process.exit(CRASH ? 2 : 0);

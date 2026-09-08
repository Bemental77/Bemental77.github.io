#!/usr/bin/env node
// ============================================================================
// THE FOUR-PORT DETERMINISM ARM — the one nothing has ever exercised.
// ============================================================================
//
// WHY IT IS A SEPARATE QUESTION FROM THE TWO-PORT ARM
// ---------------------------------------------------
// Every determinism arm run in this project drove TWO ports. The product seats
// FOUR (EmscriptenWorker.cpp:149 `EMW_MAX_PORTS = 4 // == MAPLE_PORTS`), and
// the host-time surface scales PER PLAYER, not per machine:
// core/hw/maple/maple_cfg.cpp gives every controller its own VMU
// (EmscriptenWorker.cpp:1314-1317 says so in as many words), so four players
// is twice the device set of two. Three host-clock leaks into guest state have
// already been found and pinned here — the console ID from time(NULL), the
// syscfg flash time, and the AICA RTC. A fourth would show up where the device
// count doubles, which is exactly this arm and nowhere else.
//
// WHAT THIS FILE DOES NOT DO
// --------------------------
// It does not reimplement the determinism rig. dreamcast/tools/determinism_probe.mjs
// owns the asyncify-safe stepwise driver, the frame-gated pad injection, the
// per-chunk state hashing and the wasm hash guard, and a second copy of that
// driver would produce RIG bugs that read exactly like nondeterminism — the
// failure mode CLAUDE.md gate #8 exists to prevent. This calls that probe,
// unmodified, and changes exactly ONE variable: how many Maple ports are
// plugged before the disc loads.
//
// HOW THE FOURTH AND THIRD PORTS GET PLUGGED WITHOUT EDITING ANYTHING
// -------------------------------------------------------------------
// The count is a worker message, `{cmd:'players', n}`, and it MUST arrive
// before retro_load_game because the maple devices are created inside it and
// this build deliberately does not hotplug (EmscriptenWorker.cpp:137-141 — a
// hotplug is guest-visible, so under lockstep it would have to land on the
// identical emulated frame everywhere or it is itself a desync). dreamcast.html
// sends it only when a netplay room is seated (dreamcast.html:4818), and the
// probe launches its own browser, so there is no seam to reach from Node.
//
// So this serves the site a SECOND time, from the repo's own devserver
// (tools/devserver.mjs, WEB_ROOT + PORT — no improvised server, CLAUDE.md gate
// #2), rooted at a tree that is symlinks to the real repo for every single
// entry EXCEPT dreamcast.html, which is the shipped file plus ONE injected
// script. That script wraps Worker.prototype.postMessage and rides the
// {cmd:'players'} message in front of the first discLazy/discReady — exactly
// what dreamcast/tools/port_plug_test.mjs does from puppeteer, moved into the
// page so the probe needs no cooperation and survives the coi-serviceworker
// reload. The repo's dreamcast.html is never touched, and the rig page's only
// difference from it is asserted byte-for-byte before anything boots.
//
// ⚠ AN EXTENSION WAS TRIED FIRST AND IS A DEAD END ON THIS BROWSER. A MAIN-world
// content script at document_start is the textbook way to do this, and Chrome
// 152.0.7977.83 here loads NO unpacked extension at all: with
// --disable-extensions-except + --load-extension, headless AND headful, with
// puppeteer's default --disable-extensions removed (ignoreDefaultArgs) and with
// --disable-features=DisableLoadExtensionCommandLineSwitch and
// --enable-unsafe-extension-debugging, `window.__ports4Installed` stayed false
// and browser.targets() listed no extension target. Do not spend the afternoon
// on it again.
//
// USAGE
//   node tools/browser_leak_guard.js reap && uptime     # CLAUDE.md
//   npm run web                                         # :8080, gate #2
//   bash tools/probe_lock.sh run -- node dreamcast/tools/determinism_ports4.mjs
//
// FLAGS (everything else is the probe's own default)
//   --frames N   default 1800      --runs R    default 3
//   --arms LIST  default cross (see the ARMS const: a self arm needs --equalize)
//   --equalize   push one anchor state into both instances (required for --arms self)
//   --game KEY   default gauntlet  --name TAG  default ports4
//   --players N  default 4         --proofonly  run phase 1 and stop
//   --rigport N  default 8082 (the rig origin; :8080 is left alone)
//
// EXIT  0 only when EVERY requested arm is R/R byte-identical with no rig
//       faults and the wasm hash is unchanged across the run. Note the probe
//       itself exits 0 on a desync — it is a measurement rig, not a gate — so
//       the verdict is read out of its stdout here, exactly as
//       tools/audit_all.mjs does for the two-port gate.
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const FRAMES  = arg('--frames', '1800');
const RUNS    = arg('--runs', '3');
// DEFAULT cross, NOT self,cross — and that is the probe's rule, not a
// convenience. Under --frame0 nothing restores state between the two passes of
// a self arm, so pass 2 would start at frame 1800 and compare two DIFFERENT
// time windows; determinism_probe.mjs skips the arm and says so in as many
// words. Ask for a self arm with `--arms self --equalize`, which anchors both
// passes on one pushed state.
const ARMS    = arg('--arms', 'cross');
const EQUALIZE = has('--equalize');
const GAME    = arg('--game', 'gauntlet');
const NAME    = arg('--name', 'ports4');
const PLAYERS = parseInt(arg('--players', '4'), 10);
const RIGPORT = parseInt(arg('--rigport', '8082'), 10);
const RIGURL  = `http://localhost:${RIGPORT}`;
const REAL_CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BOOT_MS = Number(process.env.BOOT_MS || 180000);

const WASM = path.join(ROOT, 'dreamcast', 'flycast_libretro', 'flycast_worker_emcc.wasm');
const wasmHash = () => {
  const b = fs.readFileSync(WASM);
  return require('node:crypto').createHash('sha256').update(b).digest('hex').slice(0, 16)
       + ' (' + b.length + ' B)';
};

const say = (s) => console.log(s);

// ---------------------------------------------------------------------------
// THE RIG ORIGIN. Rebuilt from the live repo every run, so it can never be a
// stale copy of a page that has since changed.
// ---------------------------------------------------------------------------
const RIGDIR = path.join(os.tmpdir(), 'dc-det-ports4-tree');

function injectedSource(n) {
  return `
<script>
/* dc-det-ports4 RIG INJECTION — not part of dreamcast.html. Sends the player
   count to the worker AHEAD of the disc message, because the maple devices are
   created inside retro_load_game and this build does not hotplug. */
(function () {
  if (window.__ports4Installed) return;
  window.__ports4Installed = true;
  var N = ${n};
  window.__ports4 = { sent: false, worker: null, replies: [], reported: 0 };
  var OP = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (msg) {
    var rest = Array.prototype.slice.call(arguments, 1);
    try {
      if (msg && msg.cmd === 'mem-init' && !window.__ports4.worker) window.__ports4.worker = this;
      if (!window.__ports4.sent && msg && (msg.cmd === 'discLazy' || msg.cmd === 'discReady')) {
        window.__ports4.sent = true;
        window.__ports4.worker = this;
        this.addEventListener('message', function (e) {
          var m = e.data || {};
          if (m.cmd === 'players' || m.cmd === 'portPolls') window.__ports4.replies.push(m);
        });
        OP.call(this, { cmd: 'players', n: N });
      }
    } catch (err) {}
    return OP.apply(this, [msg].concat(rest));
  };
  /* PROOF INSIDE THE MEASURED RUN, where the launcher cannot look.
     determinism_probe.mjs prints every pageerror verbatim but filters console
     output, so the witness is raised as one deliberate uncaught error. */
  var t0 = Date.now();
  var iv = setInterval(function () {
    var w = window.__ports4.worker;
    if (!w) return;
    try { w.postMessage({ cmd: 'portPolls' }); } catch (e) { return; }
    var r = window.__ports4.replies.filter(function (m) { return m.cmd === 'portPolls' && m.ok; });
    var last = r[r.length - 1];
    if (!last || !last.polls || !last.polls.some(function (v) { return v > 0; })) return;
    var live = last.polls.map(function (v, i) { return v > 0 ? i : -1; }).filter(function (i) { return i >= 0; });
    window.__ports4.reported++;
    if (window.__ports4.reported > 3) { clearInterval(iv); return; }
    setTimeout(function () {
      throw new Error('[ports4-proof] players=' + last.players + ' polls=[' + last.polls.join(',') +
                      '] portsRead=[' + live.join(',') + '] t=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }, 0);
  }, 3000);
})();
</script>
`;
}

function buildRigTree(n) {
  fs.rmSync(RIGDIR, { recursive: true, force: true });
  fs.mkdirSync(RIGDIR, { recursive: true });
  for (const e of fs.readdirSync(ROOT)) {
    if (e === 'dreamcast.html') continue;
    fs.symlinkSync(path.join(ROOT, e), path.join(RIGDIR, e));
  }
  const shipped = fs.readFileSync(path.join(ROOT, 'dreamcast.html'), 'utf8');
  const marker = '<head>';
  const at = shipped.indexOf(marker);
  if (at < 0) throw new Error('dreamcast.html has no <head> — refusing to guess where to inject');
  const inj = injectedSource(n);
  const patched = shipped.slice(0, at + marker.length) + inj + shipped.slice(at + marker.length);
  fs.writeFileSync(path.join(RIGDIR, 'dreamcast.html'), patched);
  // THE RIG PAGE MUST DIFFER FROM THE SHIPPED PAGE BY EXACTLY THE INJECTION AND
  // NOTHING ELSE. Asserted, not assumed: a rig that quietly drifted from the
  // product would answer a question about a page nobody ships.
  const delta = patched.length - shipped.length;
  if (delta !== inj.length) throw new Error(`rig page differs by ${delta} B, injection is ${inj.length} B`);
  const rebuilt = patched.slice(0, at + marker.length) + patched.slice(at + marker.length + inj.length);
  if (rebuilt !== shipped) throw new Error('removing the injection does not reproduce the shipped page');
  return { dir: RIGDIR, injectedBytes: inj.length, shippedBytes: shipped.length };
}

function startRigServer(port) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, ['tools/devserver.mjs'], {
      cwd: ROOT, env: { ...process.env, WEB_ROOT: RIGDIR, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    ch.stdout.on('data', (b) => { out += b.toString(); });
    ch.stderr.on('data', (b) => { out += b.toString(); });
    const t0 = Date.now();
    const poll = async () => {
      try {
        const r = await fetch(`http://localhost:${port}/dreamcast.html`);
        if (r.ok) return resolve(ch);
      } catch (_e) {}
      if (Date.now() - t0 > 20000) { try { ch.kill('SIGTERM'); } catch (_e) {} return reject(new Error('rig server never answered: ' + out)); }
      setTimeout(poll, 250);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// PHASE 1 — is the plug real? Read the counter the guest itself bumps.
// ---------------------------------------------------------------------------
async function proofPhase() {
  const browser = await puppeteer.launch({
    executablePath: REAL_CHROME, headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--enable-unsafe-swiftshader',
           '--autoplay-policy=no-user-gesture-required'],
  });
  try { (await import(path.join(ROOT, 'tools/browser_leak_guard.js'))).default.guard(browser, 'dc_ports4_proof'); } catch (_e) {}
  try {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => { const t = (e && e.message) || String(e); if (/ports4-proof/.test(t)) errs.push(t); });
    await page.goto(RIGURL + '/dreamcast.html', { waitUntil: 'domcontentloaded', timeout: 120000 });
    // coi-serviceworker reloads the page on the first visit; anything evaluated
    // across that reload throws "Execution context destroyed", which reads like
    // a crash. Wait for the settled, isolated load.
    for (let i = 0; i < 240; i++) {
      const iso = await page.evaluate(() => self.crossOriginIsolated === true).catch(() => false);
      if (iso) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const installed = await page.evaluate(() => !!window.__ports4Installed).catch(() => false);
    if (!installed) return { ok: false, why: 'the rig injection never ran — the page served by the rig origin is not the patched one, so this would have been a placebo arm' };
    await page.waitForFunction(() => !!document.getElementById('btnStart'), { timeout: 60000 });
    await page.evaluate((g) => {
      const s = document.getElementById('romSelect');
      if (s) { s.value = g; s.dispatchEvent(new Event('change')); }
      const b = document.getElementById('btnStart') || document.getElementById('mobileSplashStart');
      if (b) b.click();
    }, GAME);
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < BOOT_MS) {
      last = await page.evaluate(() => {
        const p = window.__ports4;
        if (!p || !p.worker) return null;
        try { p.worker.postMessage({ cmd: 'portPolls' }); } catch (e) { return null; }
        const r = p.replies.filter((m) => m.cmd === 'portPolls' && m.ok);
        return r.length ? r[r.length - 1] : null;
      }).catch(() => null);
      if (last && last.polls && last.polls.some((v) => v > 0)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!last || !last.polls) return { ok: false, why: 'the core never answered portPolls within ' + BOOT_MS + ' ms' };
    const live = last.polls.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
    const want = []; for (let i = 0; i < PLAYERS; i++) want.push(i);
    const ok = JSON.stringify(live) === JSON.stringify(want) && last.players === PLAYERS;
    return { ok, polls: last.polls, players: last.players, live, want, pageerrors: errs,
             why: ok ? null : `worker says players=${last.players}, guest polled ports ${JSON.stringify(live)}, expected ${JSON.stringify(want)}` };
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------------------
// PHASE 2 — the measurement, run by the probe that owns the rig.
// ---------------------------------------------------------------------------
function runProbe() {
  const cmd = ['dreamcast/tools/determinism_probe.mjs',
    '--frame0', '--normalize', ...(EQUALIZE ? ['--equalize'] : []), '--arms', ARMS,
    '--frames', String(FRAMES), '--runs', String(RUNS), '--warmup', '0',
    '--ports', String(PLAYERS), '--game', GAME, '--name', NAME,
    // The rig origin, and a profile of its own: a different origin has its own
    // HTTP cache, and sharing the two-port arm's profile would mean two runs
    // racing one Chrome user-data dir.
    '--url', RIGURL, '--profile', '/private/tmp/claude-501/dc-det-ports4-profile'];
  say(`\n[ports4] node ${cmd.join(' ')}`);
  say(`[ports4] rig origin: ${RIGURL}  (the live site on :8080 is left alone)`);
  return new Promise((resolve) => {
    let out = '';
    const ch = spawn(process.execPath, cmd, {
      cwd: ROOT, env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const grab = (b) => { const s = b.toString(); out += s; process.stdout.write(s); };
    ch.stdout.on('data', grab); ch.stderr.on('data', grab);
    ch.on('close', (code) => resolve({ code, out }));
  });
}

// The SAME verdict reading tools/audit_all.mjs uses for the two-port gate. The
// probe ends `finish(0)` on its success path whatever the verdict says, so
// judging on exit status would be a permanent green.
function readVerdicts(out) {
  const re = /VERDICT (\w+): (\d+)\/(\d+) runs byte-identical over (\d+) frames(?: \(\+(\d+) rig faults\))?; first-divergence frames: (\[[^\]]*\]); watchdog fires: (\d+)/g;
  const rows = []; let m;
  while ((m = re.exec(out))) rows.push({
    arm: m[1], identical: +m[2], measured: +m[3], frames: +m[4],
    faults: +(m[5] || 0), where: m[6], watchdog: +m[7],
  });
  return rows;
}

// ---------------------------------------------------------------------------
const before = wasmHash();
say('='.repeat(78));
say(`  FOUR-PORT DETERMINISM ARM — ${PLAYERS} controllers, input driven into all ${PLAYERS}`);
say(`  wasm BEFORE: ${before}`);
say(`  load: ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}   (CLAUDE.md: above ~25 is void)`);
say('='.repeat(78));

const tree = buildRigTree(PLAYERS);
say(`[ports4] rig tree: ${tree.dir}`);
say(`[ports4] rig dreamcast.html = the shipped ${tree.shippedBytes} B page + ${tree.injectedBytes} B of injection, asserted reversible`);
const rigServer = await startRigServer(RIGPORT);
const stopRig = () => { try { rigServer.kill('SIGTERM'); } catch (_e) {} };
process.on('exit', stopRig);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopRig(); process.exit(130); });
say(`[ports4] rig origin up on ${RIGURL} (repo devserver, WEB_ROOT=${tree.dir})`);

say('\n-- PHASE 1: is the plug real? (emscripten_get_port_polls, bumped only for a port with a device)');
const proof = await proofPhase();
say(`[ports4] players=${proof.players} polls=${JSON.stringify(proof.polls)} portsRead=${JSON.stringify(proof.live)} want=${JSON.stringify(proof.want)}`);
if (proof.pageerrors && proof.pageerrors.length) say(`[ports4] in-page proof channel: ${proof.pageerrors[0]}`);
if (!proof.ok) {
  say(`\nFAIL  the four-port plug did not take — ${proof.why}`);
  say('      NOT MEASURING: a determinism verdict from a two-port machine reported as four is worse than no verdict.');
  process.exit(2);
}
say(`PASS  the guest POLLED ports ${JSON.stringify(proof.live)} — all ${PLAYERS} controllers are real devices`);
if (has('--proofonly')) process.exit(0);

const { code, out } = await runProbe();
const after = wasmHash();
say(`\n[ports4] wasm AFTER: ${after}`);

let bad = [];
if (before !== after) bad.push(`wasm CHANGED mid-run ${before} -> ${after} — concurrent relink, run VOID`);
if (code !== 0) bad.push(`probe exited ${code} — FATAL/rig fault`);
const rows = readVerdicts(out);
const wanted = ARMS.split(',').map((s) => s.trim()).filter(Boolean);
for (const a of wanted) {
  const r = rows.find((x) => x.arm === a);
  if (!r) { bad.push(`no VERDICT line for arm "${a}"`); continue; }
  if (r.measured < Number(RUNS)) bad.push(`${a}: only ${r.measured} of ${RUNS} runs measured (+${r.faults} rig faults)`);
  else if (r.identical !== r.measured || r.faults) bad.push(`${a}: DESYNC — ${r.identical}/${r.measured} byte-identical, first divergence at frame(s) ${r.where}`);
}

say('\n' + '='.repeat(78));
for (const r of rows) say(`  ${r.arm.padEnd(6)} ${r.identical}/${r.measured} byte-identical over ${r.frames} frames · first divergence ${r.where} · watchdog ${r.watchdog}`);
say(`  ports plugged: ${PLAYERS} (proven: guest polled ${JSON.stringify(proof.live)})   ports driven: ${PLAYERS}`);
say(`  wasm ${before}${before === after ? ' (unchanged)' : ' -> ' + after}`);
if (bad.length) { say(`  ${'FAIL'}  ` + bad.join(' | ')); say('='.repeat(78)); process.exit(1); }
say(`  PASS  every requested arm was byte-identical on all runs with ${PLAYERS} controllers seated`);
say('='.repeat(78));
process.exit(0);

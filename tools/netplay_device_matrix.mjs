#!/usr/bin/env node
// ============================================================================
// netplay_device_matrix.mjs — DOES A REAL TWO-PLAYER ROOM WORK ON EVERY DEVICE?
// ============================================================================
//
// WHY THIS EXISTS. A real room failed: an Android phone hosting N64 Mario Kart
// showed a black screen and held the room to 0.36x with broken audio, while the
// desktop joiner rendered fine. Every netplay rig before this one put both
// players in ONE desktop Chrome (`?net=local`, a BroadcastChannel), so the
// asymmetric case — one weak device, one strong one — had never been run.
//
// WHAT IS DIFFERENT HERE
//   * TWO BROWSER PROCESSES. Each player is its own `puppeteer.launch` with its
//     own profile. A BroadcastChannel cannot cross that boundary, so the pages
//     pair over the SHIPPED signalling path — the MQTT relay (`?signal=ws`,
//     lib/netplay.js signalPlan) — pointed at a broker this rig runs
//     (tools/mqtt_ws_broker.mjs, `?wsbroker=`), because the public brokers
//     reset from this sandbox. After signalling, game traffic is a real WebRTC
//     DataChannel between the two processes (host candidates; mDNS obfuscation
//     is switched off so the two processes can resolve each other), or — in the
//     `drelay` arm — the room's own relay mode over the broker.
//   * DEVICE CONDITIONS PER PLAYER, via CDP on that player's page: Android UA
//     (+ UA-CH metadata), touch, isMobile, landscape 915x412, and
//     Emulation.setCPUThrottlingRate 4 on the page AND on every dedicated
//     worker it spawns (the emulators run in workers on several consoles; a
//     page-only throttle would leave the actual CPU loop untouched). Every
//     throttled target is recorded, and the throttle is PROVEN by a busy-loop
//     timing before/after (arm-difference proof, same rule as
//     tools/device_matrix.mjs: a placebo arm prints no verdict).
//   * NETWORK CONDITIONS. `d`: 100 ms one-way on the P2P DataChannel, modelled
//     in-page as an ordered FIFO (a reliable ordered SCTP channel never
//     reorders), plus 2% of messages paying an extra 200 ms retransmit with
//     head-of-line blocking — CDP's Network.emulateNetworkConditions does NOT
//     reach WebRTC, so it cannot be used for this. `drelay`: WebRTC forced to
//     relay-only with no TURN, so the room falls back to its relay mode over
//     the broker, and the BROKER delays every delivery 100 ms and drops 2%.
//
// ⚠ WHAT THIS STILL CANNOT DO, said plainly so a PASS is not overclaimed:
//   * the "phone" is desktop Chromium with a mobile UA, touch and a CPU
//     throttle. It is NOT a phone GPU, NOT WebKit, NOT Android's audio stack
//     and NOT thermal throttling. A black screen caused by a mobile GPU driver
//     cannot reproduce here. A PASS here is necessary, not sufficient.
//   * both players share one 4-core box (and it is shared with other agents),
//     so both emulators contend for CPU. A throttled player is measured SOLO
//     first so a device that simply lacks the CPU is reported device-limited
//     with numbers instead of being blamed on netplay.
//   * rendering is SwiftShader (no GPU in this container).
//
// MEASURED PER CELL, ON BOTH PLAYERS
//   rate      delivered guest rate: frames the lockstep engine actually RAN per
//             wall second / the console's frame rate, AND the page's own rate
//             witness where it publishes one (dc __dcProbe().guestX, n64
//             __n64Rate.speed, gc __gcRate.speed, genesis/ps1 frame counters).
//             maxWin5 is the fastest 5-second window — the fast-forward check.
//   stalls    count, total ms, and WHO was waited on (the 'stall' event's
//             waitingPeers, mapped to host/joiner).
//   delay     every input-delay change the engine made (raise/lower, frame).
//   latency   local input latency in frames: the rig presses a key, and the
//             first frame the engine RAN whose image carries a changed pad at
//             this machine's own port is the arrival (hook on
//             Lockstep.prototype.beginFrame — console-independent).
//   audio     a sink-side tap on every connect() to AudioContext.destination:
//             render quanta counted, and a DROPOUT = an all-zero hole of
//             <= 400 ms between audible audio (the shape a starved ring buffer
//             produces). Page-native counters are recorded alongside.
//   canvas    a composited screenshot clipped to the largest visible canvas,
//             decoded here; black (< 2% lit pixels or < 8 colours) is a FAIL.
//   desync    engine desync + hashesCompared (> 0 required: an unchecked room
//             is not a synchronised one).
//   errors    uncaught page errors (pageerror). Console errors are recorded.
//
// PASS = both players >= 0.99x delivered, no 5-s window above 1.02x, canvas
// non-black on both, 0 desyncs with hashesCompared > 0, 0 page errors, and
// audio dropouts under the threshold (see AUDIO_DROPOUTS_PER_MIN).
//
// USAGE
//   npm run web
//   node tools/browser_leak_guard.js reap && uptime
//   node tools/netplay_device_matrix.mjs --consoles gen,ps1 --arms a,b,c
//   (the rig takes /tmp/bemental-probe.lock itself around EVERY cell)
//
// FLAGS
//   --consoles dc,n64,gc,gen,ps1    (default all five; gba,snes are SOLO-ONLY: --solo-only)
//   --arms a,b,c,d,drelay,e,ct      (default a,b,c,d,drelay; e is the 10-min soak; ct: the
//                  joiner's emulator WORKER held to --worker-cpu of one core by a
//                  cgroup cpu quota, default 0.35 — a CPU-throttled peer the CDP
//                  throttle cannot make, since it never reaches a worker);
//                  --worker-cpu-until S lifts it S s into the measured window
//   NPDM_MIN_FREE_GB=N  lower the disk gate (default 3; a cell needs N + 1.2 GB)
//   --seconds N    measured seconds per cell (default 60)
//   --soak N       seconds for arm e (default 600)
//   --solo mobile,desktop,pair   measure the SOLO cap (no room) of these
//                  devices; `pair` = two desktop solos AT ONCE (contention control)
//                  first (default: mobile whenever arm b or c runs; 'none' = skip)
//   --solo-only    measure the solo caps and no cells. A solo also records
//                  main-thread long tasks, page-native audio counters
//                  (__audioDiag, lib/cart_audio.js __cartAudio) and a busy-loop
//                  proof in every live worker (see the MOBILE note: the CDP
//                  throttle never reaches workers here)
//   --name N       output under /tmp/npdm/<N>/ (default: timestamp)
//   --retries N    re-run a load-voided cell up to N times (default 1)
//   --url BASE     default http://localhost:8080
//   --keep-profiles  do not delete the per-player profiles
//   --query '&k=v'   append to both hand-off URLs (diagnostic arms only)
// ============================================================================

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startBroker } from './mqtt_ws_broker.mjs';
import { startFirewall, startBrokerFronts, fwProfileDir, counters as fwCounters } from './netplay_firewall.mjs';

const require = createRequire(path.join(os.homedir(), 'probe-deps') + '/');
const puppeteer = require('puppeteer');
const __filename = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);

const BASE = flag('url', 'http://localhost:8080').replace(/\/$/, '');
const SECONDS = +flag('seconds', '60');
const SOAK = +flag('soak', '600');
const RETRIES = +flag('retries', '1');
const NAME = flag('name', new Date().toISOString().replace(/[:.]/g, '-'));
const OUT = path.join('/tmp/npdm', NAME);
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LOCK = process.env.PROBE_LOCK_DIR || '/tmp/bemental-probe.lock';
const VOID_LOAD = +(process.env.NPDM_VOID_LOAD || 25);
// The disk gate (a cell needs MIN_FREE_GB + 1.2 GB free: two profiles, each
// with a 100 MB disk cache, plus the box's other tenants). NPDM_MIN_FREE_GB
// lowers it on a box that is known to be tight — say so in the run's notes.
const MIN_FREE_GB = process.env.NPDM_MIN_FREE_GB != null ? +process.env.NPDM_MIN_FREE_GB : 3;
const KEEP_PROFILES = has('keep-profiles');
// Appended to BOTH players' hand-off URLs — a DIAGNOSTIC arm (e.g. '&rb=0' to
// run Genesis in lockstep instead of rollback). Recorded on every cell.
const EXTRA_Q = flag('query', '');
// DIAGNOSTIC: a CPU profile of each player's main thread for N seconds, taken
// at the middle of the measured window. It PERTURBS the cell (profiling costs
// time), so a --profile cell's rates are not results — see CLAUDE.md gate #10.
const PROFILE_S = +flag('profile', '0');
// DIAGNOSTIC: JS evaluated on BOTH players at the midpoint of the measured
// window (e.g. to close an overlay and see whether the frame rate recovers).
const MID_EVAL = flag('mid-eval', '');
const SOLO_S = +flag('solo-seconds', '40');
// Arm `ct`: the share of ONE core the throttled joiner's worker threads get.
// 0.35 makes a PS1 rollback step (~7 ms of CPU: run + save) cost ~20 ms of wall
// time at 50 Hz — unaffordable — while a delay-lockstep frame (the core run
// only, ~5.5 ms) still fits its 20 ms (~16 ms).
const WORKER_CPU = +flag('worker-cpu', '0.35');
// ...and, with --worker-cpu-until S, for the first S seconds of the measured
// window only: the device recovers, and the room may return to rollback.
const WORKER_CPU_UNTIL = +flag('worker-cpu-until', '0');
// Solo results from an EARLIER run (its matrix.json), so a cell can be judged
// against a solo baseline without re-measuring it every time.
const BASELINE = {}, BASELINE_PAIR = {}, BASELINE_MOBILE = {}, BASELINE_N = {};
if (flag('baseline', '')) {
  for (const f of flag('baseline', '').split(',')) {
    try { const r = JSON.parse(fs.readFileSync(f, 'utf8')); for (const [k, v] of Object.entries(r.solo || {})) { const [c, d] = k.split(':'); if (d === 'desktop') BASELINE[c] = v; if (d === 'pair') BASELINE_PAIR[c] = v; if (d === 'mobile') BASELINE_MOBILE[c] = v; BASELINE_N[k] = v; } } catch (e) { console.error('baseline ' + f + ': ' + e.message); }
  }
}
const SHOTS_AT = flag('shots', '') ? flag('shots', '').split(',').map(Number) : null;

// ---- PASS thresholds ---------------------------------------------------------
// RATE: the product definition is exactly 1.000x (CLAUDE.md gate #9). 0.99 is
// the floor the task set; 1.02 over any 5-s window is the fast-forward ceiling
// (a 5-s window at 60 fps quantises to 1/300 = 0.33%, so 1.02 is 6 quanta of
// sampling slack, not an allowance to sprint).
const RATE_FLOOR = 0.99;
const RATE_CEIL_WIN = 1.02;
// AUDIO: a dropout is an audible gap (an all-zero hole <= 400 ms between
// audible audio). Lockstep legitimately STOPS the core during a stall, and a
// stopped core has nothing to play, so each stall may cost one gap that is
// already counted as a stall — those are subtracted. What remains is judged
// against the SAME GAME PLAYED SOLO on a desktop (the `desktop` solo cap, or
// --baseline): a room may not make audio worse than the game alone, x1.25 for
// scene-to-scene variation, with a floor of 2/min (one click every 30 s) for
// a game whose solo run has none. A fixed absolute number would either fail a
// room for a gap the single-player game has too (PS1 Monster Rancher 2 solo
// measured ~22/min), or pass a room that had made a quiet game crackle.
const AUDIO_DROPOUTS_PER_MIN = 2;

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
                 + 'Chrome/140.0.0.0 Mobile Safari/537.36';

// ---- the consoles ------------------------------------------------------------
// `game` is the key each page's ?np= receiver matches on (multiplayer.html's
// hand-off contract): the romSelect VALUE on dreamcast, the ROMS[] label on the
// others. `hostFlag` — the three cartridge-era pages need &host=1 to host.
// `hz`: an in-page expression for the console's lockstep frame rate.
// `witness`: an in-page expression returning the page's OWN rate reading (x hw).
const CONSOLES = {
  dc: { name: 'Dreamcast', title: 'Gauntlet Legends', page: '/dreamcast.html', game: 'gauntlet', hostFlag: '',
        hz: '59.94', witness: '(window.__dcProbe ? window.__dcProbe().guestX : null)',
        frames: 'null', bootMs: 360000, seam: 'window.__dcNet && window.__dcNet()',
        // A Dreamcast lockstep frame is one retro_run, which is one FRAME THE GAME
        // RENDERS — ~34.5 ms on Gauntlet, not a 59.94 Hz field (dreamcast.html
        // lsChooseDelay notes) — so engine frames/s is not a rate here. The
        // SH4-clock witness (guestX) is.
        rateBy: 'witness' },
  n64: { name: 'N64', title: 'Mario Kart 64', page: '/n64/', game: 'Mario Kart 64', hostFlag: '',
         hz: '((window.__n64Net && window.__n64Net().viHz) || 60)',
         witness: '(window.__n64Rate ? window.__n64Rate.speed : null)', frames: 'null', bootMs: 240000, seam: 'window.__n64Net && window.__n64Net()' },
  gc: { name: 'GameCube', title: 'Mario Party 4', page: '/gamecube.html', game: 'Mario Party 4', hostFlag: '',
        // __gcRate.speed is CUMULATIVE since boot (credits consumed / wall), so it lags any
        // change by minutes; producedPerS is the recomp's per-second guest frame count at the
        // path's pinned GUEST_HZ (60) — gamecube.html's own 'guest = N frames/s' line.
        hz: '((window.__gcRate && window.__gcRate.guestHz) || 60)',
        witness: '(window.__gcRate && window.__gcRate.producedPerS != null ? window.__gcRate.producedPerS / ((window.__gcRate.guestHz) || 60) : null)', frames: 'null', bootMs: 360000, seam: 'window.__gcNet && window.__gcNet()' },
  gen: { name: 'Genesis', title: 'Sonic the Hedgehog 3', page: '/genesis.html', game: 'Sonic the Hedgehog 3', hostFlag: '&host=1',
         hz: '((window.Module && window.Module._gpx_fps && window.Module._gpx_fps()) || 59.922751)',
         witness: 'null', frames: '(window.__genFrames|0)', bootMs: 120000, seam: 'window.__genNet && window.__genNet()' },
  // SOLO-ONLY consoles (--solo-only): no room is ever opened on these by this
  // rig. GBA has no netplay at all; the core runs one frame per emuRunFrame()
  // call, so the page's own call counter IS the guest clock (59.7275 Hz =
  // 16.78 MHz / 280896 cycles per frame). `boot` replaces soloBoot's generic
  // romSelect/btnStart press for a page without those controls.
  gba: { name: 'GBA', title: 'Sonic Advance 3', page: '/gba.html', game: 'Sonic Advance 3', hostFlag: '', soloOnly: true,
         hz: '59.7275', witness: 'null', frames: '(window.myClass ? window.myClass.frameCnt : null)', bootMs: 120000, seam: 'null',
         boot: `(() => { const i = window.ROMLIST.findIndex((r) => r.title === 'Sonic Advance 3'); document.getElementById('romselect').value = window.ROMLIST[i].url; myClass.loadRom(); return { picked: i }; })()` },
  snes: { name: 'SNES', title: 'SimCity', page: '/snes.html', game: 'SimCity', hostFlag: '&host=1',
          hz: '60.0988', witness: 'null', frames: '(window.__snesFrames|0)', bootMs: 120000, seam: 'window.__snesNet && window.__snesNet()' },
  ps1: { name: 'PS1', title: 'Monster Rancher 2', page: '/ps1.html', game: 'Monster Rancher 2', hostFlag: '&host=1',
         hz: '((window.__ps1Net && window.__ps1Net().hz) || 59.94)',
         witness: 'null', frames: '(window.__ps1Frames|0)', bootMs: 300000,
         // SOLO has no gated-frame counter (__ps1Frames counts only frames the
         // lockstep feed retired), so the solo cap reads the SPU: frames the
         // page's AudioDiag counted as PRODUCED, against the 44100 Hz SPU rate
         // (lib/audiodiag.js NOMINAL_RATE.ps1, dfsound/sdl.c:80).
         soloFrames: '(window.__audioDiag ? window.__audioDiag.framesProduced : null)', soloHz: '44100',
         aux: '(window.__audioDiag ? window.__audioDiag.framesProduced : null)', seam: 'window.__ps1Net && window.__ps1Net()',
         // the page's own per-second render line: frames drawn, the gap between
         // renders and the main-thread time each render took
         ui: "(document.getElementById('fps') || {}).textContent || null" },
};

// ---- the arms ----------------------------------------------------------------
const DESKTOP = { kind: 'desktop' };
const MOBILE = { kind: 'mobile', cpu: 4 };
// ⚠ Emulation.setCPUThrottlingRate DOES NOT REACH WORKERS in this Chromium
// (chromium-1194): on a worker target it is refused with "Operation is only
// supported for pages, not workers" (measured 2026-10-01; every mobile solo
// records it in throttleRejected, and workerProof times the same busy loop in
// each live worker against the page's unthrottled time). The page-level
// throttle slows the renderer MAIN thread. So on a console whose CPU loop runs
// in a worker, this arm throttles the UI, not the emulator — read its rate as
// an upper bound for a phone, not a measurement of one.
const ARMS = {
  a: { id: 'a', what: 'desktop host + desktop joiner', host: DESKTOP, join: DESKTOP },
  b: { id: 'b', what: 'mobile-emulated 4x-throttled HOST + desktop joiner', host: MOBILE, join: DESKTOP },
  c: { id: 'c', what: 'desktop host + mobile-emulated 4x-throttled JOINER', host: DESKTOP, join: MOBILE },
  d: { id: 'd', what: 'desktop pair, P2P link 100 ms one-way; 2% loss (reliable channel: +200 ms retransmit, head-of-line; unreliable channel: dropped)',
       host: DESKTOP, join: DESKTOP, p2p: { delayMs: 100, lossFrac: 0.02, rtxMs: 200 } },
  // THE REPORTED ROOM (docs/devices/xbox-edge.md, 2026-10-06): a direct P2P link
  // at RTT 127 ms with jitter — 53.5 ms + 0-20 ms each way (mean 63.5) — and 2%
  // loss. The rule here is ZERO stalls (the stalls line), not only the rate.
  r127: { id: 'r127', what: 'desktop pair, P2P RTT ~127 ms (53.5 + 0-20 ms jitter each way); 2% loss',
          host: DESKTOP, join: DESKTOP, p2p: { delayMs: 53.5, jitterMs: 20, lossFrac: 0.02, rtxMs: 200 } },
  drelay: { id: 'drelay', what: 'desktop pair, room forced onto RELAY mode; broker 100 ms one-way + 2% loss',
            host: DESKTOP, join: DESKTOP, relay: true, broker: { delayMs: 100, loss: 0.02 } },
  // A PLAYER BEHIND A 443-ONLY FIREWALL (docs/netplay/firewall.md). The JOINER's
  // browser runs as its own uid behind KERNEL rules (tools/netplay_firewall.mjs):
  // TCP 443 out, the page, and nothing else — every other TCP port refused, every
  // UDP datagram dropped. Nothing in the page is shimmed: the room has to find
  // out for itself that the 8084 broker is unreachable (the hand-off lists it
  // FIRST) and that WebRTC cannot open, and go to the relay. The broker is the
  // rig's, served as wss on 443 and 8084 through TLS fronts, impaired to the
  // shape of the public 443 brokers measured from this sandbox (126-344 ms one
  // way through its egress proxy, 0-0.6% loss at 60 msg/s; see
  // tools/netplay_broker_check.mjs).
  fw: { id: 'fw', what: 'desktop host (open network) + desktop JOINER behind a kernel 443-only firewall (no UDP, no TCP but 443); broker wss on 443 + 8084, 150 ms one-way + 1% loss',
        host: DESKTOP, join: DESKTOP, firewall: true, broker: { delayMs: 150, loss: 0.01 } },
  // The same firewall with an UNIMPAIRED broker: what the relay path itself costs.
  fw0: { id: 'fw0', what: 'as fw, broker unimpaired (0 ms, 0% loss)',
         host: DESKTOP, join: DESKTOP, firewall: true, broker: { delayMs: 0, loss: 0 } },
  // The same firewall with a slower broker: the upper end of what was measured.
  fw300: { id: 'fw300', what: 'as fw, broker 300 ms one-way + 1% loss',
           host: DESKTOP, join: DESKTOP, firewall: true, broker: { delayMs: 300, loss: 0.01 } },
  e: { id: 'e', what: 'desktop pair, soak', host: DESKTOP, join: DESKTOP, soak: true },
  // A CPU-THROTTLED PEER WHOSE EMULATOR RUNS IN A WORKER (ps1): the CDP throttle
  // never reaches a worker (see MOBILE), so the kernel throttles it — every
  // DedicatedWorker thread of the joiner's renderer shares WORKER_CPU of one
  // core (a cgroup cpu quota; see workerThrottleStart). The room must not run
  // slower because rollback was chosen: the capacity gate must move it to delay.
  ct: { id: 'ct', what: 'desktop host + desktop joiner whose emulator worker gets a fraction of one core (cgroup cpu quota: a CPU-throttled peer)',
        host: DESKTOP, join: { kind: 'desktop', workerCpu: true } },
  // FOUR-PORT CONSOLES (Dreamcast, GameCube, N64): three and four players, each
  // in their own browser process. On this 4-core box that is 3-4 emulators at
  // once, so these are judged against the `trio`/`quad` solo controls.
  q3: { id: 'q3', what: 'three desktop players', host: DESKTOP, join: DESKTOP, players: 3 },
  q4: { id: 'q4', what: 'four desktop players', host: DESKTOP, join: DESKTOP, players: 4 },
};

const consoles = flag('consoles', 'dc,n64,gc,gen,ps1').split(',').map((s) => s.trim()).filter(Boolean);
const arms = flag('arms', 'a,b,c,d,drelay').split(',').map((s) => s.trim()).filter(Boolean);
for (const c of consoles) if (!CONSOLES[c]) { console.error('unknown console ' + c); process.exit(2); }
for (const a of arms) if (!ARMS[a]) { console.error('unknown arm ' + a); process.exit(2); }
// Solo caps: which devices to measure ALONE (no room) before the cells.
// Default: the throttled mobile device whenever arm b or c runs.
const SOLO_DEVS = flag('solo', (arms.includes('b') || arms.includes('c')) ? 'mobile' : 'none')
  .split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
for (const s of SOLO_DEVS) if (!['mobile', 'desktop', 'pair', 'trio', 'quad'].includes(s)) { console.error('unknown --solo device ' + s); process.exit(2); }
const SOLO_ONLY = has('solo-only');

fs.mkdirSync(OUT, { recursive: true });
const logStream = fs.createWriteStream(path.join(OUT, 'run.log'), { flags: 'a' });
const T0 = Date.now();
const say = (s) => {
  const line = '[' + ((Date.now() - T0) / 1000).toFixed(1).padStart(7) + 's] ' + s;
  console.log(line);
  try { logStream.write(line + '\n'); } catch (e) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uptime = () => { try { return execSync('uptime').toString().trim(); } catch (e) { return ''; } };
const load1 = () => { const m = uptime().match(/load averages?: ([\d.]+)/); return m ? +m[1] : null; };
const freeGB = () => { try { return +execSync("df -k / | tail -1 | awk '{print $4}'").toString().trim() / 1048576; } catch (e) { return null; } };

// ---- the probe lock (compatible with tools/probe_lock.sh) --------------------
let lockHeld = false;
function lockOwnerAlive() {
  try {
    const pid = +fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim().split(/\s+/)[0];
    if (!pid) return null;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
  } catch (e) { return null; }
}
// ⚠ COURTESY GAP. Releasing and immediately re-taking the lock between cells
// starves every other agent polling for it (they poll every 5-10 s; this
// process re-took it in milliseconds, cell after cell, for over an hour). So a
// release is followed by LOCK_GAP_S seconds in which this process does not
// try, and if anyone took the lock in that gap they go first.
const LOCK_GAP_S = +(process.env.NPDM_LOCK_GAP_S || 30);
let lastRelease = 0;
async function acquireLock(tag) {
  const gap = lastRelease ? LOCK_GAP_S * 1000 - (Date.now() - lastRelease) : 0;
  if (gap > 0) { say(`[lock] courtesy gap ${Math.round(gap / 1000)}s before re-taking it`); await sleep(gap); }
  let waited = 0, said = 0;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      fs.writeFileSync(path.join(LOCK, 'owner'), `${process.pid} netplay_device_matrix:${tag} ${new Date().toTimeString().slice(0, 8)}\n`);
      lockHeld = true;
      say(`[lock] ACQUIRED ${LOCK} for ${tag} after ${waited}s · ${uptime()}`);
      return;
    } catch (e) {
      const alive = lockOwnerAlive();
      if (alive === false) { say('[lock] owner is gone — reclaiming a stale lock'); try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_e) {} continue; }
      if (alive === null) {
        // ownerless: reclaim after 10 min untouched (probe_lock.sh's rule)
        try { const st = fs.statSync(LOCK); if (Date.now() - st.mtimeMs > 10 * 60000) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; } } catch (_e) { continue; }
      }
      if (waited - said >= 60 || said === 0) {
        said = waited || 1;
        let who = ''; try { who = fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim(); } catch (_e) {}
        say(`[lock] waiting — held by: ${who || '(ownerless)'}`);
      }
      await sleep(5000); waited += 5;
    }
  }
}
function releaseLock() {
  if (!lockHeld) return;
  try {
    const pid = +fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim().split(/\s+/)[0];
    if (pid === process.pid) fs.rmSync(LOCK, { recursive: true, force: true });
  } catch (e) {}
  lockHeld = false;
  lastRelease = Date.now();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseLock(); process.exit(130); });
process.on('exit', releaseLock);

// ---- mqtt.js, injected ---------------------------------------------------------
// lib/netplay.js loads mqtt from cdnjs (WS_LIB) unless window.mqtt already
// exists (loadMqtt). Chromium here has no route to cdnjs, so the SAME file is
// fetched once by this process and defined before any page script runs.
const MQTT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.3.4/mqtt.min.js';
const MQTT_CACHE = '/tmp/npdm/mqtt-5.3.4.min.js';
function mqttSource() {
  if (!fs.existsSync(MQTT_CACHE) || fs.statSync(MQTT_CACHE).size < 100000) {
    execSync(`curl -sS -f -o ${MQTT_CACHE} ${MQTT_URL}`);
  }
  return fs.readFileSync(MQTT_CACHE, 'utf8');
}

// ---- the in-page instrument -------------------------------------------------------
// Installed with evaluateOnNewDocument, before any page script. Everything it
// does is READ-ONLY with respect to the game except the two network shims,
// which exist only in arms d / drelay.
function preloadSrc(cfg) {
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const now = () => performance.now();
  const M = window.__npdm = {
    cfg: CFG, t0: now(), readyFrames: 0, lastFrame: null, stalls: [], resumes: [], delays: [],
    lat: [], latPending: null, win: [], desyncs: [], engineSeen: false,
    audio: { ctxs: 0, taps: 0, quanta: 0, audibleQuanta: 0, zeroQuanta: 0, dropouts: 0, longSilences: 0,
             firstAudibleAt: null, err: null, curZero: 0, sawAudible: false },
    p2p: { sent: 0, delayed: 0, rtx: 0 }, relayForced: false,
    lt: { n: 0, ms: 0, max: 0, over100: 0 },
  };
  // ---------------- main-thread long tasks (>50 ms) ----------------
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { M.lt.n++; M.lt.ms += e.duration; if (e.duration > M.lt.max) M.lt.max = e.duration; if (e.duration > 100) M.lt.over100++; } })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) { M.lt.err = String(e); }
  // ---------------- WHAT a long main-thread stop was (Long Animation Frames) ----------------
  // The longtask entry above says only how long; a LoAF names the scripts that ran
  // in it (source, function, invoker) and how much of it was rendering.
  M.loaf = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) {
      if (e.duration < 100) continue;
      const sc = (e.scripts || []).map((x) => ({ src: String(x.sourceURL || '').split('/').pop().split('?')[0] + ':' + (x.sourceFunctionName || '?') + '@' + (x.sourceCharPosition | 0),
        inv: String(x.invoker || '').slice(0, 60), it: x.invokerType, ms: Math.round(x.duration), fwd: Math.round(x.forcedStyleAndLayoutDuration || 0) }))
        .sort((p, q) => q.ms - p.ms).slice(0, 4);
      M.loaf.push({ t: Math.round(e.startTime), ms: Math.round(e.duration), blk: Math.round(e.blockingDuration || 0),
        render: e.renderStart ? Math.round(e.startTime + e.duration - e.renderStart) : 0, sc });
      if (M.loaf.length > 300) M.loaf.shift();
    } }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { M.loafErr = String(e); }
  // ---------------- lockstep hooks (prototype-level, console-independent) ----------------
  const hook = () => {
    const L = window.Netplay && window.Netplay.Lockstep;
    if (!L) return false;
    if (L.prototype.__npdm) return true;
    L.prototype.__npdm = true;
    const emit = L.prototype._emit;
    L.prototype._emit = function (ev, a) {
      try {
        const t = Math.round(now() - M.t0);
        if (ev === 'stall') M.stalls.push({ t, frame: a.frame, waitingPeers: (a.waitingPeers || []).slice(), waitingOn: (a.waitingOn || []).slice(), why: a.why || null });
        else if (ev === 'resume') M.resumes.push({ t, frame: a.frame, ms: Math.round(a.ms) });
        else if (ev === 'delay') M.delays.push({ t, frame: this.frame, from: a.from, to: a.to, at: a.at, reason: a.reason || null });
        else if (ev === 'desync') M.desyncs.push({ t, d: JSON.parse(JSON.stringify(a || {})) });
      } catch (e) {}
      return emit.call(this, ev, a);
    };
    const begin = L.prototype.beginFrame;
    L.prototype.beginFrame = function (pads) {
      const r = begin.call(this, pads);
      try {
        M.engineSeen = true;
        M.engine = this;
        if (r && r.ready) {
          M.readyFrames++;
          M.lastFrame = r.frame;
          const lp = this.localPorts && this.localPorts.length ? this.localPorts[0] : null;
          if (lp != null && r.image) {
            const pb = this.padBytes | 0;
            const key = Array.prototype.join.call(r.image.subarray(lp * pb, lp * pb + pb), ',');
            const P = M.latPending;
            if (P && P.base === null) P.base = M.lastLocalKey;          // pad before the press
            if (P && P.base !== null && key !== P.base) {
              M.lat.push({ frames: r.frame - P.frame, ms: +(now() - P.t).toFixed(1), delay: this.delay, rollback: !!this.rollback });
              M.latPending = null;
            }
            M.lastLocalKey = key;
          }
        }
      } catch (e) {}
      return r;
    };
    return true;
  };
  if (!hook()) { const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 10); }
  // The rig calls this immediately before a real key press.
  M.press = () => {
    const e = M.engine;
    M.latPending = { frame: e ? e.frame : null, t: now(), base: (M.lastLocalKey == null ? null : M.lastLocalKey) };
    return M.latPending.frame;
  };
  // ---------------- per-second sampler ----------------
  let lastReady = 0, rafN = 0;
  const rafTick = () => { rafN++; requestAnimationFrame(rafTick); };
  requestAnimationFrame(rafTick);
  const ev = (s) => { try { return eval(s); } catch (e) { return null; } };
  setInterval(() => {
    const e = M.engine;
    const rep = (() => { try { return e ? e.report() : null; } catch (x) { return null; } })();
    M.win.push({
      t: Math.round(now() - M.t0), ready: M.readyFrames - lastReady, frame: e ? e.frame : null,
      state: e ? e.state : null, delay: e ? e.delay : null,
      stalls: rep ? rep.stalls : null, stallMs: rep ? rep.stallMs : null,
      witness: ev(CFG.witness), frames: ev(CFG.frames), hz: ev(CFG.hz), aux: ev(CFG.aux || 'null'), ui: ev(CFG.ui || 'null'),
      aq: M.audio.quanta, aDrop: M.audio.dropouts, raf: rafN,
      lt: M.lt.n, ltMs: Math.round(M.lt.ms),
      ad: (() => { const d = window.__audioDiag; return d ? { p: d.framesProduced, c: d.framesConsumed, u: d.underruns == null ? null : d.underruns, uf: d.underrunFrames, df: d.droppedFrames, fill: d.fill } : null; })(),
      // lib/cart_audio.js's sink counters (gba/snes/genesis), page-native.
      ca: (() => { const c = window.__cartAudio; return c ? { rx: c.rxFrames, u: c.underruns, m: c.missingFrames, o: c.overflowFrames, b: c.backlog, mode: c.mode } : null; })(),
      // THE CAPACITY GATE'S INPUTS, as this engine sees them (lib/netplay.js
      // _capDecide): its own step (st), steps per frame (rs), corrections per
      // frame (cr), p90 depth (dp) and need — and, on the host, every console's
      // row. Read-only.
      cap: (() => {
        try {
          if (!e || !e._capGate) return null;
          const rb = e.rbStats || {};
          const o = { mode: e.rollback ? 'rb' : 'delay', st: +(+e.selfStepMs || 0).toFixed(2), rs: e._capSelfRs ? +e._capSelfRs.toFixed(3) : null,
                      cr: e._capSelfCr != null ? +e._capSelfCr.toFixed(4) : null, dp: e._capSelfDp ? e._capSelfDp() : null,
                      need: e._capNeed == null ? null : e._capNeed, n: rb.rollbacks, rf: rb.resimFrames, md: rb.maxDepth, ws: rb.windowStalls, w: e.rollback };
          if (e.isHost && e._capRows) o.rows = e._capRows(e._now()).map((r) => ({ st: r.st, rs: r.rs, dp: r.dp, cr: r.cr, lt: r.lt }));
          return o;
        } catch (x) { return { err: String(x).slice(0, 80) }; }
      })(),
    });
    rafN = 0;
    lastReady = M.readyFrames;
    if (M.win.length > 1500) M.win.shift();
  }, 1000);
  // ---------------- audio sink tap ----------------
  // Every connect() to a context's destination is ALSO connected into a
  // collector that feeds an AudioWorklet which counts render quanta and holes.
  try {
    const orig = AudioNode.prototype.connect;
    const per = new WeakMap();
    const WORKLET = 'class T extends AudioWorkletProcessor{constructor(){super();this.q=0;this.aud=0;this.zero=0;this.cur=0;this.drop=0;this.longS=0;this.seen=false;this.first=null;this.n=0;}'
      + 'process(ins){const i=ins[0];let z=true;if(i&&i.length){for(let c=0;c<i.length&&z;c++){const ch=i[c];for(let k=0;k<ch.length;k++){if(ch[k]!==0){z=false;break;}}}}'
      + 'this.q++;if(z){this.zero++;if(this.seen)this.cur++;}else{this.aud++;if(!this.seen){this.seen=true;this.first=currentTime;}'
      + 'if(this.cur>0){const ms=this.cur*128*1000/sampleRate;if(ms<=400)this.drop++;else this.longS++;}this.cur=0;}'
      + 'if(++this.n>=375){this.n=0;this.port.postMessage({q:this.q,aud:this.aud,zero:this.zero,drop:this.drop,longS:this.longS,first:this.first});}return true;}}'
      + 'registerProcessor("npdm-tap",T);';
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    const setup = (ctx) => {
      let s = per.get(ctx);
      if (s) return s;
      s = { col: ctx.createGain(), ready: false };
      per.set(ctx, s);
      M.audio.ctxs++;
      s.col.gain.value = 1;
      ctx.audioWorklet.addModule(url).then(() => {
        const node = new AudioWorkletNode(ctx, 'npdm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const mute = ctx.createGain(); mute.gain.value = 0;
        orig.call(s.col, node); orig.call(node, mute); orig.call(mute, ctx.destination);
        M.audio.taps++;
        // Several contexts sum; this page almost always has one.
        const mine = { q: 0, aud: 0, zero: 0, drop: 0, longS: 0 };
        node.port.onmessage = (m) => {
          const d = m.data;
          M.audio.quanta += d.q - mine.q; M.audio.audibleQuanta += d.aud - mine.aud; M.audio.zeroQuanta += d.zero - mine.zero;
          M.audio.dropouts += d.drop - mine.drop; M.audio.longSilences += d.longS - mine.longS;
          Object.assign(mine, d);
          if (d.first != null && M.audio.firstAudibleAt == null) M.audio.firstAudibleAt = Math.round(now() - M.t0);
          M.audio.sampleRate = ctx.sampleRate; M.audio.state = ctx.state;
        };
      }).catch((e) => { M.audio.err = String(e && e.message || e); });
      return s;
    };
    AudioNode.prototype.connect = function (dest) {
      try {
        const ctx = this.context;
        if (ctx && dest && dest === ctx.destination && ctx.audioWorklet && !(ctx instanceof OfflineAudioContext)) {
          const s = setup(ctx);
          if (this !== s.col) orig.call(this, s.col);
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  } catch (e) { M.audio.err = 'tap install: ' + e; }
  // ---------------- network shims (arms d / drelay only) ----------------
  if (CFG.p2p) {
    const send = RTCDataChannel.prototype.send;
    const Q = new WeakMap();
    RTCDataChannel.prototype.send = function (data) {
      const ch = this;
      let q = Q.get(ch); if (!q) { q = { last: 0 }; Q.set(ch, q); }
      M.p2p.sent++;
      // An UNRELIABLE channel (lib/netplay.js's 'lsu' input channel: unordered
      // or maxRetransmits 0) loses the message outright; a reliable ordered one
      // retransmits and blocks everything behind it.
      const unreliable = ch.ordered === false || ch.maxRetransmits === 0;
      if (unreliable) {
        M.p2p.unreliable = (M.p2p.unreliable || 0) + 1;
        if (Math.random() < CFG.p2p.lossFrac) { M.p2p.lost = (M.p2p.lost || 0) + 1; return; }
        // jitterMs: uniform extra one-way delay per message (unordered: may reorder).
        const d = CFG.p2p.delayMs + Math.random() * (CFG.p2p.jitterMs || 0);
        setTimeout(() => { try { if (ch.readyState === 'open') send.call(ch, data); } catch (e) {} }, d);
        return;
      }
      const rtx = Math.random() < CFG.p2p.lossFrac;
      if (rtx) M.p2p.rtx++;
      const at = Math.max(now() + CFG.p2p.delayMs + Math.random() * (CFG.p2p.jitterMs || 0) + (rtx ? CFG.p2p.rtxMs : 0), q.last);
      q.last = at;
      M.p2p.delayed++;
      setTimeout(() => { try { if (ch.readyState === 'open') send.call(ch, data); } catch (e) {} }, Math.max(0, at - now()));
    };
  }
  // ---------------- ICE witness (firewall arms): what this browser could offer ----------------
  // Read-only: listeners beside lib/netplay.js's own handlers. Which candidate
  // TYPES were gathered and which states each connection went through is the
  // per-player half of the firewall arm's proof.
  if (CFG.ice) {
    const PC0 = window.RTCPeerConnection;
    M.ice = { pcs: 0, cands: {}, states: [] };
    const W0 = function (cfg, ...rest) {
      const pc = new PC0(cfg, ...rest);
      const id = ++M.ice.pcs;
      pc.addEventListener('icecandidate', (e) => { if (e.candidate) { const k = (e.candidate.type || '?') + '/' + (e.candidate.protocol || '?'); M.ice.cands[k] = (M.ice.cands[k] || 0) + 1; } });
      pc.addEventListener('connectionstatechange', () => { if (M.ice.states.length < 64) M.ice.states.push(id + '@' + Math.round(now() - M.t0) + ':' + pc.connectionState); });
      pc.addEventListener('icegatheringstatechange', () => { if (M.ice.states.length < 64) M.ice.states.push(id + '@' + Math.round(now() - M.t0) + ':gather-' + pc.iceGatheringState); });
      return pc;
    };
    W0.prototype = PC0.prototype;
    Object.setPrototypeOf(W0, PC0);
    window.RTCPeerConnection = W0;
  }
  if (CFG.relay) {
    const PC = window.RTCPeerConnection;
    const W = function (cfg, ...rest) {
      const c = Object.assign({}, cfg || {}, { iceTransportPolicy: 'relay' });
      M.relayForced = true;
      return new PC(c, ...rest);
    };
    W.prototype = PC.prototype;
    Object.setPrototypeOf(W, PC);
    window.RTCPeerConnection = W;
  }
})();`;
}

// ---- PNG decode (Chrome emits 8-bit RGB/RGBA, non-interlaced) ------------------------
function decodePng(buf) {
  let off = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp; const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride); const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = (prev && i >= bpp) ? prev[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
function judgePixels(img) {
  let lit = 0, n = 0; const colours = new Set(); let lum = 0;
  for (let i = 0; i < img.px.length; i += img.bpp * 3) {       // every 3rd pixel is plenty
    const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
    n++; if (Math.max(r, g, b) > 32) lit++;
    lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    colours.add((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4));
  }
  const litFrac = n ? lit / n : 0;
  return { w: img.w, h: img.h, litFrac: +litFrac.toFixed(4), colours: colours.size, meanLum: +(lum / (n || 1)).toFixed(1),
           showing: litFrac >= 0.02 && colours.size >= 8 };
}
async function canvasShot(page, file) {
  try {
    const rect = await page.evaluate(() => {
      let best = null;
      for (const c of document.querySelectorAll('canvas')) {
        const r = c.getBoundingClientRect(); const s = getComputedStyle(c);
        if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
        const x = Math.max(0, r.left), y = Math.max(0, r.top);
        const w = Math.min(innerWidth, r.right) - x, h = Math.min(innerHeight, r.bottom) - y;
        if (w < 16 || h < 16) continue;
        if (!best || w * h > best.w * best.h) best = { x, y, w, h, id: c.id || null };
      }
      return best;
    });
    if (!rect) return { showing: false, why: 'no visible canvas in the viewport' };
    const buf = await page.screenshot({ type: 'png', clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h }, captureBeyondViewport: false });
    fs.writeFileSync(file, buf);
    return Object.assign(judgePixels(decodePng(Buffer.from(buf))), { canvas: rect.id, file });
  } catch (e) { return { showing: false, why: 'screenshot failed: ' + String(e.message || e).slice(0, 120) }; }
}

// ---- a CPU-throttled EMULATOR thread (cgroup v1 cpu quota) -------------------------
// Every DedicatedWorker thread of this player's renderer(s) is moved into a cpu
// cgroup whose quota is `frac` of one core per 10 ms period, re-scanned every
// 500 ms so a worker spawned later (the core starts at game load) is caught.
// The kernel's own nr_throttled / throttled_time (cpu.stat) is the
// arm-difference proof: a quota that never bit throttled nothing.
const CG_ROOT = '/sys/fs/cgroup/cpu';
function descendantPids(pid) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const pp = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1];
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push(+d);
    } catch (e) {}
  }
  const out = [], q = [pid];
  while (q.length) { const p = q.shift(); for (const k of kids.get(p) || []) { out.push(k); q.push(k); } }
  return out;
}
function workerThrottleStart(P, frac) {
  const dir = path.join(CG_ROOT, `npdm-${process.pid}-${P.role}`);
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'cpu.cfs_period_us'), '10000');
    fs.writeFileSync(path.join(dir, 'cpu.cfs_quota_us'), String(Math.max(1000, Math.round(10000 * frac))));
  } catch (e) { P.cg = { frac, err: 'cgroup refused: ' + String(e.message || e).slice(0, 120) }; return; }
  P.cg = { dir, frac, tids: [], threads: [] };
  const bpid = P.browser.process() && P.browser.process().pid;
  const scan = () => {
    for (const pid of descendantPids(bpid)) {
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (e) { continue; }
      if (!cmd.includes('--type=renderer')) continue;
      let tids = [];
      try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch (e) { continue; }
      for (const t of tids) {
        if (P.cg.tids.includes(+t)) continue;
        let comm = '';
        try { comm = fs.readFileSync(`/proc/${pid}/task/${t}/comm`, 'utf8').trim(); } catch (e) { continue; }
        if (!/^DedicatedWorker/.test(comm)) continue;
        try { fs.writeFileSync(path.join(dir, 'tasks'), String(t)); P.cg.tids.push(+t); P.cg.threads.push(pid + '/' + t + ' ' + comm); } catch (e) {}
      }
    }
  };
  scan();
  P.cg.timer = setInterval(scan, 500);
}
function workerThrottleStat(P) {
  if (!P.cg || !P.cg.dir) return null;
  try {
    const o = {};
    for (const l of fs.readFileSync(path.join(P.cg.dir, 'cpu.stat'), 'utf8').trim().split('\n')) { const [k, v] = l.split(' '); o[k] = +v; }
    return o;
  } catch (e) { return null; }
}
async function workerThrottleEnd(P) {
  if (!P.cg || !P.cg.dir) return;
  clearInterval(P.cg.timer);
  // the browser is closed by now: its threads are gone and the group empties
  for (let i = 0; i < 20; i++) { try { fs.rmdirSync(P.cg.dir); return; } catch (e) { await sleep(250); } }
}

// ---- the broker, out of process (see runCell) ------------------------------------
async function startBrokerProc(impair) {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'mqtt_ws_broker.mjs'), '0',
                                         String(+(impair.delayMs || 0)), String(+(impair.loss || 0))], { stdio: ['ignore', 'pipe', 'pipe'] });
  const B = { stats: {}, impair: { delayMs: +(impair.delayMs || 0), loss: +(impair.loss || 0) }, setImpair() {}, port: 0, url: null, pid: child.pid };
  let buf = '';
  const ready = new Promise((res, rej) => {
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/listening (ws:\/\/localhost:(\d+)\/mqtt)/);
        if (m) { B.url = m[1]; B.port = +m[2]; res(); }
        const st = line.match(/^\[mqtt-ws\] (\{.*\})$/);
        if (st) { try { B.stats = JSON.parse(st[1]); } catch (e) {} }
      }
    });
    child.on('exit', () => rej(new Error('broker process exited')));
    setTimeout(() => rej(new Error('broker process did not start')), 10000);
  });
  await ready;
  B.close = () => new Promise((res) => { child.once('exit', () => res()); try { child.kill('SIGTERM'); } catch (e) { res(); } setTimeout(res, 3000); });
  return B;
}

// ---- a player's browser ---------------------------------------------------------
async function launchPlayer(role, device, cellTag, pre) {
  // pre.fw: this player is BEHIND THE FIREWALL — its browser runs as the
  // firewalled uid (tools/netplay_firewall.mjs), so its profile must be theirs.
  const dir = pre.fw ? fwProfileDir(`npdm-${cellTag}-${role}-`) : fs.mkdtempSync(path.join(os.tmpdir(), `npdm-${cellTag}-${role}-`));
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: pre.fw ? pre.fw.wrapper : CHROME, userDataDir: dir, protocolTimeout: 240000,
    // ⚠ DEVTOOLS OVER A PIPE behind the firewall: the default is a TCP port on
    // loopback, and the firewalled uid may not answer on any port but 443.
    ...(pre.fw ? { pipe: true } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--disable-backgrounding-occluded-windows',
           '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
           '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--disk-cache-size=104857600', '--window-size=1280,800', ...(pre.args || [])],
  });
  try { (await import('./browser_leak_guard.js')).default.guard(browser, __filename); } catch (_e) {}
  const page = (await browser.pages())[0] || await browser.newPage();
  page.setDefaultTimeout(120000);
  const P = { role, device, browser, page, dir, errors: [], consoleErrors: [], log: [], throttled: [], throttleRejected: [] };
  page.on('pageerror', (e) => {
    P.errors.push(String((e && e.message) || e).slice(0, 300));
    (P.errorStacks = P.errorStacks || []).push(String((e && e.stack) || '').slice(0, 1200));
  });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') P.consoleErrors.push(t.slice(0, 200));
    if (/\[net\]|lockstep|desync|relay|stall|delay|audio|underrun|fault|error/i.test(t) && P.log.length < 3000) P.log.push(((Date.now() - T0) / 1000).toFixed(1) + ' ' + t.slice(0, 300));
  });
  const cdp = await page.createCDPSession();
  P.cdp = cdp;
  if (device.kind === 'mobile') {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 915, height: 412, deviceScaleFactor: 2, mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: ANDROID_UA, platform: 'Linux armv81',
      userAgentMetadata: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Google Chrome', version: '140' }],
        fullVersion: '140.0.0.0', platform: 'Android', platformVersion: '14.0.0', architecture: '', model: 'Pixel 7', mobile: true },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await page.setViewport({ width: 1280, height: 800 });
  }
  // THE CPU THROTTLE MUST REACH THE WORKERS. Measured first, applied second, so
  // the arm-difference proof is a before/after on the same page.
  if (device.cpu) {
    const busy = () => page.evaluate(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 3e6; i++) x += Math.sqrt(i); return performance.now() - t + (x < 0 ? 1 : 0); }).catch(() => null);
    await page.goto('about:blank');
    const before = await busy();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: device.cpu });
    P.throttled.push('page');
    const after = await busy();
    P.throttleProof = { beforeMs: before && +before.toFixed(1), afterMs: after && +after.toFixed(1), ratio: (before && after) ? +(after / before).toFixed(2) : null };
    page.on('workercreated', async (w) => {
      try { await w.client.send('Emulation.setCPUThrottlingRate', { rate: device.cpu }); P.throttled.push('worker:' + w.url().split('/').pop().slice(0, 40)); }
      catch (e) { P.throttleRejected.push(w.url().split('/').pop().slice(0, 40) + ': ' + String(e.message || e).slice(0, 80)); }
    });
  }
  await page.evaluateOnNewDocument(pre.mqtt);
  await page.evaluateOnNewDocument(pre.hooks);
  if (device.workerCpu) workerThrottleStart(P, WORKER_CPU);
  return P;
}
async function closePlayer(P) {
  if (!P) return;
  if (P.cg && P.cg.timer) clearInterval(P.cg.timer);
  try { await P.browser.close(); } catch (e) {}
  await workerThrottleEnd(P);
  if (!KEEP_PROFILES) { try { fs.rmSync(P.dir, { recursive: true, force: true }); } catch (e) {} }
}
// Absorb coi-serviceworker's first-visit reload BEFORE the room opens, so the
// room is not torn down and reopened under the players (tools/device_matrix.mjs
// documents the reload). n64/ ships no service worker and settles immediately.
async function prewarm(P, C) {
  await P.page.goto(BASE + C.page, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    const s = await P.page.evaluate(async () => {
      let regs = -1; try { regs = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) {}
      return { coi: !!self.crossOriginIsolated, regs };
    }).catch(() => null);
    if (s && s.coi) return { coi: true, ms: i * 300 };
    if (s && i >= 8 && s.regs === 0) return { coi: false, ms: i * 300, note: 'no service worker on this page' };
    await sleep(300);
  }
  return { coi: false, timedOut: true };
}

const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const mkCode = () => Array.from({ length: 5 }, () => CODE_ALPHA[Math.floor(Math.random() * CODE_ALPHA.length)]).join('');

function handoffUrl(C, code, role, brokerUrl) {
  const g = encodeURIComponent(C.game);
  const q = `?np=${code}&game=${g}` + (role === 'host' ? C.hostFlag : '&join=1')
          + `&signal=ws&wsbroker=${encodeURIComponent(brokerUrl)}` + EXTRA_Q;
  return BASE + C.page + q;
}

const engineState = (P) => P.page.evaluate(() => {
  const M = window.__npdm; const e = M && M.engine;
  let sess = null;
  try {
    const ss = (window.Netplay && window.Netplay.sessions) || [];
    const s = ss[ss.length - 1];
    if (s) sess = { state: s.state, isHost: !!s.isHost, relay: s.relay ? { active: !!s.relay.active, oneWayMs: s.relay.oneWayMs, delayFrames: s.relay.delayFrames } : null };
  } catch (x) {}
  return { engine: e ? { state: e.state, frame: e.frame, delay: e.delay } : null, sess, ready: M ? M.readyFrames : 0 };
}).catch(() => null);

// ---- one cell ---------------------------------------------------------------------
async function runCell(cid, aid, attempt) {
  const C = CONSOLES[cid]; const A = ARMS[aid];
  const tag = `${cid}-${aid}` + (attempt ? `-r${attempt}` : '');
  const seconds = A.soak ? SOAK : SECONDS;
  const cell = { console: cid, arm: aid, what: A.what, attempt, seconds, query: EXTRA_Q || null, uptimeBefore: uptime(), loads: [], players: {} };
  const fg = freeGB();
  if (fg != null && fg < MIN_FREE_GB + 1.2) { cell.error = `disk: only ${fg.toFixed(2)} GB free`; return cell; }
  await acquireLock(tag);
  let broker = null, fw = null, fronts = null;
  const PS = [];
  const nPlayers = A.players || 2;
  const loadTick = setInterval(() => { const l = load1(); if (l != null) cell.loads.push(l); }, 10000);
  const allState = () => Promise.all(PS.map((P) => engineState(P)));
  const bad = (st) => st.some((x) => x && x.engine && /desync|failed|ended/.test(x.engine.state));
  try {
    cell.uptimeAtLock = uptime();
    // ⚠ THE BROKER RUNS IN ITS OWN PROCESS for any arm that routes the room
    // through it. In-process it shared this rig's event loop, and the rig
    // decodes PNG screenshots synchronously in JS — every capture held every
    // relayed message for the length of a decode, which reads in the room as
    // a 300-400 ms jitter spike that no real broker has. (Measured 2026-10-07:
    // the synthetic relay room with no screenshots, tools/
    // netplay_firewall_room_test.mjs, worst stall 34 ms; the same broker in
    // this process, worst 385 ms.) NPDM_BROKER_INPROC=1 restores the old arm.
    broker = (A.firewall || A.relay) && process.env.NPDM_BROKER_INPROC !== '1'
      ? await startBrokerProc(A.broker || {})
      : await startBroker({ port: 0 });
    if (A.broker) broker.setImpair(A.broker);
    // THE FIREWALL ARMS: TLS fronts at 443 and 8084, kernel rules for the joiner.
    // The hand-off lists the 8084 broker FIRST, so the firewalled side has to
    // find the 443 one by itself.
    let brokerList = broker.url;
    if (A.firewall) {
      fronts = await startBrokerFronts(broker.port);
      fw = startFirewall({ webPort: +(new URL(BASE).port || 80), chrome: CHROME });
      brokerList = fronts.urls.p8084 + ',' + fronts.urls.p443;
      cell.firewall = { brokers: brokerList, resolver: fronts.resolverRule, uid: fw.uid };
    }
    const pre = { mqtt: mqttSource(), hooks: null };
    const cfg = (role) => ({ role, console: cid, witness: C.witness, frames: C.frames, hz: C.hz, seam: C.seam, aux: C.aux || 'null', ui: C.ui || 'null',
                             p2p: A.p2p || null, relay: !!A.relay, ice: !!A.firewall });
    const code = mkCode();
    cell.code = code;
    cell.nPlayers = nPlayers;
    for (let i = 0; i < nPlayers; i++) {
      const role = i === 0 ? 'host' : (i === 1 ? 'joiner' : 'joiner' + i);
      // --no-proxy-server: Chromium otherwise inherits this sandbox's HTTPS_PROXY
      // and tunnels the fake broker hosts to the real egress, which refuses them.
      const fwx = A.firewall ? { args: [`--host-resolver-rules=${fronts.resolverRule}`, '--ignore-certificate-errors', '--no-proxy-server'], fw: i > 0 ? fw : null } : {};
      PS.push(await launchPlayer(role, i === 0 ? A.host : A.join, tag, Object.assign({}, pre, fwx, { hooks: preloadSrc(cfg(role)) })));
    }
    const H = PS[0];
    cell.prewarm = {};
    for (const P of PS) cell.prewarm[P.role] = await prewarm(P, C);
    const tOpen = Date.now();
    await H.page.goto(handoffUrl(C, code, 'host', brokerList), { waitUntil: 'domcontentloaded' });
    // Give the host's relay subscription a head start: a joiner publishing into
    // an empty topic is the "slow host" case, which is not what is measured here.
    for (let i = 0; i < 40; i++) { if (broker.stats.clients >= 1) break; await sleep(250); }
    await sleep(1500);
    // Joiners arrive one after another, each admitted by the host's real Allow.
    let admitted = 0; const admitHow = [];
    const tryAdmit = async () => {
      const btn = await H.page.$('#npApproveAllow').catch(() => null);
      if (!btn) return false;
      try { await H.page.click('#npApproveAllow'); admitHow.push('mouse'); }
      catch (e) { await H.page.evaluate(() => { const b = document.getElementById('npApproveAllow'); if (b) b.click(); }).catch(() => {}); admitHow.push('dom'); }
      admitted++; await sleep(500); return true;
    };
    for (let i = 1; i < PS.length; i++) {
      await PS[i].page.goto(handoffUrl(C, code, 'join', brokerList), { waitUntil: 'domcontentloaded' });
      for (let k = 0; k < 60 && admitted < i; k++) { if (!(await tryAdmit())) await sleep(500); }
    }
    cell.admitAtS = +((Date.now() - tOpen) / 1000).toFixed(1);
    // ---- wait for every engine to run --------------------------------
    const tBootLimit = Date.now() + C.bootMs;
    let running = false; let lastLog = 0;
    while (Date.now() < tBootLimit) {
      if (admitted < PS.length - 1) await tryAdmit();
      const st = await allState();
      const ok = (x) => x && x.engine && (x.engine.state === 'running' || x.engine.state === 'stalled') && x.ready > 30;
      if (st.every(ok)) { running = true; break; }
      if (Date.now() - lastLog > 15000) {
        lastLog = Date.now();
        say(`  [${tag}] waiting · admitted=${admitted}/${PS.length - 1} · ` + PS.map((P, i) => `${P.role}=${JSON.stringify(st[i] && st[i].engine)} ready=${st[i] && st[i].ready}`).join(' · ') + ` · broker=${JSON.stringify(broker.stats)}`);
      }
      if (bad(st)) break;
      await sleep(1000);
    }
    cell.admitted = admitted; cell.admitHow = admitHow.join(',');
    cell.startS = +((Date.now() - tOpen) / 1000).toFixed(1);
    cell.running = running;
    cell.shots = {}; for (const P of PS) cell.shots[P.role] = [];
    if (!running) {
      cell.error = `room never reached running on all ${PS.length} players within ${C.bootMs / 1000}s`;
    } else {
      say(`  [${tag}] all ${PS.length} engines running after ${cell.startS}s — measuring ${seconds}s`);
      // ---- the measured window -------------------------------------------------
      const tM = Date.now();
      const mark = await Promise.all(PS.map((P) => P.page.evaluate(() => ({ ready: window.__npdm.readyFrames, win: window.__npdm.win.length, t: performance.now() - window.__npdm.t0, drop: window.__npdm.audio.dropouts, aq: window.__npdm.audio.quanta, stalls: window.__npdm.stalls.length, resumes: window.__npdm.resumes.length })).catch(() => null)));
      const pressAt = [8, 22, 36, 50].filter((s) => s < seconds - 4);
      // Screenshot times (s into the window). --shots overrides, e.g. for a
      // cell where the capture itself is suspected of perturbing the page.
      const shotAt = SHOTS_AT ? SHOTS_AT.filter((x) => x < seconds) : [5, Math.floor(seconds / 2), seconds - 3];
      let nextPress = 0, nextShot = 0, pi = 0;
      while ((Date.now() - tM) / 1000 < seconds) {
        const el = (Date.now() - tM) / 1000;
        if (nextShot < shotAt.length && el >= shotAt[nextShot]) {
          const i = nextShot++;
          const shots = await Promise.all(PS.map((P) => canvasShot(P.page, path.join(OUT, `${tag}-${P.role}-${i}.png`))));
          PS.forEach((P, k) => cell.shots[P.role].push(Object.assign({ atS: Math.round(el) }, shots[k])));
          if (i === 1) {
            // The whole viewport once, as evidence of what each player actually SAW.
            await Promise.all(PS.map((P) => P.page.screenshot({ type: 'jpeg', quality: 60, path: path.join(OUT, `${tag}-${P.role}-full.jpg`) }).catch(() => {})));
          }
        }
        if (nextPress < pressAt.length && el >= pressAt[nextPress]) {
          nextPress++;
          const P = PS[(pi++) % Math.min(2, PS.length)];
          try {
            await P.page.evaluate(() => window.__npdm.press());
            await P.page.keyboard.down('ArrowLeft'); await sleep(400); await P.page.keyboard.up('ArrowLeft');
          } catch (e) {}
        }
        if (PROFILE_S && !cell.profiled && el >= Math.max(5, seconds / 2 - PROFILE_S / 2)) {
          cell.profiled = true;
          // Main thread AND every dedicated worker (several cores run in one).
          const targets = [];
          for (const P of PS) {
            targets.push({ c: P.cdp, name: `${tag}-${P.role}` });
            P.page.workers().forEach((w, i) => targets.push({ c: w.client, name: `${tag}-${P.role}-w${i}-${w.url().split('/').pop().split('?')[0]}` }));
          }
          await Promise.all(targets.map(async (t) => {
            try { await t.c.send('Profiler.enable'); await t.c.send('Profiler.setSamplingInterval', { interval: 500 }); await t.c.send('Profiler.start'); } catch (e) {}
          }));
          await sleep(PROFILE_S * 1000);
          await Promise.all(targets.map(async (t) => {
            try { const { profile } = await t.c.send('Profiler.stop'); fs.writeFileSync(path.join(OUT, `${t.name}.cpuprofile`), JSON.stringify(profile)); } catch (e) {}
          }));
        }
        // Arm ct with --worker-cpu-until S: the throttled device recovers S s
        // into the measured window (its quota is lifted) — a page that declares
        // rbResume must get zero-lag mode back after the gate's calm.
        if (WORKER_CPU_UNTIL > 0 && !cell.throttleLifted && el >= WORKER_CPU_UNTIL) {
          cell.throttleLifted = { atS: Math.round(el), who: [] };
          for (const P of PS) if (P.cg && P.cg.dir) {
            try { P.cg.statAtLift = workerThrottleStat(P); fs.writeFileSync(path.join(P.cg.dir, 'cpu.cfs_quota_us'), '-1'); cell.throttleLifted.who.push(P.role); }
            catch (e) { cell.throttleLifted.err = String(e.message || e).slice(0, 120); }
          }
          say(`  [${tag}] worker throttle LIFTED at ${Math.round(el)} s on ${cell.throttleLifted.who.join(',') || 'nobody'}`);
        }
        if (MID_EVAL && !cell.midEval && el >= seconds / 2) {
          cell.midEval = { atS: Math.round(el), js: MID_EVAL, res: await Promise.all(PS.map((P) => P.page.evaluate(MID_EVAL).then((r) => String(r)).catch((e) => 'ERR ' + e.message))) };
        }
        if (A.soak && Math.round(el) % 60 === 0) say(`  [${tag}] soak ${Math.round(el)}s · load ${load1()}`);
        const st = await allState();
        if (bad(st)) {
          cell.endedEarly = 'engine state ' + PS.map((P, i) => `${P.role}=${st[i] && st[i].engine && st[i].engine.state}`).join(' ') + ` at ${Math.round(el)}s`;
          break;
        }
        await sleep(1000);
      }
      cell.measuredS = +((Date.now() - tM) / 1000).toFixed(1);
      // ---- collect ---------------------------------------------------------------
      for (let pi2 = 0; pi2 < PS.length; pi2++) {
        const P = PS[pi2], m = mark[pi2];
        const d = await P.page.evaluate((m) => {
          const M = window.__npdm; const e = M.engine;
          let rep = null; try { rep = e ? e.report() : null; } catch (x) {}
          let native = null;
          try {
            native = {
              dcAudio: window.__dcProbe ? window.__dcProbe().audio : undefined,
              n64Audio: window.__audioDbg ? (typeof window.__audioDbg === 'function' ? window.__audioDbg() : window.__audioDbg) : undefined,
              audioDiag: window.AudioDiag && window.__audioDiag ? window.AudioDiag.report() : undefined,
              n64Rate: window.__n64Rate ? { speed: window.__n64Rate.speed, starved: window.__n64Rate.starved, cap: window.__n64Rate.cap } : undefined,
              gcRate: window.__gcRate ? { path: window.__gcRate.path, speed: window.__gcRate.speed, starved: window.__gcRate.starved, capFps: window.__gcRate.capFps } : undefined,
              // WHERE A DELAY ROOM'S TIME WENT, per page: Genesis's dropped tick credit by
              // cause, GameCube's wait attribution (gcLsStep WHERE THE TIME GOES), and the
              // engine's holds.
              genTickLoss: window.__genTickLoss || undefined,
              loaf: M.loaf ? M.loaf.slice() : (M.loafErr || undefined),
              gcLs: typeof window.__gcLockstep === 'function' ? (() => { const g = window.__gcLockstep() || {}; const r = g.rollback || {};
                return { runMs: g.runMs, waitInputMs: g.waitInputMs, waitWorkerMs: g.waitWorkerMs, bfCalls: g.bfCalls, bfStall: g.bfStall, earned: g.earned,
                         cuRefused: (r.page || {}).cuRefused, hidden: (r.page || {}).hidden }; })() : undefined,
              lsStats: e && e.stats ? { cadenceHolds: e.stats.cadenceHolds | 0, resyncHolds: e.stats.resyncHolds | 0, stalls: e.stats.stalls, stallMs: Math.round(e.stats.stallMs || 0) } : undefined,
            };
            native = JSON.parse(JSON.stringify(native));
          } catch (x) { native = { err: String(x) }; }
          let sess = null;
          try {
            const ss = window.Netplay.sessions; const s = ss[ss.length - 1];
            sess = { relay: s.relay ? JSON.parse(JSON.stringify(s.relay)) : null, peerId: s.peerId || null,
                     relayInfo: s.relayInfo ? JSON.parse(JSON.stringify(s.relayInfo())) : null,
                     sig: s._sig ? { kind: s._sig.kind, url: String(s._sig.url || ''), paths: s._sig.paths ? JSON.parse(JSON.stringify(s._sig.paths)) : null } : null,
                     chip: (() => { const n = document.getElementById('npRelay'); return n ? n.textContent : null; })() };
          } catch (x) {}
          return {
            t: performance.now() - M.t0, ready: M.readyFrames - m.ready,
            win: M.win.slice(m.win), stalls: M.stalls.slice(m.stalls), resumes: M.resumes.slice(m.resumes),
            allStalls: M.stalls.length, delays: M.delays.slice(), lat: M.lat.slice(), desyncs: M.desyncs.slice(),
            audio: Object.assign({}, M.audio, { dropoutsInWindow: M.audio.dropouts - m.drop, quantaInWindow: M.audio.quanta - m.aq }),
            p2p: M.p2p, relayForced: M.relayForced, ice: M.ice || null, report: rep ? JSON.parse(JSON.stringify(rep)) : null, native, sess,
            peerId: e ? e.peerId : null, localPorts: e ? e.localPorts : null,
            hz: (() => { try { return eval(M.cfg.hz); } catch (x) { return null; } })(),
            // The page's OWN net seam, whole (minus bulky arrays), as evidence.
            seam: (() => { try { const v = eval(M.cfg.seam); return v == null ? null : JSON.parse(JSON.stringify(v, (k, x) => (Array.isArray(x) && x.length > 64) ? '[' + x.length + ' items]' : x)); } catch (x) { return 'ERR ' + x; } })(),
            winT0: m.t,
          };
        }, m).catch((e) => ({ collectError: String(e.message || e) }));
        d.errors = P.errors.slice(); d.errorStacks = (P.errorStacks || []).slice(0, 4); d.consoleErrors = P.consoleErrors.slice(0, 20); d.consoleErrorCount = P.consoleErrors.length;
        d.throttled = P.throttled; d.throttleRejected = P.throttleRejected; d.throttleProof = P.throttleProof || null;
        if (P.cg) d.workerThrottle = { frac: P.cg.frac, err: P.cg.err || null, threads: (P.cg.threads || []).slice(0, 16), stat: workerThrottleStat(P), statAtLift: P.cg.statAtLift || null };
        d.device = P.device;
        cell.players[P.role] = d;
      }
    }
    // Errors are captured whether or not the room ran.
    for (const P of PS) {
      if (!cell.players[P.role]) cell.players[P.role] = { errors: P.errors.slice(), consoleErrors: P.consoleErrors.slice(0, 20), device: P.device, throttleProof: P.throttleProof || null };
      cell.players[P.role].log = P.log.slice(-80);
    }
    if (!running) {
      cell.failState = {};
      for (const P of PS) {
        cell.shots[P.role] = [await canvasShot(P.page, path.join(OUT, `${tag}-${P.role}-fail.png`))];
        cell.failState[P.role] = await engineState(P);
      }
    }
    if (broker.pid) { await broker.close(); broker.closed = true; }   // out of process: SIGTERM prints the final numbers
    cell.broker = Object.assign({}, broker.stats, { impair: Object.assign({}, broker.impair), outOfProcess: !!broker.pid });
    if (fw) { cell.firewall.counters = fwCounters(); cell.firewall.fronts = Object.assign({}, fronts.stats); }
  } catch (e) {
    cell.error = 'rig error: ' + String(e && e.stack || e).slice(0, 400);
  } finally {
    clearInterval(loadTick);
    for (const P of PS) await closePlayer(P);
    if (broker && !broker.closed) await broker.close().catch(() => {});
    if (fronts) await fronts.close().catch(() => {});
    if (fw) fw.close();
    cell.uptimeAfter = uptime();
    releaseLock();
  }
  return cell;
}

// ---- solo cap of a device (no room) ----------------------------------------------------
// `count` > 1 runs that many INDEPENDENT solo emulators at once, each in its own
// browser — the CONTENTION CONTROL. Two players of a room share this one box,
// so a room can only be blamed for a shortfall that two solo emulators running
// side by side do NOT show.
async function soloBoot(P, C) {
  await prewarm(P, C);
  await P.page.goto(BASE + C.page, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  if (C.boot) {
    for (let i = 0; i < 40; i++) { const ok = await P.page.evaluate(() => !!(window.myClass && window.myClass.isWasmReady)).catch(() => false); if (ok || !/gba/.test(C.page)) break; await sleep(500); }
    return P.page.evaluate(C.boot).catch((e) => ({ bootError: String(e.message || e).slice(0, 200) }));
  }
  return P.page.evaluate((game) => {
    const sels = ['romSelect', 'mobileRomSelect'].map((id) => document.getElementById(id)).filter(Boolean);
    let picked = null;
    for (const s of sels) {
      for (const o of s.options) if (o.value === game || o.textContent.trim() === game) { s.value = o.value; picked = o.value; break; }
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const sp = document.getElementById('mobileSplash');
    const splashUp = !!(sp && getComputedStyle(sp).display !== 'none' && sp.offsetParent !== null);
    const b = splashUp ? document.getElementById('mobileSplashStart') : document.getElementById('btnStart');
    if (!b) return { picked, pressed: null };
    try { b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch (e) {}
    try { b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); } catch (e) {}
    b.click();
    return { picked, pressed: b.id, splashUp, disabled: !!b.disabled, aria: b.getAttribute('aria-disabled') };
  }, C.game);
}
async function soloMeasure(P, C, tag, i) {
  const out = {};
  const tLimit = Date.now() + C.bootMs;
  let live = false;
  while (Date.now() < tLimit) {
    const w = await P.page.evaluate(() => { const W = window.__npdm.win; return W.length ? W[W.length - 1] : null; }).catch(() => null);
    if (w && ((w.witness != null && w.witness > 0.05) || (w.frames != null && w.frames > 120 * (w.hz > 1000 ? 735 : 1)))) { live = true; break; }
    await sleep(2000);
  }
  out.live = live;
  if (live) {
    await sleep(15000);
    const a0 = await P.page.evaluate(() => ({ n: window.__npdm.win.length, a: Object.assign({}, window.__npdm.audio) }));
    await sleep(SOLO_S * 1000);
    out.win = await P.page.evaluate((m0) => window.__npdm.win.slice(m0), a0.n);
    const W0 = out.win[0], W1 = out.win[out.win.length - 1];
    if (W0 && W1) {
      const mins = (W1.t - W0.t) / 60000;
      out.longTasks = { n: W1.lt - W0.lt, ms: W1.ltMs - W0.ltMs, perMin: mins ? +((W1.lt - W0.lt) / mins).toFixed(1) : null,
                        msPerS: mins ? +((W1.ltMs - W0.ltMs) / (mins * 60)).toFixed(1) : null,
                        max: await P.page.evaluate(() => Math.round(window.__npdm.lt.max)).catch(() => null) };
      // Long Animation Frames >= 150 ms in the window, and how much of them was
      // script or rendering (the rest: the thread was not running this page's work).
      out.loaf = await P.page.evaluate((t0, t1) => {
        const L = (window.__npdm.loaf || []).filter((x) => x.t >= t0 && x.t <= t1 && x.ms >= 150);
        const sum = (f) => L.reduce((a, x) => a + f(x), 0);
        return { n: L.length, ms: sum((x) => x.ms), scriptMs: sum((x) => x.sc.reduce((a, y) => a + y.ms, 0)), renderMs: sum((x) => x.render),
                 max: L.reduce((a, x) => Math.max(a, x.ms), 0) };
      }, W0.t, W1.t).catch(() => null);
      if (W0.ca && W1.ca) {
        const s = (W1.t - W0.t) / 1000;
        out.cartAudio = { mode: W1.ca.mode, rxPerS: +((W1.ca.rx - W0.ca.rx) / s).toFixed(1), underruns: W1.ca.u - W0.ca.u,
                          underrunsPerMin: +((W1.ca.u - W0.ca.u) / (s / 60)).toFixed(2), missingFrames: W1.ca.m - W0.ca.m,
                          overflowFrames: W1.ca.o - W0.ca.o, backlogEnd: W1.ca.b };
      }
      if (W0.ad && W1.ad) {
        const s = (W1.t - W0.t) / 1000;
        out.audioDiag = { producedPerS: W1.ad.p != null ? +((W1.ad.p - W0.ad.p) / s).toFixed(1) : null,
                          consumedPerS: W1.ad.c != null && W0.ad.c != null ? +((W1.ad.c - W0.ad.c) / s).toFixed(1) : null,
                          underruns: W1.ad.u != null && W0.ad.u != null ? W1.ad.u - W0.ad.u : null,
                          underrunsPerMin: W1.ad.u != null && W0.ad.u != null ? +((W1.ad.u - W0.ad.u) / (s / 60)).toFixed(2) : null,
                          droppedFrames: W1.ad.df != null ? (W1.ad.df - (W0.ad.df || 0)) : null, fillEnd: W1.ad.fill };
      }
    }
    // THE THROTTLE MUST BE PROVEN ON THE WORKERS, not assumed from a CDP ack:
    // the same busy loop in each live dedicated worker, against the page's
    // UNTHROTTLED before-time. ~4x = throttled; ~1x = the worker escaped.
    // Plus every worker TARGET in the browser (nested workers included), so a
    // worker puppeteer never reported is visible as unthrottled.
    if (P.throttleProof) {
      out.workerProof = [];
      for (const w of P.page.workers()) {
        // ⚠ BOUNDED. An emulator worker that runs its CPU loop without
        // yielding never services Runtime.evaluate, and an unbounded call then
        // waits out protocolTimeout (240 s) PER WORKER — that hung a ps1 solo
        // for 16+ minutes. Unresponsive is itself the answer: no proof.
        const ms = await Promise.race([
          w.evaluate(() => { const t = performance.now(); let x = 0; for (let i = 0; i < 3e6; i++) x += Math.sqrt(i); return performance.now() - t + (x < 0 ? 1 : 0); }).catch(() => null),
          sleep(3000).then(() => 'unresponsive'),
        ]);
        if (ms === 'unresponsive') { out.workerProof.push({ url: w.url().split('/').pop().slice(0, 40), ms: null, note: 'did not answer in 3 s (busy loop never yields)' }); continue; }
        out.workerProof.push({ url: w.url().split('/').pop().slice(0, 40), ms: ms && +ms.toFixed(1), ratioVsUnthrottledPage: (ms && P.throttleProof.beforeMs) ? +(ms / P.throttleProof.beforeMs).toFixed(2) : null });
      }
      out.workerTargets = P.browser.targets().filter((t) => /worker/.test(t.type())).map((t) => t.type() + ':' + t.url().split('/').pop().slice(0, 40));
    }
    out.shot = await canvasShot(P.page, path.join(OUT, `${tag}${i ? '-' + i : ''}.png`));
    // Audio over the SAME window as the rate, not since page load.
    const a1 = await P.page.evaluate(() => Object.assign({}, window.__npdm.audio));
    const mins = a1.sampleRate ? ((a1.quanta - a0.a.quanta) * 128 / a1.sampleRate) / 60 : null;
    out.audio = Object.assign({}, a1, { dropoutsInWindow: a1.dropouts - a0.a.dropouts,
      audibleFracInWindow: (a1.quanta - a0.a.quanta) ? +((a1.audibleQuanta - a0.a.audibleQuanta) / (a1.quanta - a0.a.quanta)).toFixed(3) : null,
      perMin: mins ? +((a1.dropouts - a0.a.dropouts) / mins).toFixed(2) : null });
  }
  out.errors = P.errors.slice(); out.throttleProof = P.throttleProof || null; out.throttled = P.throttled; out.throttleRejected = P.throttleRejected;
  out.rate = soloRate(out);
  const W = out.win || [];
  out.rafMean = W.length ? +(W.reduce((a, w) => a + (w.raf || 0), 0) / W.length).toFixed(1) : null;
  return out;
}
async function runSolo(cid, device, count = 1) {
  const C = CONSOLES[cid];
  const tag = `${cid}-solo-${device.kind}${device.cpu ? device.cpu + 'x' : ''}${count > 1 ? '-x' + count : ''}`;
  const out = { console: cid, device, count, uptimeBefore: uptime(), loads: [] };
  await acquireLock(tag);
  const Ps = [];
  const loadTick = setInterval(() => { const l = load1(); if (l != null) out.loads.push(l); }, 10000);
  try {
    for (let i = 0; i < count; i++) {
      Ps.push(await launchPlayer('solo' + i, device, tag, { mqtt: '/*none*/', hooks: preloadSrc({ role: 'solo', console: cid, witness: C.witness, frames: C.soloFrames || C.frames, hz: C.soloHz || C.hz, seam: C.seam }) }));
    }
    out.start = await Promise.all(Ps.map((P) => soloBoot(P, C)));
    out.each = await Promise.all(Ps.map((P, i) => soloMeasure(P, C, tag, i)));
    // Headline = the first instance (count 1) or the WORST instance (control).
    const rated = out.each.filter((e) => e.rate);
    const worst = rated.sort((a, b) => a.rate.x - b.rate.x)[0] || out.each[0];
    Object.assign(out, { live: out.each.every((e) => e.live), win: worst.win, shot: worst.shot, audio: worst.audio,
                         errors: out.each.flatMap((e) => e.errors), throttleProof: worst.throttleProof,
                         throttled: worst.throttled, throttleRejected: worst.throttleRejected, rafMean: worst.rafMean,
                         longTasks: worst.longTasks, loaf: worst.loaf, audioDiag: worst.audioDiag, cartAudio: worst.cartAudio, workerProof: worst.workerProof, workerTargets: worst.workerTargets });
  } catch (e) {
    out.error = 'rig error: ' + String(e && e.stack || e).slice(0, 300);
  } finally {
    clearInterval(loadTick);
    for (const P of Ps) await closePlayer(P);
    out.uptimeAfter = uptime();
    releaseLock();
  }
  out.rate = soloRate(out);
  return out;
}
function soloRate(s) {
  if (!s.win || s.win.length < 5) return null;
  const W = s.win;
  const wit = W.map((w) => w.witness).filter((x) => typeof x === 'number' && isFinite(x));
  if (wit.length >= 5) return { src: 'page witness', x: +(wit.reduce((a, b) => a + b, 0) / wit.length).toFixed(4) };
  const f0 = W[0].frames, f1 = W[W.length - 1].frames, dt = (W[W.length - 1].t - W[0].t) / 1000, hz = W[W.length - 1].hz;
  if (f0 != null && f1 != null && dt > 0 && hz) return { src: 'page frame counter', x: +(((f1 - f0) / dt) / hz).toFixed(4) };
  return null;
}

// ---- verdicts -----------------------------------------------------------------------
function analysePlayer(d, peerRole) {
  const r = { };
  if (!d || !d.win) return null;
  // ⚠ A CONSOLE WHOSE FRAME RATE CHANGES MID-RUN is judged per second at THAT
  // second's own rate, and the one second in which the rate changed is left
  // out (its frames ran at two rates; neither is right for all of them). PS1
  // Monster Rancher 2 boots at 59.94 Hz and its GPU switches to 50 Hz video
  // ~4-6 s in (wasmpsx_worker.js "THE VBLANK RATE FOLLOWS THE GPU"): judged at
  // the final 50 Hz, the boot's 60 frames/s read as a 1.19x "fast-forward".
  const W0 = d.win.filter((w) => w.ready != null);
  const hz = d.hz || (W0.length && W0[W0.length - 1].hz) || 60;
  const W = W0.filter((w, i) => !(i > 0 && W0[i - 1].hz && w.hz && W0[i - 1].hz !== w.hz))
    .map((w) => Object.assign({}, w, { x: w.ready / (+w.hz || +hz) }));
  r.hzSwitchWindowsDropped = W0.length - W.length;
  const secs = W.length;
  r.hz = +(+hz).toFixed(3);
  r.engineX = secs ? +(W.reduce((a, w) => a + w.x, 0) / secs).toFixed(4) : null;
  let maxWin5 = 0;
  for (let i = 0; i + 5 <= W.length; i++) { const s = W.slice(i, i + 5).reduce((a, w) => a + w.x, 0) / 5; if (s > maxWin5) maxWin5 = s; }
  r.maxWin5 = +maxWin5.toFixed(4);
  let minWin5 = Infinity;
  for (let i = 0; i + 5 <= W.length; i++) { const s = W.slice(i, i + 5).reduce((a, w) => a + w.x, 0) / 5; if (s < minWin5) minWin5 = s; }
  r.minWin5 = minWin5 === Infinity ? null : +minWin5.toFixed(4);
  const wit = W.map((w) => w.witness).filter((x) => typeof x === 'number' && isFinite(x));
  r.witnessX = wit.length ? +(wit.reduce((a, b) => a + b, 0) / wit.length).toFixed(4) : null;
  r.witnessMax = wit.length ? +Math.max(...wit).toFixed(4) : null;
  let wm = null;
  for (let i = 0; i + 5 <= wit.length; i++) { const v = wit.slice(i, i + 5).reduce((x, y) => x + y, 0) / 5; if (wm == null || v > wm) wm = v; }
  r.witnessMaxWin5 = wm == null ? null : +wm.toFixed(4);
  const fr = W.map((w) => w.frames).filter((x) => typeof x === 'number');
  r.frameCounterX = fr.length >= 2 ? +(((fr[fr.length - 1] - fr[0]) / Math.max(1, W.length - 1)) / hz).toFixed(4) : null;
  r.stalls = d.stalls ? d.stalls.length : null;
  r.stallMs = d.resumes ? d.resumes.reduce((a, x) => a + x.ms, 0) : null;
  const who = {};
  for (const s of d.stalls || []) for (const p of (s.waitingPeers && s.waitingPeers.length ? s.waitingPeers : ['port ' + (s.waitingOn || []).join(',')])) {
    const k = p === d.peerId ? 'self' : (peerRole[p] || p); who[k] = (who[k] || 0) + 1;
  }
  r.waitedOn = who;
  r.delayChanges = (d.delays || []).map((x) => `${x.from}->${x.to}@f${x.at}`);
  r.delayNow = d.report ? d.report.delay : null;
  r.latFrames = (d.lat || []).map((x) => x.frames);
  // THE CAPACITY GATE'S MODE OVER TIME (a gated room: rollback <-> delay), as
  // runs of consecutive seconds, each with the engine rate it delivered — so
  // "the gate moved the room to delay and back to rollback, at 1.000x in
  // both" is read off one line, not reconstructed from the per-second rows.
  r.capModes = [];
  for (const w of W) {
    const m = w.cap && w.cap.mode ? w.cap.mode : '-';
    const last = r.capModes[r.capModes.length - 1];
    if (last && last.mode === m) { last.s++; last.xs += w.x; } else r.capModes.push({ mode: m, s: 1, xs: w.x });
  }
  for (const c of r.capModes) { c.x = +(c.xs / c.s).toFixed(4); delete c.xs; }
  r.latByMode = { rollback: (d.lat || []).filter((x) => x.rollback).map((x) => x.frames), delay: (d.lat || []).filter((x) => !x.rollback).map((x) => x.frames) };
  r.desync = !!(d.report && d.report.desync) || (d.desyncs || []).length > 0 || (d.report && d.report.state === 'desync');
  r.hashesCompared = d.report ? d.report.hashesCompared : null;
  const a = d.audio || {};
  const mins = (a.quantaInWindow && a.sampleRate) ? (a.quantaInWindow * 128 / a.sampleRate) / 60 : null;
  r.audio = { taps: a.taps, audibleFrac: a.quanta ? +(a.audibleQuanta / a.quanta).toFixed(3) : null,
              dropouts: a.dropoutsInWindow, perMin: mins ? +(a.dropoutsInWindow / mins).toFixed(2) : null,
              renderedMin: mins ? +mins.toFixed(2) : null, err: a.err || null, firstAudibleAt: a.firstAudibleAt };
  r.errors = (d.errors || []).length;
  r.consoleErrors = d.consoleErrorCount || 0;
  r.relay = d.sess && d.sess.relay ? !!d.sess.relay.active : false;
  if (d.sess && d.sess.relayInfo) {
    const ri = d.sess.relayInfo;
    r.relayInfo = { oneWayMs: ri.oneWayMs != null ? Math.round(ri.oneWayMs) : null, delayFrames: ri.delayFrames, rate: ri.rate, why: ri.why, brokers: ri.brokers,
                    gapSeq: ri.stats && ri.stats.gapSeq, dropAuth: ri.stats && ri.stats.dropAuth, adopted: ri.stats && ri.stats.adopted, sinceMs: ri.sinceMs };
  }
  if (d.sess) { r.sig = d.sess.sig ? d.sess.sig.url : null; r.chip = d.sess.chip; }
  const rb = d.report && d.report.rollback;
  if (rb) r.rb = { window: rb.window, windowPeak: rb.windowPeak, rollbacks: rb.rollbacks, resimFrames: rb.resimFrames, maxDepth: rb.maxDepth, meanDepth: rb.meanDepth, rttFrames: rb.rttFrames, windowStalls: rb.windowStalls };
  if (d.ice) r.ice = { cands: d.ice.cands, states: (d.ice.states || []).slice(0, 12) };
  return r;
}
function verdict(cell, solo, soloAudio) {
  const why = [];
  if (cell.error) return { pass: false, why: [cell.error] };
  const roles = Object.keys(cell.players);
  const peerRoles = {};
  for (const r of roles) if (cell.players[r] && cell.players[r].peerId) peerRoles[cell.players[r].peerId] = r;
  cell.analysis = {};
  for (const r of roles) cell.analysis[r] = analysePlayer(cell.players[r], peerRoles);
  for (const name of roles) {
    const a = cell.analysis[name], d = cell.players[name];
    if (!a) { why.push(name + ': nothing collected'); continue; }
    const byW = CONSOLES[cell.console] && CONSOLES[cell.console].rateBy === 'witness';
    const x = byW ? a.witnessX : (a.witnessX != null ? Math.min(a.witnessX, a.engineX) : a.engineX);
    if (!(x >= RATE_FLOOR)) why.push(`${name} rate ${x}x < ${RATE_FLOOR}`);
    if (!byW && a.maxWin5 > RATE_CEIL_WIN) why.push(`${name} FAST-FORWARD: a 5-s window ran at ${a.maxWin5}x`);
    if (a.witnessMaxWin5 != null && a.witnessMaxWin5 > RATE_CEIL_WIN) why.push(`${name} FAST-FORWARD by the page's own witness: a 5-s window at ${a.witnessMaxWin5}x`);
    if (a.desync) why.push(`${name} DESYNC`);
    if (!(a.hashesCompared > 0)) why.push(`${name} compared 0 fingerprints`);
    if (a.errors) why.push(`${name} ${a.errors} page error(s): ${(d.errors || [])[0]}`);
    const shots = (cell.shots && cell.shots[name]) || [];
    const lastTwo = shots.slice(-2);
    if (!lastTwo.some((s) => s.showing)) why.push(`${name} canvas BLANK (${lastTwo.map((s) => s.litFrac != null ? s.litFrac + '/' + s.colours + 'c' : s.why).join(', ')})`);
    const excess = (a.audio.dropouts || 0) - (a.stalls || 0);
    const perMinExcess = a.audio.renderedMin ? excess / a.audio.renderedMin : 0;
    // The allowance is the console's OWN solo desktop rate when measured: a
    // room must not make audio worse than the same game alone (x1.25 for
    // scene-to-scene variation), and never less than the flat floor.
    const soloPm = soloAudio && soloAudio.perMin != null ? soloAudio.perMin : null;
    // When the box itself cannot run two of these side by side (pair control below
    // the floor), a starved producer is the box's too: the pair control's own
    // dropout rate is then the reference instead.
    const pairA = cell.pairSolo && cell.pairSolo.rate && cell.pairSolo.rate.x < RATE_FLOOR && cell.pairSolo.audio ? cell.pairSolo.audio.perMin : null;
    // A THROTTLED player is judged against the same game solo ON THAT DEVICE.
    const dev = ARMS[cell.arm] && ARMS[cell.arm][name === 'host' ? 'host' : 'join'];  // every joiner shares the arm's joiner device
    const mobA = dev && dev.kind === 'mobile' && solo && solo.audio ? solo.audio.perMin : null;
    const allow = Math.max(AUDIO_DROPOUTS_PER_MIN, soloPm != null ? soloPm * 1.25 : 0, pairA != null ? pairA * 1.25 : 0, mobA != null ? mobA * 1.25 : 0);
    a.audio.mobileSoloPerMin = mobA;
    a.audio.pairPerMin = pairA;
    a.audio.allowPerMin = +allow.toFixed(2); a.audio.soloPerMin = soloPm;
    if (perMinExcess > allow) why.push(`${name} audio ${a.audio.dropouts} dropouts (${a.audio.perMin}/min; ${perMinExcess.toFixed(1)}/min beyond stalls; allowed ${allow.toFixed(1)}${soloPm != null ? ' = solo ' + soloPm + ' x1.25' : ''})`);
  }
  if (cell.endedEarly) why.push('ended early: ' + cell.endedEarly);
  // ⚠ THE FIREWALL ARM MUST PROVE IT WAS A FIREWALL. If no UDP datagram was
  // dropped, no TCP connection refused, or nothing went out on 443, the joiner
  // was not behind what the arm says — and a room that "worked" proves nothing.
  if (ARMS[cell.arm] && ARMS[cell.arm].firewall) {
    const c = (cell.firewall && cell.firewall.counters) || {};
    const pk = (k) => (c[k] ? c[k].pkts : 0);
    const proof = { udpDropped: pk('udp'), tcpRefused: pk('tcp-other'), tcp443: pk('tcp443'), front443: cell.firewall && cell.firewall.fronts ? cell.firewall.fronts.p443 : 0,
                    front8084: cell.firewall && cell.firewall.fronts ? cell.firewall.fronts.p8084 : 0 };
    if (cell.firewall) cell.firewall.proof = proof;
    if (!(proof.udpDropped > 0)) why.push('firewall arm-proof: no UDP was dropped — WebRTC was never blocked');
    if (!(proof.tcpRefused > 0)) why.push('firewall arm-proof: no TCP connection was refused — the 8084 broker was never refused');
    if (!(proof.tcp443 > 0 && proof.front443 > 0)) why.push('firewall arm-proof: nothing reached the broker on 443');
    for (const name of roles) { const a = cell.analysis[name]; if (a && !a.relay) why.push(`${name} is NOT on the relay — a direct path opened through the firewall?`); }
  }
  // Device-limited: a throttled player that cannot do 1.000x SOLO.
  let limited = null;
  for (const [name, dev] of [['host', ARMS[cell.arm].host], ['joiner', ARMS[cell.arm].join]]) {
    if (dev.kind !== 'mobile' || !solo) continue;
    const a = cell.analysis && cell.analysis[name];
    const x = a ? (a.witnessX != null ? a.witnessX : a.engineX) : null;
    if (solo.rate && solo.rate.x < RATE_FLOOR && x != null && x >= 0.9 * solo.rate.x) {
      limited = `${name} device SOLO cap ${solo.rate.x}x (${solo.rate.src}) — below ${RATE_FLOOR} with no room at all; the room delivered ${x}x (>= 90% of it)`;
    }
  }
  // BOX-LIMITED: both players of a room share this one machine, so the room is
  // compared with TWO SOLO INSTANCES RUN SIDE BY SIDE (the `pair` control). If
  // that control itself cannot reach the floor, and the room delivers at least
  // 90% of it, the shortfall belongs to the machine, not to netplay — and only
  // a rate failure is excused by that; everything else still fails.
  let boxLimited = null;
  const pair = cell.pairSolo;   // the N-instance control matching this cell's player count
  if (pair && pair.rate && pair.rate.x < RATE_FLOOR && cell.analysis) {
    const xs = Object.keys(cell.analysis).map((k) => { const a = cell.analysis[k]; return a ? (a.witnessX != null ? a.witnessX : a.engineX) : null; });
    if (xs.every((x) => x != null && x >= 0.9 * pair.rate.x)) {
      boxLimited = `${pair.count || 2} SOLO instances side by side on this box reach only ${pair.rate.x}x; the room delivered ${xs.join('/')}x (>= 90% of that)`;
    }
  }
  const nonRate = why.filter((w) => !/ rate [\d.]+x < /.test(w));
  return { pass: why.length === 0, deviceLimited: limited, boxLimited, nonRateFailures: nonRate, why };
}

// ---- main -----------------------------------------------------------------------------
function buildTable(RESULT) {
  const rows = RESULT.cells.filter((c, i, a) => !a.slice(i + 1).some((d) => d.console === c.console && d.arm === c.arm));
  const lines = ['| console | arm | verdict | host x (engine/witness) | joiner x | stalls h/j | delay h/j | lat frames h/j | canvas h/j | audio drop/min h/j | desync | errors | load |',
                 '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const c of rows) {
    const a = c.analysis || {}; const h = a.host || {}; const j = a.joiner || {};
    const cv = (k) => ((c.shots && c.shots[k]) || []).slice(-2).some((s) => s.showing) ? 'ok' : 'BLANK';
    const v = c.void ? 'VOID' : (c.verdict.pass ? 'PASS' : ((c.verdict.nonRateFailures || []).length === 0 && (c.verdict.boxLimited || c.verdict.deviceLimited) ? (c.verdict.boxLimited ? 'BOX-LIMITED' : 'DEVICE-LIMITED') : 'FAIL'));
    lines.push(`| ${c.console} | ${c.arm} | ${v} | ${h.engineX ?? '-'}/${h.witnessX ?? '-'} | ${j.engineX ?? '-'}/${j.witnessX ?? '-'} | ${h.stalls ?? '-'}/${j.stalls ?? '-'} | ${h.delayNow ?? '-'}/${j.delayNow ?? '-'} | ${JSON.stringify(h.latFrames || [])}/${JSON.stringify(j.latFrames || [])} | ${c.error ? '-' : cv('host') + '/' + cv('joiner')} | ${h.audio ? h.audio.perMin : '-'}/${j.audio ? j.audio.perMin : '-'} | ${(h.desync || j.desync) ? 'YES' : 'no'} | ${(h.errors || 0) + (j.errors || 0)} | ${c.maxLoad} |`);
  }
  for (const [cid, s] of Object.entries(RESULT.solo)) lines.push(`| ${cid} | SOLO | ${s.rate ? s.rate.x + 'x (' + s.rate.src + ')' : 'no rate'} | canvas ${s.shot ? (s.shot.showing ? 'ok' : 'BLACK') : '-'} | throttle proof ${s.throttleProof ? s.throttleProof.ratio + 'x' : '-'} |`);
  return { rows, table: lines.join('\n') };
}
const cellLabel = (c) => c.void ? 'VOID' : (c.verdict.pass ? 'PASS' : ((c.verdict.nonRateFailures || []).length === 0 && (c.verdict.boxLimited || c.verdict.deviceLimited) ? (c.verdict.boxLimited ? 'BOX-LIMITED' : 'DEVICE-LIMITED') : 'FAIL'));

// --rejudge a.json,b.json: recompute every verdict from saved cells with the
// CURRENT thresholds and --baseline solos, and print one combined table. The
// newest cell per console x arm wins (files in the order given).
if (flag('rejudge', '')) {
  const R = { solo: {}, cells: [] };
  for (const f of flag('rejudge', '').split(',')) {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    Object.assign(R.solo, r.solo || {});
    for (const c of r.cells || []) { c.from = f; R.cells.push(c); }
  }
  for (const c of R.cells) {
    const cid = c.console;
    const ctl = { 2: 'pair', 3: 'trio', 4: 'quad' }[(ARMS[c.arm] && ARMS[c.arm].players) || 2];
    c.pairSolo = R.solo[cid + ':' + ctl] || (ctl === 'pair' ? BASELINE_PAIR[cid] : BASELINE_N[cid + ':' + ctl]) || null;
    c.verdict = verdict(c, R.solo[cid + ':mobile'] || BASELINE_MOBILE[cid], (BASELINE[cid] || R.solo[cid + ':desktop'] || {}).audio);
  }
  const { rows, table } = buildTable(R);
  console.log(table);
  for (const c of rows) console.log(`${c.console}/${c.arm} [${cellLabel(c)}] ${c.verdict.why.join(' · ')}${c.verdict.boxLimited ? ' [box: ' + c.verdict.boxLimited + ']' : ''}${c.verdict.deviceLimited ? ' [device: ' + c.verdict.deviceLimited + ']' : ''} (${c.from})`);
  const out = flag('rejudge-out', '');
  if (out) fs.writeFileSync(out, JSON.stringify({ table, cells: rows.map((c) => ({ console: c.console, arm: c.arm, label: cellLabel(c), why: c.verdict.why, analysis: c.analysis, from: c.from })) }, null, 1));
  process.exit(0);
}

(async () => {
  say(`=== netplay device matrix · consoles=${consoles.join(',')} arms=${arms.join(',')} seconds=${SECONDS} ===`);
  say(`uptime: ${uptime()} · free ${freeGB() && freeGB().toFixed(2)} GB · out ${OUT}`);
  const RESULT = { when: new Date().toISOString(), base: BASE, seconds: SECONDS, thresholds: { RATE_FLOOR, RATE_CEIL_WIN, AUDIO_DROPOUTS_PER_MIN, VOID_LOAD },
                   limits: ['mobile = desktop Chromium + UA/touch/viewport + CPU throttle; not a phone GPU, not WebKit',
                            'both players share one 4-core box with other agents; SwiftShader rendering',
                            'arm d network impairment is an in-page FIFO shim on RTCDataChannel.send; CDP network emulation does not reach WebRTC'],
                   solo: {}, cells: [] };
  const save = () => fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(RESULT, null, 1));
  for (const cid of consoles) {
    for (const dk of SOLO_DEVS) {
      const dev = dk === 'mobile' ? MOBILE : DESKTOP;
      say(`--- ${cid} SOLO cap, ${dk}${dev.cpu ? ' ' + dev.cpu + 'x' : ''} ---`);
      const s = await runSolo(cid, dev, { pair: 2, trio: 3, quad: 4 }[dk] || 1);
      RESULT.solo[cid + ':' + dk] = s; save();
      say(`  solo ${cid}/${dk}: live=${s.live} rate=${JSON.stringify(s.rate)} throttleProof=${JSON.stringify(s.throttleProof)} canvas=${s.shot && (s.shot.showing ? 'ok' : 'BLACK')} audio=${s.audio ? s.audio.dropouts + ' drop/' + s.audio.quanta + 'q' : '-'} raf=${s.rafMean} perMin=${s.audio && s.audio.perMin} longTasks=${JSON.stringify(s.longTasks)} loaf=${JSON.stringify(s.loaf)} audioDiag=${JSON.stringify(s.audioDiag)} cartAudio=${JSON.stringify(s.cartAudio)} workers=${JSON.stringify(s.workerProof)} targets=${JSON.stringify(s.workerTargets)}${s.each && s.each.length > 1 ? ' each=' + s.each.map((e) => e.rate && e.rate.x).join('/') : ''} loads=${s.loads.join(',')} ${s.start ? JSON.stringify(s.start) : ''} ${s.error || ''}`);
    }
    for (const aid of ((SOLO_ONLY || CONSOLES[cid].soloOnly) ? [] : arms)) {
      let cell = null;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        say(`--- ${cid} × ${aid} (${ARMS[aid].what})${attempt ? ' retry ' + attempt : ''} ---`);
        cell = await runCell(cid, aid, attempt);
        const maxLoad = cell.loads.length ? Math.max(...cell.loads) : load1();
        cell.maxLoad = maxLoad;
        cell.void = maxLoad != null && maxLoad > VOID_LOAD;
        const ctl = { 2: 'pair', 3: 'trio', 4: 'quad' }[ARMS[aid].players || 2];
        cell.pairSolo = RESULT.solo[cid + ':' + ctl] || (ctl === 'pair' ? BASELINE_PAIR[cid] : BASELINE_N[cid + ':' + ctl]) || null;
        cell.verdict = verdict(cell, RESULT.solo[cid + ':mobile'] || BASELINE_MOBILE[cid], (RESULT.solo[cid + ':desktop'] || BASELINE[cid] || {}).audio);
        RESULT.cells.push(cell); save();
        const v = cell.verdict;
        say(`  => ${cell.void ? 'VOID (load ' + maxLoad + ')' : (v.pass ? 'PASS' : ((v.nonRateFailures || v.why).length === 0 && (v.boxLimited || v.deviceLimited) ? (v.boxLimited ? 'BOX-LIMITED' : 'DEVICE-LIMITED') : 'FAIL'))} ${v.deviceLimited ? '[device: ' + v.deviceLimited + '] ' : ''}${v.boxLimited ? '[box: ' + v.boxLimited + '] ' : ''}${v.why.join(' · ')}`);
        if (cell.analysis) for (const k of Object.keys(cell.analysis)) {
          const a = cell.analysis[k]; if (!a) continue;
          say(`     ${k.padEnd(6)} engine ${a.engineX}x (5s ${a.minWin5}..${a.maxWin5}) witness ${a.witnessX} fc ${a.frameCounterX} · stalls ${a.stalls}/${a.stallMs}ms on ${JSON.stringify(a.waitedOn)} · delay ${a.delayNow} [${a.delayChanges.join(' ')}] · lat ${JSON.stringify(a.latFrames)} · modes ${(a.capModes || []).map((c) => c.mode + ' ' + c.s + 's@' + c.x + 'x').join(' -> ') || '-'} · audio ${JSON.stringify(a.audio)} · hashes ${a.hashesCompared} · relay ${a.relay} · err ${a.errors}/${a.consoleErrors}`);
          if (a.relayInfo || a.rb || a.ice) say(`     ${k.padEnd(6)} relay ${JSON.stringify(a.relayInfo || null)} · rb ${JSON.stringify(a.rb || null)} · ice ${JSON.stringify(a.ice || null)} · sig ${a.sig || '-'} · chip ${JSON.stringify(a.chip || null)}`);
          const shots = (cell.shots && cell.shots[k]) || [];
          say(`     ${k.padEnd(6)} canvas ${shots.map((s) => (s.showing ? 'OK' : 'BLANK') + '(' + s.litFrac + '/' + s.colours + ')').join(' ')}`);
        }
        if (cell.firewall) say(`     firewall ${JSON.stringify(cell.firewall.proof || null)} · brokers ${cell.firewall.brokers} · broker ${JSON.stringify(cell.broker || null)}`);
        if (!cell.void) break;
      }
    }
  }
  const { rows, table: _t } = buildTable(RESULT);
  RESULT.table = _t;

  save();
  fs.writeFileSync(path.join(OUT, 'table.md'), RESULT.table + '\n');
  say('\n' + RESULT.table);
  say(`full JSON: ${path.join(OUT, 'matrix.json')}`);
  const fails = rows.filter((c) => !c.void && !c.verdict.pass && !((c.verdict.nonRateFailures || []).length === 0 && (c.verdict.boxLimited || c.verdict.deviceLimited))).length;
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); releaseLock(); process.exit(3); });

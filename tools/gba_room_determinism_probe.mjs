#!/usr/bin/env node
// tools/gba_room_determinism_probe.mjs - stage G2 of the mGBA build: do N linked GBA cores in ONE wasm instance evolve IDENTICALLY on
// machines that differ in time zone, DST position and wall-clock reading? (The deterministic-lockstep directive: every peer runs its own
// cores, only input bytes cross the wire - so any host-dependent byte in the guest is a desync.)
//
//   node tools/gba_room_determinism_probe.mjs                          # the full matrix: 100,000 frames, 18 child processes + 1 timing reference
//   node tools/gba_room_determinism_probe.mjs --frames 20000          # shorter soak (controls scale with --control-frames)
//   node tools/gba_room_determinism_probe.mjs --only soul              # groups: soul | sbam | controls (default: all)
//   node tools/gba_room_determinism_probe.mjs --jobs 4 --json out.json
//   node tools/gba_room_determinism_probe.mjs --browser               # + the same room in headless Chrome under CDP Emulation.setTimezoneOverride (PORT=8092 devserver, CDP port 9251); --only browser = just that
//   node tools/gba_room_determinism_probe.mjs --mgba-dir <copy of gba/mgba>     # run against ANOTHER artifact (negative controls on builds)
//   node tools/gba_room_determinism_probe.mjs --child '<spec json>'    # run ONE child by hand (prints a JSON result); what the parent spawns
//
// Exit code is non-zero on any failed check or any negative control that is NOT caught.
//
// WHAT IT RUNS. Each CHILD is a separate Node process (own wasm instance, own heap) started with a different TZ environment variable
// and a different Date.now() (the child replaces global Date BEFORE the wasm exists, so the wasm's time()/localtime imports see it). The
// child plays a 2-seat room with a fixed, seeded key stream and samples, every --sample frames (default 60): the FULL 0x61000-byte
// savestate hash of each seat (CPU, VRAM/OAM/palette, IO, RAM, audio, timers, DMA, the cartridge GPIO/RTC block, the event queue), the
// link-layer hash, and - every single frame - a digest of each seat's video frame and audio buffer. Those fold into per-seat hash
// CHAINS. Two children agree only if every sample agrees. The parent compares the chains.
//
//   soul     Pokemon SoulGold v1.1.1 (md5 b2c5caf9..., BPEE, the only RTC cartridge we ship; GPIO RTC at ROM 0x080000C4-C8), RTC PINNED
//            (setRtc: epoch + fixed UTC offset), 5 children across 5 zones/dates, 100,000 frames, two seats with DIFFERENT key streams.
//   sbam     Super Bust-A-Move, 2 seats LINKED (the lockstep coordinator carries real MULTI rounds), after the 4,800-frame scripted walk
//            into the 2P battle, 100,000 frames of random input, 3 children across 3 zones/dates. No RTC on the cartridge: this soak is
//            about the link layer and the core, and shows that nothing else in the module reads the host.
//   controls NEGATIVE CONTROLS. The probe is only worth anything if it can fail:
//              (1) the UNPINNED path (setRtc(null), host clock + host zone) must DIVERGE across zones and across Date bases - and an
//                  unpinned twin with the same zone and clock must NOT (so the divergence is caused by the host, not by flakiness);
//              (2) a ONE-BIT key mutant on one child (a single frame, a single button, a single seat) must be caught by the chains,
//                  both when the flip lands on a sampled frame and when it lands between samples (it then has to PROPAGATE to be seen);
//              (3) a pin that differs by one hour of epoch, or by one hour of UTC offset, must give a different chain (the chain really
//                  contains the clock the game was handed, so identical chains across zones are not vacuous);
//              (4) import tripwires: the five host-time imports of the wasm (__localtime_js, __mktime_js, __tzset_js, __gmtime_js and
//                  _emscripten_date_now) are wrapped with counters in every tripwire child. Pinned runs must reach neither the local-time
//                  nor the mktime import at all; unpinned runs must (positive control for the tripwire itself). A child without
//                  tripwires must give the same chain as one with them (the tripwire does not perturb the run).
//
// EVERY RTC claim is backed by a read count from the bridge's RTC latch witness (core.rtcWitness): how many times the GAME latched the
// cartridge clock, the first/last unix time it was handed, the BCD calendar it last latched (decoded and checked against an independent
// computation from the pin), and a digest of every value handed out.
//
// STALL WATCHDOG. The bridge's link watchdog (GBASIOLockstepCoordinatorRecover after ~60 frozen frames) and every other incident are
// reported per child (incidents / loop stalls / MULTI rounds without an ack / step caps / watchdog fires / non-zero runFrame statuses)
// and any non-zero value fails the soak it appears in.
//
// WHAT THIS DOES NOT PROVE (also printed at the end): determinism across different CPUs, OSes or browsers (every child ran on THIS machine
// and THIS Node/V8); anything about real wall-clock pacing (runFrame() is stepped as fast as the host allows - it measures the module, not
// the product, and 1.000x is the caller's clock, G6); the Chrome/WebKit engines (the glue is the same, the host-time imports go through
// the same JS Date, but no browser ran here).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SBAM_SCRIPT } from './gba_link_smoke.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const MGBA = path.resolve(opt('--mgba-dir', process.env.GBA_MGBA_DIR || path.join(ROOT, 'gba/mgba')));
const ROMS = path.join(ROOT, 'gba/gbaWasm/roms');
const SOUL = 'Pokemon SoulGold (v1.1.1).gba', SBAM = 'Super Bust-A-Move (U).gba';
const SOUL_MD5 = 'b2c5caf9bc6dd28a44052427ee3ab1b7';   // the pinned SoulGold v1.1.1 (CLAUDE.md / plan: SoulGold is pinned to v1.1.1)
const FNV_P = 0x01000193, FNV_0 = 0x811C9DC5;
const W = 240, H = 160, VWORDS = W * H;

// The pin every pinned child is given. -300 min = UTC-5, deliberately NOT 0 and NOT the zone of any child, so a game that was handed the
// host's zone (UTC, Tokyo +9, LA -8/-7, Kiritimati +14, Kolkata +5:30) instead of the pin's would show a different hour.
const PIN = { fixedEpochMs: 1700000000000, tzOffsetMin: -300 };    // 2023-11-14T22:13:20Z  ->  17:13:20 at UTC-5
const SAMPLE = Number(opt('--sample', 60));

// ---------------------------------------------------------------------------------------------------------------------------------
// Shared pieces (child and parent)
const fnvWord = (h, x) => { h = Math.imul(h ^ (x & 255), FNV_P); h = Math.imul(h ^ ((x >>> 8) & 255), FNV_P); h = Math.imul(h ^ ((x >>> 16) & 255), FNV_P); h = Math.imul(h ^ ((x >>> 24) & 255), FNV_P); return h >>> 0; };
const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
const xorshift = (seed) => { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; };
const KEYS = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };

// Compile a key script (gba_link_smoke.mjs steps) to per-frame masks, with the same semantics as runScript() there.
export function compileScript(steps, seats) {
  const out = [[], []], keys = new Array(seats).fill(0);
  const maskOf = (names) => String(names).split('+').reduce((m, n) => m | (n === 'NONE' ? 0 : KEYS[n.toUpperCase()]), 0);
  const sel = (t) => (t === 'all' ? [...Array(seats).keys()] : Array.isArray(t) ? t : [t]);
  const step = (n) => { for (let i = 0; i < n; i++) for (let s = 0; s < seats; s++) out[s].push(keys[s]); };
  for (const st of steps) {
    const c = st[0];
    if (c === 'wait') step(st[1]);
    else if (c === 'tap') { const hold = st[3] === undefined ? 6 : st[3], gap = st[4] === undefined ? 12 : st[4]; for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(hold); for (const s of sel(st[1])) keys[s] = 0; step(gap); }
    else if (c === 'hold') { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(st[3]); for (const s of sel(st[1])) keys[s] = 0; }
    else if (c === 'mash') { for (let i = 0; i < st[3]; i++) { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(3); for (const s of sel(st[1])) keys[s] = 0; step(5); } }
    // 'shot' / 'mark' take no frames
  }
  return out;
}

// The key streams. index 0 is the key mask for frame 1. Both seats get their own stream.
export function keyStreams(game, frames) {
  const k = [new Uint16Array(frames), new Uint16Array(frames)];
  if (game === 'soulgold') {
    // Phase 1 (frames 1..INTRO): a deterministic A mash that walks the new-game intro (Birch's speech, naming) into the bedroom; seat 1's pattern is
    // offset so the two games are NOT clones. Phase 2: a seeded WALKER per seat - hold a direction for 16-63 frames (65%), tap A (15%), tap B (10%),
    // tap START (3%), or release for a moment (7%) - so the player roams, talks and opens/closes menus. (A first version pressed sparse random masks every
    // 12 frames and START often; both seats ended up parked in the START menu where the game ignores input, so a key flip changed nothing. That
    // was measured with a twin that zeroed seat 1's keys from frame 7,490: no divergence through frame 10,000.)
    const INTRO = 4200, DIRS = [KEYS.UP, KEYS.DOWN, KEYS.LEFT, KEYS.RIGHT];
    const walker = (seed) => {
      const r = xorshift(seed); let left = 0, mask = 0;
      return () => {
        if (left <= 0) {
          const q = r() % 100;
          if (q < 65) { mask = DIRS[r() & 3]; left = 16 + (r() % 48); }
          else if (q < 80) { mask = KEYS.A; left = 4; }
          else if (q < 90) { mask = KEYS.B; left = 4; }
          else if (q < 93) { mask = KEYS.START; left = 3; }
          else { mask = 0; left = 8 + (r() % 24); }
        }
        left--; return mask;
      };
    };
    const w0 = walker(0x50C0FFEE), w1 = walker(0x50DEC0DE);
    for (let f = 1; f <= frames; f++) {
      if (f <= INTRO) { k[0][f - 1] = (f % 16) < 3 ? KEYS.A : 0; k[1][f - 1] = ((f + 5) % 16) < 3 ? KEYS.A : 0; }
      else { k[0][f - 1] = w0(); k[1][f - 1] = w1(); }
    }
    return { k, lead: 0 };
  }
  // sbam: the scripted walk into the 2P battle, then `frames` frames of random input (the same generator as the G1 core test's soak)
  const walk = compileScript(SBAM_SCRIPT, 2), lead = walk[0].length;
  const total = lead + frames;
  k[0] = new Uint16Array(total); k[1] = new Uint16Array(total);
  const r = xorshift(0xC0FFEE);
  const cur = [0, 0];
  for (let f = 1; f <= total; f++) {
    if (f <= lead) { k[0][f - 1] = walk[0][f - 1]; k[1][f - 1] = walk[1][f - 1]; continue; }
    const sf = f - lead;
    if (sf % 12 === 0) { cur[0] = (r() & r()) & 0x3FF; cur[1] = (r() & r()) & 0x3FF; }
    k[0][f - 1] = cur[0]; k[1][f - 1] = cur[1];
  }
  return { k, lead };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// CHILD: one process, one wasm instance, one room. Prints GBA_DET_RESULT <json> on stdout.
async function childMain(spec) {
  const RealDate = Date, t0 = RealDate.now();
  const mockNow = () => (spec.dateMode === 'frozen' ? spec.dateBase : spec.dateBase + (RealDate.now() - t0));
  if (spec.dateBase !== null && spec.dateBase !== undefined) {
    // Replace global Date BEFORE the wasm exists: its _emscripten_date_now import is `Date.now()` and tzset uses `new Date()`.
    // Calls WITH arguments (what localtime/mktime use to convert a given instant) stay real, so the host ZONE (TZ env) still applies to them.
    globalThis.Date = class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) super(mockNow()); else super(...a); }
      static now() { return mockNow(); }
    };
  }
  const MgbaCore = require(path.join(MGBA, 'mgba_core.js'));
  const glue = require(path.join(MGBA, 'dist/mgba_core.js'));
  const tw = { localtime: 0, mktime: 0, tzset: 0, gmtime: 0, dateNow: 0, found: [] };
  const NAME = { __localtime_js: 'localtime', __mktime_js: 'mktime', __tzset_js: 'tzset', __gmtime_js: 'gmtime', _emscripten_date_now: 'dateNow' };
  let factory;
  if (spec.tripwire) {
    const wasmBytes = fs.readFileSync(path.join(MGBA, 'dist/mgba_core.wasm'));
    factory = (a) => glue({
      ...a,
      instantiateWasm(imports, done) {
        for (const [k, fn] of Object.entries(imports.a)) {
          const key = NAME[fn && fn.name];
          if (!key) continue;
          tw.found.push(fn.name);
          imports.a[k] = function (...args) { tw[key]++; return fn.apply(this, args); };
        }
        WebAssembly.instantiate(wasmBytes, imports).then((r) => done(r.instance));
        return {};
      }
    });
  }
  const res = {
    id: spec.id, spec, pid: process.pid, node: process.version,
    host: {
      TZ: process.env.TZ === undefined ? null : process.env.TZ, resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetJanMin: new RealDate(2024, 0, 1).getTimezoneOffset(), offsetJulMin: new RealDate(2024, 6, 1).getTimezoneOffset(),
      dateNowAtStart: Date.now(), dateMode: spec.dateMode || 'real',
      localTimeOfPinEpoch: new RealDate(PIN.fixedEpochMs).toString().slice(16, 33)
    }
  };
  const romBytes = fs.readFileSync(path.join(ROMS, spec.game === 'soulgold' ? SOUL : SBAM));
  res.romMd5 = crypto.createHash('md5').update(romBytes).digest('hex');
  const core = await MgbaCore.create({ seats: 2, factory });
  if (spec.rtc === 'pinned') core.setRtc({ fixedEpochMs: spec.pin.fixedEpochMs, tzOffsetMin: spec.pin.tzOffsetMin }); else core.setRtc(null);
  res.info = core.loadRom(romBytes);
  res.hostTimeAfterLoad = { ...tw, found: undefined };
  const { k, lead } = keyStreams(spec.game, spec.frames);
  const total = k[0].length;
  res.totalFrames = total; res.walkFrames = lead;
  const K = spec.sample || SAMPLE;
  const vu = [new Uint32Array(core.video(0).buffer, core.video(0).byteOffset, VWORDS), new Uint32Array(core.video(1).buffer, core.video(1).byteOffset, VWORDS)];
  const frameChain = [FNV_0, FNV_0], stateChain = [FNV_0, FNV_0];
  const prevPic = [-1, -1], picChanges = [0, 0], screens = [new Set(), new Set()];     // liveness: is the game actually playing, or parked on a still screen?
  let linkChain = FNV_0, statusFrames = 0, firstStatus = null;
  const entries = [], rtcSeries = [];
  const mut = spec.mutant || null;
  let mutApplied = null;
  let tRun = 0;
  const tLoop = performance.now();
  for (let f = 1; f <= total; f++) {
    for (let s = 0; s < 2; s++) {
      let m = k[s][f - 1];
      if (mut && mut.seat === s && f === mut.frame) { mutApplied = { frame: f, seat: s, bit: mut.bit, was: (m >> mut.bit) & 1 }; m ^= (1 << mut.bit); }
      core.setKeys(s, m);
    }
    const tr = performance.now();
    const st = core.runFrame();
    tRun += performance.now() - tr;
    if (st) { statusFrames++; if (!firstStatus) firstStatus = { frame: f, status: st }; }
    for (let s = 0; s < 2; s++) {
      let h = FNV_0, hv;
      const v = vu[s];
      for (let i = 0; i < VWORDS; i++) h = Math.imul(h ^ v[i], FNV_P);
      hv = h >>> 0;                                     // the picture alone: the liveness counters below use it
      const a = core.audio(s), as = a.samples;
      for (let i = 0; i < as.length; i++) h = Math.imul(h ^ (as[i] & 0xFFFF), FNV_P);
      h = Math.imul(h ^ a.frames, FNV_P);
      frameChain[s] = fnvWord(frameChain[s], h >>> 0);
      if (hv !== prevPic[s]) { picChanges[s]++; prevPic[s] = hv; }
      screens[s].add(hv);
    }
    if (f % K === 0 || f === total) {
      const h0 = core.hash(0), h1 = core.hash(1), hl = core.hashLink();
      stateChain[0] = fnvWord(stateChain[0], h0); stateChain[1] = fnvWord(stateChain[1], h1); linkChain = fnvWord(linkChain, hl);
      entries.push([f, h0, h1, hl, frameChain[0], frameChain[1]]);
    }
    if (f % 5000 === 0 || f === total) { const a = core.rtcWitness(0), b = core.rtcWitness(1); rtcSeries.push({ f, latches: [a.latches, b.latches], last: [a.lastUnix, b.lastUnix] }); }
    if (spec.progress && f % spec.progress === 0) process.stderr.write(`[${spec.id}] frame ${f}/${total}\n`);
  }
  const loopSec = (performance.now() - tLoop) / 1000;
  res.timing = { loopSec, runFrameSec: tRun / 1000, framesPerSecLoop: total / loopSec, framesPerSecEmulation: total / (tRun / 1000), seatFramesPerSecEmulation: (2 * total) / (tRun / 1000) };
  res.entries = entries;
  res.liveness = { pictureChangedFrames: picChanges.slice(), distinctPictures: [screens[0].size, screens[1].size] };
  res.chains = { seat0State: hex(stateChain[0]), seat1State: hex(stateChain[1]), link: hex(linkChain), seat0Frames: hex(frameChain[0]), seat1Frames: hex(frameChain[1]) };
  res.finalHash = { seat0: hex(core.hash(0)), seat1: hex(core.hash(1)), link: hex(core.hashLink()), all: hex(core.hashAll()) };
  res.mutation = mutApplied;
  const w = core.witnesses();
  res.incidents = { total: w.incidents, loopStalls: w.stallDetail.loopStalls, multiNoData: w.stallDetail.multiNoData, stepCaps: w.stallDetail.stepCaps, recoverCount: w.recoverCount, statusFrames, firstStatus, list: core.incidents().slice(0, 5) };
  res.link = { attached: w.attached, multiRounds: w.multiRounds, transfers: w.transfers, serialIrqs: w.serialIrqs, linked: w.linked };
  res.rtc = [core.rtcWitness(0), core.rtcWitness(1)];
  res.rtcSeries = rtcSeries;
  res.hostTime = { ...tw, found: tw.found.slice() };
  res.hostTimeDuringLoop = { localtime: tw.localtime - res.hostTimeAfterLoad.localtime, mktime: tw.mktime - res.hostTimeAfterLoad.mktime, tzset: tw.tzset - res.hostTimeAfterLoad.tzset, gmtime: tw.gmtime - res.hostTimeAfterLoad.gmtime, dateNow: tw.dateNow - res.hostTimeAfterLoad.dateNow };
  res.memory = core.memory();
  core.close();
  process.stdout.write('\nGBA_DET_RESULT ' + JSON.stringify(res) + '\n');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// PARENT
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, caught, detail = '') => { if (caught) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const section = (s) => console.log(`\n== ${s}`);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha = (f) => md5(fs.readFileSync(f));

function cpuSnapshot() { return os.cpus().map((c) => ({ ...c.times })); }
function cpuBusy(a, b) { let busy = 0, tot = 0; for (let i = 0; i < a.length; i++) { const d = {}; let t = 0; for (const k of Object.keys(a[i])) { d[k] = b[i][k] - a[i][k]; t += d[k]; } busy += t - d.idle; tot += t; } return tot ? (100 * busy) / tot : 0; }
function loadSampler(everyMs = 4000) {
  let prev = cpuSnapshot(); const samples = [];
  const id = setInterval(() => { const cur = cpuSnapshot(); samples.push(cpuBusy(prev, cur)); prev = cur; }, everyMs);
  return { stop() { clearInterval(id); const s = samples.length ? samples : [0]; return { meanPct: s.reduce((a, b) => a + b, 0) / s.length, maxPct: Math.max(...s), samples: samples.length }; } };
}
async function idleBaseline(ms = 3000) { const a = cpuSnapshot(); await new Promise((r) => setTimeout(r, ms)); return cpuBusy(a, cpuSnapshot()); }

function runChild(spec) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (spec.tz === null || spec.tz === undefined) delete env.TZ; else env.TZ = spec.tz;
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(spec), '--mgba-dir', MGBA], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      const i = out.lastIndexOf('GBA_DET_RESULT ');
      let res = null;
      if (i >= 0) { try { res = JSON.parse(out.slice(i + 15)); } catch (e) { err += `\nresult parse: ${e.message}`; } }
      resolve({ id: spec.id, code, res, stderrTail: err.slice(-1500), spec });
    });
  });
}
async function runPool(specs, jobs, label) {
  const results = new Map(); let next = 0, running = 0;
  await new Promise((done) => {
    const pump = () => {
      while (running < jobs && next < specs.length) {
        const spec = specs[next++]; running++;
        const t = performance.now();
        console.log(`       start ${spec.id.padEnd(12)} ${spec.game} ${spec.rtc} TZ=${spec.tz} frames=${spec.frames}${spec.mutant ? ' mutant=' + JSON.stringify(spec.mutant) : ''}`);
        runChild(spec).then((r) => { results.set(spec.id, r); running--; console.log(`       done  ${spec.id.padEnd(12)} exit ${r.code} in ${((performance.now() - t) / 1000).toFixed(0)} s${r.res ? '' : '  NO RESULT: ' + r.stderrTail.split('\n').slice(-3).join(' | ')}`); if (next >= specs.length && running === 0) done(); else pump(); });
      }
    };
    if (!specs.length) done(); else pump();
  });
  return results;
}

const firstDiv = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) for (let j = 0; j < a[i].length; j++) if (a[i][j] !== b[i][j]) return { index: i, frame: a[i][0], field: ['frame', 'seat0', 'seat1', 'link', 'seat0Frames', 'seat1Frames'][j] }; return null; };
const sameChains = (a, b) => JSON.stringify(a.chains) === JSON.stringify(b.chains) && a.entries.length === b.entries.length && !firstDiv(a.entries, b.entries);
const prefix = (r, n) => r.entries.filter((e) => e[0] <= n);
const fmtDiv = (d) => (d ? `first divergence at frame ${d.frame} (${d.field})` : 'no divergence');

// What the guest's calendar must read for a given unix second under a pin (independent of the emulator: plain UTC arithmetic).
function expectCalendar(unix, tzMin) { const d = new Date((unix + tzMin * 60) * 1000); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }; }
const sameCal = (a, b) => ['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second'].every((k) => a[k] === b[k]);

function matrix(frames, cframes, tripwireOn) {
  const B0 = Date.UTC(2024, 5, 15, 12, 0, 0);
  const base = { frames, sample: SAMPLE, tripwire: tripwireOn, rtc: 'pinned', pin: PIN, mutant: null, progress: 0 };
  const S = (o) => ({ ...base, ...o });
  const specs = [];
  // ---- SoulGold, pinned, 5 hostile hosts. Different zones (incl. a half-hour and a +14 one), different dates (incl. 2000, 2038 and 10 s before a US DST change),
  // clock modes 'drifting' (base + real elapsed: the host clock keeps moving during the run) and 'frozen'.
  specs.push(S({ id: 'soul-P1', game: 'soulgold', tz: 'UTC', dateBase: Date.UTC(2000, 0, 1), dateMode: 'drifting' }));
  specs.push(S({ id: 'soul-P2', game: 'soulgold', tz: 'Asia/Tokyo', dateBase: Date.UTC(2100, 0, 1), dateMode: 'frozen' }));
  specs.push(S({ id: 'soul-P3', game: 'soulgold', tz: 'America/Los_Angeles', dateBase: Date.UTC(2026, 2, 8, 9, 59, 50), dateMode: 'drifting' }));
  specs.push(S({ id: 'soul-P4', game: 'soulgold', tz: 'Pacific/Kiritimati', dateBase: Date.UTC(1999, 11, 31, 23, 59, 59), dateMode: 'drifting' }));
  specs.push(S({ id: 'soul-P5', game: 'soulgold', tz: 'Asia/Kolkata', dateBase: Date.UTC(2038, 0, 19, 3, 14, 0), dateMode: 'drifting', tripwire: false }));
  // ---- SBAM, linked, pinned (the pin is applied to every seat of every room whatever the cartridge), 3 hostile hosts
  specs.push(S({ id: 'sbam-S1', game: 'sbam', tz: 'UTC', dateBase: Date.UTC(2000, 0, 1), dateMode: 'drifting' }));
  specs.push(S({ id: 'sbam-S2', game: 'sbam', tz: 'Asia/Tokyo', dateBase: Date.UTC(2100, 0, 1), dateMode: 'frozen' }));
  specs.push(S({ id: 'sbam-S3', game: 'sbam', tz: 'America/Los_Angeles', dateBase: Date.UTC(2026, 2, 8, 9, 59, 50), dateMode: 'drifting' }));
  // ---- controls: SoulGold UNPINNED on a frozen host clock (so an unpinned twin is exactly reproducible), then the mutants and pin variants
  const U = (o) => S({ game: 'soulgold', frames: cframes, rtc: 'unpinned', dateMode: 'frozen', ...o });
  specs.push(U({ id: 'soul-U1', tz: 'UTC', dateBase: B0 }));
  specs.push(U({ id: 'soul-U2', tz: 'UTC', dateBase: B0 }));                        // twin of U1: must be IDENTICAL
  specs.push(U({ id: 'soul-U3', tz: 'Asia/Tokyo', dateBase: B0 }));                  // zone only
  specs.push(U({ id: 'soul-U4', tz: 'UTC', dateBase: B0 + 5000 }));                  // clock only: 5 seconds
  const M = (o) => S({ game: 'soulgold', frames: cframes, tz: 'UTC', dateBase: Date.UTC(2000, 0, 1), dateMode: 'drifting', ...o });
  specs.push(M({ id: 'soul-M1', mutant: { frame: 7501, seat: 1, bit: 6 } }));          // one frame, one button (UP), one seat, between samples
  specs.push(M({ id: 'soul-M2', mutant: { frame: 7500, seat: 1, bit: 6 } }));          // the same flip on a SAMPLED frame (7500 = 125 * 60)
  specs.push(M({ id: 'soul-V1', pin: { ...PIN, fixedEpochMs: PIN.fixedEpochMs + 3600000 } }));   // pin differs by one hour of epoch
  specs.push(M({ id: 'soul-V2', pin: { ...PIN, tzOffsetMin: PIN.tzOffsetMin + 60 } }));          // pin differs by one hour of zone
  // the same kind of flip LATE in the full-length run: is the soak still playing - and still sensitive to one bit of one seat's input - 2,000 frames before its end?
  specs.push(S({ id: 'soul-M3', game: 'soulgold', frames, tz: 'UTC', dateBase: Date.UTC(2000, 0, 1), dateMode: 'drifting', mutant: { frame: Math.max(frames - 1999, 7501), seat: 1, bit: 6 } }));
  specs.push(S({ id: 'sbam-M4', game: 'sbam', frames: cframes, tz: 'UTC', dateBase: Date.UTC(2000, 0, 1), dateMode: 'drifting', mutant: { frame: 0 /* set below */, seat: 1, bit: 5 } }));
  return specs;
}

const BROWSER_CASES = [
  { id: 'chrome-pinned-UTC', tz: 'UTC', rtc: 'pinned', base: Date.UTC(2000, 0, 1), mode: 'drifting' },
  { id: 'chrome-pinned-Tokyo', tz: 'Asia/Tokyo', rtc: 'pinned', base: Date.UTC(2100, 0, 1), mode: 'frozen' },
  { id: 'chrome-pinned-LA', tz: 'America/Los_Angeles', rtc: 'pinned', base: Date.UTC(2026, 2, 8, 9, 59, 50), mode: 'drifting' },
  { id: 'chrome-unpinned-UTC', tz: 'UTC', rtc: 'unpinned', base: Date.UTC(2024, 5, 15, 12, 0, 0), mode: 'frozen' },
  { id: 'chrome-unpinned-Tokyo', tz: 'Asia/Tokyo', rtc: 'unpinned', base: Date.UTC(2024, 5, 15, 12, 0, 0), mode: 'frozen' },
];

async function browserLeg(frames) {
  // Headless Chrome only (tools/headless_cdp.mjs: throwaway profile, machine-wide lock, registered with browser_leak_guard), never the user's browser.
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  const PORT = 8092;
  const server = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true });
  const out = {};
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`)).ok; } catch (_e) { await new Promise((r) => setTimeout(r, 250)); } }
    ok('devserver (PORT=8092) is serving gba/mgba/dist', up);
    const { k } = keyStreams('soulgold', frames);
    const K0 = Array.from(k[0]), K1 = Array.from(k[1]);
    await withBrowser({ port: 9251, width: 480, height: 320 }, async (page) => {
      for (const c of BROWSER_CASES) {
        await page.send('Emulation.setTimezoneOverride', { timezoneId: c.tz });
        await page.navigate(`http://localhost:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`);
        out[c.id] = await page.eval(`(async () => {
          const RealDate = Date, t0 = RealDate.now(), base = ${c.base}, frozen = ${c.mode === 'frozen'};
          const now = () => (frozen ? base : base + (RealDate.now() - t0));
          globalThis.Date = class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(now()); else super(...a); } static now() { return now(); } };
          const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed ' + src)); document.head.appendChild(s); });
          await load('/gba/mgba/dist/mgba_core.js'); await load('/gba/mgba/mgba_core.js');
          const rom = new Uint8Array(await (await fetch('/gba/gbaWasm/roms/Pokemon%20SoulGold%20(v1.1.1).gba')).arrayBuffer());
          const core = await MgbaCore.create({ seats: 2 });
          ${c.rtc === 'pinned' ? `core.setRtc({ fixedEpochMs: ${PIN.fixedEpochMs}, tzOffsetMin: ${PIN.tzOffsetMin} });` : 'core.setRtc(null);'}
          core.loadRom(rom);
          const K0 = ${JSON.stringify(K0)}, K1 = ${JSON.stringify(K1)}, entries = [];
          for (let f = 1; f <= K0.length; f++) { core.setKeys(0, K0[f - 1]); core.setKeys(1, K1[f - 1]); core.runFrame(); if (f % ${SAMPLE} === 0) entries.push([f, core.hash(0), core.hash(1), core.hashLink()]); }
          const w = core.rtcWitness(0);
          return { entries, crossOriginIsolated: self.crossOriginIsolated, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, jan: new RealDate(2024, 0, 1).getTimezoneOffset(), latches: w.latches, lastUnix: w.lastUnix, calendar: w.calendar, digest: w.digest, ua: navigator.userAgent };
        })()`);
      }
    });
  } finally { try { server.kill(); } catch (_e) {} }
  return out;
}

async function browserSection(bframes) {
  section(`browser: the same SoulGold room in headless Chrome (CDP Emulation.setTimezoneOverride), ${bframes} frames, vs a Node child`);
  const nodeRef = (await runPool([{ ...matrix(bframes, bframes, true)[0], id: 'node-ref', frames: bframes }], 1, 'node-ref')).get('node-ref');
  let out = null;
  try { out = await browserLeg(bframes); } catch (e) { ok('the browser leg ran', false, String(e && e.message || e)); return; }
  const ids = BROWSER_CASES.map((c) => c.id), rs = ids.map((i) => out[i]);
  if (!nodeRef.res || rs.some((r) => !r)) { ok('browser and node-reference results exist', false); return; }
  const ref = nodeRef.res;
  console.log(`       engine: ${rs[0].ua}`);
  ok('ARM DIFFERENCE: Chrome really ran in three different zones (the override took effect inside the page)', new Set(rs.slice(0, 3).map((r) => r.jan)).size === 3 && rs.every((r, i) => r.zone === BROWSER_CASES[i].tz), rs.map((r) => `${r.zone}(${r.jan})`).join(' '));
  ok('the page was NOT cross-origin isolated (the module needs no SharedArrayBuffer)', rs.every((r) => r.crossOriginIsolated === false), `crossOriginIsolated=${rs[0].crossOriginIsolated}`);
  const key = (e) => e.slice(0, 4).join(':');
  const refE = ref.entries.map((e) => [e[0], e[1], e[2], e[3]].join(':'));
  const same = (r) => r.entries.length === refE.length && r.entries.every((e, i) => key(e) === refE[i]);
  ok('PINNED, Chrome in UTC / Asia/Tokyo / America/Los_Angeles: identical state chains in all three zones AND identical to the Node child (seat 0, seat 1, link layer at every sample)', rs.slice(0, 3).every(same), `${refE.length} samples, last ${refE[refE.length - 1]}`);
  ok("RTC exercised in Chrome (the game latched the clock), handed the SAME clock sequence as Node (latches, last unix time, digest), and the calendar it saw is the pinned zone's wall clock", rs.slice(0, 3).every((r) => r.latches >= 3 && r.latches === ref.rtc[0].latches && r.lastUnix === ref.rtc[0].lastUnix && r.digest === ref.rtc[0].digest && sameCal(r.calendar, expectCalendar(r.lastUnix, PIN.tzOffsetMin))), `latches ${rs.slice(0, 3).map((r) => r.latches).join('/')} (node ${ref.rtc[0].latches}); calendar ${JSON.stringify(rs[0].calendar)}`);
  control('UNPINNED in Chrome, zone UTC vs Asia/Tokyo with the same host clock: chains DIVERGE (the browser path is as host-dependent as Node when nothing is pinned)', rs[3].entries.some((e, i) => key(e) !== key(rs[4].entries[i])), `calendar the guest saw: UTC ${rs[3].calendar.hour}:${rs[3].calendar.minute} vs Tokyo ${rs[4].calendar.hour}:${rs[4].calendar.minute}`);
  control('UNPINNED Chrome differs from PINNED Chrome (the pin changes what the guest sees)', rs[3].entries.some((e, i) => key(e) !== key(rs[0].entries[i])));
}

async function main() {
  const frames = Number(opt('--frames', 100000)), cframes = Math.min(frames, Number(opt('--control-frames', 30000)));
  const jobs = Number(opt('--jobs', 6)), only = opt('--only', '').split(',').filter(Boolean);
  const want = (g) => !only.length || only.includes(g);
  const jsonOut = opt('--json', null);
  const wasmPath = path.join(MGBA, 'dist/mgba_core.wasm'), jsPath = path.join(MGBA, 'dist/mgba_core.js');
  const before = { wasm: sha(wasmPath), js: sha(jsPath) };
  const bi = JSON.parse(fs.readFileSync(path.join(MGBA, 'dist/mgba_core.buildinfo.json'), 'utf8'));
  console.log(`gba_room_determinism_probe: ${path.relative(ROOT, MGBA) || '.'}  wasm md5 ${before.wasm}  js md5 ${before.js}`);
  console.log(`  buildinfo md5 wasm ${bi.md5['mgba_core.wasm']}  patches: ${bi.source.patches.length}   node ${process.version}   frames ${frames} (controls ${cframes})  sample every ${SAMPLE}  jobs ${jobs}`);
  console.log(`  host: ${os.cpus().length} logical CPUs ${os.cpus()[0].model.trim()}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB total / ${(os.freemem() / 2 ** 30).toFixed(1)} GiB free; default zone of this shell: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  ok('SoulGold ROM is the pinned v1.1.1 (md5 b2c5caf9...)', md5(fs.readFileSync(path.join(ROMS, SOUL))) === SOUL_MD5);
  const idle = await idleBaseline();
  console.log(`  machine CPU busy before the run (3 s, os.cpus deltas; Windows has no load average): ${idle.toFixed(1)}%`);

  const all = matrix(frames, cframes, true);
  const walk = compileScript(SBAM_SCRIPT, 2)[0].length;
  all.find((s) => s.id === 'sbam-M4').mutant.frame = walk + 3;     // soak frame 3, the point the G1 soak found to diverge
  const groups = { soul: all.filter((s) => /^soul-P/.test(s.id)), sbam: all.filter((s) => /^sbam-S/.test(s.id)), controls: all.filter((s) => /^(soul-[UMV]|sbam-M)/.test(s.id)) };
  const todo = []; for (const g of Object.keys(groups)) if (want(g)) todo.push(...groups[g]);
  if (want('controls')) for (const id of ['soul-P1', 'sbam-S1']) if (!todo.some((s) => s.id === id)) todo.push(all.find((s) => s.id === id));   // the controls compare against these baselines
  // longest first
  todo.sort((a, b) => b.frames - a.frames);

  // ---- an unloaded timing child, alone on the box, so the frames/s of the parallel soak has a reference
  let alone = null;
  if (!flag('--no-timing')) {
    section('timing reference: ONE child alone (SoulGold, 2 seats, pinned, 10,000 frames)');
    const samp = loadSampler(2000);
    const r = await runPool([{ ...matrix(10000, 10000, true)[0], id: 'timing-alone', frames: 10000 }], 1, 'timing');
    const ld = samp.stop();
    alone = r.get('timing-alone');
    if (alone.res) { const t = alone.res.timing; console.log(`       ${t.framesPerSecEmulation.toFixed(0)} frames/s in runFrame() (${t.seatFramesPerSecEmulation.toFixed(0)} seat-frames/s), ${t.framesPerSecLoop.toFixed(0)} frames/s including the per-frame digests and samples; box CPU busy ${ld.meanPct.toFixed(1)}% mean / ${ld.maxPct.toFixed(1)}% max during it (includes this child)`); }
    ok('the timing reference child ran', !!alone.res);
  }

  if (todo.length) section(`running ${todo.length} children, ${jobs} at a time (box CPU busy is sampled throughout)`);
  const samp = loadSampler();
  const tAll = performance.now();
  const R = await runPool(todo, jobs, 'matrix');
  const load = samp.stop();
  const wall = (performance.now() - tAll) / 1000;
  console.log(`       ${todo.length} children in ${wall.toFixed(0)} s wall; box CPU busy ${load.meanPct.toFixed(1)}% mean / ${load.maxPct.toFixed(1)}% max over ${load.samples} samples (baseline before: ${idle.toFixed(1)}%)`);
  const res = (id) => (R.get(id) && R.get(id).res) || null;
  const got = (ids) => ids.every((i) => res(i));
  const names = (ids) => ids.join(', ');

  // ---- per-child incident + timing table (EVERY soak reports its watchdog counters)
  if (todo.length) section('every child: timing and the stall-watchdog / incident counters');
  if (todo.length) console.log('       id          game      TZ                    rtc       frames  emu fr/s  loop fr/s  incidents loopStall noAck stepCap RECOVER(watchdog) statusFrames  latches(s0/s1)  hostTime(local/mk/tzset/gm/now)');
  for (const spec of todo) {
    const r = res(spec.id);
    if (!r) { console.log(`       ${spec.id.padEnd(11)} NO RESULT (exit ${R.get(spec.id).code}) ${R.get(spec.id).stderrTail.split('\n').slice(-2).join(' | ')}`); continue; }
    const t = r.timing, i = r.incidents, h = r.hostTime;
    console.log(`       ${spec.id.padEnd(11)} ${spec.game.padEnd(9)} ${String(spec.tz).padEnd(21)} ${spec.rtc.padEnd(9)} ${String(r.totalFrames).padStart(6)}  ${t.framesPerSecEmulation.toFixed(0).padStart(7)}  ${t.framesPerSecLoop.toFixed(0).padStart(8)}  ${String(i.total).padStart(9)} ${String(i.loopStalls).padStart(9)} ${String(i.multiNoData).padStart(5)} ${String(i.stepCaps).padStart(7)} ${String(i.recoverCount).padStart(17)} ${String(i.statusFrames).padStart(12)}  ${String(r.rtc[0].latches).padStart(6)}/${String(r.rtc[1].latches).padEnd(6)}  ${h.localtime}/${h.mktime}/${h.tzset}/${h.gmtime}/${h.dateNow}`);
  }
  const reported = todo.map((s) => res(s.id)).filter(Boolean);
  if (todo.length) ok('every child finished and returned a result', reported.length === todo.length, `${reported.length}/${todo.length}`);
  if (todo.length) ok('watchdog incident counter: zero incidents, zero loop stalls, zero un-acked MULTI rounds, zero step caps, ZERO watchdog recovers, zero non-clean runFrame statuses in EVERY child', reported.every((r) => r.incidents.total === 0 && r.incidents.loopStalls === 0 && r.incidents.multiNoData === 0 && r.incidents.stepCaps === 0 && r.incidents.recoverCount === 0 && r.incidents.statusFrames === 0), `${reported.length} children`);

  // ---- SoulGold, pinned, across hosts
  if (want('soul')) {
    const ids = groups.soul.map((s) => s.id);
    section(`soul: SoulGold, 2 seats, RTC pinned (epoch ${PIN.fixedEpochMs}, UTC${PIN.tzOffsetMin >= 0 ? '+' : ''}${PIN.tzOffsetMin / 60}), ${frames} frames, ${ids.length} hosts`);
    if (got(ids)) {
      const rs = ids.map(res);
      const zones = rs.map((r) => `${r.host.TZ}(${r.host.offsetJanMin}/${r.host.offsetJulMin})`);
      console.log(`       hosts: ${zones.join('  ')}`);
      console.log(`       host clocks at start: ${rs.map((r) => new Date(r.host.dateNowAtStart).toISOString().slice(0, 19)).join('  ')}`);
      ok('ARM DIFFERENCE: the five children really ran in five different host zones (distinct Jan offsets) and on five different clocks', new Set(rs.map((r) => r.host.offsetJanMin)).size === 5 && new Set(rs.map((r) => r.host.dateNowAtStart)).size === 5, `Jan offsets (min): ${rs.map((r) => r.host.offsetJanMin).join(' ')}`);
      ok('ARM DIFFERENCE: what the HOST would have shown for the pin epoch differs per child (so a host-zone leak would be visible)', new Set(rs.map((r) => r.host.localTimeOfPinEpoch)).size >= 4, rs.map((r) => r.host.localTimeOfPinEpoch.slice(0, 8)).join(' '));
      ok('every child is the pinned SoulGold v1.1.1 ROM', rs.every((r) => r.romMd5 === SOUL_MD5));
      const ref = rs[0];
      const same = rs.map((r) => sameChains(ref, r));
      ok(`PER-SEAT CHAINS IDENTICAL across all ${ids.length} hosts: seat 0 and seat 1 full-state hash chains, link chain, per-frame video+audio chains, all ${ref.entries.length} sample points`, same.every(Boolean), `seat0 ${ref.chains.seat0State}  seat1 ${ref.chains.seat1State}  link ${ref.chains.link}  frames ${ref.chains.seat0Frames}/${ref.chains.seat1Frames}`);
      ok('final whole-instance hash identical across hosts', rs.every((r) => r.finalHash.all === ref.finalHash.all), `0x${ref.finalHash.all}`);
      ok('the chain is not degenerate: many distinct seat-0 states, and the two seats are NOT clones (different keys -> different chains)', new Set(ref.entries.map((e) => e[1])).size > ref.entries.length / 3 && ref.chains.seat0State !== ref.chains.seat1State, `${new Set(ref.entries.map((e) => e[1])).size} distinct seat-0 hashes of ${ref.entries.length}`);
      // RTC exercised: at least one latch per 1,000 frames (the game was measured at ~5-6 per 1,000 in the overworld, 2 at boot)
      const minLatches = Math.max(20, Math.floor(frames / 1000));
      for (const r of rs) {
        const w = r.rtc;
        const good = w.every((x) => x.present && x.pinned && x.utcOffsetSec === PIN.tzOffsetMin * 60 && x.latches >= minLatches && x.firstUnix === PIN.fixedEpochMs / 1000);
        if (!good) ok(`${r.id}: the game latched the pinned clock on both seats`, false, JSON.stringify(w.map((x) => ({ latches: x.latches, first: x.firstUnix, pinned: x.pinned, off: x.utcOffsetSec }))));
      }
      const w0 = ref.rtc;
      ok(`RTC EXERCISED: the game latched the cartridge clock ${w0[0].latches} times on seat 0 and ${w0[1].latches} on seat 1 (RTC_DATETIME/RTC_TIME commands over GPIO 0x080000C4-C8), on every host`, rs.every((r) => r.rtc.every((x) => x.present && x.pinned && x.latches >= minLatches && x.firstUnix === PIN.fixedEpochMs / 1000)), rs.map((r) => `${r.id}: ${r.rtc[0].latches}/${r.rtc[1].latches}`).join('  '));
      const late = ref.rtcSeries.filter((p) => p.f > frames / 2);
      const early = ref.rtcSeries.find((p) => p.f >= frames / 2 - 5000) || ref.rtcSeries[0];
      ok('the RTC is still being read in the SECOND HALF of the soak (the clock matters to the whole run, not just the boot)', late.length > 0 && ref.rtc[0].latches > early.latches[0] + 20 && ref.rtc[1].latches > early.latches[1] + 20, `seat 0: ${early.latches[0]} latches at frame ${early.f} -> ${ref.rtc[0].latches} at ${ref.totalFrames}`);
      ok('every host handed the guest the SAME clock sequence: identical latch counts, first/last unix time and clock-value digest on both seats', rs.every((r) => r.rtc.every((x, s) => x.latches === ref.rtc[s].latches && x.firstUnix === ref.rtc[s].firstUnix && x.lastUnix === ref.rtc[s].lastUnix && x.digest === ref.rtc[s].digest)), `digest ${hex(ref.rtc[0].digest)}/${hex(ref.rtc[1].digest)}`);
      const calOk = rs.every((r) => r.rtc.every((x) => sameCal(x.calendar, expectCalendar(x.lastUnix, PIN.tzOffsetMin))));
      ok(`the calendar the game last latched is the PINNED zone's wall clock (computed independently from lastUnix + UTC${PIN.tzOffsetMin / 60}), not the host's`, calOk, `${JSON.stringify(ref.rtc[0].calendar)}  vs host would show ${ref.host.localTimeOfPinEpoch.slice(0, 8)} for the pin epoch on ${ref.host.TZ}`);
      // lastUnix is a time reached by emulated frames only: epoch + frames*280896/16777216 (integer ms arithmetic as mGBA does it)
      const exp = Math.floor((PIN.fixedEpochMs + Math.floor(ref.entries[ref.entries.length - 1][0] * (280896 * 1000) / 16777216)) / 1000);
      ok('the clock advances in GUEST time only: the last unix time handed out is within 60 s of epoch + frames*280896/16777216 s (the last latch may predate the final frame)', ref.rtc[0].lastUnix <= exp && exp - ref.rtc[0].lastUnix <= 60, `lastUnix ${ref.rtc[0].lastUnix}, formula for frame ${ref.entries[ref.entries.length - 1][0]}: ${exp}`);
      // tripwires
      const tw = rs.filter((r) => r.spec.tripwire);
      ok('IMPORT TRIPWIRES present in the children that carry them (all five host-time imports found by name in the wasm)', tw.length >= 4 && tw.every((r) => ['__localtime_js', '__mktime_js', '__tzset_js', '__gmtime_js', '_emscripten_date_now'].every((n) => r.hostTime.found.includes(n))), `found: ${tw[0] ? tw[0].hostTime.found.join(' ') : '-'}`);
      ok('PINNED RUNS NEVER REACH THE HOST ZONE: zero calls to __localtime_js and zero to __mktime_js over the whole life of every tripwire child (init + load + all frames)', tw.every((r) => r.hostTime.localtime === 0 && r.hostTime.mktime === 0), tw.map((r) => `${r.id}: local=${r.hostTime.localtime} mktime=${r.hostTime.mktime}`).join('  '));
      ok('the host CLOCK is never read either: zero _emscripten_date_now calls (time() / gettimeofday) in a pinned run', tw.every((r) => r.hostTime.dateNow === 0), tw.map((r) => `${r.id}: dateNow=${r.hostTime.dateNow}`).join('  '));
      ok('every RTC latch went through the UTC conversion and nothing else did: __gmtime_js calls == latches (seat 0 + seat 1)', tw.every((r) => r.hostTime.gmtime === r.rtc[0].latches + r.rtc[1].latches), tw.map((r) => `${r.id}: gmtime=${r.hostTime.gmtime} latches=${r.rtc[0].latches + r.rtc[1].latches}`).join('  '));
      ok('__tzset_js (the one import that still reports the HOST zone: timezone, daylight, tzname) runs at most once per process - lazily, at the first gmtime_r - and nothing in the pinned path reads what it writes (identical chains across five zones above is the evidence)', tw.every((r) => r.hostTime.tzset <= 1), tw.map((r) => `${r.id}: tzset=${r.hostTime.tzset} (during frames: ${r.hostTimeDuringLoop.tzset})`).join('  '));
      ok('LIVENESS: the game is actually playing, not parked: the picture changed on at least 25% of frames on both seats and showed thousands of distinct pictures', ref.liveness.pictureChangedFrames.every((n) => n >= 0.25 * ref.totalFrames) && ref.liveness.distinctPictures.every((n) => n >= 1000), `picture changed on ${ref.liveness.pictureChangedFrames.join('/')} of ${ref.totalFrames} frames, distinct pictures ${ref.liveness.distinctPictures.join('/')}`);
      const p5 = res('soul-P5');
      ok('OBSERVER: the child WITHOUT import tripwires has the same chains as the ones with them (the tripwire does not perturb the run)', p5 && !p5.spec.tripwire && sameChains(ref, p5));
    } else ok('all soul children produced results', false, names(ids.filter((i) => !res(i))));
  }

  // ---- SBAM, linked
  if (want('sbam')) {
    const ids = groups.sbam.map((s) => s.id);
    section(`sbam: Super Bust-A-Move, 2 seats LINKED, ${walk}-frame scripted walk then ${frames} random-input frames, ${ids.length} hosts`);
    if (got(ids)) {
      const rs = ids.map(res), ref = rs[0];
      ok('ARM DIFFERENCE: three zones, three clocks', new Set(rs.map((r) => r.host.offsetJanMin)).size === 3 && new Set(rs.map((r) => r.host.dateNowAtStart)).size === 3, `Jan offsets (min): ${rs.map((r) => r.host.offsetJanMin).join(' ')}`);
      ok(`PER-SEAT CHAINS IDENTICAL across all hosts, ${ref.entries.length} sample points (seat 0, seat 1, link layer, per-frame video+audio)`, rs.every((r) => sameChains(ref, r)), `seat0 ${ref.chains.seat0State}  seat1 ${ref.chains.seat1State}  link ${ref.chains.link}`);
      ok('the chain is not degenerate and the seats are not clones', new Set(ref.entries.map((e) => e[1])).size > ref.entries.length / 3 && ref.chains.seat0State !== ref.chains.seat1State, `${new Set(ref.entries.map((e) => e[1])).size} distinct seat-0 hashes`);
      ok('the cable carried data throughout (both seats attached, >= 1000 MULTI rounds, serial IRQs on the secondary) on every host', rs.every((r) => r.link.attached === 2 && r.link.multiRounds >= 1000 && r.link.serialIrqs[1] > 0), rs.map((r) => `${r.id}: rounds=${r.link.multiRounds} irqs=${r.link.serialIrqs.join('/')}`).join('  '));
      ok('SBAM has no RTC (cartridge reports none) and the pin did not change that: zero latches', rs.every((r) => r.rtc.every((x) => !x.present && x.latches === 0)));
      const tw = rs.filter((r) => r.spec.tripwire);
      ok('no host-zone import reached by the linked soak either (local/mktime = 0 on every host)', tw.every((r) => r.hostTime.localtime === 0 && r.hostTime.mktime === 0), tw.map((r) => `${r.id}: local=${r.hostTime.localtime} mktime=${r.hostTime.mktime} tzset=${r.hostTime.tzset}`).join('  '));
    } else ok('all sbam children produced results', false, names(ids.filter((i) => !res(i))));
  }

  // ---- controls
  if (want('controls')) {
    section('controls: the probe can FAIL');
    const p1 = res('soul-P1');
    if (got(['soul-U1', 'soul-U2', 'soul-U3', 'soul-U4'])) {
      const [u1, u2, u3, u4] = ['soul-U1', 'soul-U2', 'soul-U3', 'soul-U4'].map(res);
      console.log(`       unpinned children: ${[u1, u2, u3, u4].map((r) => `${r.id} TZ=${r.host.TZ} clock ${new Date(r.host.dateNowAtStart).toISOString().slice(0, 19)}Z -> last calendar ${JSON.stringify(r.rtc[0].calendar).replace(/"/g, '')}`).join('\n                          ')}`);
      ok('unpinned TWIN (same zone, same frozen host clock) is bit-identical to U1: the unpinned path is reproducible when the host does not differ', sameChains(u1, u2));
      control('(1a) UNPINNED, different ZONE only (UTC vs Asia/Tokyo, same host clock): chains DIVERGE', !sameChains(u1, u3), fmtDiv(firstDiv(u1.entries, u3.entries)));
      control('(1b) UNPINNED, different host CLOCK only (+5 s): chains DIVERGE', !sameChains(u1, u4), fmtDiv(firstDiv(u1.entries, u4.entries)));
      ok('...and the divergence IS the RTC: unpinned children latched the clock and the calendar the guest saw differs between U1 and U3 (hour) and between U1 and U4 (second)', u1.rtc[0].latches > 0 && u1.rtc[0].calendar.hour !== u3.rtc[0].calendar.hour && u1.rtc[0].calendar.second !== u4.rtc[0].calendar.second, `U1 ${u1.rtc[0].calendar.hour}:${u1.rtc[0].calendar.minute}:${u1.rtc[0].calendar.second}  U3 ${u3.rtc[0].calendar.hour}:${u3.rtc[0].calendar.minute}:${u3.rtc[0].calendar.second}  U4 ${u4.rtc[0].calendar.hour}:${u4.rtc[0].calendar.minute}:${u4.rtc[0].calendar.second}`);
      control('(1c) the TRIPWIRE fires on the unpinned path (positive control): __localtime_js is called by the guest read of the clock, never by a pinned run', [u1, u3, u4].every((r) => r.hostTime.localtime > 0) && [res('soul-P1'), res('soul-P2'), res('soul-P3'), res('soul-P4')].filter(Boolean).every((r) => r.hostTime.localtime === 0), `unpinned __localtime_js calls: ${[u1, u2, u3, u4].map((r) => r.hostTime.localtime).join('/')} (latches on seat 0+1: ${[u1, u2, u3, u4].map((r) => r.rtc[0].latches + r.rtc[1].latches).join('/')}); pinned: 0`);
    } else ok('unpinned control children produced results', false);
    if (p1 && got(['soul-M1', 'soul-M2'])) {
      const [m1, m2] = ['soul-M1', 'soul-M2'].map(res);
      const pc = prefix(p1, cframes);
      const d1 = firstDiv(pc, m1.entries), d2 = firstDiv(pc, m2.entries);
      const differing = (m) => m.entries.filter((e, i) => pc[i] && e.some((v, j) => v !== pc[i][j])).length;
      ok('mutant twins are quiet BEFORE the flip: every sample up to frame 7,500 of the mutant equals the unmutated chain', (!d1 || d1.frame > 7501) && (!d2 || d2.frame >= 7500), `M1 ${fmtDiv(d1)}, M2 ${fmtDiv(d2)}`);
      control(`(2a) ONE-BIT KEY MUTANT between samples (seat 1, UP, frame 7501, was ${m1.mutation && m1.mutation.was}): caught at the next sample`, !!d1 && d1.frame >= 7501 && d1.frame <= 7560, fmtDiv(d1));
      control(`(2b) the same flip ON a sampled frame (frame 7500, was ${m2.mutation && m2.mutation.was}): caught at that very sample`, !!d2 && d2.frame === 7500, fmtDiv(d2));
      const n1 = differing(m1), total1 = m1.entries.length - 125;
      ok(`the unaligned flip PROPAGATED and stayed visible: the mutant's samples differ from the unmutated chain at ${n1} of the ${total1} sample points after the flip (it is not a one-sample blip)`, n1 >= 5, `${n1}/${total1} samples differ`);
      ok('the mutation was applied exactly once, on the named seat and frame, and nothing else differed', m1.mutation && m1.mutation.frame === 7501 && m1.mutation.seat === 1 && m1.mutation.bit === 6 && m2.mutation && m2.mutation.frame === 7500 && m2.mutation.seat === 1);
    } else ok('SoulGold mutant children produced results', false);
    if (p1 && res('soul-M3')) {
      const m3 = res('soul-M3'), mf = m3.spec.mutant.frame;
      const d3 = firstDiv(p1.entries, m3.entries);
      ok(`mutant M3 is quiet until its flip at frame ${mf} (SoulGold, 100% of the run before it matches the unmutated chain)`, !d3 || d3.frame > mf, fmtDiv(d3));
      control(`(2d) ONE-BIT KEY MUTANT LATE in the full soak (seat 1, UP, frame ${mf} of ${m3.totalFrames}): caught within ${m3.totalFrames - mf} frames - the soak is still live and input-sensitive at its end`, !!d3 && d3.frame > mf && d3.frame <= mf + 60 && d3.frame <= m3.totalFrames, fmtDiv(d3));
    }
    if (p1 && got(['soul-V1', 'soul-V2'])) {
      const [v1, v2] = ['soul-V1', 'soul-V2'].map(res);
      control('(3a) a pin that differs by ONE HOUR OF EPOCH gives a different chain: the clock is part of what the chain proves', firstDiv(prefix(p1, cframes), v1.entries) !== null, fmtDiv(firstDiv(prefix(p1, cframes), v1.entries)));
      control('(3b) a pin that differs by ONE HOUR OF UTC OFFSET gives a different chain', firstDiv(prefix(p1, cframes), v2.entries) !== null, fmtDiv(firstDiv(prefix(p1, cframes), v2.entries)));
      ok('the variants were pinned and read (latches > 0, calendar hour differs from P1 by the offset change)', v1.rtc[0].latches > 0 && v2.rtc[0].latches > 0 && v2.rtc[0].calendar.hour !== p1.rtc[0].calendar.hour, `P1 hour ${p1.rtc[0].calendar.hour}, V2 (zone +1h) hour ${v2.rtc[0].calendar.hour}`);
    } else ok('pin-variant children produced results', false);
    const s1 = res('sbam-S1');
    if (s1 && res('sbam-M4')) {
      const m3 = res('sbam-M4');
      const d = firstDiv(s1.entries.filter((e) => e[0] <= m3.totalFrames), m3.entries);
      control(`(2c) ONE-BIT KEY MUTANT in the LINKED room (SBAM, seat 1, LEFT, soak frame 3, walk ${walk} + 3): caught`, !!d && d.frame >= walk + 3, fmtDiv(d));
    }
  }

  // ---- headless Chrome (opt-in)
  if (flag('--browser') || only.includes('browser')) await browserSection(Number(opt('--browser-frames', 6000)));

  // ---- hash guard + report
  const after = { wasm: sha(wasmPath), js: sha(jsPath) };
  ok('hash guard: the .wasm and .js are byte-identical before and after the whole run (no torn artifact)', before.wasm === after.wasm && before.js === after.js, `wasm ${before.wasm} / ${after.wasm}   js ${before.js} / ${after.js}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  const browserRan = flag('--browser') || only.includes('browser');
  console.log(`NOT PROVEN HERE: determinism across different CPUs or OSes (every child ran on this machine); ${browserRan ? 'other engines (only headless Chrome/V8 ran: no Safari/WebKit, no Firefox)' : 'any browser (rerun with --browser for headless Chrome)'}; real-time pacing (runFrame was stepped as fast as the host allows, not at 59.7275 Hz - the caller owns the clock, G6); a game that uses the cable AND the RTC at once (SoulGold Cable Club needs a save made in a Pokemon Center, none exists here).`);
  if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ before, after, idleBusyPct: idle, load, wallSeconds: wall, alone: alone && alone.res ? alone.res.timing : null, children: [...R.values()].map((x) => ({ id: x.id, code: x.code, res: x.res ? { ...x.res, entries: undefined, entryCount: x.res.entries.length } : null })) }, null, 2)); console.log(`wrote ${jsonOut}`); }
  if (fail) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cs = opt('--child', null);
  (cs ? childMain(JSON.parse(cs)) : main()).catch((e) => { console.error(e); process.exit(1); });
}

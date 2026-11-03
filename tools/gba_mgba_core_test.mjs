#!/usr/bin/env node
// tools/gba_mgba_core_test.mjs - exit tests for stage G1 (gba/mgba): the multi-core bridge and its JS API (gba/mgba/mgba_core.js).
//
//   node tools/gba_mgba_core_test.mjs                    # everything below, Node only (~1 minute)
//   GBA_SOAK_FRAMES=100000 node tools/gba_mgba_core_test.mjs --only soak     # the long determinism soak (G2 runs this size)
//   node tools/gba_mgba_core_test.mjs --browser          # + the same API through window.MgbaCore in headless Chrome (bare CDP)
//   node tools/gba_mgba_core_test.mjs --only artifact,accounting             # sections: artifact drift api accounting soak state saves memory incidents rtc
//
// Exit code is non-zero on any failure. Every check that matters has a NEGATIVE CONTROL (a mutant the check must catch, printed
// `[control]`) next to the unmutated twin that must stay quiet.
//
// What each section proves, and what it does not:
//   artifact   the shipped wasm is a real file with none of SharedArrayBuffer / Worker / pthread / Atomics and no Four Swords assist.
//   drift      the constants in bridge/bemental_gba.h and in mgba_core.js are the same numbers.
//   accounting one runFrame() == one frame per seat, exactly (core frame counter), and the guest cycle clock never drifts from
//              280,896 cycles/frame by more than a bounded run-ahead (it does not accumulate). It does NOT prove wall-clock pacing: the
//              caller owns the clock (G6).
//   soak       two SEPARATE wasm instances, identical key streams -> identical per-seat savestate-hash chains + link-layer hash, every
//              60th frame, plus a one-bit key mutant that must diverge and an observer check that hashing does not perturb the run.
//              GBA_SOAK_FRAMES frames of random input run AFTER a scripted 4,800-frame walk into the Super Bust-A-Move 2P battle.
//   state      save/restore round trip (solo) and state transfer between instances (2 linked seats).
//   saves      battery save round trips (SRAM, Flash) and refusal of a save that does not fit the cartridge.
//   memory     ONE shared ROM mapping (heap cost per extra seat << ROM size) for pristine carts; the documented private copy for RTC
//              carts; heap headroom >= 16 MiB for every ROM we ship at 4 seats.
//   incidents  a stall is surfaced, counted and recorded, not healed silently. A genuine link wedge was NEVER observed in any run, so
//              the path is exercised with the debug hook (bgb_debug_force_asleep); the watchdog's own wake is NOT exercised.
//   rtc        the clock-pin hook for G2 (value + host independence) AND its call-order independence: create -> setRtc -> loadRom must
//              pin the same clock as create -> loadRom -> setRtc (it used to be silently discarded in the first order). The
//              calendar/time-zone patch (patches/0004) needs a game that reads the RTC and is G2's test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runScript, SBAM_SCRIPT, framesOf } from './gba_link_smoke.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// GBA_MGBA_DIR points the suite at another copy of gba/mgba (mgba_core.js + dist/). It exists for NEGATIVE CONTROLS: running
// `--only rtc` against the artifact from BEFORE a fix must make the new checks fail.
const MGBA = process.env.GBA_MGBA_DIR ? path.resolve(process.env.GBA_MGBA_DIR) : path.join(ROOT, 'gba/mgba');
const DIST = path.join(MGBA, 'dist');
const ROMS = path.join(ROOT, 'gba/gbaWasm/roms');
const MgbaCore = require(path.join(MGBA, 'mgba_core.js'));
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const only = opt('--only', '').split(',').filter(Boolean);
const want = (s) => !only.length || only.includes(s);
const SOAK = Number(process.env.GBA_SOAK_FRAMES || 3000);
const FORBIDDEN = ['SharedArrayBuffer', 'new Worker', 'pthread', 'Atomics'];
const NO_FS_ASSIST = ['FS assist', 'Four Swords', 'MGBA_SPLITSCREEN_FS_ASSIST'];
const HEADROOM_MIN = 16 * 1024 * 1024;
const FRAME_CYCLES = 280896;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT caught${detail ? '  ' + detail : ''}`); } };
const section = (s) => console.log(`\n== ${s}`);
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const rom = (n) => fs.readFileSync(path.join(ROMS, n));
const SBAM = 'Super Bust-A-Move (U).gba', KIRBY = 'Kirby - Nightmare in Dream Land (U).gba', MRA2 = 'Monster Rancher Advance 2 (U).gba', SA3 = 'Sonic Advance 3 (U).gba', SOUL = 'Pokemon SoulGold (v1.1.1).gba';
const mk = async (seats, romName) => { const c = await MgbaCore.create({ seats }); c.loadRom(rom(romName)); return c; };
const eqBytes = (a, b) => !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0');

// ---------------------------------------------------------------------------------------------------------------------
// Pure checks (each is run on the real artifact AND on a mutant)
const isLfsPointer = (buf) => buf.length < 1024 && buf.subarray(0, 40).toString('latin1').startsWith('version https://git-lfs');
const hasWasmMagic = (buf) => buf.length > 8 && buf[0] === 0 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d;
const countOf = (buf, needle) => { let n = 0, i = 0; const nb = Buffer.from(needle); while ((i = buf.indexOf(nb, i)) >= 0) { n++; i += nb.length; } return n; };
const hits = (buf, list) => Object.fromEntries(list.map((w) => [w, countOf(buf, w)]).filter(([, c]) => c));
const headroomOk = (peak, heap) => heap - peak >= HEADROOM_MIN;
// Frame accounting: every call advances every seat's frame counter by exactly one; the guest cycle clock stays within `bound` of
// k*280896 (offset by the seat's first-call value) AND the bound does not grow (second half within `slack` of the first half).
function accountingVerdict(trace, bound, slack) {
  const { calls, frames, cycles } = trace; // frames[seat][k], cycles[seat][k]
  const bad = [], summary = [];
  for (let s = 0; s < frames.length; s++) {
    for (let k = 0; k < calls; k++) if (frames[s][k] !== k + 1) { bad.push(`seat ${s} call ${k + 1}: frame counter ${frames[s][k]}`); break; }
    let max1 = 0, max2 = 0;
    const base = cycles[s][0] - FRAME_CYCLES;
    for (let k = 0; k < calls; k++) { const d = Math.abs(cycles[s][k] - base - (k + 1) * FRAME_CYCLES); if (k < calls / 2) max1 = Math.max(max1, d); else max2 = Math.max(max2, d); }
    summary.push({ seat: s, maxDriftFirstHalf: max1, maxDriftSecondHalf: max2 });
    if (Math.max(max1, max2) > bound) bad.push(`seat ${s}: drift ${Math.max(max1, max2)} > bound ${bound}`);
    if (max2 > max1 + slack) bad.push(`seat ${s}: drift grows (${max1} -> ${max2})`);
  }
  return { ok: bad.length === 0, bad, summary };
}
function firstDivergence(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; }

// ---------------------------------------------------------------------------------------------------------------------
async function artifactSection() {
  section('artifact: the wasm is real, single-thread, and has no Four Swords assist');
  const wasm = fs.readFileSync(path.join(DIST, 'mgba_core.wasm')), glue = fs.readFileSync(path.join(DIST, 'mgba_core.js'));
  ok('mgba_core.wasm starts with \\0asm and is not an LFS pointer', hasWasmMagic(wasm) && !isLfsPointer(wasm), `${wasm.length} B`);
  control('an LFS pointer is recognised as one', isLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n')) && !hasWasmMagic(Buffer.from('version https://git-lfs')));
  const ft = spawnSync('git', ['check-attr', 'filter', '--', 'gba/mgba/dist/mgba_core.wasm'], { cwd: ROOT, encoding: 'utf8' });
  ok('git will store the wasm as a plain blob (filter attribute is not lfs)', ft.status === 0 && !/filter: lfs/.test(ft.stdout), ft.stdout.trim());
  const w = hits(wasm, FORBIDDEN), g = hits(glue, FORBIDDEN);
  ok('wasm: no SharedArrayBuffer / new Worker / pthread / Atomics strings', Object.keys(w).length === 0, JSON.stringify(w));
  ok('glue: no SharedArrayBuffer / new Worker / pthread / Atomics strings', Object.keys(g).length === 0, JSON.stringify(g));
  control('the string scan catches a mutant containing each forbidden word', FORBIDDEN.every((f) => Object.keys(hits(Buffer.concat([wasm.subarray(0, 64), Buffer.from(f)]), FORBIDDEN)).length === 1));
  ok('wasm: no Four Swords assist code or strings', Object.keys(hits(wasm, NO_FS_ASSIST)).length === 0, JSON.stringify(hits(wasm, NO_FS_ASSIST)));
  control('the Four Swords scan catches a mutant', NO_FS_ASSIST.every((f) => Object.keys(hits(Buffer.concat([wasm.subarray(0, 64), Buffer.from(f)]), NO_FS_ASSIST)).length === 1));
  const bi = JSON.parse(fs.readFileSync(path.join(DIST, 'mgba_core.buildinfo.json'), 'utf8'));
  ok('buildinfo md5s match the files on disk (glue compared in LF form)', bi.md5['mgba_core.wasm'] === md5(wasm) && bi.md5['mgba_core.js'] === md5(Buffer.from(glue.toString('latin1').split('\r').join(''), 'latin1')));
  // The shipped wasm must have been built from the bridge sources that are on disk NOW. build.sh records the digests of the LF-normalised
  // sources it compiled; a bridge edit without a rebuild (the exact way a fix gets "made" and not shipped) leaves them different.
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const bridgeDigest = (rel, text) => sha256(Buffer.from(text.split('\r\n').join('\n'), 'utf8'));
  const recorded = (bi.bridge && bi.bridge.sha256_of_LF_normalised_sources) || {};
  const bridgeFiles = Object.keys(recorded);
  const stale = bridgeFiles.filter((rel) => bridgeDigest(rel, fs.readFileSync(path.join(MGBA, rel), 'utf8')) !== recorded[rel]);
  ok('the wasm was built from the bridge sources on disk (buildinfo digests == current bridge/*.c|h)', bridgeFiles.length === 3 && stale.length === 0, stale.length ? `STALE: ${stale.join(', ')}` : `${bridgeFiles.length} files`);
  const mutated = bridgeFiles.filter((rel) => bridgeDigest(rel, fs.readFileSync(path.join(MGBA, rel), 'utf8') + '\n/* one more comment */\n') !== recorded[rel]);
  control('a one-line edit to any bridge source is seen as a stale build', mutated.length === bridgeFiles.length && bridgeFiles.length === 3);
  const must = ['0001-cmake-honor-use-pthreads-off.patch', '0002-lockstep-no-fs-assist-link-witnesses.patch', '0003-gba-remove-irq-trace-add-sio-irq-witness.patch', '0004-gpio-rtc-pinned-utc-offset.patch'];
  ok('buildinfo lists the four patches', JSON.stringify(bi.source.patches) === JSON.stringify(must));
  const core = await MgbaCore.create({ seats: 1 });
  ok('wasm heap is the documented fixed INITIAL_MEMORY', core.memory().heapBytes === bi.link.initialMemory, `${core.memory().heapBytes / 1048576} MiB`);
  ok('the bridge ABI version in the wasm equals the wrapper\'s', core.abi === MgbaCore.ABI_VERSION);
  const names = Object.keys(core.M).filter((k) => k.startsWith('_bgb_'));
  ok('bridge exports are present', names.length >= 40, `${names.length} _bgb_* exports`);
  core.close();
}

function driftSection() {
  section('drift: bridge/bemental_gba.h and mgba_core.js carry the same constants');
  const hdr = fs.readFileSync(path.join(MGBA, 'bridge/bemental_gba.h'), 'utf8');
  const defs = (prefix, text) => Object.fromEntries([...text.matchAll(new RegExp(`#define BGB_${prefix}_(\\w+)\\s+(0x[0-9a-fA-F]+|\\d+)`, 'g'))].map((m) => [m[1], Number(m[2])]));
  const compare = (text) => {
    const st = defs('ST', text), stat = defs('STAT', text), inc = defs('INC', text);
    const diffs = [];
    const want = { STALL: 'STALL', RECOVERED: 'RECOVERED', STEP_CAP: 'STEP_CAP', MULTI_NODATA: 'MULTI_NODATA', NOT_LOADED: 'NOT_LOADED' };
    for (const k of Object.keys(want)) if (st[k] !== MgbaCore.ST[k]) diffs.push(`ST.${k}: header ${st[k]} wrapper ${MgbaCore.ST[k]}`);
    for (const [k, v] of Object.entries(MgbaCore.STAT)) if (stat[k] !== v) diffs.push(`STAT.${k}: header ${stat[k]} wrapper ${v}`);
    const abi = Number((text.match(/#define BGB_ABI_VERSION\s+(\d+)/) || [])[1]);
    if (abi !== MgbaCore.ABI_VERSION) diffs.push(`ABI header ${abi} wrapper ${MgbaCore.ABI_VERSION}`);
    const incNames = Object.keys(inc).length;
    if (incNames !== 4) diffs.push(`INC kinds ${incNames}`);
    return diffs;
  };
  const d = compare(hdr);
  ok('header constants == wrapper constants (ST, STAT, ABI)', d.length === 0, d.join('; '));
  const mutant = hdr.replace(/#define BGB_STAT_TRANSFERS_WIN 9/, '#define BGB_STAT_TRANSFERS_WIN 10');
  control('a drifted header constant is caught', mutant !== hdr && compare(mutant).length > 0, compare(mutant)[0]);
  ok('frame constants: 280,896 cycles at 16,777,216 Hz = 59.7275 Hz', MgbaCore.FRAME_CYCLES === 280896 && Math.abs(MgbaCore.FPS - 59.7275) < 1e-3, MgbaCore.FPS.toFixed(4));
}

async function apiSection() {
  section('api: errors, seat bounds, key masking, solo is a coordinator-free fast path');
  const bad = await MgbaCore.create({ seats: 1 });
  let code = null; try { bad.loadRom(Buffer.alloc(100)); } catch (e) { code = e.code; }
  ok('a 100-byte file is refused as ROM_SIZE', code === 'ROM_SIZE', String(code));
  code = null; try { bad.loadRom(Buffer.alloc(4096)); } catch (e) { code = e.code; }
  ok('4 KiB of zeros is refused as NOT_A_GBA_ROM', code === 'NOT_A_GBA_ROM', String(code));
  let r = null; try { bad.runFrame(); } catch (e) { r = 'threw'; }
  ok('runFrame() before loadRom() reports NOT_LOADED instead of crashing', r === null && bad.runFrame() === MgbaCore.ST.NOT_LOADED);
  bad.close();
  ok('create({seats:5}) and create({seats:0}) are rejected', await MgbaCore.create({ seats: 5 }).then(() => false, () => true) && await MgbaCore.create({ seats: 0 }).then(() => false, () => true));
  const solo = await mk(1, KIRBY);
  let oob = false; try { solo.setKeys(1, 1); } catch (e) { oob = e instanceof RangeError; }
  ok('seat 1 of a 1-seat instance is out of range', oob);
  for (let i = 0; i < 5; i++) solo.runFrame();
  const keyinput = (m) => { solo.setKeys(0, m); solo.runFrame(); return solo.read16(0, 0x04000130) & 0x3FF; };
  const r0 = keyinput(0), rAll = keyinput(0x3FF), rHigh = keyinput(0xFFFF), rJunk = keyinput(0xFC00);
  ok('setKeys keeps only the low 10 bits (KEYINPUT: none=3FF, all=000, 0xFFFF==all, 0xFC00==none)', r0 === 0x3FF && rAll === 0 && rHigh === 0 && rJunk === 0x3FF, `none=${r0.toString(16)} all=${rAll.toString(16)} ffff=${rHigh.toString(16)} fc00=${rJunk.toString(16)}`);
  control('KEYINPUT really moves with the keys (a stuck register would fail the check above)', r0 !== rAll);
  const w = solo.witnesses();
  ok('solo: no coordinator is attached, no link hash, no transfers', w.attached === 0 && solo.hashLink() === 0 && w.transfers === 0 && w.linked === false && w.stalls === 0);
  ok('solo: runFrame() returns 0 (clean)', solo.runFrame() === 0);
  const px = solo.video(0);
  ok('video(seat) is a 240x160 RGBA view with alpha forced to 255', px.length === 240 * 160 * 4 && px[3] === 255 && px[px.length - 1] === 255);
  const au = solo.audio(0);
  const expectFrames = au.rate / MgbaCore.FPS;
  ok('audio(seat) returns interleaved stereo int16, one frame of samples at the rate the GAME programmed (Kirby uses 65536 Hz, not 32768)', [32768, 65536, 131072, 262144].includes(au.rate) && Math.abs(au.frames - expectFrames) < expectFrames * 0.1 && au.samples.length === au.frames * 2, `frames=${au.frames} rate=${au.rate} expected ~${expectFrames.toFixed(0)}`);
  const info = solo.info;
  ok('loadRom() returns the cartridge identity', info.code === 'A7KE' && info.romSize === 8388608 && info.romPristine === true, JSON.stringify({ code: info.code, title: info.title, maker: info.maker }));
  solo.close();
}

async function accountingSection() {
  section('accounting: one runFrame() = one frame per seat, 280,896 guest cycles per frame, no drift');
  const sample = async (seats) => {
    const core = await mk(seats, SBAM), tr = { calls: 0, frames: Array.from({ length: seats }, () => []), cycles: Array.from({ length: seats }, () => []) };
    const orig = core.runFrame.bind(core);
    core.runFrame = () => { const st = orig(); tr.calls++; for (let s = 0; s < seats; s++) { tr.frames[s].push(core.frames(s)); tr.cycles[s].push(core.cycles(s)); } return st; };
    const run = await runScript(core, SBAM_SCRIPT, {});
    const fc = core.M._bgb_frame_cycles();
    core.close();
    return { tr, run, fc };
  };
  const solo = await sample(1), duo = await sample(2);
  ok('core.frameCycles() == 280,896 (VIDEO_TOTAL_LENGTH: 228 lines x 1232 cycles)', solo.fc === FRAME_CYCLES && duo.fc === FRAME_CYCLES);
  const vs = accountingVerdict(solo.tr, 64, 16);
  ok(`1 seat, ${solo.tr.calls} calls: frame counter == calls every call; cycle drift <= 64 and not growing`, vs.ok, JSON.stringify(vs.summary));
  const vd = accountingVerdict(duo.tr, 16384, 256);
  ok(`2 linked seats, ${duo.tr.calls} calls through the link menus and a battle: frame counter == calls for BOTH seats every call; drift <= 16384 and not growing (slack 256)`, vd.ok, JSON.stringify(vd.summary));
  console.log(`       proxy used: per-seat video frame counter (core->frameCounter) and the sum of mTimingCurrentTime deltas; the master runs up to ~8k cycles past its boundary to wake the secondary (bounded, see max drift above), so cycles are exact at frame boundaries and bounded between them.`);
  // controls: a fast-forward driver (two frames per tick) and a drifting clock must both fail the same verdict
  const ff = { ...solo.tr, frames: [solo.tr.frames[0].map((_, k) => 2 * (k + 1))], cycles: [solo.tr.cycles[0].map((_, k) => solo.tr.cycles[0][0] + (2 * k + 1) * FRAME_CYCLES)] };
  control('a fast-forward driver (2 frames per call) fails the accounting verdict', !accountingVerdict(ff, 64, 16).ok);
  const slow = { ...solo.tr, cycles: [solo.tr.cycles[0].map((c, k) => c + k * 5)] };
  control('a guest clock that gains 5 cycles per frame fails the drift verdict (it would be 1.00002x)', !accountingVerdict(slow, 64, 16).ok);
  // The exact claim, in numbers: cycles per frame over the whole walk.
  const k = solo.tr.calls, perFrame = (solo.tr.cycles[0][k - 1] - solo.tr.cycles[0][0]) / (k - 1);
  ok(`solo: mean guest cycles per frame over ${k} frames is 280,896 to within 0.01 cycle`, Math.abs(perFrame - FRAME_CYCLES) < 0.01, perFrame.toFixed(4));
  const k2 = duo.tr.calls, per1 = (duo.tr.cycles[1][k2 - 1] - duo.tr.cycles[1][0]) / (k2 - 1);
  ok(`2 seats: the secondary's mean guest cycles per frame is 280,896 to within 0.05 cycle`, Math.abs(per1 - FRAME_CYCLES) < 0.05, per1.toFixed(4));
  ok('no incident over either walk', solo.run.w.incidents === 0 && duo.run.w.incidents === 0 && duo.run.statuses.length === 0);
}

// Deterministic key streams for the soak: a sparse random mask per seat, changing every 12 frames.
function makeKeys(seed) {
  let x = seed >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const cur = [0, 0];
  return (f) => { if (f % 12 === 0) { cur[0] = (rnd() & rnd()) & 0x3FF; cur[1] = (rnd() & rnd()) & 0x3FF; } return cur; };
}

async function soakSection() {
  section(`soak: two separate wasm instances, identical keys, identical state-hash chains for ${SOAK} frames (after a ${framesOf(SBAM_SCRIPT)}-frame walk into the 2P battle)`);
  const rom_ = rom(SBAM);
  const boot = async () => { const c = await MgbaCore.create({ seats: 2 }); c.loadRom(rom_); await runScript(c, SBAM_SCRIPT, {}); return c; };
  const t0 = performance.now();
  const [A, B, C, O] = [await boot(), await boot(), await boot(), await boot()];
  console.log(`       4 instances walked to the battle in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const entry = (c, f) => `${f}:${hex(c.hash(0))}:${hex(c.hash(1))}:${hex(c.hashLink())}`;
  ok('twin instances are identical right after the scripted walk', A.hashAll() === B.hashAll() && A.hashAll() === O.hashAll(), hex(A.hashAll()));
  const roundsAtStart = A.witnesses().multiRounds;
  const keysA = makeKeys(0xC0FFEE), keysC = makeKeys(0xC0FFEE);
  const chainA = [], chainB = [], chainC = [];
  const MUT = 3; // soak frame where ONE bit of ONE seat's key mask is flipped on instance C. Early on purpose: measured, a one-frame flip in the 2P battle changes the game only while the battle is live (flips at soak frame 1 and 3 diverge by frame 20; the same flips at frame 1507, after the random players had ended the match, change nothing)
  let mutatedBitWas = null, statusA = 0;
  const t1 = performance.now();
  for (let f = 1; f <= SOAK; f++) {
    const k = keysA(f), kc = keysC(f);
    for (const c of [A, B, O]) { c.setKeys(0, k[0]); c.setKeys(1, k[1]); }
    C.setKeys(0, kc[0]);
    let m1 = kc[1];
    if (f === MUT) { mutatedBitWas = (m1 >> 5) & 1; m1 ^= (1 << 5); } // KEY.LEFT, seat 1, this one frame
    C.setKeys(1, m1);
    statusA |= A.runFrame(); B.runFrame(); C.runFrame(); O.runFrame();
    if (f % 60 === 0) { chainA.push(entry(A, f)); chainB.push(entry(B, f)); chainC.push(entry(C, f)); }
  }
  console.log(`       ${SOAK} frames x 4 instances x 2 seats in ${((performance.now() - t1) / 1000).toFixed(1)} s; ${chainA.length} chain entries per instance`);
  const dAB = firstDivergence(chainA, chainB);
  ok(`twin chains are identical at all ${chainA.length} sample points (per-seat core state + link layer)`, dAB === -1, dAB >= 0 ? `first divergence at entry ${dAB}: ${chainA[dAB]} vs ${chainB[dAB]}` : `last ${chainA[chainA.length - 1]}`);
  ok('the chain is not constant (the run really moved)', new Set(chainA.map((e) => e.split(':')[1])).size > chainA.length / 3, `${new Set(chainA.map((e) => e.split(':')[1])).size} distinct seat-0 hashes`);
  const dAC = firstDivergence(chainA, chainC);
  const mutEntry = Math.floor(MUT / 60);
  control(`ONE flipped key bit (seat 1, LEFT, soak frame ${MUT}, was ${mutatedBitWas}) on one instance is caught by the chain`, dAC >= mutEntry && dAC !== -1, `first divergence at entry ${dAC} (frame ${(dAC + 1) * 60}); mutation inside entry ${mutEntry}`);
  ok('observer check: hashing every 60th frame does not perturb the run (an instance that never hashed ends in the same state)', A.hashAll() === O.hashAll(), hex(O.hashAll()));
  const wa = A.witnesses();
  ok('no incident (stall / recover / missed MULTI ack) on the soak instance', wa.incidents === 0 && statusA === 0 && wa.recoverCount === 0 && wa.stalls === 0, `incidents=${wa.incidents} recover=${wa.recoverCount} stalls=${wa.stalls} rounds=${wa.multiRounds}`);
  // Not 'transfers in the last 60 frames': in a long soak the random players end the match and sit in menus that run no SIO traffic.
  ok('the link carried data through the soak (>= 1000 data-carrying MULTI rounds during it, both seats attached)', wa.attached === 2 && wa.multiRounds - roundsAtStart >= 1000, `rounds during soak ${wa.multiRounds - roundsAtStart}`);
  for (const c of [A, B, C, O]) c.close();
}

async function stateSection() {
  section('state: savestate round trip, and state transfer between instances');
  const s = await mk(1, KIRBY);
  for (let i = 0; i < 600; i++) s.runFrame();
  const st = s.saveState(0);
  ok('savestate is the full 0x61000-byte GBASerializedState', st.length === 0x61000);
  for (let i = 0; i < 30; i++) s.runFrame();
  const straight = s.hashGame(0), strictStraight = s.hash(0), xBytes = s.saveState(0), vStraight = s.video(0).slice();
  ok('loadState() accepts it', s.loadState(0, st));
  for (let i = 0; i < 30; i++) s.runFrame();
  const yBytes = s.saveState(0);
  ok('30 frames after restore == 30 frames straight through: game-state hash (Kirby, animating)', s.hashGame(0) === straight, hex(straight));
  ok('... and the framebuffer is bit-identical', eqBytes(s.video(0), vStraight));
  const diffAt = []; for (let i = 0; i < xBytes.length; i++) if (xBytes[i] !== yBytes[i]) diffAt.push(i);
  const inPsg = (o) => o >= MgbaCore.PSG_MASK[0] && o < MgbaCore.PSG_MASK[1];
  ok('the STRICT hash differs after a restore (mGBA does not round-trip its PSG sequencer fields), and EVERY differing byte lies in the masked PSG block', s.hash(0) !== strictStraight && diffAt.length > 0 && diffAt.every(inPsg), `${diffAt.length} bytes, offsets ${diffAt.slice(0, 6).map((o) => '0x' + o.toString(16)).join(',')}`);
  control('the mask check catches a difference OUTSIDE the PSG block (a mutant byte at 0x2000)', !([...diffAt, 0x2000].every(inPsg)));
  s.loadState(0, st); for (let i = 0; i < 31; i++) s.runFrame();
  control('one extra frame after restore gives a different game-state hash', s.hashGame(0) !== straight);
  let threw = false; try { s.loadState(0, st.subarray(0, 100)); } catch (e) { threw = e instanceof RangeError; }
  ok('a truncated savestate is refused', threw);
  const bad = st.slice(); bad[0x10] ^= 0xFF; bad[0x11] ^= 0xFF; bad[0x12] ^= 0xFF;
  s.close();

  // 2 linked seats, mid-battle: instance A restores its OWN states, a fresh instance B restores the same bytes; both then see the same keys.
  const A = await MgbaCore.create({ seats: 2 }); A.loadRom(rom(SBAM));
  await runScript(A, SBAM_SCRIPT, {});
  const states = [A.saveState(0), A.saveState(1)];
  A.loadStates(states);
  const B = await MgbaCore.create({ seats: 2 }); B.loadRom(rom(SBAM));
  B.loadStates(states);
  ok('after restore the link layer of A and of a FRESH instance B is identical', A.hashLink() === B.hashLink(), hex(A.hashLink()));
  const keys = makeKeys(0xBADA55), n = Math.min(SOAK, 1500), chA = [], chB = [];
  for (let f = 1; f <= n; f++) { const k = keys(f); for (const c of [A, B]) { c.setKeys(0, k[0]); c.setKeys(1, k[1]); c.runFrame(); } if (f % 60 === 0) { chA.push(entry2(A)); chB.push(entry2(B)); } }
  function entry2(c) { return `${hex(c.hash(0))}:${hex(c.hash(1))}:${hex(c.hashLink())}`; }
  ok(`state transfer: a fresh instance restored from A's states evolves identically to A for ${n} frames (${chA.length} samples)`, firstDivergence(chA, chB) === -1, firstDivergence(chA, chB) >= 0 ? `diverged at sample ${firstDivergence(chA, chB)}` : '');
  const wa = A.witnesses(), wb = B.witnesses();
  ok('no incident on either instance after the restore (the coordinator was rebuilt, not left mid-transfer)', wa.incidents === 0 && wb.incidents === 0, `A=${wa.incidents} B=${wb.incidents}`);
  // control: a state from a DIFFERENT moment, same keys, must give a different chain
  const B2 = await MgbaCore.create({ seats: 2 }); B2.loadRom(rom(SBAM));
  const other = await MgbaCore.create({ seats: 2 }); other.loadRom(rom(SBAM));
  for (let i = 0; i < 200; i++) other.runFrame();
  B2.loadStates([other.saveState(0), other.saveState(1)]);
  const kk = makeKeys(0xBADA55); let chB2 = '';
  for (let f = 1; f <= 60; f++) { const k = kk(f); B2.setKeys(0, k[0]); B2.setKeys(1, k[1]); B2.runFrame(); if (f === 60) chB2 = entry2(B2); }
  control('restoring a state from a DIFFERENT moment gives a different chain under the same keys (the comparison can fail)', chB2 !== chA[0], `${chB2} vs ${chA[0]}`);
  for (const c of [A, B, B2, other]) c.close();
}

async function savesSection() {
  section('saves: battery round trips and refusal of a save that does not fit the cartridge');
  const pattern = (n, seed) => { const b = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; b[i] = x >>> 24; } return b; };
  const mra = await mk(1, MRA2);
  ok('MRA2 declares an SRAM battery (SRAM_F_V tag) although mGBA only resolves the type at the first access', mra.info.saveTag === 'sram' && mra.info.saveType === 'auto', `tag=${mra.info.saveTag} type=${mra.info.saveType}`);
  ok('export before the game has touched its save memory is null (nothing exists yet)', mra.exportSave(0) === null);
  const p32 = pattern(32768, 1);
  ok('setSave(32 KiB) is accepted', mra.setSave(0, p32));
  ok('exportSave() returns exactly the bytes imported (SRAM round trip, BEFORE the first frame)', eqBytes(mra.exportSave(0), p32));
  const flipped = p32.slice(); flipped[12345] ^= 1;
  control('a one-bit difference is caught by the round-trip comparison', !eqBytes(mra.exportSave(0), flipped));
  ok('a 100-byte save is refused (not silently half-loaded)', mra.setSave(0, new Uint8Array(100)) === false);
  ok('a 64 KiB save is refused for a 32 KiB SRAM cartridge', mra.setSave(0, pattern(65536, 2)) === false);
  ok('the refused imports left the good save untouched', eqBytes(mra.exportSave(0), p32));
  for (let i = 0; i < 120; i++) mra.runFrame();
  ok('the game boots on the imported save (120 frames, no incident)', mra.witnesses().incidents === 0);
  mra.close();
  const soul = await mk(1, SOUL);
  ok('SoulGold is Flash 1 MiB (FLASH1M_V tag) and resolves at load', soul.info.saveTag === 'flash1m' && soul.info.saveType === 'flash1m');
  const p128 = pattern(131072, 3);
  ok('setSave(128 KiB) is accepted and round-trips (Flash)', soul.setSave(0, p128) && eqBytes(soul.exportSave(0), p128));
  ok('a 32 KiB save is refused for a Flash 1 MiB cartridge', soul.setSave(0, pattern(32768, 4)) === false && eqBytes(soul.exportSave(0), p128));
  soul.close();
  // two seats, two different saves: each seat keeps its own
  const duo = await MgbaCore.create({ seats: 2 }); duo.loadRom(rom(MRA2));
  const a = pattern(32768, 5), b = pattern(32768, 6);
  duo.setSave(0, a); duo.setSave(1, b);
  ok('two seats keep their own battery saves (trades will mutate one seat\'s save, not the other)', eqBytes(duo.exportSave(0), a) && eqBytes(duo.exportSave(1), b) && !eqBytes(duo.exportSave(0), duo.exportSave(1)));
  duo.close();
}

async function memorySection() {
  section('memory: one shared ROM mapping; headroom for every ROM we ship at 4 seats');
  const peakOf = async (name, seats) => { const c = await mk(seats, name); for (let i = 0; i < 120; i++) c.runFrame(); for (let s = 0; s < seats; s++) c.saveState(s); const r = { peak: c.memory().highWater, heap: c.memory().heapBytes, pristine: c.info.romPristine, size: c.info.romSize }; c.close(); return r; };
  const sharedOk = (p1, p2, romSize) => p2.peak - p1.peak < romSize / 2;
  const s1 = await peakOf(SBAM, 1), s2 = await peakOf(SBAM, 2);
  ok(`Super Bust-A-Move (4 MiB): a 2nd seat costs ${((s2.peak - s1.peak) / 1048576).toFixed(2)} MiB, far below the 4 MiB ROM (one shared mapping, not a copy per core)`, sharedOk(s1, s2, s1.size), `1 seat ${(s1.peak / 1048576).toFixed(1)} MiB, 2 seats ${(s2.peak / 1048576).toFixed(1)} MiB`);
  const a1 = await peakOf(SA3, 1), a2 = await peakOf(SA3, 2);
  ok(`Sonic Advance 3 (16 MiB): a 2nd seat costs ${((a2.peak - a1.peak) / 1048576).toFixed(2)} MiB, far below the 16 MiB ROM`, sharedOk(a1, a2, a1.size), `1 seat ${(a1.peak / 1048576).toFixed(1)} MiB, 2 seats ${(a2.peak / 1048576).toFixed(1)} MiB`);
  const g1 = await peakOf(SOUL, 1), g2 = await peakOf(SOUL, 2);
  control('the sharing predicate FAILS for the RTC cart (SoulGold): mGBA copies the ROM before the first GPIO write, once per seat', !sharedOk(g1, g2, g1.size), `a 2nd seat costs ${((g2.peak - g1.peak) / 1048576).toFixed(1)} MiB (documented, not a defect of the bridge)`);
  ok('SoulGold is not pristine after reset (the GPIO copy happened) and still runs 2 seats inside the heap', !g1.pristine && headroomOk(g2.peak, g2.heap), `2 seats ${(g2.peak / 1048576).toFixed(1)} of ${(g2.heap / 1048576).toFixed(0)} MiB`);
  const rows = [];
  for (const f of fs.readdirSync(ROMS).filter((x) => x.endsWith('.gba')).sort()) {
    const p = await peakOf(f, 4);
    rows.push({ f, ...p });
    ok(`${f}: 4 seats fit with >= 16 MiB headroom`, headroomOk(p.peak, p.heap), `peak ${(p.peak / 1048576).toFixed(1)} of ${(p.heap / 1048576).toFixed(0)} MiB, headroom ${((p.heap - p.peak) / 1048576).toFixed(1)} MiB`);
  }
  const worst = rows.reduce((a, b) => (a.peak > b.peak ? a : b));
  control(`a 128 MiB heap would NOT hold ${worst.f} at 4 seats (so the headroom rule can fail)`, !headroomOk(worst.peak, 128 * 1048576), `${(worst.peak / 1048576).toFixed(1)} MiB peak`);
  ok('the fork\'s 320 MiB heap is not needed: the measured worst case is less than 60% of it', worst.peak < 0.6 * 320 * 1048576, `${(worst.peak / 1048576).toFixed(1)} MiB`);
}

async function incidentSection() {
  section('incidents: a stall is surfaced, counted and recorded - never healed silently');
  const c = await mk(2, SBAM);
  for (let i = 0; i < 400; i++) c.runFrame();
  const clean = c.witnesses();
  ok('a clean run reports zero incidents, stalls and recovers', clean.incidents === 0 && clean.stalls === 0 && clean.recoverCount === 0 && clean.clean === true);
  c.setRecoverAfter(0);                       // never heal: a stall must STAY a stall
  c.debugForceAsleep(0b10);                   // pretend seat 1 is asleep waiting on the link
  const st = c.runFrame();
  ok('runFrame() returns the STALL bit when a seat cannot move', (st & MgbaCore.ST.STALL) === MgbaCore.ST.STALL, `status ${st}`);
  const inc = c.incidents();
  ok('the incident is recorded with the seat sleep mask and the call number', inc.length === 1 && inc[0].kind === 'loop-stall' && (inc[0].asleepMask & 2) === 2 && inc[0].call === 401, JSON.stringify(inc[0]));
  const w = c.witnesses();
  ok('witnesses() counts it: stalls=1, clean=false, recoverCount stays 0 (no silent heal)', w.stalls === 1 && w.clean === false && w.recoverCount === 0 && w.incidents === 1);
  for (let i = 0; i < 70; i++) c.runFrame();
  ok('with recover disabled, 70 more stalled calls are 70 more loop-stall incidents and still no recover', c.witnesses().stallDetail.loopStalls === 71 && c.witnesses().recoverCount === 0, `loopStalls=${c.witnesses().stallDetail.loopStalls}`);
  const before = [c.frames(0), c.frames(1)];
  c.debugForceAsleep(0);
  for (let i = 0; i < 4; i++) c.runFrame();
  const after = [c.frames(0), c.frames(1)];
  ok('clearing the stall lets the seats resume; the lagging seat catches up and the incident stays on record', after[1] > before[1] && c.witnesses().incidents >= 71 && c.witnesses().clean === false, `frames ${before} -> ${after}, incidents ${c.witnesses().incidents}`);
  const unforced = await mk(2, SBAM);
  for (let i = 0; i < 480; i++) unforced.runFrame();
  control('the unforced twin never reports an incident over the same number of frames', unforced.witnesses().incidents === 0);
  ok('the log ring is readable and bounded', Array.isArray(c.drainLog()));
  c.close(); unforced.close();
}

async function rtcSection() {
  section('rtc: the clock-pin hook (for G2)');
  const E = Date.UTC(2031, 5, 15, 12, 0, 0);
  const c = await mk(1, SOUL);
  const host = c.rtcUnix(0);
  ok('unpinned: the cartridge clock follows the host clock', Math.abs(host - Date.now() / 1000) < 3, `${host}`);
  c.setRtc({ fixedEpochMs: E, tzOffsetMin: -300 });
  const expectAt = (f) => Math.floor((E + Math.floor(f * 280896 * 1000 / 16777216)) / 1000);
  const t0 = c.rtcUnix(0);
  ok('pinned: frame 0 reads exactly the pinned epoch (and not the host clock)', t0 === Math.floor(E / 1000), `${t0}`);
  let allOk = true;
  for (const target of [60, 600, 1800]) { while (c.frames(0) < target) c.runFrame(); allOk = allOk && c.rtcUnix(0) === expectAt(c.frames(0)); }
  ok('pinned: the clock advances with EMULATED frames (60, 600, 1800) by the exact FAKE_EPOCH formula', allOk);
  const t1 = c.rtcUnix(0); await new Promise((r) => setTimeout(r, 1200));
  ok('pinned: wall-clock time passing changes nothing', c.rtcUnix(0) === t1);
  ok('the time-zone offset is recorded in the library (-300 min = -18000 s)', c.M._bgb_rtc_tz_offset_sec() === -18000);
  c.setRtc(null);
  ok('setRtc(null) hands the clock back to the host and clears the pinned zone', Math.abs(c.rtcUnix(0) - Date.now() / 1000) < 3 && c.M._bgb_rtc_tz_offset_sec() === 0x7FFFFFFF);
  c.close();
  const hostTz = process.env.TZ || '(host default)';
  const child = spawnSync(process.execPath, ['-e', `const M=require(${JSON.stringify(path.join(MGBA, 'mgba_core.js'))});(async()=>{const c=await M.create({seats:1});c.loadRom(require('fs').readFileSync(${JSON.stringify(path.join(ROMS, SOUL))}));c.setRtc({fixedEpochMs:${E},tzOffsetMin:-300});for(let i=0;i<300;i++)c.runFrame();console.log(c.rtcUnix(0),c.hash(0));})()`], { env: { ...process.env, TZ: hostTz === 'Pacific/Kiritimati' ? 'UTC' : 'Pacific/Kiritimati' }, encoding: 'utf8' });
  const me = await mk(1, SOUL); me.setRtc({ fixedEpochMs: E, tzOffsetMin: -300 }); for (let i = 0; i < 300; i++) me.runFrame();
  ok('same pinned run under a host TZ 14 hours away gives the same clock reading AND the same state hash', child.status === 0 && child.stdout.trim() === `${me.rtcUnix(0)} ${me.hash(0)}`, `${child.stdout.trim()} | ${me.rtcUnix(0)} ${me.hash(0)}`);
  me.close();
  await rtcOrderChecks(E);
}

// setRtc() call order. mGBA's core init resets a core's clock to the HOST clock, so a pin written into a core before loadRom() was lost
// without a sound (the guest then read the host clock and host time zone: a silent per-machine desync in a room). The bridge now remembers
// the pin and applies it to each core as it is created.
async function rtcOrderChecks(E) {
  section('rtc order: setRtc() before loadRom() pins the same clock as after it');
  const pin = { fixedEpochMs: E, tzOffsetMin: -300 };
  const pinSec = Math.floor(E / 1000);
  const expectAt = (f) => Math.floor((E + Math.floor(f * 280896 * 1000 / 16777216)) / 1000);
  // order: 'before' = create, setRtc, loadRom | 'after' = create, loadRom, setRtc | 'none' = never pinned (the host clock)
  const run = async (order, frames) => {
    const c = await MgbaCore.create({ seats: 1 });
    if (order === 'before') c.setRtc(pin);
    c.loadRom(rom(SOUL));
    if (order === 'after') c.setRtc(pin);
    const t0 = c.rtcUnix(0);
    for (let i = 0; i < frames; i++) c.runFrame();
    const r = { t0, t: c.rtcUnix(0), f: c.frames(0), h: c.hash(0) };
    c.close();
    return r;
  };
  const FR = 1800;
  const before = await run('before', FR), after = await run('after', FR), none = await run('none', FR);
  ok('setRtc BEFORE loadRom: frame 0 reads exactly the pinned epoch', before.t0 === pinSec, `${before.t0} vs ${pinSec}`);
  ok('setRtc BEFORE loadRom: after ' + FR + ' frames the clock is the exact FAKE_EPOCH formula', before.t === expectAt(before.f), `${before.t} vs ${expectAt(before.f)} at frame ${before.f}`);
  ok('before-load and after-load order give the same clock readings', before.t0 === after.t0 && before.t === after.t, `before ${before.t0}/${before.t}, after ${after.t0}/${after.t}`);
  ok('before-load and after-load order give the same full-state hash after ' + FR + ' frames', before.h === after.h, `${hex(before.h)} vs ${hex(after.h)}`);
  control('a core that was never pinned reads the host clock, not the pin (the pin checks can fail)', none.t0 !== pinSec && Math.abs(none.t0 - Date.now() / 1000) < 5, `${none.t0}`);
  control('a core that was never pinned has a different full-state hash (the hash comparison can see the clock)', none.h !== before.h, `${hex(none.h)} vs ${hex(before.h)}`);

  // sticky across a second loadRom() and across reset()
  const c = await MgbaCore.create({ seats: 1 });
  c.setRtc(pin); c.loadRom(rom(SOUL)); for (let i = 0; i < 90; i++) c.runFrame();
  c.loadRom(rom(SOUL));
  ok('the pin survives a second loadRom() in the same instance', c.rtcUnix(0) === pinSec, `${c.rtcUnix(0)}`);
  for (let i = 0; i < 600; i++) c.runFrame();
  c.reset();
  ok('the pin survives reset(): the clock restarts at the pinned epoch', c.rtcUnix(0) === pinSec, `${c.rtcUnix(0)}`);
  for (let i = 0; i < 60; i++) c.runFrame();
  ok('and it advances with emulated frames after the reset', c.rtcUnix(0) === expectAt(c.frames(0)), `${c.rtcUnix(0)} at frame ${c.frames(0)}`);

  // a savestate does not carry the clock source: restoring one cannot change the pin
  const donor = await mk(1, SOUL);               // never pinned: its state comes from a host-clock instance
  for (let i = 0; i < 120; i++) donor.runFrame();
  const st = donor.saveState(0); donor.close();
  ok('loadState() of a savestate taken on an UNPINNED instance leaves the pinned instance pinned', c.loadState(0, st) && c.rtcUnix(0) === expectAt(c.frames(0)), `${c.rtcUnix(0)} at frame ${c.frames(0)}`);
  c.setRtc(null);
  ok('setRtc(null) after a pin hands the clock back to the host', Math.abs(c.rtcUnix(0) - Date.now() / 1000) < 5);
  c.close();

  const u = await MgbaCore.create({ seats: 1 });
  u.setRtc(pin); u.setRtc(null); u.loadRom(rom(SOUL));
  ok('setRtc(pin) then setRtc(null) BEFORE loadRom leaves the host clock in force (last call wins)', Math.abs(u.rtcUnix(0) - Date.now() / 1000) < 5 && u.rtcUnix(0) !== pinSec, `${u.rtcUnix(0)}`);
  u.close();

  // every seat of a linked instance gets the pin
  const two = await MgbaCore.create({ seats: 2 });
  two.setRtc(pin); two.loadRom(rom(SOUL));
  ok('2 seats: setRtc BEFORE loadRom pins both seats', two.rtcUnix(0) === pinSec && two.rtcUnix(1) === pinSec, `${two.rtcUnix(0)} / ${two.rtcUnix(1)}`);
  for (let i = 0; i < 120; i++) two.runFrame();
  ok('2 seats: both clocks follow the emulated frames', two.rtcUnix(0) === expectAt(two.frames(0)) && two.rtcUnix(1) === expectAt(two.frames(1)), `${two.rtcUnix(0)} ${two.rtcUnix(1)}`);
  two.close();

  // the natural order in a separate process under a host TZ 14 hours away must equal the in-process after-load run
  const hostTz = process.env.TZ || '(host default)';
  const childSrc = `const M=require(${JSON.stringify(path.join(MGBA, 'mgba_core.js'))});(async()=>{const c=await M.create({seats:1});c.setRtc({fixedEpochMs:${E},tzOffsetMin:-300});c.loadRom(require('fs').readFileSync(${JSON.stringify(path.join(ROMS, SOUL))}));const t0=c.rtcUnix(0);for(let i=0;i<${FR};i++)c.runFrame();console.log(t0,c.rtcUnix(0),c.hash(0));})()`;
  const child = spawnSync(process.execPath, ['-e', childSrc], { env: { ...process.env, TZ: hostTz === 'Pacific/Kiritimati' ? 'UTC' : 'Pacific/Kiritimati' }, encoding: 'utf8' });
  ok('create -> setRtc -> loadRom in another process under a host TZ 14 hours away == the in-process load -> setRtc run (clock AND hash)', child.status === 0 && child.stdout.trim() === `${after.t0} ${after.t} ${after.h}`, `${child.stdout.trim()} | ${after.t0} ${after.t} ${after.h}`);

  // argument validation: a bad pin is refused loudly and leaves the previous pin alone
  const v = await MgbaCore.create({ seats: 1 });
  v.setRtc(pin); v.loadRom(rom(SOUL));
  const throwsRange = (cfg) => { try { v.setRtc(cfg); return false; } catch (e) { return e instanceof RangeError; } };
  const bad = [{ fixedEpochMs: NaN, tzOffsetMin: 0 }, { fixedEpochMs: Infinity }, { tzOffsetMin: 0 }, { fixedEpochMs: '1700000000000' }, { fixedEpochMs: 1e16 }, { fixedEpochMs: E, tzOffsetMin: 2000 }, { fixedEpochMs: E, tzOffsetMin: NaN }];
  const rejected = bad.map(throwsRange);
  ok('setRtc refuses NaN, Infinity, a missing or string epoch, 1e16 ms and a zone beyond +-1440 minutes', rejected.every(Boolean), JSON.stringify(rejected));
  ok('a refused setRtc leaves the previous pin in force', v.rtcUnix(0) === pinSec);
  control('a valid pin (negative epoch, zone omitted = 0) is NOT refused', throwsRange({ fixedEpochMs: -86400000 }) === false);
  v.close();
}

// ---------------------------------------------------------------------------------------------------------------------
async function browserSection() {
  section('browser: the same API through window.MgbaCore on a NON-isolated page (headless Chrome, bare CDP)');
  const { withBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools/headless_cdp.mjs')).href);
  const { spawn } = await import('node:child_process');
  const PORT = Number(process.env.GBA_TEST_PORT || 8092);
  const srv = spawn(process.execPath, [path.join(ROOT, 'tools/devserver.mjs')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`)).ok) break; } catch (_e) { await new Promise((r) => setTimeout(r, 250)); } }
    // Node reference: Kirby, 2 seats, 240 frames, a fixed key pattern, hashes at the end
    const refCore = await mk(2, KIRBY); const keys = (f) => [f % 40 < 20 ? 8 : 0, f % 50 < 25 ? 1 : 0];
    for (let f = 1; f <= 240; f++) { const k = keys(f); refCore.setKeys(0, k[0]); refCore.setKeys(1, k[1]); refCore.runFrame(); }
    const ref = { h0: refCore.hash(0), h1: refCore.hash(1), link: refCore.hashLink(), all: refCore.hashAll() };
    refCore.close();
    let out;
    await withBrowser({ port: 9251, width: 480, height: 320 }, async (page) => {
      await page.navigate(`http://localhost:${PORT}/gba/mgba/dist/mgba_core.buildinfo.json`);
      out = await page.eval(`(async () => {
        const load = (src) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
        await load('/gba/mgba/dist/mgba_core.js'); await load('/gba/mgba/mgba_core.js');
        const o = { isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, hasGlobal: typeof window.MgbaCore === 'object' && typeof window.createMgbaCore === 'function' };
        const bytes = new Uint8Array(await (await fetch('/gba/gbaWasm/roms/' + encodeURIComponent(${JSON.stringify(KIRBY)}))).arrayBuffer());
        const core = await window.MgbaCore.create({ seats: 2 });
        o.info = core.loadRom(bytes);
        const keys = (f) => [f % 40 < 20 ? 8 : 0, f % 50 < 25 ? 1 : 0];
        const t0 = performance.now();
        for (let f = 1; f <= 240; f++) { const k = keys(f); core.setKeys(0, k[0]); core.setKeys(1, k[1]); core.runFrame(); }
        o.msFirst240 = (performance.now() - t0) / 240;
        o.h0 = core.hash(0); o.h1 = core.hash(1); o.link = core.hashLink(); o.all = core.hashAll();
        const cv = document.createElement('canvas'); cv.width = 240; cv.height = 160; const ctx = cv.getContext('2d');
        ctx.putImageData(new ImageData(core.video(0), 240, 160), 0, 0);
        o.pixel = Array.from(ctx.getImageData(120, 80, 1, 1).data);
        const t1 = performance.now(); for (let f = 241; f <= 840; f++) { const k = keys(f); core.setKeys(0, k[0]); core.setKeys(1, k[1]); core.runFrame(); }
        o.msNext600 = (performance.now() - t1) / 600;
        return o;
      })()`);
    });
    ok('page was NOT cross-origin isolated and had no SharedArrayBuffer, and MgbaCore still ran', out.isolated === false && out.sab === 'undefined' && out.hasGlobal, `isolated=${out.isolated} SAB=${out.sab}`);
    ok('window.MgbaCore.create(...).loadRom(...) works from classic <script> tags (Kirby identified)', out.info && out.info.code === 'A7KE');
    ok('Chrome and Node produce the same per-seat state hashes, link hash and whole-instance hash for the same 240-frame key stream', out.h0 === ref.h0 && out.h1 === ref.h1 && out.link === ref.link && out.all === ref.all, `chrome ${hex(out.all)} node ${hex(ref.all)}`);
    ok('video(seat) drew into a canvas through ImageData (alpha 255)', out.pixel && out.pixel[3] === 255);
    const nodeCore = await mk(2, KIRBY); const nk = (f) => [f % 40 < 20 ? 8 : 0, f % 50 < 25 ? 1 : 0];
    for (let f = 1; f <= 240; f++) { const k = nk(f); nodeCore.setKeys(0, k[0]); nodeCore.setKeys(1, k[1]); nodeCore.runFrame(); }
    const tn = performance.now(); for (let f = 241; f <= 840; f++) { const k = nk(f); nodeCore.setKeys(0, k[0]); nodeCore.setKeys(1, k[1]); nodeCore.runFrame(); } const nodeMs = (performance.now() - tn) / 600; nodeCore.close();
    console.log(`       informational (Kirby, 2 linked seats, shared box, desktop - NOT device numbers): headless Chrome ${out.msFirst240.toFixed(3)} ms/frame over the first 240 frames, ${out.msNext600.toFixed(3)} over the next 600; Node ${nodeMs.toFixed(3)} ms/frame over the same 600`);
  } finally { try { srv.kill(); } catch (_e) { /* gone */ } }
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const wasmPath = path.join(DIST, 'mgba_core.wasm'), jsPath = path.join(DIST, 'mgba_core.js');
  const before = { wasm: md5(fs.readFileSync(wasmPath)), js: md5(fs.readFileSync(jsPath)) };
  console.log(`gba_mgba_core_test: wasm md5 ${before.wasm}  js md5 ${before.js}  (soak frames ${SOAK})`);
  console.log(`machine: ${os.cpus().length} logical CPUs, load ${os.loadavg().map((x) => x.toFixed(2)).join('/')} (Windows reports 0; see the CPU % in the report)`);
  if (want('artifact')) await artifactSection();
  if (want('drift')) driftSection();
  if (want('api')) await apiSection();
  if (want('accounting')) await accountingSection();
  if (want('soak')) await soakSection();
  if (want('state')) await stateSection();
  if (want('saves')) await savesSection();
  if (want('memory')) await memorySection();
  if (want('incidents')) await incidentSection();
  if (want('rtc')) await rtcSection();
  if (flag('--browser')) await browserSection();
  section('hash guard');
  const after = { wasm: md5(fs.readFileSync(wasmPath)), js: md5(fs.readFileSync(jsPath)) };
  console.log(`       md5 after : wasm ${after.wasm}  js ${after.js}`);
  ok('wasm and glue unchanged between the start and the end of this run (no torn relink)', before.wasm === after.wasm && before.js === after.js);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

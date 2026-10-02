#!/usr/bin/env node
// rb_sparse_unit_test.mjs — THE SPARSE-SNAPSHOT ROLLBACK LOGIC, AGAINST A STRAIGHT RUN.
//
// n64/N64Wasm/dist/room_core.js (the room driver both realms run; it lived in
// n64/index.html until ec9f66b) saves a frame's start only every K frames (SPARSE SNAPSHOTS)
// and a rollback loads the newest snapshot at or before the earliest wrong
// frame, then re-runs the frames in between on the inputs they ran with. This
// rig runs THAT CODE — the block from `var RB_Q` to the end of rbRunFrame is cut
// out of the shipped room_core.js and evaluated as is — against a mock core whose state
// is a hash chain of every input it ran (so any frame run with the wrong input,
// in the wrong order, from the wrong state, or skipped, changes every state
// after it), driven by a small rollback engine with random input lateness.
//
// It checks, every frame: the PRESENT state equals a straight run's state at
// that frame; every fingerprint the page submits for a confirmed frame k is the
// straight run's state after k; no snapshot is missing; and the slot count
// never exceeds the budget. Arms: K pinned 1/2/4/8, adaptive, a slot budget
// small enough to force thinning, run-ahead on (present saves forced), and a
// capacity-gated DELAY STRETCH in the middle of the room (lsFeed's lockstep
// branch: the ring released, frames run on their final inputs outside it) after
// which rollback resumes and the ring is re-armed at the first rollback frame
// (rbRearm — the page's half of lib/netplay.js opts.rbResume).
//
// USAGE: node n64/tools/rb_sparse_unit_test.mjs [--frames 3000] [--seed 7]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
const FRAMES = +flag('frames', '3000');
const SEED0 = +flag('seed', '7');
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'N64Wasm', 'dist', 'room_core.js'), 'utf8');
const a = html.indexOf('    var RB_Q = new URLSearchParams(env.search);');
const bMark = html.indexOf('    // RUN-AHEAD — the game\'s OWN lag frames');
if (a < 0 || bMark < 0) { console.log('FAIL  could not find the rollback block in n64/N64Wasm/dist/room_core.js'); process.exit(1); }
const SRC0 = html.slice(a, html.lastIndexOf('\n    // ═', bMark));
// MUTATION: the bridge (snapshot -> earliest wrong frame) left out. A rig that
// still passes with it gone is not testing the sparse path at all.
const BRIDGE = 'for (k = s.frame; k < from; k++) {\n        if (!rbStep(';
if (SRC0.indexOf(BRIDGE) < 0) { console.log('FAIL  the bridge loop was not found in rbResim (the rig is out of date)'); process.exit(1); }
let SRC = SRC0;

function mix(h, v) { h = Math.imul(h ^ v, 16777619) >>> 0; return (h ^ (h >>> 13)) >>> 0; }

function runArm(name, opt) {
  let seed = (SEED0 * 2654435761 + opt.salt) >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  // ---- the mock core ----
  const core = { state: 0x12345, pad: 0 };
  const Module = { _neil_ls_run_frame() { core.state = mix(core.state, core.pad); }, _neil_last_fp() { return core.state; } };
  let apiRef = null, lsRef = null;
  const sb = {
    console, Math, Int32Array, Array, Infinity, performance,
    // A slot is new Uint8Array(N64S.size = 8): opt.allocLimit makes the
    // (allocLimit+1)th one throw, the way a full heap/browser refuses it.
    Uint8Array: (function () {
      const U = function (a, b, c) {
        // live slots, not a running total: a freed slot gives its memory back
        if (a === 8 && opt.allocLimit != null && apiRef && apiRef.RB.slots.length >= opt.allocLimit) throw new RangeError('out of memory (mock)');
        return b === undefined ? new Uint8Array(a) : new Uint8Array(a, b, c);
      };
      U.prototype = Uint8Array.prototype; U.BYTES_PER_ELEMENT = 1;
      return U;
    })(),
    lsEngine() { return lsRef; },
    location: { search: opt.query || '' }, URLSearchParams,
    navigator: { deviceMemory: 8 },
    window: { Module, __fbAsync: null, __n64RbLog: null, WebGL2RenderingContext: undefined },
    N64S: { size: 8, fault: null }, N64S_SM: 0,
    n64sRawOk() { return false; }, n64sFree() {},
    n64sSave(dst) { new DataView(dst.buffer, dst.byteOffset).setUint32(0, core.state); return true; },
    n64sLoad(src) { core.state = new DataView(src.buffer, src.byteOffset).getUint32(0); return true; },
    lsApplyImage(img) { let h = 7; for (let i = 0; i < img.length; i++) h = mix(h, img[i]); core.pad = h; return true; },
    lsFrameDone() {}, audioFlushNow() {}, audioDropNow() {}, pageLog() {},
    env: { search: opt.query || '', log() {}, engine() { return lsRef; }, slotCanvas() { return null; }, ringBudgetMB: 600 },
    LS_RB: { saveMs: 0 },
    n64sHashRoom(buf) { return new DataView(buf.buffer, buf.byteOffset).getUint32(0); },
    n64sRoomWords() { return []; }, N64S_FIELDS: [],
    LS: { viHz: 60, frame: 0, baseFrame: 0 }, RA: { frames: opt.ra || 0 },
  };
  sb.window.WebGL2RenderingContext = undefined;
  sb.G = sb.window;
  vm.createContext(sb);
  vm.runInContext(SRC + '\n;this.__api = { rbRunFrame, RB, rbSlot, rbPublishCap, rbRelease };', sb);
  const api = sb.__api; apiRef = api;
  if (opt.budgetSlots) api.RB.cap = opt.budgetSlots;   // re-applied after rbInit below
  // ---- the straight run ----
  const W = opt.window, P = opt.players;
  const truePad = (f, p) => ((Math.floor(f / (3 + p)) * 31 + p * 7 + (rnd() < 0.05 ? 1 : 0)) & 0xff);
  const T = [];                       // true inputs [f][p]
  for (let f = 0; f < FRAMES + W + 2; f++) { const row = []; for (let p = 0; p < P; p++) row.push(truePad(f, p)); T.push(row); }
  // (the first rollback frame after a delay stretch: port 1 changes there, so its
  // repeat-last prediction is wrong — see the arrival schedule below)
  if (opt.delay) T[opt.delay[1]][1] = (T[opt.delay[1] - 1][1] + 101) & 0xff;
  const straight = [0x12345];         // state at the start of frame f
  for (let f = 0; f < FRAMES; f++) { let h = 7; for (let p = 0; p < P; p++) h = mix(h, T[f][p]); straight.push(mix(straight[f], h)); }
  // ---- the engine (port 0 is local; others arrive late, in order) ----
  const arrive = [];                  // arrive[p][f] = frame at which input (f,p) becomes known
  for (let p = 0; p < P; p++) { arrive.push([]); let last = 0; for (let f = 0; f < FRAMES + W + 2; f++) {
    const lat = p === 0 ? 0 : Math.floor(rnd() * (W - 1)); last = Math.max(last, f + lat); arrive[p].push(Math.min(last, f + W - 1)); } }
  // THE SWITCH TO DELAY, as the engine makes it (lib/netplay.js _rbModeHold): the
  // frames up to it run on REAL inputs only, so nothing before the switch is ever
  // corrected after it — here, every input from a window before the switch to the
  // end of the stretch arrives on time.
  if (opt.delay) for (let p = 0; p < P; p++) for (let g = Math.max(0, opt.delay[0] - W - 2); g < opt.delay[1]; g++) arrive[p][g] = Math.min(arrive[p][g], g);
  // ...and the FIRST rollback frame after it, R, is late for port 1 and predicted
  // wrong, so a correction reaches back exactly to R: only a ring re-armed AT R
  // (rbRearm) holds a state to load for it.
  if (opt.delay) { const R = opt.delay[1]; for (let g = R; g < R + 3; g++) arrive[1][g] = Math.max(arrive[1][g], R + 3); }
  const used = [];                    // image the page ran frame f with
  const hashDue = [];
  let confirmed = -1, fails = 0, checked = 0, hashOk = 0, hashBad = 0, maxSlots = 0;
  const imageAt = (f, now) => {
    const img = new Uint8Array(P);
    for (let p = 0; p < P; p++) {
      if (arrive[p][f] <= now) img[p] = T[f][p];
      else { let g = f - 1; while (g >= 0 && arrive[p][g] > now) g--; img[p] = g >= 0 ? T[g][p] : 0; }
    }
    return img;
  };
  const ls = lsRef = {
    rollback: W, hashEvery: opt.hashEvery, frame: 0, selfStepMs: 0, fieldNames: null,
    rbRingFrames() { return W + 4; }, endFrame() {}, fail(why) { fails++; if (fails < 3) console.log('    engine fail: ' + why); },
    takeHashDue() { const q = hashDue.splice(0); return q; },
    submitHash(k, h) { if (h === straight[k + 1]) hashOk++; else { hashBad++; if (hashBad < 4) console.log(`    hash mismatch at confirmed frame ${k}`); } },
  };
  let budgetSet = false;
  const D = opt.delay || null;        // [from, to): a delay stretch (lsFeed's lockstep branch)
  for (let f = 0; f < FRAMES; f++) {
    ls.frame = f;
    if (D && f >= D[0] && f < D[1]) {
      // DELAY LOCKSTEP: the frame runs on its FINAL inputs, outside the ring,
      // exactly as lsFeed does it (lsRunOneFrame; the ring released at the first).
      if (api.RB.ready && !api.RB.stale) { api.rbRelease(); api.RB.stale = true; }
      used[f] = Uint8Array.from(T[f]);
      sb.lsApplyImage(used[f]); Module._neil_ls_run_frame();
      if (core.state !== straight[f + 1]) { console.log(`    DELAY FRAME ${f} differs from the straight run`); fails++; break; }
      checked++;
      // every input before the switch back is held and final (lib/netplay.js _rbResumeAt);
      // the engine's hash queue restarts there
      confirmed = f; hashDue.length = 0;
      continue;
    }
    // earliest frame whose used image is now known to be wrong
    let from = Infinity;
    for (let k = Math.max(0, f - W - 2); k < f; k++) {
      const img = imageAt(k, f);
      const u = used[k];
      let same = true; for (let p = 0; p < P; p++) if (u[p] !== img[p]) { same = false; break; }
      if (!same) { from = k; break; }
    }
    let plan = null;
    if (from < f) {
      const frames = [];
      for (let k = from; k < f; k++) { const img = imageAt(k, f); used[k] = img; frames.push({ frame: k, image: img }); }
      plan = { from, depth: f - from, frames };
    }
    const cur = imageAt(f, f); used[f] = cur;
    const ok = api.rbRunFrame(ls, { frame: f, image: cur, rollback: plan }, false);
    if (!budgetSet && opt.budgetSlots) { api.RB.cap = opt.budgetSlots; api.rbPublishCap('rig budget'); budgetSet = true; }
    if (!ok) { console.log(`    rbRunFrame failed at ${f}`); fails++; break; }
    // The present frame may run on a PREDICTION; the state is comparable with
    // the straight run whenever every frame so far ran on the true input.
    let allTrue = true;
    for (let k = Math.max(0, f - W - 2); k <= f && allTrue; k++) for (let p = 0; p < P; p++) if (used[k][p] !== T[k][p]) { allTrue = false; break; }
    if (allTrue) {
      if (core.state !== straight[f + 1]) { console.log(`    PRESENT STATE differs from the straight run after frame ${f}`); fails++; break; }
      checked++;
    }
    if (api.RB.slots.length > maxSlots) maxSlots = api.RB.slots.length;
    // confirmations: every input of k arrived by now
    while (confirmed + 1 < f) {
      const k = confirmed + 1; let all = true;
      for (let p = 0; p < P; p++) if (arrive[p][k] > f) { all = false; break; }
      if (!all) break;
      confirmed = k;
      if (opt.hashEvery && k % opt.hashEvery === 0) hashDue.push(k);
    }
  }
  const RB = api.RB;
  // THE WINDOW CAP the page tells the engine (rbPublishCap): always slots x K - 4
  // from the CURRENT capacity and K; a refused allocation must LOWER it.
  const wantCap = Math.max(4, RB.cap * Math.max(1, RB.k) - 4);
  const capOk = ls.rbMaxWindow === wantCap && (opt.allocLimit == null || (RB.cap === opt.allocLimit && ls.rbMaxWindow <= Math.max(4, opt.allocLimit * RB.k - 4)));
  if (!capOk) console.log(`    window cap ${ls.rbMaxWindow} != slots ${RB.cap} x K ${RB.k} - 4 = ${wantCap}`);
  const resumed = !D || (RB.rearms === 1 && RB.released === 1 && !RB.stale);
  if (!resumed) console.log(`    delay stretch: released ${RB.released}, re-armed ${RB.rearms}, stale ${RB.stale}`);
  const pass = capOk && !fails && checked + hashOk >= 10 && !hashBad && (RB.missingSlot === 0 || opt.allowMissing) && (!opt.budgetSlots || maxSlots <= opt.budgetSlots)
             && (!opt.hashEvery || hashOk > 0) && RB.rollbacks > 0 && resumed;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}: ${checked} of ${FRAMES} present states comparable, all = straight run; rollbacks ${RB.rollbacks}, `
    + `re-sim ${RB.resimFrames} + bridge ${RB.bridgeFrames} frames; saves ${RB.saves}, skipped ${RB.skippedSaves}; K=${RB.k}; `
    + `slots max ${maxSlots}${opt.budgetSlots ? ' (budget ' + opt.budgetSlots + ', evictions ' + RB.evictions + ')' : ''}; `
    + `fingerprints ${hashOk} ok / ${hashBad} bad; missing ${RB.missingSlot}; window cap ${ls.rbMaxWindow}`
    + (D ? `; delay stretch ${D[0]}-${D[1]}: ring released ${RB.released}, re-armed ${RB.rearms}` : ''));
  return pass;
}

let pass = 0, fail = 0;
SRC = SRC0.replace(BRIDGE, 'for (k = from; k < from; k++) {\n      if (!rbStep(');
console.log('  (mutation: bridge removed — must FAIL)');
const mut = runArm('MUTANT K=4', { query: '?rbk=4', window: 8, players: 2, hashEvery: 10, salt: 3 });
if (mut) { console.log('  FAIL  the mutant passed: this rig cannot see a broken bridge'); fail++; } else { console.log('  PASS  the mutant was caught'); pass++; }
// MUTATION: no re-arm on the return to rollback (the page that never declared
// rbResume). The delay arm must then FAIL — the ring holds nothing to roll back to.
const REARM = '      if (RB.stale) {';
if (SRC0.indexOf(REARM) < 0) { console.log('FAIL  the re-arm guard was not found in rbRunFrame (the rig is out of date)'); process.exit(1); }
SRC = SRC0.replace(REARM, '      if (false) {');
console.log('  (mutation: no re-arm after the delay stretch — must FAIL)');
const mut2 = runArm('MUTANT no rbRearm', { query: '?rbk=4', window: 8, players: 2, hashEvery: 10, delay: [1000, 1300], salt: 11 });
if (mut2) { console.log('  FAIL  the mutant passed: this rig cannot see a missing re-arm'); fail++; } else { console.log('  PASS  the mutant was caught'); pass++; }
SRC = SRC0;
const arms = [
  ['K=1 (every frame, the old ring)', { query: '?rbk=1', window: 8, players: 2, hashEvery: 10, salt: 1 }],
  ['K=2', { query: '?rbk=2', window: 8, players: 2, hashEvery: 10, salt: 2 }],
  ['K=4, 4 players', { query: '?rbk=4', window: 8, players: 4, hashEvery: 10, salt: 3 }],
  ['K=8, window 12', { query: '?rbk=8', window: 12, players: 2, hashEvery: 60, salt: 4 }],
  ['K=16 > hashEvery 10', { query: '?rbk=16', window: 8, players: 3, hashEvery: 10, salt: 5 }],
  ['adaptive K', { query: '', window: 8, players: 2, hashEvery: 10, salt: 6 }],
  ['K=1, slot budget 4 < window (thinning)', { query: '?rbk=1', window: 12, players: 2, hashEvery: 10, budgetSlots: 4, salt: 7 }],
  ['K=3, slot budget 3 (thinning)', { query: '?rbk=3', window: 12, players: 2, hashEvery: 0, budgetSlots: 3, salt: 8 }],
  // The mock engine here does NOT honour the cap (lib/netplay.js does: it
  // shrinks the window or goes to delay), so fingerprints the thinned ring no
  // longer holds are allowed to be skipped in this arm only — exactness is not.
  ['K=2, the heap refuses the 5th slot (cap lowered)', { query: '?rbk=2', window: 8, players: 2, hashEvery: 10, allocLimit: 4, allowMissing: true, salt: 10 }],
  ['K=4 with run-ahead on (present saves forced)', { query: '?rbk=4', window: 8, players: 2, hashEvery: 10, ra: 1, salt: 9 }],
  ['K=4, a delay stretch 1000-1300 then rollback again (rbRearm)', { query: '?rbk=4', window: 8, players: 2, hashEvery: 10, delay: [1000, 1300], salt: 11 }],
  ['adaptive K, a delay stretch 700-760, 4 players', { query: '', window: 8, players: 4, hashEvery: 10, delay: [700, 760], salt: 12 }],
];
for (const [n, o] of arms) { if (runArm(n, o)) pass++; else fail++; }
console.log(`\n[rb-sparse-unit] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

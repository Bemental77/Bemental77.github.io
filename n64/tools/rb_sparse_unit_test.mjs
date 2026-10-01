#!/usr/bin/env node
// rb_sparse_unit_test.mjs — THE SPARSE-SNAPSHOT ROLLBACK LOGIC, AGAINST A STRAIGHT RUN.
//
// n64/index.html saves a frame's start only every K frames (SPARSE SNAPSHOTS)
// and a rollback loads the newest snapshot at or before the earliest wrong
// frame, then re-runs the frames in between on the inputs they ran with. This
// rig runs THAT CODE — the block from `var RB_Q` to the end of rbRunFrame is cut
// out of the shipped page and evaluated as is — against a mock core whose state
// is a hash chain of every input it ran (so any frame run with the wrong input,
// in the wrong order, from the wrong state, or skipped, changes every state
// after it), driven by a small rollback engine with random input lateness.
//
// It checks, every frame: the PRESENT state equals a straight run's state at
// that frame; every fingerprint the page submits for a confirmed frame k is the
// straight run's state after k; no snapshot is missing; and the slot count
// never exceeds the budget. Arms: K pinned 1/2/4/8, adaptive, a slot budget
// small enough to force thinning, and run-ahead on (present saves forced).
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
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const a = html.indexOf('  var RB_Q = new URLSearchParams(location.search);');
const bMark = html.indexOf('  // RUN-AHEAD — the game\'s OWN lag frames');
if (a < 0 || bMark < 0) { console.log('FAIL  could not find the rollback block in n64/index.html'); process.exit(1); }
const SRC0 = html.slice(a, html.lastIndexOf('\n  // ═', bMark));
// MUTATION: the bridge (snapshot -> earliest wrong frame) left out. A rig that
// still passes with it gone is not testing the sparse path at all.
const BRIDGE = 'for (k = s.frame; k < from; k++) {\n      if (!rbStep(';
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
    n64sHashRoom(buf) { return new DataView(buf.buffer, buf.byteOffset).getUint32(0); },
    n64sRoomWords() { return []; }, N64S_FIELDS: [],
    LS: { viHz: 60, frame: 0, baseFrame: 0 }, RA: { frames: opt.ra || 0 },
  };
  sb.window.WebGL2RenderingContext = undefined;
  vm.createContext(sb);
  vm.runInContext(SRC + '\n;this.__api = { rbRunFrame, RB, rbSlot, rbPublishCap };', sb);
  const api = sb.__api; apiRef = api;
  if (opt.budgetSlots) api.RB.cap = opt.budgetSlots;   // re-applied after rbInit below
  // ---- the straight run ----
  const W = opt.window, P = opt.players;
  const truePad = (f, p) => ((Math.floor(f / (3 + p)) * 31 + p * 7 + (rnd() < 0.05 ? 1 : 0)) & 0xff);
  const T = [];                       // true inputs [f][p]
  for (let f = 0; f < FRAMES + W + 2; f++) { const row = []; for (let p = 0; p < P; p++) row.push(truePad(f, p)); T.push(row); }
  const straight = [0x12345];         // state at the start of frame f
  for (let f = 0; f < FRAMES; f++) { let h = 7; for (let p = 0; p < P; p++) h = mix(h, T[f][p]); straight.push(mix(straight[f], h)); }
  // ---- the engine (port 0 is local; others arrive late, in order) ----
  const arrive = [];                  // arrive[p][f] = frame at which input (f,p) becomes known
  for (let p = 0; p < P; p++) { arrive.push([]); let last = 0; for (let f = 0; f < FRAMES + W + 2; f++) {
    const lat = p === 0 ? 0 : Math.floor(rnd() * (W - 1)); last = Math.max(last, f + lat); arrive[p].push(Math.min(last, f + W - 1)); } }
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
  for (let f = 0; f < FRAMES; f++) {
    ls.frame = f;
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
  const pass = capOk && !fails && checked + hashOk >= 10 && !hashBad && (RB.missingSlot === 0 || opt.allowMissing) && (!opt.budgetSlots || maxSlots <= opt.budgetSlots)
             && (!opt.hashEvery || hashOk > 0) && RB.rollbacks > 0;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}: ${checked} of ${FRAMES} present states comparable, all = straight run; rollbacks ${RB.rollbacks}, `
    + `re-sim ${RB.resimFrames} + bridge ${RB.bridgeFrames} frames; saves ${RB.saves}, skipped ${RB.skippedSaves}; K=${RB.k}; `
    + `slots max ${maxSlots}${opt.budgetSlots ? ' (budget ' + opt.budgetSlots + ', evictions ' + RB.evictions + ')' : ''}; `
    + `fingerprints ${hashOk} ok / ${hashBad} bad; missing ${RB.missingSlot}; window cap ${ls.rbMaxWindow}`);
  return pass;
}

let pass = 0, fail = 0;
SRC = SRC0.replace(BRIDGE, 'for (k = from; k < from; k++) {\n      if (!rbStep(');
console.log('  (mutation: bridge removed — must FAIL)');
const mut = runArm('MUTANT K=4', { query: '?rbk=4', window: 8, players: 2, hashEvery: 10, salt: 3 });
if (mut) { console.log('  FAIL  the mutant passed: this rig cannot see a broken bridge'); fail++; } else { console.log('  PASS  the mutant was caught'); pass++; }
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
];
for (const [n, o] of arms) { if (runArm(n, o)) pass++; else fail++; }
console.log(`\n[rb-sparse-unit] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

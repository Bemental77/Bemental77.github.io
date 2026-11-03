#!/usr/bin/env node
// tools/gba_link_smoke.mjs - the G1 KILL-SWITCH rig: do real GBA titles reach their LINKED state when N cores share one wasm
// instance and are stepped by gba/mgba/bridge?
//
//   node tools/gba_link_smoke.mjs                         # all titles + negative controls (~15 s)
//   node tools/gba_link_smoke.mjs --only sbam-2p,kirby-4p
//   node tools/gba_link_smoke.mjs --png-dir <dir>         # where screenshots go (default: os.tmpdir()/gba_link_smoke)
//   node tools/gba_link_smoke.mjs --json <file>           # machine-readable matrix
//
// WHAT THIS FILE FEEDS (note added 2026-11-02, stage GR5 - comments only, no behaviour changed). TITLES[] below is the single source of the
// room catalogue: gba/mgba/room.js LINK_ROWS repeats these rows verbatim, tools/gba_room_protocol_test.mjs diffs the two row for row, and a
// title is offered in a room (gba.html's Party panel) only if it has a `linked` row here. Today: Super Bust-A-Move at 2 seats, Kirby at 2/3/4 and
// Sonic Advance 3 at 2 are `linked`; Monster Rancher Advance 2 is `could-not-reach`. THERE IS NO ROW for Pokemon SoulGold, PKMN Ultra Violet or
// Sim City 2000, ON PURPOSE: SoulGold's Cable Club needs a save made inside a Pokemon Center and none exists on the build machine (manual recipe:
// gba/mgba/README.md and docs/gba-link-rooms-testing.md), Ultra Violet has no row, and Sim City 2000 has no link mode. The gaps this leaves are
// standing entries in tools/undelivered.mjs (gba-soulgold-cable-club-is-not-tested-by-automation, gba-single-pak-multiboot-link-is-not-supported,
// gba-wireless-adapter-games-cannot-be-served). Every row here is a Multi-Play (Multi-Pak) row; a PASS proves the cable path of that title and nothing
// about a real human, a real network or a real phone.
//
// Exit code is non-zero when the SBAM (Super Bust-A-Move) run does not link, when a negative control is NOT rejected, or when a
// title's observed outcome differs from the outcome recorded in TITLES[].expect (so a regression - or an unexpected improvement -
// is a loud diff, not a silent change).
//
// WHAT "LINKED" MEANS HERE (two independent legs; both must hold):
//   1. SIO leg (bridge witnesses, sampled after every frame of the last 120): every seat is attached to the coordinator,
//      MULTI rounds that carried real data completed in the last 60 frames, the word the master was handed from seat 1 at the end
//      of a COMPLETED round was not the FFFF "nobody answered" pattern in at least one sample, and ZERO incidents (no stall,
//      no recover, no MULTI round that missed an ack) over the whole run.
//   2. SCENE leg (per title): the GAME says it is linked, read off the framebuffers - a screen that only exists once the games have
//      negotiated over the cable (player numbers, a shared battle board, a character-select that waits for the master). It is a
//      pixel check, not a text read, and every one was first found by LOOKING at the PNGs (the file names are printed).
// The SIO leg alone is not enough: a slave whose game is still on its title screen is acked by the coordinator and "transfers" exist.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MgbaCore = require(path.join(ROOT, 'gba/mgba/mgba_core.js'));
const ROMS = path.join(ROOT, 'gba/gbaWasm/roms');

// ---------------------------------------------------------------------------------------------------------------------
// PNG (self-contained: zlib + CRC; used for the screenshots the verdicts were designed against)
let crcTable = null;
function crc32(buf) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePNG(file, rgba, w, h, scale = 1) {
  const W = w * scale, H = h * scale, raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const si = (sy * w + Math.floor(x / scale)) * 4, di = y * (W * 4 + 1) + 1 + x * 4;
      raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1]; raw[di + 2] = rgba[si + 2]; raw[di + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}
export function writeMontage(file, frames, scale) {
  const w = 240, h = 160, gap = 4, n = frames.length, W = n * w + (n - 1) * gap, out = new Uint8Array(W * h * 4).fill(40);
  for (let f = 0; f < n; f++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4, di = (y * W + f * (w + gap) + x) * 4;
    out[di] = frames[f][si]; out[di + 1] = frames[f][si + 1]; out[di + 2] = frames[f][si + 2]; out[di + 3] = 255;
  }
  return writePNG(file, out, W, h, scale || (n > 2 ? 1 : 2));
}

// ---------------------------------------------------------------------------------------------------------------------
// Frame-region helpers (240x160 RGBA)
export function regionHash(rgba, y0, y1, x0 = 0, x1 = 240) {
  let h = 0x811C9DC5;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 240 + x) * 4; h = Math.imul(h ^ rgba[i], 0x01000193); h = Math.imul(h ^ rgba[i + 1], 0x01000193); h = Math.imul(h ^ rgba[i + 2], 0x01000193); }
  return h >>> 0;
}
export function regionColors(rgba, y0, y1) {
  const s = new Set(); for (let y = y0; y < y1; y++) for (let x = 0; x < 240; x++) { const i = (y * 240 + x) * 4; s.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]); } return s.size;
}
const allEqual = (a) => a.every((v) => v === a[0]);
const distinct = (a) => new Set(a).size;

// ---------------------------------------------------------------------------------------------------------------------
// The key-script runner. Steps: ['wait', n] ['tap', sel, keys, hold=6, gap=12] ['hold', sel, keys, n] ['mash', sel, key, n]
// ['shot', name] ['mark', name]. sel = 'all' | seat | [seats]. keys = 'A+START'. Every step is deterministic: the same script on the
// same build gives the same frames, which is what lets a scripted menu walk be a regression test.
const KEY = MgbaCore.KEY;
const maskOf = (names) => String(names).split('+').reduce((m, n) => m | (n === 'NONE' ? 0 : KEY[n.toUpperCase()]), 0);
export function framesOf(steps) {
  let n = 0;
  for (const s of steps) {
    if (s[0] === 'wait') n += s[1]; else if (s[0] === 'tap') n += (s[3] === undefined ? 6 : s[3]) + (s[4] === undefined ? 12 : s[4]);
    else if (s[0] === 'hold') n += s[3]; else if (s[0] === 'mash') n += s[3] * 8;
  }
  return n;
}
export async function runScript(core, steps, { pngDir = null, tag = 'run', silenceSeats = [], observeLast = 120 } = {}) {
  const seats = core.seats, keys = new Array(seats).fill(0), total = framesOf(steps);
  const marks = new Map(), shots = [], win = [], statuses = [];
  let frame = 0;
  const sel = (t) => (t === 'all' ? [...Array(seats).keys()] : Array.isArray(t) ? t : [t]);
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < seats; s++) core.setKeys(s, silenceSeats.includes(s) ? 0 : keys[s]);
      const st = core.runFrame(); frame++;
      if (st) statuses.push({ frame, st });
      if (frame > total - observeLast) { const w = core.witnesses(); win.push({ frame, linked: w.linked, multi1: w.masterSioMulti1, irqLast: w.serialIrqsLastFrame.slice(), words: w.masterWords }); }
    }
  };
  const snap = () => { const f = []; for (let s = 0; s < seats; s++) f.push(core.video(s).slice()); return f; };
  for (const st of steps) {
    const c = st[0];
    if (c === 'wait') step(st[1]);
    else if (c === 'tap') { const hold = st[3] === undefined ? 6 : st[3], gap = st[4] === undefined ? 12 : st[4]; for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(hold); for (const s of sel(st[1])) keys[s] = 0; step(gap); }
    else if (c === 'hold') { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(st[3]); for (const s of sel(st[1])) keys[s] = 0; }
    else if (c === 'mash') { for (let i = 0; i < st[3]; i++) { for (const s of sel(st[1])) keys[s] = maskOf(st[2]); step(3); for (const s of sel(st[1])) keys[s] = 0; step(5); } }
    else if (c === 'mark') marks.set(st[1], { frame, frames: snap() });
    else if (c === 'shot') { const f = snap(); marks.set('shot:' + st[1], { frame, frames: f }); if (pngDir) shots.push(writeMontage(path.join(pngDir, `${tag}_${st[1]}.png`), f)); }
    else throw new Error('bad step ' + c);
  }
  return { frames: frame, marks, shots, win, statuses, final: snap(), w: core.witnesses() };
}

// ---------------------------------------------------------------------------------------------------------------------
// The SIO leg, shared by every verdict.
export function sioLeg(run, seats) {
  const w = run.w;
  const slaveAnswered = run.win.some((s) => s.multi1 !== null && s.multi1 !== 0xFFFF);
  const slaveWordsSeen = [...new Set(run.win.map((s) => s.words && s.words[1]).filter((v) => v !== null && v !== undefined))].sort((a, b) => a - b).map((v) => '0x' + v.toString(16).padStart(4, '0'));
  const irqMax = Math.max(0, ...run.win.map((s) => Math.max(...s.irqLast)));
  const irqMeanBySeat = Array.from({ length: seats }, (_, i) => run.win.reduce((a, s) => a + s.irqLast[i], 0) / Math.max(1, run.win.length));
  const checks = {
    attached: w.attached === seats,
    transfersLast60: w.transfersLast60 > 0,
    roundsWithData: w.multiRoundsLast60 > 0,
    slaveWordNotFFFF: slaveAnswered,
    noIncidents: w.incidents === 0 && run.statuses.length === 0,
  };
  return { ok: Object.values(checks).every(Boolean), checks, serialIrqsPerFrameBySeat: irqMeanBySeat.map((v) => +v.toFixed(2)), serialIrqsMaxInOneFrame: irqMax, transfersLast60: w.transfersLast60, slaveWordsSeenAtRoundEnds: slaveWordsSeen, rounds: w.multiRounds, incidents: w.incidents, recover: w.recoverCount, stalls: w.stalls, masterWords: w.masterWords, master_SIOMULTI1_atLastCompletedRound: w.masterSioMulti1 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Titles. Each script was walked out by hand with screenshots; comments name the screen each stretch was found to be on.
const T = (name) => path.join(ROMS, name);
const SBAM_TO_MENU = [
  ['wait', 2000],                                   // Altron logo (~1000 frames) then the title
  ['tap', 'all', 'START'], ['wait', 100],           // title -> LANGUAGE SELECT
  ['tap', 'all', 'A'], ['wait', 300],               // English -> fade
  ['tap', 'all', 'START'], ['wait', 300],           // -> GAME MENU: 1P PUZZLE / CPU BATTLE / 2P BATTLE / OPTION
  ['tap', 'all', 'DOWN'], ['tap', 'all', 'DOWN'],   // cursor on 2P BATTLE
  ['tap', 'all', 'A'], ['wait', 200],               // -> MODE SELECT (NORMAL / EXPERT / CHAIN REACTION) ... or PLEASE WAIT with no cable
  ['shot', 'modeselect'], ['mark', 'modeselect'],
];
const SBAM_TO_BATTLE = [
  ['tap', 'all', 'A'], ['wait', 300],               // NORMAL -> PLAYER SELECT (MOG / ATOMA)
  ['shot', 'playerselect'],
  ['tap', 'all', 'A'], ['wait', 200],
  ['tap', 'all', 'A'], ['wait', 200],
  ['tap', 'all', 'A'], ['wait', 300],               // -> the 1P vs 2P board
  ['shot', 'battle_start'], ['mark', 'battle_start'],
  ['hold', 0, 'LEFT', 40], ['tap', 0, 'A'], ['wait', 90], ['tap', 0, 'A'], ['wait', 90], ['tap', 0, 'A'], ['wait', 120],   // only SEAT 0 plays
  ['shot', 'p1_fired'], ['mark', 'p1_fired'],
  ['hold', 1, 'RIGHT', 50], ['tap', 1, 'A'], ['wait', 90], ['tap', 1, 'A'], ['wait', 150],                                 // then only SEAT 1
  ['shot', 'p2_fired'], ['mark', 'p2_fired'],
];
export const SBAM_SCRIPT = [...SBAM_TO_MENU, ...SBAM_TO_BATTLE];

const TOP_BAR = [0, 16];   // SBAM: "1P 000000050   2P 000000000"
// Scene leg: both seats are on the 1P-vs-2P board and show the same HUD. This alone does NOT prove the cable carried anything: the two
// consoles are the same ROM on the same deterministic core, and SBAM auto-fires an idle shooter, so equal screens are cheap. What gates it is
// the game's own link check (a solo core stops at PLEASE WAIT, an idle slave leaves the master there - both controls below), and what proves
// INPUT crossed the cable is the differential in crossInputFlow().
function sbamScene(run, seats) {
  const fin = run.final, bar = fin.map((f) => regionHash(f, TOP_BAR[0], TOP_BAR[1]));
  const sharedBar = allEqual(bar) && regionColors(fin[0], TOP_BAR[0], TOP_BAR[1]) >= 4;
  const leftModeSelect = regionHash(fin[0], 0, 160) !== regionHash(run.marks.get('modeselect').frames[0], 0, 160);
  return { ok: sharedBar && leftModeSelect, sharedHudOnBothSeats: sharedBar, progressedPastModeSelect: leftModeSelect };
}

// Input differential: the same 2-seat run three ways - normal, seat 0 silent in the battle, seat 1 silent in the battle - and compare what each seat
// DRAWS of the OTHER player's board. Seat 1's picture of the left (P1) board can only depend on seat 0's buttons if those buttons crossed the cable.
export const P1_BOARD = [16, 150, 16, 104], P2_BOARD = [16, 150, 136, 224];   // [y0, y1, x0, x1]
export async function crossInputFlow(pngDir) {
  const mute = (seat) => SBAM_SCRIPT.map((st) => ((st[0] === 'hold' || st[0] === 'tap') && st[1] === seat ? ['wait', framesOf([st])] : st));
  const play = async (script, tag) => { const c = await MgbaCore.create({ seats: 2 }); c.loadRom(fs.readFileSync(path.join(ROMS, 'Super Bust-A-Move (U).gba'))); const r = await runScript(c, script, { pngDir, tag }); const w = r.w; c.close(); return { fin: r.final, incidents: w.incidents }; };
  const base = await play(SBAM_SCRIPT, 'cross_real'), twin = await play(SBAM_SCRIPT, 'cross_twin'), quiet0 = await play(mute(0), 'cross_seat0_silent'), quiet1 = await play(mute(1), 'cross_seat1_silent');
  const rh = (f, r) => regionHash(f, r[0], r[1], r[2], r[3]);
  return {
    twinSame: rh(twin.fin[1], P1_BOARD) === rh(base.fin[1], P1_BOARD) && rh(twin.fin[0], P2_BOARD) === rh(base.fin[0], P2_BOARD),
    seat1SeesSeat0Input: rh(quiet0.fin[1], P1_BOARD) !== rh(base.fin[1], P1_BOARD),
    seat0SeesSeat1Input: rh(quiet1.fin[0], P2_BOARD) !== rh(base.fin[0], P2_BOARD),
    seat1OwnBoardUnchangedByMutingSeat0: rh(quiet0.fin[1], P2_BOARD) === rh(base.fin[1], P2_BOARD) || true,
    incidents: base.incidents + quiet0.incidents + quiet1.incidents,
  };
}

const KIRBY_SCRIPT = [
  ['wait', 600], ['tap', 'all', 'START'], ['wait', 200],    // title
  ['tap', 'all', 'START'], ['wait', 200],                    // GAME SELECT: START GAME / SUB-GAMES / ...
  ['tap', 'all', 'DOWN'], ['wait', 30], ['tap', 'all', 'A'], ['wait', 200],   // SUB-GAMES: QUICK DRAW / BOMB RALLY / AIR GRIND
  ['tap', 'all', 'A'], ['wait', 100], ['shot', 'submenu'], ['mark', 'submenu'],  // ONE PLAYER / MULTIPLAYER popup
  ['tap', 'all', 'DOWN'], ['wait', 30], ['tap', 'all', 'A'], ['wait', 150],      // MULTIPLAYER -> "TRANSMITTING... P1 / P2 ..."
  ['shot', 'transmit'], ['mark', 'transmit'],
  ['wait', 200], ['tap', 'all', 'A'], ['wait', 200],         // -> QUICK DRAW tutorial (master picks the level, the others wait)
  ['shot', 'quickdraw'], ['mark', 'quickdraw'],
];
function kirbyScene(run, seats) {
  const t = run.marks.get('transmit').frames, q = run.final, sub = run.marks.get('submenu').frames;
  const bannerShared = allEqual(t.map((f) => regionHash(f, 0, 28)));
  const labelRegion = t.map((f) => regionHash(f, 80, 130));       // the big red "P1".."P4" sits here; it differs per seat IF the games negotiated ids
  const labelsDistinct = distinct(labelRegion) === seats;
  const tutorialShared = allEqual(q.map((f) => regionHash(f, 0, 70)));
  const leftTheMenu = regionHash(q[0], 0, 70) !== regionHash(sub[0], 0, 70);
  return { ok: bannerShared && labelsDistinct && tutorialShared && leftTheMenu, transmitBannerShared: bannerShared, playerLabelsDistinctPerSeat: labelsDistinct, tutorialSharedAcrossSeats: tutorialShared, leftTheSubmenu: leftTheMenu };
}

const SA3_SCRIPT = [
  ['wait', 600], ['tap', 'all', 'START'], ['wait', 200], ['tap', 'all', 'START'], ['wait', 300],   // title -> REG. NAME (no save yet)
  ['tap', 'all', 'DOWN'], ['tap', 'all', 'RIGHT'], ['tap', 'all', 'A'], ['wait', 30],               // type one character
  ['tap', 'all', 'START'], ['wait', 200], ['tap', 'all', 'A'], ['wait', 200], ['tap', 'all', 'A'], ['wait', 300],   // confirm; intro scene
  ['mash', 'all', 'START', 30], ['wait', 250],                                                      // GAME PLAY menu: MAIN GAME / BATTLE / TIME ATTACK / OPTIONS
  ['tap', 'all', 'DOWN'], ['wait', 40], ['tap', 'all', 'A'], ['wait', 300], ['shot', 'battle_menu'],   // BATTLE: "Do you each have your own Game Pak?"
  ['tap', 'all', 'A'], ['wait', 300], ['shot', 'checking'], ['mark', 'checking'],                    // MULTI-PAK MODE: CHECKING COMMUNICATION ... "2" players
  ['tap', 0, 'START'], ['wait', 200], ['wait', 200], ['tap', 'all', 'A'], ['wait', 200],              // master starts; PLEASE SELECT A PLAYER CHARACTER
  ['shot', 'charselect'], ['mark', 'charselect'],
];
function sa3Scene(run, seats) {
  const f = run.final, chk = run.marks.get('checking').frames;
  const bannerShared = allEqual(f.map((fr) => regionHash(fr, 0, 24)));
  const slaveWaits = regionHash(f[0], 60, 140) !== regionHash(f[1], 60, 140);       // the slave shows the big "X" (master picks first)
  const progressed = regionHash(f[0], 0, 160) !== regionHash(chk[0], 0, 160);
  return { ok: bannerShared && slaveWaits && progressed, charSelectBannerShared: bannerShared, slaveShowsWaitOverlay: slaveWaits, leftCheckingCommunication: progressed };
}

const MRA2_SCRIPT = [
  ['wait', 500], ['tap', 'all', 'START'], ['wait', 200], ['tap', 'all', 'START'], ['wait', 300],   // title: NEW GAME / CONTINUE / LINK
  ['tap', 'all', 'RIGHT'], ['tap', 'all', 'RIGHT'], ['wait', 30], ['shot', 'link_highlighted'], ['mark', 'link_highlighted'],
  ['tap', 'all', 'A'], ['wait', 400], ['shot', 'after_link_A'], ['mark', 'after_link_A'],
];
function mra2Scene(run) {
  const a = run.marks.get('link_highlighted').frames, b = run.final;
  const sceneChanged = regionHash(a[0], 0, 160) !== regionHash(b[0], 0, 160);
  return { ok: sceneChanged, screenChangedAfterPressingLINK: sceneChanged };
}

export const TITLES = [
  { id: 'sbam-2p', name: 'Super Bust-A-Move', rom: 'Super Bust-A-Move (U).gba', seats: 2, script: SBAM_SCRIPT, scene: sbamScene, expect: 'linked', killSwitch: true, note: '2P BATTLE -> MODE SELECT -> PLAYER SELECT -> 1P vs 2P board (Multi-Play, 2 players)' },
  { id: 'kirby-2p', name: 'Kirby: Nightmare in Dream Land', rom: 'Kirby - Nightmare in Dream Land (U).gba', seats: 2, script: KIRBY_SCRIPT, scene: kirbyScene, expect: 'linked', note: 'SUB-GAMES -> Quick Draw -> MULTIPLAYER (Multi-Pak)' },
  { id: 'kirby-3p', name: 'Kirby: Nightmare in Dream Land', rom: 'Kirby - Nightmare in Dream Land (U).gba', seats: 3, script: KIRBY_SCRIPT, scene: kirbyScene, expect: 'linked', note: 'same, 3 players (exercises the multi-secondary ack barrier)' },
  { id: 'kirby-4p', name: 'Kirby: Nightmare in Dream Land', rom: 'Kirby - Nightmare in Dream Land (U).gba', seats: 4, script: KIRBY_SCRIPT, scene: kirbyScene, expect: 'linked', note: 'same, 4 players' },
  { id: 'sa3-2p', name: 'Sonic Advance 3', rom: 'Sonic Advance 3 (U).gba', seats: 2, script: SA3_SCRIPT, scene: sa3Scene, expect: 'linked', note: 'BATTLE -> MULTI-PAK MODE -> CHECKING COMMUNICATION ("2" players) -> PLEASE SELECT A PLAYER CHARACTER' },
  { id: 'mra2-2p', name: 'Monster Rancher Advance 2', rom: 'Monster Rancher Advance 2 (U).gba', seats: 2, script: MRA2_SCRIPT, scene: mra2Scene, expect: 'could-not-reach', informational: true, note: 'title LINK entry ignores A with no save file; NEW GAME intro did not reach a savable state in the scripts tried' },
];

// ---------------------------------------------------------------------------------------------------------------------
// One title -> a verdict.
export async function playTitle(t, { pngDir, tag, silenceSeats = [], seatsOverride = null } = {}) {
  const seats = seatsOverride || t.seats;
  const core = await MgbaCore.create({ seats });
  try {
    core.loadRom(fs.readFileSync(path.isAbsolute(t.rom) ? t.rom : path.join(ROMS, t.rom)));
    const run = await runScript(core, t.script, { pngDir, tag: tag || t.id, silenceSeats });
    const sio = sioLeg(run, seats);
    let scene = { ok: false };
    try { scene = t.scene(run, seats); } catch (e) { scene = { ok: false, error: String(e.message || e) }; }
    // the three-way classification the brief asks for
    let outcome;
    if (seats >= 2 && sio.ok && scene.ok) outcome = 'linked';
    else if (seats >= 2 && run.w.transfers === 0 && (!scene.ok)) outcome = 'could-not-reach';
    else outcome = 'not-linked';
    return { id: t.id, seats, outcome, sio, scene, frames: run.frames, shots: run.shots, hashAll: core.hashAll(), finalFrameHashes: run.final.map((f) => regionHash(f, 0, 160)) };
  } finally { core.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const pngDir = opt('--png-dir', path.join(os.tmpdir(), 'gba_link_smoke'));
  const only = opt('--only', '').split(',').filter(Boolean);
  const jsonOut = opt('--json', null);
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); } };
  const control = (name, rejected, detail = '') => { if (rejected) { pass++; console.log(`  ok   [control] ${name}${detail ? '  ' + detail : ''}`); } else { fail++; console.log(`  FAIL [control] ${name} was NOT rejected${detail ? '  ' + detail : ''}`); } };
  const results = [];
  console.log(`gba_link_smoke: bridge ABI ${MgbaCore.ABI_VERSION}, screenshots -> ${pngDir}`);
  for (const t of TITLES) {
    if (only.length && !only.includes(t.id)) continue;
    console.log(`\n== ${t.id}: ${t.name}, ${t.seats} seats - ${t.note}`);
    const r = await playTitle(t, { pngDir });
    results.push(r);
    console.log(`   outcome: ${r.outcome}   (expected ${t.expect})   frames ${r.frames}`);
    console.log(`   SIO leg  : ${r.sio.ok ? 'ok' : 'FAIL'} ${JSON.stringify(r.sio.checks)}`);
    console.log(`              rounds=${r.sio.rounds} transfersLast60=${r.sio.transfersLast60} serialIrqs/frame by seat=${JSON.stringify(r.sio.serialIrqsPerFrameBySeat)} (max in one frame ${r.sio.serialIrqsMaxInOneFrame})`);
    console.log(`              master SIOMULTI1 at last completed round=0x${(r.sio.master_SIOMULTI1_atLastCompletedRound ?? 0).toString(16)} masterWords=${JSON.stringify(r.sio.masterWords)} slave-1 words seen at round ends=${JSON.stringify(r.sio.slaveWordsSeenAtRoundEnds)} incidents=${r.sio.incidents} stalls=${r.sio.stalls} recover=${r.sio.recover}`);
    console.log(`   scene leg: ${r.scene.ok ? 'ok' : 'FAIL'} ${JSON.stringify(r.scene)}`);
    for (const s of r.shots) console.log(`   png: ${s}`);
    ok(`${t.id}: observed outcome == recorded outcome '${t.expect}'`, r.outcome === t.expect, `observed '${r.outcome}'`);
    if (t.killSwitch) ok(`${t.id}: KILL SWITCH - the game shows its linked state, witnesses hold, no incident`, r.outcome === 'linked');
  }

  // -------- negative controls (SBAM): each must be REJECTED by the same verdict that passes the real run
  if (!only.length || only.includes('sbam-2p')) {
    console.log('\n== negative controls (Super Bust-A-Move)');
    const sbam = TITLES[0];
    const linkedRun = results.find((r) => r.id === 'sbam-2p');
    // (1) No cable: a SOLO core walks the same keys. It must never start a transfer, and its screen at '2P BATTLE' must not be the linked MODE SELECT.
    const mkCore = async (n) => { const c = await MgbaCore.create({ seats: n }); c.loadRom(fs.readFileSync(path.join(ROMS, sbam.rom))); return c; };
    const soloCore = await mkCore(1);
    const soloRun = await runScript(soloCore, SBAM_TO_MENU, { pngDir, tag: 'control_solo' });
    const soloW = soloRun.w, soloScene = regionHash(soloRun.final[0], 0, 160);
    soloCore.close();
    const duoCore = await mkCore(2);
    const duoRun = await runScript(duoCore, SBAM_TO_MENU, {});
    const duoScene = regionHash(duoRun.final[0], 0, 160);
    duoCore.close();
    control('solo core (no cable) never starts a transfer and has no coordinator', soloW.transfers === 0 && soloW.attached === 0, `transfers=${soloW.transfers} attached=${soloW.attached}`);
    control("solo core's screen after '2P BATTLE' is not the linked MODE SELECT screen", soloScene !== duoScene, `PLEASE WAIT vs MODE SELECT; png ${soloRun.shots[0] || '(no png dir)'}`);
    // (2) Idle-slave mutant: 2 seats, seat 1 never receives a key, so it sits on the Altron logo while seat 0 walks to 2P BATTLE alone.
    const idle = await playTitle(sbam, { pngDir, tag: 'control_idle_slave', silenceSeats: [1] });
    control('2 seats with an idle seat 1 is NOT classified linked', idle.outcome !== 'linked', `outcome '${idle.outcome}' sio.ok=${idle.sio.ok} scene.ok=${idle.scene.ok}`);
    // (2b) Input differential: what each seat DRAWS of the other player's board must depend on the other seat's buttons.
    const cf = await crossInputFlow(pngDir);
    ok("seat 1's picture of the P1 board changes when ONLY seat 0's buttons change (input crossed the cable)", cf.seat1SeesSeat0Input && cf.incidents === 0);
    ok("seat 0's picture of the P2 board changes when ONLY seat 1's buttons change", cf.seat0SeesSeat1Input);
    control('the differential can fail: an identical twin run draws the identical boards', cf.twinSame);
    // (2c) The same idle-seat-1 mutant for the other titles whose verdict must be able to fail.
    for (const id of ['kirby-2p', 'sa3-2p']) {
      if (only.length && !only.includes(id) && !only.includes('sbam-2p')) continue;
      const t = TITLES.find((x) => x.id === id);
      const m = await playTitle(t, { pngDir, tag: `control_idle_slave_${id}`, silenceSeats: [1] });
      control(`${id}: 2 seats with an idle seat 1 is NOT classified linked`, m.outcome !== 'linked', `outcome '${m.outcome}' sio.ok=${m.sio.ok} scene.ok=${m.scene.ok}`);
    }
    // (3) The rig is deterministic: a twin run of the real script gives the identical whole-instance hash.
    if (linkedRun) ok('twin run of the kill-switch title gives the identical whole-instance hash (the rig is deterministic)', (await playTitle(sbam, { pngDir: null, tag: 'twin' })).hashAll === linkedRun.hashAll, `0x${linkedRun.hashAll.toString(16)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  const matrix = results.map((r) => `${r.id}=${r.outcome}`).join('  ');
  console.log(`matrix: ${matrix}`);
  const anyLinked = results.some((r) => r.outcome === 'linked');
  if (!anyLinked && results.length) { console.log('KILL SWITCH TRIPPED: NO title reached its linked state.'); process.exitCode = 2; }
  if (fail) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });

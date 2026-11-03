#!/usr/bin/env node
// tools/pokemonarena_savegen.mjs - the RIG that makes REAL SoulGold save files, for pokemonarena's save importer (stage SV1).
//
//   node tools/pokemonarena_savegen.mjs                      # play the new-game intro in the mGBA core, save in-game, write the .sav
//   node tools/pokemonarena_savegen.mjs --out <dir>          # where the .sav / screenshots / oracle json go (default: the SV1 scratch dir)
//   ARENA_ROM=<path> ...                                     # the SoulGold v1.1.1 ROM (default gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba)
//
// WHAT IT DOES. It loads the pinned ROM into the site's own mGBA wasm core (gba/mgba/mgba_core.js, NO emulator is downloaded), pins the
// cartridge clock, and drives the game with scripted key presses through the whole new-game opening: title -> New Game -> Professor Oak's
// speech -> boy -> name "Nova" -> bedroom -> stairs -> kitchen -> New Bark Town -> Elm's lab -> the starter case (9 balls) -> Sprigatito
// -> nickname "Bob" -> START menu -> Pokemon summary pages -> Save. The save is WRITTEN BY THE GAME (exportSave of the core's flash), not by
// this tool: that is the ground truth the importer is tested against. The same scripts are deterministic (same ROM + same keys = same frames).
//
// WHAT IT IS ALSO USED FOR (the other direction): `continueAndCapture({save})` boots the game on an arbitrary save (the importer test's
// ENCODER writes those), presses CONTINUE and photographs the party / summary screens, so the GAME is the judge of whether our encoder's
// bytes read as intended.
//
// NOTHING ROM-DERIVED IS WRITTEN INTO THE REPO: the .sav, the PNGs and the oracle json live in the scratch dir only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG } from './arena_png.mjs';
import { encodeText } from '../pokemonarena/js/charset.js';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROM = process.env.ARENA_ROM || path.join(ROOT, 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba');
export const SCRATCH = process.env.ARENA_SV1_DIR || path.join(os.tmpdir(), 'pokemonarena-sv1'); // cached real save, PNGs, mutants: never inside the repo
const MgbaCore = require(path.join(ROOT, 'gba/mgba/mgba_core.js'));
export const KEY = MgbaCore.KEY;
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const RTC_PIN = { fixedEpochMs: 1700000000000, tzOffsetMin: 0 }; // 2023-11-14 22:13:20 UTC; the town renders at night

// ---- RAM facts found in THIS ROM (all read with core.read16/read32, which are side-effect free) -------------------------------------
export const RAM = Object.freeze({
  saveLoc: 0x03005a80, // IWRAM: {EWRAM pointer, size} pairs: SaveBlock2, SaveBlock1 chunks 0..3, PokemonStorage chunks 0..8 (runtime copy of the ROM layout table)
  sb1Ptr: 0x03005a88, // = the second pair's pointer = SaveBlock1 base (it moves by a few bytes on map changes: always re-read)
  playerCoords: 0x02003324, // ObjectEvent.currentCoords of the player: (x+7, y+7) as s16 pairs
  mapHeader: 0x02003828, // gMapHeader: {layout*, events*, scripts*, connections*, ...}
});
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function readMem(core, addr, len) { const b = Buffer.alloc((len + 3) & ~3); for (let i = 0; i < b.length; i += 4) b.writeUInt32LE(core.read32(0, addr + i), i); return b.subarray(0, len); }

export async function makeCore({ rom, save = null } = {}) {
  const core = await MgbaCore.create({ seats: 1 });
  core.setRtc(RTC_PIN);
  core.loadRom(rom);
  if (save) { if (!core.setSave(0, save)) throw new Error('mgba refused the save (size/type)'); }
  return core;
}

// ---- the key-script interpreter -------------------------------------------------------------------------------------------------------
// tokens: w<N> wait N frames | KEY[@gap] press KEY 5 frames then wait gap (default 20) | KEY*<n>@gap | h:KEY:<N> hold KEY N frames, gap 6
// KEY may be A+B style combos. 'shot:<name>' records a screenshot.
export function makePilot(core, { shotDir = null, log = () => {} } = {}) {
  const shots = {};
  const press = (names, hold = 5, gap = 20) => {
    const m = names.split('+').reduce((a, n) => a | KEY[n], 0);
    core.setKeys(0, m); for (let i = 0; i < hold; i++) core.runFrame();
    core.setKeys(0, 0); for (let i = 0; i < gap; i++) core.runFrame();
  };
  const wait = (n) => { core.setKeys(0, 0); for (let i = 0; i < n; i++) core.runFrame(); };
  const shot = (name, scale = 2) => {
    const rgba = core.video(0).slice();
    shots[name] = { sha256: sha256(rgba), frame: core.frames(0) };
    if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); const f = path.join(shotDir, name + '.png'); writePNG(f, 240 * scale, 160 * scale, scaleUp(rgba, scale)); shots[name].file = f; }
    return shots[name];
  };
  const run = (script) => {
    for (const tok of script.split(/\s+/).filter(Boolean)) {
      let m;
      if ((m = /^w(\d+)$/.exec(tok))) wait(+m[1]);
      else if ((m = /^h:([A-Z+]+):(\d+)$/.exec(tok))) press(m[1], +m[2], 6);
      else if ((m = /^shot:(.+)$/.exec(tok))) shot(m[1]);
      else if ((m = /^([A-Z+]+)(?:\*(\d+))?(?:@(\d+))?$/.exec(tok))) { const n = m[2] ? +m[2] : 1, gap = m[3] ? +m[3] : 20; for (let i = 0; i < n; i++) press(m[1], 5, gap); }
      else throw new Error('savegen: bad token ' + tok);
    }
  };
  return { core, run, press, wait, shot, shots, log };
}
function scaleUp(rgba, k) {
  if (k === 1) return rgba;
  const w = 240, h = 160, out = new Uint8Array(w * k * h * k * 4);
  for (let y = 0; y < h * k; y++) for (let x = 0; x < w * k; x++) { const s = ((y / k | 0) * w + (x / k | 0)) * 4, d = (y * w * k + x) * 4; out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = 255; }
  return out;
}

// ---- walking: map events from the ROM + trial-and-error exploration of what is really walkable ---------------------------------------
// WHY exploration: the map's collision words are not enough (scripts open doors, NPCs stand around, water is "passable" to the bits).
// So the pilot only trusts a tile after it has actually stepped onto it.
const DIRS = { UP: [0, -1], DOWN: [0, 1], LEFT: [-1, 0], RIGHT: [1, 0] };
const tkey = (x, y) => y * 4096 + x;
export function getPos(core) { return { x: (core.read16(0, RAM.playerCoords) << 16 >> 16) - 7, y: (core.read16(0, RAM.playerCoords + 2) << 16 >> 16) - 7 }; }
export function mapWarps(core, rom) {
  const events = core.read32(0, RAM.mapHeader + 4);
  if (events < 0x08000000 || events >= 0x0a000000) return [];
  const e = events - 0x08000000, wc = rom[e + 1], wp = u32(rom, e + 8) - 0x08000000, out = [];
  for (let i = 0; i < wc; i++) { const b = wp + i * 8; out.push({ x: rom.readInt16LE(b), y: rom.readInt16LE(b + 2) }); }
  return out;
}
function mapSize(core, rom) { const lay = core.read32(0, RAM.mapHeader) - 0x08000000; return { w: u32(rom, lay), h: u32(rom, lay + 4) }; }
export function tryStep(core, dir) {
  const p0 = getPos(core); let moved = false;
  for (let f = 0; f < 22; f++) { core.setKeys(0, KEY[dir]); core.runFrame(); const p = getPos(core); if (p.x !== p0.x || p.y !== p0.y) { moved = true; break; } }
  core.setKeys(0, 0); for (let f = 0; f < 17; f++) core.runFrame();
  return moved;
}
function bfsKnown(known, from, goalFn) {
  const q = [from], prev = new Map([[tkey(from.x, from.y), null]]);
  while (q.length) {
    const c = q.shift();
    if (goalFn(c)) { const path = []; let k = tkey(c.x, c.y); while (prev.get(k)) { const p = prev.get(k); path.push(p.dir); k = tkey(p.x, p.y); } return path.reverse(); }
    for (const [dn, [dx, dy]] of Object.entries(DIRS)) { const nx = c.x + dx, ny = c.y + dy, k = tkey(nx, ny); if (prev.has(k) || known.get(k) !== 'ok') continue; prev.set(k, { x: c.x, y: c.y, dir: dn }); q.push({ x: nx, y: ny }); }
  }
  return null;
}
/** Walk to a tile next to `target` (a warp tile) by exploring, then step onto it and wait for the fade. Returns {ok, via}. */
export function enterWarp(core, rom, target, maxSteps = 4000) {
  const warps = new Set(mapWarps(core, rom).map((w) => tkey(w.x, w.y)));
  const { w, h } = mapSize(core, rom);
  const known = new Map(); const start = getPos(core); known.set(tkey(start.x, start.y), 'ok');
  for (let steps = 0; steps < maxSteps; steps++) {
    for (const [dn, [dx, dy]] of Object.entries(DIRS)) {
      if (known.get(tkey(target.x - dx, target.y - dy)) === 'ok') {
        const via = { x: target.x - dx, y: target.y - dy, dir: dn };
        const path = bfsKnown(known, getPos(core), (c) => c.x === via.x && c.y === via.y);
        if (!path) return { ok: false, why: 'unreachable' };
        for (const d of path) if (!tryStep(core, d)) return { ok: false, why: 'walk' };
        core.setKeys(0, KEY[via.dir]); for (let f = 0; f < 60; f++) core.runFrame(); core.setKeys(0, 0);
        for (let f = 0; f < 200; f++) core.runFrame();
        return { ok: true, via };
      }
    }
    let found = null;
    const goal = (c) => { for (const [dn, [dx, dy]] of Object.entries(DIRS)) { const k = tkey(c.x + dx, c.y + dy); if (!known.has(k) && !warps.has(k) && c.x + dx >= 0 && c.y + dy >= 0 && c.x + dx < w && c.y + dy < h) { found = dn; return true; } } return false; };
    const path = bfsKnown(known, getPos(core), goal);
    if (!path) return { ok: false, why: 'exhausted' };
    let abort = false;
    for (const d of path) { const [dx, dy] = DIRS[d]; const p0 = getPos(core); if (!tryStep(core, d)) { known.set(tkey(p0.x + dx, p0.y + dy), 'blocked'); abort = true; break; } }
    if (abort) continue;
    const p = getPos(core), [dx, dy] = DIRS[found], nk = tkey(p.x + dx, p.y + dy);
    if (tryStep(core, found)) { const q = getPos(core); known.set(nk, 'ok'); known.set(tkey(q.x, q.y), 'ok'); } else known.set(nk, 'blocked');
  }
  return { ok: false, why: 'maxSteps' };
}
/** Plain BFS over the ROM collision words (word & 0x0800 = blocked in THIS hack: the metatile id is 11 bits) to a tile, with replanning on a refused step. */
export function walkTo(core, rom, to, maxReplans = 8) {
  const blocked = new Set();
  for (let rp = 0; rp < maxReplans; rp++) {
    const events = core.read32(0, RAM.mapHeader + 4) - 0x08000000, lay = core.read32(0, RAM.mapHeader) - 0x08000000;
    const w = u32(rom, lay), h = u32(rom, lay + 4), mapPtr = u32(rom, lay + 12) - 0x08000000;
    const oc = rom[events], op = u32(rom, events + 4) - 0x08000000, solid = new Set();
    for (let i = 0; i < oc; i++) solid.add(tkey(rom.readInt16LE(op + i * 24 + 4), rom.readInt16LE(op + i * 24 + 6)));
    const from = getPos(core);
    if (from.x === to.x && from.y === to.y) return { ok: true };
    const q = [from], prev = new Map([[tkey(from.x, from.y), null]]); let hit = null;
    while (q.length && !hit) {
      const c = q.shift();
      if (c.x === to.x && c.y === to.y) { hit = c; break; }
      for (const [dn, [dx, dy]] of Object.entries(DIRS)) {
        const nx = c.x + dx, ny = c.y + dy, k = tkey(nx, ny);
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || prev.has(k)) continue;
        const tgt = nx === to.x && ny === to.y;
        if (!tgt && (rom.readUInt16LE(mapPtr + (ny * w + nx) * 2) & 0x0800 || solid.has(k) || blocked.has(k))) continue;
        prev.set(k, { x: c.x, y: c.y, dir: dn }); q.push({ x: nx, y: ny });
      }
    }
    if (!hit) return { ok: false, why: 'nopath' };
    const path = []; let k = tkey(hit.x, hit.y); while (prev.get(k)) { const p = prev.get(k); path.push(p.dir); k = tkey(p.x, p.y); }
    let failed = false;
    for (const d of path.reverse()) { const p0 = getPos(core); if (!tryStep(core, d)) { const [dx, dy] = DIRS[d]; blocked.add(tkey(p0.x + dx, p0.y + dy)); failed = true; break; } }
    if (!failed) { const p = getPos(core); return { ok: p.x === to.x && p.y === to.y }; }
  }
  return { ok: false, why: 'replans' };
}

// ---- THE SCRIPT: new game -> starter -> save -------------------------------------------------------------------------------------------
const rep = (s, n) => Array(n).fill(s).join(' ');
export const INTRO = [
  'w1800', rep('A@60', 6),                       // title screen -> New Game
  rep('A@40 w60', 8),                            // Professor Oak: "Sorry to keep you waiting" ... the Pokemon in the world
  rep('A@40 A@40 w30', 8),                       // ... "do you want to play as" (first choice = the boy) ... "Please tell me your name"
  'A@40 w90',                                    // open the naming keyboard
  'DOWN@16 DOWN@16 RIGHT@16 A@30 RIGHT@16 A@30 DOWN@16 A@30',  // N o v
  'w20 UP@16 UP@16 UP@16 LEFT@16 LEFT@16 A@30 w20 START@30 w20 A@30 w60 A@40 w90', // a, then OK, then "Your name is Nova?" Yes
  rep('A@40 w60', 8),                            // Oak's farewell
  'w200', rep('A@40 w60', 5),
  'w300 A@30 w120 A@30 w120 A@30 w120 DOWN@30 w60 DOWN@30 w60',  // the bedroom
  'w600 A@30 w300 w900 DOWN@40 w120 UP@40 w120 LEFT@40 w120',
  'h:RIGHT:16 h:RIGHT:16 h:RIGHT:32 h:DOWN:32 h:DOWN:32 h:DOWN:32',
  'h:UP:64 h:RIGHT:64 h:UP:48 h:UP:32 h:RIGHT:16 h:UP:16',
  'h:LEFT:16 h:LEFT:16 h:LEFT:16 w60 h:LEFT:16 w120', // down the stairs
  rep('A@40 w60', 8),                            // Mom in the kitchen: Elm was looking for you, Pokegear, Running Shoes
  rep('A@40 A@40 A@40 w30', 6),
  'h:DOWN:32 h:DOWN:32 h:DOWN:32 h:DOWN:32 w120 h:DOWN:32',
  'h:LEFT:16 h:LEFT:16 h:DOWN:32 w90 h:DOWN:32 w60 h:DOWN:32',
  'h:RIGHT:16 w10 h:RIGHT:16 w10 h:DOWN:16 w10 h:DOWN:16 w100',
  'h:LEFT:16 w10 h:DOWN:16 w60 w200 h:DOWN:16 w60',  // the front door -> New Bark Town
  'w120 A@40 w40 A@40 w40 A@40 w40 A@40 w40 A@40 w40 A@40 w40',
];
export const LAB = [
  'w60 h:UP:16 w10 h:UP:16 w10 h:UP:16 w10 h:UP:16 w10 h:UP:16 w10',  // into the lab: Elm starts his speech by himself
  rep('A@40 w30', 8), rep('A@40 w30', 8), rep('A@40 w30', 4), rep('A@40 w60', 4), rep('A@40 w60', 8),
  'A@40 w60 A@40 w60 A@40 w100',
  'h:RIGHT:17 w8 h:UP:17 w8 h:RIGHT:17 w8 h:RIGHT:17 w8 h:DOWN:6 w10 A@40 w60 A@40 w60',  // (the trash can: "It's empty.")
  'h:LEFT:17 w8 h:DOWN:6 w10 A@40 w80 A@40 w80 A@40 w80 A@40 w80',                        // ("the case does not open from this side")
];
// the case opens from below: cursor starts on Chespin (top left); DOWN RIGHT = Sprigatito (dex No. 906, the species the importer must map)
export const PICK = 'DOWN@20 w30 RIGHT@20 w30 A@30 w60 A@30 w100 A@40 w100 RIGHT@20 w20 A@20 w20 DOWN@20 w20 DOWN@20 w20 RIGHT@20 w20 A@20 w20 UP@20 w20 UP@20 w20 LEFT@20 w20 A@20 w20 START@30 w20 A@30 w60 A@30 w60';
export const AFTER_PICK = [rep('A@40 w60', 8), rep('A@40 w60', 8), 'B@40 w60 B@40 w60 START@20 w40'];

/** Summary pages of party slot 1 (the START menu is open). Leaves the START menu open. */
export function summaryShots(pilot, tag = 'sum') {
  pilot.run('A@30 w80');          // Pokemon -> party screen
  pilot.run('A@30 w40');          // slot 1 -> Summary / Item / Pokedex / Cancel
  pilot.run('A@30 w80 shot:' + tag + '_info');
  pilot.run('RIGHT@20 w40 shot:' + tag + '_traits');
  pilot.run('RIGHT@20 w40 shot:' + tag + '_skills');
  pilot.run('A@20 w40 shot:' + tag + '_ivs');
  pilot.run('A@20 w40 shot:' + tag + '_evs');
  pilot.run('A@20 w40');          // back to the stat view
  pilot.run('RIGHT@20 w40 shot:' + tag + '_moves');
  pilot.run('B@30 w40 B@30 w40 B@30 w40');
}

export async function generateRealSave({ rom, shotDir = null, log = () => {} } = {}) {
  const core = await makeCore({ rom });
  const pilot = makePilot(core, { shotDir, log });
  const romBuf = Buffer.from(rom.buffer, rom.byteOffset, rom.byteLength);
  const t0 = Date.now();
  for (const seg of INTRO) pilot.run(seg);
  log('intro done, frame ' + core.frames(0) + ', pos ' + JSON.stringify(getPos(core)));
  const hdrTown = core.read32(0, RAM.mapHeader);
  const warp = enterWarp(core, romBuf, { x: 10, y: 9 });   // New Bark Town: the lab's door
  if (!warp.ok) throw new Error('savegen: could not reach the lab door: ' + JSON.stringify(warp));
  if (core.read32(0, RAM.mapHeader) === hdrTown) throw new Error('savegen: still in the town after the lab warp');
  for (const seg of LAB) pilot.run(seg);
  const w2 = walkTo(core, romBuf, { x: 9, y: 5 });
  if (!w2.ok) throw new Error('savegen: could not walk under the starter case: ' + JSON.stringify(w2));
  pilot.run('w10 UP@30 w60 A@30 w120 ' + PICK);
  for (const seg of AFTER_PICK) pilot.run(seg);
  // (SaveBlock1's RAM address shifts when the game saves, so the starter is located by its nickname bytes "Bob" + 0xFF, not by an offset)
  const ew = readMem(core, 0x02000000, 0x40000), nick = ew.indexOf(Buffer.from([0xbc, 0xe3, 0xd6, 0xff]));
  if (nick < 8) throw new Error('savegen: the starter "Bob" is not in RAM after the pick: the script drifted');
  const ramParty = Buffer.from(ew.subarray(nick - 8, nick + 92)); // the 100-byte party record as the game holds it before saving
  summaryShots(pilot, 'real');
  // SAVE: START menu is open; Save is the 5th entry
  pilot.run('DOWN@16 DOWN@16 DOWN@16 DOWN@16 w10 A@30 w60 shot:save_prompt A@30 w200 A@30 w100 shot:saved');
  const save = core.exportSave(0);
  if (!save || save.length !== 0x20000) throw new Error('savegen: exportSave returned ' + (save && save.length));
  log('real save made in ' + (Date.now() - t0) + ' ms, ' + core.frames(0) + ' frames');
  return { save: Uint8Array.from(save), ramParty, shots: pilot.shots, frames: core.frames(0) };
}


/** With the party screen open (START menu -> Pokemon), photograph Summary pages of party slots `slots` (default 1..n-1; slot 0 is the real starter Bob).
 *  pages: any of 'info','traits','stats','ivs','evs','moves'. An Egg only has its info page, so give it pages ['info'] through `eggPages`.
 *  Returns { shots, frames } (frames = raw 240x160 RGBA per shot name 's<slot>_<page>'). */
export function captureParty(pilot, slots, { pages = ['info', 'stats', 'ivs', 'evs', 'moves'] } = {}) {
  const frames = {};
  const grab = (name) => { pilot.shot(name, 2); frames[name] = pilot.core.video(0).slice(); };
  let cursor = 0;
  for (const slot of slots) {
    while (cursor < slot) { pilot.run('DOWN@30 w40'); cursor++; }
    const want = (p) => pages.includes(p);
    pilot.run('A@30 w40 A@30 w80');
    if (want('info')) grab('s' + slot + '_info');
    if (pages.length > 1 || !want('info')) {
      pilot.run('RIGHT@20 w40'); if (want('traits')) grab('s' + slot + '_traits');
      pilot.run('RIGHT@20 w40'); if (want('stats')) grab('s' + slot + '_stats');
      pilot.run('A@20 w40'); if (want('ivs')) grab('s' + slot + '_ivs');
      pilot.run('A@20 w40'); if (want('evs')) grab('s' + slot + '_evs');
      pilot.run('A@20 w40');
      if (want('moves')) { pilot.run('RIGHT@20 w40'); grab('s' + slot + '_moves'); pilot.run('LEFT@20 w40'); }
      pilot.run('LEFT@20 w40 LEFT@20 w40');
    }
    pilot.run('B@30 w40 B@30 w60');
  }
  return { shots: pilot.shots, frames };
}

/** Boot the game on `save`, press CONTINUE, run `script` (a pilot script) and return the shots. */
export async function continueAndCapture({ rom, save, script, shotDir = null, log = () => {} }) {
  const core = await makeCore({ rom, save });
  const pilot = makePilot(core, { shotDir, log });
  pilot.run('w1800 A@40 w60 shot:menu A@40 w200 shot:loaded');  // title -> menu (CONTINUE is first) -> overworld
  pilot.run(script);
  return { shots: pilot.shots, core, pilot };
}

// ---- THE ENCODER (test-only) -----------------------------------------------------------------------------------------------------------
// Writes chosen Pokemon into a copy of a REAL save and recomputes every checksum, so the real game can be asked (Continue -> Summary
// screens) whether it reads them as intended. It is written WITHOUT importing pokemonarena/js/saveimport.js: its offsets are its own copy,
// so "the game agrees with the encoder" is evidence about the FORMAT, not about the importer agreeing with itself.
export const E = Object.freeze({
  boxBytes: 76, partyBytes: 96, sb1Party: 0x238, sb1PartyCount: 0x234, sb2Name: 0, sb2Gender: 8, sb2Tid: 0x0a, sb2Sid: 0x0c,
  storageBoxes: 4, storageRecord: 76, perBox: 30, boxCount: 15, storageNames: 0x859c, storageTag: 0x87b4, storageCurrent: 0,
  flash: 0x20000, sector: 0x1000, perSlot: 14, signature: 0x08012025,
});
const STAT_ROM = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'];
const w16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const w32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
/** A fixed-width text field: terminated and zero-padded, but a string that exactly FILLS the field has no terminator (as in the game: a 7-letter OT name). */
function encField(str, width) { const bare = encodeText(str, { terminate: false }); return bare.length >= width ? encodeText(str, { terminate: false, width }) : encodeText(str, { terminate: true, width }); }
/** The record layout below is the one the GAME's own code writes (SetBoxMonData, jump tables at ROM 0x7c6a58 / 0x7c6bb0) and that the real game then
 *  displayed correctly (see saveimport_manifest.json "evidence"); this encoder shares NO code or constants with pokemonarena/js/saveimport.js.
 *  m: { pid, tid, sid, nickname, otName, species, item, ball, exp, ppBonuses, friendship, moves[4], pp[4], ev{}, iv{}, abilityNum(0..3), hyper{hp,atk,def,spe,spa,spd},
 *       egg, eggFlagOnly, eggIvOnly, badEgg, noSpecies, language, natureXor (5 bits, default 0), shinyMod, tera, pokerus, metLocation, metLevel, origins, moveHigh[4] (junk in
 *       the 5 spare high bits of each move word), expTop (junk in the top byte of the EXP word), ppFlag[4], level, levelByte (the stored level byte when it should differ from level), hp, maxHp, stats{atk,def,spe,spa,spd}, status }.
 *  party=true adds the 20-byte party tail. */
export function encodeMon(m, { party = false } = {}) {
  const b = new Uint8Array(party ? E.partyBytes : E.boxBytes);
  w32(b, 0, m.pid >>> 0); w32(b, 4, ((m.sid << 16) | m.tid) >>> 0);
  b.set(encField(m.nickname === undefined ? '' : m.nickname, 12), 8);
  b[0x14] = ((m.language === undefined ? 2 : m.language) & 7) | (((m.natureXor || 0) & 31) << 3);
  const egg = m.egg || m.eggFlagOnly;
  b[0x15] = (m.badEgg ? 1 : 0) | (m.noSpecies ? 0 : 2) | (egg ? 4 : 0);
  b.set(encField(m.otName || '', 7), 0x16);
  w16(b, 0x1e, m.shinyMod ? 0x4000 : 0);
  w16(b, 0x20, (m.species & 0x7ff) | ((m.tera || 0) << 11));
  w16(b, 0x22, (m.item & 0x3ff) | ((m.ball || 0) << 10));
  w32(b, 0x24, ((m.exp & 0xffffff) | ((m.expTop || 0) << 24)) >>> 0);
  b[0x2a] = m.ppBonuses || 0; b[0x2b] = m.friendship === undefined ? 70 : m.friendship;
  for (let i = 0; i < 4; i++) { w16(b, 0x2c + i * 2, (m.moves[i] || 0) & 0x7ff | (((m.moveHigh && m.moveHigh[i]) || 0) << 11)); b[0x34 + i] = (m.pp ? m.pp[i] || 0 : 0) & 0x7f; }
  b[0x33] |= ((m.abilityNum || 0) & 3) << 4;
  const hyper = m.hyper || {};
  if (hyper.hp) b[0x33] |= 0x40; if (hyper.atk) b[0x33] |= 0x80; if (hyper.def) b[0x34] |= 0x80; if (hyper.spe) b[0x35] |= 0x80; if (hyper.spa) b[0x36] |= 0x80; if (hyper.spd) b[0x37] |= 0x80;
  if (m.ppFlag) for (let i = 0; i < 4; i++) if (m.ppFlag[i]) b[0x34 + i] |= 0x80;
  STAT_ROM.forEach((k, i) => { b[0x38 + i] = (m.ev && m.ev[k]) || 0; });
  b[0x44] = m.pokerus || 0; b[0x45] = m.metLocation === undefined ? 232 : m.metLocation;
  w16(b, 0x46, m.origins === undefined ? (0x0180 | ((m.metLevel === undefined ? 5 : m.metLevel) & 0x7f)) : m.origins);
  let iv = 0; STAT_ROM.forEach((k, i) => { iv |= ((m.iv[k] & 31) << (i * 5)); });
  if (m.egg || m.eggIvOnly) iv |= 1 << 30; // the game sets BOTH the flag byte bit 2 and IV word bit 30 for an Egg
  w32(b, 0x48, iv >>> 0);
  if (party) {
    b[0x50] = m.levelByte !== undefined ? m.levelByte : m.level; b[0x51] = 0xff; w16(b, 0x52, m.hp); w16(b, 0x54, m.maxHp);
    ['atk', 'def', 'spe', 'spa', 'spd'].forEach((k, i) => w16(b, 0x56 + i * 2, m.stats[k]));
    if (m.status) w32(b, 0x4c, m.status);
  }
  return b;
}
const cksum = (buf, off, size) => { let s = 0; for (let i = 0; i < size; i += 4) s = (s + (buf[off + i] | (buf[off + i + 1] << 8) | (buf[off + i + 2] << 16) | (buf[off + i + 3] << 24))) >>> 0; return ((s >>> 16) + (s & 0xffff)) & 0xffff; };
/** Map section id -> sector index of one slot (encoder-side parse; independent of saveimport.js). */
export function slotMap(sav, slot) {
  const map = new Map(); let counter = null;
  for (let i = 0; i < E.perSlot; i++) {
    const idx = slot * E.perSlot + i, o = idx * E.sector, id = sav[o + 0xff4] | (sav[o + 0xff5] << 8);
    if (id < 14) { map.set(id, idx); counter = (sav[o + 0xffc] | (sav[o + 0xffd] << 8) | (sav[o + 0xffe] << 16) | (sav[o + 0xfff] << 24)) >>> 0; }
  }
  return { map, counter };
}
/** Write bytes into one save block (SaveBlock1: ids 1..4; storage: ids 5..13; offsets from the ROM table) of a slot and fix the checksums. */
export function writeBlock(sav, layout, slot, firstId, lastId, offset, bytes) {
  const { map } = slotMap(sav, slot);
  for (let i = 0; i < bytes.length; i++) {
    const pos = offset + i;
    let id = firstId; while (id < lastId && pos >= layout[id + 1].offset) id++;
    const inner = pos - layout[id].offset;
    if (inner >= layout[id].size) throw new Error('encoder: write beyond the block');
    sav[map.get(id) * E.sector + inner] = bytes[i];
  }
  fixChecksums(sav, layout, slot);
}
export function fixChecksums(sav, layout, slot) {
  const { map } = slotMap(sav, slot);
  for (const [id, idx] of map) { const o = idx * E.sector; w16(sav, o + 0xff6, cksum(sav, o, layout[id].size)); }
}
export function setCounter(sav, slot, counter) { for (let i = 0; i < E.perSlot; i++) w32(sav, (slot * E.perSlot + i) * E.sector + 0xffc, counter >>> 0); }
export function copySlot(sav, from, to) { sav.copyWithin(to * E.perSlot * E.sector, from * E.perSlot * E.sector, (from + 1) * E.perSlot * E.sector); }
export function readLayoutTable(romBuf) { const t = []; for (let id = 0; id < 14; id++) t.push({ offset: romBuf.readUInt16LE(0xf32f6c + id * 4), size: romBuf.readUInt16LE(0xf32f6c + id * 4 + 2) }); return t; }
/** Place party mons (encodeMon(party:true) buffers) into a slot of a copy of `sav`. */
export function withParty(sav, layoutTable, slot, partyBufs) {
  const out = Uint8Array.from(sav);
  const cnt = new Uint8Array(4); w32(cnt, 0, partyBufs.length);
  writeBlock(out, layoutTable, slot, 1, 4, E.sb1PartyCount, cnt);
  partyBufs.forEach((p, i) => writeBlock(out, layoutTable, slot, 1, 4, E.sb1Party + i * E.partyBytes, p));
  return out;
}
export function withBoxMon(sav, layoutTable, slot, box, idx, recBytes) {
  const out = Uint8Array.from(sav);
  writeBlock(out, layoutTable, slot, 5, 13, E.storageBoxes + (box * E.perBox + idx) * E.storageRecord, recBytes);
  return out;
}
/** Tile 240x160 RGBA frames into one PNG (cols wide) for eyeballing. */
export function writeSheet(file, frames, cols = 3, scale = 2) {
  const w = 240 * scale, h = 160 * scale, rows = Math.ceil(frames.length / cols), W = cols * w + (cols - 1) * 4, H = rows * h + (rows - 1) * 4;
  const out = new Uint8Array(W * H * 4).fill(40);
  frames.forEach((f, n) => { const cx = (n % cols) * (w + 4), cy = Math.floor(n / cols) * (h + 4), big = scaleUp(f, scale); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = ((cy + y) * W + cx + x) * 4; out[d] = big[s]; out[d + 1] = big[s + 1]; out[d + 2] = big[s + 2]; out[d + 3] = 255; } });
  fs.mkdirSync(path.dirname(file), { recursive: true }); writePNG(file, W, H, out); return file;
}

// ---- CLI -------------------------------------------------------------------------------------------------------------------------------
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : SCRATCH;
  const rom = fs.readFileSync(DEFAULT_ROM);
  const r = await generateRealSave({ rom, shotDir: path.join(out, 'shots_real'), log: (s) => console.log(s) });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'real_v1.sav'), r.save);
  fs.writeFileSync(path.join(out, 'real_v1.ram_party.bin'), r.ramParty);
  fs.writeFileSync(path.join(out, 'real_v1.json'), JSON.stringify({ sha256: sha256(r.save), frames: r.frames, shots: r.shots }, null, 1));
  console.log('wrote', path.join(out, 'real_v1.sav'), 'sha256', sha256(r.save), 'frames', r.frames);
}

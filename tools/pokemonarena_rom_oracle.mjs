#!/usr/bin/env node
// tools/pokemonarena_rom_oracle.mjs - the REAL-BATTLE ORACLE (stage OR1 of the pokemonarena fidelity work).
//
// It boots Pokemon SoulGold v1.1.1 in the site's own first-party mGBA core (gba/mgba/mgba_core.js + the pinned wasm; nothing is rebuilt,
// downloaded or patched), drives the REAL game into a REAL battle that runs the game's own battle code, and exposes frames, memory and
// controls so the pokemonarena battle can be compared with what the game really does.
//
//   import { openOracle } from './pokemonarena_rom_oracle.mjs';
//   const o = await openOracle({ stateDir });               // boots, pins the clock, loads the cached/derived save
//   await o.goto('CK_ACTION_MENU');                          // a real battle: "What will Bob do?"
//   o.savePng('x.png', { scale: 2 });                        // the game's frame
//   o.readU16(o.findings.gBattleMons.addr + 0x2a);           // Bob's HP in gBattleMons[0]
//
// CLI:   node tools/pokemonarena_rom_oracle.mjs --help
//
// DOCUMENTATION: pokemonarena/ORACLE.md (API, findings with how each was proven, checkpoint list, limits).
//
// RULES THIS FILE FOLLOWS: ROM bytes, save files, frames and states are NEVER written inside the repo; the ROM is read from where the other
// pokemonarena tests find it (ARENA_ROM, else gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba) and everything derived (cached states, PNGs)
// goes to `stateDir` / `outDir` (default: <os.tmpdir()>/pokemonarena-or1, or $ARENA_OR1_DIR). Determinism: the cartridge RTC is pinned
// (setRtc), there is no wall clock, and the guest advances only by runFrame().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writePNG, scaleRGBA } from './arena_png.mjs';
import { decodeText, encodeText } from '../pokemonarena/js/charset.js';   // the Gen-3 text encoding (no ROM content in it)

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROM = process.env.ARENA_ROM || path.join(ROOT, 'gba/gbaWasm/roms/Pokemon SoulGold (v1.1.1).gba');
export const DEFAULT_DIR = process.env.ARENA_OR1_DIR || path.join(os.tmpdir(), 'pokemonarena-or1');
const MGBA_DIR = path.join(ROOT, 'gba/mgba');
export const MgbaCore = require(path.join(MGBA_DIR, 'mgba_core.js'));
export const KEY = MgbaCore.KEY;                                   // A=1 B=2 SELECT=4 START=8 RIGHT=16 LEFT=32 UP=64 DOWN=128 R=256 L=512
export const RTC_PIN = Object.freeze({ fixedEpochMs: 1700000000000, tzOffsetMin: 0 });   // 2023-11-14 22:13:20 UTC (same pin as tools/pokemonarena_savegen.mjs)
export const ROUTE_VERSION = 3;                                    // bump when a route/predicate below changes: invalidates cached states

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const hex = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');

// ---------------------------------------------------------------------------------------------------------------------------------------
// FINDINGS: addresses in THIS ROM (no symbols exist; each was found by the method in `how` and is re-proven by tools/pokemonarena_rom_oracle_test.mjs).
// ---------------------------------------------------------------------------------------------------------------------------------------
export const FINDINGS = ({   // (frozen at the end of the file, after the round-2 additions)
  // Savestate layout of the pinned mGBA (include/mgba/internal/gba/serialize.h of ~/mgba-src, the pinned fork's source tree): offsets into the 0x61000-byte blob.
  blob: Object.freeze({ size: 0x61000, io: 0x400, pal: 0x800, oam: 0xc00, vram: 0x1000, iwram: 0x19000, ewram: 0x21000 }),
  regions: Object.freeze({
    io: { base: 0x04000000, size: 0x400 }, pal: { base: 0x05000000, size: 0x400 }, vram: { base: 0x06000000, size: 0x18000 }, oam: { base: 0x07000000, size: 0x400 },
    iwram: { base: 0x03000000, size: 0x8000 }, ewram: { base: 0x02000000, size: 0x40000 },
  }),
  gMain: { addr: 0x030055c0, callback1: 0, callback2: 4, savedCallback: 8, vblankCallback: 0xc, vblankCounter1: 0x20, heldKeysRaw: 0x28, heldKeys: 0x2c,
    how: 'gMain.heldKeysRaw/heldKeys found by driving 13 different key masks (0, each single key, two combos) from one savestate and intersecting the IWRAM u16 words equal to the mask: exactly 0x030055e8 and 0x030055ec survive; gMain = 0x030055e8 - 0x28 (the Gen-3 field order), and +4 holds a ROM thumb pointer that changes at the battle transition (0x081bcf95 overworld -> 0x0808b099 in battle).' },
  gBattleMons: { addr: 0x02001ecc, stride: 0x98, count: 4,
    fields: { species: 0x00, attack: 0x02, defense: 0x04, speed: 0x06, spAttack: 0x08, spDefense: 0x0a, moves: 0x0c, ivs: 0x14, statStages: 0x18, ability: 0x20, type1: 0x22, type2: 0x23, type3: 0x24, pp: 0x25, hp: 0x2a, level: 0x2c, friendship: 0x2d, maxHP: 0x2e, item: 0x30 },
    how: 'searched EWRAM for the 5-u16 sequence (atk,def,spe,spa,spd) of the starter read out of its party struct; 0x02001ecc has species 1289 + moves 10,39 + hp/maxHP 19, and the foe (species 183) sits exactly 0x98 above; 685 ROM literal-pool words equal 0x02001ecc.' },
  gBattleMainFunc: { addr: 0x03002e64, how: 'BattleMainCB1 (gMain.callback1 = 0x080887f9 in battle) starts `ldr r3,=0x3002e64; ldr r3,[r3]` then calls through r3.' },
  gBattlerControllerFuncs: { addr: 0x03002e44, count: 4, how: 'same function: second pool word 0x03002e44 indexes a 4-entry pointer array by battler.' },
  gDisplayedStringBattle: { addr: 0x0200216c, size: 300, how: 'while "Bob used Scratch!" and then "The opposing Marill used Tail Whip!" were on screen the encoded word "used" (charset.js encodeText) was found in EWRAM at 0x02002170 and 0x02002180 = the string start + 4 and + 20, i.e. one buffer at 0x0200216c; 32 ROM literal-pool words equal it.' },
  gBattleTypeFlags: { addr: 0x02001ab4, how: 'diffed EWRAM between the trainer battle intro and a wild battle intro: 0x02001ab4 is 0x0c (IS_MASTER|TRAINER) vs 0x04 (IS_MASTER); BattleMainCB1 loads this pool word and reads [+4] = gBattlersCount; 555 ROM literal-pool words equal it. Bit values follow the Gen-3 layout (TRAINER = 1<<3, IS_MASTER = 1<<2).' },
  gBattlersCount: { addr: 0x02001ab8, how: 'BattleMainCB1 loads 0x02001ab4 into r6 and reads ldrb r3,[r6,#4] (halfword 0x7933) as its loop bound; the byte at 0x02001ab8 is 2 in both battles; 400 ROM literal-pool words equal 0x02001ab8.' },
  gPlayerParty: { addr: 0x02038f98, stride: 0x60, count: 6, how: 'the 0x60-byte party record of the starter is at 0x02038f98 (level 5, 0xff, hp 19, maxHp 19, stats) and 862 ROM literal-pool words equal it.' },
  gEnemyParty: { addr: 0x02038d58, stride: 0x60, count: 6, how: 'the party struct of the foe (species 183 Lv4 in the trainer battle, species 163 Lv2 in the wild one) sits at 0x02038d58 in both battles, exactly 6*0x60 below gPlayerParty (0x02038f98); 293 ROM literal-pool words equal it. (An earlier guess, gPlayerParty+0x240 = 0x020391d8, was WRONG: that is the first word after the player party.)' },
});

// thumb function pointers observed in THIS ROM (role by observation: the screenshot at the moment the value appeared is named in ORACLE.md)
export const FUNCS = Object.freeze({
  cb2: { overworld: 0x081bcf95, battleInit: 0x0808d581, battleStart: 0x08089069, battleMain: 0x0808b099 },
  battleMain: { intro: 0x0808b9d1, actionSelect: 0x0808f0dd, runTurn: 0x08091125 },
  controller0: { actionMenu: 0x08061b9d, moveMenu: 0x08060ced },
  cb2Party: { loading: 0x0825590d, partyMenu: 0x0824d671 },
});

// ---------------------------------------------------------------------------------------------------------------------------------------
export class Oracle {
  constructor(core, rom, opts) {
    this.core = core; this.rom = rom; this.opts = opts;
    this.stateDir = opts.stateDir; this.outDir = opts.outDir;
    this.findings = FINDINGS; this.KEY = KEY;
    this._heap = null; this._log = opts.log || (() => {});
    this._ck = new Map();                 // checkpoint registry: name -> { build(o) }
    this.romSha256 = sha256(rom); this.saveSha256 = opts.saveBytes ? sha256(opts.saveBytes) : null;
    this.wasmMd5 = md5(fs.readFileSync(path.join(MGBA_DIR, 'dist/mgba_core.wasm')));
  }

  // ------------------------------------------------------------------ clock / input -----------------------------------------------------
  get frame() { return this.core.frames(0); }
  runFrames(n, keys = 0) { const k = this._mask(keys); this.core.setKeys(0, k); for (let i = 0; i < n; i++) this.core.runFrame(); }
  /** hold `keys` (names 'A', 'A+B', 'UP', ... or a mask) for `hold` frames, then release for `gap` frames. */
  press(keys, hold = 5, gap = 20) { this.runFrames(hold, keys); this.runFrames(gap, 0); }
  /** run frames with `keys` held until pred() is true; returns frames run, or throws after maxFrames. */
  runUntil(pred, { maxFrames = 3000, keys = 0, what = 'predicate' } = {}) {
    for (let i = 0; i <= maxFrames; i++) { if (pred()) return i; if (i === maxFrames) break; this.runFrames(1, keys); }
    throw new Error(`runUntil: ${what} not reached in ${maxFrames} frames (frame ${this.frame})`);
  }
  _mask(keys) { if (typeof keys === 'number') return keys & 0x3ff; return String(keys || '').split('+').filter(Boolean).reduce((a, n) => { if (!(n in KEY)) throw new Error('unknown key ' + n); return a | KEY[n]; }, 0); }
  /** the savegen-style key script: w<N> wait | KEY[@gap] press KEY 5f then wait gap (20) | KEY*<n>@gap | h:KEY:<N> hold N frames, gap 6. */
  script(text) {
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      let m;
      if ((m = /^w(\d+)$/.exec(tok))) this.runFrames(+m[1]);
      else if ((m = /^h:([A-Z+]+):(\d+)$/.exec(tok))) this.press(m[1], +m[2], 6);
      else if ((m = /^([A-Z+]+)(?:\*(\d+))?(?:@(\d+))?$/.exec(tok))) { const n = m[2] ? +m[2] : 1, gap = m[3] ? +m[3] : 20; for (let i = 0; i < n; i++) this.press(m[1], 5, gap); }
      else throw new Error('oracle.script: bad token ' + tok);
    }
  }

  // ------------------------------------------------------------------ frames ------------------------------------------------------------
  /** a COPY of the last completed frame: 240*160*4 RGBA bytes. */
  screenshotRGBA() { return this.core.video(0).slice(); }
  frameHash() { return sha256(this.core.video(0)).slice(0, 16); }
  savePng(file, { scale = 1, rgba = null } = {}) {
    const src = rgba || this.core.video(0); const px = scale === 1 ? Uint8Array.from(src) : scaleRGBA(240, 160, src, scale).rgba;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    writePNG(file, 240 * scale, 160 * scale, px); return file;
  }

  // ------------------------------------------------------------------ memory ------------------------------------------------------------
  _region(addr) {
    const a = addr >>> 0;
    if (a >= 0x02000000 && a < 0x02040000) return 'ewram'; if (a >= 0x03000000 && a < 0x03008000) return 'iwram';
    if (a >= 0x04000000 && a < 0x04000400) return 'io'; if (a >= 0x05000000 && a < 0x05000400) return 'pal';
    if (a >= 0x06000000 && a < 0x06018000) return 'vram'; if (a >= 0x07000000 && a < 0x07000400) return 'oam';
    if (a >= 0x08000000 && a < 0x0a000000) return 'rom'; return null;
  }
  /** Where EWRAM / IWRAM live inside the wasm heap (found by matching the savestate; confirmed by a poke that the core's own bus-neutral read32 sees). */
  _locateHeap() {
    if (this._heap) {                                        // cheap re-validation: 4 sampled words per region must equal the core's own bus-neutral read
      const hv = this._heapView(); let good = true;
      for (const name of ['ewram', 'iwram']) { const reg = FINDINGS.regions[name]; for (const k of [0x10, 0x1ff0, 0x2a30, 0x7ff0]) { const off = k % reg.size & ~3; if (hv.readUInt32LE(this._heap[name] + off) !== (this.core.read32(0, reg.base + off) >>> 0)) good = false; } }
      if (good) return this._heap;
      this._heap = null;
    }
    const core = this.core, blobLay = FINDINGS.blob, M = core.M;
    const st = Buffer.from(core.saveState(0)); const heap = Buffer.from(M.HEAPU8.buffer, M.HEAPU8.byteOffset, M.HEAPU8.length);
    const stBuf = M._bgb_state_buf(); const out = {};
    for (const name of ['ewram', 'iwram']) {
      const reg = FINDINGS.regions[name], off = blobLay[name];
      let best = -1, bestScore = -1;
      for (let o = 0; o + 64 <= reg.size; o += 64) { const s = new Set(st.subarray(off + o, off + o + 64)).size; if (s > bestScore) { bestScore = s; best = o; } }
      if (bestScore < 20) throw new Error('oracle: not enough entropy in ' + name + ' to locate it (run more frames first)');
      const win = st.subarray(off + best, off + best + 64); let from = 0, found = null;
      for (;;) {
        const i = heap.indexOf(win, from); if (i < 0) break; from = i + 1;
        const p = i - best; if (p >= stBuf && p < stBuf + blobLay.size) continue;       // the savestate buffer's own copy
        if (Buffer.compare(heap.subarray(p, p + reg.size), st.subarray(off, off + reg.size)) !== 0) continue;
        // confirm: poke one byte that is part of the live region and read it back through the core
        const probe = best + 7, a = reg.base + (probe & ~3); const before = core.read32(0, a);
        heap[p + probe] ^= 0xff; const mid = core.read32(0, a); heap[p + probe] ^= 0xff; const after = core.read32(0, a);
        if (mid !== before && after === before) { found = p; break; }
      }
      if (found === null) throw new Error('oracle: could not locate ' + name + ' in the wasm heap');
      out[name] = found;
    }
    this._heap = out; return out;
  }
  _heapView() { const M = this.core.M; return Buffer.from(M.HEAPU8.buffer, M.HEAPU8.byteOffset, M.HEAPU8.length); }
  readBytes(addr, len) {
    const a = addr >>> 0, reg = this._region(a), out = Buffer.alloc(len);
    if (reg === 'ewram' || reg === 'iwram') {
      const hp = this._locateHeap()[reg]; this._heapView().copy(out, 0, hp + (a - FINDINGS.regions[reg].base), hp + (a - FINDINGS.regions[reg].base) + len); return out;
    }
    if (reg === 'rom') { this.rom.copy(out, 0, a - 0x08000000, a - 0x08000000 + len); return out; }
    if (!reg) throw new RangeError('oracle.readBytes: address ' + hex(a) + ' is not in a GBA memory region');
    const s = a & ~3, e = (a + len + 3) & ~3, tmp = Buffer.alloc(e - s);                // io / palette / vram / oam: the core's bus-neutral reader
    for (let i = 0; i < tmp.length; i += 4) tmp.writeUInt32LE(this.core.read32(0, s + i), i);
    tmp.copy(out, 0, a - s, a - s + len); return out;
  }
  readU8(a) { return this.readBytes(a, 1)[0]; }
  readU16(a) { return this.readBytes(a, 2).readUInt16LE(0); }
  readU32(a) { return this.readBytes(a, 4).readUInt32LE(0); }
  readS8(a) { return this.readBytes(a, 1).readInt8(0); }
  readS16(a) { return this.readBytes(a, 2).readInt16LE(0); }
  /** write bytes. EWRAM/IWRAM: a direct poke into the live RAM (no state round trip, execution is not perturbed). IO/palette/VRAM/OAM: edit the
   *  savestate blob and load it back (the core re-derives its video caches from it). ROM is read-only. */
  writeBytes(addr, bytes) {
    const a = addr >>> 0, reg = this._region(a), b = Buffer.from(bytes);
    if (reg === 'ewram' || reg === 'iwram') {
      const hp = this._locateHeap()[reg], p = hp + (a - FINDINGS.regions[reg].base);
      if (a - FINDINGS.regions[reg].base + b.length > FINDINGS.regions[reg].size) throw new RangeError('oracle.writeBytes: runs past the end of ' + reg);
      b.copy(this._heapView(), p); return;
    }
    if (!reg || reg === 'rom') throw new RangeError('oracle.writeBytes: ' + hex(a) + ' is not writable');
    const st = Buffer.from(this.core.saveState(0)); const off = FINDINGS.blob[reg] + (a - FINDINGS.regions[reg].base);
    b.copy(st, off); if (!this.core.loadState(0, new Uint8Array(st))) throw new Error('oracle.writeBytes: the core refused the edited savestate');
  }
  writeU8(a, v) { this.writeBytes(a, [v & 0xff]); }
  writeU16(a, v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); this.writeBytes(a, b); }
  writeU32(a, v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.writeBytes(a, b); }
  /** Bus-neutral 32-bit read straight from the core (the reference the heap path is checked against). */
  coreRead32(a) { return this.core.read32(0, a >>> 0); }

  // ------------------------------------------------------------------ savestates --------------------------------------------------------
  saveStateBlob() { return this.core.saveState(0); }
  loadStateBlob(b) { const ok = this.core.loadState(0, b instanceof Uint8Array ? b : new Uint8Array(b)); if (!ok) throw new Error('oracle: the core refused the savestate'); return true; }
  hash() { return this.core.hash(0); }

  // ------------------------------------------------------------------ battle readers ----------------------------------------------------
  gMain() { const g = FINDINGS.gMain.addr; return { callback1: this.readU32(g), callback2: this.readU32(g + 4), savedCallback: this.readU32(g + 8), vblankCounter1: this.readU32(g + 0x20) }; }
  battleFuncs() {
    return { mainFunc: this.readU32(FINDINGS.gBattleMainFunc.addr), ctl: [0, 1, 2, 3].map((i) => this.readU32(FINDINGS.gBattlerControllerFuncs.addr + 4 * i)), cb1: this.readU32(FINDINGS.gMain.addr), cb2: this.readU32(FINDINGS.gMain.addr + 4) };
  }
  battleMon(side) {
    const B = FINDINGS.gBattleMons, F = B.fields, a = B.addr + side * B.stride, r = this.readBytes(a, B.stride);
    return {
      addr: a, species: r.readUInt16LE(F.species), attack: r.readUInt16LE(F.attack), defense: r.readUInt16LE(F.defense), speed: r.readUInt16LE(F.speed), spAttack: r.readUInt16LE(F.spAttack), spDefense: r.readUInt16LE(F.spDefense),
      moves: [0, 1, 2, 3].map((i) => r.readUInt16LE(F.moves + 2 * i)), ivsWord: r.readUInt32LE(F.ivs), statStages: [...r.subarray(F.statStages, F.statStages + 8)].map((v) => v), ability: r.readUInt16LE(F.ability),
      type1: r[F.type1], type2: r[F.type2], type3: r[F.type3], pp: [...r.subarray(F.pp, F.pp + 4)], hp: r.readUInt16LE(F.hp), level: r[F.level], friendship: r[F.friendship], maxHP: r.readUInt16LE(F.maxHP), item: r.readUInt16LE(F.item), experience: r.readUInt32LE(0x4c), personality: r.readUInt32LE(0x50), status1: r.readUInt32LE(0x54), status2: r.readUInt32LE(0x58), raw: r,
    };
  }
  /** The text the game's message printer is working on (gDisplayedStringBattle, decoded; \n = line break, {XX} = an undecoded byte). */
  battleText() { return decodeText(this.readBytes(FINDINGS.gDisplayedStringBattle.addr, FINDINGS.gDisplayedStringBattle.size)); }
  inBattle() { return this.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2.battleMain; }

  // ------------------------------------------------------------------ audio -------------------------------------------------------------
  /** Run `frames` video frames (keys held as given) and collect the core's audio. Returns { rate, rates, frames, samples:Float32Array stereo interleaved at `rate`, int16 }. */
  captureAudio(frames, keys = 0) {
    const chunks = [], rates = {}; const k = this._mask(keys); let total = 0;
    for (let f = 0; f < frames; f++) { this.core.setKeys(0, k); this.core.runFrame(); const a = this.core.audio(0); chunks.push(a.samples.slice(0, a.frames * 2)); total += a.frames; rates[a.rate] = (rates[a.rate] || 0) + 1; }
    const int16 = new Int16Array(total * 2); let o = 0; for (const c of chunks) { int16.set(c, o); o += c.length; }
    const rate = Number(Object.entries(rates).sort((x, y) => y[1] - x[1])[0][0]);
    const f32 = new Float32Array(int16.length); for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    return { rate, rates, frames, audioFrames: total, samples: f32, int16 };
  }

  close() { try { this.core.close(); } catch (_e) { /* gone */ } }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
async function loadSave(opts) {
  if (opts.saveBytes) return opts.saveBytes;
  if (opts.savePath) return new Uint8Array(fs.readFileSync(opts.savePath));
  const G = await import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_savegen.mjs')).href);       // the rig that plays the new-game intro and saves in-game
  const cached = path.join(G.SCRATCH, 'real_v1.sav');
  if (fs.existsSync(cached)) return new Uint8Array(fs.readFileSync(cached));
  const rom = fs.readFileSync(opts.romPath || DEFAULT_ROM);
  const r = await G.generateRealSave({ rom, shotDir: null, log: () => {} });
  fs.mkdirSync(G.SCRATCH, { recursive: true }); fs.writeFileSync(cached, r.save); return new Uint8Array(r.save);
}

/** Boot the ROM: { romPath, savePath|saveBytes, stateDir, outDir, rtc, log }. */
export async function openOracle(opts = {}) {
  const romPath = opts.romPath || DEFAULT_ROM;
  if (!fs.existsSync(romPath)) { const e = new Error('oracle: ROM not found at ' + romPath + ' (set ARENA_ROM)'); e.code = 'NO_ROM'; throw e; }
  const rom = fs.readFileSync(romPath);
  const saveBytes = await loadSave({ ...opts, romPath });
  const stateDir = opts.stateDir || DEFAULT_DIR, outDir = opts.outDir || path.join(stateDir, 'out');
  const core = await MgbaCore.create({ seats: 1 });
  core.setRtc(opts.rtc || RTC_PIN);
  core.loadRom(rom);
  if (!core.setSave(0, saveBytes)) throw new Error('oracle: the core refused the save');
  const o = new Oracle(core, rom, { ...opts, romPath, stateDir, outDir, saveBytes });
  return o;
}

// ===================================================================================================================================
// ROUTE + CHECKPOINTS
// ===================================================================================================================================
// The route is the REAL game played with a key script (deterministic: same ROM + same save + same pinned clock = same frames):
//   title -> CONTINUE (the save made by tools/pokemonarena_savegen.mjs: the player's starter, in Elm's lab) -> Elm's two scripted scenes ->
//   out of the lab into New Bark Town -> the scripted TRAINER battle (Trainer Crystal, MARILL Lv4 vs the player's starter Lv5).
// A checkpoint is a savestate blob cached on disk beside a sidecar that names everything it depends on; goto() restores it, or (cache absent
// or stale) replays the route and writes it. Restored runs are deterministic with respect to each other; they are NOT claimed to equal a
// continuing run (gba/mgba/README.md, the hashGame row).

const SAVEGEN = () => import(pathToFileURL(path.join(ROOT, 'tools/pokemonarena_savegen.mjs')).href);

/** Hold `keys` for `hold` frames then release for `gap`, repeatedly, checking pred() EVERY frame; stops on the frame pred() is first true. */
Oracle.prototype.pressUntil = function (keys, pred, { hold = 5, gap = 55, maxFrames = 4000, what = 'predicate' } = {}) {
  const k = this._mask(keys); let n = 0;
  while (!pred()) {
    if (n >= maxFrames) throw new Error(`pressUntil: ${what} not reached in ${maxFrames} frames (frame ${this.frame})`);
    const on = (n % (hold + gap)) < hold; this.core.setKeys(0, on ? k : 0); this.core.runFrame(); n++;
  }
  this.core.setKeys(0, 0); return n;
};

const CK = new Map();   // name -> { parent, doc, build(o, G) }
const ckDef = (name, parent, doc, build) => CK.set(name, { name, parent, doc, build });

// root: the overworld, in Elm's lab, right after CONTINUE
ckDef('CK_OVERWORLD_LAB', null, 'title -> CONTINUE -> overworld in Elm\'s lab (the save point of tools/pokemonarena_savegen.mjs)', async (o) => { o.script('w1800 A@40 w60 A@40 w200 w100'); });
// the route up to the instant the battle transition starts
ckDef('CK_BATTLE_TRANSITION', 'CK_OVERWORLD_LAB', 'overworld, New Bark Town: the frame gMain.callback2 becomes the battle-transition callback (the scripted trainer battle is starting)', async (o) => {
  const G = await SAVEGEN(), core = o.core;
  G.tryStep(core, 'LEFT');                                           // Elm's scene 1 starts when the player moves
  for (let i = 0; i < 16; i++) o.script('A@40 w60');
  const w = G.walkTo(core, o.rom, { x: 6, y: 11 }); if (!w.ok) throw new Error('oracle route: walkTo the lab door failed ' + JSON.stringify(w));
  o.runFrames(60, 'DOWN');                                           // onto the door tile
  for (let i = 0; i < 14; i++) o.script('A@40 w60');                 // the aide's scene (gives an item)
  o.runFrames(90, 'DOWN'); o.runFrames(300);                         // out into New Bark Town; the rival scene starts by itself
  o.pressUntil('A', () => o.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2.battleInit, { what: 'the battle transition' });
});
ckDef('CK_BATTLE_INTRO', 'CK_BATTLE_TRANSITION', 'the battle has been built and the first text box ("PKMN Trainer Crystal would like to battle!") waits for A', async (o) => {
  o.runFrames(150);
  if (!o.inBattle() || o.readU32(FINDINGS.gBattleMainFunc.addr) !== FUNCS.battleMain.intro) throw new Error('oracle route: not at the battle intro prompt (cb2 ' + hex(o.readU32(FINDINGS.gMain.addr + 4)) + ', main ' + hex(o.readU32(FINDINGS.gBattleMainFunc.addr)) + ')');
});
ckDef('CK_ACTION_MENU', 'CK_BATTLE_INTRO', '"What will Bob do?" with the FIGHT/BAG/POKeMON/RUN window, waiting for input (the game\'s HandleInputChooseAction state)', async (o) => {
  o.pressUntil('A', () => o.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.actionMenu, { what: 'the action menu' });
  o.runFrames(30);
});
ckDef('CK_MOVE_MENU', 'CK_ACTION_MENU', 'the move list ("Scratch / Tail Whip", PP 35/35, TYPE/Normal) after choosing Battle (the game\'s HandleInputChooseMove state)', async (o) => {
  o.pressUntil('A', () => o.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.moveMenu, { what: 'the move menu' });
  o.runFrames(25);
});
ckDef('CK_MESSAGE', 'CK_MOVE_MENU', '"Bob used Scratch!" in the text box, the foe\'s HP still full (a move message while the attack is being announced)', async (o) => {
  o.pressUntil('A', () => o.battleText().startsWith('Bob used'), { what: 'the move message' });
  o.runFrames(10);
});
ckDef('CK_HP_DRAINING', 'CK_MOVE_MENU', 'the foe\'s HP bar mid-drain after Bob\'s Scratch: the bar is partly emptied, gBattleMons[1].hp has NOT been updated yet (the game updates it when the drain ends)', async (o) => {
  o.pressUntil('A', () => o.battleText().startsWith('Bob used'), { what: 'the move message' });
  o.runUntil(() => { const f = o.hpBarFill(1); return f !== null && f <= 42 && f >= 30; }, { maxFrames: 400, what: 'a half-drained foe HP bar' });
});
ckDef('CK_PARTY_MENU', 'CK_ACTION_MENU', 'the in-battle party screen (POKeMON chosen in the action menu)', async (o) => {
  o.press('DOWN', 5, 10);
  o.pressUntil('A', () => o.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2Party.partyMenu, { what: 'the party menu' });
  o.runFrames(20);
});

// ---- after the scripted battle: the free overworld, Route 29 and a natural WILD battle (tall grass; the same battle code, no trainer) ----
ckDef('CK_OVERWORLD_FREE', 'CK_ACTION_MENU', 'the scripted battle won (Scratch mashed), its scenes skipped: the player is free in New Bark Town (Bob is Lv6 now)', async (o) => {
  let n = 0;
  while (o.inBattle()) { if (n++ > 8000) throw new Error('oracle route: the scripted battle did not end'); o.core.setKeys(0, (n % 60) < 5 ? KEY.A : 0); o.core.runFrame(); }
  o.core.setKeys(0, 0);
  for (let i = 0; i < 30; i++) o.script('A@40 w60');
  if (o.readU32(FINDINGS.gMain.addr + 4) !== FUNCS.cb2.overworld) throw new Error('oracle route: not back in the overworld (cb2 ' + hex(o.readU32(FINDINGS.gMain.addr + 4)) + ')');
});
ckDef('CK_ROUTE29', 'CK_OVERWORLD_FREE', 'Route 29, standing at the top of a patch of tall grass (walked west out of New Bark Town)', async (o) => {
  const G = await SAVEGEN();
  const r = G.walkTo(o.core, o.rom, { x: 0, y: 13 }); if (!r.ok) throw new Error('oracle route: walkTo the west edge failed ' + JSON.stringify(r));
  o.runFrames(90, 'LEFT'); o.runFrames(120);
});
ckDef('CK_GRASS', 'CK_ROUTE29', 'one step into the tall grass (free overworld, no encounter pending): the base state startBattle() injects its battles from, so the battle background is the grass one', async (o) => {
  o.runFrames(16, 'DOWN'); o.runFrames(4);
  if (o.readU32(FINDINGS.gMain.addr + 4) !== FUNCS.cb2.overworld) throw new Error('oracle route: an encounter started on the first grass step');
});
ckDef('CK_WILD_TRANSITION', 'CK_ROUTE29', 'the frame the battle-transition callback starts for a natural wild encounter in the grass', async (o) => {
  const dirs = ['DOWN', 'DOWN', 'DOWN', 'UP', 'UP', 'UP'], cb2 = () => o.readU32(FINDINGS.gMain.addr + 4);
  for (let i = 0; i < 400; i++) { for (let f = 0; f < 18; f++) { if (cb2() === FUNCS.cb2.battleInit) return; o.runFrames(1, dirs[i % dirs.length]); } }
  throw new Error('oracle route: no wild encounter in 400 grass steps');
});
ckDef('CK_WILD_INTRO', 'CK_WILD_TRANSITION', '"You encountered a wild Hoothoot!" waiting for A (wild battle, no trainer)', async (o) => {
  o.runFrames(150);
  if (!o.inBattle()) throw new Error('oracle route: the wild battle did not start');
});
ckDef('CK_WILD_ACTION_MENU', 'CK_WILD_INTRO', 'wild battle: "What will Bob do?"', async (o) => {
  o.pressUntil('A', () => o.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.actionMenu, { what: 'the wild action menu' });
  o.runFrames(30);
});

/** hpBarInfo(side) -> { fill, y, labelY } (the bar row is tracked through the box's +-1 px bobbing). Number of filled pixels in a battler's HP bar (0..48), read off the CURRENT FRAME (the bar is drawn 48 px wide). side 1 = the foe's box (top left),
 *  0 = the player's box (right). Returns null when the bar is not on screen (an animation hides it). Filled = green/yellow/red; the empty trough is neutral. */
Oracle.prototype.hpBarInfo = function (side) {
  const f = this.core.video(0); const W = side === 1 ? { lx0: 24, lx1: 41, ly0: 20, ly1: 48, x0: 42 } : { lx0: 168, lx1: 184, ly0: 78, ly1: 108, x0: 184 };
  let sy = 0, n = 0;                                  // the yellow-orange "HP" label sits 0.39 px below the bar row: it follows the box when it bobs (+-1 px) so the bar row is tracked, not assumed
  for (let y = W.ly0; y <= W.ly1; y++) for (let x = W.lx0; x <= W.lx1; x++) { const i = (y * 240 + x) * 4; if (f[i] > 200 && f[i + 1] > 150 && f[i + 2] < 110) { sy += y; n++; } }
  if (n < 20) return null;
  const y = Math.floor(sy / n); let fill = 0, trough = 0, color = null;
  // MEASURED bar colours (dark row y / light row y+1): green (0,148,0)/(24,198,33), yellow (181,107,8)/(255,181,0), red (173,49,57)/(255,90,41)
  const DARK = [['green', 0, 148, 0], ['yellow', 181, 107, 8], ['red', 173, 49, 57]];
  for (let x = W.x0; x < W.x0 + 48; x++) {
    const i = (y * 240 + x) * 4, r = f[i], g = f[i + 1], b = f[i + 2]; const hit = DARK.find((d) => Math.abs(r - d[1]) < 14 && Math.abs(g - d[2]) < 14 && Math.abs(b - d[3]) < 14);
    if (hit) { fill++; color = color || hit[0]; } else if (r + g + b > 200) trough++;
  }
  return fill + trough >= 44 ? { fill, y, labelY: sy / n, color } : null;
};
Oracle.prototype.hpBarFill = function (side) { const r = this.hpBarInfo(side); return r ? r.fill : null; };

const CK_LIST = () => [...CK.keys()];
Oracle.prototype.checkpointNames = function () { return CK_LIST(); };
Oracle.prototype.checkpointInfo = function (name) { const d = CK.get(name); if (!d) throw new Error('unknown checkpoint ' + name); return { name, parent: d.parent, doc: d.doc }; };
Oracle.prototype._ckFile = function (name) {
  const key = [this.romSha256.slice(0, 10), (this.saveSha256 || 'nosave').slice(0, 10), this.wasmMd5.slice(0, 10), 'v' + ROUTE_VERSION].join('_');
  return path.join(this.stateDir, key + '__' + name + '.state');
};
Oracle.prototype._ckCached = function (name) {
  const f = this._ckFile(name); if (!fs.existsSync(f) || !fs.existsSync(f + '.json')) return null;
  const blob = fs.readFileSync(f), side = JSON.parse(fs.readFileSync(f + '.json', 'utf8'));
  if (blob.length !== FINDINGS.blob.size || md5(blob) !== side.md5) return null;      // truncated or tampered cache: rebuild
  return { blob, side };
};
/** Restore the named checkpoint (from the on-disk cache, else by replaying the route and writing the cache). Returns { name, frame, hash, cached }. */
Oracle.prototype.goto = async function (name, { rebuild = false } = {}) {
  const def = CK.get(name); if (!def) throw new Error('unknown checkpoint ' + name + ' (known: ' + CK_LIST().join(', ') + ')');
  if (!rebuild) { const c = this._ckCached(name); if (c) { this.loadStateBlob(c.blob); this.runFrames(1); return { name, frame: this.frame, hash: this.hash(), cached: true, blobFrame: c.side.frame }; } }
  if (def.parent) await this.goto(def.parent, { rebuild: false });
  else if (this.frame !== 0) { this.core.reset(); this._heap = null; if (this.frame !== 0) throw new Error('oracle: reset did not return to frame 0'); }
  const t0 = Date.now();
  await def.build(this);
  const blob = Buffer.from(this.saveStateBlob()); fs.mkdirSync(this.stateDir, { recursive: true });
  const f = this._ckFile(name), tmp = (x) => x + '.tmp' + process.pid;   // atomic writes: several agents may share one cache dir; a torn read fails the md5 check and rebuilds
  fs.writeFileSync(tmp(f), blob); fs.renameSync(tmp(f), f);
  fs.writeFileSync(tmp(f + '.json'), JSON.stringify({ name, parent: def.parent, doc: def.doc, frame: this.frame, md5: md5(blob), sha256: sha256(blob), routeVersion: ROUTE_VERSION, rom: this.romSha256, save: this.saveSha256, wasm: this.wasmMd5, buildMs: Date.now() - t0 }, null, 1)); fs.renameSync(tmp(f + '.json'), f + '.json');
  this.loadStateBlob(blob); this.runFrames(1);   // continue from the restored copy (+1 frame, so the video buffer is valid): a fresh build and a cache hit are the same machine
  return { name, frame: this.frame, hash: this.hash(), cached: false, blobFrame: this.frame - 1 };
};

/** Tile 240x160 RGBA frames into one PNG (cols wide, integer scale) - for eyeballing real-vs-arena or a frame sequence. */
Oracle.prototype.sheetPng = function (file, frames, { cols = 3, scale = 1, gap = 4 } = {}) {
  const w = 240 * scale, h = 160 * scale, rows = Math.ceil(frames.length / cols), W = cols * w + (cols - 1) * gap, H = rows * h + (rows - 1) * gap;
  const out = new Uint8Array(W * H * 4).fill(40); for (let i = 3; i < out.length; i += 4) out[i] = 255;
  frames.forEach((f, n) => {
    const cx = (n % cols) * (w + gap), cy = Math.floor(n / cols) * (h + gap);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (((y / scale) | 0) * 240 + ((x / scale) | 0)) * 4, d = ((cy + y) * W + cx + x) * 4; out[d] = f[s]; out[d + 1] = f[s + 1]; out[d + 2] = f[s + 2]; out[d + 3] = 255; }
  });
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); writePNG(file, W, H, out); return file;
};

// ===================================================================================================================================
// CLI
// ===================================================================================================================================
const HELP = `pokemonarena ROM oracle (stage OR1) - boots SoulGold in the site's mGBA core and drives the REAL battle code.

  node tools/pokemonarena_rom_oracle.mjs list                         the checkpoints
  node tools/pokemonarena_rom_oracle.mjs findings                     the addresses found in this ROM (JSON)
  node tools/pokemonarena_rom_oracle.mjs goto CK_ACTION_MENU [options]
  node tools/pokemonarena_rom_oracle.mjs status                       goto nothing: boot the cache dir state report

options for goto:
  --dir <stateDir>       cached savestates (default $ARENA_OR1_DIR or <tmp>/pokemonarena-or1; rebuilt automatically when absent)
  --png <file> [--scale N]   write the frame after the checkpoint (and after --script / --frames)
  --script "<keys>"      then play a key script: w<N> wait | KEY[@gap] press (A, B, UP, ... A+B) | KEY*<n>@gap | h:KEY:<N> hold
  --frames N             then run N idle frames
  --peek <addr>[:<len>]  then hex-dump memory (default len 16); repeatable
  --battle               then print gBattleMons[0..1], the battle text, the controller functions
  ARENA_ROM=<path> overrides the ROM; ARENA_OR1_DIR the cache directory.  Nothing ROM-derived is ever written in the repo.`;

async function cli(argv) {
  const cmd = argv[0]; const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const all = (n) => argv.reduce((a, v, i) => (v === n ? [...a, argv[i + 1]] : a), []);
  if (!cmd || cmd === '--help' || cmd === 'help' || cmd === '-h') { console.log(HELP); return 0; }
  if (cmd === 'list') { for (const [n, d] of CK) console.log(n.padEnd(22), (d.parent || '(boot)').padEnd(22), d.doc); return 0; }
  if (cmd === 'findings') { console.log(JSON.stringify({ FINDINGS, FUNCS }, (k, v) => (typeof v === 'number' && v > 0xffff ? hex(v) : v), 1)); return 0; }
  const o = await openOracle({ stateDir: opt('--dir', undefined) });
  if (cmd === 'goto') {
    const name = argv[1]; const r = await o.goto(name);
    console.log(JSON.stringify({ checkpoint: r, stateDir: o.stateDir, wasmMd5: o.wasmMd5, romSha256: o.romSha256 }));
    if (opt('--script')) o.script(opt('--script'));
    if (opt('--frames')) o.runFrames(+opt('--frames'));
    for (const p of all('--peek')) { const [a, l] = p.split(':'); const addr = parseInt(a, 16), len = +(l || 16); const b = o.readBytes(addr, len); for (let i = 0; i < len; i += 16) console.log(hex(addr + i) + ' ' + [...b.subarray(i, Math.min(len, i + 16))].map((v) => v.toString(16).padStart(2, '0')).join(' ')); }
    if (argv.includes('--battle')) { for (const s of [0, 1]) { const m = o.battleMon(s); delete m.raw; console.log('gBattleMons[' + s + ']', JSON.stringify(m)); } console.log('text', JSON.stringify(o.battleText().slice(0, 80)), 'funcs', JSON.stringify(o.battleFuncs(), (k, v) => (typeof v === 'number' ? hex(v) : v))); }
    if (opt('--png')) console.log('wrote', o.savePng(opt('--png'), { scale: +opt('--scale', 1) }));
    o.close(); return 0;
  }
  console.error('unknown command ' + cmd); console.log(HELP); return 2;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) cli(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.stack || e); process.exit(1); });

// ===================================================================================================================================
// SCENARIO CONTROL: put chosen Pokemon into the REAL game's battle
// ===================================================================================================================================
/** The arena's data pack decoded from the ROM (species base stats, gender ratios, moves ...): lazy, only for the conveniences below. */
Oracle.prototype.pack = async function () {
  if (!this._pack) { const T = await import(pathToFileURL(path.join(ROOT, 'pokemonarena/js/tables.js')).href); this._pack = T.loadPack(this.rom); }
  return this._pack;
};
/** Gen-3 personality value from a desired gender / shininess. genderRatio: the species byte (0 male only .. 254 female only, 255 genderless; 127 = 50/50).
 *  Shiny = tid ^ sid ^ pid.hi ^ pid.lo below 256 (MEASURED on one tid/sid/lo: 0..255 shiny, 256.. normal; it is not the Gen-3 '< 8'). The hack's own flag (shinyMod: true) also renders shiny. `seed` varies the low half. */
export function pidFor({ tid, sid, genderRatio = 127, gender = 'M', shiny = false, seed = 0x1234 }) {
  let lo = seed & 0xffff;
  for (let i = 0; i < 0x10000; i++, lo = (lo + 1) & 0xffff) {
    if (genderRatio === 255) break;
    const female = (lo & 0xff) < genderRatio; if ((gender === 'F') === female) break;
  }
  const hi = (tid ^ sid ^ lo ^ (shiny ? 0 : 0x100)) & 0xffff;   // MEASURED (one tid/sid/lo): xor 0..255 render SHINY (yellow healthbox, gold sprite), xor 256 and above render normal: the rule is not the Gen-3 "< 8"
  return ((hi << 16) | lo) >>> 0;
}
const DEFAULT_OT = Object.freeze({ tid: 0x2ded, sid: 0xa7e3, otName: 'Nova' });
/** monSpec -> the 0x60-byte party struct the game keeps in RAM (plain, not encrypted - same layout as the .sav records; the encoder is the one in
 *  tools/pokemonarena_savegen.mjs that the real game was shown to read correctly). Required: species, level, moves. hp/maxHp default to a round stat set unless `stats` is given. */
Oracle.prototype.monBytes = async function (m) {
  const G = await SAVEGEN();
  const s = { ...DEFAULT_OT, nickname: '', ball: 1, friendship: 70, item: 0, ev: {}, iv: { hp: 15, atk: 15, def: 15, spe: 15, spa: 15, spd: 15 }, ...m };
  if (!s.species || !s.level || !s.moves) throw new Error('monBytes: species, level and moves are required');
  if (s.nickname === '') { const pk = await this.pack(); s.nickname = (pk.species[s.species] || {}).name || ''; }   // the game prints the NICKNAME field as the name, so an empty one shows no name
  s.moves = [...s.moves, 0, 0, 0, 0].slice(0, 4); s.pp = s.pp || s.moves.map((mv) => (mv ? 35 : 0));
  s.stats = { atk: 20, def: 20, spe: 20, spa: 20, spd: 20, ...(s.stats || {}) };
  s.maxHp = s.maxHp !== undefined ? s.maxHp : (s.hp !== undefined ? s.hp : 30); s.hp = s.hp !== undefined ? s.hp : s.maxHp;
  if (s.pid === undefined) s.pid = pidFor({ tid: s.tid, sid: s.sid, genderRatio: s.genderRatio, gender: s.gender, shiny: !!s.shinyPid });
  if (s.exp === undefined) s.exp = 0;
  return Buffer.from(G.encodeMon(s, { party: true }));
};
const PARTY = () => FINDINGS;
/** Begin a REAL battle of the game's own code from a free overworld state: write the foe party (and optionally the player's lead), clear the battle-type flags
 *  (wild) or set TRAINER, point gMain.callback2 at CB2_InitBattle and let the game build the battle itself (sprites, healthboxes, text).
 *  { foe: monSpec | [monSpec], player?: monSpec | [monSpec] (replaces the whole party), trainer?: false, base?: 'CK_GRASS', reach?: 'intro'|'action' }. The battle background follows the tile the player
 *  stands on (the game derives it inside CB2_InitBattle), so `base` decides it. Returns { frames, text }. */
Oracle.prototype.startBattle = async function ({ foe, player = null, trainer = false, terrain, base = 'CK_GRASS', reach = 'intro' } = {}) {
  if (!foe && trainer !== 'game') throw new Error('startBattle: foe is required (or trainer: "game")');
  const foes = foe ? (Array.isArray(foe) ? foe : [foe]) : [];
  const fb = []; for (const f of foes) fb.push(await this.monBytes(f));
  const pbs = []; if (player) for (const m of (Array.isArray(player) ? player : [player])) pbs.push(await this.monBytes(m));
  await this.goto(base);
  const P = FINDINGS.gPlayerParty, E = FINDINGS.gEnemyParty;
  if (trainer !== 'game') { this.writeBytes(E.addr, Buffer.alloc(E.stride * E.count)); fb.forEach((b, i) => this.writeBytes(E.addr + i * E.stride, b)); }   // trainer:'game' = leave the foe party to the game (it builds it from the trainer id still in RAM)
  if (pbs.length) { this.writeBytes(P.addr, Buffer.alloc(P.stride * P.count)); pbs.forEach((b, i) => this.writeBytes(P.addr + i * P.stride, b)); }   // an array replaces the WHOLE party (the game counts the non-empty slots when it builds the battle)
  this.writeU32(FINDINGS.gBattleTypeFlags.addr, trainer ? 8 : 0);
  this.writeU32(FINDINGS.gMain.addr + 4, FUNCS.cb2.battleInit);
  this.writeU8(FINDINGS.gMain.addr + 0x438, 0);
  let n = 0;   // terrain: the game overwrites gBattleTerrain inside the init, so it is held at the wanted value for the first 80 frames (measured: a write before the init is lost)
  for (; n < 900; n++) {
    if (terrain !== undefined && n < 80) this.writeU8(FINDINGS.gBattleTerrain.addr, terrain);
    if (this.inBattle() && this.readU32(FINDINGS.gBattleMainFunc.addr) === FUNCS.battleMain.intro && this.battleMon(1).species !== 0) break;
    this.runFrames(1);
  }
  if (n >= 900) throw new Error('startBattle: the injected battle did not reach its intro');
  this.runFrames(30);
  if (reach === 'action') this.pressUntil('A', () => this.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.actionMenu, { what: 'the action menu' }), this.runFrames(30);
  return { frames: n + 30, text: this.battleText() };
};

// ---- setBattleMon: write gBattleMons[side] directly (mechanics scenarios; the healthbox is NOT redrawn - use startBattle() for anything you will photograph) ----
// Offsets proven by changing one party field at a time and diffing the battle struct (see ORACLE.md "gBattleMons layout"); status2 is ASSUMED to follow status1.
export const BMON = Object.freeze({ species: [0x00, 2], attack: [0x02, 2], defense: [0x04, 2], speed: [0x06, 2], spAttack: [0x08, 2], spDefense: [0x0a, 2], ivs: [0x14, 4], ability: [0x20, 2],
  type1: [0x22, 1], type2: [0x23, 1], type3: [0x24, 1], hp: [0x2a, 2], level: [0x2c, 1], friendship: [0x2d, 1], maxHP: [0x2e, 2], item: [0x30, 2], experience: [0x4c, 4], personality: [0x50, 4],
  status1: [0x54, 4], status2: [0x58, 4], itemBackup: [0x94, 2] });
Oracle.prototype.setBattleMon = function (side, f) {
  const B = FINDINGS.gBattleMons, base = B.addr + side * B.stride;
  const put = (off, size, v) => { const b = Buffer.alloc(size); if (size === 1) b.writeUInt8(v & 0xff); else if (size === 2) b.writeUInt16LE(v & 0xffff); else b.writeUInt32LE(v >>> 0); this.writeBytes(base + off, b); };
  for (const [k, v] of Object.entries(f)) {
    if (k in BMON) { put(BMON[k][0], BMON[k][1], v); if (k === 'item') put(BMON.itemBackup[0], 2, v); }
    else if (k === 'moves') v.slice(0, 4).forEach((m, i) => put(0x0c + 2 * i, 2, m));
    else if (k === 'pp') v.slice(0, 4).forEach((m, i) => put(0x25 + i, 1, m));
    else if (k === 'statStages') v.slice(0, 8).forEach((m, i) => put(0x18 + i, 1, m));
    else if (k === 'nickname') this.writeBytes(base + 0x34, Buffer.from(encodeText(v, { terminate: true, width: 12 })));
    else throw new Error('setBattleMon: unknown field ' + k);
  }
};

// ---- turns ----
/** Choose move `slot` (0..3, the 2x2 grid) at the action menu and let the turn play out until the action menu returns / the battle ends / a prompt needs input.
 *  Returns { frames, text:[{frame,text}], hp:{before:[player,foe], after:[...]}, over }. `delay` idle frames are run at the menu first (they change the game's RNG consumption). */
Oracle.prototype.playTurn = function (slot = 0, { delay = 0, maxFrames = 2400, record = false, bars = false } = {}) {
  if (this.readU32(FINDINGS.gBattlerControllerFuncs.addr) !== FUNCS.controller0.actionMenu) throw new Error('playTurn: not at the action menu');
  const before = [this.battleMon(0).hp, this.battleMon(1).hp];
  this.runFrames(delay);
  this.press('A', 5, 0); this.pressUntil('A', () => this.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.moveMenu, { what: 'the move menu', gap: 20 }); this.runFrames(10);
  const nav = [[], ['RIGHT'], ['DOWN'], ['DOWN', 'RIGHT']][slot]; for (const k of nav) this.press(k, 3, 6);
  const t0 = this.frame, text = [], frames = [], series = []; let last = '';
  this.press('A', 5, 0);
  let over = false, n = 0;
  for (; n < maxFrames; n++) {
    this.runFrames(1);
    const t = this.battleText(); if (t !== last) { text.push({ frame: this.frame - t0, text: t }); last = t; }
    if (record) frames.push(this.screenshotRGBA());
    if (bars) { const a = this.hpBarInfo(0), b = this.hpBarInfo(1); series.push({ f: this.frame - t0, player: a ? a.fill : null, foe: b ? b.fill : null, hp: [this.battleMon(0).hp, this.battleMon(1).hp] }); }
    if (!this.inBattle()) { over = true; break; }
    if (n > 30 && this.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.actionMenu) break;
  }
  const out = { frames: this.frame - t0, text, hp: { before, after: [this.battleMon(0).hp, this.battleMon(1).hp] }, over };
  if (record) out.frameData = frames; if (bars) out.bars = series; return out;
};

/** From the action menu: choose POKeMON and wait for the in-battle party screen. */
Oracle.prototype.openPartyMenu = function () {
  this.press('DOWN', 5, 10);
  this.pressUntil('A', () => this.readU32(FINDINGS.gMain.addr + 4) === FUNCS.cb2Party.partyMenu, { what: 'the party menu' });
  this.runFrames(20);
};

// ===================================================================================================================================
// ROUND 2: the game's RNG, battle variables, field/side knobs, and realDamage()
// ===================================================================================================================================
// Addresses below were found/confirmed in round 2; pokemonarena/ORACLE.md "Round 2" says HOW each was proven (real-game effect vs assumption).
Object.assign(FINDINGS, {
  gRngState: { addr: 0x03005a68, words: 4, how: 'four u32 {a,b,c,counter} = sfc32; Random() is the ROM function at 0x0821c684 (its pool word is 0x03005a68). Measured by this oracle: from the action menu the state advances by EXACTLY two sfc32 steps per frame (3 consecutive frames matched the simulated state word for word); found independently by FA2.' },
  gBattlerAttacker: { addr: 0x02001b3c, how: "byte that is 0 while the player acts and 1 while the foe acts; writing 1 at frames 0-16 of the player's Tackle changed the damage dealt to the foe from 45 to 16-18 (the damage was computed with the foe's stats); writing it at frame >= 24 did nothing (already computed). 336 pool words." },
  gBattlerTarget: { addr: 0x02001e3a, how: 'byte that is 1 while the player attacks the foe; writing 0 during the move removed the damage to the foe (the target was redirected). 328 pool words.' },
  gCurrentMove: { addr: 0x02001e4c, how: "u16 = the move being executed (33 during the player's Tackle, 10 during the foe's Scratch in the timeline); writing Slash (163) at frames 0-14 raised the damage from 45 to 71-79. 147 pool words." },
  gBattleWeather: { addr: 0x02001e3c, how: 'u32; read after the real Rain Dance / Sunny Day / Sandstorm / Hail / Snowscape: 0x1 / 0x8 / 0x20 / 0x40 / 0x80 (rain, sun, sand, hail, snow). The effect of WRITING it is proven by realDamage in the test (Water 1.5x in rain etc.).' },
  gSideStatuses: { addr: 0x02001dd0, stride: 4, how: "u32 per side (0 player, 1 foe); read after the real Reflect 0x1, Light Screen 0x2, Safeguard 0x4, Mist 0x8, Tailwind 0x10, Lucky Chant 0x40; Aurora Veil 0x20 is FA2's report (the real Aurora Veil failed here: it needs hail/snow). Hazards (Spikes, Stealth Rock, Toxic Spikes, Sticky Web) do NOT use this word." },
  gBattleTerrain: { addr: 0x02001d43, how: 'byte: 9 in the scripted New Bark Town battle, 0 in the grass battle (EWRAM diff); the game rewrites it inside the battle init, but HOLDING a value in it for the first 80 frames after the init starts changes the battle background: 0 grass, 1 long grass, 2 sand, 3 underwater, 4 water, 5 pond, 6 mountain, 7 cave, 8 building, 9 plain, 10/11 a blue indoor one (screenshots opened).' },
  gLastUsedMove: { addr: 0x02001df8, how: 'low 16 bits = the id of the move just used (0x73 after Reflect(115), 0x71 after Light Screen(113), 0xdb after Safeguard(219) ...), high half 0x96 constant, read after each of those real moves.' },
  lastDamageMirror: { addr: 0x020018fc, how: 'holds the final damage (45) from the frame the damage is computed until the next move. READ-ONLY EVIDENCE: holding other values in it for 70 frames did not change the HP actually removed, so it is a copy, NOT the live gBattleMoveDamage (that one was not found).' },
});
export const STAGE_IDX = Object.freeze({ atk: 1, def: 2, spe: 3, spa: 4, spd: 5, acc: 6, eva: 7 });
export const WEATHER_BITS = Object.freeze({ rain: 0x1, sun: 0x8, sand: 0x20, hail: 0x40, snow: 0x80 });
export const SIDE_BITS = Object.freeze({ reflect: 0x1, light: 0x2, safeguard: 0x4, mist: 0x8, tailwind: 0x10, veil: 0x20, luckychant: 0x40 });
export const STATUS1 = Object.freeze({ brn: 0x10, psn: 0x08, par: 0x40, frz: 0x20, tox: 0x80, slp: 0x02 });

/** one sfc32 step of the game's RNG (ROM 0x0821c684): returns { s: next state, t: the 32-bit output (callers use t >>> 16) } */
export function sfc32Step([a, b, c, n]) {
  const t = (((a + b) >>> 0) + n) >>> 0;
  return { s: [(b ^ (b >>> 9)) >>> 0, (c + ((c << 3) >>> 0)) >>> 0, ((((c >>> 11) | (c << 21)) >>> 0) + t) >>> 0, (n + 1) >>> 0], t };
}
/** the first `k` Random() results (top 16 bits) a state will produce */
export function sfc32Draws(s, k) { const v = []; for (let i = 0; i < k; i++) { const r = sfc32Step(s); v.push(r.t >>> 16); s = r.s; } return v; }
const seedCache = new Map();
/** find an sfc32 state whose draws at the given positions lie in [lo, hi] (16-bit values), deterministic search. constraints: [{pos, lo, hi}] */
export function findRngSeed(constraints, { K = 6, key = '' } = {}) {
  const ck = JSON.stringify(constraints) + K + key; if (seedCache.has(ck)) return seedCache.get(ck);
  let x = 0x9e3779b9; for (const ch of ck) x = (Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0) || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const last = Math.max(Math.max(...constraints.map((c) => c.pos), 0), K - 1);
  for (let tries = 0; tries < 2e8; tries++) {
    const s0 = [next(), next(), next(), next()]; let s = s0, ok = true;
    for (let j = 0; j <= last && ok; j++) { const r = sfc32Step(s); const v = r.t >>> 16; for (const c of constraints) if (c.pos === j && (v < c.lo || v > c.hi)) { ok = false; break; } s = r.s; }
    if (ok) { seedCache.set(ck, s0); return s0; }
  }
  throw new Error('findRngSeed: no state for ' + ck);
}
Oracle.prototype.getRng = function () { const b = this.readBytes(FINDINGS.gRngState.addr, 16); return [0, 1, 2, 3].map((i) => b.readUInt32LE(4 * i)); };
Oracle.prototype.setRng = function (s) { const b = Buffer.alloc(16); s.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i)); this.writeBytes(FINDINGS.gRngState.addr, b); };
/** weather: a name from WEATHER_BITS, 0/null/'none', or a raw u32 word */
Oracle.prototype.setWeather = function (w) { this.writeU32(FINDINGS.gBattleWeather.addr, !w || w === 'none' ? 0 : typeof w === 'number' ? w : WEATHER_BITS[w]); };
/** side: 0 player / 1 foe; bits: { reflect, light, safeguard, mist, tailwind, veil, luckychant } booleans or a raw word */
Oracle.prototype.setSideStatus = function (side, bits) { let w = 0; if (typeof bits === 'number') w = bits; else for (const [k, v] of Object.entries(bits || {})) if (v) w |= SIDE_BITS[k]; this.writeU32(FINDINGS.gSideStatuses.addr + 4 * side, w >>> 0); };

/** Write a battler's fields (all optional): species, level, atk/def/spe/spa/spd, hp, maxHP, types[1-2], ability (id), item (id), stages {atk:+1,..}, status1 ('brn'|word), status2, moves[], pp[]. */
Oracle.prototype.setBattler = function (side, m) {
  const B = FINDINGS.gBattleMons, base = B.addr + side * B.stride, F = B.fields;
  const w16 = (off, v) => this.writeU16(base + off, v), w8 = (off, v) => this.writeU8(base + off, v);
  if (m.species !== undefined) w16(F.species, m.species);
  for (const [k, off] of [['atk', F.attack], ['def', F.defense], ['spe', F.speed], ['spa', F.spAttack], ['spd', F.spDefense]]) if (m[k] !== undefined) w16(off, m[k]);
  if (m.level !== undefined) w8(F.level, m.level);
  if (m.maxHP !== undefined) w16(F.maxHP, m.maxHP);
  if (m.hp !== undefined) w16(F.hp, m.hp);
  if (m.moves) m.moves.forEach((id, i) => w16(F.moves + 2 * i, id));
  if (m.pp) m.pp.forEach((v, i) => w8(F.pp + i, v));
  if (m.ability !== undefined) w16(F.ability, m.ability);
  if (m.types) { w8(F.type1, m.types[0]); w8(F.type2, m.types[1] === undefined ? m.types[0] : m.types[1]); }
  if (m.item !== undefined) { w16(F.item, m.item); w16(0x94, m.item); }
  if (m.stages !== undefined) { for (let i = 1; i < 8; i++) w8(F.statStages + i, 6); for (const [k, v] of Object.entries(m.stages)) w8(F.statStages + STAGE_IDX[k], 6 + v); }
  if (m.status1 !== undefined) this.writeU32(base + 0x54, typeof m.status1 === 'string' ? STATUS1[m.status1] : m.status1);
  if (m.status2 !== undefined) this.writeU32(base + 0x58, m.status2);
};

const NEUTRAL = Object.freeze({ species: 0, level: 100, atk: 300, def: 200, spa: 300, spd: 200, spe: 100, hp: 999, maxHP: 999, types: [10, 10], ability: 0, item: 0, stages: {}, status1: 0, status2: 0 });
/** One real-game trial. spec: { arena, attacker, defender, move, attackerSide, weather, sides:[w0,w1], seed (sfc32 state rewritten before EVERY frame) | null, maxFrames, delay } */
Oracle.prototype._trial = async function (spec) {
  const arenaName = spec.arena || 'CK_WILD_ACTION_MENU';
  this._arenas = this._arenas || new Map();
  if (!this._arenas.has(arenaName)) { await this.goto(arenaName); this._arenas.set(arenaName, Buffer.from(this.saveStateBlob())); }
  if (!this._labIds) { const pk = await this.pack(); const m = pk.moves.find((x) => x && x.name === 'Splash'); this._labIds = { splash: m ? m.id : 150 }; }
  const aS = spec.attackerSide || 0, dS = 1 - aS;
  this.loadStateBlob(this._arenas.get(arenaName)); this.runFrames(1);
  this.setBattler(aS, { ...NEUTRAL, spe: 500, ...spec.attacker, moves: [spec.move, spec.move, spec.move, spec.move], pp: [30, 30, 30, 30] });   // all four slots: the wild AI may pick any slot, the buttons pick slot 0
  this.setBattler(dS, { ...NEUTRAL, spe: 5, ...spec.defender, moves: [this._labIds.splash, this._labIds.splash, this._labIds.splash, this._labIds.splash], pp: [30, 30, 30, 30] });
  this.setWeather(spec.weather || 0);
  const sw = spec.sides || [0, 0]; this.writeU32(FINDINGS.gSideStatuses.addr, sw[0]); this.writeU32(FINDINGS.gSideStatuses.addr + 4, sw[1]);
  const seed = spec.seed; const RNG = FINDINGS.gRngState.addr; const sbuf = seed ? Buffer.alloc(16) : null; if (seed) seed.forEach((v, i) => sbuf.writeUInt32LE(v >>> 0, 4 * i));
  const step = (keys) => { if (seed) this.writeBytes(RNG, sbuf); this.runFrames(1, keys); };
  const ctl = FINDINGS.gBattlerControllerFuncs.addr;
  for (let i = 0; i < (spec.delay || 0); i++) step(0);
  for (let i = 0; i < 5; i++) step('A');
  for (let i = 0; i < 90 && this.readU32(ctl) !== FUNCS.controller0.moveMenu; i++) step(0);
  for (let i = 0; i < 8; i++) step(0);
  for (let i = 0; i < 5; i++) step('A');
  const dmon = FINDINGS.gBattleMons.addr + dS * FINDINGS.gBattleMons.stride + FINDINGS.gBattleMons.fields.hp;
  const hp0 = this.readU16(dmon), texts = [], tb = FINDINGS.gDisplayedStringBattle.addr; let lastRaw = '';
  const maxF = spec.maxFrames || 700; let f = 0, dmg = 0;
  const watch = () => { const raw = this.readBytes(tb, 48).toString('hex'); if (raw !== lastRaw) { lastRaw = raw; texts.push(this.battleText().split('\n').join(' ')); } };
  const V = FINDINGS, mu = spec.mutate; let vars = null;
  for (; f < maxF; f++) {
    step(0); watch();
    if (mu && f >= mu.from && f < mu.from + (mu.n || 3)) { if (mu.size === 2) this.writeU16(mu.addr, mu.value); else this.writeU8(mu.addr, mu.value); }
    const h = this.readU16(dmon); if (h !== hp0) { dmg = hp0 - h; vars = { attacker: this.readU8(V.gBattlerAttacker.addr), target: this.readU8(V.gBattlerTarget.addr), currentMove: this.readU16(V.gCurrentMove.addr), mirror: this.readU32(V.lastDamageMirror.addr) }; break; }
  }
  for (let i = 0; i < (spec.tail === undefined ? 24 : spec.tail); i++) { step(0); watch(); }   // let the message that follows the hit appear (critical hit / effectiveness)
  return { damage: dmg, frames: f, timedOut: f >= maxF, texts, vars, crit: texts.some((t) => /critical/i.test(t)) };
};

const BUCKET = (r) => [r * 4096, r * 4096 + 4095];
/** Which draw positions (0..K-1 of the frame the move runs in) the move uses for its damage roll, crit check and accuracy check: found by probes against the real game
 *  with a large-damage scenario and cached per (move, side). A position is the ROLL if forcing it to roll bucket 0 raises damage, the CRIT if forcing it to >= 64000
 *  multiplies damage by > 1.35, the ACCURACY if forcing it low turns the hit into a miss (damage 0). */
Oracle.prototype.movePositions = async function (move, { K = 6, arena, attackerSide = 0 } = {}) {
  const pf = path.join(this.stateDir, ['positions', this.romSha256.slice(0, 10), this.wasmMd5.slice(0, 10), 'v' + ROUTE_VERSION].join('_') + '.json');   // persisted next to the checkpoints: probes run once per move per ROM/wasm
  if (!this._posCache) { this._posCache = new Map(); try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(pf, 'utf8')))) this._posCache.set(k, v); } catch (_e) { /* no cache yet */ } }
  const ck = move + ':' + attackerSide; if (this._posCache.has(ck)) return this._posCache.get(ck);
  const probe = { arena, move, attackerSide, attacker: { level: 100, atk: 500, spa: 500, def: 300, spd: 300 }, defender: { def: 100, spd: 100, atk: 300, spa: 300 } };
  const neutral = [28000, 40000];   // roll bucket 6-9, no crit, hits any >= ~60% accuracy move
  const run = async (j, lo, hi) => { const cons = []; for (let p = 0; p < K; p++) cons.push(p === j ? { pos: p, lo, hi } : { pos: p, lo: neutral[0], hi: neutral[1] }); return this._trial({ ...probe, tail: 0, maxFrames: 500, seed: findRngSeed(cons, { K, key: 'probe' }) }); };
  const base = await this._trial({ ...probe, tail: 0, maxFrames: 500, seed: findRngSeed([...Array(K).keys()].map((p) => ({ pos: p, lo: neutral[0], hi: neutral[1] })), { K, key: 'probe' }) });
  const out = { roll: null, crit: null, acc: null, base: base.damage };
  if (base.damage > 0) for (let j = 0; j < K; j++) {
    if (out.roll !== null && out.crit !== null && j > Math.max(out.roll, out.crit) + 1) break;   // positions beyond the last found one (+1 for an accuracy draw) are not probed
    const low = await run(j, 0, 3000), high = await run(j, 64000, 65535);
    if (low.damage === 0 && out.acc === null) out.acc = j;
    else if (low.damage > base.damage * 1.04 && out.roll === null) out.roll = j;
    if (high.damage > base.damage * 1.35 && out.crit === null) out.crit = j;
  }
  this._posCache.set(ck, out);
  try { fs.mkdirSync(this.stateDir, { recursive: true }); const tmp = pf + '.tmp' + process.pid; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this._posCache))); fs.renameSync(tmp, pf); } catch (_e) { /* cache is an optimisation only */ }
  return out;
};

/** The REAL game's damage for one hit. spec: { attacker, defender, move (id), attackerSide=0, weather, sides:[word0,word1] | screens:{reflect,light,veil,safeguard,mist} (on the DEFENDER's side),
 *  crit: true|false (default false), rollIndex: 0..15 (0 = the top roll, 100%; default 0), hit: true (default), positions: {roll,crit,acc} override, arena }.
 *  attacker/defender: setBattler() fields (defaults: species 0, Lv100, 999 HP, neutral types 10/10, no ability/item, speeds 500 vs 5).
 *  Returns { damage, crit (observed from the message), texts, frames, positions }. The first call for a move id adds its position probes (cached). */
Oracle.prototype.realDamage = async function (spec) {
  const pos = spec.positions || await this.movePositions(spec.move, { arena: spec.arena, attackerSide: spec.attackerSide || 0 });
  const cons = [];
  const want = { roll: spec.rollIndex === undefined ? 0 : spec.rollIndex, crit: !!spec.crit, hit: spec.hit !== false };
  const add = (p, lo, hi) => { if (p === null || p === undefined) return; const e = cons.find((c) => c.pos === p); if (e) { e.lo = Math.max(e.lo, lo); e.hi = Math.min(e.hi, hi); if (e.lo > e.hi) throw new Error('realDamage: the roll, crit and accuracy of this move share draw position ' + p + ' and the request is contradictory'); } else cons.push({ pos: p, lo, hi }); };
  add(pos.roll, ...BUCKET(want.roll));
  add(pos.crit, want.crit ? 62806 : 0, want.crit ? 65535 : 30000);   // not-crit: below the 1/2-odds threshold (32768) so high-crit-ratio moves do not crit either
  if (pos.acc !== null && pos.acc !== undefined) add(pos.acc, want.hit ? 40000 : 0, want.hit ? 65535 : 2000);
  for (let p = 0; p < 6; p++) if (!cons.some((c) => c.pos === p)) cons.push({ pos: p, lo: 40000, hi: 62000 });   // every other draw: a hit, no crit, a mid-high roll
  const seed = findRngSeed(cons, { K: 6, key: 'real' });
  const sides = [0, 0]; const dS = 1 - (spec.attackerSide || 0);
  if (spec.sides) { sides[0] = spec.sides[0]; sides[1] = spec.sides[1]; } else if (spec.screens) { for (const [k, v] of Object.entries(spec.screens)) if (v) sides[dS] |= SIDE_BITS[k]; }
  const r = await this._trial({ ...spec, seed, sides });
  return { ...r, positions: pos };
};

// ===================================================================================================================================
// FA1 capture pack: named real-game scenarios (statuses, HP colours, faint, drain series, trainer intro, terrains)
// ===================================================================================================================================
const CAP_FOE = { species: 25, level: 30, moves: [33], hp: 60, maxHp: 60, nickname: 'Pikachu' };
const CAP_PL = { species: 6, level: 50, hp: 150, maxHp: 153, moves: [33, 1], nickname: 'Charizard' };
/** Generate the FA1 reference set into outDir (PNG at 2x + index.json). Everything is the REAL game: parties go through startBattle, so names/levels/gender/status icons/HP bars/colours are the game's.
 *  Returns { files: {name: path}, series, notes }. About 25 s. */
Oracle.prototype.capturePack = async function (outDir, { scale = 2 } = {}) {
  fs.mkdirSync(outDir, { recursive: true }); const files = {}, notes = {}; const save = (name) => { files[name] = this.savePng(path.join(outDir, name + '.png'), { scale }); };
  // 1. statuses on both healthboxes (action menu): party-tail status words
  for (const st of ['brn', 'psn', 'par', 'slp', 'frz', 'tox']) {
    await this.startBattle({ foe: { ...CAP_FOE, status: STATUS1[st] }, player: { ...CAP_PL, status: STATUS1[st] }, reach: 'action' }); save('status_' + st);
    notes['status_' + st] = { player: this.battleMon(0).status1, foe: this.battleMon(1).status1 };
  }
  await this.startBattle({ foe: CAP_FOE, player: CAP_PL, reach: 'action' }); save('status_none');
  // 2. HP colours: green / yellow / red for both boxes
  for (const [name, php, fhp] of [['hp_green', 150, 60], ['hp_yellow', 60, 25], ['hp_red', 10, 8]]) { await this.startBattle({ foe: { ...CAP_FOE, hp: fhp }, player: { ...CAP_PL, hp: php, maxHp: 153 }, reach: 'action' }); save(name); notes[name] = { playerFill: this.hpBarFill(0), foeFill: this.hpBarFill(1) }; }
  // 3. the healthbox's idle bob (frames 0..99 at the action menu: label y per frame)
  { const ys = []; for (let f = 0; f < 100; f++) { this.runFrames(1); const r = this.hpBarInfo(0); ys.push(r ? +r.labelY.toFixed(1) : null); } notes.bobPlayerLabelY = ys; }
  // 4. drain series: foe takes a Tackle (per-frame bar fill of both boxes, HP vars)
  await this.startBattle({ foe: { ...CAP_FOE, hp: 200, maxHp: 200, stats: { atk: 40, def: 40, spe: 10, spa: 40, spd: 40 } }, player: { ...CAP_PL, stats: { atk: 104, def: 98, spe: 120, spa: 129, spd: 105 } }, reach: 'action' });
  const tr = this.playTurn(0, { bars: true, record: true }); const barsCh = tr.bars.filter((b, i) => i === 0 || b.foe !== tr.bars[i - 1].foe || b.player !== tr.bars[i - 1].player);
  notes.drainSeries = barsCh; notes.drainTurn = { hp: tr.hp, frames: tr.frames, text: tr.text.map((t) => t.frame + ':' + t.text.slice(0, 30)) };
  this.sheetPng(path.join(outDir, 'turn_frames.png'), tr.frameData.filter((_, i) => i % 12 === 0).slice(0, 12), { cols: 4, scale: 1 }); files.turn_frames = path.join(outDir, 'turn_frames.png');
  // 5. faint: foe at 1 HP, player at 1 HP (the foe hits it), frames every 6
  for (const [name, php, fhp, slow] of [['faint_foe', 150, 1, false], ['faint_player', 1, 60, true]]) {
    await this.startBattle({ foe: { ...CAP_FOE, hp: fhp, stats: slow ? { spe: 200 } : {} }, player: { ...CAP_PL, hp: php, stats: { spe: slow ? 5 : 150 } }, reach: 'action' });
    const t = this.playTurn(0, { record: true, maxFrames: 700 }); const ev = t.text.map((x) => x.frame + ':' + x.text.slice(0, 40)); notes[name] = { over: t.over, text: ev, frames: t.frames };
    const stp = Math.max(1, Math.ceil(t.frameData.length / 16)); this.sheetPng(path.join(outDir, name + '_sheet.png'), t.frameData.filter((_, i) => i % stp === 0).slice(0, 16), { cols: 4, scale: 1 }); files[name + '_sheet'] = path.join(outDir, name + '_sheet.png');
  }
  // 6. trainer battle built by the game from the trainer id still in RAM (Crystal): intro text and the action menu
  await this.startBattle({ trainer: 'game', player: { ...CAP_PL }, reach: 'intro' }); save('trainer_intro'); notes.trainer_intro = this.battleText();
  this.pressUntil('A', () => this.readU32(FINDINGS.gBattlerControllerFuncs.addr) === FUNCS.controller0.actionMenu, { what: 'the trainer action menu' }); this.runFrames(30); save('trainer_action'); notes.trainer_foe = { species: this.battleMon(1).species, level: this.battleMon(1).level };
  // 7. terrains 0..9 (+10, 11)
  const tf = []; for (let t = 0; t < 12; t++) { await this.startBattle({ foe: { ...CAP_FOE, hp: 60 }, player: CAP_PL, terrain: t }); tf.push(this.screenshotRGBA()); }
  this.sheetPng(path.join(outDir, 'terrains.png'), tf, { cols: 4, scale: 1 }); files.terrains = path.join(outDir, 'terrains.png');
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ files, notes }, null, 1));
  return { files, notes };
};

Object.freeze(FINDINGS);

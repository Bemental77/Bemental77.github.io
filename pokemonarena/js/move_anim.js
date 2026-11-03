// pokemonarena/js/move_anim.js -- plays the ROM's OWN battle animations (moves, general, status, special) with its own sprite sheets,
// palettes, backgrounds, timings and sound cues.
//
// How: the animation code of Pokemon SoulGold v1.1.1 (an Emerald-engine ROM) is native THUMB code: the script interpreter, ~hundreds of
// sprite callbacks and "visual tasks", the sprite engine, the task engine. This module boots a minimal model of the GBA around that code
// (anim_ram.js memory map, anim_cpu.js ARMv4T interpreter + BIOS HLE), seeds the handful of battle variables the code reads, calls the
// ROM's LaunchBattleAnimation, then each frame does what the game's main loop does (script callback, AnimateSprites, BuildOamBuffer,
// UpdatePaletteFade, RunTasks, then the VBlank work) -- and anim_ppu.js renders the resulting VRAM / OAM / palette / I/O state.
// No move is hand-ported; unknown territory is counted (unmapped accesses, unhandled SWIs, budget overruns) so coverage is measurable.
//
//   import { createMoveAnimator } from './move_anim.js';
//   const animator = await createMoveAnimator({ rom });             // rom: Uint8Array of the pinned SoulGold ROM
//   animator.available('move', 33)                                   // 'exact' | 'approx' | 'fallback' | 'none'
//   const run = animator.start('move', 33, { attacker: { side: 0, species: 4 }, target: { side: 1, species: 1 }, seed: 1 });
//   while (!run.done) { run.step(); run.draw(imageData); }           // one call per GBA frame (59.7275 Hz)
//
// ADDRESSES below are literal-pool / structure findings in THIS ROM (see ANIM.md "Where everything is" for how each was found).
// Nothing in this file is ROM data except those addresses and field offsets.

import { GbaMem } from './anim_ram.js';
import { GbaCpu, CpuFault } from './anim_cpu.js';
import { AnimPpu, SCREEN_W, SCREEN_H } from './anim_ppu.js';
import { speciesRecord } from './speciesgfx.js';
import { smolDecode, smolProbe } from './gfxcodec.js';
import { songInfo, defaultIsSEPlaying, cryFrames } from './anim_sound.js';

export const ANIM_FPS = 59.7275;
// Instruction guards. CALL_BUDGET bounds every ROM call made while setting up (boot, a launch, one sprite's setup): 3 million, ~ a tenth of a second here. FRAME_BUDGET bounds the whole
// work of ONE animation frame (script + sprites + tasks + the VBlank work): the real GBA does that in one 280,896-cycle frame when it can and in several (lag frames, measured in the OR1
// oracle) when it cannot -- a few animations (move 502's software-drawn effect) need about 10 million instructions in a single frame, the model's equivalent of ~25 lag frames.
// A frame over FRAME_BUDGET is a runaway loop, and ends the run with a typed error. run.stepInstr / run.peakStepInstr / run.heavySteps report the cost so a host can pace it.
export const CALL_BUDGET = 3_000_000;
export const FRAME_BUDGET = 64_000_000;
export const GBA_FRAME_CYCLES = 280896;
export class MoveAnimError extends Error { constructor(msg) { super(msg); this.name = 'MoveAnimError'; } }

/* -------------------------------------------------------------------------------------------------- addresses */
export const AD = Object.freeze({
  // --- EWRAM variables (bus addresses)
  animArgs: 0x020018c4,          // gBattleAnimArgs[8] (u16): LaunchBattleAnimation clears them (0xff.. for the return stack at +0x2c, 0 for these); scripts overwrite them
  battleTerrain: 0x02001d43, disableStructPtr: 0x020018f8, localTime: 0x03005a78,
  anim: 0x020018b4,              // battle-anim engine block: +0 script ptr, +4 framesToWait (s8), +5 scriptActive, +8 callback, +0x21 target, +0x22 attacker, +0x10 args[8] (u16), +0x2c script return stack
  battleTypeFlags: 0x02001ab4, battlersCount: 0x02001ab8, animBattlerSpecies: 0x02001904, battleMons: 0x02001ecc, tileBitmap: 0x0300237c,
  battlerPositions: 0x02001b58,  // u8[4]
  battlerPartyIdx: 0x02001b5c,   // u16[4]
  battleSpritesData: 0x02001c4c, // -> { battlerData*, healthBoxesData*, animationData*, battleBars* }; battlerData[b] = { u8 flags, u8 ?, u16 transformSpecies }
  bgRegs: 0x02001c52,            // gBattle_BG0_X, BG0_Y, BG1_X, BG1_Y, BG2_X, BG2_Y, BG3_X, BG3_Y, WIN0H, WIN0V, WIN1H, WIN1V (u16 each)
  battlerSpriteIds: 0x02001d4c,  // u8[4]
  monSpritesGfx: 0x02001d3c,     // -> struct MonSpritesGfx { [0] firstDecompressed, [4+4p] sprites.ptr[p], [0x14+0x18p] templates[p] ... }
  battleBgTemplates: 0x084301e0,
  heap: 0x0201b25c, heapSize: 0x1d000,
  paletteFade: 0x0203844c, plttFaded: 0x02038468, plttUnfaded: 0x02038868,
  sprites: 0x0203beb4,           // struct Sprite[64], 0x44 bytes each
  // --- IWRAM
  main: 0x030055c0, mainInBattle: 0x030055c0 + 0x439,   // bit 1 = in battle (not a contest)
  saveBlock1Ptr: 0x030040c4, saveBlock2Ptr: 0x030040c0, reservedSpritePalettes: 0x03005b28, spritePaletteTags: 0x030020dc, rng1: 0x03005a68, rng2: 0x03005a58,
  vcount: 0x04000006,
  // --- THUMB functions (odd addresses)
  fn: Object.freeze({
    initHeap: 0x081a55cd, resetSpriteData: 0x08245ff5, freeAllSpritePalettes: 0x08246b69, resetPaletteFade: 0x081bf8f5, resetTasks: 0x0825a3b1,
    resetDma3: 0x08126c89, allocBattleResources: 0x080ed865, allocBattleSpritesData: 0x0807edc5, allocMonSpritesGfx: 0x080808db,
    launch: 0x0802adbd, animateSprites: 0x082454cd, buildOamBuffer: 0x08246f65, updatePaletteFade: 0x081bff01, runTasks: 0x0825a565,
    vblankBattle: 0x0808a07d, processDma3: 0x08126cd1, copyGpuRegs: 0, smolMain: 0x0811c081, playCryInternal: 0x082440b9, mplayIsPlaying: 0x081a14b5, random: 0x0821c685, createSprite: 0x08246731, destroySprite: 0x08245579,
    setGpuReg: 0x0817324d, resetBgs: 0x080f7c79, initBgsFromTemplates: 0x080f7cbd, setBgAttribute: 0x080f80f9, showBgInternal: 0x080f8025, allocZeroed: 0x081a56a9, setBgTilemapBuffer: 0x080f8735, startSpriteAnim: 0x08245df1, setMultiuseTemplateToPokemon: 0x081eb1d3, multiuseTemplate: 0x02038d30, spriteCallbackDummy: 0x082448d9, getBattlerSpriteCoord: 0x080477c5, getBattlerSpriteDefaultY: 0x08047941, getBattlerSpriteSubpriority: 0x08049935,
    callViaR3: 0x0802bf5f, loadBattleAnimBg: 0x0802b9bd, loadBattleTerrainA: 0x0805b051, loadBattleTerrainB: 0x0805b759, rtcCalcLocalTime: 0x0822c67d, playSE: 0x0824456d, playSE12WithPanning: 0x0824457d, se12Panpot: 0x08244625, isSEPlaying: 0x08244655, songNumStart: 0x081a0995, panpotControl: 0x081a10cd,
  }),
});

/* ---------------------------------------------------------------------------------------------------- engine */
const STACK_TOP = 0x03007f00;

export class Engine {
  constructor(rom, opts = {}) {
    this.rom = rom;
    this.mem = new GbaMem(rom);
    this.cpu = new GbaCpu(this.mem, { hookFlag: opts.hookFlag });   // opts.hookFlag: share the 16 MiB hook-flag array between engines with identical hook sets (battle_sys.js pool)
    this.cpu.r[13] = STACK_TOP;
    this.mem.pcProbe = () => this.cpu.r[15]; this.mem.lrProbe = () => this.cpu.r[14];
    // OPEN BUS. A read of an address nothing answers returns, on the real chip, the value still on the data bus: the instruction the CPU has prefetched (THUMB: the halfword at
    // instruction + 4, replicated in both halves of a 32-bit read; ARM: the word at instruction + 8). Move 232 / 337's shake sprite reads through a pointer the ROM builds with a sign
    // extension (0xffffba30) and keeps the halfword it gets (the real game: 0x2206 = the `mov r2,#6` two instructions ahead of the load; OR1). Returning 0 here made every such read differ.
    this.mem.openBus = (kind, a) => {
      const cpu = this.cpu, m = this.mem, w = kind === 'r8' ? 1 : kind === 'r16' ? 2 : 4;
      let v;
      if (cpu.thumb) { const ip = (cpu.r[15] - 2) >>> 0; const h = m.read16((ip + 4) >>> 0); v = w === 4 ? (h | (h << 16)) >>> 0 : h; }
      else { const ip = (cpu.r[15] - 4) >>> 0; v = m.read32((ip + 8) >>> 0) >>> 0; }
      return w === 1 ? (v >>> (8 * (a & 3))) & 0xff : w === 2 ? (v >>> (8 * (a & 2))) & 0xffff : v;
    };
    this.counters = { sePoll: 0, rtc: 0, sounds: 0, cries: 0 };   // approximated services the ROM code asked for (coverage reports them)
    this.hour = 12; this.bg3Anim = false; this.scriptTrace = null;   // optional array: push(scriptAddr, opcode)
    this.events = [];             // sound / screen events raised during the current frame
    this.faults = [];             // CpuFaults caught while stepping (coverage)
    this.callBudget = CALL_BUDGET;
    this.installHooks();
    this.boot();
    this.snapshot = this.takeSnapshot();
  }

  call(addr, args = [], budget = this.callBudget) {
    return this.cpu.call(addr, args, { budget });
  }

  installHooks() {
    const cpu = this.cpu, ev = this.events, F = AD.fn;
    // sound: the ROM's m4a / PlaySE layer is replaced by events carrying the same song-table index the game would play
    // The hack's own "smol" graphics decompressor (0x0811c080: header copy, source, destination; called by DecompressDataWithHeaderVram for types 1..6) allocates a temporary
    // buffer as large as the output from the 118 KB battle heap. The real battle has room for it; this model's heap holds ~2 KB more in other places and the allocation of a
    // 12 KB terrain-tile stream FAILED (Alloc returned NULL -> the ROM's assertion screen -> a spin loop: the restorebg of every move on terrain 9). The decode itself is done by
    // gfxcodec.js (this repo's own decoder, byte-equal to the native routine on every stream tested: pokemonarena_anim_test.mjs) and written the way the native code writes it
    // (halfwords into VRAM). A source that is not a ROM stream, or one gfxcodec does not accept, runs the native routine.
    const smolHook = (c) => {
      const src = ((c.r[1] >>> 0) - 8) >>> 0, dst = c.r[2] >>> 0, off = src - 0x08000000;
      const d = this.nativeSmol || off < 0 || off >= this.rom.length ? null : smolProbe(this.rom, off);
      if (!d) { cpu.unhook(F.smolMain); try { cpu.call(F.smolMain, [c.r[0], c.r[1], c.r[2]]); } finally { cpu.hook(F.smolMain, smolHook); } return; }
      const data = d.data, n = data.length;
      if ((dst & 1) === 0) { for (let i = 0; i + 1 < n; i += 2) this.mem.write16(dst + i, data[i] | (data[i + 1] << 8)); if (n & 1) this.mem.write8(dst + n - 1, data[n - 1]); }
      else for (let i = 0; i < n; i++) this.mem.write8(dst + i, data[i]);
      c.r[0] = 0;
    };
    cpu.hook(F.smolMain, smolHook);
    // Cries. PlayCryInternal (the game's cry start) is observed (a `cry` event carries the species and pan for the host to play) and the cry player's "is it still playing" question
    // (0x081a14b4, asked by the cry task and by IsCryFinished) is answered from the cry's length in frames (anim_sound.js cryFrames: the wave's sampleCount / rate). Any other
    // music player runs the native routine.
    cpu.hookBefore(F.playCryInternal, (c) => { const sp = c.r[0] & 0xffff, pan = (c.r[1] << 24) >> 24; ev.push({ type: 'cry', species: sp, pan }); this.counters.cries++; if (this.curRun) this.curRun.noteCry(sp, this.mem.read32(c.r[13]) & 0xff); });
    const playingHook = (c) => {
      const run = this.curRun, plr = c.r[0] >>> 0;
      if (run && run.cry && plr === (this.mem.ewU32(0x0203b488 + 4) >>> 0)) { c.r[0] = run.cryPlaying() ? 1 : 0; return; }
      cpu.unhook(F.mplayIsPlaying); try { c.r[0] = cpu.call(F.mplayIsPlaying, [c.r[0]]); } finally { cpu.hook(F.mplayIsPlaying, playingHook); }
    };
    cpu.hook(F.mplayIsPlaying, playingHook);
    // Every sound event also starts that song on its player in the run's model of the SE players (anim_sound.js): IsSEPlaying (the `end` command's wait) answers from it.
    const noteSound = (index) => { if (this.curRun) this.curRun.noteSound(index); };
    cpu.hook(F.playSE, (c) => { ev.push({ type: 'sound', index: c.r[0] & 0xffff, pan: 0 }); noteSound(c.r[0] & 0xffff); });
    cpu.hook(F.playSE12WithPanning, (c) => { ev.push({ type: 'sound', index: c.r[0] & 0xffff, pan: (c.r[1] << 24) >> 24 }); noteSound(c.r[0] & 0xffff); });
    cpu.hook(F.se12Panpot, (c) => { ev.push({ type: 'pan', pan: (c.r[0] << 24) >> 24 }); });
    cpu.hook(F.isSEPlaying, (c) => { this.counters.sePoll++; c.r[0] = this.curRun && this.curRun.sePlaying() ? 1 : 0; });
    // script command trace (tests / coverage): the interpreter dispatches every command through the library thunk "_call_via_r3"
    // (ROM 0x0802bf5e, bx r3) from RunAnimScriptCommand (return address 0x080297cb). The hook records (script address, command byte)
    // and then does exactly what the thunk does.
    cpu.hook(F.callViaR3, (c) => {
      if (this.scriptTrace && c.r[14] === 0x080297cb) { const sp = this.mem.read32(AD.anim); this.scriptTrace.push(sp, this.mem.read8(sp)); }
      c.noReturn = true; c.thumb = (c.r[3] & 1) === 1; c.r[15] = c.r[3] & ~1;
    });
    // BG3 ownership: the real game keeps the battle terrain on BG3; the animation backgrounds (fadetobg) are loaded INTO BG3 (tiles at charblock 2,
    // tilemap at screenblock 26, palette 2) and restorebg reloads the terrain. While an animation background owns BG3 the PPU renders it from VRAM;
    // otherwise BG3 is the picture the scene supplied (its terrain).
    cpu.hookBefore(F.loadBattleAnimBg, () => { this.bg3Anim = true; });
    cpu.hookBefore(F.loadBattleTerrainA, () => { this.bg3Anim = false; this.terrainReloaded = true; });
    cpu.hookBefore(F.loadBattleTerrainB, () => { this.bg3Anim = false; this.terrainReloaded = true; });
    // the real-time clock: a few animations pick a palette / background by the time of day (hour field of gLocalTime, 12 = day)
    cpu.hook(F.rtcCalcLocalTime, () => { this.counters.rtc++; this.mem.write8(AD.localTime + 2, this.hour); });
    cpu.hook(F.songNumStart, (c) => { ev.push({ type: 'sound', index: c.r[0] & 0xffff, pan: 0, via: 'm4a' }); noteSound(c.r[0] & 0xffff); });
    cpu.hook(F.panpotControl, (c) => { ev.push({ type: 'pan', pan: (c.r[2] << 24) >> 24, via: 'm4a' }); });
  }

  /** Everything the game's startup + battle setup does that the animation code depends on. */
  boot() {
    const { mem, cpu } = this, F = AD.fn;
    // crt0: copy the IWRAM / EWRAM initial images out of the ROM. The (src, dstStart, dstEnd) triples are read from crt0's own
    // literal pool (ROM 0x2e4..0x2f8), not hard-coded sizes.
    const dv = new DataView(this.rom.buffer, this.rom.byteOffset, this.rom.byteLength);
    for (const [a, b, c] of [[0x2e4, 0x2e8, 0x2ec], [0x2f0, 0x2f4, 0x2f8]]) {
      const src = dv.getUint32(a, true) - 0x08000000, dst = dv.getUint32(b, true), end = dv.getUint32(c, true);
      for (let i = 0; i < end - dst; i++) mem.write8(dst + i, this.rom[src + i]);
    }
    mem.setIo16(0x06, 200);                              // VCOUNT stays inside VBlank so SetGpuReg writes the register at once
    this.call(F.initHeap, [AD.heap, AD.heapSize]);
    this.call(F.resetDma3);
    this.call(F.resetSpriteData); this.call(F.freeAllSpritePalettes); this.call(F.resetPaletteFade); this.call(F.resetTasks);
    mem.iwram[AD.mainInBattle - 0x03000000] |= 2;        // gMain.inBattle
    this.call(F.allocBattleResources); this.call(F.allocBattleSpritesData); this.call(F.allocMonSpritesGfx);
    // gSaveBlock1Ptr / gSaveBlock2Ptr: the animation code reads a few save-file flags and options through them (a game-flag test, the "battle scene
    // off" option). Zeroed blocks give the new-game defaults. Allocated AFTER the mon-sprite buffers: the ROM's frame-image tables hard-code
    // EWRAM addresses that must stay inside firstDecompressed.
    mem.write32(AD.saveBlock1Ptr, this.call(F.allocZeroed, [0x4000, 0]));
    mem.write32(AD.saveBlock2Ptr, this.call(F.allocZeroed, [0x2000, 0]));
    // sAnimDisableStructPtr (the attacker's DisableStruct, read by Rollout / Fury Cutter / Ice Ball / Spit Up ...): a zeroed block; start() fills the 3 bytes the animations read
    mem.setEwU32(AD.disableStructPtr, this.call(F.allocZeroed, [0x40, 0]));
    { // placeholder SpriteTemplate: { tileTag, paletteTag, oam, anims, images, affineAnims, callback } = the ROM's own dummy pieces
      const t = this.call(F.allocZeroed, [24, 0]);
      mem.write16(t, 0xfffe); mem.write16(t + 2, 0xffff); mem.write32(t + 4, 0x08f3c704); mem.write32(t + 8, 0x08f3c6e4); mem.write32(t + 12, 0);
      mem.write32(t + 16, 0x08f3c6e8); mem.write32(t + 20, F.spriteCallbackDummy);
      this.placeholderTemplate = t;   // an address inside this engine's own heap (identical on every boot)
    }
    mem.iwram[AD.reservedSpritePalettes - 0x03000000] = 4;  // palette slots 0..3 belong to the four battlers
    // OBJ palette slots 4..10 are taken by the real singles battle's own sprites (healthbox, status bar, ball, ...): the next free slot is 11, and a script that stores
    // a palette index in a data word (AnimLightScreen's data[0] = (index + 16) * 16, the blend tasks) gets the same numbers. Tags measured in the OR1 oracle at the first animation frame.
    for (let i = 0; i < REAL_PALETTE_TAGS.length; i++) mem.write16(AD.spritePaletteTags + 2 * (4 + i), REAL_PALETTE_TAGS[i]);
    // singles: battlers 0 (player) and 1 (foe) exist; positions of the absent battlers 2 / 3 are 0xff ("not present") exactly like the real singles battle -- the
    // `monbg` command tests the partner battler (battler ^ 2) with IsBattlerSpritePresent and must skip it
    for (let i = 0; i < 4; i++) { mem.setEwU8(AD.battlerPositions + i, i < 2 ? i : 0xff); mem.setEwU8(AD.battlerSpriteIds + i, 0xff); }
    mem.setEwU8(AD.battlersCount, 2);
    // battle BG setup: the game's own BG manager initialisation (InitBattleBgsVideo): the four BG templates live in ROM, the tilemap buffers in the
    // battle resources. BG1 / BG2 carry the animation backgrounds and the mon-on-BG copies; BG0 (UI text) and BG3 (terrain) are drawn by the scene.
    this.call(F.resetBgs, [0]);
    this.call(F.initBgsFromTemplates, [0, AD.battleBgTemplates, 4]);
    for (let i = 0; i < 4; i++) { const buf = this.call(F.allocZeroed, [0x1000, 0]); this.call(F.setBgTilemapBuffer, [i, buf]); }
    for (let i = 0; i < 4; i++) this.call(F.showBgInternal, [i]);
    // The battle's own BG1 / BG2 set-up code (ROM 0x08087738): both animation layers use character block 0 (the mon tiles land at tile 0x200 = VRAM 0x4000),
    // map blocks 28 / 30; priorities start at 0 and the scripts raise them. (Values verified against the real game's registers, see ANIM.md.)
    this.call(F.setBgAttribute, [1, 1, 0]); this.call(F.setBgAttribute, [2, 1, 0]);
    this.call(F.setGpuReg, [0x0a, 0x9c00]); this.call(F.setGpuReg, [0x0c, 0x5e00]);
    this.call(F.setGpuReg, [0x48, 0x3f3f]); this.call(F.setGpuReg, [0x4a, 0x3f3f]);   // WININ / WINOUT: everything enabled in and out of the windows
    this.call(F.setGpuReg, [0x40, 240]); this.call(F.setGpuReg, [0x44, 161]);          // WIN0H = 0..240, WIN0V = 0..161: the window covers the screen (the battle's own values, read from the real game)
    this.call(F.setGpuReg, [0x00, 0xbf40]);              // DISPCNT as the real battle has it: mode 0, BG0..3, OBJ, 1D OBJ mapping, WIN0 + OBJ-window enabled
  }

  /** ROUND 6 -- the terrain's palette fades. The real battle keeps its terrain on BG3 with palettes 1..3 (LoadBattleBg loads three at slot 1), and the ROM's SOFTWARE palette blends
   *  (AnimTask_BlendBattleAnimPal, F_PAL_BG: Thunderbolt, Hyper Beam, Fire Blast, Rain Dance, Thunder Wave, Hail, Sunny Day ...) rewrite those slots of gPlttBufferFaded. The scene supplies the
   *  terrain as a PICTURE, so those blends reached nothing and the field never dimmed. Slots 1 and 2 therefore hold a 32-level gray ramp (entry e of slot 1 = level e, of slot 2 = level 16 + e)
   *  in both palette buffers and in PRAM: whatever the ROM does to those palettes happens to the ramp, and baseFadeLut() reads the faded ramp back as the colour map the PPU applies to the
   *  base picture. A blend is a function of one entry's colour (BlendPalette, BeginNormalPaletteFade), so the map is exact for them. */
  seedBaseRamp() {
    const m = this.mem, A = AD;
    for (let p = 1; p <= 2; p++) for (let e = 0; e < 16; e++) {
      const v = (p - 1) * 16 + e, c = v | (v << 5) | (v << 10), o = p * 32 + e * 2;
      m.setEwU16(A.plttUnfaded + o, c); m.setEwU16(A.plttFaded + o, c); m.prDv.setUint16(o, c, true);
    }
    this.terrainReloaded = false;
  }
  /** The per-channel colour map of the faded ramp: { r, g, b } (Uint8Array(32) each, input level -> output level), or null when nothing happened to it (identity) or the ROM replaced the
   *  ramp with a palette of its own (an animation background owns BG3 then, and the PPU is not using the base). */
  baseFadeLut() {
    const m = this.mem, A = AD, r = new Uint8Array(32), g = new Uint8Array(32), b = new Uint8Array(32); let ident = true;
    for (let p = 1; p <= 2; p++) for (let e = 0; e < 16; e++) {
      const v = (p - 1) * 16 + e, o = p * 32 + e * 2;
      if (m.ewU16(A.plttUnfaded + o) !== (v | (v << 5) | (v << 10))) return null;          // the ramp itself is gone
      const c = m.prDv.getUint16(o, true); r[v] = c & 31; g[v] = (c >> 5) & 31; b[v] = (c >> 10) & 31;
      if (r[v] !== v || g[v] !== v || b[v] !== v) ident = false;
    }
    return ident ? null : { r, g, b };
  }

  takeSnapshot() {
    const m = this.mem;
    return { ewram: m.ewram.slice(), iwram: m.iwram.slice(), io: m.io.slice(), pram: m.pram.slice(), vram: m.vram.slice(), oam: m.oam.slice(), regs: Uint32Array.from(this.cpu.r) };
  }
  /** Put the console back to a snapshot (default: the one taken after boot()). battle_sys.js passes its own snapshots (a battle at the action selection). */
  restoreSnapshot(s = this.snapshot) {
    const m = this.mem;
    m.ewram.set(s.ewram); m.iwram.set(s.iwram); m.io.set(s.io); m.pram.set(s.pram); m.vram.set(s.vram); m.oam.set(s.oam);
    this.cpu.r.set(s.regs); this.cpu.r[13] = STACK_TOP; m.hblankDma = null; m.dmaLog.length = 0;
    this.events.length = 0; this.bg3Anim = false;
    this.counters.sePoll = 0; this.counters.rtc = 0; this.counters.sounds = 0; this.counters.cries = 0;
    this.mem.unmapped.clear(); this.mem.dmaLog.length = 0; this.cpu.unhandledSwi.clear();
  }
}

/* ---------------------------------------------------------------------------------------------- the animator */
export async function createMoveAnimator(opts) {
  const rom = opts && opts.rom;
  if (!(rom instanceof Uint8Array) || rom.length !== 33554432) throw new MoveAnimError('createMoveAnimator: rom must be the 32 MiB SoulGold image (Uint8Array)');
  const eng = new Engine(rom);
  const ppu = new AnimPpu(eng.mem);
  const animator = new MoveAnimator(eng, ppu, rom, opts);
  // the battle's system animations (intro, send-out, faint, ...) live in battle_sys.js, which imports this module: a dynamic import keeps the module graph acyclic
  const sys = await import('./battle_sys.js');
  animator.system = new sys.SystemAnimator(rom, { ...opts, hookFlag: eng.cpu.hookFlag });   // the pool's first engine shares the move engine's 16 MiB hook-flag array
  return animator;
}

// LaunchBattleAnimation(animType, id): the ROM's own dispatcher. animType 0 = general (ids 0..55), 1 = move (the move id), 2 = status conditions
// (ids 0..9), 3 = special (ids 0..7: switch-out, ball throw, substitute ...). 'bg' is not a ROM animType: the animator builds a tiny script
// (fadetobg id; wait; hold; restorebg; wait; end) and runs it through the same interpreter, so a background effect can be played on its own.
const KIND_TYPE = { move: 1, general: 0, status: 2, special: 3, bg: 1 };
/** gSprites slots the real singles battle already holds besides the two battlers (9 / 11): healthboxes, shadows, ... (OR1 oracle, first animation frame of moves 24 and 33). */
/** sSpritePaletteTags[4..10] of the real singles battle (slots 0..3 are the battlers'): the animation palettes are allocated after them. */
export const REAL_PALETTE_TAGS = Object.freeze([0xd6ff, 0xd704, 0xd70d, 0x7534, 0xd779, 0xd778, 0xd77a]);
export const REAL_OCCUPIED_SLOTS = Object.freeze([0, 1, 2, 3, 4, 5, 60, 61, 62, 63]);
export const KIND_RANGE = Object.freeze({ move: [1, 935], general: [0, 55], status: [0, 9], special: [0, 7], bg: [0, 84] });
// script opcodes of this ROM's interpreter used by the 'bg' script (see ANIM.md, "script command table")
const OP = Object.freeze({ end: 0x08, delay: 0x04, fadetobg: 0x14, restorebg: 0x15, waitbgfadeout: 0x16, waitbgfadein: 0x17 });

class MoveAnimator {
  constructor(eng, ppu, rom, opts) { this.eng = eng; this.ppu = ppu; this.rom = rom; this.opts = opts || {}; this.coverage = (opts && opts.coverage) || null; }

  available(kind, id) {
    if (kind === 'system') return this.system.available(id);
    const c = this.coverage && this.coverage.status;
    if (c && c[kind] && c[kind][id]) return c[kind][id];
    const rg = KIND_RANGE[kind];
    return rg && Number.isInteger(id) && id >= rg[0] && id <= rg[1] ? 'approx' : 'none';   // without the coverage file: playable but unclassified
  }

  /** Prepare a system run in budgeted slices (battle_sys.js, ANIM.md "Round 4"): returns a handle { advance(budgetMs), ready, begin() }. Only kind 'system'. */
  prepare(kind, id, ctx = {}) {
    if (kind !== 'system') throw new MoveAnimError('prepare() is for kind "system" (moves start in well under a frame)');
    return this.system.prepare(id, ctx);
  }

  start(kind, id, ctx = {}) {
    if (kind === 'system') return this.system.start(id, ctx);
    if (!(kind in KIND_TYPE)) throw new MoveAnimError('unsupported kind ' + kind);
    const rg = KIND_RANGE[kind];
    if (!Number.isInteger(id) || id < rg[0] || id > rg[1]) throw new MoveAnimError(`${kind} id ${id} out of range ${rg[0]}..${rg[1]}`);
    return new Run(this, kind, id, ctx);
  }
}

const sideOf = (c) => (c.side === 'player' || c.side === 0 ? 0 : 1);

class Run {
  constructor(animator, kind, id, ctx) {
    this.animator = animator; this.kind = kind; this.id = id; this.rom = animator.rom;
    this.vblankFn = ctx.vblank || AD.fn.vblankBattle;   // the battle VBlank callback: the real battle's own 0x0808a07d by default (round 1 ran its sibling 0x08102d81; both write the same 12 registers from gBattle_BG* / gBattle_WIN* and call the same four helpers; the golden streams and I/O + OAM + sprites on 75 moves were identical with either)
    this.frameBudget = ctx.frameBudget || FRAME_BUDGET; this.stepInstr = 0; this.peakStepInstr = 0; this.heavySteps = 0;   // instructions of the last frame step / the largest / how many exceeded CALL_BUDGET
    this.cry = null;                               // the cry in progress: { species, mode, start, frames }
    this.cryModel = ctx.cryModel || 'none'; this.cryCap = ctx.cryCap || 0;   // 'none' (default): a cry is over at once; 'sample': the cry plays for its wave's length (measured WORSE than none on the 8 cached moves that have a cry task)
    this.sePlayers = [null, null, null, null];     // SE1 / SE2 (song-table player 1 / 2): { index, start } of the song each is playing
    this.isSEPlayingFn = typeof ctx.isSEPlaying === 'function' ? ctx.isSEPlaying : null;   // ctx.isSEPlaying(songIndex, framesSinceStart) -> bool; default: anim_sound.js's estimate from the song header
    animator.eng.curRun = this;
    const eng = this.eng = animator.eng, mem = eng.mem;
    this.ppu = animator.ppu;
    eng.restoreSnapshot();
    eng.seedBaseRamp();                                       // Round 6: the terrain's palette slots hold the ramp the PPU reads the base picture's fades from
    this.frame = 0; this.done = false; this.error = null; this.truncated = false;
    this.maxFrames = ctx.maxFrames || 1800;                  // a run that has not finished by then is cut off (a ROM script that waits forever); run.truncated says so
    this.handlers = new Map();
    const A = AD;
    const att = ctx.attacker || { side: 0, species: 4 }, tgt = ctx.target || { side: 1, species: 1 };
    this.attackerSide = sideOf(att); this.targetSide = sideOf(tgt);
    // singles: battler 0 = the near (player) side, battler 1 = the far (foe) side
    const attacker = this.attackerSide, target = this.targetSide;
    mem.setEwU8(A.anim + 34, attacker); mem.setEwU8(A.anim + 33, target);
    // random seed: the engine's Random() state (a 32-bit LCG in IWRAM) is seeded for determinism
    this.seedRng(ctx.seed === undefined ? 1 : ctx.seed);
    // The real battle numbers its sprites after the healthboxes / shadows: its two battlers are gSprites[9] (player) and gSprites[11] (foe), and a few
    // animation callbacks keep those ids in their data words. Invisible placeholders reproduce the numbering (and keep ids from colliding with plain 0 / 1).
    const mons = [null, null];
    mons[attacker] = att; mons[target] = tgt;
    // A self-targeting run (attacker and target on the SAME side: the game launches Mist, Swords Dance, weather, ... that way) still has the other Pokemon on the field.
    // ctx.bystander = { species } names it (default: the attacker's species, the old stand-in); it takes the other battler slot and the other side of the screen.
    if (attacker === target) mons[attacker ^ 1] = ctx.bystander || att;
    if (ctx.rng2) for (let i = 0; i < 4; i++) mem.write32(A.rng2 + 4 * i, ctx.rng2[i] >>> 0);   // an explicit Random2 state (tests / the real-game comparison)
    this.mainLoopRandom = ctx.mainLoopRandom !== false;
    if (ctx.rng1) for (let i = 0; i < 4; i++) mem.write32(A.rng1 + 4 * i, ctx.rng1[i] >>> 0);
    // The rest of the real battle's occupancy: CreateSprite hands out the LOWEST free slot, and a callback keeps the id of a sprite it created in a data word
    // (Double Kick keeps its child's), so a script's own sprites only get the real game's ids when the same slots are free. The real singles battle holds
    // gSprites 0-5 and 60-63 (healthboxes, shadows, ...) besides the battlers (9 / 11); 6-8, 10 and 12-59 are free. ctx.occupiedSlots overrides (null = the old dense layout).
    // Slots are filled in order 0..63 -- a placeholder, or a battler's own sprite at its slot -- and the ones the real battle leaves free are destroyed again.
    {
      const bs = ctx.battlerSlots || [9, 11];                       // gBattleSpritesDataPtr battlerSpriteIds of battlers 0 / 1 (ctx.battlerSlots: another battle layout)
      const dense = ctx.occupiedSlots === null;
      const keep = new Set([bs[0], bs[1], ...(dense ? [] : (ctx.occupiedSlots || REAL_OCCUPIED_SLOTS))]);
      const last = dense ? Math.max(bs[0], bs[1]) : 63;
      for (let id = 0; id <= last; id++) {
        if (id === bs[0]) this.setupBattler(0, (mons[0] || att).species || 4);
        else if (id === bs[1]) this.setupBattler(1, (mons[1] || tgt).species || 1);
        else this.placeholder();
      }
      if (!dense) for (let id = 0; id < 64; id++) if (!keep.has(id)) eng.call(A.fn.destroySprite, [A.sprites + id * 0x44]);
    }
    // The battle the animation runs in may hold other OBJ palettes (a wild battle has fewer healthbox palettes than the trainer battle) and leave other register values behind
    // (BG2CNT priority, WIN0): ctx.paletteTags = the 16 sSpritePaletteTags words, ctx.reservedPalettes = the reserved count, ctx.io = { registerOffset: value } for the GPU registers.
    if (ctx.paletteTags) for (let i = 0; i < 16; i++) mem.write16(A.spritePaletteTags + 2 * i, ctx.paletteTags[i] >>> 0);
    if (ctx.reservedPalettes !== undefined) mem.iwram[A.reservedSpritePalettes - 0x03000000] = ctx.reservedPalettes;
    if (ctx.io) { for (const [reg, v] of Object.entries(ctx.io)) { eng.call(A.fn.setGpuReg, [Number(reg), v >>> 0]); mem.write16(0x04000000 + Number(reg), v >>> 0); } }   // the buffer AND the live register (no VBlank here: the battle's VBlank callback rewrites the windows / scrolls from its own variables)
    // Battle state the animation code reads (found with tools/pokemonarena_anim_readset.mjs: every byte the ROM code reads that the boot had left at zero): gBattleTypeFlags (default
    // IS_MASTER | TRAINER, as in the scripted trainer battle), gBattleMons[b] {species, hp, level, maxHP} (a function skips a battler whose hp is 0), gAnimBattlerSpecies[b] (the
    // cry and form-dependent tasks read it; the launcher fills it from the PARTY, which the engine does not hold, so it is written after the launch below) and the OBJ tile allocation bitmap (which tiles a new sprite sheet lands on).
    mem.setEwU32(A.battleTypeFlags, ctx.battleTypeFlags === undefined ? 0x0c : ctx.battleTypeFlags >>> 0);
    for (let b = 0; b < 2; b++) {
      const bm = (ctx.battleMons && ctx.battleMons[b]) || {}, sp = (mons[b] || att).species || 4, base = A.battleMons + b * 0x98;
      mem.setEwU16(base, bm.species === undefined ? sp : bm.species); mem.setEwU16(base + 0x2a, bm.hp === undefined ? 100 : bm.hp);
      mem.setEwU8(base + 0x2c, bm.level === undefined ? 50 : bm.level); mem.setEwU16(base + 0x2e, bm.maxHP === undefined ? 100 : bm.maxHP);
    }
    if (ctx.battleVars) for (let i = 0; i < 12; i++) mem.setEwU16(0x02001c52 + 2 * i, ctx.battleVars[i] & 0xffff);   // gBattle_BGx_X/Y, gBattle_WINxH/V (ctx.battleVars: 12 u16)
    if (ctx.tileBitmap) for (let i = 0; i < 128; i++) mem.iwram[A.tileBitmap - 0x03000000 + i] = ctx.tileBitmap[i];
    if (ctx.disable) { const d = mem.ewU32(A.disableStructPtr); for (const k of [4, 5, 6]) if (ctx.disable[k] !== undefined) mem.setEwU8(d + k, ctx.disable[k]); }
    eng.hour = ctx.hour === undefined ? 12 : ctx.hour;
    mem.setEwU8(A.battleTerrain, ctx.terrain || 0);                  // gBattleTerrain: Secret Power / Nature Power / the restored background read it
    { const ad = mem.ewU32(mem.ewU32(A.battleSpritesData) + 8); mem.setEwU16(ad, ctx.animArg || 0); }   // gBattleSpritesDataPtr->animationData->animArg (stat-change animations read their stat / direction here)
    const args = ctx.args || [];
    this.ioBeforeLaunch = Uint8Array.from(mem.io.slice(0, 0x58));   // the registers as the battle left them (LaunchBattleAnimation clears the windows and more)
    if (kind === 'bg') {
      // a synthetic script in the heap (any readable address works as a script pointer)
      const buf = eng.call(A.fn.allocZeroed, [32, 0]);
      const bytes = [OP.fadetobg, id, OP.waitbgfadeout, OP.waitbgfadein, OP.delay, ctx.hold === undefined ? 48 : ctx.hold, OP.restorebg, OP.waitbgfadeout, OP.waitbgfadein, OP.end];
      for (let i = 0; i < bytes.length; i++) mem.write8(buf + i, bytes[i]);
      eng.call(A.fn.launch, [1, 1]);
      mem.setEwU32(A.anim, buf);
    } else eng.call(A.fn.launch, [KIND_TYPE[kind], id]);
    for (let i = 0; i < 8; i++) mem.setEwU16(A.animArgs + 2 * i, i < args.length ? args[i] : 0);   // the script reads its arguments from here, after the launch cleared them
    for (let b = 0; b < 2; b++) { const bm = (ctx.battleMons && ctx.battleMons[b]) || {}; mem.setEwU16(A.animBattlerSpecies + 2 * b, bm.species === undefined ? ((mons[b] || att).species || 4) : bm.species); }   // gAnimBattlerSpecies: LaunchBattleAnimation fills it from the party (empty here)
    this.sprites = A.sprites;
  }

  // The ROM keeps two 4-word PRNG states in IWRAM (a "Random()" one at 0x03005a68 and a "Random2()" one at 0x03005a58, both read by the
  // animation code). Both are seeded from one 32-bit seed through a splitmix32 sequence, so one seed gives one animation, bit for bit.
  seedRng(seed) {
    let z = (seed >>> 0) || 1;
    const next = () => { z = (z + 0x9e3779b9) >>> 0; let t = z; t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0; t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0; return (t ^ (t >>> 16)) >>> 0; };
    const mem = this.eng.mem;
    for (const base of [AD.rng1, AD.rng2]) for (let i = 0; i < 4; i++) mem.write32(base + 4 * i, i === 3 ? 1 : next());
    this.seed = seed >>> 0;
  }

  /** An invisible, callback-less sprite that only occupies a slot of gSprites (template: tile tag none-found, dummy OAM / anims / callback of the ROM). */
  placeholder() {
    const eng = this.eng, mem = eng.mem, A = AD;
    const t = eng.placeholderTemplate;
    const id = eng.call(A.fn.createSprite, [t, 240, 160, 0xff]);
    if (id < 64) mem.setEwU8(A.sprites + id * 0x44 + 0x3e, mem.ewU8(A.sprites + id * 0x44 + 0x3e) | 4);   // invisible
    return id;
  }

  setupBattler(b, species) {
    const eng = this.eng, mem = eng.mem, A = AD;
    const pos = b;   // singles: battler index == position (0 player, 1 foe)
    const rec = speciesRecord(this.rom, species);
    if (!rec) throw new MoveAnimError('species ' + species + ' has no graphics');
    const picOff = pos === 0 ? rec.back : rec.front;
    const pic = smolDecode(this.rom, picOff).data;
    const gfx = mem.ewU32(A.monSpritesGfx);
    // palette -> OBJ palette slot b (unfaded + faded buffers)
    const pal = (pos === 0 ? rec.pal : rec.pal);
    for (let i = 0; i < 16; i++) {
      const v = this.rom[pal + i * 2] | (this.rom[pal + i * 2 + 1] << 8);
      mem.setEwU16(A.plttUnfaded + (16 + b) * 32 + i * 2, v); mem.setEwU16(A.plttFaded + (16 + b) * 32 + i * 2, v);
    }
    // battler data: transformSpecies short-circuits the party lookup of the species
    const bsd = mem.ewU32(A.battleSpritesData), bdata = mem.ewU32(bsd);
    mem.setEwU16(bdata + 4 * b + 2, species);
    // the battler's sprite: created from the template the game copies into gMonSpritesGfx
    const x = eng.call(A.fn.getBattlerSpriteCoord, [b, 2]);
    const y = eng.call(A.fn.getBattlerSpriteDefaultY, [b]);
    const sub = eng.call(A.fn.getBattlerSpriteSubpriority, [b]);
    eng.call(A.fn.setMultiuseTemplateToPokemon, [species, pos]);
    const id = eng.call(A.fn.createSprite, [A.fn.multiuseTemplate, x, y, sub]);
    mem.setEwU8(A.battlerSpriteIds + b, id);
    // the pic: the sprite's frame-image table (ROM) names the buffers the game decompresses mon pics into; the copy to OBJ VRAM and the
    // mon-on-BG copy (gMonSpritesGfx->sprites.ptr[pos]) both read them, so the decoded 4bpp tiles go there (frame 0, then frame 1 at +0x800)
    {
      const images = mem.read32(A.sprites + id * 0x44 + 0xc);
      const d0 = mem.read32(images);
      mem.setEwU32(gfx + 4 + 4 * pos, d0);
      for (let i = 0; i < Math.min(pic.length, 0x1000); i++) mem.write8(d0 + i, pic[i]);
    }
    const sp = A.sprites + id * 0x44;
    // oam.paletteNum = b (attr2 bits 12..15)
    mem.setEwU16(sp + 4, (mem.ewU16(sp + 4) & 0x0fff) | (b << 12));
    mem.setEwU16(sp + 0x2e, b);            // data[0] = battler
    mem.setEwU16(sp + 0x32, species);      // data[2] = species
    eng.call(A.fn.startSpriteAnim, [sp, 0]);
    mem.setEwU32(sp + 0x1c, A.fn.spriteCallbackDummy);
  }

  on(type, fn) { this.handlers.set(type, fn); return this; }
  emit(type, payload) { const h = this.handlers.get(type); if (h) h(payload); }

  /** Advance exactly one GBA frame. */
  noteCry(species, mode) { const f = this.cryModel === 'none' ? 0 : cryFrames(this.rom, species); this.cry = f ? { species, mode, start: this.frame, frames: this.cryCap ? Math.min(f, this.cryCap) : f } : null; }
  cryPlaying() { return !!this.cry && this.frame - this.cry.start < this.cry.frames; }
  noteSound(index) {
    const s = songInfo(this.rom, index);
    if (s.player === 1 || s.player === 2) this.sePlayers[s.player] = { index, start: this.frame };
  }
  /** What IsSEPlaying() answers: is a song on SE1 or SE2 still running? (the `end` and `waitsound` commands poll it) */
  sePlaying() {
    for (const p of [1, 2]) {
      const pl = this.sePlayers[p]; if (!pl) continue;
      const elapsed = this.frame - pl.start;
      if (this.isSEPlayingFn ? this.isSEPlayingFn(pl.index, elapsed) : defaultIsSEPlaying(this.rom, pl.index, elapsed)) return true;
    }
    return false;
  }

  step() {
    if (this.done) return;
    const eng = this.eng, mem = eng.mem, A = AD, F = A.fn;
    const evStart = eng.events.length;
    const i0 = eng.cpu.icount, saved = eng.callBudget;
    eng.callBudget = this.frameBudget - 0;                        // the guard of a frame step: one call may use the whole FRAME_BUDGET
    try {
      if (mem.ewU8(A.anim + 5)) eng.call(mem.ewU32(A.anim + 8));
      eng.call(F.animateSprites); eng.call(F.buildOamBuffer); eng.call(F.updatePaletteFade); eng.call(F.runTasks);
      if (eng.terrainReloaded) eng.seedBaseRamp();            // restorebg loaded the real terrain palette over the ramp (inside the script command or its fade task): put the ramp back before the VBlank copy
      // VBlank: the battle callback copies the BG scroll variables to the registers, transfers palettes / OAM / sprite pics
      eng.call(this.vblankFn); eng.call(F.processDma3);
      // The real main loop draws Random() twice at the end of every iteration (the sfc32 counter word advances by exactly 2 per iteration: OR1 oracle finding, re-measured here on
      // 20+ animations). Only one animation reads Random() (move 788); it sees the same state sequence as in the real game.
      if (this.mainLoopRandom) { eng.call(F.random); eng.call(F.random); }
    } catch (e) {
      this.error = e; this.done = true; eng.faults.push(e);
    }
    eng.callBudget = saved;
    this.stepInstr = eng.cpu.icount - i0; this.peakStepInstr = Math.max(this.peakStepInstr, this.stepInstr);
    if (this.stepInstr > CALL_BUDGET) this.heavySteps++;
    this.frame++;
    for (let i = evStart; i < eng.events.length; i++) { if (eng.events[i].type === 'sound') eng.counters.sounds++; this.emit(eng.events[i].type, eng.events[i]); }
    eng.events.length = 0;
    if (!mem.ewU8(A.anim + 5)) this.done = true;
    else if (this.frame >= this.maxFrames) { this.done = true; this.truncated = true; }
  }

  /** The engine's displacement of a side's mon sprite (informational: draw() already applies all of it). side 0 = near / player, 1 = far / foe. */
  battlerState(side) {
    const mem = this.eng.mem, A = AD;
    const b = sideOf({ side });
    const id = mem.ewU8(A.battlerSpriteIds + b);
    if (id === 0xff) return null;
    const sp = A.sprites + id * 0x44;
    const a0 = mem.ewU16(sp), a1 = mem.ewU16(sp + 2);
    const st = { dx: mem.ewS16(sp + 0x24), dy: mem.ewS16(sp + 0x26), scaleX: 1, scaleY: 1, rot: 0, visible: (mem.ewU8(sp + 0x3e) & 4) === 0, alpha: ((a0 >> 10) & 3) === 1 ? 0.5 : 1, tint: null };
    if ((a0 >> 8) & 1) {  // affine: the OAM matrix of this sprite
      const m = ((a1 >> 9) & 31) * 32, o = this.eng.mem.oamDv;
      const pa = o.getInt16(m + 6, true), pb = o.getInt16(m + 14, true), pc = o.getInt16(m + 22, true), pd = o.getInt16(m + 30, true);
      const sx = Math.hypot(pa, pc) || 256, sy = Math.hypot(pb, pd) || 256;
      st.scaleX = 256 / sx; st.scaleY = 256 / sy; st.rot = Math.atan2(pc, pa);
    }
    return st;
  }

  dispose() { this.done = true; }

  /** Render the current frame (RGBA, 240x160) into target ({data,width,height} or an RGBA array). */
  draw(target, opts = {}) {
    const ppu = this.ppu;
    const data = target && target.data ? target.data : target;
    const useBase = !(opts.base === false || this.eng.bg3Anim);
    ppu.setBaseRGBA(useBase ? data : null, useBase ? this.eng.baseFadeLut() : null);
    const out = ppu.render();
    if (data) data.set(out);
    return out;
  }
}

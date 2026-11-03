// pokemonarena/js/battle_sys.js -- the battle's own SYSTEM animations (battle intro, send-out, recall, faint, hit blink, shiny sparkle, ...) played by running the ROM's native battle code.
//
// move_anim.js runs the animation scripts of single moves. Everything AROUND a move is also ROM code: the battle intro (background scroll-in, the foe sliding in, the trainer's throw,
// the ball opening, the silhouette growing into the Pokemon, the per-species front / back motion, the cries, the healthbox slides) is CB2_InitBattle + the battle controllers + sprite
// callbacks + tasks, the same kind of THUMB code the move engine already runs. This module boots a second model of the console (a SystemEngine: same interpreter, memory map and
// PPU as move_anim.js, a different boot), seeds the handful of variables the battle reads (two party structs, battle type, environment, time of day, options), points gMain.callback2
// at CB2_InitBattle and then does what the game's main loop does, once per frame. Nothing is hand-ported: the sprites, positions, timings, sound cues, text and motion are whatever
// the ROM computes. The model is verified frame by frame against the real game (tools/pokemonarena_sys_compare.mjs, pokemonarena/ANIM.md "Round 3").
//
//   const animator = await createMoveAnimator({ rom });                  // move_anim.js
//   const run = animator.start('system', SYS_ID.intro, { foe: { species: 19, level: 2 }, player: { species: 1289, level: 5 } });
//   while (!run.done) { run.step(); run.draw(imageData); }               // one call per GBA frame (59.7275 Hz)
//
// ADDRESSES below are findings in THIS ROM (ANIM.md "Round 3": the table "What the model had to be given" says how each was found). Nothing in this file is ROM data except those addresses.

import { Engine, AD, FRAME_BUDGET, MoveAnimError } from './move_anim.js';
import { AnimPpu } from './anim_ppu.js';
import { SLICE_CHECK } from './anim_cpu.js';
import { cryFrames, songInfo, defaultIsSEPlaying } from './anim_sound.js';
import { encodeText, decodeText } from './charset.js';
import { speciesRecord, SPECIES_TABLE, SPECIES_STRIDE } from './speciesgfx.js';

/** System-animation ids of `animator.start('system', id, ctx)`. */
export const SYS_ID = Object.freeze({ intro: 0, introTrainer: 1, sendOutPlayer: 2, recallPlayer: 3, faintPlayer: 4, faintFoe: 5, hitPlayer: 6, hitFoe: 7, sendOutFoe: 8, recallFoe: 9 });
export const SYS_RANGE = Object.freeze([0, 9]);
const SYS_VALID = new Set(Object.values(SYS_ID));
// Battle-controller commands (ROM command tables at 0x08431340 (opponent) / 0x084314a8 (player), one u32 per id; the command byte is bufferA[battler][0] at gBattleResources + 16 + battler * 0x200).
// A system event after the intro is "run the same controller command the battle script would issue": write the command into the battler's buffer and set its bit in
// gBattleControllerExecFlags (0x02001d38); the ROM's controller then runs it frame by frame (animations, tasks, sounds) exactly as in a real battle.
export const CMD = Object.freeze({ loadMonSprite: 4, switchInAnim: 5, returnMonToBall: 6, faintAnimation: 10, hitAnimation: 36 });
const PLANS = Object.freeze({
  [SYS_ID.recallPlayer]: { main: [{ battler: 0, cmd: [CMD.returnMonToBall, 0] }] },
  [SYS_ID.faintPlayer]: { main: [{ battler: 0, cmd: [CMD.faintAnimation] }] },
  [SYS_ID.faintFoe]: { main: [{ battler: 1, cmd: [CMD.faintAnimation] }] },
  [SYS_ID.hitPlayer]: { main: [{ battler: 0, cmd: [CMD.hitAnimation] }] },
  [SYS_ID.hitFoe]: { main: [{ battler: 1, cmd: [CMD.hitAnimation] }] },
  // a trainer's next Pokemon (trainer battle: gBattleTypeFlags TRAINER, set by the event itself): the ball thrown from the trainer's side
  [SYS_ID.recallFoe]: { trainer: true, main: [{ battler: 1, cmd: [CMD.returnMonToBall, 0] }] },
  [SYS_ID.sendOutFoe]: { trainer: true, pre: [{ battler: 1, cmd: [CMD.returnMonToBall, 1] }], main: [{ battler: 1, cmd: [CMD.switchInAnim, 1, 0], foeParty1: true }] },
  [SYS_ID.sendOutPlayer]: { pre: [{ battler: 0, cmd: [CMD.returnMonToBall, 1] }], main: [{ battler: 0, cmd: [CMD.switchInAnim, 1, 0], party1: true }] },
});
export const KEY = Object.freeze({ A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 });

export const SYS = Object.freeze({
  main: AD.main,                          // gMain: +0 callback1, +4 callback2, +0xc vblankCallback, +0x20 / +0x24 vblank counters, +0x28 heldKeysRaw, +0x2a newKeysRaw, +0x2c heldKeys, +0x2e newKeys, +0x30 newAndRepeatedKeys
  battleInit: 0x0808d581,                 // CB2_InitBattle
  battleMainFunc: 0x03002e64, controllerFuncs: 0x03002e44,
  playerParty: 0x02038f98, enemyParty: 0x02038d58, partyStride: 0x60,
  fonts: 0x0203dbf8, fontTable: 0x0911ab64,          // gFonts and the ROM's font table it points at (SetFontsPointer(&gFontInfos) runs at the game's boot, not in the battle)
  timeOfDay: 0x03001d4c,                  // GetTimeOfDay()'s variable (0x0822c7f5 returns it): 0..3
  createTrainerMon: 0x081ece55,           // the ROM's CreateMon-with-EV-spread (mon*, species, level, ...): CB2_InitBattleInternal calls it once per Pokemon of the trainer's ROM party (return address 0x0808cca3)
  getBattleEnvironment: 0x0805ac75,       // returns the index into the terrain table (0x08430470, 41 entries); it reads gBattleTerrain, which the real game derives from the player's map tile
  textPrinterHead: 0x0203dbec,            // head of the text-printer list (0 = none active)
  battlePutText: 0x08094b9d,              // BattlePutTextOnWindow(string*, window)
  actionSelect: 0x0808f0dd, actionMenuController: 0x08061b9d, intro: 0x0808b9d1,
  trainerStruct: 0x02002398,
  battleMons: 0x02001ecc, battleMonStride: 152,   // gBattleMons[battler] (struct BattlePokemon, +0 = species u16): the foe's ground shadow (SpriteCB_EnemyShadow, ROM 0x0807eb88) reads its species through 0x080ce94c EVERY frame
  battleResources: 0x02001c6c, execFlags: 0x02001d38, bufferA: 16, bufferStride: 0x200, pauseMainFunc: 0x08068a75,   // gBattleResources, gBattleControllerExecFlags; bufferA at +16, 0x200 bytes per battler; 0x08068a75 is an empty function (bx lr) that sits after the literal pool of the ROM's dummy command handler
  sb1: 0x02016644, sb2: 0x0201a318,       // SaveBlock1 / SaveBlock2 (just below the battle heap, where the real game keeps them)
});

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; };
const w32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
const field = (str, width) => { const bare = encodeText(str, { terminate: false }); return bare.length >= width ? encodeText(str, { terminate: false, width }) : encodeText(str, { terminate: true, width }); };

/** A personality value for a wanted gender / shininess (this hack's rule, measured on the real game: tid ^ sid ^ pid.hi ^ pid.lo below 256 renders shiny; a low byte below the
 *  species' gender ratio is female). */
export function personalityFor({ tid, sid, genderRatio = 127, gender = 'M', shiny = false, seed = 0x1234 }) {
  let lo = seed & 0xffff;
  for (let i = 0; i < 0x10000; i++, lo = (lo + 1) & 0xffff) {
    if (genderRatio === 255) break;
    const female = (lo & 0xff) < genderRatio;
    if ((gender === 'F') === female) break;
  }
  const hi = (tid ^ sid ^ lo ^ (shiny ? 0 : 0x100)) & 0xffff;
  return ((hi << 16) | lo) >>> 0;
}

const IV_ORDER = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'], EV_ORDER = IV_ORDER;
/** The 96-byte party record the game keeps in RAM (plain, unencrypted: 76-byte box part + 20-byte party tail). spec: { species, level, nickname?, moves[4]?, hp?, maxHp?, pid?, shiny?, gender?,
 *  tid?, sid?, otName?, exp?, ball?, friendship?, iv{}, ev{}, stats{atk,def,spe,spa,spd}?, status?, shinyMod?, abilityNum? }. Every field has a default so { species, level } is enough. */
export function makePartyMon(rom, spec) {
  const rec = speciesRecord(rom, spec.species);
  if (!rec) throw new MoveAnimError('species ' + spec.species + ' has no record');
  const tid = spec.tid === undefined ? 0x2ded : spec.tid, sid = spec.sid === undefined ? 0xa7e3 : spec.sid;
  const genderRatio = rom[SPECIES_TABLE + SPECIES_STRIDE * spec.species + 0x12];
  const pid = spec.pid !== undefined ? spec.pid >>> 0 : personalityFor({ tid, sid, genderRatio, gender: spec.gender || 'M', shiny: !!spec.shiny });
  const b = new Uint8Array(0x60);
  w32(b, 0, pid); w32(b, 4, ((sid << 16) | tid) >>> 0);
  b.set(field(spec.nickname === undefined ? rec.name : spec.nickname, 12), 8);
  b[0x14] = 2; b[0x15] = 2;                                         // language English; hasSpecies
  b.set(field(spec.otName || 'Nova', 7), 0x16);
  w16(b, 0x1e, spec.shinyMod ? 0x4000 : 0);
  w16(b, 0x20, spec.species & 0x7ff);
  w16(b, 0x22, ((spec.item || 0) & 0x3ff) | ((spec.ball === undefined ? 1 : spec.ball) << 10));
  w32(b, 0x24, (spec.exp === undefined ? 0 : spec.exp) >>> 0);
  b[0x2b] = spec.friendship === undefined ? 70 : spec.friendship;
  const moves = spec.moves || [33];
  for (let i = 0; i < 4; i++) { w16(b, 0x2c + 2 * i, (moves[i] || 0) & 0x7ff); b[0x34 + i] = moves[i] ? ((spec.pp && spec.pp[i]) || 35) : 0; }
  b[0x33] |= ((spec.abilityNum || 0) & 3) << 4;
  EV_ORDER.forEach((k, i) => { b[0x38 + i] = (spec.ev && spec.ev[k]) || 0; });
  b[0x45] = 232; w16(b, 0x46, 0x0180 | 5);
  let iv = 0; IV_ORDER.forEach((k, i) => { iv |= (((spec.iv && spec.iv[k] !== undefined ? spec.iv[k] : 15) & 31) << (5 * i)); });
  w32(b, 0x48, iv >>> 0);
  const level = spec.level || 5, maxHp = spec.maxHp !== undefined ? spec.maxHp : (spec.hp !== undefined ? Math.max(spec.hp, 1) : 20), hp = spec.hp !== undefined ? spec.hp : maxHp;
  if (spec.status) w32(b, 0x4c, spec.status);
  b[0x50] = level; b[0x51] = 0xff; w16(b, 0x52, hp); w16(b, 0x54, maxHp);
  ['atk', 'def', 'spe', 'spa', 'spd'].forEach((k, i) => w16(b, 0x56 + 2 * i, (spec.stats && spec.stats[k]) || 10 + level));
  return b;
}

/** The console model of the system animations: move_anim.js's Engine with a boot that leaves the battle to the ROM's own CB2_InitBattle. */
export class SystemEngine extends Engine {
  boot() {
    const { mem } = this, F = AD.fn;
    // crt0: copy the IWRAM / EWRAM initial images out of the ROM (the (src, dstStart, dstEnd) triples sit in crt0's own literal pool, ROM 0x2e4..0x2f8)
    const dv = new DataView(this.rom.buffer, this.rom.byteOffset, this.rom.byteLength);
    for (const [a, b, c] of [[0x2e4, 0x2e8, 0x2ec], [0x2f0, 0x2f4, 0x2f8]]) {
      const src = dv.getUint32(a, true) - 0x08000000, dst = dv.getUint32(b, true), end = dv.getUint32(c, true);
      for (let i = 0; i < end - dst; i++) mem.write8(dst + i, this.rom[src + i]);
    }
    mem.setIo16(0x06, 200);                             // VCOUNT inside VBlank so SetGpuReg writes registers at once
    this.call(F.initHeap, [AD.heap, AD.heapSize]);
    this.call(F.resetDma3);
    mem.write32(AD.saveBlock1Ptr, SYS.sb1); mem.write32(AD.saveBlock2Ptr, SYS.sb2);
    mem.write32(SYS.fonts, SYS.fontTable);              // gFonts (set at the game's boot, not by the battle): without it AddTextPrinter returns at once and every message is instant
    // The environment hook: GetBattleEnvironment reads gBattleTerrain, which the real game derives from the map tile under the player (there is no map here)
    this.cpu.hookBefore(SYS.getBattleEnvironment, () => { mem.write8(AD.battleTerrain, this.environment); });
    this.environment = 0; this.foeBytes = null; this.keepTrainerParty = false;
    // A trainer battle builds the foe party from the trainer's ROM data (its species and levels). The arena chooses its own foe: the ROM's builder runs, then the host's party is written
    // over its result (slot 0 = the host's foe, the other slots empty). ctx.trainerParty = true keeps the ROM's party.
    const mk = (c) => {
      const mon = c.r[0] >>> 0;
      this.cpu.unhook(SYS.createTrainerMon);
      try { this.cpu.call(SYS.createTrainerMon, [c.r[0], c.r[1], c.r[2], c.r[3]]); } finally { this.cpu.hook(SYS.createTrainerMon, mk); }
      if (this.foeBytes && !this.keepTrainerParty && mon >= SYS.enemyParty && mon < SYS.enemyParty + 6 * SYS.partyStride) {
        const slot = (mon - SYS.enemyParty) / SYS.partyStride | 0;
        for (let i = 0; i < SYS.partyStride; i++) mem.write8(mon + i, slot === 0 ? this.foeBytes[i] : 0);
      }
    };
    this.cpu.hook(SYS.createTrainerMon, mk);
  }
}

/** The pool of console models behind animator.start / prepare ('system'). One SystemEngine is ~0.4 MB of RAM images plus a snapshot of the same size (the 16 MiB hook-flag array is shared
 *  between the engines of a pool): a run (prepared or playing) owns one engine; a finished run keeps its engine until a new run needs it, and its last frame is then frozen. */
export class SystemAnimator {
  constructor(rom, opts = {}) {
    this.rom = rom; this.opts = opts;
    this.slots = [];                                           // { engine, ppu, owner, index }
    this.maxEngines = opts.systemEngines === undefined ? 3 : Math.max(1, opts.systemEngines | 0);
    this.cacheMax = opts.systemCache === undefined ? 4 : Math.max(0, opts.systemCache | 0);
    this.cache = new Map();                                    // battle fingerprint -> { a: snapshot at the first action-select iteration, b: Map(plan id -> snapshot after the plan's preparation) }
    this.clock = 0; this.cacheHits = 0; this.cacheMisses = 0;
  }
  grow() {
    const engine = new SystemEngine(this.rom, { hookFlag: this.slots.length ? this.slots[0].engine.cpu.hookFlag : this.opts.hookFlag });
    const slot = { engine, ppu: new AnimPpu(engine.mem), owner: null, index: this.slots.length };
    this.slots.push(slot);
    return slot;
  }
  engineFor() { return (this.slots[0] || this.grow()).engine; }
  /** An engine for `owner` (a SystemRun): a free one, a new one while the pool may grow, then the least recently used FINISHED run's (its last frame is frozen), then the least recently used
   *  LIVE run's (it is evicted: done, run.evicted = true). A prepared handle is never taken: if every engine holds one, the pool is exhausted and this throws. */
  acquire(owner) {
    let slot = this.slots.find((s) => !s.owner) || (this.slots.length < this.maxEngines ? this.grow() : null);
    if (!slot) {
      const byUse = (a, b) => a.owner.lastUse - b.owner.lastUse;
      const finished = this.slots.filter((s) => s.owner.begun && s.owner.done).sort(byUse);
      const live = this.slots.filter((s) => s.owner.begun && !s.owner.done).sort(byUse);
      slot = finished[0] || live[0] || null;
      if (!slot) throw new MoveAnimError(`the system engine pool is exhausted: all ${this.slots.length} engines hold prepared runs (dispose one, or raise createMoveAnimator({ systemEngines }))`);
      slot.owner.surrender(!slot.owner.done);
    }
    slot.owner = owner; owner.slot = slot;
    return slot;
  }
  release(owner) { if (owner.slot && owner.slot.owner === owner) owner.slot.owner = null; owner.slot = null; }
  available(id) { return SYS_VALID.has(id) || id === 'battle' ? 'exact' : 'none'; }
  /** Prepare a run in slices: returns a handle (advance(budgetMs) ... ready ... begin()). id 'battle' only fills the battle-state cache (prewarm; no run to begin). */
  prepare(id, ctx = {}) {
    if (!SYS_VALID.has(id) && id !== 'battle') throw new MoveAnimError(`system id ${id} is not one of ${[...SYS_VALID].join(', ')} (or 'battle')`);
    const run = new SystemRun(this, id, ctx);
    return new SystemPrep(run);
  }
  /** Prepare completely (no budget) and begin: the frames are exactly those of the prepared path. */
  start(id, ctx = {}) {
    if (id === 'battle') throw new MoveAnimError("'battle' only prewarms the cache: use prepare()");
    const prep = this.prepare(id, ctx);
    try { prep.advance(Infinity); } catch (e) { prep.dispose(); throw e; }
    return prep.begin();
  }
  stats() {
    const bytes = (sn) => sn.mem.ewram.length + sn.mem.iwram.length + sn.mem.io.length + sn.mem.pram.length + sn.mem.vram.length + sn.mem.oam.length;
    let cacheBytes = 0, cacheSnapshots = 0;
    for (const e of this.cache.values()) { cacheBytes += bytes(e.a); cacheSnapshots++; for (const b of e.b.values()) { cacheBytes += bytes(b); cacheSnapshots++; } }
    return { engines: this.slots.length, maxEngines: this.maxEngines, busy: this.slots.filter((s) => s.owner).length, prepared: this.slots.filter((s) => s.owner && !s.owner.begun).length,
      live: this.slots.filter((s) => s.owner && s.owner.begun && !s.owner.done).length, cacheBattles: this.cache.size, cacheSnapshots, cacheBytes, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses };
  }
  clearCache() { this.cache.clear(); }
}

const defaultKeys = (period = 24, hold = 2, first = 24) => (frame) => (frame >= first && ((frame - first) % period) < hold ? KEY.A : 0);
const DEFAULT_KEYS = defaultKeys();

/** The handle of a run being prepared (animator.prepare('system', id, ctx)). advance(budgetMs) runs the ROM model for at most that long, checking the clock every SLICE_CHECK (2048)
 *  instructions; `ready` says it is done; begin() hands over the SystemRun (the frames from there on are exactly those of animator.start()); dispose() gives the engine back. */
export class SystemPrep {
  constructor(run) { this.run = run; }
  get ready() { return this.run.prepDone && !this.run.prepFailed; }
  get phase() { return this.run.prepDone ? 'ready' : this.run.prepPhase; }
  get error() { return this.run.prepError; }
  get profile() { return this.run.profile; }
  get cache() { return this.run.cacheUsed; }
  advance(budgetMs = 4) { return this.run.advance(budgetMs); }
  begin() { return this.run.begin(); }
  dispose() { this.run.disposePrep(); }
}

export class SystemRun {
  constructor(animator, id, ctx) {
    this.animator = animator; this.id = id; this.ctx = ctx; this.rom = animator.rom;
    this.slot = null; this.eng = null; this.ppu = null;
    const slot = animator.acquire(this); const eng = this.eng = slot.engine; this.ppu = slot.ppu;
    this.lastUse = ++animator.clock;
    eng.restoreSnapshot(); eng.curRun = this;
    eng.cpu.clock = typeof ctx.clock === 'function' ? () => ctx.clock(eng.cpu) : eng.cpu.defaultClock;   // ctx.clock(cpu) -> ms: the clock of advance() (tests drive it from the instruction count)
    this.frame = 0; this.done = false; this.error = null; this.truncated = false; this.ready = false;
    this.begun = false; this.evicted = false; this.frozen = null; this.reclaimed = false;
    this.maxFrames = ctx.maxFrames || 1500;
    this.handlers = new Map(); this.sePlayers = [null, null, null, null]; this.cry = null; this.messages = [];
    this.plan = PLANS[id] || (id === 'battle' ? { main: [], warm: true, trainer: !!ctx.trainer } : null);
    this.cryModel = ctx.cryModel || 'sample'; this.cryLatency = ctx.cryLatency === undefined ? 1 : ctx.cryLatency; this.seExtra = ctx.seExtra === undefined ? (this.plan ? 2 : 0) : ctx.seExtra;
    this.isSEPlayingFn = typeof ctx.isSEPlaying === 'function' ? ctx.isSEPlaying : null;
    this.keysFn = typeof ctx.keys === 'function' ? ctx.keys : (ctx.keys === null ? () => 0 : DEFAULT_KEYS);
    this.keyPolicy = typeof ctx.keys === 'function' ? 'custom' : ctx.keys === null ? 'none' : 'default';
    this.manualKeys = 0;
    this.prevRaw = 0; this.iter = 0; this.introIter = 0; this.iterTotal = 0; this._it = null;
    eng.hour = ctx.hour === undefined ? 12 : ctx.hour; eng.keepTrainerParty = !!ctx.trainerParty;
    eng.environment = ctx.environment === undefined ? 0 : ctx.environment;
    this.seed(ctx);
    this.installMessageHook();
    this.initPrep(ctx);
  }

  /* ---------------------------------------------------------------------------------------------------------- seeding */
  seed(ctx) {
    const eng = this.eng, mem = eng.mem, rom = this.rom;
    const put = (a, buf) => { for (let i = 0; i < buf.length; i++) mem.write8(a + i, buf[i]); };
    const tid = ctx.tid === undefined ? 0x2ded : ctx.tid, sid = ctx.sid === undefined ? 0xa7e3 : ctx.sid;
    // SaveBlock2: name, gender, trainer id, options (text speed fast = 1 frame per character, stereo, battle style set, battle scene on)
    put(SYS.sb2, field(ctx.playerName || 'Nova', 8)); mem.write8(SYS.sb2 + 8, ctx.gender === 'F' || ctx.gender === 1 ? 1 : 0);
    w16(tmp, 0, tid); w16(tmp, 2, sid); put(SYS.sb2 + 0xa, tmp.subarray(0, 4));
    mem.write8(SYS.sb2 + 0x14, 0x02); mem.write8(SYS.sb2 + 0x15, 0x03);
    mem.write8(SYS.sb2 + 0x16, ctx.sb2Option16 === undefined ? 0x30 : ctx.sb2Option16); mem.write8(SYS.sb1 + 0x19c3, ctx.sb1Flag19c3 === undefined ? 0x40 : ctx.sb1Flag19c3);
    if (ctx.saveBlocks) { if (ctx.saveBlocks.sb1) put(SYS.sb1, ctx.saveBlocks.sb1); if (ctx.saveBlocks.sb2) put(SYS.sb2, ctx.saveBlocks.sb2); }   // tests: the real game's own save blocks
    // the two parties (slot 0 of each side; the game counts the non-empty slots)
    const foe = ctx.foe || { species: 19, level: 3 }, pl = ctx.player || { species: 4, level: 5 };
    this.foeSpec = foe; this.playerSpec = pl;
    const pb = ctx.partyBytes || {};   // ctx.partyBytes = { foe, player }: raw 0x60-byte records (the oracle comparison feeds the exact bytes the real game had)
    const foeBytes = pb.foe || makePartyMon(rom, foe); eng.foeBytes = foeBytes;
    put(SYS.enemyParty, foeBytes); put(SYS.playerParty, pb.player || makePartyMon(rom, pl));
    // a trainer battle (id 1, or ctx.trainer): BATTLE_TYPE_TRAINER (8) and the opponent's trainer id, which the ROM's DrawTrainerPic / name / class code reads from the trainer-battle struct
    // at 0x02002398 (+2 = gTrainerBattleOpponent_A, a u16; 0x03fe is the secret-base trainer and not used here)
    const plan0 = PLANS[this.id], trainer = ctx.trainer === undefined ? ((this.id === SYS_ID.introTrainer || (plan0 && plan0.trainer)) ? 1 : 0) : ctx.trainer;
    mem.write32(AD.battleTypeFlags, ((ctx.battleTypeFlags === undefined ? 0 : ctx.battleTypeFlags) | (trainer ? 8 : 0)) >>> 0);
    if (trainer) { const tid = typeof trainer === 'number' && trainer > 1 ? trainer : 1; w16(tmp, 0, tid); put(SYS.trainerStruct + 2, tmp.subarray(0, 2)); }
    if (ctx.trainerStruct) put(SYS.trainerStruct, ctx.trainerStruct);   // tests: the real game's own bytes
    mem.write8(SYS.timeOfDay, ctx.timeOfDay === undefined ? 1 : ctx.timeOfDay);
    this.seedRng(ctx.seed === undefined ? 1 : ctx.seed);
    mem.write32(SYS.main + 4, SYS.battleInit); mem.write32(SYS.main, 0);
  }

  seedRng(seed) {
    let z = (seed >>> 0) || 1;
    const next = () => { z = (z + 0x9e3779b9) >>> 0; let t = z; t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0; t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0; return (t ^ (t >>> 16)) >>> 0; };
    const mem = this.eng.mem;
    for (const base of [AD.rng1, AD.rng2]) for (let i = 0; i < 4; i++) mem.write32(base + 4 * i, i === 3 ? 1 : next());
    this.seedValue = seed >>> 0;
  }

  installMessageHook() {
    const eng = this.eng, mem = eng.mem;
    eng.cpu.hookBefore(SYS.battlePutText, (c) => {
      const p = c.r[0] >>> 0, bytes = [];
      for (let i = 0; i < 300; i++) { const v = mem.read8(p + i); bytes.push(v); if (v === 0xff) break; }
      const text = decodeText(Uint8Array.from(bytes));
      this.messages.push({ frame: this.frame, text, window: c.r[1] & 0xff });
      eng.events.push({ type: 'message', text, window: c.r[1] & 0xff });
    });
  }

  /* ------------------------------------------------------------------------------------------------ sound model (as in Run) */
  noteCry(species, mode) {
    const f = this.cryModel === 'none' ? 0 : cryFrames(this.rom, species);
    this.cry = f ? { species, mode, start: this.iter, frames: f + this.cryLatency } : null;
  }
  cryPlaying() { return !!this.cry && this.iter - this.cry.start < this.cry.frames; }
  noteSound(index) { const s = songInfo(this.rom, index); if (s.player === 1 || s.player === 2) this.sePlayers[s.player] = { index, start: this.iter }; }
  sePlaying() {
    for (const p of [1, 2]) {
      const pl = this.sePlayers[p]; if (!pl) continue;
      const elapsed = this.iter - pl.start;
      // The recall (event 3 / 9: the one event whose end waits on a sound effect, SE 15) ends 2 frames later in the real game than the move engine's estimate (anim_sound.js, +1):
      // 0, 1, 3 and 4 extra frames were each measured to leave it inexact, 2 makes all 53 iterations identical. The INTRO is exact at 0 on 84 scenarios (2 breaks 7 of them), so the extra
      // applies to events only. ctx.seExtra overrides.
      if (this.isSEPlayingFn ? this.isSEPlayingFn(pl.index, elapsed) : defaultIsSEPlaying(this.rom, pl.index, elapsed - this.seExtra)) return true;
    }
    return false;
  }

  on(type, fn) { this.handlers.set(type, fn); return this; }
  emit(type, payload) { const h = this.handlers.get(type); if (h) h(payload); }

  /* --------------------------------------------------------------------------------------------------- the main loop */
  /** One iteration of the game's main loop: ReadKeys, callback1, callback2, then the VBlank work (the battle VBlank callback, the DMA queue). */
  iterate(userKeys) {
    const eng = this.eng, m = eng.mem, F = AD.fn, M = SYS.main;
    this.iterKeys(userKeys);
    const cb1 = m.read32(M); if (cb1) eng.call(cb1);
    const cb2 = m.read32(M + 4); if (cb2) eng.call(cb2);
    const vb = m.read32(M + 12); if (vb) eng.call(vb);
    eng.call(F.processDma3);
    eng.call(F.random); eng.call(F.random);              // the real main loop draws Random() twice per iteration (sfc32 counter +2: measured, ANIM.md)
    this.iterEnd();
  }
  /** The first part of an iteration: ReadKeys (gMain's key words) and the VBlank counters. */
  iterKeys(userKeys) {
    const m = this.eng.mem, M = SYS.main;
    const keys = ((userKeys | KEY.L) & 0x3ff) >>> 0;    // L held = the hack's native 1x battle speed (GetBattleSpeed reads gMain.heldKeys bit 9)
    const nw = keys & ~this.prevRaw;
    m.write16(M + 0x28, keys); m.write16(M + 0x2a, nw); m.write16(M + 0x2c, keys); m.write16(M + 0x2e, nw); m.write16(M + 0x30, nw);
    this.prevRaw = keys;
    m.write32(M + 0x20, (m.read32(M + 0x20) + 1) >>> 0); m.write32(M + 0x24, (m.read32(M + 0x24) + 1) >>> 0);
  }
  iterEnd() {
    if (this.eng.mem.read32(SYS.battleMainFunc) === SYS.intro || this.introIter > 0) this.introIter++;
    this.iter++; this.iterTotal = (this.iterTotal || 0) + 1;
  }

  /** The same iteration, in slices: runs the ROM calls through the core's resumable calls until `deadline` (a cpu.clock() value) passes at a check point; returns true when the
   *  iteration is complete, false when suspended (call again with a later deadline). The order of the calls, the addresses read between them and the budgets are those of iterate(). */
  iterSliced(deadline) {
    const eng = this.eng, cpu = eng.cpu, m = eng.mem, F = AD.fn, M = SYS.main;
    let it = this._it;
    if (!it) {
      this.iterKeys(this.manualKeys | this.keysFn(this.iterTotal || 0, this));
      it = this._it = { s: 0, label: '', phase: this._phaseName || 'hidden', t0: cpu.clock(), instr: 0 };
    }
    for (;;) {
      if (cpu.pending) {
        const before = cpu.icount, t = cpu.clock();
        let done;
        try { done = cpu.resume(deadline); } catch (e) { this._it = null; throw e; }
        this.prof(it.phase, it.label, cpu.icount - before, cpu.clock() - t);
        if (!done) return false;
      }
      // between two calls: yield too (a call that ended before its next check point must not be followed by another)
      if (it.s > 0 && deadline !== Infinity && cpu.icount - this._slice0 >= SLICE_CHECK && cpu.clock() >= deadline) return false;
      let addr = 0, label = '';
      switch (it.s++) {
        case 0: addr = m.read32(M); label = 'cb1'; break;
        case 1: addr = m.read32(M + 4); label = 'cb2'; break;
        case 2: addr = m.read32(M + 12); label = 'vblank'; break;
        case 3: addr = F.processDma3; label = 'dma3'; break;
        case 4: case 5: addr = F.random; label = 'random'; break;
        default: this.iterEnd(); this._it = null; this.profPhase(it.phase).iterations++; return true;
      }
      if (addr) { it.label = label; cpu.beginCall(addr, [], { budget: FRAME_BUDGET }); }
    }
  }

  /* ---------------------------------------------------------------------------------------------------- profile */
  profPhase(name) { return this.profile.phases[name] || (this.profile.phases[name] = { iterations: 0, instructions: 0, ms: 0, calls: {} }); }
  profLookup(ms) { this.profPhase('lookup').ms += ms; this.profile.ms += ms; }
  prof(phase, label, instr, ms) {
    const p = this.profPhase(phase), c = p.calls[label] || (p.calls[label] = { instructions: 0, ms: 0 });
    p.instructions += instr; p.ms += ms; c.instructions += instr; c.ms += ms;
    this.profile.instructions += instr; this.profile.ms += ms;
  }

  /* ---------------------------------------------------------------------------------------------------- system events */
  /** Write controller commands into the battlers' buffers and mark them for execution (what BtlController_Emit* + MarkBattlerForControllerExec do). The battle main function is parked on
   *  the ROM's own empty handler so the turn logic does not issue commands of its own while the event plays. */
  issue(list) {
    const m = this.eng.mem, res = m.read32(SYS.battleResources);
    m.write32(SYS.battleMainFunc, SYS.pauseMainFunc);
    for (const { battler, cmd } of list) {
      for (let i = 0; i < cmd.length; i++) m.write8(res + SYS.bufferA + battler * SYS.bufferStride + i, cmd[i]);
      m.write32(SYS.execFlags, (m.read32(SYS.execFlags) | (1 << battler)) >>> 0);
    }
  }

  /** A hash of everything on screen that moves: the 64 sprite structs and the I/O registers. Unchanged for several iterations = the event is over. */
  activity() {
    const m = this.eng.mem; let h = 0x811c9dc5;
    const o = AD.sprites - 0x02000000, ew = m.ewram;
    for (let i = 0; i < 64 * 0x44; i++) h = Math.imul(h ^ ew[o + i], 16777619) >>> 0;
    for (let i = 0; i < 0x58; i++) if (i !== 0x44 && i !== 0x45) h = Math.imul(h ^ m.io[i], 16777619) >>> 0;   // WIN0V (0x44) is rewritten every frame by the battle VBlank (161 / 160), it is not motion
    return h;
  }

  /* ---------------------------------------------------------------------------------------------------- preparation (sliced) */
  /** The preparation of a run is a small state machine. Events (ids 2..9) and 'battle': lookup (battle-state cache) -> hidden (the intro up to the first iteration of the action
   *  selection: 'init' until the ROM's main function is the intro's, then 'intro') -> pre (the plan's own preparation commands, settled) -> finish (party slot, counters, the plan's
   *  commands). Intros (ids 0 / 1): ahead (the first iteration, the one that costs 10-15 ms, is run now and delivered by the first step()). */
  initPrep(ctx) {
    this.prepDone = false; this.prepFailed = false; this.prepError = null; this.cacheUsed = null; this.aheadPending = false;
    this.profile = { phases: {}, instructions: 0, ms: 0, advances: 0 };
    this._slice0 = 0; this._ctx = ctx; this._fp = null; this._hid = null; this._settle = null;
    this.prepPhase = this.plan ? 'lookup' : ((ctx.lookahead === undefined ? 1 : ctx.lookahead) > 0 ? 'ahead' : 'finish');
  }

  /** Run the preparation for at most `budgetMs` of host time (Infinity = to the end). The clock is looked at every SLICE_CHECK (2048) ROM instructions inside a ROM call and between
   *  calls, so a call overshoots by at most that interval (and by whatever single non-interruptible unit it meets: a hook's nested ROM call, the graphics decoder, a JS step between
   *  calls: measured, ANIM.md "Round 4"). A budget of 0 still runs one check interval, so every advance() makes progress. A fault or budget overrun rethrows (and disposes). */
  advance(budgetMs = 4) {
    if (this.begun) throw new MoveAnimError('this run was already begun');
    if (this.prepDone) return { ready: true, phase: 'ready', ms: 0, instructions: 0 };
    if (this.prepFailed) throw this.prepError;
    if (this.prepDisposed) throw new MoveAnimError('this prepared run was disposed');
    const eng = this.eng, cpu = eng.cpu, t0 = cpu.clock(), i0 = cpu.icount;
    this.lastUse = ++this.animator.clock;
    const deadline = budgetMs === Infinity ? Infinity : t0 + Math.max(0, budgetMs);
    this._slice0 = i0;
    this.profile.advances++;
    try { this.prepRun(deadline); } catch (e) { this.prepFailed = true; this.prepError = e; eng.faults.push(e); this.disposePrep(); throw e; }
    return { ready: this.prepDone, phase: this.prepDone ? 'ready' : this.prepPhase, ms: cpu.clock() - t0, instructions: cpu.icount - i0 };
  }

  prepRun(deadline) {
    const eng = this.eng, m = eng.mem, plan = this.plan, ctx = this._ctx;
    for (;;) {
      switch (this.prepPhase) {
        case 'lookup': {
          const t = eng.cpu.clock();
          this.cacheable = !this.isSEPlayingFn && this.keyPolicy !== 'custom' && this.animator.cacheMax > 0;
          if (this.cacheable) {
            this._fp = this.fingerprint();
            const entry = this.animator.cache.get(this._fp);
            if (entry) {
              this.animator.cache.delete(this._fp); this.animator.cache.set(this._fp, entry);   // most recently used
              const b = plan.pre ? entry.b.get(this.id) : null;
              this.animator.cacheHits++;
              if (b) { this.restoreCached(b); this.cacheUsed = 'B'; this.prepPhase = 'finish'; } else { this.restoreCached(entry.a); this.cacheUsed = 'A'; this.prepPhase = plan.pre ? 'pre' : 'finish'; }
              if (plan.warm) { this.prepPhase = 'finish'; }
              this.profLookup(eng.cpu.clock() - t);
              break;
            }
            this.animator.cacheMisses++;
          }
          this.profLookup(eng.cpu.clock() - t);
          this._hid = { n: 0 };
          this.prepPhase = 'hidden';
          break;
        }
        case 'hidden': {
          for (;;) {
            if (!this._it) {
              const main = m.read32(SYS.battleMainFunc);
              if (main === SYS.actionSelect) break;
              if (this._hid.n >= 4000) throw new MoveAnimError('the battle never reached its action selection');
              this._phaseName = main === SYS.intro ? 'intro' : 'init';
            }
            if (!this.iterSliced(deadline)) return;
            this._hid.n++; eng.events.length = 0;
          }
          eng.events.length = 0;
          if (m.read32(SYS.battleMainFunc) !== SYS.actionSelect) throw new MoveAnimError('the battle never reached its action selection');
          if (this.cacheable) this.cachePut('a', null, this.captureCached());
          this.prepPhase = plan.warm ? 'finish' : plan.pre ? 'pre' : 'finish';
          break;
        }
        case 'pre': {
          if (!this._settle) { this.issue(plan.pre); this._settle = { last: -1, still: 0, n: 0 }; }
          const st = this._settle;
          for (;;) {
            if (!this._it) {
              const a = this.activity();
              st.still = a === st.last && m.read32(SYS.execFlags) === 0 ? st.still + 1 : 0; st.last = a;
              if (st.still >= 8 || st.n >= 600) break;
              this._phaseName = 'pre';
            }
            if (!this.iterSliced(deadline)) return;
            st.n++; eng.events.length = 0;
          }
          eng.events.length = 0;
          if (this.cacheable) this.cachePut('b', this.id, this.captureCached());
          this.prepPhase = 'finish';
          break;
        }
        case 'ahead': {   // intro: the first iteration of the visible run, delivered by the first step()
          this._phaseName = 'ahead';
          if (!this.iterSliced(deadline)) return;
          this.aheadPending = true;
          this.prepPhase = 'finish';
          break;
        }
        case 'finish': {
          if (plan && !plan.warm) this.finishEvent(ctx);
          if (plan && plan.warm) { this.animator.release(this); }   // a prewarm hands its engine back at once: it only fills the cache
          this.prepDone = true; this.prepPhase = 'ready';
          return;
        }
        default: throw new MoveAnimError('internal: unknown preparation phase ' + this.prepPhase);
      }
      // a check between phases too
      if (deadline !== Infinity && this.eng.cpu.icount - this._slice0 >= SLICE_CHECK && this.eng.cpu.clock() >= deadline && this.prepPhase !== 'finish') return;
    }
  }

  /** The end of the preparation of an event: the incoming Pokemon, the counters, the plan's commands. Frame 0 of the run is the first iteration after that. */
  finishEvent(ctx) {
    const eng = this.eng, m = eng.mem, plan = this.plan;
    for (const c of plan.main) if (c.foeParty1) {   // the trainer's next Pokemon goes into enemy party slot 1
      const spec = ctx.switchIn || { species: this.foeSpec.species === 1 ? 4 : 1, level: this.foeSpec.level || 5 };
      this.switchSpec = spec;
      const bytes = (ctx.partyBytes && ctx.partyBytes.switchIn) || makePartyMon(this.rom, spec);
      for (let i = 0; i < bytes.length; i++) m.write8(SYS.enemyParty + SYS.partyStride + i, bytes[i]);
    }
    for (const c of plan.main) if (c.party1) {      // the incoming Pokemon goes into party slot 1 (it is not there during the intro, so the party count the game derives stays 1)
      const spec = ctx.switchIn || { species: this.playerSpec.species === 1 ? 4 : 1, level: this.playerSpec.level || 5 };
      this.switchSpec = spec;
      const bytes = (ctx.partyBytes && ctx.partyBytes.switchIn) || makePartyMon(this.rom, spec);
      for (let i = 0; i < bytes.length; i++) m.write8(SYS.playerParty + SYS.partyStride + i, bytes[i]);
    }
    // The battle script's `switchindataupdate` copies the incoming Pokemon into gBattleMons[battler] BEFORE `switchinanim`; this event injects the controller command alone, so without
    // this the battler keeps the OUTGOING Pokemon's species. The visible consequence is the foe's ground shadow: SpriteCB_EnemyShadow (0x0807eb88) reads gBattleMons[1].species every
    // frame and takes its tile (shadow size class), x and y from the species record (+0xa2 x, +0xa3 y, +0xa4 size), so the sent-out Pokemon stood on the PREVIOUS one's shadow (real game,
    // natural trainer switch, ANIM.md Round 5). Only the species is written: reading every access to gBattleMons[battler] during ids 2 and 8, the ROM touches +0x0 (species) and +0x5c
    // (a flag byte, equal in both) and nothing else.
    for (const c of plan.main) if (c.foeParty1 || c.party1) {
      const base = c.foeParty1 ? SYS.enemyParty : SYS.playerParty;
      m.write16(SYS.battleMons + SYS.battleMonStride * c.battler, (m.read8(base + SYS.partyStride + 0x20) | (m.read8(base + SYS.partyStride + 0x21) << 8)) & 0x7ff);
    }
    this.hiddenIterations = this.iter; this.iter = 0; this.introIter = 0; this.frame = 0; this.messages = []; this.cry = null; this.sePlayers = [null, null, null, null];
    this.issue(plan.main);
    this.quiet = 0; this.lastActivity = -1;
  }

  /* ---------------------------------------------------------------------------------------------------- the battle-state cache */
  /** What the whole hidden pre-roll depends on: the seeded RAM (parties, save blocks, flags, time of day, RNG ...) and the few settings kept outside it. Two 32-bit hashes of EWRAM +
   *  IWRAM and the settings; a run whose fingerprint is cached restores the snapshot instead of playing the intro again. Bypassed when ctx.keys is a function or ctx.isSEPlaying is set. */
  fingerprint() {
    const m = this.eng.mem, e = new Int32Array(m.ewram.buffer, m.ewram.byteOffset, m.ewram.length >> 2), w = new Int32Array(m.iwram.buffer, m.iwram.byteOffset, m.iwram.length >> 2);
    let h1 = 0x811c9dc5 | 0, h2 = 0x2545f491 | 0;
    for (let i = 0; i < e.length; i++) { const v = e[i]; h1 = Math.imul(h1 ^ v, 0x01000193); h2 = (Math.imul(h2 + v, 0x85ebca6b) ^ (h2 >>> 13)) | 0; }
    for (let i = 0; i < w.length; i++) { const v = w[i]; h1 = Math.imul(h1 ^ v, 0x01000193); h2 = (Math.imul(h2 + v, 0x85ebca6b) ^ (h2 >>> 13)) | 0; }
    const foe = this.eng.foeBytes; let fh = 0; if (foe) for (let i = 0; i < foe.length; i++) fh = Math.imul(fh ^ foe[i], 16777619);
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + JSON.stringify([this.eng.hour, this.eng.environment, this.cryModel, this.cryLatency, this.seExtra, this.eng.keepTrainerParty, fh >>> 0, this.keyPolicy]);
  }
  captureCached() {
    const eng = this.eng, m = eng.mem;
    return { mem: eng.takeSnapshot(), x: { prevRaw: this.prevRaw, iter: this.iter, iterTotal: this.iterTotal, introIter: this.introIter, cry: this.cry ? { ...this.cry } : null,
      sePlayers: this.sePlayers.map((p) => (p ? { ...p } : null)), bg3Anim: eng.bg3Anim, hblankDma: m.hblankDma ? { ...m.hblankDma } : null, bgMode: m.bgMode } };
  }
  restoreCached(sn) {
    const eng = this.eng, m = eng.mem, x = sn.x;
    eng.restoreSnapshot(sn.mem);
    this.prevRaw = x.prevRaw; this.iter = x.iter; this.iterTotal = x.iterTotal; this.introIter = x.introIter; this.cry = x.cry ? { ...x.cry } : null;
    this.sePlayers = x.sePlayers.map((p) => (p ? { ...p } : null));
    eng.bg3Anim = x.bg3Anim; m.hblankDma = x.hblankDma ? { ...x.hblankDma } : null; m.bgMode = x.bgMode;
  }
  cachePut(level, planId, sn) {
    const c = this.animator.cache; let e = c.get(this._fp);
    if (!e) { e = { a: null, b: new Map() }; c.set(this._fp, e); while (c.size > this.animator.cacheMax) c.delete(c.keys().next().value); }
    if (level === 'a') e.a = sn; else e.b.set(planId, sn);
    if (!e.a) c.delete(this._fp);
  }

  /* ---------------------------------------------------------------------------------------------------- begin / dispose / pool */
  begin() {
    if (this.begun) throw new MoveAnimError('this run was already begun');
    if (!this.prepDone || this.prepFailed) throw new MoveAnimError('begin(): the run is not ready (advance() until handle.ready)');
    if (this.id === 'battle') throw new MoveAnimError("a 'battle' prewarm has no run to begin");
    if (!this.slot) throw new MoveAnimError('begin(): the prepared engine was taken away');
    this.begun = true; this.lastUse = ++this.animator.clock; this.eng.curRun = this;
    return this;
  }
  disposePrep() {
    if (this.begun) { this.dispose(); return; }
    if (this.eng && this.eng.cpu.pending) this.eng.cpu.abortCall();
    this._it = null; this.done = true; this.prepDisposed = true;
    this.animator.release(this);
  }
  /** The pool takes this run's engine (it is the least recently used): a finished run keeps its last picture (frozen), a live one is cut off (evicted). */
  surrender(live) {
    if (this.eng.cpu.pending) this.eng.cpu.abortCall();
    this._it = null;
    this.frozen = { rgba: Uint8Array.from(this.drawNow(0x1f, null)), battlers: [this.battlerState(0), this.battlerState(1)] };
    this.reclaimed = true; if (live) { this.evicted = true; this.done = true; }
    this.animator.release(this);
  }

  step() {
    if (this.done) return;
    if (!this.begun) throw new MoveAnimError('this run was only prepared: call begin() on its handle (or use animator.start())');
    this.lastUse = ++this.animator.clock;
    const eng = this.eng, saved = eng.callBudget, evStart = this.aheadPending ? 0 : eng.events.length;
    eng.callBudget = FRAME_BUDGET;
    try {
      if (!this.aheadPending) { const keys = this.manualKeys | this.keysFn(this.iterTotal || 0, this); this.iterate(keys); }
    } catch (e) { this.error = e; this.done = true; eng.faults.push(e); }
    this.aheadPending = false;
    eng.callBudget = saved;
    this.frame++;
    for (let i = evStart; i < eng.events.length; i++) this.emit(eng.events[i].type, eng.events[i]);
    eng.events.length = 0;
    this.checkDone();
  }

  checkDone() {
    const m = this.eng.mem;
    if (this.plan) {
      const a = this.activity();
      this.quiet = a === this.lastActivity && m.read32(SYS.execFlags) === 0 ? this.quiet + 1 : 0; this.lastActivity = a;
      if (this.quiet >= 8) { this.done = true; this.ready = true; this.settledAt = this.frame - 8; }
      else if (this.frame >= this.maxFrames) { this.done = true; this.truncated = true; }
      return;
    }
    if ((this.id === SYS_ID.intro || this.id === SYS_ID.introTrainer) && m.read32(SYS.battleMainFunc) === SYS.actionSelect && m.read32(SYS.controllerFuncs) === SYS.actionMenuController) { this.ready = true; this.done = true; }
    else if (this.frame >= this.maxFrames) { this.done = true; this.truncated = true; }
  }

  /** Hold these keys (a KEY mask) on top of the key policy until changed. (A prepared intro has run its first iteration already: the mask applies from the second.) */
  setKeys(mask) { this.manualKeys = mask >>> 0; }

  battlerState(side) {
    if (this.frozen) return this.frozen.battlers[side === 'player' || side === 0 ? 0 : 1];
    const mem = this.eng.mem, b = side === 'player' || side === 0 ? 0 : 1, id = mem.ewU8(AD.battlerSpriteIds + b);
    if (id === 0xff || id > 63) return null;
    const sp = AD.sprites + id * 0x44, a0 = mem.ewU16(sp);
    return { x: mem.ewU16(sp + 2) & 511, y: a0 & 255, dx: mem.ewS16(sp + 0x24), dy: mem.ewS16(sp + 0x26), visible: (mem.ewU8(sp + 0x3e) & 4) === 0 };
  }

  dispose() {
    this.done = true;
    if (this.eng && this.eng.cpu.pending) this.eng.cpu.abortCall();
  }

  drawNow(layers, base) {
    const ppu = this.ppu;
    ppu.layerMask = layers;
    ppu.setBaseRGBA(base || null);
    return ppu.render();
  }
  /** Render the current frame (RGBA 240x160) into target ({data} or an RGBA array). opts.layers: bitmask (bit n = BG n, bit 4 = OBJ; default all). After the pool took this run's engine
   *  for a newer run the last picture is returned (layers / base are then ignored). */
  draw(target, opts = {}) {
    const data = target && target.data ? target.data : target;
    if (this.frozen) { if (data) data.set(this.frozen.rgba); return this.frozen.rgba; }
    const out = this.drawNow(opts.layers === undefined ? 0x1f : opts.layers, opts.base);
    if (data) data.set(out);
    return out;
  }
}
const tmp = new Uint8Array(8);

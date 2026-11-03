// tools/pokemonarena_rom_diff_live.mjs -- stage FA2 layer 2: the engine's damage versus the REAL GAME's damage.
//
// For each scenario of tools/pokemonarena_rom_diff_combos.mjs the same two battlers go into SoulGold's own battle code (through OR1's
// oracle, tools/pokemonarena_rom_oracle.mjs): both gBattleMons records are overwritten (stats, level, HP, types, ability, item, stat
// stages, status), the weather word and the target's side-status word are set, the player's FIGHT -> move 1 is pressed, and the first drop of
// the foe's HP is the damage of one hit. The game's RNG is not seeded by us (its seed is not located); the draw is varied by waiting
// 0..N-1 frames before pressing, which moves the RNG on. The engine side (engine.previewDamage) gives the set of 16 damages of one hit,
// with and without a critical hit. A scenario MATCHES when every damage the real game produced is a member of the engine's set.
//
// Addresses (gBattleMons.status1 / weather / side statuses) were found by diffing EWRAM across the use of Will-O-Wisp, Toxic, Rain Dance,
// Sunny Day, Sandstorm, Hail, Snowscape, Reflect, Light Screen and then confirmed by their effect on the damage (pokemonarena/ROMDIFF.md).
// Needs OR1's oracle and its cached checkpoints (a missing cache is rebuilt by replaying the route).  Nothing is written inside the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// gFieldStatuses (u32) and its timers, FOUND by diffing EWRAM across the moves: Trick Room 0x2, Gravity 0x20, Grassy 0x40, Misty 0x80, Electric 0x100, Psychic 0x200;
// the terrain timer is byte 2 of the word at 0x02001dc8 (5 on use, 4 after the turn), the Gravity timer is byte 0 of 0x02001dcc, the Trick Room timer byte 0 of 0x02001dc8
export const FIELD = Object.freeze({ word: 0x02001d2c, timerA: 0x02001dc8, timerB: 0x02001dcc, bits: { trickroom: 0x2, gravity: 0x20, grassy: 0x40, misty: 0x80, electric: 0x100, psychic: 0x200, scorched: 0x1000 } });
export function fieldWordOf(x) { let w = 0; for (const k of [].concat(x || [])) w |= FIELD.bits[k] || 0; return w; }
export const ADDR = Object.freeze({
  status1Off: 0x54, status2Off: 0x58,                 // inside a gBattleMons record
  weather: 0x02001e3c,                                  // u32 word: rain 1, sun 8, sand 0x20, hail 0x40, snow 0x80
  sideStatus: 0x02001dd0,                               // u32 per side: reflect 1, light screen 2, aurora veil 0x20
});
const WEATHER_WORD = { rain: 1, sun: 8, sand: 0x20, hail: 0x40, snow: 0x80, hrain: 0x2, hsun: 0x10, winds: 0x200 };   // the last three are the primal weathers (words found by entering the battle with Primordial Sea / Desolate Land / Delta Stream)
const SIDE_BIT = { reflect: 1, light: 2, veil: 0x20 };
const STATUS1 = { brn: 0x10, psn: 0x08, par: 0x40, tox: 0x80, frz: 0x20, slp: 0x02, fbt: 0x1000 };   // 0x1000 = FROSTBITE: found because every Ice move leaves this bit, never 0x20 (freeze)
const RNG_ADDR = 0x03005a68;   // the game's RNG: sfc32 state { a, b, c, counter } as four u32 (Random() = top 16 bits of t = a + b + counter)
const INNATE_OFF = 0x8e;   // gBattleMons record: three u16 innate ability ids (copied from the species record at +0x20/+0x22/+0x24 when the battle starts)
const STAGE_IDX = { atk: 1, def: 2, spe: 3, spa: 4, spd: 5, acc: 6, eva: 7 };

/** find an sfc32 state whose first K outputs (top 16 bits) all lie in [lo, hi] (the game's RNG: see ROM 0x0821c684) */
export function findSeed(lo, hi, K = 5, rngSeed = 1) {
  let x = (rngSeed >>> 0) || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (let tries = 0; tries < 4e9; tries++) {
    let a = next(), b = next(), c = next(), n = next();
    const s0 = [a, b, c, n];
    let ok = true;
    for (let j = 0; j < K; j++) {
      const t = (((a + b) >>> 0) + n) >>> 0; const v = t >>> 16;
      if (v < lo || v > hi) { ok = false; break; }
      const a2 = (b ^ (b >>> 9)) >>> 0, b2 = (c + ((c << 3) >>> 0)) >>> 0, c2 = ((((c >>> 11) | (c << 21)) >>> 0) + t) >>> 0;
      a = a2; b = b2; c = c2; n = (n + 1) >>> 0;
    }
    if (ok) return s0;
  }
  return null;
}
/** like findSeed, but the first K draws (top 16 bits) must satisfy pred(v): used for chances the game rolls as Random() % 100 */
export function findSeedPred(pred, K = 5, rngSeed = 1) {
  let x = (rngSeed >>> 0) || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  for (let tries = 0; tries < 4e9; tries++) {
    let a = next(), b = next(), c = next(), n = next();
    const s0 = [a, b, c, n];
    let ok = true;
    for (let j = 0; j < K; j++) {
      const t = (((a + b) >>> 0) + n) >>> 0; const v = t >>> 16;
      if (!pred(v)) { ok = false; break; }
      const a2 = (b ^ (b >>> 9)) >>> 0, b2 = (c + ((c << 3) >>> 0)) >>> 0, c2 = ((((c >>> 11) | (c << 21)) >>> 0) + t) >>> 0;
      a = a2; b = b2; c = c2; n = (n + 1) >>> 0;
    }
    if (ok) return s0;
  }
  return null;
}
const seedCache = new Map();
export function seedFor(lo, hi, K = 5) { const key = lo + ':' + hi + ':' + K; if (!seedCache.has(key)) seedCache.set(key, findSeed(lo, hi, K, lo * 31 + hi + K)); return seedCache.get(key); }

export async function openLive(opts = {}) {
  const OR = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_oracle.mjs')).href);
  const stateDir = opts.stateDir || process.env.ARENA_OR1_DIR || undefined;
  const o = await OR.openOracle(stateDir ? { stateDir, romPath: opts.romPath } : { romPath: opts.romPath });
  await o.goto('CK_ACTION_MENU');
  return new Live(o, OR.FINDINGS, { ...opts, actionMenuFn: OR.FUNCS.controller0.actionMenu, moveMenuFn: OR.FUNCS.controller0.moveMenu, actionSelectFn: OR.FUNCS.battleMain.actionSelect });
}

export class Live {
  constructor(o, findings, opts) {
    this.o = o; this.B = findings.gBattleMons; this.F = this.B.fields; this.blob = o.saveStateBlob();
    this.A0 = this.B.addr; this.A1 = this.B.addr + this.B.stride; this.pack = opts.pack; this.ids = opts.ids;
    this.trials = 0;
    this.ctlAddr = findings.gBattlerControllerFuncs.addr; this.mainAddr = findings.gBattleMainFunc.addr; this.actionMenuFn = opts.actionMenuFn; this.moveMenuFn = opts.moveMenuFn; this.actionWaitFn = 0x08061b9d; this.actionSelectFn = opts.actionSelectFn;
  }
  writeMon(base, m) {
    const o = this.o, F = this.F;
    const W16 = (off, v) => o.writeU16(base + off, v), W8 = (off, v) => o.writeU8(base + off, v);
    if (m.species !== undefined) W16(F.species, m.species);
    for (const [k, off] of [['atk', F.attack], ['def', F.defense], ['spe', F.speed], ['spa', F.spAttack], ['spd', F.spDefense]]) if (m[k] !== undefined) W16(off, m[k]);
    if (m.level !== undefined) W8(F.level, m.level);
    if (m.friendship !== undefined) W8(F.friendship, m.friendship);
    if (m.maxhp !== undefined) W16(F.maxHP, m.maxhp);
    if (m.hp !== undefined) W16(F.hp, m.hp);
    if (m.moves) m.moves.forEach((id, i) => W16(F.moves + 2 * i, id));
    if (m.pp) m.pp.forEach((v, i) => W8(F.pp + i, v));
    if (m.ability !== undefined) W16(F.ability, m.ability);
    if (m.types) { W8(F.type1, m.types[0]); W8(F.type2, m.types[1] === undefined ? m.types[0] : m.types[1]); W8(F.type3, 10); }
    if (m.item !== undefined) W16(F.item, m.item);
    if (m.personality !== undefined) o.writeU32(base + 0x50, m.personality >>> 0);   // gender = personality low byte against the species' ratio byte
    // innate ability slots of the battle record (+0x8e/+0x90/+0x92): ALWAYS written, so a scenario never inherits the checkpoint's innates (the live game gates them by level: 75/85/95)
    { const inn = m.inn || [0, 0, 0]; for (let k = 0; k < 3; k++) W16(INNATE_OFF + 2 * k, inn[k] || 0); }
    for (let i = 1; i < 8; i++) W8(F.statStages + i, 6);
    if (m.stages) for (const [k, v] of Object.entries(m.stages)) W8(F.statStages + STAGE_IDX[k], 6 + v);
    o.writeU32(base + ADDR.status1Off, m.status1 || 0);
    o.writeU32(base + ADDR.status2Off, m.status2 || 0);
    o.writeU32(base + ADDR.status2Off + 4, m.infat || 0);
  }
  /** one trial: restore the action-menu checkpoint, set the scenario, wait `delay` frames, FIGHT -> move 1, return the first HP drop of the foe.
   *  `rng` (4 u32): the game's RNG state is rewritten before EVERY frame, so the draws of the frame in which the move executes are a known sequence. */
  trial(setup, delay, maxFrames = 900, rng = null) {
    const o = this.o;
    const setS = rng ? () => { for (let k = 0; k < 4; k++) o.writeU32(RNG_ADDR + 4 * k, rng[k]); } : null;
    o.loadStateBlob(this.blob);
    this.writeMon(this.A0, { spe: 500, pp: [30, 0, 0, 0], ...setup.a });
    this.writeMon(this.A1, { spe: 5, moves: [this.ids.move('Splash'), 0, 0, 0], pp: [30, 0, 0, 0], ...setup.b });
    o.writeU32(ADDR.weather, setup.weatherWord || 0);
    writeField(o, setup.fieldWord || 0);
    o.writeU32(ADDR.sideStatus, 0); o.writeU32(ADDR.sideStatus + 4, setup.sideWord || 0);
    if (setS) {
      const hold = (key, n) => { for (let i = 0; i < n; i++) { setS(); o.runFrames(1, key); } };
      hold(0, delay); hold('A', 5); hold(0, 40); hold('A', 5); hold(0, 3);
    } else { o.runFrames(delay); o.press('A', 5, 40); o.press('A', 5, 3); }
    const hp0 = o.battleMon(1).hp;
    this.trials++;
    for (let f = 0; f < maxFrames; f++) { if (setS) setS(); o.runFrames(1); const h = o.battleMon(1).hp; if (h !== hp0) return { d: hp0 - h, hp: h, frames: f }; }
    return { d: 0, hp: hp0, frames: maxFrames };
  }
}

/** Put the field words (terrain / Gravity / Trick Room) into the game; timers get 5. */
export function writeField(o, w) {
  o.writeU32(FIELD.word, w);
  o.writeU8(FIELD.timerA + 2, w & 0x13c0 ? 5 : 0);
  o.writeU8(FIELD.timerB, w & 0x20 ? 5 : 0);
  o.writeU8(FIELD.timerA, w & 0x2 ? 5 : 0);
}

// ---- turn-state differential (non-damage effects, residuals, turn order) ----------------------------------------------------------
const OBS_ORDER = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
const STAGE_SLOT = { atk: 1, def: 2, spe: 3, spa: 4, spd: 5, acc: 6, eva: 7 };
function status1Code(w) { if (w & 0x1000) return 7; if (w & 0x80) return 6; if (w & 0x08) return 2; if (w & 0x10) return 3; if (w & 0x20) return 4; if (w & 0x40) return 5; if (w & 0x07) return 1; return 0; }
/** [terrain id (1 grassy, 2 electric, 3 misty, 4 psychic; 0 none), Gravity 0/1] from the field word */
export function fieldCode(w) { return [w & 0x40 ? 1 : w & 0x100 ? 2 : w & 0x80 ? 3 : w & 0x200 ? 4 : 0, w & 0x20 ? 1 : 0, w & 0x1000 ? 1 : 0]; }
function weatherCode(w) { if (w & 2) return 6; if (w & 0x10) return 7; if (w & 0x200) return 8; if (w & 1) return 1; if (w & 8) return 2; if (w & 0x20) return 3; if (w & 0x40) return 4; if (w & 0x80) return 5; return 0; }
let turnSeed = null;
export function turnLive(live, sc, ids, T, OR) {
  const o = live.o, F = live.F;
  if (!turnSeed) turnSeed = findSeed(32768, 36863, 6, 77);
  const dfc = sc.drawFrac !== undefined ? Math.round(sc.drawFrac * 65536) : null;
  const seedUse = sc.seedState || (dfc !== null ? seedFor(Math.max(0, dfc - 700), Math.min(65535, dfc + 700), 6) : sc.seedRange ? seedFor(sc.seedRange[0], sc.seedRange[1], 6) : turnSeed);   // optional: draws forced into a given 16-bit range (chance probes)
  const setS = () => { for (let k = 0; k < 4; k++) o.writeU32(RNG_ADDR + 4 * k, seedUse[k]); };
  o.loadStateBlob(live.blob);
  const side = (x, mv) => ({
    ...(x.gender ? genderSpec(live.pack, x.gender) : {}), species: x.species || (x.gender ? genderSpec(live.pack, x.gender).species : 0), level: sc.level || 50, atk: x.st.atk, def: x.st.def, spa: x.st.spa, spd: x.st.spd, spe: x.st.spe, hp: x.hp, maxhp: x.maxhp,
    types: x.types.map((n) => T[n.toUpperCase()]), ability: ids.ability(x.ability), item: ids.item(x.item), stages: x.stages || {}, status1: x.status ? STATUS1[x.status] : 0,
    moves: [ids.move(mv), 0, 0, 0], pp: [30, 0, 0, 0], inn: x.inn ? x.inn.map((n) => ids.ability(n)) : undefined,
    infat: x.inf ? 2 : 0,   // the hack keeps infatuation in the word after status2 (+0x5c): bit n = in love with battler n (found by diffing the battle struct across Attract)
  });
  live.writeMon(live.A0, side(sc.a, sc.aMove));
  { const fb = side(sc.b, sc.bMove); fb.moves = [fb.moves[0], fb.moves[0], fb.moves[0], fb.moves[0]]; fb.pp = [30, 30, 30, 30]; live.writeMon(live.A1, fb); }
  o.writeU32(ADDR.weather, sc.weather ? WEATHER_WORD[sc.weather] : 0);
  writeField(o, fieldWordOf(sc.field));
  const sideWord = (bits) => (bits || []).reduce((w, k) => w | ({ sg: 4, mist: 8, tw: 0x10 }[k] || 0), 0);
  o.writeU32(ADDR.sideStatus, sideWord(sc.sideBits && sc.sideBits.a)); o.writeU32(ADDR.sideStatus + 4, sideWord(sc.sideBits && sc.sideBits.b));
  const hold = (key, n) => { for (let i = 0; i < n; i++) { setS(); o.runFrames(1, key); } };
  const atMenu = () => { const c = o.readU32(live.ctlAddr); return (c === live.actionMenuFn || c === live.actionWaitFn) && o.readU32(live.mainAddr) === live.actionSelectFn; };
  live.trials++;
  if (sc.group === 'order') {
    hold('A', 5); hold(0, 40); hold('A', 5); hold(0, 3);
    for (let f = 0; f < 600; f++) { setS(); o.runFrames(1); const h0 = o.battleMon(0).hp, h1 = o.battleMon(1).hp; if (h0 !== sc.a.hp || h1 !== sc.b.hp) return { hp: [h0, h1] }; }
    return { hp: [o.battleMon(0).hp, o.battleMon(1).hp], timeout: true };
  }
  const seq = sc.seq || Array(sc.turns || 1).fill(sc.aMove);
  const trace = []; const texts = []; let lastTx = '';
  for (let t = 0; t < seq.length; t++) {
    o.writeU16(live.A0 + F.moves, ids.move(seq[t])); o.writeU8(live.A0 + F.pp, 30);
    hold('A', 5); hold(0, 40); hold('A', 5); hold(0, 3);
    let f = 0;
    const LIM = sc.seq && sc.seq.length > 1 ? 6000 : 2400;
    let stuckT = '', stuckN = 0;
    for (; f < LIM; f++) { setS(); { const tx0 = f % 20 === 0 ? o.battleText() : stuckT; if (tx0 === stuckT) stuckN += f % 20 === 0 ? 20 : 0; else { stuckT = tx0; stuckN = 0; } } o.runFrames(1, (f % 50 < 3 && /{FB}|{FA}/.test(o.battleText())) || (stuckN >= 240 && f % 20 < 3) ? 'A' : 0); if (sc.text && f % 4 === 0) { const tx = (o.battleText() || '').replace(/s+/g, ' ').trim(); if (tx && tx !== lastTx) { texts.push(tx); lastTx = tx; } } if (f > 30 && atMenu() && (!sc.lock || /What will/.test(o.battleText() || ''))) break; }
    if (f >= LIM) return { timeout: true, hp: [o.battleMon(0).hp, o.battleMon(1).hp], text: o.battleText(), texts, ctl: o.readU32(live.ctlAddr).toString(16), main: o.readU32(live.mainAddr).toString(16) };
    trace.push([o.battleMon(0).hp, o.battleMon(1).hp]);
  }
  const m = [o.battleMon(0), o.battleMon(1)];
  const sg = (mm) => OBS_ORDER.map((k) => mm.statStages[STAGE_SLOT[k]] - 6);
  const sw = [o.readU32(ADDR.sideStatus), o.readU32(ADDR.sideStatus + 4)];
  return {
    trace, texts, hp: [m[0].hp, m[1].hp], sg: [sg(m[0]), sg(m[1])],
    st: [status1Code(o.readU32(live.A0 + ADDR.status1Off)), status1Code(o.readU32(live.A1 + ADDR.status1Off))],
    wx: weatherCode(o.readU32(ADDR.weather)),
    fld: fieldCode(o.readU32(FIELD.word)),
    side: sw.map((w) => ({ reflect: w & 1 ? 1 : 0, light: w & 2 ? 1 : 0, veil: w & 0x20 ? 1 : 0, sg: w & 4 ? 1 : 0, mist: w & 8 ? 1 : 0, tw: w & 0x10 ? 1 : 0 })),
    conf: [(o.readU32(live.A0 + ADDR.status2Off) & 7) ? 1 : 0, (o.readU32(live.A1 + ADDR.status2Off) & 7) ? 1 : 0],
    s2: [o.readU32(live.A0 + ADDR.status2Off), o.readU32(live.A1 + ADDR.status2Off)],
    inf: [(o.readU32(live.A0 + ADDR.status2Off + 4) & 0xf) ? 1 : 0, (o.readU32(live.A1 + ADDR.status2Off + 4) & 0xf) ? 1 : 0],
    item: [m[0].item ? 1 : 0, m[1].item ? 1 : 0],
    pp: [m[0].pp[0], m[1].pp[0]],
    ty: [0, 1].map((i) => [...new Set([m[i].type1, m[i].type2, ...(m[i].type3 !== undefined && m[i].type3 !== 10 && m[i].type3 !== 0 ? [m[i].type3] : [])])].sort((x, y) => x - y)),   // the third slot (10 = none) holds a type Trick-or-Treat / Forest's Curse added
    ab: [m[0].ability, m[1].ability],
  };
}

/** Run one ENTRY scenario in the real game: a battle is built by the game itself with a roster species that holds the ability (level 100, so its innates are
 *  active), optional pre-set field/weather/timer, and the state is read at the first action menu.  Returns the observation plus what the engine side needs (real ids). */
/** A real species with a known gender ratio and a personality value that gives the wanted gender: M / F need a two-gender species, '-' a genderless one. */
export function genderSpec(pack, gender) {
  const want = gender === '-' ? (s) => s.genderRatio === 255 : (s) => s.genderRatio === 127;
  const sp = pack.species.find((s) => s && s.legal && want(s));
  const ratio = sp.genderRatio;
  let lo = 0x1234;
  if (ratio !== 255) for (let i = 0; i < 256; i++, lo = (lo + 1) & 0xffff) { const female = (lo & 0xff) < ratio; if ((gender === 'F') === female) break; }
  return { species: sp.id, personality: ((0x55aa << 16) | lo) >>> 0 };
}

/** The entry announcements the differential compares (round 5): the real game's battle text -> a short key (frisk and forewarn carry the item / move name). */
export const ANN_TEXT = [['pressure', /exerting its pressure/], ['mold-breaker', /breaks the mold/], ['turboblaze', /radiating a blazing aura/], ['teravolt', /radiating a bursting aura/], ['dark-aura', /radiating a dark aura/], ['fairy-aura', /radiating a fairy aura/],
  ['aura-break', /reversed all other/], ['weather-lock', /effects of the weather disappeared/], ['frisk', /frisked .+? and found its (.+?)!/], ['forewarn', /alerted .+? to .+?'s (.+?)!/], ['anticipation', /shuddered/]];
const WX_TEXT = [['rain', /made it rain/], ['sun', /intensified the sun's rays/]];   // the weather setters, for the start-of-battle order scenarios only
export function annOf(texts, withWeather) {
  const out = [];
  for (const raw of texts) { const tx = String(raw).replace(/\{39\}/g, ' ').replace(/\s+/g, ' '); for (const [k, re] of withWeather ? [...ANN_TEXT, ...WX_TEXT] : ANN_TEXT) { const m = re.exec(tx); if (m) out.push(m[1] ? k + ':' + m[1] : k); } }
  return out;
}
/** Round 6: a battle where BOTH leads announce something. The real game's order of the two (and the weather that stays) is read from the text; the speeds are forced through the stats the oracle writes. */
export async function startLive(live, sc) {
  const o = live.o, pack = live.pack;
  const pickBy = (abName) => {
    const abId = pack.abilities.find((a) => a && a.name === abName).id;
    for (const s of pack.species) { if (!s || s.legal === false || !s.innates) continue; const k = s.abilities.indexOf(abId); if (k >= 0) return { s, num: k }; }
    return null;
  };
  const P = pickBy(sc.pAb), F = pickBy(sc.fAb);
  if (!P || !F) return { noHolder: true };
  const spl = live.ids.move('Splash');
  await o.startBattle({
    foe: { species: F.s.id, level: 50, moves: [spl, 0, 0, 0], hp: 300, maxHp: 300, abilityNum: F.num, stats: { atk: 100, def: 100, spe: sc.fSpe, spa: 100, spd: 100 } },
    player: { species: P.s.id, level: 50, moves: [spl, 0, 0, 0], hp: 300, maxHp: 300, abilityNum: P.num, stats: { atk: 100, def: 100, spe: sc.pSpe, spa: 100, spd: 100 } },
    reach: 'intro',
  });
  const atMenu = () => { const c = o.readU32(live.ctlAddr); return (c === live.actionMenuFn || c === live.actionWaitFn) && o.readU32(live.mainAddr) === live.actionSelectFn; };
  const texts = []; let last = ''; let f = 0;
  for (; f < 3000; f++) { o.runFrames(1, f % 40 < 3 && !atMenu() ? 'A' : 0); const tx = (o.battleText() || '').replace(/\s+/g, ' ').trim(); if (tx && tx !== last) { texts.push(tx); last = tx; } if (f > 20 && atMenu()) break; }
  return { ann: annOf(texts, true), wx: weatherCode(o.readU32(ADDR.weather)), texts, timeout: f >= 3000, real: { p: P.s.id, pn: P.num, f: F.s.id, fn: F.num } };
}
export async function entryLive(live, sc) {
  const o = live.o, pack = live.pack, FL = FIELD;
  const abId = pack.abilities.find((a) => a && a.name === sc.ab).id;
  let pick = null;
  for (const s of pack.species) { if (!s || s.legal === false || !s.innates) continue; const k = s.abilities.indexOf(abId); if (k >= 0) { pick = { s, num: k }; break; } }
  if (!pick) for (const s of pack.species) { if (!s || s.legal === false || !s.innates) continue; if (s.innates.includes(abId)) { pick = { s, num: 0 }; break; } }
  if (!pick) return { noHolder: true };
  const rat = pack.species.find((x) => x && x.name === (sc.foeSp || 'Rattata')).id;
  const foeAb = sc.foeAb ? pack.abilities.find((a) => a && a.name === sc.foeAb) : null;
  const itemId = sc.item ? pack.items.find((i) => i && i.name === sc.item).id : 0;
  await o.startBattle({
    foe: { species: rat, level: 5, moves: sc.foeMoves ? [...sc.foeMoves.map((n) => live.ids.move(n)), 0, 0, 0, 0].slice(0, 4) : [sc.then ? live.ids.move('Splash') : 1, 0, 0, 0], item: sc.foeItem ? pack.items.find((i) => i && i.name === sc.foeItem).id : 0, hp: 300, maxHp: 300, stats: { atk: 100, def: 100, spe: 50, spa: 100, spd: 100 } },
    player: { species: pick.s.id, level: 100, moves: [sc.then ? live.ids.move(sc.then) : 1, 0, 0, 0], hp: 300, maxHp: 300, abilityNum: pick.num, item: itemId, stats: { atk: 100, def: 100, spe: 100, spa: 100, spd: 100 } },
    reach: 'intro',
  });
  const ty0 = [0, 1].map((i) => { const mm = o.battleMon(i); return [...new Set([mm.type1, mm.type2])].sort((x, y) => x - y); });
  const atMenu = () => { const c = o.readU32(live.ctlAddr); return (c === live.actionMenuFn || c === live.actionWaitFn) && o.readU32(live.mainAddr) === live.actionSelectFn; };
  if (sc.pre) {
    if (sc.pre.field) writeField(o, fieldWordOf(sc.pre.field));
    if (sc.pre.timer !== undefined) o.writeU8(FL.timerA + 2, sc.pre.timer);
    if (sc.pre.weather) o.writeU32(ADDR.weather, WEATHER_WORD[sc.pre.weather]);
  }
  let f = 0; const introTexts = []; let introLast = '';
  // an announcement scenario presses A slowly and reads the text every frame, so no line is skipped past
  for (; f < (sc.ann ? 3000 : 1400); f++) { o.runFrames(1, (sc.ann ? f % 40 < 3 : f % 6 < 2) && !atMenu() ? 'A' : 0); if (sc.ann) { const tx = (o.battleText() || '').replace(/\s+/g, ' ').trim(); if (tx && tx !== introLast) { introTexts.push(tx); introLast = tx; } } if (f > 20 && atMenu()) break; }
  let hpAfter = null; const entryTexts = []; let entryLastTx = '';
  if (sc.then && f < 1400) {   // choose the first move and play the turn out
    const S = seedFor(32768, 36863, 6);   // the same forced draws as the turn scenarios
    const setS = () => { for (let k = 0; k < 4; k++) o.writeU32(RNG_ADDR + 4 * k, S[k]); };
    const hold = (key, n) => { for (let i = 0; i < n; i++) { setS(); o.runFrames(1, key); } };
    hold(0, 14); hold('A', 5);
    for (let q = 0; q < 300 && o.readU32(live.ctlAddr) !== live.moveMenuFn; q++) { setS(); o.runFrames(1); }
    hold(0, 12); hold('A', 5);
    let g = 0;
    for (; g < 2400; g++) { setS(); o.runFrames(1, g % 50 < 3 && /{FB}|{FA}/.test(o.battleText()) ? 'A' : 0); if (sc.text && g % 4 === 0) { const tx = (o.battleText() || '').replace(/s+/g, ' ').trim(); if (tx && tx !== entryLastTx) { entryTexts.push(tx); entryLastTx = tx; } } if (g > 30 && atMenu()) break; }
    hpAfter = [o.battleMon(0).hp, o.battleMon(1).hp];
  }
  const m = [o.battleMon(0), o.battleMon(1)];
  const sgOf = (mm) => OBS_ORDER.map((k) => mm.statStages[STAGE_SLOT[k]] - 6);
  const tys = (mm) => [...new Set([mm.type1, mm.type2])].sort((x, y) => x - y);
  const w = o.readU32(FL.word);
  return {
    sg: [sgOf(m[0]), sgOf(m[1])], st: [status1Code(o.readU32(live.A0 + ADDR.status1Off)), status1Code(o.readU32(live.A1 + ADDR.status1Off))],
    wx: weatherCode(o.readU32(ADDR.weather)), fld: fieldCode(w), item: [m[0].item ? 1 : 0, m[1].item ? 1 : 0],
    ty: [tys(m[0]), tys(m[1])], ft: o.readU8(FL.timerA + 2), gt: o.readU8(FL.timerB), hp: hpAfter, texts: entryTexts, ann: sc.ann ? annOf(introTexts) : undefined, introTexts: sc.ann ? introTexts : undefined,
    real: { ty0, species: pick.s.id, num: pick.num, ab: [m[0].ability, m[1].ability], it: [m[0].item, m[1].item], inn: pick.s.innates.filter((x) => x), foeSp: rat },
    timeout: f >= (sc.ann ? 3000 : 1400),
  };
}

/** translate a combo (names) into the oracle's numeric setup */
export function setupOf(combo, ids, T) {
  const side = (x, isB) => ({
    ...(x.gender && ids.genderSpec ? ids.genderSpec(x.gender) : {}), species: x.gender && ids.genderSpec ? ids.genderSpec(x.gender).species : (x.holder || 0), friendship: 255, level: combo.level, atk: x.st.atk, def: x.st.def, spa: x.st.spa, spd: x.st.spd, spe: x.st.spe,
    hp: x.hp !== undefined ? x.hp : (x.maxhp !== undefined ? x.maxhp : 600), maxhp: x.maxhp !== undefined ? x.maxhp : 600,
    types: x.types.map((n) => T[n.toUpperCase()]), ability: ids.ability(x.ability), item: ids.item(x.item), stages: x.stages || {},
    status1: x.status ? STATUS1[x.status] : 0,
    ...(isB ? {} : { moves: [ids.move(combo.move), 0, 0, 0] }),
  });
  let sideWord = 0; for (const s of combo.screens || []) sideWord |= SIDE_BIT[s];
  return { a: side(combo.a, false), b: side(combo.b, true), weatherWord: combo.weather ? WEATHER_WORD[combo.weather] : 0, fieldWord: fieldWordOf(combo.field), sideWord };
}

/** evaluate one combo: run `n` delays, classify against the engine's sets */
export function evalCombo(live, setup, expect, n, opts = {}) {
  const allowed = new Set([...expect.nc, ...expect.cr]);
  const obs = [], miss = []; let maxd = 0;
  for (let d = 0; d < n; d++) {
    const r = live.trial(setup, d + (opts.delayBase || 0));
    if (r.d === 0) miss.push(d); else { obs.push(r.d); maxd = Math.max(maxd, r.d); }
  }
  const bad = obs.filter((v) => !allowed.has(v));
  const distinct = [...new Set(obs)].sort((a, b) => a - b);
  const expectZero = expect.nc.every((v) => v === 0) && expect.cr.every((v) => v === 0);
  let verdict;
  if (expectZero) verdict = obs.length === 0 ? 'match' : 'mismatch';           // engine: immune / no damage; real game must deal none
  else if (obs.length === 0) verdict = 'nohit';                                // the real game never damaged in n tries (engine expects damage)
  else verdict = bad.length === 0 ? 'match' : 'mismatch';
  return { verdict, obs, distinct, bad: [...new Set(bad)].sort((a, b) => a - b), misses: miss.length };
}

/** EXACT mode: for each of the 16 damage rolls r the RNG is set so that every draw of the move's execution is "roll bucket r, accuracy hit,
 *  no crit"; the real game's damage must equal the engine's damage for that roll. forceCrit: always-crit moves (the crit draw is irrelevant). */
export function evalExact(live, setup, expect, mv, forceCrit, opts = {}) {
  const defHp = setup.b.hp;
  const table = (forceCrit ? expect.cr : expect.nc).map((v) => Math.min(v, defHp));
  const flat = table.every((v) => v === table[0]);
  const rolls = flat ? [0, 15] : [...Array(16).keys()];
  let hitMin = mv.accuracy > 0 && mv.accuracy < 100 && !opts.neverMiss ? Math.ceil((100 - mv.accuracy) * 65536 / 100) + 8 : 0;
  if (opts.minV) hitMin = Math.max(hitMin, opts.minV);
  const odds = [24, 8, 2, 1][mv.critStage] || 24;
  const critMax = forceCrit ? 65535 : Math.floor((odds - 1) * 65536 / odds) - 8;
  const rows = [];
  for (const r of rolls) {
    const lo = Math.max(r * 4096, hitMin), hi = Math.min(r * 4096 + 4095, critMax);
    if (lo > hi || hi - lo < 300) { rows.push({ r, skipped: true }); continue; }
    const rng = seedFor(lo, hi, opts.K || 4);
    const got = live.trial(setup, 0, 900, rng);
    rows.push({ r, want: table[r], got: got.d, ok: got.d === table[r] });
  }
  const tested = rows.filter((x) => !x.skipped), bad = tested.filter((x) => !x.ok);
  return { verdict: tested.length === 0 ? 'skipped' : bad.length === 0 ? 'match' : 'mismatch', tested: tested.length, skipped: rows.length - tested.length, bad, rows };
}

export async function runLive(ctx) {
  const { t, head, skip } = ctx;
  head('layer 2: the engine versus the real game (OR1 oracle)');
  let live;
  try {
    const modUrl = (f) => pathToFileURL(path.join(root, 'pokemonarena', 'js', f)).href;
    const { loadPack } = await import(modUrl('tables.js'));
    const rb = fs.readFileSync(ctx.romPath);
    const pack = loadPack(new Uint8Array(rb.buffer, rb.byteOffset, rb.byteLength), { verify: 'header', dexText: false });
    const names = { m: new Map(), a: new Map(), i: new Map() };
    pack.moves.forEach((m) => { if (!names.m.has(m.name)) names.m.set(m.name, m.id); });
    pack.abilities.forEach((a) => { if (!names.a.has(a.name)) names.a.set(a.name, a.id); });
    pack.items.forEach((a) => { if (!names.i.has(a.name)) names.i.set(a.name, a.id); });
    const ids = { move: (n) => names.m.get(n), ability: (n) => (n ? names.a.get(n) : 0), item: (n) => (n ? names.i.get(n) : 0) };
    ids.genderSpec = (g) => genderSpec(pack, g);
    live = await openLive({ romPath: ctx.romPath, pack, ids });
    ctx.live = live; ctx.pack = pack; ctx.ids = ids;
  } catch (e) {
    skip('live/oracle', 'oracle unavailable: ' + String((e && e.message) || e).slice(0, 200));
    return;
  }
  const { buildCombos, engineExpect } = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_diff_combos.mjs')).href);
  const { loadModules, makeLab } = await import(pathToFileURL(path.join(here, 'pokemonarena_engine_lib.mjs')).href);
  const M = await loadModules(ctx.jsDir || path.join(root, 'pokemonarena', 'js'));
  const lab = makeLab(M, ctx.pack);
  const T = M.engine_data.T;
  const N = Number(process.env.ARENA_LIVE_N || 10);
  const only = ctx.groups || process.env.ARENA_LIVE_GROUP || null;
  const part = ctx.part || process.env.ARENA_LIVE_PART || 'both';
  const everyK = ctx.every || Number(process.env.ARENA_LIVE_EVERY || 1);
  const { buildInnateCombos } = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_diff_combos.mjs')).href);
  const supportedAb = M.engine_support.engineSupport(ctx.pack).abilities;
  const combos = (part === 'turns' ? [] : [...buildCombos(), ...buildInnateCombos(ctx.pack, supportedAb)].filter((c) => !only || only.split(',').includes(c.group)).filter((c) => !process.env.ARENA_LIVE_ABS || process.env.ARENA_LIVE_ABS.split(',').some((n) => n === c.a.ability || n === c.b.ability || n === c.innateOf))).filter((_, i) => i % everyK === 0);
  const results = [];
  for (const c of combos) {
    const ex = engineExpect(M, ctx.pack, lab, T, c);
    if (ex.unsupported) { results.push({ id: c.id, group: c.group, move: c.move, verdict: 'engine-unsupported', why: ex.unsupported }); continue; }
    const mvRec = ctx.pack.moves[ctx.ids.move(c.move)];
    const r = process.env.ARENA_LIVE_MODE === 'random' ? evalCombo(live, setupOf(c, ctx.ids, T), ex, N) : evalExact(live, setupOf(c, ctx.ids, T), ex, mvRec, c.crit === 'force' || !!mvRec.alwaysCrit, { minV: Math.max(c.a.status === 'par' ? 16392 : 0, (c.a.ability === 'Hustle' || c.innateOf === 'Hustle') && mvRec.category === 0 ? 13120 : 0) });
    results.push({ id: c.id, group: c.group, move: c.move, a: c.a, b: c.b, weather: c.weather, screens: c.screens, level: c.level, ...r, engine: { nc: ex.nc, cr: ex.cr } });
  }
  ctx.results = results;
  if (part === 'damage') return;
  // ---- turn-state differential
  const TU = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_diff_turns.mjs')).href);
  const scs = [...TU.buildTurns(ctx.pack, M.engine_data.EFFECTS), ...TU.buildOrder(ctx.pack)].filter((x) => !only || only.split(',').includes(x.group)).filter((_, i) => i % everyK === 0);
  const turnResults = [];
  for (const sc of scs) {
    const eng = TU.engineTurn(M, ctx.pack, lab, T, sc);
    if (eng.unsupported) { turnResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'engine-unsupported', why: eng.unsupported }); continue; }
    let lv;
    try { lv = turnLive(live, sc, ctx.ids, T); } catch (e) { turnResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'live-error', why: String((e && e.message) || e).slice(0, 160) }); continue; }
    const diffs = [];
    for (const k of sc.group === 'order' || lv.timeout ? ['hp'] : sc.seq ? ['trace', 'hp', 'sg', 'st', 'wx', 'side', 'item', 'conf', 'fld', 'ty', 'ab', 'inf'] : ['hp', 'sg', 'st', 'wx', 'side', 'item', 'conf', 'fld', 'ty', 'ab', 'inf']) if (JSON.stringify(eng[k]) !== JSON.stringify(lv[k])) diffs.push({ field: k, engine: eng[k], live: lv[k] });
    turnResults.push({ id: sc.id, group: sc.group, label: sc.label, aMove: sc.aMove, bMove: sc.bMove, verdict: diffs.length ? 'mismatch' : lv.timeout ? 'match-no-menu' : 'match', diffs, engine: eng, live: lv });
  }
  ctx.turnResults = turnResults;
  { // ---- entry scenarios (real battles started by the game)
    const entries = TU.buildEntry(ctx.pack).filter((x) => !only || only.split(',').includes(x.group)).filter((_, i) => i % everyK === 0);
    const entryResults = [];
    for (const sc of entries) {
      if (sc.start) {   // round 6: the order of two lead announcements; the engine's speeds are written into the oracle's stats
        const eng = TU.engineStart(M, ctx.pack, lab, T, sc);
        if (eng.unsupported) { entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'engine-unsupported', why: eng.unsupported }); continue; }
        let lv0;
        try { lv0 = await startLive(live, { ...sc, pSpe: eng.spd[0], fSpe: eng.spd[1] }); } catch (e) { entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'live-error', why: String((e && e.message) || e).slice(0, 160) }); continue; }
        const d0 = ['ann', 'wx'].filter((k) => JSON.stringify(eng[k]) !== JSON.stringify(lv0[k])).map((k) => ({ field: k, engine: eng[k], live: lv0[k] }));
        entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: lv0.timeout ? 'timeout' : d0.length ? 'mismatch' : 'match', diffs: d0, engine: eng, live: lv0 });
        continue;
      }
      let lv;
      try { lv = await entryLive(live, sc); } catch (e) { entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'live-error', why: String((e && e.message) || e).slice(0, 160) }); continue; }
      if (lv.noHolder) { entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'no-holder' }); continue; }
      const eng = TU.engineEntry(M, ctx.pack, lab, T, sc, lv.real);
      if (eng.unsupported) { entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: 'engine-unsupported', why: eng.unsupported }); continue; }
      const diffs = [];
      for (const k of sc.cmp || (sc.then ? ['hp', 'st', 'sg', 'item'] : ['sg', 'st', 'wx', 'fld', 'item', 'ty', 'ft', 'gt'])) if (JSON.stringify(eng[k]) !== JSON.stringify(lv[k])) diffs.push({ field: k, engine: eng[k], live: lv[k] });
      entryResults.push({ id: sc.id, group: sc.group, label: sc.label, verdict: lv.timeout ? 'timeout' : diffs.length ? 'mismatch' : 'match', diffs, engine: eng, live: lv });
    }
    ctx.entryResults = entryResults;
  }
  if (part === 'turns' && !ctx.probes) return;
  if (ctx.probes === false) return;
  // ---- exact probability probes: accuracy thresholds, crit thresholds, chance mechanics
  const PR = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_diff_probes.mjs')).href);
  const probeResults = { accuracy: [], crit: [], chance: [], chance2: [] };
  const limit = ctx.probeLimit || undefined;
  const kinds = ctx.probeKinds || ['accuracy', 'crit', 'chance', 'chance2'];
  if (kinds.includes('accuracy')) probeResults.accuracy = await PR.runAccuracyProbes(live, ctx.ids, M, ctx.pack, lab, T, limit);
  if (kinds.includes('crit')) for (const p of PR.CRIT_PROBES.slice(0, limit || PR.CRIT_PROBES.length)) {
    const real = PR.realCritBoundary(live, ctx.ids, { move: p.move, a: p.a || {}, b: {} });
    const odds = M.engine_data.E.critOdds[p.stage];
    const expect = Math.ceil((odds - 1) * 65536 / odds);
    probeResults.crit.push({ label: p.label, real, engine: expect, ok: real !== null && Math.abs(real - expect) <= 1 });
  }
  if (kinds.includes('chance')) for (const p of PR.CHANCE_PROBES.slice(0, limit || PR.CHANCE_PROBES.length)) {
    const real = PR.realBlockedFraction(live, ctx.ids, { move: p.move, a: p.a, b: {} });
    const eng = PR.engineBlockedFraction(M, ctx.pack, lab, T, p);
    probeResults.chance.push({ label: p.label, real, engine: eng, ok: real !== null && Math.abs(real - eng) < 0.0006 });
  }
  if (kinds.includes('chance2')) { const CH = await import(pathToFileURL(path.join(here, 'pokemonarena_rom_diff_chance.mjs')).href); probeResults.chance2 = await CH.runChanceProbes(turnLive, live, ctx.ids, M, ctx.pack, lab, T); }
  ctx.probeResults = probeResults;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.env.ARENA_FA2_OUT || path.join(os.tmpdir(), 'pokemonarena-fa2');
  fs.mkdirSync(out, { recursive: true });
  const ctx = { probes: process.env.ARENA_LIVE_PROBES === '1' ? true : undefined, t: () => {}, head: (s) => console.log('== ' + s), skip: (n, w) => console.log('SKIP', n, w), romPath: path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba') };
  const t0 = Date.now();
  await runLive(ctx);
  const R = ctx.results || [];
  const by = {};
  for (const r of R) { const g = (by[r.group] = by[r.group] || { n: 0, match: 0, mismatch: 0, nohit: 0, other: 0 }); g.n++; if (r.verdict in g) g[r.verdict]++; else g.other++; }
  console.table(by);
  const TR = ctx.turnResults || [];
  const byT = {};
  for (const r of TR) { const g = (byT[r.group] = byT[r.group] || { n: 0, match: 0, mismatch: 0, other: 0 }); g.n++; if (r.verdict in g) g[r.verdict]++; else g.other++; }
  const ER = ctx.entryResults || [];
  if (ER.length) { const byE = {}; for (const r of ER) { const g = (byE[r.group] = byE[r.group] || { n: 0, match: 0, mismatch: 0, other: 0 }); g.n++; if (r.verdict in g) g[r.verdict]++; else g.other++; } console.log('entry scenarios'); console.table(byE); for (const r of ER) if (r.verdict !== 'match') console.log('  ENTRY', r.verdict, r.group + '/' + r.label, JSON.stringify(r.diffs || r.why || '')); }
  if (TR.length) { console.log('turn-state scenarios'); console.table(byT); console.log('turn scenarios', TR.length, 'match', TR.filter((r) => r.verdict === 'match').length); }
  if (ctx.probeResults) for (const [k, rows] of Object.entries(ctx.probeResults)) { console.log('probes ' + k + ': ' + rows.filter((r) => r.ok).length + '/' + rows.length + ' agree'); for (const r of rows) if (!r.ok) console.log('   DIFF', r.label, 'real', r.real, 'engine', r.engine); }
  const tot = R.reduce((s, r) => s + (r.verdict === 'match' ? 1 : 0), 0);
  console.log(`combos ${R.length}, match ${tot}, trials ${ctx.live ? ctx.live.trials : 0}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  fs.writeFileSync(path.join(out, 'live_results.json'), JSON.stringify(R));
  if (TR.length) fs.writeFileSync(path.join(out, 'live_turns.json'), JSON.stringify(TR));
  if (ctx.probeResults) fs.writeFileSync(path.join(out, 'live_probes.json'), JSON.stringify(ctx.probeResults));
  console.log('results ->', path.join(out, 'live_results.json'));
}

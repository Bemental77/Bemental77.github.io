// pokemonarena/js/engine_exec.js -- the move-execution half of the battle engine (installed onto Battle.prototype by
// engine.js).  Everything here is a method of the Battle object: `this.s` is the serialisable battle state, `this.pack`
// the data pack, `this.events` the event log.  No DOM, no clocks, no Math.random: randomness is this.rand(n) only.
//
// RNG CALL ORDER for one attacking move (pinned by tools/pokemonarena_engine_test.mjs golden replays):
//   1. before the move: sleep wake roll is NOT random (counter), freeze thaw rand(5), confusion rand(3), paralysis rand(4)
//   2. accuracy: one rand(100) when the effective accuracy is below 100 (none when the move cannot miss)
//   3. per hit: crit rand(odds) (none for always-crit moves / crit-immune targets), then the damage roll rand(16)
//   4. secondary effects, in table order: one rand(100) for each with a chance below 100 (Serene Grace doubles the chance)
//   5. kind-specific rolls (multi-hit count, Present, Magnitude, ...) are documented at their kind in engine_moves.js

import {
  T, CAT, ST, WX, E, EFFECTS, ADDITIONAL, STAT_IDX, TN, TN_NAMES, PW,
} from './engine_data.js';
import {
  idiv, pokeMod, chain, applyStage, applyAccStage, baseDamage, rollFactor, applyTypeMult, typeProduct, fractionOf,
} from './engine_calc.js';
import { MOVE_KINDS } from './engine_moves.js';

const EMPTY = Object.freeze({});
const FORCED_SWITCH = new Set(['Roar', 'Whirlwind', 'Dragon Tail', 'Circle Throw']);   // Time Spiral keeps their priority
const EARTH_MOVES = new Set(['Earthquake', 'Bulldoze', 'Magnitude']);   // Grassy Terrain halves these against a grounded target (MEASURED)
const GRAVITY_BAN = new Set(['Fly', 'Bounce', 'Jump Kick', 'High Jump Kick', 'Splash', 'Magnet Rise', 'Telekinesis', 'Flying Press', 'Sky Drop']);   // MEASURED: each turned into Struggle under Gravity
export { GRAVITY_BAN };
const NO_PARENTAL = new Set(['ohko', 'counter', 'fixeddamage', 'leveldamage', 'fractiondamage', 'endeavor', 'finalgambit', 'psywave', 'struggle', 'beatup', 'spitup']);
const ef0kind = (c) => (c.ef && c.ef.kind) || '';
const NOT_REFLECTABLE = new Set(['Trick', 'Switcheroo', 'Skill Swap', 'Role Play', 'Psych Up', 'Transform', 'Mimic', 'Sketch', 'Spite', 'Imprison', 'Doodle', 'Entrainment', 'Guard Swap', 'Heart Swap', 'Power Swap', 'Memento', 'Perish Song', 'Spikes-free']);
// How the hooks of several ability sources (main + innates) combine. Numeric UQ4.12 modifiers multiply, priorities and crit stages add,
// value rewriters run in order, immunities / blockers fire on the first source that says yes, every other event hook runs for all sources.
const HOOK_MERGE = {
  bp: 'chain', atk: 'chain', final: 'chain', bpDef: 'chain', atkDef: 'chain', def: 'chain', finalDef: 'chain', acc: 'chain', evade: 'chain', spe: 'chain',
  prio: 'sum', critBoost: 'sum', stab: 'first', moveType: 'first', weight: 'seq', modStage: 'seq',
  immune: 'any', statusImmune: 'any', confuseImmune: 'any', blockDrop: 'any', critImmune: 'any', traps: 'any', truant: 'any', sturdy: 'any',
};
// The order in which switch-in abilities of ONE mon act (MEASURED in the real game, 21 pairs: pokemonarena/ROMDIFF.md section 7). It is one
// global order, NOT main-before-innate and NOT slot order. Abilities of one mon that are not listed run afterwards in source order.
export const SWITCH_IN_ORDER = Object.freeze([
  'Neutralizing Gas', 'Cloud Nine', 'Air Lock', 'Glacial', 'Drizzle', 'Drought', 'Sand Stream', 'Snow Warning', 'Primordial Sea', 'Desolate Land', 'Delta Stream',
  'Electric Surge', 'Psychic Surge', 'Misty Surge', 'Grassy Surge', 'Hadron Engine', 'Gravity Well', 'Magnify Field', 'Dark Aura', 'Fairy Aura', 'Mold Breaker', 'Teravolt', 'Turboblaze', 'Unnerve',
  'Pressure', 'Forewarn', 'Anticipation', 'Frisk', 'Download', 'Intimidate', 'Uncanny', 'Trace',
]);
const PHASE_HOOKS = { bp: { user: 'bp', target: 'bpDef' }, atk: { user: 'atk', target: 'atkDef' }, def: { target: 'def' }, final: { user: 'final', target: 'finalDef' } };
const STATUS_NAMES = ['none', 'slp', 'psn', 'brn', 'frz', 'par', 'tox', 'fbt'];
export { STATUS_NAMES };

export const execMethods = {
  // ------------------------------------------------------------------ small queries
  act(side) { const sd = this.s.sides[side]; return sd.team[sd.act]; },
  alive(mon) { return mon.hp > 0; },
  aliveCount(side) { let n = 0; for (const m of this.s.sides[side].team) if (m.hp > 0) n++; return n; },
  rand(n) {
    // 32-bit LCG (GBA family constants); output is the high 16 bits.
    const s = (Math.imul(this.s.rng, 0x41c64e6d) + 0x6073) >>> 0;
    this.s.rng = s;
    return (s >>> 16) % n;
  },
  emit(ev) { this.events.push(ev); return ev; },
  move(id) { return this.pack.moves[id]; },
  abilityName(mon) { const a = this.pack.abilities[mon.ab]; return a ? a.name : ''; },
  itemName(mon) { const it = this.pack.items[mon.it]; return it ? it.name : ''; },
  /** True when the holder's item is allowed to do anything (not Embargo, Magic Room, Klutz or a knocked-off one). */
  itemUsable(mon) { return !!mon.it && !(mon.v.emb > 0) && !(this.s.mr > 0) && !mon.v.nitem && !this.abFn(mon, 'noItem'); },

  /** A hook function of the mon's ability. `defender` hooks flagged `breakable` are skipped under Mold Breaker.
   *  A mon with ACTIVE INNATE abilities (mon.inn, level-gated at construction) has several ability sources: the main ability and each
   *  distinct innate. The hook is then a merged function over every source that has it (see HOOK_MERGE); a mon without innates takes
   *  the one-lookup fast path. */
  abFn(mon, name, defender) {
    if (this.ngOn() && name !== 'ngMarker' && !this.ngExempt(mon)) return undefined;
    if (mon.v.gastro) return undefined;
    if (mon.inn !== undefined) return this.abFnMulti(mon, name, defender);
    const h = this.abH[mon.ab];
    if (!h) return undefined;
    const f = h[name];
    if (f === undefined) return undefined;
    if (defender && this.s.mb && h.breakable) return undefined;
    return f;
  },
  /** Is Neutralizing Gas on the field?  (a Pokemon that is out and awake has it as its main ability or an active innate) */
  ngOn() {
    const id = this.ngId;
    if (id === undefined || id === 0) return false;
    for (let sd = 0; sd < 2; sd++) {
      const m = this.s.sides[sd].team[this.s.sides[sd].act];
      if (m && m.hp > 0 && (m.ab === id || (m.inn !== undefined && m.inn.indexOf(id) >= 0))) return true;
    }
    return false;
  },
  /** The Neutralizing Gas holder keeps its own ability, and an Ability Shield holder keeps everything. */
  ngExempt(mon) {
    if (mon.ab === this.ngId && mon.inn === undefined) return true;
    const it = this.itH[mon.it];
    return !!(it && it.abilityShield);
  },
  uproarOn() { for (let s = 0; s < 2; s++) { const m = this.act(s); if (m && m.hp > 0 && m.v.ramp && m.v.ramp.up) return true; } return false; },
  /** Eat a berry's effect (Pluck, Bug Bite, Stuff Cheeks, Teatime, Fling): the effect applies to `mon`; the item is NOT removed here. */
  eatBerry(mon, itemId) {
    const it = this.pack.items[itemId];
    if (!it) return;
    const h = it.holdEffect, p = it.holdEffectParam;
    mon.v.ate = 1;
    const rp = this.abFn(mon, 'ripen') ? 2 : 1;
    if (h === 1) this.healMon(mon, (p || 10) * rp, { src: 'berry' });
    else if (h === 82) this.healMon(mon, fractionOf(mon.mhp, 4) * rp, { src: 'berry' });
    else if (h >= 10 && h <= 14) this.healMon(mon, fractionOf(mon.mhp, 3) * rp, { src: 'berry' });
    else if (h === 15) this.changeStage(mon, 'atk', 1, -1, {}); else if (h === 16) this.changeStage(mon, 'def', 1, -1, {});
    else if (h === 17) this.changeStage(mon, 'spe', 1, -1, {}); else if (h === 18) this.changeStage(mon, 'spa', 1, -1, {}); else if (h === 19) this.changeStage(mon, 'spd', 1, -1, {});
    else if (h === 2 && mon.s === ST.PAR) this.clearStatus(mon, 'berry'); else if (h === 3 && mon.s === ST.SLP) this.clearStatus(mon, 'berry');
    else if (h === 4 && (mon.s === ST.PSN || mon.s === ST.TOX)) this.clearStatus(mon, 'berry'); else if (h === 5 && mon.s === ST.BRN) this.clearStatus(mon, 'berry');
    else if (h === 6 && (mon.s === ST.FRZ || mon.s === ST.FBT)) this.clearStatus(mon, 'berry');
    else if (h === 8 && mon.v.conf) { delete mon.v.conf; this.emit({ t: 'volatile-end', s: mon.side, m: mon.slot, v: 'confusion' }); }
    else if (h === 9) { if (mon.s !== ST.NONE) this.clearStatus(mon, 'berry'); if (mon.v.conf) { delete mon.v.conf; this.emit({ t: 'volatile-end', s: mon.side, m: mon.slot, v: 'confusion' }); } }
  },
  /** Stat values with Power Trick (Attack and Defense swapped) and the Split / Speed Swap overrides applied. */
  statOf(mon, key) {
    const v = mon.v;
    if (v.pt && (key === 'atk' || key === 'def')) key = key === 'atk' ? 'def' : 'atk';
    if (v.so && v.so[key] !== undefined) return v.so[key];
    return mon.st[key];
  },
  /** Why this Pokemon cannot use this move right now ('' when it can): Torment, Imprison, Heal Block, Throat Chop. */
  blockReason(m, mv) {
    if (m.v.torment && m.v.lastMv === mv.id) return 'torment';
    const foe = this.act(m.side ^ 1);
    if (foe && foe.hp > 0 && foe.v.imp && foe.mv.some((x) => x.id === mv.id)) return 'imprison';
    if (m.v.hb > 0 && mv.flags.heal) return 'heal-block';
    if (m.v.tc > 0 && mv.flags.sound) return 'throat-chop';
    if (mv.name === 'Belch' && !m.v.ate) return 'belch';
    if (mv.name === 'Stuff Cheeks' && !(m.it && this.berries.has(m.it))) return 'no-berry';   // MEASURED: unusable (Struggle) without a berry   // MEASURED: "has no moves left that it can use" until a berry has been eaten
    return '';
  },
  /** Ability ids that act for `mon`: the main ability first, then each active innate once (the same ability from two sources counts once: MEASURED). */
  abSources(mon) {
    const out = [mon.ab];
    if (mon.inn) for (const id of mon.inn) if (id && out.indexOf(id) < 0) out.push(id);
    return out;
  },
  /** Call a hook of source ability `id` as if `mon` had that ability (so pop-ups and events name the right ability). */
  callAs(mon, id, f, args) {
    if (id === mon.ab) return f(...args);
    const saved = mon.ab, sInn = this.curInn, sMon = this.curInnMon;
    mon.ab = id; this.curInn = id; this.curInnMon = mon;
    try { return f(...args); } finally { if (mon.ab === id) mon.ab = saved; this.curInn = sInn; this.curInnMon = sMon; }
  },
  abFnMulti(mon, name, defender) {
    let ids = this.abSources(mon);
    if (name === 'onStart' && ids.length > 1) ids = ids.slice().sort((x, y) => this.switchInRank(x) - this.switchInRank(y) || ids.indexOf(x) - ids.indexOf(y));
    const fs = [];
    for (const id of ids) {
      const h = this.abH[id];
      if (!h) continue;
      const f = h[name];
      if (f === undefined) continue;
      if (defender && this.s.mb && h.breakable) continue;
      fs.push({ id, f });
    }
    if (fs.length === 0) return undefined;
    if (typeof fs[0].f !== 'function') return fs[0].f; // a flag
    if (fs.length === 1 && fs[0].id === mon.ab) return fs[0].f;
    const call = (e, args) => this.callAs(mon, e.id, e.f, args);
    switch (HOOK_MERGE[name] || 'all') {
      case 'chain': return (...a) => { const r = []; for (const e of fs) { const v = call(e, a); if (v) r.push(v); } return r.length === 0 ? 0 : r.length === 1 ? r[0] : chain(r); };
      case 'sum': return (...a) => { let t = 0; for (const e of fs) t += call(e, a) || 0; return t; };
      case 'first': return (...a) => { for (const e of fs) { const v = call(e, a); if (v !== undefined && v !== 0) return v; } return undefined; };
      case 'any': return (...a) => { for (const e of fs) { const v = call(e, a); if (v) return v; } return false; };
      case 'seq': return (...a) => { let v = a[a.length - 1]; for (const e of fs) { const r = call(e, [...a.slice(0, -1), v]); if (r !== undefined) v = r; } return v; };
      default: return (...a) => { let out; for (const e of fs) { const v = call(e, a); if (out === undefined) out = v; } return out; };
    }
  },
  /** Position of an ability in the switch-in order (SWITCH_IN_ORDER, MEASURED); abilities not in the list keep their source order after it. */
  switchInRank(id) {
    const a = this.pack.abilities[id];
    const i = a ? SWITCH_IN_ORDER.indexOf(a.name) : -1;
    return i < 0 ? 1000 : i;
  },
  itFn(mon, name) {
    if (!mon.it) return undefined;
    if (this.berries.has(mon.it)) { const o = this.act(mon.side ^ 1); if (o && o.hp > 0 && this.abFn(o, 'unnerve')) return undefined; }
    if (mon.v.emb > 0 || this.s.mr > 0) return undefined;
    if (mon.v.nitem) return undefined; // knocked off / consumed this battle leaves it=0, so this is for Embargo-like blocks
    const ah = this.abH[mon.ab];
    if (ah && ah.noItem) return undefined; // Klutz
    const h = this.itH[mon.it];
    return h ? h[name] : undefined;
  },
  transformMon(user, target) {
    if (user.tf || target.tf || target.v.sub > 0) return false;
    user.tf = { st: user.st, ab: user.ab, mv: user.mv, ty: user.ty };
    user.st = { atk: target.st.atk, def: target.st.def, spa: target.st.spa, spd: target.st.spd, spe: target.st.spe };
    user.ty = this.types(target).slice();
    user.ab = target.ab;
    user.mv = target.mv.map((x) => { const mx = x.mx < 5 ? x.mx : 5; return { id: x.id, pp: mx, mx }; });
    for (const k of STAT_IDX) user.sg[k] = target.sg[k];
    this.emit({ t: 'copy', s: user.side, m: user.slot, how: 'transform', sp: target.sp, sg: { ...user.sg }, ty: user.ty.slice(), ab: user.ab });
    return true;
  },
  // ------------------------------------------------------------------ gender (round 3)
  genderOf(mon) { return mon.g === undefined ? 0 : mon.g; },
  /** Can `src` make `tgt` fall in love (Attract, Cute Charm)?  Opposite genders only; Oblivious and Aroma Veil stop it. */
  canInfatuate(src, tgt) {
    const a = this.genderOf(src), b = this.genderOf(tgt);
    if (a === 2 || b === 2 || a === b || tgt.v.inf || tgt.hp <= 0) return false;
    if (this.abFn(tgt, 'loveImmune', true)) return false;
    return true;
  },
  infatuate(tgt, src, info) {
    if (!this.canInfatuate(src, tgt)) return false;
    tgt.v.inf = 1;
    this.emit({ t: 'volatile', s: tgt.side, m: tgt.slot, v: 'infatuation' });
    if (this.itFn(tgt, 'loveKnot') && !src.v.inf && src.hp > 0 && this.canInfatuate(tgt, src)) { this.reveal(tgt, 'i'); src.v.inf = 1; this.emit({ t: 'volatile', s: src.side, m: src.slot, v: 'infatuation' }); }
    return true;
  },
  // ------------------------------------------------------------------ terrain and Gravity (round 3)
  /** The terrain id in effect (TN.*), 0 when none. */
  terrain() { return this.s.tn ? this.s.tn[0] : 0; },
  /** Is another Pokemon on the field holding the Ruin ability `name` (the holder itself is not affected)? */
  ruinHeld(name, victim) {
    for (let sd = 0; sd < 2; sd++) {
      const m = this.act(sd);
      if (m && m !== victim && m.hp > 0 && this.hasAbility(m, name) && (!this.ngOn() || this.ngExempt(m))) return true;
    }
    return false;
  },
  /** Does terrain `id` act on this Pokemon? It must be on the ground; Electromagnetism counts as grounded for Electric Terrain only. */
  terrainActs(mon, id) {
    if (this.terrain() !== id) return false;
    if (this.isGrounded(mon)) return true;
    return id === TN.ELECTRIC && !!this.abFn(mon, 'electricGrounded');
  },
  /** Start a terrain; false when it is already in effect.  Seeds and Mimicry react. */
  setTerrain(id, srcMon) {
    const S = this.s;
    if (this.terrain() === id) return false;
    const ext = srcMon && this.itFn(srcMon, 'terrainExt');
    S.tn = [id, ext ? E.terrainExtTurns : E.terrainTurns];
    this.emit({ t: 'field', k: TN_NAMES[id] + '-terrain', on: 1 });
    this.terrainChanged();
    return true;
  },
  clearTerrain() {
    const S = this.s;
    if (!S.tn) return false;
    const id = S.tn[0]; delete S.tn;
    this.emit({ t: 'field', k: TN_NAMES[id] + '-terrain', on: 0 });
    this.terrainChanged();
    return true;
  },
  /** React to a terrain starting or ending: Terrain Seeds and Mimicry. */
  terrainChanged() {
    for (let s = 0; s < 2; s++) {
      const m = this.act(s);
      if (!m || m.hp <= 0) continue;
      const f = this.itFn(m, 'onTerrain'); if (f && this.terrain()) f(this, m, this.terrain());
      const mf = this.abFn(m, 'onTerrain'); if (mf) mf(this, m, this.terrain());
    }
  },
  setGravity() {
    const S = this.s;
    if (S.gv > 0) return false;
    S.gv = E.gravityTurns;
    this.emit({ t: 'field', k: 'gravity', on: 1 });
    // everything is pulled to the ground: a Pokemon in the air (Fly / Bounce) comes down, Magnet Rise ends
    for (let s = 0; s < 2; s++) {
      const m = this.act(s);
      if (!m || m.hp <= 0) continue;
      if (m.v.sinv === 'air') { delete m.v.sinv; delete m.v.chg; this.emit({ t: 'volatile-end', s, m: m.slot, v: 'airborne' }); }
      if (m.v.mag) { delete m.v.mag; this.emit({ t: 'volatile-end', s, m: m.slot, v: 'magnet-rise' }); }
    }
    return true;
  },
  /** The terrain's factor on a move (x1.3 for the terrain's own type from a grounded user; x0.5 for Earth moves in Grassy and Dragon moves in Misty against a grounded target). MEASURED. */
  terrainMod(c) {
    const tn = this.terrain();
    if (!tn) return 0;
    const u = c.user, t = c.target;
    const boost = tn === TN.GRASSY ? T.GRASS : tn === TN.ELECTRIC ? T.ELECTRIC : tn === TN.PSYCHIC ? T.PSYCHIC : -1;
    if (c.type === boost && this.terrainActs(u, tn)) return E.terrainBoostMod;
    if (tn === TN.GRASSY && EARTH_MOVES.has(c.mv.name) && this.terrainActs(t, TN.GRASSY)) return E.terrainHalfMod;
    if (tn === TN.MISTY && c.type === T.DRAGON && this.terrainActs(t, TN.MISTY)) return E.terrainHalfMod;
    return 0;
  },
  /** The Scorched Field's factor, applied to the base damage in the weather step (fitted to the real game's damage rolls). */
  scorchMod(c) {
    if (this.terrain() !== TN.SCORCHED) return 0;
    if (c.mv.name === 'Scald') return E.scorchScaldMod;
    if (c.type === T.FIRE) return E.scorchFireMod;
    if (c.type === T.WATER || c.type === T.ICE) return E.scorchWaterMod;
    return 0;
  },
  /** Undo Transform (on switch-out or faint). */
  untransform(mon) {
    const o = mon.tf;
    if (!o) return;
    mon.st = o.st; mon.ab = o.ab; mon.mv = o.mv; mon.ty = o.ty;
    delete mon.tf;
  },
  hasAbility(mon, name) {
    const ids = mon.inn ? this.abSources(mon) : [mon.ab];
    for (const id of ids) { const a = this.pack.abilities[id]; if (a && a.name === name) return true; }
    return false;
  },

  types(mon) {
    const v = mon.v;
    let t = v.ty ? v.ty : mon.ty;
    { const ex = this.abFn(mon, 'extraType'); if (ex && t.indexOf(ex) < 0 && t.length < 3) t = t.concat([ex]); }
    if (v.roost) { t = t.filter((x) => x !== T.FLYING); if (t.length === 0) t = [T.MYSTERY]; }
    return t;
  },
  hasType(mon, ty) { return this.types(mon).indexOf(ty) >= 0; },

  /** Weather that is in effect for rules purposes (Cloud Nine / Air Lock suppress it). */
  wx() {
    const w = this.s.wx;
    if (w[0] === WX.NONE) return WX.NONE;
    for (let sd = 0; sd < 2; sd++) {
      const m = this.act(sd);
      if (m && m.hp > 0) { const f = this.abFn(m, 'noWeather'); if (f) return WX.NONE; }
    }
    return w[0];
  },
  isGrounded(mon) {
    if (this.s.gv > 0 || mon.v.smack || mon.v.ingrain || this.itFn(mon, 'ironBall')) return true;
    if (mon.v.tele > 0) return false;
    if (mon.v.mag) return false;
    if (this.hasType(mon, T.FLYING)) return false;
    const f = this.abFn(mon, 'levitate'); if (f) return false;
    const i = this.itFn(mon, 'floats'); if (i) return false;
    return true;
  },

  speed(mon) {
    let sp = applyStage(this.statOf(mon, 'spe'), mon.sg.spe);
    const mods = [];
    const af = this.abFn(mon, 'spe'); if (af) { const r = af(this, mon); if (r) mods.push(r); }
    const itf = this.itFn(mon, 'spe'); if (itf) { const r = itf(this, mon); if (r) mods.push(r); }
    if (this.s.sides[mon.side].tw > 0) mods.push(8192);
    if (mon.s === ST.PAR) { const qf = this.abFn(mon, 'noParaSlow'); if (!qf) mods.push(2048); }
    if (mods.length) sp = pokeMod(sp, chain(mods));
    return sp > 10000 ? 10000 : sp;
  },
  priorityOf(mon, mv) {
    let p = mv.priority;
    const f = this.abFn(mon, 'prio'); if (f) p += f(this, mon, mv);
    if (mv.name === 'Grassy Glide' && this.terrainActs(mon, TN.GRASSY)) p += 1;   // MEASURED terrain, ROM text for the priority
    if (p !== 0 && !FORCED_SWITCH.has(mv.name) && (this.abFn(this.act(0), 'timeSpiral') || this.abFn(this.act(1), 'timeSpiral'))) p = -p;   // MEASURED: negated for both sides
    return p;
  },

  // ------------------------------------------------------------------ hp changes
  /**
   * Apply damage to `mon`.  info: { from: side|-1, mv: move id|0, move: bool (a move hit), crit, eff, src: code }.
   * Handles Substitute, Focus Sash / Sturdy / Endure, and faints.  Returns the HP actually removed (sub damage excluded).
   */
  dealDamage(mon, amount, info) {
    if (mon.hp <= 0 || amount <= 0) return 0;
    if (mon.v.bide && info && info.move) mon.v.bide.d += amount;
    const side = mon.side;
    // Substitute soaks move damage from the foe (not self-inflicted, not sound/bypassing moves)
    if (info.move && mon.v.sub > 0 && !info.bypassSub) {
      const take = amount < mon.v.sub ? amount : mon.v.sub;
      mon.v.sub -= take;
      this.emit({ t: 'sub-damage', s: side, m: mon.slot, n: take, left: mon.v.sub });
      if (mon.v.sub <= 0) { delete mon.v.sub; this.emit({ t: 'sub-break', s: side, m: mon.slot }); }
      info.subHit = true;
      return 0;
    }
    let dmg = amount > mon.hp ? mon.hp : amount;
    let reborn = false;
    if (info.move && dmg >= mon.hp) {
      // survive-at-1 effects
      if (!mon.rb && this.abFn(mon, 'reborn')) { mon.rb = 1; dmg = mon.hp - 1; reborn = true; this.reveal(mon, 'a'); this.emit({ t: 'ability', s: side, m: mon.slot, ab: mon.ab, fx: 'reborn' }); }
      else if (mon.v.endure) { dmg = mon.hp - 1; this.emit({ t: 'endure', s: side, m: mon.slot }); }
      else {
        const sf = this.abFn(mon, 'sturdy', true);
        const keep = sf && mon.hp === mon.mhp ? sf(this, mon, info) : 0;
        if (keep) { dmg = mon.hp - (typeof keep === 'number' && keep < mon.hp ? keep : 1); this.reveal(mon, 'a'); this.emit({ t: 'ability', s: side, m: mon.slot, ab: mon.ab, fx: 'sturdy' }); }
        else {
          const fs = this.itFn(mon, 'sash');
          if (fs && mon.hp === mon.mhp && fs(this, mon, info)) { dmg = mon.hp - 1; this.consumeItem(mon, 'sash'); }
          else if (this.itFn(mon, 'band') && this.rand(100) < 10) { dmg = mon.hp - 1; this.reveal(mon, 'i'); this.emit({ t: 'item', s: side, m: mon.slot, it: mon.it, fx: 'focus-band' }); }
        }
      }
    }
    if (dmg <= 0) return 0;
    const from = mon.hp;
    mon.hp -= dmg;
    const ev = { t: 'damage', s: side, m: mon.slot, from, to: mon.hp, max: mon.mhp, src: info.src || (info.move ? 'move' : 'other') };
    if (info.crit) ev.crit = 1;
    if (info.eff !== undefined) ev.eff = info.eff;
    if (info.winds) ev.winds = 1;
    if (info.mv) ev.mv = info.mv;
    this.emit(ev);
    if (info.move) {
      mon.ht = (mon.ht || 0) + 1;
      mon.v.hit = (mon.v.hit || 0) + dmg;
      mon.v.hitCat = info.cat;
      mon.v.hitAmt = dmg;
      mon.v.hitFrom = info.from;
    }
    if (mon.hp <= 0) this.faintMon(mon, info);
    else { if (reborn) this.healMon(mon, mon.mhp - mon.hp, { src: 'reborn' }); this.afterDamage(mon, dmg, from, info); }
    return dmg;
  },
  afterDamage(mon, dmg, from, info) {
    // Berries / items that trigger on HP threshold, Emergency Exit-like abilities
    const f = this.itFn(mon, 'onHp');
    if (f) f(this, mon, from);
    const af = this.abFn(mon, 'onHp');
    if (af) af(this, mon, from);
  },
  healMon(mon, amount, info) {
    if (mon.hp <= 0 || amount <= 0) return 0;
    if (mon.v.hb > 0) return 0;   // Heal Block (MEASURED: "prevented from healing")
    if (mon.v.heal) return 0; // reserved key
    const room = mon.mhp - mon.hp;
    const n = amount > room ? room : amount;
    if (n <= 0) return 0;
    const from = mon.hp;
    mon.hp += n;
    this.emit({ t: 'heal', s: mon.side, m: mon.slot, from, to: mon.hp, max: mon.mhp, src: (info && info.src) || 'other' });
    return n;
  },
  reveal(mon, what, id) {
    if (what === 'a' && this.curInn && this.curInnMon === mon) { if (!mon.rev.n) mon.rev.n = []; if (mon.rev.n.indexOf(this.curInn) < 0) mon.rev.n.push(this.curInn); } // an innate showed: only THAT ability is revealed
    else if (what === 'a') mon.rev.a = 1;
    else if (what === 'i') mon.rev.i = 1;
    else if (what === 'm' && mon.rev.m.indexOf(id) < 0) mon.rev.m.push(id);
  },
  consumeItem(mon, fx) {
    const it = mon.it;
    this.reveal(mon, 'i');
    mon.it = 0;
    mon.used = it;
    if (this.berries.has(it)) { mon.v.ate = 1; if (this.abFn(mon, 'cudChew')) mon.v.cud = [it, this.s.turn]; }
    this.emit({ t: 'item', s: mon.side, m: mon.slot, it, fx, used: 1 });
    const ah = this.abFn(mon, 'onItemUsed'); if (ah) ah(this, mon, it);
  },
  faintMon(mon, info) {
    if (mon.fnt) return;
    mon.hp = 0;
    mon.fnt = 1;
    const side = mon.side;
    this.emit({ t: 'faint', s: side, m: mon.slot });
    if (this.s.pw) this.checkPrimal();
    const sd = this.s.sides[side];
    sd.nfaint = (sd.nfaint || 0) + 1;
    sd.lastFaint = this.s.turn;
    for (let s2 = 0; s2 < 2; s2++) { const o = this.act(s2); if (o && o !== mon && o.hp > 0) { const f = this.abFn(o, 'onAnyFaint'); if (f) f(this, o, mon); } }
    if (mon.v.grudge && info && info.from !== undefined && info.from >= 0) {   // Grudge: the move that knocked it out loses all its PP
      const k = this.act(info.from);
      if (k && k !== mon && k.v.lastMv) { const sl = k.mv.find((x) => x.id === k.v.lastMv); if (sl) { sl.pp = 0; this.emit({ t: 'pp-drain', s: k.side, m: k.slot, mv: k.v.lastMv }); } }
    }
    // faint-triggered effects (before volatiles are wiped)
    const attackerSide = info ? info.from : -1;
    if (info && info.move && mon.v.db && attackerSide >= 0 && attackerSide !== side) {
      const at = this.act(attackerSide);
      if (at && at.hp > 0) { this.emit({ t: 'destiny-bond', s: attackerSide, m: at.slot }); this.dealDamage(at, at.hp, { src: 'destiny-bond', from: side }); }
    }
    const af = this.abFn(mon, 'onFaint', true);
    if (af && info && info.move && attackerSide >= 0) af(this, mon, info);
    mon.v = {};
    if (mon.tf) this.untransform(mon);
    mon.s = ST.NONE; mon.sc = 0; // a fainted Pokemon has no major status (silent: the faint event is the message)
    mon.sg = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
    if (attackerSide >= 0 && attackerSide !== side) {
      const at = this.act(attackerSide);
      if (at && at.hp > 0 && info && info.move) {
        const ko = this.abFn(at, 'onKO'); if (ko) ko(this, at, mon);
        const ik = this.itFn(at, 'onKO'); if (ik) ik(this, at, mon);
      }
    }
  },

  // ------------------------------------------------------------------ status
  /** Try to inflict a major status. Returns true when it was applied. info: { from: side|-1, fx: code, silent, self } */
  setStatus(mon, st, srcMon, info) {
    info = info || EMPTY;
    if (mon.hp <= 0 || mon.s !== ST.NONE) { if (!info.silent && mon.hp > 0) this.emit({ t: 'fail', s: mon.side, m: mon.slot, why: 'already-status' }); return false; }
    const foeSrc = srcMon && srcMon !== mon;
    if (foeSrc && this.s.sides[mon.side].sg > 0 && !(srcMon && this.abFn(srcMon, 'infiltrates'))) {
      if (!info.silent) this.emit({ t: 'fail', s: mon.side, m: mon.slot, why: 'safeguard' });
      return false;
    }
    const tys = this.types(mon);
    let blocked = null;
    if (st === ST.BRN && tys.indexOf(T.FIRE) >= 0) blocked = 'type';
    else if (st === ST.FRZ && (tys.indexOf(T.ICE) >= 0 || this.wx() === WX.SUN)) blocked = 'type';
    else if (st === ST.FBT && (tys.indexOf(T.ICE) >= 0 || this.wx() === WX.SUN)) blocked = 'type';   // MEASURED: an Ice type never got it in 40 tries, a Fire type did; harsh sunlight blocks it like freezing (0 of 40 for Ice Beam and Ice Punch)
    else if ((st === ST.PSN || st === ST.TOX) && (tys.indexOf(T.POISON) >= 0 || tys.indexOf(T.STEEL) >= 0) && !(srcMon && this.abFn(srcMon, 'corrosion'))) blocked = 'type';
    else if (st === ST.PAR && tys.indexOf(T.ELECTRIC) >= 0) blocked = 'type';
    else if (st === ST.SLP && this.uproarOn()) blocked = 'uproar';
    else if ((st === ST.SLP && this.terrainActs(mon, TN.ELECTRIC)) || this.terrainActs(mon, TN.MISTY)) blocked = 'terrain';   // MEASURED: Spore / Thunder Wave / Toxic fail on a grounded target, work on a flyer
    if (!blocked) {
      const f = this.abFn(mon, 'statusImmune', true);
      if (f && f(this, mon, st, srcMon)) blocked = 'ability';
    }
    if (blocked) {
      if (!info.silent) this.emit({ t: 'immune', s: mon.side, m: mon.slot, why: blocked === 'ability' ? 'ability-status' : 'type-status', st });
      if (blocked === 'ability') { this.reveal(mon, 'a'); }
      return false;
    }
    mon.s = st;
    mon.sc = 0;
    if (st === ST.SLP) { mon.sc = E.sleepMin + this.rand(E.sleepSpan); const sf = this.abFn(mon, 'sleepTurns'); if (sf) mon.sc = sf(this, mon, mon.sc); } // 1..3 lost move attempts
    else if (st === ST.TOX) mon.sc = 1;
    this.emit({ t: 'status-set', s: mon.side, m: mon.slot, st, fx: info.fx || '' });
    if ((st === ST.PSN || st === ST.TOX) && srcMon && srcMon !== mon && this.abFn(srcMon, 'poisonPuppeteer') && info.fx === 'secondary') this.confuse(mon, srcMon, { fx: 'poison-puppeteer' });   // MEASURED: only the poison a damaging move gives (Toxic itself does not confuse)
    // reactions
    const sy = this.abFn(mon, 'onStatusSet');
    if (sy && foeSrc) sy(this, mon, st, srcMon);
    const ic = this.itFn(mon, 'onStatus'); if (ic) ic(this, mon, st);
    const ia = this.abFn(mon, 'onStatus'); if (ia) ia(this, mon, st);
    return true;
  },
  clearStatus(mon, why) {
    if (mon.s === ST.NONE) return;
    const st = mon.s;
    mon.s = ST.NONE; mon.sc = 0;
    this.emit({ t: 'status-clear', s: mon.side, m: mon.slot, st, why: why || '' });
  },

  /**
   * Change a stat stage. stat: 'atk'|'def'|'spa'|'spd'|'spe'|'acc'|'eva'. srcSide: side of the cause (-1 = none/self).
   * Returns the applied delta (0 if blocked or capped).
   */
  changeStage(mon, stat, delta, srcSide, info) {
    info = info || EMPTY;
    if (mon.hp <= 0 || delta === 0) return 0;
    const ofFoe = srcSide >= 0 && srcSide !== mon.side;
    // Contrary / Simple style rewrites
    const mf = this.abFn(mon, 'modStage');
    if (mf) delta = mf(this, mon, delta);
    if (delta < 0 && ofFoe && !info.bounced && srcSide >= 0) { const rf = this.abFn(mon, 'reflectDrop', true); if (rf) { const src = this.act(srcSide); this.reveal(mon, 'a'); this.emit({ t: 'ability', s: mon.side, m: mon.slot, ab: mon.ab, fx: 'mirror-armor' }); if (src && src.hp > 0) this.changeStage(src, stat, delta, mon.side, { bounced: 1 }); return 0; } }
    if (delta < 0 && ofFoe) {
      if (this.s.sides[mon.side].mist > 0) { this.emit({ t: 'stat-fail', s: mon.side, m: mon.slot, stat, why: 'mist' }); return 0; }
      if (this.itFn(mon, 'blockDrop')) { this.emit({ t: 'stat-fail', s: mon.side, m: mon.slot, stat, why: 'item' }); return 0; }
      const bf = this.abFn(mon, 'blockDrop', true);
      if (bf && bf(this, mon, stat)) { this.reveal(mon, 'a'); this.emit({ t: 'stat-fail', s: mon.side, m: mon.slot, stat, why: 'ability', ab: mon.ab }); return 0; }
      if (mon.v.sub > 0 && info.move) return 0;
    }
    const cur = mon.sg[stat];
    let now = cur + delta;
    if (now > 6) now = 6; else if (now < -6) now = -6;
    const applied = now - cur;
    if (applied === 0) {
      if (!info.silent) this.emit({ t: 'stat-fail', s: mon.side, m: mon.slot, stat, why: delta > 0 ? 'max' : 'min' });
      return 0;
    }
    mon.sg[stat] = now;
    if (applied < 0) mon.v.drop = this.s.turn;
    if (applied > 0) mon.v.raised = this.s.turn;
    this.emit({ t: 'stat-change', s: mon.side, m: mon.slot, stat, delta: applied, now });
    if (applied > 0 && !info.opp) { const fh = this.act(mon.side ^ 1); if (fh && fh.hp > 0 && fh !== mon && this.itFn(fh, 'mirror')) { if (!fh.v.mhq) fh.v.mhq = []; fh.v.mhq.push([stat, applied]); } }
    if (applied > 0 && !info.opp) { const fo = this.act(mon.side ^ 1); if (fo && fo.hp > 0 && fo !== mon) { const cb = this.abFn(fo, 'copyBoost'); if (cb) cb(this, fo, stat, applied); } }
    if (applied < 0 && ofFoe) {
      const df = this.abFn(mon, 'onDrop'); if (df) df(this, mon, stat, applied);
    }
    if (applied < 0) { const wf = this.itFn(mon, 'onDropItem'); if (wf) wf(this, mon); }
    return applied;
  },

  // ------------------------------------------------------------------ type effectiveness
  /** UQ4.12 product of the chart over the defender's types. `c` may carry attacker context for overrides. */
  typeEff(atkType, def, c) {
    const chart = this.pack.typeChart;
    const tys = this.types(def);
    const mults = [];
    for (let i = 0; i < tys.length; i++) {
      const dt = tys[i];
      let m = chart[atkType][dt];
      if (c) {
        if (c.freezeDry && dt === T.WATER) m = 8192;
        else if (c.user && m === 0 && dt === T.GHOST && (atkType === T.NORMAL || atkType === T.FIGHTING) && (this.abFn(c.user, 'scrappy') || def.v.fore)) m = 4096;
        else if (c.groundsFlying && m === 0 && atkType === T.GROUND && dt === T.FLYING) m = 4096;
        else if (m === 0 && def.v.mir && atkType === T.PSYCHIC && dt === T.DARK) m = 4096;
        else if (m === 0 && atkType === T.GROUND && dt === T.FLYING && this.isGrounded(def)) m = 4096;
        if (c.user) { const uf = this.abFn(c.user, 'typeMult'); if (uf) m = uf(this, c, m, atkType, dt); }
      }
      if (c) { const df = this.abFn(def, 'typeMultDef', true); if (df) m = df(this, c, m, atkType, dt); }
      if (m === 0 && this.itFn(def, 'ringTarget')) m = 4096;
      if (this.s.pw === PW.WINDS && dt === T.FLYING && m > 4096) { m = 4096; if (c) c.winds = 1; }   // MEASURED: Delta Stream makes what is super effective against Flying neutral; the real game says "weakened the attack" whenever this fired, then still prints the effectiveness of what is left
      mults.push(m);
    }
    let prod = typeProduct(mults);
    if (def.v.tar && atkType === T.FIRE) { mults.push(8192); prod = typeProduct(mults); }   // Tar Shot
    if (c) {
      const up = c.user ? this.abFn(c.user, 'typeProd') : null; if (up) { const np = up(this, c, prod); if (np !== prod) { prod = np; mults.length = 0; mults.push(np); } }
      const dp = this.abFn(def, 'typeProdDef', true); if (dp) { const np = dp(this, c, prod); if (np !== prod) { prod = np; mults.length = 0; mults.push(np); } }
    }
    return { prod, mults };
  },

  // ------------------------------------------------------------------ the move
  makeCtx(us, mv, ef, K, o) {
    const user = this.act(us);
    const ts = us ^ 1;
    return {
      b: this, us, ts, user, target: this.act(ts), mv, id: mv.id, ef, K,
      type: mv.type, cat: mv.category, power: mv.power, acc: mv.accuracy,
      crit: false, roll: 0, hit: 0, nhits: 1, total: 0, dealt: 0, eff: 4096, o: o || EMPTY,
      called: !!(o && o.called), contact: mv.flags.contact && !this.abFn(user, 'noContact') && !this.itFn(user, 'noContact'), fail: null, extra: {},
    };
  },

  /** Execute `moveId` for the active mon of side `us`. Returns nothing; everything is in events / state. */
  useMove(us, moveId, o) {
    o = o || EMPTY;
    const S = this.s;
    const user = this.act(us);
    const mv = this.pack.moves[moveId];
    const ef = EFFECTS[mv.effect];
    const K = MOVE_KINDS[ef.kind];
    const c = this.makeCtx(us, mv, ef, K, o);
    if (o.boostBp) c.extraBp = [o.boostBp];   // Me First
    const target = c.target;
    S.mb = !!(user && this.abFn(user, 'moldBreaker'));
    // PP and bookkeeping
    if (!o.noPP && !o.called) {
      const slot = user.mv.find((x) => x.id === moveId);
      if (slot) {
        let cost = 1;
        if (target && target.hp > 0 && this.abFn(target, 'pressure', true)) cost = 2;
        if (target && target.hp > 0) { const dq = this.abFn(target, 'ppDrain', true); if (dq) cost += dq; }
        slot.pp = slot.pp > cost ? slot.pp - cost : 0;
      }
    }
    user.v.moved = 1;
    if (moveId !== this.D.moveByName.Rage) delete user.v.rage;
    delete user.v.glaive;
    user.v.lastMv = moveId;
    if (moveId !== this.D.moveByName.Copycat && moveId !== this.D.moveByName.Struggle) S.lm = moveId;
    if (!o.called) { if (!user.v.um) user.v.um = []; if (user.v.um.indexOf(moveId) < 0) user.v.um.push(moveId); }
    c.executed = true;
    if (ef.kind !== 'destinybond') delete user.v.db;
    if (o.second) delete user.v.sinv;
    this.reveal(user, 'm', moveId);
    this.emit({ t: 'move-use', s: us, m: user.slot, mv: moveId, called: o.called ? 1 : 0 });
    // moves that thaw the user
    if (user.s === ST.FRZ && this.D.named.thawUser.has(moveId)) this.clearStatus(user, 'thaw');
    // type changers (Aerilate, Normalize, Libero ...)
    const tc = this.abFn(user, 'moveType');
    if (tc) { const nt = tc(this, user, c); if (nt !== undefined && nt !== c.type) { c.type = nt.type !== undefined ? nt.type : nt; if (nt.boost) c.typeBoost = nt.boost; } }
    if (K.type) { const nt = K.type(c); if (nt !== undefined) c.type = nt; }
    if (user.v.elec) { c.type = T.ELECTRIC; delete user.v.elec; }
    if (S.ion && c.type === T.NORMAL) c.type = T.ELECTRIC;   // Ion Deluge: every Normal move of the turn is Electric
    if (user.v.powder && c.type === T.FIRE && !o.second) {   // Powder: a Fire move fails and the user takes a quarter of its max HP
      delete user.v.powder; this.emit({ t: 'fail', s: us, m: user.slot, why: 'powder', mv: moveId });
      if (!this.abFn(user, 'magicGuard')) this.dealDamage(user, fractionOf(user.mhp, 4), { src: 'powder', from: -1 });
      this.endMove(c); return;
    }
    if (!S.mb && ((c.type === T.FIRE && this.abFn(user, 'fireBreaker')) || (c.type === T.WATER && this.abFn(user, 'waterBreaker') && this.wx() === WX.RAIN))) S.mb = true;
    if (K.cat) { const nc = K.cat(c); if (nc !== undefined) c.cat = nc; }
    { const bm = this.abFn(user, 'beforeMove'); if (bm) bm(this, user, c); }
    // charge turn?
    if (K.charge && !o.second) {
      if (K.charge(c)) { this.endMove(c); return; }
    }
    let fr = K.fail ? K.fail(c) : null;
    if (!fr && K.dmg && ((S.pw === PW.RAIN && c.type === T.FIRE) || (S.pw === PW.SUN && c.type === T.WATER))) fr = 'primal-weather';   // MEASURED: the move does nothing
    if (!fr && (mv.bytes[5] & 2)) {
      for (let sd = 0; sd < 2; sd++) { const dm = this.act(sd); if (dm.hp > 0 && this.abFn(dm, 'damp')) { fr = 'damp'; c.dampBlocked = true; this.reveal(dm, 'a'); } }
    }
    if (fr) { if (fr !== 'sturdy' && fr !== 'lost-focus') this.failMove(c, fr); else { c.failedLogged = true; this.afterMiss(c, true); } this.endMove(c); return; }
    if (K.begin) K.begin(c);
    const status = mv.category === CAT.STATUS && !K.dmg;
    if (status && mv.target === 7 && !o.snatched && !o.called && !K.selfOnly) { const foe = this.act(us ^ 1); if (foe && foe.hp > 0 && foe.v.snatch) { delete foe.v.snatch; this.emit({ t: 'noop', s: us ^ 1, m: foe.slot, why: 'snatched', mv: moveId }); this.useMove(us ^ 1, moveId, { noPP: true, called: true, snatched: true }); this.endMove(c); return; } }
    const selfish = mv.target === 7 || mv.target === 12 || mv.target === 13 || mv.target === 14 || mv.target === 9 || mv.target === 10 || mv.target === 8 || K.selfOnly;
    // ---- targeted at the foe: protect, semi-invulnerable, substitute, accuracy
    if (!selfish) {
      if (target.hp <= 0) { c.noTarget = true; this.emit({ t: 'fail', s: us, m: user.slot, why: 'no-target', mv: moveId }); this.endMove(c); return; }
      if (this.checkProtect(c)) { this.endMove(c); return; }
      const sinv = target.v.sinv;
      if (sinv && !(K.hitsInvuln && K.hitsInvuln(c, sinv)) && !this.hitsInvulnFlag(mv, sinv) && !user.v.lockon) {
        this.emit({ t: 'avoid', s: c.ts, m: target.slot, mv: moveId });
        this.afterMiss(c);
        this.endMove(c); return;
      }
      if (status && target.v.sub > 0 && !mv.flags.sound && !K.ignoreSub && !(this.abFn(user, 'infiltrates'))) {
        this.emit({ t: 'fail', s: us, m: user.slot, why: 'substitute', mv: moveId });
        this.endMove(c); return;
      }
      // Gen 7+: a status move that Prankster pushed up the order does not affect Dark-type targets
      if (status && !o.called && this.hasAbility(user, 'Prankster') && this.hasType(target, T.DARK)) {
        this.reveal(user, 'a');
        this.emit({ t: 'immune', s: c.ts, m: target.slot, why: 'prankster', mv: moveId });
        this.afterMiss(c, true); this.endMove(c); return;
      }
      // abilities that stop or bounce a status move (Good as Gold, Solar Armor, Abyssal Veil, Magic Bounce) and priority blockers (Dazzling, Armor Tail)
      if (status) {
        const sb = this.abFn(target, 'statusMoveBlock', true);
        if (sb && sb(this, c)) { this.reveal(target, 'a'); this.afterMiss(c, true); this.endMove(c); return; }
        if (target.v.mcoat && !o.bounced && this.reflectable(c)) { this.emit({ t: 'noop', s: c.ts, m: target.slot, why: 'bounced', mv: moveId }); this.useMove(c.ts, moveId, { noPP: true, called: true, bounced: true }); this.afterMiss(c, true); this.endMove(c); return; }
        const mb = this.abFn(target, 'magicBounce', true);
        if (mb && !o.bounced && this.reflectable(c) && mb(this, c)) { this.afterMiss(c, true); this.endMove(c); return; }
      }
      if (o.pri > 0 && !o.called && this.terrainActs(target, TN.PSYCHIC)) { this.emit({ t: 'fail', s: us, m: user.slot, why: 'terrain', mv: moveId }); this.afterMiss(c, true); this.endMove(c); return; }
      if (o.pri > 0 && !o.called) {
        const pb = this.abFn(target, 'priorityBlock', true);
        if (pb && pb(this, c)) { this.reveal(target, 'a'); this.afterMiss(c, true); this.endMove(c); return; }
      }
      if (!this.checkAccuracy(c)) { this.emit({ t: 'miss', s: us, m: user.slot, mv: moveId }); { const bp = this.itFn(user, 'onMiss'); if (bp) bp(this, user); } this.afterMiss(c); this.endMove(c); return; }
    }
    if (K.dmg) this.runDamage(c);
    else if (K.use) { const ok = K.use(c); if (ok === false && !c.failedLogged) this.failMove(c, c.fail || 'failed'); }
    if (user.v.lockon && !selfish && ef.kind !== 'lockon') delete user.v.lockon;
    this.endMove(c);
  },
  endMove(c) {
    const S = this.s;
    S.mb = false;
    if (c.K.endMove) c.K.endMove(c);
    { const ho = this.act(c.ts); if (ho && ho.hp > 0 && ho.v.mhq && ho !== c.user) { const q = ho.v.mhq; delete ho.v.mhq; this.consumeItem(ho, 'mirror-herb'); for (const [st, n] of q) this.changeStage(ho, st, n, -1, { opp: 1 }); } }
    // Explosion / Self-Destruct: the user faints once the move was USED, whatever became of the hit (miss, Ghost, Protect,
    // a semi-invulnerable target, a Substitute). Only Damp (a fail before the move starts) and a missing target stop it.
    if ((c.mv.bytes[5] & 2) && c.executed && !c.dampBlocked && !c.noTarget && c.user.hp > 0 && this.act(c.us) === c.user) {
      this.dealDamage(c.user, c.user.hp, { src: 'explosion', from: -1 });
    }
  },
  failMove(c, why) {
    c.failedLogged = true;
    this.emit({ t: 'fail', s: c.us, m: c.user.slot, mv: c.id, why: why || 'failed' });
    if (c.K.onFail) c.K.onFail(c);
    this.afterMiss(c, true);
  },
  afterMiss(c, failed) {
    c.user.v.prevFail = this.s.turn;
    const f = c.K.onMiss;
    if (f) f(c, !!failed);
    const user = c.user;
    // Blunder Policy style items
    if (!failed) { const itf = this.itFn(user, 'onMiss'); if (itf) itf(this, user); }
    if (user.v.ramp && !failed) delete user.v.ramp;
  },
  invulnDoubles(c, sinv) {
    const s = this.D.named.invulnDouble[sinv];
    return !!(s && s.has(c.id));
  },
  hitsInvulnFlag(mv, sinv) {
    const b0 = mv.bytes[8];
    if (sinv === 'ground') return (b0 & 8) !== 0;
    if (sinv === 'water') return (b0 & 16) !== 0;
    if (sinv === 'air') return (b0 & (32 | 64)) !== 0;
    return false;
  },

  /** Protect-family and similar blockers on the TARGET. Returns true when the move was stopped. */
  checkProtect(c) {
    const t = c.target;
    const pk = t.v.prot;
    if (!pk) return false;
    const mv = c.mv;
    if (c.K.bypassProtect || (c.o && c.o.bypassProtect)) return false;
    if (mv.additional.some((a) => a.effect === 56)) { delete t.v.prot; this.emit({ t: 'protect-break', s: c.ts, m: t.slot }); return false; }
    if (this.abFn(c.user, 'unseenFist') && c.contact) return false;
    if (this.abFn(c.user, 'tidalDeity') && c.user.hp === c.user.mhp) return false;   // MEASURED
    if (this.abFn(c.user, 'nullSpace') && mv.category !== CAT.STATUS && (pk === 1 || pk === 2 || pk === 3 || pk === 4 || pk === 5 || pk === 6 || pk === 7 || pk === 12)) { c.nullSpace = true; return false; }
    const status = mv.category === CAT.STATUS;
    // kind: 1 protect, 2 spiky, 3 kings shield, 4 baneful, 5 burning bulwark, 6 obstruct, 7 silk trap, 9 wide guard, 10 quick guard, 11 crafty shield
    if (pk === 9) { if (mv.target !== 6 && mv.target !== 11) return false; }
    else if (pk === 10) { if (this.priorityOf(c.user, mv) <= 0) return false; }
    else if (pk === 11) { if (!status) return false; }
    else if (pk === 12) { if (status) return false; }   // Mat Block: damaging moves only
    else if (pk === 3 || pk === 6 || pk === 7) { /* damaging moves only */ if (status) return false; }
    if (mv.target === 7 || mv.target === 12 || mv.target === 13) return false;
    this.emit({ t: 'protected', s: c.ts, m: t.slot, mv: c.id, pk });
    if (c.contact) {
      if (pk === 2) this.dealDamage(c.user, fractionOf(c.user.mhp, 8), { src: 'spiky-shield', from: c.ts });
      else if (pk === 3) this.changeStage(c.user, 'atk', -1, c.ts);
      else if (pk === 4) this.setStatus(c.user, ST.PSN, t, { fx: 'baneful-bunker' });
      else if (pk === 5) this.setStatus(c.user, ST.BRN, t, { fx: 'burning-bulwark' });
      else if (pk === 6) this.changeStage(c.user, 'def', -2, c.ts);
    }
    if (pk === 7 && c.contact) this.changeStage(c.user, 'spe', -1, c.ts);
    this.afterMiss(c, true);
    return true;
  },

  /** Accuracy check; consumes one rand(100) when the effective accuracy is below 100. */
  checkAccuracy(c) {
    if (c.target && (c.target.v.tele > 0 || c.target.v.glaive) && !c.K.ohko) return true;
    const user = c.user, t = c.target, mv = c.mv;
    let acc = c.K.acc ? c.K.acc(c) : mv.accuracy;
    if (c.K.ohko) return this.ohkoHit(c);
    if (acc === 0 || acc === undefined) return true;
    if (user.v.lockon) return true;
    { const sh = this.abFn(user, 'sureHit'); if (sh && sh(this, c)) return true; }
    // Gen 6+: Toxic used by a Poison-type never misses; Stomp-family moves never miss a Minimized target
    if (this.D.args.statusType[c.id] === ST.TOX && this.hasType(user, T.POISON)) return true;
    if (t.v.mini && this.D.named.minimizeDouble.has(c.id)) return true;
    if (this.abFn(user, 'noGuard') || this.abFn(t, 'noGuard')) return true;
    // weather overrides
    const wa = this.D.named.weatherAcc[c.id];
    if (wa) {
      const w = this.wx();
      if (w === WX.RAIN && wa.rain !== undefined) { if (wa.rain === 0) return true; acc = wa.rain; }
      else if (w === WX.SUN && wa.sun !== undefined) acc = wa.sun;
      else if ((w === WX.HAIL || w === WX.SNOW) && wa.hail !== undefined) { if (wa.hail === 0) return true; }
    }
    let aStage = user.sg.acc, eStage = t.sg.eva;
    if (this.abFn(user, 'ignoreEva') || t.v.fore || t.v.mir) eStage = eStage > 0 ? 0 : eStage;
    if (this.abFn(t, 'unaware', true)) aStage = 0;
    if (this.abFn(user, 'unaware')) eStage = 0;
    acc = applyAccStage(acc, aStage - eStage);
    const mods = [];
    if (this.s.gv > 0) mods.push(E.gravityAccMod);   // MEASURED: Focus Blast hit 43 of 60 draws normally and 60 of 60 under Gravity, Zap Cannon 34 -> 52
    const af = this.abFn(user, 'acc'); if (af) { const r = af(this, c); if (r) mods.push(r); }
    const ef = this.abFn(t, 'evade', true); if (ef) { const r = ef(this, c); if (r) mods.push(r); }
    const ia = this.itFn(user, 'acc'); if (ia) { const r = ia(this, c); if (r) mods.push(r); }
    const ie = this.itFn(t, 'evade'); if (ie) { const r = ie(this, c); if (r) mods.push(r); }
    if (mods.length) acc = pokeMod(acc, chain(mods));
    if (acc >= 100) return true;
    if (acc < 1) acc = 1;
    return this.rand(100) < acc;
  },
  ohkoHit(c) {
    const user = c.user, t = c.target;
    if (t.level > user.level) return false;
    // Gen 7+: Sheer Cold used by a non-Ice-type starts from 20 instead of 30
    const base = c.mv.type === T.ICE && !this.hasType(user, T.ICE) ? 20 : 30;
    const acc = base + user.level - t.level;
    if (acc >= 100) return true;
    return this.rand(100) < acc;
  },

  critStage(c) {
    const user = c.user;
    let st = c.mv.critStage + (user.v.fe ? 2 : 0);
    const af = this.abFn(user, 'critBoost'); if (af) st += af(this, c);
    const itf = this.itFn(user, 'critBoost'); if (itf) st += itf(this, c);
    if (c.K.critBoost) st += c.K.critBoost(c);
    return st > 3 ? 3 : st < 0 ? 0 : st;
  },
  rollCrit(c) {
    const t = c.target;
    if (c.K.noCrit) return false;
    const imm = this.abFn(t, 'critImmune', true);
    if (imm && imm(this, t)) return false;
    if (t.side >= 0 && this.s.sides[t.side].luckyChant > 0) return false;
    if (c.mv.alwaysCrit || (c.K.alwaysCrit && c.K.alwaysCrit(c))) return true;
    if (c.user.v.lf > 0 && !c.o.preview) { delete c.user.v.lf; return true; }   // Laser Focus (MEASURED: "A critical hit!" on the next move)
    const odds = E.critOdds[this.critStage(c)];
    return this.rand(odds) === 0;
  },

  // ------------------------------------------------------------------ the damage pipeline
  /** Modifier hooks for one stage of the damage formula: attacker ability+item first, then defender ability+item. */
  modsOf(c, phase) {
    const out = [];
    const P = PHASE_HOOKS[phase];
    const user = c.user, t = c.target;
    if (P.user) {
      let f = this.abFn(user, P.user); if (f) { const r = f(this, c); if (r) out.push(r); }
      f = this.itFn(user, P.user); if (f) { const r = f(this, c); if (r) out.push(r); }
    }
    if (P.target) {
      let f = this.abFn(t, P.target, true); if (f) { const r = f(this, c); if (r) out.push(r); }
      f = this.abFn(user, 'overload') ? undefined : this.itFn(t, P.target); if (f) { const r = f(this, c); if (r) out.push(r); }
    }
    return out;
  },

  /** Final damage for the CURRENT hit given c.crit and c.roll. Pure with respect to RNG. */
  calcDamage(c) {
    const user = c.user, t = c.target;
    let W = this.wx();
    if (W !== WX.SUN && this.abFn(user, 'sunMoves')) W = WX.SUN;
    if ((W === WX.RAIN || W === WX.SUN) && (this.itFn(t, 'umbrella') || this.itFn(user, 'umbrella'))) W = WX.NONE;
    let bp = c.bp !== undefined ? c.bp : (c.K.power ? c.K.power(c) : c.power);
    if (bp === undefined || bp < 1) bp = 1;
    c.bpBase = bp;
    const plain = !!c.plain;
    const bmods = plain ? [] : this.modsOf(c, 'bp');
    if (c.typeBoost) bmods.push(c.typeBoost);
    if (c.extraBp) for (const m of c.extraBp) bmods.push(m);
    if (user.v.chgd && c.type === T.ELECTRIC && !plain) bmods.push(8192);
    if (!plain) { const tmod = this.terrainMod(c); if (tmod) bmods.push(tmod); }
    if (!plain && ((this.s.ms > 0 && c.type === T.ELECTRIC) || (this.s.ws > 0 && c.type === T.FIRE))) bmods.push(E.sportMod);
    if (!plain) for (let s = 0; s < 2; s++) { const x = this.act(s); if (x && x.hp > 0) { const af = this.abFn(x, 'aura'); if (af) { const r = af(this, c); if (r) bmods.push(r); } } }
    if (bmods.length) bp = pokeMod(bp, chain(bmods));
    if (bp < 1) bp = 1;
    // stats
    const phys = c.cat === CAT.PHYSICAL;
    const atkMon = c.atkMon || user;
    const atkKey = c.atkStat || (phys ? 'atk' : 'spa');
    const defKey = c.defStat || (phys ? 'def' : 'spd');
    let aStage = atkMon.sg[atkKey], dStage = t.sg[defKey];
    if (c.crit) { if (aStage < 0) aStage = 0; if (dStage > 0) dStage = 0; }
    if (this.abFn(t, 'unaware', true)) aStage = 0;
    if (this.abFn(user, 'unaware')) dStage = 0;
    let A = applyStage(this.statOf(atkMon, atkKey), aStage);
    { const as = this.abFn(user, 'atkSource'); if (as && !plain) A = as(this, c, A, aStage); }
    const amods = plain ? [] : this.modsOf(c, 'atk');
    if (!plain && this.ruinHeld(phys ? 'Tablets of Ruin' : 'Vessel of Ruin', atkMon)) amods.push(E.ruinMod);
    if (amods.length) A = pokeMod(A, chain(amods));
    let Dd = applyStage(this.statOf(t, this.s.wr > 0 && !c.defStat ? (defKey === 'def' ? 'spd' : 'def') : defKey), dStage);
    const dmods = plain ? [] : this.modsOf(c, 'def');
    if (!plain && this.ruinHeld(phys ? 'Sword of Ruin' : 'Beads of Ruin', t)) dmods.push(E.ruinMod);
    if (!plain && !phys && W === WX.SAND && this.hasType(t, T.ROCK)) dmods.push(6144);
    if (!plain && phys && W === WX.SNOW && this.hasType(t, T.ICE)) dmods.push(6144);
    if (dmods.length) Dd = pokeMod(Dd, chain(dmods));
    if (A < 1) A = 1;
    if (Dd < 1) Dd = 1;
    let d = baseDamage(user.level, bp, A, Dd);
    // weather
    if (plain) { /* confusion damage ignores weather, crits, STAB, burn and screens */ }
    else if (W === WX.RAIN) { if (c.type === T.WATER) d = pokeMod(d, E.weatherBoostMod); else if (c.type === T.FIRE) d = pokeMod(d, E.weatherCutMod); }
    else if (W === WX.SUN) { if (c.type === T.FIRE) d = pokeMod(d, E.weatherBoostMod); else if (c.type === T.WATER) d = pokeMod(d, c.sunWater ? E.weatherBoostMod : E.weatherCutMod); }
    if (!plain) { const sm = this.scorchMod(c); if (sm) d = pokeMod(d, sm); }
    if (!plain && t.v.glaive) d = d * 2;   // Glaive Rush: doubled in the base-damage step (MEASURED: one hp more than a final x2)
    if (c.crit && !plain) d = pokeMod(d, E.critMod);
    d = idiv(d * rollFactor(c.roll), 100);
    // STAB
    const stab = plain ? 4096 : this.stabMod(c);
    if (stab !== 4096) d = pokeMod(d, stab);
    // type effectiveness, per defender type
    const ee = c.effInfo || this.typeEff(c.type, t, c);
    // ROM (measured, ROMDIFF.md): the defender's type multipliers are multiplied into ONE UQ4.12 number and applied once with the half-down rounding
    // (1438 of 1438 dual-type rolls); flooring after each type, as before, was off by one on dual types
    let tmods = ee.mults.slice();
    if (c.flyingPress) { const e2 = this.typeEff(T.FLYING, t, c); tmods = tmods.concat(e2.mults); }
    d = pokeMod(d, typeProduct(tmods));
    // burn
    if (!plain && user.s === ST.BRN && phys && !c.noBurnCut && !this.abFn(user, 'guts')) d = pokeMod(d, E.burnMod);
    if (!plain && user.s === ST.FBT && !phys && !c.noBurnCut) d = pokeMod(d, E.frostbiteMod);   // MEASURED: a frostbitten Flamethrower deals half (18 of 37)
    if (plain) return d < 1 ? 1 : d;
    // final modifiers
    const fm = this.modsOf(c, 'final');
    if (c.nullSpace) fm.push(2048);
    if (c.K.finalMod) { const r = c.K.finalMod(c); if (r) fm.push(r); }
    // x2 against a semi-invulnerable target the move can reach (Earthquake vs Dig ...) and Stomp-family vs a Minimized target
    if (t.v.sinv && this.invulnDoubles(c, t.v.sinv)) fm.push(8192);
    if (t.v.mini && this.D.named.minimizeDouble.has(c.id)) fm.push(8192);
    const sd = this.s.sides[t.side];
    if (!c.crit && !this.abFn(user, 'infiltrates') && !(this.abFn(user, 'tidalDeity') && user.hp === user.mhp)) {
      if (sd.veil > 0) fm.push(E.screenMod);
      else if (phys && sd.reflect > 0) fm.push(E.screenMod);
      else if (!phys && sd.light > 0) fm.push(E.screenMod);
    }
    if (c.parental && c.hit === 1) fm.push(1024);
    if (fm.length) d = pokeMod(d, chain(fm));
    if (d < 1 && ee.prod !== 0 && !(c.flyingPress && this.typeEff(T.FLYING, t, c).prod === 0)) d = 1;
    return d;
  },
  stabMod(c) {
    const user = c.user;
    if (c.type === T.MYSTERY) return 4096; // typeless moves (Struggle) never get STAB
    const tys = this.types(user);
    let own = tys.indexOf(c.type) >= 0;
    if (!own) { const xs = this.abFn(user, 'stabAlso'); if (xs !== undefined && xs === c.type) own = true; }
    if (c.stabType !== undefined) own = own || tys.indexOf(c.stabType) >= 0;
    if (!own) return 4096;
    const af = this.abFn(user, 'stab');
    if (af) { const r = af(this, c); if (r) return r; }
    return E.stabMod;
  },

  /** Run a damaging move through hits, effects and aftermath. */
  runDamage(c) {
    const user = c.user, t = c.target, K = c.K, mv = c.mv;
    // power and type-specific context
    if (K.prep) K.prep(c);
    if (c.skip) return;
    const effInfo = this.typeEff(c.type, t, c);
    if (c.flyingPress) { const e2 = this.typeEff(T.FLYING, t, c); effInfo.prod = typeProduct([effInfo.prod, e2.prod]); }
    c.effInfo = c.flyingPress ? { prod: effInfo.prod, mults: effInfo.mults } : effInfo;
    c.eff = effInfo.prod;
    // immunity (type chart, then abilities); fixed-damage moves obey the chart too
    { const imf0 = c.eff === 0 ? this.abFn(t, 'immune', true) : null; if (imf0 && imf0(this, c)) { this.reveal(t, 'a'); this.afterMiss(c, true); return; } }
    if (c.eff === 0) { this.emit({ t: 'immune', s: c.ts, m: t.slot, why: 'type', mv: c.id }); this.afterMiss(c, true); return; }
    if (mv.additional.some((a) => a.effect === 62) && t.it && this.berries.has(t.it) && !(t.v.sub > 0) && !this.abFn(t, 'stickyHold', true)) { c.stolen = t.it; this.reveal(t, 'i'); t.it = 0; }
    if (mv.additional.some((a) => a.effect === 97)) { c.bp = 150; this.setTerrain(TN.PSYCHIC, user); }   // Genesis Supernova: base power 150, Psychic Terrain first (87 = 67 x 1.3 in the real game)
    if (mv.additional.some((a) => a.effect === 4224)) { for (const k of STAT_IDX) if (t.sg[k] > 0) { user.sg[k] = Math.min(6, user.sg[k] + t.sg[k]); t.sg[k] = 0; } this.emit({ t: 'stats-reset', s: c.ts, m: t.slot, partial: 1 }); }
    if (c.type === T.GROUND && mv.power > 0 && !t.v.smack && !this.itFn(t, 'ironBall') && !(this.s.gv > 0) && (t.v.mag || t.v.tele > 0 || this.itFn(t, 'floats'))) {
      this.emit({ t: 'immune', s: c.ts, m: t.slot, why: 'airborne', mv: c.id });
      this.afterMiss(c, true);
      return;
    }
    const imf = this.abFn(t, 'immune', true);
    if (imf && imf(this, c)) { this.reveal(t, 'a'); this.afterMiss(c, true); return; }
    if (mv.power > 0) { const fh = this.abFn(t, 'firstHit', true); if (fh && fh(this, c)) { this.reveal(t, 'a'); this.afterMiss(c, true); return; } }
    if (mv.flags.powder && (this.hasType(t, T.GRASS) || this.abFn(t, 'overcoat', true) || this.itFn(t, 'goggles'))) { this.emit({ t: 'immune', s: c.ts, m: t.slot, why: 'powder', mv: c.id }); this.afterMiss(c, true); return; }
    const fixed = K.damage ? K.damage(c) : undefined;
    if (fixed === -2) { this.emit({ t: 'fail', s: c.us, m: user.slot, mv: c.id, why: 'failed' }); this.afterMiss(c, true); return; }
    if (K.breakScreens || mv.additional.some((a) => a.effect === 4223)) {
      const tsd = this.s.sides[c.ts];
      for (const k of ['reflect', 'light', 'veil']) if (tsd[k] > 0) { tsd[k] = 0; this.emit({ t: 'screen-end', s: c.ts, k, broken: 1 }); }
    }
    let nhits = K.hits ? K.hits(c) : this.hitsOf(c);
    if (nhits === 1 && !NO_PARENTAL.has(ef0kind(c)) && !(mv.bytes[5] & 2) && this.abFn(user, 'parental')) { nhits = 2; c.parental = true; }
    c.nhits = nhits;
    let hits = 0;
    for (let i = 0; i < nhits; i++) {
      if (t.hp <= 0 || (user.hp <= 0 && i > 0)) break;
      c.hit = i;
      if (i > 0 && K.perHitAcc && !(K.linkSkipsAcc && this.abFn(user, 'skillLink')) && !this.checkAccuracy(c)) break;
      if (K.perHit) K.perHit(c, i);
      c.crit = this.rollCrit(c);
      let dmg;
      if (fixed !== undefined && fixed >= 0) dmg = fixed;
      else { c.roll = this.rand(E.randomRollSpan); dmg = this.calcDamage(c); }
      const info = { move: true, contact: c.contact, from: c.us, mv: c.id, cat: c.cat, crit: c.crit, eff: c.eff, winds: c.winds, bypassSub: mv.flags.sound || !!K.bypassSub || !!this.abFn(user, 'infiltrates') };
      if (K.survive1 && dmg >= t.hp) dmg = t.hp - 1;
      if (c.crit) this.emit({ t: 'crit', s: c.ts, m: t.slot });
      const dealt = dmg > 0 ? this.dealDamage(t, dmg, info) : 0;
      c.dealt = dealt;
      c.total += dealt;
      c.subHit = !!info.subHit;
      // a frozen target is thawed by a damaging Fire-type hit (and Scald-type moves) that a Substitute did not absorb
      if (dealt > 0 && t.hp > 0 && t.s === ST.FRZ && (c.type === T.FIRE || this.D.named.thawTarget.has(c.id))) this.clearStatus(t, 'thaw');
      hits++;
      c.lastHit = { dmg, crit: c.crit };
      if (K.afterHit) K.afterHit(c, dealt);
      // contact / hit reactions
      if (!c.subHit || dealt > 0) this.onHitReactions(c, dealt, i === nhits - 1 || t.hp <= 0);
      if (c.resist && t.it && dealt > 0) { c.resist = 0; this.consumeItem(t, 'resist-berry'); }
      if (user.hp <= 0) break;
    }
    c.hits = hits;
    if (user.v.chgd && c.type === T.ELECTRIC) delete user.v.chgd;
    if (nhits > 1 && hits > 0) this.emit({ t: 'multi-hit', s: c.us, m: user.slot, n: hits });
    if (hits === 0) { this.afterMiss(c, true); return; }
    // secondary effects, then kind aftermath
    const sheer = this.abFn(user, 'sheerForce') && this.hasSecondary(c);
    if (!sheer) this.secondary(c);
    { const ah = this.abFn(user, 'afterHit'); if (ah && c.total > 0 && user.hp > 0) ah(this, c); }
    if (c.total > 0 || K.afterAlways) {
      if (K.after) K.after(c);
    }
    // item aftermath on the user (Life Orb recoil, Shell Bell, King's Rock)
    if (user.hp > 0 || c.total > 0) { const lo = this.itFn(user, 'afterAttack'); if (lo) lo(this, c); }
    // (the self-destruct family faints its user in endMove(), so a miss / Ghost / Protect does not spare it)
  },
  /** Trick Room just came into effect: items that react to it (Room Service). */
  roomSet() { for (let s = 0; s < 2; s++) { const m = this.act(s); if (m && m.hp > 0) { const f = this.itFn(m, 'onTrickRoom'); if (f) f(this, m); } } },
  /** A status move Magic Bounce / Magic Coat may send back: aimed at the foe or its side, minus the moves that copy or swap things. */
  reflectable(c) {
    const mv = c.mv;
    if (mv.category !== CAT.STATUS || (mv.target !== 1 && mv.target !== 6 && mv.target !== 13)) return false;
    return !NOT_REFLECTABLE.has(mv.name);
  },
  hasSecondary(c) {
    return c.mv.additional.some((a) => ADDITIONAL[a.effect] && ADDITIONAL[a.effect].k !== 'noop' && ADDITIONAL[a.effect].k !== 'recharge' && ADDITIONAL[a.effect].k !== 'rampage' && ADDITIONAL[a.effect].k !== 'struggle' && ADDITIONAL[a.effect].k !== 'trap');
  },
  hitsOf(c) {
    const mv = c.mv;
    if (mv.strikeCount > 0) return mv.strikeCount;
    if (mv.bytes[5] & 1) {
      if (this.abFn(c.user, 'skillLink')) return 5;
      if (this.itFn(c.user, 'loadedDice')) return 4 + this.rand(2);
      const r = this.rand(100); // 35/35/15/15 -> 2,3,4,5 hits
      return r < 35 ? 2 : r < 70 ? 3 : r < 85 ? 4 : 5;
    }
    return 1;
  },
  onHitReactions(c, dealt, last) {
    const user = c.user, t = c.target;
    if (t.v.rage && dealt > 0 && t.hp > 0) this.changeStage(t, 'atk', 1, -1, {});
    if (c.contact && dealt > 0 && t.hp > 0 && user.hp > 0 && !t.v.moved && this.s.q.some((x) => x.s === c.ts && x.k === 'move' && !x.second && this.pack.moves[x.mv] && this.pack.moves[x.mv].name === 'Beak Blast')) this.setStatus(user, ST.BRN, t, { fx: 'beak-blast' });
    // defender ability: damaging hit reactions (Static, Rough Skin, Mummy ...), contact only where the hook checks c.contact
    const f = this.abFn(t, 'onHit', true);
    if (f && t.hp >= 0) f(this, c, dealt);
    const it = this.itFn(t, 'onHit');
    if (it) it(this, c, dealt);
    if (c.K.onHit) c.K.onHit(c, dealt);
  },

  /** Secondary effects of a damaging move, in table order. */
  secondary(c) {
    const user = c.user, t = c.target;
    const serene = this.abFn(user, 'serene') ? 2 : 1;
    const adds = c.mv.additional;
    for (let i = 0; i < adds.length; i++) {
      const a = adds[i], ad = ADDITIONAL[a.effect];
      if (!ad) continue;
      const self = !!ad.self || ad.k === 'recharge' || ad.k === 'rampage' || ad.k === 'struggle';
      if (!self) {
        if (t.hp <= 0) continue;
        if (this.abFn(t, 'shieldDust', true)) continue;
        if (t.v.sub > 0 && c.subHit) continue; // blocked by the substitute
        if (this.itFn(t, 'covert')) continue;
      } else if (user.hp <= 0 && ad.k !== 'rampage') continue;
      let chance = a.chance === 0 ? 100 : a.chance * serene;
      if (chance < 100 && this.rand(100) >= chance) continue;
      this.applyAdditional(c, ad, a);
    }
  },
  applyAdditional(c, ad, a) {
    const user = c.user, t = c.target;
    switch (ad.k) {
      case 'status': this.setStatus(t, ad.s, user, { fx: 'secondary', from: c.us }); break;
      case 'confuse': this.confuse(t, user, { fx: 'secondary' }); break;
      case 'flinch': if (!t.v.moved && !this.abFn(t, 'innerFocus', true)) t.v.flinch = 1; break;
      case 'tri': { const r = this.rand(3); this.setStatus(t, r === 0 ? ST.BRN : r === 1 ? ST.PAR : ST.FBT, user, { fx: 'tri-attack' }); break; }
      case 'noop': break;
      case 'trap': this.trapMon(t, user, a.flags); break;
      case 'noescape': if (!t.v.noesc) { t.v.noesc = 1; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'noescape' }); } break;
      case 'stat': {
        const swapped = ad.self && (c.mv.name === 'Close Combat' || c.mv.name === 'Superpower') && this.abFn(user, 'titanGrip');   // Titan Grip turns the drawback on the foe
        const tgt = ad.self && !swapped ? user : t;
        const fields = ad.self || ad.foe;
        for (const k of Object.keys(fields)) this.changeStage(tgt, k, fields[k], ad.self && !swapped ? -1 : c.us, { move: true });
        break;
      }
      case 'recharge': if (!this.abFn(user, 'tireless')) user.v.rch = 1; break;
      case 'rampage': if (!user.v.ramp && !c.o.second) user.v.ramp = { mv: c.id, t: 1 + this.rand(2) }; break; // 2-3 turns in total
      case 'clearsmog': for (const k of STAT_IDX) t.sg[k] = 0; this.emit({ t: 'stats-reset', s: t.side, m: t.slot }); break;
      case 'breakprotect': if (t.v.prot) { delete t.v.prot; this.emit({ t: 'protect-break', s: t.side, m: t.slot }); } break;
      case 'direclaw': { const r = this.rand(3); this.setStatus(t, r === 0 ? ST.PSN : r === 1 ? ST.PAR : ST.SLP, user, { fx: 'dire-claw' }); break; }
      case 'struggle': this.dealDamage(user, fractionOf(user.mhp, 4), { src: 'recoil', from: -1 }); break;
      case 'rage': user.v.rage = 1; break;
      case 'uproar': if (!user.v.ramp && !c.o.second) user.v.ramp = { mv: c.id, t: 2, up: 1 }; break;   // MEASURED: three turns, no confusion at the end
      case 'pluck': if (c.stolen) { const b0 = c.stolen; delete c.stolen; this.emit({ t: 'item', s: t.side, m: t.slot, it: b0, fx: 'pluck', used: 0 }); this.eatBerry(user, b0); } break;
      case 'incinerate': if (t.it && (this.berries.has(t.it) || /Gem$/.test(this.itemName(t)))) { const it0 = t.it; this.reveal(t, 'i'); t.it = 0; this.emit({ t: 'item', s: t.side, m: t.slot, it: it0, fx: 'incinerate', used: 0 }); } break;
      case 'curebrn': if (t.s === ST.BRN) this.clearStatus(t, 'cure'); break;
      case 'throatchop': if (!t.v.tc) t.v.tc = 2; break;
      case 'coreenforcer': if (t.v.moved && !t.v.gastro) { t.v.gastro = 1; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'gastro-acid' }); } break;
      case 'plasma': this.s.ion = 1; break;
      case 'wall': { const sd = this.s.sides[c.us]; const key = ad.screen === 'reflect' ? 'reflect' : 'light'; if (!(sd[key] > 0)) { sd[key] = this.itFn(user, 'screenExt') ? 8 : E.screenTurns; this.emit({ t: 'screen', s: c.us, k: key }); } break; }
      case 'leechseed': if (t.hp > 0 && t.v.seeded === undefined && !this.hasType(t, T.GRASS)) { t.v.seeded = c.us; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'leech-seed' }); } break;
      case 'hazeall': for (let s2 = 0; s2 < 2; s2++) { const m2 = this.act(s2); for (const k of STAT_IDX) m2.sg[k] = 0; this.emit({ t: 'stats-reset', s: s2, m: m2.slot }); } break;
      case 'aroma': if (user.s !== ST.NONE) this.clearStatus(user, 'cure'); break;
      case 'jawlock': if (t.hp > 0) { t.v.noesc = 1; user.v.noesc = 1; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'noescape' }); } break;
      case 'scaleshot': if (user.hp > 0) { this.changeStage(user, 'spe', 1, -1, {}); this.changeStage(user, 'def', -1, -1, {}); } break;
      case 'raisedburn': if (t.hp > 0 && t.v.raised === this.s.turn) this.setStatus(t, ST.BRN, user, { fx: 'secondary', from: c.us }); break;
      case 'raisedconf': if (t.hp > 0 && t.v.raised === this.s.turn) this.confuse(t, user, { fx: 'secondary' }); break;
      case 'ppcut': if (t.hp > 0 && t.v.lastMv) { const sl = t.mv.find((x) => x.id === t.v.lastMv); if (sl && sl.pp > 0) { sl.pp = sl.pp > 3 ? sl.pp - 3 : 0; this.emit({ t: 'pp-drain', s: t.side, m: t.slot, mv: t.v.lastMv }); } } break;
      case 'glaive': user.v.glaive = 1; break;
      case 'saltcure': if (t.hp > 0 && !t.v.salt) { t.v.salt = 1; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'salt-cure' }); } break;
      case 'syrup': if (t.hp > 0 && !t.v.syrup) { t.v.syrup = 3; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'syrup-bomb' }); } break;
      case 'hbtwo': if (t.hp > 0 && !(t.v.hb > 0) && !this.abFn(t, 'mentalImmune', true)) { t.v.hb = 2; this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'heal-block' }); } break;
      case 'psyterrain': this.setTerrain(TN.PSYCHIC, user); break;
      default: break;
    }
  },
  trapMon(t, user, variety) {
    if (t.v.trap || t.hp <= 0) return;
    if (this.hasType(t, T.GHOST)) return;
    const turns = this.itFn(user, 'gripClaw') ? E.trapMax7 : E.trapMin + this.rand(E.trapSpan);
    t.v.trap = { t: turns, src: user.side, var: variety || 0 };
    this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'trap', var: variety || 0 });
  },
  confuse(t, src, info) {
    if (t.hp <= 0 || t.v.conf) { if (!(info && info.silent)) this.emit({ t: 'fail', s: t.side, m: t.slot, why: 'already-confused' }); return false; }
    if (this.s.sides[t.side].sg > 0 && src && src !== t && !this.abFn(src, 'infiltrates')) { this.emit({ t: 'fail', s: t.side, m: t.slot, why: 'safeguard' }); return false; }
    if (this.terrainActs(t, TN.MISTY)) { if (!(info && info.silent)) this.emit({ t: 'fail', s: t.side, m: t.slot, why: 'terrain' }); return false; }   // MEASURED: Confuse Ray / Swagger's confusion fail
    const f = this.abFn(t, 'confuseImmune', true);
    if (f && f(this, t)) { this.reveal(t, 'a'); this.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability-confuse', ab: t.ab }); return false; }
    t.v.conf = E.confMin + this.rand(E.confSpan);
    this.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'confusion' });
    const ic = this.itFn(t, 'onConfuse'); if (ic) ic(this, t);
    return true;
  },
};

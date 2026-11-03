// pokemonarena/js/engine.js -- a first-party, deterministic SINGLES battle engine for the SoulGold data pack.
//
// Pure ES module (browser + Node): no DOM, no node: imports, no Math.random / Date / Intl. All battle arithmetic is
// integer. The whole battle is `battle.s`, a plain JSON-able state object; the only inputs that ever change it are the
// two sides' choices (small plain objects, <= 2 bytes each when encoded) and the seeded RNG inside the state.
// A turn is therefore a pure function of (state, choices): see stepBattle().
//
// API (details and the event list are in pokemonarena/ENGINE.md):
//   createBattle({ pack, ruleset, teams:[A,B], seed, pick, names, validate })  -> Battle
//   battle.requests()      -> [reqA, reqB]   what each side may choose now ({phase, moves, switches, canForfeit, ...})
//   battle.choose(side, choice) -> { ok, code }          choices: {kind:'move',slot} | {kind:'switch',slot}
//                                                         | {kind:'preview',order:[...]} | {kind:'forfeit'}
//   battle.ready() / battle.advance() -> new events      resolve once every needed side has chosen
//   battle.events, battle.winner (null | 0 | 1 | -1 draw), battle.hash(), battle.snapshot(), restoreBattle(snap, {pack})
//   battle.viewFor(side)   -> the state as one side may see it (no foe hidden info)
//   replay({...choiceLog}) -> reproduces events + hash from (seed, teams, choices)
//   encodeChoice / decodeChoice, stepBattle(snapshot, choices, {pack})

import { canonicalJSON, fnv1a32, hiddenPower } from './stats.js';
import { battleStats, effectiveIvs, battleLevel, resolveRuleset, validateTeam, DEFAULT_RULESET_ID } from './rules.js';
import {
  T, CAT, ST, WX, E, EFFECTS, ENGINE_VERSION, MECHANICS, compileData, EngineError, TN, PW,
} from './engine_data.js';
import { GRAVITY_BAN } from './engine_exec.js';
import { idiv, fractionOf, typeProduct } from './engine_calc.js';
import { validatePack, validateRec, validateSnapshot, packFingerprint } from './engine_validate.js';
import { ABILITIES } from './engine_abilities.js';
import { ITEMS_BY_HOLD, ITEMS_BY_NAME } from './engine_items.js';
import { MOVE_KINDS } from './engine_moves.js';
import { execMethods } from './engine_exec.js';
import { engineSupport } from './engine_support.js';

export { MECHANICS, ENGINE_VERSION, E, EngineError };

export const REQUEST_PHASES = Object.freeze(['preview', 'move', 'switch', 'wait', 'end']);
export const CHOICE_KINDS = Object.freeze(['move', 'switch', 'preview', 'forfeit']);
export const STRUGGLE_SLOT = 4;
// Every event `t` the engine can emit (tools/pokemonarena_engine_test.mjs fails if a fuzzed battle emits a code that is not listed).
export const EVENT_CODES = Object.freeze([
  'start', 'preview', 'turn', 'switch-in', 'switch-out', 'move-use', 'miss', 'avoid', 'fail', 'immune', 'protected', 'cant-move',
  'damage', 'heal', 'crit', 'multi-hit', 'status-set', 'status-clear', 'volatile', 'volatile-end', 'stat-change', 'stat-fail', 'stats-reset',
  'faint', 'weather', 'weather-end', 'weather-tick', 'hazard', 'hazard-damage', 'hazard-clear', 'screen', 'screen-end', 'field',
  'ability', 'item', 'endure', 'sub-damage', 'sub-break', 'sub-set', 'destiny-bond', 'charge', 'confusion-hit', 'struggle',
  'forced-out', 'protect-break', 'wish', 'future-sight', 'drain', 'recoil', 'type-change', 'forfeit', 'win', 'draw', 'turn-cap',
  'pivot', 'trick', 'copy', 'noop', 'perish', 'pp-drain', 'revive',
]);

// volatile conditions the opponent can see on the field (everything else, e.g. a Choice-item lock or a Flash Fire boost, would reveal hidden info)
const PUBLIC_VOLATILE = new Set(['conf', 'flinch', 'sub', 'seeded', 'taunt', 'enc', 'dis', 'trap', 'ingrain', 'aring', 'curse', 'yawn', 'prot', 'endure',
  'fe', 'sinv', 'chg', 'rch', 'ramp', 'mag', 'smack', 'fore', 'meanlook', 'noesc', 'roost', 'ty', 'inf']);


// ---------------------------------------------------------------------------------------------
// hashing and choice encoding
// ---------------------------------------------------------------------------------------------

/** 64-bit state hash as 16 hex chars: two independent FNV-1a 32-bit passes (different basis and prime). */
export function hash64(str) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + 0x9e), 0x85ebca6b) >>> 0;
    b = (b ^ (b >>> 13)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Encode a choice into an unsigned 16-bit integer. Layout: bits 0-1 kind (0 move, 1 switch, 2 preview, 3 forfeit);
 *  move/switch: slot in bits 2-4 (move slot 0..3, 4 = Struggle; switch slot 0..5); preview: bits 2-3 = k-1, then k 3-bit team
 *  indexes from bit 4. Returns -1 for something that is not a valid choice. */
export function encodeChoice(c) {
  if (!c || typeof c !== 'object') return -1;
  if (c.kind === 'forfeit') return 3;
  if (c.kind === 'move') return Number.isInteger(c.slot) && c.slot >= 0 && c.slot <= 4 ? (c.slot << 2) : -1;
  if (c.kind === 'switch') return Number.isInteger(c.slot) && c.slot >= 0 && c.slot <= 5 ? (c.slot << 2) | 1 : -1;
  if (c.kind === 'preview') {
    const o = c.order;
    if (!Array.isArray(o) || o.length < 1 || o.length > E.pickMax) return -1;
    let v = 2 | ((o.length - 1) << 2);
    for (let i = 0; i < o.length; i++) { if (!Number.isInteger(o[i]) || o[i] < 0 || o[i] > 5) return -1; v |= o[i] << (4 + 3 * i); }
    return v;
  }
  return -1;
}
/** Inverse of encodeChoice; null when the integer is not a canonical encoding. */
export function decodeChoice(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
  const k = v & 3;
  if (k === 3) return v === 3 ? { kind: 'forfeit' } : null;
  if (k === 0 || k === 1) {
    if (v >> 5) return null;
    const slot = (v >> 2) & 7;
    if (k === 0) return slot <= 4 ? { kind: 'move', slot } : null;
    return slot <= 5 ? { kind: 'switch', slot } : null;
  }
  const n = ((v >> 2) & 3) + 1;
  const order = [];
  for (let i = 0; i < n; i++) order.push((v >> (4 + 3 * i)) & 7);
  const c = { kind: 'preview', order };
  return encodeChoice(c) === v ? c : null;
}

// ---------------------------------------------------------------------------------------------
// team construction
// ---------------------------------------------------------------------------------------------

function normalizeRec(rec) {
  const out = {
    species: rec.species, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot,
    item: rec.item !== undefined ? rec.item : rec.heldItem !== undefined ? rec.heldItem : 0,
    moves: rec.moves, nickname: rec.nickname || '',
  };
  out.moves = (rec.moves || []).map((m) => (typeof m === 'number' ? { id: m, ppUps: 0 } : { id: m.id, ppUps: m.ppUps || 0 }));
  if (rec.gender === 'M' || rec.gender === 'F' || rec.gender === '-') out.gender = rec.gender;
  const evs = rec.evs !== undefined ? rec.evs : rec.ev;
  if (evs !== undefined) out.evs = evs;
  if (rec.points !== undefined) out.points = rec.points;
  const ivs = rec.ivs !== undefined ? rec.ivs : rec.iv;
  if (ivs !== undefined) {
    if (typeof ivs === 'number') { out.ivs = { hp: ivs, atk: ivs, def: ivs, spa: ivs, spd: ivs, spe: ivs }; } else out.ivs = ivs;
  }
  return out;
}

/** The innate ability ids that are ACTIVE at a battle level: slot k works from E.innateLevels[k] (MEASURED: 75 / 85 / 95). */
export function activeInnates(innates, level) {
  const out = [];
  if (innates) for (let k = 0; k < innates.length && k < E.innateLevels.length; k++) if (innates[k] && level >= E.innateLevels[k]) out.push(innates[k]);
  return out;
}

function makeMon(pack, R, recIn, side, slot, orig) {
  const rec = normalizeRec(recIn);
  const sp = pack.species[rec.species];
  const stats = battleStats(rec, pack, R);
  const ivs = effectiveIvs(rec, R);
  const hp = hiddenPower(ivs, { fixedPower: 60 });
  const types = sp.types[0] === sp.types[1] ? [sp.types[0]] : [sp.types[0], sp.types[1]];
  const mv = rec.moves.map((m) => {
    const base = pack.moves[m.id].pp;
    const mx = base + idiv(base * m.ppUps, 5);
    return { id: m.id, pp: mx, mx };
  });
  const level = battleLevel(rec, R);
  // innate abilities: slot k of the species record works once the battle level reaches E.innateLevels[k] (MEASURED); omitted when none is active
  const inn = activeInnates(sp.innates, level);
  const mon = {
    slot, side, orig, sp: rec.species, name: rec.nickname || sp.name, level,
    ty: types, hp: stats.hp, mhp: stats.hp,
    st: { atk: stats.atk, def: stats.def, spa: stats.spa, spd: stats.spd, spe: stats.spe },
    ab: sp.abilities[rec.abilitySlot] || 0, it: rec.item || 0, used: 0,
    mv, s: 0, sc: 0, hpt: hp.typeId, wt: sp.weight, fnt: 0,
    sg: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 },
    v: {}, rev: { a: 0, i: 0, m: [] },
  };
  if (inn.length) mon.inn = inn;
  // gender (round 3): 0 male, 1 female, 2 none.  The species' ratio byte fixes the one-gender and genderless species; a two-gender species takes the record's gender and is male by default.
  // Omitted when male, so a battle that never reads gender keeps its old state and digest.
  const ratio = sp.genderRatio;
  const g = ratio === 255 ? 2 : ratio === 254 ? 1 : ratio === 0 ? 0 : rec.gender === 'F' ? 1 : rec.gender === '-' ? 0 : 0;
  if (g !== 0) mon.g = g;
  return mon;
}

function makeSide(name, mons) {
  return {
    name, team: mons, act: 0, ch: null,
    hz: { sp: 0, ts: 0, sr: 0, sw: 0 }, reflect: 0, light: 0, veil: 0, sg: 0, tw: 0, mist: 0, luckyChant: 0, wish: null, fut: null,
    nfaint: 0, lastFaint: -1, picked: 0,
  };
}

/** Read a caller-supplied choice ONCE into a private plain object; null when it is not a choice (or reading it throws). */
function readChoice(x) {
  try {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) return null;
    const kind = x.kind;
    if (typeof kind !== 'string' || CHOICE_KINDS.indexOf(kind) < 0) return null;
    if (kind === 'forfeit') return { kind };
    if (kind === 'preview') {
      const o = x.order;
      if (!Array.isArray(o) || o.length > 16) return { kind, order: null };
      const order = [];
      for (let i = 0; i < o.length; i++) order.push(o[i]);
      return { kind, order };
    }
    return { kind, slot: x.slot };
  } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------------------------
// the battle
// ---------------------------------------------------------------------------------------------

export class Battle {
  constructor(s, pack, ruleset, events, choiceLog) {
    this.s = s;
    this.pack = pack;
    this.ruleset = ruleset;
    this.D = compileData(pack);
    this.events = events || [];
    this.choiceLog = choiceLog || [];
    this.mark = 0;
    this.abH = Object.create(null);
    this.ngId = this.D.abilityByName['Neutralizing Gas'];
    this.berries = new Set(pack.items.filter((it) => it && /Berry$/.test(it.name)).map((it) => it.id));
    this.itH = Object.create(null);
    for (const a of pack.abilities) { const h = ABILITIES[a.name]; if (h && !(a.id in this.abH) && (this.D.abilityByName[a.name] === a.id || h.multi)) this.abH[a.id] = h; }
    for (const it of pack.items) {
      if (this.D.itemByName[it.name] !== it.id) continue;
      const byName = ITEMS_BY_NAME[it.name];
      const byHold = it.holdEffect ? ITEMS_BY_HOLD[it.holdEffect] : undefined;
      const h = byName || byHold;
      if (h) this.itH[it.id] = h;
    }
  }

  /** Moves Metronome may call: every supported move except the ban list, ascending id. */
  callablePool() {
    if (!this._pool) {
      const ban = this.D.named.metronomeBan;
      this._pool = engineSupport(this.pack).moveList.filter((id) => !ban.has(id));
    }
    return this._pool;
  }
  get winner() { return this.s.winner; }
  get turn() { return this.s.turn; }

  // ---- start
  startBattle() {
    const S = this.s;
    this.emit({
      t: 'start', names: [S.sides[0].name, S.sides[1].name], sizes: [S.sides[0].team.length, S.sides[1].team.length], pick: S.pick, rules: S.ruleset,
    });
    if (S.pick) { S.phase = 'preview'; S.need = [true, true]; return; }
    this.beginLeads();
  }
  beginLeads() {
    const S = this.s;
    for (let sd = 0; sd < 2; sd++) this.doSwitch(sd, 0, { defer: true, lead: true });
    this.runEntries([0, 1]);
    this.checkWinner();
    if (S.phase !== 'end') this.startTurn();
  }
  startTurn() {
    const S = this.s;
    if (S.turn >= E.turnCap) {
      this.emit({ t: 'turn-cap', n: S.turn });
      this.finish(-1);
      return;
    }
    S.turn++;
    S.phase = 'move';
    S.reason = '';
    this.emit({ t: 'turn', n: S.turn });
    S.need = [true, true];
    for (let sd = 0; sd < 2; sd++) {
      const m = this.act(sd);
      S.sides[sd].ch = null;
      if (m.hp > 0) {
        delete m.v.moved; delete m.v.hit; delete m.v.hitCat; delete m.v.hitAmt; delete m.v.hitFrom;
        if (m.v.rch || m.v.chg || m.v.ramp) { S.sides[sd].ch = { kind: 'auto' }; S.need[sd] = false; }
        m.v.turns = (m.v.turns || 0) + 1;
      }
    }
  }
  finish(winner) {
    const S = this.s;
    S.winner = winner;
    S.phase = 'end';
    S.need = [false, false];
    if (winner === -1) this.emit({ t: 'draw' });
    else this.emit({ t: 'win', s: winner });
  }
  checkWinner() {
    const S = this.s;
    if (S.phase === 'end') return true;
    const a0 = this.aliveCount(0), a1 = this.aliveCount(1);
    if (a0 === 0 && a1 === 0) { this.finish(-1); return true; }
    if (a0 === 0) { this.finish(1); return true; }
    if (a1 === 0) { this.finish(0); return true; }
    return false;
  }

  // ---- switching
  doSwitch(side, slot, o) {
    o = o || {};
    const S = this.s, sd = S.sides[side];
    const old = sd.team[sd.act];
    if (!o.lead && old && old.hp > 0) {
      const f = this.abFn(old, 'onOut'); if (f) f(this, old);
      this.emit({ t: 'switch-out', s: side, m: old.slot });
    }
    if (!o.lead) { const fo = this.act(side ^ 1); if (fo && fo.v.meanlook) delete fo.v.meanlook; }
    if (old && !o.lead) { old.v = {}; if (old.tf) this.untransform(old); old.sg = { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 }; }
    sd.act = slot;
    const mon = sd.team[slot];
    mon.v = {};
    if (S.bp && S.bp.s === side) { mon.v = Object.assign({}, S.bp.v); for (const k of ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']) mon.sg[k] = 0; /* set again just below */ }
    { const fo = this.act(side ^ 1); if (fo && this.abFn(fo, 'stakeout')) mon.v.swt = S.turn; }
    mon.sg = S.bp && S.bp.s === side ? { atk: S.bp.g[0], def: S.bp.g[1], spa: S.bp.g[2], spd: S.bp.g[3], spe: S.bp.g[4], acc: S.bp.g[5], eva: S.bp.g[6] } : { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 };
    if (S.bp && S.bp.s === side) delete S.bp;
    if (!o.lead && old && old.ty) { /* nothing */ }
    if (this.s.pw) this.checkPrimal();
    this.emit({ t: 'switch-in', s: side, m: slot, sp: mon.sp, name: mon.name, lv: mon.level, hp: mon.hp, max: mon.mhp, st: mon.s, orig: mon.orig });
    if (!o.defer) this.runEntries([side]);
  }
  /** Entry effects (hazards, abilities, items) for the listed sides, fastest first. */
  runEntries(sides) {
    // fastest first (slowest first under Trick Room); equal speeds keep side order. No RNG is used here.
    const order = sides.slice();
    if (order.length > 1) {
      const sa = this.speed(this.act(order[0])), sb = this.speed(this.act(order[1]));
      if (sa !== sb && (sb > sa) !== (this.s.tr > 0)) order.reverse();
    }
    for (const sd of order) this.entry(sd);
  }
  entry(side) {
    const S = this.s, sd = S.sides[side], mon = this.act(side);
    if (mon.hp <= 0) return;
    // hazards
    const boots = this.itFn(mon, 'boots');
    if (!boots && !this.abFn(mon, 'magicGuard')) {
      const grounded = this.isGrounded(mon);
      if (sd.hz.sr > 0) {
        const eff = this.typeEff(T.ROCK, mon, null).prod;
        const dmg = fractionOf(mon.mhp * eff, 8 * 4096);
        this.emit({ t: 'hazard-damage', s: side, m: mon.slot, hz: 'rocks' });
        this.dealDamage(mon, dmg, { src: 'stealth-rock', from: -1 });
      }
      if (mon.hp > 0 && grounded && sd.hz.sp > 0) {
        const n = sd.hz.sp;
        this.emit({ t: 'hazard-damage', s: side, m: mon.slot, hz: 'spikes' });
        this.dealDamage(mon, fractionOf(mon.mhp, n === 1 ? 8 : n === 2 ? 6 : 4), { src: 'spikes', from: -1 });
      }
      if (mon.hp > 0 && grounded && sd.hz.ts > 0) {
        if (this.hasType(mon, T.POISON)) { sd.hz.ts = 0; this.emit({ t: 'hazard-clear', s: side, hz: 'tspikes' }); }
        else if (!this.hasType(mon, T.STEEL)) this.setStatus(mon, sd.hz.ts >= 2 ? ST.TOX : ST.PSN, null, { fx: 'toxic-spikes' });
      }
      if (mon.hp > 0 && grounded && sd.hz.sw > 0) this.changeStage(mon, 'spe', -1, 1 - side, {});
    }
    if (sd.hw && mon.hp > 0) {
      const lunar = sd.hw === 2; sd.hw = 0;
      this.emit({ t: 'wish', s: side, m: mon.slot, hw: lunar ? 2 : 1 });
      this.healMon(mon, mon.mhp, { src: 'healing-wish' });
      if (mon.s !== ST.NONE) this.clearStatus(mon, 'healing-wish');
      if (lunar) for (const mvs of mon.mv) mvs.pp = mvs.mx;
    }
    if (mon.hp > 0) {
      const f = this.abFn(mon, 'onStart'); if (f) f(this, mon);
      const it = this.itFn(mon, 'onStart'); if (it && mon.hp > 0) it(this, mon);
    }
    // Eject-style pauses are not modelled.
  }

  // ---- choices and requests
  lockedFor(side) {
    const m = this.act(side);
    return m.hp > 0 && (m.v.rch || m.v.chg || m.v.ramp);
  }
  /** Which move slots are selectable for the side right now. */
  moveOptions(side) {
    const m = this.act(side);
    const out = [];
    let any = false;
    for (let i = 0; i < m.mv.length; i++) {
      const slot = m.mv[i];
      let reason = '';
      if (slot.pp <= 0) reason = 'no-pp';
      else if (m.v.dis && m.v.dis.mv === slot.id) reason = 'disabled';
      else if (m.v.taunt && this.pack.moves[slot.id].category === CAT.STATUS) reason = 'taunt';
      else if (m.v.enc && m.v.enc.mv !== slot.id) reason = 'encore';
      else if (m.v.choice && m.v.choice !== slot.id && (this.itFn(m, 'choiceLock') || this.abFn(m, 'choiceLock'))) reason = 'choice';
      else if (this.itFn(m, 'noStatus') && this.pack.moves[slot.id].category === CAT.STATUS) reason = 'assault-vest';
      else if (this.s.gv > 0 && GRAVITY_BAN.has(this.pack.moves[slot.id].name)) reason = 'gravity';
      else if ((reason = this.blockReason(m, this.pack.moves[slot.id])) !== '') { /* torment, imprison, heal block, throat chop */ }
      if (!reason) any = true;
      out.push({ slot: i, id: slot.id, pp: slot.pp, max: slot.mx, disabled: reason !== '', reason });
    }
    if (!any) {
      const sid = this.D.moveByName.Struggle;
      return { moves: [{ slot: STRUGGLE_SLOT, id: sid, pp: 1, max: 1, disabled: false, reason: '' }], struggle: true };
    }
    return { moves: out, struggle: false };
  }
  canSwitch(side) {
    const m = this.act(side);
    if (m.hp <= 0) return true;
    if (this.s.fl > 0) return false;   // Fairy Lock: nobody can leave next turn
    if (this.itFn(m, 'shedShell')) return true;  // a Shed Shell frees its holder from every kind of trapping
    if (this.hasType(m, T.GHOST)) return true;   // Gen 6+: Ghost types cannot be trapped (moves or abilities)
    if (m.v.trap || m.v.noesc || m.v.ingrain || m.v.meanlook) return false;
    // Shadow Tag / Arena Trap / Magnet Pull
    const foe = this.act(side ^ 1);
    if (foe && foe.hp > 0) {
      const ft = this.abFn(foe, 'traps');
      if (ft && ft(this, foe, m)) return false;
    }
    return true;
  }
  switchOptions(side) {
    const sd = this.s.sides[side];
    const out = [];
    for (let i = 0; i < sd.team.length; i++) {
      const m = sd.team[i];
      if ((this.s.reason === 'revive' && this.s.phase === 'switch' ? m.hp <= 0 : m.hp > 0) && i !== sd.act) out.push({ slot: i, sp: m.sp, name: m.name, hp: m.hp, max: m.mhp, st: m.s, level: m.level });
    }
    return out;
  }
  requests() {
    const S = this.s;
    const out = [];
    for (let side = 0; side < 2; side++) {
      const sd = S.sides[side];
      if (S.phase === 'end') { out.push({ side, phase: 'end', winner: S.winner, canForfeit: false }); continue; }
      // a forfeit is accepted unless the side already made a real choice (or forfeited); a side locked into a charge / recharge /
      // rampage has made no choice and may still forfeit
      const cf = !sd.ch || sd.ch.kind === 'auto' || this.resolvable();
      if (S.phase === 'preview') {
        out.push({
          side, phase: sd.ch ? 'wait' : 'preview', pick: S.pick, canForfeit: cf,
          team: sd.team.map((m, i) => ({ slot: i, sp: m.sp, name: m.name, level: m.level })),
        });
        continue;
      }
      if (!S.need[side] || sd.ch) {
        const m = this.act(side);
        out.push({ side, phase: 'wait', canForfeit: cf, locked: this.lockedFor(side) ? true : false, lockedMove: m.v.chg ? m.v.chg.mv : m.v.ramp ? m.v.ramp.mv : 0 });
        continue;
      }
      if (S.phase === 'switch') {
        out.push({ side, phase: 'switch', reason: S.reason, switches: this.switchOptions(side), canForfeit: cf });
        continue;
      }
      const mo = this.moveOptions(side);
      out.push({
        side, phase: 'move', moves: mo.moves, struggle: mo.struggle, switches: this.canSwitch(side) ? this.switchOptions(side) : [],
        trapped: !this.canSwitch(side), canForfeit: cf,
      });
    }
    return out;
  }
  /**
   * Take a choice. Returns { ok, code }; never throws for a malformed choice (a hostile object is read ONCE into a private copy, so a
   * getter / Proxy cannot change its mind between the check and the use).
   */
  choose(side, choice) {
    const S = this.s;
    if (side !== 0 && side !== 1) return { ok: false, code: 'bad-side' };
    if (S.phase === 'end') return { ok: false, code: 'ended' };
    const c = readChoice(choice);
    if (!c) return { ok: false, code: 'bad-choice' };
    const sd = S.sides[side];
    if (c.kind === 'forfeit') {
      // The choice log has no advance markers, so a forfeit must be unambiguous about what came first: any phase that is already
      // fully chosen resolves BEFORE the forfeit is recorded - exactly what a driver that calls advance() as soon as ready() does,
      // and exactly what replay() does. (The events of that resolution are delivered by the next advance() / drain().)
      while (this.resolvable()) this.step();
      if (S.phase === 'end') return { ok: false, code: 'ended' };
      // a locked side (charge / recharge / rampage) holds an automatic 'choice' and may still forfeit; a real choice (or a forfeit) is final
      if (sd.ch && sd.ch.kind !== 'auto') return { ok: false, code: 'already-chosen' };
      sd.ch = { kind: 'forfeit' };
      this.choiceLog.push({ s: side, c: { kind: 'forfeit' } });
      return { ok: true, code: 'ok' };
    }
    if (sd.ch) return { ok: false, code: 'already-chosen' };
    if (!S.need[side]) return { ok: false, code: 'not-needed' };
    if (S.phase === 'preview') {
      if (c.kind !== 'preview') return { ok: false, code: 'wrong-phase' };
      const o = c.order;
      if (!Array.isArray(o) || o.length !== S.pick) return { ok: false, code: 'bad-order' };
      const seen = {};
      for (const i of o) { if (!Number.isInteger(i) || i < 0 || i >= sd.team.length || seen[i]) return { ok: false, code: 'bad-order' }; seen[i] = 1; }
      sd.ch = { kind: 'preview', order: o.slice() };
      this.choiceLog.push({ s: side, c: { kind: 'preview', order: o.slice() } });
      return { ok: true, code: 'ok' };
    }
    if (c.kind === 'preview') return { ok: false, code: 'wrong-phase' };
    if (c.kind === 'switch') {
      const slot = c.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= sd.team.length) return { ok: false, code: 'bad-slot' };
      if (slot === sd.act) return { ok: false, code: 'active' };
      if (S.phase === 'switch' && S.reason === 'revive') { if (sd.team[slot].hp > 0) return { ok: false, code: 'not-fainted' }; }
      else if (sd.team[slot].hp <= 0) return { ok: false, code: 'fainted' };
      if (S.phase === 'move' && !this.canSwitch(side)) return { ok: false, code: 'trapped' };
      sd.ch = { kind: 'switch', slot };
      this.choiceLog.push({ s: side, c: { kind: 'switch', slot } });
      return { ok: true, code: 'ok' };
    }
    // move
    if (S.phase !== 'move') return { ok: false, code: 'wrong-phase' };
    const slot = c.slot;
    const mo = this.moveOptions(side);
    const entry = mo.moves.find((x) => x.slot === slot);
    if (!entry) return { ok: false, code: 'bad-slot' };
    if (entry.disabled) return { ok: false, code: entry.reason };
    sd.ch = { kind: 'move', slot, mv: entry.id };
    this.choiceLog.push({ s: side, c: { kind: 'move', slot } });
    return { ok: true, code: 'ok' };
  }
  /**
   * A side LEAVES the battle: it closed the page, ran out of time or lost the connection, so it forfeits whatever it had chosen. choose(side, forfeit) cannot
   * do this for a side that is only waiting for the other player (a real choice is final, so it answers 'already-chosen'), and that is exactly the state a
   * player is in during a networked turn. concede() replaces a real choice that has not been resolved yet. Everything already fully chosen resolves first
   * (as for a forfeit), and the unresolved real choice is taken out of the choice log - it never took effect - so replay(choiceLog) still reproduces the
   * live battle. -> { ok, code }.
   */
  concede(side) {
    const S = this.s;
    if (side !== 0 && side !== 1) return { ok: false, code: 'bad-side' };
    while (this.resolvable()) this.step();
    if (S.phase === 'end') return { ok: false, code: 'ended' };
    const sd = S.sides[side];
    if (sd.ch && sd.ch.kind === 'forfeit') return { ok: true, code: 'ok' };
    if (sd.ch && sd.ch.kind !== 'auto') {
      for (let i = this.choiceLog.length - 1; i >= 0; i--) if (this.choiceLog[i].s === side) { this.choiceLog.splice(i, 1); break; }
    }
    sd.ch = { kind: 'forfeit' };
    this.choiceLog.push({ s: side, c: { kind: 'forfeit' } });
    return { ok: true, code: 'ok' };
  }
  /** True when every side that has to choose has chosen, or a side forfeited. */
  ready() {
    const S = this.s;
    if (S.phase === 'end') return false;
    if (this.forfeitPending()) return true;
    for (let sd = 0; sd < 2; sd++) if (S.need[sd] && !S.sides[sd].ch) return false;
    return true;
  }
  /** A forfeit has been chosen and not yet resolved. */
  forfeitPending() {
    const S = this.s;
    return !!((S.sides[0].ch && S.sides[0].ch.kind === 'forfeit') || (S.sides[1].ch && S.sides[1].ch.kind === 'forfeit'));
  }
  /** Ready by real choices only (no forfeit involved): resolving now is unambiguous. */
  resolvable() {
    return this.s.phase !== 'end' && !this.forfeitPending() && this.ready();
  }
  /** Deliver (and mark delivered) every event since the last call. */
  drain() { const out = this.events.slice(this.mark); this.mark = this.events.length; return out; }

  /** Resolve what is ready (a team preview, a faint replacement, a pivot or a whole turn) and then any turns in which no side has a
   *  choice to make (both locked into a charge / recharge / rampage), WITHOUT delivering events. Returns false when nothing was ready. */
  step() {
    const S = this.s;
    if (S.phase === 'end' || !this.ready()) return false;
    const f0 = S.sides[0].ch && S.sides[0].ch.kind === 'forfeit', f1 = S.sides[1].ch && S.sides[1].ch.kind === 'forfeit';
    if (f0 || f1) {
      if (f0) this.emit({ t: 'forfeit', s: 0 });
      if (f1) this.emit({ t: 'forfeit', s: 1 });
      this.finish(f0 && f1 ? -1 : f0 ? 1 : 0);
      S.sides[0].ch = null; S.sides[1].ch = null;
      return true;
    }
    if (S.phase === 'preview') this.applyPreview();
    else if (S.phase === 'switch') this.applySwitchPhase();
    else if (S.phase === 'move') this.resolveTurn();
    // a turn in which neither side has anything to choose runs by itself, so "advance() runs until a choice is needed" holds
    for (let g = 0; g < E.turnCap + 2 && S.phase === 'move' && !S.need[0] && !S.need[1] && S.winner === null; g++) this.resolveTurn();
    return true;
  }
  /** Resolve whatever is ready and return the NEW events (all events since the last advance() / drain()). */
  advance() {
    this.step();
    return this.drain();
  }

  applyPreview() {
    const S = this.s;
    for (let side = 0; side < 2; side++) {
      const sd = S.sides[side];
      const order = sd.ch.order;
      sd.team = order.map((i, pos) => { const m = sd.team[i]; m.slot = pos; return m; });
      sd.ch = null;
      this.emit({ t: 'preview', s: side, order: order.slice() });
    }
    this.beginLeads();
  }
  applySwitchPhase() {
    const S = this.s;
    const reason = S.reason;
    const todo = [];
    for (let side = 0; side < 2; side++) {
      const sd = S.sides[side];
      if (S.need[side] && sd.ch && sd.ch.kind === 'switch') { todo.push(side); }
    }
    if (reason === 'revive') {
      const side = todo[0];
      const sd = S.sides[side];
      const m = sd.team[sd.ch.slot];
      sd.ch = null; S.need = [false, false]; S.pause = -1;
      m.hp = Math.max(1, idiv(m.mhp, 2)); m.fnt = 0; m.s = ST.NONE; m.sc = 0;
      this.emit({ t: 'revive', s: side, m: m.slot });
      this.emit({ t: 'heal', s: side, m: m.slot, from: 0, to: m.hp, max: m.mhp, src: 'revival-blessing' });
      this.continueTurn();
      return;
    }
    if (reason === 'pivot') {
      const side = todo[0];
      const sd = S.sides[side];
      const slot = sd.ch.slot;
      sd.ch = null; S.need = [false, false]; S.pause = -1;
      this.doSwitch(side, slot, {});
      this.checkWinner();
      if (S.phase !== 'end') this.continueTurn();
      return;
    }
    // faint replacements: all chosen simultaneously
    const slots = {};
    for (const side of todo) { slots[side] = S.sides[side].ch.slot; S.sides[side].ch = null; }
    S.need = [false, false];
    for (const side of todo) this.doSwitch(side, slots[side], { defer: true });
    this.runEntries(todo);
    this.checkWinner();
    if (S.phase !== 'end') this.startTurn();
  }

  // ---- turn resolution
  buildAction(side) {
    const S = this.s, sd = S.sides[side], m = this.act(side);
    const ch = sd.ch;
    if (m.hp <= 0) return null;
    const a = { s: side, mi: m.slot, spd: this.speed(m), q: 0 };
    if (ch.kind === 'switch') { a.k = 'switch'; a.slot = ch.slot; a.br = 100; return a; }
    if (m.v.rch) { a.k = 'recharge'; a.br = 0; return a; }
    if (m.v.chg) { a.k = 'move'; a.mv = m.v.chg.mv; a.second = 1; a.br = this.priorityOf(m, this.pack.moves[a.mv]); return a; }
    if (m.v.ramp) { a.k = 'move'; a.mv = m.v.ramp.mv; a.rampage = 1; a.br = this.priorityOf(m, this.pack.moves[a.mv]); return a; }
    a.k = 'move'; a.mv = ch.mv; a.slot = ch.slot;
    if (ch.slot === STRUGGLE_SLOT) a.struggle = 1;
    const mv = this.pack.moves[a.mv];
    a.br = this.priorityOf(m, mv);
    const q = this.itFn(m, 'order');
    if (q) a.q = q(this, m);
    if (this.abFn(m, 'stall')) a.q = -1;
    if (mv.category !== CAT.STATUS && this.abFn(m, 'quickDraw') && this.rand(100) < 30) a.q = a.q < 1 ? 1 : a.q;
    return a;
  }
  resolveTurn() {
    const S = this.s;
    const acts = [];
    for (let side = 0; side < 2; side++) { const a = this.buildAction(side); if (a) acts.push(a); }
    if (acts.length === 2) {
      // Reactive: +1 priority when the foe selected a damaging move that is super effective against this Pokemon
      for (let i = 0; i < 2; i++) {
        const a = acts[i], o = acts[1 - i], m = this.act(a.s);
        if (a.k !== 'move' || o.k !== 'move' || a.second || !this.abFn(m, 'reactive')) continue;
        const omv = this.pack.moves[o.mv], foe = this.act(o.s);
        if (!omv || omv.category === CAT.STATUS || omv.power === 0 || o.struggle) continue;
        if (this.typeEff(omv.type, m, { user: foe }).prod > 4096) a.br += 1;
      }
      // Stygian: +1 priority when the foe is asleep and the move is a damaging one
      for (let i = 0; i < 2; i++) {
        const a = acts[i], o = acts[1 - i], m = this.act(a.s), foe = this.act(o.s);
        if (a.k !== 'move' || a.second || a.struggle || !this.abFn(m, 'stygian') || foe.s !== ST.SLP) continue;
        const mvr = this.pack.moves[a.mv]; if (mvr && mvr.category !== CAT.STATUS) a.br += 1;
      }
    }
    for (let side = 0; side < 2; side++) S.sides[side].ch = null;
    S.need = [false, false];
    const tr = S.tr > 0;
    if (acts.length === 2) {
      const [a, b] = acts;
      let first = null;
      if (a.br !== b.br) first = a.br > b.br ? a : b;
      else if (a.q !== b.q) first = a.q > b.q ? a : b;
      else if (a.spd !== b.spd) first = (a.spd > b.spd) !== tr ? a : b;
      else first = this.rand(2) === 0 ? a : b;
      S.q = first === a ? [a, b] : [b, a];
    } else S.q = acts;
    this.continueTurn();
  }
  /** Run the remaining queued actions; pause for a pivot switch; otherwise finish the turn. */
  continueTurn() {
    const S = this.s;
    while (S.q.length) {
      const a = S.q.shift();
      this.execAction(a);
      if (this.checkWinner()) { S.q = []; return; }
      if (S.pause >= 0) {
        const side = S.pause;
        S.phase = 'switch'; S.reason = S.pk === 'revive' ? 'revive' : 'pivot'; delete S.pk; S.need = [false, false]; S.need[side] = true;
        return;
      }
    }
    this.endOfTurn();
  }
  execAction(a) {
    const S = this.s;
    const mon = this.act(a.s);
    if (a.k === 'switch') {
      if (mon.hp > 0 || true) this.doSwitch(a.s, a.slot, {});
      return;
    }
    if (mon.hp <= 0 || mon.slot !== a.mi) return;
    if (a.k === 'recharge') {
      this.emit({ t: 'cant-move', s: a.s, m: mon.slot, why: 'recharge' });
      delete mon.v.rch;
      return;
    }
    if (!this.canAct(a.s, a)) { return; }
    const mvId = a.struggle ? this.D.moveByName.Struggle : a.mv;
    if (a.second) { delete mon.v.chg; }
    // a normal selected move clears the one-shot lock flags that depend on repeating
    this.useMove(a.s, mvId, { noPP: !!a.struggle || !!a.second || !!a.rampage, second: !!a.second, rampage: !!a.rampage, pri: a.br });
    const fresh = this.act(a.s);
    if (fresh === mon && mon.hp > 0) this.afterMove(a, mon);
    // Dancer: the foe copies a dance move right after it is used; Momentum: Speed rises after a priority move
    { const mvr = this.pack.moves[mvId]; const o = this.act(a.s ^ 1); if (mvr && mvr.flags.dance && !a.second && o && o.hp > 0 && fresh === mon && this.abFn(o, 'dancer')) { this.emit({ t: 'ability', s: o.side, m: o.slot, ab: o.ab, fx: 'dancer' }); this.useMove(a.s ^ 1, mvId, { noPP: true, called: true }); } }
    if (a.br > 0 && fresh === mon && mon.hp > 0) { const ap = this.abFn(mon, 'afterPriority'); if (ap) ap(this, mon); }
  }
  afterMove(a, mon) {
    // rampage countdown
    if (mon.v.ramp && mon.v.ramp.mv === a.mv) {
      if (a.rampage) {
        mon.v.ramp.t -= 1;
        if (mon.v.ramp.t <= 0) { const quiet = mon.v.ramp.up || mon.v.ramp.nc; delete mon.v.ramp; if (!quiet && !this.abFn(mon, 'noFatigue')) this.confuse(mon, null, { silent: true }); }
      }
    }
    // Choice item lock
    if (this.itFn(mon, 'choiceLock') && !mon.v.choice) mon.v.choice = a.struggle ? 0 : a.mv;
    if (mon.v.choice === 0) delete mon.v.choice;
    // Protect streak resets when a non-protect move is used
    const ef = EFFECTS[this.pack.moves[a.mv] ? this.pack.moves[a.mv].effect : 0];
    if (ef && ef.kind !== 'protect' && ef.kind !== 'endure') mon.v.pstreak = 0;
  }
  /** Pre-move gates: recharge handled elsewhere. Returns false (with an event) if the mon cannot act. */
  canAct(side, a) {
    const m = this.act(side);
    const mv = this.pack.moves[a.mv];
    if (m.v.held) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'sky-drop' }); return false; }   // MEASURED: a Pokemon lifted by Sky Drop loses its action until it is dropped
    if (m.s === ST.SLP && this.uproarOn()) this.clearStatus(m, 'wake');
    if (m.s === ST.SLP) {
      // sc = number of move attempts still lost to sleep; at 0 the mon wakes and acts this turn
      if (m.sc > 0) {
        m.sc -= 1;
        if (!(mv && (mv.effect === 73 || mv.effect === 69))) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'slp' }); return false; }
      } else this.clearStatus(m, 'wake');
    }
    if (m.s === ST.FRZ && m.v.fn) { delete m.v.fn; this.clearStatus(m, 'thaw'); this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'frz' }); return false; }   // Frost Nova: frozen for exactly one turn
    if (m.s === ST.FRZ) {
      if (this.rand(E.thawChance) === 0) this.clearStatus(m, 'thaw');
      else if (!this.D.named.thawUser.has(a.mv)) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'frz' }); return false; }
      else this.clearStatus(m, 'thaw');
    }
    if (this.s.gv > 0 && !a.struggle && mv && GRAVITY_BAN.has(mv.name)) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'gravity' }); return false; }
    if (!a.struggle && !a.second && !a.rampage && mv) { const br = this.blockReason(m, mv); if (br) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: br }); return false; } }
    if (m.v.flinch) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'flinch' }); const ff = this.abFn(m, 'onFlinch'); if (ff) ff(this, m); return false; }
    const tf = this.abFn(m, 'truant');
    if (tf && tf(this, m)) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'truant' }); return false; }
    if (!a.struggle && !a.second && !a.rampage) {
      if (m.v.dis && m.v.dis.mv === a.mv) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'disabled' }); return false; }
      if (m.v.taunt && mv.category === CAT.STATUS) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'taunt' }); return false; }
    }
    if (m.v.conf) {
      m.v.conf -= 1;
      if (m.v.conf <= 0) { delete m.v.conf; this.emit({ t: 'volatile-end', s: side, m: m.slot, v: 'confusion' }); }
      else if (this.rand(100) < E.confSelfHitPct) {
        const c = { user: m, target: m, us: side, ts: side, cat: CAT.PHYSICAL, crit: false, roll: this.rand(E.randomRollSpan), type: T.NONE, mv, id: 0, plain: true, effInfo: { prod: 4096, mults: [] }, bp: E.confPower, K: {}, ef: null, o: {}, power: E.confPower };
        const dmg = this.calcDamage(c);
        this.emit({ t: 'confusion-hit', s: side, m: m.slot });
        this.dealDamage(m, dmg, { src: 'confusion', from: -1, move: false });
        return false;
      }
    }
    if (m.s === ST.PAR && this.rand(E.paraFullChance) === 0) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'par' }); return false; }
    if (m.v.inf) {
      this.emit({ t: 'volatile', s: side, m: m.slot, v: 'infatuated' });
      if (this.rand(2) === 1) { this.emit({ t: 'cant-move', s: side, m: m.slot, why: 'love' }); return false; }   // MEASURED: the draw's top bit (>= 32768 of 65536) immobilizes, 60 of 60
    }
    return true;
  }

  // ---- end of turn
  endOfTurn() {
    const S = this.s;
    const order = [0, 1];
    if (this.speed(this.act(1)) > this.speed(this.act(0)) !== (S.tr > 0)) order.reverse();
    this.residual(order);
    if (this.checkWinner()) return;
    // timers that tick once per turn
    this.tickFields();
    for (let side = 0; side < 2; side++) {
      const m = this.act(side);
      if (m.hp > 0) this.tickVolatiles(m);
      if (m.hp > 0) { delete m.v.flinch; delete m.v.prot; delete m.v.powder; delete m.v.endure; delete m.v.hit; delete m.v.roost; delete m.v.mcoat; delete m.v.snatch; }
      S.sides[side].ch = null;
    }
    if (this.checkWinner()) return;   // a perish count or Salt Cure can take the last Pokemon after the residual check
    // who needs a replacement?
    const need = [false, false];
    for (let side = 0; side < 2; side++) if (this.act(side).hp <= 0 && this.aliveCount(side) > 0) need[side] = true;
    if (need[0] || need[1]) {
      S.phase = 'switch'; S.reason = 'faint'; S.need = need;
      return;
    }
    this.startTurn();
  }
  residual(order) {
    const S = this.s;
    const each = (fn) => { for (const side of order) { const m = this.act(side); if (m.hp > 0) fn(m, side); } };
    // weather
    // ROM order (measured, ROMDIFF.md): the weather counter drops first; on the turn it reaches 0 the weather ends and does NOT damage
    if (S.wx[0] !== WX.NONE && !S.pw) {
      S.wx[1] -= 1;
      if (S.wx[1] <= 0) { const w0 = S.wx[0]; S.wx = [WX.NONE, 0]; this.emit({ t: 'weather-end', w: w0 }); }
    }
    const w = this.wx();
    if (S.wx[0] !== WX.NONE || S.pw === PW.WINDS) {   // strong winds keep S.wx at NONE but still print "blow on regardless" every turn (MEASURED)
      this.emit({ t: 'weather-tick', w: S.pw || S.wx[0] });
      if (w === WX.SAND || w === WX.HAIL) {
        each((m) => {
          const immune = (w === WX.SAND && (this.hasType(m, T.ROCK) || this.hasType(m, T.GROUND) || this.hasType(m, T.STEEL))) || (w === WX.HAIL && this.hasType(m, T.ICE))
            || this.abFn(m, 'magicGuard') || this.abFn(m, 'weatherImmune') || this.itFn(m, 'weatherImmune');
          if (!immune) this.dealDamage(m, fractionOf(m.mhp, E.weatherDiv), { src: w === WX.SAND ? 'sandstorm' : 'hail', from: -1 });
        });
      }
    }
    if (this.terrain() === TN.GRASSY) each((m) => { if (m.hp < m.mhp && this.terrainActs(m, TN.GRASSY)) this.healMon(m, fractionOf(m.mhp, 16), { src: 'grassy-terrain' }); });   // MEASURED: 1/16 per turn for every grounded Pokemon, 5 turns
    // future sight / wish
    each((m, side) => {
      const sd = S.sides[side];
      if (sd.wish) { sd.wish.t -= 1; if (sd.wish.t <= 0) { const hp = sd.wish.hp; sd.wish = null; this.emit({ t: 'wish', s: side, m: m.slot }); this.healMon(m, hp, { src: 'wish' }); } }
    });
    for (const side of order) {
      const sd = S.sides[side];
      if (sd.fut) {
        sd.fut.t -= 1;
        if (sd.fut.t <= 0) {
          const f = sd.fut; sd.fut = null;
          const m = this.act(side);
          if (m.hp > 0) {
            this.emit({ t: 'future-sight', s: side, m: m.slot, mv: f.mv });
            const c = this.makeFutureCtx(f, side);
            if (c) { c.roll = this.rand(E.randomRollSpan); c.crit = false; const eff = this.typeEff(c.type, m, c); c.effInfo = eff; c.eff = eff.prod; if (eff.prod === 0) this.emit({ t: 'immune', s: side, m: m.slot, why: 'type', mv: f.mv }); else { const dmg = this.calcDamage(c); this.dealDamage(m, dmg, { move: false, src: 'future-sight', from: f.from, mv: f.mv, eff: eff.prod, bypassSub: true }); } }
          }
        }
      }
    }
    // abilities then items
    each((m) => {
      const af = this.abFn(m, 'residual'); if (af) af(this, m);
    });
    each((m) => {
      const f = this.itFn(m, 'residual'); if (f) f(this, m);
      const g = m.hp > 0 ? this.itFn(m, 'onHp') : null; if (g) g(this, m);
    });
    // leech seed, status, trap, ingrain, aqua ring
    each((m, side) => {
      if (m.v.seeded !== undefined && m.v.seeded >= 0) {
        const src = this.act(m.v.seeded);
        if (!this.abFn(m, 'magicGuard')) {
          const dmg = this.dealDamage(m, fractionOf(m.mhp, E.leechDiv), { src: 'leech-seed', from: -1 });
          if (src && src.hp > 0 && dmg > 0) {
            if (this.abFn(m, 'liquidOoze', true)) this.dealDamage(src, dmg, { src: 'liquid-ooze', from: -1 });
            else this.healMon(src, this.itFn(src, 'bigRoot') ? idiv(dmg * 130, 100) : dmg, { src: 'leech-seed' });
          }
        }
      }
    });
    each((m) => {
      if (m.hp <= 0) return;
      if (this.abFn(m, 'magicGuard')) return;
      if (m.s === ST.BRN) this.dealDamage(m, fractionOf(m.mhp, E.burnDiv), { src: 'brn', from: -1 });
      if (m.s === ST.FBT) this.dealDamage(m, fractionOf(m.mhp, E.burnDiv), { src: 'fbt', from: -1 });   // MEASURED: 1/16 per turn
      else if (m.s === ST.PSN || m.s === ST.TOX) {
        const ph = this.abFn(m, 'poisonHeal');
        if (ph) { this.healMon(m, fractionOf(m.mhp, 8), { src: 'poison-heal' }); this.reveal(m, 'a'); }
        else if (m.s === ST.PSN) this.dealDamage(m, fractionOf(m.mhp, E.psnDiv), { src: 'psn', from: -1 });
        else { const n = m.sc < 15 ? m.sc : 15; this.dealDamage(m, fractionOf(m.mhp, E.toxDiv) * n, { src: 'tox', from: -1 }); if (m.hp > 0) m.sc += 1; }
      }
    });
    each((m) => {
      const f = m.hp > 0 ? this.itFn(m, 'lateResidual') : null; if (f) f(this, m);
    });
    each((m) => {
      if (m.v.trap && !this.abFn(m, 'magicGuard')) {
        const tr = m.v.trap;
        tr.t -= 1;
        if (tr.t < 0) { delete m.v.trap; this.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'trap' }); }
        else { const tsrc = this.act(tr.src); this.dealDamage(m, fractionOf(m.mhp, tsrc && tsrc.hp > 0 && this.itFn(tsrc, 'bindBand') ? 6 : E.trapDiv), { src: 'trap', from: -1 }); }
      } else if (m.v.trap) { m.v.trap.t -= 1; if (m.v.trap.t < 0) delete m.v.trap; }
      if (m.hp > 0 && m.v.curse && !this.abFn(m, 'magicGuard')) this.dealDamage(m, fractionOf(m.mhp, 4), { src: 'curse', from: -1 });
      if (m.hp > 0 && m.v.ingrain) this.healMon(m, fractionOf(m.mhp, 16), { src: 'ingrain' });
      if (m.hp > 0 && m.v.aring) this.healMon(m, fractionOf(m.mhp, 16), { src: 'aqua-ring' });
      if (m.hp > 0 && m.v.nm) { if (m.s === ST.SLP) { if (!this.abFn(m, 'magicGuard')) this.dealDamage(m, fractionOf(m.mhp, 4), { src: 'nightmare', from: -1 }); } else delete m.v.nm; }
      if (m.hp > 0 && m.v.yawn) { m.v.yawn -= 1; if (m.v.yawn <= 0) { delete m.v.yawn; this.setStatus(m, ST.SLP, null, { fx: 'yawn' }); } }
      if (m.hp > 0 && m.v.taunt) { m.v.taunt -= 1; if (m.v.taunt <= 0) { delete m.v.taunt; this.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'taunt' }); } }
      if (m.hp > 0 && m.v.enc) { m.v.enc.t -= 1; if (m.v.enc.t <= 0) { delete m.v.enc; this.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'encore' }); } }
      if (m.hp > 0 && m.v.dis) { m.v.dis.t -= 1; if (m.v.dis.t <= 0) { delete m.v.dis; this.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'disable' }); } }
      if (m.hp > 0 && m.v.mag) { m.v.mag -= 1; if (m.v.mag <= 0) { delete m.v.mag; this.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'magnet-rise' }); } }
    });
  }
  tickFields() {
    const S = this.s;
    for (let side = 0; side < 2; side++) {
      const sd = S.sides[side];
      for (const k of ['reflect', 'light', 'veil', 'sg', 'tw', 'mist', 'luckyChant']) {
        if (sd[k] > 0) { sd[k] -= 1; if (sd[k] === 0) this.emit({ t: 'screen-end', s: side, k }); }
      }
    }
    if (S.tr > 0) { S.tr -= 1; if (S.tr === 0) this.emit({ t: 'field', k: 'trick-room', on: 0 }); }
    for (const k of ['ms', 'ws', 'wr', 'mr', 'fl']) if (S[k] > 0) { S[k] -= 1; if (S[k] === 0) { delete S[k]; this.emit({ t: 'field', k: { ms: 'mud-sport', ws: 'water-sport', wr: 'wonder-room', mr: 'magic-room', fl: 'fairy-lock' }[k], on: 0 }); } }
    delete S.ion;
    if (S.tn) { S.tn[1] -= 1; if (S.tn[1] <= 0) this.clearTerrain(); }
    if (S.gv > 0) { S.gv -= 1; if (S.gv === 0) { delete S.gv; this.emit({ t: 'field', k: 'gravity', on: 0 }); } }
  }

  /** A primal weather (MEASURED): replaces any weather, cannot be replaced by an ordinary weather move or ability, lasts until no Pokemon on the field has the ability. */
  setPrimal(id, srcMon) {
    const S = this.s;
    if (S.pw === id) return false;
    S.pw = id;
    S.wx = id === PW.RAIN ? [WX.RAIN, 16] : id === PW.SUN ? [WX.SUN, 16] : [WX.NONE, 0];
    this.emit({ t: 'weather', w: id, s: srcMon ? srcMon.side : -1 });
    for (let sd = 0; sd < 2; sd++) { const m = this.act(sd); if (m && m.hp > 0) { const f = this.abFn(m, 'onWeather'); if (f) f(this, m, id === PW.RAIN ? WX.RAIN : id === PW.SUN ? WX.SUN : WX.NONE); } }
    return true;
  }
  /** The primal weather ends the moment no Pokemon on the field has its ability. */
  checkPrimal() {
    const S = this.s;
    if (!S.pw) return;
    const name = S.pw === PW.RAIN ? 'Primordial Sea' : S.pw === PW.SUN ? 'Desolate Land' : 'Delta Stream';
    for (let sd = 0; sd < 2; sd++) {
      const m = this.act(sd);
      if (m && m.hp > 0 && this.hasAbility(m, name)) return;
    }
    const w0 = S.pw; delete S.pw; S.wx = [WX.NONE, 0];
    this.emit({ t: 'weather-end', w: w0 });
  }

  /** Per-Pokemon end-of-turn ticks of the round 3 volatiles. */
  tickVolatiles(m) {
    const v = m.v;
    if (v.salt && !this.abFn(m, 'magicGuard')) this.dealDamage(m, fractionOf(m.mhp, this.hasType(m, T.STEEL) || this.hasType(m, T.WATER) ? 4 : 8), { src: 'salt-cure', from: -1 });
    if (v.syrup > 0 && m.hp > 0) this.changeStage(m, 'spe', -1, -1, {});
    for (const [k, name] of [['hb', 'heal-block'], ['emb', 'embargo'], ['tc', 'throat-chop'], ['tele', 'telekinesis'], ['syrup', 'syrup-bomb']]) {
      if (v[k] > 0) { v[k] -= 1; if (v[k] <= 0) { delete v[k]; this.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: name }); } }
    }
    if (v.lf > 0) { v.lf -= 1; if (v.lf <= 0) delete v.lf; }
    if (v.held) { const o = this.act(m.side ^ 1); const sd = this.D.moveByName['Sky Drop']; if (!(o && o.hp > 0 && o.v.chg && o.v.chg.mv === sd)) delete v.held; }   // the lifter is gone: the hold ends
    if (v.cud && m.hp > 0 && v.cud[1] < this.s.turn) { const it = v.cud[0]; delete v.cud; this.emit({ t: 'ability', s: m.side, m: m.slot, ab: m.ab, fx: 'cud-chew' }); this.eatBerry(m, it); }
    if (v.perish > 0) {
      v.perish -= 1;
      this.emit({ t: 'perish', s: m.side, m: m.slot, n: v.perish });
      if (v.perish === 0) { delete v.perish; this.dealDamage(m, m.hp, { src: 'perish', from: -1 }); }
    }
  }

  setWeather(w, srcMon) {
    const S = this.s;
    if (S.pw) return false;
    if (S.wx[0] === w) return false;
    let turns = E.weatherTurns;
    if (srcMon) { const f = this.itFn(srcMon, 'extends'); if (f && f(this, srcMon, w)) turns = E.extenderTurns; }
    S.wx = [w, turns];
    this.emit({ t: 'weather', w, s: srcMon ? srcMon.side : -1 });
    // forecast-style abilities react
    for (let sd = 0; sd < 2; sd++) { const m = this.act(sd); if (m && m.hp > 0) { const f = this.abFn(m, 'onWeather'); if (f) f(this, m, w); } }
    return true;
  }

  makeFutureCtx(f, side) {
    const mv = this.pack.moves[f.mv];
    const ef = EFFECTS[mv.effect];
    const K = MOVE_KINDS[ef.kind];
    const target = this.act(side);
    const userStub = { level: f.level, st: f.st, sg: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 }, v: {}, ty: f.ty, s: 0, hp: 1, mhp: 1, side: f.from, slot: -1, ab: 0, it: 0 };
    return {
      b: this, us: f.from, ts: side, user: userStub, target, mv, id: mv.id, ef, K: { dmg: true }, type: mv.type, cat: mv.category, power: mv.power,
      crit: false, roll: 0, hit: 0, nhits: 1, o: {}, extra: {}, noBurnCut: true,
    };
  }

  // ---- views and persistence
  monView(m, own) {
    const base = {
      slot: m.slot, sp: m.sp, name: m.name, level: m.level, st: m.s, fnt: m.fnt, ty: m.ty.slice(),
      hp: own ? m.hp : undefined, max: own ? m.mhp : undefined,
    };
    if (own) {
      base.stats = { ...m.st };
      base.ab = m.ab; base.it = m.it;
      base.inn = m.inn ? m.inn.slice() : [];
      base.mv = m.mv.map((x) => ({ id: x.id, pp: x.pp, mx: x.mx }));
    } else {
      base.hpPct = m.mhp > 0 ? idiv(m.hp * 100, m.mhp) + (m.hp > 0 && idiv(m.hp * 100, m.mhp) === 0 ? 1 : 0) : 0;
      base.revealed = { ab: m.rev.a ? m.ab : null, it: m.rev.i ? (m.it || m.used) : null, mv: m.rev.m.slice(), inn: m.rev.n ? m.rev.n.slice() : [] };
    }
    return base;
  }
  viewFor(side) {
    const S = this.s;
    const foe = side ^ 1;
    const mine = S.sides[side], theirs = S.sides[foe];
    const act = (m, own) => { const v = this.monView(m, own); v.stages = { ...m.sg }; v.vol = Object.keys(m.v).sort().filter((k) => own || PUBLIC_VOLATILE.has(k)); return v; };
    return {
      turn: S.turn, phase: S.phase, winner: S.winner, weather: { id: S.pw || S.wx[0], turns: S.wx[1] }, ...(S.tn ? { terrain: { id: S.tn[0], turns: S.tn[1] } } : {}), ...(S.gv > 0 ? { gravity: S.gv } : {}), trickRoom: S.tr,
      you: {
        side, name: mine.name, active: mine.act, team: mine.team.map((m) => this.monView(m, true)),
        hazards: { ...mine.hz }, reflect: mine.reflect, light: mine.light, veil: mine.veil, safeguard: mine.sg, tailwind: mine.tw,
        activeDetail: act(mine.team[mine.act], true),
      },
      foe: {
        side: foe, name: theirs.name, active: theirs.act, remaining: this.aliveCount(foe), size: theirs.team.length,
        team: theirs.team.map((m, i) => (S.phase === 'preview' || i === theirs.act || m.hp <= 0 || m.rev.m.length || m.rev.a || m.rev.i || m.v.moved !== undefined ? this.monView(m, false) : { slot: m.slot, hidden: 1, fnt: m.fnt })),
        hazards: { ...theirs.hz }, reflect: theirs.reflect, light: theirs.light, veil: theirs.veil, safeguard: theirs.sg, tailwind: theirs.tw,
        activeDetail: act(theirs.team[theirs.act], false),
      },
    };
  }
  /** Plain JSON copy of the whole battle (state + events + choice log). */
  snapshot() {
    return JSON.parse(JSON.stringify({
      v: ENGINE_VERSION, s: this.s, events: this.events, mark: this.mark, log: this.choiceLog,
      packId: this.pack.rom ? this.pack.rom.sha256 || null : null, packFp: packFingerprint(this.pack, hash64), ruleset: this.s.ruleset,
      hash: this.hash(),
    }));
  }
  /** 64-bit digest (16 hex) of the canonical JSON of the full battle state. */
  hash() { return hash64(canonicalJSON(this.s)); }
  logHash() { return hash64(canonicalJSON(this.events)); }
  /** A private copy of this battle for what-if computations: same pack and handler tables, its own deep copy of the state, no event
   *  log, and an RNG that THROWS (a preview must never consume or reveal a random number). Nothing done to it reaches this battle. */
  scratch() {
    const sb = Object.create(this);
    sb.s = JSON.parse(JSON.stringify(this.s));
    sb.events = [];
    sb.choiceLog = [];
    sb.mark = 0;
    sb.rand = () => { throw new EngineError('previewDamage tried to draw a random number', null, 'preview-rng'); };
    return sb;
  }
  /**
   * Damage side `side`'s ACTIVE Pokemon would deal to the foe's active Pokemon with `moveId` (one hit): previewDamage(side, moveId,
   * { roll: 0..15 (0 = max, 15 = min), crit }). A pure function of the battle: it changes no state, writes no event and draws no random
   * number (it runs on a private copy). Random-power moves use their expected power (Present 65, Magnitude 71, Psywave = level), fixed-damage moves
   * their fixed value, OHKO moves the target's HP; status moves, and any move when it is team preview, return 0. Multi-hit moves return ONE hit.
   * NOTE: this uses the real stats of both sides (full information) - an AI that must not see hidden info does its own estimate from viewFor().
   */
  previewDamage(side, moveId, o) {
    if (side !== 0 && side !== 1) throw new EngineError('previewDamage: side must be 0 or 1', { side }, 'bad-argument');
    const mv = Number.isInteger(moveId) && moveId > 0 ? this.pack.moves[moveId] : undefined;
    const ef = mv ? EFFECTS[mv.effect] : undefined;
    const K = ef ? MOVE_KINDS[ef.kind] : undefined;
    if (!mv || !ef || !K) throw new EngineError('previewDamage: ' + String(moveId) + ' is not a move the engine can run', { moveId }, 'bad-argument');
    o = o || {};
    const roll = Number.isInteger(o.roll) && o.roll >= 0 && o.roll <= 15 ? o.roll : 0;
    if (this.s.phase === 'preview' || !K.dmg) return 0;
    const sb = this.scratch();
    const user = sb.act(side), target = sb.act(side ^ 1);
    if (user.hp <= 0 || target.hp <= 0) return 0;
    const c = sb.makeCtx(side, mv, ef, K, {});
    c.crit = !!o.crit; c.roll = roll;
    const tc = sb.abFn(user, 'moveType');
    if (tc) { const nt = tc(sb, user, c); if (nt !== undefined && nt !== c.type) { c.type = nt.type !== undefined ? nt.type : nt; if (nt.boost) c.typeBoost = nt.boost; } }
    if (K.type) { const nt = K.type(c); if (nt !== undefined) c.type = nt; }
    if (K.cat) { const nc = K.cat(c); if (nc !== undefined) c.cat = nc; }
    if (K.previewPrep) K.previewPrep(c); else if (K.prep) K.prep(c);
    if (c.skip) return 0;
    if (mv.additional.some((a) => a.effect === 97)) { c.bp = 150; sb.setTerrain(TN.PSYCHIC, user); }   // Genesis Supernova, as in the real hit (engine_exec.js runDamage): the live damage groups compare this preview
    let ee = sb.typeEff(c.type, target, c);
    if (c.flyingPress) { const e2 = sb.typeEff(T.FLYING, target, c); ee = { prod: typeProduct([ee.prod, e2.prod]), mults: ee.mults }; }
    c.effInfo = ee; c.eff = ee.prod;
    if (ee.prod === 0) return 0;
    if (K.damage) {
      if (K.previewDamage) return K.previewDamage(c);
      const f = K.damage(c);
      return f >= 0 ? f : 0;
    }
    let d = sb.calcDamage(c);
    if (K.survive1 && d >= target.hp) d = target.hp - 1;
    return d;
  }
}
Object.assign(Battle.prototype, execMethods);

// ---------------------------------------------------------------------------------------------
// construction, restore, replay, pure step
// ---------------------------------------------------------------------------------------------

export function createBattle(opts) {
  if (!opts || typeof opts !== 'object') throw new EngineError('createBattle needs an options object { pack, teams, ... }', null, 'bad-argument');
  const pack = opts.pack;
  validatePack(pack);
  let R;
  try {
    const rsId = opts.ruleset || DEFAULT_RULESET_ID;
    R = typeof rsId === 'string' ? resolveRuleset(rsId) : rsId;
  } catch (e) { if (e instanceof EngineError) throw e; throw new EngineError('createBattle: bad ruleset: ' + String((e && e.message) || e), null, 'bad-argument'); }
  const teams = opts.teams;
  if (!Array.isArray(teams) || teams.length !== 2) throw new EngineError('teams must be [teamA, teamB]', null, 'bad-argument');
  const pick = opts.pick || 0;
  if (pick && (!Number.isInteger(pick) || pick < 1 || pick > E.pickMax)) throw new RangeError(`pick must be 1..${E.pickMax}`);
  for (let i = 0; i < 2; i++) {
    const tm = teams[i];
    if (!Array.isArray(tm) || tm.length < 1 || tm.length > 6) throw new EngineError(`team ${i}: 1..6 Pokemon required`, null, 'team-invalid');
    if (pick && tm.length < pick) throw new EngineError(`team ${i}: has fewer than the ${pick} Pokemon to pick`, null, 'team-invalid');
    tm.forEach((rec, j) => validateRec(pack, rec, `team ${i} Pokemon ${j}`));
    if (opts.validate !== false) {
      let v;
      try { v = validateTeam(tm.map((m) => { const n = normalizeRec(m); return { ...n, moves: n.moves.map((x) => x.id) }; }), pack, R); } catch (e) { throw new EngineError(`team ${i} could not be checked: ${String((e && e.message) || e)}`, null, 'team-invalid'); }
      if (!v.ok) throw new EngineError(`team ${i} is not legal under ${R.id}`, v.reasons, 'team-illegal');
    }
  }
  let names;
  try { names = opts.names ? [String(opts.names[0]), String(opts.names[1])] : ['Player 1', 'Player 2']; } catch (_e) { throw new EngineError('names must be two strings', null, 'bad-argument'); }
  let seed;
  try { seed = (opts.seed === undefined ? 1 : opts.seed) >>> 0; } catch (_e) { throw new EngineError('seed must be a number', null, 'bad-argument'); }
  let sides;
  try { sides = teams.map((tm, side) => makeSide(names[side], tm.map((rec, i) => makeMon(pack, R, rec, side, i, i)))); } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError('a Pokemon record could not be built: ' + String((e && e.message) || e), null, 'team-invalid');
  }
  const s = {
    v: ENGINE_VERSION, ruleset: R.id, seed, rng: seed, turn: 0, phase: 'preview', reason: '', need: [false, false], pause: -1, mb: false,
    pick, wx: [WX.NONE, 0], tr: 0, sides, q: [], winner: null,
  };
  const b = new Battle(s, pack, R, [], []);
  b.startBattle();
  return b;
}

/**
 * Rebuild a battle from snapshot(). The snapshot is checked completely (shape, ranges, ids against the pack, cross-field
 * consistency, the engine version, the pack it was made with, and its state hash when present); anything wrong throws an
 * EngineError with a code ('snapshot-invalid' | 'snapshot-version' | 'snapshot-rom') and nothing is built. The input is never aliased.
 */
export function restoreBattle(snap, opts) {
  if (!opts || typeof opts !== 'object' || !opts.pack) throw new EngineError('restoreBattle needs (snapshot, { pack })', null, 'bad-argument');
  const pack = opts.pack;
  validatePack(pack);
  let copy;
  try { copy = JSON.parse(JSON.stringify(snap)); } catch (_e) { throw new EngineError('snapshot is not plain JSON data', null, 'snapshot-invalid'); }
  if (copy === undefined || copy === null || typeof copy !== 'object') throw new EngineError('snapshot rejected: not an object', null, 'snapshot-invalid');
  if (copy.v !== ENGINE_VERSION) throw new EngineError('snapshot version mismatch', { got: copy.v, want: ENGINE_VERSION }, 'snapshot-version');
  validateSnapshot(copy, {
    pack, eventCodes: EVENT_CODES, choiceKinds: CHOICE_KINDS, fingerprint: packFingerprint(pack, hash64), sha: pack.rom ? pack.rom.sha256 || null : null,
  });
  if (copy.hash !== undefined && copy.hash !== hash64(canonicalJSON(copy.s))) throw new EngineError('snapshot rejected: its state hash does not match its state', null, 'snapshot-invalid');
  let R;
  try { R = resolveRuleset(copy.ruleset || copy.s.ruleset); } catch (e) { throw new EngineError('snapshot rejected: unknown ruleset', { ruleset: copy.ruleset }, 'snapshot-invalid'); }
  const b = new Battle(copy.s, pack, R, copy.events || [], copy.log || []);
  b.mark = copy.mark || 0;
  // last line of defence: a state that passed the checks must also be usable
  try { b.requests(); b.viewFor(0); b.viewFor(1); } catch (e) { throw new EngineError('snapshot rejected: the state is inconsistent (' + String((e && e.message) || e) + ')', null, 'snapshot-invalid'); }
  return b;
}

/**
 * Re-run a battle from its inputs. choiceLog = [{s, c}] exactly as battle.choiceLog records it. The log has no "advance" markers, so
 * replay settles the engine the way a driver does: before each choice it advances while the battle is ready (a forfeit is the one
 * exception - a forfeit is resolved by the NEXT advance, so a choice logged after it is still delivered first); battle.choose() itself
 * resolves any fully-chosen phase before it records a forfeit. For every phase mix the result equals the live battle, forfeits included.
 */
export function replay(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.choiceLog)) throw new EngineError('replay needs { pack, teams, seed, choiceLog: [...] }', null, 'bad-argument');
  const b = createBattle({ pack: o.pack, ruleset: o.ruleset, teams: o.teams, seed: o.seed, pick: o.pick, names: o.names, validate: o.validate });
  const settle = () => { while (b.winner === null && !b.forfeitPending() && b.ready()) b.advance(); };
  for (const e of o.choiceLog) {
    if (!e || typeof e !== 'object' || !e.c) throw new EngineError('replay: bad choice log entry', e, 'bad-argument');
    if (e.c.kind !== 'forfeit') settle();
    const r = b.choose(e.s, e.c);
    if (!r.ok) throw new EngineError(`replay: choice rejected (${r.code})`, e, 'replay-rejected');
  }
  while (b.winner === null && b.ready()) b.advance();
  return { battle: b, events: b.events, hash: b.hash(), winner: b.winner };
}

/** The pure step: (snapshot, [choiceA, choiceB]) -> { snapshot, events, hash }. choices for sides that need none may be null. */
export function stepBattle(snap, choices, opts) {
  const b = restoreBattle(snap, opts);
  b.drain();
  if (!Array.isArray(choices) || choices.length > 2) throw new EngineError('stepBattle needs choices = [choiceA, choiceB] (null for a side with nothing to choose)', null, 'bad-argument');
  for (let side = 0; side < 2; side++) {
    const c = choices[side];
    if (c) { const r = b.choose(side, c); if (!r.ok) throw new EngineError(`step: choice rejected (${r.code})`, { side, c }, 'step-rejected'); }
  }
  const events = b.advance();
  return { snapshot: b.snapshot(), events, hash: b.hash() };
}

/** Compact stats of the engine for the UI (counts come from rules.js engineSupports). */
export function engineInfo() { return { version: ENGINE_VERSION, mechanics: MECHANICS.length, fnv: fnv1a32('pokemonarena-engine') }; }

// pokemonarena/js/engine_moves.js -- the handlers for each move-effect CLASS (see engine_data.js EFFECTS for the
// effect-id -> class mapping and its anchor moves).  Leaf module: it does not import engine.js, so rules.js can ask which
// classes exist (IMPLEMENTED_KINDS) without pulling in the battle.
//
// A handler is an object; every key is optional.  `c` is the move context built by Battle.makeCtx:
//   c.b (battle)  c.user  c.target  c.us / c.ts (sides)  c.mv (the pack record)  c.id  c.type  c.cat  c.power
//   c.crit  c.roll  c.hit  c.total (damage dealt so far)  c.o (call options)
// Damaging classes set `dmg:true` and may provide:
//   prep(c)        before anything is computed (set c.bp, c.atkMon, c.atkStat, c.defStat, c.extraBp[], c.skip, ...)
//   power(c)       base power override           type(c) / cat(c)   type / category override
//   fail(c)        -> reason code or null (checked before accuracy)     begin(c)  once the move is certain to be tried (after fail, before Protect and accuracy)
//   acc(c)         accuracy override (0 = never misses)             ohko:true   OHKO accuracy rule
//   damage(c)      fixed damage (>= 0) instead of the formula, or -2 to fail
//   hits(c)        number of hits                                   perHit(c, i) / perHitAcc
//   afterHit(c,d)  after each hit                                   after(c)    after the last hit (if damage was dealt)
//   onMiss(c, failed)  after a miss / block / failure              endMove(c)  always at the end of the move
//   charge(c)      returns true on the first (charging) use of a two-turn move
// Non-damaging classes provide use(c) -> false when the move fails.

import {
  T, CAT, ST, WX, E, STAT_IDX, TN,
} from './engine_data.js';
import { idiv, fractionOf, pokeMod, applyStage } from './engine_calc.js';
import { FLING_POWER, FLING_EFFECT } from './engine_fling.js';

// Natural Gift (MEASURED: every berry, all 18 defending types, 67 berries): the berry sets the move's type and power
const NG_GROUPS = [
  [80, ['Cheri', 'Chesto', 'Pecha', 'Rawst', 'Aspear', 'Leppa', 'Oran', 'Persim', 'Lum', 'Sitrus', 'Figy', 'Wiki', 'Mago', 'Aguav', 'Iapapa', 'Razz'],
    [T.FIRE, T.WATER, T.ELECTRIC, T.GRASS, T.ICE, T.FIGHTING, T.POISON, T.GROUND, T.FLYING, T.PSYCHIC, T.BUG, T.ROCK, T.GHOST, T.DRAGON, T.DARK, T.STEEL]],
  [90, ['Bluk', 'Nanab', 'Wepear', 'Pinap', 'Pomeg', 'Kelpsy', 'Qualot', 'Hondew', 'Grepa', 'Tamato', 'Cornn', 'Magost', 'Rabuta', 'Nomel', 'Spelon', 'Pamtre'],
    [T.FIRE, T.WATER, T.ELECTRIC, T.GRASS, T.ICE, T.FIGHTING, T.POISON, T.GROUND, T.FLYING, T.PSYCHIC, T.BUG, T.ROCK, T.GHOST, T.DRAGON, T.DARK, T.STEEL]],
  [100, ['Watmel', 'Durin', 'Belue'], [T.FIRE, T.WATER, T.ELECTRIC]],
  [80, ['Chilan', 'Occa', 'Passho', 'Wacan', 'Rindo', 'Yache', 'Chople', 'Kebia', 'Shuca', 'Coba', 'Payapa', 'Tanga', 'Charti', 'Kasib', 'Haban', 'Colbur', 'Babiri', 'Roseli'],
    [T.NORMAL, T.FIRE, T.WATER, T.ELECTRIC, T.GRASS, T.ICE, T.FIGHTING, T.POISON, T.GROUND, T.FLYING, T.PSYCHIC, T.BUG, T.ROCK, T.GHOST, T.DRAGON, T.DARK, T.STEEL, T.FAIRY]],
  [100, ['Liechi', 'Ganlon', 'Salac', 'Petaya', 'Apicot', 'Lansat', 'Starf', 'Enigma', 'Micle', 'Custap', 'Jaboca', 'Rowap', 'Kee', 'Maranga'],
    [T.GRASS, T.ICE, T.FIGHTING, T.POISON, T.GROUND, T.FLYING, T.PSYCHIC, T.BUG, T.ROCK, T.GHOST, T.DRAGON, T.DARK, T.FAIRY, T.DARK]],
];
const NATURAL_GIFT = {};
for (const [p, names, types] of NG_GROUPS) names.forEach((n, i) => { NATURAL_GIFT[n + ' Berry'] = { power: p, type: types[i] }; });

const TERRAIN_TYPE = [undefined, T.GRASS, T.ELECTRIC, T.FAIRY, T.PSYCHIC, T.FIRE];
/** The volatile conditions Baton Pass hands to the next Pokemon. */
const PASSABLE = ['conf', 'sub', 'fe', 'ingrain', 'aring', 'mag', 'tele', 'lockon', 'seeded', 'curse', 'emb', 'hb', 'perish', 'pt'];
function passable(v) { const o = {}; for (const k of PASSABLE) if (v[k] !== undefined) o[k] = v[k]; return o; }
// abilities Gastro Acid and Entrainment cannot touch (the ones that are part of a Pokemon's form or that the game protects)
const GASTRO_PROOF = new Set(['Multitype', 'Stance Change', 'Schooling', 'Comatose', 'Shields Down', 'Disguise', 'RKS System', 'Battle Bond', 'Power Construct', 'Ice Face', 'Gulp Missile', 'Zen Mode', 'Neutralizing Gas', 'As One', 'Zero to Hero', 'Commander', 'Tera Shift']);
const NATURE_POWER = ['', 'Energy Ball', 'Thunderbolt', 'Moonblast', 'Psychic'];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const posStages = (m) => sum(['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].map((k) => (m.sg[k] > 0 ? m.sg[k] : 0)));
const hasStatus = (m) => m.s !== ST.NONE;

function echoStreak(c) {
  const sd = c.b.s.sides[c.us];
  const turn = c.b.s.turn;
  if (sd.ev && (sd.ev.t === turn - 1 || sd.ev.t === turn)) return sd.ev.n < 5 ? sd.ev.n + 1 : 5;
  return 1;
}

function weightOf(b, m) {
  let w = m.wt;
  const f = b.abFn(m, 'weight'); if (f) w = f(b, m, w);
  if (b.itFn(m, 'weightHalf')) w = w >> 1;
  const it = b.itFn(m, 'weight'); if (it) w = it(b, m, w);
  return w < 1 ? 1 : w;
}

/** Force `side`'s active mon out for a random replacement (Roar, Dragon Tail). Returns true if it happened. */
function forceOut(b, side, srcSide) {
  const m = b.act(side);
  if (m.hp <= 0) return false;
  if (m.v.ingrain || b.abFn(m, 'suctionCups', true)) { b.emit({ t: 'fail', s: side, m: m.slot, why: 'rooted' }); return false; }
  const sd = b.s.sides[side];
  const opts = [];
  for (let i = 0; i < sd.team.length; i++) if (i !== sd.act && sd.team[i].hp > 0) opts.push(i);
  if (!opts.length) return false;
  const slot = opts[b.rand(opts.length)];
  b.emit({ t: 'forced-out', s: side, m: m.slot });
  b.doSwitch(side, slot, {});
  return true;
}

function healFrac(b, m, num, den, src) {
  const n = fractionOf(m.mhp, den, num);
  return b.healMon(m, n, { src });
}

function applyDrain(c, pct) {
  const { b, user, target } = c;
  if (c.total <= 0 || user.hp <= 0) return;
  let amt = idiv(c.total * pct, 100);
  if (amt < 1) amt = 1;
  if (b.itFn(user, 'bigRoot')) amt = idiv(amt * 5324, 4096);
  if (b.abFn(target, 'liquidOoze', true)) {
    b.reveal(target, 'a');
    b.emit({ t: 'ability', s: target.side, m: target.slot, ab: target.ab, fx: 'liquid-ooze' });
    b.dealDamage(user, amt, { src: 'liquid-ooze', from: -1 });
  } else {
    b.emit({ t: 'drain', s: c.us, m: user.slot });
    b.healMon(user, amt, { src: 'drain' });
  }
}

const healWeather = {
  half: () => [1, 2],
  quarter: () => [1, 4],
  sun: (w) => (w === WX.SUN ? [2, 3] : w === WX.NONE ? [1, 2] : [1, 4]),
  sand: (w) => (w === WX.SAND ? [2, 3] : [1, 2]),
};

const TWO_TURN_NAMES_AIR = ['Fly', 'Bounce'];
const MAGNITUDE_BP = [10, 30, 50, 70, 90, 110, 150];
const MAGNITUDE_PREVIEW_BP = 71;
const PRESENT_PREVIEW_BP = 65;

export const MOVE_KINDS = {
  // ------------------------------------------------------------------ plain damage
  hit: { dmg: true },
  drain: { dmg: true, after(c) { applyDrain(c, c.b.D.args.drain[c.id] || 50); } },
  dreameater: {
    dmg: true,
    fail(c) { return c.target.s === ST.SLP ? null : 'no-sleep'; },
    after(c) { applyDrain(c, c.b.D.args.drain[c.id] || 50); },
  },
  recoil: {
    dmg: true,
    after(c) {
      const { b, user } = c;
      if (user.hp <= 0 || c.total <= 0) return;
      if (b.abFn(user, 'rockHead') || b.abFn(user, 'magicGuard')) return;
      const pct = b.D.args.recoil[c.id] || 25;
      let r = idiv(c.total * pct, 100);
      if (r < 1) r = 1;
      b.emit({ t: 'recoil', s: c.us, m: user.slot });
      b.dealDamage(user, r, { src: 'recoil', from: -1 });
    },
  },
  crash: {
    dmg: true,
    onMiss(c) {
      const { b, user } = c;
      if (user.hp <= 0 || b.abFn(user, 'magicGuard')) return;
      b.emit({ t: 'recoil', s: c.us, m: user.slot, crash: 1 });
      b.dealDamage(user, fractionOf(user.mhp, 2), { src: 'crash', from: -1 });
    },
  },
  struggle: {
    dmg: true,
    type: () => T.MYSTERY,
    prep(c) { c.b.emit({ t: 'struggle', s: c.us, m: c.user.slot }); },
    previewPrep() { /* the preview writes no event */ },
  },
  mindblown: {
    dmg: true,
    endMove(c) {
      const { b, user } = c;
      if (user.hp <= 0 || !c.executed || b.abFn(user, 'magicGuard')) return;
      b.dealDamage(user, fractionOf(user.mhp, 2), { src: 'mind-blown', from: -1 });
    },
  },
  burnup: {
    dmg: true,
    fail(c) { return c.b.hasType(c.user, c.mv.type) ? null : 'failed'; },
    after(c) {
      const { b, user } = c;
      if (user.hp <= 0) return;
      const ty = b.types(user).filter((x) => x !== c.mv.type);
      user.v.ty = ty.length ? ty : [T.MYSTERY];
      b.emit({ t: 'type-change', s: c.us, m: user.slot, ty: user.v.ty.slice() });
    },
  },

  // ------------------------------------------------------------------ fixed / formula-free damage
  leveldamage: { dmg: true, noCrit: true, damage(c) { return c.user.level; } },
  psywave: {
    dmg: true, noCrit: true,
    damage(c) { const r = c.b.rand(101); const d = idiv(c.user.level * (r + 50), 100); return d < 1 ? 1 : d; },
    previewDamage(c) { return c.user.level < 1 ? 1 : c.user.level; }, // the mean of level * (50..150) / 100
  },
  fixeddamage: { dmg: true, noCrit: true, damage(c) { return c.b.D.args.fixed[c.id] || 1; } },
  fractiondamage: { dmg: true, noCrit: true, damage(c) { const pct = c.b.D.args.fraction[c.id] || 50; const d = idiv(c.target.hp * pct, 100); return d < 1 ? 1 : d; } },
  ohko: {
    dmg: true, ohko: true, noCrit: true,
    fail(c) {
      const { b, target } = c;
      if (b.abFn(target, 'sturdy', true)) { b.reveal(target, 'a'); b.emit({ t: 'immune', s: c.ts, m: target.slot, why: 'ability', ab: target.ab, mv: c.id }); return 'sturdy'; }
      if (c.mv.type === T.ICE && b.hasType(target, T.ICE)) return 'ice-ohko';
      return null;
    },
    damage(c) { return c.target.hp; },
  },
  endeavor: {
    dmg: true, noCrit: true,
    fail(c) { return c.user.hp >= c.target.hp ? 'failed' : null; },
    damage(c) { return c.target.hp - c.user.hp; },
  },
  finalgambit: {
    dmg: true, noCrit: true,
    damage(c) { return c.user.hp; },
    after(c) { if (c.user.hp > 0) c.b.dealDamage(c.user, c.user.hp, { src: 'final-gambit', from: -1 }); },
  },
  counter: {
    dmg: true, noCrit: true,
    fail(c) {
      const u = c.user;
      const need = c.b.D.args.counter[c.id];
      if (!u.v.hit || u.v.hitFrom === undefined || u.v.hitFrom === c.us) return 'failed';
      // Counter (physical only) / Mirror Coat (special only); the 150% moves answer either
      if (need === 200) { const wantCat = c.mv.type === T.FIGHTING ? CAT.PHYSICAL : CAT.SPECIAL; if (u.v.hitCat !== wantCat) return 'failed'; }
      return null;
    },
    damage(c) {
      const pct = c.b.D.args.counter[c.id] || 200;
      const d = idiv(c.user.v.hitAmt * pct, 100);
      return d < 1 ? 1 : d;
    },
  },

  // ------------------------------------------------------------------ variable power
  flail: {
    dmg: true,
    power(c) {
      const p = idiv(c.user.hp * 48, c.user.mhp);
      return p <= 1 ? 200 : p <= 4 ? 150 : p <= 9 ? 100 : p <= 16 ? 80 : p <= 32 ? 40 : 20;
    },
  },
  return: { dmg: true, power() { return 102; } }, // friendship 255 assumed (ENGINE.md)
  present: {
    dmg: true,
    prep(c) {
      const r = c.b.rand(100);
      if (r < 40) c.bp = 40; else if (r < 70) c.bp = 80; else if (r < 80) c.bp = 120;
      else { c.skip = true; c.b.healMon(c.target, fractionOf(c.target.mhp, 4), { src: 'present' }); }
    },
    // expected power given that it damages: (40*40 + 30*80 + 10*120) / 80
    previewPrep(c) { c.bp = PRESENT_PREVIEW_BP; },
  },
  magnitude: {
    dmg: true,
    prep(c) {
      const r = c.b.rand(100);
      const lv = r < 5 ? 4 : r < 15 ? 5 : r < 35 ? 6 : r < 65 ? 7 : r < 85 ? 8 : r < 95 ? 9 : 10;
      c.bp = MAGNITUDE_BP[lv - 4];
      c.b.emit({ t: 'noop', what: 'magnitude', n: lv });
    },
    // expected power: (5*10 + 10*30 + 20*50 + 30*70 + 20*90 + 10*110 + 5*150) / 100
    previewPrep(c) { c.bp = MAGNITUDE_PREVIEW_BP; },
  },
  hiddenpower: { dmg: true, type(c) { return c.user.hpt; } },
  facade: { dmg: true, power(c) { return hasStatus(c.user) && c.user.s !== ST.SLP && c.user.s !== ST.FRZ ? c.mv.power * 2 : c.mv.power; }, prep(c) { c.noBurnCut = true; } },
  condpower: {
    dmg: true,
    power(c) {
      const t = c.target, nm = c.b.pack.moves[c.id].name;
      const cond = nm === 'Smelling Salts' ? t.s === ST.PAR : nm === 'Wake-Up Slap' ? t.s === ST.SLP
        : nm === 'Venoshock' || nm === 'Barb Barrage' ? (t.s === ST.PSN || t.s === ST.TOX) : t.s !== ST.NONE;
      return cond ? c.mv.power * 2 : c.mv.power;
    },
    after(c) {
      const nm = c.b.pack.moves[c.id].name, t = c.target;
      if (nm === 'Smelling Salts' && t.hp > 0 && t.s === ST.PAR && c.wasStatus === ST.PAR) c.b.clearStatus(t, 'cured');
      if (nm === 'Wake-Up Slap' && t.hp > 0 && t.s === ST.SLP && c.wasStatus === ST.SLP) c.b.clearStatus(t, 'cured');
    },
    prep(c) { c.wasStatus = c.target.s; },
  },
  revenge: { dmg: true, power(c) { return c.user.v.hit > 0 ? c.mv.power * 2 : c.mv.power; } },
  eruption: { dmg: true, power(c) { const p = idiv(c.mv.power * c.user.hp, c.user.mhp); return p < 1 ? 1 : p; } },
  lowkick: {
    dmg: true,
    power(c) {
      const w = weightOf(c.b, c.target);
      return w < 100 ? 20 : w < 250 ? 40 : w < 500 ? 60 : w < 1000 ? 80 : w < 2000 ? 100 : 120;
    },
  },
  wringout: { dmg: true, power(c) { const p = idiv(c.mv.power * c.target.hp, c.target.mhp); return p < 1 ? 1 : p; } },
  assurance: { dmg: true, power(c) { return c.target.v.hit > 0 ? c.mv.power * 2 : c.mv.power; } },
  acrobatics: { dmg: true, power(c) { return c.user.it === 0 ? c.mv.power * 2 : c.mv.power; } },
  heavyslam: {
    dmg: true,
    power(c) {
      const r = idiv(weightOf(c.b, c.user) * 100, weightOf(c.b, c.target));
      return r >= 500 ? 120 : r >= 400 ? 100 : r >= 300 ? 80 : r >= 200 ? 60 : 40;
    },
  },
  punishment: { dmg: true, power(c) { const p = 60 + 20 * posStages(c.target); return p > 200 ? 200 : p; } },
  storedpower: { dmg: true, power(c) { return 20 + 20 * posStages(c.user); } },
  electroball: {
    dmg: true,
    power(c) {
      const r = idiv(c.b.speed(c.user) * 100, c.b.speed(c.target));
      return r >= 400 ? 150 : r >= 300 ? 120 : r >= 200 ? 80 : r >= 100 ? 60 : 40;
    },
  },
  gyroball: { dmg: true, power(c) { const p = 1 + idiv(25 * c.b.speed(c.target), c.b.speed(c.user)); return p > 150 ? 150 : p; } },
  echoedvoice: {
    dmg: true,
    prep(c) {
      const sd = c.b.s.sides[c.us];
      const n = echoStreak(c);
      sd.ev = { t: c.b.s.turn, n };
      c.bp = 40 * n;
    },
    previewPrep(c) { c.bp = 40 * echoStreak(c); }, // reads the streak, writes nothing
  },
  payback: { dmg: true, power(c) { return c.target.v.moved ? c.mv.power * 2 : c.mv.power; } },
  brine: { dmg: true, power(c) { return c.target.hp * 2 <= c.target.mhp ? c.mv.power * 2 : c.mv.power; } },
  foulplay: { dmg: true, prep(c) { c.atkMon = c.target; } },
  psyshock: { dmg: true, prep(c) { c.defStat = 'def'; } },
  bodypress: { dmg: true, prep(c) { c.atkStat = 'def'; } },
  suckerpunch: {
    dmg: true,
    fail(c) {
      const q = c.b.s.q;
      const a = q.find((x) => x.s === c.ts);
      if (!a || a.k !== 'move' || a.second) return 'failed';
      const mv = c.b.pack.moves[a.mv];
      return mv.category === CAT.STATUS ? 'failed' : null;
    },
  },
  flyingpress: { dmg: true, prep(c) { c.flyingPress = true; } },
  stomptantrum: { dmg: true, power(c) { return c.user.v.prevFail === c.b.s.turn - 1 ? c.mv.power * 2 : c.mv.power; } },
  lashout: { dmg: true, power(c) { return c.user.v.drop === c.b.s.turn ? c.mv.power * 2 : c.mv.power; } },
  boltbeak: { dmg: true, power(c) { return c.target.v.moved ? c.mv.power : c.mv.power * 2; } },
  collision: { dmg: true, prep(c) { if (c.effInfo === undefined) { /* set by caller */ } }, finalMod(c) { return c.eff > 4096 ? 5461 : 0; } },
  ragefist: { dmg: true, power(c) { const p = 50 + 50 * (c.user.ht || 0); return p > 350 ? 350 : p; } },
  lastrespects: { dmg: true, power(c) { const n = c.b.s.sides[c.us].nfaint || 0; const p = 50 + 50 * n; return p > 650 ? 650 : p; } },
  triplekick: {
    dmg: true, perHitAcc: true,
    perHit(c, i) { c.bp = c.mv.power * (i + 1); },
  },
  fellstinger: { dmg: true, after(c) { if (c.target.hp <= 0 && c.user.hp > 0) c.b.changeStage(c.user, 'atk', 3, -1); } },
  knockoff: {
    dmg: true,
    prep(c) { if (c.target.it && !c.b.abFn(c.target, 'stickyHold', true)) c.extraBp = [6144]; },
    after(c) {
      const t = c.target;
      if (t.hp > 0 && t.it && !c.b.abFn(t, 'stickyHold', true) && !c.subHit) {
        c.b.emit({ t: 'item', s: t.side, m: t.slot, it: t.it, fx: 'knocked-off', used: 1 });
        t.used = t.it; t.it = 0; delete t.v.choice;
      }
    },
  },
  thief: {
    dmg: true,
    after(c) {
      const { user, target: t, b } = c;
      if (user.hp > 0 && t.hp > 0 && !user.it && t.it && !b.abFn(t, 'stickyHold', true) && !c.subHit) {
        user.it = t.it; t.used = t.it; t.it = 0; delete t.v.choice;
        b.emit({ t: 'trick', s: c.us, m: user.slot, it: user.it, from: c.ts, steal: 1 });
      }
    },
  },
  uturn: {
    dmg: true,
    after(c) { if (c.user.hp > 0 && c.b.aliveCount(c.us) > 1) { c.b.s.pause = c.us; c.b.emit({ t: 'pivot', s: c.us, m: c.user.slot }); } },
  },
  dragontail: {
    dmg: true,
    after(c) { if (c.target.hp > 0 && !c.subHit && c.b.aliveCount(c.ts) > 1) forceOut(c.b, c.ts, c.us); },
  },
  snore: { dmg: true, fail(c) { return c.user.s === ST.SLP ? null : 'failed'; } },
  falseswipe: { dmg: true, survive1: true },
  furycutter: {
    dmg: true,
    power(c) { const n = c.user.v.fc || 0; const p = c.mv.power * (1 << (n > 2 ? 2 : n)); return p > 160 ? 160 : p; },
    after(c) { c.user.v.fc = (c.user.v.fc || 0) + 1; },
    onMiss(c) { delete c.user.v.fc; },
  },
  firstturn: { dmg: true, fail(c) { return c.user.v.turns === 1 ? null : 'failed'; } },
  focuspunch: { dmg: true, fail(c) { if (c.user.v.hit > 0 && !c.b.abFn(c.user, 'parrying')) { c.b.emit({ t: 'cant-move', s: c.us, m: c.user.slot, why: 'lost-focus' }); return 'lost-focus'; } return null; } },
  weatherball: {
    dmg: true,
    type(c) { const w = c.b.wx(); return w === WX.RAIN ? T.WATER : w === WX.SUN ? T.FIRE : w === WX.SAND ? T.ROCK : (w === WX.HAIL || w === WX.SNOW) ? T.ICE : undefined; },
    power(c) { return c.b.wx() !== WX.NONE ? c.mv.power * 2 : c.mv.power; },
  },
  freezedry: { dmg: true, prep(c) { c.freezeDry = true; } },
  revelation: { dmg: true, type(c) { return c.b.types(c.user)[0]; } },
  rapidspin: {
    dmg: true,
    after(c) {
      const { b, user } = c;
      if (user.hp <= 0) return;
      const sd = b.s.sides[c.us];
      let any = false;
      // MEASURED (ROM 0x4428f4 / 0x4428e0): after the Speed rise the real game frees the user from a binding move and from Leech Seed, in that order, before the hazards
      if (user.v.trap) { const tr = user.v.trap; delete user.v.trap; any = true; b.emit({ t: 'volatile-end', s: c.us, m: user.slot, v: 'trap', why: 'rapid-spin', var: tr.var || 0 }); }
      if (user.v.seeded !== undefined) { delete user.v.seeded; any = true; b.emit({ t: 'volatile-end', s: c.us, m: user.slot, v: 'leech-seed', why: 'rapid-spin' }); }
      if (sd.hz.sp || sd.hz.ts || sd.hz.sr || sd.hz.sw) { sd.hz = { sp: 0, ts: 0, sr: 0, sw: 0 }; any = true; b.emit({ t: 'hazard-clear', s: c.us, hz: 'all' }); }
      void any;
    },
  },

  // ------------------------------------------------------------------ two-turn moves
  twoturn: {
    dmg: true,
    charge(c) {
      const { b, user } = c;
      if (b.itFn(user, 'skipCharge')) { b.consumeItem(user, 'power-herb'); return false; }
      if (c.mv.additional.some((a) => a.effect === 3345)) {   // Electro Shot: +1 Sp. Atk on the charge turn (also in rain, MEASURED), fired at once in rain
        b.changeStage(user, 'spa', 1, -1, {});
        if (b.wx() === WX.RAIN) return false;
      }
      user.v.chg = { mv: c.id };
      b.emit({ t: 'charge', s: c.us, m: user.slot, mv: c.id });
      if (c.mv.additional.some((a) => a.effect === 1295)) b.changeStage(user, 'def', 1, -1, {});
      else if (c.mv.additional.some((a) => a.effect === 1297)) b.changeStage(user, 'spa', 1, -1, {});
      return true;
    },
  },
  solarbeam: {
    dmg: true,
    charge(c) {
      const { b, user } = c;
      if (b.wx() === WX.SUN) return false;
      if (b.itFn(user, 'skipCharge')) { b.consumeItem(user, 'power-herb'); return false; }
      user.v.chg = { mv: c.id };
      b.emit({ t: 'charge', s: c.us, m: user.slot, mv: c.id });
      return true;
    },
    prep(c) { const w = c.b.wx(); if (w === WX.RAIN || w === WX.SAND || w === WX.HAIL || w === WX.SNOW) c.extraBp = [2048]; },
  },
  semiinvuln: {
    dmg: true,
    bypassProtect: false,
    charge(c) {
      const { b, user } = c;
      const nm = b.pack.moves[c.id].name;
      { const ot = b.abFn(user, 'oneTurn'); if (ot && ot(b, c)) return false; }   // Burrower / Diver / Flier: the move is done in one turn
      const kind = nm === 'Dig' ? 'ground' : nm === 'Dive' ? 'water' : TWO_TURN_NAMES_AIR.indexOf(nm) >= 0 ? 'air' : 'shadow';
      user.v.chg = { mv: c.id };
      user.v.sinv = kind;
      b.emit({ t: 'charge', s: c.us, m: user.slot, mv: c.id, sinv: kind });
      return true;
    },
    prep(c) {
      const t = c.target;
      if (t && t.v.sinv && c.mv.power > 1) { /* semi-invulnerable power doubling is handled by the hitting move's own kind */ }
    },
  },

  // ------------------------------------------------------------------ stat changes
  stats: {
    use(c) {
      const { b, user, target, ef } = c;
      if (c.id === b.D.named.minimizeId) user.v.mini = 1; // Stomp-family moves double against it and never miss
      if (ef.self) for (const k of Object.keys(ef.self)) b.changeStage(user, k, ef.self[k], -1, {});
      if (ef.foe) for (const k of Object.keys(ef.foe)) b.changeStage(target, k, ef.foe[k], c.us, { move: true });
      if (c.mv.name === 'Tar Shot') { target.v.tar = 1; b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'tar-shot' }); }   // MEASURED: Fire damage to the target doubles until it leaves the field
      return true;
    },
  },
  growth: {
    use(c) { const n = c.b.wx() === WX.SUN ? 2 : 1; c.b.changeStage(c.user, 'atk', n, -1, {}); c.b.changeStage(c.user, 'spa', n, -1, {}); return true; },
  },
  bellydrum: {
    use(c) {
      const { b, user } = c;
      const cost = idiv(user.mhp, 2);
      if (user.hp <= cost || user.sg.atk >= 6) return false;
      b.dealDamage(user, cost, { src: 'belly-drum', from: -1 });
      b.changeStage(user, 'atk', 12, -1, {});
      return true;
    },
  },
  strengthsap: {
    use(c) {
      const { b, user, target } = c;
      if (target.sg.atk <= -6) return false;
      const amt = (function () { const s = target.st.atk; const st = target.sg.atk; const r = st >= 0 ? idiv(s * (2 + st), 2) : idiv(s * 2, 2 - st); return r; }());
      b.changeStage(target, 'atk', -1, c.us, { move: true });
      b.healMon(user, amt, { src: 'strength-sap' });
      return true;
    },
  },

  // ------------------------------------------------------------------ status moves
  status: {
    use(c) {
      const { b, target, user } = c;
      const mv = c.mv;
      if (mv.flags.powder && (b.hasType(target, T.GRASS) || b.abFn(target, 'overcoat', true) || b.itFn(target, 'goggles'))) { b.emit({ t: 'immune', s: c.ts, m: target.slot, why: 'powder', mv: c.id }); return true; }
      if (mv.type === T.ELECTRIC) { const e = b.typeEff(T.ELECTRIC, target, null); if (e.prod === 0) { b.emit({ t: 'immune', s: c.ts, m: target.slot, why: 'type', mv: c.id }); return true; } }
      const st = b.D.args.statusType[c.id];
      if (st === undefined) return false;
      c.failedLogged = false;
      if (b.setStatus(target, st, user, { fx: 'move', from: c.us })) return true;
      return true;
    },
  },
  confuse: { use(c) { c.b.confuse(c.target, c.user, {}); return true; } },
  swagger: {
    use(c) {
      c.b.changeStage(c.target, 'atk', 2, c.us, { move: true });
      c.b.confuse(c.target, c.user, {});
      return true;
    },
  },
  flatter: {
    use(c) {
      c.b.changeStage(c.target, 'spa', 1, c.us, { move: true });
      c.b.confuse(c.target, c.user, {});
      return true;
    },
  },
  yawn: {
    use(c) {
      const { b, target } = c;
      if (target.s !== ST.NONE || target.v.yawn || b.s.sides[c.ts].sg > 0 || b.abFn(target, 'sleepImmune', true) || b.terrainActs(target, 2) || b.terrainActs(target, 3)) return false;
      target.v.yawn = 2;
      b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'yawn' });
      return true;
    },
  },
  leechseed: {
    use(c) {
      const { b, target } = c;
      if (target.v.seeded !== undefined || b.hasType(target, T.GRASS)) { if (b.hasType(target, T.GRASS)) b.emit({ t: 'immune', s: c.ts, m: target.slot, why: 'type', mv: c.id }); return b.hasType(target, T.GRASS); }
      target.v.seeded = c.us;
      b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'leech-seed' });
      return true;
    },
  },
  toxicthread: {
    use(c) {
      const { b, target, user } = c;
      b.setStatus(target, ST.PSN, user, { fx: 'move' });
      b.changeStage(target, 'spe', -1, c.us, { move: true });
      return true;
    },
  },

  // ------------------------------------------------------------------ healing
  heal: {
    use(c) {
      const { b, user, ef } = c;
      if (user.hp >= user.mhp) return false;
      const [n, d] = healWeather[ef.w](b.wx());
      if (ef.roost) user.v.roost = 1;
      b.healMon(user, fractionOf(user.mhp, d, n), { src: 'move' });
      return true;
    },
  },
  rest: {
    use(c) {
      const { b, user } = c;
      if (user.hp >= user.mhp || user.s === ST.SLP) return false;
      if (b.abFn(user, 'sleepImmune')) return false;
      if (b.terrainActs(user, TN.ELECTRIC) || b.terrainActs(user, TN.MISTY)) return false;   // MEASURED: Rest fails on a grounded user under Electric Terrain
      const prev = user.s;
      if (prev !== ST.NONE) b.clearStatus(user, 'rest');
      user.s = ST.SLP; user.sc = 2;
      b.emit({ t: 'status-set', s: c.us, m: user.slot, st: ST.SLP, fx: 'rest' });
      b.healMon(user, user.mhp, { src: 'rest' });
      return true;
    },
  },
  painsplit: {
    use(c) {
      const { b, user, target } = c;
      const avg = idiv(user.hp + target.hp, 2);
      for (const m of [user, target]) {
        if (m.hp > avg) b.dealDamage(m, m.hp - avg, { src: 'pain-split', from: -1 });
        else if (m.hp < avg) b.healMon(m, avg - m.hp, { src: 'pain-split' });
      }
      return true;
    },
  },
  healbell: {
    use(c) {
      const { b } = c;
      for (const m of b.s.sides[c.us].team) if (m.hp > 0 && m.s !== ST.NONE) b.clearStatus(m, 'heal-bell');
      return true;
    },
  },
  refresh: {
    use(c) {
      const { b, user } = c;
      if (user.s !== ST.PSN && user.s !== ST.TOX && user.s !== ST.BRN && user.s !== ST.PAR) return false;
      b.clearStatus(user, 'refresh');
      return true;
    },
  },
  wish: {
    use(c) {
      const sd = c.b.s.sides[c.us];
      if (sd.wish) return false;
      sd.wish = { t: 2, hp: idiv(c.user.mhp, 2) };
      c.b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'wish' });
      return true;
    },
  },

  // ------------------------------------------------------------------ field
  weather: {
    use(c) { return c.b.setWeather(c.b.D.args.weather[c.id], c.user); },
  },
  screen: {
    use(c) {
      const { b, user, ef } = c;
      const sd = b.s.sides[c.us];
      const key = ef.screen === 'reflect' ? 'reflect' : ef.screen === 'light' ? 'light' : 'veil';
      if (sd[key] > 0) return false;
      if (key === 'veil' && b.wx() !== WX.HAIL && b.wx() !== WX.SNOW) return false;
      sd[key] = b.itFn(user, 'screenExt') ? 8 : E.screenTurns;
      b.emit({ t: 'screen', s: c.us, k: key });
      return true;
    },
  },
  hazard: {
    use(c) {
      const { b, ef } = c;
      const sd = b.s.sides[c.ts];
      const k = ef.hz === 'spikes' ? 'sp' : ef.hz === 'tspikes' ? 'ts' : ef.hz === 'rocks' ? 'sr' : 'sw';
      const max = k === 'sp' ? 3 : k === 'ts' ? 2 : 1;
      if (sd.hz[k] >= max) return false;
      sd.hz[k] += 1;
      b.emit({ t: 'hazard', s: c.ts, hz: ef.hz, n: sd.hz[k] });
      return true;
    },
  },
  // Attract: opposite genders only (MEASURED in the real game: same gender, genderless and Oblivious fail); Captivate lowers Sp. Atk by 2 stages the same way
  attract: { use(c) { return c.b.infatuate(c.target, c.user, { fx: 'attract' }); } },
  captivate: { use(c) { const { b, user, target } = c; const x = b.genderOf(user), y = b.genderOf(target); if (x === 2 || y === 2 || x === y || b.abFn(target, 'loveImmune', true)) return false; b.changeStage(target, 'spa', -2, c.us, { move: true }); return true; } },
  singlesfail: { use() { return false; } },
  gravapple: { dmg: true, power(c) { return c.b.s.gv > 0 ? idiv(c.mv.power * 3, 2) : c.mv.power; } },
  ficklebeam: { dmg: true, previewPrep(c) { c.bp = c.mv.power; }, prep(c) { c.bp = c.b.rand(100) < 30 ? c.mv.power * 2 : c.mv.power; } },
  // Hyperspace Fury: Hoopa Unbound only (MEASURED: it fails for anyone else), never misses, breaks protection; the Defense drop is its additional effect
  hyperspace: { dmg: true, fail(c) { const sp = c.b.pack.species[c.user.sp]; return sp && sp.name === 'Hoopa' && c.b.hasType(c.user, T.DARK) ? null : 'failed'; } },
  hazardhit: {
    dmg: true,
    after(c) {
      const { b, ef } = c; const sd = b.s.sides[c.ts]; if (c.target.hp <= 0 && false) return;
      const k = ef.hz === 'spikes' ? 'sp' : 'sr'; const max = k === 'sp' ? 3 : 1;
      if (sd.hz[k] >= max) return;
      sd.hz[k] += 1; b.emit({ t: 'hazard', s: c.ts, hz: ef.hz, n: sd.hz[k] });
    },
  },
  fusion: {
    dmg: true,
    power(c) { const f = c.b.s.fu; return f && f[0] === c.b.s.turn && f[1] !== c.id ? c.mv.power * 2 : c.mv.power; },
    after(c) { c.b.s.fu = [c.b.s.turn, c.id]; },
  },
  geomancy: {
    selfOnly: true,
    charge(c) { const { b, user } = c; if (b.itFn(user, 'skipCharge')) { b.consumeItem(user, 'power-herb'); return false; } user.v.chg = { mv: c.id }; b.emit({ t: 'charge', s: c.us, m: user.slot, mv: c.id }); return true; },
    use(c) { const { b, user } = c; for (const k of ['spa', 'spd', 'spe']) b.changeStage(user, k, 2, c.us, { move: true }); return true; },
  },
  purify: { use(c) { const { b, user, target: t } = c; if (t.s === ST.NONE) return false; b.clearStatus(t, 'purify'); b.healMon(user, idiv(user.mhp, 2), { src: 'move' }); return true; } },
  courtchange: {
    use(c) {
      const { b } = c; const a = b.s.sides[0], z = b.s.sides[1];
      for (const k of ['reflect', 'light', 'veil', 'mist', 'sg', 'tw', 'hz', 'wish']) { const x = a[k]; a[k] = z[k]; z[k] = x; }
      b.emit({ t: 'field', k: 'court-change', on: 1 });
      return true;
    },
  },
  lastresort: { dmg: true, fail(c) { const u = c.user; if (u.mv.length < 2) return 'failed'; const um = u.v.um || []; for (const m of u.mv) if (m.id !== c.id && um.indexOf(m.id) < 0) return 'failed'; return null; } },
  copycat: {
    selfOnly: true,
    use(c) { const { b, user } = c; const lm = b.s.lm; if (!lm || b.D.named.metronomeBan.has(lm)) return false; b.emit({ t: 'copy', s: c.us, mv: lm, how: 'copycat' }); b.useMove(c.us, lm, { called: true, noPP: true }); return true; },
  },
  mefirst: {
    selfOnly: true,
    use(c) {
      const { b, user } = c;
      const q = b.s.q; const a = q.find((x) => x.s === c.ts);
      if (!a || a.k !== 'move' || a.second) return false;
      const mv = b.pack.moves[a.mv];
      if (mv.category === CAT.STATUS || mv.id === 0 || b.D.named.metronomeBan.has(mv.id)) return false;
      b.emit({ t: 'copy', s: c.us, mv: mv.id, how: 'me-first' });
      b.useMove(c.us, mv.id, { called: true, noPP: true, boostBp: 6144 });
      return true;
    },
  },
  assist: {
    selfOnly: true,
    use(c) {
      const { b, user } = c;
      const pool = [];
      b.s.sides[c.us].team.forEach((m, i) => { if (i !== b.s.sides[c.us].act && m.hp > 0) for (const x of m.mv) if (x.id && !b.D.named.metronomeBan.has(x.id) && pool.indexOf(x.id) < 0) pool.push(x.id); });
      if (!pool.length) return false;
      const id = pool[b.rand(pool.length)];
      b.emit({ t: 'copy', s: c.us, mv: id, how: 'assist' });
      b.useMove(c.us, id, { called: true, noPP: true });
      return true;
    },
  },
  instruct: {
    use(c) {
      const { b, target: t } = c;
      const lm = t.v.lastMv;
      if (!lm || t.hp <= 0 || b.D.named.metronomeBan.has(lm) || b.pack.moves[lm].name === 'Instruct' || t.v.chg || t.v.ramp) return false;
      b.emit({ t: 'copy', s: c.ts, mv: lm, how: 'instruct' });
      b.useMove(c.ts, lm, { called: true, noPP: true });
      return true;
    },
  },
  bestow: { use(c) { const { b, user, target: t } = c; if (!user.it || t.it || b.itFn(user, 'blockDrop')) return false; t.it = user.it; user.it = 0; b.emit({ t: 'item', s: c.us, m: user.slot, it: t.it, fx: 'bestow', used: 0 }); return true; } },
  stuffcheeks: { selfOnly: true, use(c) { const { b, user } = c; if (!user.it || !b.berries.has(user.it)) return false; const it = user.it; b.consumeItem(user, 'stuff-cheeks'); b.eatBerry(user, it); b.changeStage(user, 'def', 2, c.us, { move: true }); return true; } },
  teatime: { use(c) { const { b } = c; let any = false; for (let s = 0; s < 2; s++) { const m = b.act(s); if (m && m.hp > 0 && m.it && b.berries.has(m.it)) { const it = m.it; b.consumeItem(m, 'teatime'); b.eatBerry(m, it); any = true; } } return any; } },
  batonpass: { selfOnly: true, use(c) { const { b, user } = c; if (b.aliveCount(c.us) < 2) return false; b.s.bp = { s: c.us, g: ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'].map((k) => user.sg[k]), v: passable(user.v) }; b.s.pause = c.us; b.emit({ t: 'pivot', s: c.us, m: user.slot }); return true; } },
  shedtail: { selfOnly: true, use(c) { const { b, user } = c; if (b.aliveCount(c.us) < 2 || user.hp * 2 <= user.mhp) return false; const cost = idiv(user.mhp, 2); b.dealDamage(user, cost, { src: 'shed-tail', from: -1 }); b.s.bp = { s: c.us, g: [0, 0, 0, 0, 0, 0, 0], v: { sub: idiv(user.mhp, 4) } }; b.s.pause = c.us; b.emit({ t: 'pivot', s: c.us, m: user.slot }); return true; } },
  bide: {
    selfOnly: true,
    use(c) {
      const { b, user, target: t } = c;
      if (!user.v.bide) { user.v.bide = { t: 2, d: 0 }; user.v.ramp = { mv: c.id, t: 2, nc: 1 }; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'bide' }); return true; }
      user.v.bide.t -= 1;
      if (user.v.bide.t > 0) { b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'bide-storing' }); return true; }
      const d = user.v.bide.d * 2; delete user.v.bide;
      if (d <= 0 || !t || t.hp <= 0) return false;
      b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'bide-unleash' });
      b.dealDamage(t, d, { src: 'bide', from: c.us, move: true, cat: CAT.PHYSICAL });
      return true;
    },
  },
  // Fling (MEASURED: every item flung once, engine_fling.js): the item's base power; the item is thrown away; King's Rock / Razor Fang flinch, Light Ball / Poison Barb / Flame Orb / Toxic Orb give a status,
  // a berry is eaten by the target
  fling: {
    dmg: true,
    fail(c) { const u = c.user; return u.it && !c.b.itFn(u, 'blockDrop') && FLING_POWER[c.b.itemName(u)] ? null : 'failed'; },
    power(c) { return FLING_POWER[c.b.itemName(c.user)] || 1; },
    prep(c) { c.flingItem = c.user.it; c.flingName = c.b.itemName(c.user); },
    after(c) {
      const { b, user, target: t } = c;
      const it = c.flingItem;
      if (!it) return;
      user.it = 0; b.emit({ t: 'item', s: c.us, m: user.slot, it, fx: 'fling', used: 0 });
      if (t.hp <= 0) return;
      const fx = FLING_EFFECT[c.flingName];
      if (fx && fx.flinch && !t.v.moved) t.v.flinch = 1;
      if (fx && fx.status) b.setStatus(t, fx.status, user, { fx: 'fling', from: c.us });
      if (b.berries.has(it)) b.eatBerry(t, it);
    },
  },
  // Natural Gift: needs a berry the holder can use (Klutz, Embargo and Magic Room stop it); the berry gives the type and power and is used up, its own effect does not happen
  naturalgift: {
    dmg: true,
    fail(c) { const u = c.user; return u.it && NATURAL_GIFT[c.b.itemName(u)] && c.b.itemUsable(u) ? null : 'failed'; },
    type(c) { const g = NATURAL_GIFT[c.b.itemName(c.user)]; return g ? g.type : undefined; },
    previewPrep(c) { const g = NATURAL_GIFT[c.b.itemName(c.user)]; c.bp = g ? g.power : 1; },
    // MEASURED (Protect, Cud Chew and the isolation scenarios): the berry is used up whatever becomes of the hit (even when the foe protects), but only AFTER the damage: a berry whose own trigger
    // holds then (Sitrus under half HP, Cheri while paralyzed, Liechi at a quarter) still does its job (a Liechi boost or a cured burn does not change this hit); any other berry is only used up
    // (Cud Chew remembers it, Belch does not count it)
    begin(c) { const g = NATURAL_GIFT[c.b.itemName(c.user)]; c.bp = g.power; c.ngBerry = c.user.it; },
    endMove(c) {
      const { b, user } = c;
      const it = c.ngBerry; if (!it || user.it !== it) return;
      const onHp = b.itFn(user, 'onHp'); if (onHp) onHp(b, user);
      if (user.it === it && user.s) { const onSt = b.itFn(user, 'onStatus'); if (onSt) onSt(b, user, user.s); }
      if (user.it === it && user.v.conf) { const onCf = b.itFn(user, 'onConfuse'); if (onCf) onCf(b, user); }
      if (user.it !== it) return;
      user.it = 0; user.used = it; b.reveal(user, 'i');
      if (b.abFn(user, 'cudChew')) user.v.cud = [it, b.s.turn];
      b.emit({ t: 'item', s: c.us, m: user.slot, it, fx: 'natural-gift', used: 1 });
    },
  },
  // Population Bomb (MEASURED): ten hits of its own power; Skill Link always lands all ten; Loaded Dice makes it 4 to 10 hits (4 + rand(7)). Each further hit checks accuracy again (not separable under the oracle's forced draws)
  popbomb: { dmg: true, perHitAcc: true, linkSkipsAcc: true, hits(c) { const { b, user } = c; if (b.abFn(user, 'skillLink')) return 10; if (b.itFn(user, 'loadedDice')) return 4 + b.rand(7); return 10; } },
  // Raging Bull (MEASURED, species 128/241/1402/1403/1404): the Paldea Tauros forms use their second type; everything else is Normal; it breaks Reflect, Light Screen and Aurora Veil before the damage, as Brick Break does
  ragingbull: { dmg: true, breakScreens: true, type(c) { const sp = c.b.pack.species[c.user.sp]; return sp && sp.name === 'Tauros' && sp.types[0] === T.FIGHTING ? sp.types[1] : T.NORMAL; } },
  // Ivy Cudgel (MEASURED, species 1416-1423): the Ogerpon forms use their second type (Grass, Water, Fire, Rock); the mask item does not matter; every other user is Grass
  ivycudgel: { dmg: true, type(c) { const sp = c.b.pack.species[c.user.sp]; return sp && sp.name === 'Ogerpon' ? sp.types[1] : T.GRASS; } },
  // Sky Drop (MEASURED): the first turn lifts the target (it loses that turn, and the next one if it is faster than the user), the second drops it for damage; a Flying target is lifted but the drop does not affect it;
  // it fails on a target behind a Substitute or one that is already held, and (assumed from the game's rule, not separable here) on one of 200 kg or more
  skydrop: {
    dmg: true,
    charge(c) {
      const { b, user, target: t } = c;
      if (!t || t.hp <= 0 || t.v.sub || t.v.held || weightOf(b, t) >= 2000) { b.failMove(c, 'failed'); return true; }
      user.v.chg = { mv: c.id }; user.v.sinv = 'air'; t.v.held = 1;
      b.emit({ t: 'charge', s: c.us, m: user.slot, mv: c.id, sinv: 'air' });
      b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'sky-drop' });
      return true;
    },
    prep(c) { const { b, target: t } = c; if (c.o.second && b.hasType(t, T.FLYING)) { b.emit({ t: 'immune', s: c.ts, m: t.slot, why: 'type', mv: c.id }); b.afterMiss(c, true); c.skip = true; } },
    endMove(c) { if (c.o.second && c.target) delete c.target.v.held; },
  },
  // Revival Blessing (from the ROM's own text "Revives a fainted party Pokemon and restores half of its HP"; NOT run in the real game, the oracle plays one Pokemon per side): the player is asked which fainted
  // Pokemon to bring back through a 'switch' request whose reason is 'revive' and whose switches are the fainted party members; fails when none has fainted
  revival: {
    selfOnly: true,
    use(c) { const { b } = c; const sd = b.s.sides[c.us]; if (!sd.team.some((m, i) => m.hp <= 0 && i !== sd.act)) return false; b.s.pause = c.us; b.s.pk = 'revive'; return true; },
  },
  // Upper Hand: priority +3, works only when the target is about to use a priority move; flinches it
  upperhand: { dmg: true, fail(c) { const q = c.b.s.q; const a = q.find((x) => x.s === c.ts); if (!a || a.k !== 'move' || a.second) return 'failed'; return c.b.priorityOf(c.target, c.b.pack.moves[a.mv]) > 0 ? null : 'failed'; } },
  // Poltergeist: fails when the target holds no item
  poltergeist: { dmg: true, fail(c) { return c.target.it ? null : 'failed'; } },
  torment: { use(c) { const { b, target: t } = c; if (t.v.torment || b.abFn(t, 'mentalImmune', true)) return false; t.v.torment = 1; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'torment' }); return true; } },
  imprison: { use(c) { const { b, user } = c; if (user.v.imp) return false; user.v.imp = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'imprison' }); return true; } },
  embargo: { use(c) { const { b, target: t } = c; if (t.v.emb > 0) return false; t.v.emb = 5; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'embargo' }); return true; } },
  healblock: { use(c) { const { b, target: t } = c; if (t.v.hb > 0 || b.abFn(t, 'mentalImmune', true)) return false; t.v.hb = 5; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'heal-block' }); return true; } },
  gastroacid: { use(c) { const { b, target: t } = c; if (t.v.gastro || GASTRO_PROOF.has(b.abilityName(t))) return false; t.v.gastro = 1; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'gastro-acid' }); return true; } },
  miracleeye: { use(c) { const { b, target: t } = c; if (t.v.mir) return false; t.v.mir = 1; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'miracle-eye' }); return true; } },
  laserfocus: { selfOnly: true, use(c) { const { b, user } = c; if (user.v.lf > 0) return false; user.v.lf = 2; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'laser-focus' }); return true; } },
  powertrick: { selfOnly: true, use(c) { const { b, user } = c; if (user.v.pt) delete user.v.pt; else user.v.pt = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'power-trick' }); return true; } },
  split: {
    use(c) {
      const { b, user, target: t, ef } = c;
      const so = (m) => { if (!m.v.so) m.v.so = {}; return m.v.so; };
      for (const k of ef.st) { const x = idiv(b.statOf(user, k) + b.statOf(t, k), 2); so(user)[k] = x; so(t)[k] = x; }
      b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'split' });
      return true;
    },
  },
  speedswap: { use(c) { const { b, user, target: t } = c; const x = b.statOf(user, 'spe'), y = b.statOf(t, 'spe'); (user.v.so = user.v.so || {}).spe = y; (t.v.so = t.v.so || {}).spe = x; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'speed-swap' }); return true; } },
  sport: { use(c) { const { b, ef } = c; if (b.s[ef.k] > 0) return false; b.s[ef.k] = 5; b.emit({ t: 'field', k: ef.k === 'ms' ? 'mud-sport' : 'water-sport', on: 1 }); return true; } },
  room: { use(c) { const { b, ef } = c; if (b.s[ef.k] > 0) { b.s[ef.k] = 0; delete b.s[ef.k]; b.emit({ t: 'field', k: ef.k === 'wr' ? 'wonder-room' : 'magic-room', on: 0 }); return true; } b.s[ef.k] = 5; b.emit({ t: 'field', k: ef.k === 'wr' ? 'wonder-room' : 'magic-room', on: 1 }); return true; } },
  perishsong: {
    use(c) {
      const { b } = c; let any = false;
      for (let s = 0; s < 2; s++) { const m = b.act(s); if (m && m.hp > 0 && !m.v.perish && !b.abFn(m, 'soundproof', true)) { m.v.perish = 4; any = true; } }
      if (any) b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'perish-song' });
      return any;
    },
  },
  grudge: { selfOnly: true, use(c) { const { b, user } = c; user.v.grudge = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'grudge' }); return true; } },
  powder: { use(c) { const { b, target: t } = c; if (t.v.powder) return false; t.v.powder = 1; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'powder' }); return true; } },
  iondeluge: { use(c) { const { b } = c; b.s.ion = 1; b.emit({ t: 'field', k: 'ion-deluge', on: 1 }); return true; } },
  fairylock: { use(c) { const { b } = c; if (b.s.fl > 0) return false; b.s.fl = 2; b.emit({ t: 'field', k: 'fairy-lock', on: 1 }); return true; } },
  abilitycopy: {
    use(c) {
      const { b, user, target: t, ef } = c;
      const src = ef.to === 'target' ? user : t, dst = ef.to === 'target' ? t : user;
      if (src.ab === dst.ab || !src.ab || !dst.ab || (GASTRO_PROOF.has(b.abilityName(dst)) && b.abilityName(dst) !== 'Neutralizing Gas') || (GASTRO_PROOF.has(b.abilityName(src)) && b.abilityName(src) !== 'Neutralizing Gas') || b.itFn(dst, 'abilityShield')) return false;   // MEASURED: Entrainment CAN replace Neutralizing Gas, Gastro Acid cannot
      dst.ab = src.ab; delete dst.inn;
      b.emit({ t: 'copy', s: dst.side, m: dst.slot, how: 'ability-copy', ab: dst.ab });
      return true;
    },
  },
  reflecttype: { use(c) { const { b, user, target: t } = c; user.v.ty = b.types(t).slice(); b.emit({ t: 'type-change', s: c.us, m: user.slot, ty: user.v.ty.slice() }); return true; } },
  // Conversion 2 (MEASURED over 20 draw ranges for Normal, Fire, Water and Electric as the foe's last move, and for users that already are Rock / Ghost + Steel): the user becomes a type that resists or is immune to the
  // type of the foe's last move, chosen evenly among the ones it is not already; it fails when the foe has not moved yet
  conversion2: {
    selfOnly: true,
    use(c) {
      const { b, user } = c;
      const foe = b.act(c.us ^ 1); const lm = foe && foe.v.lastMv; const mv = lm ? b.pack.moves[lm] : null;
      if (!mv) return false;
      const row = b.pack.typeChart[mv.type]; const cur = b.types(user);
      const cand = [];
      for (let ty = 1; ty < row.length; ty++) if (ty !== T.MYSTERY && row[ty] < 4096 && cur.indexOf(ty) < 0 && b.pack.typeChart[ty]) cand.push(ty);
      if (!cand.length) return false;
      const pick = cand[b.rand(cand.length)];
      user.v.ty = [pick]; b.emit({ t: 'type-change', s: c.us, m: user.slot, ty: [pick] });
      return true;
    },
  },
  conversion: {
    selfOnly: true,
    use(c) {
      const { b, user } = c;
      const first = user.mv.length ? b.pack.moves[user.mv[0].id].type : T.NORMAL;
      const cur = b.types(user);
      if (cur.length === 1 && cur[0] === first) return false;
      user.v.ty = [first]; b.emit({ t: 'type-change', s: c.us, m: user.slot, ty: [first] });
      return true;
    },
  },
  camouflage: {
    selfOnly: true,
    use(c) {
      const { b, user } = c;
      const ty = TERRAIN_TYPE[b.terrain()] !== undefined ? TERRAIN_TYPE[b.terrain()] : T.NORMAL;
      const cur = b.types(user);
      if (cur.length === 1 && cur[0] === ty) return false;
      user.v.ty = [ty]; b.emit({ t: 'type-change', s: c.us, m: user.slot, ty: [ty] });
      return true;
    },
  },
  telekinesis: { use(c) { const { b, target: t } = c; if (t.v.tele > 0 || t.v.ingrain || t.v.smack || b.s.gv > 0) return false; t.v.tele = 3; b.emit({ t: 'volatile', s: c.ts, m: t.slot, v: 'telekinesis' }); return true; } },
  magnetrise: { selfOnly: true, use(c) { const { b, user } = c; if (user.v.mag || user.v.ingrain || b.s.gv > 0) return false; user.v.mag = 5; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'magnet-rise' }); return true; } },
  rototiller: {
    use(c) {
      const { b } = c; let any = false;
      for (let s = 0; s < 2; s++) { const m = b.act(s); if (m && m.hp > 0 && b.hasType(m, T.GRASS) && b.isGrounded(m)) { any = true; b.changeStage(m, 'atk', 1, c.us, { move: true }); b.changeStage(m, 'spa', 1, c.us, { move: true }); } }
      return any;
    },
  },
  plusminus: {
    selfOnly: true,
    use(c) {
      const { b, user, ef } = c;
      if (!b.hasAbility(user, 'Plus') && !b.hasAbility(user, 'Minus')) return false;
      for (const k of ef.stats) b.changeStage(user, k, 1, c.us, { move: true });
      return true;
    },
  },

  afteryou: { use(c) { return c.target.hp > 0 && !c.target.v.moved; } },
  matblock: {
    use(c) {
      const { b, user } = c;
      if (user.v.turns !== 1) return false;
      user.v.prot = 12;
      b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'protect', pk: 12 });
      return true;
    },
  },
  flowershield: {
    use(c) {
      const { b } = c;
      let any = false;
      for (let s = 0; s < 2; s++) { const m = b.act(s); if (m && m.hp > 0 && b.hasType(m, T.GRASS)) { any = true; b.changeStage(m, 'def', 1, c.us, { move: true }); } }
      return any;
    },
  },
  terrainset: {
    use(c) { return c.b.setTerrain(c.b.D.args.terrain[c.id], c.user); },
  },
  gravity: {
    use(c) { return c.b.setGravity(); },
  },
  // Terrain Pulse (MEASURED: x2 power and the terrain's type when the USER is grounded in a terrain; a flying user gets the plain move)
  terrainpulse: {
    dmg: true,
    power(c) { const tn = c.b.terrain(); return tn && c.b.terrainActs(c.user, tn) ? c.mv.power * 2 : c.mv.power; },
    type(c) { const tn = c.b.terrain(); return tn && c.b.terrainActs(c.user, tn) ? TERRAIN_TYPE[tn] : undefined; },
  },
  // Rising Voltage x2 on Electric Terrain against a grounded target; Expanding Force x1.5 on Psychic Terrain and Misty Explosion x1.5 on Misty Terrain for a
  // grounded user; Psyblade x1.5 on Electric Terrain whatever the user stands on (MEASURED: a flying user still gets it)
  terrainbonus: {
    dmg: true,
    power(c) {
      const { b, mv, user, target } = c;
      const p = mv.power;
      switch (mv.name) {
        case 'Rising Voltage': return b.terrainActs(target, TN.ELECTRIC) ? p * 2 : p;
        case 'Expanding Force': return b.terrainActs(user, TN.PSYCHIC) ? idiv(p * 3, 2) : p;
        case 'Misty Explosion': return b.terrainActs(user, TN.MISTY) ? idiv(p * 3, 2) : p;
        case 'Psyblade': return b.terrain() === TN.ELECTRIC ? idiv(p * 3, 2) : p;
        default: return p;
      }
    },
  },
  // Steel Roller fails on a bare field and removes the terrain; Ice Spinner removes it too
  steelroller: {
    dmg: true,
    fail(c) { return c.b.terrain() ? null : 'failed'; },
    after(c) { c.b.clearTerrain(); },
  },
  terrainbreak: {
    dmg: true,
    after(c) { c.b.clearTerrain(); },
  },
  trickroom: {
    use(c) {
      const S = c.b.s;
      if (S.tr > 0) { S.tr = 0; c.b.emit({ t: 'field', k: 'trick-room', on: 0 }); return true; }
      S.tr = E.trickRoomTurns;
      c.b.emit({ t: 'field', k: 'trick-room', on: 1 });
      c.b.roomSet();
      return true;
    },
  },
  tailwind: {
    use(c) { const sd = c.b.s.sides[c.us]; if (sd.tw > 0) return false; sd.tw = E.tailwindTurns; c.b.emit({ t: 'screen', s: c.us, k: 'tw' }); return true; },
  },
  safeguard: {
    use(c) { const sd = c.b.s.sides[c.us]; if (sd.sg > 0) return false; sd.sg = E.safeguardTurns; c.b.emit({ t: 'screen', s: c.us, k: 'sg' }); return true; },
  },
  haze: {
    use(c) {
      for (let s = 0; s < 2; s++) { const m = c.b.act(s); for (const k of STAT_IDX) m.sg[k] = 0; c.b.emit({ t: 'stats-reset', s, m: m.slot }); }
      return true;
    },
  },
  defog: {
    use(c) {
      const { b } = c;
      b.changeStage(c.target, 'eva', -1, c.us, { move: true });
      for (let s = 0; s < 2; s++) {
        const sd = b.s.sides[s];
        if (sd.hz.sp || sd.hz.ts || sd.hz.sr || sd.hz.sw) { sd.hz = { sp: 0, ts: 0, sr: 0, sw: 0 }; b.emit({ t: 'hazard-clear', s, hz: 'all' }); }
      }
      for (const k of ['reflect', 'light', 'veil', 'mist', 'sg']) { const sd = b.s.sides[c.ts]; if (sd[k] > 0) { sd[k] = 0; b.emit({ t: 'screen-end', s: c.ts, k }); } }
      b.clearTerrain();   // MEASURED for the Scorched Field ("The scorched field settled")
      return true;
    },
  },

  // ------------------------------------------------------------------ protection and volatiles
  protect: {
    use(c) {
      const { b, user } = c;
      const kind = b.D.args.protect[c.id] || 1;
      const n = user.v.pstreak || 0;
      let ok = true;
      if (n > 0) { const den = Math.pow(E.protectDen, n > 4 ? 4 : n); ok = b.rand(den) === 0; }
      if (!ok) { user.v.pstreak = 0; return false; }
      user.v.prot = kind;
      user.v.pstreak = n + 1;
      b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'protect', pk: kind });
      return true;
    },
    keepStreak: true,
  },
  endure: {
    use(c) {
      const { b, user } = c;
      const n = user.v.pstreak || 0;
      let ok = true;
      if (n > 0) { const den = Math.pow(E.protectDen, n > 4 ? 4 : n); ok = b.rand(den) === 0; }
      if (!ok) { user.v.pstreak = 0; return false; }
      user.v.endure = 1;
      user.v.pstreak = n + 1;
      b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'endure' });
      return true;
    },
    keepStreak: true,
  },
  substitute: {
    use(c) {
      const { b, user } = c;
      const cost = idiv(user.mhp, 4);
      if (user.v.sub > 0 || user.hp <= cost) return false;
      b.dealDamage(user, cost < 1 ? 1 : cost, { src: 'substitute', from: -1 });
      user.v.sub = cost < 1 ? 1 : cost;
      b.emit({ t: 'sub-set', s: c.us, m: user.slot, n: user.v.sub });
      return true;
    },
  },
  focusenergy: { use(c) { if (c.user.v.fe) return false; c.user.v.fe = 1; c.b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'focus-energy' }); return true; } },
  disable: {
    use(c) {
      const { b, target } = c;
      const last = target.v.lastMv;
      if (!last || target.v.dis) return false;
      const slot = target.mv.find((x) => x.id === last);
      if (!slot || slot.pp <= 0) return false;
      target.v.dis = { mv: last, t: 5 };
      b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'disable', mv: last });
      return true;
    },
  },
  encore: {
    use(c) {
      const { b, target } = c;
      const last = target.v.lastMv;
      if (!last || target.v.enc) return false;
      const slot = target.mv.find((x) => x.id === last);
      if (!slot || slot.pp <= 0) return false;
      target.v.enc = { mv: last, t: 4 };
      b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'encore', mv: last });
      return true;
    },
  },
  taunt: {
    use(c) {
      const { b, target } = c;
      if (target.v.taunt || b.abFn(target, 'tauntImmune', true)) return false;
      target.v.taunt = 4;
      b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'taunt' });
      { const mh = b.itFn(target, 'mental'); if (mh) mh(b, target); }
      return true;
    },
  },
  trick: {
    use(c) {
      const { b, user, target } = c;
      if ((!user.it && !target.it) || b.abFn(target, 'stickyHold', true)) return false;
      const a = user.it; user.it = target.it; target.it = a;
      delete user.v.choice; delete target.v.choice;
      b.emit({ t: 'trick', s: c.us, m: user.slot, it: user.it, from: c.ts });
      b.emit({ t: 'trick', s: c.ts, m: target.slot, it: target.it, from: c.us });
      return true;
    },
  },
  destinybond: { use(c) { c.user.v.db = 1; c.b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'destiny-bond' }); return true; } },
  meanlook: {
    use(c) {
      const { b, target } = c;
      if (target.v.meanlook || b.hasType(target, T.GHOST)) return false;
      target.v.meanlook = 1;
      b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'trapped' });
      return true;
    },
  },
  ingrain: { use(c) { if (c.user.v.ingrain) return false; c.user.v.ingrain = 1; c.b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'ingrain' }); return true; } },
  aquaring: { use(c) { if (c.user.v.aring) return false; c.user.v.aring = 1; c.b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'aqua-ring' }); return true; } },
  curse: {
    use(c) {
      const { b, user, target } = c;
      if (b.hasType(user, T.GHOST)) {
        if (target.v.curse || user.hp <= 1) return false;
        b.dealDamage(user, fractionOf(user.mhp, 2), { src: 'curse', from: -1 });
        target.v.curse = 1;
        b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'curse' });
        return true;
      }
      b.changeStage(user, 'atk', 1, -1, {}); b.changeStage(user, 'def', 1, -1, {}); b.changeStage(user, 'spe', -1, -1, {});
      return true;
    },
  },
  lockon: { use(c) { c.user.v.lockon = 1; c.b.emit({ t: 'volatile', s: c.us, m: c.user.slot, v: 'lock-on' }); return true; } },
  memento: {
    use(c) {
      const { b, user, target } = c;
      b.changeStage(target, 'atk', -2, c.us, { move: true });
      b.changeStage(target, 'spa', -2, c.us, { move: true });
      b.dealDamage(user, user.hp, { src: 'memento', from: -1 });
      return true;
    },
  },
  healingwish: {
    use(c) {
      const { b, user, ef } = c;
      if (b.aliveCount(c.us) < 2) return false;
      b.s.sides[c.us].hw = ef.lunar ? 2 : 1;
      b.dealDamage(user, user.hp, { src: 'healing-wish', from: -1 });
      return true;
    },
  },
  roar: {
    use(c) {
      const { b } = c;
      if (b.aliveCount(c.ts) < 2) return false;
      return forceOut(b, c.ts, c.us);
    },
  },
  teleport: {
    use(c) {
      const { b } = c;
      if (b.aliveCount(c.us) < 2) return false;
      b.s.pause = c.us; b.emit({ t: 'pivot', s: c.us, m: c.user.slot });
      return true;
    },
  },
  partingshot: {
    use(c) {
      const { b } = c;
      b.changeStage(c.target, 'atk', -1, c.us, { move: true });
      b.changeStage(c.target, 'spa', -1, c.us, { move: true });
      if (b.aliveCount(c.us) > 1) { b.s.pause = c.us; b.emit({ t: 'pivot', s: c.us, m: c.user.slot }); }
      return true;
    },
  },
  metronome: {
    selfOnly: true,
    use(c) {
      const { b } = c;
      const pool = b.callablePool();
      const id = pool[b.rand(pool.length)];
      b.emit({ t: 'copy', s: c.us, mv: id, how: 'metronome' });
      b.useMove(c.us, id, { called: true, noPP: true });
      return true;
    },
  },
  sleeptalk: {
    selfOnly: true,
    use(c) {
      const { b, user } = c;
      if (user.s !== ST.SLP) return false;
      const ok = user.mv.filter((x) => !b.D.named.sleepTalkBan.has(x.id) && x.id !== c.id);
      if (!ok.length) return false;
      const pick = ok[b.rand(ok.length)];
      b.emit({ t: 'copy', s: c.us, mv: pick.id, how: 'sleep-talk' });
      b.useMove(c.us, pick.id, { called: true, noPP: true });
      return true;
    },
  },
  transform: {
    use(c) { return c.b.transformMon(c.user, c.target); },
  },
  nothing: { use(c) { c.b.emit({ t: 'noop', s: c.us, mv: c.id }); return true; } },
  futuresight: {
    use(c) {
      const { b, user } = c;
      const sd = b.s.sides[c.ts];
      if (sd.fut) return false;
      sd.fut = { t: 3, mv: c.id, from: c.us, level: user.level, st: { ...user.st }, ty: user.ty.slice() };
      b.emit({ t: 'volatile', s: c.ts, m: c.target.slot, v: 'future-sight' });
      return true;
    },
  },
  foresight: { use(c) { c.target.v.fore = 1; c.b.emit({ t: 'volatile', s: c.ts, m: c.target.slot, v: 'foresight' }); return true; } },
  mist: { selfOnly: true, use(c) { const sd = c.b.s.sides[c.us]; if (sd.mist > 0) return false; sd.mist = E.screenTurns; c.b.emit({ t: 'screen', s: c.us, k: 'mist' }); return true; } },
  settype: {
    use(c) {
      const { b, target } = c;
      const ty = b.D.args.setType[c.id];
      const cur = b.types(target);
      if (ty === undefined) return false;
      if (c.ef.add) {
        // Trick-or-Treat / Forest's Curse ADD a third type (measured in the real game: a Normal target stays Normal and is still immune to Ghost moves)
        if (cur.indexOf(ty) >= 0) return false;
        target.v.ty = cur.concat([ty]);
      } else {
        if (cur.length === 1 && cur[0] === ty) return false;
        target.v.ty = [ty];
      }
      // the event carries the type the move set / added (a consumer shows 'became X'); the full list is in the state
      b.emit(c.ef.add ? { t: 'type-change', s: c.ts, m: target.slot, ty: [ty], add: 1 } : { t: 'type-change', s: c.ts, m: target.slot, ty: [ty] });
      return true;
    },
  },
  smackdown: {
    dmg: true,
    prep(c) { c.groundsFlying = c.mv.name === 'Thousand Arrows'; },
    after(c) { const t = c.target; if (t.hp > 0 && !c.subHit) { t.v.smack = 1; delete t.v.mag; if (t.v.sinv === 'air') { delete t.v.sinv; delete t.v.chg; } } },
  },
  spite: {
    use(c) {
      const { b, target } = c;
      const last = target.v.lastMv;
      const slot = last ? target.mv.find((x) => x.id === last) : null;
      if (!slot || slot.pp <= 0) return false;
      slot.pp = slot.pp > 4 ? slot.pp - 4 : 0;
      b.emit({ t: 'noop', what: 'spite', s: c.ts, m: target.slot, mv: last });
      return true;
    },
  },
};

/** Kinds that have a handler (the support test uses this). */

// ======================================================================================================================================
// ROUND 2, batch A: move classes added after probing the real game with the oracle (pokemonarena/ROMDIFF.md section 7).  Every class below
// was run in SoulGold's own battle code first; what the probe could see (hp, stat stages, status, weather) is what the differential pins.
// ======================================================================================================================================
const STAGES7 = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
const keepPlain = { dmg: true };
Object.assign(MOVE_KINDS, {
  // ---- self set-up moves (MEASURED: hp cost and the stat deltas)
  clangorous: { use(c) { const { b, user } = c; const cost = idiv(user.mhp, 3); if (user.hp <= cost) return false; b.dealDamage(user, cost, { src: 'clangorous-soul', from: -1 }); for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) b.changeStage(user, k, 1, -1, {}); return true; } },
  filletaway: { use(c) { const { b, user } = c; const cost = idiv(user.mhp, 2); if (user.hp <= cost) return false; b.dealDamage(user, cost, { src: 'fillet-away', from: -1 }); for (const k of ['atk', 'spa', 'spe']) b.changeStage(user, k, 2, -1, {}); return true; } },
  noretreat: { use(c) { const { b, user } = c; if (user.v.noesc) return false; for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) b.changeStage(user, k, 1, -1, {}); user.v.noesc = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'noescape' }); return true; } },
  takeheart: { use(c) { const { b, user } = c; b.changeStage(user, 'spa', 1, -1, {}); b.changeStage(user, 'spd', 1, -1, {}); if (user.s !== ST.NONE) b.clearStatus(user, 'take-heart'); return true; } },
  charge: { use(c) { const { b, user } = c; b.changeStage(user, 'spd', 1, -1, {}); user.v.chgd = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'charged' }); return true; } },
  acupressure: { use(c) { const { b, user } = c; const ks = STAGES7.filter((k) => user.sg[k] < 6); if (!ks.length) return false; b.changeStage(user, ks[b.rand(ks.length)], 2, -1, {}); return true; } },
  // ---- moves that rewrite the foe's or both sides' stat stages (MEASURED: Power / Guard / Heart Swap, Psych Up, Topsy-Turvy, Venom Drench)
  venomdrench: { use(c) { const { b, target } = c; if (target.s !== ST.PSN && target.s !== ST.TOX) return false; for (const k of ['atk', 'spa', 'spe']) b.changeStage(target, k, -1, c.us, { move: true }); return true; } },
  topsy: { use(c) { const { b, target } = c; let any = false; for (const k of STAGES7) if (target.sg[k]) { target.sg[k] = -target.sg[k]; any = true; } if (!any) return false; b.emit({ t: 'stats-reset', s: c.ts, m: target.slot, inverted: 1 }); return true; } },
  powerswap: { use(c) { const { user, target } = c; for (const k of ['atk', 'spa']) { const x = user.sg[k]; user.sg[k] = target.sg[k]; target.sg[k] = x; } c.b.emit({ t: 'copy', s: c.us, m: user.slot, how: 'power-swap', sg: { ...user.sg } }); return true; } },
  guardswap: { use(c) { const { user, target } = c; for (const k of ['def', 'spd']) { const x = user.sg[k]; user.sg[k] = target.sg[k]; target.sg[k] = x; } c.b.emit({ t: 'copy', s: c.us, m: user.slot, how: 'guard-swap', sg: { ...user.sg } }); return true; } },
  heartswap: { use(c) { const { user, target } = c; for (const k of STAGES7) { const x = user.sg[k]; user.sg[k] = target.sg[k]; target.sg[k] = x; } c.b.emit({ t: 'copy', s: c.us, m: user.slot, how: 'heart-swap', sg: { ...user.sg } }); return true; } },
  psychup: { use(c) { const { user, target } = c; for (const k of STAGES7) user.sg[k] = target.sg[k]; c.b.emit({ t: 'copy', s: c.us, m: user.slot, how: 'psych-up', sg: { ...user.sg } }); return true; } },
  // ---- Stockpile / Spit Up / Swallow (MEASURED: +1 Def and +1 Sp.Def per stockpile, Spit Up 100 BP per stack, Swallow heals 1/4, 1/2, all; both reset the boosts)
  stockpile: {
    use(c) {
      const { b, user } = c;
      const n = user.v.stk || 0; if (n >= 3) return false;
      const d = b.changeStage(user, 'def', 1, -1, {}), s = b.changeStage(user, 'spd', 1, -1, {});
      user.v.stk = n + 1; user.v.stkd = (user.v.stkd || 0) + d; user.v.stks = (user.v.stks || 0) + s;
      return true;
    },
  },
  spitup: {
    dmg: true,
    fail(c) { return c.user.v.stk ? null : 'failed'; },
    power(c) { return 100 * (c.user.v.stk || 1); },
    after(c) { stockpileEnd(c.b, c.user); },
  },
  swallow: {
    use(c) {
      const { b, user } = c; const n = user.v.stk || 0; if (!n || user.hp >= user.mhp) return false;
      b.healMon(user, n === 1 ? idiv(user.mhp, 4) : n === 2 ? idiv(user.mhp, 2) : user.mhp, { src: 'swallow' });
      stockpileEnd(b, user); return true;
    },
  },
  nightmare: { use(c) { const { b, target } = c; if (target.s !== ST.SLP || target.v.nm) return false; target.v.nm = 1; b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'nightmare' }); return true; } },
  luckychant: { use(c) { const sd = c.b.s.sides[c.us]; if (sd.luckyChant > 0) return false; sd.luckyChant = 5; c.b.emit({ t: 'screen', s: c.us, k: 'luckyChant' }); return true; } },
  // ---- plain damage moves with one twist
  pursuit: keepPlain,
  frustration: { dmg: true, power() { return 1; } },                                         // friendship 255 assumed (ENGINE.md), so the same bound as Return's 102
  beatup: {
    dmg: true,
    hits(c) { let n = 0; for (const x of c.b.s.sides[c.us].team) if (x.hp > 0) n++; return n || 1; },
    perHit(c, i) { const sd = c.b.s.sides[c.us]; const alive = sd.team.filter((x) => x.hp > 0); const m = alive[i] || c.user; const sp = c.b.pack.species[m.sp]; c.bp = idiv(sp.baseStats.atk, 10) + 5; },
  },
  retaliate: { dmg: true, power(c) { const sd = c.b.s.sides[c.us]; return sd.lastFaint === c.b.s.turn - 1 || sd.lastFaint === c.b.s.turn ? 140 : 70; } },
  synchro: { dmg: true, fail(c) { const a = c.b.types(c.user), t = c.b.types(c.target); return a.some((x) => t.indexOf(x) >= 0) ? null : 'failed'; } },
  photon: { dmg: true, cat(c) { const u = c.user; return applyStage(u.st.atk, u.sg.atk) > applyStage(u.st.spa, u.sg.spa) ? CAT.PHYSICAL : CAT.SPECIAL; } },
  typeofitem: { dmg: true, type(c) { const t = c.b.D.named.typeItems[c.user.it]; return t !== undefined && c.b.pack.items[c.user.it].holdEffect === 89 ? t : undefined; } }, // Judgment / Techno Blast / Multi-Attack: only a Plate is a supported item
  rollout: {
    dmg: true,
    prep(c) { const r = c.user.v.roll; const n = r && r.mv === c.id ? r.n : 0; c.bp = c.power * (1 << Math.min(n, 4)); },
    after(c) {   // MEASURED: the user is locked into Rollout until it has hit five times or misses
      const u = c.user; const r = u.v.roll; u.v.roll = { mv: c.id, n: (r && r.mv === c.id ? r.n : 0) + 1 };
      if (u.v.roll.n >= 5) delete u.v.roll; else if (!u.v.ramp && !c.o.rampage) u.v.ramp = { mv: c.id, t: 4, nc: 1 };
      if (c.b.abFn(u, 'rollingStones') && u.hp > 0) c.b.changeStage(u, 'spe', 1, -1, {});
    },
    onMiss(c) { delete c.user.v.roll; if (c.user.v.ramp && c.user.v.ramp.nc) delete c.user.v.ramp; },
  },
  hydrosteam: { dmg: true, prep(c) { if (c.b.wx() === WX.SUN) c.sunWater = true; } },
  // ---- ability and item moves
  abilityset: {
    use(c) {
      const { b, target } = c; const id = b.D.abilityByName[c.mv.name === 'Simple Beam' ? 'Simple' : 'Insomnia']; if (id === undefined || target.ab === id || target.hp <= 0) return false;
      target.ab = id; b.emit({ t: 'copy', s: c.ts, m: target.slot, how: 'ability-set', ab: id }); return true;
    },
  },
  roleplay: { use(c) { const { b, user, target } = c; if (!target.ab || user.ab === target.ab) return false; user.ab = target.ab; b.emit({ t: 'copy', s: c.us, m: user.slot, how: 'role-play', ab: user.ab }); return true; } },
  skillswap: { use(c) { const { b, user, target } = c; if (!user.ab || !target.ab) return false; const x = user.ab; user.ab = target.ab; target.ab = x; b.emit({ t: 'copy', s: c.us, m: user.slot, how: 'skill-swap', ab: user.ab }); return true; } },
  recycle: { use(c) { const { b, user } = c; if (user.it || !user.used) return false; user.it = user.used; user.used = 0; b.emit({ t: 'item', s: c.us, m: user.slot, it: user.it, fx: 'recycle' }); return true; } },
  trumpcard: { dmg: true, power(c) { const s = c.user.mv.find((x) => x.id === c.id); const pp = s ? s.pp : 0; return pp <= 0 ? 200 : pp === 1 ? 160 : pp === 2 ? 120 : pp === 3 ? 80 : 40; } },
  psychoshift: { use(c) { const { b, user, target } = c; if (user.s === ST.NONE || target.s !== ST.NONE) return false; const st = user.s; if (!b.setStatus(target, st, user, { fx: 'psycho-shift' })) return false; b.clearStatus(user, 'psycho-shift'); return true; } },
  healtarget: { use(c) { const { b, target } = c; if (target.hp >= target.mhp) return false; const grass = c.mv.name === 'Floral Healing' && b.terrain() === TN.GRASSY; b.healMon(target, grass ? idiv(target.mhp * 2, 3) : idiv(target.mhp, 2), { src: 'move' }); return true; } },
  selfhealcure: { use(c) { const { b, user } = c; if (user.hp >= user.mhp && user.s === ST.NONE) return false; if (user.hp < user.mhp) b.healMon(user, idiv(user.mhp, 4), { src: 'move' }); if (user.s !== ST.NONE) b.clearStatus(user, 'cure'); return true; } },
  tidyup: {
    use(c) {
      const { b, user } = c;
      for (let s = 0; s < 2; s++) { const sd = b.s.sides[s]; if (sd.hz.sp || sd.hz.ts || sd.hz.sr || sd.hz.sw) { sd.hz = { sp: 0, ts: 0, sr: 0, sw: 0 }; b.emit({ t: 'hazard-clear', s, hz: 'all' }); } const m = b.act(s); if (m && m.v.sub) { delete m.v.sub; b.emit({ t: 'sub-break', s, m: m.slot }); } }
      b.changeStage(user, 'atk', 1, -1, {}); b.changeStage(user, 'spe', 1, -1, {}); return true;
    },
  },
  chilly: {
    use(c) {
      const { b, user } = c;
      b.setWeather(WX.SNOW, user);
      if (user.hp > 0 && b.aliveCount(c.us) > 1) { b.s.pause = c.us; b.emit({ t: 'pivot', s: c.us, m: user.slot }); }
      return true;
    },
  },
  electrify: { use(c) { const { b, target } = c; if (target.v.elec) return false; target.v.elec = 1; b.emit({ t: 'volatile', s: c.ts, m: target.slot, v: 'electrify' }); return true; } },
  magiccoat: { selfOnly: true, use(c) { const { b, user } = c; if (user.v.mcoat) return false; user.v.mcoat = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'magic-coat' }); return true; } },
  snatch: { selfOnly: true, use(c) { const { b, user } = c; user.v.snatch = 1; b.emit({ t: 'volatile', s: c.us, m: user.slot, v: 'snatch' }); return true; } },
  mimic: {
    use(c) {
      const { b, user, target } = c; const last = target.v.lastMv; if (!last || last === c.id || user.mv.some((x) => x.id === last)) return false;
      const i = user.mv.findIndex((x) => x.id === c.id); if (i < 0) return false;
      const mx = Math.min(5, b.pack.moves[last].pp);
      user.mv[i] = { id: last, pp: mx, mx }; b.emit({ t: 'copy', s: c.us, m: user.slot, mv: last, how: 'mimic' }); return true;
    },
  },
  mirrormove: { selfOnly: true, use(c) { const { b, target } = c; const last = target.v.lastMv; if (!last || last === c.id || b.D.named.sleepTalkBan.has(last)) return false; b.emit({ t: 'copy', s: c.us, mv: last, how: 'mirror-move' }); b.useMove(c.us, last, { called: true, noPP: true }); return true; } },
  naturepower: { selfOnly: true, use(c) { const { b } = c; const id = b.D.moveByName[NATURE_POWER[b.terrain()] || 'Tri Attack']; b.emit({ t: 'copy', s: c.us, mv: id, how: 'nature-power' }); b.useMove(c.us, id, { called: true, noPP: true }); return true; } },
});
function stockpileEnd(b, user) {
  const d = user.v.stkd || 0, s = user.v.stks || 0;
  if (d) b.changeStage(user, 'def', -d, -1, {});
  if (s) b.changeStage(user, 'spd', -s, -1, {});
  delete user.v.stk; delete user.v.stkd; delete user.v.stks;
}

export const IMPLEMENTED_KINDS = new Set(Object.keys(MOVE_KINDS));
export { forceOut, healFrac, pokeMod };

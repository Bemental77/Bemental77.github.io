// pokemonarena/js/engine_items.js -- held-item behaviour for the battle engine.  Leaf module.
//
// Items are looked up by the ROM's own HOLD-EFFECT id (item record byte +0x1c, decoded as pack.items[i].holdEffect) with
// the record's param byte (+0x1d, holdEffectParam).  The ids below were anchored to named items by the engine test
// (e.g. 41 = Leftovers, 60 = Life Orb, 29 = Choice Band, 67 = Focus Sash), so a shifted table fails loudly.  Items that
// share a hold effect but differ in what they boost (type items, plates) are resolved through the decoded item NAME
// (engine_data.js NAMED.typeItems).  Items with hold effect 0 are inert and therefore trivially supported.
//
// HOOKS (all optional; `b` Battle, `m` the holder, `c` move context): bp atk final acc spe (attacker side),
// def finalDef evade (defender side), order, residual, lateResidual (after the status damage: Flame / Toxic Orb), onStart, onHit(b,c,dealt), afterAttack(b,c), onHp(b,m,from),
// onStatus(b,m,st), onConfuse, onDropItem, onMiss, sash, onKO, critBoost, extends, weight; flags: choiceLock, floats,
// boots, skipCharge, shedShell, bigRoot, screenExt, noStatus, covert, blockDrop.
// Every modifier value is `assumed` (expansion default); ENGINE.md lists them.

import { T, CAT, ST, WX, E, TN } from './engine_data.js';
import { forceOut } from './engine_moves.js';
import { fractionOf, idiv } from './engine_calc.js';

export const HOLD = Object.freeze({
  ORAN: 1, CHERI: 2, CHESTO: 3, PECHA: 4, RAWST: 5, ASPEAR: 6, PERSIM: 8, LUM: 9, FIGY: 10, WIKI: 11, MAGO: 12, AGUAV: 13, IAPAPA: 14,
  LIECHI: 15, GANLON: 16, SALAC: 17, PETAYA: 18, APICOT: 19, BRIGHT_POWDER: 22, WHITE_HERB: 23, QUICK_CLAW: 26, CHOICE_BAND: 29,
  KINGS_ROCK: 30, SCOPE_LENS: 40, LEFTOVERS: 41, LIGHT_BALL: 42, TYPE_POWER: 43, SHELL_BELL: 44, THICK_CLUB: 47, CHOICE_SCARF: 49,
  CHOICE_SPECS: 50, DAMP_ROCK: 51, HEAT_ROCK: 53, ICY_ROCK: 54, LIGHT_CLAY: 55, SMOOTH_ROCK: 56, POWER_HERB: 57, BIG_ROOT: 58,
  EXPERT_BELT: 59, LIFE_ORB: 60, MUSCLE_BAND: 62, WIDE_LENS: 63, WISE_GLASSES: 64, ZOOM_LENS: 65, LAGGING_TAIL: 66, FOCUS_SASH: 67,
  FLAME_ORB: 68, TOXIC_ORB: 69, BLACK_SLUDGE: 72, SHED_SHELL: 74, RESIST_BERRY: 80, SITRUS: 82, PLATE: 89, EVIOLITE: 91,
  ASSAULT_VEST: 92, ROCKY_HELMET: 95, AIR_BALLOON: 96, WEAKNESS_POLICY: 107, HEAVY_BOOTS: 119, CLEAR_AMULET: 122, COVERT_CLOAK: 125,
});

const H = {};
const add = (id, hooks) => { H[id] = Object.freeze(hooks); };
const param = (b, m) => { const it = b.pack.items[m.it]; return it ? it.holdEffectParam : 0; };
const speciesIs = (b, m, name) => b.pack.species[m.sp] && b.pack.species[m.sp].name === name;
const typeOfItem = (b, itemId) => b.D.named.typeItems[itemId];

// ---- healing and recovery
add(HOLD.LEFTOVERS, { residual(b, m) { if (m.hp < m.mhp) { b.reveal(m, 'i'); b.healMon(m, fractionOf(m.mhp, 16), { src: 'leftovers' }); } } });
add(HOLD.BLACK_SLUDGE, {
  residual(b, m) {
    b.reveal(m, 'i');
    if (b.hasType(m, T.POISON)) b.healMon(m, fractionOf(m.mhp, 16), { src: 'black-sludge' });
    else if (!b.abFn(m, 'magicGuard')) b.dealDamage(m, fractionOf(m.mhp, 8), { src: 'black-sludge', from: -1 });
  },
});
add(HOLD.SHELL_BELL, {
  afterAttack(b, c) { const u = c.user; if (c.total > 0 && u.hp > 0 && u.hp < u.mhp) { b.reveal(u, 'i'); b.healMon(u, idiv(c.total, 8) || 1, { src: 'shell-bell' }); } },
});
add(HOLD.SITRUS, { onHp(b, m) { if (m.hp * 2 <= m.mhp) { b.consumeItem(m, 'sitrus'); b.healMon(m, fractionOf(m.mhp, 4) * (b.abFn(m, 'ripen') ? 2 : 1), { src: 'sitrus' }); } } });
add(HOLD.ORAN, { onHp(b, m) { if (m.hp * 2 <= m.mhp) { const n = (param(b, m) || 10) * (b.abFn(m, 'ripen') ? 2 : 1); b.consumeItem(m, 'oran'); b.healMon(m, n, { src: 'oran' }); } } });
for (const id of [HOLD.FIGY, HOLD.WIKI, HOLD.MAGO, HOLD.AGUAV, HOLD.IAPAPA]) {
  add(id, { onHp(b, m) { if (m.hp * (b.abFn(m, 'gluttony') ? 2 : 4) <= m.mhp) { b.consumeItem(m, 'pinch-heal'); b.healMon(m, fractionOf(m.mhp, 3) * (b.abFn(m, 'ripen') ? 2 : 1), { src: 'berry' }); } } });
}
const statBerry = (stat) => ({ onHp(b, m) { if (m.hp * (b.abFn(m, 'gluttony') ? 2 : 4) <= m.mhp) { b.consumeItem(m, 'stat-berry'); b.changeStage(m, stat, b.abFn(m, 'ripen') ? 2 : 1, -1, {}); } } });
add(HOLD.LIECHI, statBerry('atk'));
add(HOLD.GANLON, statBerry('def'));
add(HOLD.SALAC, statBerry('spe'));
add(HOLD.PETAYA, statBerry('spa'));
add(HOLD.APICOT, statBerry('spd'));

// ---- status cures
const cureBerry = (match) => ({
  onStatus(b, m, st) { if (match(st)) { b.consumeItem(m, 'cure'); b.clearStatus(m, 'berry'); } },
});
add(HOLD.CHERI, cureBerry((st) => st === ST.PAR));
add(HOLD.CHESTO, cureBerry((st) => st === ST.SLP));
add(HOLD.PECHA, cureBerry((st) => st === ST.PSN || st === ST.TOX));
add(HOLD.RAWST, cureBerry((st) => st === ST.BRN));
add(HOLD.ASPEAR, cureBerry((st) => st === ST.FRZ || st === ST.FBT));
add(HOLD.LUM, {
  onStatus(b, m) { b.consumeItem(m, 'cure'); b.clearStatus(m, 'lum'); },
  onConfuse(b, m) { b.consumeItem(m, 'cure-confusion'); delete m.v.conf; b.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'confusion' }); },
});
add(HOLD.PERSIM, { onConfuse(b, m) { b.consumeItem(m, 'cure-confusion'); delete m.v.conf; b.emit({ t: 'volatile-end', s: m.side, m: m.slot, v: 'confusion' }); } });
add(HOLD.WHITE_HERB, {
  onDropItem(b, m) {
    let any = false;
    for (const k of ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']) if (m.sg[k] < 0) { m.sg[k] = 0; any = true; }
    if (any) { b.consumeItem(m, 'white-herb'); b.emit({ t: 'stats-reset', s: m.side, m: m.slot, partial: 1 }); }
  },
});
add(HOLD.FLAME_ORB, { lateResidual(b, m) { if (m.s === ST.NONE) { b.reveal(m, 'i'); b.setStatus(m, ST.BRN, null, { fx: 'flame-orb', silent: true }); } } });
add(HOLD.TOXIC_ORB, { lateResidual(b, m) { if (m.s === ST.NONE) { b.reveal(m, 'i'); b.setStatus(m, ST.TOX, null, { fx: 'toxic-orb', silent: true }); } } });

// ---- damage modifiers
add(HOLD.CHOICE_BAND, { choiceLock: true, atk(b, c) { return c.cat === CAT.PHYSICAL ? 6144 : 0; } });
add(HOLD.CHOICE_SPECS, { choiceLock: true, atk(b, c) { return c.cat === CAT.SPECIAL ? 6144 : 0; } });
add(HOLD.CHOICE_SCARF, { choiceLock: true, spe() { return 6144; } });
add(HOLD.LIFE_ORB, {
  final(b, c) { return c.cat !== CAT.STATUS ? E.lifeOrbMod : 0; },
  afterAttack(b, c) {
    const u = c.user;
    if (c.total > 0 && u.hp > 0 && !b.abFn(u, 'magicGuard') && !b.abFn(u, 'sheerForce')) { b.reveal(u, 'i'); b.dealDamage(u, fractionOf(u.mhp, 10), { src: 'life-orb', from: -1 }); }
  },
});
add(HOLD.EXPERT_BELT, { final(b, c) { return c.eff > 4096 ? 4915 : 0; } });
add(HOLD.MUSCLE_BAND, { bp(b, c) { return c.cat === CAT.PHYSICAL ? 4505 : 0; } });
add(HOLD.WISE_GLASSES, { bp(b, c) { return c.cat === CAT.SPECIAL ? 4505 : 0; } });
add(HOLD.TYPE_POWER, { bp(b, c) { return typeOfItem(b, c.user.it) === c.type ? 4915 : 0; } });
add(HOLD.PLATE, { bp(b, c) { return typeOfItem(b, c.user.it) === c.type ? 4915 : 0; } });
add(HOLD.LIGHT_BALL, { atk(b, c) { return speciesIs(b, c.user, 'Pikachu') ? 8192 : 0; } });
add(HOLD.THICK_CLUB, { atk(b, c) { return c.cat === CAT.PHYSICAL && (speciesIs(b, c.user, 'Cubone') || speciesIs(b, c.user, 'Marowak')) ? 8192 : 0; } });
add(HOLD.ASSAULT_VEST, { noStatus: true, def(b, c) { return c.cat === CAT.SPECIAL ? 6144 : 0; } });
add(HOLD.EVIOLITE, { def(b, c) { const sp = b.pack.species[c.target.sp]; return sp && sp.evolutions.length > 0 ? 6144 : 0; } });
add(HOLD.SCOPE_LENS, { critBoost() { return 1; } });
add(HOLD.WIDE_LENS, { acc() { return 4505; } });
add(HOLD.ZOOM_LENS, { acc(b, c) { return c.target.v.moved ? 4915 : 0; } });
add(HOLD.BRIGHT_POWDER, { evade() { return 3686; } });
add(HOLD.QUICK_CLAW, { order(b, m) { return b.rand(5) === 0 ? 1 : 0; } });
add(HOLD.LAGGING_TAIL, { order() { return -1; } });
add(HOLD.KINGS_ROCK, {
  afterAttack(b, c) {
    const t = c.target;
    if (c.total > 0 && t.hp > 0 && !t.v.moved && !t.v.flinch && !c.mv.additional.some((a) => a.effect === 9) && b.rand(100) < 10) t.v.flinch = 1;
  },
});
add(HOLD.RESIST_BERRY, {
  finalDef(b, c) {
    const t = c.target;
    const ty = param(b, t);
    if (ty !== c.type) return 0;
    if (c.eff <= 4096 && ty !== T.NORMAL) return 0;
    c.resist = 1;
    return 2048;
  },
});
add(HOLD.WEAKNESS_POLICY, {
  onHit(b, c, dealt) {
    const t = c.target;
    if (dealt > 0 && c.eff > 4096 && t.hp > 0) { b.consumeItem(t, 'weakness-policy'); b.changeStage(t, 'atk', 2, -1, {}); b.changeStage(t, 'spa', 2, -1, {}); }
  },
});
add(HOLD.ROCKY_HELMET, {
  onHit(b, c, dealt) {
    const a = c.user;
    if (c.contact && a.hp > 0 && !b.abFn(a, 'magicGuard')) { b.reveal(c.target, 'i'); b.dealDamage(a, fractionOf(a.mhp, 6), { src: 'rocky-helmet', from: -1 }); }
  },
});
add(HOLD.AIR_BALLOON, {
  floats: true,
  onHit(b, c, dealt) { const t = c.target; if (dealt > 0 && t.it) { b.emit({ t: 'item', s: t.side, m: t.slot, it: t.it, fx: 'balloon-pop', used: 1 }); b.reveal(t, 'i'); t.used = t.it; t.it = 0; } },
});
add(HOLD.FOCUS_SASH, { sash() { return true; } });
add(HOLD.HEAVY_BOOTS, { boots: true });
add(HOLD.SHED_SHELL, { shedShell: true });
add(HOLD.POWER_HERB, { skipCharge() { return true; } });
add(HOLD.BIG_ROOT, { bigRoot: true });
add(HOLD.LIGHT_CLAY, { screenExt: true });
add(HOLD.COVERT_CLOAK, { covert: true });
add(HOLD.CLEAR_AMULET, { blockDrop: true });
const rock = (w) => ({ extends(b, m, weather) { return weather === w; } });
add(HOLD.DAMP_ROCK, rock(WX.RAIN));
add(HOLD.HEAT_ROCK, rock(WX.SUN));
add(HOLD.ICY_ROCK, rock(WX.HAIL));
add(HOLD.SMOOTH_ROCK, rock(WX.SAND));

// ======================================================================================================================================
// ROUND 2, batch A: held items. Numbers marked MEASURED were read from the real game with the oracle (pokemonarena/ROMDIFF.md section 7);
// the rest follow the item's ROM description text.  Items with no battle effect in singles are listed as inert so that holding them is legal.
// ======================================================================================================================================
const HX2 = { DESTINY_KNOT: 73, RED_CARD: 97, EJECT_BUTTON: 100, TERRAIN_EXTENDER: 110, EJECT_PACK: 116, BLUNDER_POLICY: 118, MIRROR_HERB2: 123 };
const HX = {
  MACHO_BRACE: 24, SOOTHE_BELL: 27, MENTAL_HERB: 28, LUCK_INCENSE: 31, PURE_INCENSE: 32, SOUL_DEW: 33, DEEP_SEA_TOOTH: 34, DEEP_SEA_SCALE: 35, SMOKE_BALL: 36, EVERSTONE: 37,
  FOCUS_BAND: 38, LUCKY_EGG: 39, LUCKY_PUNCH: 45, METAL_POWDER: 46, LEEK: 48, GRIP_CLAW: 52, METRONOME: 61, STICKY_BARB: 70, IRON_BALL: 71, QUICK_POWDER: 75,
  ADAMANT_ORB: 76, LUSTROUS_ORB: 77, GRISEOUS_ORB: 78, ENIGMA_BERRY: 79, POWER_ITEM: 81, MICLE: 83, CUSTAP: 84, JABOCA: 85, ROWAP: 86, KEE: 87, MARANGA: 88, FLOAT_STONE: 90,
  GEM: 94, RED_CARD: 97, RING_TARGET: 98, BINDING_BAND: 99, EJECT_BUTTON: 100, ABSORB_BULB: 101, CELL_BATTERY: 102, SAFETY_GOGGLES: 104, LUMINOUS_MOSS: 105, SNOWBALL: 106,
  PROTECTIVE_PADS: 109, ADRENALINE_ORB: 112, UTILITY_UMBRELLA: 115, EJECT_PACK: 116, ROOM_SERVICE: 117, THROAT_SPRAY: 120, ABILITY_SHIELD: 121, MIRROR_HERB: 123,
  PUNCHING_GLOVE: 124, LOADED_DICE: 126, BOOSTER_ENERGY: 127, BERSERK_GENE: 129, LEPPA: 7, LANSAT: 20, STARF: 21, EXP_SHARE: 25,
};
const gemType = (b, id) => { const it = b.pack.items[id]; const m = it && /^(.+) Gem$/.exec(it.name); return m ? T[m[1].toUpperCase()] : undefined; };
const named = (b, m, ...ns) => { const s = b.pack.species[m.sp]; return !!s && ns.indexOf(s.name) >= 0; };

// no effect on a singles battle: the item may be held, nothing happens
for (const id of [HX.SOOTHE_BELL, HX.LUCK_INCENSE, HX.PURE_INCENSE, HX.SMOKE_BALL, HX.EVERSTONE, HX.LUCKY_EGG, HX.EXP_SHARE, HX.ADRENALINE_ORB]) add(id, { inert: true });
add(HX.ABILITY_SHIELD, { abilityShield: true });   // the holder's ability cannot be suppressed (Neutralizing Gas)
// Booster Energy (MEASURED at switch-in): a Protosynthesis / Quark Drive holder uses it up when the sun / Electric Terrain is NOT already there, and keeps it when it is
add(HX.BOOSTER_ENERGY, {
  onStart(b, m) {
    if (m.v.be) return;
    const f = b.abFn(m, 'boostable');
    if (f === undefined || f === false) return;
    const live = f === 'sun' ? b.wx() === WX.SUN : b.terrain() === TN.ELECTRIC;
    if (live) return;
    b.consumeItem(m, 'booster-energy'); m.v.be = 1;
  },
});

// switching items (a held item that makes a Pokemon leave): Red Card sends the ATTACKER out, Eject Button / Eject Pack let the HOLDER choose a replacement
add(HX2.RED_CARD, { onHit(b, c, dealt) { const t = c.target, a = c.user; if (dealt > 0 && t.hp > 0 && a.hp > 0 && b.aliveCount(c.us) > 1) { b.consumeItem(t, 'red-card'); forceOut(b, c.us, c.ts); } } });
add(HX2.EJECT_BUTTON, { onHit(b, c, dealt) { const t = c.target; if (dealt > 0 && t.hp > 0 && b.aliveCount(c.ts) > 1 && b.s.pause < 0) { b.consumeItem(t, 'eject-button'); b.s.pause = c.ts; b.emit({ t: 'pivot', s: c.ts, m: t.slot }); } } });
add(HX2.EJECT_PACK, { onDropItem(b, m) { if (m.hp > 0 && b.aliveCount(m.side) > 1 && b.s.pause < 0) { b.consumeItem(m, 'eject-pack'); b.s.pause = m.side; b.emit({ t: 'pivot', s: m.side, m: m.slot }); } } });
add(HX2.BLUNDER_POLICY, { onMiss(b, m) { b.consumeItem(m, 'blunder-policy'); b.changeStage(m, 'spe', 2, -1, {}); } });
add(HX2.MIRROR_HERB2, { mirror: true });
add(HX2.DESTINY_KNOT, { loveKnot: true });
// terrain: the Extender makes a terrain the holder sets last 8 turns; a Seed is used up by its own terrain (+1 Def for Electric / Grassy, +1 Sp. Def for Misty / Psychic; MEASURED,
// a Grassy Seed kept under Electric Terrain)
add(HX2.TERRAIN_EXTENDER, { terrainExt: true });
const SEED = { 'Electric Seed': [TN.ELECTRIC, 'def'], 'Grassy Seed': [TN.GRASSY, 'def'], 'Misty Seed': [TN.MISTY, 'spd'], 'Psychic Seed': [TN.PSYCHIC, 'spd'] };
const seedFire = (b, m, tn) => { const it = b.pack.items[m.it]; const s = it && SEED[it.name]; if (s && s[0] === tn && m.hp > 0) { b.consumeItem(m, 'terrain-seed'); b.changeStage(m, s[1], 1, -1, {}); } };
add(111, { onTerrain(b, m, tn) { seedFire(b, m, tn); }, onStart(b, m) { if (b.terrain()) seedFire(b, m, b.terrain()); } });

// speed
add(HX.POWER_ITEM, { spe() { return 2048; } });
add(HX.MACHO_BRACE, { spe() { return 2048; } });
add(HX.IRON_BALL, { spe() { return 2048; }, ironBall: true });
add(HX.QUICK_POWDER, { spe(b, m) { return named(b, m, 'Ditto') ? 8192 : 0; } });
// species items (MEASURED: Metal Powder halves physical damage to Ditto, Deep Sea Scale halves special damage, Deep Sea Tooth doubles Clamperl's special attack)
add(HX.METAL_POWDER, { def(b, c) { return c.cat === CAT.PHYSICAL && named(b, c.target, 'Ditto') ? 8192 : 0; } });
add(HX.DEEP_SEA_SCALE, { def(b, c) { return c.cat === CAT.SPECIAL && named(b, c.target, 'Clamperl') ? 8192 : 0; } });
add(HX.DEEP_SEA_TOOTH, { atk(b, c) { return c.cat === CAT.SPECIAL && named(b, c.user, 'Clamperl') ? 8192 : 0; } });
add(HX.LEEK, { critBoost(b, c) { return named(b, c.user, "Farfetch'd", "Sirfetch'd") ? 2 : 0; } });
add(HX.LUCKY_PUNCH, { critBoost(b, c) { return named(b, c.user, 'Chansey') ? 2 : 0; } });
// Ogerpon masks (MEASURED: Cornerstone / Hearthflame / Wellspring Mask on Ogerpon forms 1416-1419 and Marill; every Ogerpon form gets x1.2 on every attack with any of the three masks, Marill gets nothing)
add(128, { bp(b, c) { return named(b, c.user, 'Ogerpon') ? 4915 : 0; } });
add(HX.SOUL_DEW, { bp(b, c) { return named(b, c.user, 'Latios', 'Latias') && (c.type === T.PSYCHIC || c.type === T.DRAGON) ? 4915 : 0; } });
add(HX.ADAMANT_ORB, { bp(b, c) { return named(b, c.user, 'Dialga') && (c.type === T.DRAGON || c.type === T.STEEL) ? 4915 : 0; } });
add(HX.LUSTROUS_ORB, { bp(b, c) { return named(b, c.user, 'Palkia') && (c.type === T.DRAGON || c.type === T.WATER) ? 4915 : 0; } });
add(HX.GRISEOUS_ORB, { bp(b, c) { return named(b, c.user, 'Giratina') && (c.type === T.DRAGON || c.type === T.GHOST) ? 4915 : 0; } });

// type gems (MEASURED: x1.3 once, the gem is used up by a damaging move of its type)
add(HX.GEM, {
  bp(b, c) { if (c.mv.power > 0 && gemType(b, c.user.it) === c.type) { c.gemUsed = 1; return 5325; } return 0; },
  afterAttack(b, c) { if (c.gemUsed) { c.gemUsed = 0; b.consumeItem(c.user, 'gem'); } },
});
// moves that carry a bonus: Punching Glove x1.1 for punches (MEASURED) and no contact; Metronome +20 percent per consecutive use, applied to the FINAL damage (MEASURED: only a final-step factor reproduces 30 and 35 on uses 2 and 3)
add(HX.PUNCHING_GLOVE, { noContact: true, bp(b, c) { return c.mv.flags.punch ? 4505 : 0; } });
add(HX.PROTECTIVE_PADS, { noContact: true });
add(HX.METRONOME, {
  final(b, c) { const v = c.user.v.metro; return v && v.mv === c.id && v.n > 0 ? 4096 + 819 * (v.n > 5 ? 5 : v.n) : 0; },
  afterAttack(b, c) { const u = c.user, v = u.v.metro; u.v.metro = v && v.mv === c.id ? { mv: c.id, n: v.n + 1 } : { mv: c.id, n: 1 }; },
});
add(HX.LOADED_DICE, { loadedDice: true });
add(HX.BINDING_BAND, { bindBand: true });
add(HX.GRIP_CLAW, { gripClaw: true });
add(HX.FLOAT_STONE, { weightHalf: true });
add(HX.RING_TARGET, { ringTarget: true });
add(HX.SAFETY_GOGGLES, { goggles: true, weatherImmune: true });
add(HX.UTILITY_UMBRELLA, { umbrella: true });

// hit reactions (MEASURED): Absorb Bulb / Luminous Moss on Water, Cell Battery on Electric, Snowball on Ice, Kee / Maranga after a physical / special hit
const onType = (type, stat, d) => ({ onHit(b, c, dealt) { const t = c.target; if (dealt > 0 && c.type === type && t.hp > 0) { b.consumeItem(t, 'hit-boost'); b.changeStage(t, stat, d, -1, {}); } } });
add(HX.ABSORB_BULB, onType(T.WATER, 'spa', 1)); add(HX.CELL_BATTERY, onType(T.ELECTRIC, 'atk', 1)); add(HX.LUMINOUS_MOSS, onType(T.WATER, 'spd', 1)); add(HX.SNOWBALL, onType(T.ICE, 'atk', 1));
const onCat = (cat, stat) => ({ onHit(b, c, dealt) { const t = c.target; if (dealt > 0 && c.cat === cat && t.hp > 0) { b.consumeItem(t, 'hit-boost'); b.changeStage(t, stat, 1, -1, {}); } } });
add(HX.KEE, onCat(CAT.PHYSICAL, 'def')); add(HX.MARANGA, onCat(CAT.SPECIAL, 'spd'));
// Jaboca / Rowap: the attacker loses 1/8 of ITS max HP (MEASURED)
const thorn = (cat) => ({ onHit(b, c, dealt) { const t = c.target, a = c.user; if (dealt > 0 && c.cat === cat && a.hp > 0 && !b.abFn(a, 'magicGuard')) { b.consumeItem(t, 'thorn-berry'); b.dealDamage(a, fractionOf(a.mhp, 8), { src: 'jaboca', from: c.ts }); } } });
add(HX.JABOCA, thorn(CAT.PHYSICAL)); add(HX.ROWAP, thorn(CAT.SPECIAL));
add(HX.ENIGMA_BERRY, { onHit(b, c, dealt) { const t = c.target; if (dealt > 0 && c.eff > 4096 && t.hp > 0 && t.hp < t.mhp) { b.consumeItem(t, 'enigma'); b.healMon(t, fractionOf(t.mhp, 4), { src: 'enigma-berry' }); } } });
add(HX.THROAT_SPRAY, { afterAttack(b, c) { if (c.mv.flags.sound && c.user.hp > 0) { b.consumeItem(c.user, 'throat-spray'); b.changeStage(c.user, 'spa', 1, -1, {}); } } });
// Sticky Barb (MEASURED: the holder loses 1/8 each turn; a contact hit hands it to an itemless attacker)
add(HX.STICKY_BARB, {
  residual(b, m) { if (m.hp > 0 && !b.abFn(m, 'magicGuard')) { b.reveal(m, 'i'); b.dealDamage(m, fractionOf(m.mhp, 8), { src: 'sticky-barb', from: -1 }); } },
  onHit(b, c, dealt) { const t = c.target, a = c.user; if (dealt > 0 && c.contact && !a.it && a.hp > 0 && t.hp > 0 && !b.itFn(a, 'noContact')) { a.it = t.it; t.it = 0; b.emit({ t: 'trick', s: a.side, m: a.slot, how: 'sticky-barb', it: a.it }); } },
});
// Focus Band (MEASURED: survives a lethal hit with 1 HP when the game's Random() % 100 is below 10)
add(HX.FOCUS_BAND, { band: true });
// pinch berries (the threshold is the item's parameter / 4 steps: 1/4 of max HP)
add(HX.LANSAT, { onHp(b, m) { if (m.hp * (b.abFn(m, 'gluttony') ? 2 : 4) <= m.mhp && !m.v.lans) { b.consumeItem(m, 'lansat'); m.v.lans = 1; } }, critBoost(b, c) { return c.user.v.lans ? 2 : 0; } });
add(HX.STARF, { onHp(b, m) { if (m.hp * (b.abFn(m, 'gluttony') ? 2 : 4) <= m.mhp) { b.consumeItem(m, 'starf'); const ks = ['atk', 'def', 'spa', 'spd', 'spe'].filter((k) => m.sg[k] < 6); if (ks.length) b.changeStage(m, ks[b.rand(ks.length)], 2, -1, {}); } } });
add(HX.MICLE, { onHp(b, m) { if (m.hp * (b.abFn(m, 'gluttony') ? 2 : 4) <= m.mhp && !m.v.micle) { b.consumeItem(m, 'micle'); m.v.micle = 1; } }, acc(b, c) { if (c.user.v.micle) { c.user.v.micle = 2; return 4915; } return 0; } });
add(HX.CUSTAP, { onHp(b, m) { if (m.hp * (b.abFn(m, 'gluttony') ? 2 : 4) <= m.mhp && !m.v.custap) { b.consumeItem(m, 'custap'); m.v.custap = 1; } }, order(b, m) { if (m.v.custap) { m.v.custap = 0; return 1; } return 0; } });
add(HX.LEPPA, { afterAttack(b, c) { const u = c.user, mv = u.mv.find((x) => x.id === c.id); if (mv && mv.pp === 0 && u.hp > 0) { b.consumeItem(u, 'leppa'); mv.pp = mv.mx < 10 ? mv.mx : 10; } } });
// Room Service (MEASURED -1 Speed under Trick Room); Mental Herb frees the holder from the move-blocking conditions at once; Mirror Herb copies the foe's stat raises
add(HX.ROOM_SERVICE, { onTrickRoom(b, m) { b.consumeItem(m, 'room-service'); b.changeStage(m, 'spe', -1, -1, {}); } });
add(HX.MENTAL_HERB, { mental(b, m) { if (m.v.taunt || m.v.enc || m.v.dis) { b.consumeItem(m, 'mental-herb'); delete m.v.taunt; delete m.v.enc; delete m.v.dis; } }, residual(b, m) { if (m.v.taunt || m.v.enc || m.v.dis) { b.consumeItem(m, 'mental-herb'); delete m.v.taunt; delete m.v.enc; delete m.v.dis; } } });
add(HX.BERSERK_GENE, { onStart(b, m) { b.consumeItem(m, 'berserk-gene'); b.changeStage(m, 'atk', 2, -1, {}); b.confuse(m, null, { fx: 'berserk-gene' }); } });

export const ITEMS_BY_HOLD = Object.freeze(H);
export const ITEMS_BY_NAME = Object.freeze({});
export const SUPPORTED_HOLD_EFFECTS = Object.freeze(Object.keys(H).map(Number));
export { param as itemParam };

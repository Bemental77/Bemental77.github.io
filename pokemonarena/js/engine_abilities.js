// pokemonarena/js/engine_abilities.js -- ability behaviour for the battle engine, keyed by the ROM's ability NAME.
// Leaf module (no imports from engine.js / rules.js).  engine.js maps names to ids through the decoded pack, so an
// ability is supported exactly when its name appears here AND in the pack (rules.js / engine_support.js report both).
//
// HOOK PROTOCOL (all optional; `b` = Battle, `m` = the ability's owner, `c` = move context from engine_exec.js):
//   onStart(b,m)  onOut(b,m)  residual(b,m)  onKO(b,m,victim)  onFaint(b,m,info)  onStatusSet(b,m,st,src)  onWeather(b,m,w)
//   bp(b,c) atk(b,c) final(b,c)            attacker side modifiers (UQ4.12, 4096 = x1)
//   bpDef(b,c) atkDef(b,c) def(b,c) finalDef(b,c)   defender side modifiers
//   stab(b,c) moveType(b,m,c) -> type | {type, boost}     immune(b,c) -> true when the move is stopped
//   onHit(b,c,dealt) (defender reacts to a damaging hit)  acc(b,c) evade(b,c)  spe(b,m)  prio(b,m,mv)
//   statusImmune(b,m,st,src) confuseImmune(b,m) blockDrop(b,m,stat) modStage(b,m,delta) onDrop(b,m,stat,applied)
//   critBoost(b,c) critImmune(b,m) traps(b,foe,m) truant(b,m) sturdy(b,m,info)
//   flags (value true): levitate, magicGuard, rockHead, serene, skillLink, scrappy, unaware, moldBreaker, sheerForce, guts,
//     shieldDust, pressure, infiltrates, noGuard, ignoreEva, noWeather, innerFocus, overcoat, corrosion, noParaSlow,
//     weatherImmune, stickyHold, suctionCups, liquidOoze, poisonHeal, tauntImmune, sleepImmune, intimidateImmune, damp
//   breakable: true  => Mold Breaker style attackers ignore this ability when it is the DEFENDER's.
// Sources: the names come from the ROM; every number below is an `assumed` expansion default (ENGINE.md).

import { T, CAT, ST, WX, TN, PW, EFFECTS } from './engine_data.js';
import { fractionOf, idiv, applyStage } from './engine_calc.js';
import { E } from './engine_data.js';

const show = (b, m, fx, extra) => { b.reveal(m, 'a'); const ev = { t: 'ability', s: m.side, m: m.slot, ab: m.ab, fx }; if (extra) Object.assign(ev, extra); if (b.curInn && b.curInnMon === m) ev.inn = 1; b.emit(ev); };
const foeOf = (b, m) => b.act(m.side ^ 1);
const A = {};
const add = (names, hooks) => { for (const n of [].concat(names)) A[n] = Object.freeze(hooks); };
const absorb = (type, fn) => ({
  breakable: true,
  immune(b, c) {
    if (c.type !== type || c.cat === CAT.STATUS && false) return false;
    const m = c.target;
    show(b, m, 'absorb');
    b.emit({ t: 'immune', s: m.side, m: m.slot, why: 'ability', ab: m.ab, mv: c.id });
    fn(b, m);
    return true;
  },
});
const boostHp = (type) => ({
  atk(b, c) { return c.type === type && c.user.hp * 3 <= c.user.mhp ? 6144 : 0; },   // MEASURED (round 3 fit of 8 real rows, one of them level 100 Swarm / Bug Buzz): an attack-step factor; the base-power step was one point high on that row
});

// ---- weather / terrain setters and field
add('Drizzle', { onStart(b, m) { if (b.setWeather(WX.RAIN, m)) show(b, m, 'weather'); } });
add('Drought', { onStart(b, m) { if (b.setWeather(WX.SUN, m)) show(b, m, 'weather'); } });
add('Sand Stream', { onStart(b, m) { if (b.setWeather(WX.SAND, m)) show(b, m, 'weather'); } });
add('Snow Warning', { onStart(b, m) { if (b.setWeather(WX.SNOW, m)) show(b, m, 'weather'); } });
add(['Cloud Nine', 'Air Lock'], { noWeather: true, onStart(b, m) { show(b, m, 'weather-lock'); } });   // MEASURED (oracle, ROM 0x43fcd8): "The effects of the weather disappeared." at every entry, weather or not

// ---- entry effects
add('Intimidate', {
  onStart(b, m) {
    const f = foeOf(b, m);
    if (!f || f.hp <= 0) return;
    show(b, m, 'intimidate');
    const imm = b.abFn(f, 'intimidateImmune', true);
    if (imm) { b.reveal(f, 'a'); b.emit({ t: 'immune', s: f.side, m: f.slot, why: 'ability', ab: f.ab }); return; }
    if (b.abFn(f, 'intimidateBoost', true)) { b.reveal(f, 'a'); b.changeStage(f, 'atk', 1, -1, {}); return; }
    b.changeStage(f, 'atk', -1, m.side, {});
  },
});
add('Download', {
  onStart(b, m) {
    const f = foeOf(b, m);
    if (!f || f.hp <= 0) return;
    show(b, m, 'download');
    b.changeStage(m, f.st.def < f.st.spd ? 'atk' : 'spa', 1, -1, {});
  },
});

// ---- stat modifiers of the attacker
add(['Huge Power', 'Pure Power'], { atk(b, c) { return c.cat === CAT.PHYSICAL ? 8192 : 0; } });
add('Guts', { guts: true, atk(b, c) { return c.cat === CAT.PHYSICAL && c.user.s !== ST.NONE ? 6144 : 0; } });
add('Hustle', {
  atk(b, c) { return c.cat === CAT.PHYSICAL ? 6144 : 0; },
  acc(b, c) { return c.cat === CAT.PHYSICAL ? 3277 : 0; },
});
add('Solar Power', {
  atk(b, c) { return c.cat === CAT.SPECIAL && b.wx() === WX.SUN ? 6144 : 0; },
  residual(b, m) { if (b.wx() === WX.SUN && !b.abFn(m, 'magicGuard')) { show(b, m, 'solar-power'); b.dealDamage(m, fractionOf(m.mhp, 8), { src: 'solar-power', from: -1 }); } },
});
add('Defeatist', { atk(b, c) { return c.user.hp * 2 <= c.user.mhp ? 2048 : 0; } });
add('Toxic Boost', { atk(b, c) { return c.cat === CAT.PHYSICAL && (c.user.s === ST.PSN || c.user.s === ST.TOX) ? 6144 : 0; } });
add('Flare Boost', { atk(b, c) { return c.cat === CAT.SPECIAL && c.user.s === ST.BRN ? 6144 : 0; } });

// ---- base power
add('Technician', { bp(b, c) { return c.bpBase <= 60 ? 6144 : 0; } });
add('Iron Fist', { bp(b, c) { return c.mv.flags.punch ? 4915 : 0; } });
add('Reckless', { bp(b, c) { return c.mv.effect === 324 || c.mv.effect === 34 ? 4915 : 0; } });
add('Sheer Force', { sheerForce: true, bp(b, c) { return b.hasSecondary(c) ? 5325 : 0; } });
add('Strong Jaw', { bp(b, c) { return c.mv.flags.bite ? 6144 : 0; } });
add('Mega Launcher', { bp(b, c) { return c.mv.flags.pulse ? 6144 : 0; } });
add('Sharpness', { bp(b, c) { return c.mv.flags.slicing ? 6144 : 0; } });
add('Tough Claws', { bp(b, c) { return c.contact ? 5325 : 0; } });
add('Punk Rock', { bp(b, c) { return c.mv.flags.sound ? 5325 : 0; }, breakable: true, finalDef(b, c) { return c.mv.flags.sound ? 2048 : 0; } });
add('Steelworker', { bp(b, c) { return c.type === T.STEEL ? 6144 : 0; } });
add('Sand Force', { bp(b, c) { return b.wx() === WX.SAND && (c.type === T.ROCK || c.type === T.GROUND || c.type === T.STEEL) ? 5325 : 0; }, weatherImmune: true });
add('Analytic', { bp(b, c) { return c.target.v.moved ? 5325 : 0; } });
add('Overgrow', boostHp(T.GRASS));
add('Blaze', boostHp(T.FIRE));
add('Torrent', boostHp(T.WATER));
add('Swarm', boostHp(T.BUG));
add('Adaptability', { stab(b, c) { return 8192; } });
add('Flash Fire', {
  breakable: true,
  immune(b, c) {
    if (c.type !== T.FIRE) return false;
    const m = c.target;
    show(b, m, 'flash-fire');
    m.v.ff = 1;
    b.emit({ t: 'immune', s: m.side, m: m.slot, why: 'ability', ab: m.ab, mv: c.id });
    return true;
  },
  bp(b, c) { return c.user.v.ff && c.type === T.FIRE ? 6144 : 0; },
});
const typeChanger = (type) => ({ moveType(b, m, c) { return c.type === T.NORMAL && !c.mv.flags.noChange ? { type, boost: 4915 } : undefined; } });
add('Aerilate', typeChanger(T.FLYING));
add('Pixilate', typeChanger(T.FAIRY));
add('Refrigerate', typeChanger(T.ICE));
add('Galvanize', typeChanger(T.ELECTRIC));
add('Normalize', { moveType(b, m, c) { return { type: T.NORMAL, boost: 4915 }; } });

// ---- final damage
add('Tinted Lens', { final(b, c) { return c.eff < 4096 && c.eff > 0 ? 8192 : 0; } });
add('Sniper', { final(b, c) { return c.crit ? 6144 : 0; } });
add('Neuroforce', { final(b, c) { return c.eff > 4096 ? 5120 : 0; } });
add('Multiscale', { breakable: true, finalDef(b, c) { return c.target.hp === c.target.mhp ? 2048 : 0; } });
add('Shadow Shield', { breakable: false, finalDef(b, c) { return c.target.hp === c.target.mhp ? 2048 : 0; } });
add(['Solid Rock', 'Filter', 'Prism Armor'], { breakable: true, finalDef(b, c) { return c.eff > 4096 ? 3072 : 0; } });
add('Fluffy', { breakable: true, finalDef(b, c) { return (c.contact ? 2048 : 0) || (c.type === T.FIRE ? 8192 : 0); } });
add('Ice Scales', { breakable: true, finalDef(b, c) { return c.cat === CAT.SPECIAL ? 2048 : 0; } });
add('Heatproof', { breakable: true, bpDef(b, c) { return c.type === T.FIRE ? 2048 : 0; } });
add('Thick Fat', { breakable: true, atkDef(b, c) { return c.type === T.FIRE || c.type === T.ICE ? 2048 : 0; } });
add('Water Bubble', {
  breakable: true, atkDef(b, c) { return c.type === T.FIRE ? 2048 : 0; }, bp(b, c) { return c.type === T.WATER ? 8192 : 0; },
  statusImmune(b, m, st) { return st === ST.BRN; },
});
add('Purifying Salt', { breakable: true, atkDef(b, c) { return c.type === T.GHOST ? 2048 : 0; }, statusImmune() { return true; } });
add('Marvel Scale', { breakable: true, def(b, c) { return c.cat === CAT.PHYSICAL && c.target.s !== ST.NONE ? 6144 : 0; } });
add('Fur Coat', { breakable: true, def(b, c) { return c.cat === CAT.PHYSICAL ? 8192 : 0; } });

// ---- immunities and absorbers
add('Levitate', {
  breakable: true, levitate: true,
  immune(b, c) {
    if (c.type !== T.GROUND || c.mv.id === 0) return false;
    const t = c.target;
    if (t.v.smack || b.itFn(t, 'ironBall') || b.s.gv > 0) return false;
    show(b, t, 'levitate');
    b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id });
    return true;
  },
});
add('Volt Absorb', absorb(T.ELECTRIC, (b, m) => { b.healMon(m, fractionOf(m.mhp, 4), { src: 'volt-absorb' }); }));
add('Water Absorb', absorb(T.WATER, (b, m) => { b.healMon(m, fractionOf(m.mhp, 4), { src: 'water-absorb' }); }));
add('Earth Eater', absorb(T.GROUND, (b, m) => { b.healMon(m, fractionOf(m.mhp, 4), { src: 'earth-eater' }); }));
add('Storm Drain', absorb(T.WATER, (b, m) => { b.changeStage(m, 'spa', 1, -1, {}); }));
add('Lightning Rod', absorb(T.ELECTRIC, (b, m) => { b.changeStage(m, 'spa', 1, -1, {}); }));
add('Motor Drive', absorb(T.ELECTRIC, (b, m) => { b.changeStage(m, 'spe', 1, -1, {}); }));
add('Sap Sipper', absorb(T.GRASS, (b, m) => { b.changeStage(m, 'atk', 1, -1, {}); }));
add('Well-Baked Body', absorb(T.FIRE, (b, m) => { b.changeStage(m, 'def', 2, -1, {}); }));
add('Dry Skin', {
  ...absorb(T.WATER, (b, m) => { b.healMon(m, fractionOf(m.mhp, 4), { src: 'dry-skin' }); }),
  bpDef(b, c) { return c.type === T.FIRE ? 5120 : 0; },
  residual(b, m) {
    const w = b.wx();
    if (w === WX.RAIN) b.healMon(m, fractionOf(m.mhp, 8), { src: 'dry-skin' });
    else if (w === WX.SUN && !b.abFn(m, 'magicGuard')) b.dealDamage(m, fractionOf(m.mhp, 8), { src: 'dry-skin', from: -1 });
  },
});
add('Soundproof', { breakable: true, immune(b, c) { if (!c.mv.flags.sound) return false; const t = c.target; show(b, t, 'soundproof'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });
add('Bulletproof', { breakable: true, immune(b, c) { if (!c.mv.flags.ball) return false; const t = c.target; show(b, t, 'bulletproof'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });
add('Wonder Guard', {
  breakable: true,
  immune(b, c) {
    if (c.eff > 4096 || c.mv.power === 0) return false;
    const t = c.target;
    show(b, t, 'wonder-guard');
    b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id });
    return true;
  },
});
add('Sturdy', { breakable: true, sturdy() { return true; } });

// ---- status immunities and friends
add('Limber', { breakable: true, statusImmune(b, m, st) { return st === ST.PAR; } });
add(['Insomnia', 'Vital Spirit'], { breakable: true, sleepImmune: true, statusImmune(b, m, st) { return st === ST.SLP; } });
add('Immunity', { breakable: true, statusImmune(b, m, st) { return st === ST.PSN || st === ST.TOX; } });
add('Pastel Veil', { breakable: true, statusImmune(b, m, st) { return st === ST.PSN || st === ST.TOX; } });
add('Magma Armor', { breakable: true, statusImmune(b, m, st) { return st === ST.FRZ || st === ST.FBT; } });   // MEASURED: also blocks frostbite (0 of 40)
add('Water Veil', { breakable: true, statusImmune(b, m, st) { return st === ST.BRN; } });
add('Leaf Guard', { breakable: true, statusImmune(b) { return b.wx() === WX.SUN; } });
add('Own Tempo', { breakable: true, confuseImmune() { return true; }, intimidateImmune: true });
add('Inner Focus', { breakable: true, innerFocus: true, intimidateImmune: true });
add('Oblivious', { breakable: true, tauntImmune: true, intimidateImmune: true, loveImmune: true });
add('Scrappy', { scrappy: true, intimidateImmune: true });
add('Shield Dust', { breakable: true, shieldDust: true });
add('Overcoat', { breakable: true, overcoat: true, weatherImmune: true });
add('Magic Guard', { magicGuard: true });
add('Rock Head', { rockHead: true });
add(['Battle Armor', 'Shell Armor'], { breakable: true, critImmune() { return true; } });
add('Natural Cure', { onOut(b, m) { if (m.s !== ST.NONE) b.clearStatus(m, 'natural-cure'); } });
add('Regenerator', { onOut(b, m) { b.healMon(m, idiv(m.mhp, 3), { src: 'regenerator' }); } });
add('Poison Heal', { poisonHeal: true });
add('Shed Skin', { residual(b, m) { if (m.s !== ST.NONE && b.rand(3) === 0) { show(b, m, 'shed-skin'); b.clearStatus(m, 'shed-skin'); } } });
add('Hydration', { residual(b, m) { if (m.s !== ST.NONE && b.wx() === WX.RAIN) { show(b, m, 'hydration'); b.clearStatus(m, 'hydration'); } } });
add('Rain Dish', { residual(b, m) { if (b.wx() === WX.RAIN) b.healMon(m, fractionOf(m.mhp, 16), { src: 'rain-dish' }); } });
add('Ice Body', { residual(b, m) { const w = b.wx(); if (w === WX.HAIL || w === WX.SNOW) b.healMon(m, fractionOf(m.mhp, 16), { src: 'ice-body' }); }, weatherImmune: true });
add('Speed Boost', { residual(b, m) { show(b, m, 'speed-boost'); b.changeStage(m, 'spe', 1, -1, {}); } });
add('Synchronize', {
  onStatusSet(b, m, st, src) {
    if (!src || src.hp <= 0 || st === ST.SLP || st === ST.FRZ) return;
    show(b, m, 'synchronize');
    b.setStatus(src, st === ST.TOX ? ST.PSN : st, m, { fx: 'synchronize' });
  },
});

// ---- contact punishers (defender), run for every damaging hit
const contact = (fn) => ({ breakable: true, onHit(b, c, dealt) { if (!c.contact || dealt <= 0 && !c.subHit) return; const a = c.user; if (a.hp <= 0) return; if (b.itFn(a, 'noContact')) return; fn(b, c.target, a); } });
add('Static', contact((b, t, a) => { if (b.rand(100) < 30) { show(b, t, 'static'); b.setStatus(a, ST.PAR, t, { fx: 'static' }); } }));
add('Poison Point', contact((b, t, a) => { if (b.rand(100) < 30) { show(b, t, 'poison-point'); b.setStatus(a, ST.PSN, t, { fx: 'poison-point' }); } }));
add('Flame Body', contact((b, t, a) => { if (b.rand(100) < 30) { show(b, t, 'flame-body'); b.setStatus(a, ST.BRN, t, { fx: 'flame-body' }); } }));
add('Effect Spore', contact((b, t, a) => {
  if (b.rand(100) < 30) {
    const r = b.rand(3); show(b, t, 'effect-spore');
    if (b.hasType(a, T.GRASS) || b.abFn(a, 'overcoat')) return;
    b.setStatus(a, r === 0 ? ST.SLP : r === 1 ? ST.PSN : ST.PAR, t, { fx: 'effect-spore' });
  }
}));
add(['Rough Skin', 'Iron Barbs'], contact((b, t, a) => { if (b.abFn(a, 'magicGuard')) return; show(b, t, 'rough-skin'); b.dealDamage(a, fractionOf(a.mhp, 8), { src: 'rough-skin', from: -1 }); }));
add(['Gooey', 'Tangling Hair'], contact((b, t, a) => { show(b, t, 'gooey'); b.changeStage(a, 'spe', -1, t.side, {}); }));
add('Weak Armor', { breakable: true, onHit(b, c, dealt) { if (c.cat !== CAT.PHYSICAL || dealt <= 0) return; const t = c.target; if (t.hp <= 0) return; show(b, t, 'weak-armor'); b.changeStage(t, 'def', -1, -1, {}); b.changeStage(t, 'spe', 2, -1, {}); } });
add('Stamina', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.target.hp > 0) { show(b, c.target, 'stamina'); b.changeStage(c.target, 'def', 1, -1, {}); } } });
add('Justified', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.type === T.DARK && c.target.hp > 0) { show(b, c.target, 'justified'); b.changeStage(c.target, 'atk', 1, -1, {}); } } });
add('Rattled', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && (c.type === T.DARK || c.type === T.GHOST || c.type === T.BUG) && c.target.hp > 0) { show(b, c.target, 'rattled'); b.changeStage(c.target, 'spe', 1, -1, {}); } } });
add('Anger Point', { breakable: true, onHit(b, c, dealt) { if (c.crit && dealt > 0 && c.target.hp > 0) { show(b, c.target, 'anger-point'); b.changeStage(c.target, 'atk', 12, -1, {}); } } });
add('Steadfast', { onFlinch(b, m) { show(b, m, 'steadfast'); b.changeStage(m, 'spe', 1, -1, {}); } });
add('Aftermath', { breakable: true, onFaint(b, m, info) { if (!info.contact) return; const a = b.act(info.from); if (a && a.hp > 0 && !b.abFn(a, 'magicGuard')) { show(b, m, 'aftermath'); b.dealDamage(a, fractionOf(a.mhp, 4), { src: 'aftermath', from: -1 }); } } });

// ---- KO rewards
add('Moxie', { onKO(b, m) { show(b, m, 'moxie'); b.changeStage(m, 'atk', 1, -1, {}); } });
add('Beast Boost', {
  onKO(b, m) {
    let best = 'atk';
    for (const k of ['def', 'spa', 'spd', 'spe']) if (m.st[k] > m.st[best]) best = k;
    show(b, m, 'beast-boost'); b.changeStage(m, best, 1, -1, {});
  },
});

// ---- stat protection and rewrites
add('Contrary', { breakable: true, modStage(b, m, d) { return -d; } });
add('Simple', { breakable: true, modStage(b, m, d) { return d * 2; } });
add(['Clear Body', 'White Smoke', 'Full Metal Body'], { breakable: true, blockDrop() { return true; } });
add('Hyper Cutter', { breakable: true, blockDrop(b, m, stat) { return stat === 'atk'; } });
add('Big Pecks', { breakable: true, blockDrop(b, m, stat) { return stat === 'def'; } });
add('Keen Eye', { breakable: true, blockDrop(b, m, stat) { return stat === 'acc'; }, ignoreEva: true });
add('Defiant', { onDrop(b, m) { show(b, m, 'defiant'); b.changeStage(m, 'atk', 2, -1, {}); } });
add('Competitive', { onDrop(b, m) { show(b, m, 'competitive'); b.changeStage(m, 'spa', 2, -1, {}); } });
add('Unaware', { breakable: true, unaware: true });
// MEASURED (ROM 0x4409bc / 0x440978 / 0x440998): each announces itself at every entry
add('Mold Breaker', { moldBreaker: true, onStart(b, m) { show(b, m, 'mold-breaker'); } });
add('Turboblaze', { moldBreaker: true, onStart(b, m) { show(b, m, 'turboblaze'); } });
add('Teravolt', { moldBreaker: true, onStart(b, m) { show(b, m, 'teravolt'); } });
add('Compound Eyes', { acc() { return 5325; } });
add('No Guard', { noGuard: true });
add('Super Luck', { critBoost() { return 1; } });
add('Serene Grace', { serene: true });
add('Skill Link', { skillLink: true });
add('Pressure', { pressure: true, onStart(b, m) { show(b, m, 'pressure'); } });   // MEASURED (ROM 0x43fcb8): announced at every entry
add('Infiltrator', { infiltrates: true });
add('Sticky Hold', { breakable: true, stickyHold: true });
add('Suction Cups', { breakable: true, suctionCups: true });
add('Liquid Ooze', { breakable: true, liquidOoze: true });
add('Corrosion', { corrosion: true });
add('Damp', { breakable: true, damp: true });
add('Truant', { truant(b, m) { if (m.v.tru) { delete m.v.tru; return true; } m.v.tru = 1; return false; } });

// ---- speed and accuracy conditions
add('Swift Swim', { spe(b, m) { return b.wx() === WX.RAIN ? 8192 : 0; } });
add('Chlorophyll', { spe(b, m) { return b.wx() === WX.SUN ? 8192 : 0; } });
add('Sand Rush', { spe(b, m) { return b.wx() === WX.SAND ? 8192 : 0; }, weatherImmune: true });
add('Slush Rush', { spe(b, m) { const w = b.wx(); return w === WX.HAIL || w === WX.SNOW ? 8192 : 0; } });
add('Quick Feet', { noParaSlow: true, spe(b, m) { return m.s !== ST.NONE ? 6144 : 0; } });
add('Unburden', { spe(b, m) { return m.used && !m.it ? 8192 : 0; } });
add('Sand Veil', { breakable: true, weatherImmune: true, evade(b, c) { return b.wx() === WX.SAND ? 3277 : 0; } });
add('Snow Cloak', { breakable: true, evade(b, c) { const w = b.wx(); return w === WX.HAIL || w === WX.SNOW ? 3277 : 0; } });
add('Tangled Feet', { breakable: true, evade(b, c) { return c.target.v.conf ? 2048 : 0; } });

// ---- trapping and priority
add('Shadow Tag', { traps(b, foe, m) { return !b.hasAbility(m, 'Shadow Tag'); } });
add('Arena Trap', { traps(b, foe, m) { return b.isGrounded(m); } });
add('Magnet Pull', { traps(b, foe, m) { return b.hasType(m, T.STEEL); } });
add('Prankster', { prio(b, m, mv) { return mv.category === CAT.STATUS ? 1 : 0; } });
add('Gale Wings', { prio(b, m, mv) { return mv.type === T.FLYING && m.hp === m.mhp ? 1 : 0; } });
add('Triage', { prio(b, m, mv) { return mv.flags.heal ? 3 : 0; } });

// ---- abilities that do nothing in SINGLES (they exist for doubles / allies): supported because their absence changes nothing
add(['Symbiosis', 'Telepathy', 'Stalwart', 'Healer'], { inert: true });
// Quark Drive: Electric Terrain boosts the highest stat (MEASURED, dynamic like Protosynthesis in the sun)
add('Quark Drive', {
  atk(b, c) { const h = HIGHEST(c.user); return (b.terrain() === TN.ELECTRIC || c.user.v.be) && (c.cat === CAT.PHYSICAL ? h === 'atk' : h === 'spa') ? 5325 : 0; },
  def(b, c) { const h = HIGHEST(c.target); return (b.terrain() === TN.ELECTRIC || c.target.v.be) && (c.cat === CAT.PHYSICAL ? h === 'def' : h === 'spd') ? 5325 : 0; },
  spe(b, m) { return (b.terrain() === TN.ELECTRIC || m.v.be) && HIGHEST(m) === 'spe' ? 6144 : 0; },
  boostable: 'electric',
});
add('Unseen Fist', { unseenFist: true });
add('Flower Veil', {
  breakable: true,
  blockDrop(b, m) { return b.hasType(m, T.GRASS); },
  statusImmune(b, m) { return b.hasType(m, T.GRASS); },
});
add('Cursed Body', {
  breakable: true,
  onHit(b, c, dealt) {
    const a = c.user, t = c.target;
    if (dealt <= 0 || a.hp <= 0 || a.v.dis || !a.mv.some((x) => x.id === c.id)) return;
    if (b.rand(100) < 30) { show(b, t, 'cursed-body'); a.v.dis = { mv: c.id, t: 5 }; b.emit({ t: 'volatile', s: a.side, m: a.slot, v: 'disable', mv: c.id }); }
  },
});
add(['Protean', 'Libero'], {
  beforeMove(b, m, c) {
    const tys = b.types(m);
    if (c.type === T.MYSTERY || (tys.length === 1 && tys[0] === c.type)) return;
    m.v.ty = [c.type];
    show(b, m, 'protean');
    b.emit({ t: 'type-change', s: m.side, m: m.slot, ty: [c.type] });
  },
});
add('Soul-Heart', { onAnyFaint(b, m) { if (m.hp > 0) { show(b, m, 'soul-heart'); b.changeStage(m, 'spa', 1, -1, {}); } } });
add('Berserk', { onHp(b, m, from) { if (from * 2 > m.mhp && m.hp * 2 <= m.mhp) { show(b, m, 'berserk'); b.changeStage(m, 'spa', 1, -1, {}); } } });
add('Innards Out', { breakable: true, onFaint(b, m, info) { const a = b.act(info.from); const amt = m.v.hitAmt || 0; if (a && a.hp > 0 && amt > 0 && !b.abFn(a, 'magicGuard')) { show(b, m, 'innards-out'); b.dealDamage(a, amt, { src: 'innards-out', from: -1 }); } } });
add('Heavy Metal', { breakable: true, weight(b, m, w) { return w * 2; } });
add('Light Metal', { breakable: true, weight(b, m, w) { return w >> 1; } });
add('Gluttony', { gluttony: true });
const HIGHEST = (m) => { let best = 'atk'; for (const k of ['def', 'spa', 'spd', 'spe']) if (m.st[k] > m.st[best]) best = k; return best; };
add('Protosynthesis', {
  atk(b, c) { const h = HIGHEST(c.user); return (b.wx() === WX.SUN || c.user.v.be) && (c.cat === CAT.PHYSICAL ? h === 'atk' : h === 'spa') ? 5325 : 0; },
  def(b, c) { const h = HIGHEST(c.target); return (b.wx() === WX.SUN || c.target.v.be) && (c.cat === CAT.PHYSICAL ? h === 'def' : h === 'spd') ? 5325 : 0; },
  spe(b, m) { return (b.wx() === WX.SUN || m.v.be) && HIGHEST(m) === 'spe' ? 6144 : 0; },
  boostable: 'sun',
});
const TRACE_BAN = ['Trace', 'Multitype', 'Illusion', 'Imposter', 'Disguise', 'Power Construct', 'Stance Change', 'Zen Mode', 'Schooling', 'Battle Bond', 'Receiver', 'Power Of Alchemy', 'RKS System', 'Neutralizing Gas', 'As One', 'Commander', 'Hunger Switch', 'Ice Face', 'Flower Gift', 'Forecast', 'Wonder Guard'];
add('Trace', {
  onStart(b, m) {
    const f = foeOf(b, m);
    if (!f || f.hp <= 0) return;
    const nm = b.abilityName(f);
    if (!nm || nm === '-------' || TRACE_BAN.indexOf(nm) >= 0 || !ABILITIES[nm]) return;
    show(b, m, 'trace');
    m.ab = f.ab;
    b.emit({ t: 'copy', s: m.side, m: m.slot, how: 'trace', ab: f.ab });
    const st = b.abFn(m, 'onStart'); if (st) st(b, m);
  },
});

// ======================================================================================================================================
// ROUND 2, batch A: abilities that the ROM text describes and the real game was probed for (pokemonarena/ROMDIFF.md section 7).
// Every number is either MEASURED in the real game (rom-live: the damage ratios, the stage deltas, the priority order, the messages) or taken
// from the ROM's own ability description (long text) and then checked by the standing differential where the oracle can drive it.
// ======================================================================================================================================
const foes = (b, m) => { const f = b.act(m.side ^ 1); return f && f.hp > 0 ? f : null; };

// ---- +1 priority at full HP for one type (MEASURED: acts before a faster foe, only while at full HP)
const priFull = (type) => ({ prio(b, m, mv) { return mv.type === type && m.hp === m.mhp ? 1 : 0; } });
add('Nightstalker', priFull(T.DARK)); add('Heat Rush', priFull(T.FIRE)); add('Quick Forge', priFull(T.STEEL)); add('Static Burst', priFull(T.ELECTRIC));
add('Verdant Gale', priFull(T.GRASS)); add('Swarm Instinct', priFull(T.BUG)); add('Ready Stance', priFull(T.NORMAL)); add('Think Ahead', priFull(T.PSYCHIC));
add('First Strike', priFull(T.FIGHTING)); add('Stone Sentinel', priFull(T.ROCK)); add('Phantom Step', priFull(T.GHOST));
add('Maneuverability', { prio(b, m, mv) { return mv.category !== CAT.STATUS && mv.power > 0 && mv.power < 60 ? 1 : 0; } });
add('Stall', { stall: true });

// ---- type power boosts (MEASURED: x1.3 for the "30%" ones, x1.5 for the "50%" ones; the live differential only fits when the factor is applied to the ATTACK stat, not to the base power)
const tyBp = (type, mod) => ({ atk(b, c) { return c.type === type ? mod : 0; } });
add('Transistor', tyBp(T.ELECTRIC, 5325));
add('Windcaller', { bp(b, c) { return c.type === T.FLYING ? 5325 : 0; } });   // MEASURED: unlike its siblings Windcaller fits only as a BASE-POWER factor (a real Flygon holding it as an innate)
add("Dragon's Maw", tyBp(T.DRAGON, 6144)); add('Fire Mane', tyBp(T.FIRE, 6144)); add('Warrior Spirit', tyBp(T.FIGHTING, 6144));
add('Rocky Payload', tyBp(T.ROCK, 6144)); add('Mind Force', tyBp(T.PSYCHIC, 6144)); add('Seabound', tyBp(T.WATER, 6144)); add('Wind Force', tyBp(T.FLYING, 6144));
add('Hive Force', tyBp(T.BUG, 6144)); add('Verdant Soul', tyBp(T.GRASS, 6144)); add('Earthbound', tyBp(T.GROUND, 6144)); add('Toxic Core', tyBp(T.POISON, 6144));
add('Steel Feet', { bp(b, c) { return c.mv.flags.kick ? 4915 : 0; } });
add('Generalist', { atk(b, c) { return b.types(c.user).indexOf(c.type) < 0 ? 5120 : 0; } });   // MEASURED (round 3 fit of two real rows): the 25 percent is an attack-step factor; the base-power step was one point low on one row
add('Enigma', { bp(b, c) { return /power/i.test(c.mv.name) ? 8192 : 0; } });
add('Flare', { bp(b, c) { return c.type === T.FIRE && c.target.s === ST.BRN ? 6144 : 0; } });
add('Pack Leader', { bp(b, c) { let n = 0; for (const x of b.s.sides[c.us].team) if (x !== c.user && x.hp > 0) n++; return n ? 4096 + idiv(4096 * 5 * n, 100) : 0; } });
add('Supreme Overlord', { bp(b, c) { const n = Math.min(5, b.s.sides[c.us].nfaint); return n ? 4096 + idiv(4096 * 10 * n, 100) : 0; } });
add('Gang Up', { bp(b, c) { return c.target.v.hit > 0 ? 4915 : 0; } });
add('Stakeout', { bp(b, c) { return c.target.v.swt === b.s.turn ? 8192 : 0; } });
add('Underdog', { bp(b, c) { const x = b.pack.species[c.target.sp], y = b.pack.species[c.user.sp]; return x && y && x.bst > y.bst ? 5325 : 0; } });
add('Hunter', { atk(b, c) { return c.cat === CAT.PHYSICAL && c.target.s === ST.PAR ? 6144 : 0; } });
add('Gorilla Tactics', {
  atk(b, c) { return c.cat === CAT.PHYSICAL ? 6144 : 0; },
  choiceLock: true,
  beforeMove(b, m, c) { if (!m.v.choice && c.id) m.v.choice = c.id; },
});
add('Last Stand', {
  bp() { return 5325; },
  afterHit(b, c) { const u = c.user; if (u.hp > 0 && !b.abFn(u, 'magicGuard')) { show(b, u, 'last-stand'); b.dealDamage(u, fractionOf(u.mhp, 10), { src: 'last-stand', from: -1 }); } },
});
// attack taken from 2/3 of the user's Defense (MEASURED: Pound 33 -> 15 with Def 100 vs Atk 150, 33 -> 42 with Def 300)
add('Siegebreaker', { atkSource(b, c, A) { return idiv(applyStage(c.user.st.def, c.user.sg.def) * 2, 3); } });
add('Elemental Fist', { atkSource(b, c, A) { return c.mv.flags.punch ? applyStage(c.user.st.spa, c.user.sg.spa) : A; } });

// ---- Normal moves become another type with the 20% boost (MEASURED: Body Slam 66 -> 53 without STAB, 44 -> 79 with it)
add('Dragonize', typeChanger(T.DRAGON)); add('Terrate', typeChanger(T.GROUND)); add('Psychate', typeChanger(T.PSYCHIC));
add('Flamilate', typeChanger(T.FIRE)); add('Aquate', typeChanger(T.WATER)); add('Florate', typeChanger(T.GRASS));

// ---- type chart rewrites (MEASURED)
add('Omega', {
  typeProd(b, c, p) { return p < 8192 ? 8192 : p; },            // the user's attacks are always super effective (immunities included); MEASURED on the PRODUCT of a dual type
  typeProdDef(b, c, p) { return 2048; },                        // damage taken is never very effective (MEASURED: x0.5 whatever the chart said)
});
add('Acidic', { typeMult(b, c, m, at, dt) { return at === T.POISON && dt === T.STEEL ? 8192 : m; } });
add('Inversion', { typeMultDef(b, c, m) { return m === 0 ? 0 : m < 4096 ? 8192 : m > 4096 ? 2048 : m; } });

// ---- damage taken (MEASURED: Phalanx / Spectral / Aura Guard halve, Guardian x0.85, Sandshield / Sunhardened double the defence)
// MEASURED: the live differential (main ability AND innate) only fits when the attacker's stat is halved, not when the damage is halved
add('Phalanx', { breakable: true, atkDef(b, c) { return c.cat === CAT.PHYSICAL ? 2048 : 0; } });
add('Spectral', { breakable: true, atkDef(b, c) { return c.cat === CAT.SPECIAL ? 2048 : 0; } });
add('Aura Guard', { breakable: true, finalDef(b, c) { return c.contact ? 2048 : 0; } });
add('Guardian', { breakable: true, finalDef() { return 3482; } });
add('Sandshield', { breakable: true, def(b, c) { return c.cat === CAT.PHYSICAL && b.wx() === WX.SAND ? 8192 : 0; } });
add('Sunhardened', { breakable: true, def(b, c) { return c.cat === CAT.SPECIAL && b.wx() === WX.SUN ? 8192 : 0; } });

// ---- Dark / Fairy / Ghost Aura: every move of the type, whoever holds the aura (MEASURED +31..33 percent); Aura Break reverses them
const aura = (type) => ({ aura(b, c) { if (c.type !== type) return 0; for (let s = 0; s < 2; s++) { const x = b.act(s); if (x && x.hp > 0 && b.abFn(x, 'auraBreak')) return 3072; } return 5448; } });
// the three announce themselves at every entry (MEASURED, ROM 0x43fc98 / 0x43fc78 / 0x43fc50); Malice Aura's text was not seen
add('Dark Aura', { ...aura(T.DARK), onStart(b, m) { show(b, m, 'dark-aura'); } }); add('Fairy Aura', { ...aura(T.FAIRY), onStart(b, m) { show(b, m, 'fairy-aura'); } }); add('Malice Aura', aura(T.GHOST));
add('Aura Break', { auraBreak: true, onStart(b, m) { show(b, m, 'aura-break'); } });
add('Mega Sol', { sunMoves: true });

// ---- accuracy and evasion
add("Mind's Eye", { scrappy: true, ignoreEva: true, blockDrop(b, m, stat) { return stat === 'acc'; } });
add('Illuminate', { ignoreEva: true, blockDrop(b, m, stat) { return stat === 'acc'; } });
add('Victory Star', { acc() { return 4506; } });
add('Wonder Skin', { breakable: true, evade(b, c) { const a = c.mv.accuracy; return c.mv.category === CAT.STATUS && a > 50 ? idiv(50 * 4096, a) : 0; } });
add('Indomitable', { breakable: true, innerFocus: true, evade(b, c) { return c.mv.category === CAT.STATUS ? 2048 : 0; } });
add('Merciless', { critBoost(b, c) { const s = c.target.s; return s === ST.PSN || s === ST.TOX ? 3 : 0; } });

// ---- entry effects (MEASURED: every delta below was read from the real game's stat stages after the switch-in)
const entryFoe = (stat, d, fx) => ({ onStart(b, m) { const f = foes(b, m); if (!f) return; show(b, m, fx); b.changeStage(f, stat, d, m.side, {}); } });
const entrySelf = (stat, d, fx) => ({ onStart(b, m) { show(b, m, fx); b.changeStage(m, stat, d, -1, {}); } });
add('Uncanny', entryFoe('spa', -1, 'uncanny')); add('Breaking', entryFoe('def', -1, 'breaking')); add('Disquiet', entryFoe('spd', -1, 'disquiet')); add('Tangling', entryFoe('spe', -1, 'tangling'));
add('Infernal', { onStart(b, m) { const f = foes(b, m); if (!f) return; show(b, m, 'infernal'); b.changeStage(f, 'atk', -1, m.side, {}); b.changeStage(f, 'def', -1, m.side, {}); } });
add('Supersweet Syrup', { onStart(b, m) { const f = foes(b, m); if (!f || m.sw) return; m.sw = 1; show(b, m, 'supersweet-syrup'); b.changeStage(f, 'eva', -1, m.side, {}); } });
add('Dauntless Shield', entrySelf('def', 1, 'dauntless-shield')); add('Intrepid Sword', entrySelf('atk', 1, 'intrepid-sword'));
add('Battle Fervor', entrySelf('atk', 1, 'battle-fervor')); add('Guard Stance', entrySelf('def', 1, 'guard-stance'));
add('Resolute Guard', entrySelf('spd', 1, 'resolute-guard')); add('Skip Step', entrySelf('spe', 1, 'skip-step'));
add('Glacial', {
  onStart(b, m) { show(b, m, 'glacial'); b.changeStage(m, 'spd', 1, -1, {}); },
  residual(b, m) { const w = b.wx(); if ((w === WX.HAIL || w === WX.SNOW) && m.hp < m.mhp) { show(b, m, 'glacial'); b.healMon(m, fractionOf(m.mhp, 8), { src: 'glacial' }); } },
});
add('Restoring', { onStart(b, m) { if (m.v.aring) return; m.v.aring = 1; show(b, m, 'restoring'); b.emit({ t: 'volatile', s: m.side, m: m.slot, v: 'aqua-ring' }); } });
add('Rooted', { onStart(b, m) { if (m.v.ingrain) return; m.v.ingrain = 1; show(b, m, 'rooted'); b.emit({ t: 'volatile', s: m.side, m: m.slot, v: 'ingrain' }); } });
add('Windburst', { onStart(b, m) { const sd = b.s.sides[m.side]; if (sd.tw > 0) return; sd.tw = E.tailwindTurns; show(b, m, 'windburst'); b.emit({ t: 'screen', s: m.side, k: 'tw' }); } });
add('Showtime', { onStart(b, m) { if (b.s.tr > 0) return; b.s.tr = E.trickRoomTurns; show(b, m, 'showtime'); b.emit({ t: 'field', k: 'trick-room', on: 1 }); b.roomSet(); } });
add('Wishmaker', { onStart(b, m) { const sd = b.s.sides[m.side]; if (sd.wish) return; sd.wish = { t: 2, hp: idiv(m.mhp, 2) }; show(b, m, 'wishmaker'); b.emit({ t: 'volatile', s: m.side, m: m.slot, v: 'wish' }); } });
add('Screen Cleaner', {
  onStart(b, m) {
    let any = false;
    for (let s = 0; s < 2; s++) { const sd = b.s.sides[s]; for (const k of ['reflect', 'light', 'veil']) if (sd[k] > 0) { sd[k] = 0; any = true; b.emit({ t: 'screen-end', s, k, broken: 1 }); } }
    if (any) show(b, m, 'screen-cleaner');
  },
});
add('Slow Start', {
  onStart(b, m) { m.v.ss = 5; show(b, m, 'slow-start'); },
  atk(b, c) { return c.cat === CAT.PHYSICAL && c.user.v.ss > 0 ? 2048 : 0; },
  spe(b, m) { return m.v.ss > 0 ? 2048 : 0; },
  residual(b, m) { if (m.v.ss > 0) { m.v.ss -= 1; if (m.v.ss === 0) show(b, m, 'slow-start-end'); } },   // MEASURED (ROM 0x440938): the line comes at the end of the fifth turn
});
add('Unnerve', { unnerve: true, onStart(b, m) { if (foes(b, m)) show(b, m, 'unnerve'); } });
// Frisk, Forewarn and Anticipation only tell the player something at entry (MEASURED in the real game, ROMDIFF.md section 9; Forewarn is an INNATE of every species that has it, so it needs level 75 or more):
//  Frisk: names the foe's item, nothing is said when the foe holds none.
//  Forewarn: names the foe's move with the most power; a one-power move counts 80, an OHKO move 150, Counter / Mirror Coat / Metal Burst 120; the LAST move of the foe's list wins a tie (status moves have power 0 and can be named).
//  Anticipation: "shuddered" when a foe move is an OHKO move or is a damaging move that is super effective against the holder (a fixed-damage move like Night Shade counts, Explosion and Counter do not unless their type does).
const forewarnPower = (b, mv) => { const ef = EFFECTS[mv.effect]; if (ef && ef.kind === 'ohko') return 150; if (ef && ef.kind === 'counter') return 120; return mv.power === 1 ? 80 : mv.power; };
add('Frisk', { onStart(b, m) { const f = foes(b, m); if (f && f.it) { b.reveal(f, 'i'); show(b, m, 'frisk', { it: f.it }); } } });
add('Forewarn', { onStart(b, m) {
  const f = foes(b, m); if (!f) return;
  let best = -1, pick = 0;
  for (const slot of f.mv) { if (!slot || !slot.id) continue; const p = forewarnPower(b, b.pack.moves[slot.id]); if (p >= best) { best = p; pick = slot.id; } }
  if (pick) { b.reveal(f, 'm', pick); show(b, m, 'forewarn', { mv: pick }); }
} });
add('Anticipation', { onStart(b, m) {
  const f = foes(b, m); if (!f) return;
  for (const slot of f.mv) {
    if (!slot || !slot.id) continue;
    const mv = b.pack.moves[slot.id]; const ef = EFFECTS[mv.effect];
    if ((ef && ef.kind === 'ohko') || (mv.category !== CAT.STATUS && b.typeEff(mv.type, m, null).prod > 4096)) { show(b, m, 'anticipation'); return; }
  }
} });
add('Imposter', { onStart(b, m) { const f = foes(b, m); if (f && b.transformMon && b.transformMon(m, f)) show(b, m, 'imposter'); } });
add('Klutz', { noItem: true });

// ---- end-of-turn effects
const eotFoe = (stat, fx) => ({ residual(b, m) { const f = foes(b, m); if (!f) return; show(b, m, fx); b.changeStage(f, stat, -1, m.side, {}); } });
add('Arctic Aura', eotFoe('atk', 'arctic-aura')); add('Stormrider', eotFoe('spd', 'stormrider')); add('Volcano Howl', eotFoe('def', 'volcano-howl'));
add('Bad Dreams', { residual(b, m) { const f = foes(b, m); if (f && f.s === ST.SLP && !b.abFn(f, 'magicGuard')) { show(b, m, 'bad-dreams'); b.dealDamage(f, fractionOf(f.mhp, 8), { src: 'bad-dreams', from: m.side }); } } });
add('Rejuvenation', { residual(b, m) { if (m.hp > 0 && m.hp < m.mhp && !(m.v.hit > 0)) { show(b, m, 'rejuvenation'); b.healMon(m, fractionOf(m.mhp, 10), { src: 'rejuvenation' }); } } });
add('Mending', { residual(b, m) { if (m.hp > 0 && b.rand(100) < 30) { show(b, m, 'mending'); if (m.s !== ST.NONE) b.clearStatus(m, 'mending'); b.healMon(m, fractionOf(m.mhp, 8), { src: 'mending' }); } } });
add('Jade Bloom', { residual(b, m) { if (m.hp > 0 && m.s === ST.NONE) { show(b, m, 'jade-bloom'); b.healMon(m, fractionOf(m.mhp, 16), { src: 'jade-bloom' }); b.changeStage(m, b.rand(2) === 0 ? 'spa' : 'spd', 1, -1, {}); } } });
add('Moody', {
  residual(b, m) {
    if (m.hp <= 0) return;
    const ST7 = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
    const up = ST7.filter((k) => m.sg[k] < 6), upk = up.length ? up[b.rand(up.length)] : null;
    const dn = ST7.filter((k) => m.sg[k] > -6 && k !== upk), dnk = dn.length ? dn[b.rand(dn.length)] : null;
    if (!upk && !dnk) return;
    show(b, m, 'moody');
    if (upk) b.changeStage(m, upk, 2, -1, {});
    if (dnk) b.changeStage(m, dnk, -1, -1, {});
  },
});
add('Adrenaline', { spe(b, m) { return m.hp * 3 <= m.mhp ? 5325 : 0; } });

// ---- reactions of the holder when hit (MEASURED where marked)
add('Force Return', { breakable: true, onHit(b, c, dealt) { const a = c.user; if (dealt > 0 && a.hp > 0 && !b.abFn(a, 'magicGuard')) { show(b, c.target, 'force-return'); b.dealDamage(a, idiv(dealt * 30, 100), { src: 'force-return', from: c.ts }); } } });
add('Cotton Down', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.user.hp > 0) { show(b, c.target, 'cotton-down'); b.changeStage(c.user, 'spe', -1, c.ts, {}); } } });
add('Water Compaction', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.type === T.WATER && c.target.hp > 0) { show(b, c.target, 'water-compaction'); b.changeStage(c.target, 'def', 2, -1, {}); } } });
add('Solidify', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.cat === CAT.SPECIAL && c.target.hp > 0) { show(b, c.target, 'solidify'); b.changeStage(c.target, 'spd', 1, -1, {}); } } });
// Steam Engine: MEASURED +6 stages (the ROM text says 3)
add('Steam Engine', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && (c.type === T.FIRE || c.type === T.WATER) && c.target.hp > 0) { show(b, c.target, 'steam-engine'); b.changeStage(c.target, 'spe', 6, -1, {}); } } });
add('Thermal Exchange', {
  breakable: true, statusImmune(b, m, st) { return st === ST.BRN; },
  onHit(b, c, dealt) { if (dealt > 0 && c.type === T.FIRE && c.target.hp > 0) { show(b, c.target, 'thermal-exchange'); b.changeStage(c.target, 'atk', 1, -1, {}); } },
});
add('Inky', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.user.hp > 0) { show(b, c.target, 'inky'); b.changeStage(c.user, 'acc', -1, c.ts, {}); } } });
// Spicy Spray: MEASURED: burns the attacker every time it is hit by a damaging move
add('Spicy Spray', { breakable: true, onHit(b, c, dealt) { const a = c.user; if (dealt > 0 && a.hp > 0) { show(b, c.target, 'spicy-spray'); b.setStatus(a, ST.BRN, c.target, { fx: 'spicy-spray' }); } } });
add('Pickpocket', { breakable: true, onHit(b, c, dealt) { const t = c.target, a = c.user; if (dealt > 0 && c.contact && !t.it && a.it && t.hp > 0 && !b.abFn(a, 'stickyHold') && !c.subHit) { show(b, t, 'pickpocket'); t.it = a.it; a.it = 0; b.emit({ t: 'trick', s: t.side, m: t.slot, how: 'pickpocket', it: t.it }); } } });
add('Flameburst', { breakable: true, onFaint(b, m, info) { const a = b.act(info.from); if (a && a.hp > 0 && info.mv) { show(b, m, 'flameburst'); b.setStatus(a, ST.BRN, m, { fx: 'flameburst' }); } } });
add('Mummy', { breakable: true, onHit(b, c, dealt) { const a = c.user; if (dealt > 0 && c.contact && a.hp > 0 && a.ab !== c.target.ab) { show(b, c.target, 'mummy'); a.ab = c.target.ab; b.emit({ t: 'copy', s: a.side, m: a.slot, how: 'mummy', ab: a.ab }); } } });

// ---- attacker abilities that act once after a damaging move landed (chances are ability text; RNG order assumed: after the move's own secondary effects)
const chanceStatus = (pct, st, fx, cond) => ({ afterHit(b, c) { const t = c.target; if (t.hp <= 0 || (cond && !cond(b, c)) || t.v.sub > 0 && c.subHit) return; if (b.rand(100) < pct) { show(b, c.user, fx); b.setStatus(t, st, c.user, { fx }); } } });
add('Soothing', chanceStatus(10, ST.SLP, 'soothing'));
add('Poison Touch', chanceStatus(30, ST.PSN, 'poison-touch', (b, c) => c.contact));
add('Toxic Chain', chanceStatus(30, ST.TOX, 'toxic-chain'));
add('Blazing Sun', { afterHit(b, c) { if (c.type === T.FIRE && c.target.hp > 0) { show(b, c.user, 'blazing-sun'); b.setStatus(c.target, ST.BRN, c.user, { fx: 'blazing-sun' }); } } });
const chanceFlinch = (pct, fx, cond) => ({ afterHit(b, c) { const t = c.target; if (t.hp <= 0 || (cond && !cond(b, c)) || t.v.moved || b.abFn(t, 'innerFocus', true)) return; if (b.rand(100) < pct) { t.v.flinch = 1; show(b, c.user, fx); } } });
add('Echoing', chanceFlinch(30, 'echoing', (b, c) => c.mv.flags.sound)); add('Haunting', chanceFlinch(20, 'haunting', (b, c) => c.type === T.GHOST)); add('Stench', chanceFlinch(10, 'stench'));
add('Dust Devil', { afterHit(b, c) { if (c.target.hp > 0 && b.rand(100) < 15) { show(b, c.user, 'dust-devil'); b.confuse(c.target, c.user, { fx: 'dust-devil' }); } } });
add('Mirage', { afterHit(b, c) { if (b.wx() === WX.SUN && c.target.hp > 0 && b.rand(100) < 25) { show(b, c.user, 'mirage'); b.confuse(c.target, c.user, { fx: 'mirage' }); } } });
add('Plantation', { afterHit(b, c) { const t = c.target; if (t.hp > 0 && t.v.seeded === undefined && !b.hasType(t, T.GRASS) && b.rand(100) < 30) { show(b, c.user, 'plantation'); t.v.seeded = c.us; b.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'leech-seed' }); } } });
add('Lifesteal', { afterHit(b, c) { if (c.total > 0) { show(b, c.user, 'lifesteal'); b.healMon(c.user, idiv(c.total, 8), { src: 'lifesteal' }); } } });
add('Spectral Drain', { afterHit(b, c) { if (c.total > 0 && (c.type === T.GROUND || c.type === T.GHOST)) { show(b, c.user, 'spectral-drain'); b.healMon(c.user, idiv(c.total, 4), { src: 'spectral-drain' }); } } });
add('Lunar Cycle', { afterHit(b, c) { show(b, c.user, 'lunar-cycle'); b.changeStage(c.user, 'spe', 1, -1, {}); } });
add('Seer', { afterHit(b, c) { if (c.type === T.PSYCHIC) { show(b, c.user, 'seer'); b.changeStage(c.user, 'spe', 1, -1, {}); } } });
add('Bloodlust', { afterHit(b, c) { if (c.crit) { show(b, c.user, 'bloodlust'); b.changeStage(c.user, 'atk', 1, -1, {}); b.changeStage(c.user, 'spe', 1, -1, {}); } } });
add('Maim and Mend', { afterHit(b, c) { if (c.crit && c.total > 0) { show(b, c.user, 'maim-and-mend'); b.healMon(c.user, idiv(c.total, 4), { src: 'maim-and-mend' }); } } });
add('Magician', { afterHit(b, c) { const u = c.user, t = c.target; if (!u.it && t.it && t.hp > 0 && !b.abFn(t, 'stickyHold', true) && !c.subHit) { show(b, u, 'magician'); u.it = t.it; t.it = 0; b.emit({ t: 'trick', s: u.side, m: u.slot, how: 'magician', it: u.it }); } } });

// ---- knock-out rewards
add('Consume', { onKO(b, m) { show(b, m, 'consume'); b.healMon(m, idiv(m.mhp, 2), { src: 'consume' }); } });
add('Fill Void', { onKO(b, m) { show(b, m, 'fill-void'); b.changeStage(m, 'def', 1, -1, {}); b.changeStage(m, 'spa', 1, -1, {}); } });
add('Chilling Neigh', { onKO(b, m) { show(b, m, 'chilling-neigh'); b.changeStage(m, 'atk', 1, -1, {}); } });
add('Grim Neigh', { onKO(b, m) { show(b, m, 'grim-neigh'); b.changeStage(m, 'spa', 1, -1, {}); } });

// ---- status moves and status conditions
add('Good as Gold', { breakable: true, statusMoveBlock(b, c) { const t = c.target; show(b, t, 'good-as-gold'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });
add('Solar Armor', { breakable: true, statusMoveBlock(b, c) { const t = c.target; show(b, t, 'solar-armor'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });
add('Abyssal Veil', { breakable: true, statusMoveBlock(b, c) { const t = c.target; if (t.hp * 4 <= t.mhp * 3) return false; show(b, t, 'abyssal-veil'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });
add('Magic Bounce', {
  breakable: true,
  magicBounce(b, c) {
    const t = c.target;
    show(b, t, 'magic-bounce');
    b.emit({ t: 'noop', s: t.side, m: t.slot, why: 'bounced', mv: c.id });
    b.useMove(c.ts, c.id, { noPP: true, called: true, bounced: true });
    return true;
  },
});
const prioBlock = (fx) => ({ breakable: true, priorityBlock(b, c) { const t = c.target; show(b, t, fx); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });
add('Dazzling', prioBlock('dazzling')); add('Armor Tail', prioBlock('armor-tail'));
add('Reactive', { reactive: true });
add(['Sweet Veil'], { breakable: true, sleepImmune: true, statusImmune(b, m, st) { return st === ST.SLP; } });
add('Aroma Veil', { breakable: true, tauntImmune: true, loveImmune: true, mentalImmune: true });
add('Early Bird', { sleepTurns(b, m, n) { return idiv(n, 2); } });
add('Unstoppable', { noFatigue: true });
add('Tireless', { tireless: true });
add('Guard Dog', { breakable: true, suctionCups: true, intimidateBoost: true });
add('Debilitate', { breakable: true, ppDrain: 3 });
add('Stone Face', { sturdy(b, m) { return Math.max(1, idiv(m.mhp, 4)); }, blockDrop() { return true; }, breakable: true });
add('Nine Lives', { sturdy() { return true; }, prio(b, m) { return m.hp * 3 <= m.mhp ? 2 : 0; }, breakable: true });

// ---- charged state (next Electric move doubles) and wind
const charge = (b, m, fx) => { if (!m.v.chgd) { m.v.chgd = 1; show(b, m, fx); b.emit({ t: 'volatile', s: m.side, m: m.slot, v: 'charged' }); } };
add('Shockwiring', { onStart(b, m) { charge(b, m, 'shockwiring'); } });
add('Electromorphosis', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.target.hp > 0) charge(b, c.target, 'electromorphosis'); } });
add('Wind Power', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.mv.flags.wind && c.target.hp > 0) charge(b, c.target, 'wind-power'); } });
const windImmune = (stat, fx) => ({
  breakable: true,
  immune(b, c) { if (!c.mv.flags.wind || c.mv.power === 0 && c.mv.category !== CAT.STATUS) return false; const t = c.target; show(b, t, fx); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); b.changeStage(t, stat, 1, -1, {}); return true; },
});
add('Wind Rider', windImmune('atk', 'wind-rider')); add('Wind Chime', windImmune('spa', 'wind-chime'));
add('Smouldering', absorb(T.WATER, (b, m) => { b.changeStage(m, 'spd', 1, -1, {}); }));
add('Ritualist', absorb(T.GHOST, (b, m) => { b.healMon(m, fractionOf(m.mhp, 4), { src: 'ritualist' }); }));
add('Eelevate', {
  breakable: true, levitate: true,
  immune(b, c) {
    if (c.type !== T.GROUND || c.mv.id === 0) return false;
    const t = c.target;
    if (t.v.smack || b.itFn(t, 'ironBall')) return false;
    show(b, t, 'eelevate'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id });
    return true;
  },
  onKO(b, m) { let best = 'atk'; for (const k of ['def', 'spa', 'spd', 'spe']) if (m.st[k] > m.st[best]) best = k; show(b, m, 'eelevate'); b.changeStage(m, best, 1, -1, {}); },
});

// ---- ROUND 3: Neutralizing Gas, Ruin abilities, Permafrost
add('Neutralizing Gas', { ngMarker: true, onStart(b, m) { show(b, m, 'neutralizing-gas'); } });
add(['Sword of Ruin', 'Beads of Ruin', 'Tablets of Ruin', 'Vessel of Ruin'], { onStart(b, m) { show(b, m, 'ruin'); } });
add('Permafrost', {
  breakable: true,
  statusImmune(b, m, st) { return st === ST.BRN; },
  blockDrop(b, m, stat) { return stat === 'atk'; },
  afterHit(b, c) { const t = c.target; if (t.hp > 0 && !(t.v.sub > 0 && c.subHit) && b.rand(100) >= 80) { show(b, c.user, 'permafrost'); b.setStatus(t, ST.FBT, c.user, { fx: 'permafrost' }); } },   // MEASURED: 20% frostbite per damaging hit
});

// ---- ROUND 3 batch F: the remaining abilities a legal team can hold (descriptions are the ROM's own; each was run against the real game where the oracle can reach it, ROMDIFF.md section 8)
add('Perish Body', contact((b, t, a) => { if (!t.v.perish && !a.v.perish && !b.abFn(a, 'soundproof', true)) { show(b, t, 'perish-body'); t.v.perish = 4; a.v.perish = 4; b.emit({ t: 'volatile', s: t.side, m: t.slot, v: 'perish-song' }); } }));
// the ROM has two abilities with this name: the first (Calyrex Ice Rider) is Unnerve + Chilling Neigh, the second (Shadow Rider) is Unnerve + Grim Neigh; `multi` makes the table cover both ids
add('As One', { multi: true, unnerve: true, onStart(b, m) { if (foes(b, m)) show(b, m, 'unnerve'); }, onKO(b, m) { const shadow = m.ab !== b.D.abilityByName['As One']; show(b, m, shadow ? 'grim-neigh' : 'chilling-neigh'); b.changeStage(m, shadow ? 'spa' : 'atk', 1, -1, {}); } });
add('Poison Puppeteer', { poisonPuppeteer: true });
add('Rolling Stones', { rollingStones: true });
add('Overload', { overload: true });
add('Martyr', { inert: true });
add('Mudslide', { breakable: true, immune(b, c) { if (c.type !== T.WATER || c.mv.power === 0 && c.mv.category !== CAT.STATUS || b.wx() !== WX.SAND) return false; const t = c.target; show(b, t, 'mudslide'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); b.changeStage(t, 'def', 2, -1, {}); return true; } });
add('Backdraft', { onOut(b, m) { const f = foeOf(b, m); if (m.hp > 0 && f && f.hp > 0) { show(b, m, 'backdraft'); b.changeStage(f, 'spe', -1, m.side, {}); } } });
add('Null Space', { nullSpace: true });
add('Polarity Shift', { onStart(b, m) { const f = foeOf(b, m); if (!f || f.hp <= 0) return; show(b, m, 'polarity-shift'); const x = b.statOf(m, 'spe'), y = b.statOf(f, 'spe'); (m.v.so = m.v.so || {}).spe = y; (f.v.so = f.v.so || {}).spe = x; } });
add('Brand of Torment', contact((b, t, a) => { if (b.rand(100) < 30 && !a.v.torment && !b.abFn(a, 'mentalImmune', true)) { show(b, t, 'brand-of-torment'); a.v.torment = 1; b.emit({ t: 'volatile', s: a.side, m: a.slot, v: 'torment' }); } }));
add('Pendulum', { bp(b, c) { const p = c.user.v.pend; return p && p.mv === c.id ? 4096 + 819 * Math.min(p.n, 3) : 0; }, afterHit(b, c) { const u = c.user; const p = u.v.pend; u.v.pend = { mv: c.id, n: p && p.mv === c.id ? p.n + 1 : 1 }; } });
add('Valkyrie', { breakable: true, typeProdDef(b, c, prod) { let p = prod; const chart = b.pack.typeChart[c.type]; const f = chart ? chart[T.STEEL] : 4096; if (f < 4096) p = (p * f) >> 12; if (c.type === T.POISON) p = 0; return p; } });
add('Like a Dragon', { stabAlso: T.DRAGON, breakable: true, typeProdDef(b, c, prod) { const chart = b.pack.typeChart[c.type]; const f = chart ? chart[T.DRAGON] : 4096; return f < 4096 ? (prod * f) >> 12 : prod; } });
add('Reef Warden', { onOut(b, m) { if (m.hp > 0 && m.hp < m.mhp) { show(b, m, 'reef-warden'); b.healMon(m, idiv(m.mhp, 2), { src: 'reef-warden' }); } }, breakable: true, onHit(b, c, dealt) { if (!c.contact || dealt <= 0 || c.user.hp <= 0 || c.user.v.hb > 0) return; show(b, c.target, 'reef-warden'); c.user.v.hb = 2; } });
add('Titan Grip', { titanGrip: true });
add('Cud Chew', { cudChew: true });
add('Ripen', { ripen: true });

// ---- ROUND 3 batch G: innate abilities the hack added (ROMDIFF.md section 8).  Each was run against the real game; what was NOT seen there is not modelled and is listed in section 7.4
// Reborn (MEASURED): the first hit that would faint it leaves it standing at full HP; once per battle
add('Reborn', { reborn: true });
// Wimp Out / Emergency Exit (from the ROM's own text "switches out when its HP drops to 1/2 or less"; NOT run in the real game, the oracle plays one Pokemon per side): the Pokemon leaves when a hit takes it
// to half HP or less, asking its player for the replacement the way U-turn does
const fleeAtHalf = { onHp(b, m, from) { if (from * 2 > m.mhp && m.hp * 2 <= m.mhp && m.hp > 0 && b.aliveCount(m.side) > 1 && b.s.pause < 0) { show(b, m, 'flee'); b.s.pause = m.side; b.emit({ t: 'pivot', s: m.side, m: m.slot }); } } };
add('Wimp Out', fleeAtHalf);
add('Emergency Exit', fleeAtHalf);
// Parrying (MEASURED): Focus Punch is not interrupted by a hit.  NOT modelled: "charging hits raise Defense" (no Defense change was seen when a Pokemon was hit while focusing)
add('Parrying', { parrying: true });
// Time Spiral (MEASURED): every move's priority is negated, the foe's as well as the holder's (forced-switch moves keep theirs).  NOT modelled: the extra turn weather and terrain lose (none was seen over 4 turns of rain)
add('Time Spiral', { timeSpiral: true });
// Tidal Deity (MEASURED): while the holder is at full HP its moves go through Protect and through Reflect / Light Screen / Aurora Veil.  NOT modelled: the rain "when HP drops below full" (no rain was seen)
add('Tidal Deity', { tidalDeity: true });
// Frost Nova (from the ROM's own text, NOT seen in the real game: the oracle cannot play past a knock-out): the attacker that knocks the holder out is frozen and loses exactly its next turn
add('Frost Nova', { onFaint(b, m, info) { const a = b.act(info.from); if (a && a.hp > 0 && info.move && b.setStatus(a, ST.FRZ, m, { fx: 'frost-nova', from: m.side })) { a.v.fn = 1; } } });

// ---- ROUND 3: primal weathers (MEASURED: heavy rain / harsh sun / strong winds, entered with a pop-up like Drizzle)
add('Primordial Sea', { onStart(b, m) { if (b.setPrimal(PW.RAIN, m)) show(b, m, 'primal-weather'); } });
add('Desolate Land', { onStart(b, m) { if (b.setPrimal(PW.SUN, m)) show(b, m, 'primal-weather'); } });
add('Delta Stream', { onStart(b, m) { if (b.setPrimal(PW.WINDS, m)) show(b, m, 'primal-weather'); } });

// ---- ROUND 3: gender abilities (MEASURED in the real game, ROMDIFF.md section 8)
add('Cute Charm', contact((b, t, a) => { if (b.rand(100) >= 70 && b.canInfatuate(t, a)) { show(b, t, 'cute-charm'); b.infatuate(a, t, { fx: 'cute-charm' }); } }));
add('Rivalry', { bp(b, c) { const x = b.genderOf(c.user), y = b.genderOf(c.target); if (x === 2 || y === 2) return 0; return x === y ? 5120 : 3072; } });

// ---- ROUND 3: terrain and Gravity abilities (each one probed in the real game; ROMDIFF.md section 8)
const TERRAIN_TYPE = [undefined, T.GRASS, T.ELECTRIC, T.FAIRY, T.PSYCHIC, T.FIRE];
const surge = (name, id) => add(name, { onStart(b, m) { if (b.setTerrain(id, m)) show(b, m, 'surge'); } });
surge('Grassy Surge', TN.GRASSY); surge('Electric Surge', TN.ELECTRIC); surge('Misty Surge', TN.MISTY); surge('Psychic Surge', TN.PSYCHIC);
add('Hadron Engine', {
  onStart(b, m) { if (b.setTerrain(TN.ELECTRIC, m)) show(b, m, 'surge'); },
  atk(b, c) { return c.cat === CAT.SPECIAL && b.terrain() === TN.ELECTRIC ? E.hadronMod : 0; },   // MEASURED 4/3, also for a flying holder
});
// Orichalcum Pulse (the ROM text: harsh sunlight on entry, Attack boosted in it) is an ordinary mechanic; it was listed with the Terastal abilities only by name.  Checked against the real game by the ability
// damage groups of tools/pokemonarena_rom_diff_combos.mjs (match).  Tera Shell is NOT added: in the oracle a holder at full HP took ordinary damage (see ROMDIFF.md 8.7).
add('Orichalcum Pulse', { onStart(b, m) { if (b.setWeather(WX.SUN, m)) show(b, m, 'weather'); }, atk(b, c) { return c.cat === CAT.PHYSICAL && b.wx() === WX.SUN ? E.hadronMod : 0; } });
add('Seed Sower', { onHit(b, c, dealt) { if (dealt > 0 && c.target.hp > 0 && b.setTerrain(TN.GRASSY, c.target)) show(b, c.target, 'seed-sower'); } });
add('Grass Pelt', { breakable: true, def(b, c) { return c.cat === CAT.PHYSICAL && b.terrain() === TN.GRASSY ? 6144 : 0; } });   // MEASURED: any holder while the terrain is up
add('Mystic Force', { spe(b) { return b.terrain() === TN.PSYCHIC ? 8192 : 0; } });
add('Surge Surfer', { spe(b) { return b.terrain() === TN.ELECTRIC ? 8192 : 0; } });
add('Plasma Surge', { afterHit(b, c) { const t = c.target; if (b.terrain() === TN.ELECTRIC && t.hp > 0 && !(t.v.sub > 0 && c.subHit)) { show(b, c.user, 'plasma-surge'); b.setStatus(t, ST.PAR, c.user, { fx: 'plasma-surge' }); } } });
add('Channel Earth', { residual(b, m) { if (b.terrain() && m.hp < m.mhp) { show(b, m, 'channel-earth'); b.healMon(m, fractionOf(m.mhp, 16), { src: 'channel-earth' }); } } });
add('Electromagnetism', {
  breakable: true, levitate: true, electricGrounded: true,
  immune(b, c) {
    if (c.type !== T.GROUND || c.mv.id === 0) return false;
    const t = c.target;
    if (t.v.smack || b.itFn(t, 'ironBall') || b.s.gv > 0) return false;
    show(b, t, 'electromagnetism'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id });
    return true;
  },
});
add('Allseeing Idol', {
  breakable: true, levitate: true,
  immune(b, c) {   // Levitate that Gravity does not cancel
    if (c.type !== T.GROUND || c.mv.id === 0) return false;
    const t = c.target;
    if (t.v.smack || b.itFn(t, 'ironBall')) return false;
    show(b, t, 'allseeing-idol'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id });
    return true;
  },
  def(b, c) { return b.s.gv > 0 && c.cat === CAT.PHYSICAL ? 5325 : 0; },
});
const mimic = (b, m, tn) => {
  if (tn) { m.v.ty = [TERRAIN_TYPE[tn]]; m.v.mim = 1; show(b, m, 'mimicry'); b.emit({ t: 'type-change', s: m.side, m: m.slot, ty: m.v.ty.slice() }); }
  else if (m.v.mim) { delete m.v.mim; delete m.v.ty; show(b, m, 'mimicry'); b.emit({ t: 'type-change', s: m.side, m: m.slot, ty: b.types(m).slice() }); }
};
add('Mimicry', { onStart(b, m) { if (b.terrain()) mimic(b, m, b.terrain()); }, onTerrain(b, m, tn) { mimic(b, m, tn); } });
add('Heatstorm', { onStart(b, m) { if (b.setTerrain(TN.SCORCHED, m)) show(b, m, 'heatstorm'); } });
add('Ash Assets', {
  onKO(b, m) { if (b.terrain() !== TN.SCORCHED && b.setTerrain(TN.SCORCHED, m)) show(b, m, 'ash-assets'); },   // text: after a KO it creates a scorched field if absent (not reachable by the oracle: a KO ends its one-Pokemon battle)
  bp(b, c) { return b.terrain() === TN.SCORCHED ? E.ashAssetsMod : 0; },   // MEASURED x1.15 in the base-power step (fits 4 of 4 rolls tables)
});
add('Gravity Well', { onStart(b, m) { if (b.setGravity()) show(b, m, 'gravity-well'); } });
add('Magnify Field', {
  onStart(b, m) {
    const S = b.s;
    let did = false;
    if (S.tn) { S.tn[1] += 2; did = true; }
    if (S.wx[0] !== WX.NONE && S.wx[1] > 0) { S.wx[1] += 2; did = true; }
    if (did) show(b, m, 'magnify-field');
  },
});

// ---- ROUND 2, batch B (probed in the real game unless marked): ally-only abilities are inert in a singles battle, the rest follow the probes
add(['Run Away', 'Pickup', 'Honey Gather', 'Friend Guard', 'Plus', 'Minus', 'Battery', 'Hospitality', 'Costar', 'Curious Medicine', 'Rally', 'Spacetime Rift', 'Commander'], { inert: true });
add('Steely Spirit', tyBp(T.STEEL, 6144));                       // MEASURED x1.5 on its own Steel moves (the ally half is doubles-only)
add('Long Reach', { noContact: true });                          // MEASURED: a Rough Skin holder does not hurt it
add('Cheek Pouch', { onItemUsed(b, m, it) { if (b.berries.has(it) && m.hp > 0 && m.hp < m.mhp) { show(b, m, 'cheek-pouch'); b.healMon(m, idiv(m.mhp, 3), { src: 'cheek-pouch' }); } } });   // MEASURED: +1/3 max HP after a berry
add('Dancer', { dancer: true });                                  // MEASURED: copies the foe's dance move right after it
add('Harvest', { residual(b, m) { if (m.hp > 0 && !m.it && m.used && b.berries.has(m.used) && (b.wx() === WX.SUN || b.rand(2) === 0)) { show(b, m, 'harvest'); m.it = m.used; m.used = 0; b.emit({ t: 'item', s: m.side, m: m.slot, it: m.it, fx: 'harvest' }); } } });
const copyBoosts = (fx) => ({ breakable: true, copyBoost(b, m, stat, n) { show(b, m, fx); b.changeStage(m, stat, n, -1, { opp: 1 }); } });
add('Opportunist', copyBoosts('opportunist')); add('Tether', copyBoosts('tether'));   // MEASURED (Opportunist): a +2 of the foe is copied
add('Liquid Voice', { moveType(b, m, c) { return c.mv.flags.sound && c.type !== T.WATER ? { type: T.WATER } : undefined; } });   // MEASURED: Water instead of Normal, no 1.2 boost
add('Quick Draw', { quickDraw: true });
add('Brimstone', { fireBreaker: true });                          // MEASURED: a Fire move hits a Flash Fire holder
add('Monsoon', { waterBreaker: true, sureHit(b, c) { return c.type === T.WATER && b.wx() === WX.RAIN; } });
add('Rockstorm', { sureHit(b, c) { return c.type === T.ROCK && b.wx() === WX.SAND; } });
add('Voidtouch', { infiltrates: true });                          // ignores screens, Safeguard and Mist like Infiltrator
add('Stygian', { stygian: true });
add('Momentum', { afterPriority(b, m) { show(b, m, 'momentum'); b.changeStage(m, 'spe', 1, -1, {}); } });   // MEASURED: +1 Speed after a priority move
add('Phantom Soul', { extraType: T.GHOST }); add('Dragon Soul', { extraType: T.DRAGON }); add('Plain Soul', { extraType: T.NORMAL });
add('Fighter Soul', { extraType: T.FIGHTING }); add('Mind Soul', { extraType: T.PSYCHIC }); add('Fae Soul', { extraType: T.FAIRY });     // MEASURED (Phantom Soul): the extra type gives STAB
add('Color Change', { breakable: true, onHit(b, c, dealt) { const t = c.target; if (dealt > 0 && t.hp > 0 && c.type !== T.MYSTERY && !(b.types(t).length === 1 && b.types(t)[0] === c.type)) { show(b, t, 'color-change'); t.v.ty = [c.type]; b.emit({ t: 'type-change', s: t.side, m: t.slot, ty: [c.type] }); } } });
add('Wandering Spirit', { breakable: true, onHit(b, c, dealt) { const a = c.user, t = c.target; if (dealt > 0 && c.contact && a.hp > 0 && t.hp > 0 && a.ab !== t.ab) { show(b, t, 'wandering-spirit'); const x = a.ab; a.ab = t.ab; t.ab = x; b.emit({ t: 'copy', s: a.side, m: a.slot, how: 'wandering-spirit', ab: a.ab }); } } });
add('Lingering Aroma', { breakable: true, onHit(b, c, dealt) { const a = c.user, t = c.target; if (dealt > 0 && c.contact && a.hp > 0 && a.ab !== t.ab) { show(b, t, 'lingering-aroma'); a.ab = t.ab; b.emit({ t: 'copy', s: a.side, m: a.slot, how: 'lingering-aroma', ab: a.ab }); } } });
add('Mirror Armor', { breakable: true, reflectDrop: true });      // MEASURED: a Growl comes back at the user
add('Sand Spit', { breakable: true, onHit(b, c, dealt) { if (dealt > 0 && c.target.hp > 0 && b.setWeather(WX.SAND, c.target)) show(b, c.target, 'sand-spit'); } });   // MEASURED: starts a sandstorm
add('Toxic Debris', { breakable: true, onHit(b, c, dealt) { const f = b.s.sides[c.us]; if (dealt > 0 && c.cat === CAT.PHYSICAL && c.target.hp > 0 && f.hz.ts < 2) { show(b, c.target, 'toxic-debris'); f.hz.ts += 1; b.emit({ t: 'hazard', s: c.us, hz: 'ts', n: f.hz.ts }); } } });
add('Parental Bond', { parental: true }); add('Dual Strike', { parental: true });   // MEASURED: a second hit for 1/4 of the first (total 60 for a 48 hit)
add('Aura Shield', { breakable: true, firstHit(b, c) { const t = c.target; if (t.v.ash) return false; t.v.ash = 1; show(b, t, 'aura-shield'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); return true; } });   // MEASURED: the first attack does nothing, the second is normal
add('Disguise', {
  breakable: true,
  firstHit(b, c) { const t = c.target; if (t.dg) return false; t.dg = 1; show(b, t, 'disguise'); b.emit({ t: 'immune', s: t.side, m: t.slot, why: 'ability', ab: t.ab, mv: c.id }); b.dealDamage(t, fractionOf(t.mhp, 8), { src: 'disguise', from: -1 }); return true; },
});

// Burrower / Diver / Flier (ROM text): Dig / Dive / Fly are used in ONE turn and hit 50 percent harder (assumed: not probed)
const oneTurn = (name) => ({ oneTurn(b, c) { return c.mv.name === name; }, bp(b, c) { return c.mv.name === name ? 6144 : 0; } });
add('Burrower', oneTurn('Dig')); add('Diver', oneTurn('Dive')); add('Flier', oneTurn('Fly'));
add('Queenly Majesty', prioBlock('queenly-majesty'));
add(['Power Of Alchemy', 'Receiver', 'Ball Fetch', 'Propeller Tail', 'Power Spot'], { inert: true });   // ally / item-pickup abilities: nothing happens in a singles battle
// Multitype: Arceus takes the type of its held Plate (plate hold effect 89); the Plate cannot be removed by Knock Off / Thief style moves.
add('Multitype', {
  noRemove: true,
  onStart(b, m) {
    const it = b.pack.items[m.it];
    const t = it && it.holdEffect === 89 ? b.D.named.typeItems[m.it] : undefined;
    if (t === undefined || (m.v.ty && m.v.ty.length === 1 && m.v.ty[0] === t)) return;
    show(b, m, 'multitype'); m.v.ty = [t]; b.emit({ t: 'type-change', s: m.side, m: m.slot, ty: [t] });
  },
});
export const ABILITIES = Object.freeze(A);
export const ABILITY_NAMES = Object.freeze(Object.keys(A));

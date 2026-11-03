// tools/pokemonarena_engine_suite1.mjs -- hand-computed checks, part 1: arithmetic, classification, damage, order, accuracy,
// crits, status, weather and field.  Every expected number is derived on paper in the comment above it.
// A suite is a function of the loaded modules; it returns [{ id, fn }] where fn() returns true or a failure string.
// The same suite runs against the real source and against every mutant (tools/pokemonarena_engine_test.mjs).

import { makeLab, RS } from './pokemonarena_engine_lib.mjs';

export function suite1(M, pack, rom) {
  const L = makeLab(M, pack);
  const { lab, run, turn, mid, MV, SW, of, lost, healed, eq, J, T } = L;
  const C = M.engine_calc, X = M.engine_data;
  const checks = [];
  const add = (id, fn) => checks.push({ id, fn });
  const dmg = (spec, move, o) => lab(spec).previewDamage(0, mid(move), o || {});

  // ------------------------------------------------------------------ pure arithmetic
  add('calc/idiv', () => eq([C.idiv(7, 2), C.idiv(0, 5), C.idiv(99, 100), C.idiv(100, 100)], [3, 0, 0, 1]));
  // pokeMod rounds .5 DOWN: 19 * 6144/4096 = 28.5 -> 28 ; 20 * 1.5 = 30 ; 41 * 1.5 = 61.5 -> 61 ; 19 * 0.5 = 9.5 -> 9
  add('calc/pokeMod-rounds-half-down', () => eq([C.pokeMod(19, 6144), C.pokeMod(20, 6144), C.pokeMod(41, 6144), C.pokeMod(19, 2048), C.pokeMod(19, 8192)], [28, 30, 61, 9, 38]));
  // chainMod: 1.5 * 1.5 = 2.25 -> 9216 ; (6144*6144 + 2048) >> 12 = 9216
  add('calc/chain', () => eq([C.chain([6144, 6144]), C.chain([]), C.chain([2048, 2048]), C.chain([5324])], [9216, 4096, 1024, 5324]));
  // stage table from the ROM: +2 -> 20/10, -1 -> 10/15 (floor(100*10/15)=66), +6 -> 40/10, -6 -> 10/40
  add('calc/applyStage', () => eq([C.applyStage(100, 2), C.applyStage(100, -1), C.applyStage(100, 6), C.applyStage(100, -6), C.applyStage(100, 0), C.applyStage(100, 9)], [200, 66, 400, 25, 100, 400]));
  // accuracy stage 3/(3+s): +1 -> 133, -1 -> 75, -6 -> 33, +6 -> 300
  add('calc/applyAccStage', () => eq([C.applyAccStage(100, 1), C.applyAccStage(100, -1), C.applyAccStage(100, -6), C.applyAccStage(100, 6), C.applyAccStage(100, 0)], [133, 75, 33, 300, 100]));
  // L50 BP40 A100 D100: floor(floor(22*40*100/100)/50)+2 = floor(880/50)+2 = 19 ; BP90: floor(1980/50)+2 = 41 ; L100 BP100 A300 D100: 42*100*300/100 = 12600 -> /50 = 252 -> 254
  add('calc/baseDamage', () => eq([C.baseDamage(50, 40, 100, 100), C.baseDamage(50, 90, 100, 100), C.baseDamage(100, 100, 300, 100)], [19, 41, 254]));
  add('calc/rollFactor', () => eq([C.rollFactor(0), C.rollFactor(15)], [100, 85]));
  add('calc/typeMult-and-product', () => eq([C.applyTypeMult(24, 8192), C.applyTypeMult(25, 2048), C.typeProduct([8192, 8192]), C.typeProduct([8192, 2048]), C.typeProduct([0, 8192]), C.typeProduct([2048, 2048])], [48, 12, 16384, 4096, 0, 1024]));
  add('calc/fractionOf-min-1', () => eq([C.fractionOf(200, 16), C.fractionOf(5, 16), C.fractionOf(200, 3, 2)], [12, 1, 133]));

  // ------------------------------------------------------------------ the ROM-static stage table
  add('rom-static/stat-stage-ratio-table-matches-ROM-bytes', () => {
    const off = X.STAT_STAGE_RATIOS_ROM_OFFSET;
    const got = [];
    for (let i = 0; i < 13; i++) got.push([rom[off + 2 * i], rom[off + 2 * i + 1]]);
    return eq(got, X.STAT_STAGE_RATIOS.map((p) => [p[0], p[1]]));
  });
  add('rom/type-ids-match-pack-names', () => {
    const want = { NORMAL: 'Normal', FIGHTING: 'Fighting', FLYING: 'Flying', POISON: 'Poison', GROUND: 'Ground', ROCK: 'Rock', BUG: 'Bug', GHOST: 'Ghost', STEEL: 'Steel', FIRE: 'Fire', WATER: 'Water', GRASS: 'Grass', ELECTRIC: 'Electric', PSYCHIC: 'Psychic', ICE: 'Ice', DRAGON: 'Dragon', DARK: 'Dark', FAIRY: 'Fairy' };
    for (const k of Object.keys(want)) if (pack.types[X.T[k]].name.toLowerCase() !== want[k].toLowerCase()) return `${k}: pack says ${pack.types[X.T[k]].name}`;
    return true;
  });

  // ------------------------------------------------------------------ move-effect classification evidence
  add('classify/every-EFFECTS-anchor-carries-that-effect-id', () => {
    for (const id of Object.keys(X.EFFECTS)) {
      const ef = X.EFFECTS[id];
      for (const nm of ef.anchors) {
        const m = pack.moves[D().moveByName[nm]];
        if (!m) return `effect ${id}: anchor ${nm} is not in the pack`;
        if (m.effect !== Number(id)) return `effect ${id}: anchor ${nm} has effect ${m.effect}`;
      }
      if (ef.anchors.length === 0) return `effect ${id} (${ef.kind}) has no anchor move`;
    }
    return true;
  });
  add('classify/every-ADDITIONAL-anchor-carries-that-secondary-id', () => {
    for (const id of Object.keys(X.ADDITIONAL)) {
      for (const nm of X.ADDITIONAL[id].anchors) {
        const m = pack.moves[D().moveByName[nm]];
        if (!m) return `additional ${id}: anchor ${nm} missing`;
        if (!m.additional.some((a) => a.effect === Number(id))) return `additional ${id}: anchor ${nm} lacks it`;
      }
    }
    return true;
  });
  add('classify/no-name-in-the-data-tables-is-missing-from-the-pack', () => eq(D().missing, []));
  add('classify/move-args-equal-the-ROM-argument-byte', () => {
    // move record offset + 0x24 is the argument byte (recoil %, drain %, status id, protect kind, ...)
    const base = 0x769860, stride = 0x48;
    const arg = (n) => rom[base + D().moveByName[n] * stride + 0x24];
    const tables = [['recoil', 1], ['drain', 1], ['statusType', 1], ['fixed', 1], ['fraction', 1], ['protect', 1], ['counter', 1]];
    for (const [t] of tables) for (const [nm, v] of Object.entries(X.MOVE_ARGS[t])) if (arg(nm) !== v) return `${t}.${nm}: engine ${v} rom ${arg(nm)}`;
    for (const [nm, v] of Object.entries(X.ROM_WEATHER_ARG)) if (arg(nm) !== v) return `weather ${nm}: ${arg(nm)} != ${v}`;
    return true;
  });
  add('classify/multihit-and-explosion-flags-select-the-known-moves', () => {
    const names = (f) => pack.moves.filter(f).map((m) => m.name).sort();
    const multi = names((m) => m.bytes[5] & 1), boom = names((m) => m.bytes[5] & 2);
    const wantMulti = ['Arm Thrust', 'Barrage', 'Bone Rush', 'Bullet Seed', 'Comet Punch', 'Double Slap', 'Fury Attack', 'Fury Swipes', 'Icicle Spear', 'Pin Missile', 'Rock Blast', 'Scale Shot', 'Spike Cannon', 'Tail Slap', 'Water Shuriken'].sort();
    const r1 = eq(multi, wantMulti);
    return r1 !== true ? 'multi-hit: ' + r1 : eq(boom, ['Explosion', 'Misty Explosion', 'Self-Destruct']);
  });
  add('classify/semi-invulnerable-hit-flags', () => {
    const has = (n, bit) => (pack.moves[D().moveByName[n]].bytes[8] & bit) !== 0;
    return eq([has('Earthquake', 8), has('Surf', 16), has('Thunder', 32), has('Gust', 64), has('Pound', 8 | 16 | 32 | 64)], [true, true, true, true, false]);
  });
  function D() { return L.D; }
  add('classify/every-kind-in-EFFECTS-has-a-handler-except-planned-ones', () => {
    const planned = ['pursuit']; // listed in EFFECTS but deliberately unimplemented
    const missing = [...new Set(Object.values(X.EFFECTS).map((e) => e.kind))].filter((k) => !M.engine_moves.IMPLEMENTED_KINDS.has(k) && planned.indexOf(k) < 0);
    return eq(missing, []);
  });

  // ------------------------------------------------------------------ damage arithmetic (previewDamage: no RNG)
  // L50, BP40, A100, D100 -> base 19 (see calc/baseDamage). Roll index 0 = 100%, 15 = 85%: floor(19*85/100) = 16.
  add('damage/base-and-roll-range', () => eq([dmg({}, 'Pound', { roll: 0 }), dmg({}, 'Pound', { roll: 15 }), dmg({}, 'Pound', { roll: 7 })], [19, 16, 17]));
  // all 16 rolls: floor(19*(100-i)/100)
  add('damage/all-sixteen-rolls', () => {
    const got = []; for (let i = 0; i < 16; i++) got.push(dmg({}, 'Pound', { roll: i }));
    // by hand, floor(19*(100-i)/100) for i = 0..15: 19.00 18.81 18.62 18.43 18.24 18.05 17.86 17.67 17.48 17.29 17.10 16.91 16.72 16.53 16.34 16.15
    return eq(got, [19, 18, 18, 18, 18, 18, 17, 17, 17, 17, 17, 16, 16, 16, 16, 16]);
  });
  // STAB: attacker Normal-type -> 19 * 1.5 = 28.5 -> 28 (half rounds down)
  add('damage/stab-1.5x', () => eq(dmg({ a: { ty: [T.NORMAL] } }, 'Pound'), 28));
  add('damage/no-stab-for-other-types', () => eq(dmg({ a: { ty: [T.FIRE] } }, 'Pound'), 19));
  add('damage/stab-second-type', () => eq(dmg({ a: { ty: [T.FIRE, T.NORMAL] } }, 'Pound'), 28));
  // Karate Chop: Fighting BP50 -> floor(floor(22*50*100/100)/50)+2 = 24 ; vs Normal 2x -> 48 ; vs Flying 0.5x -> 12 ; Ghost: Fighting vs Ghost is 0x? (Fighting>Ghost = 0)
  add('damage/type-effectiveness-2x-0.5x', () => eq([dmg({}, 'Karate Chop'), dmg({ b: { ty: [T.NORMAL] } }, 'Karate Chop'), dmg({ b: { ty: [T.FLYING] } }, 'Karate Chop')], [24, 48, 12]));
  // dual types multiply: Normal+Ice = 2x*2x -> 24*2*2 = 96 ; Flying+Bug = 0.5*0.5 -> 24 -> 12 -> 6
  add('damage/dual-type-4x-and-quarter', () => eq([dmg({ b: { ty: [T.NORMAL, T.ICE] } }, 'Karate Chop'), dmg({ b: { ty: [T.FLYING, T.BUG] } }, 'Karate Chop')], [96, 6]));
  add('damage/immunity-gives-zero', () => eq(dmg({ b: { ty: [T.GHOST] } }, 'Pound'), 0));
  // special: Flamethrower BP90 -> 41 ; with Fire STAB 61 (61.5 down) ; vs Grass 2x -> 122 ; vs Water 0.5x -> 30
  add('damage/special-base-41', () => eq(dmg({}, 'Flamethrower'), 41));
  add('damage/stab-then-type-122-and-30', () => eq([dmg({ a: { ty: [T.FIRE] }, b: { ty: [T.GRASS] } }, 'Flamethrower'), dmg({ a: { ty: [T.FIRE] }, b: { ty: [T.WATER] } }, 'Flamethrower')], [122, 30]));
  // crit x1.5 before the roll: 19 -> 28
  add('damage/crit-1.5x', () => eq(dmg({}, 'Pound', { crit: true }), 28));
  // burn halves PHYSICAL only: 19 -> 9 ; special unchanged 41
  add('damage/burn-halves-physical-only', () => eq([dmg({ a: { s: 3 } }, 'Pound'), dmg({ a: { s: 3 } }, 'Flamethrower')], [9, 41]));
  // screens: Reflect (physical) 19 -> 9 ; Light Screen (special) 41 -> 20 ; crit ignores them: 28
  add('damage/screens-halve-and-crits-ignore-them', () => eq([
    dmg({ sd: [null, { reflect: 5 }] }, 'Pound'), dmg({ sd: [null, { light: 5 }] }, 'Flamethrower'), dmg({ sd: [null, { reflect: 5 }] }, 'Pound', { crit: true }), dmg({ sd: [null, { reflect: 5 }] }, 'Flamethrower'),
  ], [9, 20, 28, 41]));
  // weather: rain Water 19 -> 28, Fire 41 -> 20 ; sun Water 19 -> 9, Fire 41 -> 61
  add('damage/weather-boost-and-cut', () => eq([
    dmg({ wx: [1, 5] }, 'Water Gun'), dmg({ wx: [1, 5] }, 'Flamethrower'), dmg({ wx: [2, 5] }, 'Water Gun'), dmg({ wx: [2, 5] }, 'Flamethrower'), dmg({ wx: [3, 5] }, 'Water Gun'),
  ], [28, 20, 9, 61, 19]));
  // stat stages: atk +2 -> A=200 -> floor(floor(22*40*200/100)/50)+2 = 37 ; atk -1 -> A=66 -> 13 ; def +2 -> D=200 -> 10
  add('damage/stat-stages', () => eq([dmg({ a: { sg: { atk: 2 } } }, 'Pound'), dmg({ a: { sg: { atk: -1 } } }, 'Pound'), dmg({ b: { sg: { def: 2 } } }, 'Pound')], [37, 13, 10]));
  // crit ignores the attacker's negative stage and the defender's positive stage: atk -2 and def +2 with a crit -> same as no stages (28)
  add('damage/crit-ignores-bad-attack-and-good-defense-stages', () => eq([dmg({ a: { sg: { atk: -2 } }, b: { sg: { def: 2 } } }, 'Pound', { crit: true }), dmg({ a: { sg: { atk: -2 } }, b: { sg: { def: 2 } } }, 'Pound')], [28, 6]));
  // level 100, BP100 move (Hyper Beam is 150, use L100 with Flamethrower BP90): floor(floor(42*90*100/100)/50)+2 = floor(3780/50)+2 = 75+2 = 77
  add('damage/level-100-base', () => eq(dmg({ a: { level: 100 } }, 'Flamethrower'), 77));
  // minimum 1: tiny attack vs huge defense
  add('damage/minimum-one', () => eq(dmg({ a: { st: { atk: 1 } }, b: { st: { def: 999 } } }, 'Pound'), 2));
  // life orb 19 -> pokeMod(19, 5324) = 25 ; choice band atk x1.5 -> A=150 -> floor(floor(22*40*150/100)/50)+2 = 28 ; muscle band bp 40*1.1 -> 4505 mod
  add('damage/items-life-orb-choice-band-expert-belt', () => eq([
    dmg({ a: { it: 'Life Orb' } }, 'Pound'), dmg({ a: { it: 'Choice Band' } }, 'Pound'), dmg({ a: { it: 'Choice Band' } }, 'Flamethrower'),
    dmg({ a: { it: 'Expert Belt' }, b: { ty: [T.NORMAL] } }, 'Karate Chop'), dmg({ a: { it: 'Expert Belt' } }, 'Karate Chop'),
  ], [25, 28, 41, 58, 24]));
  // Silk Scarf (Normal) bp 40 -> 48 (pokeMod 4915) -> floor(floor(22*48*100/100)/50)+2 = 21+2 = 23 ; wrong type item no effect
  add('damage/type-item-boosts-matching-type-only', () => eq([dmg({ a: { it: 'Silk Scarf' } }, 'Pound'), dmg({ a: { it: 'Charcoal' } }, 'Pound')], [23, 19]));
  // abilities: Technician 40 -> 60 -> 28 ; Huge Power 37 ; Adaptability with STAB 38 ; Thick Fat vs Fire spa 100 -> 50 -> 21 ; Multiscale full hp -> 9
  add('damage/abilities-technician-hugepower-adaptability-thickfat-multiscale', () => eq([
    dmg({ a: { ab: 'Technician' } }, 'Pound'), dmg({ a: { ab: 'Huge Power' } }, 'Pound'), dmg({ a: { ab: 'Adaptability', ty: [T.NORMAL] } }, 'Pound'),
    dmg({ b: { ab: 'Thick Fat' } }, 'Flamethrower'), dmg({ b: { ab: 'Multiscale' } }, 'Pound'),
  ], [28, 37, 38, 21, 9]));
  // Mold Breaker ignores the defender's Multiscale (breakable): preview of a Mold Breaker attacker
  add('damage/mold-breaker-ignores-defender-abilities', () => {
    const b = lab({ a: { ab: 'Mold Breaker' }, b: { ab: 'Multiscale' } });
    b.s.mb = true;
    return eq(b.previewDamage(0, mid('Pound')), 19);
  });
  // eviolite: defender with an evolution line gets x1.5 def: species 25 evolves -> D=150 -> floor(22*40*100/150)=586 -> /50 = 11 -> 13
  add('damage/eviolite-and-assault-vest', () => eq([dmg({ b: { it: 'Eviolite' } }, 'Pound'), dmg({ b: { it: 'Assault Vest' } }, 'Flamethrower')], [13, 28]));
  // flying press: Fighting 6.. dual type effectiveness vs Normal (2x) and Flying (x1 vs Flying? Fighting>Flying is 0.5, Flying>Normal 1): see class test
  // the confusion hit is typeless physical BP40 with no modifiers
  add('damage/confusion-self-hit-is-plain-40-power', () => {
    const b = lab({ a: { moves: ['Pound'], v: { conf: 3 }, ab: 'Technician', it: 'Life Orb', ty: [T.NORMAL] } });
    const ev = turn(b, MV(0), MV(0), [0, 0]); // order: no tie; confusion check rand(100)=0 < 33 -> self hit; roll rand(16)=0
    return eq([of(ev, 'confusion-hit').length, lost(ev, 0)], [1, 19]);
  });

  // ------------------------------------------------------------------ order, priority, speed
  const order = (spec, ca, cb, rng) => { const r = run(spec, { ca, cb, rng }); return of(r.ev, 'move-use').map((e) => e.s); };
  add('order/faster-moves-first', () => eq(order({ a: { moves: ['Pound'] }, b: { moves: ['Pound'] } }, MV(0), MV(0), [1, 0, 1, 0]), [0, 1]));
  add('order/slower-first-when-b-is-faster', () => eq(order({ a: { moves: ['Pound'], st: { spe: 40 } }, b: { moves: ['Pound'] } }, MV(0), MV(0), [1, 0, 1, 0]), [1, 0]));
  add('order/priority-beats-speed', () => eq(order({ a: { moves: ['Pound'] }, b: { moves: ['Quick Attack'] } }, MV(0), MV(0), [1, 0, 1, 0]), [1, 0]));
  add('order/speed-tie-uses-one-rand2', () => eq([order({ a: { moves: ['Pound'], st: { spe: 50 } }, b: { moves: ['Pound'] } }, MV(0), MV(0), [0, 1, 0, 1, 0]), order({ a: { moves: ['Pound'], st: { spe: 50 } }, b: { moves: ['Pound'] } }, MV(0), MV(0), [1, 1, 0, 1, 0])], [[0, 1], [1, 0]]));
  // paralysis halves speed: A 100 -> 50 = B 50 -> tie ; with B 49 -> A first
  add('order/paralysis-halves-speed', () => eq([order({ a: { moves: ['Pound'], s: 5 }, b: { moves: ['Pound'], st: { spe: 49 } } }, MV(0), MV(0), [1, 1, 0, 1, 0]), order({ a: { moves: ['Pound'], s: 5 }, b: { moves: ['Pound'], st: { spe: 51 } } }, MV(0), MV(0), [1, 0, 1, 1, 0])], [[0, 1], [1, 0]]));
  add('order/stat-stage-speed-and-choice-scarf', () => eq([order({ a: { moves: ['Pound'], st: { spe: 40 }, sg: { spe: 2 } }, b: { moves: ['Pound'] } }, MV(0), MV(0), [1, 0, 1, 0]), order({ a: { moves: ['Pound'], st: { spe: 40 }, it: 'Choice Scarf' }, b: { moves: ['Pound'] } }, MV(0), MV(0), [1, 0, 1, 0])], [[0, 1], [0, 1]]));
  add('order/trick-room-reverses', () => eq(order({ a: { moves: ['Pound'] }, b: { moves: ['Pound'] }, tr: 5 }, MV(0), MV(0), [1, 0, 1, 0]), [1, 0]));
  add('order/tailwind-doubles-speed', () => eq(order({ a: { moves: ['Pound'], st: { spe: 40 } }, b: { moves: ['Pound'] }, sd: [{ tw: 3 }, null] }, MV(0), MV(0), [1, 0, 1, 0]), [0, 1]));
  add('order/switch-goes-before-moves', () => {
    const b = lab({ a: { moves: ['Pound'], bench: [{ moves: ['Pound'] }] }, b: { moves: ['Quick Attack'] } });
    const ev = turn(b, SW(1), MV(0), [1, 0]);
    return eq(ev.filter((e) => e.t === 'switch-in' || e.t === 'move-use').map((e) => e.t), ['switch-in', 'move-use']);
  });
  add('order/prankster-gives-status-moves-priority', () => eq(order({ a: { moves: ['Pound'] }, b: { moves: ['Splash'], ab: 'Prankster' } }, MV(0), MV(0), [1, 0]), [1, 0]));

  // ------------------------------------------------------------------ accuracy and crits
  // Pound (acc 100): accuracy stage -1 -> 75. rand(100) < 75 hits.  RNG order: accuracy, crit, roll.
  add('accuracy/stage-minus-1-hits-at-74-misses-at-75', () => {
    const h = run({ a: { moves: ['Pound'], sg: { acc: -1 } } }, { rng: [74, 1, 0] });
    const m = run({ a: { moves: ['Pound'], sg: { acc: -1 } } }, { rng: [75] });
    return eq([lost(h.ev, 1), of(m.ev, 'miss').length, lost(m.ev, 1)], [19, 1, 0]);
  });
  add('accuracy/target-evasion-stage-counts', () => eq(of(run({ a: { moves: ['Pound'] }, b: { sg: { eva: 1 } } }, { rng: [75] }).ev, 'miss').length, 1));
  // Compound Eyes: 75 * 5325/4096 -> pokeMod = (75*5325+2047)>>12 = 98 ; hits at 97 misses at 98
  add('accuracy/compound-eyes', () => eq([lost(run({ a: { moves: ['Pound'], sg: { acc: -1 }, ab: 'Compound Eyes' } }, { rng: [97, 1, 0] }).ev, 1), of(run({ a: { moves: ['Pound'], sg: { acc: -1 }, ab: 'Compound Eyes' } }, { rng: [98] }).ev, 'miss').length], [19, 1]));
  add('accuracy/no-rng-call-when-the-move-cannot-miss', () => eq(lost(run({ a: { moves: ['Pound'] } }, { rng: [1, 0] }).ev, 1), 19));
  add('accuracy/hypnosis-60-percent', () => eq([of(run({ a: { moves: ['Hypnosis'] } }, { rng: [59, 2] }).ev, 'status-set').length, of(run({ a: { moves: ['Hypnosis'] } }, { rng: [60] }).ev, 'miss').length], [1, 1]));
  add('accuracy/ohko-uses-30-plus-level-difference', () => {
    const hit = run({ a: { moves: ['Fissure'] } }, { rng: [29] });
    const miss = run({ a: { moves: ['Fissure'] } }, { rng: [30] });
    return eq([hit.B.hp, of(miss.ev, 'miss').length], [0, 1]);
  });
  add('accuracy/ohko-fails-against-a-higher-level-target', () => eq(of(run({ a: { moves: ['Fissure'] }, b: { level: 51 } }, { rng: [] }).ev, 'miss').length, 1));
  add('accuracy/thunder-never-misses-in-rain-and-is-50-in-sun', () => {
    const rain = run({ a: { moves: ['Thunder'] }, wx: [1, 5] }, { rng: [1, 0, 99] });
    const sun = run({ a: { moves: ['Thunder'] }, wx: [2, 5] }, { rng: [50] });
    return eq([lost(rain.ev, 1) > 0, of(sun.ev, 'miss').length], [true, 1]);
  });
  // crit: stage 0 -> rand(24)==0 ; Karate Chop (crit stage 1) -> rand(8)==0 ; focus energy +2 -> rand(2)
  add('crit/odds-24-8-2-1', () => eq([
    of(run({ a: { moves: ['Pound'] } }, { rng: [0, 0] }).ev, 'crit').length, of(run({ a: { moves: ['Pound'] } }, { rng: [1, 0] }).ev, 'crit').length,
    of(run({ a: { moves: ['Karate Chop'] } }, { rng: [0, 0] }).ev, 'crit').length, of(run({ a: { moves: ['Karate Chop'] } }, { rng: [1, 0] }).ev, 'crit').length,
    of(run({ a: { moves: ['Pound'], v: { fe: 1 } } }, { rng: [1, 0] }).ev, 'crit').length, of(run({ a: { moves: ['Pound'], v: { fe: 1 } } }, { rng: [0, 0] }).ev, 'crit').length,
  ], [1, 0, 1, 0, 0, 1]));
  add('crit/stage-3-always-crits-with-rand1', () => eq(of(run({ a: { moves: ['Karate Chop'], v: { fe: 1 }, it: 'Scope Lens' } }, { rng: [0, 0] }).ev, 'crit').length, 1));
  add('crit/battle-armor-blocks-and-consumes-no-crit-roll', () => eq(of(run({ a: { moves: ['Pound'] }, b: { ab: 'Battle Armor' } }, { rng: [0] }).ev, 'crit').length, 0));
  add('crit/damage-1.5x-in-a-real-turn', () => eq(lost(run({ a: { moves: ['Pound'] } }, { rng: [0, 0] }).ev, 1), 28));
  add('damage/roll-uses-rand16', () => eq(lost(run({ a: { moves: ['Pound'] } }, { rng: [1, 15] }).ev, 1), 16));

  // ------------------------------------------------------------------ status conditions
  const endTurnLoss = (spec, rng) => { const r = run(spec, { ca: MV(0), cb: MV(0), rng }); return { r, a: 200 - r.A.hp, b: 200 - r.B.hp }; };
  add('status/burn-residual-1-16', () => eq(endTurnLoss({ b: { s: 3 } }).b, 12));
  add('status/poison-residual-1-8', () => eq(endTurnLoss({ b: { s: 2 } }).b, 25));
  add('status/toxic-grows-each-turn', () => {
    const b = lab({ b: { s: 6, sc: 1 } });
    turn(b, MV(0), MV(0)); const l1 = 200 - b.s.sides[1].team[0].hp;
    turn(b, MV(0), MV(0)); const l2 = 200 - b.s.sides[1].team[0].hp - l1;
    turn(b, MV(0), MV(0)); const l3 = 200 - b.s.sides[1].team[0].hp - l1 - l2;
    return eq([l1, l2, l3], [12, 24, 36]); // the ROM divides first (floor(200/16) = 12) then multiplies by the counter (measured, ROMDIFF.md)
  });
  add('status/magic-guard-prevents-residual', () => eq(endTurnLoss({ b: { s: 3, ab: 'Magic Guard' } }).b, 0));
  add('status/sleep-skips-sc-attempts-then-wakes-and-acts', () => {
    const b = lab({ a: { moves: ['Pound'], s: 1, sc: 2 } });
    const r = [];
    for (let i = 0; i < 3; i++) { const ev = turn(b, MV(0), MV(0), i < 2 ? undefined : [1, 0]); r.push(of(ev, 'cant-move').length + ':' + of(ev, 'status-clear').length + ':' + of(ev, 'move-use').filter((e) => e.s === 0).length); }
    return eq(r, ['1:0:0', '1:0:0', '0:1:1']);
  });
  add('status/paralysis-full-para-is-rand4-zero', () => eq([of(run({ a: { moves: ['Pound'], s: 5 }, b: { st: { spe: 40 } } }, { rng: [0] }).ev, 'cant-move').length, lost(run({ a: { moves: ['Pound'], s: 5 }, b: { st: { spe: 40 } } }, { rng: [1, 1, 0] }).ev, 1)], [1, 19]));
  add('status/freeze-thaws-on-rand5-zero-else-stays', () => eq([of(run({ a: { moves: ['Pound'], s: 4 } }, { rng: [0, 1, 0] }).ev, 'status-clear').length, of(run({ a: { moves: ['Pound'], s: 4 } }, { rng: [4] }).ev, 'cant-move').length], [1, 1]));
  add('status/fire-move-thaws-the-user', () => eq(of(run({ a: { moves: ['Flame Wheel'], s: 4 } }, { rng: [4, 1, 0, 50] }).ev, 'status-clear').length, 1));
  add('status/confusion-counts-down-and-ends', () => {
    const b = lab({ a: { moves: ['Pound'], v: { conf: 2 } } });
    const e1 = turn(b, MV(0), MV(0), [50, 1, 0]); // confusion rand(100)=50 >= 33: no self-hit ; crit 1 ; roll 0
    const e2 = turn(b, MV(0), MV(0), [1, 0]); // conf 1 -> 0 : ends, acts normally
    return eq([of(e1, 'volatile-end').length, of(e2, 'volatile-end').length, b.s.sides[0].team[0].v.conf], [0, 1, undefined]);
  });
  add('status/flinch-only-if-the-target-has-not-moved', () => {
    const slowFlinch = run({ a: { moves: ['Pound'], st: { spe: 40 } }, b: { moves: ['Pound'] } }, { rng: [1, 0, 1, 0] });
    return eq(of(slowFlinch.ev, 'cant-move').length, 0);
  });
  add('status/safeguard-blocks-status-from-the-foe', () => eq(of(run({ a: { moves: ['Thunder Wave'] }, b: { }, sd: [null, { sg: 3 }] }, { rng: [10] }).ev, 'status-set').length, 0));
  add('status/type-immunities', () => {
    const t = (st, ty) => { const b = lab({ b: { ty: [ty] } }); return b.setStatus(b.s.sides[1].team[0], st, b.s.sides[0].team[0], {}); };
    return eq([t(3, T.FIRE), t(4, T.ICE), t(2, T.POISON), t(6, T.STEEL), t(5, T.ELECTRIC), t(3, T.WATER), t(2, T.NORMAL)], [false, false, false, false, false, true, true]);
  });
  add('status/sleep-length-is-1-plus-rand3', () => {
    const b = lab({});
    b.rand = L.scripted([2]);
    b.setStatus(b.s.sides[1].team[0], 1, b.s.sides[0].team[0], {});
    delete b.rand;
    return eq(b.s.sides[1].team[0].sc, 3);
  });

  // ------------------------------------------------------------------ weather, hazards, screens
  add('weather/rain-dance-lasts-5-turns', () => {
    const b = lab({ a: { moves: ['Rain Dance'] } });
    const ev = turn(b, MV(0), MV(0));
    const w = [b.s.wx[1]];
    for (let i = 0; i < 4; i++) turn(b, MV(0), MV(0));
    return eq([of(ev, 'weather').length, w[0], b.s.wx[0]], [1, 4, 0]);
  });
  add('weather/sandstorm-damages-non-rock-ground-steel-1-16', () => {
    const r = run({ wx: [3, 5], a: { ty: [T.ROCK] }, b: { ty: [T.NORMAL] } });
    return eq([200 - r.A.hp, 200 - r.B.hp], [0, 12]);
  });
  add('weather/hail-hurts-all-but-ice-and-snow-does-not-hurt', () => {
    const r = run({ wx: [4, 5], a: { ty: [T.ICE] } });
    const s = run({ wx: [5, 5] });
    return eq([200 - r.A.hp, 200 - r.B.hp, 200 - s.B.hp], [0, 12, 0]);
  });
  add('weather/snow-boosts-ice-physical-defense', () => eq(dmg({ wx: [5, 5], b: { ty: [T.ICE] } }, 'Pound'), 13));
  add('weather/cloud-nine-suppresses', () => eq(dmg({ wx: [1, 5], b: { ab: 'Cloud Nine' } }, 'Water Gun'), 19));
  add('hazard/spikes-1-2-3-layers-1-8-1-6-1-4', () => {
    const out = [];
    for (const n of [1, 2, 3]) {
      const b = lab({ a: { moves: ['Pound'] }, b: { bench: [{ moves: ['Splash'] }] }, sd: [null, { hz: { sp: n, ts: 0, sr: 0, sw: 0 } }] });
      const ev = turn(b, MV(0), SW(1), [1, 0]);
      out.push(of(ev, 'hazard-damage').length + ':' + lost(ev, 1, 'spikes'));
    }
    return eq(out, ['1:25', '1:33', '1:50']);
  });
  add('hazard/stealth-rock-uses-type-chart', () => {
    const rk = (ty) => { const b = lab({ b: { bench: [{ moves: ['Splash'], ty: [ty] }] }, sd: [null, { hz: { sp: 0, ts: 0, sr: 1, sw: 0 } }] }); b.s.sides[1].team[1].ty = [ty]; const ev = turn(b, MV(0), SW(1)); return lost(ev, 1, 'stealth-rock'); };
    return eq([rk(T.NORMAL), rk(T.FIRE), rk(T.FIGHTING)], [25, 50, 12]);
  });
  add('hazard/toxic-spikes-and-sticky-web-and-boots', () => {
    const sw = (hz, bench) => { const b = lab({ b: { bench: [Object.assign({ moves: ['Splash'] }, bench || {})] }, sd: [null, { hz }] }); if (bench && bench.ty) b.s.sides[1].team[1].ty = bench.ty; if (bench && bench.it) b.s.sides[1].team[1].it = L.itid(bench.it); const ev = turn(b, MV(0), SW(1)); return { st: b.s.sides[1].team[1].s, spe: b.s.sides[1].team[1].sg.spe, ev }; };
    return eq([sw({ sp: 0, ts: 1, sr: 0, sw: 0 }).st, sw({ sp: 0, ts: 2, sr: 0, sw: 0 }).st, sw({ sp: 0, ts: 1, sr: 0, sw: 0 }, { ty: [T.POISON] }).st, sw({ sp: 0, ts: 0, sr: 0, sw: 1 }).spe, sw({ sp: 0, ts: 0, sr: 0, sw: 1 }, { it: 'Heavy-Duty Boots' }).spe], [2, 6, 0, -1, 0]);
  });
  add('hazard/flying-types-and-levitate-avoid-spikes', () => {
    const b = lab({ b: { bench: [{ moves: ['Splash'] }] }, sd: [null, { hz: { sp: 3, ts: 0, sr: 0, sw: 0 } }] });
    b.s.sides[1].team[1].ty = [T.FLYING];
    return eq(lost(turn(b, MV(0), SW(1)), 1, 'spikes'), 0);
  });
  add('screen/reflect-5-turns-in-a-real-turn', () => {
    const b = lab({ a: { moves: ['Pound'] }, b: { moves: ['Reflect'] } });
    const ev = turn(b, MV(0), MV(0), [1, 0]);
    return eq([of(ev, 'screen').length, b.s.sides[1].reflect, lost(ev, 1)], [1, 4, 19]);
  });
  return checks;
}

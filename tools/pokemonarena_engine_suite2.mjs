// tools/pokemonarena_engine_suite2.mjs -- hand-computed checks, part 2: one scenario per move-effect CLASS (every kind in
// engine_moves.js MOVE_KINDS), then abilities and items.  Arithmetic is shown above each expectation.
// Defaults of the lab (tools/pokemonarena_engine_lib.mjs): both mons level 50, all stats 100 (speed A 100, B 50), 200 HP,
// type '???' (no STAB, everything neutral), no ability, no item.  RNG order inside a plain hit is [crit rand(24), roll rand(16)],
// preceded by an accuracy rand(100) only for moves below 100% accuracy.

import { makeLab } from './pokemonarena_engine_lib.mjs';

export function suite2(M, pack, rom) {
  const L = makeLab(M, pack);
  const { lab, run, turn, mid, MV, SW, of, lost, healed, eq, T } = L;
  const checks = [];
  const covered = new Set();
  /** register a class test: kind (or kinds) it covers */
  const kt = (kinds, id, fn) => { for (const k of [].concat(kinds)) covered.add(k); checks.push({ id: `class/${[].concat(kinds).join('+')}/${id}`, fn }); };
  const add = (id, fn) => checks.push({ id, fn });
  const hit = (ev, s) => lost(ev, s, 'move'); // damage dealt by moves only
  const NC = [1, 0]; // no crit, max roll
  const A = (m, extra) => Object.assign({ moves: [m] }, extra || {});

  // ================================================================== damaging classes
  kt('hit', 'plain-hit-19', () => eq(hit(run({ a: A('Pound') }, { rng: NC }).ev, 1), 19));
  // Giga Drain BP75: floor(floor(22*75*100/100)/50)+2 = floor(1650/50)+2 = 35 ; heals floor(35*50/100) = 17
  kt('drain', 'heals-half-of-damage', () => { const r = run({ a: A('Giga Drain', { hp: 100 }) }, { rng: NC }); return eq([hit(r.ev, 1), healed(r.ev, 0)], [35, 17]); });
  kt('drain', 'liquid-ooze-reverses', () => { const r = run({ a: A('Giga Drain', { hp: 100 }), b: { ab: 'Liquid Ooze' } }, { rng: NC }); return eq([healed(r.ev, 0), lost(r.ev, 0, 'liquid-ooze')], [0, 17]); });
  // Dream Eater BP100: floor(2200/50)+2 = 46, heals 23; fails on an awake target
  kt('dreameater', 'needs-a-sleeping-target', () => {
    const ok = run({ a: A('Dream Eater', { hp: 100 }), b: { s: 1, sc: 3 } }, { rng: NC });
    const no = run({ a: A('Dream Eater') }, { rng: [] });
    return eq([hit(ok.ev, 1), healed(ok.ev, 0), of(no.ev, 'fail').length], [46, 23, 1]);
  });
  // Double-Edge BP120: floor(2640/50)+2 = 54 ; recoil floor(54*33/100) = 17
  kt('recoil', 'one-third-recoil', () => { const r = run({ a: A('Double-Edge') }, { rng: NC }); return eq([hit(r.ev, 1), lost(r.ev, 0, 'recoil')], [54, 17]); });
  kt('recoil', 'rock-head-prevents', () => eq(lost(run({ a: A('Double-Edge', { ab: 'Rock Head' }) }, { rng: NC }).ev, 0, 'recoil'), 0));
  // Jump Kick (acc 95) missing: user loses half max HP (100)
  kt('crash', 'miss-costs-half-hp', () => { const r = run({ a: A('Jump Kick') }, { rng: [95] }); return eq([of(r.ev, 'miss').length, lost(r.ev, 0, 'crash')], [1, 100]); });
  // Struggle: BP50 typeless: floor(1100/50)+2 = 24 ; recoil 1/4 of max HP = 50
  kt('struggle', 'typeless-with-quarter-recoil', () => {
    const b = lab({ a: A('Pound', { pp: [0] }) });
    const rq = b.requests()[0];
    const ev = turn(b, MV(4), MV(0), NC);
    return eq([rq.struggle, rq.moves.length, hit(ev, 1), lost(ev, 0, 'recoil')], [true, 1, 24, 50]);
  });
  // Mind Blown BP150: floor(3300/50)+2 = 68 ; user loses half max HP
  kt('mindblown', 'user-loses-half', () => { const r = run({ a: A('Mind Blown') }, { rng: NC }); return eq([hit(r.ev, 1), lost(r.ev, 0, 'mind-blown')], [68, 100]); });
  // Burn Up (fire user): BP130 special: floor(2860/50)+2 = 59, STAB -> pokeMod(59,6144) = 88 ; the user loses its Fire type
  kt('burnup', 'stab-then-loses-fire-type', () => {
    const r = run({ a: A('Burn Up', { ty: [T.FIRE] }) }, { rng: NC });
    const no = run({ a: A('Burn Up') }, { rng: [] });
    return eq([hit(r.ev, 1), r.b.types(r.A), of(no.ev, 'fail').length], [88, [T.MYSTERY], 1]);
  });
  kt('leveldamage', 'level-damage-no-rng', () => eq(hit(run({ a: A('Seismic Toss') }, { rng: [] }).ev, 1), 50));
  // Psywave: floor(level * (rand(101) + 50) / 100): rand 50 -> 50 ; rand 0 -> 25
  kt('psywave', 'half-to-one-and-a-half-level', () => eq([hit(run({ a: A('Psywave') }, { rng: [50] }).ev, 1), hit(run({ a: A('Psywave') }, { rng: [0] }).ev, 1)], [50, 25]));
  kt('fixeddamage', 'sonic-boom-20-dragon-rage-40', () => eq([hit(run({ a: A('Sonic Boom') }, { rng: [0] }).ev, 1), hit(run({ a: A('Dragon Rage') }, { rng: [] }).ev, 1)], [20, 40]));
  kt('fractiondamage', 'half-current-hp', () => eq([hit(run({ a: A('Super Fang') }, { rng: [0] }).ev, 1), hit(run({ a: A('Super Fang'), b: { hp: 101 } }, { rng: [0] }).ev, 1)], [100, 50]));
  kt('ohko', 'ko-and-sturdy-and-ice', () => {
    const k = run({ a: A('Fissure') }, { rng: [29] });
    const st = run({ a: A('Fissure'), b: { ab: 'Sturdy' } }, { rng: [] });
    const ice = run({ a: A('Sheer Cold'), b: { ty: [T.ICE] } }, { rng: [] });
    return eq([k.B.hp, st.B.hp, ice.B.hp], [0, 200, 200]);
  });
  kt('endeavor', 'brings-target-to-user-hp', () => { const r = run({ a: A('Endeavor', { hp: 50 }) }, { rng: [] }); const no = run({ a: A('Endeavor') }, { rng: [] }); return eq([hit(r.ev, 1), of(no.ev, 'fail').length], [150, 1]); });
  kt('finalgambit', 'damage-equal-to-hp-then-faint', () => { const r = run({ a: A('Final Gambit', { hp: 80 }) }, { rng: [] }); return eq([hit(r.ev, 1), r.A.hp], [80, 0]); });
  // Counter: B (faster, spe 150) Pound 19 first ; Counter priority -5 returns 2x = 38 ; Mirror Coat vs special 2x ; Metal Burst 1.5x of 19 = 28
  kt('counter', 'doubles-physical-and-fails-on-special', () => {
    const r = run({ a: A('Counter'), b: { moves: ['Pound'], st: { spe: 150 } } }, { rng: NC });
    const f = run({ a: A('Counter'), b: { moves: ['Water Gun'], st: { spe: 150 } } }, { rng: NC });
    return eq([hit(r.ev, 1), of(f.ev, 'fail').length], [38, 1]);
  });
  kt('counter', 'mirror-coat-and-metal-burst', () => {
    const m = run({ a: A('Mirror Coat'), b: { moves: ['Water Gun'], st: { spe: 150 } } }, { rng: NC });
    const mb = run({ a: A('Metal Burst'), b: { moves: ['Pound'], st: { spe: 150 } } }, { rng: NC });
    return eq([hit(m.ev, 1), hit(mb.ev, 1)], [38, 28]);
  });
  // Flail at 20/200 HP: floor(20*48/200)=4 -> BP150 -> 68
  kt('flail', 'low-hp-more-power', () => eq(hit(run({ a: A('Flail', { hp: 20 }) }, { rng: NC }).ev, 1), 68));
  kt('return', 'bp102', () => eq(hit(run({ a: A('Return') }, { rng: NC }).ev, 1), 46));
  // Present: roll < 40 -> BP40 -> 19 ; roll >= 80 heals the target by 1/4 max
  kt('present', 'damage-or-heal', () => {
    const d = run({ a: A('Present') }, { rng: [0, 0, 1, 0] });
    const h = run({ a: A('Present'), b: { hp: 100 } }, { rng: [0, 90] });
    return eq([hit(d.ev, 1), healed(h.ev, 1)], [19, 50]);
  });
  // Magnitude: roll 50 (<65) -> magnitude 7 -> BP70 -> floor(1540/50)+2 = 32
  kt('magnitude', 'roll-to-bp', () => eq(hit(run({ a: A('Magnitude') }, { rng: [50, 1, 0] }).ev, 1), 32));
  // Hidden Power: type from the mon (Fire), BP60 -> 28 ; Fire STAB 42 ; vs Grass 84
  kt('hiddenpower', 'type-from-ivs-with-stab', () => eq(hit(run({ a: A('Hidden Power', { ty: [T.FIRE], hpt: T.FIRE }), b: { ty: [T.GRASS] } }, { rng: NC }).ev, 1), 84));
  // Facade statused: BP140: floor(3080/50)+2 = 63 and the burn halving is ignored
  kt('facade', 'doubles-when-statused-and-ignores-burn', () => eq(hit(run({ a: A('Facade', { s: 3 }) }, { rng: NC }).ev, 1), 63));
  // Hex BP65 -> statused target BP130: floor(2860/50)+2 = 59 ; plain 30 ; Smelling Salts on paralysis BP140 -> 63 and cures
  kt('condpower', 'hex-and-smelling-salts', () => {
    const x = run({ a: A('Hex'), b: { s: 2 } }, { rng: NC });
    const y = run({ a: A('Hex') }, { rng: NC });
    const z = run({ a: A('Smelling Salts'), b: { s: 5 } }, { rng: [1, 0] });
    return eq([hit(x.ev, 1), hit(y.ev, 1), hit(z.ev, 1), z.B.s], [59, 30, 63, 0]);
  });
  // Revenge after being hit: BP120 -> 54
  kt('revenge', 'doubles-after-damage', () => eq(hit(run({ a: A('Revenge'), b: { moves: ['Pound'], st: { spe: 150 } } }, { rng: [1, 0, 1, 0] }).ev, 1), 54));
  // Water Spout at 100/200 HP: BP75 -> 35
  kt('eruption', 'hp-scaled', () => eq(hit(run({ a: A('Water Spout', { hp: 100 }) }, { rng: NC }).ev, 1), 35));
  // Low Kick vs 60 kg (wt 600): BP80 -> floor(1760/50)+2 = 37
  kt('lowkick', 'weight-tiers', () => eq([hit(run({ a: A('Low Kick'), b: { wt: 600 } }, { rng: NC }).ev, 1), hit(run({ a: A('Low Kick'), b: { wt: 50 } }, { rng: NC }).ev, 1)], [37, 10]));
  // Wring Out at 100/200: BP floor(120*100/200) = 60 (the ROM has no +1, measured) -> floor(1320/50)+2 = 28
  kt('wringout', 'hp-scaled', () => eq(hit(run({ a: A('Wring Out'), b: { hp: 100 } }, { rng: NC }).ev, 1), 28));
  kt('assurance', 'doubles-if-target-was-hit', () => eq([hit(run({ a: A('Assurance'), b: { v: { hit: 5 } } }, { rng: NC }).ev, 1), hit(run({ a: A('Assurance') }, { rng: NC }).ev, 1)], [54, 28]));
  // Acrobatics BP55: no item -> 110 -> floor(2420/50)+2 = 50 ; with an item 26
  kt('acrobatics', 'doubles-without-item', () => eq([hit(run({ a: A('Acrobatics') }, { rng: NC }).ev, 1), hit(run({ a: A('Acrobatics', { it: 'Leftovers' }) }, { rng: NC }).ev, 1)], [50, 26]));
  // Heavy Slam 1000 vs 200 -> ratio 500% -> BP120 -> 54
  kt('heavyslam', 'weight-ratio', () => eq(hit(run({ a: A('Heavy Slam', { wt: 1000 }), b: { wt: 200 } }, { rng: NC }).ev, 1), 54));
  kt('punishment', 'counts-target-boosts', () => eq(hit(run({ a: A('Punishment'), b: { sg: { atk: 2, spa: 1 } } }, { rng: NC }).ev, 1), 54));
  kt('storedpower', 'counts-own-boosts', () => eq(hit(run({ a: A('Stored Power', { sg: { atk: 2 } }) }, { rng: NC }).ev, 1), 28));
  kt('electroball', 'speed-ratio', () => eq(hit(run({ a: A('Electro Ball') }, { rng: NC }).ev, 1), 37));
  kt('gyroball', 'slow-user', () => eq(hit(run({ a: A('Gyro Ball', { st: { spe: 40 } }), b: { st: { spe: 100 } } }, { rng: NC }).ev, 1), 29));
  kt('echoedvoice', 'grows-per-turn', () => {
    const b = lab({ a: A('Echoed Voice') });
    const e1 = turn(b, MV(0), MV(0), NC), e2 = turn(b, MV(0), MV(0), NC);
    return eq([hit(e1, 1), hit(e2, 1)], [19, 37]);
  });
  kt('payback', 'doubles-if-target-moved-first', () => eq(hit(run({ a: A('Payback'), b: { st: { spe: 150 } } }, { rng: NC }).ev, 1), 46));
  kt('brine', 'doubles-at-half-hp', () => eq(hit(run({ a: A('Brine'), b: { hp: 100 } }, { rng: NC }).ev, 1), 59));
  kt('foulplay', 'uses-target-attack', () => eq(hit(run({ a: A('Foul Play', { st: { atk: 50 } }), b: { st: { atk: 200 } } }, { rng: NC }).ev, 1), 85));
  kt('psyshock', 'special-vs-defense', () => eq(hit(run({ a: A('Psyshock'), b: { st: { def: 200, spd: 50 } } }, { rng: NC }).ev, 1), 19));
  kt('suckerpunch', 'only-vs-an-attack', () => {
    const ok = run({ a: A('Sucker Punch'), b: { moves: ['Pound'] } }, { rng: [1, 0, 1, 0] });
    const no = run({ a: A('Sucker Punch') }, { rng: [] });
    return eq([hit(ok.ev, 1), of(no.ev, 'fail').length], [32, 1]);
  });
  // Flying Press vs Normal: Fighting 2x * Flying 1x -> 46*2 = 92 ; vs Steel: 2x * 0.5x -> 46
  kt('flyingpress', 'dual-type', () => eq([hit(run({ a: A('Flying Press'), b: { ty: [T.NORMAL] } }, { rng: [0, 1, 0] }).ev, 1), hit(run({ a: A('Flying Press'), b: { ty: [T.STEEL] } }, { rng: [0, 1, 0] }).ev, 1)], [92, 46]));
  kt('stomptantrum', 'doubles-after-a-failed-move', () => eq(hit(run({ a: A('Stomping Tantrum', { v: { prevFail: 0 } }) }, { rng: NC }).ev, 1), 68));
  kt('lashout', 'doubles-after-a-stat-drop', () => eq(hit(run({ a: A('Lash Out', { v: { drop: 1 } }) }, { rng: NC }).ev, 1), 68));
  kt('bodypress', 'uses-defense', () => eq(hit(run({ a: A('Body Press', { st: { def: 200 } }) }, { rng: NC }).ev, 1), 72));
  kt('boltbeak', 'doubles-when-moving-first', () => eq(hit(run({ a: A('Bolt Beak') }, { rng: NC }).ev, 1), 76));
  // Collision Course BP100 vs Normal: 46 -> 92, then x1.33 (5461) final -> 123
  kt('collision', 'bonus-when-super-effective', () => eq(hit(run({ a: A('Collision Course'), b: { ty: [T.NORMAL] } }, { rng: NC }).ev, 1), 123));
  kt('ragefist', 'counts-hits-taken', () => { const b = lab({ a: A('Rage Fist') }); b.s.sides[0].team[0].ht = 2; return eq(hit(turn(b, MV(0), MV(0), NC), 1), 68); });
  kt('lastrespects', 'counts-fainted-allies', () => eq(hit(run({ a: A('Last Respects'), sd: [{ nfaint: 2 }, null] }, { rng: NC }).ev, 1), 68));
  // Triple Kick: three hits BP10/20/30 -> 6 + 10 + 15 = 31, an accuracy check per hit
  kt('triplekick', 'three-escalating-hits', () => eq(hit(run({ a: A('Triple Kick') }, { rng: [0, 1, 0, 0, 1, 0, 0, 1, 0] }).ev, 1), 31));
  kt('fellstinger', 'plus-three-on-ko', () => { const r = run({ a: A('Fell Stinger'), b: { hp: 10 } }, { rng: NC }); return eq([r.B.hp, r.A.sg.atk], [0, 3]); });
  // Knock Off with a target item: BP 65*1.5 = 97 -> floor(2134/50)+2 = 44, the item is removed
  kt('knockoff', 'bonus-and-removes-item', () => { const r = run({ a: A('Knock Off'), b: { it: 'Leftovers' } }, { rng: NC }); return eq([hit(r.ev, 1), r.B.it], [44, 0]); });
  kt('thief', 'steals-item', () => { const r = run({ a: A('Thief'), b: { it: 'Leftovers' } }, { rng: NC }); return eq([r.A.it > 0, r.B.it], [true, 0]); });
  kt('uturn', 'pauses-for-a-pivot-switch', () => {
    const b = lab({ a: A('U-turn', { bench: [A('Pound')] }) });
    turn(b, MV(0), MV(0), NC);
    const rq = b.requests();
    const ev = turn(b, SW(1), null);
    return eq([b.s.phase === 'move', rq[0].phase, rq[0].reason, of(ev, 'switch-in').length], [true, 'switch', 'pivot', 1]);
  });
  kt('dragontail', 'forces-the-target-out', () => {
    const b = lab({ a: A('Dragon Tail'), b: { bench: [A('Pound')] } });
    const ev = turn(b, MV(0), MV(0), [0, 1, 0, 0]);
    return eq([of(ev, 'forced-out').length, b.s.sides[1].act], [1, 1]);
  });
  kt('snore', 'only-while-asleep', () => {
    const ok = run({ a: A('Snore', { s: 1, sc: 2 }) }, { rng: [1, 0, 99] });
    const no = run({ a: A('Snore') }, { rng: [] });
    return eq([hit(ok.ev, 1), of(no.ev, 'fail').length], [24, 1]);
  });
  kt('falseswipe', 'leaves-one-hp', () => eq(run({ a: A('False Swipe'), b: { hp: 10 } }, { rng: NC }).B.hp, 1));
  kt('furycutter', 'doubles-per-consecutive-hit', () => {
    const b = lab({ a: A('Fury Cutter') });
    const e1 = turn(b, MV(0), MV(0), [0, 1, 0]), e2 = turn(b, MV(0), MV(0), [0, 1, 0]);
    return eq([hit(e1, 1), hit(e2, 1)], [19, 37]);
  });
  kt('firstturn', 'only-on-the-first-turn', () => {
    const b = lab({ a: A('Fake Out'), b: { moves: ['Pound'] } });
    const e1 = turn(b, MV(0), MV(0), NC);
    const e2 = turn(b, MV(0), MV(0), [1, 0]);
    return eq([hit(e1, 1), of(e1, 'cant-move').filter((e) => e.why === 'flinch').length, of(e2, 'fail').length], [19, 1, 1]);
  });
  kt('focuspunch', 'fails-if-hit-first', () => {
    const bad = run({ a: A('Focus Punch'), b: { moves: ['Pound'], st: { spe: 150 } } }, { rng: [1, 0] });
    const ok = run({ a: A('Focus Punch') }, { rng: NC });
    return eq([hit(bad.ev, 1), of(bad.ev, 'cant-move').filter((e) => e.why === 'lost-focus').length, hit(ok.ev, 1)], [0, 1, 68]);
  });
  kt('weatherball', 'type-and-power-from-weather', () => eq([hit(run({ a: A('Weather Ball'), wx: [1, 5] }, { rng: NC }).ev, 1), hit(run({ a: A('Weather Ball') }, { rng: NC }).ev, 1)], [69, 24]));
  // Freeze-Dry BP70: floor(1540/50)+2 = 32 ; Ice vs Water is 2x for it -> 64
  kt('freezedry', 'super-effective-on-water', () => eq(hit(run({ a: A('Freeze-Dry'), b: { ty: [T.WATER] } }, { rng: [1, 0, 99] }).ev, 1), 64));
  // Revelation Dance takes the user's first type (Fire): BP90 -> 41 -> STAB 61
  kt('revelation', 'uses-first-type', () => eq(hit(run({ a: A('Revelation Dance', { ty: [T.FIRE, T.NORMAL] }) }, { rng: NC }).ev, 1), 61));
  kt('rapidspin', 'clears-hazards-and-raises-speed', () => { const r = run({ a: A('Rapid Spin'), sd: [{ hz: { sp: 2, ts: 0, sr: 1, sw: 0 } }, null] }, { rng: NC }); return eq([r.S.sides[0].hz.sr, r.S.sides[0].hz.sp, r.A.sg.spe], [0, 0, 1]); });
  kt('twoturn', 'charge-then-hit', () => {
    const b = lab({ a: A('Razor Wind') });
    const e1 = turn(b, MV(0), MV(0)), e2 = turn(b, null, MV(0), NC); // the charging side is locked: it makes no choice
    return eq([of(e1, 'charge').length, hit(e1, 1), hit(e2, 1)], [1, 0, 37]);
  });
  // Solar Beam in sun skips the charge: BP120 special: floor(2640/50)+2 = 54 ; otherwise it charges
  kt('solarbeam', 'no-charge-in-sun', () => eq([hit(run({ a: A('Solar Beam'), wx: [2, 5] }, { rng: NC }).ev, 1), of(run({ a: A('Solar Beam') }).ev, 'charge').length], [54, 1]));
  kt('semiinvuln', 'invulnerable-while-charging', () => {
    const b = lab({ a: A('Fly'), b: { moves: ['Pound'], st: { spe: 40 } } });
    const e1 = turn(b, MV(0), MV(0));
    return eq([of(e1, 'charge').length, of(e1, 'avoid').length, hit(e1, 0)], [1, 1, 0]);
  });

  // ================================================================== stat, status, heal and field classes
  kt('stats', 'swords-dance-and-growl', () => eq([run({ a: A('Swords Dance') }).A.sg.atk, run({ a: A('Growl') }).B.sg.atk], [2, -1]));
  kt('stats', 'shell-smash-mixed', () => { const s = run({ a: A('Shell Smash') }).A.sg; return eq([s.atk, s.spa, s.spe, s.def, s.spd], [2, 2, 2, -1, -1]); });
  kt('growth', 'plus-one-or-two-in-sun', () => eq([run({ a: A('Growth') }).A.sg.atk, run({ a: A('Growth'), wx: [2, 5] }).A.sg.spa], [1, 2]));
  kt('bellydrum', 'half-hp-for-max-attack', () => { const r = run({ a: A('Belly Drum') }); const f = run({ a: A('Belly Drum', { hp: 100 }) }); return eq([r.A.hp, r.A.sg.atk, of(f.ev, 'fail').length], [100, 6, 1]); });
  kt('strengthsap', 'heals-by-target-attack-and-drops-it', () => { const r = run({ a: A('Strength Sap', { hp: 100 }), b: { st: { atk: 80 } } }); return eq([r.A.hp, r.B.sg.atk], [180, -1]); });
  kt('status', 'thunder-wave-toxic-wisp-spore', () => eq([
    run({ a: A('Thunder Wave') }, { rng: [0, 1] }).B.s, run({ a: A('Toxic') }, { rng: [0] }).B.s, run({ a: A('Will-O-Wisp') }, { rng: [0] }).B.s, run({ a: A('Spore') }, { rng: [1] }).B.s,
  ], [5, 6, 3, 1]));
  kt('status', 'thunder-wave-misses-ground-types', () => eq(run({ a: A('Thunder Wave'), b: { ty: [T.GROUND] } }, { rng: [0] }).B.s, 0));
  kt('status', 'powder-blocked-by-grass', () => eq(run({ a: A('Spore'), b: { ty: [T.GRASS] } }, { rng: [] }).B.s, 0));
  // Supersonic acc 55 then confusion length 2 + rand(4)
  // the target then takes its own turn: conf 3 -> 2 and a rand(3) self-hit roll (1 = no hit)
  kt('confuse', 'sets-confusion-2-to-5-turns', () => eq(run({ a: A('Supersonic') }, { rng: [0, 1, 50] }).B.v.conf, 2));
  kt('swagger', 'attack-up-2-and-confusion', () => { const r = run({ a: A('Swagger') }, { rng: [0, 2, 50] }); return eq([r.B.sg.atk, r.B.v.conf], [2, 3]); });
  kt('flatter', 'spa-up-1-and-confusion', () => { const r = run({ a: A('Flatter') }, { rng: [0, 50] }); return eq([r.B.sg.spa, r.B.v.conf], [1, 1]); });
  kt('yawn', 'sleep-after-two-turn-ends', () => {
    const b = lab({ a: A('Yawn') });
    turn(b, MV(0), MV(0));
    const s1 = b.s.sides[1].team[0].s;
    turn(b, MV(0), MV(0), [0]);
    return eq([s1, b.s.sides[1].team[0].s], [0, 1]);
  });
  kt('leechseed', 'drains-eighth-each-turn', () => { const r = run({ a: A('Leech Seed', { hp: 100 }) }, { rng: [0] }); return eq([200 - r.B.hp, r.A.hp], [25, 125]); });
  kt('leechseed', 'grass-types-are-immune', () => eq(run({ a: A('Leech Seed'), b: { ty: [T.GRASS] } }, { rng: [0] }).B.v.seeded, undefined));
  kt('toxicthread', 'poison-and-speed-drop', () => { const r = run({ a: A('Toxic Thread') }); return eq([r.B.s, r.B.sg.spe], [2, -1]); });
  kt('heal', 'recover-half-roost-and-weather-heals', () => eq([
    run({ a: A('Recover', { hp: 50 }) }).A.hp, run({ a: A('Moonlight', { hp: 50 }), wx: [2, 5] }).A.hp, run({ a: A('Moonlight', { hp: 50 }), wx: [1, 5] }).A.hp,
    run({ a: A('Moonlight', { hp: 50 }) }).A.hp, run({ a: A('Roost', { hp: 50, ty: [T.FLYING] }) }).A.hp, run({ a: A('Recover') }).ev.filter((e) => e.t === 'fail').length,
  ], [150, 183, 100, 150, 150, 1]));
  kt('heal', 'life-dew-quarter-and-shore-up-sand', () => eq([run({ a: A('Life Dew', { hp: 50 }) }).A.hp, run({ a: A('Shore Up', { hp: 50, ty: [T.ROCK] }), wx: [3, 5] }).A.hp], [100, 183]));
  kt('rest', 'full-heal-and-two-turns-of-sleep', () => { const r = run({ a: A('Rest', { hp: 50, s: 3 }) }); return eq([r.A.hp, r.A.s, r.A.sc], [200, 1, 2]); });
  kt('painsplit', 'average-hp', () => { const r = run({ a: A('Pain Split', { hp: 40 }) }); return eq([r.A.hp, r.B.hp], [120, 120]); });
  kt('healbell', 'cures-the-whole-team', () => { const r = run({ a: A('Heal Bell', { s: 3, bench: [A('Pound')], benchSpec: { s: 2 } }) }); return eq([r.A.s, r.S.sides[0].team[1].s], [0, 0]); });
  kt('refresh', 'cures-burn', () => eq(run({ a: A('Refresh', { s: 3 }) }).A.s, 0));
  kt('wish', 'heals-half-at-the-end-of-next-turn', () => { const b = lab({ a: A('Wish', { hp: 100 }) }); turn(b, MV(0), MV(0)); const h1 = b.s.sides[0].team[0].hp; turn(b, MV(0), MV(0)); return eq([h1, b.s.sides[0].team[0].hp], [100, 200]); });
  kt('weather', 'rain-sun-sand-hail-snow', () => eq([run({ a: A('Rain Dance') }).S.wx[0], run({ a: A('Sunny Day') }).S.wx[0], run({ a: A('Sandstorm') }).S.wx[0], run({ a: A('Hail') }).S.wx[0], run({ a: A('Snowscape') }).S.wx[0]], [1, 2, 3, 4, 5]));
  kt('weather', 'damp-rock-extends-to-8', () => eq(run({ a: A('Rain Dance', { it: 'Damp Rock' }) }).S.wx[1], 7));
  kt('screen', 'reflect-light-screen-aurora-veil', () => eq([run({ a: A('Reflect') }).S.sides[0].reflect, run({ a: A('Light Screen') }).S.sides[0].light, run({ a: A('Aurora Veil') }).S.sides[0].veil, run({ a: A('Aurora Veil'), wx: [4, 5] }).S.sides[0].veil, run({ a: A('Reflect', { it: 'Light Clay' }) }).S.sides[0].reflect], [4, 4, 0, 4, 7]));
  kt('hazard', 'layers-and-caps', () => {
    const b = lab({ a: A('Spikes') });
    for (let i = 0; i < 4; i++) turn(b, MV(0), MV(0));
    const r = run({ a: A('Stealth Rock') }), t = run({ a: A('Toxic Spikes') }), w = run({ a: A('Sticky Web') });
    return eq([b.s.sides[1].hz.sp, r.S.sides[1].hz.sr, t.S.sides[1].hz.ts, w.S.sides[1].hz.sw], [3, 1, 1, 1]);
  });
  kt('trickroom', 'toggles', () => { const b = lab({ a: A('Trick Room') }); turn(b, MV(0), MV(0)); const on = b.s.tr; turn(b, MV(0), MV(0)); return eq([on, b.s.tr], [4, 0]); });
  kt('tailwind', 'four-turns', () => eq(run({ a: A('Tailwind') }).S.sides[0].tw, 3));
  kt('safeguard', 'five-turns', () => eq(run({ a: A('Safeguard') }).S.sides[0].sg, 4));
  kt('haze', 'resets-both', () => { const r = run({ a: A('Haze', { sg: { atk: 3 } }), b: { sg: { def: -2 } } }); return eq([r.A.sg.atk, r.B.sg.def], [0, 0]); });
  kt('defog', 'lowers-evasion-and-clears-hazards', () => { const r = run({ a: A('Defog'), sd: [{ hz: { sp: 1, ts: 0, sr: 0, sw: 0 } }, { reflect: 3 }] }); return eq([r.B.sg.eva, r.S.sides[0].hz.sp, r.S.sides[1].reflect], [-1, 0, 0]); });
  kt('protect', 'blocks-and-streak-odds', () => {
    const r = run({ a: A('Pound'), b: { moves: ['Protect'] } }, { rng: [] });
    const b = lab({ a: A('Splash'), b: { moves: ['Protect'] } });
    turn(b, MV(0), MV(0));
    const ev2 = turn(b, MV(0), MV(0), [2]); // second use: rand(3) must be 0 to succeed (2 -> fails)
    return eq([of(r.ev, 'protected').length, hit(r.ev, 1), of(ev2, 'fail').length], [1, 0, 1]);
  });
  kt('protect', 'kings-shield-lowers-contact-attacker-attack', () => { const r = run({ a: A('Pound'), b: { moves: ["King's Shield"] } }); return eq(r.A.sg.atk, -1); });
  kt('endure', 'survives-at-one-hp', () => { const r = run({ a: A('Pound', { st: { spe: 40 } }), b: { moves: ['Endure'], hp: 5, st: { spe: 100 } } }, { rng: NC }); return eq(r.B.hp, 1); });
  kt('substitute', 'costs-a-quarter-and-soaks-hits', () => {
    const r = run({ a: A('Pound', { st: { spe: 40 } }), b: { moves: ['Substitute'], st: { spe: 100 } } }, { rng: NC });
    return eq([r.B.hp, r.B.v.sub, of(r.ev, 'sub-damage').length], [150, 31, 1]);
  });
  kt('focusenergy', 'sets-the-crit-boost', () => eq(run({ a: A('Focus Energy') }).A.v.fe, 1));
  kt('disable', 'blocks-the-last-move', () => {
    const b = lab({ a: A('Disable'), b: { moves: ['Pound', 'Splash'] } });
    const e1 = turn(b, MV(0), MV(0), NC); // turn 1: B has no last move yet -> Disable fails ; B uses Pound
    const e2 = turn(b, MV(0), MV(0)); // turn 2: Disable lands ; B's chosen Pound is now disabled
    const rq = b.requests()[1];
    return eq([of(e1, 'fail').length, of(e2, 'cant-move').filter((e) => e.why === 'disabled').length, rq.moves[0].disabled, rq.moves[1].disabled], [1, 1, true, false]);
  });
  kt('encore', 'locks-the-last-move', () => {
    const b = lab({ a: A('Encore'), b: { moves: ['Pound', 'Splash'] } });
    turn(b, MV(0), MV(0), NC);
    turn(b, MV(0), MV(0), NC);
    const rq = b.requests()[1];
    return eq(rq.moves.map((m) => m.reason), ['', 'encore']);
  });
  kt('taunt', 'blocks-status-moves', () => { const b = lab({ a: A('Taunt'), b: { moves: ['Pound', 'Swords Dance'] } }); turn(b, MV(0), MV(0), NC); const rq = b.requests()[1]; return eq(rq.moves.map((m) => m.reason), ['', 'taunt']); });
  kt('trick', 'swaps-items', () => { const r = run({ a: A('Trick', { it: 'Leftovers' }), b: { it: 'Life Orb' } }); return eq([r.A.it, r.B.it], [L.itid('Life Orb'), L.itid('Leftovers')]); });
  kt('destinybond', 'takes-the-attacker-down', () => { const r = run({ a: A('Destiny Bond', { hp: 10 }), b: { moves: ['Pound'] } }, { rng: NC }); return eq([r.A.hp, r.B.hp], [0, 0]); });
  kt('meanlook', 'traps-the-target', () => { const b = lab({ a: A('Mean Look'), b: { bench: [A('Pound')] } }); turn(b, MV(0), MV(0)); return eq([b.choose(1, SW(1)).code, b.requests()[1].trapped], ['trapped', true]); });
  kt('ingrain', 'heals-and-traps', () => { const r = run({ a: A('Ingrain', { hp: 100 }) }); return eq([r.A.hp, r.A.v.ingrain], [112, 1]); });
  kt('aquaring', 'heals-sixteenth', () => eq(run({ a: A('Aqua Ring', { hp: 100 }) }).A.hp, 112));
  kt('curse', 'non-ghost-and-ghost', () => {
    const n = run({ a: A('Curse') }).A.sg;
    const g = run({ a: A('Curse', { ty: [T.GHOST] }) });
    return eq([n.atk, n.def, n.spe, g.A.hp, g.B.v.curse === 1, 200 - g.B.hp], [1, 1, -1, 100, true, 50]);
  });
  kt('lockon', 'next-move-cannot-miss', () => { const r = run({ a: A('Lock-On') }); return eq(r.A.v.lockon, 1); });
  kt('memento', 'user-faints-foe-drops', () => { const r = run({ a: A('Memento') }); return eq([r.A.hp, r.B.sg.atk, r.B.sg.spa], [0, -2, -2]); });
  kt('healingwish', 'next-mon-comes-in-healed', () => {
    const b = lab({ a: A('Healing Wish', { bench: [A('Pound')], benchSpec: { hp: 30 } }) });
    turn(b, MV(0), MV(0));
    turn(b, SW(1), null);
    return eq([b.s.sides[0].team[1].hp, b.s.sides[0].team[0].hp], [200, 0]);
  });
  kt('roar', 'drags-in-another-mon', () => { const b = lab({ a: A('Roar'), b: { bench: [A('Pound')] } }); const ev = turn(b, MV(0), MV(0), [0]); return eq([of(ev, 'forced-out').length, b.s.sides[1].act], [1, 1]); });
  kt('teleport', 'pivots', () => { const b = lab({ a: A('Teleport', { bench: [A('Pound')] }) }); turn(b, MV(0), MV(0)); return eq([b.requests()[0].phase, b.requests()[0].reason], ['switch', 'pivot']); });
  kt('partingshot', 'drops-then-pivots', () => { const b = lab({ a: A('Parting Shot', { bench: [A('Pound')] }) }); turn(b, MV(0), MV(0)); return eq([b.s.sides[1].team[0].sg.atk, b.s.sides[1].team[0].sg.spa, b.requests()[0].phase], [-1, -1, 'switch']); });
  kt('metronome', 'calls-the-pooled-move', () => {
    const b = lab({ a: A('Metronome') });
    const pool = b.callablePool();
    const orig = b.rand.bind(b);
    let first = true;
    b.rand = (n) => { if (first) { first = false; return 3; } return orig(n); };
    b.drain();
    b.choose(0, MV(0)); b.choose(1, MV(0));
    const ev = b.advance();
    delete b.rand;
    const call = of(ev, 'copy')[0];
    return eq([call.mv === pool[3], of(ev, 'move-use').filter((e) => e.called).length, pool.indexOf(mid('Metronome')) < 0, pool.indexOf(mid('Struggle')) < 0], [true, 1, true, true]);
  });
  kt('sleeptalk', 'asleep-only', () => {
    const r = run({ a: { moves: ['Sleep Talk', 'Pound'], s: 1, sc: 2 } }, { rng: [0, 1, 0] });
    const no = run({ a: A('Sleep Talk') }, { rng: [] });
    return eq([of(r.ev, 'copy').length, of(no.ev, 'fail').length], [1, 1]);
  });
  kt('nothing', 'splash-celebrate-happy-hour', () => eq([of(run({ a: A('Splash') }).ev, 'noop', (e) => e.s === 0).length, of(run({ a: A('Celebrate') }).ev, 'noop', (e) => e.s === 0).length, of(run({ a: A('Happy Hour') }).ev, 'noop', (e) => e.s === 0).length], [1, 1, 1]));
  // Future Sight BP120 special: floor(2640/50)+2 = 54 ; lands at the end of the third turn
  kt('futuresight', 'hits-two-turns-later', () => {
    const b = lab({ a: A('Future Sight') });
    turn(b, MV(0), MV(0)); turn(b, MV(0), MV(0));
    const before = b.s.sides[1].team[0].hp;
    const ev = turn(b, MV(0), MV(0), [0]);
    return eq([before, lost(ev, 1, 'future-sight'), of(ev, 'future-sight').length], [200, 54, 1]);
  });
  kt('transform', 'copies-moves-types-and-stats', () => {
    const r = run({ a: A('Transform', { ty: [T.NORMAL] }), b: { moves: ['Flamethrower', 'Pound'], ty: [T.FIRE], st: { atk: 77 } } });
    return eq([r.A.mv.map((m) => m.id), r.A.ty, r.A.st.atk, r.A.mv[0].pp], [[mid('Flamethrower'), mid('Pound')], [T.FIRE], 77, 5]);
  });
  kt('transform', 'reverts-on-switch-out', () => {
    const b = lab({ a: { moves: ['Transform'], bench: [A('Pound')] }, b: { moves: ['Flamethrower'] } });
    turn(b, MV(0), MV(0));
    turn(b, SW(1), MV(0));
    turn(b, SW(0), MV(0));
    const m = b.s.sides[0].team[0];
    return eq([m.mv.map((x) => x.id), m.tf === undefined], [[mid('Transform')], true]);
  });

  kt('foresight', 'normal-and-fighting-hit-ghosts', () => eq([hit(run({ a: A('Pound'), b: { ty: [T.GHOST], v: { fore: 1 } } }, { rng: NC }).ev, 1), run({ a: A('Foresight'), b: { ty: [T.GHOST] } }).B.v.fore], [19, 1]));
  kt('mist', 'blocks-stat-drops-from-the-foe', () => { const b = lab({ a: A('Growl'), b: { moves: ['Mist'], st: { spe: 150 } } }); turn(b, MV(0), MV(0)); return eq([b.s.sides[1].mist, b.s.sides[0].team[0].sg.atk], [4, 0]); });
  kt('settype', 'soak-and-trick-or-treat', () => { const x = run({ a: A('Soak'), b: { ty: [T.FIRE] } }), y = run({ a: A('Trick-or-Treat') }); return eq([x.b.types(x.B), y.b.types(y.B)], [[T.WATER], [T.MYSTERY, T.GHOST]]); }); // Trick-or-Treat ADDS Ghost (measured in the real game), Soak replaces
  kt('smackdown', 'grounds-a-flying-target', () => { const r = run({ a: A('Smack Down'), b: { ty: [T.FLYING] } }, { rng: NC }); return eq([r.B.v.smack, r.b.isGrounded(r.B)], [1, true]); });
  kt('spite', 'cuts-four-pp-of-the-last-move', () => { const b = lab({ a: A('Spite'), b: { moves: ['Pound'] } }); turn(b, MV(0), MV(0), NC); turn(b, MV(0), MV(0), NC); return eq(b.s.sides[1].team[0].mv[0].pp, 35 - 2 - 4); });
  add('class/brick-break-breaks-screens-before-damage', () => { const r = run({ a: A('Brick Break'), sd: [null, { reflect: 5 }] }, { rng: NC }); return eq([r.S.sides[1].reflect, hit(r.ev, 1) > 10 ? 'full' : 'reduced'], [0, 'full']); });
  add('ability/cursed-body-protean-and-gluttony', () => {
    const cb = run({ a: A('Pound'), b: { ab: 'Cursed Body' } }, { rng: [1, 0, 29] });
    const pr = run({ a: A('Pound', { ab: 'Protean' }) }, { rng: NC });
    return eq([cb.A.v.dis.mv, pr.b.types(pr.A), L.D.abilityByName.Gluttony > 0], [mid('Pound'), [T.NORMAL], true]);
  });
  add('ability/trace-copies-the-foes-ability-and-runs-its-entry-effect', () => {
    const b = lab({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab: 'Trace' } }, b: { moves: ['Splash'], ab: 'Intimidate' } });
    turn(b, SW(1), MV(0));
    return eq([b.s.sides[0].team[1].ab, b.s.sides[0].team[1].sg.atk], [L.abid('Intimidate'), 0]) === true ? true : eq([b.s.sides[0].team[1].ab, b.s.sides[1].team[0].sg.atk], [L.abid('Intimidate'), -1]);
  });
  add('ability/flower-veil-and-unseen-fist-and-innards-out', () => {
    const fv = run({ a: A('Growl'), b: { ab: 'Flower Veil', ty: [T.GRASS] } });
    const uf = run({ a: A('Pound', { ab: 'Unseen Fist' }), b: { moves: ['Protect'] } }, { rng: NC });
    const io = run({ a: A('Pound', { st: { atk: 999 } }), b: { ab: 'Innards Out', hp: 30 } }, { rng: NC });
    return eq([fv.B.sg.atk, hit(uf.ev, 1) > 0, lost(io.ev, 0, 'innards-out')], [0, true, 30]);
  });

  // ================================================================== FA2 round 2: move classes added after probing the real game (each expectation is the value the oracle showed)
  // Clangorous Soul: -floor(200/3) = 66 HP, +1 in five stats ; Fillet Away: -100 HP, +2 Atk / Sp.Atk / Speed ; No Retreat: +1 in five stats and the user can no longer leave
  kt('clangorous', 'cost-a-third-and-raises-five', () => { const r = run({ a: A('Clangorous Soul') }); return eq([r.A.hp, r.A.sg.atk, r.A.sg.def, r.A.sg.spa, r.A.sg.spd, r.A.sg.spe], [134, 1, 1, 1, 1, 1]); });
  kt('filletaway', 'cost-half-and-raises-three-by-two', () => { const r = run({ a: A('Fillet Away') }); return eq([r.A.hp, r.A.sg.atk, r.A.sg.spa, r.A.sg.spe, r.A.sg.def], [100, 2, 2, 2, 0]); });
  kt('noretreat', 'raises-five-and-traps-the-user', () => { const r = run({ a: A('No Retreat') }); return eq([r.A.sg.atk, r.A.sg.spe, r.A.v.noesc], [1, 1, 1]); });
  kt('takeheart', 'raises-spa-spd-and-cures-status', () => { const r = run({ a: A('Take Heart', { s: 3 }) }); return eq([r.A.s, r.A.sg.spa, r.A.sg.spd], [0, 1, 1]); });
  // Charge: +1 Sp.Def and the next Electric move doubles its power: Thunderbolt BP90: floor(22*90/50)+2 = 41 ; doubled BP180: floor(22*180/50)+2 = 81
  kt('charge', 'raises-spd-and-doubles-the-next-electric-move', () => {
    const b = lab({ a: { moves: ['Charge', 'Thunderbolt'] } });
    turn(b, MV(0), MV(0));
    const st = [b.s.sides[0].team[0].sg.spd, b.s.sides[0].team[0].v.chgd];
    const ev = turn(b, MV(1), MV(0), [1, 0, 99]);
    return eq([st, hit(ev, 1), b.s.sides[0].team[0].v.chgd], [[1, 1], 81, undefined]);
  });
  kt('acupressure', 'picks-an-unmaxed-stat-by-the-draw', () => eq([run({ a: A('Acupressure') }, { rng: [0] }).A.sg.atk, run({ a: A('Acupressure') }, { rng: [4] }).A.sg.spe], [2, 2]));
  kt('venomdrench', 'needs-a-poisoned-target', () => { const ok = run({ a: A('Venom Drench'), b: { s: 2 } }); const no = run({ a: A('Venom Drench') }); return eq([ok.B.sg.atk, ok.B.sg.spa, ok.B.sg.spe, ok.B.sg.def, no.B.sg.atk, of(no.ev, 'fail').length], [-1, -1, -1, 0, 0, 1]); });
  kt('topsy', 'inverts-the-foes-stages', () => { const r = run({ a: A('Topsy-Turvy'), b: { sg: { atk: 2, def: -1 } } }); return eq([r.B.sg.atk, r.B.sg.def], [-2, 1]); });
  kt('powerswap', 'swaps-attack-stages', () => { const r = run({ a: A('Power Swap', { sg: { atk: 2 } }), b: { sg: { spa: 1 } } }); return eq([r.A.sg.atk, r.A.sg.spa, r.B.sg.atk, r.B.sg.spa], [0, 1, 2, 0]); });
  kt('guardswap', 'swaps-defense-stages', () => { const r = run({ a: A('Guard Swap', { sg: { def: 2 } }) }); return eq([r.A.sg.def, r.B.sg.def], [0, 2]); });
  kt('heartswap', 'swaps-every-stage', () => { const r = run({ a: A('Heart Swap', { sg: { atk: 2 } }), b: { sg: { spe: -1 } } }); return eq([r.A.sg.atk, r.A.sg.spe, r.B.sg.atk, r.B.sg.spe], [0, -1, 2, 0]); });
  kt('psychup', 'copies-the-foes-stages', () => { const r = run({ a: A('Psych Up'), b: { sg: { atk: 2, spe: 1 } } }); return eq([r.A.sg.atk, r.A.sg.spe], [2, 1]); });
  // Stockpile x2: +2 Def / +2 Sp.Def, stack 2 ; Spit Up BP200: floor(22*200/50)+2 = 90, boosts undone ; Swallow with 2 stacks heals half (100)
  kt('stockpile', 'stacks-and-boosts', () => { const b = lab({ a: { moves: ['Stockpile'] } }); turn(b, MV(0), MV(0)); turn(b, MV(0), MV(0)); const m = b.s.sides[0].team[0]; return eq([m.v.stk, m.sg.def, m.sg.spd], [2, 2, 2]); });
  kt('spitup', 'power-100-per-stack-and-resets-the-boosts', () => {
    const b = lab({ a: { moves: ['Stockpile', 'Spit Up'] } }); turn(b, MV(0), MV(0)); turn(b, MV(0), MV(0));
    const ev = turn(b, MV(1), MV(0), NC); const m = b.s.sides[0].team[0];
    return eq([hit(ev, 1), m.sg.def, m.v.stk], [90, 0, undefined]);
  });
  kt('swallow', 'heals-by-the-stack', () => { const b = lab({ a: { moves: ['Stockpile', 'Swallow'], hp: 50 } }); turn(b, MV(0), MV(0)); turn(b, MV(0), MV(0)); turn(b, MV(1), MV(0)); const m = b.s.sides[0].team[0]; return eq([m.hp, m.sg.def], [150, 0]); });
  // Nightmare: a sleeping foe loses 1/4 of max HP each turn (50 of 200)
  kt('nightmare', 'sleeping-target-loses-a-quarter', () => { const r = run({ a: A('Nightmare'), b: { s: 1, sc: 3 } }); return eq([r.B.hp, r.B.v.nm], [150, 1]); });
  kt('luckychant', 'sets-the-side-field', () => eq(run({ a: A('Lucky Chant') }).S.sides[0].luckyChant, 4));
  // Pursuit BP40: floor(880/50)+2 = 19 ; Frustration at full friendship BP1: floor(22/50)+2 = 2 ; Beat Up: one hit per healthy party member, BP = base Atk/10+5 (Pikachu 55 -> 10): floor(220/50)+2 = 6
  kt('pursuit', 'plain-hit', () => eq(hit(run({ a: A('Pursuit') }, { rng: NC }).ev, 1), 19));
  kt('frustration', 'power-one-at-full-friendship', () => eq(hit(run({ a: A('Frustration') }, { rng: NC }).ev, 1), 2));
  kt('beatup', 'one-hit-per-healthy-member', () => {
    const one = run({ a: A('Beat Up') }, { rng: NC }); const two = run({ a: A('Beat Up', { bench: [A('Splash')] }) }, { rng: [1, 0, 1, 0] });
    return eq([hit(one.ev, 1), hit(two.ev, 1)], [6, 12]);
  });
  // Retaliate BP70: floor(1540/50)+2 = 32 ; doubled to 140 after an ally fainted last turn: floor(3080/50)+2 = 63
  kt('retaliate', 'doubles-after-an-ally-fainted', () => { const a = hit(run({ a: A('Retaliate') }, { rng: NC }).ev, 1); const b2 = lab({ a: A('Retaliate') }); b2.s.sides[0].lastFaint = b2.s.turn; const c = hit(turn(b2, MV(0), MV(0), NC), 1); return eq([a, c], [32, 63]); });
  kt('synchro', 'needs-a-shared-type', () => { const no = run({ a: A('Synchronoise', { ty: [T.FIRE] }), b: { ty: [T.WATER] } }, { rng: [] }); const ok = run({ a: A('Synchronoise', { ty: [T.FIRE] }), b: { ty: [T.FIRE, T.WATER] } }, { rng: [1, 0] }); return eq([of(no.ev, 'fail').length, hit(ok.ev, 1) > 0], [1, true]); });
  // Photon Geyser BP100: physical when the user's Attack beats Sp.Atk ; Atk 200 vs Def 100: floor(floor(22*100*200/100)/50)+2 = 90
  kt('photon', 'category-follows-the-higher-attack-stat', () => { const p = hit(run({ a: A('Photon Geyser', { st: { atk: 200 } }) }, { rng: NC }).ev, 1); const s = hit(run({ a: A('Photon Geyser', { st: { spa: 200 } }) }, { rng: NC }).ev, 1); return eq([p, s], [90, 90]); });
  kt('typeofitem', 'a-plate-sets-the-type-otherwise-normal', () => { const fire = run({ a: A('Judgment', { it: 'Flame Plate' }), b: { ty: [T.GRASS] } }, { rng: NC }); const plain = run({ a: A('Judgment'), b: { ty: [T.GRASS] } }, { rng: NC }); return eq([hit(fire.ev, 1) > hit(plain.ev, 1)], [true]); });
  // Rollout BP30 doubles each consecutive hit: 30 -> 60: floor(22*30/50)+2 = 15 ; floor(22*60/50)+2 = 28
  kt('rollout', 'power-doubles-each-use', () => { const b = lab({ a: { moves: ['Rollout'] } }); const e1 = turn(b, MV(0), MV(0), [0, 1, 0]); const e2 = turn(b, null, MV(0), [0, 1, 0]); return eq([hit(e1, 1), hit(e2, 1)], [15, 28]); });   // MEASURED: the user is locked into Rollout, so only the foe chooses the second turn
  // Hydro Steam BP80: in sun the Water-type move is BOOSTED (x1.5) instead of cut: base floor(22*80/50)+2 = 37 ; x1.5 -> 55 ; plain Water Gun-style cut would give 18
  kt('hydrosteam', 'boosted-not-cut-in-sun', () => { const sun = hit(run({ a: A('Hydro Steam'), wx: [2, 5] }, { rng: NC }).ev, 1); const none = hit(run({ a: A('Hydro Steam') }, { rng: NC }).ev, 1); return eq([sun > none, none], [true, 37]); });
  kt('abilityset', 'worry-seed-and-simple-beam', () => { const w = run({ a: A('Worry Seed') }); const s = run({ a: A('Simple Beam') }); return eq([w.B.ab === L.abid('Insomnia'), s.B.ab === L.abid('Simple')], [true, true]); });
  kt('roleplay', 'copies-the-foes-ability', () => eq(run({ a: A('Role Play'), b: { ab: 'Levitate' } }).A.ab === L.abid('Levitate'), true));
  kt('skillswap', 'swaps-abilities', () => { const r = run({ a: A('Skill Swap', { ab: 'Pressure' }), b: { ab: 'Levitate' } }); return eq([r.A.ab === L.abid('Levitate'), r.B.ab === L.abid('Pressure')], [true, true]); });
  kt('recycle', 'returns-a-used-item', () => { const b = lab({ a: A('Recycle') }); b.s.sides[0].team[0].used = L.itid('Oran Berry'); turn(b, MV(0), MV(0)); return eq(b.s.sides[0].team[0].it === L.itid('Oran Berry'), true); });
  // Trump Card: BP by remaining PP (0 -> 200, 1 -> 160, 2 -> 120, 3 -> 80, else 40): the move spends one PP first, so PP 1 -> 0 left -> BP 200 = 90 ; PP 10 -> 40 = 19
  kt('trumpcard', 'power-by-remaining-pp', () => eq([hit(run({ a: A('Trump Card', { pp: [1] }) }, { rng: NC }).ev, 1), hit(run({ a: A('Trump Card', { pp: [10] }) }, { rng: NC }).ev, 1)], [90, 19]));
  kt('psychoshift', 'moves-the-status-to-the-foe', () => { const r = run({ a: A('Psycho Shift', { s: 3 }) }); return eq([r.A.s, r.B.s], [0, 3]); });
  kt('healtarget', 'heals-the-target-by-half', () => eq(run({ a: A('Heal Pulse'), b: { hp: 100 } }).B.hp, 200));
  kt('selfhealcure', 'quarter-heal-and-cure', () => { const r = run({ a: A('Jungle Healing', { hp: 100, s: 3 }) }); return eq([r.A.hp, r.A.s], [150, 0]); });
  kt('tidyup', 'clears-hazards-and-raises-atk-spe', () => { const r = run({ a: A('Tidy Up'), sd: [{ hz: { sp: 1, ts: 0, sr: 1, sw: 0 } }, null] }); return eq([r.A.sg.atk, r.A.sg.spe, r.S.sides[0].hz.sr], [1, 1, 0]); });
  kt('chilly', 'sets-snow', () => eq(run({ a: A('Chilly Reception') }).S.wx[0], 5));
  kt('electrify', 'the-foes-next-move-becomes-electric', () => { const b = lab({ a: { moves: ['Electrify'], st: { spe: 200 } }, b: { moves: ['Pound'] } }); const ev = turn(b, MV(0), MV(0), NC); return eq(of(ev, 'move-use').length, 2); });
  kt('magiccoat', 'bounces-a-status-move', () => { const r = run({ a: A('Magic Coat', { st: { spe: 200 } }), b: { moves: ['Thunder Wave'] } }, { rng: [0] }); return eq([r.A.s, r.B.s], [0, 5]); });
  kt('snatch', 'steals-a-self-targeting-status-move', () => { const r = run({ a: A('Snatch', { st: { spe: 200 } }), b: { moves: ['Swords Dance'] } }); return eq([r.A.sg.atk, r.B.sg.atk], [2, 0]); });
  kt('mimic', 'copies-the-foes-last-move', () => { const b = lab({ a: { moves: ['Mimic'], st: { spe: 10 } }, b: { moves: ['Pound'], st: { spe: 100 } } }); turn(b, MV(0), MV(0), NC); return eq(b.s.sides[0].team[0].mv[0].id === L.mid('Pound'), true); });
  kt('mirrormove', 'repeats-the-foes-last-move', () => { const b = lab({ a: { moves: ['Mirror Move'], st: { spe: 10 } }, b: { moves: ['Pound'], st: { spe: 100 } } }); const ev = turn(b, MV(0), MV(0), [1, 0, 1, 0]); return eq([hit(ev, 0), hit(ev, 1)], [19, 19]); });
  kt('naturepower', 'calls-tri-attack-without-a-terrain', () => eq(of(run({ a: A('Nature Power') }, { rng: [1, 0, 99] }).ev, 'move-use').map((e) => e.mv).includes(L.mid('Tri Attack')), true));

  // ================================================================== round 3 classes: terrain, Gravity, gender (the numbers are the real game's, ROMDIFF.md section 8)
  // r3go: one lenient turn: every draw is 0 except rand(100) = 99 (no secondary effect, a 100-accuracy move hits), rand(24) = 1 (no crit), rand(2) = 0 (not immobilized)
  const r3go = (spec, draw) => { const b = lab(spec); b.rand = draw || ((n) => (n === 100 ? 99 : n === 24 ? 1 : 0)); b.drain(); b.choose(0, MV(0)); if (!b.choose(1, MV(0)).ok) b.choose(1, { kind: 'move', slot: 4 }); const ev = b.advance(); return { b, ev, A: b.s.sides[0].team[b.s.sides[0].act], B: b.s.sides[1].team[b.s.sides[1].act] }; };
  const tdmg = (mv, fld, ax, bx) => hit(r3go({ a: A(mv, ax), b: Object.assign({ moves: ['Splash'] }, bx || {}), ...fld }).ev, 1);
  kt('terrainset', 'sets-each-terrain-for-five-turns-and-the-second-use-fails', () => eq(['Grassy Terrain', 'Electric Terrain', 'Misty Terrain', 'Psychic Terrain'].map((m) => { const g = r3go({ a: A(m) }); const first = g.b.s.tn.slice(); g.b.choose(0, MV(0)); g.b.choose(1, MV(0)); const ev = g.b.advance(); return [first, of(ev, 'fail').length]; }), [[[1, 4], 1], [[2, 4], 1], [[3, 4], 1], [[4, 4], 1]]));
  kt('terrainset', 'a-terrain-extender-makes-it-last-eight-turns', () => eq(r3go({ a: A('Grassy Terrain', { it: 'Terrain Extender' }) }).b.s.tn, [1, 7]));
  kt('gravity', 'lasts-five-turns-and-removes-Fly-and-Splash', () => {
    const g = r3go({ a: A('Gravity') });
    const fly = lab({ a: { moves: ['Fly', 'Pound'] }, gv: 5 });
    const opt = fly.requests()[0].moves.map((m) => [m.disabled, m.reason]);
    return eq([g.b.s.gv, opt], [4, [[true, 'gravity'], [false, '']]]);
  });
  kt('terrainpulse', 'doubles-and-takes-the-terrain-type-only-for-a-grounded-user', () => eq([tdmg('Terrain Pulse'), tdmg('Terrain Pulse', { tn: [1, 5] }), tdmg('Terrain Pulse', { tn: [3, 5] }), tdmg('Terrain Pulse', { tn: [1, 5] }, { ty: [T.FLYING] })], [24, 59, 46, 24]));
  kt('terrainbonus', 'rising-voltage-expanding-force-psyblade', () => eq([
    tdmg('Rising Voltage'), tdmg('Rising Voltage', { tn: [2, 5] }), tdmg('Rising Voltage', { tn: [2, 5] }, {}, { ty: [T.FLYING] }),
    tdmg('Expanding Force'), tdmg('Expanding Force', { tn: [4, 5] }), tdmg('Expanding Force', { tn: [4, 5] }, { ty: [T.FLYING] }),
    tdmg('Psyblade'), tdmg('Psyblade', { tn: [2, 5] }), tdmg('Psyblade', { tn: [2, 5] }, { ty: [T.FLYING] }),
  ], [32, 82, 84, 37, 70, 37, 37, 54, 54]));
  kt('steelroller', 'fails-on-a-bare-field-and-removes-the-terrain', () => { const bare = r3go({ a: A('Steel Roller') }); const g = r3go({ a: A('Steel Roller'), tn: [1, 5] }); return eq([of(bare.ev, 'fail').length, g.b.s.tn], [1, undefined]); });
  kt('terrainbreak', 'ice-spinner-removes-the-terrain', () => eq(r3go({ a: A('Ice Spinner'), tn: [1, 5] }).b.s.tn, undefined));
  kt('attract', 'opposite-genders-only-and-oblivious-stops-it', () => {
    const inf = (ga, gb, bx) => r3go({ a: A('Attract', { g: ga }), b: Object.assign({ moves: ['Splash'], g: gb }, bx || {}) }).B.v.inf || 0;
    return eq([inf(0, 1), inf(1, 0), inf(0, 0), inf(2, 0), inf(0, 2), inf(0, 1, { ab: 'Oblivious' })], [1, 1, 0, 0, 0, 0]);
  });
  kt('captivate', 'lowers-special-attack-by-two-of-the-opposite-gender', () => eq([r3go({ a: A('Captivate', { g: 0 }), b: { moves: ['Splash'], g: 1 } }).B.sg.spa, r3go({ a: A('Captivate', { g: 0 }), b: { moves: ['Splash'], g: 0 } }).B.sg.spa], [-2, 0]));
  kt('naturepower', 'follows-the-terrain', () => eq(['', 'Energy Ball', 'Thunderbolt', 'Moonblast', 'Psychic'].map((nm, i) => { const g = r3go({ a: A('Nature Power'), ...(i ? { tn: [i, 5] } : {}) }); const mu = of(g.ev, 'move-use').filter((e) => e.called); return mu.length ? pack.moves[mu[0].mv].name : '?'; }), ['Tri Attack', 'Energy Ball', 'Thunderbolt', 'Moonblast', 'Psychic']));

  // ---- round 3 batch B1 and the doubles-only moves
  const two = (spec, n, draw) => { const b = lab(spec); b.rand = draw || ((x) => (x === 100 ? 99 : x === 24 ? 1 : 0)); for (let i = 0; i < n; i++) { b.drain(); b.choose(0, MV(0)); if (!b.choose(1, MV(0)).ok) b.choose(1, { kind: 'move', slot: 4 }); b.advance(); } return b; };
  const mA = (b) => b.s.sides[0].team[0], mB = (b) => b.s.sides[1].team[0];
  kt('singlesfail', 'the-moves-written-for-doubles-fail-in-a-singles-battle', () => eq(['Follow Me', 'Helping Hand', 'Ally Switch', 'Coaching'].map((m) => of(r3go({ a: A(m) }).ev, 'fail').length), [1, 1, 1, 1]));
  kt('afteryou', 'works-only-while-the-target-has-not-moved', () => eq([of(r3go({ a: A('After You') }).ev, 'fail').length, of(r3go({ a: A('Quash', { st: { spe: 10 } }), b: { moves: ['Splash'], st: { spe: 100 } } }).ev, 'fail').length], [0, 1]));
  kt('matblock', 'protects-from-damage-on-the-first-turn-only', () => { const f1 = r3go({ a: A('Mat Block'), b: { moves: ['Pound'] } }); const b2 = two({ a: A('Mat Block'), b: { moves: ['Pound'], st: { spe: 10 } } }, 2); return eq([f1.A.hp, mA(b2).hp < 200], [200, true]); });
  kt('flowershield', 'raises-the-defense-of-grass-types-on-the-field', () => eq([r3go({ a: A('Flower Shield', { ty: [T.GRASS] }) }).A.sg.def, of(r3go({ a: A('Flower Shield') }).ev, 'fail').length], [1, 1]));
  kt('upperhand', 'fails-unless-the-foe-readies-a-priority-move', () => eq(of(r3go({ a: A('Upper Hand'), b: { moves: ['Pound'] } }).ev, 'fail').length, 1));
  kt('poltergeist', 'needs-an-item-on-the-target', () => eq([of(r3go({ a: A('Poltergeist') }).ev, 'fail').length, r3go({ a: A('Poltergeist'), b: { moves: ['Splash'], it: 'Leftovers' } }, (x) => (x === 24 ? 1 : 0)).B.hp < 200], [1, true]));
  kt('torment', 'forbids-the-same-move-twice-in-a-row', () => { const b = two({ a: A('Torment', { st: { spe: 200 } }), b: { moves: ['Pound'] } }, 1); return eq([mB(b).v.torment, b.moveOptions(1).struggle], [1, true]); });
  kt('imprison', 'takes-away-the-moves-the-user-knows', () => { const b = two({ a: { moves: ['Imprison', 'Pound'] }, b: { moves: ['Pound', 'Splash'] } }, 1); const o = b.moveOptions(1).moves; return eq([mA(b).v.imp, o.map((x) => x.reason)], [1, ['imprison', '']]); });
  kt('embargo', 'switches-the-targets-item-off', () => { const b = two({ a: A('Embargo'), b: { moves: ['Splash'], it: 'Leftovers', hp: 100 } }, 2); return eq([mB(b).v.emb > 0, mB(b).hp], [true, 100]); });
  kt('healblock', 'stops-all-healing', () => { const b = two({ a: A('Heal Block'), b: { moves: ['Recover'], hp: 100 } }, 1); return eq([mB(b).v.hb, mB(b).hp], [4, 100]); });
  kt('gastroacid', 'silences-the-targets-ability', () => { const b = two({ a: A('Gastro Acid'), b: { moves: ['Splash'], ab: 'Levitate' } }, 1); return eq([mB(b).v.gastro, b.abFn(mB(b), 'levitate')], [1, undefined]); });
  kt('miracleeye', 'lets-psychic-hit-dark-types-and-ignores-evasion', () => { const b = two({ a: { moves: ['Miracle Eye', 'Psychic'], st: { spe: 200 } }, b: { moves: ['Splash'], ty: [T.DARK] } }, 1); return eq([mB(b).v.mir, b.typeEff(T.PSYCHIC, mB(b), {}).prod > 0], [1, true]); });
  kt('laserfocus', 'makes-the-next-move-a-critical-hit', () => { const b = two({ a: A('Laser Focus'), b: { moves: ['Splash'] } }, 1); return eq(mA(b).v.lf, 1); });
  kt('powertrick', 'swaps-attack-and-defense-and-swaps-back', () => { const b = two({ a: A('Power Trick', { st: { atk: 150, def: 80 } }) }, 1); const x = b.statOf(mA(b), 'atk'); const b2 = two({ a: A('Power Trick', { st: { atk: 150, def: 80 } }) }, 2); return eq([x, b2.statOf(mA(b2), 'atk')], [80, 150]); });
  kt('split', 'averages-the-defenses-or-the-attacks-of-both', () => { const b = two({ a: A('Guard Split', { st: { def: 100, spd: 100 } }), b: { moves: ['Splash'], st: { def: 200, spd: 60 } } }, 1); return eq([b.statOf(mA(b), 'def'), b.statOf(mB(b), 'def'), b.statOf(mB(b), 'spd')], [150, 150, 80]); });
  kt('speedswap', 'swaps-the-speed-values', () => { const b = two({ a: A('Speed Swap', { st: { spe: 200 } }), b: { moves: ['Splash'], st: { spe: 50 } } }, 1); return eq([b.statOf(mA(b), 'spe'), b.statOf(mB(b), 'spe')], [50, 200]); });
  kt('sport', 'cuts-electric-or-fire-power-to-a-third', () => { const e0 = hit(r3go({ a: A('Thunderbolt') }).ev, 1); const b = lab({ a: A('Thunderbolt'), b: { moves: ['Splash'] } }); b.s.ms = 5; b.rand = (x) => (x === 100 ? 99 : x === 24 ? 1 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); const ev = b.advance(); return eq(hit(ev, 1) < e0 / 2, true); });
  kt('room', 'wonder-room-swaps-the-defenses-and-magic-room-removes-items', () => { const b = two({ a: A('Wonder Room') }, 1); const c = two({ a: A('Magic Room'), b: { moves: ['Splash'], it: 'Leftovers' } }, 1); return eq([b.s.wr, c.s.mr, c.itFn(mB(c), 'residual')], [4, 4, undefined]); });
  kt('perishsong', 'faints-both-after-three-end-of-turns', () => { const b = two({ a: A('Perish Song', { bench: [A('Splash')] }), b: { moves: ['Splash'], bench: [A('Splash')] } }, 2); return eq([mA(b).v.perish, mB(b).v.perish], [2, 2]); });
  kt('grudge', 'marks-the-user', () => eq(r3go({ a: A('Grudge') }).A.v.grudge, 1));
  kt('powder', 'makes-a-fire-move-fail-and-hurt-its-user', () => { const b = two({ a: A('Powder', { st: { spe: 200 } }), b: { moves: ['Ember'] } }, 1); return eq([mB(b).hp, of(b.events || [], 'fail').length >= 0], [150, true]); });
  kt('iondeluge', 'turns-normal-moves-electric-for-the-turn', () => { const b = two({ a: A('Ion Deluge', { st: { spe: 200 }, ty: [T.GROUND] }), b: { moves: ['Pound'] } }, 1); return eq(mA(b).hp, 200); });
  kt('fairylock', 'blocks-switching-next-turn', () => { const b = two({ a: A('Fairy Lock', { bench: [A('Splash')] }), b: { moves: ['Splash'], bench: [A('Splash')] } }, 1); return eq([b.canSwitch(0), b.canSwitch(1)], [false, false]); });
  kt('abilitycopy', 'entrainment-gives-the-users-ability-doodle-takes-the-targets', () => { const e = two({ a: A('Entrainment', { ab: 'Thick Fat' }), b: { moves: ['Splash'], ab: 'Blaze' } }, 1); const d = two({ a: A('Doodle', { ab: 'Thick Fat' }), b: { moves: ['Splash'], ab: 'Blaze' } }, 1); return eq([mB(e).ab === mA(e).ab, mA(d).ab === mB(d).ab], [true, true]); });
  kt('reflecttype', 'copies-the-targets-types', () => eq(mA(two({ a: A('Reflect Type'), b: { moves: ['Splash'], ty: [T.GRASS, T.POISON] } }, 1)).v.ty, [T.GRASS, T.POISON]));
  kt('conversion', 'takes-the-type-of-the-first-move', () => eq(mA(two({ a: { moves: ['Conversion'], ty: [T.FIRE] } }, 1)).v.ty, [T.NORMAL]));
  kt('camouflage', 'follows-the-terrain', () => eq(mA(two({ a: A('Camouflage', { ty: [T.FIRE] }), tn: [1, 5] }, 1)).v.ty, [T.GRASS]));
  kt('telekinesis', 'floats-the-target-for-three-turns', () => { const b = two({ a: A('Telekinesis'), b: { moves: ['Splash'] } }, 1); return eq([mB(b).v.tele, b.isGrounded(mB(b))], [2, false]); });
  kt('magnetrise', 'floats-the-user-for-five-turns', () => { const b = two({ a: A('Magnet Rise') }, 1); return eq(mA(b).v.mag, 4); });
  kt('rototiller', 'raises-attack-and-special-attack-of-grounded-grass-types', () => { const g = r3go({ a: A('Rototiller', { ty: [T.GRASS] }), b: { moves: ['Splash'], ty: [T.GRASS] } }); return eq([g.A.sg.atk, g.A.sg.spa, g.B.sg.atk, of(r3go({ a: A('Rototiller') }).ev, 'fail').length], [1, 1, 1, 1]); });
  kt('plusminus', 'needs-plus-or-minus', () => eq([r3go({ a: A('Magnetic Flux', { ab: 'Plus' }) }).A.sg.def, of(r3go({ a: A('Magnetic Flux') }).ev, 'fail').length], [1, 1]));

  // ---- round 3 batches D and E
  kt('lastresort', 'needs-every-other-move-used-first', () => { const b = lab({ a: { moves: ['Last Resort', 'Splash'] }, b: { moves: ['Splash'] } }); b.rand = (x) => (x === 100 ? 99 : x === 24 ? 1 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); const ev0 = b.advance(); b.drain(); b.choose(0, MV(1)); b.choose(1, MV(0)); b.advance(); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); const ev2 = b.advance(); return eq([of(ev0, 'fail').length, hit(ev2, 1) > 0], [1, true]); });
  kt('copycat', 'repeats-the-last-move-used-by-anyone', () => { const g = r3go({ a: A('Copycat', { st: { spe: 10 } }), b: { moves: ['Pound'], st: { spe: 100 } } }); const first = r3go({ a: A('Copycat') }); return eq([of(g.ev, 'copy').length, of(first.ev, 'fail').length], [1, 1]); });
  kt('mefirst', 'borrows-the-foes-attack-with-more-power', () => { const g = r3go({ a: A('Me First', { st: { spe: 200 } }), b: { moves: ['Pound'] } }); return eq([of(g.ev, 'copy').length, hit(g.ev, 1) > 0], [1, true]); });
  kt('assist', 'fails-without-a-party', () => eq(of(r3go({ a: A('Assist') }).ev, 'fail').length, 1));
  kt('instruct', 'repeats-the-targets-last-move', () => { const g = r3go({ a: A('Instruct', { st: { spe: 10 } }), b: { moves: ['Pound'], st: { spe: 100 } } }); return eq(of(g.ev, 'copy').length, 1); });
  kt('bestow', 'hands-the-item-over', () => { const g = r3go({ a: A('Bestow', { it: 'Leftovers' }), b: { moves: ['Splash'] } }); return eq([g.A.it, g.B.it > 0], [0, true]); });
  kt('stuffcheeks', 'eats-the-berry-and-raises-defense-by-two', () => { const g = r3go({ a: A('Stuff Cheeks', { it: 'Oran Berry', hp: 100 }) }); return eq([g.A.sg.def, g.A.it, g.A.hp > 100], [2, 0, true]); });
  kt('teatime', 'every-berry-on-the-field-is-eaten', () => { const g = r3go({ a: A('Teatime', { it: 'Oran Berry', hp: 100 }), b: { moves: ['Splash'], it: 'Oran Berry', hp: 100 } }); return eq([g.A.it, g.B.it, g.A.hp > 100, g.B.hp > 100], [0, 0, true, true]); });
  kt('batonpass', 'fails-without-a-party-and-passes-the-stages-with-one', () => { const f = r3go({ a: A('Baton Pass') }); const b = lab({ a: { moves: ['Baton Pass'], sg: { atk: 2 }, bench: [A('Splash')] }, b: { moves: ['Splash'] } }); b.rand = (x) => (x === 100 ? 99 : x === 24 ? 1 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); b.choose(0, SW(1)); b.advance(); return eq([of(f.ev, 'fail').length, b.s.sides[0].team[1].sg.atk], [1, 2]); });
  kt('shedtail', 'costs-half-the-hp-and-leaves-a-substitute', () => { const f = r3go({ a: A('Shed Tail') }); const b = lab({ a: { moves: ['Shed Tail'], bench: [A('Splash')] }, b: { moves: ['Splash'] } }); b.rand = (x) => (x === 100 ? 99 : x === 24 ? 1 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); b.choose(0, SW(1)); b.advance(); return eq([of(f.ev, 'fail').length, b.s.sides[0].team[1].v.sub, b.s.sides[0].team[0].hp], [1, 50, 100]); });
  kt('bide', 'stores-two-turns-and-unleashes-double', () => { const b = lab({ a: { moves: ['Bide'], hp: 2000, mhp: 2000 }, b: { moves: ['Pound'], hp: 2000, mhp: 2000, st: { spe: 5 } } }); b.rand = (x) => (x === 100 ? 99 : x === 24 ? 1 : 0); for (let i = 0; i < 6; i++) { b.drain(); const r = b.requests(); for (let q = 0; q < 2; q++) if (r[q].phase === 'move') b.choose(q, MV(0)); b.advance(); } return eq([mB(b).hp < 2000, mA(b).v.bide === undefined], [true, true]); });
  kt('naturalgift', 'the-berry-gives-type-and-power-and-is-used-up', () => { const f = r3go({ a: A('Natural Gift', { it: 'Cheri Berry' }), b: { moves: ['Splash'], ty: [T.GRASS] } }); const w = r3go({ a: A('Natural Gift', { it: 'Cheri Berry' }), b: { moves: ['Splash'], ty: [T.WATER] } }); const n = r3go({ a: A('Natural Gift') }); const l = r3go({ a: A('Natural Gift', { it: 'Cheri Berry', ab: 'Klutz' }) }); return eq([f.A.it, hit(f.ev, 1) > 2 * hit(w.ev, 1), of(n.ev, 'fail').length, of(l.ev, 'fail').length], [0, true, 1, 1]); });
  kt('revival', 'brings-back-a-fainted-party-member-at-half-hp', () => {
    const b = lab({ a: { moves: ['Revival Blessing'], bench: [{ moves: ['Splash'] }], benchSpec: { hp: 0, mhp: 200 } }, b: { moves: ['Splash'] } });
    b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance();
    const rq = b.requests()[0]; const ok = b.choose(0, { kind: 'switch', slot: 0 });
    const opts = rq.phase === 'switch' ? rq.switches.map((x) => x.slot) : [];
    const ok2 = b.choose(0, { kind: 'switch', slot: 1 }); b.advance();
    const bench = b.s.sides[0].team[1];
    const none = of(run({ a: A('Revival Blessing'), b: { moves: ['Splash'] } }).ev, 'fail').length;
    return eq([rq.phase, rq.reason, opts, ok.ok, ok2.ok, bench.hp, bench.fnt, none], ['switch', 'revive', [1], false, true, 100, 0, 1]);
  });
  add('r3/gravity-raises-accuracy-by-five-thirds', () => { const dr = (n) => (n === 100 ? 90 : n === 24 ? 1 : 0); const go = (gv) => hit(r3go({ a: A('Thunder'), b: { moves: ['Splash'] }, ...(gv ? { gv } : {}) }, dr).ev, 1) > 0; return eq([go(5), go(0)], [true, false]); });
  add('r3/tar-shot-doubles-fire-damage-until-it-leaves', () => { const n = tdmg('Flamethrower', {}, {}, {}), t = tdmg('Flamethrower', {}, {}, { v: { tar: 1 } }); const use = run({ a: A('Tar Shot'), b: { moves: ['Splash'] } }); return eq([t >= 2 * n - 2 && t <= 2 * n + 2, use.B.v.tar, use.B.sg.spe], [true, 1, -1]); });
  kt('conversion2', 'resists-the-foes-last-move-and-skips-own-types', () => {
    const sets = new Set(); for (let k = 0; k < 40; k++) { const b = lab({ a: A('Conversion 2', { ty: [T.NORMAL] }), b: { moves: ['Pound'], st: { spe: 500 } } }); b.rand = (n) => Math.floor(n * (k + 0.5) / 40); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); sets.add(b.s.sides[0].team[b.s.sides[0].act].v.ty && b.s.sides[0].team[b.s.sides[0].act].v.ty[0]); }
    const rock = [...sets].sort((x, y) => x - y).join(','); const none = of(run({ a: A('Conversion 2'), b: { moves: ['Splash'] } }).ev, 'fail').length;
    return eq([rock, none], [[T.ROCK, T.GHOST, T.STEEL].sort((x, y) => x - y).join(','), 1]);
  });
  kt('popbomb', 'ten-hits-skill-link-and-loaded-dice', () => {
    const dr = (n) => (n === 100 ? 50 : n === 24 ? 1 : n === 7 ? 3 : 0);
    const n = (spec) => r3go({ ...spec, b: { moves: ['Splash'], hp: 2000, mhp: 2000 } }, dr).ev.filter((e) => e.t === 'damage' && e.s === 1 && e.src === 'move').length;
    return eq([n({ a: A('Population Bomb') }), n({ a: A('Population Bomb', { ab: 'Skill Link' }) }), n({ a: A('Population Bomb', { it: 'Loaded Dice' }) })], [10, 10, 7]);
  });
  kt('ragingbull', 'breaks-screens-and-takes-the-forms-type', () => {
    const e = r3go({ a: A('Raging Bull', { species: 1403 }), b: { moves: ['Splash'] }, sd: [{}, { reflect: 5 }] }).ev;
    const fire = tdmg('Raging Bull', {}, { species: 1403 }, { ty: [T.GRASS] }), norm = tdmg('Raging Bull', {}, { species: 128 }, { ty: [T.GRASS] });
    return eq([of(e, 'screen-end').length, fire > norm], [1, true]);
  });
  kt('ivycudgel', 'ogerpon-forms-take-their-second-type', () => {
    const water = tdmg('Ivy Cudgel', {}, { species: 1417 }, { ty: [T.FIRE] }), grass = tdmg('Ivy Cudgel', {}, {}, { ty: [T.FIRE] });
    return eq([water > grass], [true]);
  });
  kt('skydrop', 'lifts-for-a-turn-then-drops', () => {
    const b = lab({ a: A('Sky Drop'), b: { moves: ['Pound'], st: { spe: 50 } } });
    const e1 = turn(b, MV(0), MV(0)); const foe = () => b.s.sides[1].team[b.s.sides[1].act];
    const lifted = foe().v.held === 1;
    const e2 = turn(b, null, MV(0));
    return eq([of(e1, 'charge').length, lifted, hit(e1, 1), of(e1, 'cant-move').length, hit(e2, 1) > 0, foe().v.held], [1, true, 0, 1, true, undefined]);
  });
  kt('fling', 'throws-the-item-with-its-power', () => { const g = r3go({ a: A('Fling', { it: 'Iron Ball' }), b: { moves: ['Splash'] } }); const n = r3go({ a: A('Fling') }); const k = r3go({ a: A('Fling', { it: "King's Rock", st: { spe: 200 } }), b: { moves: ['Pound'], st: { spe: 100 } } }); return eq([g.A.it, hit(g.ev, 1) > 40, of(n.ev, 'fail').length, of(k.ev, 'cant-move').length], [0, true, 1, 1]); });
  kt('gravapple', 'is-stronger-under-gravity', () => eq(tdmg('Grav Apple', { gv: 5 }) > tdmg('Grav Apple'), true));
  kt('ficklebeam', 'doubles-on-a-low-draw', () => { const f = (u) => { const b = lab({ a: A('Fickle Beam'), b: { moves: ['Harden'] } }); b.rand = (n) => (n === 100 ? Math.floor(u * 100) : n === 24 ? 1 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); return hit(b.advance(), 1); }; return eq(f(0.1) > f(0.9), true); });
  kt('hazardhit', 'sets-rocks-or-spikes-after-the-hit', () => { const hitDraw = (x) => (x === 24 ? 1 : 0); const a = r3go({ a: A('Stone Axe') }, hitDraw); const b = r3go({ a: A('Ceaseless Edge') }, hitDraw); return eq([a.b.s.sides[1].hz.sr, b.b.s.sides[1].hz.sp], [1, 1]); });
  kt('fusion', 'doubles-after-the-other-fusion-move', () => { const b = lab({ a: { moves: ['Fusion Flare'], st: { spe: 10 } }, b: { moves: ['Fusion Bolt'], st: { spe: 100 } } }); b.rand = (x) => (x === 100 ? 99 : x === 24 ? 1 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); const ev = b.advance(); const flare = hit(ev, 1), bolt = hit(ev, 0); const solo = tdmg('Fusion Flare'); return eq([flare > solo, bolt === tdmg('Fusion Bolt')], [true, true]); });
  kt('hyperspace', 'is-for-hoopa-unbound-only', () => eq(of(r3go({ a: A('Hyperspace Fury') }).ev, 'fail').length, 1));
  kt('geomancy', 'charges-then-raises-three-stats-by-two', () => { const b = two({ a: A('Geomancy') }, 1); const a1 = mA(b).sg.spa; const b2 = two({ a: A('Geomancy') }, 2); return eq([a1, mA(b2).sg.spa, mA(b2).sg.spd, mA(b2).sg.spe], [0, 2, 2, 2]); });
  kt('purify', 'cures-the-foe-and-heals-the-user-by-half', () => { const g = r3go({ a: A('Purify', { hp: 100 }), b: { moves: ['Splash'], s: 3 } }); return eq([g.B.s, g.A.hp], [0, 200]); });
  kt('courtchange', 'swaps-the-conditions-of-the-two-sides', () => { const b = lab({ a: { moves: ['Court Change'] }, b: { moves: ['Splash'] } }); b.s.sides[0].reflect = 5; b.rand = (x) => (x === 100 ? 99 : 0); b.drain(); b.choose(0, MV(0)); b.choose(1, MV(0)); b.advance(); return eq([b.s.sides[1].reflect > 0, b.s.sides[0].reflect], [true, 0]); });

  // every implemented class has at least one test
  add('class/every-implemented-kind-has-a-test', () => {
    const missing = [...M.engine_moves.IMPLEMENTED_KINDS].filter((k) => !covered.has(k));
    return eq(missing, []);
  });
  add('class/every-test-names-an-implemented-kind', () => eq([...covered].filter((k) => !M.engine_moves.IMPLEMENTED_KINDS.has(k)), []));

  // ================================================================== abilities
  const enter = (ab, extra) => { const b = lab({ a: { moves: ['Splash'], bench: [{ moves: ['Splash'] }], benchSpec: { ab } }, b: Object.assign({ moves: ['Splash'] }, extra || {}) }); const ev = turn(b, SW(1), MV(0)); return { b, ev }; };
  add('ability/intimidate-lowers-attack-and-inner-focus-blocks', () => eq([enter('Intimidate').b.s.sides[1].team[0].sg.atk, enter('Intimidate', { ab: 'Inner Focus' }).b.s.sides[1].team[0].sg.atk, enter('Intimidate', { ab: 'Clear Body' }).b.s.sides[1].team[0].sg.atk], [-1, 0, 0]));
  add('ability/weather-setters', () => eq([enter('Drizzle').b.s.wx[0], enter('Drought').b.s.wx[0], enter('Sand Stream').b.s.wx[0], enter('Snow Warning').b.s.wx[0]], [1, 2, 3, 5]));
  add('ability/download-picks-the-weaker-defense', () => eq([enter('Download', { st: { def: 50, spd: 100 } }).b.s.sides[0].team[1].sg.atk, enter('Download', { st: { def: 100, spd: 50 } }).b.s.sides[0].team[1].sg.spa], [1, 1]));
  add('ability/levitate-and-mold-breaker', () => {
    const lev = run({ a: A('Earthquake'), b: { ab: 'Levitate' } }, { rng: [] });
    const mb = run({ a: A('Earthquake', { ab: 'Mold Breaker' }), b: { ab: 'Levitate' } }, { rng: NC });
    return eq([hit(lev.ev, 1), hit(mb.ev, 1) > 0], [0, true]);
  });
  add('ability/absorbers', () => eq([
    healed(run({ a: A('Thunderbolt'), b: { ab: 'Volt Absorb', hp: 100 } }, { rng: [] }).ev, 1), healed(run({ a: A('Water Gun'), b: { ab: 'Water Absorb', hp: 100 } }, { rng: [] }).ev, 1),
    run({ a: A('Thunderbolt'), b: { ab: 'Lightning Rod' } }, { rng: [] }).B.sg.spa, run({ a: A('Thunderbolt'), b: { ab: 'Motor Drive' } }, { rng: [] }).B.sg.spe,
    run({ a: A('Vine Whip'), b: { ab: 'Sap Sipper' } }, { rng: [] }).B.sg.atk, run({ a: A('Water Gun'), b: { ab: 'Storm Drain' } }, { rng: [] }).B.sg.spa,
    run({ a: A('Flamethrower'), b: { ab: 'Flash Fire' } }, { rng: [] }).B.v.ff,
  ], [50, 50, 1, 1, 1, 1, 1]));
  add('ability/flash-fire-boosts-own-fire-moves', () => eq(dmg2({ a: { ab: 'Flash Fire', v: { ff: 1 } } }, 'Flamethrower'), 61));
  add('ability/sturdy-survives-from-full-hp', () => { const r = run({ a: A('Pound', { st: { atk: 999 } }), b: { ab: 'Sturdy', hp: 10, mhp: 10 } }, { rng: NC }); return eq(r.B.hp, 1); });
  add('ability/contact-status-30-percent', () => eq([
    run({ a: A('Pound'), b: { ab: 'Static' } }, { rng: [1, 0, 29] }).A.s, run({ a: A('Pound'), b: { ab: 'Static' } }, { rng: [1, 0, 30] }).A.s, run({ a: A('Pound'), b: { ab: 'Flame Body' } }, { rng: [1, 0, 0] }).A.s,
    run({ a: A('Pound'), b: { ab: 'Poison Point' } }, { rng: [1, 0, 0] }).A.s,
  ], [5, 0, 3, 2]));
  add('ability/rough-skin-eighth', () => eq(lost(run({ a: A('Pound'), b: { ab: 'Rough Skin' } }, { rng: NC }).ev, 0, 'rough-skin'), 25));
  add('ability/speed-boost-each-turn', () => eq(run({ a: A('Splash', { ab: 'Speed Boost' }) }).A.sg.spe, 1));
  add('ability/moxie-on-ko', () => eq(run({ a: A('Pound', { ab: 'Moxie' }), b: { hp: 1 } }, { rng: NC }).A.sg.atk, 1));
  add('ability/contrary-and-simple', () => eq([run({ a: A('Swords Dance', { ab: 'Contrary' }) }).A.sg.atk, run({ a: A('Swords Dance', { ab: 'Simple' }) }).A.sg.atk], [-2, 4]));
  add('ability/defiant-and-clear-body', () => eq([run({ a: A('Growl'), b: { ab: 'Defiant' } }).B.sg.atk, run({ a: A('Growl'), b: { ab: 'Clear Body' } }).B.sg.atk, run({ a: A('Growl'), b: { ab: 'Hyper Cutter' } }).B.sg.atk, run({ a: A('Growl'), b: { ab: 'Competitive' } }).B.sg.spa], [1, 0, 0, 2]));
  add('ability/unaware-ignores-boosts', () => eq(dmg2({ a: { sg: { atk: 2 } }, b: { ab: 'Unaware' } }, 'Pound'), 19));
  add('ability/serene-grace-doubles-secondary-chance', () => eq([of(run({ a: A('Flamethrower', { ab: 'Serene Grace' }) }, { rng: [1, 0, 15] }).ev, 'status-set').length, of(run({ a: A('Flamethrower') }, { rng: [1, 0, 15] }).ev, 'status-set').length], [1, 0]));
  add('ability/skill-link-five-hits', () => eq(of(run({ a: A('Double Slap', { ab: 'Skill Link' }) }, { rng: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] }).ev, 'multi-hit')[0].n, 5));
  // Double Slap (acc 85, BP15 -> floor(330/50)+2 = 8 per hit): after the accuracy roll one rand(100) picks 2/3/4/5 hits (<35, <70, <85, else)
  add('ability/multi-hit-count-35-35-15-15', () => {
    const n = (r, hits) => { const rng = [0, r]; for (let i = 0; i < hits; i++) rng.push(1, 0); const x = run({ a: A('Double Slap') }, { rng }); return [of(x.ev, 'multi-hit')[0].n, hit(x.ev, 1)]; };
    return eq([n(0, 2), n(34, 2), n(35, 3), n(69, 3), n(70, 4), n(84, 4), n(85, 5), n(99, 5)], [[2, 16], [2, 16], [3, 24], [3, 24], [4, 32], [4, 32], [5, 40], [5, 40]]);
  });
  add('ability/poison-heal-and-magic-guard', () => eq([run({ a: A('Splash', { ab: 'Poison Heal', s: 2, hp: 100 }) }).A.hp, run({ a: A('Splash', { ab: 'Magic Guard', s: 2 }) }).A.hp], [125, 200]));
  add('ability/natural-cure-and-regenerator', () => {
    const nc = lab({ a: { moves: ['Splash'], ab: 'Natural Cure', s: 3, bench: [A('Pound')] } });
    turn(nc, SW(1), MV(0));
    const rg = lab({ a: { moves: ['Splash'], ab: 'Regenerator', hp: 60, bench: [A('Pound')] } });
    turn(rg, SW(1), MV(0));
    return eq([nc.s.sides[0].team[0].s, rg.s.sides[0].team[0].hp], [0, 60 + 66]);
  });
  add('ability/synchronize-passes-status-back', () => { const r = run({ a: A('Thunder Wave'), b: { ab: 'Synchronize' } }, { rng: [0, 1] }); return eq([r.B.s, r.A.s], [5, 5]); });
  add('ability/guts-ignores-burn-and-boosts', () => eq(dmg2({ a: { ab: 'Guts', s: 3 } }, 'Pound'), 28));
  add('ability/swift-swim-doubles-speed-in-rain', () => eq(of(run({ a: A('Pound', { ab: 'Swift Swim', st: { spe: 30 } }), b: { moves: ['Pound'] }, wx: [1, 5] }, { rng: [1, 0, 1, 0] }).ev, 'move-use').map((e) => e.s), [0, 1]));
  add('ability/truant-loafs-every-other-turn', () => { const b = lab({ a: A('Pound', { ab: 'Truant' }) }); const e1 = turn(b, MV(0), MV(0), NC), e2 = turn(b, MV(0), MV(0)); return eq([of(e1, 'cant-move').length, of(e2, 'cant-move').filter((e) => e.why === 'truant').length], [0, 1]); });
  add('ability/status-immunities', () => eq([
    run({ a: A('Thunder Wave'), b: { ab: 'Limber' } }, { rng: [0] }).B.s, run({ a: A('Spore'), b: { ab: 'Insomnia' } }, { rng: [] }).B.s, run({ a: A('Toxic'), b: { ab: 'Immunity' } }, { rng: [0] }).B.s, run({ a: A('Will-O-Wisp'), b: { ab: 'Water Veil' } }, { rng: [0] }).B.s,
  ], [0, 0, 0, 0]));
  add('ability/steadfast-and-inner-focus-flinch', () => {
    const f = run({ a: A('Fake Out'), b: { moves: ['Pound'], ab: 'Steadfast' } }, { rng: NC });
    const i = run({ a: A('Fake Out'), b: { moves: ['Pound'], ab: 'Inner Focus' } }, { rng: [1, 0, 1, 0] });
    return eq([f.B.sg.spe, of(i.ev, 'cant-move').length], [1, 0]);
  });
  add('ability/scrappy-hits-ghosts', () => eq(hit(run({ a: A('Pound', { ab: 'Scrappy' }), b: { ty: [T.GHOST] } }, { rng: NC }).ev, 1), 19));
  add('ability/aerilate-changes-type-and-boosts', () => eq(hit(run({ a: A('Pound', { ab: 'Aerilate' }), b: { ty: [T.GRASS] } }, { rng: NC }).ev, 1), 46));
  add('ability/pressure-costs-extra-pp', () => eq(run({ a: A('Pound'), b: { ab: 'Pressure' } }, { rng: NC }).A.mv[0].pp, 33));
  add('ability/shadow-tag-traps', () => { const b = lab({ a: { moves: ['Splash'], bench: [A('Splash')] }, b: { moves: ['Splash'], ab: 'Shadow Tag' } }); return eq([b.requests()[0].trapped, b.choose(0, SW(1)).code], [true, 'trapped']); });
  add('ability/technician-boundary-60', () => eq(hit(run({ a: A('Pound', { ab: 'Technician' }) }, { rng: NC }).ev, 1), 28));
  add('ability/prankster-vs-priority-move', () => eq(of(run({ a: A('Splash', { st: { spe: 40 }, ab: 'Prankster' }), b: { moves: ['Pound'], st: { spe: 100 } } }, { rng: [1, 0] }).ev, 'move-use').map((e) => e.s), [0, 1]));
  add('ability/reckless-iron-fist-sheer-force-boosts', () => eq([dmg2({ a: { ab: 'Reckless' } }, 'Double-Edge'), dmg2({ a: { ab: 'Iron Fist' } }, 'Mach Punch'), dmg2({ a: { ab: 'Sheer Force' } }, 'Flamethrower')], [65, 23, 53]));
  function dmg2(spec, move, o) { return lab(spec).previewDamage(0, mid(move), o || {}); }

  // ================================================================== items
  add('item/leftovers-black-sludge', () => eq([run({ a: A('Splash', { it: 'Leftovers', hp: 100 }) }).A.hp, run({ a: A('Splash', { it: 'Black Sludge', hp: 100, ty: [T.POISON] }) }).A.hp, run({ a: A('Splash', { it: 'Black Sludge' }) }).A.hp], [112, 112, 175]));
  add('item/life-orb-recoil-tenth', () => eq(lost(run({ a: A('Pound', { it: 'Life Orb' }) }, { rng: NC }).ev, 0, 'life-orb'), 20));
  add('item/choice-band-locks-the-move', () => {
    const b = lab({ a: { moves: ['Pound', 'Splash'], it: 'Choice Band' } });
    turn(b, MV(0), MV(0), NC);
    const rq = b.requests()[0];
    return eq([rq.moves.map((m) => m.reason), b.choose(0, MV(1)).code], [['', 'choice'], 'choice']);
  });
  add('item/focus-sash-survives-once', () => { const r = run({ a: A('Pound'), b: { it: 'Focus Sash', hp: 10, mhp: 10 } }, { rng: NC }); return eq([r.B.hp, r.B.it], [1, 0]); });
  add('item/sitrus-and-oran-berries', () => eq([run({ a: A('Pound', { st: { atk: 400 } }), b: { it: 'Sitrus Berry', hp: 120, mhp: 200 } }, { rng: NC }).B.it, run({ a: A('Pound'), b: { it: 'Oran Berry', hp: 110 } }, { rng: NC }).B.hp], [0, 110 - 19 + 10]));
  add('item/lum-and-status-berries-cure', () => eq([run({ a: A('Will-O-Wisp'), b: { it: 'Lum Berry' } }, { rng: [0] }).B.s, run({ a: A('Thunder Wave'), b: { it: 'Cheri Berry' } }, { rng: [0] }).B.s, run({ a: A('Toxic'), b: { it: 'Pecha Berry' } }, { rng: [0] }).B.s], [0, 0, 0]));
  add('item/resist-berry-halves-super-effective-once', () => { const r = run({ a: A('Flamethrower'), b: { ty: [T.GRASS], it: 'Occa Berry' } }, { rng: [1, 0, 99] }); return eq([hit(r.ev, 1), r.B.it], [41, 0]); });
  add('item/rocky-helmet-sixth-on-contact', () => eq(lost(run({ a: A('Pound'), b: { it: 'Rocky Helmet' } }, { rng: NC }).ev, 0, 'rocky-helmet'), 33));
  add('item/air-balloon-floats-until-popped', () => { const r = run({ a: A('Earthquake'), b: { it: 'Air Balloon' } }, { rng: [] }); return eq([hit(r.ev, 1), r.B.it > 0], [0, true]); });
  add('item/weakness-policy', () => { const r = run({ a: A('Karate Chop'), b: { ty: [T.NORMAL], it: 'Weakness Policy' } }, { rng: NC }); return eq([r.B.sg.atk, r.B.sg.spa], [2, 2]); });
  add('item/shell-bell-eighth-of-damage', () => eq(healed(run({ a: A('Pound', { it: 'Shell Bell', hp: 100 }) }, { rng: NC }).ev, 0), 2));
  add('item/kings-rock-flinch-10-percent', () => eq([of(run({ a: A('Pound', { it: "King's Rock" }), b: { moves: ['Pound'] } }, { rng: [1, 0, 9] }).ev, 'cant-move').length, of(run({ a: A('Pound', { it: "King's Rock" }), b: { moves: ['Pound'] } }, { rng: [1, 0, 10, 1, 0] }).ev, 'cant-move').length], [1, 0]));
  add('item/flame-orb-and-toxic-orb', () => eq([run({ a: A('Splash', { it: 'Flame Orb' }) }).A.s, run({ a: A('Splash', { it: 'Toxic Orb' }) }).A.s], [3, 6]));
  add('item/quick-claw-moves-first-on-rand5-zero', () => eq(of(run({ a: A('Pound', { st: { spe: 40 } }), b: { moves: ['Pound'], it: 'Quick Claw' } }, { rng: [0, 1, 0, 1, 0] }).ev, 'move-use').map((e) => e.s), [1, 0]));
  add('item/assault-vest-disables-status-moves', () => { const b = lab({ a: { moves: ['Pound', 'Swords Dance'], it: 'Assault Vest' } }); return eq(b.requests()[0].moves.map((m) => m.reason), ['', 'assault-vest']); });
  add('item/power-herb-skips-the-charge', () => { const r = run({ a: A('Razor Wind', { it: 'Power Herb' }) }, { rng: NC }); return eq([of(r.ev, 'charge').length, hit(r.ev, 1)], [0, 37]); });
  add('item/white-herb-restores-drops', () => eq(run({ a: A('Growl'), b: { it: 'White Herb' } }).B.sg.atk, 0));
  add('item/covert-cloak-blocks-secondary', () => eq(run({ a: A('Flamethrower'), b: { it: 'Covert Cloak' } }, { rng: [1, 0] }).B.s, 0));
  add('item/clear-amulet-blocks-drops', () => eq(run({ a: A('Growl'), b: { it: 'Clear Amulet' } }).B.sg.atk, 0));
  add('item/muscle-band-and-wise-glasses', () => eq([dmg2({ a: { it: 'Muscle Band' } }, 'Pound'), dmg2({ a: { it: 'Wise Glasses' } }, 'Flamethrower')], [21, 45]));
  return { checks, covered };
}

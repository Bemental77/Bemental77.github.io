// tools/pokemonarena_rom_diff_combos.mjs -- the scenario list of the engine-vs-real-game differential (stage FA2).
//
// buildCombos() returns plain JSON-able scenarios (no ids, only names, so the same list drives the engine side and the live side).
// engineExpect(M, pack, combo) computes what the ENGINE says: the set of per-hit damages over the 16 damage rolls, with and without a
// critical hit (engine.previewDamage), which the live runner compares with what the real game dealt.
// Deterministic (a fixed PRNG seeded per scenario), pure ASCII, nothing here is ROM content.

import { mulberry32 } from './pokemonarena_engine_lib.mjs';

const TYPE_NAMES = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy'];
// one plain attacking move per type, physical and special, chosen for plain damage (no secondary that changes the numbers)
const PHYS = { Normal: 'Body Slam', Fighting: 'Close Combat', Flying: 'Drill Peck', Poison: 'Poison Jab', Ground: 'Earthquake', Rock: 'Rock Slide', Bug: 'X-Scissor', Ghost: 'Shadow Claw', Steel: 'Iron Head', Fire: 'Fire Punch', Water: 'Waterfall', Grass: 'Leaf Blade', Electric: 'Wild Charge', Psychic: 'Zen Headbutt', Ice: 'Icicle Crash', Dragon: 'Dragon Claw', Dark: 'Crunch', Fairy: 'Play Rough' };
const SPEC = { Normal: 'Hyper Voice', Fighting: 'Focus Blast', Flying: 'Air Slash', Poison: 'Sludge Bomb', Ground: 'Earth Power', Rock: 'Power Gem', Bug: 'Bug Buzz', Ghost: 'Shadow Ball', Steel: 'Flash Cannon', Fire: 'Flamethrower', Water: 'Surf', Grass: 'Energy Ball', Electric: 'Thunderbolt', Psychic: 'Psychic', Ice: 'Ice Beam', Dragon: 'Dragon Pulse', Dark: 'Dark Pulse', Fairy: 'Moonblast' };
// defender type pairs that span immunity, double resistance, double weakness and neutral
const DEF_TYPES = [['Normal'], ['Ghost'], ['Steel', 'Rock'], ['Grass', 'Bug'], ['Water', 'Ground'], ['Flying', 'Dragon'], ['Fairy', 'Poison'], ['Ice', 'Psychic'], ['Fire', 'Fighting'], ['Dark', 'Electric']];

export function buildCombos() {
  const out = [];
  const rnd = mulberry32(0xFA2);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  let n = 0;
  const base = (over) => ({ id: ++n, level: 50, a: { st: { atk: ri(90, 220), def: 100, spa: ri(90, 220), spd: 100, spe: 150 }, types: ['Normal'], ability: null, item: null, status: null, stages: {} },
    b: { st: { atk: 100, def: ri(70, 200), spa: 100, spd: ri(70, 200), spe: 60 }, types: ['Normal'], ability: null, item: null, status: null, stages: {}, hp: 600, maxhp: 600 }, weather: null, screens: [], crit: 'any', ...over });
  const mk = (group, over, tweak) => { const c = base(over); c.group = group; if (tweak) tweak(c); out.push(c); return c; };

  // 1. type chart x category: every attacking type, physical and special, against ten defender type combinations
  TYPE_NAMES.forEach((tn, ti) => {
    DEF_TYPES.forEach((dt, di) => {
      if ((ti + di) % 2 === 0) mk('type-phys', { move: PHYS[tn] }, (c) => { c.b.types = dt; c.a.types = di % 3 === 0 ? [tn] : ['Normal']; });
      else mk('type-spec', { move: SPEC[tn] }, (c) => { c.b.types = dt; c.a.types = di % 3 === 0 ? [tn] : ['Normal']; });
    });
  });
  // 2. STAB, double STAB (both attacker types equal), no STAB; levels other than 50
  for (const lv of [5, 23, 50, 77, 100]) mk('level', { move: 'Flamethrower', level: lv }, (c) => { c.a.types = ['Fire', 'Flying']; c.b.types = ['Grass']; });
  for (const lv of [5, 36, 100]) mk('level', { move: 'Body Slam', level: lv }, (c) => { c.a.types = ['Normal']; c.b.types = ['Normal']; });
  // 3. stat stages on both sides, crit interaction with stages
  for (const [as, ds] of [[2, 0], [-2, 0], [0, 2], [0, -2], [6, 0], [-6, 0], [0, 6], [0, -6], [3, -3], [-3, 3], [1, 1], [-1, -1]]) {
    mk('stages', { move: 'Earthquake', crit: 'never' }, (c) => { c.a.stages = { atk: as }; c.b.stages = { def: ds }; c.b.types = ['Normal']; c.a.types = ['Normal']; });
    mk('stages-spec', { move: 'Thunderbolt', crit: 'never' }, (c) => { c.a.stages = { spa: as }; c.b.stages = { spd: ds }; c.b.types = ['Normal']; });
  }
  for (const [as, ds] of [[-2, 0], [0, 2], [-3, 3], [2, -2]]) mk('stages-crit', { move: 'Frost Breath', crit: 'force' }, (c) => { c.a.stages = { spa: as }; c.b.stages = { spd: ds }; c.b.types = ['Normal']; });
  for (const [as, ds] of [[-2, 0], [0, 2], [-3, 3], [2, -2]]) mk('stages-crit', { move: 'Storm Throw', crit: 'force' }, (c) => { c.a.stages = { atk: as }; c.b.stages = { def: ds }; c.b.types = ['Normal']; });
  // 4. weather
  for (const [w, mv] of [['rain', 'Surf'], ['rain', 'Flamethrower'], ['sun', 'Flamethrower'], ['sun', 'Surf'], ['sun', 'Solar Beam'], ['rain', 'Solar Beam'], ['sand', 'Power Gem'], ['sand', 'Rock Slide'], ['snow', 'Icicle Crash'], ['snow', 'Ice Beam'], ['hail', 'Ice Beam'], ['rain', 'Hydro Pump'], ['sun', 'Fire Punch'], ['rain', 'Waterfall']]) {
    mk('weather', { move: mv, weather: w }, (c) => { c.b.types = ['Rock']; });
    mk('weather', { move: mv, weather: w }, (c) => { c.b.types = ['Ice', 'Steel']; });
  }
  // 5. burn and status
  for (const mv of ['Close Combat', 'Earthquake', 'Facade', 'Body Slam', 'Flamethrower', 'Hex', 'Venoshock']) {
    mk('burn', { move: mv }, (c) => { c.a.status = 'brn'; c.b.types = ['Normal']; });
  }
  mk('status', { move: 'Hex' }, (c) => { c.b.status = 'par'; }); mk('status', { move: 'Hex' }, (c) => { c.b.status = null; });
  mk('status', { move: 'Venoshock' }, (c) => { c.b.status = 'psn'; }); mk('status', { move: 'Venoshock' }, (c) => { c.b.status = 'tox'; });
  mk('status', { move: 'Facade' }, (c) => { c.a.status = 'par'; }); mk('status', { move: 'Facade' }, (c) => { c.a.status = 'psn'; });
  mk('status', { move: 'Smelling Salts' }, (c) => { c.b.status = 'par'; }); mk('status', { move: 'Smelling Salts' }, (c) => { c.b.status = null; });
  // 5b. frostbite (round 3): the status the hack's Ice moves give; special damage of the holder is halved, physical is not
  for (const mv of ['Flamethrower', 'Thunderbolt', 'Surf', 'Psychic', 'Pound', 'Earthquake', 'Frost Breath', 'Hyper Voice']) mk('frostbite', { move: mv, crit: mv === 'Frost Breath' ? 'force' : 'never' }, (c) => { c.a.status = 'fbt'; c.b.types = ['Normal']; });
  mk('frostbite', { move: 'Flamethrower', crit: 'never' }, (c) => { c.a.status = 'fbt'; c.a.types = ['Fire']; c.b.types = ['Grass']; });
  mk('frostbite', { move: 'Flamethrower', crit: 'never' }, (c) => { c.b.status = 'fbt'; c.b.types = ['Normal']; });
  // 5c. terrain and Gravity (round 3).  Each case was first run in the real game; the engine must reproduce the damage roll for roll.
  const TFLD = [['grassy', 'Energy Ball', 'Grass'], ['electric', 'Thunderbolt', 'Electric'], ['psychic', 'Psychic', 'Psychic'], ['misty', 'Moonblast', 'Fairy']];
  for (const [fl, mv] of TFLD) {
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; });                                   // grounded user: x1.3
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; c.a.types = ['Flying']; });          // a flying user gets nothing
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; c.a.ability = 'Levitate'; });         // neither does a Levitate user
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Flying']; });                                   // the target's footing does not matter for the boost
  }
  for (const [fl, mv] of [['electric', 'Energy Ball'], ['grassy', 'Thunderbolt'], ['psychic', 'Moonblast'], ['misty', 'Psychic']]) mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; });   // a different type: no boost
  for (const mv of ['Earthquake', 'Bulldoze']) {
    mk('terrain', { move: mv, field: ['grassy'], crit: 'never' }, (c) => { c.b.types = ['Normal']; });
    mk('terrain', { move: mv, field: ['electric'], crit: 'never' }, (c) => { c.b.types = ['Normal']; });
    mk('terrain', { move: mv, field: ['grassy'], crit: 'never' }, (c) => { c.b.types = ['Normal']; c.b.ability = 'Levitate'; });
  }
  for (const mv of ['Dragon Claw', 'Dragon Pulse']) {
    mk('terrain', { move: mv, field: ['misty'], crit: 'never' }, (c) => { c.b.types = ['Normal']; });                             // x0.5 against a grounded target
    mk('terrain', { move: mv, field: ['misty'], crit: 'never' }, (c) => { c.b.types = ['Flying']; });                              // a flying target takes the full move
    mk('terrain', { move: mv, field: ['grassy'], crit: 'never' }, (c) => { c.b.types = ['Normal']; });
  }
  for (const fl of ['grassy', 'electric', 'psychic', 'misty']) {
    mk('terrain', { move: 'Terrain Pulse', field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; });
    mk('terrain', { move: 'Terrain Pulse', field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; c.a.types = ['Flying']; });
    mk('terrain', { move: 'Terrain Pulse', field: [fl], crit: 'never' }, (c) => { c.b.types = ['Water', 'Ground']; });
  }
  mk('terrain', { move: 'Terrain Pulse', crit: 'never' }, (c) => { c.b.types = ['Normal']; });
  for (const [mv, fl] of [['Rising Voltage', 'electric'], ['Expanding Force', 'psychic'], ['Psyblade', 'electric'], ['Misty Explosion', 'misty'], ['Steel Roller', 'grassy'], ['Steel Roller', 'misty'], ['Grassy Glide', 'grassy']]) {
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; });
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Flying']; });
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.types = ['Normal']; c.a.types = ['Flying']; });
    mk('terrain', { move: mv, crit: 'never' }, (c) => { c.b.types = ['Normal']; });
  }
  mk('terrain', { move: 'Thunderbolt', field: ['electric'], crit: 'never' }, (c) => { c.a.ability = 'Hadron Engine'; c.b.types = ['Normal']; });
  mk('terrain', { move: 'Thunderbolt', field: ['electric'], crit: 'never' }, (c) => { c.a.ability = 'Hadron Engine'; c.a.types = ['Flying']; c.b.types = ['Normal']; });
  mk('terrain', { move: 'Body Slam', field: ['electric'], crit: 'never' }, (c) => { c.a.ability = 'Hadron Engine'; c.b.types = ['Normal']; });
  mk('terrain', { move: 'Flamethrower', field: ['electric'], crit: 'never' }, (c) => { c.a.ability = 'Hadron Engine'; c.b.types = ['Normal']; });
  mk('terrain', { move: 'Thunderbolt', crit: 'never' }, (c) => { c.a.ability = 'Hadron Engine'; c.b.types = ['Normal']; });
  for (const fl of ['grassy', 'none']) for (const mv of ['Body Slam', 'Flamethrower']) mk('terrain', { move: mv, field: fl === 'none' ? [] : [fl], crit: 'never' }, (c) => { c.b.ability = 'Grass Pelt'; c.b.types = ['Normal']; });
  mk('terrain', { move: 'Body Slam', field: ['grassy'], crit: 'never' }, (c) => { c.b.ability = 'Grass Pelt'; c.b.types = ['Flying']; });
  for (const [mv, fl] of [['Body Slam', 'electric'], ['Flamethrower', 'electric'], ['Body Slam', 'grassy']]) {
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.a.ability = 'Quark Drive'; c.a.st = { atk: 220, def: 100, spa: 120, spd: 100, spe: 150 }; c.b.types = ['Normal']; });
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.a.ability = 'Quark Drive'; c.a.st = { atk: 120, def: 100, spa: 220, spd: 100, spe: 150 }; c.b.types = ['Normal']; });
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.ability = 'Quark Drive'; c.b.st = { atk: 100, def: 220, spa: 100, spd: 120, spe: 60 }; c.b.types = ['Normal']; });
    mk('terrain', { move: mv, field: [fl], crit: 'never' }, (c) => { c.b.ability = 'Quark Drive'; c.b.st = { atk: 100, def: 120, spa: 100, spd: 220, spe: 60 }; c.b.types = ['Normal']; });
  }
  for (const [mv, ab] of [['Earthquake', 'Electromagnetism'], ['Earthquake', 'Levitate'], ['Earthquake', null], ['Body Slam', 'Electromagnetism']]) {
    mk('gravity', { move: mv, field: ['gravity'], crit: 'never' }, (c) => { c.b.ability = ab; c.b.types = ['Normal']; });
    mk('gravity', { move: mv, field: ['gravity'], crit: 'never' }, (c) => { c.b.ability = ab; c.b.types = ['Flying']; });
  }
  mk('gravity', { move: 'Earthquake', field: ['gravity'], crit: 'never' }, (c) => { c.b.item = 'Air Balloon'; c.b.types = ['Normal']; });
  mk('gravity', { move: 'Earthquake', crit: 'never' }, (c) => { c.b.item = 'Air Balloon'; c.b.types = ['Normal']; });
  mk('gravity', { move: 'Earthquake', field: ['gravity'], crit: 'never' }, (c) => { c.b.item = 'Iron Ball'; c.b.types = ['Flying']; });
  mk('gravity', { move: 'Earthquake', field: ['gravity'], crit: 'never' }, (c) => { c.b.ability = 'Allseeing Idol'; c.b.types = ['Normal']; });
  mk('gravity', { move: 'Body Slam', field: ['gravity'], crit: 'never' }, (c) => { c.b.ability = 'Allseeing Idol'; c.b.types = ['Normal']; });
  mk('gravity', { move: 'Flamethrower', field: ['gravity'], crit: 'never' }, (c) => { c.b.ability = 'Allseeing Idol'; c.b.types = ['Normal']; });
  mk('gravity', { move: 'Body Slam', crit: 'never' }, (c) => { c.b.ability = 'Allseeing Idol'; c.b.types = ['Normal']; });
  // 5d. Rivalry (round 3): x1.25 against the same gender, x0.75 against the opposite one, nothing against a genderless Pokemon or from one
  for (const [ga, gb] of [['M', 'M'], ['F', 'F'], ['M', 'F'], ['F', 'M'], ['-', 'M'], ['M', '-']]) {
    for (const mv of ['Body Slam', 'Flamethrower']) mk('gender', { move: mv, crit: 'never' }, (c) => { c.a.ability = 'Rivalry'; c.a.gender = ga; c.b.gender = gb; c.b.types = ['Normal']; });
  }
  mk('gender', { move: 'Body Slam', crit: 'never' }, (c) => { c.a.gender = 'M'; c.b.gender = 'M'; c.b.types = ['Normal']; });
  // 5e. primal weathers (round 3): heavy rain and harsh sun act as rain / sun and cancel the opposite element; strong winds make what is super effective against Flying neutral
  for (const [w, mv] of [['hrain', 'Surf'], ['hrain', 'Flamethrower'], ['hsun', 'Flamethrower'], ['hsun', 'Surf'], ['hsun', 'Water Gun'], ['hrain', 'Fire Blast'], ['hsun', 'Solar Beam'], ['hrain', 'Solar Beam']]) {
    mk('primal', { move: mv, weather: w, crit: 'never' }, (c) => { c.b.types = ['Normal']; });
    mk('primal', { move: mv, weather: w, crit: 'never' }, (c) => { c.b.types = ['Rock']; });
  }
  for (const mv of ['Ice Beam', 'Thunderbolt', 'Rock Slide', 'Ice Punch', 'Stone Edge']) {
    for (const bt of [['Flying'], ['Flying', 'Grass'], ['Flying', 'Dragon'], ['Flying', 'Bug'], ['Normal'], ['Flying', 'Ground']]) {
      mk('primal', { move: mv, weather: 'winds', crit: 'never' }, (c) => { c.b.types = bt; });
    }
    mk('primal', { move: mv, crit: 'never' }, (c) => { c.b.types = ['Flying', 'Grass']; });
  }
  // 5g. Scorched Field (round 3): Fire moves and Scald stronger, Water and Ice moves weaker; Ash Assets adds 15%
  for (const mv of ['Flamethrower', 'Fire Punch', 'Ember', 'Fire Blast', 'Scald', 'Surf', 'Water Gun', 'Hydro Pump', 'Waterfall', 'Ice Beam', 'Ice Punch', 'Blizzard', 'Pound', 'Thunderbolt', 'Terrain Pulse']) {
    mk('scorched', { move: mv, field: ['scorched'], crit: 'never' }, (c) => { c.b.types = ['Normal']; });
  }
  for (const [mv, w] of [['Flamethrower', 'sun'], ['Surf', 'rain'], ['Flamethrower', 'rain'], ['Surf', 'sun']]) mk('scorched', { move: mv, field: ['scorched'], weather: w, crit: 'never' }, (c) => { c.b.types = ['Normal']; });
  for (const mv of ['Flamethrower', 'Pound', 'Surf', 'Scald']) {
    mk('scorched', { move: mv, field: ['scorched'], crit: 'never' }, (c) => { c.a.ability = 'Ash Assets'; c.b.types = ['Normal']; });
    mk('scorched', { move: mv, crit: 'never' }, (c) => { c.a.ability = 'Ash Assets'; c.b.types = ['Normal']; });
  }
  mk('scorched', { move: 'Flamethrower', field: ['scorched'], crit: 'never' }, (c) => { c.a.types = ['Fire']; c.b.types = ['Normal']; });
  mk('scorched', { move: 'Flamethrower', field: ['scorched'], crit: 'never' }, (c) => { c.b.types = ['Water']; });
  mk('scorched', { move: 'Flamethrower', field: ['scorched'], crit: 'never' }, (c) => { c.b.types = ['Grass', 'Ice']; });
  // 5h. the newer damaging moves (round 3 batch C): the damage table must match roll for roll
  // Genesis Supernova is NOT in this list: it sets Psychic Terrain before it hits (87 in the full-turn scenario of _turns.mjs, which matches), but this harness re-writes the field words while it waits for the hit and so wipes the terrain (67 without the boost): a harness artifact
  for (const mv of ['Poltergeist', 'Throat Chop', 'Core Enforcer', 'Alluring Voice', 'Psychic Noise', 'Burning Jealousy', 'Flame Burst', 'Sparkling Aria', 'Floaty Fall', 'Plasma Fists', 'Glitzy Glow', 'Baddy Bad', 'Sappy Seed', 'Freezy Frost', 'Sparkly Swirl', 'Jaw Lock', 'Eerie Spell', 'Order Up', 'Glaive Rush', 'Salt Cure', 'Syrup Bomb', 'Incinerate', 'Rage', 'Upper Hand', 'Spectral Thief', 'Scale Shot']) {
    mk('newhit', { move: mv, crit: 'never' }, (c) => { c.b.types = ['Normal']; c.b.item = (mv === 'Poltergeist') ? 'Leftovers' : null; });
  }
  mk('newhit', { move: 'Salt Cure', crit: 'never' }, (c) => { c.b.types = ['Water']; }); mk('newhit', { move: 'Poltergeist', crit: 'never' }, (c) => { c.b.types = ['Normal']; c.b.item = null; });
  // 6. screens
  for (const [mv, sc] of [['Earthquake', 'reflect'], ['Earthquake', 'light'], ['Thunderbolt', 'light'], ['Thunderbolt', 'reflect'], ['Earthquake', 'veil'], ['Thunderbolt', 'veil']]) {
    mk('screens', { move: mv, screens: [sc], crit: 'never' });
    mk('screens', { move: mv, screens: [sc], crit: 'force' }, (c) => { if (mv === 'Earthquake') c.move = 'Storm Throw'; else c.move = 'Frost Breath'; });
  }
  // 7. attacker abilities (each against a neutral defender) and defender abilities
  const AA = [['Huge Power', 'Earthquake'], ['Pure Power', 'Earthquake'], ['Technician', 'Bullet Punch'], ['Technician', 'Earthquake'], ['Iron Fist', 'Fire Punch'], ['Iron Fist', 'Earthquake'], ['Reckless', 'Double-Edge'], ['Reckless', 'Earthquake'],
    ['Sheer Force', 'Flamethrower'], ['Sheer Force', 'Earthquake'], ['Adaptability', 'Flamethrower'], ['Hustle', 'Earthquake'], ['Guts', 'Earthquake'], ['Tinted Lens', 'Flamethrower'], ['Sniper', 'Frost Breath'], ['Strong Jaw', 'Crunch'], ['Mega Launcher', 'Dark Pulse'], ['Sharpness', 'Leaf Blade'],
    ['Tough Claws', 'Close Combat'], ['Aerilate', 'Body Slam'], ['Pixilate', 'Body Slam'], ['Refrigerate', 'Hyper Voice'], ['Galvanize', 'Body Slam'], ['Normalize', 'Flamethrower'], ['Steelworker', 'Iron Head'], ['Water Bubble', 'Surf'], ['Analytic', 'Earthquake'],
    ['Punk Rock', 'Hyper Voice'], ['Toxic Boost', 'Earthquake'], ['Flare Boost', 'Flamethrower'], ['Solar Power', 'Flamethrower'], ['Defeatist', 'Earthquake'], ['Neuroforce', 'Flamethrower']];
  for (const [ab, mv] of AA) {
    mk('ability-atk', { move: mv }, (c) => { c.a.ability = ab; c.b.types = ['Normal']; if (ab === 'Guts' || ab === 'Toxic Boost') c.a.status = ab === 'Guts' ? 'brn' : 'psn'; if (ab === 'Flare Boost') c.a.status = 'brn'; if (ab === 'Neuroforce') c.b.types = ['Grass']; if (ab === 'Tinted Lens') c.b.types = ['Fire']; });
  }
  for (const [ab, mv, hpFrac] of [['Overgrow', 'Energy Ball', 3], ['Blaze', 'Flamethrower', 3], ['Torrent', 'Surf', 3], ['Swarm', 'Bug Buzz', 3], ['Blaze', 'Flamethrower', 1], ['Analytic', 'Earthquake', 1], ['Defeatist', 'Earthquake', 3]]) {
    mk('ability-pinch', { move: mv }, (c) => { c.a.ability = ab; c.a.hp = hpFrac === 3 ? 100 : 300; c.a.maxhp = 300; c.b.types = ['Normal']; });
  }
  const DA = [['Thick Fat', 'Flamethrower'], ['Thick Fat', 'Ice Beam'], ['Thick Fat', 'Earthquake'], ['Heatproof', 'Flamethrower'], ['Multiscale', 'Earthquake'], ['Solid Rock', 'Rock Slide'], ['Filter', 'Ice Beam'], ['Prism Armor', 'Ice Beam'], ['Fluffy', 'Body Slam'], ['Fluffy', 'Flamethrower'], ['Ice Scales', 'Ice Beam'], ['Ice Scales', 'Earthquake'],
    ['Fur Coat', 'Earthquake'], ['Marvel Scale', 'Earthquake'], ['Punk Rock', 'Hyper Voice'], ['Levitate', 'Earthquake'], ['Levitate', 'Rock Slide'], ['Wonder Guard', 'Earthquake'], ['Wonder Guard', 'Rock Slide'], ['Wonder Guard', 'Flamethrower'], ['Water Absorb', 'Surf'], ['Volt Absorb', 'Thunderbolt'],
    ['Flash Fire', 'Flamethrower'], ['Sap Sipper', 'Energy Ball'], ['Storm Drain', 'Surf'], ['Lightning Rod', 'Thunderbolt'], ['Motor Drive', 'Thunderbolt'], ['Dry Skin', 'Flamethrower'], ['Dry Skin', 'Surf'], ['Soundproof', 'Hyper Voice'], ['Bulletproof', 'Shadow Ball'], ['Unaware', 'Earthquake'], ['Purifying Salt', 'Shadow Ball'], ['Water Bubble', 'Flamethrower']];
  for (const [ab, mv] of DA) mk('ability-def', { move: mv, crit: 'never' }, (c) => { c.b.ability = ab; c.b.types = ['Normal']; if (ab === 'Wonder Guard') c.b.types = ['Ghost']; if (ab === 'Unaware') c.a.stages = { atk: 2 }; });
  mk('ability-def', { move: 'Earthquake', crit: 'never' }, (c) => { c.b.ability = 'Multiscale'; c.b.hp = 300; c.b.types = ['Normal']; });
  mk('ability-def', { move: 'Earthquake', crit: 'never' }, (c) => { c.b.ability = 'Marvel Scale'; c.b.status = 'par'; c.b.types = ['Normal']; });
  mk('ability-def', { move: 'Earthquake', crit: 'never' }, (c) => { c.b.ability = 'Solid Rock'; c.b.types = ['Flying']; c.a.types = ['Normal']; });
  // 7a. round 3: Orichalcum Pulse (x4/3 Attack in harsh sunlight), plus the Generalist attack-step fit (Tera Shell was tried and did not match: the text says every hit is not very effective at full HP, the real game showed none)
  mk('ability-atk', { move: 'Pound', weather: 'sun', crit: 'never' }, (c) => { c.a.ability = 'Orichalcum Pulse'; c.b.types = ['Normal']; });
  mk('ability-atk', { move: 'Flamethrower', weather: 'sun', crit: 'never' }, (c) => { c.a.ability = 'Orichalcum Pulse'; c.b.types = ['Normal']; });
  mk('ability-atk', { move: 'Pound', crit: 'never' }, (c) => { c.a.ability = 'Orichalcum Pulse'; c.b.types = ['Normal']; });
  // 7b. round 2: abilities added by FA2 round 2 (the ROM text + the probes of pokemonarena/ROMDIFF.md section 7)
  const AA2 = [['Transistor', 'Thunderbolt'], ['Windcaller', 'Air Slash'], ["Dragon's Maw", 'Dragon Claw'], ['Fire Mane', 'Flamethrower'], ['Steel Feet', 'Mega Kick'], ['Warrior Spirit', 'Close Combat'],
    ['Rocky Payload', 'Rock Slide'], ['Mind Force', 'Psychic'], ['Seabound', 'Surf'], ['Wind Force', 'Air Slash'], ['Hive Force', 'X-Scissor'], ['Verdant Soul', 'Energy Ball'], ['Earthbound', 'Earthquake'],
    ['Toxic Core', 'Sludge Bomb'], ['Generalist', 'Flamethrower'], ['Generalist', 'Pound'], ['Enigma', 'Power Gem'], ['Enigma', 'Superpower'], ['Enigma', 'Pound'], ['Flare', 'Flamethrower'], ['Last Stand', 'Pound'], ['Last Stand', 'Flamethrower'],
    ['Siegebreaker', 'Pound'], ['Siegebreaker', 'Flamethrower'], ['Elemental Fist', 'Fire Punch'], ['Elemental Fist', 'Pound'], ['Dragonize', 'Body Slam'], ['Terrate', 'Body Slam'], ['Psychate', 'Body Slam'], ['Flamilate', 'Body Slam'],
    ['Aquate', 'Body Slam'], ['Florate', 'Body Slam'], ['Acidic', 'Sludge Bomb'], ['Dark Aura', 'Dark Pulse'], ['Fairy Aura', 'Moonblast'], ['Malice Aura', 'Shadow Ball'], ['Aura Break', 'Dark Pulse'], ['Mega Sol', 'Flamethrower'], ['Mega Sol', 'Surf'],
    ["Mind's Eye", 'Pound'], ['Gorilla Tactics', 'Pound'], ['Gorilla Tactics', 'Flamethrower'], ['Hunter', 'Pound'], ['Omega', 'Pound'], ['Omega', 'Flamethrower'], ['Eelevate', 'Body Slam']];
  for (const [ab, mv] of AA2) {
    mk('ability-atk', { move: mv }, (c) => {
      c.a.ability = ab; c.b.types = ['Normal'];
      if (ab === 'Flare') c.b.status = 'brn';
      if (ab === 'Hunter') c.b.status = 'par';
      if (ab === 'Elemental Fist') { c.a.st.spa = 260; c.a.st.atk = 100; }
      if (ab === 'Siegebreaker') c.a.st.def = c.a.st.def + 40;
      if (ab === 'Omega') c.b.types = mv === 'Pound' ? ['Ghost'] : ['Water', 'Rock'];
      if (ab === "Mind's Eye") c.b.types = ['Ghost'];
      if (ab === 'Acidic') c.b.types = ['Steel'];
      if (ab === 'Malice Aura') c.b.types = ['Fairy'];
      if (['Dragonize', 'Terrate', 'Psychate', 'Flamilate', 'Aquate', 'Florate'].includes(ab) && (c.id % 2 === 0)) c.a.types = [{ Dragonize: 'Dragon', Terrate: 'Ground', Psychate: 'Psychic', Flamilate: 'Fire', Aquate: 'Water', Florate: 'Grass' }[ab]];
    });
  }
  const DA2 = [['Phalanx', 'Pound'], ['Phalanx', 'Flamethrower'], ['Spectral', 'Pound'], ['Spectral', 'Flamethrower'], ['Aura Guard', 'Body Slam'], ['Aura Guard', 'Flamethrower'], ['Guardian', 'Pound'], ['Guardian', 'Flamethrower'],
    ['Inversion', 'Flamethrower'], ['Inversion', 'Pound'], ['Omega', 'Flamethrower'], ['Omega', 'Pound'], ['Sandshield', 'Body Slam'], ['Sunhardened', 'Surf'], ['Smouldering', 'Surf'], ['Ritualist', 'Shadow Ball'], ['Wind Rider', 'Gust'],
    ['Wind Chime', 'Gust'], ['Eelevate', 'Earthquake'], ['Dark Aura', 'Dark Pulse'], ['Fairy Aura', 'Moonblast'], ['Thermal Exchange', 'Flamethrower']];
  for (const [ab, mv] of DA2) {
    mk('ability-def', { move: mv, crit: 'never' }, (c) => {
      c.b.ability = ab; c.b.types = ['Normal'];
      if (ab === 'Inversion') c.b.types = mv === 'Pound' ? ['Ghost'] : (c.id % 2 === 0 ? ['Water'] : ['Grass', 'Bug']);
      if (ab === 'Omega') c.b.types = mv === 'Pound' ? ['Ghost'] : (c.id % 2 === 0 ? ['Grass', 'Bug'] : ['Water', 'Rock']);
      if (ab === 'Sandshield') c.weather = 'sand';
      if (ab === 'Sunhardened') c.weather = 'sun';
      if (ab === 'Dark Aura' || ab === 'Fairy Aura') c.a.types = ['Normal'];
    });
  }
  // 8. held items (attacker)
  const AI = [['Choice Band', 'Earthquake'], ['Choice Band', 'Thunderbolt'], ['Choice Specs', 'Thunderbolt'], ['Choice Specs', 'Earthquake'], ['Life Orb', 'Earthquake'], ['Expert Belt', 'Flamethrower'], ['Charcoal', 'Flamethrower'], ['Mystic Water', 'Surf'], ['Flame Plate', 'Flamethrower'],
    ['Muscle Band', 'Earthquake'], ['Muscle Band', 'Thunderbolt'], ['Wise Glasses', 'Thunderbolt'], ['Wise Glasses', 'Earthquake'], ['Black Belt', 'Close Combat'], ['Silk Scarf', 'Body Slam'], ['Soft Sand', 'Earthquake'], ['Spell Tag', 'Shadow Ball'], ['Dragon Fang', 'Dragon Claw'], ['Twisted Spoon', 'Psychic'],
    ['Metal Coat', 'Iron Head'], ['Sharp Beak', 'Drill Peck'], ['Poison Barb', 'Sludge Bomb'], ['Never-Melt Ice', 'Ice Beam'], ['Miracle Seed', 'Energy Ball'], ['Magnet', 'Thunderbolt'], ['Hard Stone', 'Rock Slide'], ['Silver Powder', 'Bug Buzz'], ['Black Glasses', 'Dark Pulse'], ['Fairy Feather', 'Moonblast']];
  for (const [it, mv] of AI) mk('item-atk', { move: mv, crit: 'never' }, (c) => { c.a.item = it; c.b.types = ['Normal']; });
  const DI = [['Assault Vest', 'Thunderbolt'], ['Assault Vest', 'Earthquake'], ['Occa Berry', 'Flamethrower'], ['Passho Berry', 'Surf'], ['Yache Berry', 'Ice Beam'], ['Chople Berry', 'Close Combat'], ['Shuca Berry', 'Earthquake'], ['Wacan Berry', 'Thunderbolt'], ['Rindo Berry', 'Energy Ball']];
  for (const [it, mv] of DI) mk('item-def', { move: mv, crit: 'never' }, (c) => { c.b.item = it; c.b.types = it === 'Occa Berry' ? ['Grass'] : it === 'Passho Berry' ? ['Fire'] : it === 'Yache Berry' ? ['Dragon'] : it === 'Chople Berry' ? ['Steel'] : it === 'Shuca Berry' ? ['Fire'] : it === 'Wacan Berry' ? ['Water'] : it === 'Rindo Berry' ? ['Water'] : ['Normal']; });
  // 9. special-power / special-damage moves
  for (const [mv, over] of [['Low Kick', {}], ['Grass Knot', {}], ['Heavy Slam', {}], ['Gyro Ball', {}], ['Electro Ball', {}], ['Return', {}], ['Hidden Power', {}], ['Eruption', {}], ['Water Spout', {}], ['Flail', {}], ['Reversal', {}], ['Brine', {}], ['Acrobatics', {}], ['Assurance', {}], ['Payback', {}], ['Revenge', {}], ['Stored Power', {}], ['Punishment', {}], ['Foul Play', {}], ['Body Press', {}], ['Psyshock', {}], ['Psystrike', {}], ['Wring Out', {}], ['Crush Grip', {}], ['Venoshock', {}], ['Fell Stinger', {}], ['Freeze-Dry', {}], ['Weather Ball', {}]]) {
    for (const hpf of [1, 2, 6, 24]) {
      if (!['Eruption', 'Water Spout', 'Flail', 'Reversal', 'Brine', 'Wring Out', 'Crush Grip'].includes(mv) && hpf > 1) continue;
      mk('power-fn', { move: mv, crit: 'never', hpFrac: hpf }, (c) => {
        c.b.types = ['Normal'];
        if (['Eruption', 'Water Spout', 'Flail', 'Reversal'].includes(mv)) { c.a.maxhp = 192; c.a.hp = Math.max(1, Math.floor(192 / hpf)); }
        else if (['Brine', 'Wring Out', 'Crush Grip'].includes(mv)) { c.b.maxhp = 192; c.b.hp = Math.max(1, Math.floor(192 / hpf)); }
        if (mv === 'Gyro Ball') { c.a.st.spe = 40; c.b.st.spe = 200; } if (mv === 'Electro Ball') { c.a.st.spe = 200; c.b.st.spe = 50; }
        if (mv === 'Acrobatics') c.a.item = null; if (mv === 'Stored Power') c.a.stages = { atk: 1, spa: 2, def: 1 }; if (mv === 'Punishment') c.b.stages = { atk: 2, def: 1, spe: -1 };
        if (mv === 'Foul Play') c.a.st.atk = 40; if (mv === 'Body Press') { c.a.st.atk = 40; c.a.st.def = 210; }
        if (mv === 'Psyshock' || mv === 'Psystrike') { c.b.st.def = 60; c.b.st.spd = 190; }
        if (mv === 'Weather Ball') c.weather = 'rain'; if (mv === 'Freeze-Dry') c.b.types = ['Water', 'Flying'];
      });
    }
  }
  // 10. fixed-damage and fraction moves
  for (const mv of ['Seismic Toss', 'Night Shade', 'Dragon Rage', 'Sonic Boom', 'Super Fang', 'Endeavor']) mk('fixed', { move: mv, crit: 'never' }, (c) => { c.b.types = mv === 'Seismic Toss' ? ['Normal'] : ['Normal']; if (mv === 'Endeavor') { c.a.hp = 100; c.a.maxhp = 300; c.b.hp = 500; } });
  mk('fixed', { move: 'Night Shade', crit: 'never' }, (c) => { c.b.types = ['Normal']; c.level = 77; });
  mk('fixed', { move: 'Seismic Toss', crit: 'never' }, (c) => { c.b.types = ['Ghost']; });
  mk('fixed', { move: 'Dragon Rage', crit: 'never' }, (c) => { c.b.types = ['Fairy']; });
  // 11. multi-hit: per-hit damage (the real game's hit count is read from its own state)
  for (const mv of ['Bullet Seed', 'Rock Blast', 'Icicle Spear', 'Double Kick', 'Triple Kick', 'Fury Attack', 'Pin Missile', 'Water Shuriken', 'Dual Wingbeat', 'Triple Axel']) mk('multi', { move: mv, crit: 'never' }, (c) => { c.b.types = ['Normal']; });
  // 12. critical hits (forced by an always-crit move): STAB, abilities and screens interplay
  for (const [mv, ab] of [['Frost Breath', null], ['Storm Throw', null], ['Frost Breath', 'Sniper'], ['Wicked Blow', null], ['Surging Strikes', null], ['Frost Breath', 'Tinted Lens']]) mk('crit', { move: mv, crit: 'force' }, (c) => { c.a.ability = ab; c.b.types = ab === 'Tinted Lens' ? ['Fire'] : ['Normal']; c.a.types = ['Ice']; });
  mk('crit', { move: 'Frost Breath', crit: 'force' }, (c) => { c.a.status = null; c.b.ability = 'Multiscale'; c.b.types = ['Normal']; });
  mk('crit', { move: 'Storm Throw', crit: 'force' }, (c) => { c.a.status = 'brn'; c.b.types = ['Normal']; });
  mk('crit', { move: 'Frost Breath', crit: 'force' }, (c) => { c.b.ability = 'Battle Armor'; c.b.types = ['Normal']; });
  mk('crit', { move: 'Frost Breath', crit: 'force' }, (c) => { c.weather = 'sun'; c.b.types = ['Normal']; });
  // 13. misc: Struggle-like typeless, Pursuit-free moves with type-changing items
  mk('misc', { move: 'Judgment-free', crit: 'never' }, () => {});
  return out.filter((c) => c.move !== 'Judgment-free');
}

/** Innate-ability scenarios (FA2 round 2): every attacker / defender ability scenario of buildCombos() again, but with the ability held as an INNATE of a real
 *  species instead of as the main ability.  The live side puts that species into the battle record (the game then reads the innates from its own species table;
 *  record level 100 unlocks all three slots), the engine side gives the mon the species' innate ids.  A holder is chosen whose OTHER innates are all abilities the
 *  engine runs (or that cannot change a damage number), so a mismatch is the model's, not a missing ability. */
export function buildInnateCombos(pack, supportedAbilityIds) {
  const out = [];
  const byName = new Map(); pack.abilities.forEach((a) => { if (a && !byName.has(a.name)) byName.set(a.name, a.id); });
  const ARMED_AT_ENTRY = new Set(['Aura Shield', 'Disguise', 'Slow Start', 'Supersweet Syrup']);   // the real game arms these when the Pokemon switches in; a species swapped into a running battle is not armed
  const NEUTRAL = new Set(['Pressure', 'Keen Eye', 'Telepathy', 'Run Away', 'Inner Focus', 'Illuminate', 'Stench', 'Honey Gather', 'Pickup', 'Ball Fetch', 'Healer', 'Symbiosis', 'Minus', 'Plus', 'Friend Guard']);
  const nameOf = (id) => (pack.abilities[id] ? pack.abilities[id].name : '');
  const holderFor = (abName) => {
    const id = byName.get(abName); if (id === undefined) return null;
    let best = null;
    for (const sp of pack.species) {
      if (!sp || !sp.innates || sp.legal === false || !sp.innates.includes(id) || sp.abilities.includes(id)) continue;
      const others = sp.innates.filter((x) => x && x !== id);
      if (others.some((x) => ARMED_AT_ENTRY.has(nameOf(x)))) continue;
      if (!others.every((x) => supportedAbilityIds.has(x) || NEUTRAL.has(nameOf(x)))) continue;
      const score = others.length;
      if (!best || score < best.score) best = { sp, score };
    }
    return best ? best.sp : null;
  };
  let n = 5000;
  for (const c of buildCombos()) {
    if (c.group !== 'ability-atk' && c.group !== 'ability-pinch' && c.group !== 'ability-def') continue;
    const side = c.a.ability ? 'a' : 'b';
    const ab = c[side].ability; if (!ab) continue;
    const sp = holderFor(ab); if (!sp) continue;
    const d = JSON.parse(JSON.stringify(c));
    d.id = ++n; d.group = 'innate-' + (side === 'a' ? 'atk' : 'def'); d.level = 100; d.innateOf = ab;
    d[side].ability = null; d[side].holder = sp.id; d[side].innIds = sp.innates.filter((x) => x);
    out.push(d);
  }
  return out;
}

const STATUS = { brn: 3, psn: 2, par: 5, tox: 6, slp: 1, frz: 4, fbt: 7 };
const WEATHER = { rain: 1, sun: 2, sand: 3, hail: 4, snow: 5 };
const STAT_ST = (x) => ({ atk: x.st.atk, def: x.st.def, spa: x.st.spa, spd: x.st.spd, spe: x.st.spe });

/** Build the engine battle for a combo (side 0 = attacker, side 1 = defender). Returns { b, lab, mvId, missing[] }. */
/** Field names (the live harness vocabulary) -> engine spec keys: terrains, Gravity and Trick Room. */
export function fieldSpec(field) {
  const out = {};
  for (const k of [].concat(field || [])) {
    if (k === 'scorched') out.tn = [5, 5]; else if (k === 'grassy') out.tn = [1, 5]; else if (k === 'electric') out.tn = [2, 5]; else if (k === 'misty') out.tn = [3, 5]; else if (k === 'psychic') out.tn = [4, 5];
    else if (k === 'gravity') out.gv = 5; else if (k === 'trickroom') out.tr = 5;
  }
  return out;
}

export function engineBattle(M, pack, lab, T, combo) {
  const missing = [];
  const tid = (n) => { const k = n.toUpperCase(); if (!(k in T)) missing.push('type ' + n); return T[k]; };
  const D = lab.D;
  const sup = M.engine_support.engineSupport(pack);
  const has = (kind, name) => { const tbl = kind === 'ab' ? D.abilityByName : kind === 'it' ? D.itemByName : D.moveByName; if (name === null || name === undefined) return true; if (!(name in tbl)) { missing.push(kind + ' ' + name); return false; } const set = kind === 'ab' ? sup.abilities : kind === 'it' ? sup.items : sup.moves; if (!set.has(tbl[name])) { missing.push('not supported by the engine (excluded by the rules layer): ' + kind + ' ' + name); return false; } return true; };
  has('mv', combo.move); has('ab', combo.a.ability); has('ab', combo.b.ability); has('it', combo.a.item); has('it', combo.b.item);
  if (missing.length) return { missing };
  const side = (x, isB) => ({
    moves: isB ? ['Splash'] : [combo.move], level: combo.level, st: STAT_ST(x), ty: x.types.map(tid), ab: x.ability || 0, it: x.item || 0, inn: x.innIds,
    hp: x.hp !== undefined ? x.hp : (x.maxhp !== undefined ? x.maxhp : 600), mhp: x.maxhp !== undefined ? x.maxhp : 600,
    s: x.status ? STATUS[x.status] : undefined, sg: x.stages && Object.keys(x.stages).length ? { ...x.stages } : undefined, species: x.species,
    g: x.gender === 'F' ? 1 : x.gender === '-' ? 2 : undefined,
  });
  const spec = { a: side(combo.a, false), b: side(combo.b, true) };
  if (combo.weather === 'hrain') { spec.wx = [1, 16]; spec.pw = 6; } else if (combo.weather === 'hsun') { spec.wx = [2, 16]; spec.pw = 7; } else if (combo.weather === 'winds') { spec.wx = [0, 0]; spec.pw = 8; }
  else if (combo.weather) spec.wx = [WEATHER[combo.weather], 5];
  Object.assign(spec, fieldSpec(combo.field));
  if (combo.screens && combo.screens.length) {
    const sd = [null, {}];
    for (const s of combo.screens) sd[1][s === 'light' ? 'light' : s === 'veil' ? 'veil' : 'reflect'] = 5;
    spec.sd = sd;
  }
  const b = lab.lab(spec);
  return { b, mvId: D.moveByName[combo.move], missing };
}

/** What the engine says: { nc: [16 damages, roll 0..15, no crit], cr: [16, crit] } for one hit, taking the engine's own immunity checks
 *  (type, ability, airborne) and its crit-immunity into account: previewDamage() alone ignores them, the turn does not. */
export function engineExpect(M, pack, lab, T, combo) {
  const e = engineBattle(M, pack, lab, T, combo);
  if (e.missing && e.missing.length) return { unsupported: e.missing };
  const nc = [], cr = [];
  try {
    for (let r = 0; r < 16; r++) { nc.push(e.b.previewDamage(0, e.mvId, { roll: r, crit: false })); cr.push(e.b.previewDamage(0, e.mvId, { roll: r, crit: true })); }
  } catch (err) { return { unsupported: ['threw ' + String(err.message || err).slice(0, 100)] }; }
  // a real turn with favourable draws (accuracy always hits, no full paralysis / crit / thaw): if the target loses nothing the move is stopped (immunity, absorb ability, ...)
  let stopped = false, critImmune = false;
  try {
    const b2 = engineBattle(M, pack, lab, T, combo).b;
    const tgt = b2.s.sides[1].team[b2.s.sides[1].act];
    const hp0 = tgt.hp;
    b2.rand = (n) => (n === 100 ? 0 : Math.floor((n * 34000) / 65536));
    b2.drain();
    b2.choose(0, { kind: 'move', slot: 0 }); if (!b2.choose(1, { kind: 'move', slot: 0 }).ok) b2.choose(1, { kind: 'move', slot: 4 });
    const evs = b2.advance();
    const kind = M.engine_data.EFFECTS[pack.moves[e.mvId].effect].kind;
    // a charge move (Solar Beam without sun, Fly, Dig...) deals nothing in the FIRST turn and the real game's second turn is automatic: not an immunity
    // a hit is seen in the damage events, not in the hp: an end-of-turn heal (Grassy Terrain, Leftovers) can hide it
    const hurt = (evs || []).some((e) => e.t === 'damage' && e.s === 1 && e.to < e.from && e.src === 'move');
    stopped = !hurt && (nc[0] > 0 || cr[0] > 0) && !['twoturn', 'solarbeam', 'semiinvuln'].includes(kind);
    const sb = engineBattle(M, pack, lab, T, combo).b.scratch();
    const t2 = sb.act(1);
    const imm = sb.abFn(t2, 'critImmune', true);
    critImmune = !!(imm && imm(sb, t2));
  } catch (_err) { /* keep the preview */ }
  if (stopped) return { nc: nc.map(() => 0), cr: cr.map(() => 0), stopped: true };
  if (critImmune) return { nc, cr: nc.slice(), critImmune: true };
  return { nc, cr };
}

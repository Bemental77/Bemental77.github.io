// pokemonarena/js/engine_data.js -- constants, the MECHANICS table, the move-effect classification and per-move
// parameters for the first-party battle engine (engine.js). Pure ES module, no imports, no DOM, no clocks.
//
// WHAT IS IN HERE: hand-written code and small numeric constants only. Nothing is ROM *content* (no names of
// moves/species as data to display, no pixels, no text). Move/ability/item NAMES appear below only as KEYS that select
// engine behaviour; compileData(pack) resolves them against the decoded pack and reports any name it cannot find.
//
// HOW EVERY LINE OF BEHAVIOUR IS SOURCED (MECHANICS rows carry the label; ENGINE.md lists them):
//   'rom'        read from decoded ROM data at runtime: type chart, move type/category/power/accuracy/pp/priority/effect id/
//                additional-effect chance/flags/target, base stats, natures, ability and item tables.
//   'rom-static' a value the ROM's own code/data table holds, located by a static decode (nothing executed) and pinned by
//                tools/pokemonarena_engine_test.mjs against the ROM bytes: the stat-stage ratio table (0x7c72f4, 13 u8
//                pairs, referenced by 9 literal-pool words) and the stat formula (0x1ed920, decoded by stage C2).
//   'rom-live'   a value MEASURED in the real game: the ROM's own battle code was driven (stage FA2, tools/pokemonarena_rom_diff_live.mjs) with a
//                forced RNG and compared with the engine; the committed test repeats the comparison (pokemonarena/ROMDIFF.md).
//   'assumed'    NOT verified against this ROM; the pokeemerald-expansion default for the modern-generation behaviour this
//                hack uses. Every such row is repeated in ENGINE.md.
//
// MOVE EFFECT IDS. The ROM stores a numeric `effect` per move (321 distinct values) and up to 3 "additional" secondary
// effects. No name table is stored in the ROM. EFFECTS / ADDITIONAL below map those ids to engine classes; each entry
// lists ANCHOR moves (well-known moves whose behaviour fixes the meaning), and the test re-checks every anchor against the
// decoded pack, so a wrong mapping or a shifted table fails loudly. Ids not listed are UNSUPPORTED.

export const ENGINE_VERSION = 1;

/** The one error type the engine throws for bad input. `code` is a stable machine-readable name (e.g. 'snapshot-invalid',
 *  'pack-invalid', 'team-invalid', 'bad-argument'), `detail` carries the structured reason. Lives here so every engine module can use it. */
export class EngineError extends Error {
  constructor(message, detail, code) { super(message); this.name = 'EngineError'; this.detail = detail; this.code = code; }
}

// ---- ids the ROM uses (shifted +1 from vanilla; the test cross-checks these against pack.types) -------------------------
export const T = Object.freeze({
  NONE: 0, NORMAL: 1, FIGHTING: 2, FLYING: 3, POISON: 4, GROUND: 5, ROCK: 6, BUG: 7, GHOST: 8, STEEL: 9, MYSTERY: 10,
  FIRE: 11, WATER: 12, GRASS: 13, ELECTRIC: 14, PSYCHIC: 15, ICE: 16, DRAGON: 17, DARK: 18, FAIRY: 19, STELLAR: 20,
});
export const CAT = Object.freeze({ PHYSICAL: 0, SPECIAL: 1, STATUS: 2 });
// target codes (tables.js TARGET): 1 selected, 2 smart, 3 depends, 4 opponent, 5 random, 6 foes, 7 user, 8 ally, 9 userAndAllies,
// 10 userOrAlly, 11 foesAndAlly, 12 field, 13 opponentsField, 14 allBattlers
export const TGT = Object.freeze({ SELECTED: 1, DEPENDS: 3, RANDOM: 5, FOES: 6, USER: 7, ALLY: 8, FIELD: 12, FOE_FIELD: 13, ALL: 14, SPREAD: 11 });

// FBT = FROSTBITE, status1 bit 0x1000 in the game: MEASURED, every Ice move (and Tri Attack's third status) leaves 0x1000, never freeze 0x20; 1/16 residual, special damage of the holder halved, Ice types are immune
export const ST = Object.freeze({ NONE: 0, SLP: 1, PSN: 2, BRN: 3, FRZ: 4, PAR: 5, TOX: 6, FBT: 7 });
// terrains (round 3). Ids are the engine's own; the game's field bits are Grassy 0x40, Misty 0x80, Electric 0x100, Psychic 0x200 (found by diffing EWRAM across the four terrain moves)
// SCORCHED is the hack's own fifth terrain (a Scorched Field, field bit 0x1000): MEASURED to share the terrain slot, the 5-turn timer, Steel Roller / Ice Spinner / Defog clearing it and to be replaced by any other terrain
export const TN = Object.freeze({ NONE: 0, GRASSY: 1, ELECTRIC: 2, MISTY: 3, PSYCHIC: 4, SCORCHED: 5 });
export const TN_NAMES = Object.freeze(['', 'grassy', 'electric', 'misty', 'psychic', 'scorched']);
export const WX = Object.freeze({ NONE: 0, RAIN: 1, SUN: 2, SAND: 3, HAIL: 4, SNOW: 5 });
// primal weathers (round 3, MEASURED): the engine keeps them in S.pw (6 heavy rain, 7 harsh sun, 8 strong winds) on top of the plain weather they act as (rain / sun / none)
export const PW = Object.freeze({ RAIN: 6, SUN: 7, WINDS: 8 });
export const STAT_IDX = Object.freeze(['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva']);

// ---------------------------------------------------------------------------------------------
// MECHANICS: name, value, source, note.  `value` is JSON data; the engine reads the numbers it needs from E below
// (kept in sync by the test: every E key appears here).
// ---------------------------------------------------------------------------------------------
// Stat-stage ratio table, the ROM's own: 13 (numerator, denominator) u8 pairs for stages -6..+6 at file offset 0x7c72f4.
export const STAT_STAGE_RATIOS = Object.freeze([
  [10, 40], [10, 35], [10, 30], [10, 25], [10, 20], [10, 15], [10, 10], [15, 10], [20, 10], [25, 10], [30, 10], [35, 10], [40, 10],
]);
export const STAT_STAGE_RATIOS_ROM_OFFSET = 0x7c72f4;
// Accuracy / evasion stage multipliers in percent for the NET stage -6..+6 (accuracy stage minus evasion stage). The ROM has no data table for them (the
// ratio is built inside the accuracy routine); they were MEASURED by driving the ROM's own battle code with a forced RNG (stage FA2, pokemonarena/ROMDIFF.md):
// the effective accuracy of an accuracy-100 move at -6..-1 is 33 36 43 50 60 75, and for 60 (move, stage) points it equals floor(base * table / 100) exactly.
export const ACC_STAGE_PCT = Object.freeze([33, 36, 43, 50, 60, 75, 100, 133, 166, 200, 233, 266, 300]);

export const E = Object.freeze({
  levelMin: 1,
  turnCap: 300,
  // damage
  baseDamageDiv: 50,
  randomRollMin: 85, // damage factor (100 - rand(16)) percent: 85..100
  randomRollSpan: 16,
  critOdds: Object.freeze([24, 8, 2, 1]), // 1 in N per crit stage 0..3
  critMod: 6144, // x1.5 as UQ4.12
  stabMod: 6144, stabAdaptMod: 8192,
  weatherBoostMod: 6144, weatherCutMod: 2048,
  burnMod: 2048, frostbiteMod: 2048,
  screenMod: 2048,
  lifeOrbMod: 5325, expertBeltMod: 4915, typeBoostItemMod: 4915, choiceMod: 6144, muscleMod: 4505,
  // status
  sleepMin: 1, sleepSpan: 3, // turns = 1 + rand(3)
  thawChance: 5, // rand(5)==0 -> 20% thaw per turn
  paraFullChance: 4, // rand(4)==0 -> 25% fully paralysed
  paraSpeedNum: 1, paraSpeedDen: 2,
  burnDiv: 16, psnDiv: 8, toxDiv: 16, leechDiv: 8, trapDiv: 8, weatherDiv: 16,
  confMin: 2, confSpan: 4, // 2 + rand(4) = 2..5 turns
  confSelfHitPct: 33, // rand(100) < 33 -> exactly 33 percent (MEASURED in the real game: the game's draw hits itself iff (100*v)>>16 >= 67, i.e. 33 of 100 picks; 1/3 would be 33.33)
  confPower: 40,
  // field
  weatherTurns: 5, screenTurns: 5, tailwindTurns: 4, trickRoomTurns: 5, safeguardTurns: 5, extenderTurns: 8,
  trapMin: 4, trapSpan: 2, // 4 + rand(2) = 4..5 turns
  trapMax7: 7, // Grip Claw: the longest binding (assumed: the item text only says it extends binding moves)
  protectDen: 3, // success 1/3^n, capped at n=4 -> 1/81 (documented)
  pickMax: 4,
  // innate abilities: slot k (0..2 of the species record) is ACTIVE only when the battle level is at least innateLevels[k]
  // (MEASURED in the real game: the live battle record's level is compared, 74 -> inactive, 75 -> active; 84/85; 94/95; same for every species)
  innateLevels: Object.freeze([75, 85, 95]),
  // terrain / Gravity (MEASURED in the real game: 5 turns counting the turn it is set, one heal per turn for Grassy; a Terrain Extender makes the terrain last 8; Gravity 5)
  terrainTurns: 5, terrainExtTurns: 8, gravityTurns: 5, terrainBoostMod: 5325, terrainHalfMod: 2048, gravityAccMod: 6840, hadronMod: 5461, sportMod: 1352, ruinMod: 3072, scorchFireMod: 4506, scorchScaldMod: 4915, scorchWaterMod: 3686, ashAssetsMod: 4710,
});

export const MECHANICS = Object.freeze([
  m('typeChart', '21x21 UQ4.12 (pack.typeChart)', 'rom', 'decoded at 0x43b8b4; engine reads it through pack.typeChart, never a copy'),
  m('moveData', 'type, category, power, accuracy, pp, priority, effect id, additional effects (id, chance), flags, target, strikeCount, critStage', 'rom', 'decoded move table (tables.js)'),
  m('multiHitFlag', 'move.bytes[5] & 1 = 2-5 hits; & 2 = self-destruct', 'rom', 'raw move byte +0x15, correlated with the known multi-hit / explosion move sets by the test'),
  m('semiInvulnHitFlags', 'move.bytes[8] bits 3 (underground), 4 (underwater), 5/6 (airborne)', 'rom', 'raw move byte +0x18, correlated with Earthquake/Surf/Thunder/Gust families by the test'),
  m('baseStats / natures / species types', 'pack.species, pack.natures', 'rom', 'decoded'),
  m('statFormula', 'floor((2B+IV+floor(EV/4))*L/100)+5 (HP +L+10), nature 110/90', 'rom-static', 'ROM routine at 0x1ed920 decoded statically by stage C2; computed by rules.battleStats'),
  m('statStageRatios', STAT_STAGE_RATIOS, 'rom-static', 'u8 pairs at file offset 0x7c72f4, pinned against the ROM by the engine test'),
  m('accuracyStageRatio', ACC_STAGE_PCT, 'rom-live', 'MEASURED in the real game (FA2): effective accuracy = min(100, floor(base * ACC_STAGE_PCT[6 + s] / 100)) for the net stage s = accuracy stage minus evasion stage clamped to -6..+6; 60 of 60 (move, stage) probes equal it (a 3/(3+s) formula differs at -5 and -4 and in the floor at +1)'),
  m('critOdds', E.critOdds, 'rom-static', 'DECODED: four adjacent u32[5] ROM tables 0x476b7c Gen7 {24,8,2,1,1}, 0x476b90 Gen6 {16,8,2,1,1}, 0x476ba4 Gen2 {17,32,64,85,128}, 0x476bb8 Gen3 {16,8,4,3,2}, reached through the base pointer 0x08476b3c (+64/+84/+104/+124) by the Thumb routines at 0xe7a7c and 0xed530; the table is chosen by config byte [0x64b40c] (>5 Gen7, 5 Gen6, 1 Gen2, else Gen3) and that byte is 8, so the Gen7 table is the one the ROM uses; stage 4 equals stage 3. Inferred, not decoded: that config id 0 is the crit-chance one. Pinned by the engine test'),
  m('critMultiplier', '1.5x (UQ4.12 6144)', 'rom-live', 'modern default; MEASURED (FA2): every always-crit move and every forced-crit combo in the damage differential equals the engine with 1.5x, roll for roll'),
  m('damageFormula', 'floor(floor(floor(2L/5+2)*BP*A/D)/50)+2, then weather, crit, roll, STAB (each a pokeMod: UQ4.12, round half down), then the type chart (the defender types multiplied into ONE UQ4.12 number and applied once, half-down), then burn, then the chained final modifiers (screens, Life Orb, Expert Belt, Multiscale, ...) applied once', 'rom-live', 'expansion Gen 5+ order; base-power modifiers (Technician, pinch abilities Overgrow/Blaze/Torrent/Swarm, Muscle Band, ...) are chained and applied to the MOVE POWER before the formula, attacking-stat modifiers (Huge Power, Choice Band, ...) to the stat; MEASURED (FA2): 470 scenarios x 16 rolls equal the real game exactly (type chart combined for dual types, STAB, weather, crit, burn, screens, abilities, items); see pokemonarena/ROMDIFF.md'),
  m('randomRoll', '85..100 percent, 16 values (100 - rand(16))', 'rom-live', 'MEASURED (FA2): the game draws RandomUniform(0,15), roll index r gives (100 - r) percent; all 16 rolls compared'),
  m('stab', '1.5x; Adaptability 2x', 'rom-live', 'MEASURED (FA2): 1.5x and Adaptability 2x equal the real game on the damage differential'),
  m('burn', 'halves physical damage (not with Guts/Facade); residual 1/16 max HP', 'rom-live', 'Gen 7+ residual; MEASURED (FA2): physical damage halved (Guts and Facade excepted) and the 1/16 residual equal the real game'),
  m('paralysis', 'speed x0.5; 25% chance to be fully paralysed', 'rom-live', 'Gen 7+ speed drop; MEASURED (FA2): the speed halving decides the same turn orders as the real game (paralysis order cases), and the full-paralysis chance is exactly 25 percent (draw below 16384 of 65536)'),
  m('sleep', '1-3 turns; counter decrements on each move attempt', 'assumed', 'Gen 5+'),
  m('freeze', '20% thaw chance per move attempt; a frozen USER is thawed by its own Flame Wheel-type move; a frozen TARGET is thawed by any damaging Fire-type hit (and Scald, Steam Eruption, Scorching Sands) that a Substitute does not absorb; Ice types and harsh sunlight cannot be frozen; no frostbite', 'assumed', 'frostbite is an expansion option, assumed off'),
  m('poison / toxic', '1/8 max HP; toxic n/16 max HP with n counting up', 'rom-live', 'MEASURED (FA2): poison 1/8; toxic = floor(max/16) * counter (divide FIRST, then multiply), counter 1 on the first tick; equal over 5 turns at max HP 411'),
  m('confusion', '2-5 turns; 33 percent self-hit (rand(100) < 33); 40 power typeless physical', 'rom-live', 'MEASURED in the real game (FA2): duration counter 2,3,4,5 in equal quarters of the draw (engine 2 + rand(4)); self-hit exactly 33 of 100 picks; the 40-power typeless damage matches the damage differential'),
  m('flinch', 'only if the target has not moved yet this turn; cleared at end of turn', 'assumed', ''),
  m('weather', 'Rain/Sun x1.5/x0.5 for Water/Fire; 5 turns (8 with the matching rock); Sand and Hail 1/16 residual; Snow raises Ice Defense x1.5', 'rom-live', 'Snowscape is present in the ROM move table; engine models Snow as Gen 9; MEASURED (FA2): 1.5x / 0.5x, five turns INCLUDING the turn it is set: damage on turns 1-4 and it ends WITHOUT damage on turn 5 (eight turns with the rock: 7 ticks); sand / hail chip 1/16; Rain Dish, Dry Skin, Ice Body, Solar Power order'),
  m('screens', 'Reflect/Light Screen/Aurora Veil x0.5 in singles, 5 turns (8 with Light Clay), ignored by crits', 'rom-live', 'MEASURED (FA2): 0.5x in singles, ignored by crits, five turns (expires on the fifth end of turn)'),
  m('innateAbilities', 'three innate ability slots per species (ROM species record +0x20/+0x22/+0x24); slot k works from level 75/85/95; only the parts of an ability that the game checks for innates work (engine_abilities.js INNATE_LIVE); switch-in effects run in one fixed order (SWITCH_IN_ORDER); the same ability from two sources counts once', 'rom-live', 'MEASURED in the real game (FA2 round 2, pokemonarena/ROMDIFF.md section 7): the level gate (74/75, 84/85, 94/95 on three species), per-ability liveness (Thick Fat, Unaware, Adaptability, Overcoat, Magic Guard, Poison Heal work; Technician, Huge Power, Levitate, absorbers, status immunities do NOT), stacking (main + innate Thick Fat = one halving) and the switch-in order (21 observed pairs)'),
  m('hazards', 'Spikes 1/8,1/6,1/4; Toxic Spikes 1 psn/2 tox; Stealth Rock 1/8 x type effectiveness; Sticky Web speed -1', 'assumed', ''),
  m('protect', 'success chance 1/3 per consecutive use, 1/81 cap, resets after any other move', 'assumed', ''),
  m('trapping', '4-5 turns, 1/8 max HP per turn', 'assumed', 'Gen 6+ value'),
  m('leechSeed', '1/8 max HP drained each turn', 'assumed', ''),
  m('recoilDrain', 'recoil/drain percentages are the move record argument byte (+0x24)', 'rom', 'read by the test from the ROM and compared with MOVE_ARGS; the engine uses the hand-written MOVE_ARGS copy'),
  m('itemHoldEffects', 'item -> behaviour is keyed by the item record hold-effect id and param byte (pack.items[].holdEffect / holdEffectParam)', 'rom', 'decoded; the test anchors the ids to named items (e.g. 41 Leftovers, 60 Life Orb, 29 Choice Band)'),
  m('itemModifiers', 'Life Orb 5325/4096 (measured: 5324 was off by one) with 10% recoil; Expert Belt 4915; Choice 6144; type items and plates 4915; Muscle Band and Wise Glasses 4505; Eviolite and Assault Vest 6144; Sitrus heals 1/4, Oran 10 HP, pinch berries 1/3; resist berries halve once; Rocky Helmet 1/6; Leftovers 1/16; Black Sludge 1/16 or 1/8', 'assumed', 'the numeric effect of each hold effect is the expansion default, not read from the ROM'),
  m('abilityModifiers', 'Technician 1.5x up to 60 BP; Iron Fist and Reckless 1.2x; Sheer Force 1.3x and removes secondaries; Huge Power 2x; Guts and Hustle 1.5x; -ate abilities 1.2x; Multiscale 0.5x; Solid Rock 0.75x; Thick Fat 0.5x; absorb abilities heal 1/4; contact abilities 30%; Rough Skin 1/8; weather speed 2x', 'assumed', 'ability behaviour is not in the ROM tables (names and text only); the numbers are the expansion defaults'),
  m('speedTie', 'one rand(2) call', 'assumed', 'engine rule'),
  m('rng', '32-bit LCG s = s*0x41C64E6D + 0x6073, output s>>>16, rand(n) = output % n', 'assumed', 'engine-internal (the GBA family LCG); not the hack\'s own RNG'),
  m('turnCap', E.turnCap, 'assumed', 'engine rule: a battle is drawn after this many turns so every battle terminates'),
  m('selfDestruct', 'Explosion and Self-Destruct (raw move byte +0x15 bit 1) faint the user once the move is USED, whether it hits, misses, hits a Ghost, is Protected or finds a semi-invulnerable target; only Damp (a fail before the move starts) stops it', 'assumed', 'Gen 3+ behaviour'),
  m('invulnerableDoubling', 'Earthquake/Magnitude vs Dig, Surf/Whirlpool vs Dive, Gust/Twister vs Fly/Bounce deal x2; Stomp-family moves vs a Minimized target deal x2 and never miss', 'assumed', 'Gen 6+ behaviour; the hit flags that let the move connect are read from the ROM (semiInvulnHitFlags), the doubling is keyed by move name'),
  m('toxicAccuracy', 'Toxic used by a Poison-type never misses; Sheer Cold used by a non-Ice-type has base accuracy 20 + level difference instead of 30 + level difference', 'assumed', 'Gen 6+ / Gen 7+ behaviour'),
  m('trapImmunity', 'Ghost types cannot be trapped by Mean Look-style moves, trapping moves or the abilities Shadow Tag / Arena Trap / Magnet Pull; a Shed Shell frees any holder', 'assumed', 'Gen 6+ behaviour'),
  m('pranksterVsDark', 'a status move whose priority was raised by Prankster fails against a Dark-type target', 'assumed', 'Gen 7+ behaviour'),
  m('faintClearsStatus', 'a fainted Pokemon has no major status', 'assumed', ''),
  m('previewPower', 'previewDamage() uses the expected power of the random-power moves (Present 65 given that it damages, Magnitude 71) and the user level for Psywave; the preview never draws from the RNG, never writes an event and never changes the battle', 'assumed', 'engine rule'),
]);
function m(name, value, source, note) { return Object.freeze({ name, value, source, note }); }

// ---------------------------------------------------------------------------------------------
// Secondary ("additional") effect ids -> engine semantics.  Anchors are well-known moves.
// ---------------------------------------------------------------------------------------------
const STAT_FIELDS = (o) => Object.freeze(o);
export const ADDITIONAL = Object.freeze({
  1: { k: 'status', s: ST.SLP, anchors: ['Relic Song'] },
  2: { k: 'status', s: ST.PSN, anchors: ['Poison Sting', 'Sludge Bomb'] },
  3: { k: 'status', s: ST.BRN, anchors: ['Fire Punch', 'Flamethrower'] },
  5: { k: 'status', s: ST.PAR, anchors: ['Thunder Punch', 'Thunderbolt', 'Body Slam'] },
  6: { k: 'status', s: ST.TOX, anchors: ['Poison Fang'] },
  7: { k: 'status', s: ST.FBT, anchors: ['Ice Punch', 'Ice Beam'] },   // the hack's Ice moves give FROSTBITE where the games give freeze (MEASURED: status1 0x1000)
  8: { k: 'confuse', anchors: ['Psybeam', 'Confusion'] },
  9: { k: 'flinch', anchors: ['Bite', 'Headbutt', 'Stomp'] },
  10: { k: 'tri', anchors: ['Tri Attack'] },
  12: { k: 'noop', anchors: ['Pay Day'] },
  13: { k: 'trap', anchors: ['Bind', 'Wrap', 'Fire Spin', 'Whirlpool'] },
  21: { k: 'stat', foe: STAT_FIELDS({ atk: -1 }), anchors: ['Aurora Beam', 'Play Rough'] },
  22: { k: 'stat', foe: STAT_FIELDS({ def: -1 }), anchors: ['Iron Tail', 'Crunch', 'Rock Smash'] },
  23: { k: 'stat', foe: STAT_FIELDS({ spe: -1 }), anchors: ['Bubble Beam', 'Icy Wind', 'Mud Shot'] },
  24: { k: 'stat', foe: STAT_FIELDS({ spa: -1 }), anchors: ['Mist Ball', 'Snarl', 'Moonblast'] },
  25: { k: 'stat', foe: STAT_FIELDS({ spd: -1 }), anchors: ['Psychic', 'Shadow Ball', 'Energy Ball', 'Focus Blast'] },
  26: { k: 'stat', foe: STAT_FIELDS({ acc: -1 }), anchors: ['Mud-Slap', 'Octazooka', 'Mirror Shot'] },
  31: { k: 'noescape', anchors: ['Spirit Shackle', 'Anchor Shot', 'Thousand Waves'] },
  35: { k: 'noop', anchors: ['Smelling Salts', 'Wake-Up Slap'] }, // the cure itself lives in the condpower kind
  48: { k: 'stat', foe: STAT_FIELDS({ spd: -2 }), anchors: ['Seed Flare', 'Acid Spray'] },
  54: { k: 'clearsmog', anchors: ['Clear Smog'] },
  56: { k: 'breakprotect', anchors: ['Feint'] },
  65: { k: 'noop', anchors: ['Round'] }, // doubles only: the power doubling when an ally also uses Round
  66: { k: 'direclaw', anchors: ['Dire Claw'] },
  327: { k: 'noop', anchors: ['Tera Blast'] }, // the Terastal type change is not modelled: Tera Blast is its Normal-type form
  4481: { k: 'noop', anchors: ['Beat Up'] }, // the per-hit power lives in the beatup kind
  69: { k: 'status', s: ST.PAR, anchors: ['Secret Power'] },
  // round 3 batch C: the secondary effects of the hack's newer moves (each probed in the real game first)
  30: { k: 'rage', self: true, anchors: ['Rage'] }, 55: { k: 'noop', anchors: ['Flame Burst'] }, 61: { k: 'incinerate', anchors: ['Incinerate'] }, 2083: { k: 'curebrn', anchors: ['Sparkling Aria'] },
  60: { k: 'throatchop', anchors: ['Throat Chop'] }, 59: { k: 'coreenforcer', anchors: ['Core Enforcer'] }, 4224: { k: 'spectral', pre: true, anchors: ['Spectral Thief'] },
  73: { k: 'plasma', self: true, anchors: ['Plasma Fists'] }, 2057: { k: 'flinch', anchors: ['Floaty Fall'] }, 77: { k: 'wall', self: true, screen: 'light', anchors: ['Glitzy Glow'] },
  76: { k: 'wall', self: true, screen: 'reflect', anchors: ['Baddy Bad'] }, 75: { k: 'leechseed', anchors: ['Sappy Seed'] }, 74: { k: 'hazeall', self: true, anchors: ['Freezy Frost'] },
  119: { k: 'aroma', self: true, anchors: ['Sparkly Swirl'] }, 64: { k: 'jawlock', anchors: ['Jaw Lock'] }, 51: { k: 'scaleshot', self: true, anchors: ['Scale Shot'] },
  515: { k: 'raisedburn', anchors: ['Burning Jealousy'] }, 520: { k: 'raisedconf', anchors: ['Alluring Voice'] }, 79: { k: 'ppcut', anchors: ['Eerie Spell'] }, 328: { k: 'noop', anchors: ['Order Up'] },
  289: { k: 'glaive', self: true, anchors: ['Glaive Rush'] }, 78: { k: 'saltcure', anchors: ['Salt Cure'] }, 67: { k: 'syrup', anchors: ['Syrup Bomb'] }, 70: { k: 'hbtwo', anchors: ['Psychic Noise'] },
  97: { k: 'noop', anchors: ['Genesis Supernova'] },
  3345: { k: 'noop', anchors: ['Electro Shot'] }, 2048: { k: 'noop', anchors: ['Stone Axe', 'Ceaseless Edge'] },   // the hazard lives in the hazardhit kind   // the charge turn lives in the twoturn kind
  267: { k: 'uproar', self: true, anchors: ['Uproar'] }, 62: { k: 'pluck', anchors: ['Pluck', 'Bug Bite'] },   // the terrain is set BEFORE the hit and the power is 150 (MEASURED), see runDamage
  1295: { k: 'noop', anchors: ['Skull Bash'] }, // the Defense boost lives in the twoturn kind
  1297: { k: 'noop', anchors: ['Meteor Beam'] }, // the Sp. Atk boost lives in the twoturn kind
  270: { k: 'stat', self: STAT_FIELDS({ atk: 1 }), anchors: ['Metal Claw', 'Power-Up Punch'] },
  271: { k: 'stat', self: STAT_FIELDS({ def: 1 }), anchors: ['Steel Wing', 'Psyshield Bash'] },
  272: { k: 'stat', self: STAT_FIELDS({ spe: 1 }), anchors: ['Flame Charge', 'Esper Wing'] },
  273: { k: 'stat', self: STAT_FIELDS({ spa: 1 }), anchors: ['Charge Beam', 'Torch Song'] },
  278: { k: 'stat', self: STAT_FIELDS({ def: -1 }), anchors: ['Clanging Scales'] },
  279: { k: 'stat', self: STAT_FIELDS({ spe: -1 }), anchors: ['Hammer Arm', 'Ice Hammer'] },
  280: { k: 'stat', self: STAT_FIELDS({ spa: -1 }), anchors: ['Make It Rain'] },
  285: { k: 'recharge', anchors: ['Hyper Beam', 'Giga Impact', 'Frenzy Plant'] },
  290: { k: 'stat', self: STAT_FIELDS({ atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }), anchors: ['Ancient Power', 'Silver Wind'] },
  292: { k: 'stat', self: STAT_FIELDS({ atk: -1, def: -1 }), anchors: ['Superpower'] },
  294: { k: 'stat', self: STAT_FIELDS({ def: 2 }), anchors: ['Diamond Storm'] },
  302: { k: 'stat', self: STAT_FIELDS({ spe: -2 }), anchors: ['Spin Out'] },
  303: { k: 'stat', self: STAT_FIELDS({ spa: -2 }), anchors: ['Overheat', 'Draco Meteor', 'Leaf Storm'] },
  308: { k: 'rampage', anchors: ['Outrage', 'Thrash', 'Petal Dance'] },
  309: { k: 'stat', self: STAT_FIELDS({ def: -1, spd: -1 }), anchors: ['Close Combat', 'Dragon Ascent'] },
  313: { k: 'stat', self: STAT_FIELDS({ def: -1, spd: -1, spe: -1 }), anchors: ['V-create'] },
  284: { k: 'noop', anchors: ['Burn Up', 'Double Shock'] }, // the type loss lives in the burnup kind
  319: { k: 'struggle', anchors: ['Struggle'] },
  4223: { k: 'screenbreak', anchors: ['Brick Break', 'Psychic Fangs'] },
});

// ---------------------------------------------------------------------------------------------
// Primary effect ids -> engine class.  `kind` is looked up in engine_moves.js MOVE_KINDS.
// ---------------------------------------------------------------------------------------------
export const EFFECTS = {};
function def(ids, kind, extra, anchors) {
  for (const id of [].concat(ids)) EFFECTS[id] = Object.freeze({ id, kind, ...(extra || {}), anchors: anchors || [] });
}
const S = STAT_FIELDS;
// -- plain damage
def(1, 'hit', null, ['Pound', 'Flamethrower']);
def(331, 'hit', null, ['Water Shuriken']);
def(111, 'hit', null, ['Earthquake', 'Bulldoze']);
def(3, 'drain', null, ['Absorb', 'Giga Drain', 'Draining Kiss']);
def(5, 'dreameater', null, ['Dream Eater']);
def(324, 'recoil', null, ['Double-Edge', 'Flare Blitz', 'Head Smash']);
def(34, 'crash', null, ['Jump Kick', 'High Jump Kick']);
def(277, 'struggle', null, ['Struggle']);
def(293, 'mindblown', null, ['Mind Blown', 'Steel Beam']);
def(264, 'burnup', null, ['Burn Up', 'Double Shock']);
def(64, 'leveldamage', null, ['Seismic Toss', 'Night Shade']);
def(65, 'psywave', null, ['Psywave']);
def(32, 'fixeddamage', null, ['Sonic Boom', 'Dragon Rage']);
def(31, 'fractiondamage', null, ['Super Fang']);
def(29, 'ohko', null, ['Fissure', 'Sheer Cold']);
def(147, 'endeavor', null, ['Endeavor']);
def(234, 'finalgambit', null, ['Final Gambit']);
def(66, 'counter', null, ['Counter', 'Mirror Coat', 'Metal Burst']);
def(75, 'flail', null, ['Flail', 'Reversal']);
def(95, 'return', null, ['Return']);
def(96, 'present', null, ['Present']);
def(99, 'magnitude', null, ['Magnitude']);
def(106, 'hiddenpower', null, ['Hidden Power']);
def(128, 'facade', null, ['Facade']);
def(130, 'condpower', null, ['Hex', 'Venoshock', 'Smelling Salts']);
def(143, 'revenge', null, ['Revenge', 'Avalanche']);
def(148, 'eruption', null, ['Eruption', 'Water Spout']);
def(154, 'lowkick', null, ['Low Kick', 'Grass Knot']);
def(168, 'wringout', null, ['Wring Out', 'Crush Grip']);
def(169, 'assurance', null, ['Assurance']);
def(171, 'acrobatics', null, ['Acrobatics']);
def(172, 'heavyslam', null, ['Heavy Slam', 'Heat Crash']);
def(173, 'punishment', null, ['Punishment']);
def(174, 'storedpower', null, ['Stored Power', 'Power Trip']);
def(175, 'electroball', null, ['Electro Ball']);
def(176, 'gyroball', null, ['Gyro Ball']);
def(177, 'echoedvoice', null, ['Echoed Voice']);
def(178, 'payback', null, ['Payback']);
def(180, 'brine', null, ['Brine']);
def(182, 'foulplay', null, ['Foul Play']);
def(183, 'psyshock', null, ['Psyshock', 'Psystrike', 'Secret Sword']);
def(205, 'suckerpunch', null, ['Sucker Punch']);
def(218, 'flyingpress', null, ['Flying Press']);
def(257, 'stomptantrum', null, ['Stomping Tantrum']);
def(269, 'bodypress', null, ['Body Press']);
def(272, 'lashout', null, ['Lash Out']);
def(289, 'boltbeak', null, ['Bolt Beak', 'Fishious Rend']);
def(303, 'collision', null, ['Collision Course', 'Electro Drift']);
def(309, 'ragefist', null, ['Rage Fist']);
def(317, 'lastrespects', null, ['Last Respects']);
def(79, 'triplekick', null, ['Triple Kick', 'Triple Axel']);
def(108, 'fellstinger', null, ['Fell Stinger']);
def(145, 'knockoff', null, ['Knock Off']);
def(146, 'thief', null, ['Thief', 'Covet']);
def(155, 'uturn', null, ['U-turn', 'Volt Switch', 'Flip Turn']);
def(233, 'dragontail', null, ['Dragon Tail', 'Circle Throw']);
def(69, 'snore', null, ['Snore']);
def(77, 'falseswipe', null, ['False Swipe']);
def(93, 'furycutter', null, ['Fury Cutter']);
def(119, 'firstturn', null, ['Fake Out', 'First Impression']);
def(129, 'focuspunch', null, ['Focus Punch']);
def(157, 'weatherball', null, ['Weather Ball']);
def(210, 'freezedry', null, ['Freeze-Dry']);
def(248, 'revelation', null, ['Revelation Dance']);
def(239, 'hit', null, ['Pollen Puff']);
def(323, 'rapidspin', null, ['Rapid Spin']);
def(54, 'twoturn', null, ['Razor Wind', 'Sky Attack', 'Skull Bash']);
def(113, 'solarbeam', null, ['Solar Beam', 'Solar Blade']);
def(116, 'semiinvuln', null, ['Fly', 'Dig', 'Dive', 'Bounce']);
def(101, 'pursuit', null, ['Pursuit']);
// -- pure stat moves (self / foe fields)
def(7, 'stats', { self: S({ atk: 1 }) }, ['Meditate', 'Sharpen']);
def(8, 'stats', { self: S({ def: 1 }) }, ['Harden', 'Withdraw']);
def(117, 'stats', { self: S({ def: 1 }) }, ['Defense Curl']);
def(13, 'stats', { self: S({ eva: 1 }) }, ['Double Team']);
def(82, 'stats', { self: S({ eva: 2 }) }, ['Minimize']);
def(14, 'stats', { self: S({ spa: 3 }) }, ['Tail Glow']);
def(15, 'stats', { foe: S({ atk: -1 }) }, ['Growl', 'Play Nice']);
def(16, 'stats', { foe: S({ def: -1 }) }, ['Tail Whip', 'Leer']);
def(18, 'stats', { foe: S({ spa: -1 }) }, ['Confide']);
def(20, 'stats', { foe: S({ acc: -1 }) }, ['Sand Attack', 'Smokescreen']);
def(38, 'stats', { self: S({ atk: 2 }) }, ['Swords Dance']);
def(39, 'stats', { self: S({ def: 2 }) }, ['Barrier', 'Acid Armor', 'Iron Defense']);
def(40, 'stats', { self: S({ spe: 2 }) }, ['Agility', 'Rock Polish']);
def(41, 'stats', { self: S({ spa: 2 }) }, ['Nasty Plot']);
def(42, 'stats', { self: S({ spd: 2 }) }, ['Amnesia']);
def(46, 'stats', { foe: S({ atk: -2 }) }, ['Charm', 'Feather Dance']);
def(47, 'stats', { foe: S({ def: -2 }) }, ['Screech']);
def(48, 'stats', { foe: S({ spe: -2 }) }, ['String Shot', 'Scary Face']);
def(49, 'stats', { foe: S({ spa: -2 }) }, ['Eerie Impulse']);
def(50, 'stats', { foe: S({ spd: -2 }) }, ['Fake Tears', 'Metal Sound']);
def(52, 'stats', { foe: S({ eva: -2 }) }, ['Sweet Scent']);
def(158, 'stats', { foe: S({ atk: -1, def: -1 }) }, ['Tickle']);
def(159, 'stats', { self: S({ def: 1, spd: 1 }) }, ['Cosmic Power', 'Defend Order']);
def(160, 'stats', { self: S({ atk: 1, def: 1 }) }, ['Bulk Up']);
def(162, 'stats', { self: S({ spa: 1, spd: 1 }) }, ['Calm Mind']);
def(163, 'stats', { self: S({ atk: 1, spe: 1 }) }, ['Dragon Dance']);
def(216, 'stats', { self: S({ atk: 1, acc: 1 }) }, ['Hone Claws']);
def(217, 'stats', { self: S({ atk: 1, spa: 1 }) }, ['Work Up']);
def(220, 'stats', { self: S({ spa: 1, spd: 1, spe: 1 }) }, ['Quiver Dance']);
def(221, 'stats', { self: S({ atk: 1, def: 1, acc: 1 }) }, ['Coil']);
def(225, 'growth', null, ['Growth']);
def(227, 'stats', { self: S({ atk: 2, spa: 2, spe: 2, def: -1, spd: -1 }) }, ['Shell Smash']);
def(228, 'stats', { self: S({ atk: 1, spe: 2 }) }, ['Shift Gear']);
def(229, 'stats', { self: S({ def: 3 }) }, ['Cotton Guard']);
def(230, 'stats', { foe: S({ atk: -1, spa: -1 }) }, ['Noble Roar']);
def(236, 'stats', { self: S({ spe: 2 }) }, ['Autotomize']);
def(109, 'bellydrum', null, ['Belly Drum']);
def(262, 'strengthsap', null, ['Strength Sap']);
def(297, 'stats', { self: S({ atk: 1, def: 1, spe: 1 }) }, ['Victory Dance']);
def(285, 'stats', { foe: S({ spe: -1 }) }, ['Tar Shot']);
def(319, 'stats', { foe: S({ atk: 2, def: -2 }) }, ['Spicy Extract']);
def(302, 'takeheart', null, ['Take Heart']); def(288, 'clangorous', null, ['Clangorous Soul']); def(311, 'filletaway', null, ['Fillet Away']); def(284, 'noretreat', null, ['No Retreat']);
def(133, 'charge', null, ['Charge']); def(251, 'acupressure', null, ['Acupressure']); def(231, 'venomdrench', null, ['Venom Drench']); def(211, 'topsy', null, ['Topsy-Turvy']);
def(198, 'powerswap', null, ['Power Swap']); def(199, 'guardswap', null, ['Guard Swap']); def(200, 'heartswap', null, ['Heart Swap']); def(110, 'psychup', null, ['Psych Up']);
def(121, 'stockpile', null, ['Stockpile']); def(122, 'spitup', null, ['Spit Up']); def(123, 'swallow', null, ['Swallow']); def(81, 'nightmare', null, ['Nightmare']); def(204, 'luckychant', null, ['Lucky Chant']);
def(115, 'beatup', null, ['Beat Up']); def(97, 'frustration', null, ['Frustration']); def(179, 'hit', null, ['Round']); def(181, 'retaliate', null, ['Retaliate']); def(240, 'synchro', null, ['Synchronoise']);
def(235, 'typeofitem', null, ['Judgment', 'Techno Blast', 'Multi-Attack']); def(91, 'rollout', null, ['Rollout', 'Ice Ball']); def(300, 'hydrosteam', null, ['Hydro Steam']);
def(282, 'photon', null, ['Photon Geyser', 'Light That Burns the Sky']); def(320, 'photon', null, ['Tera Blast']); def(327, 'terrainbreak', null, ['Ice Spinner', 'Splintered Stormshards']);
def(124, 'abilityset', null, ['Worry Seed', 'Simple Beam']); def(137, 'roleplay', null, ['Role Play']); def(149, 'skillswap', null, ['Skill Swap']); def(142, 'recycle', null, ['Recycle']);
def(170, 'trumpcard', null, ['Trump Card']); def(241, 'psychoshift', null, ['Psycho Shift']); def(207, 'healtarget', null, ['Heal Pulse', 'Floral Healing']); def(270, 'selfhealcure', null, ['Jungle Healing', 'Lunar Blessing']);
def(318, 'tidyup', null, ['Tidy Up']); def(306, 'chilly', null, ['Chilly Reception']); def(222, 'electrify', null, ['Electrify']); def(141, 'magiccoat', null, ['Magic Coat']); def(153, 'snatch', null, ['Snatch']);
def(56, 'mimic', null, ['Mimic']); def(6, 'mirrormove', null, ['Mirror Move']); def(132, 'naturepower', null, ['Nature Power']);
// -- status-inflicting
def(2, 'status', null, ['Toxic', 'Thunder Wave', 'Will-O-Wisp', 'Spore', 'Poison Powder']);
def(296, 'status', null, ['Dark Void']);
def(37, 'confuse', null, ['Supersonic', 'Confuse Ray']);
def(92, 'swagger', null, ['Swagger']);
def(126, 'flatter', null, ['Flatter']);
def(144, 'yawn', null, ['Yawn']);
def(58, 'leechseed', null, ['Leech Seed']);
def(232, 'toxicthread', null, ['Toxic Thread']);
// -- healing
def(26, 'heal', { w: 'half' }, ['Recover', 'Slack Off']);
def(118, 'heal', { w: 'half' }, ['Soft-Boiled', 'Milk Drink']);
def(184, 'heal', { w: 'half', roost: true }, ['Roost']);
def(103, 'heal', { w: 'sun' }, ['Morning Sun']);
def(104, 'heal', { w: 'sun' }, ['Synthesis']);
def(105, 'heal', { w: 'sun' }, ['Moonlight']);
def(265, 'heal', { w: 'sand' }, ['Shore Up']);
def(326, 'heal', { w: 'quarter' }, ['Life Dew']);
def(28, 'rest', null, ['Rest']);
def(68, 'painsplit', null, ['Pain Split']);
def(78, 'healbell', null, ['Heal Bell', 'Aromatherapy']);
def(151, 'refresh', null, ['Refresh']);
def(138, 'wish', null, ['Wish']);
// -- field
def(107, 'weather', null, ['Rain Dance', 'Sunny Day', 'Sandstorm', 'Hail']);
def(53, 'screen', { screen: 'reflect' }, ['Reflect']);
def(27, 'screen', { screen: 'light' }, ['Light Screen']);
def(249, 'screen', { screen: 'veil' }, ['Aurora Veil']);
def(87, 'hazard', { hz: 'spikes' }, ['Spikes']);
def(194, 'hazard', { hz: 'tspikes' }, ['Toxic Spikes']);
def(196, 'hazard', { hz: 'rocks' }, ['Stealth Rock']);
def(203, 'hazard', { hz: 'web' }, ['Sticky Web']);
def(190, 'trickroom', null, ['Trick Room']);
// round 3 batch E
def(322, 'hit', null, ['Shell Side Arm']);   // MEASURED (9 Atk/Sp. Atk/Def/Sp. Def combinations, ROMDIFF.md section 8): the hack's Shell Side Arm is always special, it never switches to physical; its 20 percent poison is the ordinary additional effect
def(167, 'naturalgift', null, ['Natural Gift']); def(305, 'popbomb', null, ['Population Bomb']); def(308, 'ragingbull', null, ['Raging Bull']); def(312, 'ivycudgel', null, ['Ivy Cudgel']); def(290, 'skydrop', null, ['Sky Drop']); def(279, 'gravapple', null, ['Grav Apple']); def(294, 'mindblown', null, ['Chloroblast']); def(313, 'ficklebeam', null, ['Fickle Beam']);
def(329, 'hazardhit', { hz: 'rocks' }, ['Stone Axe']); def(330, 'hazardhit', { hz: 'spikes' }, ['Ceaseless Edge']); 
def(274, 'hit', null, ['Dynamax Cannon', 'Behemoth Blade', 'Behemoth Bash']); def(276, 'hit', null, ['Snipe Shot']); def(321, 'hit', null, ['Tera Starstorm']); def(280, 'hyperspace', null, ['Hyperspace Fury']);
def(30, 'fusion', null, ['Fusion Flare', 'Fusion Bolt']); def(291, 'hit', null, ['Beak Blast']); def(266, 'geomancy', null, ['Geomancy']); def(263, 'purify', null, ['Purify']); def(292, 'courtchange', null, ['Court Change']);
// round 3 batch D (probed in the real game first)
def(120, 'hit', null, ['Uproar']); def(226, 'lastresort', null, ['Last Resort']); def(237, 'copycat', null, ['Copycat']); def(219, 'mefirst', null, ['Me First']);
def(139, 'assist', null, ['Assist']); def(258, 'instruct', null, ['Instruct']); def(244, 'bestow', null, ['Bestow']); def(254, 'hit', null, ['Belch']);
def(100, 'batonpass', null, ['Baton Pass']); def(314, 'shedtail', null, ['Shed Tail']); def(278, 'stuffcheeks', null, ['Stuff Cheeks']); def(298, 'teatime', null, ['Teatime']); def(23, 'bide', null, ['Bide']);
def(166, 'fling', null, ['Fling']);
def(315, 'upperhand', null, ['Upper Hand']); def(286, 'poltergeist', null, ['Poltergeist']);
// round 3 batch B1: volatile conditions and field flags (each class was run in the real game first, ROMDIFF.md section 8)
def(125, 'torment', null, ['Torment']); def(150, 'imprison', null, ['Imprison']); def(188, 'embargo', null, ['Embargo']); def(33, 'healblock', null, ['Heal Block']);
def(195, 'gastroacid', null, ['Gastro Acid']); def(186, 'miracleeye', null, ['Miracle Eye']); def(259, 'laserfocus', null, ['Laser Focus']); def(242, 'powertrick', null, ['Power Trick', 'Power Shift']);
def(202, 'split', { st: ['def', 'spd'] }, ['Guard Split']); def(201, 'split', { st: ['atk', 'spa'] }, ['Power Split']); def(247, 'speedswap', null, ['Speed Swap']);
def(156, 'sport', { k: 'ms' }, ['Mud Sport']); def(161, 'sport', { k: 'ws' }, ['Water Sport']); def(191, 'room', { k: 'wr' }, ['Wonder Room']); def(192, 'room', { k: 'mr' }, ['Magic Room']);
def(89, 'perishsong', null, ['Perish Song']); def(152, 'grudge', null, ['Grudge']); def(253, 'powder', null, ['Powder']); def(209, 'iondeluge', null, ['Ion Deluge']); def(267, 'fairylock', null, ['Fairy Lock']);
def(206, 'abilitycopy', { to: 'target' }, ['Entrainment']); def(310, 'abilitycopy', { to: 'user' }, ['Doodle']); def(223, 'reflecttype', null, ['Reflect Type']);
def(25, 'conversion', null, ['Conversion']); def(70, 'conversion2', null, ['Conversion 2']); def(301, 'revival', null, ['Revival Blessing']); def(164, 'camouflage', null, ['Camouflage']); def(197, 'telekinesis', null, ['Telekinesis']); def(193, 'magnetrise', null, ['Magnet Rise']);
def(245, 'rototiller', null, ['Rototiller']); def(260, 'plusminus', { stats: ['def', 'spd'] }, ['Magnetic Flux']); def(261, 'plusminus', { stats: ['atk', 'spa'] }, ['Gear Up']);
// the moves written for double battles (round 3, MEASURED in a singles battle): most print "But it failed!", After You / Quash work only while the target has not moved,
// Mat Block protects against damaging moves on the first turn out, Flower Shield lifts the Defense of every Grass type on the field, Decorate works on the foe
def(131, 'singlesfail', null, ['Follow Me', 'Rage Powder', 'Spotlight']); def(135, 'singlesfail', null, ['Helping Hand']); def(268, 'singlesfail', null, ['Ally Switch']);
def(252, 'singlesfail', null, ['Aromatic Mist']); def(271, 'singlesfail', null, ['Coaching']); def(316, 'singlesfail', null, ['Dragon Cheer']); def(60, 'singlesfail', null, ['Hold Hands']);
def(243, 'afteryou', null, ['After You']); def(208, 'afteryou', null, ['Quash']); def(256, 'matblock', null, ['Mat Block']); def(246, 'flowershield', null, ['Flower Shield']);
def(275, 'stats', { foe: S({ atk: 2, spa: 2 }) }, ['Decorate']); def(165, 'hit', null, ['Water Pledge', 'Fire Pledge', 'Grass Pledge']);
def(94, 'attract', null, ['Attract']); def(102, 'captivate', null, ['Captivate']);
// terrain and Gravity (round 3, MEASURED in the real game)
def(213, 'terrainset', null, ['Grassy Terrain']); def(212, 'terrainset', null, ['Misty Terrain']); def(214, 'terrainset', null, ['Electric Terrain']); def(215, 'terrainset', null, ['Psychic Terrain']);
def(185, 'gravity', null, ['Gravity']); def(283, 'terrainpulse', null, ['Terrain Pulse']); def(328, 'steelroller', null, ['Steel Roller']);
def(4, 'terrainbonus', null, ['Rising Voltage', 'Expanding Force', 'Misty Explosion', 'Psyblade']); def(273, 'hit', null, ['Grassy Glide']);
def(187, 'tailwind', null, ['Tailwind']);
def(98, 'safeguard', null, ['Safeguard']);
def(22, 'haze', null, ['Haze']);
def(238, 'defog', null, ['Defog']);
// -- protection and volatiles
def(86, 'protect', null, ['Protect', 'Detect', "King's Shield", 'Quick Guard']);
def(90, 'endure', null, ['Endure']);
def(55, 'substitute', null, ['Substitute']);
def(36, 'focusenergy', null, ['Focus Energy']);
def(63, 'disable', null, ['Disable']);
def(67, 'encore', null, ['Encore']);
def(134, 'taunt', null, ['Taunt']);
def(136, 'trick', null, ['Trick', 'Switcheroo']);
def(74, 'destinybond', null, ['Destiny Bond']);
def(80, 'meanlook', null, ['Mean Look', 'Spider Web', 'Block']);
def(140, 'ingrain', null, ['Ingrain']);
def(189, 'aquaring', null, ['Aqua Ring']);
def(83, 'curse', null, ['Curse']);
def(71, 'lockon', null, ['Mind Reader', 'Lock-On']);
def(127, 'memento', null, ['Memento']);
def(84, 'healingwish', { lunar: false }, ['Healing Wish']);
def(85, 'healingwish', { lunar: true }, ['Lunar Dance']);
def(24, 'roar', null, ['Roar', 'Whirlwind']);
def(114, 'teleport', null, ['Teleport']);
def(255, 'partingshot', null, ['Parting Shot']);
def(57, 'metronome', null, ['Metronome']);
def(45, 'transform', null, ['Transform']);
def(73, 'sleeptalk', null, ['Sleep Talk']);
def(59, 'nothing', null, ['Splash']);
def(61, 'nothing', null, ['Celebrate']);
def(62, 'nothing', null, ['Happy Hour']);
def(112, 'futuresight', null, ['Future Sight', 'Doom Desire']);
def(88, 'foresight', null, ['Foresight', 'Odor Sleuth']);
def(35, 'mist', null, ['Mist']);
def(224, 'settype', null, ['Soak', 'Magic Powder']);
def(250, 'settype', { add: true }, ['Trick-or-Treat', "Forest's Curse"]);
def(325, 'smackdown', null, ['Smack Down', 'Thousand Arrows']);
def(76, 'spite', null, ['Spite']);

// Per-move arguments the ROM keeps at move record +0x24 (verified against the ROM by the test), keyed by move name.
export const MOVE_ARGS = Object.freeze({
  // status type for effect 2/296: 1 sleep, 2 poison, 3 burn, 5 paralysis, 6 toxic
  statusType: Object.freeze({
    'Sing': 1, 'Poison Powder': 2, 'Stun Spore': 5, 'Sleep Powder': 1, 'Thunder Wave': 5, 'Toxic': 6, 'Hypnosis': 1, 'Glare': 5,
    'Poison Gas': 2, 'Lovely Kiss': 1, 'Spore': 1, 'Will-O-Wisp': 3, 'Grass Whistle': 1, 'Dark Void': 1,
  }),
  // drain percent (effect 3 / 5)
  drain: Object.freeze({
    'Absorb': 50, 'Mega Drain': 50, 'Leech Life': 50, 'Giga Drain': 50, 'Drain Punch': 50, 'Horn Leech': 50, 'Parabolic Charge': 50,
    'Draining Kiss': 75, 'Oblivion Wing': 75, 'Bouncy Bubble': 100, 'Bitter Blade': 50, 'Matcha Gotcha': 50, 'Dream Eater': 50,
  }),
  // recoil percent of damage dealt (effect 324)
  recoil: Object.freeze({
    'Take Down': 25, 'Double-Edge': 33, 'Submission': 25, 'Volt Tackle': 33, 'Flare Blitz': 33, 'Brave Bird': 33, 'Wood Hammer': 33,
    'Head Smash': 50, 'Wild Charge': 25, 'Head Charge': 25, 'Light Of Ruin': 50, 'Wave Crash': 33,
  }),
  fixed: Object.freeze({ 'Sonic Boom': 20, 'Dragon Rage': 40 }),
  // percent of the target's CURRENT hp (effect 31)
  fraction: Object.freeze({ 'Super Fang': 50, "Nature's Madness": 50, 'Ruination': 50, 'Guardian of Alola': 75 }),
  // effect 86 kinds
  protect: Object.freeze({
    'Protect': 1, 'Detect': 1, 'Spiky Shield': 2, "King's Shield": 3, 'Baneful Bunker': 4, 'Burning Bulwark': 5, 'Obstruct': 6,
    'Silk Trap': 7, 'Wide Guard': 9, 'Quick Guard': 10, 'Crafty Shield': 11, 'Max Guard': 8,
  }),
  // effect 107 weather
  // type a Soak-like move turns the target into
  setType: Object.freeze({ 'Soak': T.WATER, 'Magic Powder': T.PSYCHIC, 'Trick-or-Treat': T.GHOST, "Forest's Curse": T.GRASS }),
  // effects 212-215: the terrain a terrain move sets (TN ids)
  terrain: Object.freeze({ 'Grassy Terrain': 1, 'Misty Terrain': 3, 'Electric Terrain': 2, 'Psychic Terrain': 4 }),
  weather: Object.freeze({ 'Rain Dance': WX.RAIN, 'Sunny Day': WX.SUN, 'Sandstorm': WX.SAND, 'Hail': WX.HAIL, 'Snowscape': WX.SNOW }),
  // effect 66: multiplier percent
  counter: Object.freeze({ 'Counter': 200, 'Mirror Coat': 200, 'Metal Burst': 150, 'Comeuppance': 150 }),
});
// ROM argument byte values for the weather moves (BATTLE_WEATHER ids) -- the test compares these with the ROM.
export const ROM_WEATHER_ARG = Object.freeze({ 'Rain Dance': 0, 'Sunny Day': 3, 'Sandstorm': 5, 'Hail': 6, 'Snowscape': 7 });

// Moves that behave in a documented special way by NAME (hand-written game knowledge; the name is a key, not content).
export const NAMED = Object.freeze({
  weatherAcc: Object.freeze({ // accuracy override in weather: [rain, sun] -> 0 = never misses, number = accuracy
    'Thunder': { rain: 0, sun: 50 }, 'Hurricane': { rain: 0, sun: 50 }, 'Blizzard': { hail: 0, snow: 0 },
    'Bleakwind Storm': { rain: 0, sun: 50 }, 'Wildbolt Storm': { rain: 0, sun: 50 }, 'Sandsear Storm': { rain: 0, sun: 50 },
  }),
  // moves a Metronome call may not pick (the standard ban list, by name)
  metronomeBan: Object.freeze(['Metronome', 'Struggle', 'Sleep Talk', 'Protect', 'Detect', 'Endure', 'Counter', 'Mirror Coat', 'Metal Burst', 'Destiny Bond', 'Focus Punch', 'Roar', 'Whirlwind', 'Teleport', 'Trick', 'Switcheroo', 'Mimic', 'Transform', 'Baton Pass', 'Assist', 'Copycat', 'Me First', 'Mirror Move', 'Nature Power', 'Sketch', 'Snatch', 'Spotlight', 'Follow Me', 'Rage Powder', 'Helping Hand', 'King\'s Shield', 'Spiky Shield', 'Baneful Bunker', 'Obstruct', 'Silk Trap', 'Burning Bulwark', 'Wide Guard', 'Quick Guard', 'Crafty Shield',
    // Z-moves and Max Guard are never called by Metronome
    'Breakneck Blitz', 'All-Out Pummeling', 'Supersonic Skystrike', 'Acid Downpour', 'Tectonic Rage', 'Continental Crush', 'Savage Spin-Out', 'Never-Ending Nightmare',
    'Corkscrew Crash', 'Inferno Overdrive', 'Hydro Vortex', 'Bloom Doom', 'Gigavolt Havoc', 'Shattered Psyche', 'Subzero Slammer', 'Devastating Drake', 'Black Hole Eclipse',
    'Twinkle Tackle', 'Catastropika', '10,000,000 Volt Thunderbolt', 'Stoked Sparksurfer', 'Extreme Evoboost', 'Pulverizing Pancake', 'Genesis Supernova', 'Sinister Arrow Raid',
    'Malicious Moonsault', 'Oceanic Operetta', 'Splintered Stormshards', "Let's Snuggle Forever", 'Clangorous Soulblaze', 'Guardian of Alola', 'Searing Sunraze Smash',
    'Menacing Moonraze Maelstrom', 'Light That Burns the Sky', 'Soul-Stealing 7-Star Strike', 'Max Guard']),
  // moves Sleep Talk may not call (and Encore may not lock onto)
  sleepTalkBan: Object.freeze(['Sleep Talk', 'Rest', 'Metronome', 'Struggle', 'Focus Punch', 'Uproar', 'Bide', 'Counter', 'Mirror Coat', 'Metal Burst', 'Protect', 'Detect', 'Endure']),
  // moves that thaw a frozen user
  thawUser: Object.freeze(['Flame Wheel', 'Sacred Fire', 'Flare Blitz', 'Scald', 'Burn Up', 'Steam Eruption', 'Fusion Flare', 'Pyro Ball', 'Scorching Sands', 'Matcha Gotcha', 'Burning Jealousy']),
  // moves that thaw a frozen TARGET although they are not Fire-type
  thawTarget: Object.freeze(['Scald', 'Steam Eruption', 'Scorching Sands']),
  // x2 damage against a semi-invulnerable target (the ROM hit flag lets the move connect; the doubling is by name)
  invulnDouble: Object.freeze({
    ground: Object.freeze(['Earthquake', 'Magnitude']),
    water: Object.freeze(['Surf', 'Whirlpool']),
    air: Object.freeze(['Gust', 'Twister']),
  }),
  // x2 damage and never misses against a Minimized target
  minimizeDouble: Object.freeze(['Stomp', 'Steamroller', 'Body Slam', 'Flying Press', 'Dragon Rush', 'Heat Crash', 'Heavy Slam', 'Malicious Moonsault', 'Phantom Force', 'Shadow Force']),
  // moves with a 'sound' quality come from move.flags.sound; punch/bite/etc. from move.flags
  // explicit Freeze-Dry-like (super effective on Water)
  freezeDry: Object.freeze(['Freeze-Dry']),
  // moves that hit twice the power against a Minimized target are NOT modelled (documented)
  // type-boost items by name -> [type]
  typeItems: Object.freeze({
    'Charcoal': T.FIRE, 'Mystic Water': T.WATER, 'Magnet': T.ELECTRIC, 'Miracle Seed': T.GRASS, 'Never-Melt Ice': T.ICE, 'Black Belt': T.FIGHTING,
    'Poison Barb': T.POISON, 'Soft Sand': T.GROUND, 'Sharp Beak': T.FLYING, 'Twisted Spoon': T.PSYCHIC, 'Silver Powder': T.BUG,
    'Hard Stone': T.ROCK, 'Spell Tag': T.GHOST, 'Dragon Fang': T.DRAGON, 'Black Glasses': T.DARK, 'Metal Coat': T.STEEL, 'Silk Scarf': T.NORMAL,
    'Fairy Feather': T.FAIRY,
    'Flame Plate': T.FIRE, 'Splash Plate': T.WATER, 'Zap Plate': T.ELECTRIC, 'Meadow Plate': T.GRASS, 'Icicle Plate': T.ICE, 'Fist Plate': T.FIGHTING,
    'Toxic Plate': T.POISON, 'Earth Plate': T.GROUND, 'Sky Plate': T.FLYING, 'Mind Plate': T.PSYCHIC, 'Insect Plate': T.BUG, 'Stone Plate': T.ROCK,
    'Spooky Plate': T.GHOST, 'Draco Plate': T.DRAGON, 'Dread Plate': T.DARK, 'Iron Plate': T.STEEL, 'Pixie Plate': T.FAIRY,
    'Sea Incense': T.WATER, 'Odd Incense': T.PSYCHIC, 'Rock Incense': T.ROCK, 'Wave Incense': T.WATER, 'Rose Incense': T.GRASS,
  }),
});

// ---------------------------------------------------------------------------------------------
// compileData(pack): a pure, memoised resolution of the name-keyed tables against a pack.
// ---------------------------------------------------------------------------------------------
const cache = new WeakMap();

/** @returns {{moveByName:Object, abilityByName:Object, itemByName:Object, args:Object, byMove:Array, missing:string[]}} */
export function compileData(pack) {
  const hit = cache.get(pack);
  if (hit) return hit;
  const moveByName = Object.create(null), abilityByName = Object.create(null), itemByName = Object.create(null);
  for (const mv of pack.moves) if (mv && mv.name && !(mv.name in moveByName)) moveByName[mv.name] = mv.id;
  for (const a of pack.abilities) if (a && a.name && !(a.name in abilityByName)) abilityByName[a.name] = a.id; // first of duplicates
  for (const it of pack.items) if (it && it.name && !(it.name in itemByName)) itemByName[it.name] = it.id;
  const missing = [];
  const idOf = (name) => { const id = moveByName[name]; if (id === undefined) missing.push(name); return id; };
  const byIdMap = (tbl) => { const o = Object.create(null); for (const k of Object.keys(tbl)) { const id = idOf(k); if (id !== undefined) o[id] = tbl[k]; } return o; };
  const args = {
    statusType: byIdMap(MOVE_ARGS.statusType), drain: byIdMap(MOVE_ARGS.drain), recoil: byIdMap(MOVE_ARGS.recoil), fixed: byIdMap(MOVE_ARGS.fixed),
    fraction: byIdMap(MOVE_ARGS.fraction), protect: byIdMap(MOVE_ARGS.protect), counter: byIdMap(MOVE_ARGS.counter),
    weather: byIdMap(MOVE_ARGS.weather), setType: byIdMap(MOVE_ARGS.setType), terrain: byIdMap(MOVE_ARGS.terrain),
  };
  const named = {};
  for (const k of ['metronomeBan', 'sleepTalkBan', 'thawUser', 'freezeDry', 'thawTarget', 'minimizeDouble']) {
    const s = new Set();
    for (const n of NAMED[k]) { const id = moveByName[n]; if (id !== undefined) s.add(id); }
    named[k] = s;
  }
  named.invulnDouble = {};
  for (const kind of Object.keys(NAMED.invulnDouble)) {
    const s = new Set();
    for (const n of NAMED.invulnDouble[kind]) { const id = moveByName[n]; if (id !== undefined) s.add(id); }
    named.invulnDouble[kind] = s;
  }
  named.minimizeId = moveByName.Minimize;
  named.weatherAcc = Object.create(null);
  for (const n of Object.keys(NAMED.weatherAcc)) { const id = moveByName[n]; if (id !== undefined) named.weatherAcc[id] = NAMED.weatherAcc[n]; }
  named.typeItems = Object.create(null);
  for (const n of Object.keys(NAMED.typeItems)) { const id = itemByName[n]; if (id !== undefined) named.typeItems[id] = NAMED.typeItems[n]; }
  const out = { moveByName, abilityByName, itemByName, args, named, missing, packRef: pack };
  cache.set(pack, out);
  return out;
}

/** Why a move cannot run in the engine, or null when its effect class, its per-move arguments and all secondary
 *  effects are implemented.  `kindsImplemented` is the set of EFFECTS kinds engine_moves.js implements (injected to avoid an
 *  import cycle). */
export function moveUnsupportedReason(pack, mv, kindsImplemented) {
  if (!mv || mv.id === 0) return 'empty';
  const ef = EFFECTS[mv.effect];
  if (!ef) return 'effect-' + mv.effect;
  if (!kindsImplemented.has(ef.kind)) return 'kind-' + ef.kind;
  const args = compileData(pack).args;
  const need = KIND_ARGS[ef.kind];
  if (need && args[need][mv.id] === undefined) return 'arg-' + need;
  for (const a of mv.additional) {
    if (!ADDITIONAL[a.effect]) return 'additional-' + a.effect;
  }
  return null;
}
// kinds that read a per-move argument table
export const KIND_ARGS = Object.freeze({
  status: 'statusType', drain: 'drain', dreameater: 'drain', recoil: 'recoil', fixeddamage: 'fixed', fractiondamage: 'fraction',
  protect: 'protect', weather: 'weather', counter: 'counter', settype: 'setType', terrainset: 'terrain',
});

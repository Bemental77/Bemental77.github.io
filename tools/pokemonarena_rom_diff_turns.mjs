// tools/pokemonarena_rom_diff_turns.mjs -- stage FA2: one-turn (and two-turn) scenarios compared engine-vs-real-game on the STATE after the
// turn: both HP values, both stat-stage vectors, both major statuses, the weather and the side-status words.  Covers the effect classes
// the damage differential cannot see: stat moves, status moves and immunities, healing, recoil and drain, weather and screens, the end-of-turn
// residuals (burn, poison, toxic, sand, hail, Leftovers, ...), and the turn order (speed, priority).
//
// buildTurns(pack, EFFECTS) returns plain scenarios (names only).  engineTurn() runs one on the engine (lab battle, the RNG replaced by the
// same "draw at 34000/65536" mapping the live side forces); the live side lives in pokemonarena_rom_diff_live.mjs (turnLive).
// Pure ASCII, nothing here is ROM content.

import { fieldSpec } from './pokemonarena_rom_diff_combos.mjs';

export const OBS_STAT_ORDER = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
const STATUS_CODE = { slp: 1, psn: 2, brn: 3, frz: 4, par: 5, tox: 6, fbt: 7 };

/** the draw both sides use: every RNG call returns floor(n * 34000 / 65536) (damage roll idx 8, accuracy pick 51, no crit) */
export const fixedDraw = (n) => Math.floor((n * 34000) / 65536);

export function buildTurns(pack, EFFECTS) {
  const out = [];
  let n = 0;
  const mon = (o) => ({ st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, types: ['Normal'], ability: null, item: null, status: null, stages: {}, hp: 400, maxhp: 400, ...o });
  const add = (group, label, a, b, aMove, bMove, extra) => {
    out.push({ id: ++n, group, label, aMove, bMove: bMove || 'Splash', a: mon({ ...a, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 500, ...(a.st || {}) } }), b: mon({ ...b, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 5, ...(b.st || {}) } }), weather: null, screens: [], turns: 1, ...(extra || {}) });
  };
  const byName = (nm) => pack.moves.find((m) => m.name === nm);

  // A. every stat move the engine runs (kind 'stats') + the few single-id stat classes
  for (const mv of pack.moves) {
    if (!mv || mv.id === 0) continue;
    const ef = EFFECTS[mv.effect];
    if (!ef || ef.kind !== 'stats') continue;
    if (mv.pp === 0) continue;
    add('stats', mv.name, {}, {}, mv.name, null);
  }
  // B. status-inflicting moves (statusType args) and the type/ability immunities
  const STATUS_MOVES = ['Thunder Wave', 'Toxic', 'Will-O-Wisp', 'Poison Powder', 'Stun Spore', 'Sleep Powder', 'Spore', 'Hypnosis', 'Sing', 'Glare', 'Poison Gas', 'Lovely Kiss', 'Grass Whistle'];
  for (const nm of STATUS_MOVES) {
    if (!byName(nm)) continue;
    add('status', nm, {}, {}, nm, null);
  }
  for (const [nm, tys, ab, label] of [
    ['Thunder Wave', ['Electric'], null, 'electric immune to paralysis'], ['Thunder Wave', ['Ground'], null, 'ground immune to thunder wave'], ['Toxic', ['Poison'], null, 'poison immune to toxic'], ['Toxic', ['Steel'], null, 'steel immune to toxic'],
    ['Will-O-Wisp', ['Fire'], null, 'fire immune to burn'], ['Poison Powder', ['Grass'], null, 'grass immune to powder'], ['Spore', ['Grass'], null, 'grass immune to spore'], ['Glare', ['Ghost'], null, 'glare vs ghost'],
    ['Thunder Wave', ['Normal'], 'Limber', 'limber'], ['Toxic', ['Normal'], 'Immunity', 'immunity'], ['Will-O-Wisp', ['Normal'], 'Water Veil', 'water veil'], ['Spore', ['Normal'], 'Insomnia', 'insomnia'], ['Hypnosis', ['Normal'], 'Vital Spirit', 'vital spirit'],
    ['Spore', ['Normal'], 'Overcoat', 'overcoat vs spore'], ['Sleep Powder', ['Normal'], 'Overcoat', 'overcoat vs powder'], ['Thunder Wave', ['Normal'], 'Magic Guard', 'magic guard'], ['Will-O-Wisp', ['Normal'], 'Comatose', 'comatose'],
  ]) {
    if (!byName(nm)) continue;
    add('status-immune', label, {}, { types: tys, ability: ab }, nm, null);
  }
  add('status-immune', 'safeguard blocks toxic', {}, {}, 'Toxic', null, { sideBits: { b: ['sg'] } });
  // C. healing and self-hp moves
  for (const [nm, wx] of [['Recover', null], ['Roost', null], ['Soft-Boiled', null], ['Milk Drink', null], ['Slack Off', null], ['Synthesis', null], ['Synthesis', 'sun'], ['Synthesis', 'rain'], ['Synthesis', 'sand'], ['Moonlight', null], ['Moonlight', 'sun'], ['Morning Sun', 'hail'], ['Shore Up', null], ['Shore Up', 'sand'], ['Life Dew', null], ['Rest', null]]) {
    if (!byName(nm)) continue;
    add('heal', nm + (wx ? ' in ' + wx : ''), { hp: 100, maxhp: 400 }, {}, nm, null, { weather: wx });
  }
  for (const nm of ['Belly Drum', 'Substitute']) add('self-hp', nm, {}, {}, nm, null);
  add('self-hp', 'Pain Split', { hp: 100 }, { hp: 380 }, 'Pain Split', null);
  add('self-hp', 'Endeavor', { hp: 100 }, { hp: 400 }, 'Endeavor', null);
  add('self-hp', 'Super Fang', {}, { hp: 301 }, 'Super Fang', null);
  add('self-hp', 'Seismic Toss', {}, {}, 'Seismic Toss', null);
  add('self-hp', 'Dragon Rage', {}, {}, 'Dragon Rage', null);
  add('self-hp', 'Sonic Boom', {}, {}, 'Sonic Boom', null);
  add('self-hp', 'Night Shade', {}, {}, 'Night Shade', null);
  // D. recoil and drain (move arg bytes), life orb, shell bell
  for (const nm of ['Double-Edge', 'Take Down', 'Submission', 'Volt Tackle', 'Flare Blitz', 'Brave Bird', 'Wood Hammer', 'Head Smash', 'Wild Charge', 'Head Charge', 'Wave Crash']) add('recoil', nm, { types: ['Normal'] }, {}, nm, null);
  for (const nm of ['Absorb', 'Mega Drain', 'Giga Drain', 'Drain Punch', 'Horn Leech', 'Draining Kiss', 'Leech Life', 'Oblivion Wing']) { if (byName(nm)) add('drain', nm, { hp: 100, maxhp: 400 }, {}, nm, null); }
  for (const nm of ['Absorb', 'Giga Drain', 'Drain Punch', 'Draining Kiss']) add('drain', nm + ' with Big Root', { hp: 100, maxhp: 411, item: 'Big Root' }, { hp: 400, maxhp: 411 }, nm, null);
  add('drain', 'Leech Seed with Big Root (we seed the foe)', { hp: 100, maxhp: 411, item: 'Big Root' }, { hp: 400, maxhp: 411 }, 'Leech Seed', null, { seq: ['Leech Seed', 'Splash'] });
  add('recoil', 'Life Orb recoil', { item: 'Life Orb' }, {}, 'Earthquake', null);
  add('recoil', 'Shell Bell heal', { item: 'Shell Bell', hp: 100, maxhp: 400 }, {}, 'Earthquake', null);
  add('recoil', 'Rocky Helmet on contact', {}, { item: 'Rocky Helmet' }, 'Body Slam', null);
  add('recoil', 'Rough Skin on contact', {}, { ability: 'Rough Skin' }, 'Body Slam', null);
  add('recoil', 'Rocky Helmet no contact', {}, { item: 'Rocky Helmet' }, 'Earthquake', null);
  // E. end-of-turn residuals
  add('residual', 'burn', { status: 'brn' }, {}, 'Splash', null);
  add('residual', 'poison', { status: 'psn' }, {}, 'Splash', null);
  add('residual', 'toxic turn 1', { status: 'tox' }, {}, 'Splash', null);
  add('residual', 'toxic turn 2', { status: 'tox' }, {}, 'Splash', null, { turns: 2 });
  add('residual', 'toxic turn 3', { status: 'tox' }, {}, 'Splash', null, { turns: 3 });
  add('residual', 'burn + magic guard', { status: 'brn', ability: 'Magic Guard' }, {}, 'Splash', null);
  add('residual', 'poison + poison heal', { status: 'psn', ability: 'Poison Heal', hp: 100 }, {}, 'Splash', null);
  add('residual', 'burn foe', {}, { status: 'brn' }, 'Splash', null);
  add('residual', 'leftovers', { item: 'Leftovers', hp: 100 }, {}, 'Splash', null);
  add('residual', 'leftovers full hp', { item: 'Leftovers' }, {}, 'Splash', null);
  add('residual', 'black sludge (poison type)', { item: 'Black Sludge', hp: 100, types: ['Poison'] }, {}, 'Splash', null);
  add('residual', 'black sludge (normal type)', { item: 'Black Sludge', types: ['Normal'] }, {}, 'Splash', null);
  add('residual', 'flame orb', { item: 'Flame Orb' }, {}, 'Splash', null);
  add('residual', 'toxic orb', { item: 'Toxic Orb' }, {}, 'Splash', null);
  add('residual', 'sandstorm normal', {}, {}, 'Splash', null, { weather: 'sand' });
  add('residual', 'sandstorm rock', { types: ['Rock'] }, {}, 'Splash', null, { weather: 'sand' });
  add('residual', 'sandstorm steel', { types: ['Steel'] }, {}, 'Splash', null, { weather: 'sand' });
  add('residual', 'sandstorm ground', { types: ['Ground'] }, {}, 'Splash', null, { weather: 'sand' });
  add('residual', 'sandstorm magic guard', { ability: 'Magic Guard' }, {}, 'Splash', null, { weather: 'sand' });
  add('residual', 'sandstorm sand veil', { ability: 'Sand Veil' }, {}, 'Splash', null, { weather: 'sand' });
  add('residual', 'hail normal', {}, {}, 'Splash', null, { weather: 'hail' });
  add('residual', 'hail ice', { types: ['Ice'] }, {}, 'Splash', null, { weather: 'hail' });
  add('residual', 'snow normal', {}, {}, 'Splash', null, { weather: 'snow' });
  add('residual', 'hail ice body', { ability: 'Ice Body', hp: 100 }, {}, 'Splash', null, { weather: 'hail' });
  add('residual', 'rain dry skin', { ability: 'Dry Skin', hp: 100 }, {}, 'Splash', null, { weather: 'rain' });
  add('residual', 'sun dry skin', { ability: 'Dry Skin' }, {}, 'Splash', null, { weather: 'sun' });
  add('residual', 'rain rain dish', { ability: 'Rain Dish', hp: 100 }, {}, 'Splash', null, { weather: 'rain' });
  add('residual', 'sun solar power', { ability: 'Solar Power' }, {}, 'Splash', null, { weather: 'sun' });
  add('residual', 'leech seed', {}, {}, 'Splash', 'Leech Seed');
  add('residual', 'sitrus berry at <=50%', { item: 'Sitrus Berry', hp: 200 }, {}, 'Splash', null);
  add('residual', 'sitrus berry above 50%', { item: 'Sitrus Berry', hp: 201 }, {}, 'Splash', null);
  add('residual', 'oran berry at <=50%', { item: 'Oran Berry', hp: 200 }, {}, 'Splash', null);
  // E2. end-of-turn ORDER without any faint: HP just under the maximum, so whichever of a heal and a hit comes first changes the result through the max-HP clamp
  add('eot-order', 'burn vs leftovers', { status: 'brn', item: 'Leftovers', hp: 395 }, {}, 'Splash', null);
  add('eot-order', 'poison vs leftovers', { status: 'psn', item: 'Leftovers', hp: 395 }, {}, 'Splash', null);
  add('eot-order', 'sand vs leftovers', { item: 'Leftovers', hp: 395 }, {}, 'Splash', null, { weather: 'sand' });
  add('eot-order', 'burn vs sand (2 hits, no clamp: sanity)', { status: 'brn', hp: 395 }, {}, 'Splash', null, { weather: 'sand' });
  add('eot-order', 'sand vs rain dish', { ability: 'Rain Dish', hp: 395 }, {}, 'Splash', null, { weather: 'rain' });
  add('eot-order', 'burn vs dry skin rain heal', { status: 'brn', ability: 'Dry Skin', hp: 395 }, {}, 'Splash', null, { weather: 'rain' });
  add('eot-order', 'burn vs ice body hail heal', { status: 'brn', ability: 'Ice Body', hp: 395 }, {}, 'Splash', null, { weather: 'hail' });
  add('eot-order', 'hail damage vs ice body heal (non-ice)', { ability: 'Ice Body', hp: 395 }, {}, 'Splash', null, { weather: 'hail' });
  add('eot-order', 'burn vs black sludge heal', { status: 'brn', item: 'Black Sludge', types: ['Poison'], hp: 395 }, {}, 'Splash', null);
  add('eot-order', 'poison vs poison heal', { status: 'psn', ability: 'Poison Heal', hp: 395 }, {}, 'Splash', null);
  add('eot-order', 'burn vs speed boost', { status: 'brn', ability: 'Shed Skin', hp: 395 }, {}, 'Splash', null);
  add('eot-order', 'leech seed (foe seeds us) vs leftovers', { item: 'Leftovers', hp: 395 }, {}, 'Splash', 'Leech Seed');
  add('eot-order', 'leech seed vs burn on foe: foe heals from seed', { }, { status: 'brn', hp: 395 }, 'Leech Seed', null);
  add('eot-order', 'flame orb: burn damage starts next turn', { item: 'Flame Orb' }, {}, 'Splash', null, { turns: 2 });
  add('eot-order', 'toxic orb: counter starts at 1 next turn', { item: 'Toxic Orb' }, {}, 'Splash', null, { turns: 2 });
  add('eot-order', 'toxic orb three turns', { item: 'Toxic Orb' }, {}, 'Splash', null, { turns: 3 });
  // weather duration: one cast, then Splash; hp trace shows how many ticks happen
  add('weather-turns', 'Sandstorm cast once, 8 turns', {}, {}, 'Sandstorm', null, { seq: ['Sandstorm', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('weather-turns', 'Hail cast once, 8 turns', {}, {}, 'Hail', null, { seq: ['Hail', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('weather-turns', 'Sandstorm with Smooth Rock, 10 turns', { item: 'Smooth Rock', types: ['Rock'] }, { types: ['Normal'] }, 'Sandstorm', null, { seq: ['Sandstorm', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('weather-turns', 'Reflect cast once, then physical hits: hp trace', {}, {}, 'Reflect', 'Body Slam', { seq: ['Reflect', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  // F. weather setters, screens, misc field
  for (const [nm, wx] of [['Rain Dance', 'rain'], ['Sunny Day', 'sun'], ['Sandstorm', 'sand'], ['Hail', 'hail'], ['Snowscape', 'snow']]) add('weather', nm, {}, {}, nm, null);
  for (const nm of ['Reflect', 'Light Screen']) add('screens', nm, {}, {}, nm, null);
  add('screens', 'Aurora Veil (needs hail)', {}, {}, 'Aurora Veil', null, { weather: 'hail' });
  add('screens', 'Aurora Veil without hail (fails)', {}, {}, 'Aurora Veil', null);
  // E3. rounding of the residual fractions on a max HP that is not a multiple of 16 (411): floor(411/16) = 25, floor(411/8) = 51, ...
  const R411 = { hp: 411, maxhp: 411 };
  add('rounding', 'burn 411', { status: 'brn', ...R411 }, {}, 'Splash', null);
  add('rounding', 'poison 411', { status: 'psn', ...R411 }, {}, 'Splash', null);
  add('rounding', 'toxic 411 three turns', { status: 'tox', ...R411 }, {}, 'Splash', null, { turns: 3 });
  add('rounding', 'toxic 411 five turns', { status: 'tox', ...R411 }, {}, 'Splash', null, { turns: 5 });
  add('rounding', 'sandstorm 411', { ...R411 }, {}, 'Splash', null, { weather: 'sand' });
  add('rounding', 'hail 411', { ...R411 }, {}, 'Splash', null, { weather: 'hail' });
  add('rounding', 'leftovers 411', { item: 'Leftovers', hp: 100, maxhp: 411 }, {}, 'Splash', null);
  add('rounding', 'black sludge non-poison 411', { item: 'Black Sludge', ...R411 }, {}, 'Splash', null);
  add('rounding', 'leech seed 411', { ...R411 }, {}, 'Splash', 'Leech Seed');
  add('rounding', 'belly drum 411', { ...R411 }, {}, 'Belly Drum', null);
  add('rounding', 'substitute 411', { ...R411 }, {}, 'Substitute', null, { seq: ['Substitute'] });
  add('rounding', 'recover 411', { hp: 100, maxhp: 411 }, {}, 'Recover', null);
  add('rounding', 'synthesis sun 411', { hp: 100, maxhp: 411 }, {}, 'Synthesis', null, { weather: 'sun' });
  add('rounding', 'synthesis rain 411', { hp: 100, maxhp: 411 }, {}, 'Synthesis', null, { weather: 'rain' });
  add('rounding', 'Double-Edge recoil 411 foe', { ...R411 }, { ...R411 }, 'Double-Edge', null);
  add('rounding', 'Absorb drain', { hp: 100, maxhp: 411 }, { ...R411 }, 'Absorb', null);
  add('rounding', 'wrap trap 411 two turns', {}, { ...R411 }, 'Wrap', null, { seq: ['Wrap', 'Splash'] });
  add('rounding', 'rest 411', { hp: 100, maxhp: 411 }, {}, 'Rest', null);
  add('rounding', 'dry skin rain 411', { ability: 'Dry Skin', hp: 100, maxhp: 411 }, {}, 'Splash', null, { weather: 'rain' });
  add('rounding', 'ice body hail 411', { ability: 'Ice Body', hp: 100, maxhp: 411 }, {}, 'Splash', null, { weather: 'hail' });
  add('rounding', 'poison heal 411', { status: 'psn', ability: 'Poison Heal', hp: 100, maxhp: 411 }, {}, 'Splash', null);
  add('rounding', 'rocky helmet 411', {}, { item: 'Rocky Helmet' }, 'Body Slam', null);
  add('rounding', 'rough skin 411', { ...R411 }, { ability: 'Rough Skin' }, 'Body Slam', null);
  add('rounding', 'sitrus 411 at half', { item: 'Sitrus Berry', hp: 205, maxhp: 411 }, {}, 'Splash', null);
  add('rounding', 'life orb recoil 411', { item: 'Life Orb', ...R411 }, {}, 'Earthquake', null);
  add('rounding', 'shell bell 411', { item: 'Shell Bell', hp: 100, maxhp: 411 }, {}, 'Earthquake', null);
  // E4. more effect classes: side conditions, confusion, status cures, bonus-power moves, hp-cost moves
  add('classes', 'Mist', {}, {}, 'Mist', null);
  add('classes', 'Safeguard', {}, {}, 'Safeguard', null);
  add('classes', 'Tailwind', {}, {}, 'Tailwind', null);
  add('classes', 'Swagger: +2 attack and confusion', {}, {}, 'Swagger', null);
  add('classes', 'Flatter: +1 spatk and confusion', {}, {}, 'Flatter', null);
  add('classes', 'Supersonic confuses', {}, {}, 'Supersonic', null);
  add('classes', 'Confuse Ray confuses', {}, {}, 'Confuse Ray', null);
  add('classes', 'Heal Bell cures the user', { status: 'brn' }, {}, 'Heal Bell', null);
  add('classes', 'Refresh cures the user', { status: 'psn' }, {}, 'Refresh', null);
  add('classes', 'Dream Eater on a sleeping foe', { hp: 100 }, { status: 'slp' }, 'Dream Eater', null);
  add('classes', 'Dream Eater on an awake foe fails', { hp: 100 }, {}, 'Dream Eater', null);
  add('classes', 'False Swipe leaves 1 hp', {}, { hp: 10, maxhp: 400 }, 'False Swipe', null);
  add('classes', 'Mind Blown costs half hp', {}, {}, 'Mind Blown', null);
  add('classes', 'High Jump Kick into a ghost crashes', {}, { types: ['Ghost'] }, 'High Jump Kick', null);
  add('classes', 'Jump Kick hits', {}, {}, 'Jump Kick', null);
  add('classes', 'Smack Down grounds a flier', {}, { types: ['Flying'] }, 'Smack Down', null, { seq: ['Smack Down', 'Earthquake'] });
  add('classes', 'Growth in sun', {}, {}, 'Growth', null, { weather: 'sun' });
  add('classes', 'Growth in clear weather', {}, {}, 'Growth', null);
  add('classes', 'Strength Sap heals by the foe attack', { hp: 100 }, {}, 'Strength Sap', null);
  add('classes', 'Toxic Thread poisons and slows', {}, {}, 'Toxic Thread', null);
  add('classes', 'Soak turns the foe Water', {}, {}, 'Soak', null, { seq: ['Soak', 'Thunderbolt'] });
  add('classes', 'Trick-or-Treat adds Ghost', {}, {}, 'Trick-or-Treat', null, { seq: ['Trick-or-Treat', 'Shadow Ball'] });
  add('classes', 'Fury Cutter doubles each hit', {}, {}, 'Fury Cutter', null, { seq: ['Fury Cutter', 'Fury Cutter', 'Fury Cutter', 'Fury Cutter'] });
  add('classes', 'Echoed Voice builds', {}, {}, 'Echoed Voice', null, { seq: ['Echoed Voice', 'Echoed Voice', 'Echoed Voice'] });
  add('classes', 'Bolt Beak when the user moves first', {}, {}, 'Bolt Beak', null);
  add('classes', 'Bolt Beak when the foe moves first', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Bolt Beak', 'Splash');
  add('classes', 'Stomping Tantrum after a failed move', {}, {}, 'Stomping Tantrum', null, { seq: ['Dream Eater', 'Stomping Tantrum'] });
  add('classes', 'Rapid Spin', {}, {}, 'Rapid Spin', null);
  add('classes', 'Electro Drift on a resistant foe', { types: ['Electric'] }, { types: ['Grass'] }, 'Electro Drift', null);
  add('classes', 'Collision Course on a weak foe', { types: ['Fighting'] }, { types: ['Rock'] }, 'Collision Course', null);
  add('classes', 'Sleep Talk while asleep calls a move', { status: 'slp' }, {}, 'Sleep Talk', null);
  add('classes', 'Snore while asleep', { status: 'slp' }, {}, 'Snore', null);
  add('classes', 'Snore while awake fails', {}, {}, 'Snore', null);
  add('classes', 'Spite', {}, {}, 'Spite', null);
  add('classes', 'Mean Look', {}, {}, 'Mean Look', null);
  add('classes', 'Teleport fails in singles', {}, {}, 'Teleport', null);
  add('classes', 'Revenge after being hit (foe faster)', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Revenge', 'Body Slam');
  add('classes', 'Avalanche after being hit (foe faster)', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Avalanche', 'Body Slam');
  add('classes', 'Payback when the foe moved first', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Payback', 'Body Slam');
  add('classes', 'Payback when the user moved first', {}, {}, 'Payback', 'Body Slam');
  add('classes', 'Assurance after being hit', {}, {}, 'Assurance', 'Body Slam');
  add('classes', 'Hex vs poisoned foe', {}, { status: 'psn' }, 'Hex', null);
  add('classes', 'Smelling Salts cures paralysis', {}, { status: 'par' }, 'Smelling Salts', null);
  add('classes', 'Wake-Up Slap wakes', {}, { status: 'slp' }, 'Wake-Up Slap', null);
  // G. multi-turn mechanics observed through the HP trace (the foe attacks with Body Slam unless stated; Splash otherwise)
  add('multi-turn', 'Protect then Protect again (chain)', {}, {}, 'Protect', 'Body Slam', { seq: ['Protect', 'Protect', 'Splash'] });
  add('multi-turn', 'Protect then Splash', {}, {}, 'Protect', 'Body Slam', { seq: ['Protect', 'Splash'] });
  add('multi-turn', 'Detect then Protect', {}, {}, 'Detect', 'Body Slam', { seq: ['Detect', 'Protect', 'Splash'] });
  add('multi-turn', 'Endure vs strong hit at low hp', { hp: 20 }, {}, 'Endure', 'Body Slam', { seq: ['Endure'] });
  add('multi-turn', 'Substitute then foe hits', {}, {}, 'Substitute', 'Body Slam', { seq: ['Substitute', 'Splash', 'Splash'] });
  add('multi-turn', 'Counter after foe physical hit (foe faster)', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Counter', 'Body Slam', { seq: ['Counter'] });
  add('multi-turn', 'Mirror Coat after foe special hit (foe faster)', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Mirror Coat', 'Flamethrower', { seq: ['Mirror Coat'] });
  add('multi-turn', 'Metal Burst after foe hit (foe faster)', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Metal Burst', 'Body Slam', { seq: ['Metal Burst'] });
  add('multi-turn', 'Counter vs special (fails)', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Counter', 'Flamethrower', { seq: ['Counter'] });
  add('multi-turn', 'Fake Out then Fake Out (flinch once)', {}, {}, 'Fake Out', 'Body Slam', { seq: ['Fake Out', 'Fake Out'] });
  add('multi-turn', 'Fly (charge, then hit)', {}, {}, 'Fly', 'Splash', { seq: ['Fly', 'Fly'] });
  add('multi-turn', 'Dig (charge, then hit) vs Earthquake foe', {}, {}, 'Dig', 'Earthquake', { seq: ['Dig', 'Dig'] });
  add('multi-turn', 'Fly vs Earthquake foe', {}, {}, 'Fly', 'Earthquake', { seq: ['Fly', 'Fly'] });
  add('multi-turn', 'Solar Beam in sun (no charge)', {}, {}, 'Solar Beam', 'Splash', { seq: ['Solar Beam'], weather: 'sun' });
  add('multi-turn', 'Solar Beam without sun (charge)', {}, {}, 'Solar Beam', 'Splash', { seq: ['Solar Beam', 'Solar Beam'] });
  add('multi-turn', 'Solar Beam in rain (charge)', {}, {}, 'Solar Beam', 'Splash', { seq: ['Solar Beam', 'Solar Beam'], weather: 'rain' });
  add('multi-turn', 'Hyper Beam recharge', {}, {}, 'Hyper Beam', 'Splash', { seq: ['Hyper Beam', 'Hyper Beam', 'Hyper Beam'] });
  add('multi-turn', 'Wrap trap 7 turns', {}, {}, 'Wrap', 'Splash', { seq: ['Wrap', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Fire Spin trap 7 turns', {}, {}, 'Fire Spin', 'Splash', { seq: ['Fire Spin', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Future Sight then 3 turns', {}, {}, 'Future Sight', 'Splash', { seq: ['Future Sight', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Doom Desire then 3 turns', {}, {}, 'Doom Desire', 'Splash', { seq: ['Doom Desire', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Leech Seed from us 3 turns (foe 300)', {}, { hp: 300 }, 'Leech Seed', 'Splash', { seq: ['Leech Seed', 'Splash', 'Splash'] });
  add('multi-turn', 'Thrash (rampage then confusion)', {}, {}, 'Thrash', 'Splash', { seq: ['Thrash', 'Thrash', 'Thrash', 'Thrash', 'Thrash'] });
  add('multi-turn', 'Outrage rampage', {}, {}, 'Outrage', 'Splash', { seq: ['Outrage', 'Outrage', 'Outrage', 'Outrage', 'Outrage'] });
  add('multi-turn', 'Tailwind then foe hits', {}, {}, 'Tailwind', 'Body Slam', { seq: ['Tailwind', 'Splash'] });
  add('multi-turn', 'Trick Room set', {}, {}, 'Trick Room', 'Splash', { seq: ['Trick Room', 'Splash', 'Splash'] });
  add('multi-turn', 'Light Screen then special hits', {}, {}, 'Light Screen', 'Flamethrower', { seq: ['Light Screen', 'Splash', 'Splash'] });
  add('multi-turn', 'Reflect expires after 5 turns', {}, {}, 'Reflect', 'Body Slam', { seq: ['Reflect', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Light Screen expires after 5 turns', {}, {}, 'Light Screen', 'Flamethrower', { seq: ['Light Screen', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Taunt then foe status move', {}, {}, 'Taunt', 'Swords Dance', { seq: ['Taunt', 'Splash', 'Splash'] });
  add('multi-turn', 'Encore after foe move', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Encore', 'Swords Dance', { seq: ['Encore', 'Splash', 'Splash'] });
  add('multi-turn', 'Disable', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Disable', 'Body Slam', { seq: ['Disable', 'Splash', 'Splash'] });
  add('multi-turn', 'Yawn then sleep', {}, {}, 'Yawn', 'Body Slam', { seq: ['Yawn', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Ingrain', { hp: 100 }, {}, 'Ingrain', 'Splash', { seq: ['Ingrain', 'Splash', 'Splash'] });
  add('multi-turn', 'Aqua Ring', { hp: 100 }, {}, 'Aqua Ring', 'Splash', { seq: ['Aqua Ring', 'Splash', 'Splash'] });
  add('multi-turn', 'Curse (non-ghost) then splash', {}, {}, 'Curse', 'Splash', { seq: ['Curse', 'Splash'] });
  add('multi-turn', 'Haze resets foe boosts', {}, { stages: { atk: 3, def: -2 } }, 'Haze', 'Splash', { seq: ['Haze'] });
  add('multi-turn', 'Rest then sleep turns', { hp: 100 }, {}, 'Rest', 'Splash', { seq: ['Rest', 'Splash', 'Splash', 'Splash'] });
  add('multi-turn', 'Focus Punch interrupted by hit', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Focus Punch', 'Body Slam', { seq: ['Focus Punch'] });
  add('multi-turn', 'Knock Off removes item', {}, { item: 'Leftovers' }, 'Knock Off', 'Splash', { seq: ['Knock Off'] });
  add('multi-turn', 'Thief steals item', {}, { item: 'Leftovers' }, 'Thief', 'Splash', { seq: ['Thief'] });
  add('multi-turn', 'Trick swaps items', { item: 'Choice Scarf' }, { item: 'Leftovers' }, 'Trick', 'Splash', { seq: ['Trick'] });
  add('multi-turn', 'Sucker Punch vs attacking foe', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Sucker Punch', 'Body Slam', { seq: ['Sucker Punch'] });
  add('multi-turn', 'Sucker Punch vs status foe', {}, {}, 'Sucker Punch', 'Swords Dance', { seq: ['Sucker Punch'] });
  add('multi-turn', 'Endeavor', { hp: 50 }, {}, 'Endeavor', 'Splash', { seq: ['Endeavor'] });
  add('multi-turn', 'Lock-On then low accuracy move', {}, {}, 'Lock-On', 'Splash', { seq: ['Lock-On', 'Focus Blast'] });
  add('multi-turn', 'Belly Drum then Splash', {}, {}, 'Belly Drum', 'Splash', { seq: ['Belly Drum', 'Splash'] });
  add('multi-turn', 'Memento', {}, {}, 'Memento', 'Splash', { seq: ['Memento'] });
  add('multi-turn', 'Healing Wish (self faint)', {}, {}, 'Healing Wish', 'Splash', { seq: ['Healing Wish'] });
  // multi-hit counts under the fixed draw (the engine hit-count draw vs the ROM's)
  for (const nm of ['Bullet Seed', 'Rock Blast', 'Icicle Spear', 'Fury Attack', 'Pin Missile', 'Double Slap', 'Comet Punch', 'Arm Thrust', 'Barrage', 'Spike Cannon']) add('multi-hit', nm, {}, {}, nm, null);
  for (const nm of ['Double Kick', 'Bonemerang', 'Dual Wingbeat', 'Twineedle', 'Gear Grind', 'Triple Kick']) add('multi-hit', nm, {}, {}, nm, null);
  // H. round 2 abilities (state effects the oracle can drive: each was probed against the real game, see ROMDIFF.md section 7)
  const ab2 = (ab, label, aMove, o = {}) => { const side = o.side || 'b'; const sd = { ...(o[side] || {}), ability: ab }; add('ability-new', ab + ' ' + label, side === 'a' ? sd : (o.a || {}), side === 'b' ? sd : (o.b || {}), aMove, o.bMove || null, o.extra); };
  ab2('Force Return', 'pound', 'Pound'); ab2('Cotton Down', 'pound', 'Pound'); ab2('Water Compaction', 'surf', 'Surf'); ab2('Solidify', 'special hit', 'Flamethrower');
  ab2('Steam Engine', 'fire hit', 'Flamethrower'); ab2('Steam Engine', 'water hit', 'Surf'); ab2('Thermal Exchange', 'fire hit', 'Flamethrower'); ab2('Thermal Exchange', 'will-o-wisp', 'Will-O-Wisp');
  ab2('Inky', 'pound', 'Pound'); ab2('Blazing Sun', 'ember', 'Ember', { side: 'a' }); ab2('Lifesteal', 'pound', 'Pound', { side: 'a', a: { hp: 300 } }); ab2('Spectral Drain', 'earthquake', 'Earthquake', { side: 'a', a: { hp: 300 } });
  ab2('Lunar Cycle', 'pound', 'Pound', { side: 'a' }); ab2('Seer', 'psychic', 'Psychic', { side: 'a' }); ab2('Bloodlust', 'crit move', 'Frost Breath', { side: 'a' }); ab2('Maim and Mend', 'crit move', 'Frost Breath', { side: 'a', a: { hp: 300 } });
  ab2('Magician', 'steal berry', 'Pound', { side: 'a', b: { item: 'Oran Berry' } }); ab2('Pickpocket', 'contact', 'Body Slam', { b: {}, a: { item: 'Oran Berry' } });
  ab2('Arctic Aura', 'eot', 'Splash', { side: 'a' }); ab2('Stormrider', 'eot', 'Splash', { side: 'a' }); ab2('Volcano Howl', 'eot', 'Splash', { side: 'a' });
  ab2('Bad Dreams', 'foe asleep', 'Splash', { side: 'a', b: { status: 'slp' } }); ab2('Rejuvenation', 'hurt no hit', 'Splash', { b: { hp: 300 } }); ab2('Glacial', 'snow', 'Splash', { b: { hp: 300 }, extra: { weather: 'snow' } });
  ab2('Good as Gold', 'thunder wave', 'Thunder Wave'); ab2('Solar Armor', 'thunder wave', 'Thunder Wave'); ab2('Abyssal Veil', 'full hp thunder wave', 'Thunder Wave'); ab2('Abyssal Veil', 'hp 60 percent', 'Thunder Wave', { b: { hp: 240 } });
  ab2('Magic Bounce', 'thunder wave', 'Thunder Wave'); ab2('Magic Bounce', 'growl', 'Growl'); ab2('Dazzling', 'quick attack', 'Quick Attack'); ab2('Armor Tail', 'quick attack', 'Quick Attack'); ab2('Sweet Veil', 'sleep powder', 'Sleep Powder');
  ab2('Stone Face', 'huge hit', 'Earthquake', { a: { st: { atk: 3000 } } }); ab2('Nine Lives', 'huge hit', 'Earthquake', { a: { st: { atk: 3000 } } });
  ab2('Wind Rider', 'gust', 'Gust'); ab2('Wind Chime', 'gust', 'Gust'); ab2('Smouldering', 'surf', 'Surf'); ab2('Ritualist', 'shadow ball', 'Shadow Ball', { b: { hp: 200 } }); ab2('Eelevate', 'earthquake', 'Earthquake');
  ab2('Electromorphosis', 'pound then thunderbolt', 'Pound', { bMove: 'Thunderbolt' }); ab2('Wind Power', 'gust then thunderbolt', 'Gust', { bMove: 'Thunderbolt' }); ab2('Spicy Spray', 'pound', 'Pound');
  ab2('Aura Shield', 'two pounds', 'Pound', { extra: { seq: ['Pound', 'Pound'] } }); ab2('Parental Bond', 'pound', 'Pound', { side: 'a' }); ab2('Dual Strike', 'pound', 'Pound', { side: 'a' }); ab2('Dual Strike', 'flamethrower', 'Flamethrower', { side: 'a' });
  ab2('Long Reach', 'contact vs rough skin', 'Body Slam', { side: 'a', b: { ability: 'Rough Skin' } }); ab2('Cheek Pouch', 'sitrus', 'Pound', { b: { item: 'Sitrus Berry', hp: 120 } });
  ab2('Dancer', 'foe dance', 'Swords Dance'); ab2('Opportunist', 'foe raises', 'Swords Dance'); ab2('Liquid Voice', 'sound move', 'Hyper Voice', { side: 'a' }); ab2('Momentum', 'priority move', 'Quick Attack', { side: 'a' });
  ab2('Mirror Armor', 'growl', 'Growl'); ab2('Sand Spit', 'hit', 'Pound'); ab2('Brimstone', 'fire into flash fire', 'Flamethrower', { side: 'a', b: { ability: 'Flash Fire' } });
  ab2('Phantom Soul', 'ghost stab', 'Shadow Ball', { side: 'a', b: { types: ['Psychic'] } }); ab2('Steely Spirit', 'steel move', 'Iron Head', { side: 'a' });
  // I. round 2 held items (each probed against the real game; state effects only)
  const it2 = (item, label, aMove, o = {}) => { const side = o.side || 'a'; const sd = { ...(o[side] || {}), item }; add('item-new', item + ' ' + label, side === 'a' ? sd : (o.a || {}), side === 'b' ? sd : (o.b || {}), aMove, o.bMove || null, o.extra); };
  it2('Fire Gem', 'matching move', 'Flamethrower'); it2('Fire Gem', 'other move', 'Pound'); it2('Normal Gem', 'matching move', 'Pound');
  it2('Iron Ball', 'earthquake hits flying holder', 'Earthquake', { side: 'b', b: { types: ['Flying'] } });
  it2('Absorb Bulb', 'water hit', 'Surf', { side: 'b' }); it2('Absorb Bulb', 'other hit', 'Pound', { side: 'b' }); it2('Cell Battery', 'electric hit', 'Thunderbolt', { side: 'b' });
  it2('Luminous Moss', 'water hit', 'Surf', { side: 'b' }); it2('Snowball', 'ice hit', 'Ice Beam', { side: 'b' }); it2('Throat Spray', 'sound move', 'Hyper Voice');
  it2('Punching Glove', 'punch', 'Fire Punch'); it2('Punching Glove', 'non-punch', 'Pound');
  it2('Metronome', 'second use', 'Pound', { extra: { seq: ['Pound', 'Pound'] } }); it2('Metronome', 'third use', 'Pound', { extra: { seq: ['Pound', 'Pound', 'Pound'] } });
  it2('Kee Berry', 'physical hit', 'Pound', { side: 'b' }); it2('Maranga Berry', 'special hit', 'Flamethrower', { side: 'b' }); it2('Jaboca Berry', 'physical hit', 'Pound', { side: 'b' }); it2('Rowap Berry', 'special hit', 'Flamethrower', { side: 'b' });
  it2('Sticky Barb', 'holder end of turn', 'Splash', { side: 'b' }); it2('Sticky Barb', 'contact vs itemless attacker', 'Body Slam', { side: 'b' });
  it2('Safety Goggles', 'sandstorm', 'Splash', { side: 'b', extra: { weather: 'sand' } }); it2('Safety Goggles', 'spore', 'Spore', { side: 'b' });
  it2('Utility Umbrella', 'rain vs fire hit', 'Flamethrower', { side: 'b', extra: { weather: 'rain' } });
  it2('Ring Target', 'ghost holder hit by normal', 'Pound', { side: 'b', b: { types: ['Ghost'] } }); it2('Binding Band', 'bind damage', 'Wrap');
  it2('Enigma Berry', 'super effective hit', 'Flamethrower', { side: 'b', b: { types: ['Grass'], hp: 200 } });
  it2('Mental Herb', 'taunted', 'Taunt', { side: 'b', bMove: 'Swords Dance' }); it2('Room Service', 'trick room', 'Trick Room', { side: 'b' });
  it2('Leek', 'farfetchd crit', 'Slash', { a: { species: 83 } }); it2('Lucky Punch', 'chansey crit', 'Slash', { a: { species: 113 } });
  it2('Soul Dew', 'latios psychic', 'Psychic', { a: { species: 381 } }); it2('Soul Dew', 'latios pound', 'Pound', { a: { species: 381 } });
  it2('Metal Powder', 'ditto physical hit', 'Pound', { side: 'b', b: { species: 132 } });
  it2('Adamant Orb', 'dialga dragon', 'Dragon Claw', { a: { species: 483 } }); it2('Lustrous Orb', 'palkia water', 'Surf', { a: { species: 484 } });
  // J. round 2 moves (each class was run in the real game first; hp, stat stages, status, weather, side bits and item flags are compared)
  const mvn = (mv, label, a, b, extra, bMove) => add('move-new', mv + (label ? ' ' + label : ''), a || {}, b || {}, mv, bMove || null, extra);
  mvn('Charge', 'then Thunderbolt', {}, {}, { seq: ['Charge', 'Thunderbolt'] }); mvn('Clangorous Soul'); mvn('Fillet Away'); mvn('No Retreat'); mvn('Victory Dance'); mvn('Take Heart', 'burned', { status: 'brn' });
  mvn('Power Swap', '', { stages: { atk: 2 } }, { stages: { spa: 1 } }); mvn('Guard Swap', '', { stages: { def: 2 } }); mvn('Heart Swap', '', { stages: { atk: 2 } }, { stages: { spe: -1 } }); mvn('Psych Up', '', {}, { stages: { atk: 2, spe: 1 } });
  mvn('Tar Shot'); mvn('Venom Drench', 'poisoned', {}, { status: 'psn' }); mvn('Venom Drench', 'healthy'); mvn('Topsy-Turvy', '', {}, { stages: { atk: 2, def: -1 } }); mvn('Nightmare', 'sleeping foe', {}, { status: 'slp' });
  mvn('Stockpile'); mvn('Stockpile', 'then Spit Up', {}, {}, { seq: ['Stockpile', 'Spit Up'] }); mvn('Stockpile', 'then Swallow', { hp: 200 }, {}, { seq: ['Stockpile', 'Swallow'] });
  mvn('Pursuit'); mvn('Beat Up'); mvn('Round'); mvn('Retaliate'); mvn('Judgment'); mvn('Techno Blast'); mvn('Multi-Attack'); mvn('Photon Geyser', '', { st: { atk: 200, spa: 100 } }); mvn('Ice Spinner'); mvn('Tera Blast');
  mvn('Heal Pulse', '', {}, { hp: 200 }); mvn('Floral Healing', '', {}, { hp: 200 }); mvn('Jungle Healing', '', { hp: 200, status: 'brn' }); mvn('Lunar Blessing', '', { hp: 200, status: 'brn' });
  mvn('Skull Bash'); mvn('Spicy Extract'); mvn('Chilly Reception'); mvn('Tidy Up'); mvn('Psycho Shift', '', { status: 'brn' }); mvn('Trump Card'); mvn('Nature Power'); mvn('Secret Power');
  mvn('Magic Coat', 'vs Thunder Wave', {}, {}, null, 'Thunder Wave'); mvn('Snatch', 'vs Swords Dance', {}, {}, null, 'Swords Dance'); mvn('Electrify', 'then Pound', {}, {}, null, 'Pound'); mvn('Mirror Move', 'after Pound', {}, {}, null, 'Pound');
  // K. frostbite (round 3): residual, special-damage halving, Facade, Ice-type immunity is a chance probe (not here)
  add('frostbite', 'residual on the target', {}, { status: 'fbt' }, 'Splash', null); add('frostbite', 'residual on the user', { status: 'fbt' }, {}, 'Splash', null);
  add('frostbite', 'Pound while frostbitten', { status: 'fbt' }, {}, 'Pound', null); add('frostbite', 'Flamethrower while frostbitten', { status: 'fbt' }, {}, 'Flamethrower', null); add('frostbite', 'Facade while frostbitten', { status: 'fbt' }, {}, 'Facade', null);
  add('frostbite', 'Fire move does not thaw it', {}, { status: 'fbt' }, 'Flamethrower', null); add('frostbite', 'Magic Guard blocks the residual', { status: 'fbt', ability: 'Magic Guard' }, {}, 'Splash', null);
  // L. terrain and Gravity (round 3).  Every scenario was run in the real game first; hp, stages, status, confusion, items and the field word (fld) are compared.
  const T4 = ['grassy', 'electric', 'psychic', 'misty'];
  const rep6 = (mv, n) => [mv, ...Array(n).fill('Splash')];
  for (const fl of T4) add('terrain', fl + ' end of turn, both hurt', { hp: 300 }, { hp: 300 }, 'Splash', null, { field: [fl] });
  add('terrain', 'grassy end of turn, flying holder', { hp: 300, types: ['Flying'] }, { hp: 300 }, 'Splash', null, { field: ['grassy'] });
  add('terrain', 'grassy end of turn, Levitate holder', { hp: 300, ability: 'Levitate' }, { hp: 300 }, 'Splash', null, { field: ['grassy'] });
  add('terrain', 'grassy end of turn, Iron Ball flying holder', { hp: 300, types: ['Flying'], item: 'Iron Ball' }, { hp: 300 }, 'Splash', null, { field: ['grassy'] });
  add('terrain', 'grassy lasts 5 turns (field word)', { hp: 100 }, {}, 'Splash', null, { field: ['grassy'], seq: ['Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  for (const [mv, fl] of [['Grassy Terrain', 'grassy'], ['Electric Terrain', 'electric'], ['Psychic Terrain', 'psychic'], ['Misty Terrain', 'misty']]) {
    add('terrain', mv + ' then 6 turns', { hp: 100 }, {}, mv, null, { seq: rep6(mv, 5) });
    add('terrain', mv + ' used twice (the second fails)', { hp: 100 }, {}, mv, null, { seq: [mv, mv, 'Splash'] });
    add('terrain', mv + ' used by the foe', { hp: 100 }, {}, 'Splash', mv, { seq: ['Splash', 'Splash'] });
  }
  add('terrain', 'Grassy Terrain with a Terrain Extender, 9 turns', { hp: 100, item: 'Terrain Extender' }, {}, 'Grassy Terrain', null, { seq: rep6('Grassy Terrain', 8) });
  add('terrain', 'Grassy Terrain set by the foe with a Terrain Extender', { hp: 100 }, { item: 'Terrain Extender' }, 'Splash', 'Grassy Terrain', { seq: rep6('Splash', 8) });
  add('terrain', 'Electric Terrain replaces Grassy Terrain', { hp: 100 }, {}, 'Electric Terrain', null, { field: ['grassy'], seq: ['Electric Terrain', 'Splash'] });
  // sleep, paralysis, poison, burn, confusion, yawn
  for (const [mv, fl] of [['Spore', 'electric'], ['Spore', 'misty'], ['Spore', 'grassy'], ['Thunder Wave', 'electric'], ['Thunder Wave', 'misty'], ['Toxic', 'misty'], ['Toxic', 'electric'], ['Will-O-Wisp', 'misty'], ['Confuse Ray', 'misty'], ['Confuse Ray', 'electric'], ['Swagger', 'misty'], ['Swagger', 'electric'], ['Growl', 'misty'], ['Sleep Powder', 'electric'], ['Hypnosis', 'electric']]) {
    add('terrain', mv + ' under ' + fl + ' terrain, grounded target', {}, {}, mv, null, { field: [fl] });
    add('terrain', mv + ' under ' + fl + ' terrain, flying target', {}, { types: ['Flying'] }, mv, null, { field: [fl] });
  }
  add('terrain', 'Spore under electric terrain, Levitate target', {}, { ability: 'Levitate' }, 'Spore', null, { field: ['electric'] });
  add('terrain', 'Spore under electric terrain, Electromagnetism target', {}, { ability: 'Electromagnetism' }, 'Spore', null, { field: ['electric'] });
  add('terrain', 'Thunder Wave under misty terrain, Electromagnetism target', {}, { ability: 'Electromagnetism' }, 'Thunder Wave', null, { field: ['misty'] });
  for (const fl of ['electric', 'misty']) { add('terrain', 'Yawn under ' + fl + ' terrain', {}, {}, 'Yawn', null, { field: [fl], seq: ['Yawn', 'Splash', 'Splash'] }); add('terrain', 'Yawn under ' + fl + ' terrain, flying target', {}, { types: ['Flying'] }, 'Yawn', null, { field: [fl], seq: ['Yawn', 'Splash', 'Splash'] }); }
  add('terrain', 'Yawn then Electric Terrain from the foe', {}, {}, 'Yawn', 'Electric Terrain', { seq: ['Yawn', 'Splash', 'Splash'] });
  add('terrain', 'Rest under electric terrain', { hp: 100 }, {}, 'Rest', null, { field: ['electric'] });
  // psychic terrain blocks priority moves aimed at a grounded target
  for (const mv of ['Quick Attack', 'Aqua Jet', 'Mach Punch', 'Pound', 'Bullet Punch']) {
    add('terrain', mv + ' under psychic terrain, grounded target', {}, {}, mv, null, { field: ['psychic'] });
    add('terrain', mv + ' under psychic terrain, flying target', {}, { types: ['Flying'] }, mv, null, { field: ['psychic'] });
  }
  add('terrain', 'Prankster Thunder Wave under psychic terrain', { ability: 'Prankster' }, {}, 'Thunder Wave', null, { field: ['psychic'] });
  add('terrain', 'Protect under psychic terrain', {}, {}, 'Protect', null, { field: ['psychic'] });
  add('terrain', 'Quick Attack under electric terrain', {}, {}, 'Quick Attack', null, { field: ['electric'] });
  // moves that read the terrain
  for (const fl of T4) {
    add('terrain', 'Nature Power under ' + fl + ' terrain', {}, {}, 'Nature Power', null, { field: [fl] });
    add('terrain', 'Nature Power under ' + fl + ' terrain, flying user', { types: ['Flying'] }, {}, 'Nature Power', null, { field: [fl] });
    add('terrain', 'Secret Power under ' + fl + ' terrain', {}, {}, 'Secret Power', null, { field: [fl] });
    add('terrain', 'Camouflage under ' + fl + ' terrain', {}, {}, 'Camouflage', null, { field: [fl] });
    add('terrain', 'Terrain Pulse under ' + fl + ' terrain', {}, {}, 'Terrain Pulse', null, { field: [fl] });
  }
  add('terrain', 'Floral Healing under grassy terrain', {}, { hp: 100 }, 'Floral Healing', null, { field: ['grassy'] });
  add('terrain', 'Floral Healing under grassy terrain, flying target', {}, { hp: 100, types: ['Flying'] }, 'Floral Healing', null, { field: ['grassy'] });
  add('terrain', 'Floral Healing under electric terrain', {}, { hp: 100 }, 'Floral Healing', null, { field: ['electric'] });
  add('terrain', 'Floral Healing at 301 max hp, grassy', {}, { hp: 100, maxhp: 301 }, 'Floral Healing', null, { field: ['grassy'] });
  add('terrain', 'Floral Healing at 403 max hp, grassy', {}, { hp: 100, maxhp: 403 }, 'Floral Healing', null, { field: ['grassy'] });
  for (const mv of ['Steel Roller', 'Ice Spinner']) {
    for (const fl of ['grassy', 'psychic']) add('terrain', mv + ' under ' + fl + ' terrain removes it', { hp: 100 }, {}, mv, null, { field: [fl], seq: [mv, 'Splash', 'Splash'] });
  }
  add('terrain', 'Steel Roller without a terrain', { hp: 100 }, {}, 'Steel Roller', null, { seq: ['Steel Roller', 'Splash'] });
  add('terrain', 'Ice Spinner without a terrain', { hp: 100 }, {}, 'Ice Spinner', null, { seq: ['Ice Spinner', 'Splash'] });
  add('terrain', 'Splintered Stormshards under electric terrain', { hp: 100 }, {}, 'Splintered Stormshards', null, { field: ['electric'], seq: ['Splintered Stormshards', 'Splash'] });
  add('terrain', 'Sleep Talk under misty terrain', {}, {}, 'Splash', null, { field: ['misty'] });
  // seeds
  for (const [sd, fl] of [['Electric Seed', 'electric'], ['Grassy Seed', 'grassy'], ['Misty Seed', 'misty'], ['Psychic Seed', 'psychic']]) {
    add('terrain', sd + ' held by the foe, ' + fl + ' terrain set by the user', {}, { item: sd }, fl[0].toUpperCase() + fl.slice(1) + ' Terrain', null);
    add('terrain', sd + ' held by the user, ' + fl + ' terrain set by the foe', { item: sd }, {}, 'Splash', fl[0].toUpperCase() + fl.slice(1) + ' Terrain');
    add('terrain', sd + ' held by a flying foe, ' + fl + ' terrain set by the user', {}, { item: sd, types: ['Flying'] }, fl[0].toUpperCase() + fl.slice(1) + ' Terrain', null);
  }
  add('terrain', 'Grassy Seed under electric terrain', {}, { item: 'Grassy Seed' }, 'Electric Terrain', null);
  add('terrain', 'Psychic Seed under misty terrain', {}, { item: 'Psychic Seed' }, 'Misty Terrain', null);
  // abilities
  add('terrain', 'Channel Earth under grassy terrain', { hp: 300, ability: 'Channel Earth' }, {}, 'Splash', null, { field: ['grassy'] });
  add('terrain', 'Channel Earth under electric terrain, flying holder', { hp: 300, ability: 'Channel Earth', types: ['Flying'] }, {}, 'Splash', null, { field: ['electric'] });
  add('terrain', 'Channel Earth without a terrain', { hp: 300, ability: 'Channel Earth' }, {}, 'Splash', null);
  add('terrain', 'Plasma Surge under electric terrain', { ability: 'Plasma Surge' }, {}, 'Pound', null, { field: ['electric'] });
  add('terrain', 'Plasma Surge under electric terrain, electric target', { ability: 'Plasma Surge' }, { types: ['Electric'] }, 'Pound', null, { field: ['electric'] });
  add('terrain', 'Plasma Surge under electric terrain, flying target', { ability: 'Plasma Surge' }, { types: ['Flying'] }, 'Pound', null, { field: ['electric'] });
  add('terrain', 'Plasma Surge under electric terrain, status move', { ability: 'Plasma Surge' }, {}, 'Growl', null, { field: ['electric'] });
  add('terrain', 'Plasma Surge without a terrain', { ability: 'Plasma Surge' }, {}, 'Pound', null);
  add('terrain', 'Seed Sower hit', { hp: 300 }, { ability: 'Seed Sower' }, 'Pound', null, { seq: ['Pound', 'Splash'] });
  add('terrain', 'Seed Sower hit under electric terrain', { hp: 300 }, { ability: 'Seed Sower' }, 'Pound', null, { field: ['electric'], seq: ['Pound', 'Splash'] });
  add('terrain', 'Mimicry: grassy terrain set by the foe, then Flamethrower', {}, { ability: 'Mimicry' }, 'Flamethrower', 'Grassy Terrain', { seq: ['Splash', 'Flamethrower'] });
  add('terrain', 'Mimicry: electric terrain set by the foe, then Ground move', {}, { ability: 'Mimicry' }, 'Earthquake', 'Electric Terrain', { seq: ['Splash', 'Earthquake'] });
  add('terrain', 'Mimicry: misty terrain set by the foe, then Poison move', {}, { ability: 'Mimicry' }, 'Sludge Bomb', 'Misty Terrain', { seq: ['Splash', 'Sludge Bomb'] });
  add('terrain', 'Mimicry: terrain removed by Steel Roller, type returns', { hp: 400 }, { ability: 'Mimicry' }, 'Steel Roller', 'Grassy Terrain', { seq: ['Splash', 'Steel Roller', 'Flamethrower'] });
  add('terrain', 'Quark Drive under electric terrain set by the user', { ability: 'Quark Drive', st: { atk: 150, spe: 100 } }, { st: { spe: 5 } }, 'Electric Terrain', null, { seq: ['Electric Terrain', 'Pound'] });
  add('terrain', 'Quark Drive with the terrain gone', { ability: 'Quark Drive', st: { atk: 150, spe: 100 } }, { st: { spe: 5 } }, 'Steel Roller', null, { field: ['electric'], seq: ['Steel Roller', 'Pound'] });
  add('terrain', 'Hadron Engine under electric terrain', { ability: 'Hadron Engine' }, {}, 'Thunderbolt', null, { field: ['electric'] });
  add('terrain', 'Grass Pelt under grassy terrain, physical', { st: { atk: 300 } }, { ability: 'Grass Pelt', hp: 300 }, 'Pound', null, { field: ['grassy'] });
  // Gravity
  for (const mv of ['Fly', 'Bounce', 'Jump Kick', 'High Jump Kick', 'Splash', 'Magnet Rise', 'Telekinesis', 'Flying Press', 'Sky Drop', 'Pound']) {
    add('gravity', mv + ' under Gravity', {}, {}, mv, 'Harden', { field: ['gravity'] });
    add('gravity', mv + ' chosen before Gravity (the faster foe sets it)', { st: { spe: 5 } }, { st: { spe: 500 } }, mv, 'Gravity');
  }
  add('gravity', 'Gravity then Earthquake x7 against a flier, foe Harden', { hp: 2000, maxhp: 2000 }, { types: ['Flying'], hp: 2000, maxhp: 2000 }, 'Gravity', 'Harden', { seq: ['Gravity', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake'] });
  add('gravity', 'field Gravity, Earthquake x7 against a flier', { hp: 2000, maxhp: 2000 }, { types: ['Flying'], hp: 2000, maxhp: 2000 }, 'Earthquake', 'Harden', { field: ['gravity'], seq: ['Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake'] });
  add('gravity', 'Gravity used twice (the second fails)', { hp: 2000, maxhp: 2000 }, { types: ['Flying'], hp: 2000, maxhp: 2000 }, 'Gravity', 'Harden', { seq: ['Gravity', 'Gravity', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake', 'Earthquake'] });
  add('gravity', 'Gravity brings down a Fly in the air', { st: { spe: 5 } }, { st: { spe: 500 } }, 'Gravity', 'Fly', { seq: ['Gravity', 'Splash'] });
  add('gravity', 'Gravity brings down a Magnet Rise', { hp: 2000, maxhp: 2000, st: { spe: 5 } }, { hp: 2000, maxhp: 2000, st: { spe: 500 } }, 'Gravity', 'Magnet Rise', { seq: ['Earthquake', 'Gravity', 'Earthquake'] });
  add('gravity', 'Gravity and Levitate target, Earthquake', {}, { ability: 'Levitate' }, 'Earthquake', 'Harden', { field: ['gravity'] });
  add('gravity', 'Gravity and an Air Balloon holder, Earthquake', {}, { item: 'Air Balloon' }, 'Earthquake', 'Harden', { field: ['gravity'] });
  add('gravity', 'Gravity and an Allseeing Idol holder, Earthquake', {}, { ability: 'Allseeing Idol' }, 'Earthquake', 'Harden', { field: ['gravity'] });
  add('gravity', 'Gravity and an Allseeing Idol holder, Pound', {}, { ability: 'Allseeing Idol', hp: 400 }, 'Pound', 'Harden', { field: ['gravity'] });
  add('gravity', 'Gravity and an Iron Ball flier, Earthquake', {}, { item: 'Iron Ball', types: ['Flying'] }, 'Earthquake', 'Harden', { field: ['gravity'] });
  add('gravity', 'Pound under Gravity, foe Harden', {}, {}, 'Pound', 'Harden', { field: ['gravity'] });
  add('terrain', 'Rest under misty terrain', { hp: 100 }, {}, 'Rest', null, { field: ['misty'] });
  add('terrain', 'Rest under grassy terrain', { hp: 100 }, {}, 'Rest', null, { field: ['grassy'] });
  add('terrain', 'Rest under electric terrain, flying user', { hp: 100, types: ['Flying'] }, {}, 'Rest', null, { field: ['electric'] });
  // P. Scorched Field and the other things that clear a terrain (round 3)
  add('terrain', 'scorched lasts 5 turns', {}, {}, 'Splash', null, { field: ['scorched'], seq: ['Splash', 'Splash', 'Splash', 'Splash'] });
  add('terrain', 'scorched gone after 5 turns', {}, {}, 'Splash', null, { field: ['scorched'], seq: ['Splash', 'Splash', 'Splash', 'Splash', 'Splash'] });
  add('terrain', 'Grassy Terrain replaces the scorched field', {}, {}, 'Grassy Terrain', null, { field: ['scorched'], seq: ['Grassy Terrain', 'Splash'] });
  add('terrain', 'Electric Terrain set by the foe replaces the scorched field', {}, {}, 'Splash', 'Electric Terrain', { field: ['scorched'], seq: ['Splash', 'Splash'] });
  add('terrain', 'Defog clears the scorched field', {}, {}, 'Defog', null, { field: ['scorched'], seq: ['Defog', 'Splash'] });
  add('terrain', 'Defog clears a grassy terrain', { hp: 100 }, {}, 'Defog', null, { field: ['grassy'], seq: ['Defog', 'Splash'] });
  add('terrain', 'Defog clears an electric terrain', {}, {}, 'Defog', null, { field: ['electric'], seq: ['Defog', 'Splash'] });
  add('terrain', 'Steel Roller under the scorched field', {}, {}, 'Steel Roller', null, { field: ['scorched'], seq: ['Steel Roller', 'Splash'] });
  add('terrain', 'Ice Spinner under the scorched field', {}, {}, 'Ice Spinner', null, { field: ['scorched'], seq: ['Ice Spinner', 'Splash'] });
  add('terrain', 'Rapid Spin does not clear the scorched field', {}, {}, 'Rapid Spin', null, { field: ['scorched'], seq: ['Rapid Spin', 'Splash'] });
  add('terrain', 'Terrain Pulse under the scorched field', {}, {}, 'Terrain Pulse', null, { field: ['scorched'] });
  add('terrain', 'scorched field with a Pound, no effect', {}, {}, 'Pound', null, { field: ['scorched'] });
  add('terrain', 'scorched field and sun together', {}, {}, 'Flamethrower', null, { field: ['scorched'], weather: 'sun' });
  // Q. the moves written for double battles, used in a singles battle (round 3)
  for (const mv of ['Follow Me', 'Rage Powder', 'Spotlight', 'Helping Hand', 'Ally Switch', 'Aromatic Mist', 'Coaching', 'Dragon Cheer', 'Hold Hands']) add('doubles', mv + ' in a singles battle', {}, {}, mv, 'Pound');
  for (const mv of ['After You', 'Quash']) { add('doubles', mv + ', user first', {}, {}, mv, 'Pound'); add('doubles', mv + ', user last', { st: { spe: 5 } }, { st: { spe: 500 } }, mv, 'Pound'); }
  add('doubles', 'Mat Block against Pound', {}, {}, 'Mat Block', 'Pound');
  add('doubles', 'Mat Block against a status move', {}, {}, 'Mat Block', 'Growl');
  add('doubles', 'Mat Block used twice', {}, {}, 'Mat Block', 'Pound', { seq: ['Mat Block', 'Mat Block'] });
  add('doubles', 'Mat Block after a first move', {}, {}, 'Pound', 'Pound', { seq: ['Pound', 'Mat Block'] });
  add('doubles', 'Decorate on the foe, then Pound', {}, {}, 'Decorate', null, { seq: ['Decorate', 'Pound'] });
  for (const [ta, tb] of [[['Normal'], ['Normal']], [['Grass'], ['Normal']], [['Normal'], ['Grass']], [['Grass'], ['Grass']], [['Grass', 'Poison'], ['Normal']], [['Normal'], ['Grass', 'Flying']]]) add('doubles', 'Flower Shield ' + ta.join('/') + ' user, ' + tb.join('/') + ' foe', { types: ta }, { types: tb }, 'Flower Shield', null);
  for (const mv of ['Water Pledge', 'Fire Pledge', 'Grass Pledge']) add('doubles', mv + ' as a plain hit', {}, {}, mv, null);
  // R. volatile conditions and field flags (round 3 batch B1); every scenario is a short sequence so the effect shows in the hp trace, stages, status, types or abilities
  const VA = { st: { atk: 150, def: 80, spa: 120, spd: 90, spe: 500 }, hp: 300, maxhp: 400 }, VB = { st: { atk: 90, def: 130, spa: 100, spd: 110, spe: 5 }, hp: 350, maxhp: 400 };
  const vol = (mv, label, a, b, seq, bMove) => add('vol', mv + (label ? ' ' + label : ''), { ...VA, ...(a || {}), st: { ...VA.st, ...((a || {}).st || {}) } }, { ...VB, ...(b || {}), st: { ...VB.st, ...((b || {}).st || {}) } }, mv, bMove || 'Pound', { seq: seq || [mv, 'Pound', 'Pound'] });
  vol('Torment'); vol('Torment', 'then Pound three times', {}, {}, ['Torment', 'Pound', 'Pound', 'Pound']);
  vol('Imprison'); vol('Embargo', 'against a Sitrus Berry holder', {}, { item: 'Sitrus Berry', hp: 150 }, ['Embargo', 'Pound', 'Pound']);
  vol('Heal Block', 'against Recover', {}, { hp: 150 }, ['Heal Block', 'Splash', 'Splash'], 'Recover'); vol('Heal Block', 'against a Leftovers holder', {}, { item: 'Leftovers', hp: 150 }, ['Heal Block', 'Splash', 'Splash']);
  vol('Gastro Acid', 'against Thick Fat', {}, { ability: 'Thick Fat' }, ['Gastro Acid', 'Flamethrower', 'Flamethrower']); vol('Gastro Acid', 'against Levitate', {}, { ability: 'Levitate' }, ['Gastro Acid', 'Earthquake']);
  vol('Gastro Acid', 'against Neutralizing Gas (fails)', {}, { ability: 'Neutralizing Gas' }, ['Gastro Acid', 'Splash']);
  vol('Miracle Eye', 'against a Dark type', {}, { types: ['Dark'] }, ['Miracle Eye', 'Psychic', 'Psychic']); vol('Miracle Eye', 'against +6 evasion', {}, { stages: { eva: 6 } }, ['Miracle Eye', 'Pound', 'Pound']);
  vol('Laser Focus'); vol('Laser Focus', 'twice', {}, {}, ['Laser Focus', 'Laser Focus', 'Pound']);
  vol('Power Trick'); vol('Power Trick', 'twice', {}, {}, ['Power Trick', 'Power Trick', 'Pound']); vol('Power Shift');
  vol('Guard Split'); vol('Power Split'); vol('Speed Swap', 'then Gyro Ball', {}, {}, ['Speed Swap', 'Gyro Ball', 'Gyro Ball']);
  vol('Mud Sport', 'then Thunderbolt', {}, {}, ['Mud Sport', 'Thunderbolt', 'Thunderbolt']); vol('Water Sport', 'then Flamethrower', {}, {}, ['Water Sport', 'Flamethrower', 'Flamethrower']);
  vol('Mud Sport', 'expires', {}, {}, ['Mud Sport', 'Splash', 'Splash', 'Splash', 'Splash', 'Thunderbolt']); vol('Water Sport', 'then a Water move', {}, {}, ['Water Sport', 'Surf']);
  vol('Wonder Room', 'then Pound and Flamethrower', {}, {}, ['Wonder Room', 'Pound', 'Flamethrower']); vol('Wonder Room', 'used twice', {}, {}, ['Wonder Room', 'Wonder Room', 'Pound']);
  vol('Magic Room', 'with Leftovers on both', { item: 'Leftovers' }, { item: 'Leftovers', hp: 300 }, ['Magic Room', 'Splash', 'Splash']); vol('Magic Room', 'twice', {}, {}, ['Magic Room', 'Magic Room', 'Splash']);
  vol('Perish Song', 'four turns', {}, {}, ['Perish Song', 'Splash', 'Splash', 'Splash'], 'Splash'); vol('Perish Song', 'three turns', {}, {}, ['Perish Song', 'Splash', 'Splash'], 'Splash');
  vol('Powder', 'against Ember', {}, {}, ['Powder', 'Splash'], 'Ember'); vol('Ion Deluge', 'against Pound on a Ground type', { types: ['Ground'] }, {}, ['Ion Deluge', 'Splash']);
  vol('Ion Deluge', 'against Pound, a Normal user', {}, {}, ['Ion Deluge', 'Splash']);
  vol('Entrainment', '', { ability: 'Thick Fat' }, { ability: 'Blaze' }, ['Entrainment', 'Splash']); vol('Entrainment', 'same ability', { ability: 'Thick Fat' }, { ability: 'Thick Fat' }, ['Entrainment', 'Splash']);
  vol('Entrainment', 'onto Neutralizing Gas (fails)', { ability: 'Thick Fat' }, { ability: 'Neutralizing Gas' }, ['Entrainment', 'Splash']); vol('Doodle', '', { ability: 'Thick Fat' }, { ability: 'Blaze' }, ['Doodle', 'Splash']);
  vol('Reflect Type', '', {}, { types: ['Grass', 'Poison'] }, ['Reflect Type', 'Splash']); vol('Conversion', 'a Fire type', { types: ['Fire'] }, {}, ['Conversion', 'Splash']); vol('Conversion', 'already Normal', {}, {}, ['Conversion', 'Splash']);
  vol('Camouflage', 'on a bare field', { types: ['Fire'] }, {}, ['Camouflage', 'Splash']);
  vol('Telekinesis', 'then Earthquake', {}, {}, ['Telekinesis', 'Earthquake', 'Earthquake']); vol('Telekinesis', 'then Thunder', {}, {}, ['Telekinesis', 'Thunder', 'Thunder']);
  vol('Magnet Rise', 'against Earthquake', {}, {}, ['Magnet Rise', 'Splash', 'Splash'], 'Earthquake'); vol('Magnet Rise', 'twice', {}, {}, ['Magnet Rise', 'Magnet Rise', 'Splash'], 'Earthquake');
  vol('Rototiller', 'both Grass types', { types: ['Grass'] }, { types: ['Grass'] }, ['Rototiller', 'Splash']); vol('Rototiller', 'no Grass type', {}, {}, ['Rototiller', 'Splash']); vol('Rototiller', 'a flying Grass type', { types: ['Grass', 'Flying'] }, {}, ['Rototiller', 'Splash']);
  vol('Magnetic Flux', 'with Plus', { ability: 'Plus' }, {}, ['Magnetic Flux', 'Splash']); vol('Magnetic Flux', 'without Plus', {}, {}, ['Magnetic Flux', 'Splash']); vol('Gear Up', 'with Minus', { ability: 'Minus' }, {}, ['Gear Up', 'Splash']);
  // S. the secondary effects of the newer moves (round 3 batch C)
  const dm = (mv, label, a, b, seq, bMove) => add('newhit', mv + (label ? ' ' + label : ''), { ...VA, ...(a || {}), st: { ...VA.st, ...((a || {}).st || {}) } }, { ...VB, ...(b || {}), st: { ...VB.st, ...((b || {}).st || {}) } }, mv, bMove || 'Pound', { seq: seq || [mv, 'Pound', 'Pound'] });
  for (const mv of ['Rage', 'Flame Burst', 'Incinerate', 'Sparkling Aria', 'Throat Chop', 'Core Enforcer', 'Plasma Fists', 'Floaty Fall', 'Glitzy Glow', 'Baddy Bad', 'Sappy Seed', 'Freezy Frost', 'Sparkly Swirl', 'Jaw Lock', 'Scale Shot', 'Eerie Spell', 'Order Up', 'Glaive Rush', 'Salt Cure', 'Syrup Bomb', 'Psychic Noise', 'Genesis Supernova', 'Poltergeist']) dm(mv);
  dm('Rage', 'taking two hits', {}, {}, ['Rage', 'Rage', 'Pound', 'Splash']); dm('Rage', 'then a different move', {}, {}, ['Rage', 'Pound', 'Pound']);
  dm('Incinerate', 'on a berry holder', {}, { item: 'Sitrus Berry' }, ['Incinerate', 'Splash']); dm('Incinerate', 'on a Fire Gem holder', {}, { item: 'Fire Gem' }, ['Incinerate', 'Splash']); dm('Incinerate', 'on a Leftovers holder', {}, { item: 'Leftovers' }, ['Incinerate', 'Splash']);
  dm('Sparkling Aria', 'on a burned foe', {}, { status: 'brn' }, ['Sparkling Aria', 'Splash']); dm('Throat Chop', 'then a sound move', {}, {}, ['Throat Chop', 'Splash', 'Splash'], 'Hyper Voice');
  dm('Core Enforcer', 'after the foe moved', { st: { spe: 5 } }, { ability: 'Levitate', st: { spe: 500 } }, ['Core Enforcer', 'Splash']); dm('Core Enforcer', 'before the foe moved', {}, { ability: 'Levitate' }, ['Core Enforcer', 'Splash']);
  dm('Spectral Thief', 'against +2 Atk and +1 Def', {}, { stages: { atk: 2, def: 1 } }, ['Spectral Thief', 'Pound']); dm('Spectral Thief', 'against no boosts', {}, {}, ['Spectral Thief', 'Pound']);
  dm('Plasma Fists', 'then a Normal move of the foe on a Ground user', { types: ['Ground'] }, {}, ['Plasma Fists', 'Splash']);
  dm('Glitzy Glow', 'then a special hit', {}, {}, ['Glitzy Glow', 'Splash', 'Splash'], 'Flamethrower'); dm('Baddy Bad', 'then a physical hit', {}, {}, ['Baddy Bad', 'Splash', 'Splash'], 'Pound');
  dm('Sappy Seed', 'on a Grass type', {}, { types: ['Grass'] }, ['Sappy Seed', 'Splash']); dm('Freezy Frost', 'with boosts on both sides', { stages: { atk: 2 } }, { stages: { def: 1, spe: -2 } }, ['Freezy Frost', 'Splash']);
  dm('Sparkly Swirl', 'while burned', { status: 'brn' }, {}, ['Sparkly Swirl', 'Splash']); dm('Jaw Lock', 'then a Pound', {}, {}, ['Jaw Lock', 'Pound']);
  dm('Scale Shot', 'four turns', {}, {}, ['Scale Shot', 'Scale Shot', 'Scale Shot', 'Scale Shot']);
  dm('Burning Jealousy', 'the foe raises its stats', {}, {}, ['Burning Jealousy', 'Splash'], 'Swords Dance'); dm('Burning Jealousy', 'no boost', {}, {}, ['Burning Jealousy', 'Splash']);
  dm('Alluring Voice', 'the foe raises its stats', {}, {}, ['Alluring Voice', 'Splash'], 'Swords Dance'); dm('Alluring Voice', 'no boost', {}, {}, ['Alluring Voice', 'Splash']);
  dm('Eerie Spell', 'after the foe used Pound', {}, {}, ['Splash', 'Eerie Spell', 'Splash']); dm('Glaive Rush', 'then the foe hits back and misses are impossible', {}, {}, ['Glaive Rush', 'Splash', 'Pound']);
  dm('Salt Cure', 'on a Water type', {}, { types: ['Water'] }, ['Salt Cure', 'Splash', 'Splash']); dm('Syrup Bomb', 'three turns', {}, {}, ['Syrup Bomb', 'Splash', 'Splash', 'Splash', 'Splash']);
  dm('Psychic Noise', 'then a Recover', {}, { hp: 150 }, ['Psychic Noise', 'Splash', 'Splash', 'Splash'], 'Recover');
  dm('Upper Hand', 'against Pound (fails)', {}, {}, ['Upper Hand', 'Splash']);
  dm('Poltergeist', 'with a Leftovers holder', {}, { item: 'Leftovers' }, ['Poltergeist', 'Splash']); dm('Poltergeist', 'without an item (fails)', {}, {}, ['Poltergeist', 'Splash']);
  // T. batch D: Uproar, Bide, the copying moves, item moves
  const BIG = { hp: 2000, maxhp: 2000 };
  const bd = (mv, label, a, b, seq, bMove) => add('batchd', mv + (label ? ' ' + label : ''), { ...VA, ...(a || {}), st: { ...VA.st, ...((a || {}).st || {}) } }, { ...VB, ...(b || {}), st: { ...VB.st, ...((b || {}).st || {}) } }, mv, bMove || 'Pound', { seq: seq || [mv, 'Pound', 'Pound'], lock: mv === 'Uproar' || mv === 'Bide' || mv === 'Sky Drop' });
  // Uproar: the real game stalls on the third locked turn when its RNG is held at one state (the harness forces it every frame), so its hp trace cannot be compared; the three-turn lock and the messages were read in an unforced run (ROMDIFF.md section 8)

  bd('Bide', 'three turns against Pound', BIG, BIG, ['Bide', 'Splash']); bd('Bide', 'with no damage taken (fails)', BIG, BIG, ['Bide', 'Splash'], 'Splash');
  bd('Last Resort', 'alone'); bd('Last Resort', 'after Splash and Pound', {}, {}, ['Splash', 'Pound', 'Last Resort']);
  bd('Copycat', 'after the foe used Pound', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Copycat', 'Splash']); bd('Copycat', 'first turn (fails)', {}, {}, ['Copycat', 'Splash']);
  bd('Me First', 'against Pound', {}, {}, ['Me First', 'Splash']); bd('Me First', 'against Growl (fails)', {}, {}, ['Me First', 'Splash'], 'Growl'); bd('Me First', 'user last (fails)', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Me First', 'Splash']);
  bd('Assist', 'no party (fails)', {}, {}, ['Assist', 'Splash']);
  bd('Bestow', 'with Leftovers', { item: 'Leftovers' }, {}, ['Bestow', 'Splash']); bd('Bestow', 'no item', {}, {}, ['Bestow', 'Splash']); bd('Bestow', 'foe has an item', { item: 'Leftovers' }, { item: 'Oran Berry' }, ['Bestow', 'Splash']);
  bd('Belch', 'without a berry', {}, {}, ['Belch', 'Splash']); bd('Belch', 'after eating a berry', { item: 'Oran Berry', hp: 210 }, {}, ['Splash', 'Belch', 'Belch']);
  bd('Instruct', 'after the foe used Pound', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Instruct', 'Splash']); bd('Shed Tail', 'no party (fails)', {}, {}, ['Shed Tail', 'Splash']); bd('Baton Pass', 'no party (fails)', {}, {}, ['Baton Pass', 'Splash']);
  bd('Stuff Cheeks', 'with a berry', { item: 'Oran Berry', hp: 100 }, {}, ['Stuff Cheeks', 'Splash']); bd('Stuff Cheeks', 'without a berry', {}, {}, ['Stuff Cheeks', 'Splash']);
  bd('Teatime', 'with berries on both sides', { item: 'Oran Berry', hp: 100 }, { item: 'Sitrus Berry', hp: 100 }, ['Teatime', 'Splash']); bd('Teatime', 'no berries', {}, {}, ['Teatime', 'Splash']);
  bd('Pluck', 'against a Sitrus Berry', { hp: 200 }, { item: 'Sitrus Berry', hp: 150 }, ['Pluck', 'Splash']); bd('Bug Bite', 'against an Oran Berry', { hp: 200 }, { item: 'Oran Berry' }, ['Bug Bite', 'Splash']);
  bd('Pluck', 'against a Cheri Berry on a paralyzed user', { status: 'par' }, { item: 'Cheri Berry' }, ['Pluck', 'Splash']); bd('Bug Bite', 'against a Liechi Berry', {}, { item: 'Liechi Berry' }, ['Bug Bite', 'Splash']); bd('Pluck', 'against a Leftovers holder', {}, { item: 'Leftovers' }, ['Pluck', 'Splash']);
  // U. Fling: the power table was swept item by item; these scenarios re-check a spread of items (power, effect, berry eaten by the target, items that fail) at the standard stats
  for (const it of ['Iron Ball', "King's Rock", 'Razor Fang', 'Flame Orb', 'Toxic Orb', 'Poison Barb', 'Leftovers', 'Potion', 'Lonely Mint', 'Rare Bone', 'Odd Keystone', 'Flame Plate', 'Dread Plate', 'Life Orb', 'Black Glasses', 'Choice Band', 'Eviolite', 'Big Nugget', 'Power Weight', 'Health Feather', 'Wishing Piece', 'Leek', 'Adamant Orb', 'Damp Rock', 'Lucky Punch', 'Icy Rock']) bd('Fling', 'with ' + it, { item: it }, {}, ['Fling', 'Splash']);
  bd('Fling', 'with an Oran Berry on a hurt foe', { item: 'Oran Berry' }, { hp: 100 }, ['Fling', 'Splash']); bd('Fling', 'with a Sitrus Berry on a hurt foe', { item: 'Sitrus Berry' }, { hp: 100 }, ['Fling', 'Splash']);
  bd('Fling', 'with a Cheri Berry on a paralyzed foe', { item: 'Cheri Berry' }, { status: 'par' }, ['Fling', 'Splash']); bd('Fling', 'with a Liechi Berry', { item: 'Liechi Berry' }, {}, ['Fling', 'Splash']);
  bd('Fling', 'with a Great Ball (fails)', { item: 'Great Ball' }, {}, ['Fling', 'Splash']); bd('Fling', 'with no item (fails)', {}, {}, ['Fling', 'Splash']); bd('Fling', 'with a Lum Berry on a burned foe', { item: 'Lum Berry' }, { status: 'brn' }, ['Fling', 'Splash']);
  bd('Fling', 'with a flinch item against a faster foe', { item: "King's Rock", st: { spe: 5 } }, { st: { spe: 500 } }, ['Fling', 'Splash']);
  // X. Natural Gift: the type and power table was swept berry by berry against all 18 defending types (ngsweep, ROMDIFF.md section 8); these re-check the state change: the berry is used up and its own effect does not happen, and every way the move fails
  for (const br of ['Cheri', 'Chesto', 'Leppa', 'Lum', 'Sitrus', 'Bluk', 'Watmel', 'Chilan', 'Roseli', 'Liechi', 'Kee', 'Maranga']) bd('Natural Gift', 'with a ' + br + ' Berry', { item: br + ' Berry' }, {}, ['Natural Gift', 'Natural Gift']);
  bd('Natural Gift', 'with no item (fails)', {}, {}, ['Natural Gift', 'Splash']); bd('Natural Gift', 'with Leftovers (fails)', { item: 'Leftovers' }, {}, ['Natural Gift', 'Splash']);
  bd('Natural Gift', 'with Klutz', { item: 'Cheri Berry', ability: 'Klutz' }, {}, ['Natural Gift', 'Splash']); bd('Natural Gift', 'under Embargo', { item: 'Cheri Berry', st: { spe: 1 } }, {}, ['Natural Gift', 'Splash'], 'Embargo');
  bd('Natural Gift', 'under Magic Room', { item: 'Cheri Berry', st: { spe: 1 } }, {}, ['Natural Gift', 'Natural Gift'], 'Magic Room'); bd('Natural Gift', 'against an Unnerve foe', { item: 'Cheri Berry' }, { ability: 'Unnerve' }, ['Natural Gift', 'Splash']);
  bd('Natural Gift', 'against Protect', { item: 'Cheri Berry', st: { spe: 1 } }, {}, ['Natural Gift', 'Splash'], 'Protect'); bd('Natural Gift', 'a Normal berry against a Ghost foe', { item: 'Chilan Berry' }, { types: ['Ghost'] }, ['Natural Gift', 'Splash']);
  bd('Natural Gift', 'a Fairy berry against a Dragon foe', { item: 'Roseli Berry' }, { types: ['Dragon'] }, ['Natural Gift', 'Splash']); bd('Natural Gift', 'a Fire berry from a Fire user', { item: 'Cheri Berry', types: ['Fire'] }, { types: ['Grass'] }, ['Natural Gift', 'Splash']);
  bd('Natural Gift', 'then Belch', { item: 'Oran Berry', hp: 210 }, {}, ['Natural Gift', 'Belch', 'Splash']); bd('Natural Gift', 'with Cud Chew', { item: 'Oran Berry', ability: 'Cud Chew', hp: 210 }, {}, ['Natural Gift', 'Splash', 'Splash']);
  bd('Natural Gift', 'with a Sitrus Berry at low HP', { item: 'Sitrus Berry', hp: 100 }, {}, ['Natural Gift', 'Splash']);
  // does the berry's own effect happen when Natural Gift uses it up? (isolated from the foe: it only Splashes)
  bd('Natural Gift', 'Oran Berry at low HP, foe idle', { item: 'Oran Berry', hp: 100 }, {}, ['Natural Gift', 'Splash'], 'Splash'); bd('Natural Gift', 'Oran Berry at high HP, foe idle', { item: 'Oran Berry', hp: 300 }, {}, ['Natural Gift', 'Splash'], 'Splash');
  bd('Natural Gift', 'Sitrus Berry at low HP, foe idle', { item: 'Sitrus Berry', hp: 100 }, {}, ['Natural Gift', 'Splash'], 'Splash'); bd('Natural Gift', 'Cheri Berry while paralyzed, foe idle', { item: 'Cheri Berry', status: 'par' }, {}, ['Natural Gift', 'Splash'], 'Splash');
  bd('Natural Gift', 'Liechi Berry at 90 HP, foe idle', { item: 'Liechi Berry', hp: 90 }, {}, ['Natural Gift', 'Splash'], 'Splash'); bd('Natural Gift', 'Lum Berry while burned, foe idle', { item: 'Lum Berry', status: 'brn' }, {}, ['Natural Gift', 'Splash'], 'Splash');
  bd('Natural Gift', 'Liechi Berry at full-ish HP, foe idle', { item: 'Liechi Berry', hp: 300 }, {}, ['Natural Gift', 'Splash'], 'Splash');
  // Y. batch G: Population Bomb, Raging Bull, Ivy Cudgel, Sky Drop (the species-form types were read per species id, ROMDIFF.md section 8)
  bd('Population Bomb', 'ten hits', {}, {}, ['Population Bomb', 'Splash'], 'Splash'); bd('Population Bomb', 'with Skill Link', { ability: 'Skill Link' }, {}, ['Population Bomb', 'Splash'], 'Splash'); bd('Population Bomb', 'with Loaded Dice', { item: 'Loaded Dice' }, {}, ['Population Bomb', 'Splash'], 'Splash');
  for (const sp of [128, 241, 1402, 1403, 1404]) for (const ty of ['Steel', 'Ghost']) bd('Raging Bull', 'species ' + sp + ' against ' + ty, { species: sp }, { types: [ty] }, ['Raging Bull', 'Splash'], 'Splash');
  bd('Raging Bull', 'breaks Reflect (the foe is faster)', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Raging Bull', 'Splash'], 'Reflect');
  for (const sp of [1416, 1417, 1418, 1419]) for (const ty of ['Fire', 'Water']) bd('Ivy Cudgel', 'species ' + sp + ' against ' + ty, { species: sp }, { types: [ty] }, ['Ivy Cudgel', 'Splash'], 'Splash');
  bd('Ivy Cudgel', 'a Pokemon that is not an Ogerpon', {}, { types: ['Water'] }, ['Ivy Cudgel', 'Splash'], 'Splash');
  bd('Conversion 2', 'before the foe has moved (fails)', {}, {}, ['Conversion 2', 'Splash'], 'Splash');
  bd('Shell Side Arm', 'with Atk above Sp. Atk and a weak Defense', { st: { atk: 200, spa: 100 }, species: 978 }, { st: { def: 50, spd: 200 } }, ['Shell Side Arm', 'Splash'], 'Splash'); bd('Shell Side Arm', 'with Sp. Atk above Atk and a weak Sp. Def', { st: { atk: 100, spa: 200 }, species: 978 }, { st: { def: 200, spd: 50 } }, ['Shell Side Arm', 'Splash'], 'Splash');
  bd('Sky Drop', 'the foe is slower', {}, {}, ['Sky Drop', 'Sky Drop', 'Splash'], 'Pound'); bd('Sky Drop', 'the foe is faster', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Sky Drop', 'Sky Drop', 'Splash'], 'Pound');
  bd('Sky Drop', 'against a Flying type', {}, { types: ['Flying'] }, ['Sky Drop', 'Sky Drop', 'Splash'], 'Pound'); bd('Sky Drop', 'against a Substitute (fails)', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Sky Drop', 'Splash'], 'Substitute');
  bd('Sky Drop', 'against a 460 kg Pokemon (Snorlax)', {}, { species: 143 }, ['Sky Drop', 'Sky Drop', 'Splash'], 'Pound'); bd('Sky Drop', 'against a 100 kg Pokemon (Machamp)', {}, { species: 68 }, ['Sky Drop', 'Sky Drop', 'Splash'], 'Pound');
  // Z. batch G innates (level 100 so the innate slots are on): only what the real game showed is modelled
  const inn = (nm, label, a, b, seq, bMove) => add('innate3', nm + ' ' + label, { ...VA, ...(a || {}), inn: [nm], st: { ...VA.st, ...((a || {}).st || {}) } }, { ...VB, ...(b || {}), st: { ...VB.st, ...((b || {}).st || {}) } }, seq[0], bMove || 'Pound', { seq, level: 100 });
  inn('Reborn', 'a lethal hit then a second one', { hp: 150 }, { st: { atk: 800 } }, ['Splash', 'Splash'], 'Pound'); inn('Reborn', 'a survivable hit then a lethal one', { hp: 380 }, { st: { atk: 800 } }, ['Splash', 'Splash'], 'Pound');
  inn('Parrying', 'Focus Punch while being hit', {}, {}, ['Focus Punch', 'Splash'], 'Pound'); add('innate3', 'Focus Punch while being hit, no Parrying (control)', { ...VA }, { ...VB }, 'Focus Punch', 'Pound', { seq: ['Focus Punch', 'Splash'], level: 100 });
  inn('Time Spiral', 'slow Pound against Quick Attack', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Pound', 'Splash'], 'Quick Attack'); inn('Time Spiral', 'slow Quick Attack against Pound', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Quick Attack', 'Splash'], 'Pound');
  inn('Time Spiral', 'fast Pound against Protect', {}, {}, ['Pound', 'Splash'], 'Protect');
  inn('Tidal Deity', 'against Protect at full HP', { hp: 400 }, {}, ['Pound', 'Splash'], 'Protect'); inn('Tidal Deity', 'against Protect below full HP', { hp: 399 }, {}, ['Pound', 'Splash'], 'Protect'); inn('Tidal Deity', 'against Reflect at full HP', { hp: 400, st: { spe: 5 } }, { st: { spe: 500 } }, ['Pound', 'Splash'], 'Reflect');
  // S4. items and moves that were 'unverified' in round 2 and are now driven (ROMDIFF.md section 8.6)
  bd('Fury Attack', 'with Loaded Dice (4 or 5 hits)', { item: 'Loaded Dice' }, {}, ['Fury Attack', 'Splash'], 'Splash'); bd('Fury Attack', 'without Loaded Dice', {}, {}, ['Fury Attack', 'Splash'], 'Splash');
  bd('Wrap', 'with Grip Claw (longer trap)', { item: 'Grip Claw' }, {}, ['Wrap', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'], 'Splash'); bd('Wrap', 'without Grip Claw', {}, {}, ['Wrap', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash', 'Splash'], 'Splash');
  bd('Low Kick', 'against a 235 kg Pokemon (Gyarados)', {}, { species: 130 }, ['Low Kick', 'Splash'], 'Splash'); bd('Low Kick', 'against a 235 kg Pokemon holding Float Stone', {}, { species: 130, item: 'Float Stone' }, ['Low Kick', 'Splash'], 'Splash');
  bd('Pound', 'Custap Berry at a quarter HP, slower than the foe', { item: 'Custap Berry', hp: 90, st: { spe: 5 } }, { st: { spe: 500 } }, ['Pound', 'Splash'], 'Pound');
  bd('Tar Shot', 'then Flamethrower', {}, {}, ['Tar Shot', 'Flamethrower'], 'Splash'); bd('Flamethrower', 'control for Tar Shot', {}, {}, ['Splash', 'Flamethrower'], 'Splash');
  for (const [sp, it] of [[1416, 'Hearthflame Mask'], [1418, 'Wellspring Mask'], [1417, 'Wellspring Mask'], [1419, 'Cornerstone Mask']]) bd('Pound', 'Ogerpon ' + sp + ' with ' + it, { species: sp, item: it, st: { atk: 500 } }, {}, ['Pound', 'Splash'], 'Splash');
  bd('Pound', 'Ogerpon 1418 without a mask', { species: 1418, st: { atk: 500 } }, {}, ['Pound', 'Splash'], 'Splash'); bd('Pound', 'a Marill with a mask (no boost)', { item: 'Hearthflame Mask', st: { atk: 500 } }, {}, ['Pound', 'Splash'], 'Splash');
  bd('Flamethrower', 'Ogerpon 1418 with a mask (special)', { species: 1418, item: 'Hearthflame Mask', st: { spa: 500 } }, {}, ['Flamethrower', 'Splash'], 'Splash');
  // V. batch E: the remaining hit moves and the field swaps
  for (const mv of ['Grav Apple', 'Chloroblast', 'Stone Axe', 'Ceaseless Edge', 'Dynamax Cannon', 'Snipe Shot', 'Tera Starstorm', 'Hyperspace Fury', 'Beak Blast', 'Purify', 'Geomancy', 'Court Change', 'Fusion Flare', 'Fusion Bolt', 'Electro Shot']) bd(mv, '', {}, {}, [mv, 'Splash']);
  bd('Grav Apple', 'under Gravity', {}, {}, ['Grav Apple', 'Splash']); bd('Stone Axe', 'twice', {}, {}, ['Stone Axe', 'Stone Axe', 'Splash']); bd('Ceaseless Edge', 'three times', {}, {}, ['Ceaseless Edge', 'Ceaseless Edge', 'Ceaseless Edge', 'Splash']);
  bd('Purify', 'on a burned foe', {}, { status: 'brn' }, ['Purify', 'Splash']); bd('Purify', 'on a healthy foe (fails)', {}, {}, ['Purify', 'Splash']);
  bd('Geomancy', 'then Pound', {}, {}, ['Geomancy', 'Pound']);
  bd('Court Change', 'with screens up', {}, {}, ['Reflect', 'Court Change', 'Splash']); bd('Court Change', 'with hazards on the foe side', {}, {}, ['Stealth Rock', 'Court Change', 'Splash']);
  bd('Fusion Flare', 'after the foe used Fusion Bolt', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Fusion Flare', 'Splash'], 'Fusion Bolt'); bd('Fusion Bolt', 'first', {}, {}, ['Fusion Bolt', 'Splash'], 'Fusion Flare');
  add('batchd', 'Electro Shot in the rain', { ...VA }, { ...VB }, 'Electro Shot', 'Pound', { seq: ['Electro Shot', 'Splash'], weather: 'rain' }); bd('Electro Shot', 'two turns', {}, {}, ['Electro Shot', 'Pound']);
  bd('Beak Blast', 'against a contact move', { st: { spe: 5 } }, { st: { spe: 500 } }, ['Beak Blast', 'Splash']);
  // W. batch F abilities (contact, move and state abilities that the post-entry writes can drive)
  const ab = (ability, label, a, b, seq, bMove, who) => add('abilityf', ability + ' ' + label, { ...VA, ...(a || {}), st: { ...VA.st, ...((a || {}).st || {}) }, ...(who === 'a' ? { ability } : {}) }, { ...VB, ...(b || {}), st: { ...VB.st, ...((b || {}).st || {}) }, ...(who === 'b' ? { ability } : {}) }, (seq || ['Pound'])[0], bMove || 'Pound', { seq: seq || ['Pound', 'Pound'] });
  ab('Perish Body', 'contact hit', {}, {}, ['Pound', 'Splash', 'Splash', 'Splash'], 'Splash', 'b'); ab('Perish Body', 'special hit (no effect)', {}, {}, ['Flamethrower', 'Splash'], 'Splash', 'b');
  ab('As One', 'holder attacks (Unnerve: berries off)', { item: 'Sitrus Berry', hp: 150 }, {}, ['Pound', 'Splash'], 'Splash', 'b');
  ab('Poison Puppeteer', 'Toxic', {}, {}, ['Toxic', 'Splash'], 'Splash', 'a'); ab('Poison Puppeteer', 'Poison Jab', {}, {}, ['Poison Jab', 'Splash'], 'Splash', 'a');
  ab('Rolling Stones', 'Rollout twice', {}, {}, ['Rollout', 'Rollout'], 'Splash', 'a');
  ab('Overload', 'against Eviolite', {}, { item: 'Eviolite' }, ['Pound', 'Splash'], 'Splash', 'a');
  add('abilityf', 'Mudslide in a sandstorm', { ...VA }, { ...VB, ability: 'Mudslide' }, 'Surf', 'Splash', { seq: ['Surf', 'Splash'], weather: 'sand' }); ab('Mudslide', 'a Water move without sand', {}, {}, ['Surf', 'Splash'], 'Splash', 'b');
  ab('Null Space', 'against Protect', {}, {}, ['Pound', 'Splash'], 'Protect', 'a'); ab('Null Space', 'without protection', {}, {}, ['Pound', 'Splash'], 'Splash', 'a');
  ab('Pendulum', 'four Pounds', {}, {}, ['Pound', 'Pound', 'Pound', 'Pound'], 'Splash', 'a');
  ab('Titan Grip', 'Close Combat', {}, {}, ['Close Combat', 'Splash'], 'Splash', 'a'); ab('Valkyrie', 'against Poison and Normal moves', {}, {}, ['Splash', 'Splash'], 'Sludge Bomb', 'a');
  ab('Valkyrie', 'against a Normal move', {}, {}, ['Splash', 'Splash'], 'Pound', 'a'); ab('Valkyrie', 'against a Fire move', {}, {}, ['Splash', 'Splash'], 'Flamethrower', 'a'); ab('Valkyrie', 'against a Fairy move', {}, {}, ['Splash', 'Splash'], 'Moonblast', 'a');
  ab('Like a Dragon', 'against Fire', {}, {}, ['Splash', 'Splash'], 'Flamethrower', 'a'); ab('Like a Dragon', 'against Ice (no weakness)', {}, {}, ['Splash', 'Splash'], 'Ice Beam', 'a'); ab('Like a Dragon', 'a Dragon move', {}, {}, ['Dragon Claw', 'Splash'], 'Splash', 'a');
  ab('Cud Chew', 'Oran Berry eaten twice', { hp: 210, item: 'Oran Berry' }, {}, ['Splash', 'Splash', 'Splash'], 'Pound', 'a'); ab('Ripen', 'Oran Berry', { hp: 210, item: 'Oran Berry' }, {}, ['Splash', 'Splash'], 'Pound', 'a'); ab('Ripen', 'Sitrus Berry', { hp: 210, item: 'Sitrus Berry' }, {}, ['Splash', 'Splash'], 'Pound', 'a');
  ab('Reef Warden', 'contact hit then Recover', {}, { hp: 150 }, ['Pound', 'Splash'], 'Recover', 'b'); ab('Martyr', 'a plain hit', {}, {}, ['Pound', 'Splash'], 'Splash', 'b');
  ab('Brand of Torment', 'contact hit (fixed draw)', {}, {}, ['Pound', 'Pound'], 'Splash', 'b');
  // O. Permafrost, Neutralizing Gas, Ruin (round 3)
  add('ruin', 'Permafrost against Will-O-Wisp', {}, { ability: 'Permafrost' }, 'Will-O-Wisp', null);
  add('ruin', 'Permafrost against Growl', {}, { ability: 'Permafrost' }, 'Growl', null);
  add('ruin', 'Permafrost against Screech', {}, { ability: 'Permafrost' }, 'Screech', null);
  add('ruin', 'Permafrost against Toxic', {}, { ability: 'Permafrost' }, 'Toxic', null);
  add('ruin', 'Permafrost holder attacks, fixed draw', { ability: 'Permafrost' }, {}, 'Pound', null);
  add('ruin', 'Permafrost holder, Splash only', { ability: 'Permafrost' }, {}, 'Splash', null);
  // N. primal weathers (round 3)
  for (const w of ['hrain', 'hsun', 'winds']) {
    for (const mv of ['Sunny Day', 'Rain Dance', 'Sandstorm', 'Hail', 'Snowscape']) add('primal', mv + ' under ' + w, {}, {}, mv, null, { weather: w });
    add('primal', w + ' lasts 7 turns', {}, {}, 'Pound', null, { weather: w, seq: ['Pound', 'Pound', 'Pound', 'Pound', 'Pound', 'Pound', 'Pound'] });
  }
  for (const [w, mv] of [['hrain', 'Flamethrower'], ['hrain', 'Surf'], ['hsun', 'Flamethrower'], ['hsun', 'Surf'], ['hsun', 'Water Gun'], ['hrain', 'Will-O-Wisp'], ['hsun', 'Hydro Pump'], ['hrain', 'Fire Blast'], ['hrain', 'Thunder'], ['hsun', 'Solar Beam'], ['hsun', 'Ice Beam'], ['hrain', 'Blizzard']]) add('primal', mv + ' under ' + w, {}, {}, mv, null, { weather: w });
  for (const [w, mv, ab, who] of [['hsun', 'Synthesis', null, 'a'], ['hrain', 'Synthesis', null, 'a'], ['hsun', 'Splash', 'Dry Skin', 'b'], ['hrain', 'Splash', 'Dry Skin', 'b'], ['hrain', 'Splash', 'Rain Dish', 'a'], ['hsun', 'Splash', 'Solar Power', 'a'], ['winds', 'Splash', 'Chlorophyll', 'a']]) {
    add('primal', mv + ' ' + (ab || '') + ' under ' + w, who === 'a' ? { hp: 100, ability: ab } : {}, who === 'b' ? { ability: ab } : {}, mv, null, { weather: w });
  }
  for (const mv of ['Ice Beam', 'Thunderbolt', 'Rock Slide']) for (const bt of [['Flying'], ['Flying', 'Grass'], ['Normal']]) add('primal', mv + ' against ' + bt.join('/') + ' under strong winds', {}, { types: bt }, mv, null, { weather: 'winds' });
  add('primal', 'Swift Swim under heavy rain', {}, {}, 'Splash', null, { weather: 'hrain' });
  // M. gender (round 3): infatuation, Captivate, Cute Charm; a = the user, b = the target
  const GP = [['M', 'F'], ['F', 'M'], ['M', 'M'], ['F', 'F'], ['-', 'M'], ['M', '-'], ['-', '-']];
  for (const [ga, gb] of GP) {
    add('gender', 'Attract ' + ga + ' to ' + gb, { gender: ga }, { gender: gb }, 'Attract', null);
    add('gender', 'Captivate ' + ga + ' to ' + gb, { gender: ga }, { gender: gb }, 'Captivate', null);
  }
  add('gender', 'Attract against Oblivious', { gender: 'M' }, { gender: 'F', ability: 'Oblivious' }, 'Attract', null);
  add('gender', 'Attract against Aroma Veil', { gender: 'M' }, { gender: 'F', ability: 'Aroma Veil' }, 'Attract', null);
  add('gender', 'Attract against Own Tempo', { gender: 'M' }, { gender: 'F', ability: 'Own Tempo' }, 'Attract', null);
  add('gender', 'Captivate against Oblivious', { gender: 'M' }, { gender: 'F', ability: 'Oblivious' }, 'Captivate', null);
  add('gender', 'Attract against a Destiny Knot holder', { gender: 'M' }, { gender: 'F', item: 'Destiny Knot' }, 'Attract', null);
  add('gender', 'Attract while holding a Destiny Knot', { gender: 'M', item: 'Destiny Knot' }, { gender: 'F' }, 'Attract', null);
  add('gender', 'Attract twice', { gender: 'M' }, { gender: 'F' }, 'Attract', null, { seq: ['Attract', 'Attract'] });
  add('gender', 'Attract against a protected target', { gender: 'M' }, { gender: 'F' }, 'Attract', 'Protect');
  add('gender', 'Cute Charm contact hit, opposite genders', { gender: 'M' }, { gender: 'F', ability: 'Cute Charm' }, 'Body Slam', null);
  add('gender', 'Cute Charm contact hit, same gender', { gender: 'M' }, { gender: 'M', ability: 'Cute Charm' }, 'Body Slam', null);
  add('gender', 'Cute Charm non-contact hit', { gender: 'M' }, { gender: 'F', ability: 'Cute Charm' }, 'Thunderbolt', null);
  add('gender', 'infatuated user attacks', { gender: 'M', inf: true }, { gender: 'F' }, 'Pound', null);
  add('gender', 'infatuated user attacks, 4 turns', { gender: 'M', inf: true }, { gender: 'F' }, 'Pound', null, { seq: ['Pound', 'Pound', 'Pound', 'Pound'] });
  add('gender', 'infatuated user, status move', { gender: 'M', inf: true }, { gender: 'F' }, 'Growl', null);
  // G. turn order: first mover wins a mutual one-shot (loser faints); a = (spe, move), b = (spe, move); winner is who is left standing
  return out;
}

// ---- entry scenarios: a real species that holds the ability leads the battle (level 100); state compared at the first action menu -------------------
export function buildEntry(pack) {
  const out = []; let n = 0;
  const has = (nm) => pack.abilities.some((a) => a && a.name === nm);
  const add = (group, label, ab, extra) => { if (!has(ab)) return; out.push({ id: ++n, group, label, ab, ...(extra || {}) }); };
  for (const ab of ['Electric Surge', 'Grassy Surge', 'Misty Surge', 'Psychic Surge', 'Hadron Engine']) add('entry-terrain', ab, ab);
  add('entry-terrain', 'Gravity Well', 'Gravity Well');
  for (const [ab, fl] of [['Electric Surge', 'electric'], ['Grassy Surge', 'grassy'], ['Psychic Surge', 'psychic']]) add('entry-terrain', ab + ' while the same terrain is already up', ab, { pre: { field: [fl], timer: 3 } });
  add('entry-terrain', 'Electric Surge replaces a grassy terrain', 'Electric Surge', { pre: { field: ['grassy'], timer: 3 } });
  add('entry-terrain', 'Magnify Field with 3 terrain turns left', 'Magnify Field', { pre: { field: ['grassy'], timer: 3 } });
  add('entry-terrain', 'Magnify Field on a bare field', 'Magnify Field');
  for (const [fl, nm] of [['grassy', 'Grass'], ['electric', 'Electric'], ['misty', 'Misty'], ['psychic', 'Psychic']]) add('entry-terrain', 'Mimicry entering a ' + fl + ' terrain', 'Mimicry', { pre: { field: [fl], timer: 3 } });
  add('entry-terrain', 'Mimicry on a bare field', 'Mimicry');
  for (const [sd, fl] of [['Electric Seed', 'electric'], ['Grassy Seed', 'grassy'], ['Misty Seed', 'misty'], ['Psychic Seed', 'psychic']]) {
    add('entry-terrain', sd + ' entering its terrain', 'Pressure', { item: sd, pre: { field: [fl], timer: 3 } });
    add('entry-terrain', sd + ' entering another terrain', 'Pressure', { item: sd, pre: { field: [fl === 'grassy' ? 'electric' : 'grassy'], timer: 3 } });
  }
  add('entry-terrain', 'Quark Drive with Booster Energy', 'Quark Drive', { item: 'Booster Energy' });
  add('entry-terrain', 'Protosynthesis with Booster Energy', 'Protosynthesis', { item: 'Booster Energy' });
  add('entry-terrain', 'Quark Drive entering an electric terrain with Booster Energy', 'Quark Drive', { item: 'Booster Energy', pre: { field: ['electric'], timer: 3 } });
  add('entry-terrain', 'Protosynthesis entering the sun with Booster Energy', 'Protosynthesis', { item: 'Booster Energy', pre: { weather: 'sun' } });
  for (const ab of ['Drizzle', 'Intimidate', 'Sand Stream', 'Trace', 'Download']) add('entry-base', ab, ab);
  for (const ab of ['Neutralizing Gas', 'Sword of Ruin', 'Beads of Ruin', 'Permafrost']) add('entry-base', ab, ab);
  // Koraidon also has the Speed Boost innate: the engine's entry goes through a switch turn whose end gives it +1 Speed, the real game's first menu comes before any turn ends, so the stat stages are not compared here
  add('entry-base', 'Orichalcum Pulse', 'Orichalcum Pulse', { cmp: ['st', 'wx', 'fld', 'item', 'ty', 'ft', 'gt'] });
  // round 6: both leads at battle start, the order of the two announcements and the weather that stays (the faster enters first, ties side 0; ROMDIFF.md section 10)
  // strictly different speeds only: an exact tie is decided by the real game's RNG (Xerneas against Yveltal at 119 / 119 went to the foe, five other tie runs to the player), the engine keeps side 0 first
  for (const [pa, fa] of [['Mold Breaker', 'Pressure'], ['Pressure', 'Mold Breaker'], ['Drizzle', 'Drought'], ['Drought', 'Drizzle'], ['Cloud Nine', 'Pressure'], ['Pressure', 'Aura Break']])
    add('start-order', pa + ' against ' + fa, pa, { start: true, pAb: pa, fAb: fa });
  // round 5: the announcements the real game prints at entry (ROMDIFF.md section 9); compared as text keys, nothing else
  const ANNS = { cmp: ['ann'], ann: true };
  for (const ab of ['Pressure', 'Mold Breaker', 'Turboblaze', 'Teravolt', 'Dark Aura', 'Fairy Aura', 'Aura Break', 'Cloud Nine', 'Air Lock']) add('entry-ann', ab, ab, ANNS);
  add('entry-ann', 'Frisk, the foe holds an Oran Berry', 'Frisk', { ...ANNS, foeItem: 'Oran Berry' }); add('entry-ann', 'Frisk, the foe holds nothing', 'Frisk', ANNS);
  for (const [lab, mvs] of [['one plain move', ['Pound']], ['a strong move', ['Pound', 'Tackle', 'Earthquake', 'Splash']], ['an OHKO move', ['Pound', 'Fissure', 'Earthquake', 'Splash']], ['a fixed-damage move', ['Seismic Toss', 'Pound', 'Splash']],
    ['a counter move', ['Counter', 'Pound', 'Earthquake', 'Splash']], ['a variable-power move', ['Gyro Ball', 'Pound', 'Splash']], ['a tie, last wins', ['Flamethrower', 'Thunderbolt', 'Ice Beam', 'Splash']], ['the same tie reversed', ['Ice Beam', 'Thunderbolt', 'Flamethrower', 'Splash']],
    ['status moves only', ['Splash', 'Growl']], ['Seismic Toss against Rock Slide', ['Seismic Toss', 'Rock Slide']], ['Counter against Thunder', ['Counter', 'Thunder']], ['an OHKO against Hyper Beam', ['Fissure', 'Hyper Beam']]]) add('entry-ann', 'Forewarn, ' + lab, 'Forewarn', { ...ANNS, foeMoves: mvs });
  for (const [lab, mvs] of [['a neutral move', ['Pound']], ['a Grass move', ['Vine Whip', 'Pound']], ['an OHKO move', ['Guillotine']], ['a Fire move', ['Flamethrower']], ['an Electric move', ['Thunderbolt']], ['a Dark move', ['Bite']], ['a Ghost move', ['Night Shade']], ['a status move', ['Grass Whistle']],
    ['Explosion', ['Explosion']], ['Counter', ['Counter']], ['a mix', ['Pound', 'Bite', 'Splash', 'Earthquake']], ['a Fighting move', ['Karate Chop']], ['a Fighting move of fixed damage', ['Seismic Toss']], ['a Fighting move among others', ['Pound', 'Brick Break', 'Splash']], ['a variable-power Fighting move', ['Low Kick']]]) add('entry-ann', 'Anticipation, ' + lab, 'Anticipation', { ...ANNS, foeMoves: mvs });
  // abilities whose effect is a state set at switch-in (the real game does NOT read the ability afterwards): play a turn after the entry
  add('entry-ruin', 'Neutralizing Gas holder hits a Levitate foe', 'Neutralizing Gas', { then: 'Earthquake', foeSp: 'Gastly' });
  add('entry-ruin', 'Earthquake against a Levitate foe, plain holder', 'Pressure', { then: 'Earthquake', foeSp: 'Gastly' });
  add('entry-ruin', 'Sword of Ruin holder hits a Rattata with Pound', 'Sword of Ruin', { then: 'Pound' });
  add('entry-ruin', 'Sword of Ruin holder, special hit (Def does not matter)', 'Sword of Ruin', { then: 'Flamethrower' });
  add('entry-ruin', 'Beads of Ruin holder hits with a special move', 'Beads of Ruin', { then: 'Flamethrower' });
  add('entry-ruin', 'Beads of Ruin holder, physical hit', 'Beads of Ruin', { then: 'Pound' });
  add('entry-ruin', 'control holder with Pound', 'Pressure', { then: 'Pound' });
  add('entry-ruin', 'control holder with Flamethrower', 'Pressure', { then: 'Flamethrower' });
  add('entry-terrain', 'Heatstorm', 'Heatstorm');
  add('entry-terrain', 'Heatstorm replacing a grassy terrain', 'Heatstorm', { pre: { field: ['grassy'], timer: 3 } });
  add('entry-terrain', 'Magnify Field with a scorched field', 'Magnify Field', { pre: { field: ['scorched'], timer: 3 } });
  add('entry-terrain', 'Mimicry entering a scorched field', 'Mimicry', { pre: { field: ['scorched'], timer: 3 } });
  for (const ab of ['Primordial Sea', 'Desolate Land', 'Delta Stream']) { add('entry-primal', ab, ab); add('entry-primal', ab + ' replacing another weather', ab, { pre: { weather: 'sand' } }); }
  return out;
}

/** Round 6: both leads at battle start (not a switch-in): the announcements in order, the weather that stays, and the two speeds (the live side writes them into the oracle's stats). */
export function engineStart(M, pack, lab, T, sc) {
  const pickBy = (abName) => {
    const abId = pack.abilities.find((a) => a && a.name === abName).id;
    for (const s of pack.species) { if (!s || s.legal === false || !s.innates) continue; const k = s.abilities.indexOf(abId); if (k >= 0) return { s, num: k }; }
    return null;
  };
  const P = pickBy(sc.pAb), F = pickBy(sc.fAb);
  if (!P || !F) return { unsupported: ['no holder'] };
  const sup = M.engine_support.engineSupport(pack);
  const bad = [P, F].filter((h) => !sup.abilities.has(h.s.abilities[h.num])).map((h) => pack.abilities[h.s.abilities[h.num]].name);
  if (bad.length) return { unsupported: ['not supported by the engine: ' + bad.join(', ')] };
  try {
    const rec = (h) => { const r = M.rules.blankRec(h.s.id, pack, 'arena-gen3-standard'); r.abilitySlot = h.num; return r; };
    const b = M.engine.createBattle({ pack, ruleset: 'arena-gen3-standard', teams: [[rec(P)], [rec(F)]], seed: 1, validate: false });
    const ANN_FX = new Set(['pressure', 'mold-breaker', 'turboblaze', 'teravolt', 'dark-aura', 'fairy-aura', 'aura-break', 'weather-lock']);
    const ann = [];
    b.events.forEach((e, i) => { if (e.t !== 'ability') return; if (ANN_FX.has(e.fx)) ann.push(e.fx); else if (e.fx === 'weather') { const w = b.events[i - 1]; ann.push(w && w.t === 'weather' ? (w.w === 1 ? 'rain' : w.w === 2 ? 'sun' : 'weather') : 'weather'); } });
    return { ann, wx: b.s.pw ? b.s.pw : (b.s.wx && b.s.wx[1] > 0 ? b.s.wx[0] : 0), spd: [b.speed(b.act(0)), b.speed(b.act(1))] };
  } catch (e) { return { unsupported: ['threw ' + String((e && e.message) || e).slice(0, 120)] }; }
}

export function engineEntry(M, pack, lab, T, sc, real) {
  const D = lab.D;
  const sup = M.engine_support.engineSupport(pack);
  const abIds = [...new Set([...(real.ab || []), ...(real.inn || [])])];
  const bad = [];
  if (sc.item && !sup.items.has(D.itemByName[sc.item])) bad.push('item ' + sc.item);
  for (const id of real.inn || []) if (!sup.abilities.has(id)) bad.push('innate ' + (pack.abilities[id] || {}).name);
  if (!sup.abilities.has(real.ab[0])) bad.push('ability ' + (pack.abilities[real.ab[0]] || {}).name);
  if (bad.length) return { unsupported: ['not supported by the engine: ' + bad.join(', ')] };
  const spec = {
    a: { moves: ['Splash'], hp: 300, mhp: 300, bench: [{ moves: sc.then ? [sc.then] : ['Splash'] }], benchSpec: { ab: real.ab[0], inn: real.inn, it: sc.item || 0, level: 100, ty: real.ty0[0], hp: 300, mhp: 300 } },
    b: { moves: sc.foeMoves || ['Splash'], ab: real.ab[1], level: 5, ty: real.ty0[1], st: { spe: 50 }, hp: 300, mhp: 300, ...(sc.foeItem ? { it: sc.foeItem } : {}) },
  };
  if (sc.pre && sc.pre.field) Object.assign(spec, fieldSpec(sc.pre.field), sc.pre.field.length ? { tn: fieldSpec(sc.pre.field).tn && [fieldSpec(sc.pre.field).tn[0], sc.pre.timer || 5] } : {});
  if (sc.pre && sc.pre.weather) spec.wx = [{ rain: 1, sun: 2, sand: 3, hail: 4, snow: 5 }[sc.pre.weather], 5];
  let b;
  try {
    b = lab.lab(spec);
    b.rand = fixedDraw;
    b.drain();
    const r0 = b.choose(0, { kind: 'switch', slot: 1 }); const r1 = b.choose(1, { kind: 'move', slot: 0 });
    if (!r0.ok || !r1.ok) return { unsupported: ['choose rejected'] };
    b.advance();
    if (sc.then) {   // the follow-up turn: the entered holder uses its move
      b.drain();
      const r2 = b.choose(0, { kind: 'move', slot: 0 }); const r3 = b.choose(1, { kind: 'move', slot: 0 });
      if (!r2.ok || !r3.ok) return { unsupported: ['choose rejected (follow-up)'] };
      b.advance();
    }
  } catch (e) { return { unsupported: ['threw ' + String((e && e.message) || e).slice(0, 120)] }; }
  const A = b.s.sides[0].team[b.s.sides[0].act], B = b.s.sides[1].team[b.s.sides[1].act];
  const sg = (m) => OBS_STAT_ORDER.map((k) => m.sg[k] | 0);
  const tys = (m) => [...new Set(b.types(m))].sort((x, y) => x - y);
  // the entry announcements of the holder, in the keys of live.mjs annOf()
  const ANN_FX = new Set(['pressure', 'mold-breaker', 'turboblaze', 'teravolt', 'dark-aura', 'fairy-aura', 'aura-break', 'weather-lock', 'frisk', 'forewarn', 'anticipation']);
  const ann = b.events.filter((e) => e.t === 'ability' && e.s === 0 && ANN_FX.has(e.fx)).map((e) => (e.fx === 'frisk' ? 'frisk:' + b.pack.items[e.it].name : e.fx === 'forewarn' ? 'forewarn:' + b.pack.moves[e.mv].name : e.fx));
  return {
    ann,
    hp: [A.hp, B.hp], sg: [sg(A), sg(B)], st: [A.s | 0, B.s | 0], wx: b.s.pw ? b.s.pw : (b.s.wx && b.s.wx[1] > 0 ? b.s.wx[0] : 0), fld: [b.s.tn && b.s.tn[0] !== 5 ? b.s.tn[0] : 0, b.s.gv > 0 ? 1 : 0, b.s.tn && b.s.tn[0] === 5 ? 1 : 0],
    item: [A.it ? 1 : 0, B.it ? 1 : 0], ty: [tys(A), tys(B)], ft: b.s.tn ? b.s.tn[1] + 1 : 0, gt: b.s.gv > 0 ? b.s.gv + 1 : 0,   // the lab ran the end of turn once: add it back
  };
}

// ---- turn order scenarios -----------------------------------------------------------------------------------------------
export function buildOrder(pack) {
  const out = []; let n = 0;
  const has = (nm) => pack.moves.some((m) => m.name === nm);
  const add = (label, a, b, aMove, bMove, extra) => {
    if (!has(aMove) || !has(bMove)) return;
    out.push({ id: ++n, group: 'order', label, aMove, bMove, a: { st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, types: ['Normal'], ability: null, item: null, status: null, stages: {}, hp: 1, maxhp: 400, ...a, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100, ...(a.st || {}) } }, b: { st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, types: ['Normal'], ability: null, item: null, status: null, stages: {}, hp: 1, maxhp: 400, ...b, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100, ...(b.st || {}) } }, weather: null, screens: [], turns: 1, ...(extra || {}) });
  };
  // terrain speed and priority (round 3)
  add('Grassy Glide under grassy terrain beats a faster Pound', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Grassy Glide', 'Pound', { field: ['grassy'] });
  add('Grassy Glide without the terrain loses to a faster Pound', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Grassy Glide', 'Pound');
  add('Grassy Glide under a flying user', { st: { spe: 10 }, types: ['Flying'] }, { st: { spe: 200 } }, 'Grassy Glide', 'Pound', { field: ['grassy'] });
  add('Grassy Glide under electric terrain', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Grassy Glide', 'Pound', { field: ['electric'] });
  add('Mystic Force under psychic terrain', { st: { spe: 60 }, ability: 'Mystic Force' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { field: ['psychic'] });
  add('Mystic Force under psychic terrain, still slower than 2x', { st: { spe: 60 }, ability: 'Mystic Force' }, { st: { spe: 130 } }, 'Tackle', 'Tackle', { field: ['psychic'] });
  add('Mystic Force without the terrain', { st: { spe: 60 }, ability: 'Mystic Force' }, { st: { spe: 100 } }, 'Tackle', 'Tackle');
  add('Mystic Force under electric terrain', { st: { spe: 60 }, ability: 'Mystic Force' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { field: ['electric'] });
  add('Mystic Force under psychic terrain, flying holder', { st: { spe: 60 }, ability: 'Mystic Force', types: ['Flying'] }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { field: ['psychic'] });
  add('Surge Surfer under electric terrain', { st: { spe: 60 }, ability: 'Surge Surfer' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { field: ['electric'] });
  add('Surge Surfer under electric terrain, still slower than 2x', { st: { spe: 60 }, ability: 'Surge Surfer' }, { st: { spe: 130 } }, 'Tackle', 'Tackle', { field: ['electric'] });
  add('Surge Surfer under grassy terrain', { st: { spe: 60 }, ability: 'Surge Surfer' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { field: ['grassy'] });
  add('Surge Surfer under electric terrain, flying holder', { st: { spe: 60 }, ability: 'Surge Surfer', types: ['Flying'] }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { field: ['electric'] });
  add('faster a wins', { st: { spe: 120 } }, { st: { spe: 100 } }, 'Tackle', 'Tackle');
  add('faster b wins', { st: { spe: 100 } }, { st: { spe: 120 } }, 'Tackle', 'Tackle');
  add('speed 1 point faster a', { st: { spe: 101 } }, { st: { spe: 100 } }, 'Tackle', 'Tackle');
  add('speed 1 point faster b', { st: { spe: 100 } }, { st: { spe: 101 } }, 'Tackle', 'Tackle');
  add('stage +1 beats equal', { st: { spe: 100 }, stages: { spe: 1 } }, { st: { spe: 140 } }, 'Tackle', 'Tackle');
  add('stage -1 loses to equal', { st: { spe: 100 }, stages: { spe: -1 } }, { st: { spe: 70 } }, 'Tackle', 'Tackle');
  add('stage +1 at 150 beats 149', { st: { spe: 100 }, stages: { spe: 1 } }, { st: { spe: 149 } }, 'Tackle', 'Tackle');
  add('stage +1 at 150 loses to 151', { st: { spe: 100 }, stages: { spe: 1 } }, { st: { spe: 151 } }, 'Tackle', 'Tackle');
  add('paralysis halves speed (a 100 par vs b 60)', { st: { spe: 100 }, status: 'par' }, { st: { spe: 60 } }, 'Tackle', 'Tackle');
  add('paralysis (a 100 par vs b 40)', { st: { spe: 100 }, status: 'par' }, { st: { spe: 40 } }, 'Tackle', 'Tackle');
  add('paralysis (a 100 par vs b 51)', { st: { spe: 100 }, status: 'par' }, { st: { spe: 51 } }, 'Tackle', 'Tackle');
  add('paralysis (a 100 par vs b 49)', { st: { spe: 100 }, status: 'par' }, { st: { spe: 49 } }, 'Tackle', 'Tackle');
  add('paralysis (a 100 par vs b 26)', { st: { spe: 100 }, status: 'par' }, { st: { spe: 26 } }, 'Tackle', 'Tackle');
  add('paralysis (a 100 par vs b 24)', { st: { spe: 100 }, status: 'par' }, { st: { spe: 24 } }, 'Tackle', 'Tackle');
  add('choice scarf', { st: { spe: 100 }, item: 'Choice Scarf' }, { st: { spe: 140 } }, 'Tackle', 'Tackle');
  add('choice scarf (just below)', { st: { spe: 100 }, item: 'Choice Scarf' }, { st: { spe: 151 } }, 'Tackle', 'Tackle');
  add('quick attack priority beats speed', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Quick Attack', 'Tackle');
  add('priority vs priority, speed decides', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Quick Attack', 'Quick Attack');
  add('fake out +3 beats quick attack +1', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Fake Out', 'Quick Attack');
  add('sucker punch priority (a faster, b status? damaging)', { st: { spe: 10 } }, { st: { spe: 200 } }, 'Aqua Jet', 'Tackle');
  add('swift swim in rain', { st: { spe: 60 }, ability: 'Swift Swim' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { weather: 'rain' });
  add('chlorophyll in sun', { st: { spe: 60 }, ability: 'Chlorophyll' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { weather: 'sun' });
  add('sand rush in sand', { st: { spe: 60 }, ability: 'Sand Rush' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { weather: 'sand' });
  add('slush rush in hail', { st: { spe: 60 }, ability: 'Slush Rush' }, { st: { spe: 100 } }, 'Tackle', 'Tackle', { weather: 'hail' });
  add('swift swim without rain', { st: { spe: 60 }, ability: 'Swift Swim' }, { st: { spe: 100 } }, 'Tackle', 'Tackle');
  add('iron ball halves speed', { st: { spe: 100 }, item: 'Iron Ball' }, { st: { spe: 60 } }, 'Tackle', 'Tackle');
  add('lagging tail goes last', { st: { spe: 200 }, item: 'Lagging Tail' }, { st: { spe: 10 } }, 'Tackle', 'Tackle');
  add('stall goes last', { st: { spe: 200 }, ability: 'Stall' }, { st: { spe: 10 } }, 'Tackle', 'Tackle');
  add('prankster status move priority', { st: { spe: 10 }, ability: 'Prankster' }, { st: { spe: 200 } }, 'Thunder Wave', 'Tackle');
  add('gale wings full hp', { st: { spe: 10 }, ability: 'Gale Wings', hp: 400 }, { st: { spe: 200 } }, 'Drill Peck', 'Tackle');
  add('gale wings not full hp', { st: { spe: 10 }, ability: 'Gale Wings', hp: 1 }, { st: { spe: 200 } }, 'Drill Peck', 'Tackle');
  add('trick room off, slower loses', { st: { spe: 50 } }, { st: { spe: 60 } }, 'Tackle', 'Tackle');
  return out;
}

// ---- the engine side ------------------------------------------------------------------------------------------------------
export function engineTurn(M, pack, lab, T, sc, opts = {}) {
  const missing = [];
  const D = lab.D;
  const sup = M.engine_support.engineSupport(pack);
  const chk = (kind, nm) => { if (nm === null || nm === undefined) return; const tbl = kind === 'ab' ? D.abilityByName : kind === 'it' ? D.itemByName : D.moveByName; if (!(nm in tbl)) { missing.push(kind + ' ' + nm); return; } const set = kind === 'ab' ? sup.abilities : kind === 'it' ? sup.items : sup.moves; if (!set.has(tbl[nm])) missing.push('not supported by the engine (excluded by the rules layer): ' + kind + ' ' + nm); };
  chk('mv', sc.aMove); chk('mv', sc.bMove); chk('ab', sc.a.ability); chk('ab', sc.b.ability); chk('it', sc.a.item); chk('it', sc.b.item);
  if (missing.length) return { unsupported: missing };
  const tid = (nm) => T[nm.toUpperCase()];
  const WX = { rain: 1, sun: 2, sand: 3, hail: 4, snow: 5 };
  const side = (x, mv) => ({
    g: x.gender === 'F' ? 1 : x.gender === '-' ? 2 : undefined, v: x.inf ? { inf: 1 } : undefined, wt: x.species !== undefined && pack.species[x.species] ? pack.species[x.species].weight : undefined,
    moves: [mv], level: sc.level || 50, species: x.species, st: { atk: x.st.atk, def: x.st.def, spa: x.st.spa, spd: x.st.spd, spe: x.st.spe }, ty: x.types.map(tid), ab: x.ability || 0, it: x.item || 0, inn: x.innIds || (x.inn ? x.inn.map((n) => D.abilityByName[n]) : undefined),
    hp: x.hp, mhp: x.maxhp, s: x.status ? STATUS_CODE[x.status] : undefined, sc: x.status === 'tox' ? 1 : x.status === 'slp' ? 2 : undefined, sg: x.stages && Object.keys(x.stages).length ? { ...x.stages } : undefined,
  });
  const seq = sc.seq || Array(sc.turns || 1).fill(sc.aMove);
  const aMoves = [...new Set(seq)];
  const spec = { a: { ...side(sc.a, sc.aMove), moves: aMoves }, b: side(sc.b, sc.bMove) };
  if (sc.weather) { if (sc.weather === 'hrain') { spec.wx = [1, 16]; spec.pw = 6; } else if (sc.weather === 'hsun') { spec.wx = [2, 16]; spec.pw = 7; } else if (sc.weather === 'winds') { spec.wx = [0, 0]; spec.pw = 8; } else spec.wx = [WX[sc.weather], 5]; }
  Object.assign(spec, fieldSpec(sc.field));
  let b;
  const trace = [];
  try {
    b = lab.lab(spec);
    if (sc.sideBits) for (const [who, bits] of Object.entries(sc.sideBits)) for (const bit of bits) b.s.sides[who === 'a' ? 0 : 1][bit] = 5;
    b.rand = sc.drawFrac !== undefined ? ((n) => Math.floor(n * sc.drawFrac)) : fixedDraw;
    // one iteration = one time the player's FIGHT menu is open (locked turns - charge, recharge, rampage - run without a menu, as in the real game)
    for (let t = 0; t < seq.length; t++) {
      b.drain();
      if (b.winner !== null && b.winner !== undefined) break;
      { const A0 = b.s.sides[0].team[b.s.sides[0].act]; const mvId = D.moveByName[seq[t]]; if (mvId !== undefined) A0.mv = [{ id: mvId, pp: 30, mx: 30 }]; }
      let first = true, guard = 0;
      do {
        const reqs = b.requests();
        for (let i = 0; i < 2; i++) {
          const rq = reqs[i];
          if (rq.phase !== 'move') continue;
          let slot = 0;
          const ent = rq.moves.find((x) => x.slot === slot);
          if (!ent || ent.disabled) slot = rq.struggle ? 4 : (rq.moves.find((x) => !x.disabled) || { slot: 4 }).slot;
          const r = b.choose(i, { kind: 'move', slot });
          if (!r.ok) return { unsupported: ['choose rejected side ' + i + ' ' + r.code] };
        }
        b.advance(); first = false;
        if (b.winner !== null && b.winner !== undefined) break;
      } while (b.requests()[0].phase !== 'move' && ++guard < 12);
      trace.push([b.s.sides[0].team[b.s.sides[0].act].hp, b.s.sides[1].team[b.s.sides[1].act].hp]);
    }
  } catch (e) { return { unsupported: ['threw ' + String((e && e.message) || e).slice(0, 120)] }; }
  const A = b.s.sides[0].team[b.s.sides[0].act], B = b.s.sides[1].team[b.s.sides[1].act];
  const sg = (m) => OBS_STAT_ORDER.map((k) => m.sg[k] | 0);
  return {
    trace, hp: [A.hp, B.hp], sg: [sg(A), sg(B)], st: [A.s | 0, B.s | 0], wx: b.s.pw ? b.s.pw : (b.s.wx && b.s.wx[1] > 0 ? b.s.wx[0] : 0),
    side: [0, 1].map((i) => ({ reflect: b.s.sides[i].reflect > 0 ? 1 : 0, light: b.s.sides[i].light > 0 ? 1 : 0, veil: b.s.sides[i].veil > 0 ? 1 : 0, sg: b.s.sides[i].sg > 0 ? 1 : 0, mist: b.s.sides[i].mist > 0 ? 1 : 0, tw: b.s.sides[i].tw > 0 ? 1 : 0 })),
    conf: [A.v.conf ? 1 : 0, B.v.conf ? 1 : 0],
    inf: [A.v.inf ? 1 : 0, B.v.inf ? 1 : 0],
    item: [A.it ? 1 : 0, B.it ? 1 : 0],
    fld: [b.s.tn && b.s.tn[0] !== 5 ? b.s.tn[0] : 0, b.s.gv > 0 ? 1 : 0, b.s.tn && b.s.tn[0] === 5 ? 1 : 0],
    ty: [A, B].map((m) => [...new Set(m.v.ty ? m.v.ty : m.ty)].sort((x, y) => x - y)),   // the STORED types: an ability that adds a type (Phantom Soul) is worked out at use time in the real game, only Trick-or-Treat / Forest's Curse write the third slot
    ab: [A.ab, B.ab],
  };
}

// pokemonarena/js/tower_buffs.js -- the Pokemon Tower's BUFFS: the catalogue (families, tags, synergies) as DATA, and the ONE interpreter that applies it to team records. Pure ES module: no DOM, no clock,
// no storage, no Math.random; inputs are never mutated (a test freezes them). See TOWER.md for the design and the reasons.
//
// WHAT A BUFF IS. A FAMILY (id, name, category, tags, ops) is offered at a TIER (green / blue / purple / gold) and the player may hold it at a POWER: taking a family you hold adds the points of the offered
// tier (green 1, blue 2, purple 4, gold 8), the family's tier is the highest threshold its power has reached, and every numeric amount in its ops is written as four anchors [green, blue, purple, gold] that
// are interpolated linearly at the power (tower_config.js has the arithmetic). So "the same buff again" is never refused: it upgrades (two greens are a blue, two blues a purple, two purples a gold, a gold can still
// grow to the cap with diminishing returns).
//
// WHAT A BUFF CAN DO, AND WHAT IT CANNOT. It edits TEAM RECORDS before a battle (EVs, IVs, nature, held item, ability slot, moves, PP Ups) and shapes the opponent (its team size, EVs, IVs, items, a move, its
// ability and nature) and the run (offer size, rarity odds, extra lives, a look at the next trainer). It cannot change anything the engine cannot already express: no starting HP, no weather, no hazards, no
// damage multipliers (TOWER.md lists the engine hooks that would be needed). Every result stays inside what the ENGINE accepts (EVs <= 255 each, IVs <= 31, PP Ups <= 3, items / moves / abilities the engine can run);
// it deliberately may exceed what the RULESET calls legal (the 510 EV total): the Tower battle is built with validate:false, which only skips the ruleset check.
//
// OP LANGUAGE (an op is a plain object; `who` selects Pokemon; any numeric amount may be an array [green, blue, purple, gold]; an op may carry `tier: n` = only active once the family reached tier n):
//   { op:'ev', who, add:{stat: amt}, set:{stat: n}, mul: amt(permille) }   stat: hp atk def spa spd spe | best (the better attacking stat) | worst | bulk | offense | defense | all
//   { op:'iv', who, min: amt } | { op:'iv', who, set: n }       { op:'nature', who, rule:'attacker'|'swift'|'sturdy'|'neutral' }       { op:'ability', who, slot: 2 }
//   { op:'item', who, give: rule, empty?: true } | { op:'item', who, strip: true }       { op:'pp', who, ups: amt }       { op:'move', who, kind, type? }       { op:'gamble', pm, then:[ops], else:[ops] }
//   opponent: { op:'foe-size', add } { op:'foe-ev-cut', cut(permille) } { op:'foe-ev', add:{stat: amt}, who } { op:'foe-ivcap', max } { op:'foe-items', mode:'none' } { op:'foe-relief', cut(permille) }
//             { op:'foe-defang', n } { op:'foe-ability0' } { op:'foe-neutral' }
//   run:      { op:'run', offer, fortune, bossOffer, lives, reveal }
// SYNERGIES (below) are data too: tag-count sets (3 / 5 families sharing a tag), named combos (specific families together), and multipliers (a speed tag makes the offense families stronger).

import { legalMoves, engineSupports } from './rules.js';
import { createRng } from './ai.js';
import { CONFIG, TIERS, POWER_ANCHORS } from './tower_config.js';

export const CATEGORIES = Object.freeze(['training', 'genes', 'item', 'move', 'foe', 'meta', 'risk', 'type']);
const STATS = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);

/* ---------------------------------------------------------------------------------------------- exact arithmetic */

/** Round half up of n / d for any integer n and d > 0. */
export const roundDiv = (n, d) => Math.floor((2 * n + d) / (2 * d));
/** v * pm / 1000, rounded half up. */
export const mulPm = (v, pm) => roundDiv(v * pm, 1000);
export const tierOfPower = (p) => (p >= 8 ? 3 : p >= 4 ? 2 : p >= 2 ? 1 : 0);
/** An amount at a power: a number is itself; [green, blue, purple, gold] is interpolated at power 1 / 2 / 4 / 8, with a fifth anchor at the cap of gold * capBonusPm / 1000. */
export function scaleAt(amt, power, cfg = CONFIG) {
  if (typeof amt === 'number') return amt;
  const pts = POWER_ANCHORS, vals = [amt[0], amt[1], amt[2], amt[3], mulPm(amt[3], cfg.capBonusPm)];
  const p = Math.max(1, Math.min(cfg.powerCap, power | 0));
  for (let i = 0; i < pts.length - 1; i++) if (p <= pts[i + 1]) return vals[i] + roundDiv((vals[i + 1] - vals[i]) * (p - pts[i]), pts[i + 1] - pts[i]);
  return vals[4];
}

/* ---------------------------------------------------------------------------------------------- the catalogue */

const TYPE_NAMES = Object.freeze({ 1: 'Normal', 2: 'Fighting', 3: 'Flying', 4: 'Poison', 5: 'Ground', 6: 'Rock', 7: 'Bug', 8: 'Ghost', 9: 'Steel', 11: 'Fire', 12: 'Water', 13: 'Grass', 14: 'Electric', 15: 'Psychic', 16: 'Ice', 17: 'Dragon', 18: 'Dark', 19: 'Fairy' });
export const TYPE_IDS = Object.freeze(Object.keys(TYPE_NAMES).map(Number));
export const typeTag = (t) => TYPE_NAMES[t].toLowerCase();

const FAM = [];
const fam = (id, name, cat, tags, ops, o = {}) => FAM.push(Object.freeze({ id, name, cat, tags: Object.freeze(tags), ops: Object.freeze(ops), tiers: o.tiers || [0, 3], w: o.w || 10, curse: !!o.curse, cap: o.cap || 0, blurb: o.blurb || '' }));
const ev = (who, add, extra) => ({ op: 'ev', who, add, ...(extra || {}) });
const evSet = (who, set) => ({ op: 'ev', who, set });
const item = (who, give, o) => ({ op: 'item', who, give, ...(o || {}) });
const mv = (who, kind, o) => ({ op: 'move', who, kind, ...(o || {}) });

// ---- training: EVs by role (per-Pokemon selectors) ----
fam('power-training', 'Power Training', 'training', ['offense', 'evs'], [ev('all', { best: [24, 40, 64, 100] })]);
fam('speed-training', 'Speed Training', 'training', ['speed', 'evs'], [ev('all', { spe: [30, 50, 80, 120] })]);
fam('bulk-training', 'Bulk Training', 'training', ['bulk', 'evs'], [ev('all', { hp: [20, 34, 54, 84], def: [15, 26, 42, 64], spd: [15, 26, 42, 64] })]);
fam('iron-wall', 'Iron Wall', 'training', ['bulk', 'evs'], [ev('all', { def: [40, 66, 100, 150] }), ev('all', { hp: 40 }, { tier: 3 })]);
fam('mind-shield', 'Mind Shield', 'training', ['bulk', 'evs'], [ev('all', { spd: [40, 66, 100, 150] }), ev('all', { hp: 40 }, { tier: 3 })]);
fam('twin-focus', 'Twin Focus', 'training', ['offense', 'evs'], [ev('all', { atk: [25, 42, 66, 100], spa: [25, 42, 66, 100] })]);
fam('max-effort', 'Max Effort', 'training', ['offense', 'speed', 'evs'], [ev('all', { best: [60, 120, 200, 255], spe: [0, 60, 120, 200] })], { tiers: [1, 3] });
fam('vitality-surge', 'Vitality Surge', 'training', ['bulk', 'recovery', 'evs'], [ev('all', { hp: [30, 60, 100, 160] })]);
fam('underdog-training', 'Underdog Training', 'training', ['offense', 'bulk', 'evs'], [ev('weakest', { best: [60, 100, 150, 220], hp: [40, 70, 110, 160] })]);
fam('lead-training', 'Lead Training', 'training', ['offense', 'speed', 'evs'], [ev('slot0', { best: [50, 80, 120, 180], spe: [50, 80, 120, 180] })]);
fam('ace-training', 'Ace Training', 'training', ['offense', 'speed', 'evs'], [ev('strongest', { best: [40, 70, 110, 170], spe: [20, 40, 64, 100] })], { tiers: [1, 3] });
fam('rear-guard', 'Rear Guard', 'training', ['bulk', 'evs'], [ev('last', { hp: [60, 100, 150, 220], def: [30, 50, 80, 120], spd: [30, 50, 80, 120] })]);
// ---- genes: IVs, natures, abilities ----
fam('perfect-genes', 'Perfect Genes', 'genes', ['genes'], [{ op: 'iv', who: 'all', min: [10, 20, 28, 31] }]);
fam('nature-coach', 'Nature Coach', 'genes', ['genes', 'nature', 'offense'], [{ op: 'nature', who: 'all', rule: 'attacker' }, ev('all', { best: 20 }, { tier: 2 })]);
fam('swift-natures', 'Swift Natures', 'genes', ['genes', 'nature', 'speed'], [{ op: 'nature', who: 'all', rule: 'swift' }, ev('all', { spe: 20 }, { tier: 2 })]);
fam('sturdy-natures', 'Sturdy Natures', 'genes', ['genes', 'nature', 'bulk'], [{ op: 'nature', who: 'all', rule: 'sturdy' }, ev('all', { hp: 20 }, { tier: 2 })]);
fam('hidden-talent', 'Hidden Talent', 'genes', ['genes', 'ability'], [{ op: 'ability', who: 'all', slot: 2 }, ev('all', { hp: [0, 20, 40, 70] })]);
// ---- held items (the last item buff taken wins on a Pokemon) ----
fam('leftovers-all', 'Leftovers for All', 'item', ['items', 'recovery'], [item('all', 'leftovers'), ev('all', { hp: [0, 16, 32, 60] })]);
fam('life-orb-squad', 'Life Orb Squad', 'item', ['items', 'offense'], [item('all', 'life-orb'), ev('all', { best: [0, 30, 60, 100] })], { tiers: [1, 3] });
fam('focus-sash-all', 'Sash Brigade', 'item', ['items', 'bulk'], [item('all', 'focus-sash'), ev('all', { spe: [0, 20, 40, 70] })], { tiers: [1, 3] });
fam('choice-matched', 'Choice Training', 'item', ['items', 'offense'], [item('all', 'choice'), ev('all', { best: [0, 20, 40, 70] })]);
fam('berry-bag', 'Berry Bag', 'item', ['items', 'recovery'], [item('all', 'sitrus', { empty: true }), ev('all', { hp: [0, 16, 32, 60] })]);
fam('lum-guard', 'Lum Guard', 'item', ['items', 'recovery'], [item('all', 'lum'), ev('all', { spd: [0, 16, 32, 60] })]);
fam('sharp-eyes', 'Sharp Eyes', 'item', ['items', 'crit'], [item('all', 'scope-lens'), ev('all', { best: [0, 16, 32, 56] })]);
fam('power-band', 'Power Band', 'item', ['items', 'offense'], [item('all', 'power-band'), ev('all', { best: [0, 16, 32, 56] })]);
fam('rocky-thorns', 'Rocky Thorns', 'item', ['items', 'bulk'], [item('all', 'rocky-helmet'), ev('all', { def: [0, 16, 32, 60] })]);
fam('razor-claws', 'Razor Claws', 'item', ['items', 'crit'], [item('all', 'razor-claw'), ev('all', { spe: [0, 16, 32, 60] })]);
fam('shell-bell-drain', 'Shell Bell Drain', 'item', ['items', 'recovery'], [item('all', 'shell-bell'), ev('all', { hp: [0, 16, 32, 60] })]);
fam('quick-claws', 'Quick Claws', 'item', ['items', 'speed'], [item('all', 'quick-claw'), ev('all', { spe: [0, 16, 32, 60] })]);
fam('boots', 'Heavy Boots', 'item', ['items', 'bulk'], [item('all', 'boots'), ev('all', { hp: [0, 16, 32, 60] })]);
fam('pinch-berries', 'Pinch Berries', 'item', ['items', 'offense'], [item('all', 'pinch'), ev('all', { best: [0, 16, 32, 56] })]);
fam('assault-vests', 'Assault Vests', 'item', ['items', 'bulk'], [item('attacks3', 'vest'), ev('attacks3', { spd: [0, 30, 60, 100] })], { tiers: [1, 3] });
fam('air-balloons', 'Air Balloons', 'item', ['items', 'bulk'], [item('all', 'balloon'), ev('all', { hp: [0, 16, 32, 60] })]);
// ---- moves: tutors (each replaces a weaker move; none if the Pokemon cannot legally learn a fitting one) ----
fam('pp-boost', 'PP Boost', 'move', ['pp', 'tutor'], [{ op: 'pp', who: 'all', ups: [1, 2, 3, 3] }, ev('all', { hp: [0, 0, 20, 40] })]);
fam('coverage-tutor', 'Coverage Tutor', 'move', ['tutor', 'offense'], [mv('all', 'coverage'), ev('all', { best: [0, 20, 40, 70] })], { tiers: [1, 3] });
fam('stab-tutor', 'STAB Tutor', 'move', ['tutor', 'offense'], [mv('all', 'stab'), ev('all', { best: [0, 16, 32, 56] })]);
fam('first-aid', 'First Aid Lessons', 'move', ['tutor', 'recovery'], [mv('all', 'heal'), ev('all', { hp: [0, 16, 32, 60] })]);
fam('protect-tutor', 'Protect Lessons', 'move', ['tutor', 'bulk'], [mv('all', 'protect'), ev('all', { def: [0, 16, 32, 60] })]);
fam('priority-tutor', 'Priority Lessons', 'move', ['tutor', 'priority', 'speed'], [mv('all', 'priority'), ev('all', { spe: [0, 16, 32, 60] })]);
fam('status-tutor', 'Status Lessons', 'move', ['tutor', 'status'], [mv('all', 'status'), ev('all', { spe: [0, 16, 32, 60] })]);
fam('setup-tutor', 'Setup Lessons', 'move', ['tutor', 'setup', 'offense'], [mv('all', 'setup'), ev('all', { hp: [0, 20, 40, 70] })], { tiers: [1, 3] });
fam('hazard-tutor', 'Hazard Lessons', 'move', ['tutor', 'hazard'], [mv('slot0', 'hazard'), ev('slot0', { hp: [0, 30, 60, 100] })]);
fam('power-tutor', 'Power Lessons', 'move', ['tutor', 'offense'], [mv('all', 'power'), ev('all', { best: [0, 16, 32, 56] })]);
fam('crit-tutor', 'Keen Moves', 'move', ['tutor', 'crit'], [mv('all', 'crit'), ev('all', { best: [0, 16, 32, 56] })]);
// ---- the opponent ----
fam('intimidating-presence', 'Intimidating Presence', 'foe', ['foe'], [{ op: 'foe-size', add: [-1, -1, -2, -3] }]);
fam('disarm', 'Disarm', 'foe', ['foe', 'items'], [{ op: 'foe-items', mode: 'none' }, { op: 'foe-ev-cut', cut: [0, 40, 80, 150] }]);
fam('weak-foes', 'Frail Foes', 'foe', ['foe', 'evs'], [{ op: 'foe-ev-cut', cut: [80, 130, 190, 280] }]);
fam('stunted-growth', 'Stunted Growth', 'foe', ['foe', 'genes'], [{ op: 'foe-ivcap', max: [20, 15, 10, 5] }]);
fam('defang', 'Defang', 'foe', ['foe', 'tutor'], [{ op: 'foe-defang', n: [1, 1, 2, 3] }]);
fam('mundane-foes', 'Mundane Foes', 'foe', ['foe', 'ability'], [{ op: 'foe-ability0' }, { op: 'foe-neutral', tier: 2 }]);
fam('dull-natures', 'Dull Natures', 'foe', ['foe', 'nature'], [{ op: 'foe-neutral' }, { op: 'foe-ev-cut', cut: [0, 30, 60, 100] }]);
fam('frail-boss', 'Frail Boss', 'foe', ['foe', 'economy'], [{ op: 'foe-relief', cut: [500, 700, 1000, 1000] }], { tiers: [1, 3] });
// ---- the run itself: offers, odds, lives, scouting ----
fam('wider-choice', 'Wider Choice', 'meta', ['economy'], [{ op: 'run', offer: [1, 1, 2, 2] }]);
fam('fortune', 'Fortune', 'meta', ['economy'], [{ op: 'run', fortune: [1, 2, 3, 5] }]);
fam('boss-bounty', 'Boss Bounty', 'meta', ['economy'], [{ op: 'run', bossOffer: [1, 1, 2, 2] }], { tiers: [1, 3] });
fam('extra-life', 'Extra Life', 'meta', ['economy', 'recovery'], [{ op: 'run', lives: [0, 0, 1, 2] }], { tiers: [2, 3] });
fam('scouting-report', 'Scouting Report', 'meta', ['economy'], [{ op: 'run', reveal: true }], { cap: 1, tiers: [0, 0] });
// ---- risk / reward: a curse for a bigger effect ----
fam('glass-cannon', 'Glass Cannon', 'risk', ['risk', 'offense'], [ev('all', { best: [60, 100, 150, 220] }), evSet('all', { hp: 0, def: 0, spd: 0 })], { curse: true });
fam('tank-mode', 'Tank Mode', 'risk', ['risk', 'bulk'], [ev('all', { hp: [60, 100, 160, 255], def: [60, 100, 160, 255], spd: [60, 100, 160, 255] }), evSet('all', { atk: 0, spa: 0 })], { curse: true });
fam('devils-bargain', "Devil's Bargain", 'risk', ['risk', 'offense'], [ev('all', { best: [60, 100, 160, 240] }), { op: 'foe-ev', who: 'all', add: { all: [30, 36, 44, 56] } }], { curse: true, tiers: [1, 3] });
fam('high-stakes', 'High Stakes', 'risk', ['risk', 'speed'], [{ op: 'item', who: 'all', strip: true }, ev('all', { best: [60, 100, 150, 220], spe: [40, 70, 110, 160] })], { curse: true });
fam('gambler', 'Gambler', 'risk', ['risk'], [{ op: 'gamble', pm: 500, then: [ev('all', { best: [80, 130, 200, 255] })], else: [{ op: 'foe-ev', who: 'all', add: { best: [60, 80, 100, 130] } }] }], { curse: true });
fam('double-or-nothing', 'Double or Nothing', 'risk', ['risk', 'evs'], [{ op: 'ev', who: 'all', mul: [1250, 1500, 1750, 2000] }, { op: 'foe-size', add: 1 }], { curse: true, tiers: [1, 3] });
fam('berserker', 'Berserker', 'risk', ['risk', 'offense', 'speed'], [ev('all', { best: [50, 90, 140, 200], spe: [50, 90, 140, 200] }), evSet('all', { def: 0, spd: 0 })], { curse: true });
fam('policy-gamble', 'Policy Gamble', 'risk', ['risk', 'items'], [item('all', 'weakness-policy'), ev('all', { best: [0, 40, 80, 140] })], { curse: true, tiers: [1, 3] });
// ---- build-defining legendaries (gold only) ----
fam('apex-predator', 'Apex Predator', 'training', ['offense', 'items', 'genes', 'nature'], [evSet('all', { best: 255 }), { op: 'iv', who: 'all', set: 31 }, item('all', 'life-orb'), { op: 'nature', who: 'all', rule: 'attacker' }], { tiers: [3, 3], cap: 8, w: 5 });
fam('fortress', 'Fortress', 'training', ['bulk', 'items', 'recovery'], [evSet('all', { hp: 255, def: 255, spd: 255 }), item('all', 'leftovers')], { tiers: [3, 3], cap: 8 });
fam('titan-training', 'Titan Training', 'training', ['offense', 'bulk', 'speed', 'evs'], [evSet('all', { hp: 255, atk: 255, def: 255, spa: 255, spd: 255, spe: 255 })], { tiers: [3, 3], cap: 8 });
fam('overwhelming-force', 'Overwhelming Force', 'foe', ['foe', 'economy'], [{ op: 'foe-size', add: -2 }, { op: 'foe-ev-cut', cut: 400 }], { tiers: [3, 3], cap: 8 });
fam('grandmaster-tutor', 'Grandmaster Tutor', 'move', ['tutor', 'offense', 'priority'], [mv('all', 'coverage'), mv('all', 'stab'), mv('all', 'priority')], { tiers: [3, 3], cap: 8 });
// ---- type-themed: three mechanics for each of the 18 types, relevant only to Pokemon of that type ----
for (const t of TYPE_IDS) {
  const tag = typeTag(t), nm = TYPE_NAMES[t], who = 'type:' + t;
  fam('type-training-' + tag, nm + ' Training', 'type', [tag, 'type', 'offense', 'evs'], [ev(who, { best: [24, 40, 64, 100], hp: [0, 10, 20, 40] })]);
  fam('type-gear-' + tag, nm + ' Gear', 'type', [tag, 'type', 'items'], [item(who, 'plate'), ev(who, { spe: [0, 16, 32, 56] })]);
  fam('type-lessons-' + tag, nm + ' Lessons', 'type', [tag, 'type', 'tutor'], [mv(who, 'type', { type: t }), { op: 'pp', who, ups: [0, 1, 2, 3] }]);
}

export const FAMILIES = Object.freeze(FAM);
export const FAMILY_BY_ID = Object.freeze(Object.fromEntries(FAM.map((f) => [f.id, f])));
export const familyOf = (id) => FAMILY_BY_ID[id] || null;
/** The highest power a family can hold (its own cap, else the run's power cap). */
export const capOf = (f, cfg = CONFIG) => Math.min(cfg.powerCap, f.cap || cfg.powerCap);

/* ---------------------------------------------------------------------------------------------- synergies */

const SYN = [];
const tagSyn = (id, tag, levels) => SYN.push(Object.freeze({ id, kind: 'tag', tag, levels: Object.freeze(levels) }));
const comboSyn = (id, name, needs, text, ops) => SYN.push(Object.freeze({ id, kind: 'combo', name, needs: Object.freeze(needs), text, ops: Object.freeze(ops) }));
const multSyn = (id, name, whenTag, min, boostTag, pm, text) => SYN.push(Object.freeze({ id, kind: 'mult', name, when: Object.freeze({ tag: whenTag, min }), boost: Object.freeze({ tag: boostTag, pm }), text }));
const lv = (need, name, text, ops) => ({ need, name, text, ops });

tagSyn('tempo', 'speed', [lv(3, 'Tempo', 'Speed EVs +40 on every Pokemon', [ev('all', { spe: 40 })]), lv(5, 'Blitz', 'Speed EVs +80 and Attack EVs +30', [ev('all', { spe: 80, best: 30 })])]);
tagSyn('bastion', 'bulk', [lv(3, 'Bastion', 'HP EVs +40 on every Pokemon', [ev('all', { hp: 40 })]), lv(5, 'Citadel', 'HP, Defense and Special Defense EVs +60', [ev('all', { hp: 60, def: 60, spd: 60 })])]);
tagSyn('onslaught', 'offense', [lv(3, 'Onslaught', 'Best attacking stat EVs +40', [ev('all', { best: 40 })]), lv(5, 'Annihilation', 'Best attacking stat EVs +90', [ev('all', { best: 90 })])]);
tagSyn('full-kit', 'items', [lv(3, 'Full Kit', 'HP EVs +30', [ev('all', { hp: 30 })]), lv(5, 'Walking Armoury', 'HP EVs +50 and PP Ups on every move', [ev('all', { hp: 50 }), { op: 'pp', who: 'all', ups: 3 }])]);
tagSyn('scholar', 'tutor', [lv(3, 'Scholar', 'PP Ups +2 on every move', [{ op: 'pp', who: 'all', ups: 2 }]), lv(5, 'Professor', 'PP Ups +3 and best attacking stat EVs +50', [{ op: 'pp', who: 'all', ups: 3 }, ev('all', { best: 50 })])]);
tagSyn('second-wind', 'recovery', [lv(3, 'Second Wind', 'HP EVs +40', [ev('all', { hp: 40 })]), lv(5, 'Lifeline', 'HP EVs +80 and Special Defense EVs +40', [ev('all', { hp: 80, spd: 40 })])]);
tagSyn('keen-edge', 'crit', [lv(2, 'Keen Edge', 'Best attacking stat EVs +30', [ev('all', { best: 30 })]), lv(3, 'Executioner', 'Best attacking stat EVs +70 and Speed +30', [ev('all', { best: 70, spe: 30 })])]);
tagSyn('dominator', 'foe', [lv(3, 'Intimidator', 'Every trainer: EVs cut by 10%', [{ op: 'foe-ev-cut', cut: 100 }]), lv(5, 'Dominator', 'Every trainer brings one Pokemon fewer', [{ op: 'foe-size', add: -1 }, { op: 'foe-ev-cut', cut: 100 }])]);
tagSyn('windfall', 'economy', [lv(3, 'Windfall', 'Every offer shows one more ball', [{ op: 'run', offer: 1 }]), lv(5, 'Jackpot', 'Boss offers show one more ball and Fortune is stronger', [{ op: 'run', bossOffer: 1, fortune: 1 }])]);
tagSyn('daredevil', 'risk', [lv(2, 'Daredevil', 'Best attacking stat EVs +40', [ev('all', { best: 40 })]), lv(3, 'Death Wish', 'Best attacking stat EVs +100 and Speed +60', [ev('all', { best: 100, spe: 60 })])]);
tagSyn('study-hall', 'genes', [lv(2, 'Study Hall', 'IVs raised to at least 20', [{ op: 'iv', who: 'all', min: 20 }]), lv(3, 'Honours Class', 'IVs raised to 31', [{ op: 'iv', who: 'all', set: 31 }])]);
tagSyn('overtrained', 'evs', [lv(4, 'Overtrained', 'EVs +15 in every stat', [ev('all', { all: 15 })]), lv(6, 'Peak Condition', 'EVs +30 in every stat', [ev('all', { all: 30 })])]);
for (const t of TYPE_IDS) {
  const tag = typeTag(t), nm = TYPE_NAMES[t], who = 'type:' + t;
  tagSyn('affinity-' + tag, tag, [lv(2, nm + ' Affinity', nm + ' Pokemon: best attacking stat EVs +30 and Speed +20', [ev(who, { best: 30, spe: 20 })]), lv(3, nm + ' Mastery', nm + ' Pokemon: best attacking stat EVs +70, HP +40 and a favourable nature', [ev(who, { best: 70, hp: 40 }), { op: 'nature', who, rule: 'attacker' }])]);
}
comboSyn('hit-and-run', 'Hit and Run', ['speed-training', 'priority-tutor'], 'Speed EVs +40 and Attack EVs +30', [ev('all', { spe: 40, best: 30 })]);
comboSyn('iron-fortress', 'Iron Fortress', ['iron-wall', 'mind-shield'], 'HP EVs +60', [ev('all', { hp: 60 })]);
comboSyn('glass-and-steel', 'Glass and Steel', ['glass-cannon', 'life-orb-squad'], 'Best attacking stat EVs +60', [ev('all', { best: 60 })]);
comboSyn('sash-and-protect', 'Cornered Rat', ['focus-sash-all', 'protect-tutor'], 'Speed EVs +50 and HP +30', [ev('all', { spe: 50, hp: 30 })]);
comboSyn('sustain', 'Sustain', ['leftovers-all', 'first-aid'], 'HP EVs +50 and Defense +30', [ev('all', { hp: 50, def: 30 })]);
comboSyn('critical-mass', 'Critical Mass', ['sharp-eyes', 'crit-tutor'], 'Best attacking stat EVs +60', [ev('all', { best: 60 })]);
comboSyn('setup-sweeper', 'Setup Sweeper', ['setup-tutor', 'swift-natures'], 'Speed EVs +50 and best attacking stat EVs +40', [ev('all', { spe: 50, best: 40 })]);
comboSyn('boss-hunter', 'Boss Hunter', ['boss-bounty', 'frail-boss'], 'Every offer shows one more ball and bosses are weaker', [{ op: 'run', offer: 1 }, { op: 'foe-relief', cut: 300 }]);
comboSyn('trainer-trouble', 'Trainer Trouble', ['intimidating-presence', 'weak-foes', 'disarm'], 'Every trainer: EVs cut by a further 20%', [{ op: 'foe-ev-cut', cut: 200 }]);
comboSyn('perfect-student', 'Perfect Student', ['perfect-genes', 'nature-coach', 'hidden-talent'], 'EVs +20 in every stat', [ev('all', { all: 20 })]);
comboSyn('lucky-seven', 'Lucky Streak', ['fortune', 'wider-choice', 'scouting-report'], 'Fortune is stronger and every offer shows one more ball', [{ op: 'run', fortune: 2, offer: 1 }]);
comboSyn('all-in', 'All In', ['devils-bargain', 'double-or-nothing', 'berserker'], 'Best attacking stat and Speed EVs +80', [ev('all', { best: 80, spe: 80 })]);
comboSyn('coverage-king', 'Coverage King', ['coverage-tutor', 'stab-tutor', 'power-tutor'], 'Best attacking stat EVs +60 and PP Ups on every move', [ev('all', { best: 60 }), { op: 'pp', who: 'all', ups: 3 }]);
comboSyn('cold-open', 'Cold Open', ['hazard-tutor', 'status-tutor'], 'Lead Pokemon: HP and Speed EVs +60', [ev('slot0', { hp: 60, spe: 60 })]);
multSyn('adrenaline', 'Adrenaline', 'speed', 2, 'offense', 1250, 'Offense families are 25% stronger');
multSyn('bulwark', 'Bulwark', 'bulk', 2, 'recovery', 1300, 'Recovery families are 30% stronger');
multSyn('precision', 'Precision', 'crit', 2, 'setup', 1250, 'Setup families are 25% stronger');
multSyn('quartermaster', 'Quartermaster', 'items', 3, 'tutor', 1200, 'Tutor families are 20% stronger');
multSyn('overconfidence', 'Overconfidence', 'risk', 2, 'offense', 1300, 'Offense families are 30% stronger');
multSyn('methodical', 'Methodical', 'evs', 3, 'genes', 1250, 'Genetic families are 25% stronger');

export const SYNERGIES = Object.freeze(SYN);
export const SYNERGY_BY_ID = Object.freeze(Object.fromEntries(SYN.map((s) => [s.id, s])));

/** held = [{ id, p }] (power per family, in the order first taken). -> { tags: {tag: n}, active: [{ id, name, level, kind, text, ops }], boost: {familyId: pm} } */
export function synergyState(held) {
  const tags = {};
  for (const h of held) { const f = FAMILY_BY_ID[h.id]; if (f) for (const t of f.tags) tags[t] = (tags[t] || 0) + 1; }
  const have = new Set(held.map((h) => h.id));
  const active = [], boost = {};
  for (const s of SYN) {
    if (s.kind === 'tag') {
      let hit = null; const n = tags[s.tag] || 0;
      s.levels.forEach((l, i) => { if (n >= l.need) hit = { l, i }; });
      if (hit) active.push({ id: s.id, name: hit.l.name, level: hit.i + 1, kind: 'tag', text: hit.l.text, ops: hit.l.ops });
    } else if (s.kind === 'combo') {
      if (s.needs.every((n) => have.has(n))) active.push({ id: s.id, name: s.name, level: 1, kind: 'combo', text: s.text, ops: s.ops });
    } else if (s.kind === 'mult' && (tags[s.when.tag] || 0) >= s.when.min) {
      active.push({ id: s.id, name: s.name, level: 1, kind: 'mult', text: s.text, ops: [] });
      for (const h of held) { const f = FAMILY_BY_ID[h.id]; if (f && f.tags.includes(s.boost.tag)) boost[h.id] = Math.min(2000, mulPm(boost[h.id] || 1000, s.boost.pm)); }
    }
  }
  return { tags, active, boost };
}

/* ---------------------------------------------------------------------------------------------- the interpreter */

const clone = (x) => JSON.parse(JSON.stringify(x));
const supCache = new WeakMap();
const supOf = (pack) => { let s = supCache.get(pack); if (!s) { s = engineSupports(pack); supCache.set(pack, s); } return s; };
const nameCache = new WeakMap();
const nameIndex = (pack, key, list) => { let c = nameCache.get(pack); if (!c) { c = {}; nameCache.set(pack, c); } if (!c[key]) { const m = new Map(); for (const x of list) if (x && x.name && !m.has(x.name)) m.set(x.name, x.id); c[key] = m; } return c[key]; };
const itemId = (pack, name) => nameIndex(pack, 'items', pack.items).get(name);
const moveId = (pack, name) => nameIndex(pack, 'moves', pack.moves).get(name);
const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
/** A coin for a gamble: one number per (floor salt, family), so the team side and the opponent side of the SAME gamble always agree. */
const gambleRoll = (ctx, id) => createRng(((ctx.salt >>> 0) ^ fnv(id)) >>> 0)(1000);
const spOf = (pack, rec) => pack.species[rec.species];
const bestAttack = (pack, rec) => { const b = spOf(pack, rec).baseStats; return b.atk >= b.spa ? 'atk' : 'spa'; };
const typesOf = (pack, rec) => { const t = spOf(pack, rec).types; return t[0] === t[1] ? [t[0]] : [t[0], t[1]]; };
const bst = (pack, rec) => { const b = spOf(pack, rec).baseStats; return b.hp + b.atk + b.def + b.spa + b.spd + b.spe; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The indices of the Pokemon a selector names. */
export function select(pack, recs, who) {
  const all = recs.map((_, i) => i);
  if (who === 'all') return all;
  if (who === 'slot0') return recs.length ? [0] : [];
  if (who === 'last') return recs.length ? [recs.length - 1] : [];
  if (who === 'weakest' || who === 'strongest') {
    let pick = -1;
    recs.forEach((r, i) => { const b = bst(pack, r); if (pick < 0 || (who === 'weakest' ? b < bst(pack, recs[pick]) : b > bst(pack, recs[pick]))) pick = i; });
    return pick < 0 ? [] : [pick];
  }
  if (who === 'physical' || who === 'special') return all.filter((i) => (bestAttack(pack, recs[i]) === 'atk') === (who === 'physical'));
  if (who === 'attacks3') return all.filter((i) => recs[i].moves.filter((m) => { const mm = pack.moves[m.id]; return mm.category !== 2 && mm.power > 0; }).length >= 3);
  if (typeof who === 'string' && who.startsWith('type:')) { const t = Number(who.slice(5)); return all.filter((i) => typesOf(pack, recs[i]).includes(t)); }
  throw new RangeError('unknown selector ' + String(who));
}

function statKeys(pack, rec, k) {
  if (STATS.includes(k)) return [k];
  if (k === 'best') return [bestAttack(pack, rec)];
  if (k === 'worst') return [bestAttack(pack, rec) === 'atk' ? 'spa' : 'atk'];
  if (k === 'bulk') return ['hp', 'def', 'spd'];
  if (k === 'offense') return ['atk', 'spa'];
  if (k === 'defense') return ['def', 'spd'];
  if (k === 'all') return STATS.slice();
  throw new RangeError('unknown stat selector ' + String(k));
}

const FIXED_ITEMS = { leftovers: 'Leftovers', 'life-orb': 'Life Orb', 'focus-sash': 'Focus Sash', sitrus: 'Sitrus Berry', 'razor-claw': 'Razor Claw', lum: 'Lum Berry', 'scope-lens': 'Scope Lens', 'rocky-helmet': 'Rocky Helmet', 'weakness-policy': 'Weakness Policy', 'shell-bell': 'Shell Bell', 'quick-claw': 'Quick Claw', boots: 'Heavy-Duty Boots', balloon: 'Air Balloon', vest: 'Assault Vest' };
const TYPE_ITEMS = { 1: ['Silk Scarf'], 2: ['Black Belt'], 3: ['Sharp Beak'], 4: ['Poison Barb'], 5: ['Soft Sand'], 6: ['Hard Stone'], 7: ['Silver Powder'], 8: ['Spell Tag'], 9: ['Metal Coat'], 11: ['Charcoal'], 12: ['Mystic Water'], 13: ['Miracle Seed'], 14: ['Magnet'], 15: ['Twisted Spoon'], 16: ['Never-Melt Ice'], 17: ['Dragon Fang'], 18: ['Black Glasses', 'BlackGlasses'], 19: ['Pixie Plate', 'Fairy Feather'] };
/** The item id a rule gives this Pokemon, or 0 when there is none (the engine can not run it, or the pack lacks it). */
export function itemFor(pack, rec, rule) {
  const sup = supOf(pack);
  const names = rule === 'choice' ? [bestAttack(pack, rec) === 'atk' ? 'Choice Band' : 'Choice Specs'] : rule === 'power-band' ? [bestAttack(pack, rec) === 'atk' ? 'Muscle Band' : 'Wise Glasses']
    : rule === 'pinch' ? [bestAttack(pack, rec) === 'atk' ? 'Liechi Berry' : 'Petaya Berry'] : rule === 'plate' ? (TYPE_ITEMS[typesOf(pack, rec)[0]] || []) : [FIXED_ITEMS[rule]];
  for (const n of names) { const id = n && itemId(pack, n); if (id && sup.items.has(id)) return id; }
  return 0;
}

const natureOf = (pack, up, down) => { const n = pack.natures.find((x) => x.up === up && x.down === down); return n ? n.id : null; };
export function natureFor(pack, rec, rule) {
  const best = bestAttack(pack, rec), other = best === 'atk' ? 'spa' : 'atk';
  if (rule === 'attacker') return natureOf(pack, best, other);
  if (rule === 'swift') return natureOf(pack, 'spe', other);
  if (rule === 'sturdy') return natureOf(pack, best === 'atk' ? 'def' : 'spd', other);
  if (rule === 'neutral') return 0;
  throw new RangeError('unknown nature rule ' + String(rule));
}

const NAMES = {
  heal: ['Recover', 'Roost', 'Soft-Boiled', 'Slack Off', 'Synthesis', 'Moonlight', 'Morning Sun', 'Milk Drink', 'Wish'],
  protect: ['Protect', 'Detect'],
  priority: ['Extreme Speed', 'Sucker Punch', 'Bullet Punch', 'Mach Punch', 'Aqua Jet', 'Ice Shard', 'Shadow Sneak', 'Quick Attack'],
  status: ['Thunder Wave', 'Will-O-Wisp', 'Toxic', 'Spore', 'Sleep Powder', 'Hypnosis', 'Stun Spore', 'Glare'],
  setupPhys: ['Swords Dance', 'Dragon Dance', 'Bulk Up', 'Agility'], setupSpec: ['Calm Mind', 'Nasty Plot', 'Quiver Dance', 'Agility'],
  hazard: ['Stealth Rock', 'Spikes', 'Toxic Spikes'],
};
const isAttack = (m) => m && m.category !== 2 && m.power > 0;
const moveScore = (m) => (isAttack(m) ? Math.floor(m.power * (m.accuracy === 0 ? 100 : m.accuracy) / 100) : 25);
const hasStab = (pack, rec, id) => typesOf(pack, rec).includes(pack.moves[id].type);

function pickTutor(pack, R, rec, kind, typeId) {
  const sup = supOf(pack), have = new Set(rec.moves.map((m) => m.id));
  const legal = legalMoves(pack, rec.species, rec.level, R).filter((id) => sup.moves.has(id) && !have.has(id));
  const byName = (list) => { for (const n of list) { const id = moveId(pack, n); if (id && legal.includes(id)) return id; } return null; };
  const best = (pred) => { let b = null, bs = -1; for (const id of legal) { const m = pack.moves[id]; if (!isAttack(m) || !pred(m, id)) continue; const s = moveScore(m) * (hasStab(pack, rec, id) ? 3 : 2); if (s > bs || (s === bs && id < b)) { b = id; bs = s; } } return b; };
  const curTypes = new Set(rec.moves.map((m) => pack.moves[m.id]).filter(isAttack).map((m) => m.type));
  switch (kind) {
    case 'coverage': return best((m) => m.power >= 60 && !curTypes.has(m.type));
    case 'stab': return rec.moves.some((m) => isAttack(pack.moves[m.id]) && pack.moves[m.id].power >= 70 && hasStab(pack, rec, m.id)) ? null : best((m, id) => m.power >= 60 && hasStab(pack, rec, id));
    case 'power': return best((m) => m.power >= 60);
    case 'crit': return best((m) => m.critStage >= 1 || m.alwaysCrit);
    case 'type': { const id = best((m) => m.type === typeId && m.power >= 40); return id && moveScore(pack.moves[id]) > Math.min(...rec.moves.map((m) => moveScore(pack.moves[m.id]))) ? id : null; }
    case 'heal': return rec.moves.some((m) => NAMES.heal.includes(pack.moves[m.id].name)) ? null : byName(NAMES.heal);
    case 'protect': return rec.moves.some((m) => NAMES.protect.includes(pack.moves[m.id].name)) ? null : byName(NAMES.protect);
    case 'priority': return rec.moves.some((m) => isAttack(pack.moves[m.id]) && pack.moves[m.id].priority > 0) ? null : byName(NAMES.priority);
    case 'status': return rec.moves.some((m) => NAMES.status.includes(pack.moves[m.id].name)) ? null : byName(NAMES.status);
    case 'setup': return byName(bestAttack(pack, rec) === 'atk' ? NAMES.setupPhys : NAMES.setupSpec);
    case 'hazard': return rec.moves.some((m) => NAMES.hazard.includes(pack.moves[m.id].name)) ? null : byName(NAMES.hazard);
    default: throw new RangeError('unknown tutor kind ' + String(kind));
  }
}
/** Which move slot a taught move replaces: a free slot first; else the weakest attack when at least three attacks remain after it, else the weakest non-attack. */
function replaceSlot(pack, rec, newIsAttack) {
  if (rec.moves.length < 4) return rec.moves.length;
  const idx = rec.moves.map((m, i) => ({ i, m: pack.moves[m.id] }));
  const atk = idx.filter((x) => isAttack(x.m)), non = idx.filter((x) => !isAttack(x.m));
  const lowest = (xs) => xs.reduce((a, b) => (moveScore(b.m) < moveScore(a.m) ? b : a)).i;
  if (newIsAttack) return non.length ? lowest(non) : lowest(atk);
  return atk.length >= 3 ? lowest(atk) : non.length ? lowest(non) : lowest(atk);
}

/**
 * Apply ONE op to a team (or a foe team: the same code), at a power, with an exact amount multiplier (permille). ctx = { pack, R, rng }.
 * Ops that are not about the records (foe-size, run ...) are handled elsewhere and ignored here.
 */
function applyOp(ctx, recs, op, power, pm, tierNow) {
  if (op.tier !== undefined && tierNow < op.tier) return;
  const { pack } = ctx, A = (v) => mulPm(scaleAt(v, power, ctx.cfg), pm), N = (v) => scaleAt(v, power, ctx.cfg);
  switch (op.op) {
    case 'ev': case 'foe-ev': {
      for (const i of select(pack, recs, op.who || 'all')) {
        const r = recs[i];
        if (op.set) for (const k of Object.keys(op.set)) for (const s of statKeys(pack, r, k)) r.evs[s] = clamp(op.set[k], 0, 255);
        if (op.add) for (const k of Object.keys(op.add)) { const n = A(op.add[k]); for (const s of statKeys(pack, r, k)) r.evs[s] = clamp(r.evs[s] + n, 0, 255); }
        if (op.mul) { const f = N(op.mul); for (const s of STATS) r.evs[s] = clamp(mulPm(r.evs[s], f), 0, 255); }
      }
      return;
    }
    case 'iv': for (const i of select(pack, recs, op.who || 'all')) { const r = recs[i]; for (const s of STATS) r.ivs[s] = op.set !== undefined ? clamp(op.set, 0, 31) : clamp(Math.max(r.ivs[s], N(op.min)), 0, 31); } return;
    case 'nature': for (const i of select(pack, recs, op.who || 'all')) { const n = natureFor(pack, recs[i], op.rule); if (n !== null) recs[i].nature = n; } return;
    case 'ability': for (const i of select(pack, recs, op.who || 'all')) { const sp = spOf(pack, recs[i]), a = sp.abilities[op.slot]; if (a && supOf(pack).abilities.has(a)) recs[i].abilitySlot = op.slot; } return;
    case 'item': for (const i of select(pack, recs, op.who || 'all')) { const r = recs[i]; if (op.strip) { r.item = 0; continue; } if (op.empty && r.item) continue; const id = itemFor(pack, r, op.give); if (id) r.item = id; } return;
    case 'pp': for (const i of select(pack, recs, op.who || 'all')) { const u = clamp(N(op.ups), 0, 3); for (const m of recs[i].moves) m.ppUps = Math.max(m.ppUps || 0, u); } return;
    case 'move': for (const i of select(pack, recs, op.who || 'all')) {
      const r = recs[i], id = pickTutor(pack, ctx.R, r, op.kind, op.type);
      if (!id) continue;
      const at = replaceSlot(pack, r, isAttack(pack.moves[id]));
      r.moves[at] = { id, ppUps: 0 };
    } return;
    default: return;
  }
}
const TEAM_OPS = new Set(['ev', 'iv', 'nature', 'ability', 'item', 'pp', 'move', 'gamble']);
const FOE_REC_OPS = new Set(['foe-ev', 'foe-defang', 'foe-ability0', 'foe-neutral']);
const KNOWN_OPS = new Set([...TEAM_OPS, ...FOE_REC_OPS, 'foe-size', 'foe-ev-cut', 'foe-ivcap', 'foe-items', 'foe-relief', 'run']);
/** The gamble's two branches are team ops or foe ops: which side an op acts on. */
const sideOf = (op) => (op.op === 'gamble' ? 'both' : TEAM_OPS.has(op.op) ? 'team' : FOE_REC_OPS.has(op.op) ? 'foe' : 'spec');

/** Walk every active (family, ops) and (synergy, ops) pair in order: held families first (acquisition order), then synergies. */
function* sources(held, cfg) {
  const syn = synergyState(held);
  for (const h of held) { const f = FAMILY_BY_ID[h.id]; if (f) yield { ops: f.ops, p: Math.min(h.p, capOf(f, cfg)), pm: syn.boost[h.id] || 1000, fam: f }; }
  for (const s of syn.active) if (s.ops.length) yield { ops: s.ops, p: 1, pm: 1000, syn: s };
}
const ctxOf = (pack, o) => ({ pack, R: (o.cfg || CONFIG).ruleset, rng: o.rng || createRng(o.salt >>> 0), salt: o.salt >>> 0, cfg: o.cfg || CONFIG });
const srcId = (src) => (src.fam ? src.fam.id : src.syn.id);

/** The player's team after every held buff: a NEW array of NEW records (the input is never touched). */
export function applyTeam(pack, recs, held, o = {}) {
  const ctx = ctxOf(pack, o), out = clone(recs);
  for (const src of sources(held, ctx.cfg)) {
    const tier = tierOfPower(src.p);
    for (const op of src.ops) {
      if (op.op === 'gamble') { const branch = gambleRoll(ctx, srcId(src)) < op.pm ? op.then : op.else; for (const b of branch) if (sideOf(b) === 'team') applyOp(ctx, out, b, src.p, src.pm, tier); continue; }
      if (sideOf(op) === 'team') applyOp(ctx, out, op, src.p, src.pm, tier);
    }
  }
  return out;
}

/** What the held buffs do to the OPPONENT before its team is built: { sizeAdd, cutPm, ivCap, noItems, relief }. */
export function foeMods(held, o = {}) {
  const cfg = o.cfg || CONFIG, m = { sizeAdd: 0, cutPm: 0, ivCap: 31, noItems: false, reliefPm: 0 };
  for (const src of sources(held, cfg)) {
    const tier = tierOfPower(src.p);
    for (const op of src.ops) {
      if (op.tier !== undefined && tier < op.tier) continue;
      if (op.op === 'foe-size') m.sizeAdd += scaleAt(op.add, src.p, cfg);
      else if (op.op === 'foe-ev-cut') m.cutPm += mulPm(scaleAt(op.cut, src.p, cfg), src.pm);
      else if (op.op === 'foe-ivcap') m.ivCap = Math.min(m.ivCap, scaleAt(op.max, src.p, cfg));
      else if (op.op === 'foe-items' && op.mode === 'none') m.noItems = true;
      else if (op.op === 'foe-relief') m.reliefPm = Math.min(1000, m.reliefPm + scaleAt(op.cut, src.p, cfg));
    }
  }
  m.cutPm = Math.min(900, m.cutPm);
  return m;
}

/** The record-level things the held buffs do to the opponent's finished team (EVs added, a move defanged, ability slot 0, neutral natures). A NEW array. */
export function applyFoe(pack, recs, held, o = {}) {
  const ctx = ctxOf(pack, o), out = clone(recs);
  for (const src of sources(held, ctx.cfg)) {
    const tier = tierOfPower(src.p);
    const run = (op) => {
      if (op.tier !== undefined && tier < op.tier) return;
      if (op.op === 'gamble') { for (const b of (gambleRoll(ctx, srcId(src)) < op.pm ? op.then : op.else)) run(b); return; }
      if (op.op === 'foe-ev') applyOp(ctx, out, { ...op, op: 'foe-ev' }, src.p, src.pm, tier);
      else if (op.op === 'foe-ability0') for (const r of out) r.abilitySlot = 0;
      else if (op.op === 'foe-neutral') for (const r of out) r.nature = 0;
      else if (op.op === 'foe-defang') {
        const n = scaleAt(op.n, src.p, ctx.cfg);
        for (const r of out) for (let k = 0; k < n; k++) {
          const atk = r.moves.map((m, i) => ({ i, m: pack.moves[m.id] })).filter((x) => isAttack(x.m)).sort((a, b) => moveScore(b.m) - moveScore(a.m) || a.i - b.i);
          if (atk.length < 2) break;
          const cap = Math.floor(moveScore(atk[0].m) * 0.6), sup = supOf(pack), have = new Set(r.moves.map((m) => m.id));
          const weaker = legalMoves(pack, r.species, r.level, ctx.R).filter((id) => sup.moves.has(id) && !have.has(id) && isAttack(pack.moves[id]) && pack.moves[id].power >= 40 && moveScore(pack.moves[id]) <= cap);
          if (weaker.length) r.moves[atk[0].i] = { id: weaker[ctx.rng(weaker.length)], ppUps: 0 };
        }
      }
    };
    for (const op of src.ops) run(op);
  }
  return out;
}

/** What the held buffs do to the run: { offer, fortune, bossOffer, lives, reveal }. */
export function runEffects(held, o = {}) {
  const cfg = o.cfg || CONFIG, e = { offer: 0, fortune: 0, bossOffer: 0, lives: 0, reveal: false };
  for (const src of sources(held, cfg)) {
    const tier = tierOfPower(src.p);
    for (const op of src.ops) {
      if (op.op !== 'run' || (op.tier !== undefined && tier < op.tier)) continue;
      for (const k of ['offer', 'fortune', 'bossOffer', 'lives']) if (op[k] !== undefined) e[k] += scaleAt(op[k], src.p, cfg);
      if (op.reveal) e.reveal = true;
    }
  }
  return e;
}

/** Every op name the catalogue uses is one the interpreter knows (a test walks this). */
export function unknownOps() {
  const bad = [];
  const walk = (ops, where) => { for (const op of ops) { if (!KNOWN_OPS.has(op.op)) bad.push(where + ':' + op.op); if (op.op === 'gamble') { walk(op.then, where); walk(op.else, where); } } };
  for (const f of FAM) walk(f.ops, f.id);
  for (const s of SYN) { if (s.kind === 'tag') for (const l of s.levels) walk(l.ops, s.id); else if (s.kind === 'combo') walk(s.ops, s.id); }
  return bad;
}

/* ---------------------------------------------------------------------------------------------- words */

const STAT_WORD = { best: 'best attacking stat', worst: 'weaker attacking stat', bulk: 'bulk stats', offense: 'Attack and Sp. Atk', defense: 'Defense and Sp. Def', all: 'every stat', hp: 'HP', atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed' };
const WHO_WORD = (w) => (w === 'all' ? 'team' : w === 'slot0' ? 'lead' : w === 'last' ? 'last member' : w === 'weakest' ? 'weakest member' : w === 'strongest' ? 'strongest member' : w === 'attacks3' ? 'attackers' : w.startsWith('type:') ? TYPE_NAMES[Number(w.slice(5))] + ' members' : w);
const NATURE_WORD = { attacker: 'an attacking', swift: 'a Speed-boosting', sturdy: 'a bulk-boosting', neutral: 'a neutral' };
const KIND_WORD = { coverage: 'a coverage attack', stab: 'a strong same-type attack', power: 'a powerful attack', crit: 'a high-critical-hit attack', heal: 'a healing move', protect: 'Protect', priority: 'a priority attack', status: 'a status move', setup: 'a setup move', hazard: 'an entry hazard', type: 'a move of its type' };
const ITEM_WORD = { leftovers: 'Leftovers', 'life-orb': 'Life Orb', 'focus-sash': 'Focus Sash', sitrus: 'a Sitrus Berry', 'razor-claw': 'Razor Claw', lum: 'a Lum Berry', 'scope-lens': 'Scope Lens', 'rocky-helmet': 'Rocky Helmet', 'weakness-policy': 'Weakness Policy', 'shell-bell': 'Shell Bell', 'quick-claw': 'Quick Claw', boots: 'Heavy-Duty Boots', balloon: 'an Air Balloon', vest: 'Assault Vest', choice: 'a matching Choice item', 'power-band': 'a matching Muscle Band / Wise Glasses', pinch: 'a matching pinch berry', plate: 'a matching type item' };
/** One line for what a list of ops does at a power (numbers are the exact ones the interpreter uses, multiplier included). */
export function describeOps(ops, power, o = {}) {
  const cfg = o.cfg || CONFIG, pm = o.pm || 1000, tier = tierOfPower(power), A = (v) => mulPm(scaleAt(v, power, cfg), pm), N = (v) => scaleAt(v, power, cfg), out = [];
  const sgn = (n) => (n >= 0 ? '+' + n : String(n));
  const each = (op) => {
    if (op.tier !== undefined && tier < op.tier) return;
    switch (op.op) {
      case 'ev': case 'foe-ev': {
        const who = op.op === 'foe-ev' ? 'Opponent' : WHO_WORD(op.who || 'all');
        if (op.set) for (const k of Object.keys(op.set)) out.push(who + ': ' + STAT_WORD[k] + ' EVs set to ' + op.set[k]);
        if (op.add) { const parts = Object.keys(op.add).map((k) => ({ k, n: A(op.add[k]) })).filter((x) => x.n !== 0).map((x) => STAT_WORD[x.k] + ' ' + sgn(x.n)); if (parts.length) out.push(who + ' EVs: ' + parts.join(', ')); }
        if (op.mul) out.push(who + ': every EV x' + (N(op.mul) / 1000).toFixed(2));
        return;
      }
      case 'iv': out.push(WHO_WORD(op.who || 'all') + ': IVs ' + (op.set !== undefined ? 'set to ' + op.set : 'at least ' + N(op.min))); return;
      case 'nature': out.push(WHO_WORD(op.who || 'all') + ': ' + (NATURE_WORD[op.rule] || 'a ' + op.rule) + ' nature'); return;
      case 'ability': out.push(WHO_WORD(op.who || 'all') + ': hidden ability'); return;
      case 'item': out.push(op.strip ? WHO_WORD(op.who || 'all') + ': held items removed' : WHO_WORD(op.who || 'all') + ': hold ' + (ITEM_WORD[op.give] || op.give) + (op.empty ? ' (if empty-handed)' : '')); return;
      case 'pp': { const u = clamp(N(op.ups), 0, 3); if (u) out.push('PP Ups ' + u + ' on every move'); return; }
      case 'move': out.push(WHO_WORD(op.who || 'all') + ': learn ' + (KIND_WORD[op.kind] || op.kind) + ' if they can'); return;
      case 'gamble': out.push('A coin each floor: heads, ' + (describeOps(op.then, power, o) || 'nothing') + '; tails, ' + (describeOps(op.else, power, o) || 'nothing')); return;
      case 'foe-size': out.push('Trainers bring ' + (N(op.add) < 0 ? Math.abs(N(op.add)) + ' fewer' : N(op.add) + ' more') + ' Pokemon'); return;
      case 'foe-ev-cut': { const c = mulPm(N(op.cut), pm); if (c) out.push('Trainer EVs cut by ' + c / 10 + '%'); return; }
      case 'foe-ivcap': out.push('Trainer IVs capped at ' + N(op.max)); return;
      case 'foe-items': out.push('Trainers hold no items'); return;
      case 'foe-relief': out.push('Boss bonuses cut by ' + N(op.cut) / 10 + '%'); return;
      case 'foe-defang': out.push('Each trainer Pokemon loses its ' + (N(op.n) > 1 ? N(op.n) + ' strongest attacks' : 'strongest attack')); return;
      case 'foe-ability0': out.push('Trainers use their ordinary ability'); return;
      case 'foe-neutral': out.push('Trainers have neutral natures'); return;
      case 'run': { const p = []; if (op.offer !== undefined) p.push('offers show ' + sgn(N(op.offer)) + ' ball(s)'); if (op.fortune !== undefined) p.push('rarer balls (Fortune ' + N(op.fortune) + ')'); if (op.bossOffer !== undefined) p.push('boss offers show ' + sgn(N(op.bossOffer)) + ' ball(s)'); if (op.lives !== undefined && N(op.lives) > 0) p.push(N(op.lives) + ' extra ' + (N(op.lives) > 1 ? 'lives' : 'life')); if (op.reveal) p.push('the next trainer is revealed'); if (p.length) out.push(p.join(', ')); return; }
      default: return;
    }
  };
  for (const op of ops) each(op);
  return out.join('; ');
}
/** The one-line effect of a family at a power. */
export function familyText(id, power, o = {}) { const f = FAMILY_BY_ID[id]; return f ? describeOps(f.ops, power, o) : ''; }

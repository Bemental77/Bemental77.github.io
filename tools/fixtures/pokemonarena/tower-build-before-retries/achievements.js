// pokemonarena/js/achievements.js -- the Pokemon Tower's ACHIEVEMENTS. Earned only by doing the Tower (never by regular or online battles), computed from the run's own history and the Tower's record, so
// they cannot drift from what happened and re-evaluating is idempotent. Pure ES module: no DOM, no clock, no storage.
//
//   const { unlocked } = evaluate(run, tower);          // ids newly earned (not yet in tower.achievements)
//   tower = unlock(tower, unlocked, Date.now());        // the CALLER stamps the time: this module has no clock
//
// Each achievement is { id, name, desc, grade (1..4, shown in the rarity colours green / blue / purple / gold), test(facts) }. `facts` (runFacts) is a plain object derived from the run and the Tower record.

import { CONFIG } from './tower_config.js';
import { sanitiseStamp } from './tower_record.js';
import { FAMILIES, FAMILY_BY_ID, CATEGORIES, synergyState, tierOfPower } from './tower_buffs.js';

const sub = (a, b) => a.filter((x) => !b.includes(x));

/** Everything the catalogue below asks about a run and the Tower record. */
export function runFacts(run, tower, cfg = CONFIG) {
  const wins = run.history.filter((h) => h.result === 'w'), cleared = wins.length;
  let streak = 0, best = 0;
  for (const h of wins) { streak = h.flawless ? streak + 1 : 0; best = Math.max(best, streak); }
  const picks = run.history.filter((h) => h.pick).map((h) => h.pick), pickCount = {};
  for (const p of picks) pickCount[p.id] = (pickCount[p.id] || 0) + 1;
  const common = (run.types.length ? run.types[0].filter((t, i, a) => a.indexOf(t) === i) : []).filter((t) => run.types.every((ts) => ts.includes(t)));
  const seenNow = Object.keys(tower.buffsSeen), allSeen = new Set(seenNow.concat(picks.map((p) => p.id)));
  const syn = synergyState(run.held);
  const winTurns = wins.map((h) => h.turns).filter((t) => t >= 1);
  return {
    format: run.format, phase: run.phase, won: run.phase === 'won', cleared, bossFloors: wins.filter((h) => h.boss).map((h) => h.floor),
    flawless: wins.filter((h) => h.flawless).length, flawlessStreak: best, bossFlawless: wins.some((h) => h.boss && h.flawless),
    noBuffAt: (n) => cleared >= n && wins.slice(0, n - 1).every((h) => h.pick === null || h.pick === undefined), taken: picks.length, skips: run.skips,
    minTurns: winTurns.length ? Math.min(...winTurns) : null, maxTurns: wins.length ? Math.max(...wins.map((h) => h.turns)) : 0,
    mono: run.types.length >= 1 && common.length > 0, rainbow: run.team.recs.length === 6 && new Set(run.types.map((t) => t[0])).size === 6,
    distinctHeld: run.held.length, tiersHeld: new Set(run.held.map((h) => tierOfPower(h.p))), maxPower: run.held.reduce((n, h) => Math.max(n, h.p), 0),
    fused: Object.keys(pickCount).some((id) => pickCount[id] >= 2 && (run.held.find((h) => h.id === id) || { p: 0 }).p >= 4),
    categories: new Set(picks.map((p) => FAMILY_BY_ID[p.id].cat)), cursed: picks.filter((p) => FAMILY_BY_ID[p.id].curse).length,
    synergies: syn.active.length, combos: syn.active.filter((s) => s.kind === 'combo').length,
    comeback: wins.some((h) => h.comeback), sweep: wins.some((h) => h.sweep), photoFinish: wins.some((h) => h.closest !== null && h.closest <= 5),
    livesUsed: run.livesUsed, over: run.phase === 'over', floorsTotal: cfg.floors,
    t: { runs: tower.runs, wins: tower.wins, floors: tower.floors, bosses: tower.bosses, winsByFormat: tower.winsByFormat, buffsSeen: allSeen.size },
  };
}

const A = [];
const ach = (id, name, desc, grade, test) => A.push(Object.freeze({ id, name, desc, grade, test }));
// climbing
ach('first-floor', 'First Step', 'Clear floor 1.', 1, (f) => f.cleared >= 1);
ach('climb-5', 'Getting Warm', 'Clear floor 5.', 1, (f) => f.cleared >= 5);
ach('climb-15', 'Halfway Up', 'Clear floor 15.', 2, (f) => f.cleared >= 15);
ach('climb-25', 'Nearly There', 'Clear floor 25.', 3, (f) => f.cleared >= 25);
ach('gatekeeper', 'Gatekeeper Down', 'Beat the floor 10 boss.', 2, (f) => f.bossFloors.includes(10));
ach('warden', 'Warden Down', 'Beat the floor 20 boss.', 3, (f) => f.bossFloors.includes(20));
ach('tower-master', 'Tower Master', 'Clear the top floor and win the run.', 4, (f) => f.won);
// flawless
ach('flawless-floor', 'Not a Scratch', 'Win a floor without losing a Pokemon.', 1, (f) => f.flawless >= 1);
ach('hat-trick', 'Hat Trick', 'Win three floors in a row without losing a Pokemon.', 2, (f) => f.flawlessStreak >= 3);
ach('flawless-10', 'Spotless', 'Win ten floors in one run without losing a Pokemon.', 3, (f) => f.flawless >= 10);
ach('untouchable-boss', 'Untouchable', 'Beat a boss without losing a Pokemon.', 3, (f) => f.bossFlawless);
ach('flawless-run', 'Perfect Climb', 'Win the run without losing a single Pokemon on any floor.', 4, (f) => f.won && f.flawless === f.floorsTotal);
// restraint
ach('no-buff-5', 'Bare Hands', 'Clear floor 5 without taking any buff.', 2, (f) => f.noBuffAt(5));
ach('no-buff-10', 'Purist', 'Beat the floor 10 boss without taking any buff.', 3, (f) => f.noBuffAt(10));
ach('no-buff-win', 'Naked Ascent', 'Win the run without ever taking a buff.', 4, (f) => f.won && f.taken === 0);
ach('skipper', 'Picky', 'Skip five offers in one run.', 1, (f) => f.skips >= 5);
// speed
ach('quick-win', 'Quick Win', 'Win a floor in 4 turns or fewer.', 1, (f) => f.minTurns !== null && f.minTurns <= 4);
ach('blitz', 'Lightning Round', 'Win a floor in 2 turns or fewer.', 2, (f) => f.minTurns !== null && f.minTurns <= 2);
ach('one-turn', 'One and Done', 'Win a floor in a single turn.', 3, (f) => f.minTurns === 1);
ach('marathon', 'Marathon', 'Win a floor that lasts 40 turns or more.', 2, (f) => f.maxTurns >= 40);
// formats and teams
ach('win-3v3', 'Triple Threat', 'Win a run in the 3v3 format.', 3, (f) => f.t.winsByFormat['3v3'] >= 1);
ach('win-6v6', 'Full Squad', 'Win a run in the 6v6 format.', 3, (f) => f.t.winsByFormat['6v6'] >= 1);
ach('both-formats', 'Both Ways', 'Win a run in each format.', 4, (f) => f.t.winsByFormat['3v3'] >= 1 && f.t.winsByFormat['6v6'] >= 1);
ach('mono-10', 'One Note', 'Clear floor 10 with a team whose Pokemon all share a type.', 2, (f) => f.mono && f.cleared >= 10);
ach('mono-win', 'Monotype Master', 'Win a run with a team whose Pokemon all share a type.', 4, (f) => f.mono && f.won);
ach('rainbow', 'Rainbow Team', 'Clear floor 10 with six Pokemon of six different first types.', 2, (f) => f.rainbow && f.cleared >= 10);
// collecting and building
ach('collector-10', 'Collector', 'Take ten different buffs over all your runs.', 1, (f) => f.t.buffsSeen >= 10);
ach('collector-30', 'Hoarder', 'Take thirty different buffs over all your runs.', 2, (f) => f.t.buffsSeen >= 30);
ach('collector-60', 'Curator', 'Take sixty different buffs over all your runs.', 3, (f) => f.t.buffsSeen >= 60);
ach('completionist', 'Completionist', 'Take every buff family at least once.', 4, (f) => f.t.buffsSeen >= FAMILIES.length);
ach('hoarder-15', 'Walking Arsenal', 'Hold fifteen different buffs at once.', 2, (f) => f.distinctHeld >= 15);
ach('fusion', 'Fusion', 'Take a buff family twice and merge it up to purple or better.', 2, (f) => f.fused);
ach('ascension', 'Ascension', 'Push one buff family to the power cap.', 4, (f) => f.maxPower >= 16);
ach('all-categories', 'Well Rounded', 'Take a buff from every category in one run.', 3, (f) => CATEGORIES.every((c) => f.categories.has(c)));
ach('tier-collector', 'Full Spectrum', 'Hold a green, a blue, a purple and a gold buff at once.', 3, (f) => [0, 1, 2, 3].every((t) => f.tiersHeld.has(t)));
ach('risky-business', 'Risky Business', 'Take three cursed buffs in one run.', 2, (f) => f.cursed >= 3);
ach('synergist', 'Synergist', 'Have three synergies active at once.', 2, (f) => f.synergies >= 3);
ach('synergy-master', 'Synergy Master', 'Have eight synergies active at once.', 4, (f) => f.synergies >= 8);
ach('combo-lover', 'Combo Lover', 'Complete a named combo.', 2, (f) => f.combos >= 1);
// feats
ach('comeback-floor', 'Comeback', 'Win a floor after being two Pokemon down.', 2, (f) => f.comeback);
ach('sweep-floor', 'Clean Sweep', 'Win a floor with one Pokemon scoring every knock-out.', 2, (f) => f.sweep);
ach('photo-finish', 'Photo Finish', 'Win a floor with a Pokemon left at 5% HP or less.', 2, (f) => f.photoFinish);
ach('second-wind', 'Second Chance', 'Spend an extra life.', 1, (f) => f.livesUsed >= 1);
ach('phoenix', 'Phoenix', 'Spend an extra life and still win the run.', 4, (f) => f.livesUsed >= 1 && f.won);
ach('rock-bottom', 'Rock Bottom', 'Lose on floor 1.', 1, (f) => f.over && f.cleared === 0);
// persistence
ach('runs-3', 'Regular', 'Finish three runs.', 1, (f) => f.t.runs >= 3);
ach('runs-10', 'Devoted', 'Finish ten runs.', 2, (f) => f.t.runs >= 10);
ach('runs-25', 'Obsessed', 'Finish twenty-five runs.', 3, (f) => f.t.runs >= 25);
ach('wins-3', 'Habitual Winner', 'Win three runs.', 3, (f) => f.t.wins >= 3);
ach('tower-veteran', 'Tower Veteran', 'Clear a hundred floors across all your runs.', 3, (f) => f.t.floors >= 100);
ach('boss-hunter-10', 'Giant Slayer', 'Beat ten bosses across all your runs.', 3, (f) => f.t.bosses >= 10);

export const ACHIEVEMENTS = Object.freeze(A);
export const ACHIEVEMENT_BY_ID = Object.freeze(Object.fromEntries(A.map((a) => [a.id, a])));

/** Which achievements this run (and the Tower record, after the run was folded in) has earned that the record does not hold yet. -> { unlocked: [id], facts } */
export function evaluate(run, tower, cfg = CONFIG) {
  const facts = runFacts(run, tower, cfg), have = tower.achievements || {};
  return { unlocked: A.filter((a) => !(a.id in have) && a.test(facts)).map((a) => a.id), facts };
}
/** A NEW Tower record with these ids stamped at `at` (the caller's time). Unknown ids and already-held ones are ignored. */
export function unlock(tower, ids, at) {
  const t = JSON.parse(JSON.stringify(tower));
  for (const id of ids) if (ACHIEVEMENT_BY_ID[id] && !(id in t.achievements)) t.achievements[id] = sanitiseStamp(at);
  return t;
}
export const missing = (tower) => sub(A.map((a) => a.id), Object.keys(tower.achievements));

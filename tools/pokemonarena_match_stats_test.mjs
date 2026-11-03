#!/usr/bin/env node
// POKEMONARENA MATCH STATS TEST (ST1) -- pokemonarena/js/match_stats.js, the collector that folds the engine's event log into the match summary.
//
//   A  HAND-COMPUTED LOGS: small invented event lists whose every number was worked out on paper first (attack damage, crits, effectiveness, recoil /
//      poison / weather, a leech-seed KO, healing, misses, immunities, statuses, switches, a forfeit, a draw, a sweep, a comeback ...).
//   B  REAL ENGINE BATTLES: N seeded battles (3v3 and 6v6, easy / normal / hard CPU, with forfeits) through the real engine; the summary is checked against the
//      engine's own final state (HP per Pokemon, faint counts, alive counts, hits taken, turns, winner), against its own identities (damage taken = attacks +
//      the rest; attacks dealt = attacks taken; faints = the other side's KOs + self + environment) and for determinism (same log -> same bytes, a copy of the
//      log, and a replay of the saved choices).
//   C  THE DAMAGE SOURCES: every `src` the engine emitted in the battles is in CLASS_OF_SRC (an unknown one would be counted as environment: it is reported).
//   D  MUTANTS: one-snippet defects of match_stats.js, each of which must trip a NAMED check; the unmutated twin through the same loader must pass all.
//
//   node tools/pokemonarena_match_stats_test.mjs        ARENA_BATTLES=n (default 240), ARENA_ROM, ARENA_SKIP_MUTANTS=1
// Reads the ROM (the engine needs the pack); writes nothing but a temp copy of match_stats.js for the mutants. Pure ASCII.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const N_BATTLES = Math.max(10, Number(process.env.ARENA_BATTLES || 240));
const imp = (n) => import(pathToFileURL(path.join(JS, n)).href);
const MS = await imp('match_stats.js');
const T = await imp('tables.js'), MC = await imp('matchctl.js'), AI = await imp('ai.js');
const MSRC = fs.readFileSync(path.join(JS, 'match_stats.js'), 'utf8');
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH); process.exit(2); }
const pack = T.loadPack(fs.readFileSync(ROM_PATH), { verify: 'header', dexText: false });

let passed = 0, failed = 0;
const failures = [], failNames = [];
function t(name, ok, detail = '') { if (ok === true) { passed++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); } else { failed++; failNames.push(name); failures.push(name + ': ' + (typeof ok === 'string' ? ok : detail)); console.log('  FAIL ' + name + (typeof ok === 'string' ? ' -- ' + ok : detail ? ' -- ' + detail : '')); } }
const head = (s) => console.log('\n== ' + s);
const J = (x) => JSON.stringify(x);
const eqv = (got, want) => (J(got) === J(want) ? true : 'got ' + J(got) + ' want ' + J(want));

/* ================================================================================================================= the checks, as a suite over any module */

// ---- A. hand-computed logs. Each log is written as the engine would write it; the comment above it gives the paper numbers.
const sw = (s, m, sp, name, hp, max) => ({ t: 'switch-in', s, m, sp, name, lv: 50, hp, max, st: 0, orig: m });
const dmg = (s, m, from, to, max, extra = {}) => ({ t: 'damage', s, m, from, to, max, src: 'move', mv: 1, eff: 4096, ...extra });
const START = (sizes = [2, 2]) => [{ t: 'start', names: ['You', 'Foe'], sizes, pick: 0, rules: 'x' }];

// L1: A (side 0, 100 HP) vs B (side 1, 100 HP) then C (90 HP).
//  turn 1: A uses move 85 and crits B super effectively for 60 (100->40); B uses move 33 on A for 30 (80->50) neutral.
//  turn 2: A hits B for 40 (40->0, 60% + ... ) B faints; C comes in. turn 3: C hits A for 50 (50->0), A faints. B's team: B,C; A's team: A only second slot D (60 HP) comes in.
//  then D (side0 slot1, 70 max) hits C for 90 -> C faints (90 HP): A's side wins. Expected numbers worked out below.
const L1 = [
  ...START([2, 2]),
  sw(1, 0, 100, 'B', 100, 100), sw(0, 0, 25, 'A', 80, 80),
  { t: 'turn', n: 1 },
  { t: 'move-use', s: 0, m: 0, mv: 85, called: 0 }, dmg(1, 0, 100, 40, 100, { mv: 85, eff: 8192, crit: 1 }),
  { t: 'move-use', s: 1, m: 0, mv: 33, called: 0 }, dmg(0, 0, 80, 50, 80, { mv: 33 }),
  { t: 'turn', n: 2 },
  { t: 'move-use', s: 0, m: 0, mv: 85, called: 0 }, dmg(1, 0, 40, 0, 100, { mv: 85, eff: 8192 }), { t: 'faint', s: 1, m: 0 },
  sw(1, 1, 101, 'C', 90, 90),
  { t: 'turn', n: 3 },
  { t: 'move-use', s: 1, m: 1, mv: 33, called: 0 }, dmg(0, 0, 50, 0, 80, { mv: 33, eff: 2048 }), { t: 'faint', s: 0, m: 0 },
  sw(0, 1, 26, 'D', 70, 70),
  { t: 'turn', n: 4 },
  { t: 'move-use', s: 0, m: 1, mv: 7, called: 0 }, dmg(1, 1, 90, 0, 90, { mv: 7, eff: 8192, crit: 1 }), { t: 'faint', s: 1, m: 1 },
  { t: 'win', s: 0 },
];
function hand(M) {
  const s = M.summarizeMatch(L1, { viewSide: 0 });
  const A = s.sides[0], B = s.sides[1];
  t('hand/L1 result, winner, turns, endedBy', J([s.result, s.winner, s.turns, s.endedBy]) === J(['w', 0, 4, 'ko']), J([s.result, s.winner, s.turns, s.endedBy]));
  // paper: A dealt 60 + 40 = 100 (dealtPct = 60 + 40 = 100), D dealt 90 (one hit, 100% of C's 90 max)
  t('hand/L1 damage dealt per Pokemon and per side', J([A.mons[0].dealt, A.mons[0].dealtPct, A.mons[1].dealt, A.mons[1].dealtPct, A.dealt]) === J([100, 100, 90, 100, 190]), J([A.mons[0].dealt, A.mons[0].dealtPct, A.mons[1].dealt, A.mons[1].dealtPct, A.dealt]));
  // paper: side 0 took 30 + 50 = 80 (A: 80/80 = 100 %), D took 0. side 1 took 60 + 40 + 90 = 190
  t('hand/L1 damage taken per Pokemon and per side', J([A.mons[0].taken, A.mons[0].takenPct, A.taken, B.mons[0].taken, B.mons[0].takenPct, B.mons[1].taken, B.taken]) === J([80, 100, 80, 100, 100, 90, 190]), J([A.mons[0].taken, A.taken, B.taken]));
  t('hand/L1 KOs: A scored one (B), D scored one (C); faints: A 1, B 1, C 1', J([A.mons[0].kos, A.mons[1].kos, A.kos, A.faints, B.faints, B.kos]) === J([1, 1, 2, 1, 2, 1]), J([A.mons[0].kos, A.mons[1].kos, A.kos, A.faints, B.faints, B.kos]));
  t('hand/L1 hits 2 + 1, crits 1 + 1, super effective 2 + 1, resisted: B-C hit on A was 2048 (1)', J([A.mons[0].hits, A.mons[0].crits, A.mons[0].superEffective, A.mons[1].crits, A.mons[1].superEffective, B.resisted, B.hits]) === J([2, 1, 2, 1, 1, 1, 2]), J([A.mons[0].hits, A.mons[0].crits, A.mons[0].superEffective, B.resisted, B.hits]));
  t('hand/L1 biggest hit is D 90 on turn 4 (100 percent of C), move 7, a critical hit', J(s.biggestHit) === J({ side: 0, slot: 1, sp: 26, mv: 7, dmg: 90, pct: 100, crit: 1, eff: 8192, vs: { side: 1, slot: 1, sp: 101 }, turn: 4 }), J(s.biggestHit));
  t('hand/L1 each sides own biggest hit: side 0 90 (D), side 1 50 (C on A, 50 of 80 = 63 %)', s.sides[0].biggestHit.dmg === 90 && s.sides[1].biggestHit.dmg === 50 && s.sides[1].biggestHit.pct === 63, J(s.sides[1].biggestHit));
  t('hand/L1 first blood is B fainting on turn 2, scored by A with move 85', J(s.firstBlood) === J({ victim: { side: 1, slot: 0, sp: 100 }, by: { side: 0, slot: 0, sp: 25, mv: 85 }, cause: 'attack', turn: 2 }), J(s.firstBlood));
  t('hand/L1 last hit is D\'s move 7 on C', J(s.lastHit) === J({ side: 0, slot: 1, sp: 26, mv: 7, victim: { side: 1, slot: 1, sp: 101 } }), J(s.lastHit));
  // streaks: faint B (s1), faint A (s0), faint C (s1): side 0 streak 1 then reset by its own faint... side 1 scored: B then (A fainted) - side 1 got 1 (A), side 0 got B (1) then C (the faint of s1 again, but a faint of s0 came between): 1
  t('hand/L1 KO streak is 1 (every faint alternated sides)', s.koStreak.n === 1, J(s.koStreak));
  // MVP: A score = 1000 * 1 + 600 + 400 = 2000 ; D = 1000 + 1000 = 2000; tie -> fewer faints (D has 0, A has 1) -> D
  t('hand/L1 MVP: A and D tie on 2000 (100 per KO + damage %), D wins the tie on faints', s.mvp && s.mvp.slot === 1 && s.mvp.sp === 26 && s.mvp.score === 2000 && s.mvp.scorePts === 200, J(s.mvp));
  // closest call: D never took damage -> nobody below full among survivors that never fainted: A fainted -> null
  t('hand/L1 closest call is null (the only Pokemon that was hurt fainted)', s.closestCall === null, J(s.closestCall));
  t('hand/L1 end HP: A 0, D 70/70, team left 70 of 150 (47 %)', J([A.mons[0].endHp, A.mons[1].endHp, A.hpLeft, A.hpMax, A.hpLeftPct, A.alive, B.alive]) === J([0, 70, 70, 150, 47, 1, 0]), J([A.hpLeft, A.hpMax, A.hpLeftPct, A.alive]));
  t('hand/L1 turns on the field: A 3, B 2, C 2, D 1', J([A.mons[0].turns, B.mons[0].turns, B.mons[1].turns, A.mons[1].turns]) === J([3, 2, 2, 1]), J([A.mons[0].turns, B.mons[0].turns, B.mons[1].turns, A.mons[1].turns]));
  t('hand/L1 moves used: A [[85,2]], B [[33,1]], C [[33,1]], D [[7,1]]; side 0 [[85,2],[7,1]]', J([A.mons[0].moves, B.mons[0].moves, B.mons[1].moves, A.mons[1].moves, A.moves]) === J([[[85, 2]], [[33, 1]], [[33, 1]], [[7, 1]], [[85, 2], [7, 1]]]), J(A.moves));
  t('hand/L1 flags: not a no-faint win, not a sweep (two Pokemon scored), not a comeback', J(s.flags) === J({ noFaintWin: false, sweep: false, comeback: false, forfeit: false }), J(s.flags));
  t('hand/L1 view side 1 sees the same match from the other chair (l)', M.summarizeMatch(L1, { viewSide: 1 }).result === 'l');

  // L2: environment and self damage. Side 0: E (100 HP) vs side 1: F (100 HP) only.
  //  turn 1: E uses 10: hit F 30 (100->70), crit, resisted(2048). F is poisoned (status-set st 2, fx '') -> 'inflicted' by E.
  //  F uses 20 -> E: 20 (100->80) and recoil on F: 5 (70->65, src recoil) ; heal F +10 (65->75 src leftovers).
  //  end of turn: poison hits F 12 (75->63 src psn); sandstorm (weather-tick w 3) hits E 6 (80->74 src sandstorm).
  //  turn 2: E misses; F avoided; E's move had no effect (immune with mv); F's move blocked (protected).
  //  F faints from poison... F has 63 -> psn 63 -> faint (env faint, nobody's KO). Then draw? no: E wins.
  const L2 = [
    ...START([1, 1]),
    sw(1, 0, 200, 'F', 100, 100), sw(0, 0, 150, 'E', 100, 100),
    { t: 'turn', n: 1 },
    { t: 'move-use', s: 0, m: 0, mv: 10, called: 0 }, dmg(1, 0, 100, 70, 100, { mv: 10, eff: 2048, crit: 1 }), { t: 'status-set', s: 1, m: 0, st: 2, fx: '' },
    { t: 'move-use', s: 1, m: 0, mv: 20, called: 0 }, dmg(0, 0, 100, 80, 100, { mv: 20 }), { t: 'damage', s: 1, m: 0, from: 70, to: 65, max: 100, src: 'recoil' },
    { t: 'heal', s: 1, m: 0, from: 65, to: 75, max: 100, src: 'leftovers' },
    { t: 'damage', s: 1, m: 0, from: 75, to: 63, max: 100, src: 'psn' }, { t: 'weather-tick', w: 3 }, { t: 'damage', s: 0, m: 0, from: 80, to: 74, max: 100, src: 'sandstorm' },
    { t: 'turn', n: 2 },
    { t: 'status-set', s: 1, m: 0, st: 6, fx: 'toxic-orb' },
    { t: 'move-use', s: 0, m: 0, mv: 11, called: 0 }, { t: 'miss', s: 0, m: 0, mv: 11 },
    { t: 'move-use', s: 1, m: 0, mv: 21, called: 0 }, { t: 'immune', s: 0, m: 0, why: 'type', mv: 21 },
    { t: 'turn', n: 3 },
    { t: 'move-use', s: 0, m: 0, mv: 12, called: 0 }, { t: 'avoid', s: 1, m: 0, mv: 12 },
    { t: 'move-use', s: 1, m: 0, mv: 22, called: 0 }, { t: 'protected', s: 0, m: 0, mv: 22, pk: 1 },
    { t: 'damage', s: 1, m: 0, from: 63, to: 0, max: 100, src: 'psn' }, { t: 'faint', s: 1, m: 0 },
    { t: 'win', s: 0 },
  ];
  const s2 = M.summarizeMatch(L2, { viewSide: 0 });
  const E = s2.sides[0], F = s2.sides[1];
  t('hand/L2 dealt: E 30 (30 %), F 20; indirect none', J([E.dealt, E.dealtPct, F.dealt, E.dealtIndirect]) === J([30, 30, 20, 0]), J([E.dealt, E.dealtPct, F.dealt]));
  t('hand/L2 taken: E 20 + 6 = 26 (20 by attacks, 6 other); F 30 + 5 + 12 + 63 = 110 (30 by attacks, 80 other)', J([E.taken, E.takenByAttacks, E.takenOther, F.taken, F.takenByAttacks, F.takenOther]) === J([26, 20, 6, 110, 30, 80]), J([E.taken, E.takenByAttacks, E.takenOther, F.taken, F.takenByAttacks, F.takenOther]));
  t('hand/L2 healed: F 10', F.healed === 10 && E.healed === 0, J([F.healed, E.healed]));
  t('hand/L2 the faint was caused by poison: nobody scored it; E has 0 KOs, F envFaints 1; identity faints = other.kos + self + env', J([E.kos, F.faints, F.envFaints, F.selfFaints, F.faints === E.kos + F.selfFaints + F.envFaints]) === J([0, 1, 1, 0, true]), J([E.kos, F.faints, F.envFaints]));
  t('hand/L2 status: E inflicted one on F (st 2); F suffered 2 (the Toxic Orb it gave itself is suffered, not inflicted)', J([E.statusInflicted, E.statuses, F.mons[0].statusSuffered]) === J([1, [[2, 1]], 2]), J([E.statusInflicted, E.statuses]));
  t('hand/L2 misses: E missed once and F avoided once (2); no effect 1 (F\'s move 21); blocked 1 (E blocked F? no: F\'s 22 was protected against)', J([E.misses, F.noEffect, F.blocked, E.noEffect]) === J([2, 1, 1, 0]), J([E.misses, F.noEffect, F.blocked]));
  t('hand/L2 weather: 1 tick of w 3; weatherTurns 1', J([s2.weatherTurns, s2.weather]) === J([1, [[3, 1]]]), J([s2.weatherTurns, s2.weather]));
  t('hand/L2 closest call: E reached 74 of 100 (74 %) and never fainted', s2.closestCall && s2.closestCall.hp === 74 && s2.closestCall.max === 100 && s2.closestCall.pct === 74, J(s2.closestCall));
  t('hand/L2 no-faint win', s2.flags.noFaintWin === true && s2.flags.sweep === false, J(s2.flags));
  t('hand/L2 last hit is null (the final faint was nobody\'s attack)', s2.lastHit === null, J(s2.lastHit));
  t('hand/L2 the HP identity: start + healed - taken = end for F (100 + 10 - 110 = 0) and E (100 - 26 = 74)', J([F.mons[0].startHp + F.mons[0].healed - F.mons[0].taken, F.mons[0].endHp, E.mons[0].startHp - E.mons[0].taken, E.mons[0].endHp]) === J([0, 0, 74, 74]));

  // L3: a leech-seed KO (class 'foe'), a self faint (explosion), a sweep and a comeback. Side 0: P (60), Q (60), R (60); side 1: X (60), Y (60), Z (60). 3 v 3.
  //  P hits X to death (attack). X's side: Y in. Y hits P to death (attack) -> P faint. Q in. Y explodes: damage Y->Y src explosion, Y faints (self). Z in.
  //  Z faints P... let side 1 get ahead: after faints: s0 lost P (1), s1 lost X, Y -> 3v1? Build: s0 lose P, Q => R alone vs Z alone? Use a comeback: s0 alive 3->1 while s1 stays 3 (deficit 2), then R KOs X, Y (by attacks) and Z via leech seed: win.
  const L3 = [
    ...START([3, 3]),
    { t: 'preview', s: 0, order: [0, 1, 2] }, { t: 'preview', s: 1, order: [0, 1, 2] },
    sw(1, 0, 300, 'X', 60, 60), sw(0, 0, 301, 'P', 60, 60),
    { t: 'turn', n: 1 },
    { t: 'move-use', s: 1, m: 0, mv: 5, called: 0 }, dmg(0, 0, 60, 0, 60, { mv: 5 }), { t: 'faint', s: 0, m: 0 }, sw(0, 1, 302, 'Q', 60, 60),
    { t: 'turn', n: 2 },
    { t: 'move-use', s: 1, m: 0, mv: 5, called: 0 }, dmg(0, 1, 60, 0, 60, { mv: 5 }), { t: 'faint', s: 0, m: 1 }, sw(0, 2, 303, 'R', 60, 60),
    { t: 'turn', n: 3 },
    { t: 'move-use', s: 0, m: 2, mv: 6, called: 0 }, dmg(1, 0, 60, 0, 60, { mv: 6 }), { t: 'faint', s: 1, m: 0 }, sw(1, 1, 304, 'Y', 60, 60),
    { t: 'turn', n: 4 },
    { t: 'move-use', s: 0, m: 2, mv: 6, called: 0 }, dmg(1, 1, 60, 0, 60, { mv: 6 }), { t: 'faint', s: 1, m: 1 }, sw(1, 2, 305, 'Z', 60, 60),
    { t: 'turn', n: 5 },
    { t: 'damage', s: 1, m: 2, from: 60, to: 0, max: 60, src: 'leech-seed' }, { t: 'faint', s: 1, m: 2 },
    { t: 'win', s: 0 },
  ];
  const s3 = M.summarizeMatch(L3, { viewSide: 0 });
  t('hand/L3 comeback: side 0 was two Pokemon down (1 alive vs 3) and won', s3.flags.comeback === true && s3.sides[0].deficit === 2, J([s3.flags, s3.sides[0].deficit]));
  t('hand/L3 sweep: R scored both attack KOs and the third faint was the seed\'s (indirect KO), so it is NOT a sweep', s3.flags.sweep === false && s3.sides[0].attackKos === 2 && s3.sides[0].indirectKos === 1 && s3.sides[0].kos === 3, J([s3.flags, s3.sides[0].attackKos, s3.sides[0].indirectKos]));
  t('hand/L3 KO streak is 3 for side 0 (three faints in a row on side 1 after two on side 0 broke... the run X, Y, Z)', s3.koStreak.n === 3 && s3.koStreak.side === 0, J(s3.koStreak));
  t('hand/L3 side 1 streak is 2 (P, Q)', s3.sides[1].koStreak === 2, String(s3.sides[1].koStreak));
  t('hand/L3 faints identity: side 1 faints 3 = side 0 kos 3 + 0 + 0; side 0 faints 2 = side 1 kos 2', s3.sides[1].faints === s3.sides[0].kos + s3.sides[1].selfFaints + s3.sides[1].envFaints && s3.sides[0].faints === s3.sides[1].kos + s3.sides[0].selfFaints + s3.sides[0].envFaints);
  t('hand/L3 indirect damage: side 0 caused 60 by seed (dealtIndirect 60)', s3.sides[0].dealtIndirect === 60, String(s3.sides[0].dealtIndirect));
  t('hand/L3 MVP is R (2 attack KOs: 2000 + 200 = ... 2000 + 2 * 100 pm = 2000 + 2000 = 4000 -> 400 points)', s3.mvp && s3.mvp.sp === 303 && s3.mvp.score === 4000 && s3.mvp.scorePts === 400, J(s3.mvp));
  // a sweep: only R scores, no indirect
  const L3b = L3.map((e) => (e.src === 'leech-seed' ? { ...e, src: 'move', mv: 6, eff: 4096 } : e));
  const s3b = M.summarizeMatch(L3b, { viewSide: 0 });
  t('hand/L3b sweep: one Pokemon (R) scored all three KOs', s3b.flags.sweep === true && s3b.sides[0].attackKos === 3, J([s3b.flags, s3b.sides[0].attackKos]));

  // L4: a forfeit and a draw
  const L4 = [...START([1, 1]), sw(1, 0, 1, 'U', 50, 50), sw(0, 0, 2, 'V', 50, 50), { t: 'turn', n: 1 }, { t: 'forfeit', s: 0 }, { t: 'win', s: 1 }];
  const s4 = M.summarizeMatch(L4, { viewSide: 0 });
  t('hand/L4 a forfeit by the view side is an f, on turn 1, ended by forfeit', J([s4.result, s4.turns, s4.endedBy, s4.flags.forfeit]) === J(['f', 1, 'forfeit', true]), J([s4.result, s4.turns, s4.endedBy]));
  const L5 = [...START([1, 1]), sw(1, 0, 1, 'U', 50, 50), sw(0, 0, 2, 'V', 50, 50), { t: 'turn', n: 299 }, { t: 'turn-cap', n: 300 }, { t: 'draw' }];
  const s5 = M.summarizeMatch(L5, { viewSide: 0 });
  t('hand/L5 a turn-cap draw is a d with 300 turns, ended by turn-cap', J([s5.result, s5.winner, s5.turns, s5.endedBy]) === J(['d', -1, 300, 'turn-cap']), J([s5.result, s5.turns, s5.endedBy]));
  t('hand/L5 an unfinished log has no result', M.summarizeMatch(L5.slice(0, 5), {}).result === 'none');
  // L6: Revival Blessing. Side 0: P (50), Q (50); side 1: U (50). P faints (attack), Q comes in, the blessing revives P to 25 (src revival-blessing): alive 2, healed 25, faints 1.
  const L6 = [...START([2, 1]), { t: 'preview', s: 0, order: [0, 1] }, { t: 'preview', s: 1, order: [0] }, sw(1, 0, 1, 'U', 50, 50), sw(0, 0, 2, 'P', 50, 50), { t: 'turn', n: 1 },
    { t: 'move-use', s: 1, m: 0, mv: 5, called: 0 }, dmg(0, 0, 50, 0, 50, { mv: 5 }), { t: 'faint', s: 0, m: 0 }, sw(0, 1, 3, 'Q', 50, 50),
    { t: 'turn', n: 2 }, { t: 'revive', s: 0, m: 0 }, { t: 'heal', s: 0, m: 0, from: 0, to: 25, max: 50, src: 'revival-blessing' }];
  const s6 = M.summarizeMatch(L6, { viewSide: 0 });
  t('hand/L6 a revive: alive 2 again, 25 HP healed, one faint counted, the deficit never passed 1', J([s6.sides[0].alive, s6.sides[0].healed, s6.sides[0].faints, s6.sides[0].deficit, s6.sides[0].mons[0].endHp]) === J([2, 25, 1, 0, 25]), J([s6.sides[0].alive, s6.sides[0].healed, s6.sides[0].faints, s6.sides[0].deficit]));
  // teams: a Pokemon never sent out still shows (with the full team given), at full health
  const sT = M.summarizeMatch(L4, { viewSide: 0, teams: [[{ slot: 0, sp: 2, name: 'V', level: 50, mhp: 50 }, { slot: 1, sp: 3, name: 'W', level: 50, mhp: 70 }], [{ slot: 0, sp: 1, name: 'U', level: 50, mhp: 50 }]] });
  t('hand/teams a bench Pokemon that never came out is listed (played 0, 70/70) and sizes follow the teams', sT.sides[0].mons.length === 2 && sT.sides[0].mons[1].played === 0 && sT.sides[0].mons[1].endHp === 70 && sT.sides[0].size === 2 && sT.sides[1].size === 1, J(sT.sides[0].mons[1]));
  // junk in the log is ignored, never thrown
  let threw = false; try { M.summarizeMatch([null, 5, 'x', {}, { t: 'nonsense' }, { t: 'damage' }], {}); } catch (_e) { threw = true; }
  t('hand/junk events do not throw', threw === false);
  t('hand/the summary is plain JSON (a round trip changes nothing)', J(JSON.parse(J(s))) === J(s) && J(JSON.parse(J(s3))) === J(s3));
}

// ---- B. real battles
function play(seed, pick, cpu, opts = {}) {
  const A = MC.randomTeam(pack, seed * 1000 + 1, 6), B = MC.randomTeam(pack, seed * 1000 + 2, 6);
  const mk = () => MC.createMatchController({ pack, teams: [A.recs, B.recs], seed, pick, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: cpu, seed: seed + 5 }] });
  const c = mk();
  c.start();
  const ai = AI.createAi({ pack, level: opts.humanLevel || 'normal', seed: seed ^ 0x77 });
  let n = 0;
  for (let g = 0; c.winner === null && g < 3000; g++) {
    const req = c.pending(0); if (!req) break;
    if (opts.forfeitAt && c.turn >= opts.forfeitAt && req.phase === 'move' && req.canForfeit) { c.submit(0, { kind: 'forfeit' }); break; }
    const ch = ai.choose(req, c.view(0), { previewInfo: { foe: c.previewInfo[1] } });
    const r = c.submit(0, ch); if (!r.ok) throw new Error('refused ' + J(ch) + ' ' + r.code);
    n++;
  }
  return { c, mk, A, B, choices: c.battle.choiceLog.map((e) => ({ s: e.s, c: e.c })) };
}
const teamsOf = (c) => [0, 1].map((s) => c.battle.s.sides[s].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp })));
const srcSeen = new Map();

function engineChecks(M, battles) {
  const bad = {};
  const fail = (k, d) => { if (!bad[k]) bad[k] = d; };
  for (const b of battles) {
    const c = b.c, ev = c.battle.events, S = c.battle.s;
    const s = M.summarizeMatch(ev, { viewSide: 0, teams: teamsOf(c) });
    const tag = b.tag;
    // 1 the winner / result
    const want = S.winner === -1 ? 'd' : S.winner === 0 ? 'w' : (ev.some((e) => e.t === 'forfeit' && e.s === 0) ? 'f' : 'l');
    if (s.result !== want || s.winner !== S.winner) fail('result', tag + ' ' + s.result + ' vs ' + want);
    if (s.turns !== c.battle.turn) fail('turns', tag + ' ' + s.turns + ' vs ' + c.battle.turn);
    for (let side = 0; side < 2; side++) {
      const sd = S.sides[side], o = s.sides[side], x = s.sides[side ^ 1];
      // 2 HP per Pokemon: start + healed - taken = end = the engine's HP
      for (const m of o.mons) {
        const em = sd.team[m.slot];
        if (!em) { fail('mon', tag + ' slot ' + m.slot + ' has no engine Pokemon'); continue; }
        if (m.endHp !== em.hp) fail('end-hp', tag + ' side ' + side + ' slot ' + m.slot + ' ' + m.endHp + ' vs engine ' + em.hp);
        if (m.sp !== em.sp || m.max !== em.mhp) fail('identity', tag + ' side ' + side + ' slot ' + m.slot);
        const revived = m.faints > 0 && ev.some((e) => e.t === 'heal' && e.s === side && e.m === m.slot && e.from === 0);
        if (m.startHp + m.healed - m.taken !== m.endHp) fail('hp-identity', tag + ' side ' + side + ' slot ' + m.slot + ' ' + m.startHp + '+' + m.healed + '-' + m.taken + ' != ' + m.endHp + (revived ? ' (revived)' : ''));
        if (m.takenByAttacks + m.takenOther !== m.taken) fail('taken-split', tag);
        if (m.endPct < 0 || m.endPct > 100 || m.dealt < 0 || m.kos < 0) fail('range', tag);
      }
      // 3 the sides
      if (o.taken !== o.takenByAttacks + o.takenOther) fail('side-taken-split', tag);
      if (x.dealt !== o.takenByAttacks) fail('dealt-equals-taken-by-attacks', tag + ' side ' + side + ' took ' + o.takenByAttacks + ' by attacks but the other side dealt ' + x.dealt);
      if (o.faints !== x.kos + o.selfFaints + o.envFaints) fail('faint-identity', tag + ' side ' + side + ' faints ' + o.faints + ' vs ' + x.kos + '+' + o.selfFaints + '+' + o.envFaints);
      if (o.faints !== (sd.nfaint || 0)) fail('faints-vs-engine', tag + ' side ' + side + ' ' + o.faints + ' vs engine nfaint ' + (sd.nfaint || 0));
      if (o.kos !== o.attackKos + o.indirectKos) fail('kos-split', tag);
      const aliveEngine = sd.team.filter((m) => m.hp > 0).length;
      if (o.alive !== aliveEngine) fail('alive', tag + ' side ' + side + ' ' + o.alive + ' vs ' + aliveEngine);
      // hits taken by attacks = the other side's landed hits (the engine counts a hit on a mon in `ht`: moves and Bide)
      const htTaken = sd.team.reduce((n, m) => n + (m.ht || 0), 0);
      if (htTaken !== x.hits) fail('hits-vs-engine-ht', tag + ' side ' + side + ' engine ht ' + htTaken + ' vs summary hits ' + x.hits);
      if (o.crits > o.hits || o.superEffective + o.resisted > o.hits) fail('hit-bounds', tag);
      if (o.hpLeft !== o.mons.reduce((n, m) => n + m.endHp, 0)) fail('hp-left', tag);
    }
    // 4 MVP / closest call / biggest hit / first blood come from real Pokemon of the match
    if (s.mvp) { const m = s.sides[0].mons.find((q) => q.slot === s.mvp.slot); if (!m || m.score !== s.mvp.score || s.sides[0].mons.some((q) => q.score > m.score)) fail('mvp', tag); }
    if (s.closestCall) { const m = s.sides[0].mons.find((q) => q.slot === s.closestCall.slot); if (!m || m.faints !== 0 || m.endHp <= 0 || s.closestCall.hp > m.max) fail('closest', tag); }
    if (s.biggestHit) { const mx = Math.max(...s.sides.flatMap((o) => o.mons.map((m) => 0)), 0); void mx; const all = ev.filter((e) => e.t === 'damage' && (e.src === 'move' || e.src === 'bide')).map((e) => e.from - e.to); if (s.biggestHit.dmg !== Math.max(...all)) fail('biggest-hit', tag + ' ' + s.biggestHit.dmg + ' vs ' + Math.max(...all)); }
    else if (ev.some((e) => e.t === 'damage' && (e.src === 'move' || e.src === 'bide'))) fail('biggest-hit-missing', tag);
    const firstFaint = ev.find((e) => e.t === 'faint');
    if (firstFaint ? !(s.firstBlood && s.firstBlood.victim.side === firstFaint.s && s.firstBlood.victim.slot === firstFaint.m) : s.firstBlood !== null) fail('first-blood', tag);
    // 5 determinism
    if (J(M.summarizeMatch(ev, { viewSide: 0, teams: teamsOf(c) })) !== J(s)) fail('deterministic', tag);
    if (J(M.summarizeMatch(JSON.parse(J(ev)), { viewSide: 0, teams: teamsOf(c) })) !== J(s)) fail('deterministic-copy', tag);
    if (J(JSON.parse(J(s))) !== J(s)) fail('plain-json', tag);
    // 6 a replay of the saved choices (what a reload does) gives the same summary
    if (b.replayOk !== false) {
      const r = b.mk(); r.start();
      let ok = true;
      for (const e of b.choices.filter((q) => q.s === 0)) { const out = r.submit(0, e.c); if (!out.ok) { ok = false; break; } }
      if (!ok || r.battle.hash() !== c.battle.hash()) fail('replay-hash', tag);
      else if (J(M.summarizeMatch(r.battle.events, { viewSide: 0, teams: teamsOf(r) })) !== J(s)) fail('replay-summary', tag);
    }
    // 7 the view side is only a point of view: the other chair has the same numbers swapped
    const s1 = M.summarizeMatch(ev, { viewSide: 1, teams: teamsOf(c) });
    if (J(s1.sides) !== J(s.sides) || s1.turns !== s.turns || J(s1.biggestHit) !== J(s.biggestHit)) fail('view-side-symmetry', tag);
    if (s.result === 'w' && s1.result !== 'l' && s1.result !== 'f') fail('view-side-result', tag);
  }
  return bad;
}

head('building ' + N_BATTLES + ' real battles');
const battles = [];
{
  const t0 = Date.now();
  const levels = ['easy', 'normal', 'hard'];
  for (let i = 0; i < N_BATTLES; i++) {
    const seed = 1000 + i * 37;
    const pick = i % 3 === 2 ? 0 : 3;
    const cpu = levels[i % 3];
    const forfeit = i % 10 === 7 ? 2 : 0;
    const b = play(seed, pick, cpu, { forfeitAt: forfeit, humanLevel: levels[(i + 1) % 3] });
    b.tag = `[seed ${seed} ${pick ? '3v3' : '6v6'} ${cpu}${forfeit ? ' forfeit' : ''}]`;
    battles.push(b);
  }
  console.log(`  ${battles.length} battles in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${battles.reduce((n, b) => n + b.c.battle.events.length, 0)} events; winners ${J([0, 1, -1].map((w) => battles.filter((b) => b.c.winner === w).length))}`);
}
for (const b of battles) for (const e of b.c.battle.events) if (e.t === 'damage') srcSeen.set(e.src, (srcSeen.get(e.src) || 0) + 1);

/* ================================================================================================================= suite runner (real module, then every mutant) */
function suiteFor(M) {
  const out = [];
  const bad = engineChecks(M, battles);
  const names = ['result', 'turns', 'end-hp', 'identity', 'hp-identity', 'taken-split', 'side-taken-split', 'dealt-equals-taken-by-attacks', 'faint-identity', 'faints-vs-engine', 'kos-split', 'alive', 'hits-vs-engine-ht', 'hit-bounds', 'hp-left', 'mvp', 'closest', 'biggest-hit', 'first-blood', 'deterministic', 'plain-json', 'replay-summary', 'view-side-symmetry'];
  for (const n of names) out.push(['engine/' + n, bad[n] === undefined ? true : bad[n]]);
  return out;
}

head('A. hand-computed logs');
hand(MS);

head('B. real engine battles (' + battles.length + ')');
{
  const t0 = Date.now();
  const rows = suiteFor(MS);
  for (const [name, ok] of rows) t(name, ok);
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const mons = battles.reduce((n, b) => n + b.c.battle.s.sides[0].team.length + b.c.battle.s.sides[1].team.length, 0);
  const faintsTotal = battles.reduce((n, b) => n + b.c.battle.s.sides[0].nfaint + b.c.battle.s.sides[1].nfaint, 0);
  t('engine/coverage: the battles are not trivial (' + mons + ' Pokemon, ' + faintsTotal + ' faints, results ' + J(['w', 'l', 'd', 'f'].map((r) => battles.filter((b) => MS.summarizeMatch(b.c.battle.events, { viewSide: 0 }).result === r).length)) + ')', faintsTotal > N_BATTLES * 2 && battles.some((b) => b.c.winner === 1) && battles.some((b) => b.c.winner === 0) && battles.some((b) => b.c.battle.events.some((e) => e.t === 'forfeit')));
  const kinds = new Set(); for (const b of battles) for (const e of b.c.battle.events) kinds.add(e.t);
  for (const k of ['crit', 'miss', 'status-set', 'heal', 'recoil', 'weather-tick', 'switch-out', 'immune']) t('engine/coverage: the battles contain "' + k + '" events', kinds.has(k) || (k === 'weather-tick' && kinds.has('weather')), [...kinds].join(','));
}

head('C. damage sources and purity');
t('purity: match_stats.js reads no clock, no randomness, no DOM and imports nothing', !/Date\.now|performance\.now|Math\.random|document|window|\bimport\b.*from/.test(MSRC.replace(/\/\/.*$/gm, '')));
t('purity: match_stats.js is ASCII only', /^[\x09\x0a\x0d\x20-\x7e]*$/.test(MSRC));
{
  const unknown = [...srcSeen.keys()].filter((k) => !Object.prototype.hasOwnProperty.call(MS.CLASS_OF_SRC, k));
  t('sources: every damage src the engine emitted in ' + battles.length + ' battles (' + [...srcSeen.keys()].sort().join(' ') + ') is classified' + (unknown.length ? ' -- UNKNOWN: ' + unknown.join(' ') : ''), unknown.length === 0, unknown.join(','));
  const engineSrcs = new Set(); for (const f of fs.readdirSync(JS).filter((n) => /^engine.*\.js$/.test(n))) for (const m of fs.readFileSync(path.join(JS, f), 'utf8').matchAll(/src: '([a-z-]+)'/g)) engineSrcs.add(m[1]);
  const heals = new Set(['wish', 'water-absorb', 'volt-absorb', 'swallow', 'strength-sap', 'spectral-drain', 'sitrus', 'shell-bell', 'ritualist', 'revival-blessing', 'rest', 'rejuvenation', 'regenerator', 'reef-warden', 'reborn', 'rain-dish', 'present', 'poison-heal', 'oran', 'mending', 'maim-and-mend', 'lifesteal', 'leftovers', 'jade-bloom', 'ingrain', 'ice-body', 'grassy-terrain', 'glacial', 'enigma-berry', 'earth-eater', 'drain', 'consume', 'cheek-pouch', 'channel-earth', 'aqua-ring', 'berry']);
  const missing = [...engineSrcs].filter((k) => !MS.CLASS_OF_SRC[k] && !heals.has(k));
  t('sources: every src the engine SOURCE can put on a damage that is not a known heal source is classified (a new one must be classified on purpose): ' + (missing.join(' ') || 'none missing'), missing.length === 0, missing.join(','));
  t('sources: the three classes plus attack are the only classes', new Set(Object.values(MS.CLASS_OF_SRC)).size === 4 && ['attack', 'foe', 'self', 'env'].every((k) => Object.values(MS.CLASS_OF_SRC).includes(k)));
}

/* ================================================================================================================= D. mutants */
const MUTANTS = [
  ['M01 the attacker is the wrong side', "attacker = mons[e.s ^ 1].get(active[e.s ^ 1]) || null;", "attacker = mons[e.s].get(active[e.s]) || null;", ['hand/L1 damage dealt per Pokemon and per side']],
  ['M02 damage taken ignores the other sources', "t.taken += lost;", "if (CLASS_OF_SRC[e.src] === 'attack') t.taken += lost;", ['hand/L2 taken: E 20 + 6 = 26 (20 by attacks, 6 other); F 30 + 5 + 12 + 63 = 110 (30 by attacks, 80 other)']],
  ['M03 crits are not counted', "if (e.crit) attacker.crits++;", "", ['hand/L1 hits 2 + 1, crits 1 + 1, super effective 2 + 1, resisted: B-C hit on A was 2048 (1)']],
  ['M04 resisted hits count as super effective', "if (e.eff > 4096) attacker.superEffective++; else if (e.eff > 0 && e.eff < 4096) attacker.resisted++;", "if (e.eff > 4096 || e.eff < 4096) attacker.superEffective++;", ['hand/L1 hits 2 + 1, crits 1 + 1, super effective 2 + 1, resisted: B-C hit on A was 2048 (1)']],
  ['M05 a poison faint is credited as a KO', "else side[e.s].envFaints++;", "else { side[e.s ^ 1].indirectKos++; }", ['hand/L2 the faint was caused by poison: nobody scored it; E has 0 KOs, F envFaints 1; identity faints = other.kos + self + env']],
  ['M06 the faint is credited to the victim\'s own side', "if (a) { a.kos++; by = ld.attacker; }", "if (a) { const v = mons[e.s].get(e.m); v.kos++; by = ld.attacker; }", ['hand/L1 KOs: A scored one (B), D scored one (C); faints: A 1, B 1, C 1']],
  ['M07 the MVP tie is broken the wrong way', "(m.faints < mvp.faints || (m.faints === mvp.faints && m.slot < mvp.slot))", "(m.faints > mvp.faints || (m.faints === mvp.faints && m.slot < mvp.slot))", ['hand/L1 MVP: A and D tie on 2000 (100 per KO + damage %), D wins the tie on faints']],
  ['M08 the biggest hit keeps the LAST of equal hits and the smaller one', "if (lost > 0 && (!biggest || lost > biggest.dmg)) biggest = hit;", "if (lost > 0 && (!biggest || lost < biggest.dmg)) biggest = hit;", ['hand/L1 biggest hit is D 90 on turn 4']],
  ['M09 healing is not counted', "t.healed += gain; t.hp = e.to | 0;", "t.hp = e.to | 0;", ['hand/L2 healed: F 10']],
  ['M10 a miss is counted for the defender', "case 'miss': mon(e.s, e.m).misses++; break;", "case 'miss': { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) a.misses++; break; }", ['hand/L2 misses: E missed once and F avoided once (2); no effect 1 (F\'s move 21); blocked 1 (E blocked F? no: F\'s 22 was protected against)']],
  ['M11 a status the holder gave itself counts as inflicted', "if (!SELF_STATUS_FX.has(e.fx)) {", "if (true) {", ['hand/L2 status: E inflicted one on F (st 2); F suffered 2 (the Toxic Orb it gave itself is suffered, not inflicted)']],
  ['M12 turns on the field are not counted', "if (a && a.hp > 0) a.turns++;", "", ['hand/L1 turns on the field: A 3, B 2, C 2, D 1']],
  ['M13 the KO streak is never reset', "lastFaintSide === e.s ? side[e.s ^ 1].streak + 1 : 1;", "side[e.s ^ 1].streak + 1;", ['hand/L1 KO streak is 1 (every faint alternated sides)']],
  ['M14 the comeback deficit is not measured', "side[0].worstAlive = Math.max(side[0].worstAlive, a1 - a0);", "", ['hand/L3 comeback: side 0 was two Pokemon down (1 alive vs 3) and won']],
  ['M15 a forfeit is a loss', "winner === viewSide ? 'w' : forfeited[viewSide] ? 'f' : 'l'", "winner === viewSide ? 'w' : 'l'", ['hand/L4 a forfeit by the view side is an f, on turn 1, ended by forfeit']],
  ['M16 the percent rounds down', "const pct = (a, b) => (b > 0 ? Math.floor((200 * a + b) / (2 * b)) : 0);", "const pct = (a, b) => (b > 0 ? Math.floor((100 * a) / b) : 0);", ['hand/L1 end HP: A 0, D 70/70, team left 70 of 150 (47 %)']],
  ['M17 closest call includes Pokemon that fainted', "m.lowHp >= 0 && m.faints === 0 ?", "m.lowHp >= 0 ?", ["hand/L1 closest call is null (the only Pokemon that was hurt fainted)"]],
  ['M18 the sub-hit counts as dealt damage', "case 'sub-damage': { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) a.subHits++; break; }", "case 'sub-damage': { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) { a.subHits++; a.dealt += e.n | 0; } break; }", ['engine/dealt-equals-taken-by-attacks']],
  ['M19 a revive is not noticed (alive counts)', "if ((e.from | 0) === 0 && gain > 0) side[e.s].dead = Math.max(0, side[e.s].dead - 1);", "", ["hand/L6 a revive: alive 2 again, 25 HP healed, one faint counted, the deficit never passed 1"]],
  ['M20 environment damage is credited to the foe as a KO class', "psn: 'env', tox: 'env', brn: 'env', fbt: 'env',", "psn: 'foe', tox: 'foe', brn: 'foe', fbt: 'foe',", ['hand/L2 dealt: E 30 (30 %), F 20; indirect none', 'hand/L2 the faint was caused by poison: nobody scored it; E has 0 KOs, F envFaints 1; identity faints = other.kos + self + env']],
  ['M22 the last hit is taken from the first KO', "lastKo = f;", "if (!lastKo) lastKo = f;", ['hand/L1 last hit is D\'s move 7 on C']],
];
// the hand checks report through t(); for the mutants we run them against a captured reporter
async function loadMutant(from, to) {
  const n = MSRC.split(from).length - 1;
  if (n !== 1) throw new Error('mutation target found ' + n + 'x: ' + from.slice(0, 70));
  const f = path.join(os.tmpdir(), 'arena-ms-mutant-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(f, MSRC.replace(from, () => to));
  try { return await import(pathToFileURL(f).href); } finally { try { fs.unlinkSync(f); } catch (_e) { /* ignore */ } }
}
if (!process.env.ARENA_SKIP_MUTANTS) {
  head('D. mutants: each must fail a named check; the unmutated twin through the same loader must not');
  // a result-collecting twin of t()
  const collect = (M) => {
    const fails = new Set();
    const keep = { p: passed, f: failed, fl: failures.length, fn: failNames.length };
    const origLog = console.log;
    console.log = () => {};
    try { hand(M); } catch (e) { fails.add('THREW ' + e.message); }
    console.log = origLog;
    for (const nm of failNames.slice(keep.fn)) fails.add(nm);
    failures.length = keep.fl; failNames.length = keep.fn; passed = keep.p; failed = keep.f;
    try { for (const [n, ok] of suiteFor(M)) if (ok !== true) fails.add(n); } catch (e) { fails.add('THREW ' + e.message); }
    return fails;
  };
  const twin = await loadMutant("export const SUMMARY_VERSION = 1;", "export const SUMMARY_VERSION = 1;");
  const twinFails = collect(twin);
  t('mutants: the unmutated twin passes every hand-computed and engine check', twinFails.size === 0, [...twinFails].join(' | '));
  let caught = 0, total = 0;
  for (const [id, from, to, expect] of MUTANTS) {
    total++;
    let M;
    try { M = await loadMutant(from, to); } catch (e) { t(id + ' loads', false, e.message); continue; }
    const fails = collect(M);
    if (from === to) { t(id + ' (equivalent: documented, not counted)', true); caught++; continue; }
    const named = expect.length ? expect.some((x) => [...fails].some((f) => f.startsWith(x.slice(0, 40)))) : fails.size > 0;
    if (named) caught++;
    t(id + ' -> ' + (expect.length ? 'caught by a NAMED check' : 'caught'), named, 'failed checks: ' + ([...fails].join(' | ').slice(0, 200) || 'none'));
  }
  console.log(`  mutants ${caught}/${total}`);
}

console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exitCode = 1; }

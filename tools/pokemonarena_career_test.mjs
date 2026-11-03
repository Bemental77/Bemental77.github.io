#!/usr/bin/env node
// POKEMONARENA CAREER TEST (ST1) -- the battle record kept on a profile: pokemonarena/js/career_stats.js, profile.js (schema 3: migration, check, repair,
// recordMatch, resetRecord, planImport), store.js (recordMatch / resetRecord inside one transaction, restoreRevision, history).
//
//   A  FOLD, BY HAND   one match at a time into a record: every counter, the streaks, the bests, the favourites (with their cap), the recent list, the
//                      callouts, saturation, idempotence by match id, bad matches refused, the input never modified.
//   B  FOLD, FOR REAL  N real engine battles folded in order through profile.recordMatch; every total is recomputed from the battles by a separate loop.
//   C  SCHEMA 3        the strict check, the repair of hostile stats (every key), the v2 -> v3 migration against a hand-written golden, the v1 -> v3 chain,
//                      a v4 document stays read-only, a fuzz of the stats block (open never throws, the result is valid and a fixed point).
//   D  IMPORT          what an import does with the record: new = copied, merge = left exactly as it is, replace = the file's.
//   E  THE STORE       one transaction; a duplicate writes nothing; two tabs at once lose nothing; an editor holding a stale revision is told (Conflict); no
//                      history entries from battles; a restore of old teams keeps the record; reset takes a backup and a history entry; newer / missing /
//                      damaged documents; the `saved` broadcast; an old (v2) document is migrated first.
//   F  MUTANTS         one-snippet defects of career_stats.js, profile.js and store.js (in a temp copy of the module tree), each of which must trip a NAMED check.
//
//   node tools/pokemonarena_career_test.mjs        ARENA_BATTLES=n (default 80), ARENA_FUZZ=k (default 1), ARENA_SKIP_MUTANTS=1
// Pure ASCII. Writes only a temp copy of pokemonarena/js (for the mutants).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const FX = path.join(here, 'fixtures', 'pokemonarena');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const N_BATTLES = Math.max(10, Number(process.env.ARENA_BATTLES || 80));
const FUZZ = Math.max(1, Number(process.env.ARENA_FUZZ || 1));
import { canonicalJSON } from '../pokemonarena/js/stats.js';
const J = (x) => { try { return canonicalJSON(x); } catch (_e) { return String(x); } };                      // keys sorted: two documents are equal when they say the same thing, whatever order they were built in
const clone = (o) => JSON.parse(JSON.stringify(o));
const readFx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH); process.exit(2); }

const T = await import(pathToFileURL(path.join(JS, 'tables.js')).href);
const MC = await import(pathToFileURL(path.join(JS, 'matchctl.js')).href);
const AI = await import(pathToFileURL(path.join(JS, 'ai.js')).href);
const MSreal = await import(pathToFileURL(path.join(JS, 'match_stats.js')).href);
const pack = T.loadPack(fs.readFileSync(ROM_PATH), { verify: 'header', dexText: false });

let passed = 0, failed = 0;
const failures = [], failNames = [];
function report(name, ok, detail) { if (ok === true) { passed++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); } else { failed++; failNames.push(name); const why = typeof ok === 'string' ? ok : detail || ''; failures.push(name + ': ' + why); console.log('  FAIL ' + name + (why ? ' -- ' + String(why).slice(0, 400) : '')); } }
const head = (s) => console.log('\n== ' + s);
const NOW = 1700000999999;
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function detDeps(seed = 1, t0 = NOW) { const r = mulberry32(seed); let tm = t0; return { now: () => tm, randomBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256)), advance: (d) => { tm += d; } }; }
const FIX = { v2: readFx('profile-v2-current.json'), v2exp: readFx('profile-v2-current.expected-v3.json'), cur: readFx('profile-v3-current.json'), fut: readFx('profile-v4-future.json'), v1full: readFx('profile-v1-full.json'), v1fullExp: readFx('profile-v1-full.expected-v3.json') };

const mkMatch = (o = {}) => ({
  id: 'm1', at: 1000, fmt: '3v3', cpu: 'normal', ruleset: 'arena-gen3-standard', result: 'w', turns: 10, playMs: 60000, mvp: 25, team: [25, 6, 9], species: [25, 6], moves: [[85, 3], [33, 2]],
  me: { kos: 2, faints: 1, dealt: 300, taken: 200, hits: 5, crits: 1, superEffective: 2, resisted: 1, noEffect: 0, misses: 1, statusInflicted: 1, healed: 20, switches: 1, koStreak: 2, biggestHit: { sp: 25, mv: 85, dmg: 120, pct: 70, vs: 6 } }, foeFaints: 3,
  ...o,
});
const deepFreeze = (o) => { if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

/* ================================================================================================== the suite, over any set of modules */
async function suite(M) {
  const out = [];
  const add = (name, result) => out.push([name, result]);
  const blk = async (name, fn) => { try { await fn(); } catch (e) { add('crash/' + name, 'threw ' + (e && e.message ? e.message : e)); } };      // a defect that makes a section throw is a failure, named by the section
  const C = M.C, P = M.P, S = M.S;
  const base = () => { const p = P.createProfile({ trainerName: 'ASH' }, detDeps(3)); return p; };
  const fold = (stats, m, rs = 'arena-gen3-standard') => C.foldMatch(stats, m, rs);
  const empty = () => P.emptyStats();

  // ---------------------------------------------------------------------------------------------------- A. by hand
  await blk('fold-by-hand', async () => {
    const f1 = fold(empty(), mkMatch());
    const s = f1.stats;
    add('fold/first-win-counters', J([s.wins, s.losses, s.draws, s.forfeits, s.streak, s.best, s.lastMatchAt, s.firstMatchAt, s.playMs]) === J([1, 0, 0, 0, 1, 1, 1000, 1000, 60000]) ? true : J(s));
    add('fold/by-format-by-cpu-by-ruleset', J([s.byFormat['3v3'], s.byFormat['6v6'], s.byCpu.normal, s.byCpu.easy, s.byRuleset]) === J([{ w: 1, l: 0, dr: 0, f: 0 }, { w: 0, l: 0, dr: 0, f: 0 }, { w: 1, l: 0, dr: 0, f: 0 }, { w: 0, l: 0, dr: 0, f: 0 }, { 'arena-gen3-standard': { w: 1, l: 0 } }]) ? true : J([s.byFormat, s.byCpu, s.byRuleset]));
    add('fold/totals', J(s.totals) === J({ turns: 10, kos: 2, faints: 1, dealt: 300, taken: 200, hits: 5, crits: 1, superEffective: 2, resisted: 1, noEffect: 0, misses: 1, statusInflicted: 1, healed: 20, switches: 1 }) ? true : J(s.totals));
    add('fold/bests', J(s.bests) === J({ hit: { sp: 25, mv: 85, dmg: 120, pct: 70, vs: 6, at: 1000 }, fastestWin: { turns: 10, at: 1000 }, longest: { turns: 10, at: 1000 }, koStreak: 2 }) ? true : J(s.bests));
    add('fold/favourites', J(s.fav) === J({ species: { 6: 1, 25: 1 }, moves: { 33: 2, 85: 3 }, mvps: { 25: 1 } }) ? true : J(s.fav));
    add('fold/recent-entry', J(s.recent) === J([{ id: 'm1', at: 1000, fmt: '3v3', cpu: 'normal', res: 'w', turns: 10, mvp: 25, team: [25, 6, 9] }]) ? true : J(s.recent));
    add('fold/first-win-is-the-only-callout-on-a-fresh-record', J(f1.callouts) === J([{ kind: 'first-win', n: 1 }]) ? true : J(f1.callouts));
    add('fold/result-is-well-formed-by-the-strict-check', (() => { const p = base(); p.stats = s; const bad = P.checkProfile(p); return bad.length === 0 ? true : J(bad.slice(0, 2)); })());

    // a second win: faster, bigger hit, longer KO streak, a streak of 2
    const m2 = mkMatch({ id: 'm2', at: 2000, turns: 7, me: { ...mkMatch().me, koStreak: 3, biggestHit: { sp: 6, mv: 7, dmg: 150, pct: 88, vs: 9 } } });
    const f2 = fold(s, m2);
    add('fold/callouts-compare-with-the-numbers-BEFORE-the-match', J(f2.callouts.map((c) => c.kind)) === J(['streak', 'fastest', 'hit', 'ko-streak']) ? true : J(f2.callouts));
    add('fold/callout-numbers', J(f2.callouts.map((c) => c.n)) === J([2, 7, 150, 3]) ? true : J(f2.callouts));
    add('fold/bests-move-only-forward', J([f2.stats.bests.hit.dmg, f2.stats.bests.hit.sp, f2.stats.bests.fastestWin.turns, f2.stats.bests.longest.turns, f2.stats.bests.koStreak, f2.stats.best, f2.stats.streak]) === J([150, 6, 7, 10, 3, 2, 2]) ? true : J(f2.stats.bests));
    add('fold/recent-is-newest-first', J(f2.stats.recent.map((r) => r.id)) === J(['m2', 'm1']) ? true : J(f2.stats.recent));
    // a tie is not a record
    const m3 = mkMatch({ id: 'm3', at: 3000, turns: 7, me: { ...mkMatch().me, koStreak: 3, biggestHit: { sp: 6, mv: 7, dmg: 150, pct: 88, vs: 9 } } });
    const f3 = fold(f2.stats, m3);
    add('fold/a-tie-is-not-a-record', f3.callouts.filter((c) => c.kind !== 'streak').length === 0 && f3.stats.bests.hit.at === 2000 && f3.stats.bests.fastestWin.at === 2000 ? true : J(f3.callouts) + J(f3.stats.bests));
    // a loss ends the run, keeps the best; a forfeit and a draw
    const fl = fold(f3.stats, mkMatch({ id: 'm4', at: 4000, result: 'l', turns: 20 }));
    add('fold/a-loss-resets-the-streak-and-keeps-the-best', J([fl.stats.losses, fl.stats.streak, fl.stats.best]) === J([1, 0, 3]) ? true : J([fl.stats.losses, fl.stats.streak, fl.stats.best]));
    add('fold/a-loss-is-no-fastest-win-and-a-longest-battle-is-called-out', J(fl.callouts) === J([{ kind: 'longest', n: 20 }]) ? true : J(fl.callouts));
    const ff = fold(fl.stats, mkMatch({ id: 'm5', at: 5000, result: 'f', turns: 3, fmt: '6v6', cpu: 'hard' }));
    add('fold/a-forfeit-is-a-forfeit-not-a-loss', J([ff.stats.forfeits, ff.stats.losses, ff.stats.byFormat['6v6'].f, ff.stats.byCpu.hard.f, ff.stats.byRuleset['arena-gen3-standard']]) === J([1, 1, 1, 1, { w: 3, l: 2 }]) ? true : J([ff.stats.forfeits, ff.stats.losses, ff.stats.byRuleset]));
    const fd = fold(ff.stats, mkMatch({ id: 'm6', at: 6000, result: 'd', turns: 300, cpu: 'easy' }));
    add('fold/a-draw-is-a-draw-and-touches-no-ruleset-w-l', J([fd.stats.draws, fd.stats.byFormat['3v3'].dr, fd.stats.byCpu.easy.dr, fd.stats.byRuleset['arena-gen3-standard'], fd.stats.streak]) === J([1, 1, 1, { w: 3, l: 2 }, 0]) ? true : J([fd.stats.draws, fd.stats.byRuleset]));
    add('fold/battle-count-is-the-sum-of-the-four', C.battleCount(fd.stats) === 6 ? true : String(C.battleCount(fd.stats)));
    add('fold/an-unknown-ruleset-id-leaves-byRuleset-alone', J(fold(empty(), mkMatch(), null).stats.byRuleset) === '{}' ? true : 'touched');
    // idempotence
    const dup = fold(f2.stats, m2);
    add('fold/the-same-match-id-twice-changes-nothing', dup.duplicate === true && J(dup.stats) === J(f2.stats) && dup.callouts.length === 0 ? true : J([dup.duplicate, dup.callouts]));
    add('fold/a-match-id-seen-before-is-a-duplicate-even-with-other-numbers', fold(f2.stats, { ...m2, result: 'l', turns: 1 }).duplicate === true ? true : 'folded again');
    // input untouched
    await blk('fold-input', async () => {
      const st = deepFreeze(clone(f2.stats)), mm = deepFreeze(mkMatch({ id: 'zz' }));
      let threw = null; try { fold(st, mm); } catch (e) { threw = e; }
      add('fold/never-modifies-its-input', threw === null ? true : 'threw ' + threw.message);
    });
    // recent cap
    let st = empty();
    for (let i = 0; i < 30; i++) st = fold(st, mkMatch({ id: 'r' + i, at: 10000 + i })).stats;
    add('fold/recent-keeps-the-newest-20', st.recent.length === 20 && st.recent[0].id === 'r29' && st.recent[19].id === 'r10' && C.battleCount(st) === 30 ? true : J(st.recent.map((r) => r.id)));
    // favourites cap with space saving: species 1 is used by every match, 40 other species once each
    let sf = empty();
    for (let i = 0; i < 40; i++) sf = fold(sf, mkMatch({ id: 'f' + i, at: 20000 + i, species: [1, 100 + i], mvp: 0, moves: [[1000 + i, 1]], team: [1, 100 + i] })).stats;
    const spKeys = Object.keys(sf.fav.species), mvKeys = Object.keys(sf.fav.moves);
    add('fold/favourites-are-capped', spKeys.length === C.CAREER_LIMITS.speciesMax && mvKeys.length === C.CAREER_LIMITS.movesMax ? true : J([spKeys.length, mvKeys.length]));
    add('fold/the-heavy-hitter-survives-the-cap-and-its-count-is-exact', sf.fav.species['1'] === 40 ? true : String(sf.fav.species['1']));
    add('fold/space-saving: a newcomer takes over the least-used entry and its count + 1 (never below the truth)', Object.values(sf.fav.species).every((n) => n >= 1) && Object.values(sf.fav.species).filter((n) => n > 1).length >= 1 ? true : J(sf.fav.species));
    add('fold/the-capped-record-is-still-valid', (() => { const p = base(); p.stats = sf; const bad = P.checkProfile(p); return bad.length === 0 ? true : J(bad.slice(0, 2)); })());
    // saturation
    const big = clone(empty()); big.wins = Number.MAX_SAFE_INTEGER; big.totals.dealt = Number.MAX_SAFE_INTEGER; big.playMs = Number.MAX_SAFE_INTEGER - 5;
    const fs2 = fold(big, mkMatch());
    add('fold/counters-saturate-at-the-largest-safe-integer', fs2.stats.wins === Number.MAX_SAFE_INTEGER && fs2.stats.totals.dealt === Number.MAX_SAFE_INTEGER && fs2.stats.playMs === Number.MAX_SAFE_INTEGER ? true : J([fs2.stats.wins, fs2.stats.totals.dealt, fs2.stats.playMs]));
    // matches that must be refused
    const bads = [
      ['result', { result: 'x' }], ['turns', { turns: -1 }], ['turns-big', { turns: 1e9 }], ['id', { id: 'has space' }], ['id-empty', { id: '' }], ['fmt', { fmt: '4v4' }], ['cpu', { cpu: 'impossible' }], ['at', { at: -5 }], ['at-float', { at: 1.5 }],
      ['playMs', { playMs: 1e12 }], ['team', { team: [1, 2, 3, 4, 5, 6, 7] }], ['team-zero', { team: [0] }], ['moves', { moves: [[0, 1]] }], ['moves-shape', { moves: [[1, 2, 3]] }], ['mvp', { mvp: 70000 }], ['me', { me: null }],
      ['hit-pct', { me: { ...mkMatch().me, biggestHit: { sp: 1, mv: 1, dmg: 5, pct: 101, vs: 1 } } }], ['kos-float', { me: { ...mkMatch().me, kos: 1.5 } }], ['kos-negative', { me: { ...mkMatch().me, kos: -1 } }],
    ];
    const notRefused = bads.filter(([, over]) => C.matchIssue(mkMatch(over)) === null).map(([n]) => n);
    add('match/bad-matches-are-refused-with-a-reason', notRefused.length === 0 ? true : 'accepted: ' + notRefused.join(','));
    add('match/foldMatch-throws-a-RangeError-for-a-bad-match', (() => { try { fold(empty(), mkMatch({ result: 'x' })); return 'did not throw'; } catch (e) { return e instanceof RangeError ? true : 'threw ' + e.name; } })());
    add('match/a-good-match-has-no-issue', C.matchIssue(mkMatch()) === null ? true : C.matchIssue(mkMatch()));
    add('match/win-rate-rounds-half-up-and-is-null-before-the-first-battle', J([C.winRate(empty()), C.winRate({ ...empty(), wins: 1, losses: 2 }), C.winRate({ ...empty(), wins: 2, losses: 1 }), C.winRate({ ...empty(), wins: 1, losses: 7 }), C.winRate({ ...empty(), wins: 3, forfeits: 1 }), C.winRate({ ...empty(), wins: 5 })]) === J([null, 33, 67, 13, 75, 100]) ? true : J([C.winRate({ ...empty(), wins: 1, losses: 7 })]));
    add('match/favList-orders-by-count-then-id', J(C.favList({ 5: 2, 3: 2, 9: 7, 1: 1 }, 3)) === J([[9, 7], [3, 2], [5, 2]]) ? true : J(C.favList({ 5: 2, 3: 2, 9: 7, 1: 1 }, 3)));
  });

  // ---------------------------------------------------------------------------------------------------- B. for real
  await blk('real', async () => {
    let p = base();
    const expected = { w: 0, l: 0, d: 0, f: 0, kos: 0, faints: 0, dealt: 0, taken: 0, turns: 0, hits: 0, crits: 0, bestHit: 0, fastest: Infinity, longest: 0, streak: 0, best: 0, playMs: 0, movesTotal: 0 };
    let stepsOk = true, firstBad = '';
    const results = [];
    for (let i = 0; i < M.battles.length; i++) {
      const b = M.battles[i];
      const sum = M.MS.summarizeMatch(b.events, { viewSide: 0, teams: b.teams });
      const m = C.matchFromSummary(sum, { id: 'real' + i, at: 1700000000000 + i * 1000, fmt: b.fmt, cpu: b.cpu, ruleset: 'arena-gen3-standard', playMs: 20000 + i });
      const r = P.recordMatch(p, m);
      if (!r.ok) { stepsOk = false; firstBad = i + ': ' + J(r); break; }
      p = r.profile;
      const bad = P.checkProfile(p);
      if (bad.length) { stepsOk = false; firstBad = i + ': ' + J(bad.slice(0, 2)); break; }
      expected[sum.result] += 1; results.push(sum.result);
      const me = sum.sides[0];
      expected.kos += me.kos; expected.faints += me.faints; expected.dealt += me.dealt; expected.taken += me.taken; expected.turns += sum.turns; expected.hits += me.hits + me.subHits; expected.crits += me.crits;
      expected.playMs += 20000 + i;
      if (me.biggestHit) expected.bestHit = Math.max(expected.bestHit, me.biggestHit.dmg);
      if (sum.result === 'w') expected.fastest = Math.min(expected.fastest, sum.turns);
      expected.longest = Math.max(expected.longest, sum.turns);
      expected.movesTotal += me.moves.reduce((n, q) => n + q[1], 0);
    }
    add('real/every-step-is-recordable-and-leaves-a-valid-profile', stepsOk ? true : firstBad);
    const s = p.stats;
    add('real/counters-match-the-battles', J([s.wins, s.losses, s.draws, s.forfeits]) === J([expected.w, expected.l, expected.d, expected.f]) ? true : J([s.wins, s.losses, s.draws, s.forfeits]) + ' vs ' + J(expected));
    add('real/battle-count-is-the-number-of-battles', C.battleCount(s) === M.battles.length ? true : String(C.battleCount(s)));
    add('real/totals-match-a-separate-recount', J([s.totals.kos, s.totals.faints, s.totals.dealt, s.totals.taken, s.totals.turns, s.totals.hits, s.totals.crits]) === J([expected.kos, expected.faints, expected.dealt, expected.taken, expected.turns, expected.hits, expected.crits]) ? true : J(s.totals) + ' vs ' + J(expected));
    add('real/bests-match-a-separate-recount', J([s.bests.hit ? s.bests.hit.dmg : 0, s.bests.fastestWin ? s.bests.fastestWin.turns : Infinity, s.bests.longest.turns]) === J([expected.bestHit, expected.fastest === Infinity ? Infinity : expected.fastest, expected.longest]) || (s.bests.fastestWin === null && expected.fastest === Infinity) ? true : J(s.bests) + ' vs ' + J(expected));
    // the streak is the trailing run of wins, best the longest run
    let run = 0, best = 0; for (const r of results) { run = r === 'w' ? run + 1 : 0; best = Math.max(best, run); }
    add('real/streak-and-best-streak-match-a-separate-recount', s.streak === run && s.best === best ? true : J([s.streak, s.best, run, best]));
    add('real/play-time-adds-up', s.playMs === expected.playMs ? true : J([s.playMs, expected.playMs]));
    add('real/recent-is-the-last-20-newest-first', s.recent.length === Math.min(20, M.battles.length) && s.recent[0].id === 'real' + (M.battles.length - 1) && s.recent.every((r, i, a) => i === 0 || a[i - 1].at > r.at) ? true : J(s.recent.map((r) => r.id)));
    add('real/favourite-moves-count-every-use', Object.values(s.fav.moves).reduce((n, v) => n + v, 0) <= expected.movesTotal && Object.keys(s.fav.moves).length <= C.CAREER_LIMITS.movesMax ? true : J(Object.keys(s.fav.moves).length));
    add('real/the-record-survives-a-canonical-round-trip-through-open', (() => { const o = P.openProfileDocument(clone(p), { deps: detDeps() }); return o.ok && !o.changed && o.problems.length === 0 && J(o.profile) === J(p) ? true : 'changed ' + J(o.problems.slice(0, 2)); })());
    add('real/the-record-survives-export-and-import', await (async () => { const text = P.serializeExport(P.buildExport(p, { deps: detDeps() })); const r = await P.parseExport(text, {}); return r.ok && J(r.profile.stats) === J(p.stats) ? true : J(r).slice(0, 200); })());
    add('real/the-export-text-has-no-bare-d-member-(a-private-key-lookalike)', !/"d"\s*:/.test(P.serializeExport(P.buildExport(p, { deps: detDeps() }))) ? true : 'a "d" member');
  });

  // ---------------------------------------------------------------------------------------------------- C. schema 3
  await blk('schema', async () => {
    add('schema/current-version-is-3', P.SCHEMA_VERSION === 3 ? true : String(P.SCHEMA_VERSION));
    add('schema/a-fresh-profile-has-an-empty-well-formed-record', (() => { const p = base(); return P.checkProfile(p).length === 0 && C.battleCount(p.stats) === 0 && J(Object.keys(p.stats).sort()) === J(['bests', 'best', 'byCpu', 'byFormat', 'byRuleset', 'draws', 'fav', 'firstMatchAt', 'forfeits', 'lastMatchAt', 'losses', 'playMs', 'recent', 'streak', 'totals', 'wins'].sort()) ? true : J(Object.keys(p.stats)); })());
    add('schema/the-current-fixture-is-valid-and-a-fixed-point', (() => { const o = P.openProfileDocument(clone(FIX.cur), { deps: detDeps() }); return o.ok && !o.changed && o.problems.length === 0 && J(o.profile) === J(FIX.cur) ? true : J(o.problems.slice(0, 3)); })());
    // migration
    const mv = P.openProfileDocument(clone(FIX.v2), { deps: detDeps() });
    add('migrate/v2-to-v3-golden', mv.ok && mv.migratedFrom === 2 && mv.changed === true && mv.problems.length === 0 && J(mv.profile) === J(FIX.v2exp) ? true : (mv.ok ? 'differs: ' + J(mv.profile.stats) : J(mv)));
    add('migrate/v2-counters-and-by-ruleset-survive-unchanged', mv.ok && J([mv.profile.stats.wins, mv.profile.stats.losses, mv.profile.stats.forfeits, mv.profile.stats.streak, mv.profile.stats.best, mv.profile.stats.lastMatchAt, mv.profile.stats.byRuleset]) === J([3, 1, 1, 2, 3, 1700000550000, { 'arena-gen3-standard+strict-champions': { w: 3, l: 1 } }]) ? true : 'lost');
    add('migrate/the-chain-v1-to-v3-matches-the-hand-written-golden', (() => { const o = P.openProfileDocument(clone(FIX.v1full), { deps: detDeps() }); return o.ok && o.migratedFrom === 1 && J(o.profile) === J(FIX.v1fullExp) ? true : (o.ok ? 'differs' : J(o)); })());
    add('migrate/a-v2-document-that-already-had-a-v3-key-keeps-it-in-the-bag', (() => {
      const d = clone(FIX.v2); d.stats.totals = { surprise: 1 }; d.stats.recent = 'old note';
      const o = P.openProfileDocument(d, { deps: detDeps() });
      return o.ok && o.profile.stats._unknown && J(o.profile.stats._unknown.totals) === J({ surprise: 1 }) && o.profile.stats._unknown.recent === 'old note' && P.checkProfile(o.profile).length === 0 && o.profile.stats.totals.kos === 0 ? true : J(o).slice(0, 300);
    })());
    add('migrate/idempotent-and-a-fixed-point-after-one-pass', (() => { const a = P.openProfileDocument(clone(FIX.v2), { deps: detDeps() }); const b = P.openProfileDocument(clone(a.profile), { deps: detDeps() }); return b.ok && !b.changed && b.problems.length === 0 && J(b.profile) === J(a.profile) ? true : 'second pass changed'; })());
    add('migrate/a-v4-document-is-read-only-and-untouched', (() => { const o = P.openProfileDocument(clone(FIX.fut), { deps: detDeps() }); return o.ok && o.readOnly === true && o.changed === false && J(o.profile) === J(FIX.fut) ? true : J(o).slice(0, 200); })());
    // hostile stats, key by key: each case is applied to a valid v3 document; the result must open, be valid, repair or set aside only that key, and be a fixed point
    const cases = [
      ['firstMatchAt-text', (s) => { s.firstMatchAt = 'soon'; }], ['firstMatchAt-negative', (s) => { s.firstMatchAt = -1; }], ['playMs-float', (s) => { s.playMs = 1.5; }], ['playMs-missing', (s) => { delete s.playMs; }],
      ['byFormat-array', (s) => { s.byFormat = []; }], ['byFormat-extra-key', (s) => { s.byFormat['9v9'] = { w: 1, l: 0, dr: 0, f: 0 }; }], ['byFormat-negative', (s) => { s.byFormat['3v3'].w = -3; }], ['byFormat-record-extra', (s) => { s.byFormat['6v6'].zz = 1; }],
      ['byCpu-null', (s) => { s.byCpu = null; }], ['byCpu-missing-level', (s) => { delete s.byCpu.hard; }],
      ['totals-string', (s) => { s.totals = 'many'; }], ['totals-float', (s) => { s.totals.kos = 1.5; }], ['totals-extra', (s) => { s.totals.cheats = 9; }], ['totals-missing', (s) => { delete s.totals.dealt; }],
      ['bests-array', (s) => { s.bests = []; }], ['bests-hit-bad-pct', (s) => { s.bests.hit.pct = 101; }], ['bests-hit-missing-field', (s) => { delete s.bests.hit.vs; }], ['bests-hit-extra', (s) => { s.bests.hit.x = 1; }],
      ['bests-fastest-negative', (s) => { s.bests.fastestWin.turns = -2; }], ['bests-koStreak-huge', (s) => { s.bests.koStreak = 1e6; }], ['bests-extra', (s) => { s.bests.mostCheese = 3; }],
      ['fav-array', (s) => { s.fav = []; }], ['fav-species-bad-key', (s) => { s.fav.species['pikachu'] = 3; }], ['fav-species-zero-key', (s) => { s.fav.species['0'] = 3; }], ['fav-species-huge-key', (s) => { s.fav.species['70000'] = 3; }],
      ['fav-count-zero', (s) => { s.fav.moves['11'] = 0; }], ['fav-count-float', (s) => { s.fav.moves['12'] = 2.5; }], ['fav-proto-key', (s) => { Object.defineProperty(s.fav.species, '__proto__', { value: 5, enumerable: true, configurable: true, writable: true }); }], ['fav-extra-map', (s) => { s.fav.badges = { 1: 1 }; }],
      ['fav-over-cap', (s) => { for (let i = 1; i <= 60; i++) s.fav.species[String(200 + i)] = i; }], ['fav-moves-over-cap', (s) => { for (let i = 1; i <= 40; i++) s.fav.moves[String(300 + i)] = 1 + (i % 7); }],
      ['recent-string', (s) => { s.recent = 'none'; }], ['recent-too-long', (s) => { for (let i = 0; i < 50; i++) s.recent.push({ id: 'x' + i, at: 5 + i, fmt: '3v3', cpu: 'easy', res: 'w', turns: 3, mvp: 0, team: [1] }); }],
      ['recent-bad-entry', (s) => { s.recent[1] = { id: 'bad id' }; }], ['recent-repeat-id', (s) => { s.recent[2] = { ...s.recent[0] }; }], ['recent-bad-result', (s) => { s.recent[0].res = 'x'; }], ['recent-team-7', (s) => { s.recent[0].team = [1, 2, 3, 4, 5, 6, 7]; }], ['recent-extra-field', (s) => { s.recent[0].note = 'hi'; }],
      ['stats-null', (s, d) => { d.stats = null; }], ['stats-array', (s, d) => { d.stats = []; }], ['stats-unknown-key', (s) => { s.achievements = ['a']; }],
    ];
    const caseFails = [];
    for (const [name, edit] of cases) {
      const d = clone(FIX.cur);
      edit(d.stats, d);
      let o;
      try { o = P.openProfileDocument(d, { deps: detDeps() }); } catch (e) { caseFails.push(name + ' threw ' + e.message); continue; }
      if (!o.ok) { caseFails.push(name + ' refused: ' + o.code); continue; }
      const bad = P.checkProfile(o.profile);
      if (bad.length) { caseFails.push(name + ' invalid after repair: ' + bad[0].code + ' ' + bad[0].path); continue; }
      const again = P.openProfileDocument(clone(o.profile), { deps: detDeps() });
      if (!again.ok || again.changed || again.problems.length || J(again.profile) !== J(o.profile)) caseFails.push(name + ' is not a fixed point');
      if (!o.changed) caseFails.push(name + ' was accepted as it was');
      // the rest of the record the case did not touch must be kept
      if (!['stats-null', 'stats-array'].includes(name) && o.profile.stats.wins !== FIX.cur.stats.wins) caseFails.push(name + ' lost the counters');
    }
    add('repair/every-hostile-stats-case-opens-valid-and-stable-and-is-reported-as-changed (' + cases.length + ' cases)', caseFails.length === 0 ? true : caseFails.slice(0, 4).join(' | '));
    add('repair/over-cap-favourites-keep-the-highest-counts', (() => {
      const d = clone(FIX.cur); for (let i = 1; i <= 60; i++) d.stats.fav.species[String(200 + i)] = i;
      const o = P.openProfileDocument(d, { deps: detDeps() });
      const ks = Object.keys(o.profile.stats.fav.species).map(Number);
      return ks.length === C.CAREER_LIMITS.speciesMax && ks.includes(260) && ks.includes(237) && !ks.includes(210) ? true : J(ks.length);
    })());
    add('repair/over-long-recent-keeps-the-first-20-as-given', (() => {
      const d = clone(FIX.cur); for (let i = 0; i < 50; i++) d.stats.recent.push({ id: 'x' + i, at: 5 + i, fmt: '3v3', cpu: 'easy', res: 'w', turns: 3, mvp: 0, team: [1] });
      const o = P.openProfileDocument(d, { deps: detDeps() });
      return o.profile.stats.recent.length === 20 && o.profile.stats.recent[0].id === d.stats.recent[0].id ? true : String(o.profile.stats.recent.length);
    })());
    add('repair/unknown-extra-keys-of-the-record-are-kept-in-the-bag-not-lost', (() => {
      const d = clone(FIX.cur); d.stats.totals.cheats = 9; d.stats.bests.mostCheese = 3; d.stats.fav.badges = { 1: 1 }; d.stats.achievements = ['a'];
      const o = P.openProfileDocument(d, { deps: detDeps() });
      const b = o.profile.stats._unknown;
      return b && b.achievements && b.careerRejected && J(b.careerRejected.totals) === J({ cheats: 9 }) && J(b.careerRejected.bests) === J({ mostCheese: 3 }) && J(b.careerRejected.fav) === J({ badges: { 1: 1 } }) ? true : J(b);
    })());
    add('repair/no-prototype-pollution-from-hostile-keys-in-the-record', (() => {
      const d = JSON.parse(J(FIX.cur).replace('"fav":{"species":{', '"fav":{"species":{"__proto__":{"polluted":1},'));
      const o = P.openProfileDocument(d, { deps: detDeps() });
      return o.ok && ({}).polluted === undefined && o.profile.stats.fav.polluted === undefined && P.checkProfile(o.profile).length === 0 ? true : 'polluted';
    })());
    // strict check: each broken value alone is reported
    const strict = [['playMs', (s) => { s.playMs = -1; }], ['byFormat', (s) => { s.byFormat['3v3'].w = 1.5; }], ['byCpu', (s) => { delete s.byCpu.easy; }], ['totals', (s) => { s.totals.kos = -1; }], ['bests', (s) => { s.bests.hit.dmg = 0; }], ['fav', (s) => { s.fav.moves['x'] = 1; }], ['recent', (s) => { s.recent[0].res = 'q'; }], ['recent', (s) => { s.recent = [s.recent[0], s.recent[0]]; }], ['firstMatchAt', (s) => { s.firstMatchAt = 'x'; }]];
    const unreported = strict.filter(([key, edit]) => { const p = clone(FIX.cur); edit(p.stats); return !P.checkProfile(p).some((x) => x.code === 'profile.stats' && x.path === 'stats.' + key); }).map(([k]) => k);
    add('check/checkProfile-reports-each-broken-key-of-the-record', unreported.length === 0 ? true : 'not reported: ' + unreported.join(','));
    // fuzz: the record block under random junk
    await blk('fuzz', async () => {
      const rng = mulberry32(99);
      const junk = [null, 0, -1, 1.5, '', 'x', [], {}, true, 1e30, [1, 2], { a: 1 }, 255, 65536, '{PK}'];
      let opened = 0, refused = 0, bad = '';
      for (let i = 0; i < 600 * FUZZ && !bad; i++) {
        const d = clone(FIX.cur);
        const n = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < n; k++) {
          let node = d.stats;
          const depth = Math.floor(rng() * 4);
          for (let q = 0; q < depth; q++) { const ks = node && typeof node === 'object' ? Object.keys(node) : []; if (!ks.length) break; const nx = node[ks[Math.floor(rng() * ks.length)]]; if (nx && typeof nx === 'object') node = nx; else break; }
          const ks = node && typeof node === 'object' ? Object.keys(node) : [];
          if (!ks.length) continue;
          const key = ks[Math.floor(rng() * ks.length)];
          if (rng() < 0.3) { if (Array.isArray(node)) node.splice(Number(key), 1); else delete node[key]; } else node[key] = junk[Math.floor(rng() * junk.length)];
        }
        let o; try { o = P.openProfileDocument(d, { deps: detDeps() }); } catch (e) { bad = 'iteration ' + i + ' threw ' + e.message; break; }
        if (!o.ok) { refused++; continue; }
        opened++;
        const v = P.checkProfile(o.profile); if (v.length) { bad = 'iteration ' + i + ' invalid: ' + v[0].code + ' ' + v[0].path; break; }
        const again = P.openProfileDocument(clone(o.profile), { deps: detDeps() });
        if (!again.ok || again.changed || again.problems.length || J(again.profile) !== J(o.profile)) { bad = 'iteration ' + i + ' not a fixed point'; break; }
      }
      add('fuzz/the-record-block-under-random-junk-opens-valid-and-stable (' + opened + ' opened, ' + refused + ' refused)', !bad && opened > 300 ? true : bad || 'too few opened');
    });
  });

  // ---------------------------------------------------------------------------------------------------- D. import
  await blk('import', async () => {
    const mine = base(); mine.id = 'p_mine'; mine.stats = P.recordMatch(mine, mkMatch({ id: 'a1' })).profile.stats;
    const theirs = clone(FIX.cur); theirs.rev = 0;
    const planM = P.planImport(mine, theirs, 'merge', detDeps());
    add('import/merge-leaves-the-record-exactly-as-it-is', planM.ok && J(planM.profile.stats) === J(mine.stats) && planM.report.record === 'kept-local' ? true : J(planM.report));
    const planN = P.planImport(null, theirs, 'new', detDeps());
    add('import/new-profile-carries-the-files-record', planN.ok && J(planN.profile.stats) === J(theirs.stats) && planN.report.record === 'copied' && planN.report.recordBattles === 5 ? true : J(planN.report));
    const planR = P.planImport(mine, theirs, 'replace', detDeps());
    add('import/replace-takes-the-files-record', planR.ok && J(planR.profile.stats) === J(theirs.stats) && planR.report.record === 'replaced' ? true : J(planR.report));
    add('import/merging-the-same-file-twice-cannot-count-its-battles-twice', (() => { const a = P.planImport(mine, theirs, 'merge', detDeps()); const b = P.planImport(a.profile, theirs, 'merge', detDeps()); return b.ok && J(b.profile.stats) === J(mine.stats) ? true : 'changed'; })());
    add('import/the-planned-profile-is-well-formed-in-all-three-modes', [planM, planN, planR].every((x) => x.ok && P.checkProfile(x.profile).length === 0) ? true : 'invalid');
    add('import/an-export-of-a-v2-file-migrates-with-the-record-zeroed', await (async () => {
      const env = { format: 'pokemonarena-profile', exportVersion: 1, schemaVersion: 2, exportedAt: 5, romSha256: FIX.v2.romSha256, profile: clone(FIX.v2) };
      const canon = (await import(pathToFileURL(path.join(JS, 'stats.js')).href)).canonicalJSON;
      const rom = await import(pathToFileURL(path.join(JS, 'rom.js')).href);
      env.checksum = 'sha256:' + rom.sha256Hex(new TextEncoder().encode(canon(env.profile)));
      const r = await P.parseExport(JSON.stringify(env), {});
      return r.ok && r.migratedFrom === 2 && r.profile.schemaVersion === 3 && r.profile.stats.wins === 3 && r.profile.stats.totals.kos === 0 ? true : J(r).slice(0, 300);
    })());
  });

  // ---------------------------------------------------------------------------------------------------- E. the store
  await blk('store', async () => {
    let seq = 0;
    const fakeBC = () => { const posted = []; class BC { constructor() { this.onmessage = null; } postMessage(m) { posted.push(m); } close() {} } return { BC, posted }; };
    const open = async (name, extra = {}) => {
      const dbName = 'career-' + name + '-' + process.pid + '-' + (seq++);
      const adapter = S.createMemoryAdapter({ name: dbName });
      const store = await S.openStore({ adapter, channel: extra.channel === undefined ? false : extra.channel, deps: extra.deps || detDeps(7), storage: null });
      return { store, adapter, dbName, second: async (channel = false) => S.openStore({ adapter: S.createMemoryAdapter({ name: dbName }), channel, deps: detDeps(8), storage: null }) };
    };
    const put = (adapter, doc) => adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', clone(doc)));
    const docFor = (id, over = {}) => { const d = clone(FIX.cur); d.id = id; Object.assign(d, over); return d; };

    await blk('store-basic', async () => {
      const { store, adapter } = await open('basic');
      await put(adapter, docFor('p_one', { rev: 4 }));
      const r1 = await store.recordMatch('p_one', mkMatch({ id: 'n1', at: 1800000000000, me: { ...mkMatch().me, biggestHit: { sp: 25, mv: 85, dmg: 300, pct: 90, vs: 6 } } }));
      add('store/recordMatch-writes-the-folded-record-and-bumps-the-revision', r1.ok && r1.duplicate === false && r1.saved.rev === 5 && r1.saved.stats.wins === 4 && r1.saved.stats.recent[0].id === 'n1' && r1.before.wins === 3 ? true : J(r1).slice(0, 300));
      const l1 = await store.loadProfile('p_one');
      add('store/what-is-stored-is-what-was-returned-and-is-valid', l1.ok && l1.profile.rev === 5 && l1.profile.stats.wins === 4 && l1.repaired === 0 && J(l1.profile) === J(r1.saved) ? true : J(l1).slice(0, 200));
      add('store/callouts-come-back-with-the-write', J(r1.callouts) === J([{ kind: 'hit', n: 300 }]) ? true : J(r1.callouts));
      const r2 = await store.recordMatch('p_one', mkMatch({ id: 'n1', at: 1800000000000 }));
      const l2 = await store.loadProfile('p_one');
      add('store/the-same-match-id-twice-writes-nothing', r2.ok && r2.duplicate === true && r2.saved === null && l2.profile.rev === 5 && l2.profile.stats.wins === 4 ? true : J([r2.duplicate, l2.profile.rev, l2.profile.stats.wins]));
      const h = await store.listHistory('p_one');
      for (let i = 0; i < 8; i++) await store.recordMatch('p_one', mkMatch({ id: 'h' + i, at: 1800000001000 + i }));
      const h2 = await store.listHistory('p_one');
      add('store/battles-make-no-history-entries-so-edits-stay-recoverable', J(h) === J(h2) && (await store.loadProfile('p_one')).profile.rev === 13 ? true : J([h.length, h2.length]));
      const bad = await (async () => { try { await store.recordMatch('p_one', mkMatch({ result: 'x', id: 'bad' })); return 'accepted'; } catch (e) { return e.code === 'store.invalid' ? true : e.code + ' ' + e.message; } })();
      add('store/a-bad-match-is-refused-and-writes-nothing', bad === true && (await store.loadProfile('p_one')).profile.rev === 13 ? true : bad);
      add('store/an-unknown-profile-is-NotFound', await (async () => { try { await store.recordMatch('p_nope', mkMatch()); return 'accepted'; } catch (e) { return e.code === 'store.not-found' ? true : e.code; } })());
    });
    await blk('store-tabs', async () => {
      // two tabs at once
      const a = await open('tabs');
      const b = await a.second();
      await put(a.adapter, docFor('p_tabs', { rev: 1 }));
      const jobs = [];
      for (let i = 0; i < 24; i++) jobs.push((i % 2 ? a.store : b).recordMatch('p_tabs', mkMatch({ id: 'tab' + i, at: 1800000000000 + i, result: i % 3 === 0 ? 'l' : 'w' })));
      const done = await Promise.all(jobs);
      const l = (await a.store.loadProfile('p_tabs')).profile;
      add('store/two-tabs-finishing-matches-at-the-same-moment-lose-neither (24 matches, 2 connections)', done.every((x) => x.ok && !x.duplicate) && C.battleCount(l.stats) === 3 + 1 + 1 + 24 && l.rev === 25 && l.stats.recent.length === 20 && new Set(done.map((x) => x.saved.rev)).size === 24 ? true : J([C.battleCount(l.stats), l.rev, new Set(done.map((x) => x.saved.rev)).size]));
      add('store/...and-the-totals-are-the-sums', l.stats.totals.kos === FIX.cur.stats.totals.kos + 24 * 2 && l.stats.totals.dealt === FIX.cur.stats.totals.dealt + 24 * 300 ? true : J(l.stats.totals));
      // an editor that opened the profile before the matches is told it is stale
      const stale = clone(FIX.cur); stale.id = 'p_tabs'; stale.rev = 1;
      const conflict = await (async () => { try { await a.store.saveProfile(stale, { reason: 'edit' }); return 'saved over the record'; } catch (e) { return e.code === 'store.conflict' ? true : e.code; } })();
      add('store/an-editor-holding-an-old-revision-gets-a-conflict-not-a-silent-overwrite-of-the-record', conflict === true ? true : conflict);
      const fresh = (await b.loadProfile('p_tabs')).profile; fresh.trainerName = 'RENAMED';
      const saved = await b.saveProfile(fresh, { reason: 'edit' });
      add('store/after-reloading-the-edit-saves-and-keeps-the-record', saved.stats.recent.length === 20 && C.battleCount(saved.stats) === 29 && saved.trainerName === 'RENAMED' ? true : J(saved.stats.recent.length));
    });
    await blk('store-restore', async () => {
      // restore keeps the record; reset takes a backup and a history entry
      const { store, adapter } = await open('restore');
      await put(adapter, docFor('p_r', { rev: 1 }));
      const l0 = (await store.loadProfile('p_r')).profile;
      l0.trainerName = 'FIRST';
      const e1 = await store.saveProfile(l0, { reason: 'edit' });            // rev 2; history holds rev 1
      await store.recordMatch('p_r', mkMatch({ id: 'r1', at: 1800000000000 }));
      await store.recordMatch('p_r', mkMatch({ id: 'r2', at: 1800000000001 }));
      const cur = (await store.loadProfile('p_r')).profile;
      cur.trainerName = 'SECOND';
      const e2 = await store.saveProfile(cur, { reason: 'edit' });
      const hist = await store.listHistory('p_r');
      add('store/history-holds-the-edits-not-the-battles', hist.length === 2 && hist.every((x) => x.reason === 'edit') ? true : J(hist));
      const back = await store.restoreRevision('p_r', hist[hist.length - 1].rev);
      add('store/restoring-an-old-revision-of-the-teams-keeps-the-current-record', back.trainerName === FIX.cur.trainerName && C.battleCount(back.stats) === 5 + 2 && back.stats.recent[0].id === 'r2' ? true : J([back.trainerName, C.battleCount(back.stats)]));
      void e1; void e2;
      const rs = await store.resetRecord('p_r');
      const ab = await store.getAutoBackup('p_r');
      const hh = await store.listHistory('p_r');
      add('store/reset-empties-only-the-record', C.battleCount(rs.stats) === 0 && rs.stats.recent.length === 0 && rs.trainerName === back.trainerName && rs.teams.length === back.teams.length && rs.box.length === back.box.length && P.checkProfile(rs).length === 0 ? true : J(rs.stats).slice(0, 200));
      add('store/reset-takes-an-automatic-backup-with-the-old-record-and-a-history-entry', ab && ab.reason === 'pre-reset-record' && ab.file.profile.stats.wins === back.stats.wins && hh.some((x) => x.reason === 'reset-record') ? true : J([ab && ab.reason, hh.map((x) => x.reason)]));
      add('store/matches-can-be-recorded-again-after-a-reset', (await store.recordMatch('p_r', mkMatch({ id: 'after' }))).saved.stats.wins === 1 ? true : 'no');
    });
    await blk('store-docs', async () => {
      // newer, damaged, old documents
      const { store, adapter } = await open('docs');
      await put(adapter, FIX.fut);
      add('store/a-profile-saved-by-a-newer-build-is-never-written', await (async () => { try { await store.recordMatch(FIX.fut.id, mkMatch()); return 'recorded'; } catch (e) { return e.code === 'store.read-only' ? true : e.code; } })());
      add('store/...and-reset-refuses-it-too', await (async () => { try { await store.resetRecord(FIX.fut.id); return 'reset'; } catch (e) { return e.code === 'store.read-only' ? true : e.code; } })());
      add('store/...and-it-is-byte-for-byte-as-it-was', J((await adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', FIX.fut.id)))) === J(FIX.fut) ? true : 'changed');
      await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { id: 'p_junk', schemaVersion: 'banana' }));
      add('store/an-unreadable-document-is-refused-and-set-aside-in-the-quarantine', await (async () => { try { await store.recordMatch('p_junk', mkMatch()); return 'recorded'; } catch (e) { const q = await store.listQuarantine('p_junk'); return e.code === 'store.invalid' && q.length === 1 ? true : e.code + ' q=' + q.length; } })());
      const v2doc = clone(FIX.v2); v2doc.id = 'p_old';
      await put(adapter, v2doc);
      const r = await store.recordMatch('p_old', mkMatch({ id: 'old1', at: 1800000000000 }));
      const hist = await store.listHistory('p_old');
      add('store/an-old-v2-document-is-migrated-first-then-the-match-is-recorded', r.ok && r.saved.schemaVersion === 3 && r.saved.stats.wins === 4 && r.saved.stats.forfeits === 1 && r.saved.stats.totals.kos === 2 && hist.some((x) => x.reason === 'migration') ? true : J(r).slice(0, 300));
      const gone = await open('gone');
      add('store/a-closed-store-says-so', await (async () => { await gone.store.close(); try { await gone.store.recordMatch('p', mkMatch()); return 'recorded'; } catch (e) { return e.code === 'store.closed' ? true : e.code; } })());
    });
    await blk('store-bc', async () => {
      // the broadcast
      const bc = fakeBC();
      const { store, adapter } = await open('bc', { channel: bc.BC });
      await put(adapter, docFor('p_bc', { rev: 2 }));
      await store.recordMatch('p_bc', mkMatch({ id: 'bc1', at: 1800000000000 }));
      await store.recordMatch('p_bc', mkMatch({ id: 'bc1', at: 1800000000000 }));
      const saved = bc.posted.filter((m) => m.t === 'saved' && m.id === 'p_bc');
      add('store/a-write-is-announced-to-other-tabs-once-and-a-duplicate-is-not', saved.length === 1 && saved[0].rev === 3 ? true : J(bc.posted));
      await store.resetRecord('p_bc');
      add('store/a-reset-is-announced-too', bc.posted.filter((m) => m.t === 'saved' && m.id === 'p_bc').length === 2 ? true : J(bc.posted));
    });
  });
  return out;
}

/* ================================================================================================== battles for B */
function play(seed, pick, cpu, forfeitAt) {
  const A = MC.randomTeam(pack, seed * 1000 + 1, 6), B = MC.randomTeam(pack, seed * 1000 + 2, 6);
  const c = MC.createMatchController({ pack, teams: [A.recs, B.recs], seed, pick, names: ['You', 'CPU'], sides: [{ kind: 'human' }, { kind: 'cpu', level: cpu, seed: seed + 5 }] });
  c.start();
  const ai = AI.createAi({ pack, level: 'normal', seed: seed ^ 0x77 });
  for (let g = 0; c.winner === null && g < 3000; g++) {
    const req = c.pending(0); if (!req) break;
    if (forfeitAt && c.turn >= forfeitAt && req.phase === 'move' && req.canForfeit) { c.submit(0, { kind: 'forfeit' }); break; }
    const r = c.submit(0, ai.choose(req, c.view(0), { previewInfo: { foe: c.previewInfo[1] } })); if (!r.ok) throw new Error('refused');
  }
  return c;
}
const battles = [];
{
  const levels = ['easy', 'normal', 'hard'];
  for (let i = 0; i < N_BATTLES; i++) {
    const pick = i % 4 === 3 ? 0 : 3, cpu = levels[i % 3];
    const c = play(500 + i * 41, pick, cpu, i % 9 === 4 ? 2 : 0);
    battles.push({ events: c.battle.events.slice(), teams: [0, 1].map((s) => c.battle.s.sides[s].team.map((m) => ({ slot: m.slot, sp: m.sp, name: m.name, level: m.level, mhp: m.mhp }))), fmt: pick ? '3v3' : '6v6', cpu });
  }
}

/* ================================================================================================== run, then mutants */
async function loadFrom(dir) {
  const u = (n) => import(pathToFileURL(path.join(dir, n)).href);
  const [P, S, C, MS] = await Promise.all([u('profile.js'), u('store.js'), u('career_stats.js'), u('match_stats.js')]);
  return { P, S, C, MS, battles };
}
function copyJs(dest) { fs.mkdirSync(dest, { recursive: true }); for (const n of fs.readdirSync(JS)) { const s = path.join(JS, n); if (fs.statSync(s).isFile() && n.endsWith('.js')) fs.copyFileSync(s, path.join(dest, n)); } return dest; }

head('running the suite on the real modules');
const realMods = await loadFrom(JS);
const t0 = Date.now();
const real = await suite(realMods);
for (const [name, ok] of real) report(name, ok);
console.log(`  ${real.length} checks (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const MUTANTS = [
  ['C01 a repeated match id is folded again', 'career_stats.js', "if (s.recent.some((r) => r.id === m.id))", "if (false)", ['fold/the-same-match-id-twice-changes-nothing']],
  ['C02 a loss does not end the streak', 'career_stats.js', "} else s.streak = 0;", "} else { /* streak kept */ }", ['fold/a-loss-resets-the-streak-and-keeps-the-best']],
  ['C03 a forfeit is counted as a loss', 'career_stats.js', "{ w: 'wins', l: 'losses', d: 'draws', f: 'forfeits' }", "{ w: 'wins', l: 'losses', d: 'draws', f: 'losses' }", ['fold/a-forfeit-is-a-forfeit-not-a-loss']],
  ['C04 the best streak is never raised', 'career_stats.js', "if (s.streak > s.best) s.best = s.streak;", "", ['fold/bests-move-only-forward']],
  ['C05 recent grows without a limit', 'career_stats.js', "s.recent = s.recent.slice(0, CAREER_LIMITS.recentMax);", "", ['fold/recent-keeps-the-newest-20']],
  ['C06 favourites have no cap', 'career_stats.js', "if (Object.keys(map).length >= cap) {", "if (false) {", ['fold/favourites-are-capped']],
  ['C07 the first win is called out every time', 'career_stats.js', "if (res === 'w' && before.wins === 0)", "if (res === 'w')", ['fold/callouts-compare-with-the-numbers-BEFORE-the-match']],
  ['C08 a draw counts as a win', 'career_stats.js', "d: 'draws', f: 'forfeits' }", "d: 'wins', f: 'forfeits' }", ['fold/a-draw-is-a-draw-and-touches-no-ruleset-w-l']],
  ['C09 counters do not saturate', 'career_stats.js', "const sat = (a, b) => Math.min(MAX, a + b);", "const sat = (a, b) => a + b;", ['fold/counters-saturate-at-the-largest-safe-integer']],
  ['C10 the strict check ignores the recent list', 'career_stats.js', "if (!Array.isArray(s.recent) || s.recent.length > CAREER_LIMITS.recentMax || !s.recent.every(recentOk) || new Set(s.recent.map((r) => r.id)).size !== s.recent.length) bad(", "if (false) bad(", ['check/checkProfile-reports-each-broken-key-of-the-record']],
  ['C11 over-cap favourites are not trimmed on repair', 'career_stats.js', "const trimmed = trimMap(good, FAV_CAP[k]);", "const trimmed = good;", ['repair/over-cap-favourites-keep-the-highest-counts', 'crash/schema']],
  ['C12 any result string is a recordable match', 'career_stats.js', "if (!RESULT_IDS.includes(m.result)) return 'result';", "", ['match/bad-matches-are-refused-with-a-reason']],
  ['C13 a forfeit is no loss for the ruleset', 'career_stats.js', "(res === 'w' || res === 'l' || res === 'f')", "(res === 'w' || res === 'l')", ['fold/a-forfeit-is-a-forfeit-not-a-loss']],
  ['C14 the win rate rounds down', 'career_stats.js', "return n === 0 ? null : Math.floor((200 * s.wins + n) / (2 * n));", "return n === 0 ? null : Math.floor((100 * s.wins) / n);", ['match/win-rate-rounds-half-up-and-is-null-before-the-first-battle']],
  ['C15 a tie replaces the old best', 'career_stats.js', "if (m.me.biggestHit && (!s.bests.hit || m.me.biggestHit.dmg > s.bests.hit.dmg))", "if (m.me.biggestHit && (!s.bests.hit || m.me.biggestHit.dmg >= s.bests.hit.dmg))", ['fold/a-tie-is-not-a-record']],
  ['C16 unknown keys of the record are dropped instead of kept', 'career_stats.js', "if (Object.keys(tr).length) { setOwn(rejected, 'totals', tr);", "if (false) { setOwn(rejected, 'totals', tr);", ['repair/unknown-extra-keys-of-the-record-are-kept-in-the-bag-not-lost']],
  ['P01 the migration leaves the new keys out', 'profile.js', "      setOwn(o.stats, k, fresh[k]);", "", ['migrate/v2-to-v3-golden']],
  ['P02 a merge takes the file\'s record', 'profile.js', "  const p = clone(existing);\n  p.updatedAt = now;", "  const p = clone(existing);\n  p.stats = clone(incoming.stats);\n  p.updatedAt = now;", ['import/merge-leaves-the-record-exactly-as-it-is']],
  ['P03 the current version is still 2', 'profile.js', "export const SCHEMA_VERSION = 3;", "export const SCHEMA_VERSION = 2;", ['schema/current-version-is-3']],
    ['P05 repair puts nothing in the unknown bag', 'profile.js', "    if (Object.keys(car.rejected).length) bag = mergeBag(bag, { careerRejected: car.rejected });", "", ['repair/unknown-extra-keys-of-the-record-are-kept-in-the-bag-not-lost']],
  ['P06 replace keeps the old record', 'profile.js', "    report.record = 'replaced';", "    p.stats = clone(existing.stats);\n    report.record = 'replaced';", ['import/replace-takes-the-files-record']],
  ['S01 a battle makes a history entry', 'store.js', "if (exists && !history && valid) {", "if (false) {", ['store/battles-make-no-history-entries-so-edits-stay-recoverable']],
  ['S02 restoring old teams takes the record back too', 'store.js', "if (now && now.ok && !now.readOnly) restored.stats = now.profile.stats;", "", ['store/restoring-an-old-revision-of-the-teams-keeps-the-current-record']],
  ['S03 a profile from a newer build is written to', 'store.js', "if (opened.readOnly) throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id, schemaVersion: opened.profile.schemaVersion });", "", ['store/a-profile-saved-by-a-newer-build-is-never-written']],
  ['S04 a duplicate is written anyway', 'store.js', "if (r.duplicate) return { saved: null, duplicate: true, callouts: [], before: opened.profile.stats };", "", ['store/the-same-match-id-twice-writes-nothing']],
  ['S05 reset takes no backup', 'store.js', "backup: 'pre-reset-record'", "backup: null", ['store/reset-takes-an-automatic-backup-with-the-old-record-and-a-history-entry']],
  ['S06 the write is not announced', 'store.js', "if (out.saved) this._announce({ t: 'saved', id, rev: out.saved.rev });", "", ['store/a-write-is-announced-to-other-tabs-once-and-a-duplicate-is-not']],
  ['S07 recordMatch reads, then writes in a second transaction (not atomic)', 'store.js', "const raw = await tx.get('profiles', id);\n      if (raw === undefined) throw new NotFoundError(`no profile ${id}`, { id });\n      const opened = openProfileDocument(raw, { deps: this.deps });\n      if (!opened.ok) throw new ValidationError(`profile ${id} cannot be read: ${opened.message}`, opened.problems || []);\n      if (opened.readOnly) throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id, schemaVersion: opened.profile.schemaVersion });",
    "const raw = this.__stale || (this.__stale = await tx.get('profiles', id));\n      if (raw === undefined) throw new NotFoundError(`no profile ${id}`, { id });\n      const opened = openProfileDocument(raw, { deps: this.deps });\n      if (!opened.ok) throw new ValidationError(`profile ${id} cannot be read: ${opened.message}`, opened.problems || []);\n      if (opened.readOnly) throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id, schemaVersion: opened.profile.schemaVersion });",
    ['store/two-tabs-finishing-matches-at-the-same-moment-lose-neither (24 matches, 2 connections)', 'crash/store-tabs']],
];
if (!process.env.ARENA_SKIP_MUTANTS) {
  head('F. mutants (a temp copy of pokemonarena/js each); the unmutated copy must pass everything');
  const run = async (file, from, to) => {
    const dir = copyJs(fs.mkdtempSync(path.join(os.tmpdir(), 'arena-career-')));
    try {
      if (file) {
        const p = path.join(dir, file); const s = fs.readFileSync(p, 'utf8'); const n = s.split(from).length - 1;
        if (n !== 1) throw new Error('mutation target found ' + n + 'x in ' + file + ': ' + from.slice(0, 70));
        fs.writeFileSync(p, s.replace(from, () => to));
      }
      const mods = await loadFrom(dir);
      const res = await suite(mods);
      return res.filter(([, ok]) => ok !== true).map(([n]) => n);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
  };
  const twin = await run(null);
  report('mutants: the unmutated copy through the same loader passes every check', twin.length === 0, twin.slice(0, 3).join(' | '));
  let caught = 0;
  for (const [id, file, from, to, expect] of MUTANTS) {
    let fails;
    try { fails = await run(file, from, to); } catch (e) { report(id + ' loads', false, e.message); continue; }
    const named = expect.length ? expect.some((x) => fails.includes(x)) : fails.length > 0;
    if (named) caught++;
    report(id + ' -> ' + (expect.length ? 'caught by a NAMED check' : 'caught by some check'), named, 'failed: ' + (fails.join(' | ').slice(0, 240) || 'none'));
  }
  console.log(`  mutants ${caught}/${MUTANTS.length}`);
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exitCode = 1; }

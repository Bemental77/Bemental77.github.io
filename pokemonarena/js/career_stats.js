// pokemonarena/js/career_stats.js -- the CAREER half of a profile's `stats`: what is kept about every finished match, its limits, its strict check,
// its repair, and the one pure function that folds a finished match into it.
//
// Pure ES module (browser + Node 24): no DOM, no IndexedDB, no clock (the caller passes `at`), no ROM. profile.js imports this module (schema version 3);
// store.js applies `foldMatch` inside one read-write transaction (store.recordMatch); battle_boot.js builds the match with `matchFromSummary`.
//
// WHAT IS KEPT (profile.stats, schema 3). The first eight keys are the schema-2 ones and keep their meaning:
//   wins losses draws forfeits   whole battles by how they ended, from the player's side. A battle the player gave up with FORFEIT is a forfeit (not a loss).
//   streak best                  the current run of consecutive wins and the longest run ever (a loss, a draw or a forfeit ends the run)
//   lastMatchAt                  ms since the epoch of the last recorded match (null before the first)
//   byRuleset                    {ruleset id: {w, l}}; a forfeit counts as an l, a draw as neither
//   -- schema 3 --
//   firstMatchAt                 ms of the first recorded match, null before it
//   playMs                       the battles' own clock: frames played / 59.7275 Hz, in ms (a battle left open on the result screen costs nothing)
//   byFormat byCpu               {3v3|6v6: {w, l, dr, f}} and {easy|normal|hard: {w, l, dr, f}}  (wins, losses, draws, forfeits)
//   totals                       turns kos faints dealt taken hits crits superEffective resisted noEffect misses statusInflicted healed switches
//   bests                        hit {sp, mv, dmg, pct, vs, at} (the biggest single attack ever), fastestWin {turns, at}, longest {turns, at}, koStreak
//   fav                          species / moves / mvps: {id: count}, each capped (CAREER_LIMITS); beyond the cap the least-used entry is replaced
//                                (the "space saving" rule: the newcomer takes over its count + 1, so a kept count is never below the truth)
//   recent                       the last 20 matches, newest first: {id, at, fmt, cpu, res, turns, mvp, team}
// Every counter is a non-negative safe integer and saturates at Number.MAX_SAFE_INTEGER; every map and list is bounded, so the document stays small.
// IDEMPOTENCE. A match carries an id; if `recent` already holds it the fold changes nothing (a replay, a double fire, a second tab cannot count a match twice).

const MAX = Number.MAX_SAFE_INTEGER;
const TIME_MAX = 8.64e15;
const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KEY_RE = /^[1-9][0-9]{0,4}$/;

export const CAREER_LIMITS = Object.freeze({ recentMax: 20, speciesMax: 24, movesMax: 24, mvpMax: 12, teamMax: 6, turnsMax: 100000, dmgMax: 99999, playMsMatchMax: 86400000, koStreakMax: 100 });
export const FORMAT_IDS = Object.freeze(['3v3', '6v6']);
export const CPU_IDS = Object.freeze(['easy', 'normal', 'hard']);
export const RESULT_IDS = Object.freeze(['w', 'l', 'd', 'f']);
export const TOTAL_KEYS = Object.freeze(['turns', 'kos', 'faints', 'dealt', 'taken', 'hits', 'crits', 'superEffective', 'resisted', 'noEffect', 'misses', 'statusInflicted', 'healed', 'switches']);
export const CAREER_KEYS = Object.freeze(['firstMatchAt', 'playMs', 'byFormat', 'byCpu', 'totals', 'bests', 'fav', 'recent']);
const REC_KEYS = ['w', 'l', 'dr', 'f'];                       // 'dr' (not 'd'): a lone "d" member is what a private JWK looks like, and the export scanners (and the tests) look for exactly that
const REC_OF = { w: 'w', l: 'l', d: 'dr', f: 'f' };            // match result -> its key in a {w, l, dr, f} record
const FAV_KEYS = ['species', 'moves', 'mvps'];
const FAV_CAP = { species: CAREER_LIMITS.speciesMax, moves: CAREER_LIMITS.movesMax, mvps: CAREER_LIMITS.mvpMax };
const BEST_KEYS = ['hit', 'fastestWin', 'longest', 'koStreak'];
const HIT_KEYS = ['sp', 'mv', 'dmg', 'pct', 'vs', 'at'];
const RECENT_KEYS = ['id', 'at', 'fmt', 'cpu', 'res', 'turns', 'mvp', 'team'];

const rec0 = () => ({ w: 0, l: 0, dr: 0, f: 0 });
export function emptyCareer() {
  return {
    firstMatchAt: null, playMs: 0,
    byFormat: { '3v3': rec0(), '6v6': rec0() }, byCpu: { easy: rec0(), normal: rec0(), hard: rec0() },
    totals: Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])),
    bests: { hit: null, fastestWin: null, longest: null, koStreak: 0 },
    fav: { species: {}, moves: {}, mvps: {} },
    recent: [],
  };
}
/** Whole battles recorded: wins + losses + draws + forfeits (works on any stats object with those four counters). */
export const battleCount = (s) => (s.wins | 0) + (s.losses | 0) + (s.draws | 0) + (s.forfeits | 0);

/* ---------------------------------------------------------------------------------------------- strict check */

const recOk = (r) => isObj(r) && Object.keys(r).length === 4 && REC_KEYS.every((k) => isInt(r[k], 0, MAX));
const hitOk = (h) => isObj(h) && Object.keys(h).length === 6 && HIT_KEYS.every((k) => hasOwn.call(h, k))
  && isInt(h.sp, 1, 65535) && isInt(h.mv, 1, 65535) && isInt(h.dmg, 1, CAREER_LIMITS.dmgMax) && isInt(h.pct, 0, 100) && isInt(h.vs, 1, 65535) && isInt(h.at, 0, TIME_MAX);
const turnAtOk = (t) => isObj(t) && Object.keys(t).length === 2 && isInt(t.turns, 0, CAREER_LIMITS.turnsMax) && isInt(t.at, 0, TIME_MAX);
function favOk(m, cap) {
  if (!isObj(m)) return false;
  const ks = Object.keys(m);
  return ks.length <= cap && ks.every((k) => KEY_RE.test(k) && isInt(Number(k), 1, 65535) && isInt(m[k], 1, MAX));
}
export function recentOk(r) {
  return isObj(r) && Object.keys(r).length === 8 && RECENT_KEYS.every((k) => hasOwn.call(r, k))
    && typeof r.id === 'string' && ID_RE.test(r.id) && isInt(r.at, 0, TIME_MAX) && FORMAT_IDS.includes(r.fmt) && CPU_IDS.includes(r.cpu) && RESULT_IDS.includes(r.res)
    && isInt(r.turns, 0, CAREER_LIMITS.turnsMax) && isInt(r.mvp, 0, 65535)
    && Array.isArray(r.team) && r.team.length <= CAREER_LIMITS.teamMax && r.team.every((x) => isInt(x, 1, 65535));
}

/** Strict problems of the schema-3 keys of a stats object, as `add(code, path, message)` calls. [] when well formed. */
export function checkCareer(s, add) {
  const bad = (path, why) => add('profile.stats', 'stats.' + path, `${path} ${why}`);
  if (!(s.firstMatchAt === null || isInt(s.firstMatchAt, 0, TIME_MAX))) bad('firstMatchAt', 'must be null or a non-negative integer');
  if (!isInt(s.playMs, 0, MAX)) bad('playMs', 'must be a non-negative integer');
  for (const [name, ids] of [['byFormat', FORMAT_IDS], ['byCpu', CPU_IDS]]) {
    const o = s[name];
    if (!isObj(o) || Object.keys(o).length !== ids.length || !ids.every((k) => recOk(o[k]))) bad(name, `must hold exactly ${ids.join(', ')}, each {w, l, dr, f} of non-negative integers`);
  }
  if (!isObj(s.totals) || Object.keys(s.totals).length !== TOTAL_KEYS.length || !TOTAL_KEYS.every((k) => isInt(s.totals[k], 0, MAX))) bad('totals', 'must hold exactly ' + TOTAL_KEYS.join(', ') + ' as non-negative integers');
  const b = s.bests;
  if (!isObj(b) || Object.keys(b).length !== 4 || !BEST_KEYS.every((k) => hasOwn.call(b, k))
    || !(b.hit === null || hitOk(b.hit)) || !(b.fastestWin === null || turnAtOk(b.fastestWin)) || !(b.longest === null || turnAtOk(b.longest)) || !isInt(b.koStreak, 0, CAREER_LIMITS.koStreakMax)) bad('bests', 'must be {hit, fastestWin, longest, koStreak} with well-formed entries or null');
  const f = s.fav;
  if (!isObj(f) || Object.keys(f).length !== 3 || !FAV_KEYS.every((k) => favOk(f[k], FAV_CAP[k]))) bad('fav', 'must be {species, moves, mvps}: maps of id -> count, each within its cap');
  if (!Array.isArray(s.recent) || s.recent.length > CAREER_LIMITS.recentMax || !s.recent.every(recentOk) || new Set(s.recent.map((r) => r.id)).size !== s.recent.length) bad('recent', `must be at most ${CAREER_LIMITS.recentMax} well-formed matches with distinct ids`);
}

/* ---------------------------------------------------------------------------------------------- repair (normalisation) */

const keep = (o, ks) => { const out = {}; const rest = {}; for (const k of Object.keys(o)) { if (ks.includes(k)) out[k] = o[k]; else rest[k] = o[k]; } return [out, rest]; };
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
function trimMap(m, cap) {
  const ks = Object.keys(m).sort((a, b) => (m[b] - m[a]) || (Number(a) - Number(b)));
  const out = {};
  for (const k of ks.slice(0, cap)) setOwn(out, k, m[k]);
  return out;
}

/**
 * Repair the schema-3 keys of `src` (an untrusted stats object). Returns { value, rejected }: `value` holds all eight keys, well formed;
 * `rejected` holds what had to be dropped (kept by the caller in the unknown bag, never silently lost). `P(severity, code, path, message, extra)` reports each repair.
 */
export function normalizeCareer(src, P, loud) {
  const out = emptyCareer();
  const rejected = {};
  const rep = (path, msg, was) => { if (loud) P('repaired', 'profile.stats', 'stats.' + path, msg, was === undefined ? undefined : { was }); };
  // scalars
  if (src.firstMatchAt === null || isInt(src.firstMatchAt, 0, TIME_MAX)) out.firstMatchAt = src.firstMatchAt; else if (src.firstMatchAt !== undefined) rep('firstMatchAt', 'invalid; set to null', src.firstMatchAt); else rep('firstMatchAt', 'missing; set to null');
  if (isInt(src.playMs, 0, MAX)) out.playMs = src.playMs; else rep('playMs', 'missing or invalid; set to 0', src.playMs);
  // by format / by cpu
  for (const [name, ids] of [['byFormat', FORMAT_IDS], ['byCpu', CPU_IDS]]) {
    const o = src[name];
    if (!isObj(o)) { rep(name, 'missing or invalid; zeroed', o); if (o !== undefined) setOwn(rejected, name, o); continue; }
    const [good, rest] = keep(o, ids);
    for (const k of ids) {
      const r = good[k];
      if (isObj(r)) {
        const [rk, rr] = keep(r, REC_KEYS);
        for (const f of REC_KEYS) { if (isInt(rk[f], 0, MAX)) out[name][k][f] = rk[f]; else rep(`${name}.${k}.${f}`, 'missing or invalid; set to 0', rk[f]); }
        if (Object.keys(rr).length) setOwn(rejected, `${name}.${k}`, rr);
      } else rep(`${name}.${k}`, 'missing or invalid; zeroed', r);
    }
    if (Object.keys(rest).length) { setOwn(rejected, name, rest); rep(name, 'unknown entries were moved to the unknown bag'); }
  }
  // totals
  if (isObj(src.totals)) {
    const [tk, tr] = keep(src.totals, TOTAL_KEYS);
    for (const k of TOTAL_KEYS) { if (isInt(tk[k], 0, MAX)) out.totals[k] = tk[k]; else rep('totals.' + k, 'missing or invalid; set to 0', tk[k]); }
    if (Object.keys(tr).length) { setOwn(rejected, 'totals', tr); rep('totals', 'unknown entries were moved to the unknown bag'); }
  } else rep('totals', 'missing or invalid; zeroed', src.totals);
  // bests
  if (isObj(src.bests)) {
    const [bk, br] = keep(src.bests, BEST_KEYS);
    if (bk.hit === null || bk.hit === undefined) out.bests.hit = null; else if (hitOk(bk.hit)) out.bests.hit = Object.fromEntries(HIT_KEYS.map((k) => [k, bk.hit[k]])); else { rep('bests.hit', 'invalid; cleared', bk.hit); }
    for (const k of ['fastestWin', 'longest']) { if (bk[k] === null || bk[k] === undefined) out.bests[k] = null; else if (turnAtOk(bk[k])) out.bests[k] = { turns: bk[k].turns, at: bk[k].at }; else rep('bests.' + k, 'invalid; cleared', bk[k]); }
    if (isInt(bk.koStreak, 0, CAREER_LIMITS.koStreakMax)) out.bests.koStreak = bk.koStreak; else if (bk.koStreak !== undefined) rep('bests.koStreak', 'invalid; set to 0', bk.koStreak);
    if (Object.keys(br).length) { setOwn(rejected, 'bests', br); rep('bests', 'unknown entries were moved to the unknown bag'); }
  } else rep('bests', 'missing or invalid; cleared', src.bests);
  // favourites: bad entries dropped, then trimmed to the cap by count
  if (isObj(src.fav)) {
    const [fk, fr] = keep(src.fav, FAV_KEYS);
    for (const k of FAV_KEYS) {
      const m = fk[k];
      if (!isObj(m)) { rep('fav.' + k, 'missing or invalid; emptied', m); continue; }
      const good = {};
      let dropped = 0;
      for (const id of Object.keys(m)) { if (KEY_RE.test(id) && isInt(Number(id), 1, 65535) && isInt(m[id], 1, MAX)) setOwn(good, id, m[id]); else dropped++; }
      const trimmed = trimMap(good, FAV_CAP[k]);
      if (dropped || Object.keys(trimmed).length !== Object.keys(good).length) rep('fav.' + k, `${dropped} bad entr${dropped === 1 ? 'y' : 'ies'} dropped, kept at most ${FAV_CAP[k]}`);
      out.fav[k] = trimmed;
    }
    if (Object.keys(fr).length) { setOwn(rejected, 'fav', fr); rep('fav', 'unknown entries were moved to the unknown bag'); }
  } else rep('fav', 'missing or invalid; emptied', src.fav);
  // recent
  if (Array.isArray(src.recent)) {
    const seen = new Set();
    let dropped = 0;
    for (const r of src.recent) {
      if (out.recent.length >= CAREER_LIMITS.recentMax) { dropped++; continue; }
      if (recentOk(r) && !seen.has(r.id)) { seen.add(r.id); out.recent.push({ id: r.id, at: r.at, fmt: r.fmt, cpu: r.cpu, res: r.res, turns: r.turns, mvp: r.mvp, team: r.team.slice() }); } else dropped++;
    }
    if (dropped) rep('recent', `${dropped} entr${dropped === 1 ? 'y' : 'ies'} dropped (malformed, repeated or over the limit of ${CAREER_LIMITS.recentMax})`);
  } else rep('recent', 'missing or invalid; emptied', src.recent);
  return { value: out, rejected };
}

/* ---------------------------------------------------------------------------------------------- one finished match */

/**
 * The match as the career wants it. `summary` = match_stats.summarizeMatch(...) output; ctx = { id, at, fmt, cpu, ruleset, playMs }.
 * `team` = the species of every Pokemon the player brought (those that took part first); species = those that took part.
 */
export function matchFromSummary(summary, ctx) {
  const me = summary.sides[summary.viewSide];
  const foe = summary.sides[summary.viewSide ^ 1];
  const played = me.mons.filter((m) => m.switchIns > 0);
  const bh = me.biggestHit;
  return {
    id: ctx.id, at: ctx.at, fmt: ctx.fmt, cpu: ctx.cpu, ruleset: ctx.ruleset, result: summary.result, turns: summary.turns, playMs: ctx.playMs,
    mvp: summary.mvp ? summary.mvp.sp : 0,
    team: me.mons.map((m) => m.sp),
    species: played.map((m) => m.sp),
    moves: me.moves.map((p) => [p[0], p[1]]),
    me: {
      kos: me.kos, faints: me.faints, dealt: me.dealt, taken: me.taken, hits: me.hits + me.subHits, crits: me.crits, superEffective: me.superEffective, resisted: me.resisted, noEffect: me.noEffect,
      misses: me.misses, statusInflicted: me.statusInflicted, healed: me.healed, switches: me.switches, koStreak: me.koStreak,
      biggestHit: bh ? { sp: bh.sp, mv: bh.mv, dmg: bh.dmg, pct: bh.pct, vs: bh.vs.sp } : null,
    },
    foeFaints: foe.faints,
  };
}

/** null if `m` is a match this module will fold, else a short reason. The caller is our own code, but a record from storage or a file is not trusted. */
export function matchIssue(m) {
  if (!isObj(m)) return 'not an object';
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'id';
  if (!isInt(m.at, 0, TIME_MAX)) return 'at';
  if (!FORMAT_IDS.includes(m.fmt)) return 'fmt';
  if (!CPU_IDS.includes(m.cpu)) return 'cpu';
  if (!RESULT_IDS.includes(m.result)) return 'result';
  if (!isInt(m.turns, 0, CAREER_LIMITS.turnsMax)) return 'turns';
  if (!isInt(m.playMs, 0, CAREER_LIMITS.playMsMatchMax)) return 'playMs';
  if (!isInt(m.mvp, 0, 65535)) return 'mvp';
  if (!Array.isArray(m.team) || m.team.length > CAREER_LIMITS.teamMax || !m.team.every((x) => isInt(x, 1, 65535))) return 'team';
  if (!Array.isArray(m.species) || m.species.length > CAREER_LIMITS.teamMax || !m.species.every((x) => isInt(x, 1, 65535))) return 'species';
  if (!Array.isArray(m.moves) || m.moves.length > 64 || !m.moves.every((p) => Array.isArray(p) && p.length === 2 && isInt(p[0], 1, 65535) && isInt(p[1], 1, 100000))) return 'moves';
  const me = m.me;
  if (!isObj(me)) return 'me';
  for (const k of ['kos', 'faints', 'dealt', 'taken', 'hits', 'crits', 'superEffective', 'resisted', 'noEffect', 'misses', 'statusInflicted', 'healed', 'switches']) if (!isInt(me[k], 0, 10000000)) return 'me.' + k;
  if (!isInt(me.koStreak, 0, CAREER_LIMITS.koStreakMax)) return 'me.koStreak';
  if (!(me.biggestHit === null || (isObj(me.biggestHit) && isInt(me.biggestHit.sp, 1, 65535) && isInt(me.biggestHit.mv, 1, 65535) && isInt(me.biggestHit.dmg, 1, CAREER_LIMITS.dmgMax) && isInt(me.biggestHit.pct, 0, 100) && isInt(me.biggestHit.vs, 1, 65535)))) return 'me.biggestHit';
  return null;
}

const sat = (a, b) => Math.min(MAX, a + b);
/** Space-saving counter: add n to key; when the map is full and the key is new, the least-used entry makes room and the newcomer takes its count + n. */
function bumpFav(map, id, n, cap) {
  const k = String(id);
  if (hasOwn.call(map, k)) { map[k] = sat(map[k], n); return; }
  if (Object.keys(map).length >= cap) {
    let worst = null;
    for (const key of Object.keys(map)) if (worst === null || map[key] < map[worst] || (map[key] === map[worst] && Number(key) > Number(worst))) worst = key;
    const floor = map[worst];
    delete map[worst];
    map[k] = sat(floor, n);
    return;
  }
  map[k] = n;
}

/**
 * Fold one match into a stats object. Pure: `stats` (schema 3, well formed) is not modified.
 * -> { stats, duplicate, callouts }. duplicate = the match id is already in `recent` (then `stats` is a copy, unchanged).
 * callouts are the records this match set against the numbers BEFORE it: [{ kind: 'first-win' | 'streak' | 'fastest' | 'hit' | 'longest' | 'ko-streak', n }]
 * (a record is only called out when there was an earlier one to beat, except 'first-win').
 */
export function foldMatch(stats, m, byRulesetId) {
  const why = matchIssue(m);
  if (why) throw new RangeError('foldMatch: bad match (' + why + ')');
  const s = JSON.parse(JSON.stringify(stats));
  if (s.recent.some((r) => r.id === m.id)) return { stats: s, duplicate: true, callouts: [] };
  const before = JSON.parse(JSON.stringify(stats));
  const had = battleCount(before) > 0;
  const res = m.result;
  const key = { w: 'wins', l: 'losses', d: 'draws', f: 'forfeits' }[res];
  s[key] = sat(s[key], 1);
  if (res === 'w') { s.streak = sat(s.streak, 1); if (s.streak > s.best) s.best = s.streak; } else s.streak = 0;
  s.lastMatchAt = s.lastMatchAt === null ? m.at : Math.max(s.lastMatchAt, m.at);
  s.firstMatchAt = s.firstMatchAt === null ? m.at : Math.min(s.firstMatchAt, m.at);
  s.playMs = sat(s.playMs, m.playMs);
  s.byFormat[m.fmt][REC_OF[res]] = sat(s.byFormat[m.fmt][REC_OF[res]], 1);
  s.byCpu[m.cpu][REC_OF[res]] = sat(s.byCpu[m.cpu][REC_OF[res]], 1);
  if (byRulesetId && (res === 'w' || res === 'l' || res === 'f')) {
    const e = hasOwn.call(s.byRuleset, byRulesetId) ? s.byRuleset[byRulesetId] : null;
    if (e) { if (res === 'w') e.w = sat(e.w, 1); else e.l = sat(e.l, 1); }
    else if (Object.keys(s.byRuleset).length < 64) setOwn(s.byRuleset, byRulesetId, res === 'w' ? { w: 1, l: 0 } : { w: 0, l: 1 });
  }
  for (const k of TOTAL_KEYS) s.totals[k] = sat(s.totals[k], k === 'turns' ? m.turns : m.me[k]);
  const callouts = [];
  if (res === 'w' && before.wins === 0) callouts.push({ kind: 'first-win', n: 1 });
  if (res === 'w' && s.streak > before.best && s.streak >= 2) callouts.push({ kind: 'streak', n: s.streak });
  if (res === 'w' && before.bests.fastestWin && m.turns < before.bests.fastestWin.turns) callouts.push({ kind: 'fastest', n: m.turns });
  if (m.me.biggestHit && before.bests.hit && m.me.biggestHit.dmg > before.bests.hit.dmg) callouts.push({ kind: 'hit', n: m.me.biggestHit.dmg });
  if (had && before.bests.longest && m.turns > before.bests.longest.turns) callouts.push({ kind: 'longest', n: m.turns });
  if (before.bests.koStreak > 0 && m.me.koStreak > before.bests.koStreak) callouts.push({ kind: 'ko-streak', n: m.me.koStreak });
  if (m.me.biggestHit && (!s.bests.hit || m.me.biggestHit.dmg > s.bests.hit.dmg)) s.bests.hit = { ...m.me.biggestHit, at: m.at };
  if (res === 'w' && (!s.bests.fastestWin || m.turns < s.bests.fastestWin.turns)) s.bests.fastestWin = { turns: m.turns, at: m.at };
  if (!s.bests.longest || m.turns > s.bests.longest.turns) s.bests.longest = { turns: m.turns, at: m.at };
  if (m.me.koStreak > s.bests.koStreak) s.bests.koStreak = m.me.koStreak;
  for (const sp of Array.from(new Set(m.species)).sort((a, b) => a - b)) bumpFav(s.fav.species, sp, 1, FAV_CAP.species);
  for (const [mv, n] of m.moves.slice().sort((a, b) => a[0] - b[0])) bumpFav(s.fav.moves, mv, n, FAV_CAP.moves);
  if (m.mvp) bumpFav(s.fav.mvps, m.mvp, 1, FAV_CAP.mvps);
  s.recent.unshift({ id: m.id, at: m.at, fmt: m.fmt, cpu: m.cpu, res, turns: m.turns, mvp: m.mvp, team: m.team.slice() });
  s.recent = s.recent.slice(0, CAREER_LIMITS.recentMax);
  return { stats: s, duplicate: false, callouts };
}

/* ---------------------------------------------------------------------------------------------- reading it back (for the RECORD screen and the recap) */

/** Win rate as a whole percent (round half up) over every recorded battle; null before the first battle. */
export function winRate(s) {
  const n = battleCount(s);
  return n === 0 ? null : Math.floor((200 * s.wins + n) / (2 * n));
}
/** The entries of a favourites map, most used first (ties: lower id first): [[id, count], ...]. */
export function favList(map, n = 3) {
  return Object.keys(map).map((k) => [Number(k), map[k]]).sort((a, b) => (b[1] - a[1]) || (a[0] - b[0])).slice(0, n);
}

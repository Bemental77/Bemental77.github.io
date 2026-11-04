// pokemonarena/js/tower_record.js -- the Tower's STORED RECORD (profile.tower, schema 5): its layout, its strict shape check, and how a damaged one is repaired. Pure ES module: no DOM, no clock, no storage.
//
// This file is deliberately small and light: profile.js (and so the Team Builder, the hub and every page that opens a profile) imports it, and it must not drag the engine in. It knows the SHAPE of the
// record, not the game: the deep checks of a stored run (is this offer the one this seed gives? is the team legal?) live in tower.js (parseRun / checkTower) and run when a run is resumed.
//
//   tower = {
//     v: 1,
//     best:         { '3v3': 0, '6v6': 0 },   most floors cleared in one run, per format
//     winsByFormat: { '3v3': 0, '6v6': 0 },   runs won (wins = their sum)
//     runs, wins, floors, bosses,             finished runs / won runs / floors cleared / bosses beaten, over all runs
//     buffsSeen:    { '<family id>': n },     times each buff family was taken
//     achievements: { '<id>': <ms> },         when each was earned (the caller's clock)
//     current:      null | <a run>,           the run under way (tower.js has its layout)
//     last:         null | { ... },           a summary of the run that ended last (what the result screen shows)
//   }
//
// UNKNOWN FIELDS are never dropped: they go to `tower._unknown`, as everywhere in the profile. A field that cannot be repaired is replaced by its empty value and the raw value is kept in the bag by
// profile.js (normalizeTower returns it in `rejected`), so a damaged record costs the player that one field, never the whole climb.

import { CONFIG } from './tower_config.js';

export const TOWER_VERSION = 1;
export const TOWER_LIMITS = Object.freeze({ idMax: 40, buffsMax: 400, achievementsMax: 500, heldMax: 400, earnedMax: 200, counterMax: 1e9, runJsonMax: 100000, timeMax: 8.64e15 });

const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isTowerId = (s) => typeof s === 'string' && ID.test(s);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** The keys a stored run may have (tower.js documents each). Kept here so that the shallow check below and tower.js's strict parser can never disagree about the list. */
export const RUN_KEYS = Object.freeze(['v', 'seed', 'format', 'ruleset', 'floor', 'phase', 'team', 'types', 'held', 'offer', 'history', 'skips', 'livesUsed', 'folded', 'fighting', 'earned']);
export const RUN_PHASES = Object.freeze(['battle', 'offer', 'over', 'won']);
export const TOWER_KEYS = Object.freeze(['v', 'best', 'winsByFormat', 'runs', 'wins', 'floors', 'bosses', 'buffsSeen', 'achievements', 'current', 'last']);
export const LAST_KEYS = Object.freeze(['format', 'seed', 'won', 'cleared', 'livesUsed', 'skips', 'held', 'earned', 'at']);

export const emptyTower = () => ({ v: TOWER_VERSION, best: { '3v3': 0, '6v6': 0 }, winsByFormat: { '3v3': 0, '6v6': 0 }, runs: 0, wins: 0, floors: 0, bosses: 0, buffsSeen: {}, achievements: {}, current: null, last: null });

/** Is `r` shaped like a stored run? (Shallow: the field names and the cheap bounds. tower.js parseRun is the strict, deep parser.) */
export function isRunShape(r, cfg = CONFIG) {
  if (!isObj(r)) return false;
  for (const k of Object.keys(r)) if (!RUN_KEYS.includes(k)) return false;
  for (const k of RUN_KEYS) if (!hasOwn.call(r, k)) return false;
  if (r.v !== 1 || !isInt(r.seed, 0, 0xffffffff) || !cfg.formats.includes(r.format) || !RUN_PHASES.includes(r.phase) || !isInt(r.floor, 1, cfg.floors)) return false;
  if (!isObj(r.team) || !Array.isArray(r.team.recs) || !Array.isArray(r.held) || !Array.isArray(r.history) || !Array.isArray(r.earned)) return false;
  if (typeof r.folded !== 'boolean' || typeof r.fighting !== 'boolean') return false;
  try { return JSON.stringify(r).length <= TOWER_LIMITS.runJsonMax; } catch (_e) { return false; }
}

const heldOk = (h, cfg) => Array.isArray(h) && h.length <= TOWER_LIMITS.heldMax && h.every((x) => isObj(x) && Object.keys(x).length === 2 && isTowerId(x.id) && isInt(x.p, 1, cfg.powerCap));
const earnedOk = (e) => Array.isArray(e) && e.length <= TOWER_LIMITS.earnedMax && e.every(isTowerId) && new Set(e).size === e.length;

export function isLastShape(l, cfg = CONFIG) {
  if (!isObj(l)) return false;
  for (const k of Object.keys(l)) if (!LAST_KEYS.includes(k)) return false;
  return LAST_KEYS.every((k) => hasOwn.call(l, k)) && cfg.formats.includes(l.format) && isInt(l.seed, 0, 0xffffffff) && typeof l.won === 'boolean' && isInt(l.cleared, 0, cfg.floors)
    && isInt(l.livesUsed, 0, 1000) && isInt(l.skips, 0, 1000) && heldOk(l.held, cfg) && earnedOk(l.earned) && isInt(l.at, 0, TOWER_LIMITS.timeMax);
}

/** Strict shape problems of a stored Tower record: [] = well formed, else short reasons. */
export function checkTowerShape(t, cfg = CONFIG) {
  const bad = [];
  if (!isObj(t)) return ['not an object'];
  for (const k of Object.keys(t)) if (!TOWER_KEYS.includes(k) && k !== '_unknown') bad.push('unknown field ' + k);
  for (const k of TOWER_KEYS) if (!hasOwn.call(t, k)) bad.push('missing ' + k);
  if (bad.length) return bad;
  if (t.v !== TOWER_VERSION) bad.push('version');
  const perFormat = (o) => isObj(o) && Object.keys(o).length === cfg.formats.length && cfg.formats.every((f) => hasOwn.call(o, f));
  if (!perFormat(t.best) || !cfg.formats.every((f) => isInt(t.best[f], 0, cfg.floors))) bad.push('best');
  if (!perFormat(t.winsByFormat) || !cfg.formats.every((f) => isInt(t.winsByFormat[f], 0, TOWER_LIMITS.counterMax))) bad.push('winsByFormat');
  else if (cfg.formats.reduce((n, f) => n + t.winsByFormat[f], 0) !== t.wins) bad.push('wins != winsByFormat');
  for (const k of ['runs', 'wins', 'floors', 'bosses']) if (!isInt(t[k], 0, TOWER_LIMITS.counterMax)) bad.push(k);
  if (t.wins > t.runs) bad.push('wins > runs');
  if (!isObj(t.buffsSeen) || Object.keys(t.buffsSeen).length > TOWER_LIMITS.buffsMax || !Object.keys(t.buffsSeen).every((id) => isTowerId(id) && isInt(t.buffsSeen[id], 1, TOWER_LIMITS.counterMax))) bad.push('buffsSeen');
  if (!isObj(t.achievements) || Object.keys(t.achievements).length > TOWER_LIMITS.achievementsMax || !Object.keys(t.achievements).every((id) => isTowerId(id) && isInt(t.achievements[id], 0, TOWER_LIMITS.timeMax))) bad.push('achievements');
  if (t.current !== null && !isRunShape(t.current, cfg)) bad.push('current run');
  else if (t.current !== null && (t.current.folded || t.current.phase === 'over' || t.current.phase === 'won')) bad.push('current run is finished');
  if (t.last !== null && !isLastShape(t.last, cfg)) bad.push('last');
  if (hasOwn.call(t, '_unknown') && !isObj(t._unknown)) bad.push('_unknown');
  return bad;
}

const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/**
 * Repair a stored Tower record field by field. -> { value (always well formed), rejected ({} when nothing was lost) }.
 * `P(severity, code, path, message, extra)` is profile.js's problem reporter (optional here). `present` says whether the document had a `tower` at all (a v5 document without one is repaired to empty; a
 * v4 document is migrated, not repaired). Nothing the player earned is thrown away silently: what cannot be kept goes to `rejected`, which profile.js stores in the unknown bag.
 */
export function normalizeTower(src, P = () => {}, present = true, cfg = CONFIG) {
  const rejected = {}, out = emptyTower();
  const rep = (field, raw, why) => { setOwn(rejected, field, raw); P('repaired', 'profile.tower', 'tower.' + field, 'tower.' + field + ' ' + why + '; emptied (the old value is kept in the unknown bag)'); };
  if (!isObj(src)) {
    if (present && src !== undefined) { setOwn(rejected, '_raw', src); P('repaired', 'profile.tower', 'tower', 'tower was not an object; emptied (the old value is kept in the unknown bag)'); }
    else if (present && src === undefined) P('repaired', 'profile.tower', 'tower', 'tower was missing; an empty record was made');
    return { value: out, rejected };
  }
  if (src.v !== TOWER_VERSION) { setOwn(rejected, '_raw', src); P('repaired', 'profile.tower', 'tower.v', 'tower.v is ' + String(src.v) + ', not ' + TOWER_VERSION + '; the record is kept in the unknown bag and an empty one made'); return { value: out, rejected }; }
  const perFormat = (field, hi) => {
    const v = src[field];
    if (isObj(v) && cfg.formats.every((f) => isInt(v[f], 0, hi))) { for (const f of cfg.formats) out[field][f] = v[f]; const extra = Object.keys(v).filter((k) => !cfg.formats.includes(k)); if (extra.length) { const o = {}; for (const k of extra) setOwn(o, k, v[k]); setOwn(rejected, field + 'Extra', o); } }
    else if (hasOwn.call(src, field)) rep(field, v, 'was invalid');
  };
  perFormat('best', cfg.floors); perFormat('winsByFormat', TOWER_LIMITS.counterMax);
  for (const k of ['runs', 'wins', 'floors', 'bosses']) { if (isInt(src[k], 0, TOWER_LIMITS.counterMax)) out[k] = src[k]; else if (hasOwn.call(src, k)) rep(k, src[k], 'was invalid'); }
  if (isObj(src.buffsSeen)) {
    const lost = {};
    for (const id of Object.keys(src.buffsSeen)) { if (isTowerId(id) && isInt(src.buffsSeen[id], 1, TOWER_LIMITS.counterMax) && Object.keys(out.buffsSeen).length < TOWER_LIMITS.buffsMax) setOwn(out.buffsSeen, id, src.buffsSeen[id]); else setOwn(lost, id, src.buffsSeen[id]); }
    if (Object.keys(lost).length) rep('buffsSeen', lost, 'had entries that are not {id: count}');
  } else if (hasOwn.call(src, 'buffsSeen')) rep('buffsSeen', src.buffsSeen, 'was not an object');
  if (isObj(src.achievements)) {
    const lost = {};
    for (const id of Object.keys(src.achievements)) { if (isTowerId(id) && isInt(src.achievements[id], 0, TOWER_LIMITS.timeMax) && Object.keys(out.achievements).length < TOWER_LIMITS.achievementsMax) setOwn(out.achievements, id, src.achievements[id]); else setOwn(lost, id, src.achievements[id]); }
    if (Object.keys(lost).length) rep('achievements', lost, 'had entries that are not {id: time}');
  } else if (hasOwn.call(src, 'achievements')) rep('achievements', src.achievements, 'was not an object');
  if (src.current === null || src.current === undefined) out.current = null;
  else if (isRunShape(src.current, cfg) && !src.current.folded && src.current.phase !== 'over' && src.current.phase !== 'won') out.current = clone(src.current);
  else rep('current', src.current, 'was not a run that is under way');
  if (src.last === null || src.last === undefined) out.last = null;
  else if (isLastShape(src.last, cfg)) out.last = clone(src.last);
  else rep('last', src.last, 'was not a run summary');
  // the counters must agree with each other; the agreement is made without ever lowering what the player has done
  const sum = cfg.formats.reduce((n, f) => n + out.winsByFormat[f], 0);
  if (out.wins !== sum) { if (hasOwn.call(src, 'wins') && out.wins !== sum) P('repaired', 'profile.tower', 'tower.wins', 'tower.wins disagreed with winsByFormat; set to ' + sum); out.wins = sum; }
  if (out.runs < out.wins) { P('repaired', 'profile.tower', 'tower.runs', 'tower.runs was below tower.wins; raised'); out.runs = out.wins; }
  for (const f of cfg.formats) if (out.best[f] > 0 && out.floors < out.best[f]) out.floors = out.best[f];
  // unknown fields of the record
  const bag = isObj(src._unknown) ? { ...src._unknown } : null;
  const unk = {};
  for (const k of Object.keys(src)) if (!TOWER_KEYS.includes(k) && k !== '_unknown') setOwn(unk, k, src[k]);
  let b2 = bag;
  if (Object.keys(unk).length) { b2 = b2 || {}; for (const k of Object.keys(unk)) if (!hasOwn.call(b2, k)) setOwn(b2, k, unk[k]); }
  if (hasOwn.call(src, '_unknown') && !isObj(src._unknown)) { b2 = b2 || {}; setOwn(b2, '_unknown', src._unknown); }
  if (b2 && Object.keys(b2).length) out._unknown = b2;
  const still = checkTowerShape(out, cfg);
  if (still.length) { const empty = emptyTower(); setOwn(rejected, '_raw', src); P('repaired', 'profile.tower', 'tower', 'tower could not be repaired (' + still[0] + '); an empty record was made and the old one kept in the unknown bag'); return { value: empty, rejected }; }
  return { value: out, rejected };
}

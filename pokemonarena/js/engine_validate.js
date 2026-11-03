// pokemonarena/js/engine_validate.js -- input validation for the battle engine: the data pack, a team record, a restored snapshot.
//
// Everything here REFUSES with a named EngineError (`error.code`, `error.detail`) instead of letting a malformed value surface as
// a TypeError deep inside a turn.  Pure ES module (no DOM, no node:, no clocks); imports only the leaf data/support modules.
//
//   validatePack(pack)                      -> throws EngineError(code 'pack-invalid') unless the pack has what the engine reads
//   validateRec(pack, rec, where)           -> throws EngineError(code 'team-invalid') for a record the engine cannot build
//   validateSnapshot(snap, ctx)             -> throws EngineError(code 'snapshot-invalid' | 'snapshot-version' | 'snapshot-rom')
//   packFingerprint(pack, hash)             -> 16-hex digest of the battle-relevant pack content (memoised per pack object)

import { EngineError, ENGINE_VERSION, E } from './engine_data.js';
import { engineSupport } from './engine_support.js';

const TYPE_MAX = 20; // T.STELLAR
const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'];
const STAGE_KEYS = ['atk', 'def', 'spa', 'spd', 'spe', 'acc', 'eva'];
const PHASES = ['preview', 'move', 'switch', 'end'];
const show = (x) => { try { const s = typeof x === 'string' ? JSON.stringify(x) : String(x); return s.length > 40 ? s.slice(0, 40) + '...' : s; } catch (_e) { return typeof x; } };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------------------------------------
// the data pack
// ---------------------------------------------------------------------------------------------
const packOk = new WeakSet();
const fpCache = new WeakMap();

export function validatePack(pack) {
  if (pack && typeof pack === 'object' && packOk.has(pack)) return;
  const bad = (why) => { throw new EngineError('the data pack cannot be used by the engine: ' + why, { why }, 'pack-invalid'); };
  if (!isObj(pack)) bad('it is not an object');
  for (const k of ['species', 'moves', 'abilities', 'items', 'natures', 'roster']) if (!Array.isArray(pack[k])) bad(`${k} is not an array`);
  const chart = pack.typeChart;
  if (!Array.isArray(chart) || chart.length <= TYPE_MAX) bad('typeChart is not a 21x21 table');
  for (let a = 0; a <= TYPE_MAX; a++) {
    const row = chart[a];
    if (!Array.isArray(row) || row.length <= TYPE_MAX) bad(`typeChart[${a}] is not a row of 21`);
    for (let d = 0; d <= TYPE_MAX; d++) if (!Number.isInteger(row[d]) || row[d] < 0 || row[d] > 65535) bad(`typeChart[${a}][${d}] = ${show(row[d])}`);
  }
  const num = (o, k, lo, hi, what) => { const v = o[k]; if (!Number.isInteger(v) || v < lo || v > hi) bad(`${what}.${k} = ${show(v)} (expected an integer ${lo}..${hi})`); };
  for (let i = 0; i < pack.moves.length; i++) {
    const mv = pack.moves[i];
    if (!isObj(mv)) bad(`moves[${i}] is not an object`);
    if (mv.id !== i) bad(`moves[${i}].id = ${show(mv.id)}`);
    if (i === 0) continue;
    const w = `moves[${i}]`;
    if (typeof mv.name !== 'string') bad(`${w}.name`);
    num(mv, 'type', 0, TYPE_MAX, w); num(mv, 'category', 0, 2, w); num(mv, 'power', 0, 65535, w); num(mv, 'accuracy', 0, 255, w);
    num(mv, 'pp', 0, 255, w); num(mv, 'priority', -128, 127, w); num(mv, 'effect', 0, 65535, w); num(mv, 'target', 0, 255, w);
    num(mv, 'strikeCount', 0, 15, w); num(mv, 'critStage', 0, 255, w);
    if (!isObj(mv.flags)) bad(`${w}.flags`);
    if (!Array.isArray(mv.additional)) bad(`${w}.additional`);
    for (let k = 0; k < mv.additional.length; k++) { const a = mv.additional[k]; if (!isObj(a)) bad(`${w}.additional[${k}]`); num(a, 'effect', 0, 65535, `${w}.additional[${k}]`); num(a, 'chance', 0, 65535, `${w}.additional[${k}]`); }
    if (!Array.isArray(mv.bytes) || mv.bytes.length < 9) bad(`${w}.bytes`);
    for (let k = 0; k < mv.bytes.length; k++) if (!Number.isInteger(mv.bytes[k]) || mv.bytes[k] < 0 || mv.bytes[k] > 255) bad(`${w}.bytes[${k}]`);
  }
  for (let i = 0; i < pack.species.length; i++) {
    const sp = pack.species[i];
    if (sp === null || sp === undefined) continue;
    const w = `species[${i}]`;
    if (!isObj(sp)) bad(`${w} is not an object`);
    if (!Array.isArray(sp.types) || sp.types.length < 2) bad(`${w}.types`);
    for (let k = 0; k < 2; k++) if (!Number.isInteger(sp.types[k]) || sp.types[k] < 0 || sp.types[k] > TYPE_MAX) bad(`${w}.types[${k}] = ${show(sp.types[k])}`);
    if (!isObj(sp.baseStats)) bad(`${w}.baseStats`);
    for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) num(sp.baseStats, k, 0, 255, `${w}.baseStats`);
    if (!Array.isArray(sp.abilities)) bad(`${w}.abilities`);
    for (let k = 0; k < sp.abilities.length; k++) if (!Number.isInteger(sp.abilities[k]) || sp.abilities[k] < 0) bad(`${w}.abilities[${k}]`);
    num(sp, 'weight', 0, 1000000, w);
    if (!Array.isArray(sp.evolutions)) bad(`${w}.evolutions`);
    if (typeof sp.name !== 'string') bad(`${w}.name`);
  }
  for (const id of pack.roster) if (!Number.isInteger(id) || !pack.species[id]) bad(`roster entry ${show(id)} has no species`);
  for (let i = 0; i < pack.abilities.length; i++) { const a = pack.abilities[i]; if (!isObj(a) || typeof a.name !== 'string') bad(`abilities[${i}]`); }
  for (let i = 0; i < pack.items.length; i++) {
    const it = pack.items[i];
    if (!isObj(it) || typeof it.name !== 'string') bad(`items[${i}]`);
    num(it, 'holdEffect', 0, 65535, `items[${i}]`); num(it, 'holdEffectParam', 0, 65535, `items[${i}]`);
  }
  packOk.add(pack);
}

/** 16 hex chars over the battle-relevant content of the pack (chart, moves, species, items); memoised per pack object. */
export function packFingerprint(pack, hash) {
  let f = fpCache.get(pack);
  if (f) return f;
  const parts = [JSON.stringify(pack.typeChart)];
  parts.push(JSON.stringify(pack.moves.map((m) => [m.id, m.type, m.category, m.power, m.accuracy, m.pp, m.priority, m.effect, m.target, m.strikeCount, m.critStage, m.alwaysCrit ? 1 : 0, m.bytes[5], m.bytes[8], m.additional.map((a) => [a.effect, a.chance])])));
  parts.push(JSON.stringify(pack.species.map((s) => (s ? [s.id, s.types, s.baseStats, s.abilities, s.weight] : 0))));
  parts.push(JSON.stringify(pack.items.map((it) => [it.id, it.holdEffect, it.holdEffectParam])));
  parts.push(JSON.stringify(pack.abilities.map((a) => a.name)));
  f = hash(parts.join('|'));
  fpCache.set(pack, f);
  return f;
}

// ---------------------------------------------------------------------------------------------
// a team record
// ---------------------------------------------------------------------------------------------

/** The record must be something the engine can turn into a Pokemon. (Legality - EVs, moves a species may learn - is rules.js's job.) */
export function validateRec(pack, rec, where) {
  const bad = (why) => { throw new EngineError(`${where}: ${why}`, { where, why }, 'team-invalid'); };
  if (!isObj(rec)) bad('the Pokemon record is not an object');
  if (!Number.isInteger(rec.species) || rec.species <= 0 || !pack.species[rec.species]) bad(`species ${show(rec.species)} is not in the data pack`);
  if (rec.moves !== undefined && !Array.isArray(rec.moves)) bad('moves is not an array');
  const mv = rec.moves || [];
  if (mv.length < 1 || mv.length > 4) bad(`a Pokemon needs 1..4 moves, got ${mv.length}`);
  const sup = engineSupport(pack);
  for (let i = 0; i < mv.length; i++) {
    const m = mv[i];
    const id = typeof m === 'number' ? m : isObj(m) ? m.id : undefined;
    if (!Number.isInteger(id) || id <= 0 || !pack.moves[id]) bad(`moves[${i}] = ${show(isObj(m) ? m.id : m)} is not a move in the data pack`);
    if (!sup.moves.has(id)) bad(`moves[${i}] (${pack.moves[id].name}) is not a move the engine can run`);
    if (isObj(m) && m.ppUps !== undefined && (!Number.isInteger(m.ppUps) || m.ppUps < 0 || m.ppUps > 3)) bad(`moves[${i}].ppUps = ${show(m.ppUps)}`);
  }
  for (const k of ['level', 'nature', 'abilitySlot']) if (rec[k] !== undefined && !Number.isInteger(rec[k])) bad(`${k} = ${show(rec[k])} is not an integer`);
  const item = rec.item !== undefined ? rec.item : rec.heldItem;
  if (item !== undefined && (!Number.isInteger(item) || item < 0 || item >= pack.items.length)) bad(`item ${show(item)} is not in the data pack`);
  if (rec.nickname !== undefined && typeof rec.nickname !== 'string') bad('nickname is not a string');
  if (rec.gender !== undefined && rec.gender !== 'M' && rec.gender !== 'F' && rec.gender !== '-') bad(`gender = ${show(rec.gender)} is not 'M', 'F' or '-'`);
}

// ---------------------------------------------------------------------------------------------
// a snapshot
// ---------------------------------------------------------------------------------------------

/**
 * Validate a snapshot (already a private JSON copy).  ctx = { pack, eventCodes:string[], choiceKinds:string[], fingerprint:string, sha:string|null }.
 * Checks the shape of every field the engine reads, every range, every id against the pack, and cross-field consistency
 * (fnt is 1 exactly when hp is 0, hp <= max, active slot in range, winner set exactly when ended, ...).  Throws the first problem found.
 */
export function validateSnapshot(snap, ctx) {
  const { pack } = ctx;
  const fail = (path, why) => { throw new EngineError(`snapshot rejected at ${path}: ${why}`, { path, why }, 'snapshot-invalid'); };
  const int = (x, lo, hi, path) => { if (!Number.isInteger(x) || x < lo || x > hi) fail(path, `expected an integer ${lo}..${hi}, got ${show(x)}`); return x; };
  const flag = (x, path) => int(x, 0, 1, path);
  const str = (x, max, path) => { if (typeof x !== 'string' || x.length > max) fail(path, `expected a string of at most ${max} characters`); return x; };
  const obj = (x, path) => { if (!isObj(x)) fail(path, 'expected an object'); return x; };
  const arr = (x, lo, hi, path) => { if (!Array.isArray(x) || x.length < lo || x.length > hi) fail(path, `expected an array of ${lo}..${hi} items`); return x; };
  const only = (o, keys, path) => { for (const k of Object.keys(o)) if (keys.indexOf(k) < 0) fail(`${path}.${k}`, 'unknown field'); };
  const sup = engineSupport(pack);
  const moveId = (x, path) => { int(x, 1, pack.moves.length - 1, path); if (!sup.moves.has(x)) fail(path, `move ${x} is not one the engine can run`); return x; };
  const typeId = (x, path) => int(x, 0, TYPE_MAX, path);

  if (!isObj(snap)) fail('snapshot', 'expected an object');
  if (snap.v !== ENGINE_VERSION) throw new EngineError('snapshot version mismatch', { got: snap.v, want: ENGINE_VERSION }, 'snapshot-version');
  only(snap, ['v', 's', 'events', 'mark', 'log', 'packId', 'packFp', 'ruleset', 'hash'], 'snapshot');
  if (snap.packId !== undefined && snap.packId !== null && ctx.sha && snap.packId !== ctx.sha) throw new EngineError('snapshot was made with a different ROM', { got: snap.packId, want: ctx.sha }, 'snapshot-rom');
  if (snap.packFp !== undefined && snap.packFp !== ctx.fingerprint) throw new EngineError('snapshot was made with a different data pack', { got: snap.packFp, want: ctx.fingerprint }, 'snapshot-rom');

  // ---- top level state
  const S = obj(snap.s, 'snapshot.s');
  only(S, ['v', 'ruleset', 'seed', 'rng', 'turn', 'phase', 'reason', 'need', 'pause', 'mb', 'pick', 'wx', 'tr', 'sides', 'q', 'winner', 'tn', 'gv', 'pw', 'ms', 'ws', 'wr', 'mr', 'fl', 'ion', 'lm', 'bp', 'fu', 'pk'], 's');
  if (S.v !== ENGINE_VERSION) fail('s.v', 'engine version differs');
  str(S.ruleset, 64, 's.ruleset');
  if (snap.ruleset !== undefined && snap.ruleset !== S.ruleset) fail('ruleset', 'differs from s.ruleset');
  int(S.seed, 0, 0xffffffff, 's.seed'); int(S.rng, 0, 0xffffffff, 's.rng');
  int(S.turn, 0, E.turnCap + 1, 's.turn');
  if (PHASES.indexOf(S.phase) < 0) fail('s.phase', `unknown phase ${show(S.phase)}`);
  if (S.pk !== undefined && S.pk !== 'revive') fail('s.pk', `unknown pause kind ${show(S.pk)}`);
  if (S.reason !== '' && S.reason !== 'faint' && S.reason !== 'pivot' && S.reason !== 'revive') fail('s.reason', `unknown reason ${show(S.reason)}`);
  arr(S.need, 2, 2, 's.need').forEach((b, i) => { if (typeof b !== 'boolean') fail(`s.need[${i}]`, 'expected a boolean'); });
  int(S.pause, -1, 1, 's.pause');
  if (typeof S.mb !== 'boolean') fail('s.mb', 'expected a boolean');
  int(S.pick, 0, E.pickMax, 's.pick');
  arr(S.wx, 2, 2, 's.wx'); int(S.wx[0], 0, 5, 's.wx[0]'); int(S.wx[1], 0, 16, 's.wx[1]');
  int(S.tr, 0, 16, 's.tr');
  if (S.tn !== undefined) { arr(S.tn, 2, 2, 's.tn'); int(S.tn[0], 1, 5, 's.tn[0]'); int(S.tn[1], 1, 8, 's.tn[1]'); }
  if (S.gv !== undefined) int(S.gv, 1, 5, 's.gv');
  if (S.pw !== undefined) int(S.pw, 6, 8, 's.pw');
  for (const k of ['ms', 'ws', 'wr', 'mr', 'fl', 'ion']) if (S[k] !== undefined) int(S[k], 1, 8, `s.${k}`);
  if (S.lm !== undefined) moveId(S.lm, 's.lm');
  if (S.fu !== undefined) { arr(S.fu, 2, 2, 's.fu'); int(S.fu[0], 0, 99999, 's.fu[0]'); moveId(S.fu[1], 's.fu[1]'); }
  if (S.bp !== undefined) { obj(S.bp, 's.bp'); only(S.bp, ['s', 'g', 'v'], 's.bp'); int(S.bp.s, 0, 1, 's.bp.s'); arr(S.bp.g, 7, 7, 's.bp.g').forEach((g, i2) => int(g, -6, 6, `s.bp.g[${i2}]`)); volatiles(S.bp.v, 's.bp.v'); }
  if (S.winner !== null) int(S.winner, -1, 1, 's.winner');
  if ((S.phase === 'end') !== (S.winner !== null)) fail('s.winner', 'must be set exactly when the phase is "end"');
  if (S.phase === 'preview' && S.pick < 1) fail('s.phase', 'a preview phase needs pick >= 1');

  // ---- sides and mons
  arr(S.sides, 2, 2, 's.sides');
  S.sides.forEach((sd, si) => {
    const sp = `s.sides[${si}]`;
    obj(sd, sp);
    only(sd, ['name', 'team', 'act', 'ch', 'hz', 'reflect', 'light', 'veil', 'sg', 'tw', 'mist', 'luckyChant', 'wish', 'fut', 'nfaint', 'lastFaint', 'picked', 'hw', 'ev'], sp);
    str(sd.name, 200, `${sp}.name`);
    arr(sd.team, 1, 6, `${sp}.team`);
    if (S.phase === 'preview' && sd.team.length < S.pick) fail(`${sp}.team`, 'fewer mons than the pick');
    int(sd.act, 0, sd.team.length - 1, `${sp}.act`);
    obj(sd.hz, `${sp}.hz`); only(sd.hz, ['sp', 'ts', 'sr', 'sw'], `${sp}.hz`);
    int(sd.hz.sp, 0, 3, `${sp}.hz.sp`); int(sd.hz.ts, 0, 2, `${sp}.hz.ts`); int(sd.hz.sr, 0, 1, `${sp}.hz.sr`); int(sd.hz.sw, 0, 1, `${sp}.hz.sw`);
    for (const k of ['reflect', 'light', 'veil', 'sg', 'tw', 'mist', 'luckyChant']) int(sd[k], 0, 16, `${sp}.${k}`);
    int(sd.nfaint, 0, 6, `${sp}.nfaint`); int(sd.lastFaint, -1, E.turnCap + 1, `${sp}.lastFaint`); int(sd.picked, 0, 1, `${sp}.picked`);
    if (sd.hw !== undefined) int(sd.hw, 0, 2, `${sp}.hw`);
    if (sd.ev !== undefined) { obj(sd.ev, `${sp}.ev`); only(sd.ev, ['t', 'n'], `${sp}.ev`); int(sd.ev.t, 0, E.turnCap + 1, `${sp}.ev.t`); int(sd.ev.n, 1, 5, `${sp}.ev.n`); }
    if (sd.wish !== null) { obj(sd.wish, `${sp}.wish`); only(sd.wish, ['t', 'hp'], `${sp}.wish`); int(sd.wish.t, 0, 3, `${sp}.wish.t`); int(sd.wish.hp, 0, 100000, `${sp}.wish.hp`); }
    if (sd.fut !== null) {
      const f = obj(sd.fut, `${sp}.fut`);
      only(f, ['t', 'mv', 'from', 'level', 'st', 'ty'], `${sp}.fut`);
      int(f.t, 0, 4, `${sp}.fut.t`); moveId(f.mv, `${sp}.fut.mv`); int(f.from, 0, 1, `${sp}.fut.from`); int(f.level, 1, 100, `${sp}.fut.level`);
      obj(f.st, `${sp}.fut.st`); only(f.st, STAT_KEYS, `${sp}.fut.st`); for (const k of STAT_KEYS) int(f.st[k], 0, 99999, `${sp}.fut.st.${k}`);
      arr(f.ty, 1, 2, `${sp}.fut.ty`).forEach((t, i) => typeId(t, `${sp}.fut.ty[${i}]`));
    }
    if (sd.ch !== null) {
      const c = obj(sd.ch, `${sp}.ch`);
      if (c.kind === 'auto' || c.kind === 'forfeit') only(c, ['kind'], `${sp}.ch`);
      else if (c.kind === 'move') { only(c, ['kind', 'slot', 'mv'], `${sp}.ch`); int(c.slot, 0, 4, `${sp}.ch.slot`); moveId(c.mv, `${sp}.ch.mv`); }
      else if (c.kind === 'switch') { only(c, ['kind', 'slot'], `${sp}.ch`); int(c.slot, 0, sd.team.length - 1, `${sp}.ch.slot`); }
      else if (c.kind === 'preview') {
        only(c, ['kind', 'order'], `${sp}.ch`);
        const o = arr(c.order, 1, E.pickMax, `${sp}.ch.order`);
        const seen = {};
        o.forEach((x, i) => { int(x, 0, sd.team.length - 1, `${sp}.ch.order[${i}]`); if (seen[x]) fail(`${sp}.ch.order`, 'duplicate member'); seen[x] = 1; });
      } else fail(`${sp}.ch.kind`, `unknown choice kind ${show(c.kind)}`);
    }
    sd.team.forEach((m, mi) => validateMon(m, `${sp}.team[${mi}]`, si, mi));
    if (S.phase !== 'end' && sd.team.every((m) => m.hp <= 0)) fail(sp, 'every Pokemon has fainted but the battle has not ended');
  });

  // ---- the queued actions of a turn in progress
  arr(S.q, 0, 2, 's.q').forEach((a, i) => {
    const p = `s.q[${i}]`;
    obj(a, p);
    only(a, ['s', 'mi', 'spd', 'q', 'k', 'slot', 'br', 'mv', 'second', 'rampage', 'struggle'], p);
    int(a.s, 0, 1, `${p}.s`); int(a.mi, 0, 5, `${p}.mi`); int(a.spd, 0, 100000, `${p}.spd`); int(a.q, -1, 1, `${p}.q`); int(a.br, -128, 200, `${p}.br`);
    if (['move', 'switch', 'recharge'].indexOf(a.k) < 0) fail(`${p}.k`, `unknown action ${show(a.k)}`);
    if (a.k === 'switch') int(a.slot, 0, 5, `${p}.slot`);
    if (a.k === 'move') { moveId(a.mv, `${p}.mv`); if (a.slot !== undefined) int(a.slot, 0, 4, `${p}.slot`); }
    for (const k of ['second', 'rampage', 'struggle']) if (a[k] !== undefined) flag(a[k], `${p}.${k}`);
  });

  // ---- events and the choice log
  if (snap.events !== undefined) {
    arr(snap.events, 0, 400000, 'events');
    const codes = ctx.eventCodes;
    for (let i = 0; i < snap.events.length; i++) {
      const e = snap.events[i];
      if (!isObj(e) || typeof e.t !== 'string' || codes.indexOf(e.t) < 0) fail(`events[${i}]`, `not an engine event (${show(e && e.t)})`);
    }
  }
  const nev = snap.events ? snap.events.length : 0;
  if (snap.mark !== undefined) int(snap.mark, 0, nev, 'mark');
  if (snap.log !== undefined) {
    arr(snap.log, 0, 400000, 'log');
    for (let i = 0; i < snap.log.length; i++) {
      const e = snap.log[i];
      if (!isObj(e)) fail(`log[${i}]`, 'expected an object');
      int(e.s, 0, 1, `log[${i}].s`);
      if (!isObj(e.c) || ctx.choiceKinds.indexOf(e.c.kind) < 0) fail(`log[${i}].c`, 'not a choice');
    }
  }

  function validateMon(m, p, si, mi) {
    obj(m, p);
    only(m, ['slot', 'side', 'orig', 'sp', 'name', 'level', 'ty', 'hp', 'mhp', 'st', 'ab', 'it', 'used', 'mv', 's', 'sc', 'hpt', 'wt', 'fnt', 'sg', 'v', 'rev', 'tf', 'ht', 'inn', 'sw', 'dg', 'g', 'rb'], p);
    int(m.slot, 0, 5, `${p}.slot`); if (m.slot !== mi) fail(`${p}.slot`, `must equal its position ${mi}`);
    if (m.side !== si) fail(`${p}.side`, `must equal ${si}`);
    int(m.orig, 0, 5, `${p}.orig`);
    int(m.sp, 1, pack.species.length - 1, `${p}.sp`); if (!pack.species[m.sp]) fail(`${p}.sp`, `species ${m.sp} is not in the data pack`);
    str(m.name, 200, `${p}.name`);
    int(m.level, 1, 100, `${p}.level`);
    arr(m.ty, 1, 2, `${p}.ty`).forEach((t, i) => typeId(t, `${p}.ty[${i}]`));
    int(m.mhp, 1, 99999, `${p}.mhp`); int(m.hp, 0, m.mhp, `${p}.hp`);
    if (flag(m.fnt, `${p}.fnt`) !== (m.hp === 0 ? 1 : 0)) fail(`${p}.fnt`, 'must be 1 exactly when hp is 0');
    stats(m.st, `${p}.st`);
    int(m.ab, 0, pack.abilities.length - 1, `${p}.ab`); int(m.it, 0, pack.items.length - 1, `${p}.it`); int(m.used, 0, pack.items.length - 1, `${p}.used`);
    arr(m.mv, 1, 4, `${p}.mv`).forEach((x, i) => {
      obj(x, `${p}.mv[${i}]`); only(x, ['id', 'pp', 'mx'], `${p}.mv[${i}]`);
      moveId(x.id, `${p}.mv[${i}].id`); int(x.mx, 0, 255, `${p}.mv[${i}].mx`); int(x.pp, 0, x.mx, `${p}.mv[${i}].pp`);
    });
    int(m.s, 0, 7, `${p}.s`); int(m.sc, 0, 64, `${p}.sc`);
    if (m.g !== undefined) int(m.g, 1, 2, `${p}.g`);
    if (m.hp === 0 && m.s !== 0) fail(`${p}.s`, 'a fainted Pokemon carries no status');
    typeId(m.hpt, `${p}.hpt`); int(m.wt, 0, 1000000, `${p}.wt`);
    obj(m.sg, `${p}.sg`); only(m.sg, STAGE_KEYS, `${p}.sg`); for (const k of STAGE_KEYS) int(m.sg[k], -6, 6, `${p}.sg.${k}`);
    obj(m.rev, `${p}.rev`); only(m.rev, ['a', 'i', 'm', 'n'], `${p}.rev`); flag(m.rev.a, `${p}.rev.a`); flag(m.rev.i, `${p}.rev.i`);
    arr(m.rev.m, 0, 64, `${p}.rev.m`).forEach((x, i) => int(x, 1, pack.moves.length - 1, `${p}.rev.m[${i}]`));
    if (m.rev.n !== undefined) arr(m.rev.n, 1, 3, `${p}.rev.n`).forEach((x, i) => int(x, 1, pack.abilities.length - 1, `${p}.rev.n[${i}]`));
    if (m.inn !== undefined) arr(m.inn, 1, 3, `${p}.inn`).forEach((x, i) => int(x, 1, pack.abilities.length - 1, `${p}.inn[${i}]`));
    if (m.ht !== undefined) int(m.ht, 0, 100000, `${p}.ht`);
    if (m.rb !== undefined) int(m.rb, 0, 1, `${p}.rb`);
    if (m.sw !== undefined) flag(m.sw, `${p}.sw`);
    if (m.dg !== undefined) flag(m.dg, `${p}.dg`);
    if (m.tf !== undefined) {
      obj(m.tf, `${p}.tf`); only(m.tf, ['st', 'ab', 'mv', 'ty'], `${p}.tf`);
      stats(m.tf.st, `${p}.tf.st`); int(m.tf.ab, 0, pack.abilities.length - 1, `${p}.tf.ab`);
      arr(m.tf.ty, 1, 2, `${p}.tf.ty`).forEach((t, i) => typeId(t, `${p}.tf.ty[${i}]`));
      arr(m.tf.mv, 1, 4, `${p}.tf.mv`).forEach((x, i) => { obj(x, `${p}.tf.mv[${i}]`); moveId(x.id, `${p}.tf.mv[${i}].id`); int(x.mx, 0, 255, `${p}.tf.mv[${i}].mx`); int(x.pp, 0, x.mx, `${p}.tf.mv[${i}].pp`); });
    }
    volatiles(m.v, `${p}.v`);
  }
  function stats(st, p) { obj(st, p); only(st, STAT_KEYS, p); for (const k of STAT_KEYS) int(st[k], 1, 99999, `${p}.${k}`); }
  function volatiles(v, p) {
    obj(v, p);
    for (const k of Object.keys(v)) {
      const x = v[k], q = `${p}.${k}`;
      switch (k) {
        // on / off markers
        case 'moved': case 'flinch': case 'endure': case 'ingrain': case 'meanlook': case 'lockon': case 'noesc': case 'fore': case 'fe': case 'db':
        case 'curse': case 'aring': case 'roost': case 'ff': case 'smack': case 'rch': case 'tru': case 'mini': case 'nitem': case 'heal': case 'chgd': flag(x, q); break;
        case 'ss': int(x, 0, 5, q); break;
        case 'swt': int(x, 0, E.turnCap + 2, q); break;
        case 'prot': int(x, 1, 11, q); break;
        case 'seeded': int(x, 0, 1, q); break;
        case 'sub': case 'hit': case 'hitAmt': int(x, 0, 200000, q); break;
        case 'lans': case 'micle': case 'custap': int(x, 0, 2, q); break;
        case 'stk': case 'stkd': case 'stks': int(x, 0, 18, q); break;
        case 'mhq': arr(x, 0, 16, q).forEach((p2, i2) => { arr(p2, 2, 2, `${q}[${i2}]`); int(p2[1], 1, 12, `${q}[${i2}][1]`); }); break;
        case 'nm': case 'elec': case 'mcoat': case 'snatch': case 'ash': case 'mim': case 'be': case 'inf': case 'tar': case 'fn': case 'held': case 'torment': case 'imp': case 'gastro': case 'mir': case 'pt': case 'grudge': case 'powder': case 'rage': case 'glaive': case 'salt': case 'ate': flag(x, q); break;
        case 'cud': arr(x, 2, 2, q); int(x[0], 1, 99999, `${q}[0]`); int(x[1], 0, 99999, `${q}[1]`); break;
        case 'pend': obj(x, q); only(x, ['mv', 'n'], q); moveId(x.mv, `${q}.mv`); int(x.n, 0, 99, `${q}.n`); break;
        case 'um': arr(x, 0, 5, q).forEach((id, i2) => moveId(id, `${q}[${i2}]`)); break;
        case 'bide': obj(x, q); only(x, ['t', 'd'], q); int(x.t, 0, 3, `${q}.t`); int(x.d, 0, 999999, `${q}.d`); break;
        case 'hb': case 'emb': case 'tc': case 'tele': case 'lf': case 'syrup': case 'perish': int(x, 0, 8, q); break;
        case 'so': obj(x, q); for (const kk of Object.keys(x)) { if (['atk', 'def', 'spa', 'spd', 'spe'].indexOf(kk) < 0) fail(`${q}.${kk}`, 'unknown stat'); int(x[kk], 1, 99999, `${q}.${kk}`); } break;
        case 'roll': obj(x, q); only(x, ['mv', 'n'], q); moveId(x.mv, `${q}.mv`); int(x.n, 0, 8, `${q}.n`); break;
        case 'metro': obj(x, q); only(x, ['mv', 'n'], q); moveId(x.mv, `${q}.mv`); int(x.n, 0, 64, `${q}.n`); break;
        case 'conf': case 'taunt': case 'yawn': case 'mag': case 'pstreak': case 'fc': int(x, 0, 64, q); break;
        case 'turns': case 'prevFail': case 'drop': case 'raised': int(x, 0, E.turnCap + 2, q); break;
        case 'hitCat': int(x, 0, 2, q); break;
        case 'hitFrom': int(x, -1, 1, q); break;
        case 'lastMv': case 'choice': if (x !== 0) moveId(x, q); break;
        case 'sinv': if (['ground', 'water', 'air', 'shadow'].indexOf(x) < 0) fail(q, `unknown semi-invulnerable kind ${show(x)}`); break;
        case 'ty': arr(x, 1, 3, q).forEach((t, i) => typeId(t, `${q}[${i}]`)); break;
        case 'chg': obj(x, q); only(x, ['mv'], q); moveId(x.mv, `${q}.mv`); break;
        case 'ramp': obj(x, q); only(x, ['mv', 't', 'up', 'nc'], q); moveId(x.mv, `${q}.mv`); int(x.t, 0, 8, `${q}.t`); break;
        case 'trap': obj(x, q); only(x, ['t', 'src', 'var'], q); int(x.t, -1, 8, `${q}.t`); int(x.src, 0, 1, `${q}.src`); int(x.var, 0, 255, `${q}.var`); break;
        case 'dis': case 'enc': obj(x, q); only(x, ['mv', 't'], q); moveId(x.mv, `${q}.mv`); int(x.t, 0, 8, `${q}.t`); break;
        default: fail(q, 'unknown volatile condition');
      }
    }
  }
}

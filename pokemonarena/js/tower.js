// pokemonarena/js/tower.js -- the Pokemon Tower's RUN: a deterministic state machine (floors, trainers, offers, picks, results) with a strict serialised form. Pure ES module: no DOM, no clock, no storage,
// no Math.random. Everything is a function of (run seed, floor, what the player picked): the same seed gives the same trainers, the same offers and the same rarity rolls. See TOWER.md.
//
//   const run = newRun({ pack, seed, format: '3v3', team: { name, recs, meta } });          // floor 1, phase 'battle'
//   const setup = battleSetup(pack, run);                                                   // { player, foe, cpu, pick, seed, validate:false, ... } for createMatchController
//   const { run: r2, events } = recordFloorResult(run, { floor: 1, result: 'w', turns, faints });   // a win -> phase 'offer' (balls), a loss -> 'over' (or a life is spent)
//   const view = offerView(r2, { pack });                                                   // { balls:[{ id, name, rarity, effectText, synergyProgress, stacksInto }], cursorStart }
//   const { run: r3 } = takeBuff(r2, view.balls[0].id);                                     // or takeBuff(r2, null) to skip; nothing is ever granted automatically
//
// THE TOWER NEVER TOUCHES THE REGULAR GAME. This module imports no career, profile, store, hub or battle-page code, and nothing in the regular battle path imports it (tools/pokemonarena_tower_test.mjs
// scans the import graph both ways). Buffs live only in `battleSetup`'s output; a Tower result is a value for the Tower's own record (`foldRunInto`), never a career entry.

import { createRng } from './ai.js';
import { randomTeam, FORMATS } from './matchctl.js';
import { validateTeam } from './rules.js';
import { CONFIG, TIERS } from './tower_config.js';
import { emptyTower, TOWER_VERSION, checkTowerShape, RUN_KEYS, RUN_KEYS_OPTIONAL, sanitiseStamp } from './tower_record.js';
import { FAMILIES, FAMILY_BY_ID, SYNERGIES, capOf, applyTeam, applyFoe, foeMods, runEffects, synergyState, describeOps, tierOfPower, mulPm } from './tower_buffs.js';

export const RUN_VERSION = 1;
export { emptyTower, TOWER_VERSION };               // the stored record's layout lives in tower_record.js (light: profile.js imports it); re-exported so the Tower's callers need one import
const clone = (x) => JSON.parse(JSON.stringify(x));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
/** A deterministic u32 from integers (an avalanche mix: neighbouring inputs give unrelated outputs). */
export function mix(...xs) { let h = 0x9e3779b9; for (const x of xs) { h = Math.imul(h ^ (x >>> 0), 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; } return h >>> 0; }
const pickFrom = (table, f) => { let v = table[0][1]; for (const [from, x] of table) if (f >= from) v = x; return v; };

export const isBoss = (floor, cfg = CONFIG) => floor >= 1 && floor % cfg.bossEvery === 0;

/* ---------------------------------------------------------------------------------------------- the floors */

/** What a floor asks of the player, from the table in tower_config.js (before any buff shapes it). */
export function floorSpec(floor, format, cfg = CONFIG) {
  const boss = isBoss(floor, cfg), f = cfg.foeEv;
  const evPm = clamp(f.startPm + f.perFloorPm * (floor - 1), 0, f.maxPm);
  const evBonus = (floor >= f.bonusFrom ? (floor - f.bonusFrom + 1) * f.bonusPerFloor : 0) + (boss ? f.bossBonus : 0);
  return { floor, boss, cpu: boss ? cfg.bossCpu : pickFrom(cfg.cpu, floor), size: boss ? cfg.bossSize : pickFrom(cfg.foeSize[format], floor), evPm, evBonus, ivCap: pickFrom(cfg.foeIvCap, floor), itemMode: pickFrom(cfg.foeItems, floor) };
}

const TITLES = {
  easy: ['Youngster', 'Lass', 'Bug Catcher', 'Picnicker', 'Fisherman', 'Camper', 'Schoolkid', 'Rookie'],
  normal: ['Hiker', 'Sailor', 'Black Belt', 'Gentleman', 'Psychic', 'Scientist', 'Ranger', 'Breeder', 'Juggler', 'Biker'],
  hard: ['Ace Trainer', 'Cooltrainer', 'Veteran', 'Expert', 'Dragon Tamer', 'Elite', 'Specialist', 'Champion'],
};
const FIRST = ['Joey', 'Hana', 'Marco', 'Ines', 'Theo', 'Mira', 'Kenji', 'Lena', 'Oskar', 'Priya', 'Dante', 'Yuki', 'Bram', 'Sana', 'Felix', 'Nora', 'Ivo', 'Talia', 'Rui', 'Edda', 'Cyrus', 'Maeve', 'Anders', 'Zara', 'Hugo', 'Leila', 'Soren', 'Wren', 'Pavel', 'Isla'];
const BOSSES = { 10: 'Gatekeeper Thorne', 20: 'Warden Isolde', 30: 'Tower Master Aldous' };

/**
 * The trainer of a floor, BEFORE any buff of the player's: { floor, name, boss, cpu: { level, seed }, spec, recs, meta }.
 * Always built from a six-Pokemon team (a smaller team is a prefix of it), so a buff that changes the size changes only how many are used.
 */
export function floorTrainer(pack, { seed, format, floor }, cfg = CONFIG, mods = null) {
  const spec = floorSpec(floor, format, cfg), m = mods || { sizeAdd: 0, cutPm: 0, ivCap: 31, noItems: false, reliefPm: 0 };
  const rng = createRng(mix(seed, floor, 0x7a41));
  const band = spec.cpu;
  const name = spec.boss ? (BOSSES[floor] || 'Tower Boss ' + floor) : TITLES[band][rng(TITLES[band].length)] + ' ' + FIRST[rng(FIRST.length)];
  const size = clamp(spec.size + m.sizeAdd, cfg.minFoe[format], 6);
  const team = randomTeam(pack, mix(seed, floor, 0x7ea3), 6, cfg.ruleset);
  const pm = clamp(Math.floor(spec.evPm * (1000 - m.cutPm) / 1000), 0, 1000);
  const bonus = spec.boss ? Math.floor(spec.evBonus * (1000 - m.reliefPm) / 1000) : spec.evBonus;
  const ivCap = Math.min(spec.ivCap, m.ivCap);
  const recs = team.recs.slice(0, size).map((r, i) => {
    const c = clone(r);
    for (const k of Object.keys(c.evs)) { const base = c.evs[k]; c.evs[k] = clamp(mulPm(base, pm) + (base > 0 ? bonus : 0), 0, cfg.foeEv.cap); }
    for (const k of Object.keys(c.ivs)) c.ivs[k] = Math.min(c.ivs[k], ivCap);
    if (m.noItems || spec.itemMode === 'none' || (spec.itemMode === 'half' && (i + rng(2)) % 2 === 1)) c.item = 0;
    return c;
  });
  return { floor, name, boss: spec.boss, cpu: { level: spec.cpu, seed: mix(seed, floor, 0xc0de) }, spec: { ...spec, size, evPm: pm, evBonus: bonus, ivCap }, recs, meta: team.meta.slice(0, size) };
}

/* ---------------------------------------------------------------------------------------------- the run */

const baseRun = (o) => ({ v: RUN_VERSION, seed: o.seed >>> 0, format: o.format, ruleset: o.ruleset, floor: 1, phase: 'battle', team: o.team, types: o.types, held: [], offer: null, history: [], skips: 0, livesUsed: 0, folded: false, fighting: false, earned: [], attempt: 0 });

/** Start a run on floor 1. team = { name, recs, meta } is a SNAPSHOT of a legal saved team. Throws RangeError for a team that cannot play the format. */
export function newRun({ pack, seed, format, team, cfg = CONFIG }) {
  if (!cfg.formats.includes(format)) throw new RangeError('format must be one of ' + cfg.formats.join(', '));
  if (!team || !Array.isArray(team.recs) || team.recs.length < 1 || team.recs.length > 6) throw new RangeError('a team of 1..6 Pokemon is needed');
  if (FORMATS[format].pick && team.recs.length < FORMATS[format].pick) throw new RangeError('a ' + format + ' run needs at least ' + FORMATS[format].pick + ' Pokemon');
  const v = validateTeam(team.recs.map((r) => ({ ...r, moves: r.moves.map((m) => (typeof m === 'number' ? m : m.id)) })), pack, cfg.ruleset);
  if (!v.ok) throw new RangeError('the team is not legal under ' + cfg.ruleset + ': ' + v.reasons.slice(0, 2).map((r) => r.code).join(', '));
  const recs = clone(team.recs).map((r) => ({ ...r, moves: r.moves.map((m) => (typeof m === 'number' ? { id: m, ppUps: 0 } : { id: m.id, ppUps: m.ppUps || 0 })) }));
  const meta = (team.meta && team.meta.length === recs.length ? clone(team.meta) : recs.map(() => ({ gender: null, shiny: false }))).map((m) => ({ gender: m && (m.gender === 'M' || m.gender === 'F') ? m.gender : null, shiny: !!(m && m.shiny) }));
  const types = recs.map((r) => { const t = pack.species[r.species].types; return t[0] === t[1] ? [t[0], t[0]] : [t[0], t[1]]; });
  return baseRun({ seed, format, ruleset: cfg.ruleset, team: { name: String(team.name || 'Team').slice(0, 24), recs, meta }, types });
}

export const livesLeft = (run, cfg = CONFIG) => Math.max(0, cfg.lives + runEffects(run.held, { cfg }).lives - run.livesUsed);
const heldPower = (held, id) => { const h = held.find((x) => x.id === id); return h ? h.p : 0; };

/** Everything a battle of the CURRENT floor needs, buffs applied: feed `player.recs` / `foe.recs` to createMatchController with `validate: false` (the Tower's records may exceed the ruleset's 510 EV total on purpose). */
export function battleSetup(pack, run, cfg = CONFIG) {
  const salt = mix(run.seed, run.floor, 0x5a17);
  const mods = foeMods(run.held, { cfg });
  const trainer = floorTrainer(pack, { seed: run.seed, format: run.format, floor: run.floor }, cfg, mods);
  const player = applyTeam(pack, run.team.recs, run.held, { cfg, salt });
  const foeRecs = applyFoe(pack, trainer.recs, run.held, { cfg, salt });
  return {
    floor: run.floor, boss: trainer.boss, ruleset: cfg.ruleset, format: run.format, pick: FORMATS[run.format].pick, validate: false, seed: run.livesUsed ? mix(run.seed, run.floor, 0xb477, run.livesUsed) : mix(run.seed, run.floor, 0xb477),
    names: [run.team.name, trainer.name], cpu: trainer.cpu,
    player: { recs: player, meta: clone(run.team.meta) }, foe: { recs: foeRecs, meta: trainer.meta },
    trainer: { name: trainer.name, boss: trainer.boss, spec: trainer.spec }, effects: runEffects(run.held, { cfg }),
  };
}

/* ---------------------------------------------------------------------------------------------- offers */

function tierWeights(cleared, boss, fortune, cfg) {
  const table = boss ? cfg.offer.bossWeights : cfg.offer.tierWeights;
  let w = table[0].w.slice(); for (const e of table) if (cleared >= e.from) w = e.w.slice();
  const shift = clamp(fortune * cfg.offer.rareShiftPm, 0, 900);
  if (shift) {
    const low = w.findIndex((x) => x > 0), moved = Math.floor(w[low] * shift / 1000);
    const dest = [4, 3, 1].map((x, i) => (low + 1 + i < 4 ? [low + 1 + i, x] : null)).filter(Boolean), tot = dest.reduce((n, d) => n + d[1], 0);
    if (dest.length && moved > 0) { w[low] -= moved; let given = 0; dest.forEach(([t, x], i) => { const g = i === dest.length - 1 ? moved - given : Math.floor(moved * x / tot); w[t] += g; given += g; }); }
  }
  return w;
}
const weighted = (rng, items, wOf) => { const tot = items.reduce((n, x) => n + wOf(x), 0); let r = rng(tot); for (const x of items) { r -= wOf(x); if (r < 0) return x; } return items[items.length - 1]; };

/** Would taking this family change anything (for the team, the opponent or the run)? Used so that a ball never offers a dead buff. */
function isUseful(pack, run, f, tier, cfg, memo) {
  if (!pack) return true;
  const p0 = heldPower(run.held, f.id), p1 = Math.min(capOf(f, cfg), p0 + TIERS[tier].points);
  if (p1 === p0) return false;
  const held1 = p0 ? run.held.map((h) => (h.id === f.id ? { id: h.id, p: p1 } : h)) : run.held.concat([{ id: f.id, p: p1 }]);
  if (memo.before === undefined) memo.before = JSON.stringify(applyTeam(pack, run.team.recs, run.held, { cfg }));
  if (memo.before !== JSON.stringify(applyTeam(pack, run.team.recs, held1, { cfg }))) return true;
  return f.ops.some((op) => op.op !== 'ev' && op.op !== 'iv' && op.op !== 'nature' && op.op !== 'ability' && op.op !== 'item' && op.op !== 'pp' && op.op !== 'move');
}

/**
 * The offer after the floor just cleared (run.floor - 1): [{ id, tier }] in ball order. Deterministic in (seed, floor, held buffs). `pack` (optional) filters out buffs that would change nothing.
 * Sizes, rarity odds, guarantees and boss rules are all in cfg.offer.
 */
export function offerFor(run, { pack = null, cfg = CONFIG } = {}) {
  const cleared = run.floor - 1, boss = isBoss(cleared, cfg), eff = runEffects(run.held, { cfg });
  const size = clamp((boss ? cfg.offer.bossSize + eff.bossOffer : cfg.offer.size) + eff.offer, cfg.offer.minSize, cfg.offer.maxSize);
  const weights = tierWeights(cleared, boss, eff.fortune, cfg), rng = createRng(mix(run.seed, cleared, 0x0ffe5));
  const floorTier = boss ? cfg.offer.bossGuaranteeTier : (cfg.offer.guaranteeEvery > 0 && cleared % cfg.offer.guaranteeEvery === 0 ? cfg.offer.guaranteeTier : 0);
  const out = [], used = new Set(), memo = {};
  for (let i = 0; i < size; i++) {
    let tier = weighted(rng, [0, 1, 2, 3].filter((t) => weights[t] > 0), (t) => weights[t]);
    if (i === 0) tier = Math.max(tier, floorTier);
    let chosen = null;
    for (const t of [tier, ...[0, 1, 2, 3].filter((x) => x !== tier).sort((a, b) => Math.abs(a - tier) - Math.abs(b - tier) || a - b)]) {
      let cands = FAMILIES.filter((f) => f.tiers[0] <= t && t <= f.tiers[1] && !used.has(f.id) && heldPower(run.held, f.id) < capOf(f, cfg));
      while (cands.length) {                       // draw by weight; a draw that would change nothing is set aside and the next one drawn
        const f = weighted(rng, cands, (x) => x.w);
        if (isUseful(pack, run, f, t, cfg, memo)) { chosen = { id: f.id, tier: t }; break; }
        cands = cands.filter((x) => x !== f);
      }
      if (chosen) break;
    }
    if (chosen) { used.add(chosen.id); out.push(chosen); }
  }
  return out;
}

/** The balls of an offer as the offer screen needs them (TOWER.md "The offer screen"). Pure: no drawing. */
export function offerView(run, { pack = null, cfg = CONFIG } = {}) {
  const offer = run.offer || [], syn = synergyState(run.held);
  const balls = offer.map((o) => {
    const f = FAMILY_BY_ID[o.id], t = TIERS[o.tier], p0 = heldPower(run.held, o.id), p1 = Math.min(capOf(f, cfg), p0 + t.points);
    const held1 = p0 ? run.held.map((h) => (h.id === o.id ? { id: h.id, p: p1 } : h)) : run.held.concat([{ id: o.id, p: p1 }]);
    const after = synergyState(held1);
    const progress = [];
    for (const s of SYNERGIES) {
      if (s.kind === 'tag' && f.tags.includes(s.tag) && !p0) { const n = after.tags[s.tag], next = s.levels.find((l) => l.need > (syn.tags[s.tag] || 0)) || s.levels[s.levels.length - 1]; progress.push({ id: s.id, name: next.name, have: Math.min(n, next.need), need: next.need, gained: n >= next.need && (syn.tags[s.tag] || 0) < next.need }); }
      else if (s.kind === 'combo' && s.needs.includes(o.id) && !p0) { const have = s.needs.filter((n) => held1.some((h) => h.id === n)).length; progress.push({ id: s.id, name: s.name, have, need: s.needs.length, gained: have === s.needs.length }); }
      else if (s.kind === 'mult' && f.tags.includes(s.when.tag) && !p0) { const n = after.tags[s.when.tag]; progress.push({ id: s.id, name: s.name, have: Math.min(n, s.when.min), need: s.when.min, gained: n >= s.when.min && (syn.tags[s.when.tag] || 0) < s.when.min }); }
    }
    progress.sort((a, b) => Number(b.gained) - Number(a.gained) || b.have / b.need - a.have / a.need || (a.id < b.id ? -1 : 1));
    return {
      id: o.id, name: f.name, tier: o.tier, rarity: t.id, alias: t.alias, color: t.color, ball: t.ball, category: f.cat, curse: f.curse,
      effectText: describeOps(f.ops, p1, { cfg, pm: after.boost[o.id] || 1000 }),
      synergyProgress: progress.slice(0, 4),
      stacksInto: p0 ? { from: { tier: TIERS[tierOfPower(p0)].id, power: p0 }, to: { tier: TIERS[tierOfPower(p1)].id, power: p1 }, text: TIERS[tierOfPower(p0)].id + ' -> ' + TIERS[tierOfPower(p1)].id } : null,
    };
  });
  return { balls, cursorStart: 0, canSkip: !!cfg.offer.allowSkip };
}

/* ---------------------------------------------------------------------------------------------- results and picks */

/** A finished battle as the run needs it. Accepts match_stats.summarizeMatch's summary (viewSide 0) or the plain object { floor, result, turns, faints, comeback?, sweep?, closest? }. */
export function floorResultFrom(x, floor) {
  if (x && x.sides && x.flags) {
    const me = x.sides[x.viewSide === 1 ? 1 : 0];
    return { floor, result: x.result, turns: x.turns | 0, faints: me.faints | 0, comeback: !!x.flags.comeback, sweep: !!x.flags.sweep, closest: x.closestCall ? x.closestCall.pct : null };
  }
  return { floor: x.floor === undefined ? floor : x.floor, result: x.result, turns: x.turns | 0, faints: x.faints | 0, comeback: !!x.comeback, sweep: !!x.sweep, closest: x.closest === undefined ? null : x.closest };
}
const RESULTS = ['w', 'l', 'd', 'f'];

/**
 * Record the result of the floor being fought. -> { run, applied, events, why? }. Idempotent: a result for a floor that is not the current one, or in any phase but 'battle', changes nothing (a double fire,
 * a reload that replays the result screen). A win opens the offer (or wins the run on the last floor); a loss spends a life if there is one, else ends the run.
 */
export function recordFloorResult(run, resultIn, { pack = null, cfg = CONFIG } = {}) {
  const res = floorResultFrom(resultIn, run.floor);
  if (!RESULTS.includes(res.result) || !isInt(res.turns, 0, 100000) || !isInt(res.faints, 0, 36)) return { run, applied: false, events: [], why: 'bad result' };
  if (run.phase !== 'battle' || res.floor !== run.floor) return { run, applied: false, events: [], why: run.phase !== 'battle' ? 'not in battle' : 'not the current floor' };
  const r = clone(run), boss = isBoss(run.floor, cfg), won = res.result === 'w';
  r.fighting = false; r.attempt = 0;
  r.history.push({ floor: run.floor, result: won ? 'w' : 'l', turns: res.turns, faints: res.faints, flawless: won && res.faints === 0, boss, comeback: won && res.comeback, sweep: won && res.sweep, closest: res.closest });
  const events = [];
  if (won) {
    events.push({ type: 'floor-won', floor: run.floor, boss });
    if (run.floor >= cfg.floors) { r.phase = 'won'; events.push({ type: 'run-won' }); }
    else { r.phase = 'offer'; r.floor = run.floor + 1; r.offer = offerFor(r, { pack, cfg }); if (!r.offer.length) { r.phase = 'battle'; r.offer = null; r.history[r.history.length - 1].pick = null; r.skips += 1; } }
  } else if (livesLeft(run, cfg) > 0) { r.livesUsed += 1; r.history[r.history.length - 1].life = true; events.push({ type: 'life-used', floor: run.floor }); }
  else { r.phase = 'over'; events.push({ type: 'run-over', floor: run.floor }); }
  return { run: r, applied: true, events };
}

/** Take one of the offered balls by family id (or null to skip, if the config allows). The family is added at the tier offered, or its power grows by that tier's points. -> { run, applied, events, why? } */
export function takeBuff(run, id, { cfg = CONFIG } = {}) {
  if (run.phase !== 'offer' || !run.offer) return { run, applied: false, events: [], why: 'no offer' };
  const r = clone(run), last = r.history[r.history.length - 1], events = [];
  if (id === null) {
    if (!cfg.offer.allowSkip) return { run, applied: false, events: [], why: 'skipping is not allowed' };
    last.pick = null; r.skips += 1;
  } else {
    const o = run.offer.find((x) => x.id === id);
    if (!o) return { run, applied: false, events: [], why: 'not offered' };
    const f = FAMILY_BY_ID[id], p0 = heldPower(run.held, id), p1 = Math.min(capOf(f, cfg), p0 + TIERS[o.tier].points), before = synergyState(run.held);
    if (p0) r.held = r.held.map((h) => (h.id === id ? { id, p: p1 } : h)); else r.held.push({ id, p: p1 });
    last.pick = { id, tier: o.tier };
    const after = synergyState(r.held), had = new Set(before.active.map((s) => s.id + ':' + s.level));
    events.push({ type: 'buff', id, tier: o.tier, from: p0 ? { tier: tierOfPower(p0), power: p0 } : null, to: { tier: tierOfPower(p1), power: p1 }, upgraded: p0 > 0 && tierOfPower(p1) > tierOfPower(p0), synergies: after.active.filter((s) => !had.has(s.id + ':' + s.level)).map((s) => ({ id: s.id, name: s.name, level: s.level, text: s.text })) });
  }
  r.offer = null; r.phase = 'battle';
  return { run: r, applied: true, events };
}

/** The player leaves the Tower (a closed tab on a fresh visit, the Give Up menu): the run is over. */
export function abandonRun(run) { if (run.phase === 'over' || run.phase === 'won') return run; const r = clone(run); r.phase = 'over'; r.offer = null; r.fighting = false; r.attempt = 0; return r; }

/** A fight of the current floor has begun (the battle screen is up). `attempt` (1..2^32-1) is the identity of the page that is fighting it: only that page can finish it. Idempotent. A run that is not waiting for a fight changes nothing. -> { run, applied } */
export function markFighting(run, attempt = 0) {
  if (run.phase !== 'battle' || run.fighting) return { run, applied: false };
  const r = clone(run); r.fighting = true; r.attempt = attempt >>> 0; return { run: r, applied: true };
}

/* ---------------------------------------------------------------------------------------------- serialised form (strict) */

const HIST_KEYS = ['floor', 'result', 'turns', 'faints', 'flawless', 'boss', 'comeback', 'sweep', 'closest', 'life', 'pick'];

function checkRec(r) {
  if (!isObj(r) || !isInt(r.species, 1, 100000) || !isInt(r.level, 1, 100) || !isInt(r.nature, 0, 24) || !isInt(r.abilitySlot, 0, 2) || !isInt(r.item === undefined ? 0 : r.item, 0, 100000)) return false;
  if (!Array.isArray(r.moves) || r.moves.length < 1 || r.moves.length > 4 || !r.moves.every((m) => isObj(m) && isInt(m.id, 1, 100000) && isInt(m.ppUps === undefined ? 0 : m.ppUps, 0, 3))) return false;
  if (new Set(r.moves.map((m) => m.id)).size !== r.moves.length) return false;
  for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) if (!isObj(r.ivs) || !isInt(r.ivs[k], 0, 31) || !isObj(r.evs) || !isInt(r.evs[k], 0, 255)) return false;
  return r.nickname === undefined || (typeof r.nickname === 'string' && r.nickname.length <= 24);
}

/** held rebuilt from the picks in the history: the stored `held` must equal it (a forged power is refused). */
export function heldFromHistory(history, cfg = CONFIG) {
  const held = [];
  for (const h of history) if (h.pick) { const f = FAMILY_BY_ID[h.pick.id], p0 = heldPower(held, h.pick.id), p1 = Math.min(capOf(f, cfg), p0 + TIERS[h.pick.tier].points); if (p0) held.find((x) => x.id === h.pick.id).p = p1; else held.push({ id: h.pick.id, p: p1 }); }
  return held;
}

/** Strict parse of a stored run: -> { ok: true, run } | { ok: false, why }. Never throws. With `pack` it also re-derives the offer and checks the team's legality; without, it checks shape and consistency. */
export function parseRun(input, { pack = null, cfg = CONFIG } = {}) {
  const bad = (why) => ({ ok: false, why });
  let r;
  try { r = typeof input === 'string' ? JSON.parse(input) : clone(input); } catch (_e) { return bad('not JSON'); }
  if (!isObj(r)) return bad('not an object');
  for (const k of Object.keys(r)) if (!RUN_KEYS.includes(k)) return bad('unknown field ' + k);
  for (const k of RUN_KEYS) if (!(k in r) && !RUN_KEYS_OPTIONAL.includes(k)) return bad('missing field ' + k);
  if ('attempt' in r && !isInt(r.attempt, 0, 0xffffffff)) return bad('attempt');
  if (r.v !== RUN_VERSION) return bad('version');
  if (!isInt(r.seed, 0, 0xffffffff) || !cfg.formats.includes(r.format) || r.ruleset !== cfg.ruleset) return bad('seed, format or ruleset');
  if (!['battle', 'offer', 'over', 'won'].includes(r.phase) || !isInt(r.floor, 1, cfg.floors) || typeof r.folded !== 'boolean' || typeof r.fighting !== 'boolean') return bad('phase, floor or folded');
  if (r.fighting && r.phase !== 'battle') return bad('a fight is marked outside the battle phase');
  if (!r.fighting && (r.attempt >>> 0) !== 0) return bad('an attempt is marked without a fight');
  if (!Array.isArray(r.earned) || r.earned.length > 200 || !r.earned.every((x) => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(x)) || new Set(r.earned).size !== r.earned.length) return bad('earned');
  if (!isObj(r.team) || typeof r.team.name !== 'string' || r.team.name.length > 24 || !Array.isArray(r.team.recs) || r.team.recs.length < 1 || r.team.recs.length > 6 || !r.team.recs.every(checkRec)) return bad('team');
  if (FORMATS[r.format].pick && r.team.recs.length < FORMATS[r.format].pick) return bad('team too small for the format');
  if (!Array.isArray(r.team.meta) || r.team.meta.length !== r.team.recs.length || !r.team.meta.every((m) => isObj(m) && (m.gender === null || m.gender === 'M' || m.gender === 'F') && typeof m.shiny === 'boolean')) return bad('team meta');
  if (!Array.isArray(r.types) || r.types.length !== r.team.recs.length || !r.types.every((t) => Array.isArray(t) && t.length === 2 && t.every((x) => isInt(x, 0, 30)))) return bad('types');
  if (!Array.isArray(r.held) || r.held.length > FAMILIES.length || !r.held.every((h) => isObj(h) && Object.keys(h).length === 2 && FAMILY_BY_ID[h.id] && isInt(h.p, 1, capOf(FAMILY_BY_ID[h.id], cfg))) || new Set(r.held.map((h) => h.id)).size !== r.held.length) return bad('held');
  if (!Array.isArray(r.history) || r.history.length > 400) return bad('history');
  let wins = 0, prev = 0, lives = 0;
  for (const h of r.history) {
    if (!isObj(h)) return bad('history entry');
    for (const k of Object.keys(h)) if (!HIST_KEYS.includes(k)) return bad('history field ' + k);
    if (!isInt(h.floor, 1, cfg.floors) || h.floor < prev || (h.result !== 'w' && h.result !== 'l') || !isInt(h.turns, 0, 100000) || !isInt(h.faints, 0, 36)) return bad('history values');
    if (typeof h.flawless !== 'boolean' || typeof h.boss !== 'boolean' || typeof h.comeback !== 'boolean' || typeof h.sweep !== 'boolean' || !(h.closest === null || isInt(h.closest, 0, 100))) return bad('history flags');
    if (h.boss !== isBoss(h.floor, cfg) || h.flawless !== (h.result === 'w' && h.faints === 0)) return bad('history is inconsistent');
    if (h.pick !== undefined && h.pick !== null && !(isObj(h.pick) && FAMILY_BY_ID[h.pick.id] && isInt(h.pick.tier, 0, 3) && FAMILY_BY_ID[h.pick.id].tiers[0] <= h.pick.tier && h.pick.tier <= FAMILY_BY_ID[h.pick.id].tiers[1])) return bad('history pick');
    if (h.result === 'w') { wins++; if (h.floor !== wins) return bad('wins are not floors in order'); } else if (h.life) lives++;
    prev = h.floor;
  }
  // the floor and the pending offer follow from the history: wins are floors 1..n; a battle or an offer is on floor n + 1; a won run has cleared every floor; an over run is on the floor it lost or left
  if (r.phase === 'won') { if (wins !== cfg.floors || r.floor !== cfg.floors) return bad('floor does not match the wins'); }
  else if (r.phase === 'over') { if (r.floor !== Math.min(cfg.floors, wins + 1)) return bad('floor does not match the wins'); }
  else if (r.floor !== wins + 1) return bad('floor does not match the wins');
  const unresolved = r.history.filter((h) => h.result === 'w' && h.pick === undefined).length, lastH = r.history[r.history.length - 1];
  if (r.phase === 'offer' ? (unresolved !== 1 || !lastH || lastH.result !== 'w' || lastH.pick !== undefined) : r.phase === 'battle' ? unresolved !== 0 : r.phase === 'won' ? unresolved !== 1 : unresolved > 1) return bad('an offer is pending or missing');
  const rebuilt = heldFromHistory(r.history, cfg);
  if (JSON.stringify(rebuilt) !== JSON.stringify(r.held)) return bad('held buffs do not match the picks');
  if (!isInt(r.skips, 0, 400) || r.skips !== r.history.filter((h) => h.result === 'w' && h.pick === null).length) return bad('skips');
  if (!isInt(r.livesUsed, 0, 50) || r.livesUsed !== lives || r.livesUsed > cfg.lives + runEffects(r.held, { cfg }).lives) return bad('lives');
  if (r.phase === 'offer') {
    if (!Array.isArray(r.offer) || r.offer.length < 1 || r.offer.length > cfg.offer.maxSize || !r.offer.every((o) => isObj(o) && FAMILY_BY_ID[o.id] && isInt(o.tier, 0, 3) && FAMILY_BY_ID[o.id].tiers[0] <= o.tier && o.tier <= FAMILY_BY_ID[o.id].tiers[1]) || new Set(r.offer.map((o) => o.id)).size !== r.offer.length) return bad('offer');
    if (pack && JSON.stringify(offerFor(r, { pack, cfg })) !== JSON.stringify(r.offer)) return bad('the offer is not the one this seed gives');
  } else if (r.offer !== null) return bad('offer outside the offer phase');
  if (pack) { const v = validateTeam(r.team.recs.map((x) => ({ ...x, item: x.item || 0, moves: x.moves.map((m) => m.id) })), pack, cfg.ruleset); if (!v.ok) return bad('the team is not legal'); }
  return { ok: true, run: r };
}
export const serializeRun = (run) => JSON.stringify(run);

/* ---------------------------------------------------------------------------------------------- the Tower's own record (profile.tower, schema 5) */
// The record's LAYOUT and its shallow shape check are in tower_record.js (profile.js imports that, not this file). What is here needs the game: the deep check of the run it holds, and folding a finished run in.

/** Strict check of a stored Tower record: its shape (tower_record.js) AND the run under way, parsed deeply. -> [] when well formed, else short problems. */
export function checkTower(t, { cfg = CONFIG, pack = null } = {}) {
  const bad = checkTowerShape(t, cfg);
  if (bad.length) return bad;
  for (const id of Object.keys(t.buffsSeen)) if (!FAMILY_BY_ID[id]) bad.push('unknown buff ' + id);          // the record's SHAPE lets a retired family id through (profile.js must never refuse a player's climb for it); the game-level check does not
  if (t.current !== null) { const p = parseRun(t.current, { pack, cfg }); if (!p.ok) bad.push('current run: ' + p.why); }
  return bad;
}

/** The summary of a finished run the result screen shows (tower.last). */
export function lastOf(run, at) {
  return { format: run.format, seed: run.seed, won: run.phase === 'won', cleared: run.history.filter((h) => h.result === 'w').length, livesUsed: run.livesUsed, skips: run.skips, held: run.held.map((h) => ({ id: h.id, p: h.p })), earned: run.earned.slice(), at: sanitiseStamp(at) };
}

/**
 * Fold a FINISHED run into the Tower record, once. -> { tower, run } (run.folded = true). A run that is not over, or was folded already, changes nothing.
 * The record's counters move, "current" is emptied and "last" becomes this run's summary; "at" is the caller's clock (this module has none).
 */
export function foldRunInto(tower, run, { cfg = CONFIG, at = 0 } = {}) {
  if ((run.phase !== 'over' && run.phase !== 'won') || run.folded) return { tower, run };
  const t = clone(tower), wins = run.history.filter((h) => h.result === 'w');
  t.runs += 1; if (run.phase === 'won') { t.wins += 1; t.winsByFormat[run.format] += 1; }
  t.floors += wins.length; t.bosses += wins.filter((h) => h.boss).length;
  t.best[run.format] = Math.max(t.best[run.format], wins.length);
  for (const h of run.history) if (h.pick) t.buffsSeen[h.pick.id] = (t.buffsSeen[h.pick.id] || 0) + 1;
  t.current = null;
  const folded = { ...clone(run), folded: true };
  t.last = lastOf(folded, at);
  return { tower: t, run: folded };
}

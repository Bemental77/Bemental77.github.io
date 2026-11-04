// pokemonarena/js/tower_session.js -- everything the Pokemon Tower DOES between the hub, the battle and the profile, as plain functions that take plain arguments and callbacks. Pure ES module: no DOM, no URL, no
// storage, no clock (the caller's `now` is passed in). Nothing here assumes it owns the page, which is the point: today the hub shows the Tower's screens and the battle page (battle.html?tower=1) fights a
// floor, tomorrow the hub hosts the fight itself, and both call the SAME functions. The one thing that moves between pages is tower_launch.js.
//
// THE PIECES
//   reducers      reduceStart / reduceBeginFloor / reduceFinishFloor / reducePick / reduceGiveUp (tower record, args) -> { tower, applied, ... }. PURE: the stored Tower record in, the next one out. The
//                 profile store runs one inside a single transaction (store.towerUpdate), so two tabs cannot lose each other's step and a result is applied once however often it is sent.
//   floor spec    towerFloorSpec(pack, run) -> what battle_boot.js / matchctl.js build a match from, the run's buffs already applied to the records, `validate: false` (the only place a buff reaches a battle).
//   session       createTowerSession({ pack, persist, now }) binds the reducers to a place that keeps the record (`persist`: { read(), update(fn) }): the profile store (storePersist) or a plain variable (memoryPersist).
//   startTowerFloor({ pack, persist, floor, runId, navType, now }) -> { ok, spec, finish(summary) }: begin a floor, get the battle to build, and the function that turns the finished battle into the next step.
//   summarizeTower(tower, pack) -> the plain JSON the hub draws (record, the run under way with its offer, the buffs held with their words, the synergies, the achievements, the last run).
//
// WHAT HAPPENS WHEN (the rules, each tested):
//   * A fight begins when the player makes the first choice of it (the team preview, or the first move): the run is marked `fighting`. Reloading the battle page resumes it. Arriving at a floor whose fight is
//     marked, any other way (the tab was closed, the address typed again), means the earlier fight was LEFT: that counts as a loss on that floor (an Extra Life, if held, is spent). Leaving a fight is never a
//     free retry; looking at a floor and leaving before choosing anything costs nothing.
//   * A fight ends: a win opens the offer (or wins the run on the top floor), a loss spends a life or ends the run. A result is applied ONCE: the same result sent twice, or for another floor, changes nothing.
//   * A ball is taken (or the offer skipped): the run goes back to waiting for a fight.
//   * Achievements are evaluated after every step, stamped with the caller's clock, and listed in the run that earned them.
//   * A run that ends is folded into the record (best floor, wins, buffs seen...) and summarised in `last`; `current` is emptied.
//   * NOTHING here writes the regular career. Tower results have no slot in `stats`.

import { CONFIG, TIERS } from './tower_config.js';
import { newRun, battleSetup, recordFloorResult, takeBuff, markFighting, abandonRun, foldRunInto, offerView, floorTrainer, livesLeft, mix, parseRun, isBoss } from './tower.js';
import { FAMILY_BY_ID, synergyState, describeOps, foeMods, tierOfPower, capOf } from './tower_buffs.js';
import { evaluate, unlock, ACHIEVEMENTS, ACHIEVEMENT_BY_ID } from './achievements.js';
import { randomTeam } from './matchctl.js';
import { emptyTower } from './tower_record.js';
import { teamFromProfile } from './teamcode.js';
import { teamFromMons } from './matchctl.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const refuse = (why, extra) => ({ applied: false, why, ...(extra || {}) });

/* ---------------------------------------------------------------------------------------------- a step's achievements */

/** Evaluate achievements for `run` against the record `tower`, stamp the new ones at `now`, and list them in the run. -> { tower, run, newIds } */
function stamp(tower, run, now, cfg) {
  const ev = evaluate(run, tower, cfg);
  if (!ev.unlocked.length) return { tower, run, newIds: [] };
  const r = clone(run);
  r.earned = r.earned.concat(ev.unlocked.filter((id) => !r.earned.includes(id)));
  return { tower: unlock(tower, ev.unlocked, now), run: r, newIds: ev.unlocked.slice() };
}

/** A run that has ended (over / won): fold it into the record once, then evaluate the achievements that depend on the record's totals. -> { tower, run, newIds } */
function conclude(tower, run, now, cfg) {
  const f = foldRunInto(tower, run, { cfg, at: now });
  const ev = evaluate(f.run, f.tower, cfg);
  let t = ev.unlocked.length ? unlock(f.tower, ev.unlocked, now) : f.tower;
  const earned = [...new Set(f.run.earned.concat(ev.unlocked))];
  t = { ...t, last: { ...t.last, earned } };
  return { tower: t, run: { ...f.run, earned }, newIds: ev.unlocked.slice() };
}

const nextOf = (run) => (run.phase === 'offer' ? { step: 'offer', floor: run.floor } : run.phase === 'battle' ? { step: run.livesUsed > 0 && run.history.length && run.history[run.history.length - 1].life ? 'retry' : 'fight', floor: run.floor } : { step: run.phase, floor: run.floor });

/* ---------------------------------------------------------------------------------------------- reducers */

/**
 * Start a run. `team` = { name, recs, meta } (a snapshot of a saved, legal team) or null for a random legal team. A run already under way is refused unless `replace` is true (it is then given up and counted).
 * -> { tower, applied, run } | { applied: false, why }
 */
export function reduceStart(tower, { pack, seed, format, team = null, now = 0, cfg = CONFIG, replace = false }) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return refuse('seed');
  if (!cfg.formats.includes(format)) return refuse('format');
  let t = tower;
  if (tower.current) {
    if (!replace) return refuse('a run is under way');
    t = conclude(tower, abandonRun(tower.current), now, cfg).tower;
  }
  let tm = team;
  if (!tm) {
    try { const rt = randomTeam(pack, mix(seed, 0x7ea1), 6, cfg.ruleset); tm = { name: 'RANDOM', recs: rt.recs, meta: rt.meta }; } catch (e) { return refuse('a random team could not be made'); }
  }
  let run;
  try { run = newRun({ pack, seed, format, team: tm, cfg }); } catch (e) { return refuse(String(e && e.message ? e.message : e).slice(0, 120)); }
  return { tower: { ...clone(t), current: run }, applied: true, run, events: [{ type: 'run-started', format }] };
}

/**
 * The battle screen for `floor` of the run `seed` is about to come up. -> { applied, status, ... }
 *   status 'ok'         the floor is the current one and no fight was marked: nothing is written (the fight is marked at the player's first choice: reduceMarkFight)
 *   status 'resume'     a fight is marked and this is a reload / history step (navType): it goes on, nothing is written
 *   status 'abandoned'  a fight is marked and this is a fresh arrival: the earlier fight was left, so it counted as a loss (written); `next` says what follows
 *   status 'stale'      the record is not waiting for that fight (another floor, the offer, no run, another run): nothing is written
 */
export function reduceBeginFloor(tower, { pack, floor, seed, navType = 'navigate', now = 0, cfg = CONFIG }) {
  const cur = tower.current;
  if (!cur || cur.seed !== seed) return { applied: false, status: 'stale', why: 'no such run' };
  if (cur.phase !== 'battle' || cur.floor !== floor) return { applied: false, status: 'stale', why: 'the run is not waiting for that fight', phase: cur.phase, floor: cur.floor };
  if (cur.fighting) {
    if (navType === 'reload' || navType === 'back_forward') return { applied: false, status: 'resume', run: cur };
    const lost = reduceFinishFloor(tower, { floor, seed, result: { floor, result: 'l', turns: 0, faints: 0 }, pack, now, cfg });
    return { ...lost, status: 'abandoned' };
  }
  return { applied: false, status: 'ok', run: cur };
}

/** The player made the first choice of the floor's fight: from now on leaving it counts as a loss. Idempotent. */
export function reduceMarkFight(tower, { floor, seed }) {
  const cur = tower.current;
  if (!cur || cur.seed !== seed) return refuse('no such run');
  if (cur.phase !== 'battle' || cur.floor !== floor) return refuse('the run is not waiting for that fight');
  const m = markFighting(cur);
  return m.applied ? { tower: { ...clone(tower), current: m.run }, applied: true, run: m.run } : { applied: false, why: 'already marked', run: cur };
}

/**
 * The fight of `floor` ended. `result` = match_stats' summary (viewSide 0) or { floor, result: 'w'|'l'|'d'|'f', turns, faints }. -> { tower, applied, run, events, next, newIds, finished } | { applied: false, why }
 * `next`: { step: 'offer' | 'retry' | 'over' | 'won', floor }.
 */
export function reduceFinishFloor(tower, { floor, seed, result, pack = null, now = 0, cfg = CONFIG }) {
  const cur = tower.current;
  if (!cur || cur.seed !== seed) return refuse('no such run');
  if (cur.phase !== 'battle' || cur.floor !== floor) return refuse('the run is not waiting for that fight');
  const r = recordFloorResult(cur, result, { pack, cfg });
  if (!r.applied) return refuse(r.why || 'the result was not applied');
  if (r.run.phase === 'over' || r.run.phase === 'won') {
    const c = conclude(tower, r.run, now, cfg);
    return { tower: c.tower, applied: true, run: c.run, events: r.events, next: { step: r.run.phase, floor: r.run.floor }, newIds: c.newIds, finished: true };
  }
  const s = stamp(tower, r.run, now, cfg);
  return { tower: { ...clone(s.tower), current: s.run }, applied: true, run: s.run, events: r.events, next: nextOf(s.run), newIds: s.newIds, finished: false };
}

/** A ball is taken (`id`) or the offer is skipped (`id` null). -> { tower, applied, run, events, next, newIds } | { applied: false, why } */
export function reducePick(tower, { seed, id, now = 0, cfg = CONFIG }) {
  const cur = tower.current;
  if (!cur || cur.seed !== seed) return refuse('no such run');
  if (cur.phase !== 'offer') return refuse('there is no offer');
  const r = takeBuff(cur, id, { cfg });
  if (!r.applied) return refuse(r.why || 'not offered');
  const s = stamp(tower, r.run, now, cfg);
  return { tower: { ...clone(s.tower), current: s.run }, applied: true, run: s.run, events: r.events, next: nextOf(s.run), newIds: s.newIds };
}

/** Give the run up (the player left the Tower for good, or starts another). It counts as a finished run that ended where it was. */
export function reduceGiveUp(tower, { seed = null, now = 0, cfg = CONFIG }) {
  const cur = tower.current;
  if (!cur || (seed !== null && cur.seed !== seed)) return refuse('no such run');
  const c = conclude(tower, abandonRun(cur), now, cfg);
  return { tower: c.tower, applied: true, run: c.run, events: [{ type: 'run-over', floor: cur.floor, gaveUp: true }], next: { step: 'over', floor: cur.floor }, newIds: c.newIds, finished: true };
}

/** A saved team as a Tower run keeps it: { name, recs, meta } in the engine's own record form (a snapshot: later edits to the saved team do not reach the run). Throws RangeError for a team that is not there. */
export function teamSnapshot(profile, teamId) {
  const t = teamFromProfile(profile, teamId), r = teamFromMons(t.mons, t.ruleset);
  return { name: String(t.name).slice(0, 24), recs: r.recs, meta: r.meta };
}
/** The name of a buff family, for a message ("You took Power Training"). */
export const buffName = (id) => (FAMILY_BY_ID[id] ? FAMILY_BY_ID[id].name : String(id));

/* ---------------------------------------------------------------------------------------------- the floor's battle */

const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
/** What a saved battle must agree with to be resumed: the run, the floor, the lives spent and every buff held (battle_resume.js keeps it beside the choices). */
export function towerTag(run) { return 'tower:' + run.seed + ':' + run.floor + ':' + run.livesUsed + ':' + fnv(JSON.stringify(run.held)).toString(16); }

/**
 * The battle of the run's CURRENT floor as the match builder wants it (battle_boot.js resolveBattle's `spec`): the player's records carry the run's buffs, the trainer is the floor's, `validate: false` lets a
 * buffed team past the 510-EV total. This is the ONLY place a buff reaches a battle: no other spec carries a `tower` field, and none sets `validate`.
 */
export function towerFloorSpec(pack, run, cfg = CONFIG) {
  const s = battleSetup(pack, run, cfg);
  return {
    pack, ruleset: s.ruleset, teams: [s.player.recs, s.foe.recs], meta: [s.player.meta, s.foe.meta], seed: s.seed, pick: s.pick, names: ['You', s.names[1]],
    sides: [{ kind: 'human' }, { kind: 'cpu', level: s.cpu.level, seed: s.cpu.seed }], cpu: s.cpu.level, format: run.format, trainer: s.names[1], validate: false,
    tower: { floor: run.floor, boss: s.boss, seed: run.seed, lives: livesLeft(run, cfg), livesUsed: run.livesUsed, buffs: run.held.length, tag: towerTag(run), trainer: s.trainer, effects: s.effects },
  };
}

/* ---------------------------------------------------------------------------------------------- persistence */

/** A place that keeps the Tower record in a plain variable (tests, and a hub that hosts the fight in one page without a store). */
export function memoryPersist(initial) {
  let tower = clone(initial || emptyTower());
  return {
    async read() { return clone(tower); },
    async update(fn) { const r = fn(clone(tower)); if (r && r.tower) tower = clone(r.tower); return { result: r || null, tower: clone(tower) }; },
    peek: () => clone(tower),
  };
}

/** The profile store as that place: every change is one transaction (store.towerUpdate), and nothing outside profile.tower is touched. */
export function storePersist(store, profileId) {
  return {
    async read() { const l = await store.loadProfile(profileId); if (!l.ok) throw new Error('the profile could not be read'); return l.profile.tower; },
    async update(fn) { const r = await store.towerUpdate(profileId, (tower) => fn(tower)); return { result: r.result, tower: r.after }; },
  };
}

/* ---------------------------------------------------------------------------------------------- the session */

export function createTowerSession({ pack, persist, now = () => Date.now(), cfg = CONFIG }) {
  const run = (fn) => persist.update(fn).then((r) => r.result);
  const api = {
    cfg, pack, persist,
    read: () => persist.read(),
    async summary() { return summarizeTower(await persist.read(), pack, { cfg }); },
    startRun(a) { return run((tw) => reduceStart(tw, { ...a, pack, now: now(), cfg })); },
    beginFloor(a) { return run((tw) => reduceBeginFloor(tw, { ...a, pack, now: now(), cfg })); },
    markFight(a) { return run((tw) => reduceMarkFight(tw, a)); },
    finishFloor(a) { return run((tw) => reduceFinishFloor(tw, { ...a, pack, now: now(), cfg })); },
    pick(a) { return run((tw) => reducePick(tw, { ...a, now: now(), cfg })); },
    giveUp(a = {}) { return run((tw) => reduceGiveUp(tw, { ...a, now: now(), cfg })); },
  };
  return api;
}

/**
 * Begin a floor and get everything the battle needs, whoever hosts it. -> { ok:false, status, why } | { ok:true, status, run, spec, tag, markFight(), finish(result) }
 *   spec    the battle to build (towerFloorSpec); build it with createMatchController({ ...spec, validate: spec.validate }) and the scene
 *   markFight  () -> Promise: call it ONCE, at the player's first choice of the fight (ctl.onLocalChoice): from then on leaving the fight counts as a loss
 *   finish  (result) -> Promise<{ applied, next, newIds, run }>: hand it the finished match (match_stats' summary, or { result: 'f' } for a fight that was left); it is applied once
 * `status`: 'ok' | 'resume' (a reload of a fight under way) | 'abandoned' (the earlier fight was left and counted as a loss: `next` says what follows, there is no spec) | 'stale' | 'none'
 */
export async function startTowerFloor({ pack, persist, floor, runId, navType = 'navigate', now = () => Date.now(), cfg = CONFIG }) {
  const s = createTowerSession({ pack, persist, now, cfg });
  const b = await s.beginFloor({ floor, seed: runId, navType });
  if (!b || b.status === 'stale') return { ok: false, status: 'stale', why: b ? b.why : 'no answer' };
  if (b.status === 'abandoned') return { ok: false, status: 'abandoned', applied: b.applied, next: b.next || null, newIds: b.newIds || [], why: 'the earlier fight of this floor was left, which counts as a loss' };
  const tower = await s.read();
  const cur = tower.current;
  if (!cur || cur.seed !== runId || cur.phase !== 'battle' || cur.floor !== floor) return { ok: false, status: 'stale', why: 'the run moved on' };
  let spec;
  try { spec = towerFloorSpec(pack, cur, cfg); } catch (e) { return { ok: false, status: 'error', why: String(e && e.message ? e.message : e).slice(0, 120) }; }
  return { ok: true, status: b.status, run: cur, spec, tag: spec.tower.tag, markFight: () => s.markFight({ floor, seed: runId }), finish: (result) => s.finishFloor({ floor, seed: runId, result }) };
}

/* ---------------------------------------------------------------------------------------------- what the screens show */

function heldView(run, cfg) {
  const syn = synergyState(run.held);
  return run.held.map((h) => {
    const f = FAMILY_BY_ID[h.id];
    if (!f) return { id: h.id, name: h.id, rarity: 'green', color: TIERS[0].color, power: h.p, text: '' };
    const t = TIERS[tierOfPower(h.p)];
    return { id: h.id, name: f.name, rarity: t.id, tier: tierOfPower(h.p), color: t.color, ball: t.ball, power: h.p, cap: capOf(f, cfg), curse: f.curse, text: describeOps(f.ops, h.p, { cfg, pm: syn.boost[h.id] || 1000 }) };
  });
}
const achView = (tower) => ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, desc: a.desc, grade: a.grade, at: Object.prototype.hasOwnProperty.call(tower.achievements, a.id) ? tower.achievements[a.id] : null }));

/**
 * The Tower record as plain JSON for the screens (hub_data.js builds one per profile; the hub model keeps it and draws from it). Never throws: a run that cannot be read shows as `broken`.
 * { record, run: null | {...}, last, achievements: [51], earned (count), total }
 */
export function summarizeTower(tower, pack, { cfg = CONFIG } = {}) {
  const record = { best: { ...tower.best }, winsByFormat: { ...tower.winsByFormat }, runs: tower.runs, wins: tower.wins, floors: tower.floors, bosses: tower.bosses, buffsSeen: Object.keys(tower.buffsSeen).length };
  let run = null;
  const c = tower.current;
  if (c) {
    const parsed = parseRun(c, { pack: null, cfg });
    if (!parsed.ok) run = { broken: true, why: parsed.why };
    else {
      const r = parsed.run, syn = synergyState(r.held);
      let trainer = null;
      if (r.phase === 'battle' && pack) { try { const tr = floorTrainer(pack, { seed: r.seed, format: r.format, floor: r.floor }, cfg, foeMods(r.held, { cfg })); trainer = { name: tr.name, boss: tr.boss, cpu: tr.cpu.level, size: tr.recs.length }; } catch (_e) { trainer = null; } }
      run = {
        seed: r.seed, format: r.format, floor: r.floor, floors: cfg.floors, phase: r.phase, fighting: r.fighting, teamName: r.team.name, teamSize: r.team.recs.length,
        lives: livesLeft(r, cfg), livesUsed: r.livesUsed, skips: r.skips, boss: isBoss(r.floor, cfg), cleared: r.history.filter((h) => h.result === 'w').length,
        held: heldView(r, cfg), synergies: syn.active.map((s) => ({ id: s.id, name: s.name, text: s.text, kind: s.kind })), trainer,
        offer: r.phase === 'offer' ? offerView(r, { pack, cfg }) : null, earned: r.earned.slice(),
      };
    }
  }
  let last = null;
  if (tower.last) {
    const l = tower.last;
    last = { won: l.won, cleared: l.cleared, format: l.format, livesUsed: l.livesUsed, skips: l.skips, at: l.at,
      held: heldView({ held: l.held }, cfg), earned: l.earned.filter((id) => ACHIEVEMENT_BY_ID[id]).map((id) => ({ id, name: ACHIEVEMENT_BY_ID[id].name, grade: ACHIEVEMENT_BY_ID[id].grade })) };
  }
  const achievements = achView(tower);
  return { record, run, last, achievements, earned: achievements.filter((a) => a.at !== null).length, total: achievements.length };
}

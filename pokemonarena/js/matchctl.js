// pokemonarena/js/matchctl.js -- the match controller: owns ONE battle, collects each side's choice, advances the engine, hands the
// resulting events to the scene. Transport-agnostic and deterministic: no wall clock, no Math.random, no timers inside a decision.
//
//   import { createMatchController, randomTeam } from './matchctl.js';
//   const ctl = createMatchController({ pack, ruleset, teams: [recsA, recsB], seed, pick: 3, names: ['You', 'CPU'],
//                                       sides: [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 5 }] });
//   ctl.pending(0)               // the request side 0 must answer now ({ phase: 'move' | 'switch' | 'preview', ... }) or null
//   ctl.submit(0, { kind: 'move', slot: 1 })   // -> { ok, code }; the CPU side answers by itself, the engine advances when ready
//   ctl.takeEvents()             // engine events produced since the last call (what the scene plays)
//
// PREVIEWS. `pick: 3` is the 3v3 team preview: each side submits { kind: 'preview', order: [3 team slots] } and only those three fight, the first leads.
// `lead: true` is the 6v6 LEAD preview: each side submits { kind: 'preview', order: [one team slot] }, that Pokemon is sent out first and the rest of the team follows in
// team order (the request says { phase: 'preview', pick: 1, lead: true, team }). A side whose team has ONE Pokemon is not asked. FORMATS says which format uses which;
// formatOpts(fmt) is the pair to spread into the options here, so the Tower (or any caller) gets the lead preview from the same place the battle page and the online match do:
//   createMatchController({ pack, teams, seed, ...formatOpts('6v6'), sides })
// With neither option there is no preview and the first Pokemon of each team leads (the battle the Arena played before the lead preview existed).
//
// THE FREE SWITCH. `freeSwitch: true` offers a human seat that fights a CPU the Gen 3 prompt "<TRAINER> is about to send out <MON>. Will you switch your Pokemon?" (Battle Style SHIFT, the ROM's word): when the
// CPU's Pokemon has fainted and it has another, the CPU chooses its replacement first (as ever, in this controller's pump), and then ctl.pending(seat) is { phase: 'switch', reason: 'free', switches,
// next: { slot, sp, name, level } } until the seat answers ctl.submit(seat, { kind: 'switch', slot }) (it comes in now, uses no turn and takes its entry hazards and abilities; the CPU's replacement
// follows) or ctl.submit(seat, { kind: 'stay' }). Both answers are ordinary recorded choices (battle.choiceLog, onLocalChoice, the resume record). A seat the offer does not apply to (a remote seat,
// a CPU, or a human seat whose opponent is a person) never sees it, so an online battle is unchanged; without the option nothing differs from a controller that never heard of it. A page whose
// player chose Battle Style SET passes the option all the same and lets the scene answer { kind: 'stay' } for them (scene.js), so that changing the style in the middle of a battle is exact.
//
// SIDE KINDS
//   { kind: 'human' }   choices come from the local UI through ctl.submit(side, choice); each accepted one fires onLocalChoice
//   { kind: 'human', concede: true }   the same, and a FORFEIT from this seat goes through ctl.concede() so it works even while the seat is
//                       waiting for the other player with a real choice already in (networked play: pokemonarena/js/netmatch.js)
//   { kind: 'cpu', level, seed }   ai.js answers the moment a request exists (it only sees viewFor(side) and its own request)
//   { kind: 'remote' }  the slot a netplay adapter fills: ctl.submitRemote(choice) / ctl.submitWire(u16); same validation. It never fires
//                       onLocalChoice (that is the local player's choices only) and ctl.concede(side) ends the battle when that player leaves.
// The kinds go through the same ctl.submit() path, so the network adapter replaces only who calls it.

import { createBattle, encodeChoice, decodeChoice } from './engine.js';
import { createAi, createRng } from './ai.js';
import { engineSupports, engineExcludedSpecies, blankRec, legalMoves, resolveRuleset, DEFAULT_RULESET_ID } from './rules.js';
import { evsToPoints } from './stats.js';

export const FORMATS = Object.freeze({ '6v6': Object.freeze({ pick: 0, lead: true }), '3v3': Object.freeze({ pick: 3 }) });

/** The preview options of a format, to spread into createMatchController / replay: { pick, lead }. Throws RangeError for a format the Arena does not play. */
export function formatOpts(fmt) {
  if (typeof fmt !== 'string' || !Object.prototype.hasOwnProperty.call(FORMATS, fmt)) throw new RangeError('format must be 6v6 or 3v3');
  const f = FORMATS[fmt];
  return { pick: f.pick, lead: !!f.lead };
}

/** Does this controller's battle open on a preview for its human seat: the 3v3 team preview (both sides choose), or the 6v6 lead preview (a seat whose team is one Pokemon is not asked)? Read from the engine's start event. */
export function opensOnPreview(c) {
  try {
    const st = c.battle.events.find((e) => e.t === 'start'), me = c.sides.findIndex((x) => x.kind === 'human');
    return !!st && (st.lead ? me >= 0 && st.sizes[me] > 1 : !!st.pick);
  } catch (_e) { return false; }
}

/* ------------------------------------------------------------------------------------------ teams: records */

/**
 * Turn profile-style battle views (teamcode.js decodeTeamCode().team.mons, or profile box records) into the records createBattle takes,
 * plus the cosmetic data the scene needs and the engine does not carry (gender, shiny).
 */
export function teamFromMons(mons, ruleset) {
  const R = typeof ruleset === 'string' ? resolveRuleset(ruleset) : ruleset;
  const recs = [], meta = [];
  for (const m of mons) {
    const rec = {
      species: m.species, level: m.level, nature: m.nature, abilitySlot: m.abilitySlot, item: m.heldItem !== undefined ? m.heldItem : (m.item || 0),
      moves: m.moves.map((x) => (typeof x === 'number' ? { id: x, ppUps: 0 } : { id: x.id, ppUps: x.ppUps || 0 })),
      ivs: { ...(m.iv || m.ivs) }, evs: { ...(m.ev || m.evs) }, nickname: m.nickname || '',
    };
    if (R.points) { try { rec.points = evsToPoints(rec.evs, rec.ivs); } catch (_e) { /* validation reports it */ } }
    recs.push(rec);
    meta.push({ gender: m.gender === 'M' || m.gender === 'F' ? m.gender : null, shiny: !!m.shiny });
  }
  return { recs, meta };
}

// stable gender for a random Pokemon: from the species' ratio byte (0 male only, 254 female only, 255 genderless, else by a PRNG draw)
function drawGender(sp, rnd) {
  const r = sp.genderRatio;
  if (r === 255) return null;
  if (r === 0) return 'M';
  if (r === 254) return 'F';
  return rnd(256) >= r ? 'M' : 'F';
}

const PREFERRED_ITEMS = ['Leftovers', 'Sitrus Berry', 'Life Orb', 'Choice Band', 'Choice Specs', 'Choice Scarf', 'Focus Sash', 'Expert Belt', 'Lum Berry', 'Black Sludge', 'Shell Bell', 'Muscle Band', 'Wise Glasses', 'Scope Lens', 'Quick Claw'];
const UTILITY = ['Recover', 'Roost', 'Soft-Boiled', 'Slack Off', 'Thunder Wave', 'Will-O-Wisp', 'Toxic', 'Swords Dance', 'Calm Mind', 'Dragon Dance', 'Nasty Plot', 'Bulk Up', 'Protect', 'Substitute', 'Stealth Rock', 'Spikes', 'Reflect', 'Light Screen', 'Rain Dance', 'Sunny Day', 'Leech Seed', 'Sleep Powder', 'Spore', 'Agility', 'Rest', 'Hypnosis', 'Taunt'];

/**
 * `n` random LEGAL Pokemon records under `rulesetId`: species clause respected, only what the engine can run, each with two or three
 * attacking moves (STAB first) and one or two utility moves, a spread aimed at the better attacking stat. Deterministic in `seed`.
 * Returns { recs, meta }.
 */
export function randomTeam(pack, seed, n = 6, rulesetId = DEFAULT_RULESET_ID) {
  const R = resolveRuleset(rulesetId);
  const rnd = createRng(seed ^ 0x51ed270b);
  const sup = engineSupports(pack);
  const excluded = new Set(engineExcludedSpecies(pack, R).map((e) => e.id));
  const roster = pack.roster.filter((id) => !excluded.has(id) && !R.banned.species.includes(id) && pack.species[id].weight > 0 && pack.species[id].baseStats.hp > 0);
  const nameToItem = new Map(pack.items.map((it) => [it.name, it.id]));
  const prefItems = PREFERRED_ITEMS.map((nm) => nameToItem.get(nm)).filter((id) => id !== undefined && sup.items.has(id) && !R.banned.items.includes(id));
  const nameToMove = new Map(); for (const mv of pack.moves) if (mv && mv.name && !nameToMove.has(mv.name)) nameToMove.set(mv.name, mv.id);
  const utilIds = UTILITY.map((nm) => nameToMove.get(nm)).filter((id) => id !== undefined);
  const recs = [], meta = [], dex = new Set(), used = new Set();
  let guard = 0;
  while (recs.length < n && guard++ < 4000) {
    const sid = roster[rnd(roster.length)];
    const sp = pack.species[sid];
    if (dex.has(sp.natDex) || used.has(sid)) continue;
    const rec = blankRec(sid, pack, R);
    const slots = R.ability.slots.filter((s) => sp.abilities[s] && sup.abilities.has(sp.abilities[s]) && !R.banned.abilities.includes(sp.abilities[s]));
    if (!slots.length) continue;
    const pool = legalMoves(pack, sid, rec.level, R);
    const attacks = pool.filter((id) => { const mv = pack.moves[id]; return mv.category !== 2 && mv.power >= 40 && mv.pp >= 5; });
    if (attacks.length < 2) continue;
    // attacking stat leaning decides which attacks to prefer
    const phys = sp.baseStats.atk >= sp.baseStats.spa;
    const score = (id) => { const mv = pack.moves[id]; const stab = sp.types.includes(mv.type) ? 1.5 : 1; const side = (mv.category === 0) === phys ? 1 : 0.55; return mv.power * stab * side * (mv.accuracy === 0 ? 1 : mv.accuracy / 100); };
    const ranked = attacks.slice().sort((a, b) => score(b) - score(a) || a - b).slice(0, 10);
    const moves = [];
    const take = (id) => { if (!moves.includes(id)) moves.push(id); };
    const nAtk = 2 + (rnd(3) === 0 ? 1 : 0);
    const typesUsed = new Set();
    for (let guard2 = 0; moves.length < nAtk && guard2 < 40; guard2++) {
      const id = ranked[rnd(Math.min(ranked.length, 6))];
      const t = pack.moves[id].type;
      if (typesUsed.has(t) && ranked.length > 4 && guard2 < 20) continue;
      typesUsed.add(t); take(id);
    }
    const utils = utilIds.filter((id) => pool.includes(id));
    while (moves.length < 4 && utils.length) take(utils.splice(rnd(utils.length), 1)[0]);
    while (moves.length < 4 && moves.length < ranked.length) take(ranked[rnd(ranked.length)]);
    rec.moves = moves.slice(0, 4).map((id) => ({ id, ppUps: 0 }));
    rec.abilitySlot = slots[rnd(slots.length)];
    rec.item = prefItems.length ? prefItems[rnd(prefItems.length)] : 0;
    // nature: boost the stat the attacks use, lower the other attacking stat
    const up = phys ? 'atk' : 'spa', down = phys ? 'spa' : 'atk';
    const nat = pack.natures.find((x) => x.up === up && x.down === down);
    rec.nature = nat ? nat.id : 0;
    const off = phys ? 'atk' : 'spa';
    const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    evs[off] = 252; evs[rnd(2) === 0 ? 'spe' : 'hp'] = 252; evs.spd = 6;       // 510 in total, none over 255
    rec.evs = evs; rec.ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
    if (R.points) rec.points = evsToPoints(rec.evs, rec.ivs);
    rec.nickname = '';
    dex.add(sp.natDex); used.add(sid);
    recs.push(rec);
    meta.push({ gender: drawGender(sp, rnd), shiny: rnd(64) === 0 });
  }
  if (recs.length < n) throw new RangeError('could not build a random team of ' + n);
  return { recs, meta };
}

/* ---------------------------------------------------------------------------------------------- controller */

const NEEDS = new Set(['preview', 'move', 'switch']);

export function createMatchController(opts) {
  const { pack } = opts;
  const ruleset = opts.ruleset || DEFAULT_RULESET_ID;
  const sidesSpec = opts.sides || [{ kind: 'human' }, { kind: 'cpu', level: 'normal', seed: 1 }];
  const names = opts.names || ['You', 'CPU'];
  // freeSwitch: true offers "Will you switch your Pokemon?" (the Gen 3 trainer-battle prompt) to a HUMAN seat whose opponent is a CPU, and to no other seat: a battle against a person (a remote seat) has none, as in the real game.
  if (opts.freeSwitch !== undefined && opts.freeSwitch !== null && typeof opts.freeSwitch !== 'boolean') throw new RangeError('freeSwitch must be true or false');
  const freeSwitch = opts.freeSwitch === true ? [0, 1].map((side) => sidesSpec[side].kind === 'human' && sidesSpec[side ^ 1].kind === 'cpu') : undefined;
  const battle = createBattle({ pack, ruleset, teams: opts.teams, seed: opts.seed, pick: opts.pick || 0, lead: opts.lead, freeSwitch, names, validate: opts.validate !== false });
  const ais = sidesSpec.map((s) => (s.kind === 'cpu' ? createAi({ pack, level: s.level || 'normal', seed: s.seed === undefined ? 1 : s.seed }) : null));
  // the public team-preview information each side sees of the other: species and (normalised) level, nothing else
  const previewInfo = [0, 1].map((side) => battle.s.sides[side].team.map((m) => ({ sp: m.sp, level: m.level })));
  const subs = { events: new Set(), local: new Set(), end: new Set() };
  let queue = [];
  let ended = false;

  const pending = (side) => { const r = battle.requests()[side]; return r && NEEDS.has(r.phase) ? r : null; };

  function emitEvents(ev) {
    if (!ev.length) return;
    queue.push(...ev);
    for (const cb of Array.from(subs.events)) { try { cb(ev); } catch (e) { if (typeof console !== 'undefined') console.error('[matchctl] events listener failed', e); } }
  }

  // every CPU side with an open request answers; then the engine advances while it can; repeat until a human / remote choice is needed
  function pump() {
    for (let guard = 0; guard < 5000; guard++) {
      let acted = false;
      for (let s = 0; s < 2; s++) {
        if (!ais[s]) continue;
        const req = pending(s);
        if (!req) continue;
        const c = ais[s].choose(req, battle.viewFor(s), { previewInfo: { foe: previewInfo[s ^ 1] } });
        if (c) { const r = battle.choose(s, c); if (!r.ok) throw new Error('matchctl: the CPU on side ' + s + ' made an illegal choice (' + r.code + '): ' + JSON.stringify(c)); acted = true; }
      }
      if (battle.winner === null && battle.ready()) { emitEvents(battle.advance()); acted = true; }
      else if (battle.winner !== null && !ended) { emitEvents(battle.drain()); }
      if (!acted) break;
    }
    if (battle.winner !== null && !ended) { ended = true; for (const cb of Array.from(subs.end)) { try { cb(battle.winner); } catch (_e) { /* listener errors never stop the match */ } } }
  }

  // onLocalChoice is for the LOCAL player's choices only ({ kind: 'human' }): a CPU answers by itself and a remote side's choice arrives from the network,
  // where an adapter that listened for "every non-CPU choice" would send the opponent's own choice straight back to them.
  const announce = (side, choice) => { if (sidesSpec[side].kind === 'human') for (const cb of Array.from(subs.local)) { try { cb({ side, choice, wire: encodeChoice(choice) }); } catch (_e) { /* ignore */ } } };

  function submit(side, choice) {
    if (side !== 0 && side !== 1) return { ok: false, code: 'bad-side' };
    // A networked human may leave at any time, even while waiting for the other player with a real choice already in; that is concede(), not a choice.
    if (choice && choice.kind === 'forfeit' && sidesSpec[side].concede) return concede(side);
    const r = battle.choose(side, choice);
    if (!r.ok) return r;
    announce(side, choice);
    pump();
    return r;
  }
  // A side leaves the battle (forfeit, time ran out, connection lost): the engine ends it with the other side the winner. See Battle.concede.
  function concede(side) {
    if (side !== 0 && side !== 1) return { ok: false, code: 'bad-side' };
    const r = battle.concede(side);
    if (!r.ok) return r;
    announce(side, { kind: 'forfeit' });
    pump();
    return r;
  }
  const remoteSide = () => sidesSpec.findIndex((s) => s.kind === 'remote');

  const ctl = {
    battle, pack, ruleset, names, sides: sidesSpec, previewInfo,
    // introduction: the engine's opening events (start, switch-in...) are delivered like any other
    start() { emitEvents(battle.drain()); pump(); return ctl; },
    pending,
    // Does this side have to choose in the phase the engine is in? Unlike pending(), it stays true after the side has chosen (until the phase resolves), and it is false
    // for a side locked into a charge / recharge turn. A networked match numbers its rounds from this, so a match rebuilt after a reload (where the answer was already given)
    // sees the same round shape as the one that was never interrupted.
    needs: (side) => !!battle.s.need[side],
    origOf: (side) => battle.s.sides[side].team.map((x) => x.orig),
    requests: () => battle.requests(),
    view: (side) => battle.viewFor(side),
    submit, concede,
    submitRemote(choice) { const s = remoteSide(); if (s < 0) return { ok: false, code: 'no-remote' }; return submit(s, choice); },
    submitWire(u16) { const c = decodeChoice(u16); return c ? ctl.submitRemote(c) : { ok: false, code: 'bad-wire' }; },
    takeEvents() { const q = queue; queue = []; return q; },
    onEvents(cb) { subs.events.add(cb); return () => subs.events.delete(cb); },
    onLocalChoice(cb) { subs.local.add(cb); return () => subs.local.delete(cb); },
    onEnd(cb) { subs.end.add(cb); return () => subs.end.delete(cb); },
    get winner() { return battle.winner; },
    get turn() { return battle.turn; },
    info() { return { turn: battle.turn, winner: battle.winner, hash: battle.hash(), logHash: battle.logHash(), ruleset, choiceLog: battle.choiceLog.map((e) => ({ s: e.s, c: e.c })), events: battle.events.length }; },
  };
  return ctl;
}

// pokemonarena/js/match_stats.js -- the MATCH STATISTICS COLLECTOR: folds the battle engine's event log into one deterministic summary of the match.
//
// Pure ES module (browser + Node 24): no DOM, no clock, no storage, no randomness, no pack. The input is the event list the engine already
// produces (ENGINE.md section 1, `battle.events`, the same events scene.js plays), so the summary is a pure function of the log: the same
// log gives the same summary, byte for byte (JSON), whether the log was played live or rebuilt by replaying the saved choices after a reload.
// Nothing here is ROM content: species / move ids are numbers; names are resolved by the caller from the pack.
//
//   import { summarizeMatch } from './match_stats.js';
//   const s = summarizeMatch(battle.events, { viewSide: 0, teams });      // teams (optional) = [[{slot, sp, name, level, mhp, hp}], [...]] so Pokemon never sent out appear too
//
// WHAT IS COUNTED (every number is an integer; "pct" is rounded half up from integers, never from floats):
//   damage dealt / taken   HP removed by `damage` events. DEALT is credited to a Pokemon only for an ATTACK: a `damage` event with src 'move' or
//                          'bide' hits the side that did not use the move, and the attacker is the Pokemon that side had on the field at that
//                          moment (the event carries the TARGET only; the attacker is the other side's active Pokemon, which is exact because
//                          a damaging move is resolved before any switch). TAKEN is everything: attacks and the rest.
//   the rest               every other damage source is one of three classes (CLASS_OF_SRC): 'foe' = caused by the opposing side without a
//                          Pokemon to blame (entry hazards, Leech Seed, a binding move, Rocky Helmet, Rough Skin, Future Sight ...), 'self' =
//                          caused by the Pokemon's own move, item or ability (recoil, Life Orb, a confusion hit, Belly Drum, Explosion ...), 'env'
//                          = status damage and weather. An src the table does not know is 'env' (the test reports every unknown src it meets).
//   HP identity            for each side: taken = hit by attacks + 'foe' + 'self' + 'env'; and the attacks the other side dealt add up to exactly
//                          what this side took from attacks. Sum over Pokemon of (start HP + healed - taken) = HP at the end (revives start at 0).
//   KOs                    a `faint` always follows the lethal `damage` event of the same Pokemon. ATTACK -> the attacker scores the KO (mon.kos);
//                          'foe' -> the opposing side scores it without a Pokemon (side.indirectKos); 'self' and 'env' faints are nobody's KO.
//                          Identity: faints(side) = kos(other side) + selfFaints(side) + envFaints(side), with kos = attack KOs + indirect KOs.
//   hits / crits / effectiveness   per attacking Pokemon, from the `damage` events of attacks (crit flag, eff: > 4096 super effective,
//                          < 4096 and > 0 not very effective); a hit that only broke a substitute counts as a hit with no HP dealt.
//   misses / no effect / blocked   `miss` and `avoid` (the move missed), `immune` with a move (it had no effect), `protected` (it was blocked).
//   status                 `status-set` against the other side counts as INFLICTED by that side's Pokemon on the field (not for Rest or a Flame /
//                          Toxic Orb, which hit the holder itself); every `status-set` counts as SUFFERED by its target.
//   healing                HP gained by `heal` events (items, abilities, drain moves, Rest, a revive ...), credited to the Pokemon healed.
//   turns on the field     the Pokemon on the field when a `turn` event begins is credited one turn.
//   weather / terrain      `weather-tick` events per weather id; `turn` events while a terrain field is on, per terrain.
// WHAT IS DEFINED HERE (and printed on the recap):
//   MVP                    per side, the Pokemon with the highest score = 100 per KO scored + damage dealt as a percent of the victims' max HP
//                          (so one KO of a full-health Pokemon is worth about 200). Ties: fewer faints, then the lower team slot. No score, no MVP.
//   biggest hit            the largest single attack in HP; ties go to the earlier one. pct = HP lost as a percent of the target's max HP.
//   closest call           among Pokemon that never fainted and took damage, the lowest HP they reached (by fraction of max HP, exact).
//   first blood            the first faint of the match, with the Pokemon that scored it when it was an attack.
//   last hit               the attack that caused the faint that ended the match (null for a forfeit, a draw or a faint nobody scored).
//   KO streak              the most faints in a row on one side of the battle with none on the other (a faint on the other side ends it).
//   flags                  noFaintWin (won and lost no Pokemon), sweep (won, and ONE Pokemon scored every attack KO, at least two),
//                          comeback (won after being two or more Pokemon down at any moment), deficit = the worst count.
//   result                 w / l / d / f from the view side's point of view: f = the view side forfeited and lost, d = a draw (turn cap, or both
//                          sides out at once), w / l by the `win` event.

export const SUMMARY_VERSION = 1;

/** Damage source -> who is to blame. 'attack' sources have an attacker; the others do not (see the header). */
export const CLASS_OF_SRC = Object.freeze({
  move: 'attack', bide: 'attack',
  'future-sight': 'foe', 'leech-seed': 'foe', trap: 'foe', 'stealth-rock': 'foe', spikes: 'foe', 'rocky-helmet': 'foe', 'rough-skin': 'foe',
  'spiky-shield': 'foe', 'salt-cure': 'foe', aftermath: 'foe', 'innards-out': 'foe', jaboca: 'foe', rowap: 'foe', 'destiny-bond': 'foe',
  'bad-dreams': 'foe', nightmare: 'foe', powder: 'foe', 'liquid-ooze': 'foe', 'force-return': 'foe',
  recoil: 'self', crash: 'self', 'life-orb': 'self', confusion: 'self', 'belly-drum': 'self', 'mind-blown': 'self', explosion: 'self', memento: 'self',
  'final-gambit': 'self', 'healing-wish': 'self', curse: 'self', 'fillet-away': 'self', 'clangorous-soul': 'self', substitute: 'self', 'shed-tail': 'self',
  'last-stand': 'self', disguise: 'self', 'sticky-barb': 'self', 'black-sludge': 'self', 'solar-power': 'self', 'dry-skin': 'self', 'pain-split': 'self',
  psn: 'env', tox: 'env', brn: 'env', fbt: 'env', sandstorm: 'env', hail: 'env', perish: 'env',
});
const SELF_STATUS_FX = new Set(['rest', 'flame-orb', 'toxic-orb']);

const pct = (a, b) => (b > 0 ? Math.floor((200 * a + b) / (2 * b)) : 0);       // round half up, integers only
const pm = (a, b) => (b > 0 ? Math.floor((1000 * a) / b) : 0);                 // per mille, floored (summed, then rounded once)
const sortedPairs = (o) => Object.keys(o).map((k) => [Number(k), o[k]]).sort((x, y) => (y[1] - x[1]) || (x[0] - y[0]));
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

function newMon(side, slot, sp, name, level, max, hp) {
  return {
    side, slot, sp: sp | 0, name: name || '', level: level | 0, max: max | 0, startHp: hp === undefined ? max | 0 : hp | 0,
    hp: hp === undefined ? max | 0 : hp | 0, seen: false,
    dealt: 0, dealtPm: 0, taken: 0, takenAtk: 0, takenFoe: 0, takenSelf: 0, takenEnv: 0, healed: 0,
    kos: 0, faints: 0, faintTurn: 0, hits: 0, subHits: 0, crits: 0, superEffective: 0, resisted: 0, noEffect: 0, misses: 0, blocked: 0,
    statusInflicted: 0, statusSuffered: 0, switchIns: 0, switchOuts: 0, turns: 0, moveUses: {}, lowHp: -1, lowMax: 1,
  };
}

/**
 * Fold an event log into the match summary. opts: { viewSide (0), teams }. Never throws on a well-formed log; unknown event kinds are ignored.
 * The result is plain JSON (arrays, objects, integers, strings, booleans, null).
 */
export function summarizeMatch(events, opts = {}) {
  const viewSide = opts.viewSide === 1 ? 1 : 0;
  const mons = [new Map(), new Map()];                                    // per side: slot -> mon
  const active = [-1, -1];
  const side = [0, 1].map(() => ({
    dealtIndirect: 0, selfFaints: 0, envFaints: 0, indirectKos: 0, switches: 0, statuses: {}, streak: 0, bestStreak: 0, dead: 0, worstAlive: 0, moves: {},
  }));
  const sizeOf = [0, 0];
  const names = ['', ''];
  const weather = {}, terrain = {};
  let terrainOn = '', turn = 0, endTurn = 0, winner = null, forfeited = [false, false], endedBy = 'none', capSeen = false;
  let firstBlood = null, biggest = null, lastDamage = null, lastKo = null, lastFaintSide = -1, lastFaintCause = null;
  const sideBig = [null, null];

  const put = (s, slot, init) => { let m = mons[s].get(slot); if (!m) { m = init(); mons[s].set(slot, m); } return m; };
  const mon = (s, slot) => put(s, slot, () => newMon(s, slot, 0, '', 0, 0));

  if (Array.isArray(opts.teams)) {
    for (let s = 0; s < 2; s++) {
      for (const t of opts.teams[s] || []) {
        const max = t.mhp !== undefined ? t.mhp : t.max;
        mons[s].set(t.slot, newMon(s, t.slot, t.sp, t.name, t.level, max, max));       // the battle starts at full health; the team passed in may be a snapshot of the END of the match
      }
      sizeOf[s] = (opts.teams[s] || []).length;
    }
  }
  const aliveOf = (s) => Math.max(0, sizeOf[s] - side[s].dead);

  for (const e of events || []) {
    if (!e || typeof e !== 'object') continue;
    try { switch (e.t) {
      case 'start': names[0] = String(e.names && e.names[0] || ''); names[1] = String(e.names && e.names[1] || ''); if (!sizeOf[0] && Array.isArray(e.sizes)) { sizeOf[0] = e.sizes[0] | 0; sizeOf[1] = e.sizes[1] | 0; } break;
      case 'preview': if (!opts.teams && Array.isArray(e.order)) sizeOf[e.s] = e.order.length; break;
      case 'turn': {
        turn = e.n | 0; endTurn = Math.max(endTurn, turn);
        for (let s = 0; s < 2; s++) { const a = mons[s].get(active[s]); if (a && a.hp > 0) a.turns++; }
        if (terrainOn) bump(terrain, terrainOn);
        break;
      }
      case 'switch-in': {
        const m = put(e.s, e.m, () => newMon(e.s, e.m, e.sp, e.name, e.lv, e.max, e.hp));
        if (!m.seen) { m.seen = true; m.sp = e.sp | 0; m.name = e.name || m.name; m.level = e.lv | 0; m.startHp = e.hp | 0; }
        if (e.max > 0) { m.max = e.max | 0; m.hp = e.hp | 0; }
        m.switchIns++;
        active[e.s] = e.m;
        break;
      }
      case 'switch-out': { mon(e.s, e.m).switchOuts++; side[e.s].switches++; break; }
      case 'move-use': { const m = mon(e.s, e.m); bump(m.moveUses, e.mv); bump(side[e.s].moves, e.mv); break; }
      case 'miss': mon(e.s, e.m).misses++; break;
      case 'avoid': { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) a.misses++; break; }
      case 'protected': { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) a.blocked++; break; }
      case 'immune': { if (e.mv) { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) a.noEffect++; } break; }
      case 'sub-damage': { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) a.subHits++; break; }
      case 'status-set': {
        const t = mon(e.s, e.m);
        t.statusSuffered++;
        if (!SELF_STATUS_FX.has(e.fx)) { const a = mons[e.s ^ 1].get(active[e.s ^ 1]); if (a) { a.statusInflicted++; bump(side[e.s ^ 1].statuses, e.st); } }
        break;
      }
      case 'damage': {
        const t = mon(e.s, e.m);
        const lost = Math.max(0, (e.from | 0) - (e.to | 0));
        const cls = CLASS_OF_SRC[e.src] || 'env';
        if (t.max === 0 && e.max > 0) { t.max = e.max | 0; t.startHp = Math.max(t.startHp, e.from | 0); }
        t.hp = e.to | 0;
        t.taken += lost;
        if (cls === 'attack') t.takenAtk += lost; else if (cls === 'foe') t.takenFoe += lost; else if (cls === 'self') t.takenSelf += lost; else t.takenEnv += lost;
        if (t.hp > 0) { const lo = t.lowHp < 0 || t.hp * t.lowMax < t.lowHp * t.max; if (lo) { t.lowHp = t.hp; t.lowMax = t.max; } }
        let attacker = null;
        if (cls === 'attack') {
          attacker = mons[e.s ^ 1].get(active[e.s ^ 1]) || null;
          if (attacker) {
            attacker.hits++;
            attacker.dealt += lost; attacker.dealtPm += pm(lost, t.max);
            if (e.crit) attacker.crits++;
            if (e.eff > 4096) attacker.superEffective++; else if (e.eff > 0 && e.eff < 4096) attacker.resisted++;
            const hit = { side: attacker.side, slot: attacker.slot, sp: attacker.sp, mv: e.mv | 0, dmg: lost, pct: pct(lost, t.max), crit: e.crit ? 1 : 0, eff: e.eff === undefined ? 4096 : e.eff, vs: { side: t.side, slot: t.slot, sp: t.sp }, turn };
            if (lost > 0 && (!biggest || lost > biggest.dmg)) biggest = hit;
            if (lost > 0 && (!sideBig[attacker.side] || lost > sideBig[attacker.side].dmg)) sideBig[attacker.side] = hit;
          }
        } else if (cls === 'foe') side[e.s ^ 1].dealtIndirect += lost;
        lastDamage = { side: e.s, slot: e.m, cls, attacker: attacker ? { side: attacker.side, slot: attacker.slot, sp: attacker.sp, mv: e.mv | 0 } : null };
        break;
      }
      case 'heal': {
        const t = mon(e.s, e.m);
        const gain = Math.max(0, (e.to | 0) - (e.from | 0));
        if ((e.from | 0) === 0 && gain > 0) side[e.s].dead = Math.max(0, side[e.s].dead - 1);        // a revive
        t.healed += gain; t.hp = e.to | 0;
        if (t.max === 0 && e.max > 0) t.max = e.max | 0;
        break;
      }
      case 'faint': {
        const t = mon(e.s, e.m);
        t.faints++; t.faintTurn = turn; t.hp = 0; side[e.s].dead++;
        const ld = lastDamage && lastDamage.side === e.s && lastDamage.slot === e.m ? lastDamage : { cls: 'env', attacker: null };
        let by = null;
        if (ld.cls === 'attack' && ld.attacker) { const a = mons[ld.attacker.side].get(ld.attacker.slot); if (a) { a.kos++; by = ld.attacker; } }
        else if (ld.cls === 'foe') side[e.s ^ 1].indirectKos++;
        else if (ld.cls === 'self') side[e.s].selfFaints++;
        else side[e.s].envFaints++;
        const f = { victim: { side: e.s, slot: e.m, sp: t.sp }, by, cls: ld.cls, turn };
        if (!firstBlood) firstBlood = f;
        lastKo = f;
        // streaks: consecutive faints on one side with none on the other
        side[e.s ^ 1].streak = lastFaintSide === e.s ? side[e.s ^ 1].streak + 1 : 1;
        lastFaintSide = e.s;
        if (side[e.s ^ 1].streak > side[e.s ^ 1].bestStreak) side[e.s ^ 1].bestStreak = side[e.s ^ 1].streak;
        // alive deficit, for the comeback flag (measured right after every faint)
        const a0 = aliveOf(0), a1 = aliveOf(1);
        side[0].worstAlive = Math.max(side[0].worstAlive, a1 - a0);       // how far side 0 was behind (in Pokemon)
        side[1].worstAlive = Math.max(side[1].worstAlive, a0 - a1);
        lastFaintCause = f;
        break;
      }
      case 'weather-tick': bump(weather, e.w | 0); break;
      case 'field': { if (typeof e.k === 'string' && /-terrain$/.test(e.k)) terrainOn = e.on ? e.k.replace(/-terrain$/, '') : (terrainOn === e.k.replace(/-terrain$/, '') ? '' : terrainOn); break; }
      case 'forfeit': forfeited[e.s] = true; break;
      case 'turn-cap': capSeen = true; endTurn = Math.max(endTurn, e.n | 0); break;
      case 'win': winner = e.s; break;
      case 'draw': winner = -1; break;
      default: break;
    } } catch (_e) { /* a malformed event (a side or slot that is not there) is skipped; the engine never writes one */ }
  }
  if (winner !== null) endedBy = winner === -1 ? (capSeen ? 'turn-cap' : 'draw') : (forfeited[winner ^ 1] ? 'forfeit' : 'ko');

  const result = winner === null ? 'none' : winner === -1 ? 'd' : winner === viewSide ? 'w' : forfeited[viewSide] ? 'f' : 'l';

  // ---- per side
  const outSides = [0, 1].map((s) => {
    const list = Array.from(mons[s].values()).sort((a, b) => a.slot - b.slot);
    const monsOut = list.map((m) => {
      const endHp = m.hp;
      return {
        slot: m.slot, sp: m.sp, name: m.name, level: m.level, max: m.max, played: m.seen ? 1 : 0,
        dealt: m.dealt, dealtPct: Math.floor((m.dealtPm + 5) / 10), taken: m.taken, takenPct: pct(m.taken, m.max),
        takenByAttacks: m.takenAtk, takenOther: m.takenFoe + m.takenSelf + m.takenEnv, healed: m.healed,
        kos: m.kos, faints: m.faints, hits: m.hits, subHits: m.subHits, crits: m.crits, superEffective: m.superEffective, resisted: m.resisted, noEffect: m.noEffect,
        misses: m.misses, blocked: m.blocked, statusInflicted: m.statusInflicted, statusSuffered: m.statusSuffered,
        switchIns: m.switchIns, switchOuts: m.switchOuts, turns: m.turns, moves: sortedPairs(m.moveUses),
        startHp: m.startHp, endHp, endPct: pct(endHp, m.max),
        low: m.lowHp >= 0 && m.faints === 0 ? { hp: m.lowHp, max: m.lowMax, pct: Math.max(m.lowHp > 0 ? 1 : 0, pct(m.lowHp, m.lowMax)) } : null,
        score: 1000 * m.kos + m.dealtPm,
      };
    });
    const sum = (k) => monsOut.reduce((n, m) => n + m[k], 0);
    const kosAttack = sum('kos');
    let mvp = null;
    for (const m of monsOut) {
      if (m.score <= 0) continue;
      if (!mvp || m.score > mvp.score || (m.score === mvp.score && (m.faints < mvp.faints || (m.faints === mvp.faints && m.slot < mvp.slot)))) mvp = m;
    }
    let closest = null;
    for (const m of monsOut) if (m.low && m.low.hp < m.max && (!closest || m.low.hp * closest.low.max < closest.low.hp * m.low.max)) closest = m;
    const hpNow = monsOut.reduce((n, m) => n + m.endHp, 0), hpMax = monsOut.reduce((n, m) => n + m.max, 0);
    return {
      name: names[s], size: Math.max(sizeOf[s], monsOut.length),
      mons: monsOut,
      dealt: sum('dealt'), dealtPct: sum('dealtPct'), taken: sum('taken'), takenByAttacks: sum('takenByAttacks'), takenOther: sum('takenOther'),
      dealtIndirect: side[s].dealtIndirect, healed: sum('healed'), kos: kosAttack + side[s].indirectKos, attackKos: kosAttack, indirectKos: side[s].indirectKos,
      faints: sum('faints'), selfFaints: side[s].selfFaints, envFaints: side[s].envFaints, hits: sum('hits'), subHits: sum('subHits'), crits: sum('crits'),
      superEffective: sum('superEffective'), resisted: sum('resisted'), noEffect: sum('noEffect'), misses: sum('misses'), blocked: sum('blocked'),
      statusInflicted: sum('statusInflicted'), statusSuffered: sum('statusSuffered'), statuses: sortedPairs(side[s].statuses),
      switches: side[s].switches, moves: sortedPairs(side[s].moves), koStreak: side[s].bestStreak, deficit: side[s].worstAlive,
      hpLeft: hpNow, hpMax, hpLeftPct: pct(hpNow, hpMax), alive: aliveOf(s),
      mvp: mvp ? { slot: mvp.slot, sp: mvp.sp, name: mvp.name, score: mvp.score, scorePts: Math.floor((mvp.score + 5) / 10), kos: mvp.kos, dealt: mvp.dealt, dealtPct: mvp.dealtPct } : null,
      closestCall: closest ? { slot: closest.slot, sp: closest.sp, name: closest.name, hp: closest.low.hp, max: closest.low.max, pct: closest.low.pct } : null,
      biggestHit: sideBig[s],
    };
  });

  const w = winner;
  const me = outSides[viewSide], foe = outSides[viewSide ^ 1];
  const attackers = (os) => os.mons.filter((m) => m.kos > 0);
  const flags = {
    noFaintWin: result === 'w' && me.faints === 0,
    sweep: result === 'w' && me.attackKos >= 2 && attackers(me).length === 1 && me.indirectKos === 0 && foe.selfFaints === 0 && foe.envFaints === 0,
    comeback: result === 'w' && me.deficit >= 2,
    forfeit: result === 'f',
  };
  const wsum = Object.values(weather).reduce((n, v) => n + v, 0), tsum = Object.values(terrain).reduce((n, v) => n + v, 0);
  const lastHit = result === 'w' || result === 'l' ? (lastKo && lastKo.by ? { side: lastKo.by.side, slot: lastKo.by.slot, sp: lastKo.by.sp, mv: lastKo.by.mv, victim: lastKo.victim } : null) : null;
  return {
    v: SUMMARY_VERSION, viewSide, result, winner: w === null ? null : w, endedBy, turns: Math.max(turn, endTurn),
    names: [names[0], names[1]], sides: outSides,
    firstBlood: firstBlood ? { victim: firstBlood.victim, by: firstBlood.by ? { side: firstBlood.by.side, slot: firstBlood.by.slot, sp: firstBlood.by.sp, mv: firstBlood.by.mv } : null, cause: firstBlood.cls, turn: firstBlood.turn } : null,
    lastHit, biggestHit: biggest, mvp: me.mvp ? { side: viewSide, ...me.mvp } : null,
    closestCall: me.closestCall ? { side: viewSide, ...me.closestCall } : null,
    koStreak: { side: me.koStreak >= foe.koStreak ? viewSide : viewSide ^ 1, n: Math.max(me.koStreak, foe.koStreak) },
    weatherTurns: wsum, weather: sortedPairs(weather), terrainTurns: tsum, terrain: Object.keys(terrain).sort().map((k) => [k, terrain[k]]),
    flags,
  };
}

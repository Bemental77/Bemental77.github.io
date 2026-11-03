// pokemonarena/js/engine_digest.js -- a fixed set of seeded battles between random LEGAL teams, reduced to hashes.
//
// Used three ways by tools/pokemonarena_engine_test.mjs: (1) golden replays (the per-battle hashes are pinned in
// pokemonarena/engine.golden.json -- hashes only), (2) the fuzz / invariant loop, (3) Node-vs-browser parity (the same
// digest must come out of headless Chrome).  Pure ES module: integer-only local PRNG (xorshift32), no Math.random, no Date.

import { createBattle, hash64 } from './engine.js';
import { blankRec, legalMoves, engineSupports, engineExcludedSpecies } from './rules.js';

const RS = 'arena-gen3-standard';

/** xorshift32 -> function(n) returning an integer in [0, n). */
export function makePrng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return (n) => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s % n;
  };
}

/** A random LEGAL team of `n` Pokemon (species clause respected, supported ability/moves/items only). */
export function randomTeam(pack, rnd, n, ruleset) {
  const rs = ruleset || RS;
  const sup = engineSupports(pack);
  const excluded = new Set(engineExcludedSpecies(pack, rs).map((e) => e.id));
  const roster = pack.roster.filter((id) => !excluded.has(id));
  const team = [];
  const dex = new Set();
  const heldItems = sup.itemList.filter((i) => pack.items[i].holdEffect !== 0);
  let guard = 0;
  while (team.length < n && guard++ < 1000) {
    const sid = roster[rnd(roster.length)];
    const sp = pack.species[sid];
    if (dex.has(sp.natDex)) continue;
    dex.add(sp.natDex);
    const rec = blankRec(sid, pack, rs);
    const slots = [0, 1, 2].filter((s) => sp.abilities[s] && sup.abilities.has(sp.abilities[s]));
    rec.abilitySlot = slots[rnd(slots.length)];
    const pool = legalMoves(pack, sid, 100, rs);
    rec.moves = [];
    const k = 1 + rnd(4);
    for (let i = 0; i < k && pool.length; i++) rec.moves.push(pool.splice(rnd(pool.length), 1)[0]);
    rec.nature = rnd(25);
    let left = 510;
    for (const key of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) { const v = Math.min(255, rnd(256), left); rec.evs[key] = v; left -= v; }
    rec.ivs = { hp: rnd(32), atk: rnd(32), def: rnd(32), spa: rnd(32), spd: rnd(32), spe: rnd(32) };
    rec.item = rnd(3) === 0 ? 0 : heldItems[rnd(heldItems.length)];
    team.push(rec);
  }
  return team;
}

/** Drive a battle to its end with pseudo-random legal choices. Returns the battle. */
export function playRandom(battle, rnd, opts) {
  const o = opts || {};
  let guard = 0;
  const hook = o.onTurn;
  while (battle.winner === null && guard++ < 5000) {
    const reqs = battle.requests();
    for (let s = 0; s < 2; s++) {
      const r = reqs[s];
      if (r.phase === 'preview') {
        const idx = r.team.map((m) => m.slot);
        const order = [];
        while (order.length < r.pick) order.push(idx.splice(rnd(idx.length), 1)[0]);
        battle.choose(s, { kind: 'preview', order });
      } else if (r.phase === 'move') {
        if (r.switches.length && rnd(100) < 12) battle.choose(s, { kind: 'switch', slot: r.switches[rnd(r.switches.length)].slot });
        else {
          const ok = r.moves.filter((m) => !m.disabled);
          battle.choose(s, { kind: 'move', slot: ok[rnd(ok.length)].slot });
        }
      } else if (r.phase === 'switch') battle.choose(s, { kind: 'switch', slot: r.switches[rnd(r.switches.length)].slot });
    }
    if (!battle.ready()) throw new Error('engine not ready after every side chose');
    battle.advance();
    if (hook) hook(battle);
  }
  return battle;
}

/** `count` battles from seeds seed0..seed0+count-1; returns { rows, digest } where rows are small plain objects. */
export function digestBattles(pack, count, seed0) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const rnd = makePrng(0x1234567 + (seed0 + i) * 7919);
    const na = 1 + rnd(6), nb = 1 + rnd(6);
    const A = randomTeam(pack, rnd, na), B = randomTeam(pack, rnd, nb);
    const pick = (na >= 3 && nb >= 3 && rnd(4) === 0) ? 3 : 0;
    const b = createBattle({ pack, ruleset: RS, teams: [A, B], seed: rnd(0x7fffffff), pick, validate: false });
    playRandom(b, rnd);
    rows.push({ i: seed0 + i, hash: b.hash(), logHash: b.logHash(), turns: b.turn, winner: b.winner, events: b.events.length });
  }
  return { rows, digest: hash64(JSON.stringify(rows)) };
}

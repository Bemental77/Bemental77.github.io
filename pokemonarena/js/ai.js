// pokemonarena/js/ai.js -- the CPU opponent (easy / normal / hard).
//
// Pure ES module (browser + Node): no DOM, no node: imports, no Math.random / Date. Deterministic: every decision is a function of
// (request, view, level, the AI's OWN seeded PRNG state, the static pack); the AI never touches the battle's RNG.
//
//   import { createAi } from './ai.js';
//   const ai = createAi({ pack, level: 'normal', seed: 7 });
//   const choice = ai.choose(battle.requests()[side], battle.viewFor(side), { previewInfo });   // -> a choice object for battle.choose
//
// FAIRNESS. ai.choose() receives ONLY (a) the side's own request (what it may choose), (b) battle.viewFor(side) (its own team in
// full, the foe's active Pokemon with HP as a percentage and only the REVEALED moves / ability / item, unseen bench members
// hidden) and (c) at team preview the public species list of both teams. It never receives the battle object, so it cannot read the
// foe's real stats, moves, EVs, IVs, item or ability. The foe's stats are ESTIMATED from the species' base stats at the foe's level
// (IV 31, EV 0, neutral nature), the standard guess a player makes. tools/pokemonarena_scene_test.mjs proves the property: two
// battles that differ only in the foe's hidden data give the AI identical views and identical choices, and every property the AI
// reads from view/request is recorded and checked against an allow-list.
//
// LEVELS (the ladder is MEASURED, see tools/pokemonarena_scene_test.mjs 'ai: strength' )
//   easy    a random legal move (a random legal switch only when forced); never a forfeit.
//   normal  expected damage (type chart, STAB, weather, stat stages, accuracy, KO bonus) with a few status / setup / recovery /
//           hazard heuristics; switches out of a clearly lost matchup and never switches into a known immunity. It is a fallible
//           player on purpose: SLIP_PERCENT of its turns it plays any legal move instead of its best one.
//   hard    the same damage model WITHOUT the deliberate blunders: it always plays its best attack (KOs and priority-KOs first, accuracy
//           weighed in), uses a status / setup / recovery / hazard move only when that move is worth more than the best attack and the
//           foe cannot punish the turn, and leaves the field voluntarily only when it cannot hurt the foe at all. Forced replacements
//           (after a faint) use the same matchup scorer as normal. Measured facts behind this design (matched, side-swapped games on random
//           legal teams, see the report): a voluntary-switch rule built on a duel model (KO turns + speed), a duel-model replacement
//           scorer, a duel-model team-preview scorer and the old one-turn expectimax each scored no better than plain best-attack play, so
//           none of them is shipped; a CHEATING best-attack player that read the foe's real damage from previewDamage gained 1.5 points over the
//           fair one (58.6% vs 57.1% against the old normal, 800 games each: inside the +-3 noise), so damage-estimate accuracy is not the limit.
//           What separates hard from normal is therefore consistency, plus the status / stuck-mon rules.

export const AI_LEVELS = Object.freeze(['easy', 'normal', 'hard']);

/** xorshift32 -> fn(n) in [0, n). The AI's own generator (never the engine's). */
export function createRng(seed) {
  // sequential seeds (1, 2, 3...) must not give correlated streams: run the seed through an integer mixer first
  let s = seed >>> 0;
  s = Math.imul(s ^ (s >>> 16), 0x7feb352d) >>> 0; s = Math.imul(s ^ (s >>> 15), 0x846ca68b) >>> 0; s = (s ^ (s >>> 16)) >>> 0;
  s = s || 0x9e3779b9;
  const fn = (n) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return n > 0 ? s % n : 0; };
  fn.state = () => s;
  return fn;
}

/* ----------------------------------------------------------------------------------------------- pack lookups */

const cache = new WeakMap();
function lookups(pack) {
  let c = cache.get(pack);
  if (c) return c;
  const moveByName = Object.create(null);
  for (const m of pack.moves) if (m && m.name && moveByName[m.name] === undefined) moveByName[m.name] = m.id;
  const abName = (id) => (pack.abilities[id] ? pack.abilities[id].name : '');
  const itName = (id) => (pack.items[id] ? pack.items[id].name : '');
  const typeId = Object.create(null);
  for (const t of pack.types) typeId[t.name] = t.id;
  c = { moveByName, abName, itName, typeId };
  cache.set(pack, c);
  return c;
}
const idsOf = (pack, names) => { const L = lookups(pack); return new Set(names.map((n) => L.moveByName[n]).filter((x) => x !== undefined)); };
const kindCache = new WeakMap();
function kinds(pack) {
  let k = kindCache.get(pack);
  if (k) return k;
  k = {
    heal: idsOf(pack, ['Recover', 'Roost', 'Soft-Boiled', 'Slack Off', 'Milk Drink', 'Moonlight', 'Morning Sun', 'Synthesis', 'Heal Order', 'Shore Up', 'Rest']),
    sleep: idsOf(pack, ['Spore', 'Sleep Powder', 'Hypnosis', 'Lovely Kiss', 'Sing', 'Grass Whistle', 'Yawn', 'Dark Void']),
    para: idsOf(pack, ['Thunder Wave', 'Stun Spore', 'Glare']),
    burn: idsOf(pack, ['Will-O-Wisp']),
    poison: idsOf(pack, ['Toxic', 'Poison Powder', 'Toxic Thread']),
    confuse: idsOf(pack, ['Confuse Ray', 'Supersonic', 'Swagger', 'Flatter', 'Teeter Dance']),
    setup: idsOf(pack, ['Swords Dance', 'Dragon Dance', 'Nasty Plot', 'Calm Mind', 'Bulk Up', 'Quiver Dance', 'Agility', 'Iron Defense', 'Amnesia', 'Shell Smash', 'Belly Drum', 'Curse', 'Growth', 'Work Up', 'Howl', 'Hone Claws', 'Coil', 'Shift Gear', 'Cosmic Power', 'Acid Armor', 'Barrier', 'Autotomize', 'Rock Polish', 'Cotton Guard', 'Tail Glow', 'Geomancy', 'Victory Dance']),
    hazard: idsOf(pack, ['Stealth Rock', 'Spikes', 'Toxic Spikes', 'Sticky Web']),
    protect: idsOf(pack, ['Protect', 'Detect', "King's Shield", 'Spiky Shield', 'Baneful Bunker', 'Endure']),
    weather: idsOf(pack, ['Rain Dance', 'Sunny Day', 'Sandstorm', 'Hail', 'Snowscape']),
    screen: idsOf(pack, ['Reflect', 'Light Screen', 'Aurora Veil', 'Tailwind']),
    fixedLevel: idsOf(pack, ['Seismic Toss', 'Night Shade']),
    fixed: new Map([['Dragon Rage', 40], ['Sonic Boom', 20]].map(([n, v]) => [lookups(pack).moveByName[n], v]).filter((e) => e[0] !== undefined)),
    ohko: idsOf(pack, ['Fissure', 'Guillotine', 'Horn Drill', 'Sheer Cold']),
    recoilish: idsOf(pack, ['Explosion', 'Self-Destruct', 'Memento', 'Final Gambit', 'Misty Explosion']),
    pivot: idsOf(pack, ['U-turn', 'Volt Switch', 'Flip Turn', 'Parting Shot']),
  };
  kindCache.set(pack, k);
  return k;
}

// foe abilities that make a type's damage zero when REVEALED
const ABSORB = { Levitate: ['Ground'], 'Flash Fire': ['Fire'], 'Water Absorb': ['Water'], 'Storm Drain': ['Water'], 'Dry Skin': ['Water'], 'Volt Absorb': ['Electric'], 'Lightning Rod': ['Electric'], 'Motor Drive': ['Electric'], 'Sap Sipper': ['Grass'], 'Earth Eater': ['Ground'] };

/* -------------------------------------------------------------------------------------- damage estimation */

const stageMul = (s) => (s >= 0 ? (2 + s) / 2 : 2 / (2 - s));
const estStat = (base, level) => Math.floor(((2 * base + 31) * level) / 100) + 5;
const estHp = (base, level) => Math.floor(((2 * base + 31) * level) / 100) + level + 10;
const uniq = (a) => Array.from(new Set(a));

export function typeMultiplier(pack, atkType, defTypes) {
  let m = 1;
  for (const t of uniq(defTypes)) m *= pack.typeChart[atkType][t] / 4096;
  return m;
}

// the damage of one hit as a number of HP (average roll, no crit, no ability / item), integer arithmetic as in the Gen-3 formula
function hitDamage(pack, o) {
  const { level, power, A, D, stab, eff, wx, physical, burned } = o;
  if (!(power > 0) || eff === 0) return 0;
  let d = Math.floor(Math.floor(Math.floor((2 * level) / 5 + 2) * power * A / Math.max(1, D)) / 50) + 2;
  d *= wx; if (stab) d *= 1.5; d *= eff; if (physical && burned) d *= 0.5;
  return Math.max(1, Math.floor(d * 0.925));
}

function weatherMul(wxId, type, ids) {
  // weather ids: 1 rain 2 sun 3 sand 4 hail 5 snow (ENGINE.md); Water / Fire only
  if (wxId === 1) return type === ids.Water ? 1.5 : type === ids.Fire ? 0.5 : 1;
  if (wxId === 2) return type === ids.Fire ? 1.5 : type === ids.Water ? 0.5 : 1;
  return 1;
}

const POWER_FIX = { Return: 102, 'Hidden Power': 60, 'Gyro Ball': 70, 'Low Kick': 60, 'Grass Knot': 60, Flail: 40, Reversal: 40, 'Heavy Slam': 70, 'Heat Crash': 70, Punishment: 60, 'Stored Power': 60, 'Electro Ball': 60, Eruption: 100, 'Water Spout': 100, Facade: 70, Hex: 65, Venoshock: 65, 'Wring Out': 60, 'Crush Grip': 60, Present: 40, Magnitude: 70, Psywave: 50, 'Trump Card': 60, 'Beat Up': 50, 'Fury Cutter': 40 };

/**
 * Expected fraction of the TARGET's max HP that one use of `moveId` removes. `me` = { level, stats, ty, stages, status, ab }, `foe` =
 * { level, stats (estimated), ty, stages, status, hpFrac, ab (revealed name or '') }. Returns { frac, acc, ko }.
 */
export function moveValue(pack, moveId, me, foe, wxId) {
  const mv = pack.moves[moveId], L = lookups(pack), K = kinds(pack);
  const ids = L.typeId;
  if (!mv) return { frac: 0, acc: 0, ko: false };
  const acc = mv.accuracy === 0 ? 1 : Math.min(1, mv.accuracy / 100);
  if (mv.category === 2 && !K.fixed.has(moveId)) return { frac: 0, acc, ko: false };
  const foeMaxHp = foe.stats.hp, foeHp = Math.max(1, Math.round(foeMaxHp * foe.hpFrac));
  let dmg = 0;
  if (K.fixedLevel.has(moveId)) dmg = me.level;
  else if (K.fixed.has(moveId)) dmg = K.fixed.get(moveId);
  else if (K.ohko.has(moveId)) dmg = foeHp;
  else {
    let power = mv.power > 1 ? mv.power : (POWER_FIX[mv.name] || 60);
    const phys = mv.category === 0;
    const A = Math.max(1, Math.floor((phys ? me.stats.atk : me.stats.spa) * stageMul(phys ? (me.stages.atk || 0) : (me.stages.spa || 0))));
    const D = Math.max(1, Math.floor((phys ? foe.stats.def : foe.stats.spd) * stageMul(phys ? (foe.stages.def || 0) : (foe.stages.spd || 0))));
    let eff = typeMultiplier(pack, mv.type, foe.ty);
    const abName = foe.ab || '';
    if (ABSORB[abName] && ABSORB[abName].some((t) => ids[t] === mv.type)) eff = 0;
    if (abName === 'Wonder Guard' && eff <= 1) eff = 0;
    dmg = hitDamage(pack, { level: me.level, power, A, D, stab: me.ty.includes(mv.type), eff, wx: weatherMul(wxId, mv.type, ids), physical: phys, burned: me.status === 3 });
    if (mv.strikeCount > 1) dmg *= mv.strikeCount;
    else if (mv.flags && /* multi-hit raw flag */ (mv.bytes && (mv.bytes[5] & 1))) dmg *= 3;
  }
  const frac = Math.min(1, dmg / foeMaxHp);
  return { frac, acc, ko: dmg >= foeHp, dmg };
}

/* --------------------------------------------------------------------------------------------- view helpers */

// What the AI can know about the Pokemon in `slot` of its own team and about the foe's active Pokemon.
function mineOf(view, slot) { return view.you.team[slot]; }

function foeEstimate(pack, view) {
  const f = view.foe.activeDetail, sp = pack.species[f.sp];
  const b = sp.baseStats;
  const L = lookups(pack);
  const ab = f.revealed && f.revealed.ab ? L.abName(f.revealed.ab) : '';
  return {
    sp: f.sp, level: f.level, ty: f.ty.slice(), status: f.st, hpFrac: Math.max(0.01, (f.hpPct || 0) / 100), stages: f.stages || {},
    stats: { hp: estHp(b.hp, f.level), atk: estStat(b.atk, f.level), def: estStat(b.def, f.level), spa: estStat(b.spa, f.level), spd: estStat(b.spd, f.level), spe: estStat(b.spe, f.level) },
    ab, revealedMoves: (f.revealed && f.revealed.mv) ? f.revealed.mv.slice() : [], vol: f.vol || [],
  };
}

function meSnapshot(pack, view, mon, stages) {
  return { level: mon.level, stats: mon.stats, ty: mon.ty.slice(), stages: stages || {}, status: mon.st, ab: lookups(pack).abName(mon.ab), hp: mon.hp, max: mon.max, sp: mon.sp };
}
// a bench Pokemon as it would stand on the field (no stages)
const asMe = (pack, view, mon) => meSnapshot(pack, view, mon, {});

// The foe's threat to a Pokemon `target`: the biggest fraction of target's max HP one foe attack is likely to remove. Uses the foe's
// REVEALED moves plus an assumed 80-power STAB hit of each of its types (the worst case a player plans for).
function foeThreat(pack, view, foe, target, wxId) {
  const L = lookups(pack), ids = L.typeId;
  const stages = target.slot === view.you.active ? (view.you.activeDetail.stages || {}) : {};
  const tgt = { level: target.level, stats: { hp: target.max, atk: target.stats.atk, def: target.stats.def, spa: target.stats.spa, spd: target.stats.spd, spe: target.stats.spe }, ty: target.ty.slice(), stages, status: target.st, hpFrac: 1, ab: L.abName(target.ab) };
  const attacker = { level: foe.level, stats: foe.stats, ty: foe.ty, stages: foe.stages, status: foe.status };
  let best = 0;
  for (const mid of foe.revealedMoves) { const v = moveValue(pack, mid, attacker, tgt, wxId); best = Math.max(best, v.frac * v.acc); }
  for (const t of uniq(foe.ty)) {
    const eff = typeMultiplier(pack, t, target.ty);
    let eff2 = eff; const ab = L.abName(target.ab);
    if (ABSORB[ab] && ABSORB[ab].some((n) => ids[n] === t)) eff2 = 0;
    const phys = foe.stats.atk >= foe.stats.spa;
    const A = (phys ? foe.stats.atk : foe.stats.spa) * stageMul(phys ? (foe.stages.atk || 0) : (foe.stages.spa || 0));
    const D = (phys ? target.stats.def : target.stats.spd);
    const d = hitDamage(pack, { level: foe.level, power: 80, A, D, stab: true, eff: eff2, wx: weatherMul(wxId, t, ids), physical: phys, burned: foe.status === 3 });
    best = Math.max(best, Math.min(1, d / target.max));
  }
  return best;
}

const fracHp = (m) => (m.max > 0 ? m.hp / m.max : 0);
const speedOf = (stats, stages, status) => stats.spe * stageMul((stages && stages.spe) || 0) * (status === 5 ? 0.5 : 1);

/* ----------------------------------------------------------------------------------------------- the choosers */

function legalMoves(request) { return (request.moves || []).filter((m) => !m.disabled); }
function mkMove(slot) { return { kind: 'move', slot }; }
function mkSwitch(slot) { return { kind: 'switch', slot }; }

function pickBest(rng, scored, tolerance) {
  let top = -Infinity; for (const s of scored) top = Math.max(top, s.v);
  const pool = scored.filter((s) => s.v >= top - tolerance * Math.max(Math.abs(top), 1e-9));
  if (!pool.length) return scored[0];                  // NaN scores can never leave the AI without a choice
  return pool[rng(pool.length)];
}

// status moves: what is it worth to use this one now? (fractions of "one good attack"; ~0.35 is a decent hit)
function statusValue(pack, moveId, ctx) {
  const K = kinds(pack), { foe, myFrac, wx } = ctx, L = lookups(pack), ids = L.typeId;
  const foeFree = foe.status === 0;
  const foeTy = foe.ty;
  const isType = (n) => foeTy.includes(ids[n]);
  if (K.sleep.has(moveId)) { if (!foeFree) return -1; if (foe.vol.includes('yawn')) return -1; return isType('Grass') && ['Spore', 'Sleep Powder'].includes(pack.moves[moveId].name) ? -1 : 0.55; }
  if (K.para.has(moveId)) { if (!foeFree || isType('Electric')) return -1; if (pack.moves[moveId].name === 'Thunder Wave' && isType('Ground')) return -1; return speedOf(ctx.me.stats, ctx.me.stages, ctx.me.status) < speedOf(foe.stats, foe.stages, foe.status) ? 0.5 : 0.3; }
  if (K.burn.has(moveId)) { if (!foeFree || isType('Fire')) return -1; return foe.stats.atk > foe.stats.spa ? 0.45 : 0.2; }
  if (K.poison.has(moveId)) { if (!foeFree || isType('Poison') || isType('Steel')) return -1; return 0.35; }
  if (K.confuse.has(moveId)) return foe.vol.includes('confusion') ? -1 : 0.25;
  if (K.heal.has(moveId)) { if (myFrac > 0.7) return -1; return myFrac < 0.35 ? 0.8 : 0.5; }
  if (K.setup.has(moveId)) { const boosted = Object.values(ctx.me.stages).reduce((a, b) => a + b, 0); if (boosted >= 2 || myFrac < 0.6 || ctx.threat > 0.45) return -1; return 0.45 - 0.1 * boosted; }
  if (K.hazard.has(moveId)) { if (ctx.hazardsOnFoeSide >= 1 && pack.moves[moveId].name !== 'Spikes') return -1; return ctx.foeRemaining >= 3 ? 0.4 : 0.1; }
  if (K.weather.has(moveId)) { return wx === 0 ? 0.15 : -1; }
  if (K.screen.has(moveId)) return ctx.threat > 0.2 ? 0.2 : 0.05;
  if (K.protect.has(moveId)) return -1;
  return 0.04;                                         // an unknown status move: nearly never worth a turn
}

function chooseEasy(request, rng) {
  if (request.phase === 'move') { const ms = legalMoves(request); return mkMove(ms[rng(ms.length)].slot); }
  if (request.phase === 'switch') return mkSwitch(request.switches[rng(request.switches.length)].slot);
  return null;
}

function buildCtx(pack, view, request) {
  const me = mineOf(view, view.you.active);
  const stages = view.you.activeDetail.stages || {};
  const foe = foeEstimate(pack, view);
  const wx = view.weather ? view.weather.id : 0;
  const mySnap = meSnapshot(pack, view, me, stages);
  const myFrac = fracHp(me);
  const threat = foeThreat(pack, view, foe, { ...me, stats: me.stats }, wx);
  return { me: mySnap, meMon: me, foe, wx, myFrac, threat, hazardsOnFoeSide: (view.foe.hazards ? (view.foe.hazards.sp + view.foe.hazards.ts + view.foe.hazards.sr + view.foe.hazards.sw) : 0), foeRemaining: view.foe.remaining };
}

// how good is Pokemon `cand` (a bench member) against the foe's active one right now: my best hit minus the foe's best hit, in HP fractions
function matchup(pack, view, foe, cand, wx) {
  const me = asMe(pack, view, cand);
  const hits = cand.mv.map((m) => { const v = moveValue(pack, m.id, me, { ...foe, stats: foe.stats }, wx); return m.pp > 0 ? v.frac * v.acc : 0; });
  const mine = Math.max(0, ...hits);
  const threat = foeThreat(pack, view, foe, cand, wx);
  const hpf = fracHp(cand);
  return mine - threat * (hpf > 0 ? 1 / Math.max(hpf, 0.25) : 5) * 0.6;
}

function bestSwitch(pack, view, request, foe, wx, avoid) {
  let best = null;
  for (const s of request.switches) {
    const cand = mineOf(view, s.slot);
    if (!cand || cand.hp <= 0) continue;
    let v = matchup(pack, view, foe, cand, wx);
    // never switch into a known immunity-less KO: a revealed foe move that would remove most of the candidate's HP
    const thr = foeThreat(pack, view, foe, cand, wx);
    if (thr >= fracHp(cand) * 0.9 && avoid) v -= 2;
    if (!best || v > best.v) best = { slot: s.slot, v };
  }
  return best;
}

// normal's deliberate blunder rate: a percentage of turns on which it plays any legal move. 30 was chosen by measurement: normal then beats easy about
// 4 games in 5 while hard beats normal about 3 games in 5 (18, the earlier value, left hard indistinguishable from normal).
export const SLIP_PERCENT = 30;
function chooseNormal(pack, request, view, rng) {
  if (request.phase === 'switch') {
    const foe = foeEstimate(pack, view), wx = view.weather ? view.weather.id : 0;
    const b = bestSwitch(pack, view, request, foe, wx, true);
    return mkSwitch(b ? b.slot : request.switches[0].slot);
  }
  const ctx = buildCtx(pack, view, request);
  const moves = legalMoves(request);
  if (request.struggle || moves.length === 0) return mkMove(request.moves[0].slot);
  const K = kinds(pack);
  const scored = moves.map((m) => {
    const mv = pack.moves[m.id];
    let v;
    if (mv.category === 2 && !K.fixed.has(m.id)) v = statusValue(pack, m.id, ctx);
    else {
      const r = moveValue(pack, m.id, ctx.me, ctx.foe, ctx.wx);
      v = r.frac * r.acc;
      if (r.ko) v += 0.6 * r.acc;                                 // finishing the foe is worth a whole extra attack
      if (mv.priority > 0 && r.ko) v += 0.4;
      if (K.recoilish.has(m.id)) v = ctx.myFrac < 0.3 ? v : v * 0.4;
    }
    return { slot: m.slot, id: m.id, v };
  });
  // normal is a competent but fallible player: now and then (SLIP_PERCENT of turns) it plays any legal move instead of the best one
  if (rng(100) < SLIP_PERCENT) { const pickAny = moves[rng(moves.length)]; return mkMove(pickAny.slot); }
  const best = pickBest(rng, scored, 0.1);
  // a switch is considered only when the current matchup is clearly poor
  if (request.switches && request.switches.length && !request.trapped) {
    const bestAttack = Math.max(...scored.map((s) => s.v));
    if (bestAttack < 0.3 && ctx.threat > Math.max(0.35, ctx.myFrac * 0.7)) {
      const sw = bestSwitch(pack, view, request, ctx.foe, ctx.wx, true);
      const here = matchup(pack, view, ctx.foe, ctx.meMon, ctx.wx);
      if (sw && sw.v > here + 0.4 && fracHp(mineOf(view, sw.slot)) > 0.4 && rng(100) < 70) return mkSwitch(sw.slot);
    }
  }
  return mkMove(best.slot);
}

// hard: best attack every turn (no slips), a utility move only when it is clearly worth the turn, a voluntary switch only when stuck.
// Units: fractions of the foe's max HP per use (accuracy-weighted), a KO is worth +0.6 (+0.4 more with priority).
function attackScore(pack, K, m, ctx) {
  const mv = pack.moves[m.id], r = moveValue(pack, m.id, ctx.me, ctx.foe, ctx.wx);
  let v = r.frac * r.acc;
  if (r.ko) v += 0.6 * r.acc;
  if (mv.priority > 0 && r.ko) v += 0.4;
  if (K.recoilish.has(m.id)) v = ctx.myFrac < 0.3 ? v : v * 0.4;
  return v;
}
function chooseHard(pack, request, view, rng) {
  if (request.phase === 'switch') return chooseNormal(pack, request, view, rng);      // a forced replacement: the matchup scorer (it never slips)
  const ctx = buildCtx(pack, view, request);
  const moves = legalMoves(request);
  if (request.struggle || moves.length === 0) return mkMove(request.moves[0].slot);
  const K = kinds(pack);
  const attacks = [], utility = [];
  for (const m of moves) {
    const mv = pack.moves[m.id];
    if (mv.category === 2 && !K.fixed.has(m.id)) { const base = statusValue(pack, m.id, ctx); if (base > 0) utility.push({ slot: m.slot, id: m.id, v: base }); }
    else attacks.push({ slot: m.slot, id: m.id, v: attackScore(pack, K, m, ctx) });
  }
  const bestUtil = utility.length ? utility.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  if (!attacks.length) return mkMove((bestUtil || { slot: moves[0].slot }).slot);
  const best = attacks.reduce((a, b) => (b.v > a.v ? b : a));      // exact ties keep the lower slot: no randomness at all
  // a status / setup / recovery / hazard move beats the best attack only when it is worth more AND the foe cannot punish the turn
  if (bestUtil && bestUtil.v > best.v && ctx.threat < ctx.myFrac * 0.8 && best.v <= 0.9) return mkMove(bestUtil.slot);
  // stuck: nothing it has can hurt the foe (immunity, resisted walls, empty PP) and no utility move helps -> leave if a teammate can
  if (best.v < 0.02 && !bestUtil && request.switches && request.switches.length && !request.trapped) {
    const sw = bestSwitch(pack, view, request, ctx.foe, ctx.wx, true);
    if (sw) return mkSwitch(sw.slot);
  }
  return mkMove(best.slot);
}

// Team preview: both rosters are public (species and level). Pick `pick` of mine, the best lead first.
function choosePreview(pack, request, view, rng, level, previewInfo) {
  const n = request.team.length, pick = request.pick;
  const idx = request.team.map((m) => m.slot);
  if (level === 'easy' || !previewInfo || !previewInfo.foe || !previewInfo.foe.length) {
    const pool = idx.slice(), order = [];
    while (order.length < pick) order.push(pool.splice(rng(pool.length), 1)[0]);
    return { kind: 'preview', order };
  }
  const L = lookups(pack);
  const myRec = view.you.team;
  const score = (slot) => {
    const m = myRec[slot];
    let total = 0;
    for (const f of previewInfo.foe) {
      const sp = pack.species[f.sp], b = sp.baseStats, fty = sp.types[0] === sp.types[1] ? [sp.types[0]] : [sp.types[0], sp.types[1]];
      const foe = { level: f.level, ty: fty, stages: {}, status: 0, hpFrac: 1, ab: '', stats: { hp: estHp(b.hp, f.level), atk: estStat(b.atk, f.level), def: estStat(b.def, f.level), spa: estStat(b.spa, f.level), spd: estStat(b.spd, f.level), spe: estStat(b.spe, f.level) } };
      const me = asMe(pack, view, m);
      let best = 0;
      for (const mv of m.mv) { const r = moveValue(pack, mv.id, me, foe, 0); best = Math.max(best, r.frac * r.acc); }
      let thr = 0;
      for (const t of uniq(fty)) { const e = typeMultiplier(pack, t, m.ty); thr = Math.max(thr, e * 0.3); }
      total += best - thr * 0.5;
    }
    return total / previewInfo.foe.length + (m.stats.spe / 800);
  };
  void L;
  const ranked = idx.map((s) => ({ slot: s, v: score(s) + rng(1000) / 1e6 })).sort((a, b) => b.v - a.v);
  void n;
  return { kind: 'preview', order: ranked.slice(0, pick).map((r) => r.slot) };
}

/**
 * createAi({ pack, level, seed }) -> { level, choose(request, view, extra) }
 *   extra.previewInfo = { foe: [{ sp, level }] }  (the public team preview; only read at the preview phase)
 * Returns a choice for battle.choose, or null when the request needs nothing (phase 'wait' / 'end').
 */
export function createAi({ pack, level = 'normal', seed = 1 }) {
  if (!AI_LEVELS.includes(level)) throw new RangeError('unknown AI level ' + String(level));
  const rng = createRng(seed);
  return {
    level,
    rng,
    choose(request, view, extra = {}) {
      if (!request) return null;
      if (request.phase === 'preview') return choosePreview(pack, request, view, rng, level, extra.previewInfo);
      if (request.phase !== 'move' && request.phase !== 'switch') return null;
      if (request.phase === 'switch' && request.reason === 'free') return { kind: 'stay' };          // the free-switch offer ("Will you switch your Pokemon?"): a CPU standing in for a person (autoplay) says NO, it draws nothing from its rng
      if (request.phase === 'switch' && (!request.switches || !request.switches.length)) return null;
      if (level === 'easy') return chooseEasy(request, rng);
      return level === 'hard' ? chooseHard(pack, request, view, rng) : chooseNormal(pack, request, view, rng);
    },
  };
}

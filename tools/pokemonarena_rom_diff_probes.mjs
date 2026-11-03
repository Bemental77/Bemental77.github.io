// tools/pokemonarena_rom_diff_probes.mjs -- stage FA2: EXACT probability probes against the real game.
//
// The real game's draws are reduced by multiplication: an event with a "pick" p = (100 * v) >> 16 (v = the 16-bit draw) happens above a
// threshold, and a damage-roll / crit / accuracy outcome is a monotone function of ONE draw. Rewriting the game's RNG state before every frame
// (tools/pokemonarena_rom_diff_live.mjs findSeed / findSeedPos) lets a binary search find the threshold to the unit.  Every probe here returns the
// number of picks (out of 100) or draw values (out of 65536) that produce the event in the real game, next to the engine's count.
// Engine counts are taken by calling the engine's own check with every possible rand(n) value, so no probability is copied by hand.
// Pure ASCII, nothing here is ROM content.

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RNG_ADDR = 0x03005a68;

/** sfc32 state whose outputs j = 0..K-1 (top 16 bits) lie in iv[j] = [lo, hi] */
export function findSeedPos(iv, rngSeed = 1) {
  let x = (rngSeed >>> 0) || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const K = iv.length;
  for (let tries = 0; tries < 4e9; tries++) {
    let a = next(), b = next(), c = next(), n = next();
    const s0 = [a, b, c, n];
    let ok = true;
    for (let j = 0; j < K; j++) {
      const t = (((a + b) >>> 0) + n) >>> 0; const v = t >>> 16;
      if (v < iv[j][0] || v > iv[j][1]) { ok = false; break; }
      const a2 = (b ^ (b >>> 9)) >>> 0, b2 = (c + ((c << 3) >>> 0)) >>> 0, c2 = ((((c >>> 11) | (c << 21)) >>> 0) + t) >>> 0;
      a = a2; b = b2; c = c2; n = (n + 1) >>> 0;
    }
    if (ok) return s0;
  }
  return null;
}

/** play the real game with the RNG rewritten before every frame; returns the foe's first HP drop (0 = none) */
export function realRun(live, ids, spec, S) {
  const o = live.o;
  o.loadStateBlob(live.blob);
  const mon = (x, mv) => ({ species: 0, level: 50, atk: 100, def: 100, spa: 100, spd: 100, spe: 100, types: [1], hp: 600, maxhp: 600, ability: ids.ability(x.ability), item: ids.item(x.item), stages: x.stages || {}, status1: x.status1 || 0, status2: x.status2 || 0, infat: x.infat || 0, moves: [ids.move(mv), 0, 0, 0], pp: [30, 0, 0, 0] });
  live.writeMon(live.A0, { ...mon(spec.a || {}, spec.move), spe: 500 });
  live.writeMon(live.A1, { ...mon(spec.b || {}, 'Splash'), spe: 5 });
  o.writeU32(0x02001e3c, spec.wxWord || 0);
  o.writeU32(0x02001d2c, spec.fieldWord || 0); o.writeU8(0x02001dcc, (spec.fieldWord || 0) & 0x20 ? 5 : 0);   // gFieldStatuses (Gravity 0x20) and the Gravity timer
  const setS = () => { for (let k = 0; k < 4; k++) o.writeU32(RNG_ADDR + 4 * k, S[k]); };
  const hold = (key, n) => { for (let i = 0; i < n; i++) { setS(); o.runFrames(1, key); } };
  hold('A', 5); hold(0, 40); hold('A', 5); hold(0, 3);
  const hp0 = o.battleMon(1).hp;
  for (let f = 0; f < 300; f++) { setS(); o.runFrames(1); const h = o.battleMon(1).hp; if (h !== hp0) return hp0 - h; }
  return 0;
}

const seedCache = new Map();
const pickSeed = (p) => {
  if (!seedCache.has(p)) {
    const lo = Math.ceil(p * 65536 / 100) + 2, hi = Math.floor(((p + 1) * 65536 - 1) / 100) - 2;
    // positions 0 and 2 carry the pick (the accuracy draw is at 0 or 2), 1 and 3 are neutral (non-crit, any roll)
    seedCache.set(p, findSeedPos([[lo, hi], [4096, 40000], [lo, hi], [4096, 40000]], p + 5));
  }
  return seedCache.get(p);
};

/** the real game's effective accuracy (percent) for `spec`: the smallest pick that misses is 100 - that */
export function realAccuracy(live, ids, spec) {
  const hit = (p) => realRun(live, ids, spec, pickSeed(p)) > 0;
  if (!hit(99)) return 0;
  if (hit(0)) return 100;
  let lo = 0, hi = 99;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (hit(m)) hi = m; else lo = m; }
  return 100 - hi;
}

/** the engine's effective accuracy: the number of rand(100) values in 0..99 for which checkAccuracy lets the move hit */
export async function engineAccuracy(M, pack, lab, T, spec) {
  const { MOVE_KINDS } = await import(pathToFileURL(path.join(M.dir, 'engine_moves.js')).href);
  const id = lab.D.moveByName[spec.move];
  const tid = (n) => T[n.toUpperCase()];
  const side = (x, mv) => ({ moves: [mv], st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, ty: [tid('Normal')], ab: x.ability ? lab.abid(x.ability) : 0, it: x.item ? lab.itid(x.item) : 0, hp: 600, mhp: 600, sg: x.stages && Object.keys(x.stages).length ? { ...x.stages } : undefined });
  const b = lab.lab({ a: side(spec.a || {}, spec.move), b: side(spec.b || {}, 'Splash'), wx: spec.wxId ? [spec.wxId, spec.pw ? 16 : 5] : undefined, pw: spec.pw, gv: spec.gv });
  const mv = pack.moves[id], ef = M.engine_data.EFFECTS[mv.effect], K = MOVE_KINDS[ef.kind];
  let hits = 0;
  for (let v = 0; v < 100; v++) {
    const sb = b.scratch();
    sb.rand = (n) => (n === 100 ? v : 0);
    const c = sb.makeCtx(0, mv, ef, K, {});
    if (sb.checkAccuracy(c)) hits++;
  }
  return hits;
}

export const ACCURACY_PROBES = [
  { label: 'accuracy stage -6 on an accuracy-100 move', move: 'Body Slam', a: { stages: { acc: -6 } } },
  { label: 'accuracy stage -5', move: 'Body Slam', a: { stages: { acc: -5 } } },
  { label: 'accuracy stage -4', move: 'Body Slam', a: { stages: { acc: -4 } } },
  { label: 'accuracy stage -3', move: 'Body Slam', a: { stages: { acc: -3 } } },
  { label: 'accuracy stage -2', move: 'Body Slam', a: { stages: { acc: -2 } } },
  { label: 'accuracy stage -1', move: 'Body Slam', a: { stages: { acc: -1 } } },
  { label: 'evasion stage +4 on the target', move: 'Body Slam', b: { stages: { eva: 4 } } },
  { label: 'evasion stage +5 on the target', move: 'Body Slam', b: { stages: { eva: 5 } } },
  { label: 'accuracy -5 on a 90 move (floor 32)', move: 'Rock Throw', a: { stages: { acc: -5 } } },
  { label: 'accuracy -6 on a 90 move (floor 29)', move: 'Rock Throw', a: { stages: { acc: -6 } } },
  { label: 'accuracy -5 on an 85 move (floor 30)', move: 'Double Slap', a: { stages: { acc: -5 } } },
  { label: 'accuracy +1 on a 75 move (floor 99)', move: 'Slam', a: { stages: { acc: 1 } } },
  { label: 'accuracy -5 on a 75 move (floor 27)', move: 'Slam', a: { stages: { acc: -5 } } },
  { label: 'accuracy -1 on a 95 move', move: 'Cut', a: { stages: { acc: -1 } } },
  { label: 'accuracy -5 on a 95 move (floor 34)', move: 'Cut', a: { stages: { acc: -5 } } },
  { label: 'net stage: accuracy +2 vs evasion +3 (-1)', move: 'Slam', a: { stages: { acc: 2 } }, b: { stages: { eva: 3 } } },
  { label: 'Compound Eyes on a 70 move', move: 'Focus Blast', a: { ability: 'Compound Eyes' } },
  { label: 'Wide Lens on a 70 move', move: 'Focus Blast', a: { item: 'Wide Lens' } },
  { label: 'Hustle on a physical 75 move', move: 'Slam', a: { ability: 'Hustle' } },
  { label: 'Sand Veil in sandstorm', move: 'Slam', b: { ability: 'Sand Veil' }, wxWord: 0x20, wxId: 3 },
  { label: 'Snow Cloak in snow', move: 'Slam', b: { ability: 'Snow Cloak' }, wxWord: 0x80, wxId: 5 },
  { label: 'Bright Powder on the target', move: 'Slam', b: { item: 'Bright Powder' } },
  { label: 'Thunder in rain (never misses)', move: 'Thunder', wxWord: 1, wxId: 1 },
  { label: 'Thunder in sun (50)', move: 'Thunder', wxWord: 8, wxId: 2 },
  { label: 'Thunder in clear weather (70)', move: 'Thunder' },
  { label: 'Blizzard in hail (never misses)', move: 'Blizzard', wxWord: 0x40, wxId: 4 },
  { label: 'Blizzard in snow (never misses)', move: 'Blizzard', wxWord: 0x80, wxId: 5 },
  { label: 'Hurricane in rain', move: 'Hurricane', wxWord: 1, wxId: 1 },
  { label: 'Hurricane in sun', move: 'Hurricane', wxWord: 8, wxId: 2 },
  { label: 'No Guard attacker on a 70 move', move: 'Focus Blast', a: { ability: 'No Guard' } },
  { label: 'Thunder in harsh sun', move: 'Thunder', wxWord: 0x10, wxId: 2, pw: 7 },
  { label: 'Thunder in heavy rain (never misses)', move: 'Thunder', wxWord: 2, wxId: 1, pw: 6 },
  { label: 'Hurricane in harsh sun', move: 'Hurricane', wxWord: 0x10, wxId: 2, pw: 7 },
  { label: 'Blizzard in strong winds', move: 'Blizzard', wxWord: 0x200, pw: 8 },
  { label: 'Focus Blast under Gravity (x5/3)', move: 'Focus Blast', fieldWord: 0x20, gv: 5 },
  { label: 'Rock Throw under Gravity', move: 'Rock Throw', fieldWord: 0x20, gv: 5 },
  { label: 'Zap Cannon under Gravity', move: 'Zap Cannon', fieldWord: 0x20, gv: 5 },
  { label: 'accuracy -2 under Gravity', move: 'Focus Blast', a: { stages: { acc: -2 } }, fieldWord: 0x20, gv: 5 },
  { label: 'evasion +2 under Gravity', move: 'Focus Blast', b: { stages: { eva: 2 } }, fieldWord: 0x20, gv: 5 },
];

/** run the accuracy probes; rows { label, real, engine, ok } */
export async function runAccuracyProbes(live, ids, M, pack, lab, T, limit) {
  const rows = [];
  const filt = process.env.ARENA_PROBE_FILTER ? new RegExp(process.env.ARENA_PROBE_FILTER) : null;
  for (const p of ACCURACY_PROBES.filter((x) => !filt || filt.test(x.label)).slice(0, limit || ACCURACY_PROBES.length)) {
    const real = realAccuracy(live, ids, p);
    let engine;
    try { engine = await engineAccuracy(M, pack, lab, T, p); } catch (e) { engine = 'threw ' + String((e && e.message) || e).slice(0, 80); }
    rows.push({ label: p.label, real, engine, ok: real === engine });
  }
  return rows;
}

/** crit boundary: the smallest value of the crit draw (position 2) that makes Body Slam critical, for several crit-stage sources */
export function realCritBoundary(live, ids, spec) {
  const SAFE = [4096, 8000];
  const seedX = (x) => findSeedPos([[0, 65535], [0, 65535], [x, x], SAFE], x + 11);
  const isCrit = (x) => realRun(live, ids, spec, seedX(x)) > 70;
  if (!isCrit(65535)) return null;
  if (isCrit(0)) return 0;
  let lo = 0, hi = 65535;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (isCrit(m)) hi = m; else lo = m; }
  return hi;
}
export const CRIT_PROBES = [
  { label: 'crit stage 0 (Body Slam)', move: 'Body Slam', stage: 0 },
  { label: 'crit stage 1 from Super Luck', move: 'Body Slam', a: { ability: 'Super Luck' }, stage: 1 },
  { label: 'crit stage 1 from Scope Lens', move: 'Body Slam', a: { item: 'Scope Lens' }, stage: 1 },
  { label: 'crit stage 1 from Razor Claw', move: 'Body Slam', a: { item: 'Razor Claw' }, stage: 1 },
];

// ---- chance mechanics found by locating the one draw that decides an outcome ---------------------------------------------------
const topDraws = (S, k) => { const out = []; let [a, b, c, n] = S; for (let i = 0; i < k; i++) { const t = (((a + b) >>> 0) + n) >>> 0; out.push(t >>> 16); const a2 = (b ^ (b >>> 9)) >>> 0, b2 = (c + ((c << 3) >>> 0)) >>> 0, c2 = ((((c >>> 11) | (c << 21)) >>> 0) + t) >>> 0; a = a2; b = b2; c = c2; n = (n + 1) >>> 0; } return out; };
/** realRun with raw status words: outcome 'moved' when the foe lost HP */
function runStatus(live, ids, spec, S) { return realRun(live, ids, { ...spec, a: { ...(spec.a || {}) } }, S) > 0 ? 'moved' : 'blocked'; }
/** fraction (0..1) of the 16-bit draw range for which the player's move is NOT executed, from the real game: find the draw position that decides it, then binary-search its threshold */
export function realBlockedFraction(live, ids, spec) {
  let x = 31337; const rnd = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x; };
  const T = [];
  for (let i = 0; i < 50; i++) { const S = [rnd(), rnd(), rnd(), 0]; T.push({ S, y: runStatus(live, ids, spec, S), v: topDraws(S, 8) }); }
  let best = null;
  for (let p = 0; p < 8; p++) {
    const s = T.slice().sort((a, b) => a.v[p] - b.v[p]);
    let ch = 0; for (let i = 1; i < s.length; i++) if (s[i].y !== s[i - 1].y) ch++;
    if (!best || ch < best.ch) best = { p, ch, s };
  }
  if (best.ch !== 1) return null;
  const s = best.s; let i = 1; while (s[i].y === s[0].y) i++;
  let lo = s[i - 1].v[best.p], hi = s[i].v[best.p];
  const lowY = s[0].y;
  const seedAt = (xv) => findSeedPos(Array.from({ length: 8 }, (_, j) => (j === best.p ? [xv, xv] : [0, 65535])), xv + 99);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (runStatus(live, ids, spec, seedAt(m)) === lowY) lo = m; else hi = m; }
  const lowFrac = hi / 65536;
  return lowY === 'blocked' ? lowFrac : 1 - lowFrac;
}
/** the engine's blocked fraction: sample a uniform draw u and feed the engine rand(n) = floor(u * n) */
export function engineBlockedFraction(M, pack, lab, T, spec) {
  const N = 2000; let blocked = 0;
  for (let k = 0; k < N; k++) {
    const u = (k + 0.5) / N;
    const side = (x, mv) => ({ moves: [mv], st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, ty: [T.NORMAL], hp: 600, mhp: 600, ...x });
    const b = lab.lab({ a: side(spec.engA, spec.move), b: side({}, 'Splash') });
    b.rand = (n) => Math.floor(u * n);
    b.drain();
    b.choose(0, { kind: 'move', slot: 0 }); b.choose(1, { kind: 'move', slot: 0 });
    b.advance();
    if (b.s.sides[1].team[0].hp === 600) blocked++;
  }
  return blocked / N;
}
export const CHANCE_PROBES = [
  { label: 'confusion: the confused attacker hits itself', move: 'Body Slam', a: { status2: 3 }, engA: { v: { conf: 3 } } },
  { label: 'paralysis: fully paralysed', move: 'Body Slam', a: { status1: 0x40 }, engA: { s: 5 } },
  { label: 'freeze: stays frozen (does not thaw)', move: 'Body Slam', a: { status1: 0x20 }, engA: { s: 4 } },
];

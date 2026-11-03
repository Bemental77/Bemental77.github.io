// tools/pokemonarena_rom_diff_chance.mjs -- stage FA2 round 3: chance mechanics measured as FRACTIONS of the draw range.
//
// Why a fraction and not a draw-for-draw comparison: the real game fires its chance effects on the HIGH end of its 16-bit draw (Cute Charm and Static
// fire on a draw >= 70 percent of the range, a 20 percent effect on >= 80 percent), the engine fires on the low end (rand(100) < chance).  The two are the
// same distribution mirrored, so the honest check is "what share of all possible draws produces the outcome": the real game's share is found by locating the
// draw position that decides the outcome and bisecting its threshold (the same method as pokemonarena_rom_diff_probes.mjs realBlockedFraction), the
// engine's by sampling.  The two shares must agree to 0.6 percent.  Pure ASCII, no ROM content.

import { engineTurn } from './pokemonarena_rom_diff_turns.mjs';
import { findSeedPos } from './pokemonarena_rom_diff_probes.mjs';

const topDraws = (S, k) => { const out = []; let [a, b, c, n] = S; for (let i = 0; i < k; i++) { const t = (((a + b) >>> 0) + n) >>> 0; out.push(t >>> 16); const a2 = (b ^ (b >>> 9)) >>> 0, b2 = (c + ((c << 3) >>> 0)) >>> 0, c2 = ((((c >>> 11) | (c << 21)) >>> 0) + t) >>> 0; a = a2; b = b2; c = c2; n = (n + 1) >>> 0; } return out; };

/** share (0..1) of the real game's draw range for which pred(observation) is true, or null when no single draw position decides it */
export function realOutcomeFraction(turnLive, live, ids, T, sc, pred) {
  let x = 20211;
  const rnd = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x; };
  const run = (S) => !!pred(turnLive(live, { ...sc, seedState: S }, ids, T));
  const samples = [];
  for (let i = 0; i < 110; i++) { const S = [rnd(), rnd(), rnd(), 0]; samples.push({ y: run(S), v: topDraws(S, 8) }); }
  if (samples.every((s) => s.y === samples[0].y)) return samples[0].y ? 1 : 0;
  // The outcome is decided by ONE draw position, but a few samples (about one in thirty, seen when the oracle's first frames of a turn differ) are decided by another draw:
  // fit the cut that misclassifies the fewest samples, accept it while at most 4 of the 110 are wrong, and bisect it with a majority of three runs per step.
  let best = null;
  for (let p = 0; p < 8; p++) {
    const sorted = samples.slice().sort((a, b) => a.v[p] - b.v[p]);
    const total = sorted.length, yes = sorted.filter((q) => q.y).length;
    let yesLow = 0;
    for (let i = 1; i < total; i++) {
      if (sorted[i - 1].y) yesLow++;
      const errA = yesLow + ((total - i) - (yes - yesLow));   // low side false, high side true
      const errB = (i - yesLow) + (yes - yesLow);             // low side true, high side false
      const err = Math.min(errA, errB);
      if (sorted[i - 1].v[p] === sorted[i].v[p]) continue;
      if (!best || err < best.err) best = { p, err, i, lowY: errB < errA, s: sorted };
    }
  }
  if (!best || best.err > 4) return null;
  const s = best.s;
  let lo = s[best.i - 1].v[best.p], hi = s[best.i].v[best.p];
  const lowY = best.lowY;
  const seedAt = (xv, k) => findSeedPos(Array.from({ length: 8 }, (_, j) => (j === best.p ? [xv, xv] : [0, 65535])), xv + 77 + k * 1013);
  const vote = (xv) => { let n = 0; for (let k = 0; k < 3; k++) if (run(seedAt(xv, k)) === lowY) n++; return n >= 2; };
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (vote(m)) lo = m; else hi = m; }
  const lowFrac = hi / 65536;
  return lowY ? lowFrac : 1 - lowFrac;
}

/** the engine's share: draw u (every rand(n) = floor(u * n)) swept over (0, 1) */
export function engineOutcomeFraction(M, pack, lab, T, sc, pred) {
  const N = 1000; let hit = 0;
  for (let k = 0; k < N; k++) {
    const u = (k + 0.5) / N;
    const r = engineTurn(M, pack, lab, T, { ...sc, drawFrac: u });
    if (r.unsupported) return null;
    if (pred(r)) hit++;
  }
  return hit / N;
}

const mon = (o) => ({ st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 }, types: ['Normal'], ability: null, item: null, status: null, stages: {}, hp: 400, maxhp: 400, ...o });
const S = (label, aMove, a, b, pred, extra) => ({ label, sc: { id: 1, group: 'chance', aMove, bMove: 'Splash', level: 50, a: mon({ ...a, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 500, ...((a || {}).st || {}) } }), b: mon({ ...b, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: 5, ...((b || {}).st || {}) } }), weather: null, screens: [], turns: 1, ...(extra || {}) }, pred });

export const CHANCE_SCENARIOS = [
  S('Static (30 percent) paralyzes a contact attacker', 'Pound', {}, { ability: 'Static' }, (o) => o.st[0] === 5),
  S('Poison Point (30 percent)', 'Pound', {}, { ability: 'Poison Point' }, (o) => o.st[0] === 2),
  S('Flame Body (30 percent)', 'Pound', {}, { ability: 'Flame Body' }, (o) => o.st[0] === 3),
  S('Cute Charm (30 percent) infatuates an opposite-gender attacker', 'Pound', { gender: 'M' }, { gender: 'F', ability: 'Cute Charm' }, (o) => o.inf[0] === 1),
  S('Permafrost (20 percent) gives frostbite', 'Pound', { ability: 'Permafrost' }, {}, (o) => o.st[1] === 7),
  S('Body Slam paralysis (30 percent)', 'Body Slam', {}, {}, (o) => o.st[1] === 5),
  S('Thunderbolt paralysis (10 percent)', 'Thunderbolt', {}, {}, (o) => o.st[1] === 5),
  S('Flamethrower burn (10 percent)', 'Flamethrower', {}, {}, (o) => o.st[1] === 3),
  S('Ice Beam frostbite (10 percent)', 'Ice Beam', {}, {}, (o) => o.st[1] === 7),
  S('Poison Jab poison (30 percent)', 'Poison Jab', {}, {}, (o) => o.st[1] === 2),
  S('Psybeam confusion (10 percent)', 'Psybeam', {}, {}, (o) => o.conf[1] === 1),
  S('infatuation immobilizes (50 percent)', 'Pound', { gender: 'M', inf: true }, { gender: 'F' }, (o) => o.hp[1] === 400),
];

export async function runChanceProbes(turnLive, live, ids, M, pack, lab, T) {
  const rows = [];
  const filt = process.env.ARENA_PROBE_FILTER ? new RegExp(process.env.ARENA_PROBE_FILTER) : null;
  for (const p of CHANCE_SCENARIOS) {
    if (filt && !filt.test(p.label)) continue;
    const real = realOutcomeFraction(turnLive, live, ids, T, p.sc, p.pred);
    const engine = engineOutcomeFraction(M, pack, lab, T, p.sc, p.pred);
    rows.push({ label: p.label, real, engine, ok: real !== null && engine !== null && Math.abs(real - engine) < 0.006 });
  }
  return rows;
}

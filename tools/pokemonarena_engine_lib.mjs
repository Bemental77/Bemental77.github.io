// tools/pokemonarena_engine_lib.mjs -- shared infrastructure for the battle-engine test (stage E1).
//
// loadModules(dir)  imports the engine modules from ANY directory (the real pokemonarena/js, or a mutated copy), so the same
//                   suite can be run against the real source and against every mutant.
// makeLab(M, pack)  builds tiny, fully controlled battles: two (or more) Pokemon whose stats / types / ability / item /
//                   status are overwritten with round numbers so each expected value can be computed by hand.
// Everything here is test infrastructure; nothing is ROM content. Pure ASCII.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RS = process.env.ARENA_RS || 'arena-gen3-standard';   // ARENA_RS=arena-gen3-standard+lv100 fuzzes with all three innate slots active

export async function loadModules(dir, bust = '') {
  const u = (f) => pathToFileURL(path.join(dir, f)).href + bust;
  const names = ['engine', 'rules', 'engine_data', 'engine_calc', 'engine_moves', 'engine_abilities', 'engine_exec', 'engine_items', 'engine_support', 'engine_digest', 'engine_validate', 'stats'];
  const mods = await Promise.all(names.map((n) => import(u(n + '.js'))));
  const M = {};
  names.forEach((n, i) => { M[n] = mods[i]; });
  M.dir = dir;
  return M;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

/** a scripted RNG: values are consumed in order, each must be < n; running out or leftovers are errors. */
export function scripted(vals) {
  const q = vals.slice();
  const fn = (n) => {
    if (!q.length) throw new Error(`rand(${n}) beyond the script`);
    const v = q.shift();
    if (!(v >= 0 && v < n)) throw new Error(`script value ${v} is outside rand(${n})`);
    return v;
  };
  fn.left = () => q.length;
  return fn;
}

export function makeLab(M, pack) {
  const D = M.engine_data.compileData(pack);
  const T = M.engine_data.T;
  const mid = (n) => { const id = D.moveByName[n]; if (id === undefined) throw new Error('no such move ' + n); return id; };
  const abid = (n) => { if (n === 0 || n === undefined || n === null) return 0; if (typeof n === 'number') return n; const id = D.abilityByName[n]; if (id === undefined) throw new Error('no such ability ' + n); return id; };
  const itid = (n) => { if (n === 0 || n === undefined || n === null) return 0; if (typeof n === 'number') return n; const id = D.itemByName[n]; if (id === undefined) throw new Error('no such item ' + n); return id; };

  function monDefaults(side) {
    return { level: 50, st: { atk: 100, def: 100, spa: 100, spd: 100, spe: side === 0 ? 100 : 50 }, hp: 200, mhp: 200, ty: [T.MYSTERY], ab: 0, it: 0 };
  }
  function applyMon(m, x, side) {
    const d = monDefaults(side);
    m.level = x.level !== undefined ? x.level : d.level;
    m.st = Object.assign({}, d.st, x.st || {});
    m.mhp = x.mhp !== undefined ? x.mhp : d.mhp;
    m.hp = x.hp !== undefined ? x.hp : m.mhp;
    m.ty = x.ty ? x.ty.slice() : d.ty;
    m.ab = abid(x.ab);
    if (x.inn) m.inn = x.inn.map(abid); else delete m.inn;   // active innate abilities (the engine sets them from the species + level; the lab sets them by name)
    m.it = itid(x.it);
    m.fnt = m.hp > 0 ? 0 : 1;
    if (x.s !== undefined) m.s = x.s;
    if (x.sc !== undefined) m.sc = x.sc;
    for (const k of Object.keys(m.sg)) m.sg[k] = 0;   // a lab Pokemon starts clean: entry abilities of its species (Intimidate ...) ran in createBattle, the real game's post-write state has none
    if (x.sg) Object.assign(m.sg, x.sg);
    if (x.v) Object.assign(m.v, x.v);
    if (x.pp) m.mv.forEach((mv, i) => { if (x.pp[i] !== undefined) mv.pp = x.pp[i]; });
    if (x.wt !== undefined) m.wt = x.wt;
    if (x.g !== undefined) m.g = x.g; else delete m.g;   // gender: 0 male (omitted), 1 female, 2 none
    if (x.hpt !== undefined) m.hpt = x.hpt;
    if (x.sp !== undefined) m.sp = x.sp;
  }

  /** spec: { a:{moves:[names], bench:[{moves}], st, hp, ty, ab, it, s, sg, v, ...}, b:{...}, seed, pick, wx:[id,turns], tr, sd:[{...},{...}] } */
  function lab(spec = {}) {
    const sides = [spec.a || {}, spec.b || {}];
    const mk = (x) => {
      const rec = M.rules.blankRec(x.species || 25, pack, RS);
      rec.moves = (x.moves || ['Splash']).map(mid);
      return rec;
    };
    const teams = sides.map((x) => [mk(x), ...((x.bench || []).map(mk))]);
    const b = M.engine.createBattle({ pack, ruleset: RS, teams, seed: spec.seed === undefined ? 1 : spec.seed, validate: false, pick: spec.pick || 0 });
    if (!spec.pick) {
      sides.forEach((x, side) => {
        b.s.sides[side].team.forEach((m, i) => applyMon(m, i === 0 ? x : (x.benchSpec || {}), side));
      });
    }
    if (spec.wx) b.s.wx = spec.wx.slice();
    if (spec.tr) b.s.tr = spec.tr;
    if (spec.tn) b.s.tn = spec.tn.slice();   // [terrain id 1..4, turns]
    if (spec.gv) b.s.gv = spec.gv;
    if (spec.pw) b.s.pw = spec.pw;           // primal weather: 6 heavy rain, 7 harsh sun, 8 strong winds           // Gravity turns left
    if (spec.sd) spec.sd.forEach((o, i) => { if (o) Object.assign(b.s.sides[i], o); });
    b.drain();
    return b;
  }

  const must = (r) => { if (!r.ok) throw new Error('choose rejected: ' + r.code); };
  const MV = (slot) => ({ kind: 'move', slot });
  const SW = (slot) => ({ kind: 'switch', slot });

  /** run one turn with optional scripted RNG; returns the new events */
  function turn(b, ca, cb, script) {
    let rnd = null;
    if (script) { rnd = scripted(script); b.rand = rnd; }
    b.drain();
    try {
      if (ca) must(b.choose(0, ca));
      if (cb) must(b.choose(1, cb));
      const ev = b.advance();
      if (rnd && rnd.left() !== 0) throw new Error(`rng script not fully consumed (${rnd.left()} left): the RNG call order changed`);
      return ev;
    } finally { delete b.rand; }
  }
  /** one scenario: build, take one turn, return handles */
  function run(spec, o = {}) {
    const b = lab(spec);
    const ev = turn(b, o.ca === undefined ? MV(0) : o.ca, o.cb === undefined ? MV(0) : o.cb, o.rng);
    return { b, ev, A: b.s.sides[0].team[b.s.sides[0].act], B: b.s.sides[1].team[b.s.sides[1].act], S: b.s };
  }
  const of = (ev, t, pred) => ev.filter((e) => e.t === t && (!pred || pred(e)));
  const lost = (ev, side, src) => ev.filter((e) => e.t === 'damage' && e.s === side && (!src || e.src === src)).reduce((s, e) => s + e.from - e.to, 0);
  const healed = (ev, side) => ev.filter((e) => e.t === 'heal' && e.s === side).reduce((s, e) => s + e.to - e.from, 0);
  const J = (x) => JSON.stringify(x);
  const eq = (got, want) => (J(got) === J(want) ? true : `got ${J(got)} want ${J(want)}`);

  return { lab, turn, run, mid, abid, itid, MV, SW, of, lost, healed, eq, J, D, T, scripted, applyMon };
}

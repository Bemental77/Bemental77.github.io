// tools/pokemonarena_tower_test.mjs -- the POKEMON TOWER's pure logic (pokemonarena/js/tower.js, tower_buffs.js, tower_config.js, achievements.js), in Node, on the REAL engine and ROM pack.
//
//   node tools/pokemonarena_tower_test.mjs             the cases (about half a minute)
//   node tools/pokemonarena_tower_test.mjs --mutants   ALSO break the modules one way at a time; every break must fail a NAMED group of cases (the suite is not vacuous)
//
// What is proved here: the catalogue is what TOWER.md says (families per tier, synergies, tags) and every number a buff produces is the exact arithmetic documented; every op does what its words say to
// real legal teams and never produces a record the ENGINE rejects (property test over random pick sequences of up to 30 picks, then real battles); offers are deterministic in (seed, floor, held buffs), have the
// configured sizes and rarity odds, and never show a dead buff; stacking merges by power points and stops at the cap; every synergy is reachable by a real sequence of offers and picks; the run state machine is
// idempotent and its stored form refuses every hostile edit; the achievements each have a positive and a negative fixture; and the Tower never touches the regular game (import graph, both ways).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const WANT_MUTANTS = process.argv.includes('--mutants');
const ONLY = process.argv.slice(2).filter((a) => /^--only=/.test(a)).map((a) => a.slice(7).split(',')).flat();

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail || ''); } }
const J = (x) => JSON.stringify(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

const imp = (dir, f, bust) => import(pathToFileURL(path.join(dir, f)).href + (bust ? '?x=' + bust : ''));
async function loadStack(dir, bust) {
  const [tables, matchctl, engine, rules, ai, T, B, C, A, ms] = await Promise.all(['tables.js', 'matchctl.js', 'engine.js', 'rules.js', 'ai.js', 'tower.js', 'tower_buffs.js', 'tower_config.js', 'achievements.js', 'match_stats.js'].map((f) => imp(dir, f, bust)));
  return { tables, matchctl, engine, rules, ai, T, B, C, A, ms };
}
const romBytes = fs.readFileSync(ROM_PATH);
const sleepTick = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------------------------------------ fixtures */
let PACK = null;
const teamsFor = (S, n = 6) => Array.from({ length: n }, (_, i) => S.matchctl.randomTeam(PACK, 700 + i * 31, 6, S.C.CONFIG.ruleset));
const mkRun = (S, o = {}) => {
  const recs = o.recs || Array.from({ length: o.n || 3 }, (_, i) => ({ species: 10 + i }));
  return { v: 1, seed: o.seed || 1, format: o.format || '3v3', ruleset: S.C.CONFIG.ruleset, floor: o.floor || 1, phase: o.phase || 'battle', team: { name: 'T', recs, meta: recs.map(() => ({ gender: null, shiny: false })) }, types: o.types || recs.map((_, i) => [i + 1, i + 1]), held: o.held || [], offer: null, history: o.history || [], skips: o.skips || 0, livesUsed: o.livesUsed || 0, folded: false };
};
const W = (n, mod) => Array.from({ length: n }, (_, i) => ({ floor: i + 1, result: 'w', turns: 10, faints: 1, flawless: false, boss: (i + 1) % 10 === 0, comeback: false, sweep: false, closest: null, pick: null, ...(mod ? mod(i + 1) : {}) }));

/* ------------------------------------------------------------------------------------------------ the suite */
async function suite(S, tag, opt = {}) {
  const { T, B, C, A, rules, engine, matchctl, ai } = S;
  const CFG = C.CONFIG;
  const t = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const grp = (g) => !opt.groups || opt.groups.includes(g);
  const N = (full, fast) => (opt.fast ? fast : full);                  // loop sizes: the full suite, and the lighter run each mutant gets
  const teams = ['C', 'D', 'E', 'F', 'H', 'I'].some(grp) ? teamsFor(S) : [];
  const fid = (id) => B.FAMILY_BY_ID[id];
  const best = (rec) => { const b = PACK.species[rec.species].baseStats; return b.atk >= b.spa ? 'atk' : 'spa'; };
  const item = (name) => PACK.items.find((i) => i.name === name).id;

  /* A. the catalogue is what the design says */
  if (grp('A')) {
    const fams = B.FAMILIES, ids = fams.map((f) => f.id);
    ok(fams.length >= 60 && new Set(ids).size === ids.length, t('A1 at least 60 distinct buff families (' + fams.length + ')'), String(fams.length));
    ok(B.CATEGORIES.every((c) => fams.some((f) => f.cat === c)) && fams.every((f) => B.CATEGORIES.includes(f.cat)), t('A2 every category is used and every family is in one'), '');
    ok(J(B.unknownOps()) === '[]', t('A3 every op the catalogue uses is one the interpreter knows'), J(B.unknownOps()));
    const perTier = [0, 1, 2, 3].map((x) => fams.filter((f) => f.tiers[0] <= x && x <= f.tiers[1]).length);
    ok(fams.every((f) => f.tiers[0] <= f.tiers[1] && f.tiers[0] >= 0 && f.tiers[1] <= 3) && perTier.every((n) => n >= 20), t('A4 every tier has at least 20 families to offer (green/blue/purple/gold: ' + perTier.join('/') + ')'), perTier.join('/'));
    const amts = []; const walk = (ops) => { for (const o of ops) { for (const k of Object.keys(o)) { const v = o[k]; if (Array.isArray(v) && typeof v[0] === 'number') amts.push([k, v]); else if (v && typeof v === 'object' && !Array.isArray(v) && ['add', 'set'].includes(k)) for (const q of Object.values(v)) if (Array.isArray(q)) amts.push([k, q]); } if (o.op === 'gamble') { walk(o.then); walk(o.else); } } };
    for (const f of fams) walk(f.ops);
    ok(amts.length > 100 && amts.every(([, v]) => v.length === 4 && v.every(Number.isInteger)), t('A5 every tier-scaled amount has exactly four integer anchors (' + amts.length + ' of them)'), '');
    ok(amts.every(([k, v]) => v.every((x, i) => i === 0 || (k === 'add' && v[0] < 0 ? x <= v[i - 1] : true) && (k === 'ups' || k === 'min' || v[0] < 0 || x >= v[i - 1]) || k === 'max' || k === 'cut' && false)), t('A6 anchors never get weaker as the tier rises (except the IV cap, which falls)'), '');
    const syn = B.SYNERGIES, tagN = {}; for (const f of fams) for (const x of f.tags) tagN[x] = (tagN[x] || 0) + 1;
    ok(syn.length >= 40, t('A7 at least 40 synergies (' + syn.length + '), ' + syn.reduce((n, s) => n + (s.kind === 'tag' ? s.levels.length : 1), 0) + ' with their levels'), String(syn.length));
    const tagOk = syn.filter((s) => s.kind === 'tag').every((s) => s.levels.every((l, i) => i === 0 || l.need > s.levels[i - 1].need) && (tagN[s.tag] || 0) >= Math.max(...s.levels.map((l) => l.need)));
    ok(tagOk, t('A8 every tag synergy has enough families carrying its tag for its top level, and its levels rise'), '');
    ok(syn.filter((s) => s.kind === 'combo').every((s) => new Set(s.needs).size === s.needs.length && s.needs.every((n) => fid(n))) && syn.filter((s) => s.kind === 'mult').every((s) => tagN[s.when.tag] >= s.when.min && tagN[s.boost.tag] >= 1), t('A9 every combo names real families and every multiplier real tags'), '');
    const named = syn.every((s) => (s.kind === 'tag' ? s.levels.every((l) => l.name && l.text && l.text.length <= 90) : s.name && s.text && s.text.length <= 90));
    ok(named && new Set(syn.map((s) => s.id)).size === syn.length, t('A10 every synergy has a visible name and a one-line description'), '');
    ok(syn.filter((s) => s.kind === 'combo').length >= 10 && syn.filter((s) => s.kind === 'mult').length >= 4 && syn.filter((s) => s.kind === 'tag').length >= 20, t('A11 the three kinds are all there: tag sets, named combos, multipliers'), '');
    const texts = fams.every((f) => [0, 1, 2, 3].filter((x) => f.tiers[0] <= x && x <= f.tiers[1]).every((x) => B.familyText(f.id, [1, 2, 4, 8][x]).length > 0));
    ok(texts, t('A12 every family has a non-empty one-line effect at every tier it can be offered at'), '');
    ok(C.TIERS.length === 4 && C.TIERS.map((x) => x.id).join() === 'green,blue,purple,gold' && new Set(C.TIERS.map((x) => x.color)).size === 4 && C.TIERS.map((x) => x.points).join() === '1,2,4,8' && C.BALL_STYLE.length === 4 && new Set(C.BALL_STYLE.map((x) => x.ball)).size === 4, t('A13 four rarity tiers: green, blue, purple, gold, with distinct colours, ball sprites and power points 1 / 2 / 4 / 8'), '');
    ok(fams.every((f) => B.capOf(f) >= [1, 2, 4, 8][f.tiers[1]]), t('A15 no family\'s power cap is below the points of the highest tier it can be offered at (its gold anchors are reachable)'), fams.filter((f) => B.capOf(f) < [1, 2, 4, 8][f.tiers[1]]).map((f) => f.id).join());
    ok(fams.filter((f) => f.curse).length >= 6 && fams.filter((f) => f.tiers[0] === 3 && f.tiers[1] === 3).length >= 5, t('A14 there are risk / reward curses and build-defining gold-only legendaries'), fams.filter((f) => f.curse).length + ' curses');
    // the tables in pokemonarena/TOWER.md are generated from these modules (tools/pokemonarena_tower_doc.mjs): the document cannot say something the code does not
    const D = await imp(path.join(root, 'tools'), 'pokemonarena_tower_doc.mjs'), docText = fs.readFileSync(path.join(root, 'pokemonarena', 'TOWER.md'), 'utf8');
    let docNow = null, docWhy = '';
    try { docNow = D.render(docText, D.blocks({ B, C, A, T })); } catch (e) { docWhy = e.message; }
    ok(docNow === docText && /<!-- BEGIN gen:floors -->/.test(docText) && /<!-- BEGIN gen:families -->/.test(docText), t('A16 the tables in pokemonarena/TOWER.md (counts, floors, odds, families, synergies, achievements, balls) are exactly what the modules generate'), docWhy || 'run: node tools/pokemonarena_tower_doc.mjs');
  }

  /* B. exact arithmetic */
  if (grp('B')) {
    ok([[5, 2, 3], [-5, 2, -2], [7, 2, 4], [-7, 2, -3], [0, 3, 0], [1, 2, 1], [-1, 2, 0]].every(([n, d, w]) => B.roundDiv(n, d) === w), t('B1 roundDiv is round-half-up for positive and negative numerators'), [[5, 2], [-5, 2]].map(([n, d]) => B.roundDiv(n, d)).join());
    ok(B.mulPm(24, 1250) === 30 && B.mulPm(25, 1250) === 31 && B.mulPm(0, 1250) === 0 && B.mulPm(100, 1000) === 100 && B.mulPm(3, 500) === 2, t('B2 mulPm is exact permille arithmetic, rounded half up'), '');
    const a = [24, 40, 64, 100];
    ok([1, 2, 4, 8].map((p) => B.scaleAt(a, p)).join() === '24,40,64,100', t('B3 the four anchors are hit exactly at power 1 / 2 / 4 / 8'), '');
    ok(B.scaleAt(a, 16) === 125 && B.scaleAt(a, 99) === 125 && B.scaleAt(a, 0) === 24, t('B4 the cap anchor is gold x 1.25 and power is clamped to 1..16'), [B.scaleAt(a, 16), B.scaleAt(a, 99), B.scaleAt(a, 0)].join());
    ok(B.scaleAt(a, 3) === 52 && B.scaleAt(a, 6) === 82 && B.scaleAt(a, 12) === 113 && B.scaleAt(7, 5) === 7, t('B5 between anchors it interpolates linearly with half-up rounding (power 3, 6, 12) and a plain number is itself'), [B.scaleAt(a, 3), B.scaleAt(a, 6), B.scaleAt(a, 12)].join());
    let mono = true; for (let p = 2; p <= 16; p++) if (B.scaleAt(a, p) < B.scaleAt(a, p - 1)) mono = false;
    ok(mono, t('B6 a rising amount never gets weaker as power grows'), '');
    ok([[1, 0], [2, 1], [3, 1], [4, 2], [7, 2], [8, 3], [16, 3]].every(([p, w]) => B.tierOfPower(p) === w), t('B7 a family\'s tier is the highest threshold its power reached: 1 green, 2 blue, 4 purple, 8 gold'), '');
  }

  /* C. every op does what its words say, on real legal teams */
  if (grp('C')) {
    const T0 = teams[0].recs;
    const frozen = deepFreeze(clone(T0));
    let threw = null; try { for (const f of B.FAMILIES.slice(0, 40)) B.applyTeam(PACK, frozen, [{ id: f.id, p: 8 }]); B.applyFoe(PACK, frozen, [{ id: 'defang', p: 4 }]); } catch (e) { threw = e; }
    ok(!threw, t('C1 applying buffs never mutates its input (a deep-frozen team goes through 40 families)'), threw && String(threw.message));
    const one = (id, p, recs = T0) => B.applyTeam(PACK, recs, [{ id, p }]);
    const pt = [1, 2, 4, 8].map((p) => one('power-training', p).map((r, i) => r.evs[best(T0[i])] - T0[i].evs[best(T0[i])]));
    ok(pt.every((d, k) => d.every((x, i) => x === Math.min(255 - T0[i].evs[best(T0[i])], [24, 40, 64, 100][k]))), t('C2 Power Training adds exactly 24 / 40 / 64 / 100 EVs to the better attacking stat (capped at 255) at power 1 / 2 / 4 / 8'), J(pt));
    const ex = one('titan-training', 8), gc = one('glass-cannon', 8), dn = one('double-or-nothing', 8);
    ok(ex.every((r) => Object.values(r.evs).every((v) => v === 255)) && gc.every((r, i) => r.evs.hp === 0 && r.evs.def === 0 && r.evs.spd === 0 && r.evs[best(T0[i])] === Math.min(255, T0[i].evs[best(T0[i])] + 220)) && dn.every((r, i) => Object.keys(r.evs).every((k) => r.evs[k] === Math.min(255, T0[i].evs[k] * 2))), t('C3 set, clamp and multiply on EVs: Titan sets all 255, Glass Cannon zeroes the bulk, Double or Nothing doubles (capped)'), '');
    const lo = one('leftovers-all', 1), ch = one('choice-matched', 1), bb = one('berry-bag', 1, T0.map((r, i) => ({ ...r, item: i % 2 ? 0 : r.item }))), av = one('assault-vests', 2);
    ok(lo.every((r) => r.item === item('Leftovers')) && ch.every((r, i) => r.item === item(best(T0[i]) === 'atk' ? 'Choice Band' : 'Choice Specs')), t('C4 item rules: Leftovers for all; Choice Band or Specs matched to the better attacking stat'), '');
    ok(bb.every((r, i) => (i % 2 ? r.item === item('Sitrus Berry') : r.item === T0[i].item)), t('C5 Berry Bag only fills EMPTY hands'), '');
    const atk3 = (r) => r.moves.filter((m) => { const mm = PACK.moves[m.id]; return mm.category !== 2 && mm.power > 0; }).length >= 3;
    ok(av.every((r, i) => (atk3(T0[i]) ? r.item === item('Assault Vest') : r.item === T0[i].item)), t('C6 Assault Vests go only to Pokemon with three or more attacks'), '');
    const nat = (rule, id) => one(id, 1).map((r) => r.nature);
    const nm = (id) => PACK.natures[id];
    ok(nat('attacker', 'nature-coach').every((n, i) => nm(n).up === best(T0[i]) && nm(n).down !== best(T0[i])) && nat('swift', 'swift-natures').every((n) => nm(n).up === 'spe') && nat('sturdy', 'sturdy-natures').every((n, i) => nm(n).up === (best(T0[i]) === 'atk' ? 'def' : 'spd')), t('C7 natures: the attacker, swift and sturdy rules pick the right pair of stats from the nature table'), '');
    const hid = one('hidden-talent', 1);
    ok(hid.every((r, i) => { const a = PACK.species[T0[i].species].abilities[2]; const sup = rules.engineSupports(PACK).abilities.has(a); return a && sup ? r.abilitySlot === 2 : r.abilitySlot === T0[i].abilitySlot; }), t('C8 Hidden Talent switches to the hidden slot only where the species has a hidden ability the engine can run'), '');
    ok(one('pp-boost', 1).every((r) => r.moves.every((m) => m.ppUps >= 1)) && one('pp-boost', 4).every((r) => r.moves.every((m) => m.ppUps >= 3)), t('C9 PP Ups rise to the tier\'s amount and never fall'), '');
    const lowIv = T0.map((r) => ({ ...r, ivs: { hp: 5, atk: 31, def: 12, spa: 0, spd: 31, spe: 20 } }));
    const pg = [one('perfect-genes', 1, lowIv), one('perfect-genes', 8, lowIv)];
    ok(pg[0].every((r) => r.ivs.hp === 10 && r.ivs.atk === 31 && r.ivs.def === 12 && r.ivs.spa === 10 && r.ivs.spe === 20) && pg[1].every((r) => Object.values(r.ivs).every((v) => v === 31)), t('C10 Perfect Genes raises IVs to at least 10 / 20 / 28 / 31 and never lowers one'), J(pg[0][0].ivs));
    // tutors
    const sup = rules.engineSupports(PACK);
    let tutorOk = true, changed = 0, why = '';
    for (const id of ['coverage-tutor', 'stab-tutor', 'first-aid', 'protect-tutor', 'priority-tutor', 'status-tutor', 'setup-tutor', 'power-tutor', 'crit-tutor', 'hazard-tutor', 'type-lessons-fire', 'type-lessons-water', 'grandmaster-tutor']) {
      for (const recs of teams.map((x) => x.recs)) {
        const out = one(id, 8, recs);
        out.forEach((r, i) => {
          const before = recs[i].moves.map((m) => m.id), after = r.moves.map((m) => m.id);
          const legal = new Set(rules.legalMoves(PACK, r.species, r.level, CFG.ruleset));
          const added = after.filter((m) => !before.includes(m));
          if (r.moves.length > 4 || r.moves.length < 1 || new Set(after).size !== after.length) { tutorOk = false; why = id + ': move list shape'; }
          for (const m of added) if (!legal.has(m) || !sup.moves.has(m)) { tutorOk = false; why = id + ': taught an illegal or unsupported move ' + m; }
          if (JSON.stringify(before) !== JSON.stringify(after)) changed++;
          if (after.filter((m) => PACK.moves[m].category !== 2 && PACK.moves[m].power > 0).length < Math.min(2, before.filter((m) => PACK.moves[m].category !== 2 && PACK.moves[m].power > 0).length)) { tutorOk = false; why = id + ': left fewer than two attacks'; }
        });
      }
    }
    ok(tutorOk && changed > 20, t('C11 tutors teach only moves the Pokemon can legally learn and the engine can run, keep 1..4 distinct moves and leave at least two attacks (' + changed + ' Pokemon were changed)'), why);
    const heal = one('first-aid', 1).flatMap((r, i) => r.moves.map((m) => m.id).filter((m) => !T0[i].moves.some((x) => x.id === m)));
    ok(heal.length > 0 && heal.every((m) => ['Recover', 'Roost', 'Soft-Boiled', 'Slack Off', 'Synthesis', 'Moonlight', 'Morning Sun', 'Milk Drink', 'Wish'].includes(PACK.moves[m].name)), t('C12 First Aid teaches only healing moves'), heal.map((m) => PACK.moves[m].name).join());
    // type selectors
    const fireIdx = T0.map((r, i) => (PACK.species[r.species].types.includes(11) ? i : -1)).filter((i) => i >= 0);
    let anyFire = null; for (const tm of teams) { const ix = tm.recs.map((r, i) => (PACK.species[r.species].types.includes(11) ? i : -1)).filter((i) => i >= 0); if (ix.length && ix.length < 6) { anyFire = { recs: tm.recs, ix }; break; } }
    void fireIdx;
    if (!anyFire) { const base = teams[0].recs, fireSp = PACK.roster.find((id) => PACK.species[id].types.includes(11) && PACK.species[id].types[0] !== PACK.species[id].types[1]); anyFire = { recs: base.map((r, i) => (i === 0 ? { ...r, species: fireSp, moves: matchctl.randomTeam(PACK, 5, 1).recs[0].moves } : r)), ix: [0] }; }
    const tf = one('type-training-fire', 4, anyFire.recs);
    ok(tf.every((r, i) => (anyFire.ix.includes(i) ? JSON.stringify(r.evs) !== JSON.stringify(anyFire.recs[i].evs) : JSON.stringify(r) === JSON.stringify(anyFire.recs[i]))), t('C13 a type family changes only the Pokemon that have that type'), anyFire.ix.join());
    // foe side
    const fm = (id, p) => B.foeMods([{ id, p }]);
    ok(fm('intimidating-presence', 1).sizeAdd === -1 && fm('intimidating-presence', 4).sizeAdd === -2 && fm('overwhelming-force', 8).sizeAdd === -2 && fm('double-or-nothing', 2).sizeAdd === 1, t('C14 foe size changes: -1, -2, -2 and +1 (the curse)'), '');
    ok(fm('weak-foes', 1).cutPm === 80 && fm('weak-foes', 8).cutPm === 280 && fm('disarm', 1).noItems && fm('stunted-growth', 2).ivCap === 15 && fm('frail-boss', 4).reliefPm === 1000 && B.foeMods([{ id: 'weak-foes', p: 8 }, { id: 'overwhelming-force', p: 8 }]).cutPm === 680 && B.foeMods([{ id: 'weak-foes', p: 8 }, { id: 'overwhelming-force', p: 8 }, { id: 'dull-natures', p: 8 }]).cutPm === 880 && B.foeMods(['weak-foes', 'overwhelming-force', 'dull-natures', 'disarm', 'stunted-growth'].map((id) => ({ id, p: 16 }))).cutPm === 900, t('C15 foe EV cuts add up (680; 880 once three foe families wake the Intimidator synergy; never more than 90%), IV caps, item removal and boss relief read from the tier'), '');
    const foe0 = matchctl.randomTeam(PACK, 41, 6).recs;
    const af = B.applyFoe(PACK, foe0, [{ id: 'mundane-foes', p: 4 }, { id: 'dull-natures', p: 1 }]);
    ok(af.every((r) => r.abilitySlot === 0 && r.nature === 0), t('C16 Mundane Foes and Dull Natures reset the foe\'s ability slot and nature'), '');
    const df = B.applyFoe(PACK, foe0, [{ id: 'defang', p: 1 }], { salt: 5 });
    const scoreOf = (m) => { const mm = PACK.moves[m.id]; return mm.category !== 2 && mm.power > 0 ? Math.floor(mm.power * (mm.accuracy === 0 ? 100 : mm.accuracy) / 100) : 25; };
    ok(df.every((r, i) => r.moves.length === foe0[i].moves.length && Math.max(...r.moves.map(scoreOf)) <= Math.max(...foe0[i].moves.map(scoreOf))) && df.some((r, i) => J(r.moves) !== J(foe0[i].moves)), t('C17 Defang swaps a foe\'s strongest attack for a weaker legal one and keeps the move count'), '');
    const re = (id, p) => B.runEffects([{ id, p }]);
    ok(re('wider-choice', 4).offer === 2 && re('extra-life', 4).lives === 1 && re('extra-life', 8).lives === 2 && re('boss-bounty', 2).bossOffer === 1 && re('fortune', 3).fortune === 3 && re('fortune', 8).fortune === 5 && re('scouting-report', 1).reveal === true && re('power-training', 8).offer === 0, t('C18 run effects: offer size, extra lives (purple 1, gold 2), boss offers, fortune, scouting'), '');
    // gamble
    const g = [];
    for (let salt = 0; salt < 60; salt++) { const a = B.applyTeam(PACK, T0, [{ id: 'gambler', p: 4 }], { salt }), f = B.applyFoe(PACK, foe0, [{ id: 'gambler', p: 4 }], { salt }); g.push([J(a) !== J(T0), J(f) !== J(foe0)]); }
    ok(g.every(([a, f]) => a !== f) && g.some(([a]) => a) && g.some(([, f]) => f), t('C19 the Gambler\'s coin is one flip per floor for BOTH sides (heads: you gain; tails: the foe does; never both, never neither) and both outcomes occur'), g.filter(([a, f]) => a === f).length + ' disagreements');
    const g1 = B.applyTeam(PACK, T0, [{ id: 'gambler', p: 4 }], { salt: 7 }), g2 = B.applyTeam(PACK, T0, [{ id: 'gambler', p: 4 }], { salt: 7 });
    ok(J(g1) === J(g2), t('C20 the same salt gives the same coin'), '');
    // describe matches the arithmetic
    const txt = B.familyText('power-training', 2);
    ok(/\+40/.test(txt) && /\+30/.test(B.describeOps(fid('power-training').ops, 1, { pm: 1250 })) && B.familyText('weak-foes', 2).includes('13%') && B.familyText('leftovers-all', 1).includes('Leftovers'), t('C21 the effect text carries the exact numbers the interpreter uses (multiplier included)'), txt);
  }

  /* D. synergies */
  if (grp('D')) {
    const H = (...pairs) => pairs.map(([id, p]) => ({ id, p: p || 1 }));
    const names = (held) => B.synergyState(held).active.map((s) => s.id + ':' + s.level);
    const speeds = B.FAMILIES.filter((f) => f.tags.includes('speed')).slice(0, 5).map((f) => [f.id, 1]);
    ok(!names(H(...speeds.slice(0, 2))).some((n) => n.startsWith('tempo')) && names(H(...speeds.slice(0, 3))).includes('tempo:1') && names(H(...speeds.slice(0, 4))).includes('tempo:1') && names(H(...speeds.slice(0, 5))).includes('tempo:2'), t('D1 a tag set switches on exactly at its count: 3 speed families -> Tempo, 5 -> Blitz'), names(H(...speeds)).join());
    ok(!names(H(...speeds.slice(0, 5))).includes('tempo:1'), t('D2 only the highest level of a tag set is active'), '');
    const dup = B.synergyState(H(['power-training', 8], ['speed-training', 8]));
    ok(dup.tags.offense === 1 && dup.tags.speed === 1, t('D3 a family counts ONCE toward a tag however strong it is'), J(dup.tags));
    ok(names(H(['speed-training', 1], ['priority-tutor', 8])).includes('hit-and-run:1') && !names(H(['speed-training', 8])).includes('hit-and-run:1'), t('D4 a named combo needs ALL its families, at any power'), '');
    ok(names(H(['iron-wall', 1], ['mind-shield', 1])).includes('iron-fortress:1') && !names(H(['intimidating-presence', 1], ['weak-foes', 1])).includes('trainer-trouble:1') && names(H(['intimidating-presence', 1], ['weak-foes', 1], ['disarm', 1])).includes('trainer-trouble:1'), t('D5 a three-family combo needs all three'), '');
    const sp2 = H(['speed-training', 1], ['quick-claws', 1], ['power-training', 1]);
    const ba = B.applyTeam(PACK, teams[0].recs, [sp2[2]]), bb = B.applyTeam(PACK, teams[0].recs, sp2.slice().reverse());
    const d0 = ba.map((r, i) => r.evs[best(teams[0].recs[i])] - teams[0].recs[i].evs[best(teams[0].recs[i])]);
    const mult = B.synergyState(sp2).boost['power-training'];
    ok(mult === 1250 && names(sp2).includes('adrenaline:1'), t('D6 two speed families make the offense families 25% stronger (Adrenaline)'), String(mult));
    const dd = bb.map((r, i) => r.evs[best(teams[0].recs[i])] - teams[0].recs[i].evs[best(teams[0].recs[i])]);
    ok(dd.every((x, i) => x >= d0[i]) && B.describeOps(fid('power-training').ops, 1, { pm: 1250 }).includes('+30') && B.mulPm(24, 1250) === 30, t('D7 the multiplier reaches the arithmetic exactly (24 EVs become 30) and the words say so'), J([d0, dd]));
    const tempo = B.applyTeam(PACK, teams[0].recs, H(...speeds.slice(0, 3)));
    const lone = B.applyTeam(PACK, teams[0].recs, H(...speeds.slice(0, 2)));
    ok(tempo.every((r, i) => r.evs.spe >= lone[i].evs.spe), t('D8 an active synergy\'s own effect is applied (Tempo adds Speed EVs on top)'), '');
    ok(J(B.synergyState([]).active) === '[]' && J(B.applyTeam(PACK, teams[0].recs, [])) === J(teams[0].recs), t('D9 no buffs: no synergies and the team comes back unchanged'), '');
    ok(B.SYNERGIES.filter((s) => s.kind === 'mult').every((s) => B.FAMILIES.some((f) => f.tags.includes(s.boost.tag))), t('D10 every multiplier has something to multiply'), '');
  }
  const mkTeamRun = (seed = 4242, format = '3v3', ti = 0) => T.newRun({ pack: PACK, seed, format, team: { name: 'Me', recs: teams[ti].recs, meta: teams[ti].meta } });
  const rr = ai.createRng(20241103);
  const randHeld = (n, maxP) => { const held = []; for (let i = 0; i < n; i++) { const f = B.FAMILIES[rr(B.FAMILIES.length)]; const tier = f.tiers[0] + rr(f.tiers[1] - f.tiers[0] + 1); const h = held.find((x) => x.id === f.id); const p1 = Math.min(B.capOf(f), maxP ? Math.min(maxP, (h ? h.p : 0) + C.TIERS[tier].points) : (h ? h.p : 0) + C.TIERS[tier].points); if (h) h.p = p1; else held.push({ id: f.id, p: p1 }); } return held; };
  const TEAM_OPS = ['ev', 'iv', 'nature', 'ability', 'item', 'pp', 'move'];

  /* E. offers, rarity, stacking */
  if (grp('E')) {
    const base = mkTeamRun();
    const at = (floor, held = [], seed) => ({ ...clone(base), floor, phase: 'offer', held, seed: seed === undefined ? base.seed : seed });
    const O = (run, pack) => T.offerFor(run, { pack: pack || null });
    ok(J(O(at(6))) === J(O(at(6))) && J(O(at(6, [{ id: 'power-training', p: 2 }]))) === J(O(at(6, [{ id: 'power-training', p: 2 }]))), t('E1 the same (seed, floor, held buffs) always gives the same offer'), '');
    const seeds = new Set(); for (let s = 1; s <= 40; s++) seeds.add(J(O(at(6, [], s))));
    ok(seeds.size >= 30 && J(O(at(6))) !== J(O(at(7))), t('E2 a different seed or a different floor gives a different offer (' + seeds.size + ' distinct of 40)'), String(seeds.size));
    const sz = (run) => O(run).length;
    ok(sz(at(2)) === 3 && sz(at(11)) === 5 && sz(at(2, [{ id: 'wider-choice', p: 4 }])) === 5 && sz(at(11, [{ id: 'boss-bounty', p: 2 }])) === 6 && sz(at(11, [{ id: 'wider-choice', p: 16 }, { id: 'boss-bounty', p: 16 }])) === CFG.offer.maxSize && sz(at(3, [{ id: 'wider-choice', p: 16 }])) <= CFG.offer.maxSize, t('E3 offer sizes: 3 on an ordinary floor, 5 after a boss, +2 Wider Choice at purple, +1 Boss Bounty at blue, never above the maximum'), [sz(at(2)), sz(at(11)), sz(at(2, [{ id: 'wider-choice', p: 4 }])), sz(at(11, [{ id: 'boss-bounty', p: 2 }]))].join());
    let bad = '';
    for (let s = 1; s <= 160 && !bad; s++) {
      const floor = 2 + rr(29), held = randHeld(rr(12)), run = at(floor, held, s), off = O(run);
      if (new Set(off.map((o) => o.id)).size !== off.length) bad = 'duplicate family in one offer (seed ' + s + ')';
      for (const o of off) { const f = fid(o.id), h = held.find((x) => x.id === o.id); if (!(f.tiers[0] <= o.tier && o.tier <= f.tiers[1])) bad = o.id + ' offered outside its tiers'; if (h && h.p >= B.capOf(f)) bad = o.id + ' offered at its power cap'; }
      if (off.length < CFG.offer.minSize || off.length > CFG.offer.maxSize) bad = 'offer size ' + off.length;
    }
    ok(!bad, t('E4 every offer has distinct families, each within its tier range and below its power cap, of a legal size (160 random states)'), bad);
    const tiersOf = (run, n) => { const out = []; for (let s = 1; s <= n; s++) for (const o of O({ ...run, seed: s })) out.push(o.tier); return out; };
    const first = tiersOf(at(2), 200);
    ok(first.every((x) => x === 0), t('E5 the first offer (after floor 1) is all green: nothing better is in the odds yet'), J([...new Set(first)]));
    const bossT = []; for (let s = 1; s <= 200; s++) { const off = O(at(11, [], s)); bossT.push(off.map((o) => o.tier)); }
    ok(bossT.every((ts) => ts.every((x) => x >= 1) && ts[0] >= 2), t('E6 a boss offer has no green ball, and its first ball is purple or gold'), '');
    const guar = []; for (const f of [5, 9, 13, 17, 21]) for (let s = 1; s <= 80; s++) guar.push(O(at(f, [], s))[0].tier >= 1);
    ok(guar.every(Boolean), t('E7 every 4th cleared floor guarantees a blue-or-better first ball'), '');
    const early = tiersOf(at(4), 300);
    ok(early.every((x) => x <= 1), t('E8 before floor 5 is cleared there is no purple or gold in the odds'), J([...new Set(early)]));
    const freq = [0, 0, 0, 0], N = 3000; for (let s = 1; s <= N; s++) for (const o of O({ ...at(20), seed: s })) freq[o.tier]++;
    const want = CFG.offer.tierWeights.filter((e) => e.from <= 19).slice(-1)[0].w, tot = freq.reduce((a, b) => a + b, 0);
    ok(freq.every((n, i) => Math.abs(n / tot * 100 - want[i]) < 3), t('E9 the rarity odds on floor 19 match the table within 3 points (' + freq.map((n) => Math.round(n / tot * 100)).join('/') + ' vs ' + want.join('/') + ')'), freq.join());
    const mean = (run) => { const xs = tiersOf(run, 1200); return xs.reduce((a, b) => a + b, 0) / xs.length; };
    ok(mean(at(13, [{ id: 'fortune', p: 8 }])) > mean(at(13)) + 0.15, t('E10 the Fortune family raises the average rarity of an offer'), mean(at(13)).toFixed(2) + ' -> ' + mean(at(13, [{ id: 'fortune', p: 8 }])).toFixed(2));
    // dead buffs are never shown when the pack is known
    let dead = 0, deadWithout = 0, seen = 0;
    for (let s = 1; s <= 100; s++) {
      const run = at(2 + rr(28), randHeld(rr(8)), s);
      for (const o of O(run, PACK)) {
        const f = fid(o.id); if (!f.ops.every((op) => TEAM_OPS.includes(op.op))) continue;
        seen++;
        const h = run.held.find((x) => x.id === o.id), p1 = Math.min(B.capOf(f), (h ? h.p : 0) + C.TIERS[o.tier].points);
        const held1 = h ? run.held.map((x) => (x.id === o.id ? { id: x.id, p: p1 } : x)) : run.held.concat([{ id: o.id, p: p1 }]);
        if (J(B.applyTeam(PACK, base.team.recs, held1)) === J(B.applyTeam(PACK, base.team.recs, run.held))) dead++;
      }
      for (const o of O(run, null)) { const f = fid(o.id); if (!f.ops.every((op) => TEAM_OPS.includes(op.op))) continue; const h = run.held.find((x) => x.id === o.id), p1 = Math.min(B.capOf(f), (h ? h.p : 0) + C.TIERS[o.tier].points); const held1 = h ? run.held.map((x) => (x.id === o.id ? { id: x.id, p: p1 } : x)) : run.held.concat([{ id: o.id, p: p1 }]); if (J(B.applyTeam(PACK, base.team.recs, held1)) === J(B.applyTeam(PACK, base.team.recs, run.held))) deadWithout++; }
    }
    ok(dead === 0 && seen > 100 && deadWithout > 0, t('E11 with the pack known no team buff that would change nothing is ever offered (' + seen + ' balls checked; without the filter ' + deadWithout + ' dead ones appear)'), dead + ' dead, ' + deadWithout + ' unfiltered');
    // picking and merging
    const offerRun = (held, offer) => ({ ...clone(base), floor: 3, phase: 'offer', held, offer, history: [{ floor: 1, result: 'w', turns: 3, faints: 0, flawless: true, boss: false, comeback: false, sweep: false, closest: null, pick: null }, { floor: 2, result: 'w', turns: 3, faints: 0, flawless: true, boss: false, comeback: false, sweep: false, closest: null }] });
    const merge = (p0, tier) => { const r = offerRun(p0 ? [{ id: 'power-training', p: p0 }] : [], [{ id: 'power-training', tier }]); const out = T.takeBuff(r, 'power-training'); return out.run.held[0].p; };
    ok([[1, 0, 2], [2, 1, 4], [4, 2, 8], [8, 3, 16], [16, 3, 16], [3, 0, 4], [6, 3, 14], [0, 2, 4], [0, 3, 8]].every(([p0, tier, want]) => merge(p0, tier) === want), t('E12 the stacking rule: power adds the offered tier\'s points (green 1, blue 2, purple 4, gold 8) and stops at the cap of 16'), [[1, 0], [2, 1], [4, 2], [8, 3], [16, 3]].map(([a, b]) => merge(a, b)).join());
    const ev = T.takeBuff(offerRun([{ id: 'power-training', p: 1 }], [{ id: 'power-training', tier: 0 }]), 'power-training');
    ok(ev.events[0].upgraded === true && ev.events[0].from.tier === 0 && ev.events[0].to.tier === 1 && ev.run.phase === 'battle' && ev.run.offer === null && ev.run.history[ev.run.history.length - 1].pick.id === 'power-training', t('E13 two greens of one family merge into a blue (the event says so), the offer closes and the pick is in the history'), J(ev.events[0]));
    const sk = T.takeBuff(offerRun([], [{ id: 'power-training', tier: 0 }]), null), nsk = T.takeBuff(offerRun([], [{ id: 'power-training', tier: 0 }]), null, { cfg: { ...CFG, offer: { ...CFG.offer, allowSkip: false } } });
    ok(sk.applied && sk.run.skips === 1 && sk.run.held.length === 0 && !nsk.applied, t('E14 a skip takes nothing and is counted; where skipping is switched off it is refused'), '');
    ok(!T.takeBuff(offerRun([], [{ id: 'power-training', tier: 0 }]), 'speed-training').applied && !T.takeBuff({ ...clone(base) }, 'power-training').applied, t('E15 only an offered ball can be taken, and only while an offer is open (nothing is granted automatically)'), '');
    const gain = T.takeBuff(offerRun([{ id: 'speed-training', p: 1 }, { id: 'quick-claws', p: 1 }], [{ id: 'priority-tutor', tier: 0 }]), 'priority-tutor');
    const gs = gain.events[0].synergies.map((s) => s.id + ':' + s.level);
    ok(gs.includes('tempo:1') && gs.includes('hit-and-run:1') && gain.events[0].synergies.every((s) => s.name && s.text) && T.takeBuff(offerRun([{ id: 'speed-training', p: 1 }, { id: 'quick-claws', p: 1 }], [{ id: 'power-training', tier: 0 }]), 'power-training').events[0].synergies.every((s) => s.id !== 'tempo'), t('E16 a pick that completes a synergy reports it by name (a third speed family -> Tempo and Hit and Run); one that does not, reports nothing of the kind'), gs.join());
    const frozenRun = deepFreeze(offerRun([{ id: 'power-training', p: 1 }], [{ id: 'power-training', tier: 0 }]));
    let thr = null; try { T.takeBuff(frozenRun, 'power-training'); T.takeBuff(frozenRun, null); T.recordFloorResult(deepFreeze(clone(base)), { floor: 1, result: 'w', turns: 3, faints: 0 }); } catch (e) { thr = e; }
    ok(!thr, t('E17 picks and results never mutate the run they are given'), thr && String(thr.message));
    ok(T.takeBuff(offerRun([], [{ id: 'apex-predator', tier: 3 }]), 'apex-predator').run.held[0].p === 8 && O(at(3, [{ id: 'apex-predator', p: 8 }], 5)).every((o) => o.id !== 'apex-predator'), t('E18 a build-defining legendary is taken once: at its cap it is no longer offered'), '');
  }

  if (grp('E')) {
    const base2 = mkTeamRun(), capped = B.FAMILIES.slice(0, 100).map((f) => ({ id: f.id, p: B.capOf(f) }));
    let leak = '', short = 0;
    for (let sd = 1; sd <= 60 && !leak; sd++) for (const floor of [3, 11, 20, 30]) {
      const off = T.offerFor({ ...clone(base2), floor, phase: 'offer', held: capped, seed: sd }, { pack: null });
      if (off.length < CFG.offer.minSize) short++;
      for (const o of off) if (capped.some((h) => h.id === o.id)) leak = o.id + ' at floor ' + floor;
    }
    ok(!leak && !short, t('E19 with a hundred families already at their power cap, none of them is ever offered again and an offer can still be filled from the rest'), leak + ' short=' + short);
  }

  /* F. the run machine */
  if (grp('F')) {
    const mk = (n, format) => teams[0].recs.slice(0, n);
    let r1 = null, r2 = null, r3 = null, r4 = null;
    try { T.newRun({ pack: PACK, seed: 1, format: '3v3', team: { name: 'x', recs: mk(2) } }); } catch (e) { r1 = e; }
    try { T.newRun({ pack: PACK, seed: 1, format: '9v9', team: { name: 'x', recs: mk(3) } }); } catch (e) { r2 = e; }
    try { T.newRun({ pack: PACK, seed: 1, format: '3v3', team: { name: 'x', recs: teams[0].recs.map((r) => ({ ...r, evs: { hp: 255, atk: 255, def: 255, spa: 255, spd: 255, spe: 255 } })) } }); } catch (e) { r3 = e; }
    try { T.newRun({ pack: PACK, seed: 1, format: '3v3', team: { name: 'x', recs: [] } }); } catch (e) { r4 = e; }
    ok(r1 instanceof RangeError && r2 instanceof RangeError && r3 instanceof RangeError && r4 instanceof RangeError, t('F1 a run refuses a team too small for the format, an unknown format, an illegal team and an empty one'), [r1, r2, r3, r4].map((e) => e && e.message).join(' | '));
    const orig = clone(teams[0].recs), run = T.newRun({ pack: PACK, seed: 99, format: '3v3', team: { name: 'Me', recs: teams[0].recs, meta: teams[0].meta } });
    teams[0].recs[0].evs.hp = 77; teams[0].recs[0].moves.length = 1;
    ok(run.floor === 1 && run.phase === 'battle' && run.held.length === 0 && run.offer === null && J(run.team.recs) === J(orig), t('F2 a new run is on floor 1, in battle, holds nothing, and snapshots the team (later edits to the saved team do not reach it)'), '');
    teams[0].recs[0].evs.hp = orig[0].evs.hp; teams[0].recs[0].moves = orig[0].moves;
    const fs3 = (f) => T.floorSpec(f, '3v3'), fs6 = (f) => T.floorSpec(f, '6v6');
    ok(J(fs3(1)) === J({ floor: 1, boss: false, cpu: 'easy', size: 3, evPm: 250, evBonus: 0, ivCap: 10, itemMode: 'none' }) && fs3(4).size === 4 && fs3(4).ivCap === 20 && fs3(5).itemMode === 'half' && fs3(7).cpu === 'normal' && fs3(7).ivCap === 26 && fs3(10).boss && fs3(10).size === 6 && fs3(10).cpu === 'hard' && fs3(10).evPm === 700 && fs3(10).evBonus === 30 && fs3(16).evPm === 1000 && fs3(17).cpu === 'hard' && fs3(17).evBonus === 6 && fs3(30).evBonus === 114 && fs6(7).size === 5 && fs6(13).size === 6 && fs3(9).boss === false && fs3(20).boss && fs3(30).boss, t('F3 the floor table is the one in tower_config.js: sizes, CPU levels, EV scaling, IV caps, item modes, bosses on 10 / 20 / 30'), J(fs3(1)));
    let build = true, why = '';
    for (const format of ['3v3', '6v6']) for (let f = 1; f <= CFG.floors; f++) {
      const a = T.floorTrainer(PACK, { seed: 31, format, floor: f }), b = T.floorTrainer(PACK, { seed: 31, format, floor: f });
      if (J(a) !== J(b)) { build = false; why = 'not deterministic at ' + format + ' ' + f; }
      if (!/^[\x20-\x7e]{3,24}$/.test(a.name) || a.recs.length !== a.spec.size || a.meta.length !== a.recs.length || a.boss !== (f % 10 === 0)) { build = false; why = 'trainer shape at ' + format + ' ' + f + ' ' + a.name; }
      if (a.recs.length < (format === '3v3' ? 3 : 2)) { build = false; why = 'trainer too small'; }
      try { engine.createBattle({ pack: PACK, ruleset: CFG.ruleset, teams: [teams[0].recs, a.recs], seed: 1, pick: format === '3v3' ? 3 : 0, validate: false }); } catch (e) { build = false; why = 'engine refused ' + format + ' ' + f + ': ' + e.message; }
    }
    ok(build, t('F4 all ' + CFG.floors * 2 + ' trainers (both formats) are deterministic, named in plain ASCII, the size the table says, and accepted by the engine'), why);
    const evSum = (fl, seedN) => T.floorTrainer(PACK, { seed: seedN, format: '3v3', floor: fl }).recs.reduce((n, r) => n + Object.values(r.evs).reduce((a, b) => a + b, 0), 0) / T.floorTrainer(PACK, { seed: seedN, format: '3v3', floor: fl }).recs.length;
    const avg = (fl) => [1, 2, 3, 4, 5, 6].reduce((n, s) => n + evSum(fl, s), 0) / 6;
    const ivMax = Math.max(...T.floorTrainer(PACK, { seed: 3, format: '3v3', floor: 1 }).recs.flatMap((r) => Object.values(r.ivs)));
    ok(avg(1) < avg(5) && avg(5) < avg(12) && avg(12) < avg(25) && ivMax <= 10 && T.floorTrainer(PACK, { seed: 3, format: '3v3', floor: 2 }).recs.every((r) => r.item === 0) && T.floorTrainer(PACK, { seed: 3, format: '3v3', floor: 12 }).recs.every((r) => r.item > 0), t('F5 trainers get stronger by floor (EVs ' + [1, 5, 12, 25].map((f) => Math.round(avg(f))).join(' < ') + '), early ones have low IVs and no items, later ones hold items'), J([avg(1), avg(5), avg(12), avg(25)]));
    const sizeWith = (floor, format, held) => T.floorTrainer(PACK, { seed: 3, format, floor }, CFG, B.foeMods(held)).recs.length;
    ok(sizeWith(12, '3v3', []) === 5 && sizeWith(12, '3v3', [{ id: 'intimidating-presence', p: 1 }]) === 4 && sizeWith(12, '3v3', [{ id: 'intimidating-presence', p: 8 }]) === 3 && sizeWith(2, '6v6', [{ id: 'intimidating-presence', p: 8 }]) === 2 && sizeWith(2, '3v3', [{ id: 'double-or-nothing', p: 2 }]) === 4 && sizeWith(10, '3v3', [{ id: 'double-or-nothing', p: 16 }]) === 6, t('F6 foe size follows the buffs (5 -> 4 -> 3), never drops below the format\'s minimum (3 for 3v3, 2 for 6v6) and never goes above six'), [sizeWith(12, '3v3', []), sizeWith(12, '3v3', [{ id: 'intimidating-presence', p: 8 }]), sizeWith(2, '6v6', [{ id: 'intimidating-presence', p: 8 }])].join());
    // battle setup
    const held = [{ id: 'power-training', p: 4 }, { id: 'leftovers-all', p: 1 }, { id: 'intimidating-presence', p: 1 }];
    const rb = { ...clone(run), held, floor: 12 };
    const su = T.battleSetup(PACK, rb), su2 = T.battleSetup(PACK, rb), su3 = T.battleSetup(PACK, { ...rb, floor: 13 });
    ok(su.validate === false && su.pick === 3 && su.ruleset === CFG.ruleset && su.names[0] === 'Me' && su.names[1] === su.trainer.name && J(su) === J(su2) && su.seed !== su3.seed && J(rb.team.recs) === J(run.team.recs) && su.player.recs.some((r, i) => J(r) !== J(run.team.recs[i])) && su.foe.recs.length === 5 - 1, t('F7 the battle setup is deterministic, built with validate:false for the right pick, applies the buffs to a COPY (the run\'s team is untouched), and shrinks the foe by the buff'), su.foe.recs.length + ' foes');
    ok(T.battleSetup(PACK, { ...clone(mkTeamRun(5, '6v6')), floor: 3 }).pick === 0, t('F8 a 6v6 setup plays the whole team (pick 0)'), '');
    // results
    const win = (r, floor, o) => T.recordFloorResult(r, { floor, result: 'w', turns: 6, faints: 1, ...(o || {}) }, { pack: PACK });
    const w1 = win(run, 1);
    ok(w1.applied && w1.run.phase === 'offer' && w1.run.floor === 2 && w1.run.offer.length >= 3 && w1.run.history.length === 1 && w1.run.history[0].flawless === false && J(w1.events.map((e) => e.type)) === '["floor-won"]', t('F9 a win opens the offer for the next floor and records the floor'), J(w1.events));
    const again = T.recordFloorResult(w1.run, { floor: 1, result: 'w', turns: 6, faints: 1 }, { pack: PACK }), wrongFloor = T.recordFloorResult(run, { floor: 3, result: 'w', turns: 6, faints: 0 }), bad = T.recordFloorResult(run, { floor: 1, result: 'x', turns: 1, faints: 0 });
    ok(!again.applied && again.run === w1.run && !wrongFloor.applied && !bad.applied, t('F10 a result is applied once: the same result twice, a result for another floor and a nonsense result change nothing'), '');
    const l1 = T.recordFloorResult(run, { floor: 1, result: 'l', turns: 9, faints: 3 }), dr = T.recordFloorResult(run, { floor: 1, result: 'd', turns: 99, faints: 3 }), fo = T.recordFloorResult(run, { floor: 1, result: 'f', turns: 2, faints: 0 });
    ok(l1.run.phase === 'over' && dr.run.phase === 'over' && fo.run.phase === 'over' && J(l1.events) === '[{"type":"run-over","floor":1}]', t('F11 a loss, a draw or a forfeit ends the run'), '');
    const lives = { ...clone(run), held: [{ id: 'extra-life', p: 4 }] }, lost = T.recordFloorResult(lives, { floor: 1, result: 'l', turns: 5, faints: 3 });
    const lost2 = T.recordFloorResult(lost.run, { floor: 1, result: 'l', turns: 5, faints: 3 });
    ok(lost.run.phase === 'battle' && lost.run.floor === 1 && lost.run.livesUsed === 1 && T.livesLeft(lost.run) === 0 && lost.events[0].type === 'life-used' && lost2.run.phase === 'over', t('F12 an Extra Life turns one loss into a retry of the same floor; the next loss ends the run'), J(lost.events));
    const top = { ...clone(run), floor: CFG.floors }, won = T.recordFloorResult(top, { floor: CFG.floors, result: 'w', turns: 8, faints: 0 });
    ok(won.run.phase === 'won' && won.run.offer === null && won.events.some((e) => e.type === 'run-won') && T.abandonRun(won.run).phase === 'won' && T.abandonRun(run).phase === 'over' && T.abandonRun(T.abandonRun(run)).phase === 'over', t('F13 clearing the last floor wins the run (no offer); abandoning ends a run but never un-wins one'), '');
    // a real summary from a real battle
    const su1 = T.battleSetup(PACK, run);
    const ctl = matchctl.createMatchController({ pack: PACK, ruleset: su1.ruleset, teams: [su1.player.recs, su1.foe.recs], seed: su1.seed, pick: su1.pick, names: su1.names, validate: false, sides: [{ kind: 'cpu', level: 'normal', seed: 3 }, { kind: 'cpu', level: su1.cpu.level, seed: su1.cpu.seed }] }); ctl.start();
    const summary = S.ms.summarizeMatch(ctl.battle.events, { viewSide: 0 }), fr = T.floorResultFrom(summary, 1);
    ok(['w', 'l', 'd', 'f'].includes(fr.result) && fr.turns === summary.turns && fr.faints === summary.sides[0].faints && T.recordFloorResult(run, summary).applied, t('F14 a real match summary (match_stats) is accepted as a floor result'), J(fr));
    // whole runs by a bot: every step round-trips through the strict form
    let allOk = true, runsEnded = 0, wonRuns = 0, msg = '', steps = 0;
    for (let sd = 1; sd <= 24 && allOk; sd++) {
      let r = mkTeamRun(1000 + sd, sd % 2 ? '3v3' : '6v6', sd % 6);
      const rg = ai.createRng(sd * 7919);
      let tower = T.emptyTower();
      for (let guard = 0; guard < 200 && r.phase !== 'over' && r.phase !== 'won'; guard++) {
        steps++;
        if (r.phase === 'battle') { const res = T.recordFloorResult(r, { floor: r.floor, result: rg(100) < 88 ? 'w' : 'l', turns: 1 + rg(30), faints: rg(3), comeback: rg(10) === 0 }, { pack: sd % 4 === 0 ? PACK : null }); if (!res.applied) { allOk = false; msg = 'result not applied'; } r = res.run; }
        else { const off = r.offer, pick = rg(5) === 0 ? null : off[rg(off.length)].id; const tk = T.takeBuff(r, pick); if (!tk.applied) { allOk = false; msg = 'pick refused ' + pick; } r = tk.run; }
        const p = T.parseRun(T.serializeRun(r), { pack: sd % 4 === 0 ? PACK : null });
        if (!p.ok || J(p.run) !== J(r)) { allOk = false; msg = 'round trip failed at seed ' + sd + ': ' + (p.why || 'differs'); }
      }
      if (r.phase === 'over' || r.phase === 'won') { runsEnded++; if (r.phase === 'won') wonRuns++; const f = T.foldRunInto(tower, r); tower = f.tower; const again2 = T.foldRunInto(tower, f.run); if (J(again2.tower) !== J(tower) || T.checkTower(tower).length || !f.run.folded) { allOk = false; msg = 'fold: ' + J(T.checkTower(tower)); } }
    }
    ok(allOk && runsEnded >= 20, t('F15 24 whole runs by a bot (' + steps + ' steps, ' + runsEnded + ' finished, ' + wonRuns + ' won): every step survives serialise -> strict parse unchanged, and folding into the Tower record works once'), msg);
    // hostile edits
    let r5 = mkTeamRun(55, '3v3'); r5 = win(r5, 1).run; r5 = T.takeBuff(r5, r5.offer[0].id).run; r5 = win(r5, 2).run;
    const good = T.serializeRun(r5), edit = (fn) => { const x = JSON.parse(good); fn(x); return T.parseRun(JSON.stringify(x), { pack: PACK }); };
    const refused = [
      ['an unknown field', (x) => { x.extra = 1; }], ['a missing field', (x) => { delete x.held; }], ['version 2', (x) => { x.v = 2; }], ['floor 0', (x) => { x.floor = 0; }], ['floor 31', (x) => { x.floor = 31; }], ['a floor that does not match the wins', (x) => { x.floor = 9; }],
      ['an unknown format', (x) => { x.format = '9v9'; }], ['another ruleset', (x) => { x.ruleset = 'arena-gen3-standard+lv100'; }], ['seed -1', (x) => { x.seed = -1; }], ['seed 2^32', (x) => { x.seed = 4294967296; }], ['a phase that does not exist', (x) => { x.phase = 'cheat'; }],
      ['a forged power', (x) => { x.held[0].p = 16; }], ['a held family that does not exist', (x) => { x.held.push({ id: 'god-mode', p: 1 }); }], ['a duplicated held family', (x) => { x.held.push({ ...x.held[0] }); }], ['a free held buff', (x) => { x.held.push({ id: 'titan-training', p: 8 }); }],
      ['a different offer', (x) => { x.offer = [{ id: 'titan-training', tier: 3 }]; }], ['a duplicate in the offer', (x) => { x.offer = [x.offer[0], x.offer[0]]; }], ['an offer outside its tiers', (x) => { x.offer[0].tier = 3; x.offer[0].id = 'scouting-report'; }], ['no offer in the offer phase', (x) => { x.offer = null; }],
      ['a history that skips a floor', (x) => { x.history[1].floor = 3; }], ['a history entry that lies about flawless', (x) => { x.history[0].flawless = !x.history[0].flawless; }], ['a boss flag on floor 1', (x) => { x.history[0].boss = true; }], ['negative turns', (x) => { x.history[0].turns = -1; }], ['a pick with a bad tier', (x) => { x.history[0].pick.tier = 9; }],
      ['skips that do not add up', (x) => { x.skips = 5; }], ['lives that were never earned', (x) => { x.livesUsed = 2; }], ['a team of seven', (x) => { x.team.recs.push(x.team.recs[0]); x.team.meta.push(x.team.meta[0]); x.types.push(x.types[0]); }], ['an EV of 300', (x) => { x.team.recs[0].evs.atk = 300; }], ['an IV of 99', (x) => { x.team.recs[0].ivs.hp = 99; }],
      ['five moves', (x) => { x.team.recs[0].moves.push({ id: 1, ppUps: 0 }, { id: 2, ppUps: 0 }, { id: 3, ppUps: 0 }, { id: 4, ppUps: 0 }); }], ['a PP Up of 9', (x) => { x.team.recs[0].moves[0].ppUps = 9; }], ['a folded flag that is not a boolean', (x) => { x.folded = 'yes'; }], ['types that do not match the team', (x) => { x.types.pop(); }], ['a team too small for 3v3', (x) => { x.team.recs.length = 2; x.team.meta.length = 2; x.types.length = 2; }],
    ];
    const accepted = refused.filter(([, fn]) => edit(fn).ok).map(([n]) => n);
    ok(T.parseRun(good, { pack: PACK }).ok && accepted.length === 0 && !T.parseRun('not json').ok && !T.parseRun('[]').ok && !T.parseRun('null').ok && !T.parseRun(JSON.stringify({ __proto__: null })).ok, t('F16 the strict form accepts the genuine run and refuses all ' + refused.length + ' hostile edits (and non-objects, non-JSON)'), accepted.join(' | '));
    const noPack = (fn) => { const x = JSON.parse(good); fn(x); return T.parseRun(JSON.stringify(x)); };
    ok(noPack(() => {}).ok && !noPack((x) => { x.held[0].p = x.held[0].p === 1 ? 2 : 1; }).ok && !noPack((x) => { x.held.push({ id: 'titan-training', p: 8 }); }).ok && !noPack((x) => { x.held = []; }).ok, t('F20 without the pack to lean on, a forged power, a free buff or a deleted buff is refused by checking the held list against the picks in the history alone'), '');
    ok(T.parseRun(good).ok === true && T.parseRun(JSON.stringify({ ...JSON.parse(good), offer: [{ id: 'titan-training', tier: 3 }] })).ok === true && T.parseRun(JSON.stringify({ ...JSON.parse(good), offer: [{ id: 'titan-training', tier: 0 }] })).ok === false, t('F17 without the pack the offer cannot be re-derived, so only its shape is checked (with the pack a forged offer is refused: see F16)'), '');
    // the Tower record
    const tw = T.emptyTower();
    const ended = T.abandonRun(T.takeBuff(win(mkTeamRun(8, '3v3'), 1).run, null).run);
    const f1 = T.foldRunInto(tw, ended);
    ok(f1.tower.runs === 1 && f1.tower.floors === 1 && f1.tower.best['3v3'] === 1 && f1.tower.wins === 0 && f1.run.folded && T.foldRunInto(f1.tower, f1.run).tower === f1.tower && T.foldRunInto(tw, mkTeamRun(1)).tower === tw && J(T.checkTower(f1.tower)) === '[]', t('F18 a finished run folds into the Tower record exactly once; a run still under way folds into nothing'), J(f1.tower));
    const twBad = [['unknown field', (x) => { x.cheat = 1; }], ['negative runs', (x) => { x.runs = -1; }], ['wins above runs', (x) => { x.wins = 3; x.winsByFormat['3v3'] = 3; }], ['best above the floor count', (x) => { x.best['3v3'] = 99; }], ['an unknown buff in buffsSeen', (x) => { x.buffsSeen.nope = 1; }], ['a bad achievement stamp', (x) => { x.achievements['first-floor'] = 'now'; }], ['wins that disagree with the formats', (x) => { x.wins = 1; }], ['a finished current run', (x) => { x.current = JSON.parse(T.serializeRun(ended)); }]];
    const twAcc = twBad.filter(([, fn]) => { const x = clone(f1.tower); fn(x); return T.checkTower(x).length === 0; }).map(([n]) => n);
    ok(twAcc.length === 0 && T.checkTower(null).length > 0 && T.checkTower([]).length > 0, t('F19 the Tower record\'s strict check refuses all ' + twBad.length + ' hostile edits'), twAcc.join(' | '));
  }

  /* G. achievements: a positive and a negative fixture for every one */
  if (grp('G')) {
    const ACH = A.ACHIEVEMENTS;
    const byGrade = [1, 2, 3, 4].map((g) => ACH.filter((a) => a.grade === g).length);
    ok(ACH.length >= 40 && new Set(ACH.map((a) => a.id)).size === ACH.length && new Set(ACH.map((a) => a.name)).size === ACH.length && ACH.every((a) => a.name && a.desc && /\.$/.test(a.desc) && [1, 2, 3, 4].includes(a.grade) && typeof a.test === 'function') && byGrade.every((n) => n >= 5), t('G1 at least 40 achievements with distinct ids and names, a one-line description each, graded green / blue / purple / gold (' + ACH.length + ': ' + byGrade.join(' / ') + ')'), byGrade.join());
    const reserved = new Set([...B.FAMILIES.map((f) => f.name), ...B.SYNERGIES.flatMap((s) => (s.levels ? s.levels.map((l) => l.name) : [s.name]))]);
    ok(ACH.every((a) => !reserved.has(a.name)), t('G2 no achievement shares a name with a buff or a synergy (the player reads one list of names)'), ACH.filter((a) => reserved.has(a.name)).map((a) => a.name).join());
    const E0 = T.emptyTower(), FL = { flawless: true, faints: 0 }, PK = (id = 'power-training', tier = 0) => ({ id, tier });
    const R = (o) => mkRun(S, o);
    const wr = (n, mod, o) => R({ history: W(n, mod), floor: n + 1, ...(o || {}) });
    const won = (mod, o) => R({ phase: 'won', floor: 30, history: W(30, mod), ...(o || {}) });
    const seen = (n) => ({ ...E0, buffsSeen: Object.fromEntries(B.FAMILIES.slice(0, n).map((f) => [f.id, 1])) });
    const heldN = (n) => B.FAMILIES.slice(0, n).map((f) => ({ id: f.id, p: 1 }));
    const grow = (pred) => { const held = []; let prev = []; for (const f of B.FAMILIES) { prev = held.slice(); held.push({ id: f.id, p: 1 }); if (pred(B.synergyState(held))) return [held.slice(), prev]; } return null; };
    const syn3 = grow((s) => s.active.length >= 3), syn8 = grow((s) => s.active.length >= 8);
    ok(syn3 && syn8, t('G3 (fixture) eight synergies can be active at once'), '');
    const cats = B.CATEGORIES.map((c) => B.FAMILIES.find((f) => f.cat === c).id);
    const curses = B.FAMILIES.filter((f) => f.curse).map((f) => f.id);
    const nb = (stamp) => ({ ...E0, ...stamp });
    const FX = {
      'first-floor': [[wr(1)], [wr(0)]], 'climb-5': [[wr(5)], [wr(4)]], 'climb-15': [[wr(15)], [wr(14)]], 'climb-25': [[wr(25)], [wr(24)]],
      gatekeeper: [[wr(10)], [wr(9)]], warden: [[wr(20)], [wr(19)]], 'tower-master': [[won()], [R({ phase: 'over', history: W(29), floor: 30 })]],
      'flawless-floor': [[wr(3, (i) => (i === 2 ? FL : {}))], [wr(3)]],
      'hat-trick': [[wr(5, (i) => (i >= 2 && i <= 4 ? FL : {}))], [wr(5, (i) => (i !== 3 ? FL : {}))]],
      'flawless-10': [[wr(12, (i) => (i <= 10 ? FL : {}))], [wr(12, (i) => (i <= 9 ? FL : {}))]],
      'untouchable-boss': [[wr(10, (i) => (i === 10 ? FL : {}))], [wr(10, (i) => (i !== 10 ? FL : {}))]],
      'flawless-run': [[won(() => FL)], [won((i) => (i === 18 ? {} : FL))]],
      'no-buff-5': [[wr(5, (i) => (i === 5 ? { pick: PK() } : {}))], [wr(5, (i) => (i === 4 ? { pick: PK() } : {}))]],
      'no-buff-10': [[wr(10, (i) => (i === 10 ? { pick: PK() } : {}))], [wr(10, (i) => (i === 9 ? { pick: PK() } : {}))]],
      'no-buff-win': [[won()], [won((i) => (i === 7 ? { pick: PK() } : {}))]],
      skipper: [[R({ skips: 5 })], [R({ skips: 4 })]],
      'quick-win': [[wr(3, (i) => (i === 2 ? { turns: 4 } : {}))], [wr(3, () => ({ turns: 5 }))]],
      blitz: [[wr(3, (i) => (i === 2 ? { turns: 2 } : {}))], [wr(3, () => ({ turns: 3 }))]],
      'one-turn': [[wr(3, (i) => (i === 2 ? { turns: 1 } : {}))], [wr(3, () => ({ turns: 2 }))]],
      marathon: [[wr(3, (i) => (i === 2 ? { turns: 40 } : {}))], [wr(3, (i) => (i === 2 ? { turns: 39 } : {}))]],
      'win-3v3': [[wr(0), nb({ winsByFormat: { '3v3': 1, '6v6': 0 } })], [wr(0), nb({ winsByFormat: { '3v3': 0, '6v6': 1 } })]],
      'win-6v6': [[wr(0), nb({ winsByFormat: { '3v3': 0, '6v6': 1 } })], [wr(0), nb({ winsByFormat: { '3v3': 1, '6v6': 0 } })]],
      'both-formats': [[wr(0), nb({ winsByFormat: { '3v3': 1, '6v6': 1 } })], [wr(0), nb({ winsByFormat: { '3v3': 2, '6v6': 0 } })]],
      'mono-10': [[wr(10, null, { types: [[11, 11], [11, 13], [7, 11]] })], [wr(10)]],
      'mono-win': [[won(null, { types: [[11, 11], [11, 13], [7, 11]] })], [won()]],
      rainbow: [[wr(10, null, { n: 6 })], [wr(10, null, { n: 6, types: [[1, 1], [1, 2], [2, 2], [3, 3], [4, 4], [5, 5]] })]],
      'collector-10': [[wr(0), seen(10)], [wr(0), seen(9)]], 'collector-30': [[wr(0), seen(30)], [wr(0), seen(29)]], 'collector-60': [[wr(0), seen(60)], [wr(0), seen(59)]],
      completionist: [[wr(0), seen(B.FAMILIES.length)], [wr(0), seen(B.FAMILIES.length - 1)]],
      'hoarder-15': [[R({ held: heldN(15) })], [R({ held: heldN(14) })]],
      fusion: [[wr(2, () => ({ pick: PK('power-training', 1) }), { held: [{ id: 'power-training', p: 4 }] })], [wr(1, () => ({ pick: PK('power-training', 3) }), { held: [{ id: 'power-training', p: 8 }] })]],
      ascension: [[R({ held: [{ id: 'power-training', p: 16 }] })], [R({ held: [{ id: 'power-training', p: 15 }] })]],
      'all-categories': [[wr(cats.length, (i) => ({ pick: PK(cats[i - 1]) }))], [wr(cats.length - 1, (i) => ({ pick: PK(cats[i - 1]) }))]],
      'tier-collector': [[R({ held: [{ id: B.FAMILIES[0].id, p: 1 }, { id: B.FAMILIES[1].id, p: 2 }, { id: B.FAMILIES[2].id, p: 4 }, { id: B.FAMILIES[3].id, p: 8 }] })], [R({ held: [{ id: B.FAMILIES[0].id, p: 1 }, { id: B.FAMILIES[1].id, p: 2 }, { id: B.FAMILIES[2].id, p: 4 }, { id: B.FAMILIES[3].id, p: 5 }] })]],
      'risky-business': [[wr(3, (i) => ({ pick: PK(curses[i - 1]) }))], [wr(2, (i) => ({ pick: PK(curses[i - 1]) }))]],
      synergist: [[R({ held: syn3[0] })], [R({ held: syn3[1] })]], 'synergy-master': [[R({ held: syn8[0] })], [R({ held: syn8[1] })]],
      'combo-lover': [[R({ held: [{ id: 'speed-training', p: 1 }, { id: 'priority-tutor', p: 1 }] })], [R({ held: [{ id: 'speed-training', p: 1 }] })]],
      'comeback-floor': [[wr(3, (i) => (i === 2 ? { comeback: true } : {}))], [wr(3)]], 'sweep-floor': [[wr(3, (i) => (i === 2 ? { sweep: true } : {}))], [wr(3)]],
      'photo-finish': [[wr(3, (i) => (i === 2 ? { closest: 5 } : {}))], [wr(3, (i) => (i === 2 ? { closest: 6 } : {}))]],
      'second-wind': [[R({ livesUsed: 1 })], [R({ livesUsed: 0 })]], phoenix: [[won(null, { livesUsed: 1 })], [won(null, { livesUsed: 0 })]],
      'rock-bottom': [[R({ phase: 'over', history: [] })], [R({ phase: 'over', history: W(1), floor: 2 })]],
      'runs-3': [[wr(0), nb({ runs: 3 })], [wr(0), nb({ runs: 2 })]], 'runs-10': [[wr(0), nb({ runs: 10 })], [wr(0), nb({ runs: 9 })]], 'runs-25': [[wr(0), nb({ runs: 25 })], [wr(0), nb({ runs: 24 })]],
      'wins-3': [[wr(0), nb({ wins: 3, runs: 3 })], [wr(0), nb({ wins: 2, runs: 3 })]], 'tower-veteran': [[wr(0), nb({ floors: 100 })], [wr(0), nb({ floors: 99 })]], 'boss-hunter-10': [[wr(0), nb({ bosses: 10 })], [wr(0), nb({ bosses: 9 })]],
    };
    const unl = (pair) => A.evaluate(pair[0], pair[1] || E0).unlocked;
    const noFix = ACH.filter((a) => !FX[a.id]).map((a) => a.id), orphan = Object.keys(FX).filter((id) => !A.ACHIEVEMENT_BY_ID[id]);
    ok(!noFix.length && !orphan.length, t('G4 every achievement has a fixture pair (and none is for an achievement that does not exist)'), noFix.concat(orphan).join());
    const posBad = ACH.filter((a) => FX[a.id] && !unl(FX[a.id][0]).includes(a.id)).map((a) => a.id), negBad = ACH.filter((a) => FX[a.id] && unl(FX[a.id][1]).includes(a.id)).map((a) => a.id);
    ok(!posBad.length, t('G5 each of the ' + ACH.length + ' achievements is earned by its positive fixture'), posBad.join());
    ok(!negBad.length, t('G6 and none is earned by its negative fixture (one step short of the goal)'), negBad.join());
    // earning is idempotent, stamped by the caller, and never mutates
    const fr = deepFreeze(clone(E0)), run1 = deepFreeze(wr(10));
    const ev1 = A.evaluate(run1, fr), tw1 = A.unlock(fr, ev1.unlocked, 12345);
    ok(ev1.unlocked.includes('first-floor') && ev1.unlocked.includes('gatekeeper') && Object.values(tw1.achievements).every((v) => v === 12345) && A.evaluate(run1, tw1).unlocked.length === 0 && J(A.unlock(tw1, ev1.unlocked, 999)) === J(tw1) && J(A.unlock(tw1, ['nope', 'also-nope'], 1)) === J(tw1) && A.missing(tw1).length === ACH.length - ev1.unlocked.length && A.missing(fr).length === ACH.length, t('G7 evaluating twice earns nothing new, a second unlock keeps the first stamp, unknown ids are ignored, nothing given is mutated'), String(ev1.unlocked.length));
    ok(J(T.checkTower(tw1)) === '[]' && T.checkTower({ ...tw1, achievements: { 'first-floor': 'now' } }).length > 0, t('G8 an unlocked Tower record still passes the strict check (and a bad stamp does not)'), J(T.checkTower(tw1)));
  }

  /* H. the engine, the regular game, and the offer screen */
  if (grp('H')) {
    const R = rules.resolveRuleset(CFG.ruleset), STATK = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
    const mkR = (seed, fmt, ti) => T.newRun({ pack: PACK, seed, format: fmt, team: { name: 'P', recs: teams[ti].recs, meta: teams[ti].meta } });
    const toIds = (recs) => recs.map((r) => ({ ...r, item: r.item || 0, moves: r.moves.map((m) => (typeof m === 'number' ? m : m.id)) }));
    // what the Tower is ALLOWED to bend (and nothing else): the 510 EV total and the one-item-per-team clause
    const ALLOWED = { player: ['ev.total', 'team.item-clause'], foe: ['ev.total', 'team.item-clause'] };
    const problem = (ins, outs, side) => {
      if (outs.length !== ins.length) return 'length ' + outs.length + ' != ' + ins.length;
      for (let i = 0; i < ins.length; i++) {
        const a = ins[i], b = outs[i];
        if (b.species !== a.species || b.level !== a.level || (b.nickname || '') !== (a.nickname || '')) return 'rec ' + i + ' identity changed';
        if (b.moves.some((m) => !Number.isInteger(m.ppUps) || m.ppUps < 0 || m.ppUps > 3)) return 'rec ' + i + ' ppUps';
      }
      const v = rules.validateTeam(toIds(outs), PACK, CFG.ruleset);
      const bad = (v.reasons || []).filter((r) => !ALLOWED[side].includes(r.code));
      return bad.length ? 'validateTeam: ' + bad.slice(0, 2).map((r) => r.code + '@' + r.path).join(',') : '';
    };
    const engineProblem = (setup) => {
      try { engine.createBattle({ pack: PACK, ruleset: CFG.ruleset, teams: [setup.player.recs, setup.foe.recs], seed: setup.seed, pick: setup.pick, names: setup.names, validate: false }); return ''; } catch (e) { return 'engine refused: ' + e.message; }
    };
    const playOut = (setup) => { const ctl = matchctl.createMatchController({ pack: PACK, ruleset: setup.ruleset, teams: [setup.player.recs, setup.foe.recs], seed: setup.seed, pick: setup.pick, names: setup.names, validate: false, sides: [{ kind: 'cpu', level: 'normal', seed: 3 }, { kind: 'cpu', level: setup.cpu.level, seed: setup.cpu.seed }] }); ctl.start(); return ctl; };
    const checkSetup = (run) => {
      const setup = T.battleSetup(PACK, run), tr = T.floorTrainer(PACK, { seed: run.seed, format: run.format, floor: run.floor }, CFG, B.foeMods(run.held));
      return problem(run.team.recs, setup.player.recs, 'player') || problem(tr.recs, setup.foe.recs, 'foe') || engineProblem(setup);
    };
    const digest = () => { const s = JSON.stringify([PACK.species, PACK.moves, PACK.items, PACK.natures, PACK.roster]); let h = 0x811c9dc5; for (let i = 0; i < s.length; i += 7) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h + ':' + s.length; };
    const dig0 = digest();

    // H1: random pick sequences through the REAL machine (real offers, up to 29 picks: a run has 29 offers), then the engine's own validation and real battles
    const SEQS = N(160, 24), battles = N(24, 3);
    let bad1 = '', picksTotal = 0, maxPicks = 0, battled = 0, capBad = '';
    for (let q = 0; q < SEQS && !bad1; q++) {
      const rng = ai.createRng(9000 + q), fmt = q % 2 ? '3v3' : '6v6', ti = q % teams.length, usePack = q % 10 === 0 ? PACK : null;
      let run = mkR(70000 + q, fmt, ti); const snap = J(run.team.recs); let picks = 0;
      const steps = q % 8 === 0 ? 29 : 1 + rng(29);
      for (let k = 0; k < steps && run.phase === 'battle'; k++) {
        run = T.recordFloorResult(run, { floor: run.floor, result: 'w', turns: 5, faints: 0 }, { pack: usePack }).run;
        if (run.phase !== 'offer') break;
        const pick = rng(9) === 0 ? null : run.offer[rng(run.offer.length)].id;
        run = T.takeBuff(run, pick).run; if (pick) picks++;
      }
      picksTotal += picks; maxPicks = Math.max(maxPicks, picks);
      for (const h of run.held) if (!(h.p >= 1 && h.p <= B.capOf(B.FAMILY_BY_ID[h.id]))) capBad = h.id + ' p=' + h.p;
      if (J(run.team.recs) !== snap) bad1 = 'the run\'s own team was changed (seq ' + q + ')';
      const pr = T.parseRun(T.serializeRun(run), { pack: usePack });
      if (!pr.ok) bad1 = bad1 || 'parseRun refused a genuine run: ' + pr.why;
      bad1 = bad1 || (run.phase === 'battle' ? checkSetup(run) : '');
      if (!bad1 && run.phase === 'battle' && q % Math.max(1, Math.floor(SEQS / battles)) === 0) { const ctl = playOut(T.battleSetup(PACK, run)); battled++; if (ctl.winner === null) bad1 = 'a real battle did not finish (seq ' + q + ')'; }
    }
    ok(!bad1, t('H1 ' + SEQS + ' random pick sequences through the real machine (' + picksTotal + ' picks, up to ' + maxPicks + ' in one run): every team and trainer passes the engine\'s own validation (only the EV total and the item clause are bent), the engine builds the battle, ' + battled + ' real battles finish'), bad1);
    ok(!capBad, t('H2 every held family has power between 1 and its cap after every sequence'), capBad);

    // H3: random held sets straight from the stacking rule: up to 30 picks, all 124 families in play, every tier
    let bad3 = '', worst = 0;
    const DIRECT = N(140, 20);
    for (let q = 0; q < DIRECT && !bad3; q++) {
      const rng = ai.createRng(31000 + q), n = q < 4 ? 30 : 1 + rng(30), hist = [];
      for (let k = 0; k < n; k++) { const f = B.FAMILIES[rng(B.FAMILIES.length)], tier = f.tiers[0] + rng(f.tiers[1] - f.tiers[0] + 1); hist.push({ pick: { id: f.id, tier } }); }
      const held = T.heldFromHistory(hist);
      worst = Math.max(worst, held.length);
      if (held.some((h) => h.p > B.capOf(B.FAMILY_BY_ID[h.id]) || h.p < 1) || new Set(held.map((h) => h.id)).size !== held.length) bad3 = 'held out of range';
      const run = { ...clone(mkR(40000 + q, q % 2 ? '3v3' : '6v6', q % teams.length)), held, floor: 1 + rng(30) };
      bad3 = bad3 || checkSetup(run);
    }
    ok(!bad3, t('H3 ' + DIRECT + ' random sets of up to 30 picks (up to ' + worst + ' families at once) are legal for the engine on both sides, and the stacking caps hold'), bad3);

    // H4: the numbers reach the engine, and they are the documented arithmetic
    const oracle = (rec, lvl) => {
      const bs = PACK.species[rec.species].baseStats, nat = PACK.natures.find((x) => x.id === rec.nature), out = {};
      for (const k of STATK) {
        const b = bs[k], inner = Math.floor((2 * b + rec.ivs[k] + Math.floor(rec.evs[k] / 4)) * lvl / 100);
        if (k === 'hp') out.hp = b === 1 ? 1 : inner + lvl + 10;
        else { let s = inner + 5; if (nat && nat.up !== nat.down) { if (nat.up === k) s = Math.floor(s * 110 / 100); else if (nat.down === k) s = Math.floor(s * 90 / 100); } out[k] = s; }
      }
      return out;
    };
    const zero = clone(teams[0].recs).map((r) => ({ ...r, evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } }));
    const zrun = (held) => ({ ...clone(mkR(5, '6v6', 0)), team: { name: 'Z', recs: zero.map((r) => ({ ...r, moves: r.moves.map((m) => ({ ...m })) })), meta: teams[0].meta }, held, floor: 4 });
    const stats = (run) => { const setup = T.battleSetup(PACK, run), b = engine.createBattle({ pack: PACK, ruleset: CFG.ruleset, teams: [setup.player.recs, setup.foe.recs], seed: 1, pick: 0, names: setup.names, validate: false }); return { setup, mons: b.s.sides[0].team }; };
    let exact = true, why4 = '', lift = 0;
    const baseMons = stats(zrun([])).mons;
    for (const [id, p, want] of [['power-training', 2, 40], ['power-training', 8, 100], ['power-training', 16, 125], ['power-training', 3, 52]]) {
      const { setup, mons } = stats(zrun([{ id, p }]));
      for (const m of mons) {
        const rec = setup.player.recs[m.orig], o = oracle(rec, m.level), best = PACK.species[rec.species].baseStats.atk >= PACK.species[rec.species].baseStats.spa ? 'atk' : 'spa';
        if (rec.evs[best] !== want) { exact = false; why4 = id + ' p' + p + ': ' + best + ' EVs ' + rec.evs[best] + ' != ' + want; }
        for (const k of ['atk', 'def', 'spa', 'spd', 'spe']) if (m.st[k] !== o[k]) { exact = false; why4 = id + ' p' + p + ' ' + k + ': engine ' + m.st[k] + ' != formula ' + o[k]; }
        if (m.mhp !== o.hp) { exact = false; why4 = 'hp: engine ' + m.mhp + ' != formula ' + o.hp; }
        if (p === 8 && m.st[best] > baseMons.find((x) => x.orig === m.orig).st[best]) lift++;
      }
    }
    ok(exact && lift > 0, t('H4 a Power Training EV amount (40 / 52 / 100 / 125 at power 2 / 3 / 8 / 16) reaches the engine, and every battle stat and HP equals the documented formula floor((2B+IV+floor(EV/4))*L/100)+5 (HP +L+10, nature 110/90) at level 50'), why4);
    // H5: determinism of a whole battle, and different floors play differently
    const rb = { ...clone(mkR(777, '3v3', 1)), held: [{ id: 'power-training', p: 4 }, { id: 'speed-training', p: 2 }], floor: 6 };
    const a1 = playOut(T.battleSetup(PACK, rb)).info(), a2 = playOut(T.battleSetup(PACK, rb)).info(), a3 = playOut(T.battleSetup(PACK, { ...rb, floor: 7 })).info();
    ok(a1.logHash === a2.logHash && a1.hash === a2.hash && a1.logHash !== a3.logHash && a1.winner !== null, t('H5 a whole tower battle replays identically from the same run state (same log hash) and floor 7 is a different battle from floor 6'), a1.logHash + ' ' + a3.logHash);

    // H6: the regular game never sees a buff
    const R0 = clone(teams[2].recs), reg = () => { const c = matchctl.createMatchController({ pack: PACK, ruleset: CFG.ruleset, teams: [teams[2].recs, teams[3].recs], seed: 4242, pick: 3, names: ['A', 'B'], sides: [{ kind: 'cpu', level: 'normal', seed: 1 }, { kind: 'cpu', level: 'hard', seed: 2 }] }); c.start(); return c.info(); };
    const regA = reg();
    for (const f of B.FAMILIES) { const run = { ...clone(mkR(9, '6v6', 2)), held: [{ id: f.id, p: 8 }], floor: 9 }; T.battleSetup(PACK, run); B.applyTeam(PACK, R0, run.held, { salt: 1 }); }
    const regB = reg();
    ok(regA.logHash === regB.logHash && regA.hash === regB.hash && J(teams[2].recs) === J(R0) && digest() === dig0 && J(B.applyTeam(PACK, R0, [])) === J(R0) && J(T.battleSetup(PACK, mkR(3, '3v3', 0)).player.recs) === J(mkR(3, '3v3', 0).team.recs), t('H6 after the Tower has built a battle with every one of the ' + B.FAMILIES.length + ' families, a regular match on the same teams plays out identically, the ROM tables and the saved teams are byte-for-byte unchanged, and with no buffs the player\'s team is exactly the saved one'), regA.logHash + ' ' + regB.logHash);
    let frozen = '';
    try { const fz = deepFreeze(clone(R0)); for (const f of B.FAMILIES) B.applyTeam(PACK, fz, [{ id: f.id, p: 16 }], { salt: 5 }); B.applyFoe(PACK, deepFreeze(clone(R0)), [{ id: 'weak-foes', p: 8 }, { id: 'gambler', p: 8 }].filter((x) => B.FAMILY_BY_ID[x.id]), { salt: 5 }); } catch (e) { frozen = e.message; }
    ok(!frozen, t('H7 applying any family to a frozen team never writes to its input'), frozen);

    // H8: the import graph, both ways. The Tower pulls in no career / profile / hub / battle-page / online code; none of the regular game pulls the Tower in.
    const DIR = opt.dir || SRC;
    const rd = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
    const code = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const imports = (txt) => { const c = code(txt); return [...c.matchAll(/(?:^|[;\n])\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g), ...c.matchAll(/(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]); };
    const TOWER = { 'tower_config.js': [], 'tower_buffs.js': ['./rules.js', './ai.js', './tower_config.js'], 'achievements.js': ['./tower_config.js', './tower_buffs.js'], 'tower.js': ['./ai.js', './matchctl.js', './rules.js', './tower_config.js', './tower_buffs.js'] };
    const bad8 = [];
    for (const [f, allowed] of Object.entries(TOWER)) {
      const txt = rd(f), imp = imports(txt);
      for (const i of imp) if (!allowed.includes(i)) bad8.push(f + ' imports ' + i);
      if (/\bimport\s*\(/.test(code(txt))) bad8.push(f + ' uses a dynamic import');
      const m = code(txt).match(/\b(localStorage|sessionStorage|indexedDB|document\.|window\.|navigator\.|fetch\(|XMLHttpRequest|Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval|require\()/);
      if (m) bad8.push(f + ' touches the outside world: ' + m[1]);
    }
    ok(!bad8.length, t('H8 the four Tower modules import only the rules, the AI\'s random generator, the match builder and each other, and touch no storage, DOM, clock or Math.random'), bad8.join('; '));
    const TOWER_FILES = Object.keys(TOWER), rest = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !TOWER_FILES.includes(f));
    const badRev = rest.filter((f) => imports(rd(f)).some((i) => /tower|achievements/.test(i)) || /\bimport\s*\(\s*['"][^'"]*(tower|achievements)/.test(code(rd(f))));
    const pages = [path.join(root, 'pokemonarena.html'), ...fs.readdirSync(path.join(root, 'pokemonarena')).filter((f) => /\.(html|css)$/.test(f)).map((f) => path.join(root, 'pokemonarena', f))].filter((p) => fs.existsSync(p));
    const badPages = pages.filter((p) => /tower_buffs|tower_config|tower\.js|achievements\.js/.test(fs.readFileSync(p, 'utf8')));
    ok(rest.length > 40 && !badRev.length && !badPages.length, t('H9 none of the ' + rest.length + ' other modules (career, profile, store, hub, battle page, online, netmatch, scene...) or the pages imports the Tower (Phase 2 will name the hub and battle pages as the only allowed importers)'), badRev.concat(badPages.map((p) => path.basename(p))).join());
    const tw = T.emptyTower(), twJson = J(T.foldRunInto(tw, T.abandonRun(T.takeBuff(T.recordFloorResult(mkR(2, '3v3', 0), { floor: 1, result: 'w', turns: 4, faints: 0 }, { pack: PACK }).run, null).run)).tower);
    ok(!/"(byCpu|totals|recent|stats|online|career|record|matches)"/.test(twJson + J(tw)) && Object.keys(tw).sort().join() === ['achievements', 'best', 'bosses', 'buffsSeen', 'current', 'floors', 'runs', 'v', 'wins', 'winsByFormat'].sort().join(), t('H10 the Tower\'s record is its own: it has no byCpu / totals / recent / online fields, so a tower battle cannot appear in the regular career'), twJson);
    for (const fn of ['recordMatch', 'recordCareer', 'writeCareer', 'saveProfile']) ok(!(fn in T) && !(fn in A) && !(fn in B), t('H11 the Tower modules export no ' + fn), '');

    // H12: the ball art the offer screen names really has those colours (measured on the ROM)
    const am = await imp(DIR, 'anim_mon.js');
    const rom8 = new Uint8Array(romBytes);
    const hueName = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d < 30 || mx < 60) return 'gray'; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = Math.round(((h * 60) + 360) % 360); return h < 20 || h >= 340 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 170 ? 'green' : h < 200 ? 'teal' : h < 260 ? 'blue' : 'purple/pink'; };
    const rgb = (c) => (Array.isArray(c) ? c : typeof c === 'number' ? [(c & 31) << 3, ((c >> 5) & 31) << 3, ((c >> 10) & 31) << 3] : [c.r, c.g, c.b]);
    const dominant = (idx) => { const g = am.ballGfx(rom8, idx); if (!g) return null; const cnt = {}; for (const p of g.frames[0].pixels) if (p) { const h = hueName(rgb(g.palette[p])); if (h !== 'gray') cnt[h] = (cnt[h] || 0) + 1; } return Object.entries(cnt).sort((x, y) => y[1] - x[1])[0][0]; };
    const hues = C.BALL_STYLE.map((b) => dominant(b.ball));
    ok(C.BALL_STYLE.length === 4 && hues[0] === 'green' && hues[1] === 'blue' && hues[2] === 'purple/pink' && ['yellow', 'orange'].includes(hues[3]) && new Set(C.BALL_STYLE.map((b) => b.ball)).size === 4 && C.BALL_STYLE.every((b, i) => b.tier === C.TIERS[i].id && b.ball === C.TIERS[i].ball && b.color === C.TIERS[i].color), t('H12 the four rarity balls are four different sprites from the ROM\'s own ball table and their dominant colours are green / blue / purple / yellow (' + hues.join(', ') + ')'), hues.join());

    // H13: offerView, the data the offer screen draws
    const ovBad = [], seenRar = new Set();
    for (let q = 0; q < N(150, 20); q++) {
      const rng = ai.createRng(5500 + q), held = [], nh = rng(12);
      for (let k = 0; k < nh; k++) { const f = B.FAMILIES[rng(B.FAMILIES.length)]; if (!held.some((h) => h.id === f.id)) held.push({ id: f.id, p: [1, 2, 4, 8][f.tiers[0] + rng(f.tiers[1] - f.tiers[0] + 1)] }); }
      const floor = 2 + rng(29), base = { ...clone(mkR(6000 + q, '3v3', q % teams.length)), held, floor, phase: 'offer' };
      base.offer = T.offerFor(base, { pack: q % 3 ? null : PACK }); base.history = W(floor - 1);
      const v = T.offerView(base, { pack: PACK });
      if (v.balls.length !== base.offer.length || v.cursorStart !== 0 || v.canSkip !== true) ovBad.push('view shape ' + q);
      v.balls.forEach((b, i) => {
        const o = base.offer[i], f = B.FAMILY_BY_ID[o.id], tr = C.TIERS[o.tier], h = held.find((x) => x.id === o.id);
        seenRar.add(b.rarity);
        if (b.id !== o.id || b.name !== f.name || b.rarity !== tr.id || b.color !== tr.color || b.ball !== tr.ball || typeof b.effectText !== 'string' || !b.effectText.length) ovBad.push('ball ' + q + '.' + i);
        if (!Array.isArray(b.synergyProgress) || b.synergyProgress.length > 4 || b.synergyProgress.some((p) => !(p.need > 0 && p.have >= 0 && p.have <= p.need && typeof p.name === 'string' && typeof p.gained === 'boolean'))) ovBad.push('progress ' + q + '.' + i);
        const wantTo = Math.min(B.capOf(f), (h ? h.p : 0) + tr.points);
        if (h ? !(b.stacksInto && b.stacksInto.from.power === h.p && b.stacksInto.to.power === wantTo && /->/.test(b.stacksInto.text)) : b.stacksInto !== null) ovBad.push('stacksInto ' + q + '.' + i);
      });
    }
    ok(!ovBad.length && seenRar.size >= 3, t('H13 offerView gives every ball its id, name, rarity colour, ROM ball, effect text, synergy progress and what it stacks into, for 150 offers (rarities seen: ' + [...seenRar].join('/') + ')'), ovBad.slice(0, 3).join('; '));
    const fire = B.FAMILIES.filter((f) => f.cat === 'type' && f.tags.includes('fire')).map((f) => f.id);
    const fv = (nHeld) => { const r = { ...clone(mkR(11, '3v3', 0)), held: fire.slice(0, nHeld).map((id) => ({ id, p: 1 })), phase: 'offer', floor: 3, history: W(2) }; r.offer = [{ id: fire[nHeld], tier: 0 }]; return T.offerView(r, { pack: PACK }).balls[0].synergyProgress.find((p) => p.id === 'affinity-fire'); };
    const f0 = fv(0), f1 = fv(1), f2 = fv(2);
    ok(fire.length === 3 && f0 && f0.have === 1 && f0.need === 2 && !f0.gained && f1 && f1.have === 2 && f1.need === 2 && f1.gained && f2 && f2.have === 3 && f2.need === 3 && f2.gained && /Fire/.test(f2.name), t('H14 the info box shows synergy progress the way the design says: a first Fire buff reads 1/2, a second completes Fire Affinity (2/2), a third completes Fire Mastery (3/3)'), J([f0, f1, f2]));
  }

  /* I. reachability: every synergy by a real sequence of offers and picks; every buff offerable */
  if (grp('I')) {
    const mkR = (seed, ti) => T.newRun({ pack: PACK, seed, format: '3v3', team: { name: 'R', recs: teams[ti].recs, meta: teams[ti].meta } });
    const targets = [];
    for (const s of B.SYNERGIES) {
      if (s.kind === 'tag') s.levels.forEach((l, i) => targets.push({ s, level: i + 1, tag: s.tag }));
      else if (s.kind === 'combo') targets.push({ s, level: 1, fams: s.needs });
      else targets.push({ s, level: 1, tag: s.when.tag });
    }
    const relevant = (tg, f, held) => !held.some((h) => h.id === f.id) && (tg.fams ? tg.fams.includes(f.id) : f.tags.includes(tg.tag));
    const reach = (tg, maxSeeds) => {
      for (let seed = 1; seed <= maxSeeds; seed++) {
        let run = mkR(seed * 7 + 1, seed % teams.length);
        for (let k = 0; k < 29 && run.phase === 'battle'; k++) {
          run = T.recordFloorResult(run, { floor: run.floor, result: 'w', turns: 5, faints: 0 }).run;
          if (run.phase !== 'offer') break;
          const ball = run.offer.find((o) => relevant(tg, fid(o.id), run.held));
          run = T.takeBuff(run, ball ? ball.id : null).run;
          if (B.synergyState(run.held).active.some((a) => a.id === tg.s.id && a.level === tg.level)) return { seed, picks: run.held.length, floor: run.floor - 1 };
        }
      }
      return null;
    };
    const missing = [], found = []; let hardest = 0;
    for (const tg of targets) { const r = reach(tg, N(6000, 300)); if (r) { found.push(r); hardest = Math.max(hardest, r.seed); } else missing.push(tg.s.id + ':' + tg.level); }
    ok(!missing.length, t('I1 all ' + targets.length + ' synergy levels of ' + B.SYNERGIES.length + ' synergies are reached by a legal sequence of real offers and picks (hardest needed ' + hardest + ' seeds, at most ' + Math.max(0, ...found.map((r) => r.picks)) + ' picks)'), missing.join());
    // every buff family can appear in a real offer for a real team (the "would change nothing" filter included)
    // the filter hides a buff that would change nothing FOR THIS TEAM (a Bug-type lesson for a team with no Bug-type, 31 IVs for a team that has them), so the scan uses a spread of teams: random ones, half with lower IVs
    const scanTeams = Array.from({ length: N(40, 8) }, (_, i) => { const tm = matchctl.randomTeam(PACK, 500 + i * 17, 6, CFG.ruleset); if (i % 2) for (const r of tm.recs) for (const k of Object.keys(r.ivs)) r.ivs[k] = Math.max(0, r.ivs[k] - 11); return tm; });
    const offered = new Map(), scanRun = (s, floor) => ({ ...clone(T.newRun({ pack: PACK, seed: s * 13, format: '3v3', team: { name: 'S', recs: scanTeams[s % scanTeams.length].recs, meta: scanTeams[s % scanTeams.length].meta } })), floor, phase: 'offer', held: [] });
    const scan = (s, floor) => { for (const o of T.offerFor(scanRun(s, floor), { pack: PACK })) { if (!offered.has(o.id)) offered.set(o.id, new Set()); offered.get(o.id).add(o.tier); } };
    for (let s = 1; s <= N(120, 16); s++) for (const floor of [3, 6, 11, 14, 19, 21, 26, 30]) scan(s, floor);
    // a family that is rare (a gold-only legendary) is searched for on the floors that favour it, until it turns up
    if (!opt.fast) for (const f of B.FAMILIES) for (let s = 1000; !offered.has(f.id) && s < 5000; s++) scan(s, [30, 26, 21, 19][s % 4]);
    const never = B.FAMILIES.filter((f) => !offered.has(f.id)).map((f) => f.id), outside = [...offered].filter(([id, ts]) => [...ts].some((x) => x < fid(id).tiers[0] || x > fid(id).tiers[1])).map(([id]) => id);
    ok(!outside.length && (opt.fast || !never.length), t('I2 every one of the ' + B.FAMILIES.length + ' families shows up in real offers (with the dead-buff filter on) and only at tiers it allows'), 'never: ' + never.join() + ' outside: ' + outside.join());
    const perTier = [0, 1, 2, 3].map((tt) => B.FAMILIES.filter((f) => f.tiers[0] <= tt && tt <= f.tiers[1]).length);
    ok(perTier.every((n) => n >= 40) && perTier[0] + perTier[1] + perTier[2] + perTier[3] > B.FAMILIES.length, t('I3 offerable families per tier: green ' + perTier[0] + ' / blue ' + perTier[1] + ' / purple ' + perTier[2] + ' / gold ' + perTier[3]), perTier.join());
  }
  void sleepTick;
}

/* ------------------------------------------------------------------------------------------------ the mutants */
// Each mutant breaks ONE guarantee in a private copy of pokemonarena/js. The groups named must then fail at least one case; if none does, the suite is not testing that guarantee.
const MUTANTS = [
  // exact arithmetic
  { id: 'roundDiv-floors', why: 'rounding goes down instead of half up', file: 'tower_buffs.js', from: 'export const roundDiv = (n, d) => Math.floor((2 * n + d) / (2 * d));', to: 'export const roundDiv = (n, d) => Math.floor(n / d);', groups: ['B'] },
  { id: 'tier-threshold', why: 'gold starts at power 9, not 8', file: 'tower_buffs.js', from: 'export const tierOfPower = (p) => (p >= 8 ? 3 :', to: 'export const tierOfPower = (p) => (p >= 9 ? 3 :', groups: ['B'] },
  { id: 'cap-anchor-lost', why: 'the power cap adds nothing over gold', file: 'tower_buffs.js', from: 'mulPm(amt[3], cfg.capBonusPm)', to: 'amt[3]', groups: ['B'] },
  { id: 'ev-clamp-removed', why: 'EVs can pass 255', file: 'tower_buffs.js', from: 'r.evs[s] = clamp(r.evs[s] + n, 0, 255);', to: 'r.evs[s] = r.evs[s] + n;', groups: ['C', 'H'] },
  { id: 'selector-ignores-type', why: 'a type family changes every Pokemon', file: 'tower_buffs.js', from: 'return all.filter((i) => typesOf(pack, recs[i]).includes(t));', to: 'return all;', groups: ['C'] },
  { id: 'hidden-slot-unchecked', why: 'Hidden Talent switches to a slot the species does not have', file: 'tower_buffs.js', from: 'if (a && supOf(pack).abilities.has(a)) recs[i].abilitySlot = op.slot;', to: 'recs[i].abilitySlot = op.slot;', groups: ['C', 'H'] },
  { id: 'applyTeam-mutates', why: 'applying buffs rewrites the saved team', file: 'tower_buffs.js', from: 'export function applyTeam(pack, recs, held, o = {}) {\n  const ctx = ctxOf(pack, o), out = clone(recs);', to: 'export function applyTeam(pack, recs, held, o = {}) {\n  const ctx = ctxOf(pack, o), out = recs;', groups: ['C', 'H'] },
  { id: 'tutor-slot', why: 'a taught move always replaces the first move', file: 'tower_buffs.js', from: '  if (rec.moves.length < 4) return rec.moves.length;\n', to: '  if (rec.moves.length < 4) return rec.moves.length;\n  if (rec.moves.length === 4) return 0;\n', groups: ['C'] },
  { id: 'gamble-ignores-salt', why: 'the coin lands the same way every floor', file: 'tower_buffs.js', from: 'createRng(((ctx.salt >>> 0) ^ fnv(id)) >>> 0)(1000)', to: 'createRng(fnv(id) >>> 0)(1000)', groups: ['C'] },
  { id: 'foe-cut-uncapped', why: 'foe EV cuts can pass 90%', file: 'tower_buffs.js', from: '  m.cutPm = Math.min(900, m.cutPm);\n', to: '', groups: ['C'] },
  { id: 'foe-items-kept', why: 'Disarm strips nothing', file: 'tower_buffs.js', from: "else if (op.op === 'foe-items' && op.mode === 'none') m.noItems = true;", to: "else if (op.op === 'foe-items' && op.mode === 'none') m.noItems = false;", groups: ['C', 'F'] },
  { id: 'describe-omits-multiplier', why: 'the words show the amount without the synergy multiplier', file: 'tower_buffs.js', from: 'A = (v) => mulPm(scaleAt(v, power, cfg), pm), N = (v) => scaleAt(v, power, cfg), out = [];', to: 'A = (v) => scaleAt(v, power, cfg), N = (v) => scaleAt(v, power, cfg), out = [];', groups: ['C', 'D'] },
  // synergies
  { id: 'synergy-off-by-one', why: 'a tag set switches on one family late', file: 'tower_buffs.js', from: 'if (n >= l.need) hit = { l, i };', to: 'if (n > l.need) hit = { l, i };', groups: ['D'] },
  { id: 'lowest-level-wins', why: 'the lowest tag level is shown instead of the highest', file: 'tower_buffs.js', from: 'if (n >= l.need) hit = { l, i };', to: 'if (n >= l.need && !hit) hit = { l, i };', groups: ['D'] },
  { id: 'multiplier-ignored', why: 'a multiplier synergy multiplies nothing', file: 'tower_buffs.js', from: 'boost[h.id] = Math.min(2000, mulPm(boost[h.id] || 1000, s.boost.pm));', to: 'boost[h.id] = 1000;', groups: ['D'] },
  { id: 'combo-needs-some', why: 'a combo needs only one of its families', file: 'tower_buffs.js', from: 's.needs.every((n) => have.has(n))', to: 's.needs.some((n) => have.has(n))', groups: ['D'] },
  { id: 'strong-counts-twice', why: 'a strong family counts twice toward a tag', file: 'tower_buffs.js', from: 'for (const t of f.tags) tags[t] = (tags[t] || 0) + 1;', to: 'for (const t of f.tags) tags[t] = (tags[t] || 0) + (h.p >= 4 ? 2 : 1);', groups: ['D'] },
  // offers and stacking
  { id: 'offer-seed-ignored', why: 'every run is offered the same balls', file: 'tower.js', from: 'rng = createRng(mix(run.seed, cleared, 0x0ffe5))', to: 'rng = createRng(mix(1, cleared, 0x0ffe5))', groups: ['E'] },
  { id: 'at-cap-offered', why: 'a family at its power cap is offered again', file: 'tower.js', from: 'heldPower(run.held, f.id) < capOf(f, cfg));', to: 'true);', groups: ['E'] },
  { id: 'boss-guarantee-removed', why: 'a boss offer can be all blue', file: 'tower.js', from: 'const floorTier = boss ? cfg.offer.bossGuaranteeTier :', to: 'const floorTier = boss ? 0 :', groups: ['E'] },
  { id: 'guarantee-not-applied', why: 'the guaranteed first ball is never raised', file: 'tower.js', from: '    if (i === 0) tier = Math.max(tier, floorTier);\n', to: '', groups: ['E'] },
  { id: 'boss-offer-size', why: 'a boss offer is as small as an ordinary one', file: 'tower.js', from: '(boss ? cfg.offer.bossSize + eff.bossOffer : cfg.offer.size) + eff.offer', to: '(cfg.offer.size + (boss ? eff.bossOffer : 0)) + eff.offer', groups: ['E'] },
  { id: 'weights-ignore-floor', why: 'the rarity table is always its last row', file: 'tower.js', from: 'for (const e of table) if (cleared >= e.from) w = e.w.slice();', to: 'for (const e of table) w = e.w.slice();', groups: ['E'] },
  { id: 'fortune-does-nothing', why: 'Fortune does not move the odds', file: 'tower.js', from: 'clamp(fortune * cfg.offer.rareShiftPm, 0, 900)', to: 'clamp(0 * fortune, 0, 900)', groups: ['E'] },
  { id: 'dead-buffs-offered', why: 'a buff that changes nothing is offered', file: 'tower.js', from: 'function isUseful(pack, run, f, tier, cfg, memo) {\n', to: 'function isUseful(pack, run, f, tier, cfg, memo) {\n  return true;\n', groups: ['E'] },
  { id: 'stack-adds-one', why: 'taking a family twice adds one point whatever its colour', file: 'tower.js', from: 'p0 + TIERS[o.tier].points), before', to: 'p0 + 1), before', groups: ['E'] },
  { id: 'stack-no-cap', why: 'power has no cap', file: 'tower.js', from: 'p1 = Math.min(capOf(f, cfg), p0 + TIERS[o.tier].points), before', to: 'p1 = p0 + TIERS[o.tier].points, before', groups: ['E', 'F'] },
  { id: 'pick-not-recorded', why: 'the history forgets what was picked', file: 'tower.js', from: 'last.pick = { id, tier: o.tier };', to: 'last.pick = null;', groups: ['F'] },
  { id: 'history-cap-lost', why: 'a stored run can hold power above the cap', file: 'tower.js', from: 'p1 = Math.min(capOf(f, cfg), p0 + TIERS[h.pick.tier].points); if (p0)', to: 'p1 = p0 + TIERS[h.pick.tier].points; if (p0)', groups: ['H'] },
  // the run
  { id: 'boss-floors', why: 'bosses fall on the wrong floors', file: 'tower.js', from: 'floor >= 1 && floor % cfg.bossEvery === 0;', to: 'floor >= 1 && floor % (cfg.bossEvery + 1) === 0;', groups: ['E', 'F'] },
  { id: 'foe-size-ignores-buffs', why: 'Intimidating Presence does not shrink the trainer\'s team', file: 'tower.js', from: 'const size = clamp(spec.size + m.sizeAdd, cfg.minFoe[format], 6);', to: 'const size = clamp(spec.size, cfg.minFoe[format], 6);', groups: ['F'] },
  { id: 'result-guard-removed', why: 'a result for any floor or phase is applied', file: 'tower.js', from: "if (run.phase !== 'battle' || res.floor !== run.floor) return {", to: 'if (false) return {', groups: ['F'] },
  { id: 'loss-keeps-going', why: 'a lost floor does not end the run', file: 'tower.js', from: "else { r.phase = 'over'; events.push({ type: 'run-over', floor: run.floor }); }", to: "else { events.push({ type: 'run-over', floor: run.floor }); }", groups: ['F'] },
  { id: 'life-not-spent', why: 'an extra life is never used up', file: 'tower.js', from: 'r.livesUsed += 1;', to: 'r.livesUsed += 0;', groups: ['F'] },
  { id: 'last-floor-off-by-one', why: 'clearing the top floor does not win', file: 'tower.js', from: 'if (run.floor >= cfg.floors) { r.phase = \'won\';', to: 'if (run.floor > cfg.floors) { r.phase = \'won\';', groups: ['F'] },
  { id: 'validate-flag', why: 'tower battles are built with the regular validation (and so refuse any buffed team)', file: 'tower.js', from: 'validate: false, seed: mix(run.seed, run.floor, 0xb477)', to: 'validate: true, seed: mix(run.seed, run.floor, 0xb477)', groups: ['F'] },
  // the stored form
  { id: 'parse-forged-held', why: 'a stored run\'s buffs are not checked against its picks', file: 'tower.js', from: "if (JSON.stringify(rebuilt) !== JSON.stringify(r.held)) return bad('held buffs do not match the picks');", to: '', groups: ['F'] },
  { id: 'parse-unknown-field', why: 'a stored run may carry extra fields', file: 'tower.js', from: "for (const k of Object.keys(r)) if (!RUN_KEYS.includes(k)) return bad('unknown field ' + k);", to: '', groups: ['F'] },
  { id: 'parse-offer-not-rederived', why: 'a stored offer is believed, not re-derived from the seed', file: 'tower.js', from: "if (pack && JSON.stringify(offerFor(r, { pack, cfg })) !== JSON.stringify(r.offer)) return bad('the offer is not the one this seed gives');", to: '', groups: ['F'] },
  { id: 'fold-twice', why: 'a run can be folded into the record more than once', file: 'tower.js', from: "if ((run.phase !== 'over' && run.phase !== 'won') || run.folded) return { tower, run };", to: "if (run.phase !== 'over' && run.phase !== 'won') return { tower, run };", groups: ['F'] },
  // achievements
  { id: 'streak-never-resets', why: 'a flawless streak survives a floor that was not flawless', file: 'achievements.js', from: 'streak = h.flawless ? streak + 1 : 0;', to: 'streak = streak + 1;', groups: ['G'] },
  { id: 'no-buff-off-by-one', why: 'the pick after the target floor counts against "no buff"', file: 'achievements.js', from: 'wins.slice(0, n - 1).every(', to: 'wins.slice(0, n).every(', groups: ['G'] },
  { id: 'evaluate-repeats', why: 'an achievement already held is earned again', file: 'achievements.js', from: 'A.filter((a) => !(a.id in have) && a.test(facts))', to: 'A.filter((a) => a.test(facts))', groups: ['G'] },
  { id: 'unlock-restamps', why: 'a second unlock overwrites the first stamp', file: 'achievements.js', from: 'if (ACHIEVEMENT_BY_ID[id] && !(id in t.achievements)) t.achievements[id] = at;', to: 'if (ACHIEVEMENT_BY_ID[id]) t.achievements[id] = at;', groups: ['G'] },
  // the offer screen, the regular game, the import graph
  { id: 'view-no-stacking', why: 'the info box never says what a ball stacks into', file: 'tower.js', from: 'stacksInto: p0 ? {', to: 'stacksInto: false ? {', groups: ['H'] },
  { id: 'ball-sprite-shared', why: 'gold and purple use the same ball sprite', file: 'tower_config.js', from: "color: '#ffca28', ball: 13", to: "color: '#ffca28', ball: 4", groups: ['H'] },
  { id: 'tower-record-has-career-fields', why: 'the Tower\'s record grows a per-CPU career table', file: 'tower.js', from: 'export const emptyTower = () => ({ v: TOWER_VERSION,', to: 'export const emptyTower = () => ({ byCpu: {}, v: TOWER_VERSION,', groups: ['H', 'F'] },
  { id: 'view-no-progress', why: 'the info box never shows synergy progress', file: 'tower.js', from: 'synergyProgress: progress.slice(0, 4),', to: 'synergyProgress: [],', groups: ['H'] },
  { id: 'skip-not-gated', why: 'a skip is accepted where the config forbids it', file: 'tower.js', from: "if (!cfg.offer.allowSkip) return { run, applied: false, events: [], why: 'skipping is not allowed' };", to: '', groups: ['E'] },
  { id: 'tower-reads-the-clock', why: 'the Tower reads the wall clock', file: 'tower.js', from: 'export const RUN_VERSION = 1;', to: 'export const RUN_VERSION = 1;\nconst __startedAt = Date.now();', groups: ['H'] },
  { id: 'tower-imports-career', why: 'a Tower module imports the career code', file: 'tower.js', from: "import { createRng } from './ai.js';", to: "import { createRng } from './ai.js';\nimport './career_stats.js';", groups: ['H'] },
  { id: 'regular-game-imports-tower', why: 'the regular match builder imports the Tower', file: 'matchctl.js', from: "import { createAi, createRng } from './ai.js';", to: "import { createAi, createRng } from './ai.js';\nimport { floorSpec as __floorSpec } from './tower.js';", groups: ['H'] },
];

async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-tower-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file);
      const text = fs.readFileSync(target, 'utf8');
      const n = typeof mu.from === 'string' ? text.split(mu.from).length - 1 : (mu.from.test(text) ? 1 : 0);
      if (n !== 1) { out.push({ id: mu.id, killed: false, why: 'THE MUTANT DID NOT APPLY (pattern found ' + n + 'x)' }); continue; }
      fs.writeFileSync(target, typeof mu.from === 'string' ? text.replace(mu.from, () => mu.to) : text.replace(mu.from, mu.to));
      const before = { pass, fail, nf: failures.length };
      const saveQ = process.env.ARENA_QUIET; process.env.ARENA_QUIET = '1';
      let threw = null;
      try { const S2 = await loadStack(dir, mu.id); await suite(S2, mu.id, { groups: mu.groups, fast: true, dir }); } catch (e) { threw = e; }
      const failed = fail - before.fail, killedBy = failures.slice(before.nf).map((f) => f.replace(/^\[[^\]]*\]\s*/, '').split(' ')[0]);
      pass = before.pass; fail = before.fail; failures.length = before.nf;       // a mutant's failures never count against the real suite
      process.env.ARENA_QUIET = saveQ || '';
      out.push({ id: mu.id, killed: failed > 0 || !!threw, why: mu.why, groups: mu.groups, failed, killedBy, threw: threw ? String(threw.message || threw).slice(0, 90) : null, byThrow: failed === 0 && !!threw });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ main */
const S0 = await loadStack(SRC);
PACK = S0.tables.loadPack(romBytes, { verify: 'header', dexText: false });
const t0 = Date.now();
await suite(S0, '', { groups: ONLY.length ? ONLY : null });
console.log(`tower: ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
{
  const { B, C, A } = S0;
  const perTier = [0, 1, 2, 3].map((tt) => B.FAMILIES.filter((f) => f.tiers[0] <= tt && tt <= f.tiers[1]).length);
  const only = [0, 1, 2, 3].map((tt) => B.FAMILIES.filter((f) => f.tiers[0] === tt && f.tiers[1] === tt).length);
  const lv = B.SYNERGIES.reduce((n, s) => n + (s.levels ? s.levels.length : 1), 0);
  console.log(`catalogue: ${B.FAMILIES.length} buff families (offerable at green ${perTier[0]} / blue ${perTier[1]} / purple ${perTier[2]} / gold ${perTier[3]}; offered at one tier only: ${only.join(' / ')}), ${B.SYNERGIES.length} synergies in ${lv} levels (${B.SYNERGIES.filter((s) => s.kind === 'tag').length} tag sets, ${B.SYNERGIES.filter((s) => s.kind === 'combo').length} named combos, ${B.SYNERGIES.filter((s) => s.kind === 'mult').length} multipliers), ${A.ACHIEVEMENTS.length} achievements (${[1, 2, 3, 4].map((g) => A.ACHIEVEMENTS.filter((a) => a.grade === g).length).join(' / ')} by grade), ${B.FAMILIES.filter((f) => f.curse).length} curses, ${C.CONFIG.floors} floors`);
}
let survived = 0;
if (WANT_MUTANTS) {
  const keepFail = fail, keepFailures = failures.slice();
  const tm = Date.now();
  const res = await runMutants();
  fail = keepFail; failures.length = 0; failures.push(...keepFailures);
  for (const m of res) { console.log((m.killed ? 'killed  ' : 'SURVIVED') + ' ' + m.id + ' -- ' + m.why + (m.killed ? '  [' + [...new Set(m.killedBy || [])].slice(0, 4).join(' ') + (m.threw ? ' threw: ' + m.threw : '') + ']' : '  <-- the suite did not notice')); if (!m.killed) survived++; }
  console.log(`mutants: ${res.length - survived}/${res.length} killed (${((Date.now() - tm) / 1000).toFixed(1)} s)`);
}
if (fail || survived) { console.log('\nFAILURES:\n  ' + failures.join('\n  ')); process.exit(1); }

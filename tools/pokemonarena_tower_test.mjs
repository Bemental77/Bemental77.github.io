// tools/pokemonarena_tower_test.mjs -- the POKEMON TOWER's pure logic (pokemonarena/js/tower.js, tower_buffs.js, tower_config.js, achievements.js), in Node, on the REAL engine and ROM pack.
//
//   node tools/pokemonarena_tower_test.mjs             the cases (about half a minute)
//   node tools/pokemonarena_tower_test.mjs --mutants   ALSO break the modules one way at a time; every break must fail a NAMED group of cases (the suite is not vacuous)
//   node tools/pokemonarena_tower_test.mjs --only=R,S,O   just those groups (R, S, O: the retries);   ARENA_FAST=1 runs the lighter loops every mutant gets, on the real tree
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
const MUT_ONLY = process.argv.slice(2).filter((a) => /^--mutant=/.test(a)).map((a) => a.slice(9).split(',')).flat();

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) { if (cond) { pass++; if (process.env.ARENA_VERBOSE) console.log('ok  ', name); } else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); if (!process.env.ARENA_QUIET) console.log('FAIL', name, detail || ''); } }
const J = (x) => JSON.stringify(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
const canon = (x) => { const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])])) : v); return JSON.stringify(walk(x)); };          // (the same value whatever order its keys were written in)
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

const imp = (dir, f, bust) => import(pathToFileURL(path.join(dir, f)).href + (bust ? '?x=' + bust : ''));
async function loadStack(dir, bust) {
  const [tables, matchctl, engine, rules, ai, T, B, C, A, ms, R, SS, TF, TL, RS, BB, HB] = await Promise.all(['tables.js', 'matchctl.js', 'engine.js', 'rules.js', 'ai.js', 'tower.js', 'tower_buffs.js', 'tower_config.js', 'achievements.js', 'match_stats.js', 'tower_record.js', 'tower_session.js', 'tower_fight.js', 'tower_launch.js', 'battle_resume.js', 'battle_boot.js', 'tower_hub.js'].map((f) => imp(dir, f, bust)));
  return { tables, matchctl, engine, rules, ai, T, B, C, A, ms, R, SS, TF, TL, RS, BB, HB };
}
const romBytes = fs.readFileSync(ROM_PATH);
const sleepTick = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------------------------------------ fixtures */
let PACK = null;
const teamsFor = (S, n = 6) => Array.from({ length: n }, (_, i) => S.matchctl.randomTeam(PACK, 700 + i * 31, 6, S.C.CONFIG.ruleset));
const mkRun = (S, o = {}) => {
  const recs = o.recs || Array.from({ length: o.n || 3 }, (_, i) => ({ species: 10 + i }));
  return { v: 1, seed: o.seed || 1, format: o.format || '3v3', ruleset: S.C.CONFIG.ruleset, floor: o.floor || 1, phase: o.phase || 'battle', team: { name: 'T', recs, meta: recs.map(() => ({ gender: null, shiny: false })) }, types: o.types || recs.map((_, i) => [i + 1, i + 1]), held: o.held || [], offer: null, history: o.history || [], skips: o.skips || 0, livesUsed: o.livesUsed || 0, folded: false, fighting: false, earned: [] };
};
const W = (n, mod) => Array.from({ length: n }, (_, i) => ({ floor: i + 1, result: 'w', turns: 10, faints: 1, flawless: false, boss: (i + 1) % 10 === 0, comeback: false, sweep: false, closest: null, pick: null, ...(mod ? mod(i + 1) : {}) }));

/* ------------------------------------------------------------------------------------------------ the suite */
async function suite(S, tag, opt = {}) {
  const { T, B, C, A, rules, engine, matchctl, ai, R: REC, SS, TF, TL, RS, BB } = S;
  const CFG = C.CONFIG;
  // THE RULE BEFORE RETRIES (2026-11-17), as a config: no retry on any floor, so a loss ends the run. Every check that was written for "a loss ends the run" runs under it, WITH ITS EXPECTATIONS UNCHANGED:
  // that is the proof that retriesPerFloor: 0 is exactly the old rule. The rule in force (three retries a floor) has its own checks in group R, and R also runs the other reading (three for the whole climb).
  const OLD = Object.freeze({ ...CFG, retriesPerFloor: 0, retriesPerRun: null });
  const t = (s) => (tag ? '[' + tag + '] ' : '') + s;
  const grp = (g) => !opt.groups || opt.groups.includes(g);
  const N = (full, fast) => (opt.fast ? fast : full);                  // loop sizes: the full suite, and the lighter run each mutant gets
  const teams = ['C', 'D', 'E', 'F', 'H', 'I', 'K', 'L', 'N', 'Q', 'R', 'S', 'O'].some(grp) ? teamsFor(S) : [];
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
    ok(T.battleSetup(PACK, { ...clone(mkTeamRun(5, '6v6')), floor: 3 }).lead === true && T.battleSetup(PACK, { ...clone(mkTeamRun(5, '3v3')), floor: 3 }).lead === false && SS.towerFloorSpec(PACK, mkTeamRun(5, '6v6')).lead === true && SS.towerFloorSpec(PACK, mkTeamRun(5, '3v3')).lead === false, t('F8b a 6v6 Tower fight opens with the LEAD choice (who is sent out first), as every 6v6 battle does; a 3v3 one does not'), '');
    // results
    const win = (r, floor, o) => T.recordFloorResult(r, { floor, result: 'w', turns: 6, faints: 1, ...(o || {}) }, { pack: PACK });
    const w1 = win(run, 1);
    ok(w1.applied && w1.run.phase === 'offer' && w1.run.floor === 2 && w1.run.offer.length >= 3 && w1.run.history.length === 1 && w1.run.history[0].flawless === false && J(w1.events.map((e) => e.type)) === '["floor-won"]', t('F9 a win opens the offer for the next floor and records the floor'), J(w1.events));
    const again = T.recordFloorResult(w1.run, { floor: 1, result: 'w', turns: 6, faints: 1 }, { pack: PACK }), wrongFloor = T.recordFloorResult(run, { floor: 3, result: 'w', turns: 6, faints: 0 }), bad = T.recordFloorResult(run, { floor: 1, result: 'x', turns: 1, faints: 0 });
    ok(!again.applied && again.run === w1.run && !wrongFloor.applied && !bad.applied, t('F10 a result is applied once: the same result twice, a result for another floor and a nonsense result change nothing'), '');
    const l1 = T.recordFloorResult(run, { floor: 1, result: 'l', turns: 9, faints: 3 }, { cfg: OLD }), dr = T.recordFloorResult(run, { floor: 1, result: 'd', turns: 99, faints: 3 }, { cfg: OLD }), fo = T.recordFloorResult(run, { floor: 1, result: 'f', turns: 2, faints: 0 }, { cfg: OLD });
    ok(l1.run.phase === 'over' && dr.run.phase === 'over' && fo.run.phase === 'over' && J(l1.events) === '[{"type":"run-over","floor":1}]', t('F11 a loss, a draw or a forfeit ends the run (with no retry to give: retriesPerFloor 0, the rule before retries)'), '');
    const lives = { ...clone(run), held: [{ id: 'extra-life', p: 4 }] }, lost = T.recordFloorResult(lives, { floor: 1, result: 'l', turns: 5, faints: 3 });
    const lost2 = T.recordFloorResult(lost.run, { floor: 1, result: 'l', turns: 5, faints: 3 }, { cfg: OLD });
    ok(lost.run.phase === 'battle' && lost.run.floor === 1 && lost.run.livesUsed === 1 && T.livesLeft(lost.run) === 0 && lost.events[0].type === 'life-used' && lost2.run.phase === 'over', t('F12 an Extra Life turns one loss into a retry of the same floor; the next loss ends the run (retriesPerFloor 0)'), J(lost.events));
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
      ['five moves', (x) => { x.team.recs[0].moves.push({ id: 1, ppUps: 0 }, { id: 2, ppUps: 0 }, { id: 3, ppUps: 0 }, { id: 4, ppUps: 0 }); }], ['a PP Up of 9', (x) => { x.team.recs[0].moves[0].ppUps = 9; }], ['a fight marked outside the battle phase', (x) => { x.fighting = true; }], ['an earned list with a bad id', (x) => { x.earned = ['Bad Id']; }], ['a fighting flag that is not a boolean', (x) => { x.fighting = 1; }], ['a folded flag that is not a boolean', (x) => { x.folded = 'yes'; }], ['types that do not match the team', (x) => { x.types.pop(); }], ['a team too small for 3v3', (x) => { x.team.recs.length = 2; x.team.meta.length = 2; x.types.length = 2; }],
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
    const TOWER = { 'tower_config.js': [], 'tower_record.js': ['./tower_config.js'], 'tower_buffs.js': ['./rules.js', './ai.js', './tower_config.js'], 'achievements.js': ['./tower_config.js', './tower_buffs.js', './tower_record.js'], 'tower.js': ['./ai.js', './matchctl.js', './rules.js', './tower_config.js', './tower_record.js', './tower_buffs.js'] };
    const bad8 = [];
    for (const [f, allowed] of Object.entries(TOWER)) {
      const txt = rd(f), imp = imports(txt);
      for (const i of imp) if (!allowed.includes(i)) bad8.push(f + ' imports ' + i);
      if (/\bimport\s*\(/.test(code(txt))) bad8.push(f + ' uses a dynamic import');
      const m = code(txt).match(/\b(localStorage|sessionStorage|indexedDB|document\.|window\.|navigator\.|fetch\(|XMLHttpRequest|Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval|require\()/);
      if (m) bad8.push(f + ' touches the outside world: ' + m[1]);
    }
    ok(!bad8.length, t('H8 the five Tower logic modules import only the rules, the AI\'s random generator, the match builder and each other, and touch no storage, DOM, clock or Math.random'), bad8.join('; '));
    // WHO MAY IMPORT THE TOWER. Phase 2 puts the Tower in the hub (its screens) and on the battle page (one floor's fight) and in the profile (its record's shape): those files, and only those, import the
    // Tower modules named here (dynamically where the page should not load the Tower until it is used). Every other module -- the engine, the match builder, the career, the netplay, the online page, the
    // presence / open-games code, the scene -- imports NONE of them, so a regular or an online battle cannot reach a buff.
    const WHO = {
      'profile.js': ['./tower_record.js'], 'hub_model.js': ['./tower_hub.js'], 'hub_screen.js': ['./tower_screen.js'], 'tower_screen.js': ['./tower_hub.js'],
      'boot.js': ['./tower_launch.js', './tower_session.js', './tower_hub.js'], 'battle_boot.js': ['./tower_launch.js', './tower_session.js', './tower_fight.js'],
    };
    const MODULES = ['tower.js', 'tower_buffs.js', 'tower_config.js', 'tower_record.js', 'achievements.js', 'tower_session.js', 'tower_fight.js', 'tower_launch.js', 'tower_hub.js', 'tower_screen.js'];
    const towerImports = (f) => { const c = code(rd(f)); return [...imports(rd(f)), ...[...c.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])].filter((i) => /tower|achievements/.test(i)); };
    const TOWER2 = { 'tower_session.js': ['./tower_config.js', './tower.js', './tower_buffs.js', './achievements.js', './matchctl.js', './tower_record.js', './teamcode.js'], 'tower_fight.js': ['./tower_session.js', './tower_config.js'], 'tower_launch.js': ['./editor_links.js', './tower_config.js'], 'tower_hub.js': [], 'tower_screen.js': ['./tower_hub.js', './hub_model.js'] };
    const bad8c = [];
    for (const [f, allowed] of Object.entries(TOWER2)) {
      const txt = rd(f), c2 = code(txt).replace(/now = \(\) => Date\.now\(\)/g, '');          // (the caller's clock defaults to the real one in two signatures; nothing else reads it)
      for (const i of imports(txt)) if (!allowed.includes(i)) bad8c.push(f + ' imports ' + i);
      if (/\bimport\s*\(/.test(c2)) bad8c.push(f + ' uses a dynamic import');
      const m = c2.match(/\b(localStorage|sessionStorage|indexedDB|document\.|window\.|navigator\.|fetch\(|XMLHttpRequest|Math\.random|Date\.now|new Date|performance\.now|setInterval|require\()/);
      if (m) bad8c.push(f + ' touches the outside world: ' + m[1]);
      if (f !== 'tower_fight.js' && /\bsetTimeout\b/.test(c2)) bad8c.push(f + ' uses a timer');
    }
    ok(!bad8c.length, t('H8c the Tower\'s session, fight, launch, hub and screen modules import only what the table allows (never the career, the store, the online code or the scene), read no clock but the caller\'s, and touch no storage, DOM or Math.random'), bad8c.join('; '));
    const TOWER_FILES = MODULES, rest = fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && !TOWER_FILES.includes(f));
    const badRev = rest.filter((f) => towerImports(f).some((i) => !(WHO[f] || []).includes(i)));
    const pages = [path.join(root, 'pokemonarena.html'), ...fs.readdirSync(path.join(root, 'pokemonarena')).filter((f) => /\.(html|css)$/.test(f)).map((f) => path.join(root, 'pokemonarena', f))].filter((p) => fs.existsSync(p));
    const badPages = pages.filter((p) => /tower_buffs|tower_config|tower\.js|achievements\.js/.test(fs.readFileSync(p, 'utf8')));
    ok(rest.length > 40 && !badRev.length && !badPages.length, t('H9 of the ' + rest.length + ' other modules only profile.js (the record\'s shape), the hub (model, screen, boot) and the battle page import a Tower module, and only the ones the table names: nothing in the engine, the match builder, the career, the store, the online page, netmatch, presence or the scene does'), badRev.concat(badPages.map((p) => path.basename(p))).join());
    const tw = T.emptyTower(), twJson = J(T.foldRunInto(tw, T.abandonRun(T.takeBuff(T.recordFloorResult(mkR(2, '3v3', 0), { floor: 1, result: 'w', turns: 4, faints: 0 }, { pack: PACK }).run, null).run)).tower);
    ok(!/"(byCpu|totals|recent|stats|online|career|record|matches)"/.test(twJson + J(tw)) && Object.keys(tw).sort().join() === ['achievements', 'best', 'bosses', 'buffsSeen', 'current', 'floors', 'last', 'runs', 'v', 'wins', 'winsByFormat'].sort().join(), t('H10 the Tower\'s record is its own: it has no byCpu / totals / recent / online fields, so a tower battle cannot appear in the regular career'), twJson);
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

  /* ============================================================================================ PHASE 2: the stored record, the session, the fight, the address, the leaks */
  const mkT = (o) => ({ ...REC.emptyTower(), ...(o || {}) });
  // a pick as the hub sends it: it names the run, the floor and the OFFER it was shown in
  const PK = (tw, id, extra) => ({ seed: tw.current.seed, id, floor: tw.current.floor, offer: SS.offerKey(tw.current), ...(extra || {}) });
  const WIN = (floor, extra) => ({ floor, result: 'w', turns: 5, faints: 0, ...(extra || {}) }), LOSS = (floor) => ({ floor, result: 'l', turns: 7, faints: 3 });
  const startArgs = (o) => ({ pack: PACK, seed: 777, format: '3v3', team: { name: 'Me', recs: teams[0].recs, meta: teams[0].meta }, now: 1000, ...(o || {}) });
  // a whole run through the reducers: `plan(floor, run)` -> 'w' | 'l'; `pickOf(run)` -> a ball id | null. -> the Tower record after every step too (for the "reload anywhere" checks)
  function playRun(seed, plan, pickOf, o = {}) {
    let tw = SS.reduceStart(mkT(), startArgs({ seed, ...(o.start || {}) })).tower, now = 1000, steps = [];
    for (let g = 0; g < 200 && tw.current; g++) {
      const cur = tw.current;
      if (o.reload) tw = JSON.parse(JSON.stringify(tw));
      if (cur.phase === 'offer') { const id = pickOf(cur); const r = SS.reducePick(tw, PK(tw, id, { now: (now += 10) })); if (!r.applied) throw new Error('pick refused: ' + r.why); tw = r.tower; }
      else { const w = plan(cur.floor, cur), r = SS.reduceFinishFloor(tw, { floor: cur.floor, seed, result: w === 'w' ? WIN(cur.floor) : LOSS(cur.floor), pack: PACK, now: (now += 10) }); if (!r.applied) throw new Error('result refused: ' + r.why); tw = r.tower; }
      steps.push(J(tw).length);
    }
    return { tower: tw, steps };
  }

  /* J. the stored record (tower_record.js): shape, repair, limits */
  if (grp('J')) {
    const e = REC.emptyTower(), good = clone(e);
    ok(REC.checkTowerShape(e).length === 0 && REC.emptyTower() !== REC.emptyTower() && J(Object.keys(e)) === J(REC.TOWER_KEYS) && REC.TOWER_VERSION === 1, t('J1 an empty Tower record is well formed, a fresh object each time, with exactly the documented fields'), J(REC.checkTowerShape(e)));
    const fx = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'fixtures', 'pokemonarena', 'profile-v5-tower.json'), 'utf8')).tower;
    ok(REC.checkTowerShape(fx).length === 0 && fx.current.phase === 'offer' && fx._unknown.futureTowerThing.keep === 'me', t('J2 the populated fixture record (a run under way, a last run, unknown fields) is well formed'), J(REC.checkTowerShape(fx)));
    const run1 = clone(fx.current);
    const hostile = [
      ['an unknown field', (x) => { x.cheat = 1; }], ['a missing field', (x) => { delete x.last; }], ['version 2', (x) => { x.v = 2; }], ['best for a third format', (x) => { x.best['4v4'] = 1; }], ['best above the floors', (x) => { x.best['3v3'] = 31; }], ['a negative best', (x) => { x.best['6v6'] = -1; }],
      ['wins that are not the sum of winsByFormat', (x) => { x.wins = 3; }], ['more wins than runs', (x) => { x.wins = 9; x.winsByFormat['3v3'] = 9; }], ['a fractional counter', (x) => { x.runs = 2.5; }], ['a counter past a billion', (x) => { x.floors = 1e10; }],
      ['an upper-case buff id', (x) => { x.buffsSeen.Power = 1; }], ['a zero buff count', (x) => { x.buffsSeen['power-training'] = 0; }], ['four hundred and one buff ids', (x) => { for (let i = 0; i < 401; i++) x.buffsSeen['b' + i] = 1; }],
      ['a time stamp that is a string', (x) => { x.achievements['first-floor'] = 'now'; }], ['an achievement id with a space', (x) => { x.achievements['a b'] = 1; }],
      ['a run with an extra field', (x) => { x.current.cheat = 1; }], ['a run with a missing field', (x) => { delete x.current.held; }], ['a run on floor 31', (x) => { x.current.floor = 31; }], ['a run in a phase that does not exist', (x) => { x.current.phase = 'cheat'; }],
      ['a run that is already over', (x) => { x.current.phase = 'over'; }], ['a run that is already folded', (x) => { x.current.folded = true; }], ['a run whose fighting flag is not a boolean', (x) => { x.current.fighting = 1; }], ['a run whose earned list is not a list', (x) => { x.current.earned = 'x'; }],
      ['a last run missing a field', (x) => { delete x.last.held; }], ['a last run that holds a power of 17', (x) => { x.last.held[0].p = 17; }], ['a last run that earned the same thing twice', (x) => { x.last.earned = ['a', 'a']; }], ['a last run with more floors than the Tower has', (x) => { x.last.cleared = 31; }],
      ['an unknown-field bag that is not an object', (x) => { x._unknown = 5; }],
    ];
    const slipped = hostile.filter(([, fn]) => { const x = clone(fx); fn(x); return REC.checkTowerShape(x).length === 0; }).map(([n]) => n);
    ok(!slipped.length && REC.checkTowerShape(null).length && REC.checkTowerShape([]).length && REC.checkTowerShape('x').length, t('J3 the strict shape check refuses all ' + hostile.length + ' hostile edits (and non-objects)'), slipped.join(' | '));
    const big = clone(fx); big.current.team.name = 'x'.repeat(REC.TOWER_LIMITS.runJsonMax);
    ok(REC.checkTowerShape(big).length > 0 && !REC.isRunShape(big.current), t('J4 a stored run larger than the size cap is refused (a record cannot be used to fill the store)'), '');
    // repair: field by field, nothing silently lost
    const P0 = []; const rep = (src, present = true) => REC.normalizeTower(src, (...a) => P0.push(a), present);
    const junk = [undefined, null, 5, 'x', [], [1, 2], { v: 2 }, { v: 1 }, { ...clone(fx), best: 'x' }, { ...clone(fx), buffsSeen: [1] }, { ...clone(fx), achievements: { ok: 1, 'Bad Id': 2, third: 'x' } }, { ...clone(fx), current: { floor: 1 } }, { ...clone(fx), last: 5 }, { ...clone(fx), runs: -4, wins: 'many' }, { ...clone(fx), winsByFormat: { '3v3': 2 } }];
    let junkBad = '';
    for (const [i, src] of junk.entries()) { const r = rep(src); const again = rep(r.value); if (REC.checkTowerShape(r.value).length) junkBad = junkBad || 'junk ' + i + ' gave an invalid record'; else if (J(again.value) !== J(r.value) || Object.keys(again.rejected).length) junkBad = junkBad || 'junk ' + i + ' is not a fixed point'; }
    ok(!junkBad, t('J5 whatever a damaged `tower` is, repairing it gives a well-formed record, and repairing that again changes nothing'), junkBad);
    const part = rep({ ...clone(fx), best: 'x', achievements: { 'first-floor': 5, 'Bad Id': 6 } });
    ok(J(part.value.achievements) === J({ 'first-floor': 5 }) && J(part.rejected.achievements) === J({ 'Bad Id': 6 }) && J(part.rejected.best) === '"x"' && part.value.best['3v3'] === 0 && part.value.runs === fx.runs && part.value.current && part.value.last && part.value._unknown.futureTowerThing, t('J6 a damaged field costs the player only that field: the rest of the climb (runs, achievements that are fine, the run under way, the last run, unknown fields) is kept, and the damaged value is handed back to be kept in the bag'), J(part.rejected));
    const sums = rep({ ...clone(fx), wins: 9, runs: 1, winsByFormat: { '3v3': 2, '6v6': 1 } }).value;
    ok(sums.wins === 3 && sums.runs >= 3 && REC.checkTowerShape(sums).length === 0, t('J7 counters that disagree are made to agree without lowering anything the player did (wins = the sum of the formats, runs never below wins)'), J(sums));
    ok(rep(undefined, true).value.runs === 0 && rep({ ...clone(fx), v: 2 }).rejected._raw.v === 2 && J(rep(undefined, false).value) === J(REC.emptyTower()) && P0.some((a) => a[1] === 'profile.tower'), t('J8 a missing record becomes an empty one, a record of another version is kept whole in the bag, and repairs are reported'), '');
    const rng = ai.createRng(5150); let fuzzBad = '';
    for (let i = 0; i < N(300, 40) && !fuzzBad; i++) { const x = clone(fx); const walk = (o, d) => { const ks = Object.keys(o || {}); if (!ks.length || d > 3 || rng(4) === 0) return; const k = ks[rng(ks.length)], v = o[k]; if (rng(3) === 0) o[k] = [null, -1, 'x', 1e12, {}, [], true][rng(7)]; else if (v && typeof v === 'object') walk(v, d + 1); }; walk(x, 0); walk(x, 0); const r = REC.normalizeTower(x, () => {}, true); if (REC.checkTowerShape(r.value).length) fuzzBad = 'fuzz ' + i + ' -> ' + REC.checkTowerShape(r.value).join(); }
    ok(!fuzzBad, t('J9 300 randomly damaged records (any field, any depth) always repair to a well-formed one, never throw'), fuzzBad);
  }

  /* K. the session: every step of a climb, the rules that keep it honest */
  if (grp('K')) {
    const t0 = SS.reduceStart(mkT(), startArgs());
    ok(t0.applied && t0.tower.current.phase === 'battle' && t0.tower.current.floor === 1 && t0.tower.current.fighting === false && REC.checkTowerShape(t0.tower).length === 0 && t0.tower.runs === 0 && J(t0.tower.current.team.recs) === J(teams[0].recs), t('K1 a new run starts on floor 1, waiting for its fight, holding a snapshot of the team'), J(t0).slice(0, 200));
    const refusals = [['a seed below zero', startArgs({ seed: -1 })], ['a seed of 2^32', startArgs({ seed: 4294967296 })], ['a fractional seed', startArgs({ seed: 1.5 })], ['a seed that is text', startArgs({ seed: '5' })], ['an unknown format', startArgs({ format: '9v9' })],
      ['a team too small for 3v3', startArgs({ team: { name: 'x', recs: teams[0].recs.slice(0, 2), meta: teams[0].meta.slice(0, 2) } })], ['an illegal team', startArgs({ team: { name: 'x', recs: teams[0].recs.map((r) => ({ ...r, evs: { hp: 255, atk: 255, def: 255, spa: 255, spd: 255, spe: 255 } })), meta: teams[0].meta } })]];
    const refusedOk = refusals.filter(([, a]) => SS.reduceStart(mkT(), a).applied === false).length === refusals.length;
    ok(refusedOk && SS.reduceStart(t0.tower, startArgs({ seed: 5 })).applied === false && /under way/.test(SS.reduceStart(t0.tower, startArgs({ seed: 5 })).why), t('K2 a run is refused for a hostile seed, an unknown format, a team too small or illegal, and while another is under way (unless it is to replace it)'), '');
    const rnd = SS.reduceStart(mkT(), startArgs({ team: null }));
    ok(rnd.applied && rnd.tower.current.team.recs.length === 6 && rnd.tower.current.team.name === 'RANDOM' && J(SS.reduceStart(mkT(), startArgs({ team: null })).tower.current.team.recs) === J(rnd.tower.current.team.recs) && J(SS.reduceStart(mkT(), startArgs({ team: null, seed: 778 })).tower.current.team.recs) !== J(rnd.tower.current.team.recs), t('K3 no saved team: a random legal team of six, the same for the same seed and a different one for another'), '');
    // a result
    const w1 = SS.reduceFinishFloor(t0.tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 });
    ok(w1.applied && w1.next.step === 'offer' && w1.next.floor === 2 && w1.tower.current.phase === 'offer' && w1.tower.current.offer.length >= 3 && w1.finished === false && w1.tower.achievements['first-floor'] === 2000 && w1.run.earned.includes('first-floor') && w1.tower.runs === 0, t('K4 a won floor opens the offer, earns First Step (stamped with the caller\'s clock, listed in the run) and does not yet count the run'), J(w1.next));
    const again = SS.reduceFinishFloor(w1.tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2100 });
    const wrongFloor = SS.reduceFinishFloor(t0.tower, { floor: 2, seed: 777, result: WIN(2), pack: PACK, now: 2100 }), wrongRun = SS.reduceFinishFloor(t0.tower, { floor: 1, seed: 778, result: WIN(1), pack: PACK, now: 2100 }), noRun = SS.reduceFinishFloor(mkT(), { floor: 1, seed: 777, result: WIN(1), pack: PACK });
    ok(again.applied === false && !again.tower && wrongFloor.applied === false && wrongRun.applied === false && noRun.applied === false && SS.reduceFinishFloor(t0.tower, { floor: 1, seed: 777, result: { floor: 1, result: 'maybe', turns: 1, faints: 0 }, pack: PACK }).applied === false, t('K5 a result is applied ONCE: the same result again, a result for another floor or another run, for no run, or a nonsense result, changes nothing'), '');
    const l1 = SS.reduceFinishFloor(t0.tower, { floor: 1, seed: 777, result: LOSS(1), pack: PACK, now: 2000, cfg: OLD });
    ok(l1.applied && l1.finished && l1.next.step === 'over' && l1.tower.current === null && l1.tower.runs === 1 && l1.tower.wins === 0 && l1.tower.last.won === false && l1.tower.last.cleared === 0 && l1.tower.achievements['rock-bottom'] === 2000 && l1.tower.last.earned.includes('rock-bottom') && l1.run.folded === true && REC.checkTowerShape(l1.tower).length === 0, t('K6 (retriesPerFloor 0) a lost floor with no life ends the run: it is folded into the record once, summarised in `last` (with what it earned), and `current` is empty'), J(l1.tower.last));
    const dup = SS.reduceFinishFloor(l1.tower, { floor: 1, seed: 777, result: LOSS(1), pack: PACK, now: 2200, cfg: OLD });
    ok(dup.applied === false && J(l1.tower.runs) === '1', t('K7 a finished run cannot be finished again (a double fire cannot count it twice)'), '');
    // a pick
    const ids = w1.tower.current.offer.map((o) => o.id);
    const pk = SS.reducePick(w1.tower, PK(w1.tower, ids[0], { now: 3000 }));
    ok(pk.applied && pk.next.step === 'fight' && pk.next.floor === 2 && pk.tower.current.phase === 'battle' && pk.tower.current.offer === null && pk.tower.current.held.length === 1 && pk.tower.current.held[0].id === ids[0] && pk.tower.current.history[0].pick.id === ids[0], t('K8 taking a ball puts it in the run, closes the offer and goes back to waiting for a fight'), J(pk.next));
    ok(SS.reducePick(pk.tower, { seed: 777, id: ids[1], floor: 2, offer: SS.offerKey(w1.tower.current), now: 3100 }).applied === false && SS.reducePick(w1.tower, PK(w1.tower, 'not-offered', { now: 3100 })).applied === false && SS.reducePick(w1.tower, PK(w1.tower, ids[0], { seed: 778, now: 3100 })).applied === false && SS.reducePick(t0.tower, { seed: 777, id: null, floor: 1, offer: '1:0', now: 3100 }).applied === false, t('K9 a pick is applied once and only to the offer that is open: a second pick, a ball that was not offered, another run, or no offer at all change nothing'), '');
    const sk = SS.reducePick(w1.tower, PK(w1.tower, null, { now: 3000 }));
    ok(sk.applied && sk.tower.current.skips === 1 && sk.tower.current.held.length === 0 && sk.tower.current.history[0].pick === null, t('K10 skipping takes nothing and is counted'), '');
    // the fight's own marks
    const b0 = SS.reduceBeginFloor(t0.tower, { pack: PACK, floor: 1, seed: 777, navType: 'navigate', now: 2000 });
    const m1 = SS.reduceMarkFight(t0.tower, { floor: 1, seed: 777, attempt: 11 }), m2 = SS.reduceMarkFight(m1.tower, { floor: 1, seed: 777, attempt: 11 });
    ok(b0.status === 'ok' && !b0.applied && m1.applied && m1.tower.current.fighting === true && m2.applied === false && SS.reduceMarkFight(t0.tower, { floor: 2, seed: 777, attempt: 11 }).applied === false && SS.reduceMarkFight(w1.tower, { floor: 1, seed: 777, attempt: 11 }).applied === false, t('K11 looking at a floor writes nothing; the fight is marked at the first choice, once, and only for the floor the run is waiting for'), J(b0.status));
    const resume = SS.reduceBeginFloor(m1.tower, { pack: PACK, floor: 1, seed: 777, navType: 'reload', now: 2000 }), back = SS.reduceBeginFloor(m1.tower, { pack: PACK, floor: 1, seed: 777, navType: 'back_forward', now: 2000 });
    const left = SS.reduceBeginFloor(m1.tower, { pack: PACK, floor: 1, seed: 777, navType: 'navigate', now: 2500, cfg: OLD });
    ok(resume.status === 'resume' && !resume.applied && back.status === 'resume' && left.status === 'abandoned' && left.applied && left.next.step === 'over' && left.tower.current === null && left.tower.last.won === false && left.tower.runs === 1, t('K12 a marked fight comes back by a reload and resumes; arriving at it any other way means it was LEFT, which counts as a loss (the run ends here with no life and, retriesPerFloor 0, no retry)'), J([resume.status, left.status]));
    const stale = [SS.reduceBeginFloor(t0.tower, { pack: PACK, floor: 2, seed: 777 }), SS.reduceBeginFloor(t0.tower, { pack: PACK, floor: 1, seed: 1 }), SS.reduceBeginFloor(w1.tower, { pack: PACK, floor: 2, seed: 777 }), SS.reduceBeginFloor(mkT(), { pack: PACK, floor: 1, seed: 777 })];
    ok(stale.every((x) => x.status === 'stale' && !x.applied), t('K13 a fight the run is not waiting for (another floor, another run, the offer, no run) is stale, and nothing is written'), J(stale.map((x) => x.status)));
    // an Extra Life: forged into the offer, taken through the machine's own pick
    const withLife = (() => { const x = clone(w1.tower); x.current.offer = [{ id: 'extra-life', tier: 2 }, ...x.current.offer.slice(1)]; return SS.reducePick(x, PK(x, 'extra-life', { now: 3000 })).tower; })();
    const lost2 = SS.reduceFinishFloor(withLife, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 3500 });
    const marked = SS.reduceMarkFight(withLife, { floor: 2, seed: 777, attempt: 12 }), lost2m = SS.reduceFinishFloor(marked.tower, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 3500, attempt: 12 });
    ok(marked.tower.current.fighting === true && lost2m.tower.current.fighting === false && withLife.current.held[0].p === 4 && lost2.applied && !lost2.finished && lost2.next.step === 'retry' && lost2.next.floor === 2 && lost2.tower.current.livesUsed === 1 && lost2.tower.current.floor === 2 && lost2.tower.runs === 0, t('K14 an Extra Life turns the loss into a retry of the same floor (and nothing is counted yet); the next loss ends the run'), J(lost2.next));
    const lost3 = SS.reduceFinishFloor(lost2.tower, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 3600, cfg: OLD });
    ok(lost3.finished && lost3.next.step === 'over' && lost3.tower.last.livesUsed === 1 && lost3.tower.achievements['second-wind'] === 3500, t('K15 ... and (retriesPerFloor 0) the retry that is lost ends it; Second Chance (spend an extra life) was earned when the life went'), J(lost3.tower.achievements));
    // give up
    const gu = SS.reduceGiveUp(pk.tower, { seed: 777, now: 4000 });
    ok(gu.applied && gu.finished && gu.tower.current === null && gu.tower.runs === 1 && gu.tower.best['3v3'] === 1 && gu.tower.last.cleared === 1 && SS.reduceGiveUp(gu.tower, { seed: 777, now: 4100 }).applied === false && SS.reduceGiveUp(pk.tower, { seed: 5, now: 4100 }).applied === false, t('K16 giving a run up counts it as a finished run where it stood, once; there is nothing to give up afterwards, or for another run'), J(gu.tower.last));
    const rep = SS.reduceStart(pk.tower, startArgs({ seed: 900, replace: true, now: 4200 }));
    ok(rep.applied && rep.tower.runs === 1 && rep.tower.current.seed === 900 && rep.tower.last.cleared === 1, t('K17 starting a new run over one under way gives the old one up and counts it'), '');
    // whole runs: a winning one, and one that is reloaded from its stored form at every step
    const bestPick = (cur) => cur.offer[0].id, always = () => 'w';
    const full = playRun(31, always, bestPick), fullR = playRun(31, always, bestPick, { reload: true });
    const ft = full.tower;
    ok(ft.current === null && ft.runs === 1 && ft.wins === 1 && ft.winsByFormat['3v3'] === 1 && ft.best['3v3'] === 30 && ft.floors === 30 && ft.bosses === 3 && ft.last.won && ft.last.cleared === 30 && ['tower-master', 'gatekeeper', 'warden', 'climb-25'].every((id) => ft.achievements[id]) && Object.keys(ft.buffsSeen).length > 0 && REC.checkTowerShape(ft).length === 0, t('K18 a whole winning climb of 30 floors: the run is won and folded once (best 30, 3 bosses, buffs seen), and the achievements for it are earned'), J({ r: ft.runs, w: ft.wins, b: ft.best, f: ft.floors, bo: ft.bosses }));
    ok(J(fullR.tower) === J(ft) && fullR.steps.join() === full.steps.join(), t('K19 RELOAD ANYWHERE: the record, written out and read back before every single step of the same climb, ends exactly where the unbroken climb did'), '');
    // a second run does not re-stamp what the first earned, and adds to the totals
    const second = (() => { let tw = ft; const r = SS.reduceStart(tw, startArgs({ seed: 32, now: 9000 })); tw = r.tower; tw = SS.reduceFinishFloor(tw, { floor: 1, seed: 32, result: WIN(1), pack: PACK, now: 9100 }).tower; return SS.reduceGiveUp(tw, { seed: 32, now: 9200 }).tower; })();
    ok(second.runs === 2 && second.achievements['first-floor'] === ft.achievements['first-floor'] && second.wins === 1 && second.best['3v3'] === 30 && second.floors === 31 && !second.last.earned.includes('first-floor'), t('K20 a second run adds to the totals, never re-stamps an achievement already earned, and its summary lists only what IT earned'), J(second.last.earned));
    // the summary the screens draw
    const sm0 = SS.summarizeTower(mkT(), PACK), smB = SS.summarizeTower(t0.tower, PACK), smO = SS.summarizeTower(w1.tower, PACK), smL = SS.summarizeTower(ft, PACK);
    ok(sm0.run === null && sm0.last === null && sm0.achievements.length === A.ACHIEVEMENTS.length && sm0.earned === 0 && smB.run.phase === 'battle' && smB.run.trainer && smB.run.trainer.name && smB.run.offer === null && smB.run.floors === 30 && smO.run.phase === 'offer' && smO.run.offer.balls.length === w1.tower.current.offer.length && smO.run.offer.balls.every((b, i) => b.id === w1.tower.current.offer[i].id) && smL.last.won === true && smL.last.earned.every((e) => e.name) && smL.earned === Object.keys(ft.achievements).length, t('K21 the summary the screens draw: no run, a run waiting for its fight (with the trainer), a run with its offer (the same balls), the last run with what it earned, all 51 achievements'), J(smB.run));
    const brokenT = clone(w1.tower); brokenT.current.team.recs = 'x';
    let sumThrew = null, smX = null; try { smX = SS.summarizeTower(brokenT, PACK); } catch (e) { sumThrew = e; }
    ok(!sumThrew && smX.run && smX.run.broken === true, t('K22 a stored run that cannot be read summarises as "broken" (the screens offer to drop it); it never throws'), String(sumThrew && sumThrew.message));
    // the battle spec
    const run7 = clone(pk.tower.current), spec = SS.towerFloorSpec(PACK, run7), spec2 = SS.towerFloorSpec(PACK, deepFreeze(clone(run7)));
    const noBuff = SS.towerFloorSpec(PACK, { ...clone(run7), held: [] });
    ok(spec.validate === false && spec.tower.floor === 2 && J(spec) === J(spec2) && spec.names[0] === 'You' && spec.sides[0].kind === 'human' && spec.sides[1].kind === 'cpu' && spec.pick === 3 && /^tower:777:2:0:[0-9a-f]+$/.test(spec.tower.tag) && spec.tower.tag !== noBuff.tower.tag && J(spec.teams[0]) !== J(noBuff.teams[0]) && SS.towerTag({ ...run7, livesUsed: 1 }) !== spec.tower.tag && SS.towerTag({ ...run7, floor: 3 }) !== spec.tower.tag && spec.seed !== SS.towerFloorSpec(PACK, { ...run7, livesUsed: 1 }).seed, t('K23 the floor\'s battle: built from the run alone (the same run gives the same spec, a frozen run is not touched), `validate:false`, the buffs in the player\'s records, a tag that changes with the floor, the lives spent and every buff held, and a retry fights with another seed'), spec.tower.tag);
    // the session binds the reducers to a place that keeps the record (here a variable)
    const per = SS.memoryPersist(mkT()), sess = SS.createTowerSession({ pack: PACK, persist: per, now: () => 5000 });
    const s1 = await sess.startRun({ seed: 41, format: '3v3', team: null }), s2 = await sess.finishFloor({ floor: 1, seed: 41, result: WIN(1) }), s3 = await sess.pick(PK(per.peek(), per.peek().current.offer[0].id)), s4 = await sess.giveUp({ seed: 41 });
    const smS = await sess.summary();
    ok(s1.applied && s2.applied && s3.applied && s4.applied && per.peek().runs === 1 && per.peek().current === null && smS.last.cleared === 1 && (await sess.startRun({ seed: -1, format: '3v3' })).applied === false && J(per.peek().last.at) === '5000', t('K24 the session binds the steps to a place that keeps the record: start, win, pick, give up leave one finished run, stamped with the session\'s clock, and a refused step writes nothing'), J(per.peek().last));
  }

  /* L. the fight controller (tower_fight.js): the battle side of a floor, with navigation as callbacks */
  if (grp('L')) {
    const mkNav = () => { const calls = []; return { calls, toTower: (s) => calls.push(['tower', s === undefined ? null : s]), toHub: () => calls.push(['hub']), retry: (run) => calls.push(['retry', run.floor]) }; };
    const open = async (tw, o) => { const per = SS.memoryPersist(tw); const nav = mkNav(); const f = await TF.createTowerFight({ pack: PACK, persist: per, floor: 1, runId: 777, navType: 'navigate', nav, now: () => 7000, ...(o || {}) }); return { per, nav, f }; };
    const base = SS.reduceStart(mkT(), startArgs()).tower;
    const A1 = await open(base, { cfg: OLD });
    ok(A1.f.ok && A1.f.spec.validate === false && /^TOWER  FLOOR 1\/30  .+  BUFFS 0$/.test(A1.f.bar()) && J(A1.f.resultOptions(0)) === '["PICK A BUFF","BACK TO HUB"]' && J(A1.f.resultOptions(1)) === '["TO THE TOWER","BACK TO HUB"]' && J(A1.f.resultOptions(-1)) === '["TO THE TOWER","BACK TO HUB"]' && A1.f.tag === A1.f.spec.tower.tag, t('L1 (retriesPerFloor 0) a floor opens with its spec, a status line, and result buttons that say what is known (a win goes to the offer)'), A1.f.bar());
    const withLife = (() => { const y0 = (() => { const y = clone(SS.reduceFinishFloor(base, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 }).tower); y.current.offer = [{ id: 'extra-life', tier: 2 }, ...y.current.offer.slice(1)]; return y; })(); return SS.reducePick(y0, PK(y0, 'extra-life', { now: 3000 })).tower; })();
    const A2 = await open(withLife, { floor: 2, cfg: OLD });
    ok(A2.f.ok && J(A2.f.resultOptions(1)) === '["RETRY FLOOR","BACK TO HUB"]' && /LIVES 1$/.test(A2.f.bar()), t('L2 (retriesPerFloor 0) with an Extra Life the buttons offer a retry, and the status line shows the lives'), A2.f.bar());
    const bad = [await open(base, { floor: 2 }), await open(base, { runId: 5 }), await open(mkT())];
    ok(bad.every((b) => !b.f.ok && b.f.status === 'stale' && /not waiting/.test(b.f.message)), t('L3 a floor the run is not waiting for (another floor, another run, no run) is refused with words, and nothing is written'), J(bad.map((b) => b.f.status)));
    // the first choice marks the fight; a fresh arrival after that is a LEFT fight and counts as a loss
    const B1 = await open(base);
    B1.f.committed(); B1.f.committed(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok(B1.per.peek().current.fighting === true, t('L4 the first choice marks the fight (once)'), '');
    const rl = await TF.createTowerFight({ pack: PACK, persist: B1.per, floor: 1, runId: 777, navType: 'reload', nav: mkNav(), now: () => 7000 });
    const left = await TF.createTowerFight({ pack: PACK, persist: B1.per, floor: 1, runId: 777, navType: 'navigate', nav: mkNav(), now: () => 7100, cfg: OLD });
    ok(rl.ok && rl.status === 'resume' && !left.ok && left.status === 'abandoned' && /counted as a loss/.test(left.message) && /over/.test(left.message) && B1.per.peek().current === null && B1.per.peek().last.cleared === 0, t('L5 (retriesPerFloor 0) after the first choice a reload resumes the fight, and any other arrival is the earlier fight LEFT: it counted as a loss (here the run is over)'), left.message);
    // a real battle through the real engine, then the result is applied once and the buttons act on it
    const C1 = await open(base, { cfg: OLD });
    const spec = C1.f.spec, ctl = matchctl.createMatchController({ pack: PACK, ruleset: spec.ruleset, teams: spec.teams, seed: spec.seed, pick: spec.pick, names: spec.names, validate: spec.validate, sides: [{ kind: 'cpu', level: 'hard', seed: 5 }, spec.sides[1]] }); ctl.start();
    const summary = S.ms.summarizeMatch(ctl.battle.events, { viewSide: 0 }), info = { summary, ticks: 100, winner: ctl.winner };
    const p1 = C1.f.onMatchEnd(info), p2 = C1.f.onMatchEnd(info);
    const done = await p1;
    const won = ctl.winner === 0;
    ok(p1 === p2 && done.applied && done.next.step === (won ? 'offer' : 'over') && C1.per.peek().current === null === !won, t('L6 (retriesPerFloor 0) the finished battle is applied to the run ONCE however many times it is announced, and the run moves on by who won (' + (won ? 'won -> offer' : 'lost -> over') + ')'), J(done.next));
    ok(C1.f.recap().state === 'tower' && /^TOWER FLOOR 1$/.test(C1.f.recap().head) && C1.f.recap().notes.some((n) => /battle record/.test(n)) && /^SAVING|^COULD/.test((await open(base)).f.recap().head), t('L7 the recap\'s RECORD page says it is the Tower (and that the battle is not in the record), and "saving" until the write has answered'), J(C1.f.recap()));
    C1.f.onResult(won ? 'PICK A BUFF' : 'TO THE TOWER'); await new Promise((r) => setTimeout(r, 30));
    ok(J(C1.nav.calls) === J([['tower', won ? 'offer' : 'over']]), t('L8 the result button goes to the Tower screen the run is waiting for (the offer after a win, the result after the run ends)'), J(C1.nav.calls));
    const D1 = await open(base); D1.f.onMatchEnd({ summary: { ...summary, result: 'w', viewSide: 0 }, ticks: 1, winner: 0 }); await D1.f.onMatchEnd({ summary: { ...summary, result: 'w', viewSide: 0 } }); D1.f.onResult('BACK TO HUB'); await new Promise((r) => setTimeout(r, 30));
    ok(J(D1.nav.calls) === J([['hub']]), t('L9 BACK TO HUB goes to the hub'), J(D1.nav.calls));
    const E1 = await open(withLife, { floor: 2 }); E1.f.onMatchEnd({ summary: { ...summary, result: 'l' }, ticks: 1, winner: 1 }); await new Promise((r) => setTimeout(r, 20)); E1.f.onResult('RETRY FLOOR'); await new Promise((r) => setTimeout(r, 30));
    ok(E1.nav.calls.length === 1 && E1.nav.calls[0][0] === 'retry' && E1.nav.calls[0][1] === 2 && E1.per.peek().current.livesUsed === 1, t('L10 RETRY FLOOR after a loss with an Extra Life goes to the same floor again (the life is spent)'), J(E1.nav.calls));
    // leaving in the middle of the fight (after the first choice) is a loss
    const F1 = await open(base, { cfg: OLD }); F1.f.committed(); await new Promise((r) => setTimeout(r, 30)); F1.f.onQuit(); await new Promise((r) => setTimeout(r, 30));
    ok(J(F1.nav.calls) === J([['tower', 'over']]) && F1.per.peek().current === null && F1.per.peek().last.won === false, t('L11 (retriesPerFloor 0) leaving in the middle of the fight (after the first choice) is a loss: recorded, and then the Tower\'s result screen'), J(F1.nav.calls));
    // leaving BEFORE the first choice is not a played fight. THE RULE CHANGED 2026-11-17 (it used to drop a run that had cleared nothing and count as a lost floor on a later one): it now costs nothing and
    // WRITES nothing, under every config: the run waits for the same fight, and the Tower menu opens
    for (const [rule, RC] of [['retriesPerFloor 0', OLD], ['three retries a floor', CFG]]) {
      const F2 = await open(base, { cfg: RC }), before = J(F2.per.peek()); F2.f.onQuit(); await new Promise((r) => setTimeout(r, 30));
      ok(J(F2.nav.calls) === J([['tower', null]]) && J(F2.per.peek()) === before && F2.per.peek().current.floor === 1 && F2.per.peek().current.fighting === false && F2.per.peek().current.history.length === 0 && F2.per.peek().runs === 0 && F2.per.peek().last === null && Object.keys(F2.per.peek().achievements).length === 0 && F2.f.leaveCost('quit').cost === 'nothing', t('L11b (' + rule + ') leaving before the first choice costs nothing and writes nothing: the record is byte for byte what it was, the run still waits for floor 1, and the Tower menu opens'), J(F2.nav.calls));
    }
    const G1 = await open(base, { cfg: OLD }); G1.f.onMatchEnd({ summary: { ...summary, result: 'l', viewSide: 0 } }); await new Promise((r) => setTimeout(r, 20)); G1.f.onQuit(); await new Promise((r) => setTimeout(r, 30));
    ok(G1.per.peek().runs === 1 && G1.nav.calls.length === 1, t('L12 (retriesPerFloor 0) leaving AFTER the fight ended counts nothing more: the result was already applied'), J(G1.nav.calls));
  }

  /* M. the address and the one navigation seam (tower_launch.js) */
  if (grp('M')) {
    const nav = []; const navigate = (u) => nav.push(u);
    let rt = true, rtWhy = '';
    for (let floor = 1; floor <= 30; floor++) for (const life of [0, 1, 7]) {
      const run = { seed: 4294967295 - floor, floor, livesUsed: life }, u = TL.towerBattleHref(run, { profileId: 'p_0123456789abcdef' }), q = new URLSearchParams(u.slice(u.indexOf('?') + 1)), r = TL.parseTowerParams(q);
      if (!(r.ok && r.tower && r.tower.floor === floor && r.tower.run === run.seed && r.tower.tries === life && r.tower.profileId === 'p_0123456789abcdef' && u.startsWith('/pokemonarena/battle.html?tower=1&floor='))) { rt = false; rtWhy = u; }
    }
    ok(rt, t('M1 every floor\'s address (1..30, with and without lives spent) reads back to the same floor, run, try (the lives spent, for a run with no retry) and profile'), rtWhy);
    ok(TL.parseTowerParams(new URLSearchParams('')).tower === null && TL.parseTowerParams(new URLSearchParams('seed=5&format=3v3')).tower === null && TL.parseTowerParams(new URLSearchParams('floor=3&run=4&p=1&life=2')).tower === null, t('M2 an address with no Tower parameter is not a Tower address'), '');
    const badQ = ['tower=1', 'tower=2&floor=3&run=4', 'tower=1&floor=0&run=4', 'tower=1&floor=31&run=4', 'tower=1&floor=abc&run=4', 'tower=1&floor=1e1&run=4', 'tower=1&floor=3&run=-1', 'tower=1&floor=3&run=4294967296', 'tower=1&floor=3&run=0x10', 'tower=1&floor=3&run=4&life=1001', 'tower=1&floor=3&run=4&life=-1', 'tower=1&floor=3&run=4&p=bad id', 'tower=1&floor=3&run=4&p=' + 'a'.repeat(41), 'tower=1&floor=3&run=4&p=%3Cscript%3E'];
    ok(badQ.every((q) => TL.parseTowerParams(new URLSearchParams(q)).ok === false) && TL.parseTowerParams(new URLSearchParams('tower=1&floor=30&run=0')).ok, t('M3 hostile addresses are refused (' + badQ.length + ' of them: a wrong tower value, a missing, fractional, signed, hex or out-of-range number, a hostile profile id); the edges (floor 30, run 0) are accepted'), badQ.filter((q) => TL.parseTowerParams(new URLSearchParams(q)).ok).join(' | '));
    const pq = (q) => BB.parseBattleQuery('?' + q);
    const combos = ['team=ARENA1.AAAA.0000', 'foe=random', 'seed=5', 'format=3v3', 'cpu=hard', 'np=ABC&host=1', 'online=1'];
    ok(pq('tower=1&floor=3&run=44').ok && pq('tower=1&floor=3&run=44').params.tower.floor === 3 && pq('tower=1&floor=3&run=44').params.quick === false && combos.every((c) => { const r = pq('tower=1&floor=3&run=44&' + c); return !r.ok && r.error.param === 'tower'; }) && pq('seed=5&format=3v3').params.tower === null && pq('').params.tower === null && pq('').params.quick === true, t('M4 battle.html\'s parser accepts a Tower address, refuses it together with a team, a foe, a seed, a format, a CPU level or an online parameter (it takes all of them from the run), and leaves regular addresses with `tower: null`'), J(pq('tower=1&floor=3&run=44&seed=5')));
    ok(TL.launchFloorBattle({ seed: 9, floor: 4, livesUsed: 0 }, { navigate, profileId: 'p_x' }) === '/pokemonarena/battle.html?tower=1&floor=4&run=9&p=p_x' && nav[0] === '/pokemonarena/battle.html?tower=1&floor=4&run=9&p=p_x' && TL.returnToTower({ navigate, step: 'offer' }) === '/pokemonarena/#tower-offer' && TL.returnToTower({ navigate, step: 'over' }) === '/pokemonarena/#tower-last' && TL.returnToTower({ navigate, step: 'won' }) === '/pokemonarena/#tower-last' && TL.returnToTower({ navigate, step: 'retry' }) === '/pokemonarena/#tower' && TL.returnToTower({ navigate }) === '/pokemonarena/#tower' && TL.returnToHub({ navigate }) === '/pokemonarena/' && nav.length === 7, t('M5 launchFloorBattle, returnToTower and returnToHub each call the page\'s navigate once with the address the contract names'), J(nav));
    let thrown = 0; for (const fn of [() => TL.launchFloorBattle({ seed: 1, floor: 1 }, {}), () => TL.returnToTower({}), () => TL.towerBattleHref({ seed: -1, floor: 1 }), () => TL.towerBattleHref({ seed: 1, floor: 31 }), () => TL.towerBattleHref({ seed: 1, floor: 1 }, { profileId: '../x' })]) { try { fn(); } catch (e) { thrown++; } }
    ok(thrown === 5, t('M6 nothing navigates without a navigate callback, and no address is built outside the contract (RangeError / TypeError)'), String(thrown));
    // THE SEAM: nothing but tower_launch.js names a page or an address
    const DIR2 = opt.dir || SRC, strip = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const named = ['tower_session.js', 'tower_fight.js', 'tower_hub.js', 'tower_screen.js', 'tower_record.js', 'tower.js', 'tower_buffs.js', 'tower_config.js', 'achievements.js'].filter((f) => /\blocation\b|battle\.html|\.assign\(|\.replace\(\s*['"]\/|\/pokemonarena\/|history\.(push|replace)State|window\./.test(strip(fs.readFileSync(path.join(DIR2, f), 'utf8'))));
    // ... and the two PAGES that use the seam (the hub's boot.js and the battle page's battle_boot.js) spell out no hub or Tower address themselves: they go through HUB_PAGE_URL / TOWER_HUB_URL / launchFloorBattle / returnToTower
    const addrLit = /['"`]\/pokemonarena\/(#[a-z-]*)?['"`]|battle\.html\?tower|tower=1|['"`]#tower/;
    for (const f of ['battle_boot.js', 'boot.js']) if (addrLit.test(strip(fs.readFileSync(path.join(DIR2, f), 'utf8')))) named.push(f + ' (a hub or Tower address spelled out)');
    ok(named.length === 0, t('M7 THE SEAM: no Tower module except tower_launch.js reads or writes an address, `location`, `window` or a page name, and neither page (boot.js, battle_boot.js) spells out a hub or Tower address (so a hub that hosts the fight in its own page replaces one file)'), named.join());
    const launchTxt = strip(fs.readFileSync(path.join(DIR2, 'tower_launch.js'), 'utf8'));
    ok(!/\blocation\b|window\.|document\./.test(launchTxt) && /navigate\(url\)/.test(launchTxt), t('M8 tower_launch.js itself only builds strings and calls the navigate it is given: it touches neither `location` nor `window`'), '');
  }

  /* N. what reaches a battle: buffs in a Tower spec and NEVER in any other */
  if (grp('N')) {
    const pq = (q) => BB.parseBattleQuery('?' + q);
    const regular = [{ q: '', label: 'a Quick Battle' }, { q: 'format=6v6&cpu=hard&seed=77', label: 'a 6v6 Quick Battle on hard' }, { q: 'cpu=easy&seed=5&format=3v3', label: 'a Quick Battle on easy' }];
    const poison = (() => { const run = SS.reduceStart(mkT(), startArgs()).tower.current; const held = [{ id: 'power-training', p: 16 }, { id: 'titan-training', p: 8 }, { id: 'weak-foes', p: 16 }]; return { towerRun: { ...run, held }, tower: { current: { ...run, held } }, towerFight: { spec: { teams: [[], []] } }, session: {}, profile: { tower: { current: { ...run, held } } }, held, buffs: held, validate: false }; })();
    let leak = '', n = 0;
    for (const { q, label } of regular) for (const seed of [1, 2, 99, 4000000000]) {
      const parsed = pq(q + (/seed=/.test(q) ? '' : (q ? '&' : '') + 'seed=' + seed));
      if (!parsed.ok) { leak = 'parse ' + q; continue; }
      const a = await BB.resolveBattle(PACK, parsed.params), b = await BB.resolveBattle(PACK, parsed.params, poison), c = await BB.resolveBattle(PACK, { ...parsed.params, tower: null }, poison);
      n++;
      if (!a.ok || J(a.spec.teams) !== J(b.spec.teams) || J(a.spec.teams) !== J(c.spec.teams) || J({ ...a.spec, pack: 0 }) !== J({ ...b.spec, pack: 0 })) leak = label + ' seed ' + seed + ': a Tower input changed the spec';
      if ('tower' in a.spec || 'validate' in a.spec || a.spec.validate !== undefined) leak = label + ': a regular spec carries a Tower field or turns validation off';
      const base = matchctl.randomTeam(PACK, ((Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(1 + 0x7f4a7c15, 0xc2b2ae35)) >>> 0), 6, CFG.ruleset);
      void base;
    }
    ok(!leak && n >= 8, t('N1 a Quick Battle, with every Tower input a page could have to hand (a run with buffs, a Tower record, a fight controller, a session, a profile, a `held` list, validate:false) poisoning the call, resolves to exactly the spec it resolves to without them: teams, seed, sides, no `tower` field, no `validate` (' + n + ' cases)'), leak);
    // a saved team through the real profile and team code: the other regular form
    const DX = opt.dir || SRC, P = await imp(DX, 'profile.js'), TC = await imp(DX, 'teamcode.js');
    let teamLeak = '';
    try {
      const mon = (name) => { const sid = PACK.species.findIndex((s) => s && s.legal && s.name === name); const rec = rules.blankRec(sid, PACK, CFG.ruleset), ratio = PACK.species[sid].genderRatio; return P.createMon({ species: sid, level: rec.level, nature: rec.nature, abilitySlot: rec.abilitySlot, heldItem: rec.item, moves: rec.moves, ev: rec.evs, iv: rec.ivs, gender: ratio === 255 ? '-' : ratio === 254 ? 'F' : 'M' }); };
      const mons = ['Pikachu', 'Charizard', 'Snorlax'].map(mon), prof = P.createProfile({ trainerName: 'ASH' });
      prof.box = mons; prof.teams = [P.createTeam({ name: 'T', monIds: mons.map((m) => m.id) })];
      const enc = await TC.encodeTeamCode(TC.teamFromProfile(prof, prof.teams[0].id)), p6 = pq('team=' + enc + '&seed=9&format=6v6&cpu=normal');
      const a = await BB.resolveBattle(PACK, p6.params), b = await BB.resolveBattle(PACK, p6.params, poison);
      if (!a.ok || J(a.spec.teams) !== J(b.spec.teams) || 'tower' in a.spec || a.spec.validate !== undefined) teamLeak = 'a team battle changed or carries a Tower field: ' + (a.ok ? '' : J(a.error));
      const rec0 = a.ok ? a.spec.teams[0][0] : null;
      if (rec0 && ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].some((k) => rec0.evs[k] !== mons[0].ev[k])) teamLeak = 'a team battle\'s EVs are not the saved team\'s';
    } catch (e) { teamLeak = 'threw ' + e.message; }
    ok(!teamLeak, t('N2 a battle with a saved team (its EVs exactly the saved ones), likewise poisoned, is untouched'), teamLeak);
    // the Tower's own spec: the buff changes the battle (hash differs), a regular spec built from the same records does not know it
    const run = SS.reduceStart(mkT(), startArgs()).tower.current;
    const heldRun = { ...run, held: [{ id: 'power-training', p: 8 }, { id: 'speed-training', p: 8 }, { id: 'iron-wall', p: 8 }] };
    const play = (sp) => { const c = matchctl.createMatchController({ pack: PACK, ruleset: sp.ruleset, teams: sp.teams, seed: sp.seed, pick: sp.pick, names: sp.names, validate: sp.validate, sides: [{ kind: 'cpu', level: 'normal', seed: 3 }, sp.sides[1]] }); c.start(); return c.info(); };
    const sA = SS.towerFloorSpec(PACK, run), sB = SS.towerFloorSpec(PACK, heldRun);
    const iA = play(sA), iB = play(sB), iB2 = play(SS.towerFloorSpec(PACK, heldRun));
    ok(iA.logHash !== iB.logHash && iB.logHash === iB2.logHash && J(sA.teams[0]) !== J(sB.teams[0]) && J(sA.teams[1]) === J(sB.teams[1]), t('N3 a buff changes the Tower battle (another log hash) and only the player\'s side of it; the same buffs replay to the same battle'), iA.logHash + ' ' + iB.logHash);
    // the same buffed records through the REGULAR builder: validation refuses them (they pass only under validate:false), so a buffed team cannot slip into a regular battle by any path
    let refusedRegular = false; try { matchctl.createMatchController({ pack: PACK, ruleset: sB.ruleset, teams: sB.teams, seed: 1, pick: sB.pick, names: ['a', 'b'], sides: [{ kind: 'cpu', level: 'easy', seed: 1 }, { kind: 'cpu', level: 'easy', seed: 2 }] }); } catch (e) { refusedRegular = true; }
    ok(refusedRegular === true, t('N4 the buffed records are refused by the regular validation (a buffed team has more than the 510 EVs): only `validate:false`, which only a Tower spec sets, lets them in'), '');
    // the resume record: a Tower fight's tag, and a regular battle's lack of one
    const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
    const mkCtl = () => { const c = matchctl.createMatchController({ pack: PACK, ruleset: sA.ruleset, teams: sA.teams, seed: sA.seed, pick: sA.pick, names: sA.names, validate: false, sides: [{ kind: 'human' }, sA.sides[1]] }); c.start(); return c; };
    const stg = store(), key = RS.resumeKey('/pokemonarena/battle.html', '?tower=1&floor=1&run=777');
    const c1 = mkCtl(), rs1 = RS.createResumeStore({ storage: stg, key, seed: sA.seed, tag: sA.tower.tag }); rs1.attach(c1);
    c1.submit(0, { kind: 'preview', order: c1.pending(0).pick ? [0, 1, 2] : [] }); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    const saved = stg.getItem(key) ? JSON.parse(stg.getItem(key)) : null;
    const same = RS.createResumeStore({ storage: stg, key, seed: sA.seed, tag: sA.tower.tag }).restore({ ctl: mkCtl(), makeCtl: mkCtl, navType: 'reload' });
    const stg2 = store(); stg2.setItem(key, stg.getItem(key));
    const otherTag = RS.createResumeStore({ storage: stg2, key, seed: sA.seed, tag: SS.towerTag(heldRun) }).restore({ ctl: mkCtl(), makeCtl: mkCtl, navType: 'reload' });
    const stg3 = store(); stg3.setItem(key, stg.getItem(key));
    const untagged = RS.createResumeStore({ storage: stg3, key, seed: sA.seed }).restore({ ctl: mkCtl(), makeCtl: mkCtl, navType: 'reload' });
    ok(saved && saved.tag === sA.tower.tag && same.info.restored === true && otherTag.info.restored === false && stg2.getItem(key) === null && untagged.info.restored === false && stg3.getItem(key) === null, t('N5 a Tower fight\'s saved battle carries its tag and resumes only for the same run, floor, lives and buffs: with another buff set, or by a regular battle page (no tag), it is thrown away and the battle starts clean'), J({ saved: saved && saved.tag, same: same.info, other: otherTag.info.reason, untagged: untagged.info.reason }));
    const stg4 = store(), c4 = (() => { const c = matchctl.createMatchController({ pack: PACK, ruleset: CFG.ruleset, teams: [teams[0].recs, teams[1].recs], seed: 5, pick: 3, names: ['a', 'b'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 1 }] }); c.start(); return c; })();
    const rs4 = RS.createResumeStore({ storage: stg4, key: 'k', seed: 5 }); rs4.attach(c4); c4.submit(0, { kind: 'preview', order: [0, 1, 2] }); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok(stg4.getItem('k') && !('tag' in JSON.parse(stg4.getItem('k'))), t('N6 a regular battle\'s saved record has no tag field at all (the format regular pages have always written)'), String(stg4.getItem('k')).slice(0, 60));
    // THE SOURCE: the regular resolver and the page's regular paths name no Tower thing
    const bbText = fs.readFileSync(path.join(opt.dir || SRC, 'battle_boot.js'), 'utf8');
    const rb = bbText.slice(bbText.indexOf('export async function resolveBattle'), bbText.indexOf('/* ------------------------------------------------------------------------------------------------ the page */'));
    ok(rb.length > 500 && !/tower|held|buff/i.test(rb.replace(/\/\/[^\n]*/g, '')), t('N7 resolveBattle (the regular battles\' resolver) mentions no Tower, held buff or buff at all'), '');
    ok(/createMatchController\(\{[^}]*validate: spec\.validate/.test(bbText) && /createResumeStore\(\{[^}]*tag: towerFight \? towerFight\.tag : undefined/.test(bbText), t('N9 the battle page hands the spec\'s `validate` to the match builder and the Tower fight\'s tag to the resume store (a regular spec has neither, so nothing changes for it)'), '');
    const callers = [...bbText.matchAll(/applyTeam|applyFoe|battleSetup|towerFloorSpec|foeMods/g)].length;
    ok(callers === 0, t('N8 battle_boot.js never calls the buff interpreter itself (only tower_fight.js, loaded for a Tower address, does)'), String(callers));
  }

  /* Q. THE RELEASE HARDENING: a hostile or broken record can never lock the Tower; a fight is counted once, by the page that fights it, the moment the engine ends it; an old screen cannot answer a new offer */
  if (grp('Q')) {
    const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
    const mkNav = () => { const calls = []; return { calls, toTower: (s) => calls.push(['tower', s === undefined ? null : s]), toHub: () => calls.push(['hub']), retry: (run) => calls.push(['retry', run.floor]) }; };
    // (the fights of this group run under OLD, the rule they were written for: a loss or a left fight ENDS the run. Group R proves the same kill points, tabs and replays under the rule in force.)
    const openQ = (per, o) => TF.createTowerFight({ pack: PACK, persist: per, floor: 1, runId: 777, navType: 'navigate', nav: mkNav(), now: () => 7000, cfg: OLD, ...(o || {}) });
    const fresh = () => SS.memoryPersist(SS.reduceStart(mkT(), startArgs()).tower);
    const fakeCtl = () => { const subs = new Set(), c = { winner: null, battle: { events: [], s: { sides: [{ team: [] }, { team: [] }] } }, onEnd(cb) { subs.add(cb); return () => subs.delete(cb); }, end(w) { c.winner = w; for (const cb of [...subs]) cb(); } }; return c; };
    const sumW = () => ({ result: 'w', turns: 5, faints: 0 }), sumL = () => ({ result: 'l', turns: 7, faints: 3 });

    /* Q1-Q4: the stored record can never lock the Tower (a hostile import, a hand edit) */
    const MAXK = REC.TOWER_LIMITS;
    const hostile = (mod) => { const x = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'fixtures', 'pokemonarena', 'profile-v5-tower.json'), 'utf8')).tower; x.current = null; mod(x); return x; };
    const kinds = {
      'a record of 400 unknown buff ids': (x) => { for (let i = 0; i < 400; i++) x.buffsSeen['zz-' + i] = 1; },
      'a record of 500 unknown achievements': (x) => { for (let i = 0; i < 500; i++) x.achievements['zz-' + i] = 1; },
      'a runs counter of a billion': (x) => { x.runs = 1e9; },
      'a floors counter of a billion': (x) => { x.floors = 1e9; x.bosses = 1e9; },
      'a buff count of a billion': (x) => { x.buffsSeen['power-training'] = 1e9; },
      'wins of a billion in both formats': (x) => { x.winsByFormat = { '3v3': 1e9, '6v6': 1e9 }; x.wins = 2e9; x.runs = 1e9; },
    };
    const lockWhy = [];
    for (const [name, mod] of Object.entries(kinds)) {
      const rep = REC.normalizeTower(hostile(mod), () => {}, true), v = rep.value;
      if (REC.checkTowerShape(v).length) { lockWhy.push(name + ': the repair is not well formed'); continue; }
      if (!v.last || !v.achievements['first-floor'] || !v._unknown) { lockWhy.push(name + ': the rest of the climb (last run, achievements, unknown fields) was thrown away with the bad field'); continue; }
      // the first legitimate steps after the repair: a new buff id, a new achievement, one more of every counter: they must still be well formed
      const g = clone(v); g.buffsSeen['brand-new'] = 1; g.achievements['brand-new'] = 5; g.runs += 1; g.wins += 1; g.winsByFormat['3v3'] += 1; g.floors += 30; g.bosses += 3; for (const k of Object.keys(g.buffsSeen)) g.buffsSeen[k] += 1;
      if (REC.checkTowerShape(g).length) lockWhy.push(name + ': one more step makes the record fail its own check (' + REC.checkTowerShape(g)[0] + ')');
    }
    ok(lockWhy.length === 0, t('Q1 whatever a hostile record holds (400 junk ids, 500 junk achievements, counters at a billion), the repaired record has room for the very next real step: it can never be left on the edge of its own limit'), lockWhy.join(' | '));
    {
      const r1 = REC.normalizeTower(hostile((x) => { for (let i = 0; i < 400; i++) x.buffsSeen['zz-' + i] = 1; x.buffsSeen['power-training'] = 3; }), () => {}, true);
      const r2 = REC.normalizeTower(hostile((x) => { for (let i = 0; i < 500; i++) x.achievements['zz-' + i] = 1; }), () => {}, true);
      const r3 = REC.normalizeTower(hostile((x) => { x.runs = 1e9; x.floors = 1e9 - 5; }), () => {}, true);
      ok(Object.keys(r1.value.buffsSeen).length === MAXK.buffsKeep && MAXK.buffsKeep < MAXK.buffsMax && Object.keys(r1.rejected.buffsSeen).length >= 150, t('Q2 the repair keeps at most ' + MAXK.buffsKeep + ' buff ids (the check allows ' + MAXK.buffsMax + '); what does not fit is handed back, not thrown away'), J(Object.keys(r1.value.buffsSeen).length) + ' ' + J(Object.keys(r1.rejected.buffsSeen || {}).length));
      ok(Object.keys(r2.value.achievements).length === MAXK.achievementsKeep && MAXK.achievementsKeep < MAXK.achievementsMax && Object.keys(r2.rejected.achievements).length >= 100 && r3.value.runs <= 10 && r3.rejected.runs === 1e9 && r3.value.floors <= 100 && r3.rejected.floors === 1e9 - 5 && MAXK.counterKeep <= MAXK.counterMax - 1e6, t('Q3 the repair keeps at most ' + MAXK.achievementsKeep + ' achievements (the check allows ' + MAXK.achievementsMax + ') and no counter within a million of the limit (the over-limit value is handed back)'), J([Object.keys(r2.value.achievements).length, r3.value.runs, r3.value.floors]));
    }
    // a whole climb on a profile the hostile file made, through the REAL transaction shape: nothing throws, the step is applied
    {
      let threw = '';
      for (const [name, mod] of Object.entries(kinds)) {
        try {
          const tw = REC.normalizeTower(hostile(mod), () => {}, true).value, per = SS.memoryPersist(tw);
          const s = SS.createTowerSession({ pack: PACK, persist: per, now: () => 5000 });
          await s.startRun({ seed: 11, format: '3v3', team: null });
          for (let g = 0; g < 14; g++) { const cur = per.peek().current; if (!cur) break; if (cur.phase === 'offer') await s.pick(PK(per.peek(), cur.offer[0].id)); else await s.finishFloor({ floor: cur.floor, seed: 11, result: cur.floor < 4 ? WIN(cur.floor) : LOSS(cur.floor) }); }          // (floor 4 is lost four times: three retries, then the loss that ends the run)
          const after = per.peek();
          if (after.current !== null || after.runs < 1 || REC.checkTowerShape(after).length) threw = threw || name + ': ended as ' + J({ cur: !!after.current, runs: after.runs, bad: REC.checkTowerShape(after)[0] });
        } catch (e) { threw = threw || name + ': ' + e.message; }
      }
      ok(!threw, t('Q4 a whole climb (start, wins, a buff, a floor lost until its retries are used up) on each hostile record records every step and ends the run: the Tower is never locked'), threw);
    }

    /* Q5-Q6: a bag of unknown values is held to a size */
    {
      const big = hostile((x) => { x._unknown = { keepMe: { a: 1 }, huge: 'x'.repeat(2e6), other: 'y'.repeat(30000), newest: 'z'.repeat(20000) }; });
      const r = REC.normalizeTower(big, () => {}, true), bag = r.value._unknown || {};
      ok(JSON.stringify(bag).length <= MAXK.bagMax && !('huge' in bag) && 'newest' in bag && 'other' in bag && !('keepMe' in bag), t('Q5 a Tower record\'s bag of unknown values is held to ' + MAXK.bagMax + ' characters: the oldest keys go first, a key bigger than the allowance goes too, the newest are kept'), J(Object.keys(bag)));
      const small = hostile((x) => { x._unknown = { futureThing: { keep: 'me' }, n: 5 }; });
      const rs = REC.normalizeTower(small, () => {}, true), again = REC.normalizeTower(r.value, () => {}, true);
      ok(J(rs.value._unknown) === J(small._unknown) && J(again.value) === J(r.value), t('Q6 a small bag is untouched (a real Tower record is under 10 KB), and capping is a fixed point'), J(rs.value._unknown));
      ok(J(REC.capBag({ a: 1 }, 100)) === '{"a":1}' && J(REC.capBag({ a: 'x'.repeat(60), b: 'y'.repeat(60), c: 1 }, 100)) === '{"b":"' + 'y'.repeat(60) + '","c":1}' && REC.capBag(7) === 7 && REC.sanitiseStamp(-5) === 0 && REC.sanitiseStamp(1.5) === 0 && REC.sanitiseStamp(NaN) === 0 && REC.sanitiseStamp(1700000000000) === 1700000000000 && REC.sanitiseStamp(9e18) === 0 && REC.sanitiseStamp('5') === 0, t('Q7 capBag drops oldest-first and leaves a bag that fits alone; sanitiseStamp keeps a whole number of ms in range and turns anything else into 0'), '');
    }

    /* Q8-Q9: a run that cannot be read is DROPPED, never folded; a run that cleared nothing is not a run */
    {
      const base = SS.reduceStart(mkT(), startArgs()).tower;
      const brokenKinds = { 'history [null]': (c) => { c.history = [null]; }, 'held [null]': (c) => { c.held = [null]; }, 'history [{}]': (c) => { c.history = [{}]; }, 'a held buff that does not exist': (c) => { c.held = [{ id: 'no-such-buff', p: 1 }]; }, 'team recs [7]': (c) => { c.team.recs = [7]; } };
      const shapeBad = [], dropBad = [];
      for (const [name, mod] of Object.entries(brokenKinds)) {
        const tw = clone(base); mod(tw.current);
        if (name.endsWith('[null]') || name.endsWith('[7]')) { if (REC.isRunShape(tw.current)) shapeBad.push(name); }
        let g = null, st = null;
        try { g = SS.reduceGiveUp(tw, { seed: 777, now: 9 }); st = SS.reduceStart(tw, startArgs({ seed: 900, replace: true, now: 9 })); } catch (e) { dropBad.push(name + ' threw ' + e.message); continue; }
        if (!(g.applied && g.tower.current === null && g.tower.runs === 0 && g.tower.last === null && g.dropped === true && REC.checkTowerShape(g.tower).length === 0)) dropBad.push(name + ' give-up: ' + J(g).slice(0, 80));
        if (!(st.applied && st.tower.current && st.tower.current.seed === 900 && st.tower.runs === 0 && st.tower.last === null)) dropBad.push(name + ' new run: ' + J(st).slice(0, 80));
      }
      ok(shapeBad.length === 0, t('Q8 the shallow check refuses a run whose history, held list or team holds a null or a number (such a run is never kept, it is handed back in the bag)'), shapeBad.join(','));
      ok(dropBad.length === 0, t('Q9 DROP THIS RUN and NEW RUN on a run that cannot be read (null / empty history rows, an unknown buff, a junk team) drop it: no throw, nothing counted, no `last`, the Tower is free again'), dropBad.join(' | '));
      const broken = clone(base); broken.current.history = [{}];
      const b0 = SS.reduceBeginFloor(broken, { pack: PACK, floor: 1, seed: 777, navType: 'navigate', now: 5 });
      ok(b0.status === 'stale' && !b0.applied, t('Q10 a fight is never opened on a run that cannot be read (it is stale; the hub offers to drop it)'), J(b0));
    }
    {
      let tw = mkT(), clk = 100;
      for (let i = 0; i < 25; i++) { tw = SS.reduceStart(tw, startArgs({ seed: 100 + i, replace: true, now: clk++ })).tower; }
      const g25 = SS.reduceGiveUp(tw, { seed: 124, now: clk++ });
      let tw2 = mkT(); const ev = [];
      for (let i = 0; i < 25; i++) { const s0 = SS.reduceStart(tw2, startArgs({ seed: 300 + i, now: clk++ })); const g = SS.reduceGiveUp(s0.tower, { seed: 300 + i, now: clk++ }); tw2 = g.tower; ev.push(g.dropped === true); }
      ok(tw.runs === 0 && g25.tower.runs === 0 && g25.tower.last === null && Object.keys(g25.tower.achievements).length === 0 && tw2.runs === 0 && Object.keys(tw2.achievements).length === 0 && ev.every(Boolean), t('Q11 starting and giving up (or starting over) 25 times with no floor cleared counts for nothing: no run, no last run, no run-count or Rock Bottom achievement'), J({ runs: tw.runs, a: Object.keys(g25.tower.achievements) }));
      const w = SS.reduceFinishFloor(SS.reduceStart(mkT(), startArgs()).tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 5 }).tower;
      const gu = SS.reduceGiveUp(w, { seed: 777, now: 6 }), rp = SS.reduceStart(w, startArgs({ seed: 5, replace: true, now: 6 }));
      ok(gu.finished === true && gu.tower.runs === 1 && gu.tower.last.cleared === 1 && rp.tower.runs === 1, t('Q12 a run that DID clear a floor still counts when it is given up or started over'), J(gu.tower.runs));
    }

    /* Q13-Q16: the attempt identity (two tabs, a replayed loss) */
    {
      const tw0 = SS.reduceStart(mkT(), startArgs()).tower;
      const mA = SS.reduceMarkFight(tw0, { floor: 1, seed: 777, attempt: 101, tries: 0 }), mB = SS.reduceMarkFight(mA.tower, { floor: 1, seed: 777, attempt: 202, tries: 0 }), mA2 = SS.reduceMarkFight(mA.tower, { floor: 1, seed: 777, attempt: 101, tries: 0 });
      const none = SS.reduceMarkFight(tw0, { floor: 1, seed: 777, tries: 0 }), zero = SS.reduceMarkFight(tw0, { floor: 1, seed: 777, attempt: 0 }), wrongLife = SS.reduceMarkFight(tw0, { floor: 1, seed: 777, attempt: 5, tries: 3 });
      ok(mA.applied && mA.tower.current.fighting && mA.tower.current.attempt === 101 && mB.applied === false && mB.taken === true && mA2.applied === false && mA2.why === 'already marked' && !mA2.taken && none.applied === false && zero.applied === false && wrongLife.applied === false && REC.checkTowerShape(mA.tower).length === 0, t('Q13 a fight is marked with its page\'s attempt number: the same page may ask again, ANOTHER page is refused as taken, a mark without a number or for another try of the floor is refused'), J([mA.applied, mB, mA2.why]).slice(0, 160));
      const fB = SS.reduceFinishFloor(mA.tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 9, attempt: 202, tries: 0 }), fNone = SS.reduceFinishFloor(mA.tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 9 }), fA = SS.reduceFinishFloor(mA.tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 9, attempt: 101, tries: 0 });
      ok(fB.applied === false && fB.taken === true && fNone.applied === false && fA.applied && fA.tower.current.attempt === 0 && fA.tower.current.fighting === false, t('Q14 only the page that marked the fight can finish it: another page\'s result, or one with no attempt, changes nothing; the owner\'s is applied and clears the mark'), J([fB.why, fNone.why]));
      const runOf = (mod) => { const x = clone(tw0.current); mod(x); const a = T.parseRun(x, { pack: null }).ok, b = REC.isRunShape(x); return a === b ? a : 'the two checks disagree'; };
      const legacy = (() => { const x = clone(tw0.current); delete x.attempt; return x; })();
      ok(runOf(() => {}) === true && runOf((x) => { x.fighting = true; x.attempt = 5; }) === true && runOf((x) => { x.fighting = true; delete x.attempt; }) === true && T.parseRun(legacy, { pack: null }).ok && REC.isRunShape(legacy) && T.parseRun({ ...clone(tw0.current), attempt: 5 }, { pack: null }).ok === false && runOf((x) => { x.fighting = true; x.attempt = -1; }) === false && runOf((x) => { x.fighting = true; x.attempt = 1.5; }) === false && runOf((x) => { x.fighting = true; x.attempt = 4294967296; }) === false && !T.parseRun({ ...clone(tw0.current), junk: 1 }, { pack: null }).ok, t('Q13b the attempt is part of the stored run: 0 when no fight is marked, a whole number up to 2^32-1 when one is; a run stored before the key existed (no `attempt`) is still a run; a number without a fight, or a fractional / negative / huge one, is refused (by the deep parser and by the shallow check)'), '');
      // the abandoned fight of tab A still counts although tab B plays the floor to its end
      const left = SS.reduceBeginFloor(mA.tower, { pack: PACK, floor: 1, seed: 777, navType: 'navigate', now: 20, cfg: OLD });
      ok(left.status === 'abandoned' && left.applied && left.tower.current === null && left.tower.runs === 1 && left.tower.last && left.tower.last.won === false, t('Q15 (retriesPerFloor 0) the fight another tab marked is LEFT when this one arrives afresh: it counts as a loss (the system finishes it for that attempt)'), J(left.status));
      // an Extra Life retry: the late or replayed loss of the earlier try is refused
      const wL = (() => { const y = clone(SS.reduceFinishFloor(tw0, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 }).tower); y.current.offer = [{ id: 'extra-life', tier: 2 }, ...y.current.offer.slice(1)]; return SS.reducePick(y, PK(y, 'extra-life', { now: 3000 })).tower; })();
      const mk2 = SS.reduceMarkFight(wL, { floor: 2, seed: 777, attempt: 301, tries: 0 }), l1 = SS.reduceFinishFloor(mk2.tower, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 4000, attempt: 301, tries: 0 });
      const replay = SS.reduceFinishFloor(l1.tower, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 4100, attempt: 301, tries: 0 }), replayNoMark = SS.reduceFinishFloor(l1.tower, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 4100, tries: 0 });
      ok(l1.applied && l1.next.step === 'retry' && l1.tower.current.livesUsed === 1 && replay.applied === false && replayNoMark.applied === false && /try of the floor is over/.test(replay.why) && SS.reduceFinishFloor(l1.tower, { floor: 2, seed: 777, result: LOSS(2), pack: PACK, now: 4100, tries: 1 }).applied === true, t('Q16 after an Extra Life is spent, a late or replayed loss of the earlier try is refused (it names the try it is for); a result of the NEW try is accepted'), J([replay.why, replayNoMark.why]));
    }

    /* Q17: a pick names the offer it was shown in */
    {
      const w1 = SS.reduceFinishFloor(SS.reduceStart(mkT(), startArgs()).tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 }).tower, id0 = w1.current.offer[0].id, key = SS.offerKey(w1.current);
      const bad = [['no identity', { seed: 777, id: id0 }], ['another floor', { seed: 777, id: id0, floor: 3, offer: key }], ['another offer', { seed: 777, id: id0, floor: 2, offer: '2:deadbeef' }], ['a key of the wrong floor', { seed: 777, id: id0, floor: 2, offer: '3:' + key.split(':')[1] }]];
      const refused = bad.filter(([, a]) => SS.reducePick(w1, { ...a, now: 5 }).applied === false).length;
      const ok1 = SS.reducePick(w1, PK(w1, id0, { now: 5 }));
      // the old screen answers after the run has moved on to the NEXT offer (floor 3): its floor / key are the old ones
      let tw = ok1.tower; tw = SS.reduceFinishFloor(tw, { floor: 2, seed: 777, result: WIN(2), pack: PACK, now: 6 }).tower;
      const stale = SS.reducePick(tw, { seed: 777, id: null, floor: 2, offer: key, now: 7 }), staleAny = SS.reducePick(tw, { seed: 777, id: tw.current.offer[0].id, floor: 2, offer: key, now: 7 }), fresh3 = SS.reducePick(tw, PK(tw, null, { now: 8 }));
      const forged = clone(w1); forged.current.offer = forged.current.offer.slice().reverse();
      const sameFloorOtherOffer = SS.reducePick(forged, { seed: 777, id: forged.current.offer[0].id, floor: 2, offer: key, now: 5 });
      ok(refused === bad.length && sameFloorOtherOffer.applied === false && ok1.applied && tw.current.phase === 'offer' && tw.current.floor === 3 && stale.applied === false && stale.stale === true && staleAny.applied === false && fresh3.applied && fresh3.tower.current.skips === 1 && SS.offerKey(w1.current) !== SS.offerKey(tw.current), t('Q17 a pick is refused unless it names the offer it was shown in (its floor and key): an old screen\'s skip or take cannot be applied to a LATER offer, and the current offer\'s own answer is accepted'), J([refused, stale.why]));
    }

    /* Q18: the timestamp */
    {
      const bad = [-5, 1.5, NaN, Infinity, 9e18, 'x', null, undefined]; let why = '';
      for (const b of bad) {
        try {
          const per = SS.memoryPersist(mkT()), s = SS.createTowerSession({ pack: PACK, persist: per, now: () => b });
          await s.startRun({ seed: 41, format: '3v3', team: null }); const r = await s.finishFloor({ floor: 1, seed: 41, result: WIN(1) });
          const tw = per.peek();
          if (!r || !r.applied || tw.achievements['first-floor'] !== 0 || REC.checkTowerShape(tw).length) why = why || String(b) + ': ' + J(r).slice(0, 60);
          const per2 = SS.memoryPersist(mkT()), s2 = SS.createTowerSession({ pack: PACK, persist: per2, now: () => b, cfg: OLD });          // (a lost run: under OLD the loss of floor 1 ends it)
          await s2.startRun({ seed: 42, format: '3v3', team: null }); const r2 = await s2.finishFloor({ floor: 1, seed: 42, result: LOSS(1) }), tw2 = per2.peek();
          if (!r2 || !r2.applied || tw2.last.at !== 0 || tw2.achievements['rock-bottom'] !== 0 || REC.checkTowerShape(tw2).length) why = why || String(b) + ' (a lost run): ' + J(r2).slice(0, 60);
        } catch (e) { why = why || String(b) + ' threw ' + e.message; }
      }
      const u = A.unlock(mkT(), ['first-floor'], -5), u2 = A.unlock(mkT(), ['first-floor'], 1234);
      ok(!why && u.achievements['first-floor'] === 0 && u2.achievements['first-floor'] === 1234, t('Q18 an achievement stamp from a clock that says -5, 1.5, NaN, Infinity, text or nothing is stored as 0, never as something the record\'s own check refuses'), why);
    }

    /* Q19-Q24: the fight hears the match when the ENGINE ends it; every kill point counts a result exactly once */
    for (const outcome of ['l', 'w']) {
      const SUM = outcome === 'l' ? sumL : sumW, endWinner = outcome === 'l' ? 1 : 0;
      // (1) killed BEFORE the end (after the first choice): a reload resumes, any other arrival is a loss
      {
        const per = fresh(), f = await openQ(per, { nonce: () => 41 }); f.committed(); await ticks();
        const rl = await openQ(per, { navType: 'reload' }), left = await openQ(per, { navType: 'navigate' });
        ok(rl.ok && rl.status === 'resume' && !left.ok && left.status === 'abandoned' && per.peek().runs === 1 && per.peek().current === null, t('Q19[' + outcome + '] kill point 1, during the fight: a reload resumes it; closing the page and coming back is the fight LEFT, a loss, counted once'), J([rl.status, left.status, per.peek().runs]));
      }
      // (2) killed AFTER the engine ended, BEFORE the result screen: the Tower already heard it (no scene, no result screen, no onMatchEnd from the page)
      {
        const per = fresh(), f = await openQ(per, { nonce: () => 41 }); f.committed(); await ticks();
        const c = fakeCtl(); f.watchEngine(c, SUM); c.end(endWinner); await ticks();
        const tw = per.peek(), counted = outcome === 'l' ? tw.current === null && tw.runs === 1 && tw.last.won === false && tw.last.cleared === 0 : tw.current && tw.current.phase === 'offer' && tw.current.floor === 2 && tw.current.history.length === 1 && tw.current.history[0].result === 'w' && tw.current.fighting === false;
        const rl = await openQ(per, { navType: 'reload' }), nav = await openQ(per, { navType: 'navigate' }), bf = await openQ(per, { navType: 'back_forward' });
        ok(counted && !rl.ok && rl.status === 'stale' && !nav.ok && nav.status === 'stale' && !bf.ok && bf.status === 'stale', t('Q20[' + outcome + '] kill point 2, after the engine ended and before the result screen: the result is already in the record, and reloading, going back or typing the address gives the "already counted" page, never a fresh fight'), J(tw).slice(0, 120) + ' ' + J([rl.status, nav.status]));
        const before = J(per.peek());
        const info = { summary: SUM(), ticks: 9, winner: endWinner }, p1 = f.onMatchEnd(info), p2 = f.onMatchEnd(info); await p1;
        f.onQuit(); await ticks();
        ok(p1 === p2 && J(per.peek()) === before, t('Q21[' + outcome + '] kill point 3, on the result screen: the scene announcing the same match (twice), and leaving afterwards, changes nothing (counted exactly once)'), '');
        f.onResult(outcome === 'l' ? 'TO THE TOWER' : 'PICK A BUFF'); await new Promise((r) => setTimeout(r, 20));
        const done = await openQ(per, { navType: 'reload' });
        ok(!done.ok && done.status === 'stale' && J(per.peek()) === before && /result is already counted/.test(done.message), t('Q22[' + outcome + '] kill point 4, after the result button: still once, and the page says the result is already counted'), done.message);
      }
    }
    {
      // an engine that has ALREADY ended when the page attaches (a reload that replayed to the end) is heard at once
      const per = fresh(), f = await openQ(per, { nonce: () => 41 }); f.committed(); await ticks();
      const c = fakeCtl(); c.winner = 1; const off = f.watchEngine(c, sumL); await ticks();
      ok(typeof off === 'function' && per.peek().current === null && per.peek().runs === 1, t('Q23 attaching to a controller whose match is already over reports it at once'), J(per.peek().runs));
      // a summary that throws still counts the match (by who won)
      const per2 = fresh(), f2 = await openQ(per2, { nonce: () => 42 }); const c2 = fakeCtl(); f2.watchEngine(c2, () => { throw new Error('no summary'); }); c2.end(1); await ticks();
      ok(per2.peek().current === null && per2.peek().runs === 1, t('Q24 a summariser that throws still gets the loss recorded (the winner decides)'), '');
    }
    // marked, reloaded, and NOTHING to resume from: left, a loss, counted once (never a free restart)
    {
      const per = fresh(), f = await openQ(per, { nonce: () => 41 }); f.committed(); await ticks();
      const rl = await openQ(per, { navType: 'reload' });
      const a = await rl.leaveUnrestorable(), a2 = await rl.leaveUnrestorable();
      ok(rl.ok && rl.status === 'resume' && /counted as a loss/.test(a.message) && a2.message === a.message && per.peek().runs === 1 && per.peek().current === null && per.peek().last.won === false, t('Q25 a fight that is marked, reloaded and has nothing to resume from is LEFT: a loss, counted once however often it is asked, with the words that say so'), a.message);
      const wl = (() => { const y = clone(SS.reduceFinishFloor(SS.reduceStart(mkT(), startArgs()).tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 }).tower); y.current.offer = [{ id: 'extra-life', tier: 2 }, ...y.current.offer.slice(1)]; return SS.reducePick(y, PK(y, 'extra-life', { now: 3000 })).tower; })();
      const per3 = SS.memoryPersist(wl), g = await TF.createTowerFight({ pack: PACK, persist: per3, floor: 2, runId: 777, navType: 'navigate', nav: mkNav(), now: () => 7000, nonce: () => 55 }); g.committed(); await ticks();
      const r3 = await TF.createTowerFight({ pack: PACK, persist: per3, floor: 2, runId: 777, navType: 'reload', nav: mkNav(), now: () => 7000 }), a3 = await r3.leaveUnrestorable();
      ok(r3.status === 'resume' && /Extra Life was spent/.test(a3.message) && per3.peek().current.livesUsed === 1 && per3.peek().current.fighting === false && per3.peek().current.attempt === 0, t('Q26 ... with an Extra Life the unrestorable fight spends it, and the floor can be tried again'), a3.message);
    }
    // two tabs: the second cannot finish the first's fight, nor make the first's abandoned fight free
    {
      const per = fresh(); let dupA = 0, dupB = 0;
      const A = await openQ(per, { nonce: () => 101, onDuplicate: () => { dupA++; } }), B = await openQ(per, { nonce: () => 202, onDuplicate: () => { dupB++; } });
      A.committed(); await ticks(); B.committed(); await ticks();
      const r = await B.onMatchEnd({ summary: sumW(), ticks: 1, winner: 0 });
      const cur = per.peek().current;
      ok(A.ok && B.ok && dupA === 0 && dupB === 1 && r.applied === false && cur.fighting === true && cur.attempt === 101 && cur.history.length === 0 && /not|already|another/i.test(B.recap().head + B.recap().notes.join(' ')), t('Q27 two tabs open on the same floor: the second to make a choice is told it is a duplicate, its winning result is refused, and the first tab\'s fight stays the one that counts'), J(r).slice(0, 100));
      const left = await openQ(per, { navType: 'navigate' });
      ok(!left.ok && left.status === 'abandoned' && per.peek().current === null && per.peek().runs === 1 && per.peek().last.won === false, t('Q28 ... and when the first tab is abandoned, that is still a loss: the second tab\'s play did not make it free'), left.status);
      // a reload of the SAME tab takes over its own attempt and can finish
      const per2 = fresh(), A2 = await openQ(per2, { nonce: () => 101 }); A2.committed(); await ticks();
      const R2 = await openQ(per2, { navType: 'reload', nonce: () => 999 });
      const rr = await R2.onMatchEnd({ summary: sumW(), ticks: 1, winner: 0 });
      ok(R2.status === 'resume' && R2.run.attempt === 101 && rr.applied === true && per2.peek().current.phase === 'offer', t('Q29 a reload of the fight under way takes over that fight\'s own attempt: it can finish it (and does not mark again)'), J(rr).slice(0, 100));
    }
    {
      // the late duplicate of an earlier try, through the page's own functions (an Extra Life was spent in between)
      const wl = (() => { const y = clone(SS.reduceFinishFloor(SS.reduceStart(mkT(), startArgs()).tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 }).tower); y.current.offer = [{ id: 'extra-life', tier: 2 }, ...y.current.offer.slice(1)]; return SS.reducePick(y, PK(y, 'extra-life', { now: 3000 })).tower; })();
      const per = SS.memoryPersist(wl), a = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 2, runId: 777, nonce: () => 301 });
      await a.markFight(); const first = await a.finish(LOSS(2)), again = await a.finish(LOSS(2));
      ok(first.applied && first.next.step === 'retry' && again.applied === false && per.peek().current.livesUsed === 1 && per.peek().current.phase === 'battle', t('Q30 through startTowerFloor: the loss that spent the Extra Life is applied once; sent again by a late tab it is refused and the retry is untouched'), J(again));
      const b = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 2, runId: 777, nonce: () => 302 });
      ok(b.ok && b.tries === 1 && b.attempt === 302, t('Q31 the retry is a new try (try 1) with its own attempt number'), J([b.tries, b.attempt]));
    }

    /* Q32-Q35: the wiring of the battle page (battle_boot.js), checked in its source: it is page code, so what is proved is that each guarantee is wired where the logic needs it */
    {
      const bb = fs.readFileSync(path.join(opt.dir || SRC, 'battle_boot.js'), 'utf8'), idx = (s) => bb.indexOf(s);
      ok(idx('towerFight.watchEngine(ctl, summarizeMatch)') > idx('ctl = rs.ctl;') && idx('towerFight.watchEngine(ctl, summarizeMatch)') < idx('resumeStore.attach(ctl)') && /import \{ summarizeMatch \} from '\.\/match_stats\.js'/.test(bb), t('Q32 the battle page hands the Tower the match at the ENGINE\'S end (watchEngine on the final controller, before the resume record is cleared) with the same summariser the scene uses'), '');
      ok(/towerFight\.status === 'resume' && !rs\.info\.restored/.test(bb) && /await towerFight\.leaveUnrestorable\(\)/.test(bb), t('Q33 the battle page counts a marked fight that cannot be restored as LEFT (leaveUnrestorable), never restarts it free'), '');
      const iPres = idx("import('./battle_ask.js')"), iGuard = idx('if (towerFight) return;');
      ok(iGuard > 0 && iPres > iGuard && bb.includes('open: towerFight ? undefined : openSwitch'), t('Q34 OPEN TO BATTLES is not mounted in a Tower fight: the guard comes before the presence module is loaded, and the pause menu of a Tower fight is given no OPEN TO BATTLES row (an Accepted challenge would leave the fight)'), '');
      ok(/nonce: freshSeed/.test(bb) && /onDuplicate:/.test(bb), t('Q35 the battle page gives each fight a fresh attempt number (from crypto) and shows the duplicate-tab notice'), '');
    }

    /* Q36-Q37: the hub addresses are named once (tower_launch.js), and a regular address ignores the Tower's parameters */
    {
      const bbs = fs.readFileSync(path.join(opt.dir || SRC, 'battle_boot.js'), 'utf8');
      ok(/import \{[^}]*HUB_PAGE_URL[^}]*TOWER_HUB_URL[^}]*\} from '\.\/tower_launch\.js'/.test(bbs) && (bbs.match(/TOWER_HUB_URL/g) || []).length >= 3 && (bbs.match(/HUB_PAGE_URL/g) || []).length >= 5, t('Q36 battle_boot.js reaches the hub and the Tower\'s screens only through the two constants of tower_launch.js (the M7 scan proves no address is spelled out beside them)'), '');
      const pq = (q) => BB.parseBattleQuery('?' + q);
      const stray = ['p=1', 'run=3', 'floor=2', 'life=1', 'p=x&floor=99&run=zz', 'floor=3&run=4&life=2&p=abc', 'p=%3Cscript%3E'];
      ok(stray.every((q) => { const r = pq(q); return r.ok && r.params.tower === null && r.params.quick === true; }) && TL.parseTowerParams(new URLSearchParams('floor=3&run=4')).tower === null && pq('seed=5&format=3v3&p=1').ok && pq('seed=5&format=3v3&p=1').params.tower === null && !pq('tower=1&floor=0&run=4').ok && !pq('tower=1&p=bad id&floor=1&run=4').ok && !pq('tower=2&floor=1&run=4').ok, t('Q37 an address with p, run, floor or life but NO tower=1 is a regular address and they are ignored, as the build before the Tower ignored them; with tower=1 every hostile value is still refused'), J(pq('p=1')));
    }

    /* Q38-Q41: the tab-local resume record carries the attempt. A tab that was told it is a duplicate saves its own choices (under its own number) and, RELOADED, used to resume the first tab's fight and finish it. */
    {
      const sess = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
      const key = RS.resumeKey('/pokemonarena/battle.html', '?tower=1&floor=1&run=777');
      const mkCtl = (sp) => { const c = matchctl.createMatchController({ pack: PACK, ruleset: sp.ruleset, teams: sp.teams, seed: sp.seed, pick: sp.pick, names: sp.names, validate: false, sides: [{ kind: 'human' }, sp.sides[1]] }); c.start(); return c; };
      // one TAB, wired as battle_boot.js wires it: its own session storage, a resume store that names the page's attempt, the fight's first-choice hook
      const tab = async (per, o) => { const f = await openQ(per, o), st = sess(); return { f, st, rs: RS.createResumeStore({ storage: st, key, seed: f.spec.seed, tag: f.tag, attempt: f.attempt }), ctl: null }; };
      const play = async (tb) => { tb.ctl = mkCtl(tb.f.spec); tb.rs.attach(tb.ctl); tb.ctl.onLocalChoice(() => tb.f.committed()); tb.ctl.submit(0, { kind: 'preview', order: [0, 1, 2] }); await ticks(); };
      const reload = async (per, tb) => { const f = await openQ(per, { navType: 'reload' }); const rs = RS.createResumeStore({ storage: tb.st, key, seed: f.spec.seed, tag: f.tag, attempt: f.attempt }); return { f, r: rs.restore({ ctl: mkCtl(f.spec), makeCtl: () => mkCtl(f.spec), navType: 'reload' }) }; };
      const per = fresh(); let dupB = 0;
      const A = await tab(per, { nonce: () => 101 }), B = await tab(per, { nonce: () => 202, onDuplicate: () => { dupB++; } });
      await play(A); await play(B);
      const recA = JSON.parse(A.st.getItem(key)), recB = JSON.parse(B.st.getItem(key));
      ok(dupB === 1 && per.peek().current.fighting === true && per.peek().current.attempt === 101 && recA.attempt === 101 && recB.attempt === 202 && A.f.attempt === 101 && B.f.attempt === 202, t('Q38 the resume record each tab keeps carries the attempt of the page that wrote it (tab A 101, the duplicate tab B 202), while the run keeps the first tab\'s 101'), J([recA.attempt, recB.attempt, dupB]));
      // the duplicate tab is RELOADED: it must not resume (nor finish) the first tab's fight; the page then counts the unrestorable fight as LEFT
      const rb = await reload(per, B);
      const left = rb.f.status === 'resume' && !rb.r.info.restored ? await rb.f.leaveUnrestorable() : null;          // (battle_boot.js: status 'resume' and not restored -> leaveUnrestorable)
      ok(rb.f.status === 'resume' && rb.f.attempt === 101 && rb.r.info.restored === false && /another page/.test(rb.r.info.reason) && B.st.getItem(key) === null && left && /counted as a loss/.test(left.message) && per.peek().current === null && per.peek().runs === 1 && per.peek().last.won === false, t('Q39 a duplicate tab that is RELOADED does not take over the first tab\'s fight: its saved battle is refused ("another page of this fight"), thrown away, and the fight counts as LEFT (a loss), never finished by it'), J([rb.f.status, rb.r.info.restored, rb.r.info.reason, per.peek().runs]));
      // the first tab itself: its own reload still resumes and can finish
      const perA = fresh(), A1 = await tab(perA, { nonce: () => 101 }); await play(A1);
      const ra = await reload(perA, A1), endA = await ra.f.onMatchEnd({ summary: sumW(), ticks: 1, winner: 0 });
      ok(ra.f.status === 'resume' && ra.r.info.restored === true && ra.r.info.choices === 1 && endA.applied === true && perA.peek().current.phase === 'offer' && perA.peek().current.history.length === 1, t('Q40 the tab that marked the fight, reloaded, still resumes it (same saved choices, same attempt) and finishes it once'), J([ra.r.info.restored, ra.r.info.reason, endA && endA.applied]));
      // a saved battle that names no page at all (written before the attempt was part of it) is not believed by a page that has one: unrestorable, so the fight counts as left
      const perL = fresh(), L1 = await tab(perL, { nonce: () => 101 }), stL = sess(); L1.ctl = mkCtl(L1.f.spec); RS.createResumeStore({ storage: stL, key, seed: L1.f.spec.seed, tag: L1.f.tag }).attach(L1.ctl); L1.ctl.onLocalChoice(() => L1.f.committed()); L1.ctl.submit(0, { kind: 'preview', order: [0, 1, 2] }); await ticks();
      const recL = JSON.parse(stL.getItem(key)), rl = await reload(perL, { st: stL });
      ok(!('attempt' in recL) && rl.f.status === 'resume' && rl.r.info.restored === false && stL.getItem(key) === null, t('Q40b a saved battle with no attempt in it is not used by a Tower page (it cannot be shown to be that page\'s own): unrestorable'), J(rl.r.info));
      // a regular battle names no attempt: its record is written and read as it always was
      const stg = sess(), c4 = matchctl.createMatchController({ pack: PACK, ruleset: CFG.ruleset, teams: [teams[0].recs, teams[1].recs], seed: 5, pick: 3, names: ['a', 'b'], sides: [{ kind: 'human' }, { kind: 'cpu', level: 'easy', seed: 1 }] }); c4.start();
      const rs4 = RS.createResumeStore({ storage: stg, key: 'k', seed: 5 }); rs4.attach(c4); c4.submit(0, { kind: 'preview', order: [0, 1, 2] }); await ticks();
      ok(stg.getItem('k') && !('attempt' in JSON.parse(stg.getItem('k'))) && !('tag' in JSON.parse(stg.getItem('k'))), t('Q41 a regular battle\'s saved record has no attempt (and no tag): the format regular pages have always written'), String(stg.getItem('k')).slice(0, 80));
    }
    {
      const bb = fs.readFileSync(path.join(opt.dir || SRC, 'battle_boot.js'), 'utf8');
      ok(/createResumeStore\(\{[^}]*attempt: towerFight \? towerFight\.attempt : undefined/.test(bb), t('Q42 the battle page gives its resume store the Tower fight\'s attempt (a regular battle has none)'), '');
    }

    /* Q43: attempt numbers at and above 2^31 (about half of all random 32-bit numbers) compare as the whole numbers they are */
    {
      const bad = [];
      for (const N of [2147483648, 3e9, 4294967295]) {
        const tw0 = SS.reduceStart(mkT(), startArgs()).tower, a = { floor: 1, seed: 777, tries: 0 };
        const mA = SS.reduceMarkFight(tw0, { ...a, attempt: N }), again = SS.reduceMarkFight(mA.tower, { ...a, attempt: N }), other = SS.reduceMarkFight(mA.tower, { ...a, attempt: N - 1 });
        if (!(mA.applied && mA.tower.current.attempt === N && again.applied === false && again.why === 'already marked' && !again.taken && other.applied === false && other.taken === true)) bad.push(N + ' mark: ' + J([again.why, again.taken, other.taken]));
        const wrong = SS.reduceFinishFloor(mA.tower, { ...a, result: WIN(1), pack: PACK, now: 9, attempt: N - 1 }), fin = SS.reduceFinishFloor(mA.tower, { ...a, result: WIN(1), pack: PACK, now: 9, attempt: N });
        if (!(wrong.applied === false && wrong.taken === true && fin.applied && fin.tower.current.phase === 'offer')) bad.push(N + ' finish: ' + J([wrong.taken, fin.applied]));
        const lost = SS.reduceBeginFloor(mA.tower, { pack: PACK, floor: 1, seed: 777, navType: 'navigate', now: 20, cfg: OLD });
        if (!(lost.status === 'abandoned' && lost.applied && lost.tower.runs === 1)) bad.push(N + ' abandon: ' + lost.status);
        const per = SS.memoryPersist(mA.tower), rl = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 1, runId: 777, navType: 'reload', nonce: () => 5 }), done = rl.ok ? await rl.finish(WIN(1)) : null;
        if (!(rl.ok && rl.status === 'resume' && rl.attempt === N && done && done.applied)) bad.push(N + ' resume: ' + J([rl.status, rl.attempt]));
      }
      ok(bad.length === 0, t('Q43 a fight marked by a page whose attempt number is 2147483648, 3000000000 or 4294967295: the same page may ask again (not "another tab"), another page is refused, only the owner finishes it, an abandoned one is finished on its behalf, and a reload takes the number over unchanged'), bad.join(' | '));
    }

    /* Q44-Q47: LEAVE TOWER before the first choice. THE RULE CHANGED 2026-11-17: it used to DROP a run that had cleared nothing and to count as a lost floor on a later one; it now costs nothing and changes
       nothing, on any floor and under any config (the question on the page says so). A quit AFTER the first choice is the played loss it always was (Q45: under OLD it ends the run). */
    {
      const tw0 = SS.reduceStart(mkT(), startArgs()).tower, F = { floor: 1, seed: 777, result: { floor: 1, result: 'f', turns: 0, faints: 0 }, pack: PACK, now: 9 };
      const q0 = SS.reduceFinishFloor(tw0, F), q0old = SS.reduceFinishFloor(tw0, { ...F, cfg: OLD });
      const mk = SS.reduceMarkFight(tw0, { floor: 1, seed: 777, attempt: 5, tries: 0 }), q1 = SS.reduceFinishFloor(mk.tower, { ...F, attempt: 5, tries: 0, cfg: OLD });
      const w1 = SS.reduceFinishFloor(tw0, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 2000 }).tower, w2 = SS.reducePick(w1, PK(w1, null, { now: 3000 })).tower, q2 = SS.reduceFinishFloor(w2, { ...F, floor: 2, result: { floor: 2, result: 'f', turns: 0, faints: 0 } }), q2old = SS.reduceFinishFloor(w2, { ...F, floor: 2, result: { floor: 2, result: 'f', turns: 0, faints: 0 }, cfg: OLD });
      ok([q0, q0old].every((q) => q.applied === false && q.unplayed === true && /no fight was begun/.test(q.why) && !q.tower && !q.dropped && !q.finished), t('Q44 a quit with no fight marked is not a played fight: it is refused ("no fight was begun") and nothing is written, so the run still waits for floor 1 (it used to be dropped: the rule changed), under either config'), J(q0).slice(0, 160));
      ok(q1.applied === true && q1.finished === true && !q1.dropped && q1.tower.runs === 1 && q1.tower.last.won === false && q1.tower.last.cleared === 0 && 'rock-bottom' in q1.tower.achievements, t('Q45 ... but a quit AFTER the first choice (the fight is marked) is a played loss: counted, with Rock Bottom on floor 1 (retriesPerFloor 0: it ends the run)'), J(q1).slice(0, 160));
      ok([q2, q2old].every((q) => q.applied === false && q.unplayed === true && !q.tower), t('Q46 ... and a quit before the first choice of a LATER floor (one floor was cleared) costs nothing either (it used to count as a lost floor: the rule changed)'), J(q2).slice(0, 160));
      // 25 times: open the floor and LEAVE TOWER with no choice made -> the SAME run still waits on floor 1, nothing counted; 25 climbs (OLD) left after a first choice are 25 played runs
      const perN = SS.memoryPersist(SS.reduceStart(mkT(), startArgs({ seed: 900 })).tower); const first = J(perN.peek()); let navs = 0;
      for (let i = 0; i < 25; i++) { const nav = mkNav(), f = await TF.createTowerFight({ pack: PACK, persist: perN, floor: 1, runId: 900, navType: 'navigate', nav, now: () => 7000 + i }); f.onQuit(); await ticks(); if (f.ok && J(nav.calls) === J([['tower', null]])) navs++; }
      let tp = mkT();
      for (let i = 0; i < 25; i++) {
        const per = SS.memoryPersist(SS.reduceStart(tp, startArgs({ seed: 900 + i, now: 10 + i })).tower), f = await TF.createTowerFight({ pack: PACK, persist: per, floor: 1, runId: 900 + i, navType: 'navigate', nav: mkNav(), now: () => 7000 + i, cfg: OLD });
        f.committed(); await ticks(); f.onQuit(); await ticks(); tp = per.peek();
      }
      const tw = perN.peek();
      ok(navs === 25 && J(tw) === first && tw.runs === 0 && tw.last === null && tw.current && tw.current.floor === 1 && tw.current.history.length === 0 && Object.keys(tw.achievements).length === 0 && tp.runs === 25 && 'rock-bottom' in tp.achievements && 'runs-3' in tp.achievements, t('Q47 opening the floor and LEAVE TOWER 25 times with no choice made earns nothing and loses nothing (no run counted, no Rock Bottom, no run-count achievement: the record is byte for byte what it was); the same 25 climbs left after a first choice (retriesPerFloor 0) are 25 played runs'), J({ navs, runs: tw.runs, a: Object.keys(tw.achievements), played: tp.runs }));
    }

    /* Q48-Q50: the hub page's wiring of the start guard (and its release for a page restored from the back / forward cache) and of the history seeding (boot.js is page code; tower_hub.js holds the logic and the hub test proves it) */
    {
      const bt = fs.readFileSync(path.join(opt.dir || SRC, 'boot.js'), 'utf8');
      ok(/import \{[^}]*createStartGuard[^}]*\} from '\.\/tower_hub\.js'/.test(bt) && /eff\.type === 'tower-new' && !startGuard\.enter\(eff\.token\)/.test(bt) && /startGuard\.done\(eff\.token, started\)/.test(bt) && !/createOnceGate|startGate/.test(bt), t('Q48 the hub page runs a START only through the start guard (one start under way on the page, one run per token) and ends it when the start did or did not happen'), '');
      const sh = bt.slice(bt.indexOf('function seedHistory'), bt.indexOf('/* ---- the team list'));
      // (the page used to keep a COUNT of the entries it stood on, `pushed`; it now keeps their trail, `hist`: the same line, the same rule)
      ok(/historySeedPlan\(path, state\)/.test(sh) && /if \(!plan\.write\) \{ hist = plan\.trail\.slice\(\); return; \}/.test(sh) && sh.indexOf('plan.write') > 0 && sh.indexOf('plan.write') < sh.indexOf('history.replaceState') && sh.indexOf('history.replaceState') < sh.indexOf('history.pushState'), t('Q49 the hub page seeds its history only when the plan says to write (a reload or a back / forward step onto an entry it wrote adds nothing), and counts the entries it stands on either way'), sh.slice(0, 80));
      ok(/addEventListener\('pageshow', \(e\) => \{ if \(e\.persisted\) \{ startGuard\.reset\(\);/.test(bt), t('Q50 a hub page restored from the back / forward cache frees its start guard (START works again after START, browser Back, give up); without it the button is silently dead until a reload'), (bt.match(/addEventListener\('pageshow'[^\n]*/) || [''])[0].slice(0, 120));
    }
  }

  /* ============================================================================================ THE RETRIES (the decision of 2026-11-17: a loss no longer ends the climb at once; every floor has three retries) */
  const startT = (o) => SS.reduceStart(mkT(), startArgs(o)).tower;
  // a result as a PAGE sends it: it names the try of the floor it is for
  // (a step on a record with no run under way, which only a broken build produces, is a refused step that hands the record back: the check that follows then fails BY NAME instead of on a TypeError)
  const noRun = (tw) => ({ applied: false, why: 'no run under way', tower: tw, next: {}, retries: {}, events: [], finished: false });
  const loseT = (tw, o) => (tw && tw.current ? SS.reduceFinishFloor(tw, { floor: tw.current.floor, seed: tw.current.seed, result: LOSS(tw.current.floor), pack: PACK, now: 5000, tries: T.tryNumber(tw.current), ...(o || {}) }) : noRun(tw));
  const winT = (tw, o) => (tw && tw.current ? SS.reduceFinishFloor(tw, { floor: tw.current.floor, seed: tw.current.seed, result: WIN(tw.current.floor), pack: PACK, now: 5000, tries: T.tryNumber(tw.current), ...(o || {}) }) : noRun(tw));
  const skipT = (tw) => { if (!tw || !tw.current || tw.current.phase !== 'offer') return tw; const r = SS.reducePick(tw, PK(tw, null, { now: 5001 })); return r.applied ? r.tower : tw; };
  const lifeT = () => { const y = clone(winT(startT()).tower); y.current.offer = [{ id: 'extra-life', tier: 2 }, ...y.current.offer.slice(1)]; return SS.reducePick(y, PK(y, 'extra-life', { now: 3000 })).tower; };          // a run on floor 2 holding one Extra Life
  const infoOf = (run, cfg) => { if (!run) return ['no run']; const i = T.retryInfo(run, cfg); return [i.used, i.onFloor, i.left, i.cap, i.scope]; };
  const lossRow = (floor, mark) => ({ floor, result: 'l', turns: 3, faints: 3, flawless: false, boss: floor % 10 === 0, comeback: false, sweep: false, closest: null, ...(mark ? { [mark]: true } : {}) });
  // a whole climb through the reducers: `losses(floor)` -> how many times that floor is lost before it is won. -> the Tower record when the run has ended
  const climb = (tw0, seed, losses, cfgC) => {
    let tw = SS.reduceStart(tw0, startArgs({ seed, now: 100 })).tower; const lost = {};
    for (let g = 0; g < 400 && tw.current; g++) {
      const cur = tw.current, o = cfgC ? { cfg: cfgC } : {};
      if (cur.phase === 'offer') { tw = skipT(tw); continue; }
      const want = losses(cur.floor), had = lost[cur.floor] || 0, r = had < want ? loseT(tw, o) : winT(tw, o);
      if (!r.applied) return tw;          // (a refused step: the climb stops where it is, and the check that reads the record says so)
      if (had < want) lost[cur.floor] = had + 1;
      tw = r.tower;
    }
    return tw;
  };

  /* R. the rule: the reducer, the two caps, the identity of a try, the strict parser, the record, the achievements, the bots */
  if (grp('R')) {
    const PER_RUN = Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: 3 }), BOTH = Object.freeze({ ...CFG, retriesPerFloor: 2, retriesPerRun: 3 }), NONE = Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: null });
    const docText = fs.readFileSync(path.join(root, 'pokemonarena', 'TOWER.md'), 'utf8');
    ok(CFG.retriesPerFloor === 3 && CFG.retriesPerRun === null && docText.includes('need to be able to save progress in the tower too, and retry and have counted # of retries') && /2026-11-17/.test(docText) && /retriesPerFloor/.test(docText) && /retriesPerRun/.test(docText), t('R0 the rule in force is the owner\'s "three", read as three retries per floor (retriesPerFloor 3, retriesPerRun null: no cap on the whole climb), and TOWER.md records the decision with the owner\'s words and names both config values'), J([CFG.retriesPerFloor, CFG.retriesPerRun]));
    // ---- a loss no longer ends the climb
    const t0 = startT(), l1 = loseT(t0), c1 = l1.applied ? l1.tower.current : null, ri = c1 ? T.retryInfo(c1) : null;
    ok(l1.applied && !l1.finished && l1.next.step === 'retry' && l1.next.via === 'retry' && l1.next.floor === 1 && !!c1 && c1.phase === 'battle' && c1.floor === 1 && c1.fighting === false && c1.attempt === 0 && c1.livesUsed === 0 && c1.offer === null && J(c1.team) === J(t0.current.team) && J(c1.held) === J(t0.current.held) && l1.tower.runs === 0 && l1.tower.last === null && REC.checkTowerShape(l1.tower).length === 0 && T.parseRun(c1, { pack: PACK }).ok, t('R1 A LOSS NO LONGER ENDS THE CLIMB: the run stays on the same floor, in battle, holding its team and its buffs; nothing is folded, nothing is in `last`, and the stored form is well formed'), J(l1).slice(0, 200));
    ok(!!c1 && c1.history.length === 1 && c1.history[0].result === 'l' && c1.history[0].retry === true && !('life' in c1.history[0]) && T.retriesOf(c1) === 1 && T.floorRetriesOf(c1) === 1 && J(infoOf(t0.current)) === J([0, 0, 3, 3, 'floor']) && J(infoOf(c1)) === J([1, 1, 2, 3, 'floor']) && J(l1.events.map((e) => e.type)) === '["retry-used"]' && l1.events[0].retries === 1 && l1.events[0].left === 2 && J(l1.retries) === J(ri) && !('retries' in c1) && J(Object.keys(c1)) === J(Object.keys(t0.current)), t('R2 EVERY RETRY IS COUNTED: the lost try is a row of the history marked `retry`, the climb\'s count and the floor\'s count both go up by one, one fewer is left (3 -> 2 of 3), and the run stores no retry number (the counts are read from the rows)'), J(c1 && c1.history));
    // ---- the fourth lost try of a floor ends the run
    { let tw = t0; const steps = []; for (let i = 0; i < 4 && tw.current; i++) { const r = loseT(tw); steps.push([r.applied, r.finished, r.next.step, r.retries.left]); tw = r.tower; }
      let raw = t0.current; for (let i = 0; i < 4; i++) raw = T.recordFloorResult(raw, LOSS(1), { pack: PACK }).run;
      ok(J(steps) === J([[true, false, 'retry', 2], [true, false, 'retry', 1], [true, false, 'retry', 0], [true, true, 'over', 0]]) && tw.current === null && tw.runs === 1 && tw.wins === 0 && tw.last.won === false && tw.last.cleared === 0 && tw.last.retries === 3 && tw.retries === 3 && raw.phase === 'over' && J(raw.history.map((h) => (h.retry ? 'retry' : h.life ? 'life' : 'end'))) === J(['retry', 'retry', 'retry', 'end']) && T.parseRun(raw, { pack: PACK }).ok && T.recordFloorResult(raw, LOSS(1)).applied === false, t('R3 THREE RETRIES A FLOOR, four tries in all: the fourth lost try of a floor ends the run exactly as a loss used to (phase over, folded once, summarised in `last` with its 3 retries); the loss that ended it is the one row with no mark'), J(steps));
    }
    // ---- the floor's count starts again on every new floor
    { let tw = loseT(loseT(t0).tower).tower; const f1 = infoOf(tw.current); tw = skipT(winT(tw).tower); const f2 = infoOf(tw.current);
      for (let i = 0; i < 3; i++) tw = loseT(tw).tower; const f2b = infoOf(tw.current), end = loseT(tw);
      ok(J(f1) === J([2, 2, 1, 3, 'floor']) && J(f2) === J([2, 0, 3, 3, 'floor']) && J(f2b) === J([5, 3, 0, 3, 'floor']) && tw.current.floor === 2 && end.finished && end.tower.last.retries === 5 && end.tower.last.cleared === 1 && end.tower.retries === 5, t('R4 the retries of a floor start again at 0 on every new floor (2 used on floor 1, then 3 more on floor 2), while the climb\'s total keeps counting (5)'), J([f1, f2, f2b]));
    }
    // ---- an Extra Life is spent INSTEAD of a retry
    { const wl = lifeT(), a = loseT(wl), b = a.applied ? loseT(a.tower) : { applied: false }, ca = a.tower.current, cb = b.applied ? b.tower.current : null;
      ok(a.applied && a.next.step === 'retry' && a.next.via === 'life' && ca.livesUsed === 1 && T.retriesOf(ca) === 0 && ca.history[ca.history.length - 1].life === true && !('retry' in ca.history[ca.history.length - 1]) && J(a.events.map((e) => e.type)) === '["life-used"]' && J(infoOf(ca)) === J([0, 0, 3, 3, 'floor']) && 'second-wind' in a.tower.achievements && b.applied && b.next.via === 'retry' && cb.livesUsed === 1 && T.retriesOf(cb) === 1 && T.tryNumber(cb) === 2 && !('second-wind' in l1.tower.achievements) && B.familyText('extra-life', 4) === '1 extra life: a lost floor spends it instead of a retry' && B.familyText('extra-life', 8) === '2 extra lives: a lost floor spends one instead of a retry' && B.describeOps(B.FAMILY_BY_ID['extra-life'].ops, 4, { cfg: OLD }) === '1 extra life: a lost floor spends it instead of ending the run', t('R5 EXTRA LIFE keeps a meaning: a loss while one is held spends it INSTEAD of counting a retry (no retry is used, the row is marked `life`, Second Chance is earned); the next loss counts a retry; a retry alone never earns Second Chance; and the ball says so in its own words ("a lost floor spends it instead of a retry")'), J([a.next, b.next]));
    }
    // ---- won with n retries; the record: the total, and the fewest retries of a WON climb per format
    { const won4 = climb(mkT(), 31, (f) => (f === 3 || f === 10 ? 2 : 0));
      const clean = climb(mkT(), 32, () => 0), second = climb(won4, 33, (f) => (f === 7 ? 1 : 0)), third = climb(second, 34, (f) => (f === 2 || f === 20 ? 3 : 0));
      ok(won4.current === null && won4.wins === 1 && won4.winsByFormat['3v3'] === 1 && won4.best['3v3'] === 30 && won4.last.won === true && won4.last.retries === 4 && won4.retries === 4 && J(won4.fewestRetries) === J({ '3v3': 4, '6v6': null }) && REC.checkTowerShape(won4).length === 0 && J(T.checkTower(won4)) === '[]' && ['tower-master', 'gatekeeper', 'climb-25'].every((id) => id in won4.achievements), t('R6 a climb is WON with retries (two on floor 3, two on floor 10): it counts as a win like any other, `last` and the record say 4 retries, and the fewest retries of a won 3v3 climb is 4 (6v6: none yet)'), J([won4.retries, won4.fewestRetries, won4.last && won4.last.retries]));
      ok(clean.wins === 1 && !('retries' in clean) && !('retries' in clean.last) && J(clean.fewestRetries) === J({ '3v3': 0, '6v6': null }) && REC.fewestRetriesOf(clean, '3v3') === 0 && REC.fewestRetriesOf(clean, '6v6') === null && second.retries === 5 && J(second.fewestRetries) === J({ '3v3': 1, '6v6': null }) && third.retries === 11 && J(third.fewestRetries) === J({ '3v3': 1, '6v6': null }) && third.wins === 3 && third.last.retries === 6, t('R7 a climb won with no retry records a fewest of 0 and writes no `retries` key anywhere; a better win lowers the fewest (4 -> 1), a worse one never raises it, and the total adds up (4 + 1 + 6 = 11)'), J([clean.fewestRetries, second && second.fewestRetries, third && third.retries]));
      // a record from before retries: no key at all; a format it has won reads as won with 0 retries
      const before = { ...mkT(), runs: 4, wins: 2, winsByFormat: { '3v3': 2, '6v6': 0 }, best: { '3v3': 30, '6v6': 12 }, floors: 80, bosses: 6 }, sumB = SS.summarizeTower(before, PACK), wonAgain = climb(before, 35, (f) => (f === 5 ? 2 : 0));
      ok(REC.checkTowerShape(before).length === 0 && sumB.record.retries === 0 && J(sumB.record.fewestRetries) === J({ '3v3': 0, '6v6': null }) && J(wonAgain.fewestRetries) === J({ '3v3': 0, '6v6': null }) && wonAgain.retries === 2 && wonAgain.wins === 3, t('R8 OLD DATA: a record written before retries existed has none of the keys and is well formed; it reads as 0 retries, a format it has won reads as won with 0 (a loss used to end the run), and a later win with retries does not take that 0 away'), J([sumB.record, wonAgain.fewestRetries]));
    }
    // ---- give up: counted where it stood, with its retries; a run that cleared nothing is dropped whatever it retried
    { const gave = SS.reduceGiveUp(loseT(skipT(winT(loseT(t0).tower).tower)).tower, { seed: 777, now: 9 }), droppedR = SS.reduceGiveUp(loseT(loseT(t0).tower).tower, { seed: 777, now: 9 });
      ok(gave.applied && gave.finished && gave.tower.last.retries === 2 && gave.tower.retries === 2 && gave.tower.last.cleared === 1 && gave.tower.runs === 1 && !('fewestRetries' in gave.tower) && droppedR.applied && droppedR.dropped === true && droppedR.tower.runs === 0 && droppedR.tower.last === null && !('retries' in droppedR.tower) && Object.keys(droppedR.tower.achievements).length === 0, t('R9 GIVE UP ends a run where it stood, with its retries counted (2) and no fewest-retries figure (it was not won); a run that cleared nothing is dropped as before, retries and all (they count for nothing)'), J([gave.tower.last, droppedR.dropped]));
    }
    // ---- retriesPerFloor 0 IS the old rule (every OLD check of groups F, K, L and Q proves it step by step: this one is the summary)
    { const oi = infoOf(t0.current, OLD), lo = loseT(t0, { cfg: OLD }), rawO = T.recordFloorResult(t0.current, LOSS(1), { cfg: OLD });
      ok(J(oi) === J([0, 0, 0, 0, 'floor']) && lo.finished && lo.next.step === 'over' && lo.tower.runs === 1 && J(Object.keys(lo.tower)) === J(REC.TOWER_KEYS) && !('retries' in lo.tower.last) && J(Object.keys(lo.tower.last)) === J(REC.LAST_KEYS) && rawO.run.phase === 'over' && J(rawO.events) === '[{"type":"run-over","floor":1}]' && !('retry' in rawO.run.history[0]) && 'rock-bottom' in lo.tower.achievements, t('R10 retriesPerFloor 0 behaves exactly as the rule before retries: a loss ends the run at once, no row is marked, and the record and `last` have exactly the keys the build before wrote (no retry key anywhere)'), J(oi));
    }
    // ---- the other reading of "three": three for the whole climb
    { const s0 = infoOf(t0.current, PER_RUN); let tw = loseT(t0, { cfg: PER_RUN }).tower; tw = skipT(winT(tw, { cfg: PER_RUN }).tower); tw = loseT(loseT(tw, { cfg: PER_RUN }).tower, { cfg: PER_RUN }).tower; const s3 = infoOf(tw.current, PER_RUN); tw = skipT(winT(tw, { cfg: PER_RUN }).tower); const s3b = infoOf(tw.current, PER_RUN), end = loseT(tw, { cfg: PER_RUN });
      ok(J(s0) === J([0, 0, 3, 3, 'run']) && J(s3) === J([3, 2, 0, 3, 'run']) && J(s3b) === J([3, 0, 0, 3, 'run']) && end.finished && end.next.step === 'over' && end.tower.last.retries === 3 && end.tower.last.cleared === 2, t('R11 retriesPerRun 3 with retriesPerFloor null caps the WHOLE climb: one retry on floor 1 and two on floor 2 use it up, a new floor brings none back, and the next loss ends the run'), J([s0, s3, s3b]));
      let tb = loseT(t0, { cfg: BOTH }).tower; const b1 = infoOf(tb.current, BOTH); tb = skipT(winT(tb, { cfg: BOTH }).tower); tb = loseT(tb, { cfg: BOTH }).tower; tb = skipT(winT(tb, { cfg: BOTH }).tower); tb = loseT(tb, { cfg: BOTH }).tower; const b3 = infoOf(tb.current, BOTH), twoOnOne = infoOf(loseT(loseT(t0, { cfg: BOTH }).tower, { cfg: BOTH }).tower.current, BOTH);
      ok(J(infoOf(t0.current, BOTH)) === J([0, 0, 2, 2, 'floor']) && J(b1) === J([1, 1, 1, 2, 'floor']) && J(b3) === J([3, 1, 0, 3, 'run']) && loseT(tb, { cfg: BOTH }).finished && J(twoOnOne) === J([2, 2, 0, 2, 'floor']), t('R12 with BOTH caps set the one that runs out first decides, and the screens are told which (2 a floor: `floor`; 3 for the climb, once that is the tighter: `run`)'), J([b1, b3, twoOnOne]));
    }
    // ---- no cap at all still ends: one run never counts more than TOWER_LIMITS.retriesMax retries (its history would otherwise grow without end)
    { const MAXR = REC.TOWER_LIMITS.retriesMax, full = { ...clone(t0.current), history: Array.from({ length: MAXR }, () => lossRow(1, 'retry')) }, over = { ...clone(full), history: full.history.concat([lossRow(1, 'retry')]) };
      const n0 = T.retryInfo(t0.current, NONE), nf = T.retryInfo(full, NONE), lastLoss = T.recordFloorResult(full, LOSS(1), { cfg: NONE });
      ok(n0.scope === 'none' && n0.cap === null && n0.left === MAXR && nf.left === 0 && nf.used === MAXR && T.parseRun(full).ok && lastLoss.run.phase === 'over' && !T.parseRun(over).ok && MAXR + 30 + 51 <= 400 && JSON.stringify(full).length < REC.TOWER_LIMITS.runJsonMax, t('R13 with no cap of either kind a run can still take only ' + MAXR + ' retries (then a loss ends it): the history stays inside the parser\'s 400 rows and the stored run inside its size cap, and a run with more is refused'), J([n0.left, nf.left]));
      const junk = [undefined, -1, 1.5, '3', NaN, {}, Infinity].map((v) => T.retryInfo(t0.current, { ...CFG, retriesPerFloor: v }));
      ok(junk.every((i) => i.perFloor === 0 && i.left === 0 && i.scope === 'floor') && T.retryInfo(t0.current, { ...CFG, retriesPerFloor: 3, retriesPerRun: 'x' }).left === 0, t('R14 a cap that is not a whole number from 0 or null (a typo in the config: undefined, -1, 1.5, "3", NaN) reads as 0, never as "no limit"'), J(junk.map((i) => i.left)));
    }
    // ---- THE IDENTITY OF A TRY: the try number (lives spent + retries counted) is in the battle seed, in the saved battle's tag and in every result
    { const runs = [t0.current]; for (let i = 0; i < 3; i++) runs.push(loseT({ ...mkT(), current: runs[runs.length - 1] }).tower.current);
      const specs = runs.map((r) => SS.towerFloorSpec(PACK, r)), withLife1 = T.battleSetup(PACK, { ...clone(t0.current), livesUsed: 1 }), mixed = { ...clone(runs[2]), livesUsed: 2 };
      ok(runs.map((r) => T.tryNumber(r)).join() === '0,1,2,3' && T.tryNumber(mixed) === 4 && specs.map((s) => s.tower.tries).join() === '0,1,2,3' && new Set(specs.map((s) => s.seed)).size === 4 && new Set(specs.map((s) => s.tower.tag)).size === 4 && /^tower:777:1:2:[0-9a-f]+$/.test(specs[2].tower.tag) && withLife1.seed === specs[1].seed && specs[0].seed === T.mix(777, 1, 0xb477), t('R15 the TRY NUMBER of a floor is the lives spent + the retries counted (0, 1, 2, 3 for the four tries): every try has its own battle seed and its own tag; the first try\'s seed is the one a floor always had'), specs.map((s) => s.tower.tag).join(' '));
      ok(specs.every((s) => J(s.teams) === J(specs[0].teams) && J(s.meta) === J(specs[0].meta) && s.trainer === specs[0].trainer && J(s.sides) === J(specs[0].sides) && s.pick === specs[0].pick && J(s.tower.trainer) === J(specs[0].tower.trainer)), t('R16 A RETRY IS THE SAME FLOOR: the same trainer (name, CPU level and seed), the same two teams with the same buffs, the same format; only the dice differ'), '');
      const play = (sp) => { const c = matchctl.createMatchController({ pack: PACK, ruleset: sp.ruleset, teams: sp.teams, seed: sp.seed, pick: sp.pick, names: sp.names, validate: sp.validate, sides: [{ kind: 'cpu', level: 'normal', seed: 3 }, sp.sides[1]] }); c.start(); return c.info().logHash; };
      const hashes = specs.slice(0, N(4, 2)).map(play);
      ok(new Set(hashes).size === hashes.length && play(specs[1]) === hashes[1], t('R17 ... and a retry is NOT A REPLAY of the lost battle: the same two sides playing the same way give a different battle on every try (the dice are re-rolled), and the same try replays to the same battle'), hashes.join(' '));
    }
    // ---- exactly once, at the lowest level: a result that names its try is applied to that try only
    { const a = T.recordFloorResult(t0.current, LOSS(1), { pack: PACK, tries: 0 }), again = T.recordFloorResult(a.run, LOSS(1), { pack: PACK, tries: 0 }), lateWin = T.recordFloorResult(a.run, WIN(1), { pack: PACK, tries: 0 }), next = T.recordFloorResult(a.run, LOSS(1), { pack: PACK, tries: 1 });
      const s1 = loseT(t0), s2 = SS.reduceFinishFloor(s1.tower, { floor: 1, seed: 777, result: LOSS(1), pack: PACK, now: 6000, tries: 0 }), s3 = SS.reduceFinishFloor(s1.tower, { floor: 1, seed: 777, result: WIN(1), pack: PACK, now: 6000, tries: 0 });
      ok(a.applied && again.applied === false && again.run === a.run && /not the current try/.test(again.why) && lateWin.applied === false && next.applied && T.retriesOf(next.run) === 2 && s2.applied === false && /try of the floor is over/.test(s2.why) && !s2.tower && s3.applied === false && T.retriesOf(s1.tower.current) === 1, t('R18 EXACTLY ONCE: the same lost try sent again (a double fire, a replay) is refused because the run has moved on to the next try, so it can never count twice; a late WIN of the lost try is refused too; the next try\'s own result is applied'), J([again.why, s2.why]));
    }
    // ---- the strict stored form: the marks are checked and the counts are re-derived from the rows. WHAT THAT BUYS, exactly: a MALFORMED edit is refused (R19). It does not make the rows themselves
    //      tamper-proof: an edit that leaves them self-consistent is a run the parser cannot tell from a genuine one (R19b pins that limit, so that neither this file nor TOWER.md can claim more).
    { let g = loseT(t0).tower; g = winT(g).tower; g = SS.reducePick(g, PK(g, g.current.offer[0].id, { now: 7 })).tower; g = loseT(loseT(g).tower).tower;
      const good = T.serializeRun(g.current), edit = (fn) => { const x = JSON.parse(good); fn(x); return x; }, both = (x) => [T.parseRun(x, { pack: PACK }).ok, T.parseRun(x).ok];
      const hostile = [
        ['a retry mark on a WON floor', (x) => { x.history[1].retry = true; }], ['a life mark on a won floor', (x) => { x.history[1].life = true; }],
        ['a retry mark that is 1', (x) => { x.history[0].retry = 1; }], ['a retry mark that is "yes"', (x) => { x.history[0].retry = 'yes'; }], ['a retry mark that is false', (x) => { x.history[0].retry = false; }], ['a retry mark that is null', (x) => { x.history[0].retry = null; }],
        ['a retry mark that is -1', (x) => { x.history[0].retry = -1; }], ['a retry mark that is 1.5', (x) => { x.history[0].retry = 1.5; }], ['a retry mark that is a billion', (x) => { x.history[0].retry = 1e9; }], ['a life mark that is 1', (x) => { x.history[0].life = 1; }],
        ['one loss that cost both a life and a retry', (x) => { x.history[0].life = true; x.livesUsed = 1; }],
        ['a retry un-counted in the middle of the run (a loss that cost nothing)', (x) => { delete x.history[2].retry; }], ['a retry un-counted on the last row of a run still in battle', (x) => { delete x.history[3].retry; }],
        ['a retry re-labelled IN PLACE as a floor already cleared (its row is then out of order: after that floor\'s win)', (x) => { x.history[2].floor = 1; }], ['a retry of a floor not yet reached', (x) => { x.history[0].floor = 2; }], ['a retry moved on to the next floor', (x) => { x.history[3].floor = 3; }],
        ['a pick on a lost floor', (x) => { x.history[0].pick = null; }], ['an unknown mark on a lost floor', (x) => { x.history[0].retried = true; }],
        ['a stored retry count (the run has none: it is counted from the rows)', (x) => { x.retries = 3; }], ['a stored count of 0', (x) => { x.retries = 0; }], ['a stored floor count', (x) => { x.floorRetries = 0; }],
        ['a retry turned into a spent life that was never held', (x) => { delete x.history[0].retry; x.history[0].life = true; x.livesUsed = 1; }],
      ];
      const slipped = hostile.filter(([, fn]) => both(edit(fn)).some(Boolean)).map(([n]) => n);
      const shapeToo = ['retries', 'floorRetries'].every((k) => !REC.isRunShape(edit((x) => { x[k] = 1; })));
      const p = T.parseRun(good, { pack: PACK });
      const gl = loseT(lifeT()).tower.current, bothMarks = clone(gl); bothMarks.history[bothMarks.history.length - 1].retry = true;          // (a life that WAS held and spent: only the mark itself is wrong)
      ok(p.ok && J(p.run) === J(g.current) && T.retriesOf(p.run) === 3 && T.floorRetriesOf(p.run) === 2 && slipped.length === 0 && shapeToo && REC.isRunShape(g.current) && T.parseRun(gl).ok && !T.parseRun(bothMarks).ok, t('R19 THE STRICT FORM accepts the genuine run with its three retries and refuses all ' + hostile.length + ' MALFORMED edits of the marks: a mark on a won floor, a mark that is not `true` (1, "yes", -1, 1.5, a billion...), a loss that cost both or nothing, a retry re-labelled in place as another floor (its row left out of order), a stored count (which the shallow check refuses too)'), slipped.join(' | '));
      // THE KNOWN LIMIT (found by the review of 2026-11-17; TOWER.md section 9 states it and names this check). The retries are COUNTED FROM THE ROWS, and there is no secret in a browser, so an edit that
      // leaves the rows self-consistent is, to this parser, a genuine run: deleting retry rows gives the floor its retries back, and so does re-filing one, IN ORDER, under a floor already cleared. That is
      // no worse than the wins (a hand-written run of won floors parses too, and did before retries), and a stored number beside the rows would not change it (it would be edited with them). What IS
      // refused is every edit that leaves the rows malformed (R19), and a file edited outside the game fails its export checksum (the profile test). If this check ever fails because the parser can tell
      // such an edit after all, TOWER.md sections 9 and 11 and the two source comments (tower.js retryInfo, tower_record.js) must be rewritten with it.
      { let b = loseT(loseT(t0).tower).tower; b = skipT(winT(b).tower); b = loseT(loseT(loseT(b).tower).tower).tower;          // floor 1: two retries, then won; floor 2: three retries, none left
        const NAME = t('R19b THE KNOWN LIMIT OF THE STRICT FORM, pinned (TOWER.md section 9 says it in so many words): a SELF-CONSISTENT edit of the rows is not detectable in the browser. On a run with no retry left on its floor, deleting that floor\'s three retry rows reads back as a run with 3 left, deleting one or re-filing one in order under a floor already cleared as a run with 1 left, deleting every lost row as a run that never lost; only the malformed form (the row re-labelled in place) is refused');
        let held = false, seen = '';          // (a build broken enough to end this run early, or to throw on it, fails the check BY NAME)
        try {
          const big = b.current; if (!big) throw new Error('the run ended before the floor\'s three retries were counted');
          const shape = big.history.map((h) => h.floor + h.result + (h.retry ? '*' : '')).join(' ');
          const ed = (fn) => { const x = clone(big); fn(x); return x; }, reads = (x) => T.parseRun(x, { pack: PACK }).ok && T.parseRun(x).ok && REC.isRunShape(x), inf = (x) => J(infoOf(x));
          const noneOn2 = ed((x) => { x.history = x.history.filter((h) => !(h.result === 'l' && h.floor === 2)); });                                  // the three retry rows of this floor deleted
          const oneGone = ed((x) => { x.history.pop(); });                                                                                          // one of them deleted
          const refiled = ed((x) => { const row = x.history.pop(); row.floor = 1; row.boss = false; x.history.splice(2, 0, row); });                    // one re-filed under floor 1, IN ORDER (before floor 1's win)
          const noLoss = ed((x) => { x.history = x.history.filter((h) => h.result === 'w'); });                                                        // every lost row deleted
          const inPlace = ed((x) => { x.history[x.history.length - 1].floor = 1; });                                                                  // (the malformed form of the same idea: the row stays where it was)
          const doc = fs.readFileSync(path.join(root, 'pokemonarena', 'TOWER.md'), 'utf8');
          seen = [shape, inf(big), reads(big), reads(noneOn2), inf(noneOn2), reads(oneGone), inf(oneGone), reads(refiled), inf(refiled), reads(noLoss), inf(noLoss), T.parseRun(inPlace).ok, /`R19b`/.test(doc) && /KNOWN LIMIT/.test(doc) ? 'the doc names it' : 'TOWER.md DOES NOT NAME R19b / THE KNOWN LIMIT'].join(' | ');
          held = shape === '1l* 1l* 1w 2l* 2l* 2l*' && inf(big) === J([5, 3, 0, 3, 'floor']) && reads(big)
            && reads(noneOn2) && inf(noneOn2) === J([2, 0, 3, 3, 'floor']) && reads(oneGone) && inf(oneGone) === J([4, 2, 1, 3, 'floor']) && reads(refiled) && inf(refiled) === J([5, 2, 1, 3, 'floor']) && reads(noLoss) && inf(noLoss) === J([0, 0, 3, 3, 'floor'])
            && !T.parseRun(inPlace).ok && /`R19b`/.test(doc) && /KNOWN LIMIT/.test(doc);
        } catch (e) { seen = 'threw: ' + String(e && e.message ? e.message : e).slice(0, 120); }
        ok(held, NAME, seen);
      }
      let over = t0.current; for (let i = 0; i < 4; i++) over = T.recordFloorResult(over, LOSS(1), { pack: PACK }).run;
      const gaveUp = T.abandonRun(g.current), twoEnds = clone(over); delete twoEnds.history[2].retry;
      const legacy = (() => { const x = clone(skipT(winT(startT()).tower).current); delete x.attempt; return x; })();
      ok(T.parseRun(over).ok && T.parseRun(gaveUp).ok && T.retriesOf(gaveUp) === 3 && !T.parseRun(twoEnds).ok && T.parseRun(legacy).ok && T.retriesOf(legacy) === 0 && T.tryNumber(legacy) === 0 && J(infoOf(legacy)) === J([0, 0, 3, 3, 'floor']), t('R20 a run that ended reads back too (lost with its retries used up: three marked rows and the one that ended it; given up after retries: every loss marked), a run with two losses that "ended" it is refused, and a run stored before retries existed is a run with 0 retries and three to use'), '');
      // a stored run is not refused for having been made under another cap: the caps are the reducer's to enforce (so changing the config never breaks a climb under way)
      ok(T.parseRun(g.current, { cfg: OLD }).ok && T.parseRun(g.current, { cfg: PER_RUN }).ok && T.retryInfo(g.current, OLD).left === 0 && loseT(g, { cfg: OLD }).finished, t('R21 changing the caps never makes a climb under way unreadable: a run with retries still parses under retriesPerFloor 0 (or under the per-climb reading), it simply has none left'), '');
    }
    // ---- the Tower record: the strict check and the repair of the retry keys
    { const rec = climb(climb(mkT(), 41, (f) => (f === 3 ? 2 : 0)), 42, (f) => (f === 1 ? 4 : 0));          // one climb won with 2 retries, one lost on floor 1 with its 3 retries used
      const hostile = [
        ['negative retries', (x) => { x.retries = -1; }], ['fractional retries', (x) => { x.retries = 2.5; }], ['retries past a billion', (x) => { x.retries = 1e10; }], ['retries as text', (x) => { x.retries = '5'; }], ['retries null', (x) => { x.retries = null; }],
        ['a fewest for a third format', (x) => { x.fewestRetries['4v4'] = 1; }], ['a fewest missing a format', (x) => { delete x.fewestRetries['6v6']; }], ['a negative fewest', (x) => { x.fewestRetries['3v3'] = -1; }], ['a fractional fewest', (x) => { x.fewestRetries['3v3'] = 0.5; }],
        ['a fewest above what one run can count', (x) => { x.fewestRetries['3v3'] = REC.TOWER_LIMITS.retriesMax + 1; }], ['a fewest that is a list', (x) => { x.fewestRetries = [0, 0]; }], ['a fewest for a format that was never won', (x) => { x.fewestRetries['6v6'] = 0; }],
        ['a last run with negative retries', (x) => { x.last.retries = -1; }], ['a last run with fractional retries', (x) => { x.last.retries = 1.5; }], ['a last run with more retries than a run can count', (x) => { x.last.retries = REC.TOWER_LIMITS.retriesMax + 1; }], ['a last run with a second unknown key', (x) => { x.last.tries = 1; }],
      ];
      const slipped = hostile.filter(([, fn]) => { const x = clone(rec); fn(x); return REC.checkTowerShape(x).length === 0; }).map(([n]) => n);
      ok(REC.checkTowerShape(rec).length === 0 && rec.retries === 5 && J(rec.fewestRetries) === J({ '3v3': 2, '6v6': null }) && rec.last.retries === 3 && slipped.length === 0 && J(REC.TOWER_KEYS_OPTIONAL) === J(['retries', 'fewestRetries']) && J(REC.LAST_KEYS_OPTIONAL) === J(['retries']) && REC.TOWER_VERSION === 1 && J(Object.keys(REC.emptyTower())) === J(REC.TOWER_KEYS), t('R22 THE RECORD keeps the retries as OPTIONAL keys of the same version (retries, fewestRetries; `retries` in `last`): an empty record has none of them, and the strict check refuses all ' + hostile.length + ' hostile values (negative, fractional, huge, text, a fewest for a format never won)'), slipped.join(' | '));
      const P0 = [], rep = (src) => REC.normalizeTower(src, (...a) => P0.push(a), true);
      const bad1 = rep({ ...clone(rec), retries: -4 }), bad2 = rep({ ...clone(rec), fewestRetries: { '3v3': 'x', '6v6': null } }), bad3 = rep({ ...clone(rec), fewestRetries: { '3v3': 2, '6v6': 1 } }), bad4 = rep({ ...clone(rec), last: { ...clone(rec.last), retries: -2 } }), same = rep(clone(rec));
      ok(canon(same.value) === canon(rec) && !Object.keys(same.rejected).length && !('retries' in bad1.value) && bad1.rejected.retries === -4 && bad1.value.runs === rec.runs && J(bad1.value.fewestRetries) === J(rec.fewestRetries) && !('fewestRetries' in bad2.value) && J(bad2.rejected.fewestRetries) === J({ '3v3': 'x', '6v6': null }) && bad2.value.retries === 5 && J(bad3.value.fewestRetries) === J({ '3v3': 2, '6v6': null }) && J(bad3.rejected.fewestRetries) === J({ '3v3': 2, '6v6': 1 }) && bad4.value.last === null && (bad4.rejected.last || {}).retries === -2 && [bad1, bad2, bad3, bad4].every((b) => REC.checkTowerShape(b.value).length === 0 && J(rep(b.value).value) === J(b.value)) && P0.some((a) => a[1] === 'profile.tower' && /fewestRetries/.test(a[2])), t('R23 THE REPAIR treats each retry key as its own field: a bad total is emptied (and handed back for the bag), a bad fewest is emptied, a fewest for a format never won loses only that entry, a `last` with a bad count is set aside; the rest of the record is kept, the result is well formed and repairing it again changes nothing'), J([bad1.rejected, bad3.value.fewestRetries]));
      // what a build that does not know the keys parked in the bag comes back (the old build's repair moves an unknown top-level key into `_unknown`, and sets aside a `last` it cannot read)
      const parked = (() => { const x = clone(rec); x._unknown = { retries: x.retries, fewestRetries: x.fewestRetries, keepMe: { a: 1 }, towerRejected: { last: x.last, other: 5 } }; delete x.retries; delete x.fewestRetries; x.last = null; return x; })();
      const backR = rep(parked), again = rep(backR.value);
      const junkBag = rep({ ...clone(parked), _unknown: { retries: 'lots', fewestRetries: { '3v3': -1, '6v6': null }, towerRejected: { last: { junk: true } } } });
      const topWins = rep({ ...clone(rec), _unknown: { retries: 999 } }), lastTaken = rep({ ...clone(parked), last: { ...clone(rec.last), cleared: 9 } });
      ok(backR.value.retries === 5 && J(backR.value.fewestRetries) === J(rec.fewestRetries) && J(backR.value.last) === J(rec.last) && J(backR.value._unknown) === J({ keepMe: { a: 1 }, towerRejected: { other: 5 } }) && !Object.keys(backR.rejected).length && REC.checkTowerShape(backR.value).length === 0 && J(again.value) === J(backR.value) && !('retries' in junkBag.value) && !('fewestRetries' in junkBag.value) && junkBag.value.last === null && (junkBag.value._unknown || {}).retries === 'lots' && J((junkBag.value._unknown || {}).towerRejected) === J({ last: { junk: true } }) && topWins.value.retries === 5 && (topWins.value._unknown || {}).retries === 999 && (lastTaken.value.last || {}).cleared === 9 && J(((lastTaken.value._unknown || {}).towerRejected || {}).last) === J(rec.last), t('R24 what a build without the keys parked comes back: `retries` and `fewestRetries` found in the record\'s bag (and a `last` it set aside) are restored and taken out of the bag, once (a fixed point); junk in the bag stays there, a key the record already has is not overwritten by the bag, and a parked `last` does not replace a newer one'), J(backR.value._unknown));
    }
    // ---- the summary the screens draw
    { const lostOnce = loseT(skipT(winT(t0).tower)).tower, s = SS.summarizeTower(lostOnce, PACK), s0 = SS.summarizeTower(t0, PACK), sl = SS.summarizeTower(lifeT(), PACK), viaLife = SS.summarizeTower(loseT(lifeT()).tower, PACK);
      const done = climb(mkT(), 51, (f) => (f === 2 ? 1 : 0)), sd = SS.summarizeTower(done, PACK), unsaved = SS.summarizeTower(lostOnce, PACK, { saved: false });
      ok(s.run.lostTry === 'retry' && J([s.run.retry.used, s.run.retry.onFloor, s.run.retry.left, s.run.retry.cap, s.run.retry.scope]) === J([1, 1, 2, 3, 'floor']) && s.run.tries === 1 && s.run.floor === 2 && s0.run.lostTry === null && s0.run.retry.left === 3 && s0.run.tries === 0 && sl.run.lostTry === null && viaLife.run.lostTry === 'life' && viaLife.run.retry.used === 0 && viaLife.run.tries === 1 && sd.record.retries === 1 && J(sd.record.fewestRetries) === J({ '3v3': 1, '6v6': null }) && sd.last.retries === 1 && s.saved === true && unsaved.saved === false && SS.summarizeTower(mkT(), PACK).record.retries === 0 && J(JSON.parse(J(s))) === J(s), t('R25 the summary the screens draw says it all: the run\'s retries (used, on this floor, left, the cap and what it covers), whether the last try of the floor was lost (by a retry or by an Extra Life) and the try number; the record\'s total and fewest; the last run\'s retries; and whether the climb is being saved'), J(s.run.retry));
    }
    // ---- THE ACHIEVEMENTS a retry must not cheapen
    { const E0 = T.emptyTower(), FL = { flawless: true, faints: 0 }, R0 = (history, o) => mkRun(S, { history, floor: Math.min(30, history.filter((h) => h.result === 'w').length + 1), ...(o || {}) });
      const withLoss = (hist, floor, mark) => { const i = hist.findIndex((h) => h.floor === floor && h.result === 'w'); return hist.slice(0, i).concat([lossRow(floor, mark)], hist.slice(i)); };
      const earns = (run, id) => A.evaluate(run, E0).unlocked.includes(id);
      const cases = [['flawless-floor', W(3, (i) => (i === 2 ? FL : {})), 2, 3], ['hat-trick', W(5, (i) => (i >= 2 && i <= 4 ? FL : {})), 3, 5], ['flawless-10', W(12, (i) => (i <= 10 ? FL : {})), 4, 12], ['untouchable-boss', W(10, (i) => (i === 10 ? FL : {})), 10, 4]];
      const why = [];
      for (const [id, hist, onIt, elsewhere] of cases) {
        if (!earns(R0(hist), id)) why.push(id + ': not earned by its clean fixture');
        if (earns(R0(withLoss(hist, onIt, 'retry')), id)) why.push(id + ': earned although floor ' + onIt + ' took a retry');
        if (earns(R0(withLoss(hist, onIt, 'life'), { livesUsed: 1 }), id)) why.push(id + ': earned although floor ' + onIt + ' cost an Extra Life');
        if (!earns(R0(withLoss(hist, elsewhere, 'retry')), id)) why.push(id + ': lost to a retry on floor ' + elsewhere + ', which it does not depend on');
      }
      const wonAll = W(30, () => FL), wonRun = (history, o) => mkRun(S, { phase: 'won', floor: 30, history, ...(o || {}) });
      if (!earns(wonRun(wonAll), 'flawless-run')) why.push('flawless-run: not earned by a clean climb');
      if (earns(wonRun(withLoss(wonAll, 7, 'retry')), 'flawless-run')) why.push('flawless-run: earned with a retry on floor 7');
      if (earns(wonRun(withLoss(wonAll, 7, 'life'), { livesUsed: 1 }), 'flawless-run')) why.push('flawless-run: earned with an Extra Life spent');
      const facts = A.runFacts(R0(withLoss(withLoss(W(4, () => FL), 2, 'retry'), 2, 'retry')), E0);
      ok(why.length === 0 && facts.retries === 2 && facts.flawless === 3 && facts.flawlessStreak === 2, t('R26 THE "WITHOUT LOSING A POKEMON" ACHIEVEMENTS CANNOT BE FISHED FOR: Not a Scratch, Hat Trick, Spotless, Untouchable and Perfect Climb count a floor only when it was won with no faint ON ITS FIRST TRY (a retry or an Extra Life on that floor spoils it, a lost try breaks a streak), and a retry on a floor they do not depend on changes nothing'), why.join(' | '));
      const one = loseT(t0), four = loseT(loseT(loseT(one.tower).tower).tower), phx = climb(mkT(), 61, (f) => (f === 4 ? 1 : 0));
      const words = Object.fromEntries(A.ACHIEVEMENTS.map((a) => [a.id, a.desc]));
      ok(!('rock-bottom' in one.tower.achievements) && one.tower.current !== null && four.finished && 'rock-bottom' in four.tower.achievements && /tries/.test(words['rock-bottom']) && !/^Lose on floor 1\.$/.test(words['rock-bottom']) && ['flawless-floor', 'hat-trick', 'flawless-10', 'untouchable-boss'].every((id) => /first try/.test(words[id])) && /without a retry/.test(words['flawless-run']) && !('phoenix' in phx.achievements) && !('second-wind' in phx.achievements) && 'tower-master' in phx.achievements && A.ACHIEVEMENTS.length === 51, t('R27 the achievements whose meaning changed say what now happens: Rock Bottom is no longer one loss on floor 1 (the run goes on) but running out of tries there; the five flawless ones say "first try" / "without a retry"; Phoenix and Second Chance still need an Extra Life (a climb won with a retry earns neither); there are still 51'), words['rock-bottom']);
    }
    // ---- a bot that loses and retries reaches further (real battles; the same seeds under the old rule and under the rule in force)
    { const runs = N(10, 3), reach = (cfgB, i) => {
        const team = matchctl.randomTeam(PACK, 9000 + i * 31, 6, CFG.ruleset); let run = T.newRun({ pack: PACK, seed: 123457 + i * 101, format: '3v3', team: { name: 'Bot', recs: team.recs, meta: team.meta } });
        for (let g = 0; g < 400 && run.phase !== 'over' && run.phase !== 'won'; g++) {
          if (run.phase === 'offer') { run = T.takeBuff(run, null).run; continue; }
          const s = T.battleSetup(PACK, run, cfgB), ctl = matchctl.createMatchController({ pack: PACK, ruleset: s.ruleset, teams: [s.player.recs, s.foe.recs], seed: s.seed, pick: s.pick, names: s.names, validate: false, sides: [{ kind: 'cpu', level: 'hard', seed: 5 + i }, { kind: 'cpu', level: s.cpu.level, seed: s.cpu.seed }] }); ctl.start();
          run = T.recordFloorResult(run, { floor: run.floor, result: ctl.winner === 0 ? 'w' : 'l', turns: ctl.turn, faints: 0 }, { pack: PACK, cfg: cfgB, tries: T.tryNumber(run) }).run;
        }
        return { cleared: run.history.filter((h) => h.result === 'w').length, retries: T.retriesOf(run), ok: T.parseRun(run).ok };
      };
      const oldR = [], newR = []; for (let i = 0; i < runs; i++) { oldR.push(reach(OLD, i)); newR.push(reach(CFG, i)); }
      const sum = (xs) => xs.reduce((n, x) => n + x.cleared, 0);
      ok(newR.every((x, i) => x.cleared >= oldR[i].cleared && x.ok) && sum(newR) > sum(oldR) && oldR.every((x) => x.retries === 0) && newR.some((x) => x.retries > 0) && newR.every((x) => x.retries <= 3 * (x.cleared + 1)), t('R28 A BOT THAT LOSES AND RETRIES REACHES FURTHER: over ' + runs + ' climbs with the same seeds, every climb with three retries a floor clears at least as many floors as it does when a loss ends it, and more in all (' + sum(oldR) + ' -> ' + sum(newR) + ' floors); a retry is a real battle with other dice, and no floor takes more than three'), J([oldR.map((x) => x.cleared), newR.map((x) => x.cleared)]));
    }
  }

  /* S. the session, the fight and the page under the rule in force: a lost try is counted ONCE whatever is replayed, a stale page cannot answer a newer try, leaving costs what the page says it costs */
  if (grp('S')) {
    const ticks = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
    const mkNav = () => { const calls = []; return { calls, toTower: (s) => calls.push(['tower', s === undefined ? null : s]), toHub: () => calls.push(['hub']), retry: (run) => calls.push(['retry', run.floor, T.tryNumber(run)]) }; };
    const openS = (per, o) => TF.createTowerFight({ pack: PACK, persist: per, floor: 1, runId: 777, navType: 'navigate', nav: mkNav(), now: () => 7000, ...(o || {}) });          // (the config in force: three retries a floor)
    const fresh = () => SS.memoryPersist(startT());
    const fakeCtl = () => { const subs = new Set(), c = { winner: null, battle: { events: [], s: { sides: [{ team: [] }, { team: [] }] } }, onEnd(cb) { subs.add(cb); return () => subs.delete(cb); }, end(w) { c.winner = w; for (const cb of [...subs]) cb(); } }; return c; };
    const sumW = () => ({ result: 'w', turns: 5, faints: 0 }), sumL = () => ({ result: 'l', turns: 7, faints: 3 });
    const retr = (per) => (per.peek().current ? T.retriesOf(per.peek().current) : -1);

    /* S1-S3: the page's own functions */
    { const per = fresh(), a = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 1, runId: 777, nonce: () => 301 });
      await a.markFight(); const first = await a.finish(LOSS(1)), state = J(per.peek()), again = await a.finish(LOSS(1)), lateWin = await a.finish(WIN(1));
      const b = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 1, runId: 777, nonce: () => 302 });
      ok(a.ok && a.tries === 0 && first.applied && first.next.step === 'retry' && first.next.via === 'retry' && first.retries.left === 2 && again.applied === false && /try of the floor is over/.test(again.why) && lateWin.applied === false && J(per.peek()) === state && retr(per) === 1 && per.peek().current.phase === 'battle' && b.ok && b.status === 'ok' && b.tries === 1 && b.attempt === 302 && b.spec.seed !== a.spec.seed && b.tag !== a.tag, t('S1 through the page\'s own functions: the lost try counts ONE retry; the same result sent again (a result fired twice) and a late win of that try are refused and change nothing; the floor then opens as try 1, with its own attempt, seed and tag'), J([again.why, b.tries]));
    }
    { // a stale page: it opened try 0 and made no choice; another page fought try 0 and lost it
      const per = fresh(), A1 = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 1, runId: 777, nonce: () => 11 }), B1 = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 1, runId: 777, nonce: () => 22 });
      await B1.markFight(); const lost = await B1.finish(LOSS(1)), state = J(per.peek());
      const mark = await A1.markFight(), w = await A1.finish(WIN(1)), l = await A1.finish(LOSS(1)), untouched = J(per.peek()) === state;
      const C1 = await SS.startTowerFloor({ pack: PACK, persist: per, floor: 1, runId: 777, nonce: () => 33 }); const l2 = C1.ok ? (await C1.markFight(), await C1.finish(LOSS(1))) : { applied: false };
      ok(lost.applied && mark.applied === false && !mark.taken && /try of the floor is over/.test(mark.why) && w.applied === false && l.applied === false && untouched && C1.tries === 1 && l2.applied && retr(per) === 2 && per.peek().current.history.every((h) => h.retry === true), t('S2 A STALE PAGE CANNOT ANSWER A NEWER TRY: a page that opened try 0 and is still open after try 0 was lost elsewhere cannot mark a fight, win the floor or count another loss (the record is untouched by it); the page of try 1 can'), J([mark.why, w.why]));
    }
    { // two tabs on the same try
      const per = fresh(); let dupB = 0;
      const A1 = await openS(per, { nonce: () => 101 }), B1 = await openS(per, { nonce: () => 202, onDuplicate: () => { dupB++; } });
      A1.committed(); await ticks(); B1.committed(); await ticks();
      const r = await B1.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }), mid = per.peek().current;
      const left = await openS(per), afterLeft = J(per.peek()), next = await openS(per), stillSame = J(per.peek()) === afterLeft;
      ok(dupB === 1 && r.applied === false && r.taken === true && mid.fighting === true && mid.attempt === 101 && mid.history.length === 0 && !left.ok && left.status === 'abandoned' && left.next.step === 'retry' && left.next.via === 'retry' && /cost one retry/.test(left.message) && /2 of 3 retries are left on this floor/.test(left.message) && /saved/.test(left.message) && retr(per) === 1 && per.peek().runs === 0 && next.ok && next.status === 'ok' && next.spec.tower.tries === 1 && stillSame, t('S3 A SECOND TAB: the duplicate\'s lost fight is refused (it never counts a retry); the first tab\'s fight, left, costs ONE retry and the run goes on (the page says so, with what is left); arriving again after that opens the next try and costs nothing more'), left.message);
    }

    /* S4-S7: every kill point of a lost fight counts the retry exactly once */
    { const per = fresh(), f = await openS(per, { nonce: () => 41 }); f.committed(); await ticks();
      const rl = await openS(per, { navType: 'reload' }), left = await openS(per, { navType: 'navigate' }), st = J(per.peek()), again = await openS(per, { navType: 'navigate' });
      ok(rl.ok && rl.status === 'resume' && !left.ok && left.status === 'abandoned' && retr(per) === 1 && per.peek().current.floor === 1 && per.peek().current.fighting === false && per.peek().runs === 0 && again.ok && again.status === 'ok' && J(per.peek()) === st, t('S4 kill point 1, during the fight: a reload resumes it; closing the page and coming back is the fight LEFT: it costs one retry of the floor, counted once, AND THE RUN GOES ON'), J([rl.status, left.status, retr(per)]));
    }
    { const per = fresh(), f = await openS(per, { nonce: () => 41 }); f.committed(); await ticks();
      const c = fakeCtl(); f.watchEngine(c, sumL); c.end(1); await ticks();
      const tw = per.peek(), counted = tw.current && tw.current.phase === 'battle' && tw.current.floor === 1 && T.retriesOf(tw.current) === 1 && tw.current.fighting === false && tw.current.attempt === 0 && tw.runs === 0, before = J(tw);
      const rl = await openS(per, { navType: 'reload' }), nav = await openS(per, { navType: 'navigate' }), bf = await openS(per, { navType: 'back_forward' });
      ok(counted && [rl, nav, bf].every((x) => x.ok && x.status === 'ok' && x.spec.tower.tries === 1) && J(per.peek()) === before, t('S5 kill point 2, after the engine ended and before the result screen: the retry is already in the record, and A RELOAD AT THE RESULT DOES NOT COUNT IT AGAIN: reloading, going back or typing the address opens the next try of the floor and writes nothing'), J([rl.status, nav.status, bf.status]));
      const info = { summary: sumL(), ticks: 9, winner: 1 }, p1 = f.onMatchEnd(info), p2 = f.onMatchEnd(info); await p1;
      f.onQuit(); await ticks();
      ok(p1 === p2 && J(per.peek()) === before && J(f.nav.calls) === J([['tower', 'retry']]), t('S6 kill point 3, on the result screen: the scene announcing the same match (twice), and LEAVE TOWER afterwards, change nothing (the retry is counted exactly once) and the Tower opens'), J(f.nav.calls));
      const g = await openS(per, { nonce: () => 42 }); g.committed(); await ticks(); const c2 = fakeCtl(); g.watchEngine(c2, sumL); c2.end(1); await ticks();
      g.onResult('RETRY FLOOR'); await new Promise((r) => setTimeout(r, 20));
      const h = await openS(per, { nonce: () => 43 }); h.committed(); await ticks(); await h.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }); h.onResult('BACK TO TOWER'); await new Promise((r) => setTimeout(r, 20));
      ok(J(g.nav.calls) === J([['retry', 1, 2]]) && retr(per) === 3 && J(h.nav.calls) === J([['tower', 'retry']]), t('S7 kill point 4, the result buttons: RETRY FLOOR goes straight to the same floor as the next try (the run it hands on is on try 2), BACK TO TOWER goes to the Tower with the climb saved; neither counts anything'), J([g.nav.calls, h.nav.calls]));
      // the fourth lost try of the floor: the run ends, and the page shows what a lost run always showed
      const k = await openS(per, { nonce: () => 44 }), opts = J(k.resultOptions(1)), bar = k.bar(); k.committed(); await ticks(); const end = await k.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }); k.onResult('TO THE TOWER'); await new Promise((r) => setTimeout(r, 20));
      ok(opts === '["TO THE TOWER","BACK TO HUB"]' && /RETRIES 0\/3$/.test(bar) && end.applied && end.finished && end.next.step === 'over' && per.peek().current === null && per.peek().runs === 1 && per.peek().last.retries === 3 && k.recap().head === 'TOWER FLOOR 1: NO RETRY LEFT' && k.recap().notes[0] === 'THE CLIMB ENDS ON FLOOR 1.' && J(k.nav.calls) === J([['tower', 'over']]) && (await openS(per)).status === 'stale', t('S8 THE LOSS AFTER THE THIRD RETRY OF A FLOOR ENDS THE RUN: the buttons are the ones a lost run always had, the record page says the floor\'s retries were used up, the run is folded once with its 3 retries, and the Tower shows the last run'), J([opts, k.recap()]));
    }
    { // leaving mid-fight (after the first choice): one retry, the run goes on; four leaves in a row end it
      const per = fresh(), f = await openS(per); f.committed(); await ticks(); const cost = f.leaveCost('quit'); f.onQuit(); await new Promise((r) => setTimeout(r, 20)); f.onQuit(); await new Promise((r) => setTimeout(r, 20));
      ok(cost.cost === 'retry' && cost.left === 3 && J(f.nav.calls) === J([['tower', 'retry'], ['tower', 'retry']]) && retr(per) === 1 && per.peek().current.floor === 1 && per.peek().runs === 0 && per.peek().last === null, t('S9 LEAVING MID-FIGHT (LEAVE TOWER after the first choice) costs ONE retry and the run goes on; asking twice counts it once'), J(f.nav.calls));
      let ended = null; for (let i = 0; i < 3; i++) { const g = await openS(per); g.committed(); await ticks(); if (i === 2) ended = g.leaveCost('quit'); g.onQuit(); await new Promise((r) => setTimeout(r, 20)); }
      ok(ended && ended.cost === 'end' && per.peek().current === null && per.peek().runs === 1 && per.peek().last.retries === 3 && per.peek().last.cleared === 0 && 'rock-bottom' in per.peek().achievements, t('S10 ... and leaving when no retry is left ends the climb, as the question said it would'), J(ended));
    }
    { // a marked fight that cannot be restored
      const per = fresh(), f = await openS(per, { nonce: () => 41 }); f.committed(); await ticks();
      const rl = await openS(per, { navType: 'reload' }), a = await rl.leaveUnrestorable(), a2 = await rl.leaveUnrestorable();
      ok(rl.status === 'resume' && /cost one retry/.test(a.message) && /2 of 3 retries are left/.test(a.message) && a2.message === a.message && retr(per) === 1 && per.peek().runs === 0, t('S11 a marked fight that is reloaded and cannot be restored is LEFT: one retry, counted once however often it is asked, with the words that say so'), a.message);
    }
    { // the engine's end is heard once whoever announces it; a win after retries opens the offer
      const per = SS.memoryPersist(loseT(loseT(startT()).tower).tower), f = await openS(per, { nonce: () => 5 }); f.committed(); await ticks();
      const c = fakeCtl(); f.watchEngine(c, sumW); c.end(0); await ticks(); await f.onMatchEnd({ summary: sumW(), ticks: 1, winner: 0 });
      const cur = per.peek().current;
      ok(f.spec.tower.tries === 2 && /RETRIES 1\/3$/.test(f.bar()) && cur.phase === 'offer' && cur.floor === 2 && T.retriesOf(cur) === 2 && T.floorRetriesOf(cur) === 0 && cur.history.filter((h) => h.result === 'w').length === 1 && f.recap().notes[0] === 'FLOOR 1 CLEARED. PICK A BUFF.', t('S12 the third try of a floor, won: the offer opens as after any win, the two retries stay counted, and the next floor starts with none used'), J(f.recap()));
    }

    /* S13-S15: what the page SAYS: the status line, the buttons, the record page, the question */
    { const per = fresh(), f0 = await openS(per), f1 = await openS(SS.memoryPersist(loseT(startT()).tower)), fl = await TF.createTowerFight({ pack: PACK, persist: SS.memoryPersist(lifeT()), floor: 2, runId: 777, navType: 'navigate', nav: mkNav(), now: () => 7000 });
      const PER_RUN = Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: 3 }), NONE = Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: null });
      const fr = await openS(fresh(), { cfg: PER_RUN }), fn = await openS(fresh(), { cfg: NONE }), fo = await openS(fresh(), { cfg: OLD });
      ok(/^TOWER  FLOOR 1\/30  .+  BUFFS 0  RETRIES 3\/3$/.test(f0.bar()) && /RETRIES 2\/3$/.test(f1.bar()) && /BUFFS 1  RETRIES 3\/3  LIVES 1$/.test(fl.bar()) && /RETRIES 3\/3$/.test(fr.bar()) && /RETRIES USED 0$/.test(fn.bar()) && /BUFFS 0$/.test(fo.bar()), t('S13 the battle page\'s Tower bar shows the retries left of the cap (3/3, then 2/3; before the lives when there are any; "RETRIES USED n" when there is no cap; nothing where the config hands out none)'), [f0.bar(), fl.bar(), fn.bar()].join(' | '));
      ok(J(f0.resultOptions(1)) === '["RETRY FLOOR","BACK TO TOWER","BACK TO HUB"]' && J(f0.resultOptions(-1)) === '["RETRY FLOOR","BACK TO TOWER","BACK TO HUB"]' && J(f0.resultOptions(0)) === '["PICK A BUFF","BACK TO HUB"]' && J(fl.resultOptions(1)) === '["RETRY FLOOR","BACK TO TOWER","BACK TO HUB"]' && J(fo.resultOptions(1)) === '["TO THE TOWER","BACK TO HUB"]' && [f0, fl].every((x) => x.resultOptions(1).every((s) => s.length <= 14)), t('S14 the result screen after a loss with a retry (or an Extra Life) in hand offers RETRY FLOOR first, then BACK TO TOWER, then BACK TO HUB (each within the 14 characters a result button may have); a win is unchanged'), J(f0.resultOptions(1)));
      f0.committed(); await ticks(); await f0.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 });
      fr.committed(); await ticks(); await fr.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }); fn.committed(); await ticks(); await fn.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 });
      fl.committed(); await ticks(); await fl.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 });
      const r0 = f0.recap(), rr = fr.recap(), rn = fn.recap(), rl = fl.recap();
      ok(r0.head === 'TOWER FLOOR 1: RETRY COUNTED' && J(r0.notes) === J(['THE CLIMB IS SAVED. TRY THE FLOOR AGAIN.', '2 OF 3 RETRIES LEFT HERE, 1 USED.', 'Not in your battle record.']) && rr.notes[1] === '2 OF 3 RETRIES LEFT IN ALL, 1 USED.' && rn.notes[1] === 'RETRIES USED ON THIS CLIMB: 1.' && rl.head === 'TOWER FLOOR 2' && rl.notes[0] === 'EXTRA LIFE USED. TRY THE FLOOR AGAIN.' && [r0, rr, rn, rl].every((x) => x.notes.length === 3 && x.notes[2] === 'Not in your battle record.' && x.head.length <= 30), t('S15 the record page after a lost try says the climb is saved, how many retries are left (here, or in all) and how many the climb has used; an Extra Life says so instead; every one ends with "Not in your battle record."'), J(r0));
    }
    { // what leaving costs NOW, and the question that says it
      const per = fresh(), f = await openS(per), before = [f.leaveCost('quit').cost, f.leaveCost('forfeit').cost, f.leaveAsk('quit', 'box'), f.leaveAsk('quit', 'title'), f.leaveAsk('forfeit', 'box'), f.leaveAsk('forfeit', 'title')];
      f.committed(); await ticks(); const after = [f.leaveCost('quit').cost, f.leaveAsk('quit', 'box'), f.leaveAsk('quit', 'title')];
      const last = await openS(SS.memoryPersist(loseT(loseT(loseT(startT()).tower).tower).tower)); last.committed(); await ticks();
      const one = await openS(SS.memoryPersist(loseT(loseT(startT()).tower).tower)); one.committed(); await ticks();
      const life = await TF.createTowerFight({ pack: PACK, persist: SS.memoryPersist(lifeT()), floor: 2, runId: 777, navType: 'navigate', nav: mkNav(), now: () => 7000 }); life.committed(); await ticks();
      const perRun = await openS(fresh(), { cfg: Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: 3 }) }); perRun.committed(); await ticks();
      const old = await openS(fresh(), { cfg: OLD }); old.committed(); await ticks();
      const resumed = await openS(per, { navType: 'reload' });
      ok(J(before) === J(['nothing', 'retry', 'Leave the Tower? No choice was made yet, so it costs nothing.', 'Leave? Costs nothing.', 'Give up? It costs 1 of the 3 retries left on this floor.', 'Give up? Costs 1 retry.']) && J(after) === J(['retry', 'Leave? It costs 1 of the 3 retries left on this floor.', 'Leave? Costs 1 retry.']) && one.leaveAsk('quit', 'box') === 'Leave? It costs 1 of the 1 retry left on this floor.' && last.leaveCost('quit').cost === 'end' && last.leaveAsk('quit', 'box') === 'Leave? No retry is left on this floor: the climb ends here.' && last.leaveAsk('forfeit', 'title') === 'Give up? The climb ends.' && life.leaveCost('forfeit').cost === 'life' && /spends your Extra Life/.test(life.leaveAsk('quit', 'box')) && perRun.leaveAsk('quit', 'box') === 'Leave? It costs 1 of the 3 retries left on this climb.' && old.leaveAsk('quit', 'box') === 'Leave? It counts as a loss: the climb ends here.' && resumed.status === 'resume' && resumed.leaveCost('quit').cost === 'retry', t('S16 LEAVE TOWER and FORFEIT say truthfully what leaving NOW costs: nothing before the first choice (FORFEIT is itself a choice, so it costs a retry); after it, one of the N retries left on this floor (or on the climb), an Extra Life while one is held, the end of the climb when none is left; a fight resumed by a reload was already begun'), J(before));
      // every one of those lines fits where the scene draws it: two lines of the message box, and the title row of the team preview (no wider than the longest title the scene already has)
      const BU = await imp(opt.dir || SRC, 'battle_ui.js'), HBm = S.HB, ui = BU.createBattleUi(romBytes), mw = (font) => (s) => ui.measure(font, ui.safeText(String(s)));
      const fights = [f, last, one, life, perRun, old, await openS(fresh())], wide = [];
      for (const x of fights) for (const kind of ['quit', 'forfeit']) {
        const box = HBm.wrapLines(x.leaveAsk(kind, 'box'), mw('normal'), ui.R.msg.w - 4), title = x.leaveAsk(kind, 'title');
        if (box.length > 2) wide.push('box: ' + x.leaveAsk(kind, 'box'));
        if (mw('normal')(title) > mw('normal')('Send out this one first?')) wide.push('title: ' + title);
      }
      const recaps = [];
      for (const cfgX of [CFG, Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: 3 }), Object.freeze({ ...CFG, retriesPerFloor: null, retriesPerRun: null })]) for (const lostN of [0, 2, 3]) {
        let tw = startT(); for (let i = 0; i < lostN; i++) tw = loseT(tw, { cfg: cfgX }).tower;
        if (!tw.current) continue;
        const x = await openS(SS.memoryPersist(tw), { cfg: cfgX }); x.committed(); await ticks(); await x.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }); recaps.push(x.recap());
      }
      for (const r of recaps) { if (mw('normal')(r.head) > 214) wide.push('head: ' + r.head); for (const n of r.notes) if (mw('small')(n) > 214) wide.push('note: ' + n); }
      ok(wide.length === 0 && recaps.length >= 7, t('S17 every LEAVE / FORFEIT question fits the two lines of the message box and the title row of the team preview, and every line of the record page (' + recaps.length + ' lost tries under three configs) fits its 214 pixels, measured with the ROM\'s fonts'), wide.slice(0, 3).join(' | '));
    }
    { // the real scene, on a real Tower floor: the pause menu's LEAVE TOWER and FORFEIT ask the fight's question; a battle that passes no such option asks what it always asked
      const DIRS = opt.dir || SRC, [SCm, BTm, BUm] = await Promise.all(['scene.js', 'battle_text.js', 'battle_ui.js'].map((x) => imp(DIRS, x)));
      const text = BTm.loadBattleText(romBytes, JSON.parse(fs.readFileSync(path.join(root, 'pokemonarena', 'text_manifest.json'), 'utf8'))), ui = BUm.createBattleUi(romBytes);
      const per = fresh(), f = await openS(per), sp = f.spec;
      const mk = (extra) => { const ctl = matchctl.createMatchController({ pack: PACK, ruleset: sp.ruleset, teams: sp.teams, seed: sp.seed, pick: sp.pick, lead: sp.lead, freeSwitch: true, names: sp.names, sides: sp.sides, validate: sp.validate }); const sc = SCm.createScene({ ui, pack: PACK, text, ctl, viewSide: 0, env: 0, textSpeed: 'fast', meta: sp.meta, trainer: sp.trainer, playerName: 'You', quitLabel: 'LEAVE TOWER', ...extra }); return { ctl, sc }; };
      const menuTo = (sc, label) => { sc.press('start'); const rows = sc.S.menu ? sc.S.menu.rows.slice() : [], i = rows.indexOf(label); for (let k = 0; k < i; k++) sc.press('down'); sc.press('a'); return i >= 0; };
      const toPreview = (x) => { x.ctl.start(); x.sc.begin(); let g = 0; while (x.sc.mode !== 'preview' && g++ < 20000) x.sc.tick(); };
      const X = mk({ leaveAsk: (k, w) => f.leaveAsk(k, w) }); X.ctl.onLocalChoice(() => f.committed()); toPreview(X);
      const seen = [];
      menuTo(X.sc, 'LEAVE TOWER'); seen.push(X.sc.view().preview.title); X.sc.press('b');
      menuTo(X.sc, 'FORFEIT'); seen.push(X.sc.view().preview.title); X.sc.press('b');
      X.sc.choose.preview(0); X.sc.choose.preview(1); X.sc.choose.preview(2); X.sc.press('a'); X.sc.settle(); await ticks();
      menuTo(X.sc, 'LEAVE TOWER'); seen.push(X.sc.view().box.text.join(' ')); X.sc.press('b');
      menuTo(X.sc, 'FORFEIT'); seen.push(X.sc.view().box.text.join(' ')); const lines = X.sc.view().box.text.length; X.sc.press('b');
      ok(J(seen) === J(['Leave? Costs nothing.', 'Give up? Costs 1 retry.', 'Leave? It costs 1 of the 3 retries left on this floor.', 'Give up? It costs 1 of the 3 retries left on this floor.']) && lines <= 2 && per.peek().current.fighting === true, t('S18 IN THE REAL SCENE on a Tower floor: at the team preview LEAVE TOWER asks "Leave? Costs nothing." and FORFEIT "Give up? Costs 1 retry."; after the first choice both say one of the 3 retries left on this floor, in the two lines of the message box'), J(seen));
      const plain = [];
      for (const extra of [{}, { leaveAsk: () => null }, { leaveAsk: () => { throw new Error('x'); } }, { leaveAsk: () => 'y'.repeat(121) }, { leaveAsk: 'Leave?' }]) {
        try { const Y = mk(extra); toPreview(Y); menuTo(Y.sc, 'LEAVE TOWER'); plain.push(Y.sc.view().preview.title); Y.sc.press('b'); menuTo(Y.sc, 'FORFEIT'); plain.push(Y.sc.view().preview.title); } catch (e) { plain.push('the scene threw: ' + e.message, ''); }
      }
      ok(plain.every((s, i) => s === (i % 2 ? 'Give up this battle?' : 'Leave this battle?')), t('S19 a battle that passes no such option (every regular and online battle), or one whose option gives nothing, throws or gives too much, asks exactly what the scene always asked'), J(plain));
      const bb = fs.readFileSync(path.join(DIRS, 'battle_boot.js'), 'utf8');
      ok(/leaveAsk: towerFight \? \(kind, where\) => towerFight\.leaveAsk\(kind, where\) : undefined/.test(bb), t('S20 the battle page hands the scene the Tower fight\'s question, and only for a Tower floor (a regular battle passes none)'), '');
    }

    /* S21: the address names the try */
    { const rng = ai.createRng(4242); let bad = '';
      for (let i = 0; i < N(200, 40) && !bad; i++) {
        const lives = rng(3), hist = []; for (let k = 0; k < rng(9); k++) hist.push(rng(3) === 0 ? lossRow(1, 'life') : rng(2) ? lossRow(1, 'retry') : { floor: 1, result: 'w' });
        const run = { seed: 5 + i, floor: 1 + rng(30), livesUsed: lives, history: hist }, want = REC.tryNumber(run), u = TL.towerBattleHref(run, { profileId: 'p_x' }), r = TL.parseTowerParams(new URLSearchParams(u.slice(u.indexOf('?') + 1)));
        if (TL.tryOfRun(run) !== want || !r.ok || r.tower.tries !== want || /life=/.test(u) || (want > 0) !== /[?&]try=\d+/.test(u)) bad = u + ' want ' + want;
      }
      const q = (x) => TL.parseTowerParams(new URLSearchParams(x)), badQ = ['tower=1&floor=3&run=4&try=1001', 'tower=1&floor=3&run=4&try=-1', 'tower=1&floor=3&run=4&try=1.5', 'tower=1&floor=3&run=4&try=0x2', 'tower=1&floor=3&run=4&try=abc', 'tower=1&floor=3&run=4&try=2&life=-1'];
      ok(!bad && q('tower=1&floor=3&run=4&life=2').tower.tries === 2 && q('tower=1&floor=3&run=4&try=5&life=2').tower.tries === 5 && q('tower=1&floor=3&run=4&try=0&life=2').tower.tries === 0 && q('tower=1&floor=3&run=4').tower.tries === 0 && badQ.every((x) => q(x).ok === false) && q('try=3&floor=2').tower === null && BB.parseBattleQuery('?try=3').ok && BB.parseBattleQuery('?try=3').params.tower === null && TL.towerBattleHref({ seed: 9, floor: 4, livesUsed: 0, history: [] }, {}) === '/pokemonarena/battle.html?tower=1&floor=4&run=9', t('S21 THE ADDRESS NAMES THE TRY (try=K: the lives spent + the retries counted, the same number the run gives; nothing for the first try): it reads back, the older life=K is still read when there is no try, hostile values of either are refused, and try= on a regular address is ignored'), bad);
    }

    /* S22-S24: THE PAGE BEHIND A RETRY (the review of 2026-11-17). A retry is another page than the try it follows, so the page BEHIND a retry in the tab's history can be the lost try's battle page. Reached
       by the browser's Back in the middle of the retry, that page took the fight under way for its own, found nothing saved under its own address and counted the fight as LEFT: Back cost a retry at once,
       and ended the climb on the last try, with no question asked, while Forward would have resumed the fight untouched. A page now says which try it was OPENED AS (`openedTry`: the battle page's address). */
    { const per = SS.memoryPersist(loseT(startT()).tower);                                                                   // the run is on try 1 of floor 1 (one retry counted)
      const f = await openS(per, { nonce: () => 61, openedTry: 1 }); f.committed(); await ticks();                          // the retry's own page makes the first choice: the fight is marked
      const state = J(per.peek());
      const back = await openS(per, { navType: 'back_forward', openedTry: 0 }), rl = await openS(per, { navType: 'reload', openedTry: 0 }), other = await openS(per, { navType: 'back_forward', openedTry: 2 });
      const untouched = J(per.peek()) === state;
      const fwd = await openS(per, { navType: 'back_forward', openedTry: 1 }), same = await openS(per, { navType: 'reload', openedTry: 1 }), noTry = await openS(per, { navType: 'back_forward' });
      const untouched2 = J(per.peek()) === state;
      // the last try of the floor (no retry left): Back onto the page of the try before it must not end the climb
      const perL = SS.memoryPersist(loseT(loseT(loseT(startT()).tower).tower).tower), fl = await openS(perL, { nonce: () => 62, openedTry: 3 }); fl.committed(); await ticks();
      const stL = J(perL.peek()), backL = await openS(perL, { navType: 'back_forward', openedTry: 2 }), endedNothing = J(perL.peek()) === stL && perL.peek().current !== null && perL.peek().runs === 0 && perL.peek().last === null;
      // no fight marked: a page opened as another try (a reload at a lost result) opens the try the run is on, and writes nothing
      const perO = SS.memoryPersist(loseT(startT()).tower), stO = J(perO.peek()), o1 = await openS(perO, { navType: 'reload', openedTry: 0 }), o2 = await openS(perO, { navType: 'back_forward', openedTry: 0 }), o3 = await openS(perO, { navType: 'navigate', openedTry: 0 });
      const openedOk = [o1, o2, o3].every((x) => x.ok && x.status === 'ok' && x.tries === 1 && x.spec.tower.tries === 1) && J(perO.peek()) === stO;
      // ... while a FRESH arrival at any address of the floor still means the fight was left (a typed address is not a way round the cost of leaving)
      const typed = await openS(per, { navType: 'navigate', openedTry: 0 });
      ok(f.ok && f.tries === 1 && [back, rl, other].every((x) => !x.ok && x.status === 'elsewhere' && /Nothing was counted/.test(x.message) && /another page/.test(x.message)) && untouched
        && [fwd, same, noTry].every((x) => x.ok && x.status === 'resume' && x.attempt === 61 && x.tries === 1) && untouched2
        && fl.ok && !backL.ok && backL.status === 'elsewhere' && endedNothing && openedOk
        && !typed.ok && typed.status === 'abandoned' && retr(per) === 2 && per.peek().current.fighting === false,
        t('S22 THE PAGE BEHIND A RETRY: with a retry under way (its first choice made), the browser\'s Back or a reload onto the page of ANOTHER try of the floor is "elsewhere": it neither resumes that fight nor counts it as left, and writes NOTHING (on the last try too: the climb does not end); Forward, or a reload of the fight\'s own page, resumes it with its own attempt; a page that says no try at all resumes as before; with no fight marked such a page just opens the try the run is on; and a FRESH arrival still counts the fight as left'), J([back.status, rl.status, other.status, untouched, fwd.status, same.status, noTry.status, untouched2, backL.status, endedNothing, openedOk, typed.status, retr(per)]));
    }
    { // RETRY FLOOR on a result screen that has outlived its moment (it is still in the tab's history, or the browser brought the page back whole): it must never open a try that is being fought elsewhere
      const wait = () => new Promise((r) => setTimeout(r, 25));
      const per = fresh(), a = await openS(per, { nonce: () => 71 }); a.committed(); await ticks(); await a.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 });           // try 0 is lost: its result screen is up
      const b = await openS(per, { nonce: () => 72 }); b.committed(); await ticks();                                                                                      // ... and another page has since begun try 1
      const state = J(per.peek()); a.onResult('RETRY FLOOR'); await wait();
      const fought = J(a.nav.calls), kept = J(per.peek()) === state && per.peek().current.fighting === true && per.peek().current.attempt === 72;
      // ... or one that is over (the run has moved on to try 2)
      const per2 = fresh(), a2 = await openS(per2, { nonce: () => 73 }); a2.committed(); await ticks(); await a2.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 });
      const b2 = await openS(per2, { nonce: () => 74 }); b2.committed(); await ticks(); await b2.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 });
      const state2 = J(per2.peek()); a2.onResult('RETRY FLOOR'); await wait();
      const movedOn = J(a2.nav.calls), kept2 = J(per2.peek()) === state2 && retr(per2) === 2;
      // ... or when the record cannot be read at that moment: the Tower, never a blind retry
      const per3 = fresh(); let broken = false;
      const flaky = { read: () => (broken ? Promise.reject(new Error('storage is gone')) : per3.read()), update: (fn) => per3.update(fn), peek: () => per3.peek() };
      const a3 = await openS(flaky, { nonce: () => 75 }); a3.committed(); await ticks(); await a3.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }); broken = true; a3.onResult('RETRY FLOOR'); await wait();
      // the ordinary case: nothing has happened since the loss, and the button opens the next try
      const per4 = fresh(), a4 = await openS(per4, { nonce: () => 76 }); a4.committed(); await ticks(); await a4.onMatchEnd({ summary: sumL(), ticks: 1, winner: 1 }); a4.onResult('RETRY FLOOR'); await wait();
      ok(fought === J([['tower', null]]) && kept && movedOn === J([['tower', null]]) && kept2 && J(a3.nav.calls) === J([['tower', null]]) && J(a4.nav.calls) === J([['retry', 1, 1]]) && retr(per4) === 1,
        t('S23 RETRY FLOOR ON A RESULT SCREEN THAT OUTLIVED ITS MOMENT never leaves a fight without a word: when the try it would open is already being fought on another page, or is over, or the record cannot be read, the button goes to the Tower (which says where the climb stands) and writes nothing; while the run still waits for that try, untouched, it opens it'), J([fought, kept, movedOn, kept2, a3.nav.calls, a4.nav.calls]));
    }
    { // the battle page's side of it: the address names the try the page hosts, and RETRY FLOOR takes the lost try's place in the history
      const sf = TL.searchForTry, bb = fs.readFileSync(path.join(opt.dir || SRC, 'battle_boot.js'), 'utf8');
      const cases = [
        ['?tower=1&floor=3&run=4', 0, null], ['?tower=1&floor=3&run=4&p=p_x', 2, '?tower=1&floor=3&run=4&p=p_x&try=2'], ['?tower=1&floor=3&run=4&try=1&p=p_x&speed=fast&anim=0', 2, '?tower=1&floor=3&run=4&try=2&p=p_x&speed=fast&anim=0'],
        ['?tower=1&floor=3&run=4&try=2', 0, '?tower=1&floor=3&run=4'], ['?tower=1&floor=3&run=4&try=2', 2, null], ['?tower=1&floor=3&run=4&life=1', 1, null], ['?tower=1&floor=3&run=4&life=1', 2, '?tower=1&floor=3&run=4&try=2'],
        ['?tower=1&floor=3&run=4&life=2&try=1', 3, '?tower=1&floor=3&run=4&try=3'], ['?seed=5&format=3v3', 2, null], ['?tower=1&floor=99&run=4', 2, null], ['?tower=1&floor=3&run=4&try=x', 2, null], ['?tower=1&floor=3&run=4', 1001, null], ['?tower=1&floor=3&run=4', -1, null], ['?tower=1&floor=3&run=4', 1.5, null], ['', 1, null],
      ];
      const wrong = cases.filter(([s, k, want]) => sf(s, k) !== want).map(([s, k]) => s + ' @' + k + ' -> ' + sf(s, k));
      const back = cases.filter(([, , want]) => want !== null).every(([, k, want]) => { const r = TL.parseTowerParams(new URLSearchParams(want.slice(1))); return r.ok && r.tower.tries === k && sf(want, k) === null; });
      const wired = /navType: navigationType\(\), openedTry: tw\.tries, nav: nv,/.test(bb)
        && /retry: \(run\) => launchFloorBattle\(run, \{ navigate: navigateReplacing, profileId \}\)/.test(bb)
        && /const navigateReplacing = \(url\) => \{ if \(typeof window\.__arenaNavigate === 'function'\) window\.__arenaNavigate\(url, \{ replace: true \}\); else location\.replace\(url\); \};/.test(bb)
        && /const fixed = searchForTry\(location\.search, f\.tries\); if \(fixed !== null\) history\.replaceState\(history\.state, '', location\.pathname \+ fixed \+ location\.hash\);/.test(bb)
        && bb.indexOf('const tf = await openTowerFight(params.tower);') > 0 && bb.indexOf('const tf = await openTowerFight(params.tower);') < bb.indexOf('const addrKey = resumeKey(location.pathname, location.search)')
        && /f\.status === 'elsewhere' \? 'Another try of this floor'/.test(bb);
      ok(wrong.length === 0 && back && wired, t('S24 THE BATTLE PAGE NAMES THE TRY IT HOSTS: searchForTry puts the right try into a Tower address (keeping everything else, dropping the older life=, leaving a right or a non-Tower address alone) and what it writes reads back; the page hands the fight the try of its address, puts its address right when it opens another try than the address names, and RETRY FLOOR navigates by REPLACING the lost try\'s page'), wrong.join(' | ') + (back ? '' : ' (does not read back)') + (wired ? '' : ' (battle_boot.js is not wired so)'));
    }
    { // S25: THE TAB'S SAVED BATTLE BELONGS TO THE FIGHT, NOT TO AN ADDRESS. Two entries of one tab's history can both be pages of the fight's try (the page that opened the try from the hub, a page that was
      // reloaded into it), and their addresses are not spelled alike; kept under the address, the saved battle was found by one of them only, and the other counted the fight as left.
      const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } }; };
      const mkCtl = (sp) => { const c = matchctl.createMatchController({ pack: PACK, ruleset: sp.ruleset, teams: sp.teams, seed: sp.seed, pick: sp.pick, lead: sp.lead, freeSwitch: true, names: sp.names, sides: sp.sides, validate: sp.validate }); c.start(); return c; };
      const per = SS.memoryPersist(loseT(startT()).tower), st = mem(), keyOf = RS.resumeKeyOfTag;                                    // one tab; the run is on try 1
      // the page that opened try 1: it fights, and saves its choices the way the battle page does (under the fight's tag, with its attempt)
      const f = await openS(per, { nonce: () => 81, openedTry: 1 }), c = mkCtl(f.spec);
      RS.createResumeStore({ storage: st, key: keyOf(f.tag), seed: f.spec.seed, tag: f.tag, attempt: f.attempt }).attach(c); c.onLocalChoice(() => f.committed());
      c.submit(0, { kind: 'preview', order: [0, 1, 2] }); await ticks();
      // ANOTHER entry of the tab's history that is a page of try 1 too, reached by the browser's Back: it resumes the fight from the same saved battle
      const g = await openS(per, { navType: 'back_forward', openedTry: 1 }), c2 = mkCtl(g.spec);
      const r2 = RS.createResumeStore({ storage: st, key: keyOf(g.tag), seed: g.spec.seed, tag: g.tag, attempt: g.attempt }).restore({ ctl: c2, makeCtl: () => mkCtl(g.spec), navType: 'back_forward' });
      const resumed = g.ok && g.status === 'resume' && g.attempt === 81 && g.tag === f.tag && r2.info.restored === true && r2.info.choices === 1 && String(r2.ctl.battle.hash()) === String(c.battle.hash());
      // (the two addresses such pages have: the hub writes try before p, a page that put its own address right writes it after)
      const addrA = RS.resumeKey('/pokemonarena/battle.html', '?tower=1&floor=1&run=777&try=1&p=p_x'), addrB = RS.resumeKey('/pokemonarena/battle.html', TL.searchForTry('?tower=1&floor=1&run=777&p=p_x', 1));
      const keys = addrA !== addrB && keyOf(f.tag) === 'arena.resume:' + f.tag && /^arena\.resume:tower:777:1:1:[0-9a-f]+$/.test(keyOf(f.tag)) && !keyOf(f.tag).startsWith('arena.resume:/') && addrA.startsWith('arena.resume:/');
      // a saved battle the build before kept under the address is carried over, once; a newer one is never overwritten; nothing throws
      const st3 = mem(); st3.setItem(addrA, st.getItem(keyOf(f.tag)));
      const moved = RS.adoptRecord(st3, keyOf(f.tag), addrA), again = RS.adoptRecord(st3, keyOf(f.tag), addrA);
      const st4 = mem(); st4.setItem(addrA, 'OLD'); st4.setItem(keyOf(f.tag), 'NEW'); const kept = RS.adoptRecord(st4, keyOf(f.tag), addrA);
      const throwing = { getItem() { throw new Error('storage is gone'); }, setItem() {}, removeItem() {} };
      const carried = moved === true && again === false && st3.getItem(addrA) === null && st3.getItem(keyOf(f.tag)) !== null && st3.getItem(keyOf(f.tag)) === st.getItem(keyOf(f.tag))
        && kept === false && st4.getItem(keyOf(f.tag)) === 'NEW' && st4.getItem(addrA) === null && RS.adoptRecord(null, 'a', 'b') === false && RS.adoptRecord(throwing, 'a', 'b') === false && RS.adoptRecord(st4, 'k', 'k') === false;
      // ... and what is carried over is still not believed: with another page's attempt in it, it is refused
      const st5 = mem(); st5.setItem(addrA, JSON.stringify({ ...JSON.parse(st.getItem(keyOf(f.tag))), attempt: 999 })); RS.adoptRecord(st5, keyOf(f.tag), addrA);
      const r5 = RS.createResumeStore({ storage: st5, key: keyOf(g.tag), seed: g.spec.seed, tag: g.tag, attempt: g.attempt }).restore({ ctl: mkCtl(g.spec), makeCtl: () => mkCtl(g.spec), navType: 'reload' });
      const bb = fs.readFileSync(path.join(opt.dir || SRC, 'battle_boot.js'), 'utf8');
      const wired = /const addrKey = resumeKey\(location\.pathname, location\.search\), fightKey = towerFight \? resumeKeyOfTag\(towerFight\.tag\) : addrKey;/.test(bb) && /if \(towerFight\) adoptRecord\(store, fightKey, addrKey\);/.test(bb) && /createResumeStore\(\{ storage: store, key: fightKey,/.test(bb);
      ok(resumed && keys && carried && r5.info.restored === false && /another page/.test(r5.info.reason) && wired, t('S25 THE TAB\'S SAVED BATTLE BELONGS TO THE FIGHT, NOT TO AN ADDRESS: a Tower floor\'s is kept under the fight\'s tag, so another entry of the tab\'s history that is a page of the same try (whose address is spelled another way) resumes the fight from it at the same battle state; a regular battle keeps its address; a saved battle the build before kept under the address is carried over once, never over a newer one, and is still checked (another page\'s attempt in it: refused); the battle page is wired so'), J([resumed, keys, carried, r5.info, wired]));
    }
  }

  /* O. THE BUILD BEFORE RETRIES, next to a record that has them (a page that still holds the old code for one cache lifetime, or a tab left open across the deploy). The old build is the real one: its five
        Tower modules as they stood at d4466048 (tools/fixtures/pokemonarena/tower-build-before-retries), loaded beside the current profile, store and engine. */
  if (grp('O')) {
    const FXD = path.join(root, 'tools', 'fixtures', 'pokemonarena', 'tower-build-before-retries'), from = opt.dir || SRC;
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-tower-old-'));
    try {
      for (const f of fs.readdirSync(from)) { const p = path.join(from, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(oldDir, f)); }
      const fixed = fs.readdirSync(FXD).filter((f) => f.endsWith('.js')); for (const f of fixed) fs.copyFileSync(path.join(FXD, f), path.join(oldDir, f));
      const [OR, OT, OS, OF, OP, OST] = await Promise.all(['tower_record.js', 'tower.js', 'tower_session.js', 'tower_fight.js', 'profile.js', 'store.js'].map((f) => imp(oldDir, f)));
      const P = await imp(from, 'profile.js');
      ok(J(fixed.sort()) === J(['achievements.js', 'tower.js', 'tower_fight.js', 'tower_record.js', 'tower_session.js']) && !('retriesOf' in OR) && !OR.RUN_KEYS.includes('retries') && typeof OT.retryInfo === 'undefined', t('O0 (fixture) the old build is the five Tower modules as they stood before retries: it knows no retry'), fixed.join());
      // (1) a climb that has not used a retry is, byte for byte, what the old build wrote: it reads it and plays it by its own rule
      const clean = (() => { let tw = skipT(winT(startT()).tower); tw = SS.reduceGiveUp(tw, { seed: 777, now: 5 }).tower; tw = SS.reduceStart(tw, startArgs({ seed: 778 })).tower; return skipT(winT(tw).tower); })();          // one finished run (given up after floor 1) and a run under way on floor 2: no retry anywhere
      const oldLoss = clean ? OS.reduceFinishFloor(clean, { floor: 2, seed: 778, result: LOSS(2), pack: PACK, now: 9 }) : null;
      ok(!!clean && clean.last && clean.runs === 1 && OR.checkTowerShape(clean).length === 0 && J(OT.checkTower(clean)) === '[]' && OT.parseRun(clean.current, { pack: PACK }).ok && OS.summarizeTower(clean, PACK).run.broken !== true && J(Object.keys(clean)) === J(OR.TOWER_KEYS) && J(Object.keys(clean.last)) === J(OR.LAST_KEYS) && J(Object.keys(clean.current)) === J(OR.RUN_KEYS) && oldLoss.applied && oldLoss.finished, t('O1 A CLIMB WITH NO RETRY YET IS EXACTLY WHAT THE OLD BUILD WROTE: a record this build made (a finished run, a run under way) with no retry in it has the old keys and nothing else; the old build checks it, parses it, shows it, and plays it by its own rule (there, a loss ends the run)'), J(OR.checkTowerShape(clean || {})));
      // (2) a record with retries everywhere
      const rec = (() => { let tw = climb(mkT(), 41, (f) => (f === 3 ? 2 : 0)); tw = climb(tw, 42, (f) => (f === 2 ? 4 : 0)); tw = SS.reduceStart(tw, startArgs({ seed: 43, now: 9 })).tower; return loseT(skipT(winT(loseT(tw).tower).tower)).tower; })();          // won with 2 retries; lost on floor 2 with 3; a run under way on floor 2 with 2 retries (1 on this floor)
      const shape = OR.checkTowerShape(rec), repO = OR.normalizeTower(clone(rec), () => {}, true), v = repO.value;
      ok(rec.retries === 5 && rec.last.retries === 3 && T.retriesOf(rec.current) === 2 && shape.includes('unknown field retries') && shape.includes('unknown field fewestRetries') && OR.checkTowerShape(v).length === 0 && J(v.current) === J(rec.current) && v.runs === rec.runs && v.wins === rec.wins && v.floors === rec.floors && v.bosses === rec.bosses && J(v.best) === J(rec.best) && J(v.achievements) === J(rec.achievements) && J(v.buffsSeen) === J(rec.buffsSeen) && v._unknown.retries === 5 && J(v._unknown.fewestRetries) === J(rec.fewestRetries) && v.last === null && J(repO.rejected.last) === J(rec.last) && !('current' in repO.rejected), t('O2 A RECORD WITH RETRIES IN THE OLD BUILD: its strict check does not know the new keys, and its repair (run on every load) moves `retries` and `fewestRetries` whole into the record\'s bag and sets the LAST RUN summary aside; EVERYTHING ELSE IS KEPT, and THE CLIMB UNDER WAY STAYS WHERE IT IS (a run stores no retry key, so the old shallow check still accepts it)'), J(shape));
      // (3) the Tower is not locked: the old build cannot READ a run that has retry rows, so it offers to drop it and refuses to fight it; nothing is written unless the player says so
      const sumO = OS.summarizeTower(v, PACK), begin = OS.reduceBeginFloor(v, { pack: PACK, floor: 2, seed: 43, navType: 'navigate', now: 9 }), fightO = await OF.createTowerFight({ pack: PACK, persist: OS.memoryPersist(v), floor: 2, runId: 43, navType: 'navigate', nav: {}, now: () => 9 });
      const drop = OS.reduceGiveUp(v, { seed: 43, now: 9 }), over = OS.reduceStart(v, startArgs({ seed: 99, replace: true, now: 9 }));
      let climbed = ''; try { const perO = OS.memoryPersist(over.tower), so = OS.createTowerSession({ pack: PACK, persist: perO, now: () => 9 }); const a = await so.finishFloor({ floor: 1, seed: 99, result: WIN(1) }), b = await so.pick({ seed: 99, id: null, floor: 2, offer: OS.offerKey(perO.peek().current) }), c = await so.finishFloor({ floor: 2, seed: 99, result: LOSS(2) }); if (!(a.applied && b.applied && c.applied && perO.peek().current === null && perO.peek().runs === rec.runs + 1 && OR.checkTowerShape(perO.peek()).length === 0)) climbed = 'the old build could not climb: ' + J([a.applied, b.applied, c.applied]); } catch (e) { climbed = 'threw ' + e.message; }
      ok(sumO.run && sumO.run.broken === true && begin.status === 'stale' && !begin.applied && fightO.ok === false && fightO.status === 'stale' && drop.applied && drop.dropped === true && drop.tower.current === null && drop.tower.runs === rec.runs && over.applied && over.tower.current.seed === 99 && !climbed, t('O3 THE OLD BUILD IS NOT LOCKED: it shows the climb with retries as a run it cannot read (DROP THIS RUN is offered, never forced), its battle page refuses to open the floor and writes nothing, and a NEW RUN over it, a win, a ball and a loss are all recorded'), climbed || J([sumO.run, begin.status]));
      // (4) through the real store: the old build loads the profile (and writes its repair back); when this build opens it again NOTHING IS LOST
      const prof = { ...P.createProfile({ trainerName: 'ASH' }, { now: () => 1700000000000, randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 5) & 255) }), tower: clone(rec) };
      const adapter = OST.createMemoryAdapter({ name: 'old-build-' + (tag || 'real'), durable: true }), storeO = await OST.openStore({ adapter, channel: false });
      await adapter.transact(['profiles'], 'readwrite', (tx) => tx.put('profiles', { ...clone(prof), rev: 1 }));
      const lo = await storeO.loadProfile(prof.id), stored = await adapter.transact(['profiles'], 'readonly', (tx) => tx.get('profiles', prof.id));
      const reopened = P.openProfileDocument(clone(stored), {});
      ok(lo.ok && J(lo.profile.tower.current) === J(rec.current) && stored.rev > 1 && stored.tower._unknown.retries === 5 && stored.tower.last === null && reopened.ok && canon(reopened.profile.tower) === canon(rec) && P.checkProfile(reopened.profile).length === 0 && !P.openProfileDocument(clone(reopened.profile), {}).changed, t('O4 A VISIT OF THE OLD BUILD LOSES NOTHING: it loads the profile, repairs the Tower record its own way and writes that back (the retry keys in the bag, the last run set aside, the climb untouched); when this build opens the profile again the record is, value for value, the one it wrote: the retries, the fewest, the last run and the climb'), J(Object.keys(stored.tower._unknown || {})));
      // (5) the control: WHY a run stores no retry number. A run with one more top-level key is not a run to the old build, and its repair takes the climb out of `current` on every load
      const keyed = clone(rec); keyed.current.retries = 2;
      const repK = OR.normalizeTower(keyed, () => {}, true);
      ok(repK.value.current === null && repK.rejected.current && repK.rejected.current.retries === 2 && !REC.isRunShape(keyed.current), t('O5 (control) why the count lives in the history rows and not in a key of the run: the old build, shown a run with one unknown key, takes THE WHOLE CLIMB out of `current` and parks it (on every load, written back); this build refuses such a run too, so no build ever writes one'), J(Object.keys(repK.rejected)));
    } finally { fs.rmSync(oldDir, { recursive: true, force: true }); }
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
  { id: 'setup-drops-lead', why: 'a 6v6 Tower fight skips the lead choice that every other 6v6 battle has', file: 'tower.js', from: "lead: !!FORMATS[run.format].lead, validate: false,", to: "validate: false,", groups: ['F'] },
  { id: 'result-guard-removed', why: 'a result for any floor or phase is applied', file: 'tower.js', from: "if (run.phase !== 'battle' || res.floor !== run.floor) return {", to: 'if (false) return {', groups: ['F'] },
  { id: 'loss-keeps-going', why: 'a lost floor does not end the run', file: 'tower.js', from: "else { r.phase = 'over'; events.push({ type: 'run-over', floor: run.floor }); }", to: "else { events.push({ type: 'run-over', floor: run.floor }); }", groups: ['F'] },
  { id: 'life-not-spent', why: 'an extra life is never used up', file: 'tower.js', from: 'r.livesUsed += 1;', to: 'r.livesUsed += 0;', groups: ['F'] },
  { id: 'last-floor-off-by-one', why: 'clearing the top floor does not win', file: 'tower.js', from: 'if (run.floor >= cfg.floors) { r.phase = \'won\';', to: 'if (run.floor > cfg.floors) { r.phase = \'won\';', groups: ['F'] },
  { id: 'validate-flag', why: 'tower battles are built with the regular validation (and so refuse any buffed team)', file: 'tower.js', from: 'validate: false, seed: tryNumber(run) ? mix(', to: 'validate: true, seed: tryNumber(run) ? mix(', groups: ['F'] },
  // the stored form
  { id: 'parse-forged-held', why: 'a stored run\'s buffs are not checked against its picks', file: 'tower.js', from: "if (JSON.stringify(rebuilt) !== JSON.stringify(r.held)) return bad('held buffs do not match the picks');", to: '', groups: ['F'] },
  { id: 'parse-unknown-field', why: 'a stored run may carry extra fields', file: 'tower.js', from: "for (const k of Object.keys(r)) if (!RUN_KEYS.includes(k)) return bad('unknown field ' + k);", to: '', groups: ['F'] },
  { id: 'parse-offer-not-rederived', why: 'a stored offer is believed, not re-derived from the seed', file: 'tower.js', from: "if (pack && JSON.stringify(offerFor(r, { pack, cfg })) !== JSON.stringify(r.offer)) return bad('the offer is not the one this seed gives');", to: '', groups: ['F'] },
  { id: 'fold-twice', why: 'a run can be folded into the record more than once', file: 'tower.js', from: "if ((run.phase !== 'over' && run.phase !== 'won') || run.folded) return { tower, run };", to: "if (run.phase !== 'over' && run.phase !== 'won') return { tower, run };", groups: ['F'] },
  // achievements
  { id: 'streak-never-resets', why: 'a flawless streak survives a floor that was not flawless', file: 'achievements.js', from: 'streak = clean(h) ? streak + 1 : 0;', to: 'streak = streak + 1;', groups: ['G'] },
  { id: 'no-buff-off-by-one', why: 'the pick after the target floor counts against "no buff"', file: 'achievements.js', from: 'wins.slice(0, n - 1).every(', to: 'wins.slice(0, n).every(', groups: ['G'] },
  { id: 'evaluate-repeats', why: 'an achievement already held is earned again', file: 'achievements.js', from: 'A.filter((a) => !(a.id in have) && a.test(facts))', to: 'A.filter((a) => a.test(facts))', groups: ['G'] },
  { id: 'unlock-restamps', why: 'a second unlock overwrites the first stamp', file: 'achievements.js', from: 'if (ACHIEVEMENT_BY_ID[id] && !(id in t.achievements)) t.achievements[id] = sanitiseStamp(at);', to: 'if (ACHIEVEMENT_BY_ID[id]) t.achievements[id] = sanitiseStamp(at);', groups: ['G'] },
  // the offer screen, the regular game, the import graph
  { id: 'view-no-stacking', why: 'the info box never says what a ball stacks into', file: 'tower.js', from: 'stacksInto: p0 ? {', to: 'stacksInto: false ? {', groups: ['H'] },
  { id: 'ball-sprite-shared', why: 'gold and purple use the same ball sprite', file: 'tower_config.js', from: "color: '#ffca28', ball: 13", to: "color: '#ffca28', ball: 4", groups: ['H'] },
  { id: 'tower-record-has-career-fields', why: 'the Tower\'s record grows a per-CPU career table', file: 'tower_record.js', from: 'export const emptyTower = () => ({ v: TOWER_VERSION,', to: 'export const emptyTower = () => ({ byCpu: {}, v: TOWER_VERSION,', groups: ['H', 'F'] },
  { id: 'view-no-progress', why: 'the info box never shows synergy progress', file: 'tower.js', from: 'synergyProgress: progress.slice(0, 4),', to: 'synergyProgress: [],', groups: ['H'] },
  { id: 'skip-not-gated', why: 'a skip is accepted where the config forbids it', file: 'tower.js', from: "if (!cfg.offer.allowSkip) return { run, applied: false, events: [], why: 'skipping is not allowed' };", to: '', groups: ['E'] },
  // ---- phase 2: the stored record
  { id: 'rec-accepts-unknown-fields', why: 'the Tower record may carry fields it does not know', file: 'tower_record.js', from: "if (!TOWER_KEYS.includes(k) && !TOWER_KEYS_OPTIONAL.includes(k) && k !== '_unknown') bad.push('unknown field ' + k);", to: '', groups: ['J'] },
  { id: 'rec-wins-not-summed', why: 'wins may disagree with the formats', file: 'tower_record.js', from: "else if (cfg.formats.reduce((n, f) => n + t.winsByFormat[f], 0) !== t.wins) bad.push('wins != winsByFormat');", to: '', groups: ['J'] },
  { id: 'rec-run-size-uncapped', why: 'a stored run of any size is accepted', file: 'tower_record.js', from: 'return JSON.stringify(r).length <= TOWER_LIMITS.runJsonMax;', to: 'return true;', groups: ['J'] },
  { id: 'rec-repair-loses-unknown', why: 'repairing drops the unknown fields of the record', file: 'tower_record.js', from: 'if (b2 && Object.keys(b2).length) out._unknown = b2;', to: '', groups: ['J'] },
  { id: 'rec-repair-loses-rejected', why: 'a field that cannot be repaired is thrown away instead of kept', file: 'tower_record.js', from: "const rep = (field, raw, why) => { setOwn(rejected, field, raw);", to: "const rep = (field, raw, why) => { ", groups: ['J'] },
  { id: 'rec-repair-lowers-runs', why: 'counters are made to agree by lowering the player\'s runs', file: 'tower_record.js', from: "if (out.runs < out.wins) { P('repaired', 'profile.tower', 'tower.runs', 'tower.runs was below tower.wins; raised'); out.runs = out.wins; }", to: '', groups: ['J'] },
  // ---- phase 2: the session
  { id: 'session-mark-any-floor', why: 'the first-choice mark is applied to a floor the run is not waiting for', file: 'tower_session.js', from: "if (cur.phase !== 'battle' || cur.floor !== floor) return refuse('the run is not waiting for that fight');\n  if (!isAttempt(attempt))", to: 'if (!isAttempt(attempt))', groups: ['K'] },
  { id: 'session-reload-is-a-loss', why: 'a reload of a fight under way counts as leaving it', file: 'tower_session.js', from: "    if (byHistory) return { applied: false, status: 'resume', run: cur };\n", to: '', groups: ['K'] },
  { id: 'session-leaving-is-free', why: 'arriving at a marked fight afresh does not count the earlier one as a loss', file: 'tower_session.js', from: "const lost = reduceFinishFloor(tower, { floor, seed, result: { floor, result: 'l', turns: 0, faints: 0 }, pack, now, cfg, attempt: cur.attempt >>> 0, tries: tryNumber(cur) });          // (on behalf of the fight that was left)\n    return { ...lost, status: 'abandoned' };", to: "return { applied: false, status: 'resume', run: cur };", groups: ['K', 'L', 'S'] },
  { id: 'session-run-not-folded', why: 'a finished run stays in current and is never counted', file: 'tower_session.js', from: "if (r.run.phase === 'over' || r.run.phase === 'won') {", to: 'if (false) {', groups: ['K'] },
  { id: 'session-achievements-unlisted', why: 'what a step earns is not listed in the run', file: 'tower_session.js', from: 'r.earned = r.earned.concat(ev.unlocked.filter((id) => !r.earned.includes(id)));', to: '', groups: ['K'] },
  { id: 'session-giveup-uncounted', why: 'giving a run up leaves no trace in the record', file: 'tower_session.js', from: 'const c = conclude(tower, abandonRun(cur), now, cfg);\n  return { tower: c.tower, applied: true, run: c.run, events: [{ type: \'run-over\', floor: cur.floor, gaveUp: true }]', to: 'const c = { tower: { ...clone(tower), current: null }, run: abandonRun(cur), newIds: [] };\n  return { tower: c.tower, applied: true, run: c.run, events: [{ type: \'run-over\', floor: cur.floor, gaveUp: true }]', groups: ['K'] },
  { id: 'session-start-over-a-run', why: 'a run may be started while another is under way', file: 'tower_session.js', from: "if (!replace) return refuse('a run is under way');", to: '', groups: ['K'] },
  { id: 'session-replace-uncounted', why: 'the run that is replaced is not counted', file: 'tower_session.js', from: 'countable(tower.current, cfg) ? conclude(tower, abandonRun(tower.current), now, cfg).tower :', to: 'false ? 0 :', groups: ['K'] },
  { id: 'session-random-team-same', why: 'every seed gets the same random team', file: 'tower_session.js', from: 'randomTeam(pack, mix(seed, 0x7ea1), 6, cfg.ruleset)', to: 'randomTeam(pack, mix(1, 0x7ea1), 6, cfg.ruleset)', groups: ['K'] },
  { id: 'tag-ignores-buffs', why: 'a saved battle would resume with another set of buffs', file: 'tower_session.js', from: 'fnv(JSON.stringify(run.held)).toString(16)', to: "fnv('').toString(16)", groups: ['K'] },
  { id: 'tag-ignores-lives', why: 'a saved battle would resume on another try of the floor', file: 'tower_session.js', from: "':' + tryNumber(run) + ':'", to: "':0:'", groups: ['K', 'R'] },
  { id: 'spec-validates', why: 'a Tower battle is built with the regular validation (and so refuses any buffed team)', file: 'tower_session.js', from: "trainer: s.names[1], validate: false,", to: "trainer: s.names[1], validate: true,", groups: ['K'] },
  { id: 'summary-throws-on-broken', why: 'a run that cannot be read crashes the screens', file: 'tower_session.js', from: 'if (!parsed.ok) run = { broken: true, why: parsed.why };', to: "if (!parsed.ok) throw new Error('broken run');", groups: ['K'] },
  { id: 'summary-no-offer', why: 'the offer screen gets no balls', file: 'tower_session.js', from: "offer: r.phase === 'offer' ? { ...offerView(r, { pack, cfg }), key: offerKey(r) } : null,", to: 'offer: null,', groups: ['K'] },
  { id: 'fight-flag-kept', why: 'the fight mark survives the result', file: 'tower.js', from: "const r = clone(run), boss = isBoss(run.floor, cfg), won = res.result === 'w';\n  r.fighting = false;", to: "const r = clone(run), boss = isBoss(run.floor, cfg), won = res.result === 'w';", groups: ['K'] },
  { id: 'fold-no-last', why: 'a finished run leaves no summary', file: 'tower.js', from: 't.last = lastOf(folded, at);', to: '', groups: ['K'] },
  { id: 'parse-fight-outside-battle', why: 'a stored run may be marked as fighting while it is not', file: 'tower.js', from: "if (r.fighting && r.phase !== 'battle') return bad('a fight is marked outside the battle phase');", to: '', groups: ['F'] },
  // ---- phase 2: the fight controller
  { id: 'fight-applied-twice', why: 'the finished battle is applied to the run every time it is announced', file: 'tower_fight.js', from: 'if (st.promise) return st.promise;\n      st.ended = true;', to: 'st.ended = true;', groups: ['L'] },
  { id: 'fight-quit-is-a-win', why: 'leaving in the middle of the fight is recorded as a win', file: 'tower_fight.js', from: "f.finish({ floor: spec.tower.floor, result: 'f', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, (e) =>", to: "f.finish({ floor: spec.tower.floor, result: 'w', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, (e) =>", groups: ['L'] },
  { id: 'page-bfcache-keeps-start-locked', why: 'a hub page restored from the back / forward cache keeps its start guard locked (START is silently ignored)', file: 'boot.js', from: "if (e.persisted) { startGuard.reset(); refreshData(); }", to: "if (e.persisted) { refreshData(); }", groups: ['Q'] },
  { id: 'fight-unrestorable-is-a-win', why: 'a fight that cannot be resumed is recorded as a win', file: 'tower_fight.js', from: "f.finish({ floor: spec.tower.floor, result: 'f', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, () =>", to: "f.finish({ floor: spec.tower.floor, result: 'w', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, () =>", groups: ['Q'] },
  { id: 'fight-never-marked', why: 'the first choice never marks the fight (leaving it is free)', file: 'tower_fight.js', from: 'f.markFight().then((r) => {', to: 'Promise.resolve().then((r) => {', groups: ['L'] },
  { id: 'fight-win-button', why: 'a win offers the wrong button', file: 'tower_fight.js', from: "return [spec.tower.floor >= cfg.floors ? 'TO THE TOWER' : 'PICK A BUFF', 'BACK TO HUB'];", to: "return ['BACK TO HUB', 'TO THE TOWER'];", groups: ['L'] },
  { id: 'fight-retry-goes-to-tower', why: 'RETRY FLOOR does not retry', file: 'tower_fight.js', from: "f.stillWaiting(a.run).then((yes) => yes, () => false).then((yes) => { if (yes) nav.retry(a.run); else nav.toTower(null); });", to: "nav.toTower(a.next.step);", groups: ['L'] },
  { id: 'fight-step-not-passed', why: 'the result button forgets what the run is waiting for', file: 'tower_fight.js', from: 'nav.toTower(a && a.applied ? a.next.step : null);\n      });', to: 'nav.toTower(null);\n      });', groups: ['L'] },
  // ---- phase 2: the address and the seam
  { id: 'launch-floor-zero', why: 'floor 0 is an address', file: 'tower_launch.js', from: "const floor = num('floor', 1, cfg.floors, true);", to: "const floor = num('floor', 0, cfg.floors, true);", groups: ['M'] },
  { id: 'launch-hex-numbers', why: 'a number may be written in hex', file: 'tower_launch.js', from: "if (!/^\\d{1,10}$/.test(s)) return null;", to: "if (!/^\\w{1,10}$/.test(s) || !Number.isFinite(Number(s))) return null;", groups: ['M'] },
  { id: 'launch-life-forgotten', why: 'a retry has the address of the first try', file: 'tower_launch.js', from: "if (tries) q.push('try=' + tries);", to: '', groups: ['M'] },
  { id: 'launch-tower-2', why: 'tower=2 is a Tower address', file: 'tower_launch.js', from: "if (q.get('tower') !== '1') return bad('tower', 'The tower parameter must be 1.');", to: '', groups: ['M'] },
  { id: 'launch-offer-step', why: 'a won floor does not open the offer', file: 'tower_launch.js', from: "const url = step === 'offer' ? HUB_PAGE_URL + '#tower-offer' :", to: "const url = step === 'offer' ? TOWER_HUB_URL :", groups: ['M'] },
  { id: 'launch-no-navigate', why: 'launching a floor does not go anywhere', file: 'tower_launch.js', from: "if (typeof navigate !== 'function') throw new TypeError('launchFloorBattle needs navigate(url)');\n  navigate(url);", to: "if (typeof navigate !== 'function') throw new TypeError('launchFloorBattle needs navigate(url)');", groups: ['M'] },
  { id: 'launch-reads-location', why: 'the launch module reads the page address', file: 'tower_launch.js', from: "export const HUB_PAGE_URL = '/pokemonarena/';", to: "export const HUB_PAGE_URL = '/pokemonarena/';\nconst __here = typeof location !== 'undefined' ? location.href : '';", groups: ['M'] },
  { id: 'hub-names-a-page', why: 'a hub module reads window.location', file: 'tower_hub.js', from: "export const TOWER_RULESET = 'arena-gen3-standard';", to: "export const TOWER_RULESET = 'arena-gen3-standard';\nconst __page = typeof window !== 'undefined' ? window.location : null;", groups: ['M', 'H'] },
  { id: 'fight-names-a-page', why: 'the fight controller names the battle page', file: 'tower_fight.js', from: 'const WAIT_MS = 1500;', to: "const WAIT_MS = 1500;\nconst __url = '/pokemonarena/battle.html';", groups: ['M'] },
  // ---- phase 2: what reaches a battle
  { id: 'resolve-leaks-buffs', why: 'a regular battle\'s resolver applies a buff when it is handed a Tower run', file: 'battle_boot.js', from: "  if (pick && (mineTeam.recs.length < pick || foeTeam.recs.length < pick))", to: "  if (deps.towerRun && deps.towerRun.held && deps.towerRun.held.length) mineTeam = { ...mineTeam, recs: mineTeam.recs.map((r) => ({ ...r, evs: { ...r.evs, hp: 255 } })) };\n  if (pick && (mineTeam.recs.length < pick || foeTeam.recs.length < pick))", groups: ['N'] },
  { id: 'resolve-turns-validation-off', why: 'a regular spec turns the validation off', file: 'battle_boot.js', from: "trainer: CPU_NAMES[params.cpu],\n    },", to: "trainer: CPU_NAMES[params.cpu], validate: false,\n    },", groups: ['N'] },
  { id: 'page-drops-validate', why: 'the page forgets to hand the spec\'s validate flag to the match builder', file: 'battle_boot.js', from: "sides: spec.sides, validate: spec.validate });", to: "sides: spec.sides });", groups: ['N'] },
  { id: 'page-drops-resume-tag', why: 'the page forgets the Tower fight\'s tag in the resume store', file: 'battle_boot.js', from: ", tag: towerFight ? towerFight.tag : undefined, attempt:", to: ", attempt:", groups: ['N'] },
  { id: 'query-allows-tower-plus-team', why: 'a Tower address may also name a team, a seed, a format or a CPU', file: 'battle_boot.js', from: "if (tw.tower && (team !== null || foe !== null || seedS !== null || format !== null || cpu !== null || ['np', 'host', 'join', 'online'].some((k) => q.has(k)))) return bad(", to: "if (false) return bad(", groups: ['M'] },
  { id: 'resume-ignores-tag', why: 'a saved battle resumes whatever its tag', file: 'battle_resume.js', from: 'rec.seed === seed && rec.tag === tag', to: 'rec.seed === seed', groups: ['N'] },
  { id: 'resume-writes-no-tag', why: 'a Tower fight\'s saved battle carries no tag', file: 'battle_resume.js', from: '...(tag === undefined ? {} : { tag }),', to: '', groups: ['N'] },
  { id: 'online-imports-the-tower', why: 'the match builder (used by online play) imports a Tower module', file: 'matchctl.js', from: "import { createBattle, encodeChoice, decodeChoice } from './engine.js';", to: "import './tower_config.js';\nimport { createBattle, encodeChoice, decodeChoice } from './engine.js';", groups: ['H'] },
  { id: 'hub-data-imports-the-session', why: 'the hub data reader pulls the whole Tower (and the engine) into the hub', file: 'hub_data.js', from: "import { teamMons, validateMonList } from './profile.js';", to: "import { summarizeTower as __s } from './tower_session.js';\nimport { teamMons, validateMonList } from './profile.js';", groups: ['H'] },
  { id: 'tower-reads-the-clock', why: 'the Tower reads the wall clock', file: 'tower.js', from: 'export const RUN_VERSION = 1;', to: 'export const RUN_VERSION = 1;\nconst __startedAt = Date.now();', groups: ['H'] },
  { id: 'tower-imports-career', why: 'a Tower module imports the career code', file: 'tower.js', from: "import { createRng } from './ai.js';", to: "import { createRng } from './ai.js';\nimport './career_stats.js';", groups: ['H'] },
  { id: 'regular-game-imports-tower', why: 'the regular match builder imports the Tower', file: 'matchctl.js', from: "import { createAi, createRng } from './ai.js';", to: "import { createAi, createRng } from './ai.js';\nimport { floorSpec as __floorSpec } from './tower.js';", groups: ['H'] },
  // ---- the release hardening (group Q): the stored record can never lock the Tower
  { id: "keep-buffs-at-the-check-limit", why: "the repair keeps as many buff ids as the check allows (no room for the next real one)", file: "tower_record.js", from: "kept < TOWER_LIMITS.buffsKeep", to: "kept < TOWER_LIMITS.buffsMax", groups: ["Q"] },
  { id: "keep-achievements-at-the-check-limit", why: "the repair keeps as many achievements as the check allows", file: "tower_record.js", from: "kept < TOWER_LIMITS.achievementsKeep", to: "kept < TOWER_LIMITS.achievementsMax", groups: ["Q"] },
  { id: "keep-counters-at-the-check-limit", why: "the repair keeps a counter at the limit of the check", file: "tower_record.js", from: "if (isInt(src[k], 0, TOWER_LIMITS.counterKeep)) out[k] = src[k];", to: "if (isInt(src[k], 0, TOWER_LIMITS.counterMax)) out[k] = src[k];", groups: ["Q"] },
  { id: "keep-buff-counts-at-the-check-limit", why: "a buff count at the limit of the check is kept", file: "tower_record.js", from: "isInt(src.buffsSeen[id], 1, TOWER_LIMITS.counterKeep)", to: "isInt(src.buffsSeen[id], 1, TOWER_LIMITS.counterMax)", groups: ["Q"] },
  { id: "keep-format-wins-at-the-check-limit", why: "the wins of the two formats may add up past the limit", file: "tower_record.js", from: "perFormat('winsByFormat', Math.floor(TOWER_LIMITS.counterKeep / cfg.formats.length));", to: "perFormat('winsByFormat', TOWER_LIMITS.counterMax);", groups: ["Q"] },
  { id: "bag-uncapped", why: "the unknown bag of the Tower record has no size limit", file: "tower_record.js", from: "if (b2) b2 = capBag(b2);", to: "", groups: ["Q"] },
  { id: "capbag-never-caps", why: "capBag returns any bag whole", file: "tower_record.js", from: "if (total <= max) return bag;", to: "return bag;", groups: ["Q"] },
  { id: "shape-allows-null-rows", why: "a stored run may hold null rows in its history, held list or team", file: "tower_record.js", from: "if (!r.team.recs.every(isObj) || !r.held.every(isObj) || !r.history.every(isObj)) return false;", to: "", groups: ["Q"] },
  { id: "stamp-unsanitised", why: "an achievement stamp is stored as the clock gave it", file: "achievements.js", from: "t.achievements[id] = sanitiseStamp(at);", to: "t.achievements[id] = at;", groups: ["Q"] },
  { id: "last-stamp-unsanitised", why: "the last run's stamp is stored as the clock gave it", file: "tower.js", from: "at: sanitiseStamp(at), ...(retries > 0", to: "at, ...(retries > 0", groups: ["Q"] },
  { id: "sanitise-lets-fractions-through", why: "a fractional stamp is a stamp", file: "tower_record.js", from: "export const sanitiseStamp = (at) => (Number.isInteger(at) && at >= 0", to: "export const sanitiseStamp = (at) => (Number.isFinite(at) && at >= 0", groups: ["Q"] },
  // ---- unreadable runs are dropped, runs that cleared nothing are not runs
  { id: "giveup-folds-unreadable-runs", why: "DROP THIS RUN folds a run that cannot be read (and throws)", file: "tower_session.js", from: "if (!countable(cur, cfg)) return dropped(tower, cur);", to: "if (false) return dropped(tower, cur);", groups: ["Q"] },
  { id: "replace-folds-unreadable-runs", why: "NEW RUN over a run that cannot be read folds it (and throws)", file: "tower_session.js", from: "t = countable(tower.current, cfg) ? conclude(", to: "t = true ? conclude(", groups: ["Q"] },
  { id: "countable-counts-empty-runs", why: "a run that cleared no floor counts as a run", file: "tower_session.js", from: "return p.ok && p.run.history.some((h) => h.result === 'w'); };", to: "return p.ok; };", groups: ["Q"] },
  { id: "countable-counts-unreadable-runs", why: "a run that cannot be parsed counts as a run", file: "tower_session.js", from: "return p.ok && p.run.history.some((h) => h.result === 'w'); };", to: "return !p.ok || p.run.history.some((h) => h.result === 'w'); };", groups: ["Q"] },
  { id: "begin-floor-opens-unreadable-runs", why: "a fight opens on a run that cannot be read", file: "tower_session.js", from: "  if (!parseRun(cur, { pack: null, cfg }).ok) return { applied: false, status: 'stale', why: 'the run cannot be read' };", to: "", groups: ["Q"] },
  // ---- the identity of a fight and of an offer
  { id: "mark-any-page", why: "a second page may mark (and own) a fight that is already marked", file: "tower_session.js", from: "if (cur.fighting) return (cur.attempt >>> 0) === (attempt >>> 0) ? { applied: false, why: 'already marked', run: cur } : refuse(", to: "if (cur.fighting) return true ? { applied: false, why: 'already marked', run: cur } : refuse(", groups: ["Q"] },
  { id: "mark-needs-no-number", why: "a fight is marked without an attempt number", file: "tower_session.js", from: "  if (!isAttempt(attempt)) return refuse('a fight needs an attempt number');\n", to: "", groups: ["Q"] },
  { id: "mark-ignores-the-try", why: "a mark for another try of the floor is accepted", file: "tower_session.js", from: "  if (tries !== undefined && tries !== tryNumber(cur)) return refuse('that try of the floor is over');\n  if (cur.fighting) return", to: "  if (cur.fighting) return", groups: ["Q", "S"] },
  { id: "finish-from-any-page", why: "a page that did not mark the fight can finish it", file: "tower_session.js", from: "if (cur.fighting && (cur.attempt >>> 0) !== (attempt >>> 0)) return refuse(", to: "if (false) return refuse(", groups: ["Q"] },
  { id: "finish-ignores-the-try", why: "the session does not check which try a result is for (the run machine below it still refuses it, with other words)", file: "tower_session.js", from: "  if (tries !== undefined && tries !== tryNumber(cur)) return refuse('that try of the floor is over');          // a late", to: "  // a late", groups: ["Q"] },
  { id: "abandon-forgets-the-owner", why: "the fight that was left is not finished on behalf of its own attempt", file: "tower_session.js", from: "attempt: cur.attempt >>> 0, tries: tryNumber(cur) });          // (on behalf", to: "tries: tryNumber(cur) });          // (on behalf", groups: ["Q"] },
  { id: "pick-answers-any-offer", why: "a pick is applied to whatever offer is open", file: "tower_session.js", from: "  if (floor !== cur.floor || offer !== offerKey(cur)) return refuse('that offer is gone', { stale: true });", to: "", groups: ["Q"] },
  { id: "pick-ignores-the-floor", why: "a pick is checked against the offer key but not the floor", file: "tower_session.js", from: "if (floor !== cur.floor || offer !== offerKey(cur))", to: "if (offer !== offerKey(cur))", groups: ["Q"] },
  { id: "offer-key-ignores-the-balls", why: "the offer key does not depend on the balls", file: "tower_session.js", from: "fnv(JSON.stringify(run.offer || [])).toString(16)", to: "fnv('').toString(16)", groups: ["Q"] },
  { id: "attempt-kept-after-the-result", why: "the mark of a fight survives its result", file: "tower.js", from: "r.fighting = false; r.attempt = 0;\n  r.history.push(", to: "r.fighting = false;\n  r.history.push(", groups: ["Q"] },
  { id: "parse-attempt-without-fight", why: "a stored run may carry an attempt number with no fight", file: "tower.js", from: "  if (!r.fighting && (r.attempt >>> 0) !== 0) return bad('an attempt is marked without a fight');", to: "", groups: ["Q"] },
  { id: "parse-attempt-any-number", why: "a stored attempt may be any number", file: "tower.js", from: "if ('attempt' in r && !isInt(r.attempt, 0, 0xffffffff)) return bad('attempt');", to: "", groups: ["Q"] },
  { id: "shape-attempt-any-number", why: "the shallow check lets any attempt through", file: "tower_record.js", from: "  if (hasOwn.call(r, 'attempt') && !isInt(r.attempt, 0, 0xffffffff)) return false;\n", to: "", groups: ["Q"] },
  { id: "attempt-required", why: "a run stored before the attempt key existed is refused", file: "tower_record.js", from: "if (!hasOwn.call(r, k) && !RUN_KEYS_OPTIONAL.includes(k)) return false;", to: "if (!hasOwn.call(r, k)) return false;", groups: ["Q"] },
  { id: "resume-makes-a-new-attempt", why: "a reload of a fight under way gets a fresh attempt number and so cannot finish it", file: "tower_session.js", from: "attempt = b.status === 'resume' ? (cur.attempt >>> 0) : newAttempt(nonce, now);", to: "attempt = newAttempt(nonce, now);", groups: ["Q"] },
  { id: "finish-forgets-the-try", why: "the page's result does not say which try of the floor it is for", file: "tower_session.js", from: "s.finishFloor({ floor, seed: runId, result, attempt, tries })", to: "s.finishFloor({ floor, seed: runId, result, attempt })", groups: ["Q", "S"] },
  // ---- the fight hears the engine; a fight that cannot be resumed is a loss
  { id: "fight-ignores-the-engine-end", why: "the Tower is not told when the engine ends the match (only the result screen tells it)", file: "tower_fight.js", from: "return ctl.onEnd(hear);", to: "return () => {};", groups: ["Q"] },
  { id: "fight-ignores-an-ended-engine", why: "a controller that is already over is not reported", file: "tower_fight.js", from: "if (ctl.winner !== null && ctl.winner !== undefined) { hear(); return () => {}; }", to: "if (false) { hear(); return () => {}; }", groups: ["Q"] },
  { id: "fight-unrestorable-is-free", why: "a fight that cannot be resumed is not counted as left", file: "tower_fight.js", from: "      st.ended = true;\n      st.promise = f.finish({ floor: spec.tower.floor, result: 'f', turns: 0, faints: 0 }).then((r) => { st.applied = r; return r; }, () => {", to: "      st.ended = true;\n      st.promise = Promise.resolve({ applied: false }).then((r) => { st.applied = r; return r; }, () => {", groups: ["Q"] },
  { id: "fight-duplicate-is-silent", why: "a second tab is not told it is a duplicate", file: "tower_fight.js", from: "if (r && r.applied === false && r.taken) { st.duplicate = true;", to: "if (false) { st.duplicate = true;", groups: ["Q"] },
  { id: "fight-stale-says-nothing-of-the-result", why: "the page for a fight that is already counted does not say so", file: "tower_fight.js", from: "If you just played it, its result is already counted; it may also have moved on", to: "It may have moved on", groups: ["Q"] },
  // ---- the battle page's wiring and the address
  { id: "page-never-listens-to-the-engine", why: "the battle page does not give the Tower the engine's end", file: "battle_boot.js", from: "      if (towerFight) towerFight.watchEngine(ctl, summarizeMatch);          // the Tower learns the result when the ENGINE ends the match, not when the result screen comes up (closing the page in between can no longer dodge a loss)\n", to: "", groups: ["Q"] },
  { id: "page-restarts-an-unrestorable-fight", why: "a marked fight with nothing to resume restarts at the preview", file: "battle_boot.js", from: "if (towerFight && towerFight.status === 'resume' && !rs.info.restored) {", to: "if (false) {", groups: ["Q"] },
  { id: "page-mounts-open-to-battles", why: "OPEN TO BATTLES is mounted in a Tower fight", file: "battle_boot.js", from: "    if (towerFight) return;          // OPEN TO BATTLES is NOT mounted", to: "    if (false) return;          // OPEN TO BATTLES is NOT mounted", groups: ["Q"] },
  { id: "page-has-no-nonce", why: "every page makes the same attempt number", file: "battle_boot.js", from: "nonce: freshSeed,\n        onDuplicate:", to: "onDuplicate:", groups: ["Q"] },
  { id: "page-spells-out-the-hub", why: "battle_boot.js names the hub's Tower address itself", file: "battle_boot.js", from: "const MAX_PARAM = 1100;", to: "const MAX_PARAM = 1100;\nconst __hub = '/pokemonarena/#tower';", groups: ["M"] },
  { id: "boot-spells-out-a-fight-address", why: "boot.js builds a Tower fight address itself", file: "boot.js", from: "export const SETTINGS_KEY = 'arena.hub';", to: "export const SETTINGS_KEY = 'arena.hub';\nconst __fight = '/pokemonarena/battle.html?tower=1';", groups: ["M"] },
  { id: "launch-refuses-stray-params", why: "floor / run / life / p on a regular address make it an error", file: "tower_launch.js", from: "  if (!has('tower')) return { ok: true, tower: null };", to: "  if (['floor', 'run', 'life', 'p'].some(has) && !has('tower')) return bad('tower', 'x');\n  if (!has('tower')) return { ok: true, tower: null };", groups: ["Q"] },
  // ---- the second review's residual defects: the saved battle names its page, big attempt numbers, a quit before any choice, one start at a time, the history is seeded once
  { id: "resume-ignores-the-attempt", why: "a reloaded duplicate tab resumes the first tab's fight (the saved battle is used whatever page wrote it)", file: "battle_resume.js", from: "if (attempt !== undefined && rec.attempt !== attempt) {", to: "if (false) {", groups: ["Q"] },
  { id: "resume-writes-no-attempt", why: "the saved battle does not say which page wrote it", file: "battle_resume.js", from: "...(attempt === undefined ? {} : { attempt }),", to: "", groups: ["Q"] },
  { id: "resume-store-forgets-its-attempt", why: "the resume store saves its snapshots without its page's attempt", file: "battle_resume.js", from: "snapshotOf(ctl, seed, humanSide, tag, attempt)", to: "snapshotOf(ctl, seed, humanSide, tag)", groups: ["Q"] },
  { id: "resume-takes-records-with-no-attempt", why: "a saved battle that names no page is believed by a Tower page", file: "battle_resume.js", from: "rec.attempt !== attempt) {", to: "rec.attempt !== undefined && rec.attempt !== attempt) {", groups: ["Q"] },
  { id: "fight-hides-its-attempt", why: "the fight controller does not hand the page its attempt (the resume store then asks for none)", file: "tower_fight.js", from: "tag: f.tag, attempt: f.attempt, tries: f.tries, nav,", to: "tag: f.tag, tries: f.tries, nav,", groups: ["Q"] },
  { id: "page-drops-resume-attempt", why: "the battle page forgets to give its resume store the fight's attempt", file: "battle_boot.js", from: ", attempt: towerFight ? towerFight.attempt : undefined });", to: " });", groups: ["Q"] },
  { id: "mark-compares-signed", why: "a page whose attempt number is 2^31 or more is not recognised as the owner of its own mark", file: "tower_session.js", from: "(cur.attempt >>> 0) === (attempt >>> 0) ? { applied: false, why: 'already marked'", to: "(cur.attempt | 0) === attempt ? { applied: false, why: 'already marked'", groups: ["Q"] },
  { id: "finish-compares-signed", why: "the owner of a fight with an attempt number of 2^31 or more cannot finish it", file: "tower_session.js", from: "(cur.attempt >>> 0) !== (attempt >>> 0)) return refuse(", to: "(cur.attempt | 0) !== (attempt >>> 0)) return refuse(", groups: ["Q"] },
  { id: "resume-adopts-a-signed-attempt", why: "a reload takes over a negative attempt number when the fight's is 2^31 or more", file: "tower_session.js", from: "b.status === 'resume' ? (cur.attempt >>> 0) :", to: "b.status === 'resume' ? (cur.attempt | 0) :", groups: ["Q"] },
  { id: "quit-before-a-choice-counts", why: "a quit result for a fight that was never begun is recorded as a lost try", file: "tower_session.js", from: "  if (result && result.result === 'f' && !cur.fighting) return refuse('no fight was begun', { unplayed: true });\n", to: "", groups: ["Q"] },
  { id: "quit-after-a-choice-is-free", why: "leaving after the first choice is refused too (the loss is never counted)", file: "tower_session.js", from: "result.result === 'f' && !cur.fighting) return refuse('no fight was begun'", to: "result.result === 'f') return refuse('no fight was begun'", groups: ["Q", "S"] },
  { id: "fight-quit-before-a-choice-is-a-lost-try", why: "LEAVE TOWER before the first choice marks the fight and sends its loss (the page writes where it said it would cost nothing)", file: "tower_fight.js", from: "if (!st.marked && f.status !== 'resume') { nav.toTower(null); return; }", to: "if (!st.marked && f.status !== 'resume') { st.marked = true; f.markFight(); }", groups: ["L"] },
  { id: "boot-start-guard-never-ends", why: "the hub page never ends a start (a start that failed cannot be asked for again)", file: "boot.js", from: "startGuard.done(eff.token, started)", to: "void started", groups: ["Q"] },
  { id: "boot-start-guard-is-skipped", why: "the hub page lets every START through", file: "boot.js", from: "eff.type === 'tower-new' && !startGuard.enter(eff.token)", to: "eff.type === 'tower-new' && !true", groups: ["Q"] },
  { id: "boot-seeds-history-on-every-boot", why: "a reload adds two entries to the history", file: "boot.js", from: "if (!plan.write) { hist = plan.trail.slice(); return; }", to: "", groups: ["Q"] },
  { id: "boot-ignores-the-seed-plan", why: "the hub page seeds its history without asking the plan", file: "boot.js", from: "const plan = historySeedPlan(path, state);", to: "const plan = { trail: entryTrail(null, path), write: true };", groups: ["Q"] },
  // ---- THE RETRIES (2026-11-17). The run machine
  { id: 'retry-loss-ends-at-once', why: 'the old rule comes back: a loss with a retry left ends the run', file: 'tower.js', from: 'else if (retryInfo(run, cfg).left > 0) {', to: 'else if (false) {', groups: ['R'] },
  { id: 'retry-never-runs-out', why: 'a floor can be retried without end', file: 'tower.js', from: 'else if (retryInfo(run, cfg).left > 0) {', to: 'else if (true) {', groups: ['R', 'S'] },
  { id: 'retry-not-marked', why: 'a lost try that costs a retry is not marked in the history (nothing counts it)', file: 'tower.js', from: "r.history[r.history.length - 1].retry = true; events.push({ type: 'retry-used'", to: "events.push({ type: 'retry-used'", groups: ['R'] },
  { id: 'retry-counted-before-a-life', why: 'a retry is counted although an Extra Life is held', file: 'tower.js', from: '} else if (livesLeft(run, cfg) > 0) { r.livesUsed += 1;', to: '} else if (livesLeft(run, cfg) > 0 && retryInfo(run, cfg).left === 0) { r.livesUsed += 1;', groups: ['R'] },
  { id: 'retry-floor-count-never-resets', why: 'the retries of a floor are the retries of the whole climb (a new floor brings none back)', file: 'tower_record.js', from: 'if (isRetryRow(h) && h.floor === f) n++;', to: 'if (isRetryRow(h)) n++;', groups: ['R'] },
  { id: 'retry-floor-cap-ignored', why: 'retriesPerFloor is not enforced', file: 'tower.js', from: 'const leftFloor = perFloor === null ? Infinity : Math.max(0, perFloor - onFloor),', to: 'const leftFloor = Infinity,', groups: ['R'] },
  { id: 'retry-run-cap-ignored', why: 'retriesPerRun is not enforced', file: 'tower.js', from: 'leftRun = perRun === null ? Infinity : Math.max(0, perRun - used),', to: 'leftRun = Infinity,', groups: ['R'] },
  { id: 'retry-hard-cap-lost', why: 'with no cap in the config a run can count retries without end', file: 'tower.js', from: 'hard = Math.max(0, TOWER_LIMITS.retriesMax - used);', to: 'hard = Infinity;', groups: ['R'] },
  { id: 'retry-junk-cap-is-no-limit', why: 'a cap that is not a number (a typo in the config) means retries without end', file: 'tower.js', from: 'const capOfRetries = (v) => (v === null ? null : Number.isInteger(v) && v >= 0 ? v : 0);', to: 'const capOfRetries = (v) => (Number.isInteger(v) && v >= 0 ? v : null);', groups: ['R'] },
  { id: 'retry-scope-always-floor', why: 'the screens are told the per-floor cap although the climb\'s cap is the one that ran out', file: 'tower.js', from: "const scope = perFloor !== null && leftFloor <= leftRun ? 'floor' :", to: "const scope = perFloor !== null ? 'floor' :", groups: ['R'] },
  // ---- the identity of a try
  { id: 'retry-is-a-replay', why: 'a retry is fought with the seed of the lost battle (the dice are not re-rolled)', file: 'tower.js', from: 'seed: tryNumber(run) ? mix(run.seed, run.floor, 0xb477, tryNumber(run)) : mix(run.seed, run.floor, 0xb477),', to: 'seed: run.livesUsed ? mix(run.seed, run.floor, 0xb477, run.livesUsed) : mix(run.seed, run.floor, 0xb477),', groups: ['R'] },
  { id: 'try-number-ignores-retries', why: 'the try number counts the lives spent only (two tries of a floor share an identity)', file: 'tower_record.js', from: '(run && Number.isInteger(run.livesUsed) && run.livesUsed > 0 ? run.livesUsed : 0) + retriesOf(run);', to: '(run && Number.isInteger(run.livesUsed) && run.livesUsed > 0 ? run.livesUsed : 0);', groups: ['R', 'S'] },
  { id: 'result-ignores-the-try', why: 'the run machine applies a result whatever try it names (the same lost try counts twice)', file: 'tower.js', from: "  if (tries !== undefined && tries !== tryNumber(run)) return { run, applied: false, events: [], why: 'not the current try' };\n", to: '', groups: ['R'] },
  { id: 'session-result-forgets-the-try', why: 'the session does not hand the try of a result to the run machine', file: 'tower_session.js', from: 'const r = recordFloorResult(cur, result, { pack, cfg, tries });', to: 'const r = recordFloorResult(cur, result, { pack, cfg });', groups: ['R'] , andAlso: { file: 'tower_session.js', from: "  if (tries !== undefined && tries !== tryNumber(cur)) return refuse('that try of the floor is over');          // a late", to: '  // a late' } },
  // ---- the strict stored form
  { id: 'parse-retry-on-a-won-floor', why: 'a won floor may be marked as having cost a retry', file: 'tower.js', from: "if (h.life || h.retry) return bad('a won floor cost a life or a retry'); ", to: '', groups: ['R'] },
  { id: 'parse-mark-of-any-value', why: 'a retry or life mark may be any value (1, "yes", -1...)', file: 'tower.js', from: "    if ((h.life !== undefined && h.life !== true) || (h.retry !== undefined && h.retry !== true)) return bad('a life or retry mark that is not true');\n", to: '', groups: ['R'] },
  { id: 'parse-loss-on-any-floor', why: 'a lost try may be filed under another floor than the one it was fought on (frees a retry on this floor)', file: 'tower.js', from: "      if (h.floor !== wins + 1) return bad('a loss is not on the floor that was being fought');\n", to: '', groups: ['R'] },
  { id: 'parse-loss-that-cost-nothing', why: 'a loss in the middle of a run may have cost nothing (a retry un-counted)', file: 'tower.js', from: "      else if (i !== r.history.length - 1 || r.phase !== 'over') return bad('a loss that cost nothing did not end the run');\n", to: '', groups: ['R'] },
  { id: 'parse-loss-cost-both', why: 'one loss may have cost a life and a retry', file: 'tower.js', from: "      if (h.life && h.retry) return bad('one loss cost both a life and a retry');\n", to: '', groups: ['R'] },
  { id: 'parse-pick-on-a-lost-floor', why: 'a lost floor may carry a pick', file: 'tower.js', from: "      if (h.pick !== undefined) return bad('a pick on a lost floor');\n", to: '', groups: ['R'] },
  { id: 'parse-retries-unbounded', why: 'a stored run may hold more retries than one run can count', file: 'tower.js', from: "  if (retries > TOWER_LIMITS.retriesMax) return bad('retries');", to: '', groups: ['R'] },
  { id: 'parse-retry-key-unknown', why: 'the parser does not know the retry mark (every climb with a retry becomes unreadable)', file: 'tower.js', from: "'closest', 'life', 'retry', 'pick'];", to: "'closest', 'life', 'pick'];", groups: ['R'] },
  // ---- the record
  { id: 'fold-forgets-the-retries', why: 'a finished run adds nothing to the record\'s retries', file: 'tower.js', from: '  if (retries > 0 || Number.isInteger(t.retries)) t.retries = (Number.isInteger(t.retries) ? t.retries : 0) + retries;\n', to: '', groups: ['R'] },
  { id: 'fold-always-writes-the-total', why: 'a record that never saw a retry gets a retries key (it is no longer what the build before wrote)', file: 'tower.js', from: 'if (retries > 0 || Number.isInteger(t.retries)) t.retries =', to: 'if (true) t.retries =', groups: ['R', 'O'] },
  { id: 'fewest-is-the-latest', why: 'the fewest retries of a won climb is overwritten by a worse win', file: 'tower.js', from: 'fewest[run.format] = before === null ? retries : Math.min(before, retries);', to: 'fewest[run.format] = retries;', groups: ['R'] },
  { id: 'fewest-counts-lost-runs', why: 'a run that was not won sets the fewest-retries figure', file: 'tower.js', from: "  if (run.phase === 'won') {\n    const before = fewestRetriesOf(tower, run.format), fewest = {};", to: "  if (true) {\n    const before = fewestRetriesOf(tower, run.format), fewest = {};", groups: ['R'] },
  { id: 'fewest-ignores-old-wins', why: 'a format won before retries existed reads as never won with few retries', file: 'tower_record.js', from: "return isObj(tower) && isObj(tower.winsByFormat) && tower.winsByFormat[format] > 0 ? 0 : null;", to: 'return null;', groups: ['R'] },
  { id: 'last-always-writes-retries', why: 'the summary of a run with no retry gets a retries key (the build before sets such a summary aside)', file: 'tower.js', from: '...(retries > 0 ? { retries } : {}) };', to: '...({ retries }) };', groups: ['R', 'O'] },
  { id: 'last-forgets-the-retries', why: 'LAST RUN does not know how many retries the run counted', file: 'tower.js', from: '...(retries > 0 ? { retries } : {}) };', to: '...({}) };', groups: ['R'] },
  { id: 'rec-retries-any-number', why: 'the record\'s total may be negative, fractional or huge', file: 'tower_record.js', from: "  if (hasOwn.call(t, 'retries') && !isInt(t.retries, 0, TOWER_LIMITS.counterMax)) bad.push('retries');\n", to: '', groups: ['R'] },
  { id: 'rec-fewest-any-shape', why: 'the fewest-retries figure may be anything', file: 'tower_record.js', from: "if (!fewestOk(t.fewestRetries, cfg)) bad.push('fewestRetries');\n    else if", to: 'if', groups: ['R'] },
  { id: 'rec-fewest-without-a-win', why: 'a format that was never won may have a fewest-retries figure', file: 'tower_record.js', from: "cfg.formats.some((f) => t.fewestRetries[f] !== null && !(t.winsByFormat[f] >= 1))) bad.push('fewestRetries without a win');", to: "false) bad.push('fewestRetries without a win');", groups: ['R'] },
  { id: 'rec-last-retries-any-number', why: 'the last run\'s retries may be negative, fractional or huge', file: 'tower_record.js', from: "  if (hasOwn.call(l, 'retries') && !isInt(l.retries, 0, TOWER_LIMITS.retriesMax)) return false;\n", to: '', groups: ['R'] },
  { id: 'rec-last-any-key', why: 'the summary of the last run may carry any key', file: 'tower_record.js', from: 'if (!LAST_KEYS.includes(k) && !LAST_KEYS_OPTIONAL.includes(k)) return false;', to: 'if (false) return false;', groups: ['R'] },
  { id: 'repair-keeps-a-bad-total', why: 'the repair keeps a retries total that is not a count (the whole record then fails its check and is emptied)', file: 'tower_record.js', from: "optional('retries', (v) => isInt(v, 0, TOWER_LIMITS.counterKeep));", to: "optional('retries', () => true);", groups: ['R'] },
  { id: 'repair-keeps-a-fewest-without-a-win', why: 'the repair keeps a fewest-retries entry for a format never won', file: 'tower_record.js', from: '    for (const f of cfg.formats) if (out.winsByFormat[f] < 1) out.fewestRetries[f] = null;\n', to: '', groups: ['R'] },
  { id: 'repair-never-restores-the-bag', why: 'the retry keys an older build parked in the bag never come back (they read as 0 for ever)', file: 'tower_record.js', from: '    else if (bagIn && hasOwn.call(bagIn, k) && valid(bagIn[k])) { out[k] = clone(bagIn[k]); back.push(k); }\n', to: '', groups: ['R', 'O'] },
  { id: 'repair-restores-junk', why: 'a value in the bag is restored without being checked', file: 'tower_record.js', from: 'else if (bagIn && hasOwn.call(bagIn, k) && valid(bagIn[k])) {', to: 'else if (bagIn && hasOwn.call(bagIn, k)) {', groups: ['R'] },
  { id: 'repair-leaves-a-copy-in-the-bag', why: 'what came back out of the bag stays in it too', file: 'tower_record.js', from: '  if (bag) for (const k of back) delete bag[k];', to: '', groups: ['R'] },
  { id: 'repair-never-restores-last', why: 'the last run an older build set aside never comes back', file: 'tower_record.js', from: 'out.last = parkedLast ? clone(parkedLast) : null; lastBack = !!parkedLast;', to: 'out.last = null;', groups: ['R', 'O'] },
  { id: 'repair-parked-last-replaces-a-newer-one', why: 'a parked last run replaces the one the record has', file: 'tower_record.js', from: "  else if (isLastShape(src.last, cfg)) out.last = clone(src.last);\n  else rep('last', src.last, 'was not a run summary');", to: "  else if (isLastShape(src.last, cfg)) out.last = clone(parkedLast || src.last);\n  else rep('last', src.last, 'was not a run summary');", groups: ['R'] },
  // ---- the session and the summary
  { id: 'next-step-forgets-how', why: 'a lost try always reads as an Extra Life spent', file: 'tower_session.js', from: "return h && h.result === 'l' ? (h.life ? 'life' : 'retry') : null;", to: "return h && h.result === 'l' ? 'life' : null;", groups: ['R', 'S'] },
  { id: 'summary-forgets-the-lost-try', why: 'the hub is not told that the last try of the floor was lost (no RETRY FLOOR row)', file: 'tower_session.js', from: 'retry: retryInfo(r, cfg), lostTry: lostTry(r),', to: 'retry: retryInfo(r, cfg), lostTry: null,', groups: ['R'] },
  { id: 'summary-always-says-saved', why: 'the summary says the climb is saved although the store keeps nothing', file: 'tower_session.js', from: 'saved: saved !== false };', to: 'saved: true };', groups: ['R'] },
  { id: 'summary-record-forgets-retries', why: 'the record lines get no retries total', file: 'tower_session.js', from: 'retries: Number.isInteger(tower.retries) ? tower.retries : 0, fewestRetries: fewest };', to: 'retries: 0, fewestRetries: fewest };', groups: ['R'] },
  // ---- the fight: what the page says and does
  { id: 'fight-buttons-no-retry', why: 'the result screen offers no RETRY FLOOR for a retry (only for an Extra Life)', file: 'tower_fight.js', from: "return lives0 > 0 || rt0.left > 0 ? ['RETRY FLOOR', 'BACK TO TOWER', 'BACK TO HUB'] :", to: "return lives0 > 0 ? ['RETRY FLOOR', 'BACK TO TOWER', 'BACK TO HUB'] :", groups: ['S'] },
  { id: 'fight-buttons-retry-when-none-left', why: 'the result screen offers RETRY FLOOR after the loss that ended the run', file: 'tower_fight.js', from: "return lives0 > 0 || rt0.left > 0 ? ['RETRY FLOOR', 'BACK TO TOWER', 'BACK TO HUB'] :", to: "return true ? ['RETRY FLOOR', 'BACK TO TOWER', 'BACK TO HUB'] :", groups: ['S'] },
  { id: 'fight-bar-hides-the-retries', why: 'the Tower bar does not show the retries left', file: 'tower_fight.js', from: "const retries = !hasRetries(rt0) ? '' :", to: "const retries = true ? '' :", groups: ['S'] },
  { id: 'fight-recap-silent-on-a-retry', why: 'the record page does not say a retry was counted', file: 'tower_fight.js', from: "        head += ': RETRY COUNTED';\n", to: '', groups: ['S'] },
  { id: 'fight-recap-silent-on-the-end', why: 'the record page does not say the floor\'s retries were used up', file: 'tower_fight.js', from: "if (hasRetries(rt)) head += ': NO RETRY LEFT'; ", to: '', groups: ['S'] },
  { id: 'fight-recap-forgets-what-is-left', why: 'the record page does not say how many retries are left', file: 'tower_fight.js', from: "+ ' LEFT ' + (rt.scope === 'run' ? 'IN ALL' : 'HERE') + ', ' + rt.used + ' USED.');", to: "+ ' LEFT.');", groups: ['S'] },
  { id: 'fight-leave-is-always-free', why: 'the question says leaving costs nothing after the first choice too', file: 'tower_fight.js', from: "const begun = st.marked || f.status === 'resume';", to: 'const begun = false;', groups: ['S'] },
  { id: 'fight-resumed-leave-is-free', why: 'a fight resumed by a reload says leaving costs nothing', file: 'tower_fight.js', from: "const begun = st.marked || f.status === 'resume';", to: 'const begun = st.marked;', groups: ['S'] },
  { id: 'fight-forfeit-says-free', why: 'FORFEIT before the first choice says it costs nothing (it is a choice: it costs a retry)', file: 'tower_fight.js', from: "const cost = kind === 'quit' && !begun ? 'nothing' :", to: "const cost = !begun ? 'nothing' :", groups: ['S'] },
  { id: 'fight-cost-forgets-the-life', why: 'the question says a retry is spent although an Extra Life goes first', file: 'tower_fight.js', from: "? 'nothing' : lives0 > 0 ? 'life' : rt0.left > 0 ? 'retry' : 'end';", to: "? 'nothing' : rt0.left > 0 ? 'retry' : 'end';", groups: ['S'] },
  { id: 'fight-cost-never-ends', why: 'the question says leaving costs a retry when none is left (it ends the climb)', file: 'tower_fight.js', from: "? 'nothing' : lives0 > 0 ? 'life' : rt0.left > 0 ? 'retry' : 'end';", to: "? 'nothing' : lives0 > 0 ? 'life' : 'retry';", groups: ['S'] },
  { id: 'fight-left-message-forgets-the-cost', why: 'the page for a fight that was left does not say it cost a retry', file: 'tower_fight.js', from: "    if (n === 'retry' && f.next.via === 'retry') return ('You left the last fight of this floor, so it counted as a loss and cost one retry. ' + leftWords(rt)).trim() + ' The climb is saved: go back to the Tower to try the floor again.';\n", to: '', groups: ['S'] },
  { id: 'fight-left-message-forgets-what-is-left', why: 'the page for a fight that was left does not say how many retries are left', file: 'tower_fight.js', from: "+ leftWords(rt)).trim() + ' The climb is saved", to: ").trim() + ' The climb is saved", groups: ['S'] },
  // ---- the address, the scene, the page
  { id: 'launch-ignores-the-retries', why: 'the address of a retry is the address of the first try', file: 'tower_launch.js', from: " + (Array.isArray(run.history) ? run.history.filter((h) => !!h && typeof h === 'object' && h.result === 'l' && h.retry === true).length : 0);", to: ';', groups: ['S'] },
  { id: 'launch-life-beats-try', why: 'the older life= parameter is read before try=', file: 'tower_launch.js', from: "tries: has('try') ? tries : life,", to: "tries: has('life') ? life : tries,", groups: ['S'] },
  { id: 'launch-try-unchecked', why: 'a hostile try= value is not refused', file: 'tower_launch.js', from: "  if (tries === null) return bad('try', 'The try number must be a whole number from 0 to 1000.');\n", to: '', groups: ['S'] },
  { id: 'scene-box-ignores-the-page', why: 'the scene asks its own question in a Tower fight (the cost is not said in the message box)', file: 'scene.js', from: "const own = k === 'forfeit' || k === 'quit' ? leaveAsk(k, 'box') : null;", to: 'const own = null;', groups: ['S'] },
  { id: 'scene-title-ignores-the-page', why: 'the scene asks its own question at the team preview of a Tower fight', file: 'scene.js', from: "const left = asking ? (leaveAsk(S.confirm.kind, 'title') || (", to: 'const left = asking ? (null || (', groups: ['S'] },
  { id: 'scene-question-unguarded', why: 'the scene shows whatever the page hands it (too long, not text)', file: 'scene.js', from: "return typeof t === 'string' && t.length > 0 && t.length <= 120 ? t : null;", to: 'return t;', groups: ['S'] },
  { id: 'scene-question-may-throw', why: 'a page question that throws takes the scene down', file: 'scene.js', from: 'let t = null; try { t = opts.leaveAsk(kind, where); } catch (_e) { t = null; }', to: 'const t = opts.leaveAsk(kind, where);', groups: ['S'] },
  { id: 'page-drops-the-leave-question', why: 'the battle page does not hand the scene the Tower fight\'s question', file: 'battle_boot.js', from: 'leaveAsk: towerFight ? (kind, where) => towerFight.leaveAsk(kind, where) : undefined, ', to: '', groups: ['S'] },
  // ---- the achievements and the words of Extra Life
  { id: 'flawless-counts-a-retried-floor', why: 'a floor won without a faint on its SECOND try counts as won without losing a Pokemon (the flawless achievements can be fished for)', file: 'achievements.js', from: "clean = (h) => h.result === 'w' && h.flawless === true && !lostFloors.has(h.floor);", to: "clean = (h) => h.result === 'w' && h.flawless === true;", groups: ['R'] },
  { id: 'rock-bottom-on-the-first-loss', why: 'Rock Bottom is earned by one lost try on floor 1 (the run goes on)', file: 'achievements.js', from: '(f) => f.over && f.cleared === 0);', to: '(f) => f.cleared === 0 && (f.over || f.retries > 0));', groups: ['R'] },
  { id: 'extra-life-words-say-nothing', why: 'the Extra Life ball does not say what a life now does', file: 'tower_buffs.js', from: " + ': a lost floor spends ' + (N(op.lives) > 1 ? 'one' : 'it') + (retriesExist(cfg) ? ' instead of a retry' : ' instead of ending the run'));", to: ');', groups: ['R'] },
  { id: 'extra-life-words-ignore-the-config', why: 'the Extra Life ball speaks of a retry where the config hands out none', file: 'tower_buffs.js', from: "(retriesExist(cfg) ? ' instead of a retry' : ' instead of ending the run')", to: "' instead of a retry'", groups: ['R'] },
  { id: 'config-one-retry', why: 'the config hands out one retry a floor, not the owner\'s three', file: 'tower_config.js', from: '  retriesPerFloor: 3,\n', to: '  retriesPerFloor: 1,\n', groups: ['R'] },
  { id: 'config-three-for-the-climb', why: 'the config caps the whole climb at three (the reading that was NOT adopted)', file: 'tower_config.js', from: '  retriesPerFloor: 3,\n  retriesPerRun: null,\n', to: '  retriesPerFloor: null,\n  retriesPerRun: 3,\n', groups: ['R'] },
  // ---- THE REVIEW OF 2026-11-17. (1) the page behind a retry: Back out of a retry must cost nothing
  { id: 'begin-resumes-on-any-page', why: 'the page of ANOTHER try, reached by the browser\'s Back, takes the fight under way for its own (finding nothing saved under its address, the battle page then counts the fight as left: Back out of a retry costs a retry, or the climb)', file: 'tower_session.js', from: "if (byHistory && openedTry !== undefined && openedTry !== tryNumber(cur)) return {", to: 'if (false) return {', groups: ['S'] },
  { id: 'begin-typed-old-address-is-free', why: 'a FRESH arrival at another try\'s address while a fight is under way no longer counts that fight as left (a typed address dodges the cost of leaving)', file: 'tower_session.js', from: "if (byHistory && openedTry !== undefined && openedTry !== tryNumber(cur)) return {", to: 'if (openedTry !== undefined && openedTry !== tryNumber(cur)) return {', groups: ['S'] },
  { id: 'begin-own-page-is-elsewhere', why: 'the fight\'s OWN page, reloaded, is told the fight is on another page (a reload can no longer resume a fight)', file: 'tower_session.js', from: "if (byHistory && openedTry !== undefined && openedTry !== tryNumber(cur)) return {", to: 'if (byHistory && openedTry !== undefined) return {', groups: ['S'] },
  { id: 'floor-forgets-the-opened-try', why: 'the try a page was opened as never reaches the reducer', file: 'tower_session.js', from: 'const b = await s.beginFloor({ floor, seed: runId, navType, openedTry });', to: 'const b = await s.beginFloor({ floor, seed: runId, navType });', groups: ['S'] },
  { id: 'floor-elsewhere-reads-as-ok', why: 'the page of another try is not told so by the floor\'s opener (it goes on to build the fight)', file: 'tower_session.js', from: "  if (b.status === 'elsewhere') return { ok: false, status: 'elsewhere', why: b.why, tries: b.tries };\n", to: '', groups: ['S'] },
  { id: 'fight-forgets-the-opened-try', why: 'the fight controller drops the try its page was opened as', file: 'tower_fight.js', from: 'startTowerFloor({ pack, persist, floor, runId, navType, now, cfg, nonce, openedTry });', to: 'startTowerFloor({ pack, persist, floor, runId, navType, now, cfg, nonce });', groups: ['S'] },
  { id: 'fight-elsewhere-says-nothing-of-the-count', why: 'the page of another try does not say that nothing was counted', file: 'tower_fight.js', from: ' to carry on with it. Nothing was counted. Opening', to: ' to carry on with it. Opening', groups: ['S'] },
  { id: 'fight-stale-retry-button-leaves-the-fight', why: 'RETRY FLOOR on a result screen that outlived its moment opens the try afresh although it is being fought on another page (a fresh arrival counts that fight as left)', file: 'tower_fight.js', from: 'f.stillWaiting(a.run).then((yes) => yes, () => false).then((yes) => { if (yes) nav.retry(a.run); else nav.toTower(null); });', to: 'nav.retry(a.run);', groups: ['S'] },
  { id: 'fight-retry-button-trusts-a-failed-read', why: 'RETRY FLOOR opens the try although the record could not be read', file: 'tower_fight.js', from: 'f.stillWaiting(a.run).then((yes) => yes, () => false)', to: 'f.stillWaiting(a.run).then((yes) => yes, () => true)', groups: ['S'] },
  { id: 'fight-retry-button-never-retries', why: 'RETRY FLOOR always goes to the Tower', file: 'tower_fight.js', from: '.then((yes) => { if (yes) nav.retry(a.run); else nav.toTower(null); });', to: '.then(() => { nav.toTower(null); });', groups: ['S'] },
  { id: 'still-waiting-ignores-the-mark', why: 'a try that is being fought on another page reads as still waiting', file: 'tower_session.js', from: 'c.floor === run.floor && c.fighting !== true && tryNumber(c) === tryNumber(run); });', to: 'c.floor === run.floor && tryNumber(c) === tryNumber(run); });', groups: ['S'] },
  { id: 'still-waiting-ignores-the-try', why: 'a try that is over reads as still waiting (the run is on a later one)', file: 'tower_session.js', from: 'c.floor === run.floor && c.fighting !== true && tryNumber(c) === tryNumber(run); });', to: 'c.floor === run.floor && c.fighting !== true; });', groups: ['S'] },
  { id: 'launch-search-keeps-the-old-try', why: 'the address of a page that hosts another try than it names is left naming the old one', file: 'tower_launch.js', from: "  if (tries > 0) q.set('try', String(tries)); else q.delete('try');\n", to: '', groups: ['S'] },
  { id: 'launch-search-writes-try-0', why: 'the first try\'s address is written with try=0 (it is no longer the address the hub gives the floor)', file: 'tower_launch.js', from: "  if (tries > 0) q.set('try', String(tries)); else q.delete('try');\n", to: "  q.set('try', String(tries));\n", groups: ['S'] },
  { id: 'launch-search-keeps-life', why: 'the older life= stays in an address that was put right', file: 'tower_launch.js', from: "  q.delete('life');\n", to: '', groups: ['S'] },
  { id: 'launch-search-rewrites-a-right-address', why: 'an address that already names the try is rewritten all the same', file: 'tower_launch.js', from: ' || tries > 1000 || p.tower.tries === tries) return null;', to: ' || tries > 1000) return null;', groups: ['S'] },
  { id: 'page-forgets-its-opened-try', why: 'the battle page does not tell the fight which try its address names', file: 'battle_boot.js', from: 'navType: navigationType(), openedTry: tw.tries, nav: nv,', to: 'navType: navigationType(), nav: nv,', groups: ['S'] },
  { id: 'page-retry-adds-a-history-entry', why: 'RETRY FLOOR leaves the lost try\'s battle page behind the retry in the tab\'s history', file: 'battle_boot.js', from: 'launchFloorBattle(run, { navigate: navigateReplacing, profileId })', to: 'launchFloorBattle(run, { navigate, profileId })', groups: ['S'] },
  { id: 'page-replacing-navigation-assigns', why: 'the navigation that should take the page\'s place in the history adds an entry', file: 'battle_boot.js', from: 'window.__arenaNavigate(url, { replace: true }); else location.replace(url); };', to: 'window.__arenaNavigate(url, { replace: true }); else location.assign(url); };', groups: ['S'] },
  { id: 'page-keeps-a-stale-address', why: 'a page that hosts another try than its address names leaves the address as it is (its own reload then reads as another try\'s page, which does not resume the fight)', file: 'battle_boot.js', from: "if (fixed !== null) history.replaceState(history.state, '', location.pathname + fixed + location.hash);", to: '', groups: ['S'] },
  { id: 'page-keeps-the-saved-battle-under-its-address', why: 'a Tower fight\'s saved battle is kept under the page\'s address again (another page of the same try, spelled another way, finds nothing and counts the fight as left)', file: 'battle_boot.js', from: 'fightKey = towerFight ? resumeKeyOfTag(towerFight.tag) : addrKey;', to: 'fightKey = addrKey;', groups: ['S'] },
  { id: 'page-never-adopts-the-old-record', why: 'a fight saved under the address by the build before is not carried over (a reload across the deploy counts it as left)', file: 'battle_boot.js', from: "      if (towerFight) adoptRecord(store, fightKey, addrKey);\n", to: '', groups: ['S'] },
  { id: 'resume-fight-key-is-one-for-all', why: 'every Tower fight keeps its saved battle under the same key (the key does not name the fight)', file: 'battle_resume.js', from: "export const resumeKeyOfTag = (tag) => 'arena.resume:' + String(tag);", to: "export const resumeKeyOfTag = (tag) => 'arena.resume:tower';", groups: ['S'] },
  { id: 'adopt-overwrites-a-newer-record', why: 'a saved battle carried over from the old key replaces the one the fight already has', file: 'battle_resume.js', from: "    if (has !== null && has !== undefined) return false;\n", to: '', groups: ['S'] },
  { id: 'adopt-leaves-the-old-entry', why: 'the saved battle stays under its old key too after it was carried over', file: 'battle_resume.js', from: "    storage.removeItem(oldKey);\n", to: '', groups: ['S'] },
  { id: 'adopt-never-carries-over', why: 'nothing is ever carried over from the old key', file: 'battle_resume.js', from: "    storage.setItem(key, old);\n    return true;\n", to: "    return false;\n", groups: ['S'] },
  // (2) the known limit of the strict form: the tempting way to "close" it refuses genuine climbs
  { id: 'parse-refuses-retries-of-floors-below', why: 'the parser refuses a retry row of any floor but the one the run is on (the tempting way to stop a retry being re-filed under an earlier floor: it refuses every genuine climb that lost a try on an earlier floor)', file: 'tower.js', from: "      if (h.floor !== wins + 1) return bad('a loss is not on the floor that was being fought');\n", to: "      if (h.floor !== wins + 1 || (h.retry === true && h.floor !== r.floor)) return bad('a loss is not on the floor that was being fought');\n", groups: ['R'] },
];

async function runMutants() {
  const out = [];
  for (const mu of MUTANTS) {
    if (MUT_ONLY.length && !MUT_ONLY.includes(mu.id)) continue;          // --mutant=id1,id2 runs just those
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-tower-mut-'));
    try {
      for (const f of fs.readdirSync(SRC)) { const p = path.join(SRC, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, f)); }
      const target = path.join(dir, mu.file);
      const text = fs.readFileSync(target, 'utf8');
      const n = typeof mu.from === 'string' ? text.split(mu.from).length - 1 : (mu.from.test(text) ? 1 : 0);
      if (n !== 1) { out.push({ id: mu.id, killed: false, why: 'THE MUTANT DID NOT APPLY (pattern found ' + n + 'x)' }); continue; }
      fs.writeFileSync(target, typeof mu.from === 'string' ? text.replace(mu.from, () => mu.to) : text.replace(mu.from, mu.to));
      if (mu.andAlso) {          // (a defect that needs two edits to show: both layers of a guard that is checked twice)
        const t2 = path.join(dir, mu.andAlso.file), x2 = fs.readFileSync(t2, 'utf8');
        if (x2.split(mu.andAlso.from).length - 1 !== 1) { out.push({ id: mu.id, killed: false, why: 'THE MUTANT\'S SECOND EDIT DID NOT APPLY' }); continue; }
        fs.writeFileSync(t2, x2.replace(mu.andAlso.from, () => mu.andAlso.to));
      }
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
await suite(S0, '', { groups: ONLY.length ? ONLY : null, fast: !!process.env.ARENA_FAST });          // (ARENA_FAST=1: the lighter run each mutant gets, on the real tree: it must pass there too, or a mutant's "kill" would mean nothing)
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

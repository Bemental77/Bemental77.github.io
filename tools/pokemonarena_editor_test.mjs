#!/usr/bin/env node
// POKEMONARENA EDITOR STATE / DATA TEST  (stage T1)
//
// Proves pokemonarena/js/editor_state.js (the pure reducer behind the profile + team editor) and editor_data.js (its searchable lists and
// derived numbers) against the REAL pack decoded from the pinned ROM, and that the checks themselves can fail:
//
//   * ONE SUITE of named checks (`state/...`, `data/...`) defined as data, runnable against ANY copy of the modules. First the real files, then
//     an UNMUTATED TWIN (a fresh copy in a temp tree, must pass silently), then every MUTANT: a one-snippet edit of editor_state.js / editor_data.js
//     / editor_art.js that names the check(s) that MUST fail. The harness refuses a mutant whose target is not found exactly the stated number of
//     times, so a refactor cannot turn one into a no-op, and it refuses a check that no mutant names (a check nobody can make fail is decoration).
//   * FUZZ: thousands of random actions (valid and garbage) against frozen state; the invariants are that nothing throws, every committed
//     profile passes profile.js checkProfile(), a rejected action leaves the SAME profile object, and no `internal.error` ever surfaces.
//   * DIFFERENTIAL: the batch move verdicts equal one-move-at-a-time validateMon; conformMon output always passes validateStoredMon; the two EV
//     views stay linked through every points value.
//
// WHAT THIS DOES NOT PROVE: any DOM behaviour (tools/pokemonarena_editor_page_test.mjs drives headless Chrome), real IndexedDB, or that the rules
// themselves match the game (rules.js has its own test). Legality is read from rules.js at run time; this test never names an engine-unsupported code.
//
// USAGE   node tools/pokemonarena_editor_test.mjs         (exits non-zero on any failure)
// ENV     ARENA_ROM  path to the ROM    ARENA_FUZZ  fuzz scale (default 1)
//         ARENA_SKIP_MUTANTS=1  run only the checks and the unmutated twin
//         ARENA_QUIET=1         no mutant progress lines
//
// RUNTIME. The mutants are one-snippet edits and each needs a fresh copy of the module tree (an ES module cannot be unloaded, so a mutant is a
// NEW module graph). The first version re-ran EVERY check against EVERY mutant (about 2.3 s each; 312 s in total on a loaded box) and printed
// nothing between "N checks in X s" and the final summary, so a runner with a 180 s limit saw a hang. It was not stuck: the timeout killed it at
// mutant 78 of 120 (the leftover arena-editor-test-* temp tree held exactly 78 copies) and left that tree behind. Now a mutant runs ONLY the
// checks it names (the claim "this check can fail" is exactly that those checks trip), a progress line prints every 10 mutants, and a normal
// exit, SIGINT, SIGTERM and SIGHUP all remove the temp tree.
//
// Reads the ROM, writes only under the OS temp dir. Pure ASCII.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const JS = path.join(root, 'pokemonarena', 'js');
const ROM_PATH = process.env.ARENA_ROM || path.join(root, 'gba', 'gbaWasm', 'roms', 'Pokemon SoulGold (v1.1.1).gba');
const FUZZ = Math.max(1, Number(process.env.ARENA_FUZZ || 1));
if (!fs.existsSync(ROM_PATH)) { console.error('ROM not found: ' + ROM_PATH + ' (set ARENA_ROM)'); process.exit(2); }

const base = await import(pathToFileURL(path.join(JS, 'tables.js')).href);
const rom = new Uint8Array(fs.readFileSync(ROM_PATH));
const pack = base.loadPack(rom, { dexText: true });
(function deepFreeze(o) { if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; })(pack);

let passed = 0, failed = 0;
const failures = [];
const t = (name, ok, detail = '') => {
  if (ok === true) { passed++; if (process.env.ARENA_VERBOSE) console.log('  ok   ' + name); }
  else { failed++; const why = typeof ok === 'string' ? ok : detail; failures.push(name + ': ' + why); console.log('  FAIL ' + name + (why ? '  -- ' + why : '')); }
};
const J = (x) => JSON.stringify(x);
const clone = (o) => JSON.parse(JSON.stringify(o));
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const deepFreeze = (o) => { if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); } return o; };

// ---------------------------------------------------------------------------------------------
// loading a copy of the modules (real, twin or mutant)
// ---------------------------------------------------------------------------------------------
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-editor-test-'));
const cleanTmp = () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_e) { /* best effort */ } };
// A runner that kills the process outright (Windows `timeout`, TerminateProcess) delivers no signal, so nothing can clean up on the way out:
// sweep the trees such runs left behind (older than 30 minutes, so a live run in another shell is never touched).
try {
  for (const n of fs.readdirSync(os.tmpdir())) {
    if (!/^arena-editor-test-[A-Za-z0-9]{6}$/.test(n)) continue;
    const p = path.join(os.tmpdir(), n);
    if (p !== TMP_ROOT && Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true });
  }
} catch (_e) { /* best effort */ }
process.on('exit', cleanTmp);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { cleanTmp(); process.exit(code); });
let copyN = 0;
function makeCopy(mutate) {
  const dir = path.join(TMP_ROOT, 'c' + (copyN++));
  fs.mkdirSync(path.join(dir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const f of fs.readdirSync(JS)) if (f.endsWith('.js')) fs.copyFileSync(path.join(JS, f), path.join(dir, 'js', f));
  if (mutate) for (const [file, fn] of Object.entries(mutate)) { const p = path.join(dir, 'js', file); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); }
  return dir;
}
async function loadCopy(dir) {
  const imp = (n) => import(pathToFileURL(path.join(dir, 'js', n)).href);
  return { S: await imp('editor_state.js'), D: await imp('editor_data.js'), A: await imp('editor_art.js'), G: await imp('gfxcodec.js'), L: await imp('editor_links.js'), IM: await imp('editor_import_model.js'), V: await imp('editor_views.js'), R: await imp('rules.js'), P: await imp('profile.js'), T: await imp('teamcode.js'), ST: await imp('stats.js'), pack, rom };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function detDeps(seed = 1, t0 = 1700000000000) {
  const r = mulberry32(seed);
  let tm = t0;
  return { now: () => (tm += 1), randomBytes: (n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256)) };
}
const STD = 'arena-gen3-standard';
const CHAMP = 'arena-gen3-standard+strict-champions';
const PRESETS = [STD, CHAMP, STD + '+lv5', STD + '+lv100', STD + '+item-clause', STD + '+no-species-clause'];
const PIKACHU = 25, CHARIZARD = 6;
const statBlock = (v) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });

function fresh(c, { deps = detDeps(), teamRuleset = STD, teams = 1 } = {}) {
  const profile = c.P.createProfile({ trainerName: 'ASH' }, deps);
  let s = c.S.initialState(profile);
  const ctx = { pack, deps };
  for (let i = 0; i < teams; i++) s = c.S.reduce(s, { type: 'teamCreate', ruleset: teamRuleset }, ctx);
  return { s, ctx };
}
// run an action; returns the new state, and records the context so callers do not repeat it
const go = (c, ctx, s, a) => c.S.reduce(s, a, ctx);
function withMons(c, species, opts = {}) {
  const f = fresh(c, opts);
  let s = f.s;
  const teamId = s.profile.teams[0].id;
  for (const sp of species) s = go(c, f.ctx, s, { type: 'monAdd', teamId, species: sp });
  return { ...f, s, teamId, monIds: s.profile.teams[0].monIds.slice() };
}
const monOf = (s, id) => s.profile.box.find((m) => m.id === id);
const ok = (s, label) => (s.error ? `${label}: unexpected rejection ${J(s.error)}` : true);
const rejected = (before, after, code, label) => {
  if (!after.error) return `${label}: was accepted`;
  if (code && after.error.code !== code) return `${label}: code ${after.error.code}, wanted ${code}`;
  if (after.profile !== before.profile) return `${label}: a rejected action changed the profile object`;
  if (after.seq !== before.seq || after.undo !== before.undo) return `${label}: a rejected action touched seq/undo`;
  return true;
};
const allOf = async (xs, fn) => { for (const x of xs) { const r = await fn(x); if (r !== true) return r; } return true; };

// ---------------------------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------------------------
const suite = [];
const add = (id, fn, cost = 'cheap') => { if (suite.some((x) => x.id === id)) throw new Error('duplicate check id ' + id); suite.push({ id, fn, cost }); };

// ================================ state: profile level
add('state/initial/a-fresh-state-is-clean', (c) => {
  const p = c.P.createProfile({}, detDeps());
  const s = c.S.initialState(p);
  return s.profile === p && s.seq === 0 && s.savedSeq === 0 && !c.S.isDirty(s) && !c.S.canUndo(s) && !c.S.canRedo(s) && s.error === null ? true : J(s);
});
add('state/rename/accepts-a-name-and-marks-dirty-and-undoable', (c) => {
  const { s, ctx } = fresh(c);
  const s2 = go(c, ctx, s, { type: 'rename', name: 'RED' });
  if (s2.error) return J(s2.error);
  return s2.profile.trainerName === 'RED' && c.S.isDirty(s2) && c.S.canUndo(s2) && s.profile.trainerName === 'ASH' ? true : 'no change, or the input state was mutated';
});
add('state/rename/rejects-bad-names-and-keeps-the-same-profile-object', (c) => {
  const { s, ctx } = fresh(c);
  for (const [name, code] of [['', 'name.empty'], ['   ', 'name.empty'], ['ELEVENCHARS', 'name.text.length'], ['A{B', 'name.text.chars'], ['A\u0001B', 'name.text.chars'], [7, 'name.text.type'], [null, 'name.text.type'], ['\u{1F600}', 'name.text.length']]) {
    const r = rejected(s, go(c, ctx, s, { type: 'rename', name }), code === 'name.text.length' && typeof name === 'string' && name.length < 10 ? undefined : code, 'rename ' + J(name));
    if (r !== true) return r;
  }
  return true;
});
add('state/rename/the-same-name-is-not-an-edit', (c) => {
  const { s, ctx } = fresh(c);
  const s2 = go(c, ctx, s, { type: 'rename', name: 'ASH' });
  return s2.profile === s.profile && s2.seq === s.seq && !s2.error ? true : 'a no-op rename counted as an edit';
});
add('state/setting/default-ruleset-and-enums-are-validated', (c) => {
  const { s, ctx } = fresh(c);
  const a = go(c, ctx, s, { type: 'setting', key: 'defaultRuleset', value: STD + '+lv5' });
  if (a.error || a.profile.settings.defaultRuleset !== STD + '+lv5') return 'valid ruleset refused ' + J(a.error);
  const flip = go(c, ctx, s, { type: 'setting', key: 'defaultRuleset', value: STD + '+lv100+lv5' });
  const r1 = rejected(s, flip, 'setting.ruleset', 'conflicting layers');
  const r2 = rejected(s, go(c, ctx, s, { type: 'setting', key: 'textSpeed', value: 'warp' }), 'setting.value', 'bad enum');
  const r3 = rejected(s, go(c, ctx, s, { type: 'setting', key: 'nope', value: 1 }), 'setting.key', 'bad key');
  const r4 = rejected(s, go(c, ctx, s, { type: 'setting', key: 'sound', value: 'yes' }), 'setting.value', 'bad bool');
  const b = go(c, ctx, s, { type: 'setting', key: 'textSpeed', value: 'fast' });
  return [r1, r2, r3, r4].find((x) => x !== true) || (b.profile.settings.textSpeed === 'fast' ? true : 'enum not applied');
});

// ================================ state: teams
add('state/team/create-uses-the-default-ruleset-names-it-and-reports-the-id', (c) => {
  const { s, ctx } = fresh(c, { teams: 0 });
  const s1 = go(c, ctx, s, { type: 'teamCreate' });
  const s2 = go(c, ctx, s1, { type: 'teamCreate' });
  const tm = s2.profile.teams;
  return tm.length === 2 && tm[0].name === 'TEAM 1' && tm[1].name === 'TEAM 2' && tm[1].ruleset === STD && s2.result.teamId === tm[1].id && new Set(tm.map((x) => x.id)).size === 2 ? true : J(tm);
});
add('state/team/sixteen-is-the-limit', (c) => {
  const { s, ctx } = fresh(c, { teams: 16 });
  if (s.profile.teams.length !== 16) return 'could not create 16 teams: ' + J(s.error);
  const r = rejected(s, go(c, ctx, s, { type: 'teamCreate' }), 'teams.full', '17th team');
  const r2 = rejected(s, go(c, ctx, s, { type: 'teamDuplicate', teamId: s.profile.teams[0].id }), 'teams.full', 'duplicate at the limit');
  return r !== true ? r : r2;
});
add('state/team/create-validates-name-and-ruleset', (c) => {
  const { s, ctx } = fresh(c, { teams: 0 });
  const r = [
    rejected(s, go(c, ctx, s, { type: 'teamCreate', name: '' }), 'name.empty', 'empty'),
    rejected(s, go(c, ctx, s, { type: 'teamCreate', name: 'SEVENTEEN CHARS!!' }), 'name.text.length', 'long'),
    rejected(s, go(c, ctx, s, { type: 'teamCreate', ruleset: 'nonsense' }), 'ruleset.unknown', 'unknown ruleset'),
    rejected(s, go(c, ctx, s, { type: 'teamCreate', ruleset: STD + '+lv5+lv100' }), 'ruleset.unknown', 'conflicting layers'),
  ];
  const good = go(c, ctx, s, { type: 'teamCreate', name: 'SIXTEEN CHARS!!!', ruleset: STD + '+item-clause+lv100' });
  if (good.error) return 'a 16-character team name was refused: ' + J(good.error);
  return r.find((x) => x !== true) || (good.profile.teams[0].ruleset === STD + '+lv100+item-clause' ? true : 'ruleset not canonicalised: ' + good.profile.teams[0].ruleset);
});
add('state/team/rename', (c) => {
  const { s, ctx } = fresh(c);
  const id = s.profile.teams[0].id;
  const a = go(c, ctx, s, { type: 'teamRename', teamId: id, name: 'RAIN DANCE' });
  if (a.error || a.profile.teams[0].name !== 'RAIN DANCE') return J(a.error);
  return [rejected(s, go(c, ctx, s, { type: 'teamRename', teamId: id, name: '' }), 'name.empty', 'empty'), rejected(s, go(c, ctx, s, { type: 'teamRename', teamId: 'nope', name: 'X' }), 'team.missing', 'missing')].find((x) => x !== true) || true;
});
add('state/team/duplicate-clones-the-mons-with-new-ids-and-sits-after-the-original', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD, 9], { teams: 2 });
  const first = f.s.profile.teams[0];
  const s2 = go(c, f.ctx, f.s, { type: 'teamDuplicate', teamId: first.id });
  if (s2.error) return J(s2.error);
  const tm = s2.profile.teams;
  const copy = tm[1];
  if (tm.length !== 3 || copy.id === first.id || copy.name === first.name || copy.ruleset !== first.ruleset || s2.result.teamId !== copy.id) return 'team list ' + J(tm.map((x) => [x.id, x.name]));
  if (copy.monIds.length !== 3 || copy.monIds.some((id) => first.monIds.includes(id))) return 'mon ids were shared';
  const strip = (m) => { const o = clone(m); delete o.id; delete o.createdAt; delete o.updatedAt; return o; };
  const same = copy.monIds.every((id, i) => J(strip(monOf(s2, id))) === J(strip(monOf(f.s, first.monIds[i]))));
  return same && s2.profile.box.length === f.s.profile.box.length + 3 ? true : 'copied mons differ from the originals';
});
add('state/team/delete-removes-its-mons-but-keeps-a-mon-another-team-uses', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD], { teams: 2 });
  // share Pikachu with team 2 (what a profile merge can produce)
  const shared = f.monIds[0];
  const p = clone(f.s.profile);
  p.teams[1].monIds = [shared];
  const s = { ...f.s, profile: p };
  const s2 = go(c, f.ctx, s, { type: 'teamDelete', teamId: p.teams[0].id });
  if (s2.error) return J(s2.error);
  const ids = s2.profile.box.map((m) => m.id);
  return s2.profile.teams.length === 1 && ids.length === 1 && ids[0] === shared ? true : 'box after delete ' + J(ids);
});
add('state/team/move-reorders-and-clamps', (c) => {
  const { s, ctx } = fresh(c, { teams: 3 });
  const [a, b, d] = s.profile.teams.map((x) => x.id);
  const s0 = go(c, ctx, s, { type: 'teamMove', teamId: a, to: 1 });
  if (J(s0.profile.teams.map((x) => x.id)) !== J([b, a, d])) return 'move to the middle ' + J(s0.profile.teams.map((x) => x.name));
  const s1 = s;
  const s2 = go(c, ctx, s1, { type: 'teamMove', teamId: a, to: 99 });
  const none = go(c, ctx, s2, { type: 'teamMove', teamId: a, to: 2 });
  return [rejected(s, go(c, ctx, s, { type: 'teamMove', teamId: a, to: 1.5 }), 'value.not-integer', 'fraction'), rejected(s, go(c, ctx, s, { type: 'teamMove', teamId: 'x', to: 0 }), 'team.missing', 'missing')].find((x) => x !== true)
    || (J(s2.profile.teams.map((x) => x.id)) === J([b, d, a]) && none.profile === s2.profile ? true : 'clamp or no-op');
});

// ================================ state: adding mons
add('state/mon/add-makes-a-legal-starter-under-every-preset', (c) => {
  const rng = mulberry32(5);
  for (const rs of PRESETS) {
    const f = fresh(c, { teamRuleset: rs });
    let s = f.s;
    const teamId = s.profile.teams[0].id;
    const excluded = new Set(c.R.engineExcludedSpecies(pack, rs).map((e) => e.id));
    for (let i = 0; i < 40; i++) {
      const sid = pack.roster[Math.floor(rng() * pack.roster.length)];
      if (excluded.has(sid)) continue;
      const next = go(c, f.ctx, { ...s, profile: { ...s.profile, teams: [{ ...s.profile.teams[0], monIds: [] }], box: [] } }, { type: 'monAdd', teamId, species: sid });
      if (next.error) return `${rs} species ${sid}: ${J(next.error)}`;
      const m = next.profile.box[0];
      const v = c.P.validateStoredMon(m, pack, rs);
      if (!v.ok) return `${rs} species ${sid}: starter is not legal: ${J(v.reasons[0])}`;
    }
  }
  return true;
});
add('state/mon/add-refuses-species-the-engine-layer-excludes-with-rules-js-codes', (c) => {
  const f = fresh(c);
  const teamId = f.s.profile.teams[0].id;
  const ex = c.R.engineExcludedSpecies(pack, STD);
  if (ex.length < 1) return 'rules.js excludes no species at all right now; this check has nothing to prove (the engine layer may have been switched off)';
  const seen = new Set();
  for (const e of ex.slice(0, 30)) {
    const want = 'species.engine-' + e.why;
    seen.add(want);
    const r = rejected(f.s, go(c, f.ctx, f.s, { type: 'monAdd', teamId, species: e.id }), want, 'excluded species ' + e.id);
    if (r !== true) return r;
    if (!c.R.RULE_CODES[want]) return 'rules.js has no RULE_CODES text for ' + want;
    const sw = withMons(c, [PIKACHU]);
    const r2 = rejected(sw.s, go(c, sw.ctx, sw.s, { type: 'monSet', monId: sw.monIds[0], field: 'species', value: e.id }), want, 'species change to ' + e.id);
    if (r2 !== true) return r2;
  }
  // a ruleset OBJECT with the engine layer off (rules.js allows this for engine tests) excludes nothing
  const off = (rid) => { const o = clone(c.R.resolveRuleset(rid)); o.engine = { enforce: false }; return o; };
  const ok2 = go(c, { ...f.ctx, resolve: off }, f.s, { type: 'monAdd', teamId, species: ex[0].id });
  return ok2.error ? 'with the engine layer off the species was still refused: ' + J(ok2.error) : true;
});
add('state/mon/add-respects-the-team-size-and-the-roster', (c) => {
  const f = withMons(c, [1, 4, 7, 25, 133, 150]);
  if (f.monIds.length !== 6) return 'could not fill a team: ' + J(f.s.error);
  const r1 = rejected(f.s, go(c, f.ctx, f.s, { type: 'monAdd', teamId: f.teamId, species: 6 }), 'team.full', 'seventh');
  const g = fresh(c);
  const gid = g.s.profile.teams[0].id;
  const expectCode = (sp) => (Number.isInteger(sp) && pack.species[sp] ? 'species.illegal' : 'species.unknown');
  for (const sp of [0, 1578, 99999, -1, 2.5, '25', null]) { const r = rejected(g.s, go(c, g.ctx, g.s, { type: 'monAdd', teamId: gid, species: sp }), expectCode(sp), 'species ' + J(sp)); if (r !== true) return r; }
  const banning = (rid) => { const o = clone(c.R.resolveRuleset(rid)); o.banned.species = [PIKACHU]; return o; };
  const rb = rejected(g.s, go(c, { ...g.ctx, resolve: banning }, g.s, { type: 'monAdd', teamId: gid, species: PIKACHU }), 'species.banned', 'banned species');
  return r1 !== true ? r1 : rb;
});
add('state/mon/starter-defaults-follow-the-ruleset', (c) => {
  const std = withMons(c, [PIKACHU]);
  const champ = withMons(c, [PIKACHU], { teamRuleset: CHAMP });
  const a = monOf(std.s, std.monIds[0]), b = monOf(champ.s, champ.monIds[0]);
  if (a.level !== 100 || J(a.iv) !== J(statBlock(31)) || J(a.ev) !== J(statBlock(0))) return 'standard starter ' + J([a.level, a.iv, a.ev]);
  if (b.level !== 50 || J(b.iv) !== J(statBlock(31)) || J(b.ev) !== J(statBlock(0))) return 'champions starter ' + J([b.level, b.iv, b.ev]);
  return a.gender === 'M' && a.moves.length >= 1 && a.nature === 0 && a.heldItem === 0 ? true : 'starter fields ' + J(a);
});
add('state/mon/remove-reorder-duplicate', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD, 9]);
  const [a, b, d] = f.monIds;
  const mv = go(c, f.ctx, f.s, { type: 'monMove', teamId: f.teamId, monId: d, to: 0 });
  if (J(mv.profile.teams[0].monIds) !== J([d, a, b])) return 'order ' + J(mv.profile.teams[0].monIds);
  const dup = go(c, f.ctx, f.s, { type: 'monDuplicate', teamId: f.teamId, monId: a });
  if (dup.error || dup.profile.teams[0].monIds.length !== 4 || dup.profile.teams[0].monIds[1] !== dup.result.monId || dup.result.monId === a) return 'duplicate ' + J(dup.error || dup.profile.teams[0].monIds);
  const rm = go(c, f.ctx, f.s, { type: 'monRemove', teamId: f.teamId, monId: b });
  if (rm.error || rm.profile.teams[0].monIds.length !== 2 || rm.profile.box.some((m) => m.id === b)) return 'remove left the record in the box';
  const full = withMons(c, [1, 4, 7, 25, 133, 150]);
  return [rejected(f.s, go(c, f.ctx, f.s, { type: 'monRemove', teamId: f.teamId, monId: 'nope' }), 'mon.missing', 'remove missing'),
    rejected(full.s, go(c, full.ctx, full.s, { type: 'monDuplicate', teamId: full.teamId, monId: full.monIds[0] }), 'team.full', 'duplicate into a full team')].find((x) => x !== true) || true;
});

// ================================ state: single-field edits
add('state/field/level-clamps-integers-and-rejects-everything-else', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const set = (v) => go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'level', value: v });
  if (monOf(set(37), id).level !== 37) return 'level 37';
  const hi = set(500), lo = set(-4);
  if (monOf(hi, id).level !== 100 || hi.notice.code !== 'clamped' || monOf(lo, id).level !== 1) return 'clamp ' + J([monOf(hi, id).level, monOf(lo, id).level]);
  for (const v of [1.5, NaN, Infinity, '50', null, undefined, {}, [50]]) { const r = rejected(f.s, set(v), 'value.not-integer', 'level ' + String(v)); if (r !== true) return r; }
  return true;
});
add('state/field/the-champions-layer-fixes-the-level-ivs-and-locks-evs-to-points', (c) => {
  const f = withMons(c, [PIKACHU], { teamRuleset: CHAMP });
  const id = f.monIds[0];
  const r = [
    rejected(f.s, go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'level', value: 60 }), 'level.fixed', 'level'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'ivSet', monId: id, stat: 'atk', value: 0 }), 'iv.fixed', 'iv'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'ivPreset', monId: id, preset: 'all0' }), 'iv.fixed', 'iv preset'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'atk', value: 100, mode: 'ev' }), 'ev.locked', 'classic ev'),
  ];
  const same = go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'level', value: 50 });
  return r.find((x) => x !== true) || (same.error ? 'the fixed level itself was refused: ' + J(same.error) : true);
});
add('state/field/nature-ability-gender-shiny-friendship-nickname', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const set = (field, value) => go(c, f.ctx, f.s, { type: 'monSet', monId: id, field, value });
  const n = set('nature', 3);
  if (monOf(n, id).nature !== 3) return 'nature';
  const bad = [
    rejected(f.s, set('nature', 25), 'nature.range', 'nature 25'), rejected(f.s, set('nature', -1), 'nature.range', 'nature -1'), rejected(f.s, set('nature', 1.5), 'nature.range', 'nature 1.5'),
    rejected(f.s, set('abilitySlot', 1), 'ability.slot-empty', 'Pikachu has no second ability'), rejected(f.s, set('abilitySlot', 3), 'ability.slot-range', 'slot 3'),
    rejected(f.s, set('gender', '-'), 'gender.species', 'genderless Pikachu'), rejected(f.s, set('shiny', 'yes'), 'shiny.type', 'shiny'),
    rejected(f.s, set('nickname', 'WAYTOOLONGNAME'), 'nickname.text.length', 'nickname'), rejected(f.s, set('nope', 1), 'field.unknown', 'field'),
  ].find((x) => x !== true);
  if (bad) return bad;
  const a = set('abilitySlot', 2), g = set('gender', 'F'), sh = set('shiny', true), fr = set('friendship', 999), nn = set('nickname', 'ZAP');
  if (a.error || monOf(a, id).abilitySlot !== 2) return 'hidden slot ' + J(a.error);
  return monOf(g, id).gender === 'F' && monOf(sh, id).shiny === true && monOf(fr, id).friendship === 255 && monOf(nn, id).nickname === 'ZAP' ? true : 'a field was not applied';
});
add('state/field/held-item-is-checked-against-the-item-table-and-the-rules', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const set = (v, ctx = f.ctx) => go(c, ctx, f.s, { type: 'monSet', monId: id, field: 'heldItem', value: v });
  const leftovers = pack.items.find((i) => i.name === 'Leftovers').id;
  if (monOf(set(leftovers), id).heldItem !== leftovers) return 'Leftovers';
  const r = [rejected(f.s, set(99999), 'item.unknown', 'item 99999'), rejected(f.s, set(-1), 'item.unknown', 'item -1'), rejected(f.s, set('1'), 'item.unknown', 'item "1"')].find((x) => x !== true);
  if (r) return r;
  // a ruleset that bans Leftovers (handed in through the test seam): the reducer must surface rules.js's own code
  const banning = (rid) => { const R = c.R.resolveRuleset(rid); const o = clone(R); o.banned.items = [leftovers]; return o; };
  const banned = set(leftovers, { ...f.ctx, resolve: banning });
  return rejected(f.s, banned, 'item.banned', 'banned item');
});

// ================================ state: moves
add('state/moves/set-append-clear', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const tb = pack.moves.findIndex((m) => m && m.name === 'Thunderbolt');
  const s1 = go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: tb });
  if (s1.error || monOf(s1, id).moves.length !== 2 || monOf(s1, id).moves[1].id !== tb) return 'append ' + J(s1.error);
  const s2 = go(c, f.ctx, s1, { type: 'moveSet', monId: id, slot: 0, moveId: null });
  if (s2.error || monOf(s2, id).moves.length !== 1 || monOf(s2, id).moves[0].id !== tb) return 'clear ' + J(s2.error);
  return rejected(s2, go(c, f.ctx, s2, { type: 'moveSet', monId: id, slot: 0, moveId: null }), 'moves.min', 'clearing the last move');
});
add('state/moves/rejections-carry-the-rules-code', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const first = monOf(f.s, id).moves[0].id;
  const hydro = pack.moves.findIndex((m) => m && m.name === 'Hydro Cannon');
  const r = [
    rejected(f.s, go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: first }), 'move.duplicate', 'duplicate'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: 99999 }), 'move.unknown', 'unknown'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: 1.5 }), 'move.unknown', 'fraction'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 3, moveId: first + 1 }), 'move.slot', 'a gap in the slots'),
    rejected(f.s, go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: hydro }), 'move.illegal', 'a move Pikachu cannot learn'),
  ].find((x) => x !== true);
  if (r) return r;
  const e = go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: hydro }).error;
  return e.why === 'not-learnable' ? true : 'the why detail was lost: ' + J(e);
});
add('state/moves/the-level-gate-is-asked-of-rules-js', (c) => {
  // lowest level a move is learnable at, per the pack, for the first species that has a level-up move above level 1
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const sp = pack.species[PIKACHU];
  const late = sp.levelUp.filter(([mv, lv]) => lv >= 30 && !sp.teachable.includes(mv) && !sp.eggMoves.includes(mv)).sort((a, b) => b[1] - a[1])[0];
  if (!late) return 'no late level-up-only move found for Pikachu';
  const low = go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'level', value: 5 });
  const r = go(c, f.ctx, low, { type: 'moveSet', monId: id, slot: 1, moveId: late[0] });
  if (!r.error || r.error.code !== 'move.illegal' || r.error.why !== 'level-too-low' || r.error.needLevel !== late[1]) return 'low level: ' + J(r.error);
  const hi = go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: late[0] });
  return hi.error ? 'level 100 refused it: ' + J(hi.error) : true;
});
add('state/moves/reorder', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const ids = [85, 98, 87].filter((m) => c.D.moveStatuses(pack, c.P.toRulesRec(monOf(f.s, id), STD), [m], STD)[m].ok);
  let s = f.s;
  ids.forEach((m, i) => { s = go(c, f.ctx, s, { type: 'moveSet', monId: id, slot: monOf(s, id).moves.length, moveId: m }); });
  const before = monOf(s, id).moves.map((x) => x.id);
  const r = go(c, f.ctx, s, { type: 'moveReorder', monId: id, from: 0, to: before.length - 1 });
  const after = monOf(r, id).moves.map((x) => x.id);
  return J(after) === J([...before.slice(1), before[0]]) && rejected(s, go(c, f.ctx, s, { type: 'moveReorder', monId: id, from: 0, to: 9 }), 'move.slot', 'to out of range') === true ? true : J([before, after]);
});
add('state/species/change-clears-a-dead-ability-slot', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const target = pack.roster.find((x) => pack.species[x].abilities[2] === 0 && pack.species[x].abilities[0] !== 0);
  let s = go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'abilitySlot', value: 2 });
  s = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'species', value: target });
  if (s.error) return J(s.error);
  const m = monOf(s, id);
  return pack.species[target].abilities[m.abilitySlot] !== 0 && c.P.validateStoredMon(m, pack, STD).ok ? true : 'slot ' + m.abilitySlot + ' of species ' + target + ' is empty or the mon is illegal';
});
add('state/species/change-keeps-learnable-moves-fixes-ability-and-gender', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const tb = pack.moves.findIndex((m) => m && m.name === 'Thunderbolt');
  let s = go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: tb });
  s = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'abilitySlot', value: 2 });
  const s2 = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'species', value: CHARIZARD });
  if (s2.error) return J(s2.error);
  const m = monOf(s2, id);
  const v = c.P.validateStoredMon(m, pack, STD);
  if (!v.ok) return 'the result is not legal: ' + J(v.reasons[0]);
  // Thunderbolt is a TM Charizard learns in this ROM or it is dropped; either way the result must be legal and non-empty. Gender follows the ratio.
  const nogender = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'species', value: pack.roster.find((x) => pack.species[x].genderRatio === 255) });
  return m.species === CHARIZARD && m.moves.length >= 1 && monOf(nogender, id).gender === '-' && c.P.validateStoredMon(monOf(nogender, id), pack, STD).ok ? true : 'species change ' + J([m, monOf(nogender, id)]);
});
add('state/species/rejects-unknown-illegal-and-banned', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const set = (v, ctx = f.ctx) => go(c, ctx, f.s, { type: 'monSet', monId: id, field: 'species', value: v });
  const banning = (rid) => { const o = clone(c.R.resolveRuleset(rid)); o.banned.species = [CHARIZARD]; return o; };
  const code0 = pack.species[0] ? 'species.illegal' : 'species.unknown';
  return [rejected(f.s, set(0), code0, 'species 0'), rejected(f.s, set(1578), pack.species[1578] ? 'species.illegal' : 'species.unknown', 'the egg slot'), rejected(f.s, set(99999), 'species.unknown', 'species 99999'), rejected(f.s, set('6'), 'species.unknown', 'species "6"'),
    rejected(f.s, set(CHARIZARD, { ...f.ctx, resolve: banning }), 'species.banned', 'banned species')].find((x) => x !== true) || true;
});

// ================================ state: EVs / points / IVs
add('state/ev/classic-clamps-per-stat-and-to-the-510-total-with-a-notice', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = f.s;
  const ev = (stat, v) => { s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat, value: v, mode: 'ev' }); return s; };
  ev('atk', 252); ev('spe', 252);
  if (monOf(s, id).ev.atk !== 252) return 'atk';
  const r = ev('hp', 255);
  if (monOf(r, id).ev.hp !== 6 || r.notice.code !== 'clamped') return 'total cap: hp became ' + monOf(r, id).ev.hp;
  const big = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'def', value: 9999, mode: 'ev' });
  const neg = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: -5, mode: 'ev' });
  if (monOf(big, id).ev.def !== 255 || monOf(neg, id).ev.atk !== 0) return 'per-stat clamp';
  const sum = Object.values(monOf(r, id).ev).reduce((a, b) => a + b, 0);
  return sum === 510 ? true : 'total ' + sum;
});
add('state/ev/non-integers-and-unknown-stats-are-rejected', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  for (const v of [1.5, NaN, '100', null, undefined, Infinity]) { const r = rejected(f.s, go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'atk', value: v, mode: 'ev' }), 'value.not-integer', 'ev ' + String(v)); if (r !== true) return r; }
  return [rejected(f.s, go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'speed', value: 4, mode: 'ev' }), 'stat.unknown', 'stat name'), rejected(f.s, go(c, f.ctx, f.s, { type: 'evSet', monId: 'nope', stat: 'atk', value: 4 }), 'mon.missing', 'missing mon')].find((x) => x !== true) || true;
});
add('state/ev/points-and-evs-stay-linked-for-every-points-value', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  for (let p = 0; p <= 32; p++) {
    const s = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'spe', value: p, mode: 'points' });
    if (s.error) return `points ${p}: ${J(s.error)}`;
    const ev = monOf(s, id).ev.spe;
    if (ev !== c.ST.pointsToEv(p, 31) || c.ST.evToPoints(ev, 31) !== p) return `points ${p} -> ev ${ev} -> points ${c.ST.evToPoints(ev, 31)}`;
  }
  const typed = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'spe', value: 252, mode: 'ev' });
  const d = c.D.derived(pack, monOf(typed, id), STD);
  return d.points.spe === 32 && c.ST.pointsToEv(32, 31) === 252 ? true : 'ev 252 reads as ' + d.points.spe + ' points';
});
add('state/ev/the-points-view-respects-an-even-iv', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = go(c, f.ctx, f.s, { type: 'ivSet', monId: id, stat: 'atk', value: 30 });
  s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: 1, mode: 'points' });
  const ev = monOf(s, id).ev.atk;
  return ev === c.ST.pointsToEv(1, 30) && ev === 8 ? true : 'one point at IV 30 costs ' + ev + ' EV (want 8)';
});
add('state/ev/champions-points-cap-at-32-per-stat-and-66-total-and-stay-on-the-4-then-8-grid', (c) => {
  const f = withMons(c, [PIKACHU], { teamRuleset: CHAMP });
  const id = f.monIds[0];
  let s = f.s;
  const pt = (stat, v) => { s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat, value: v, mode: 'points' }); return s; };
  pt('hp', 32); pt('atk', 32);
  const third = pt('spe', 32);
  const m = monOf(third, id);
  if (c.ST.evToPoints(m.ev.spe, 31) !== 2 || third.notice.code !== 'clamped') return 'total cap: spe points ' + c.ST.evToPoints(m.ev.spe, 31);
  const v = c.P.validateStoredMon(m, pack, CHAMP);
  if (!v.ok) return 'not legal: ' + J(v.reasons[0]);
  const over = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'def', value: 33, mode: 'points' });
  return c.ST.evToPoints(monOf(over, id).ev.def, 31) === 32 ? true : 'per-stat cap';
});
add('state/ev/snap-to-minimum', (c) => {
  const f = withMons(c, [PIKACHU], { teamRuleset: STD });
  const id = f.monIds[0];
  const s = go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'level', value: 50 });
  const e = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: 255, mode: 'ev' });
  const sn = go(c, f.ctx, e, { type: 'evSnap', monId: id });
  if (monOf(sn, id).ev.atk !== 252 || sn.result.saved !== 3 || sn.notice.code !== 'snapped') return 'snap ' + J([monOf(sn, id).ev.atk, sn.result, sn.notice]);
  const again = go(c, f.ctx, sn, { type: 'evSnap', monId: id });
  const champ = withMons(c, [PIKACHU], { teamRuleset: CHAMP });
  const cs = go(c, champ.ctx, champ.s, { type: 'evSnap', monId: champ.monIds[0] });
  return again.profile === sn.profile && again.notice.code === 'snap.nothing' && cs.profile === champ.s.profile && cs.notice.code === 'snap.points' ? true : 'idempotence or the points layer';
});
add('state/ev/snap-uses-the-battle-level-not-the-mons-own', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  if (monOf(f.s, id).level !== 100) return 'the starter is expected to be level 100 under the standard rules';
  const e = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'atk', value: 250, mode: 'ev' });
  const sn = go(c, f.ctx, e, { type: 'evSnap', monId: id });
  // battles run at 50: 250 EV (q = 62) buys 31 points, and q = 61 (244 EV) already buys 31; at level 100 the answer would be 248
  const want = c.ST.snapEvToMinimum(250, { stat: 'atk', base: pack.species[PIKACHU].baseStats.atk, iv: 31, level: 50, mod: 0 });
  return want === 244 && monOf(sn, id).ev.atk === 244 && sn.result.saved === 6 ? true : 'snapped to ' + monOf(sn, id).ev.atk + ' (want 244 at battle level 50)';
});
add('state/ev/reset', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const e = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'atk', value: 200, mode: 'ev' });
  const r = go(c, f.ctx, e, { type: 'evReset', monId: id });
  return J(monOf(r, id).ev) === J(statBlock(0)) ? true : J(monOf(r, id).ev);
});
add('state/iv/set-clamps-and-presets', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const iv = (stat, v) => go(c, f.ctx, f.s, { type: 'ivSet', monId: id, stat, value: v });
  if (monOf(iv('def', 12), id).iv.def !== 12 || monOf(iv('def', 99), id).iv.def !== 31 || monOf(iv('def', -3), id).iv.def !== 0) return 'iv clamp';
  const bad = [rejected(f.s, iv('def', 1.2), 'value.not-integer', 'fraction'), rejected(f.s, iv('def', '5'), 'value.not-integer', 'string'), rejected(f.s, iv('mana', 5), 'stat.unknown', 'stat')].find((x) => x !== true);
  if (bad) return bad;
  const p = (preset) => monOf(go(c, f.ctx, f.s, { type: 'ivPreset', monId: id, preset }), id).iv;
  if (J(p('all0')) !== J(statBlock(0)) || J(p('all31')) !== J(statBlock(31))) return 'all0/all31';
  const za = p('zeroAtk'), zs = p('zeroSpe'), zas = p('zeroAtkSpe');
  if (za.atk !== 0 || za.spe !== 31 || zs.spe !== 0 || zs.atk !== 31 || zas.atk !== 0 || zas.spe !== 0 || zas.hp !== 31) return 'zero presets';
  return rejected(f.s, go(c, f.ctx, f.s, { type: 'ivPreset', monId: id, preset: 'bogus' }), 'ivpreset.unknown', 'unknown preset');
});
add('state/iv/hidden-power-presets-round-trip-for-all-16-types', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  for (const ty of c.ST.HIDDEN_POWER_TYPES) {
    const s = go(c, f.ctx, f.s, { type: 'ivPreset', monId: id, preset: 'hp:' + ty.name });
    if (s.error) return ty.name + ': ' + J(s.error);
    const d = c.D.derived(pack, monOf(s, id), STD);
    if (d.hiddenPower.type !== ty.name || d.hiddenPower.typeId !== ty.id) return `${ty.name}: derived ${J(d.hiddenPower)}`;
  }
  return rejected(f.s, go(c, f.ctx, f.s, { type: 'ivPreset', monId: id, preset: 'hp:Fairy' }), 'ivpreset.unknown', 'Fairy is not a Hidden Power type');
});

// ================================ state: undo / redo
add('state/undo/twenty-edits-and-no_more', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = f.s;
  const base = s;
  for (let i = 1; i <= 25; i++) s = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'friendship', value: i });
  if (s.undo.length !== 20) return 'undo depth ' + s.undo.length;
  for (let i = 0; i < 20; i++) s = go(c, f.ctx, s, { type: 'undo' });
  if (monOf(s, id).friendship !== 5) return 'after 20 undos friendship is ' + monOf(s, id).friendship + ' (want 5: the 5th edit is the oldest undo target)';
  const none = go(c, f.ctx, s, { type: 'undo' });
  return rejected(s, none, 'undo.empty', 'undo past the limit') === true && base.profile.box[0].friendship === 70 ? true : 'depth';
});
add('state/undo/redo-replays-and-a-new-edit-clears-it', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'nature', value: 3 });
  s = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'nature', value: 5 });
  const u = go(c, f.ctx, s, { type: 'undo' });
  if (monOf(u, id).nature !== 3 || !c.S.canRedo(u) || !/undid/.test(u.notice.message)) return 'undo';
  const r = go(c, f.ctx, u, { type: 'redo' });
  if (monOf(r, id).nature !== 5 || c.S.canRedo(r)) return 'redo';
  const again = go(c, f.ctx, u, { type: 'monSet', monId: id, field: 'nature', value: 9 });
  return !c.S.canRedo(again) && rejected(r, go(c, f.ctx, r, { type: 'redo' }), 'redo.empty', 'redo at the end') === true ? true : 'a new edit kept the redo stack';
});
add('state/undo/one-drag-is-one-undo-step', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = f.s;
  for (let v = 0; v <= 200; v += 4) s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: v, mode: 'ev', coalesce: 'drag:atk' });
  if (s.undo.length !== f.s.undo.length + 1) return 'a drag made ' + (s.undo.length - f.s.undo.length) + ' undo entries';
  const other = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'def', value: 40, mode: 'ev', coalesce: 'drag:def' });
  const u = go(c, f.ctx, s, { type: 'undo' });
  return other.undo.length === s.undo.length + 1 && monOf(u, id).ev.atk === 0 ? true : 'a different key must start a new step; undo of the drag must restore the value before it';
});
add('state/undo/a-different-action-between-two-same-key-edits-breaks-the-group', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'atk', value: 4, mode: 'ev', coalesce: 'k' });
  s = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'nature', value: 2 });
  const n = s.undo.length;
  s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: 8, mode: 'ev', coalesce: 'k' });
  return s.undo.length === n + 1 ? true : 'edits separated by another action were merged';
});
add('state/undo/restores-teams-and-box-but-never-the-identity-or-the-rev', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD]);
  let s = go(c, f.ctx, f.s, { type: 'teamDelete', teamId: f.teamId });
  if (s.profile.box.length !== 0) return 'delete did not empty the box';
  const jwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
  s = go(c, f.ctx, s, { type: 'setIdentity', identity: { publicKeyJwk: jwk, previousKeys: [] } });
  s = go(c, f.ctx, s, { type: 'saved', rev: 7, seq: s.seq, updatedAt: 1234 });
  const u = go(c, f.ctx, s, { type: 'undo' });
  return u.profile.teams.length === 1 && u.profile.box.length === 2 && u.profile.identity.publicKeyJwk.x === 'A'.repeat(43) && u.profile.rev === 7 && u.profile.updatedAt === 1234 ? true : 'undo rolled back something it must not';
});
add('state/undo/an-undone-edit-is-dirty-again', (c) => {
  const f = withMons(c, [PIKACHU]);
  let s = go(c, f.ctx, f.s, { type: 'monSet', monId: f.monIds[0], field: 'nature', value: 3 });
  s = go(c, f.ctx, s, { type: 'saved', rev: 2, seq: s.seq });
  if (c.S.isDirty(s)) return 'dirty right after saved';
  const u = go(c, f.ctx, s, { type: 'undo' });
  return c.S.isDirty(u) ? true : 'undo after a save must mark the document as needing a save';
});
add('state/save/saved-bookkeeping', (c) => {
  const f = withMons(c, [PIKACHU]);
  let s = go(c, f.ctx, f.s, { type: 'monSet', monId: f.monIds[0], field: 'nature', value: 3 });
  const seqAtSave = s.seq;
  s = go(c, f.ctx, s, { type: 'monSet', monId: f.monIds[0], field: 'nature', value: 4 }); // edited while the write was in flight
  const a = go(c, f.ctx, s, { type: 'saved', rev: 9, seq: seqAtSave });
  if (a.profile.rev !== 9 || !c.S.isDirty(a) || monOf(a, f.monIds[0]).nature !== 4) return 'an edit made during the save was lost or marked clean';
  const b = go(c, f.ctx, a, { type: 'saved', rev: 10, seq: a.seq });
  return !c.S.isDirty(b) && b.profile.rev === 10 && rejected(b, go(c, f.ctx, b, { type: 'saved', rev: 11, seq: b.seq + 5 }), 'saved.shape', 'saved for the future') === true ? true : 'second save';
});
add('state/readonly/a-newer-document-cannot-be-edited', (c) => {
  const p = c.P.createProfile({}, detDeps());
  const s = c.S.initialState(p, { readOnly: true });
  const r = [{ type: 'rename', name: 'X' }, { type: 'teamCreate' }, { type: 'undo' }].map((a) => go(c, { pack }, s, a));
  return rejected(s, r[0], 'profile.readonly', 'rename') === true && rejected(s, r[1], 'profile.readonly', 'teamCreate') === true && r[2].error ? true : 'a read-only profile accepted an edit';
});

// ================================ state: rules panel, switch, conform
add('state/rules/parse-and-build-ids-round-trip', (c) => {
  for (const mode of c.S.LEVEL_MODES) for (const itemClause of [false, true]) for (const noSpeciesClause of [false, true]) {
    const id = c.S.buildRulesetId({ mode, itemClause, noSpeciesClause });
    const p = c.S.parseRulesetId(id);
    if (p.mode !== mode || p.itemClause !== itemClause || p.noSpeciesClause !== noSpeciesClause || p.unknown.length) return `${id} -> ${J(p)}`;
    if (c.S.buildRulesetId(p) !== id) return 'not stable ' + id;
    if (!c.S.rulesetLabel(id)) return 'no label';
  }
  let threw = false;
  try { c.S.parseRulesetId('nope'); } catch (_e) { threw = true; }
  return threw ? true : 'parseRulesetId accepted an unknown id';
});
add('state/rules/switching-changes-only-the-id-and-conform-fixes-it', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD, 9]);
  let s = f.s;
  const id = f.monIds[0];
  s = go(c, f.ctx, s, { type: 'monSet', monId: id, field: 'level', value: 77 });
  s = go(c, f.ctx, s, { type: 'ivPreset', monId: id, preset: 'zeroAtk' });
  s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'hp', value: 255, mode: 'ev' });
  s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: 255, mode: 'ev' });
  const boxBefore = J(s.profile.box);
  const sw = go(c, f.ctx, s, { type: 'teamRuleset', teamId: f.teamId, ruleset: CHAMP });
  if (sw.error || sw.profile.teams[0].ruleset !== CHAMP || J(sw.profile.box) !== boxBefore) return 'switch changed more than the id';
  const bad = c.D.validationView(pack, c.S.teamMonsOf(sw.profile, f.teamId), CHAMP);
  const codes = new Set(bad.mons[0].map((p) => p.code));
  if (bad.ok || !codes.has('level.fixed') || !codes.has('iv.fixed')) return 'validation after the switch ' + J([...codes]);
  const fix = go(c, f.ctx, sw, { type: 'teamConform', teamId: f.teamId });
  if (fix.error) return J(fix.error);
  const after = c.D.validationView(pack, c.S.teamMonsOf(fix.profile, f.teamId), CHAMP);
  const m = monOf(fix, id);
  if (!after.ok) return 'still invalid after conform: ' + J(after.mons.flat().concat(after.team).slice(0, 2));
  const again = go(c, f.ctx, fix, { type: 'teamConform', teamId: f.teamId });
  return m.level === 50 && J(m.iv) === J(statBlock(31)) && again.notice.code === 'conform.nothing' && again.profile === fix.profile ? true : 'conform result ' + J([m.level, m.iv, m.ev]);
});
add('state/rules/conform-always-produces-a-legal-mon-under-every-preset-fuzz', (c) => {
  const rng = mulberry32(77);
  const n = 120 * FUZZ;
  for (let i = 0; i < n; i++) {
    const sid = pack.roster[Math.floor(rng() * pack.roster.length)];
    const target = PRESETS[Math.floor(rng() * PRESETS.length)];
    const R = c.R.resolveRuleset(target);
    let rec;
    try { rec = c.R.blankRec(sid, pack, STD); } catch (_e) { continue; }
    const ev = {}, iv = {};
    for (const k of c.ST.STAT_ORDER) { ev[k] = Math.floor(rng() * 256); iv[k] = Math.floor(rng() * 32); }
    const moveIds = Object.keys(c.R.learnsetOf(pack, sid, true)).map(Number);
    const moves = [];
    for (let k = 0; k < 1 + Math.floor(rng() * 4) && moveIds.length; k++) { const mv = moveIds[Math.floor(rng() * moveIds.length)]; if (!moves.some((x) => x.id === mv)) moves.push({ id: mv, ppUps: 0 }); }
    const mon = c.P.createMon({ species: sid, level: 1 + Math.floor(rng() * 100), nature: Math.floor(rng() * 25), abilitySlot: rec.abilitySlot, heldItem: Math.floor(rng() * 30), moves, ev, iv, gender: c.D.genderOptions(pack, sid)[0] }, detDeps(i));
    const { mon: fixed } = c.S.conformMon(mon, pack, R, detDeps(i));
    const v = c.P.validateStoredMon(fixed, pack, R);
    if (!v.ok) return `species ${sid} under ${target}: ${J(v.reasons.slice(0, 2))} (from ${J({ level: mon.level, ev: mon.ev, iv: mon.iv, moves: mon.moves })})`;
  }
  return true;
});
add('state/rules/conform-drops-only-moves-that-became-illegal', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const tb = pack.moves.findIndex((m) => m && m.name === 'Thunderbolt');
  let s = go(c, f.ctx, f.s, { type: 'moveSet', monId: id, slot: 1, moveId: tb });
  const sp = pack.species[PIKACHU];
  const late = sp.levelUp.filter(([mv, lv]) => lv >= 30 && !sp.teachable.includes(mv) && !sp.eggMoves.includes(mv)).sort((a, b) => b[1] - a[1])[0];
  s = go(c, f.ctx, s, { type: 'moveSet', monId: id, slot: 2, moveId: late[0] });
  // drop the level through the data layer (the reducer would not allow a level that breaks a move, so edit the document directly)
  const p = clone(s.profile);
  p.box[0].level = 5;
  const { mon } = c.S.conformMon(p.box[0], pack, STD, detDeps());
  const ids = mon.moves.map((x) => x.id);
  return ids.includes(tb) && !ids.includes(late[0]) && ids.length >= 1 ? true : 'moves after conform ' + J(ids);
});
add('state/import/a-decoded-team-becomes-a-new-team-with-its-mons', async (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD], { teams: 1 });
  const code = await c.T.encodeTeamCode(c.T.teamFromProfile(f.s.profile, f.teamId));
  const dec = await c.T.decodeTeamCode(code);
  if (!dec.ok) return J(dec);
  const g = fresh(c, { deps: detDeps(9), teams: 0 });
  const s = go(c, g.ctx, g.s, { type: 'teamImport', team: dec.team });
  if (s.error) return J(s.error);
  const t = s.profile.teams[0];
  const views = t.monIds.map((id) => c.T.battleView(monOf(s, id)));
  const orig = c.S.teamMonsOf(f.s.profile, f.teamId).map(c.T.battleView);
  if (c.ST.canonicalJSON(views) !== c.ST.canonicalJSON(orig) || t.ruleset !== STD || s.result.teamId !== t.id) return 'imported team differs from the source';
  const bad = [
    rejected(g.s, go(c, g.ctx, g.s, { type: 'teamImport', team: { ...dec.team, mons: [] } }), 'import.shape', 'no mons'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'teamImport', team: { ...dec.team, mons: new Array(7).fill(dec.team.mons[0]) } }), 'import.shape', 'seven mons'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'teamImport', team: { ...dec.team, ruleset: 'x' } }), 'ruleset.unknown', 'bad ruleset'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'teamImport', team: { ...dec.team, mons: [{ ...dec.team.mons[0], level: 900 }] } }), 'import.invalid', 'a mon that is not well formed'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'teamImport', team: null }), 'import.shape', 'null'),
  ].find((x) => x !== true);
  return bad || true;
});
add('state/save-import/records-from-a-save-join-the-profile-as-a-new-team-or-an-existing-one', (c) => {
  // W1: the records a SoulGold save yields (saveimport.js, origin 'save-import') are added by the reducer; the screen only chooses WHICH ones and WHERE
  const f = withMons(c, [PIKACHU, CHARIZARD], { teams: 1 });
  const recs = c.S.teamMonsOf(f.s.profile, f.teamId).map((m) => ({ ...clone(m), origin: 'save-import', id: 'sv-' + m.species }));
  const g = fresh(c, { deps: detDeps(11), teams: 0 });
  // 1. a NEW team: named, in the profile's default ruleset, holding fresh ids and the records' content; the box grows by the same count
  const s1 = go(c, g.ctx, g.s, { type: 'saveImport', mons: recs, teamId: null, name: 'ASH PARTY' });
  if (s1.error) return J(s1.error);
  const t1 = s1.profile.teams[0];
  if (t1.name !== 'ASH PARTY' || t1.monIds.length !== 2 || s1.profile.box.length !== 2 || t1.ruleset !== g.s.profile.settings.defaultRuleset) return 'new team: ' + J({ name: t1.name, n: t1.monIds.length, box: s1.profile.box.length, rs: t1.ruleset });
  if (t1.monIds.some((id) => id.startsWith('sv-'))) return 'the records kept the save importer ids (importing twice would collide)';
  const views = t1.monIds.map((id) => c.T.battleView(monOf(s1, id)));
  if (c.ST.canonicalJSON(views) !== c.ST.canonicalJSON(recs.map(c.T.battleView))) return 'the imported Pokemon differ from the records';
  if (!t1.monIds.every((id) => monOf(s1, id).origin === 'save-import')) return 'origin is not save-import';
  if (s1.result.teamId !== t1.id || s1.result.count !== 2) return 'result ' + J(s1.result);
  // 2. importing the same records AGAIN gives distinct ids (no collision), as a second team
  const s2 = go(c, g.ctx, s1, { type: 'saveImport', mons: recs, teamId: null });
  if (s2.error || new Set(s2.profile.box.map((m) => m.id)).size !== 4 || s2.profile.teams[1].name !== 'SAVE PARTY') return 'second import: ' + J(s2.error) + ' ' + s2.profile.box.length;
  // 3. appended to an EXISTING team that has room
  const s3 = go(c, g.ctx, s1, { type: 'saveImport', mons: [recs[0]], teamId: t1.id });
  if (s3.error || s3.profile.teams[0].monIds.length !== 3 || s3.profile.box.length !== 3) return 'append: ' + J(s3.error);
  // 4. refusals: nothing chosen, seven records, a full team, an unknown team, a record the ROM lacks, a malformed record
  const bad = [
    rejected(g.s, go(c, g.ctx, g.s, { type: 'saveImport', mons: [], teamId: null }), 'import.shape', 'no records'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'saveImport', mons: new Array(7).fill(recs[0]), teamId: null }), 'import.shape', 'seven records'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'saveImport', mons: recs, teamId: 'nope' }), 'team.missing', 'unknown team'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'saveImport', mons: [{ ...recs[0], species: 65535 }], teamId: null }), 'species.unknown', 'species 65535'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'saveImport', mons: [{ ...recs[0], level: 900 }], teamId: null }), 'import.invalid', 'level 900'),
    rejected(g.s, go(c, g.ctx, g.s, { type: 'saveImport', mons: null, teamId: null }), 'import.shape', 'null'),
  ].find((x) => x !== true);
  if (bad) return bad;
  const six = go(c, g.ctx, g.s, { type: 'saveImport', mons: new Array(6).fill(recs[0]), teamId: null });
  if (six.error) return 'six records into a new team: ' + J(six.error);
  const full = rejected(six, go(c, g.ctx, six, { type: 'saveImport', mons: [recs[0]], teamId: six.profile.teams[0].id }), 'team.full', 'a team that already has six');
  if (full !== true) return full;
  // 5. undo takes the whole import back in one step
  const u = go(c, g.ctx, s1, { type: 'undo' });
  return u.profile.teams.length === 0 && u.profile.box.length === 0 ? true : 'undo left ' + u.profile.teams.length + ' teams / ' + u.profile.box.length + ' Pokemon';
});
add('import/the-save-import-list-judges-every-pokemon-and-names-every-failure', (c) => {
  // W1: the PURE half of the save-import screen. A hand-made importer answer (3 party, 2 box, 1 refused) is turned into the list a player reads.
  const IM = c.IM;
  const f = withMons(c, [PIKACHU, CHARIZARD], { teams: 1 });
  const [pika, chari] = c.S.teamMonsOf(f.s.profile, f.teamId).map((m) => ({ ...clone(m), origin: 'save-import' }));
  const illegalMove = pack.moves.find((m) => m && m.id > 0 && !c.R.legalMoves(pack, PIKACHU, 50, c.R.resolveRuleset(STD)).includes(m.id)).id;
  const bad = { ...clone(pika), id: 'bad-1', nickname: 'ZAP', moves: [{ id: illegalMove, ppUps: 0 }] };
  const res = {
    ok: true, trainer: { name: 'NOVA', tid: 1, sid: 2, id: 1 }, party: [{ ...pika, id: 'p0' }, bad, { ...chari, id: 'p2' }],
    boxes: [{ index: 0, name: 'BOX 1', current: true, mons: [{ ...chari, id: 'b0' }] }, { index: 1, name: 'BOX 2', current: false, mons: [] }, { index: 2, name: 'RAIDS', current: false, mons: [{ ...pika, id: 'b2' }] }],
    reports: { p0: { notes: [{ code: 'x', message: 'n' }], selfCheck: { matched: 6, total: 6 } } }, warnings: [{ code: 'w', message: 'a warning' }],
    rejected: [{ where: { box: 3, slot: 4 }, species: 9999, code: 'species.unknown', message: 'no such species' }], summary: { statCheck: { statsMatched: 6, statsTotal: 6 } },
  };
  const v = IM.buildImportView(res, pack, STD);
  if (!v.ok || v.groups.map((g) => g.id).join() !== 'party,box-0,box-2') return 'groups ' + J(v.groups && v.groups.map((g) => g.id));
  const party = v.groups[0].rows;
  if (party.map((r) => r.status).join() !== 'legal,fix,legal') return 'party statuses ' + party.map((r) => r.status).join();
  if (!party[1].reasons.length || !party[1].reasons.every((r) => r.code && r.message)) return 'a needs-fixing row has no reasons';
  if (party[0].speciesName !== 'Pikachu' || party[0].level !== pika.level || typeof party[0].natureName !== 'string' || party[0].natureName === '?' || party[1].name !== 'ZAP') return 'row fields ' + J(party[0]);
  if (v.summary.total !== 5 || v.summary.legal !== 4 || v.summary.needsFix !== 1 || v.summary.refused !== 1 || v.summary.party !== 3 || v.summary.boxed !== 2) return 'summary ' + J(v.summary);
  if (v.rejected.length !== 1 || v.rejected[0].label !== 'Box 4, slot 5' || v.rejected[0].code !== 'species.unknown') return 'rejected ' + J(v.rejected);
  // W1 fix D6: the game's default box name ("BOX 1") is not said twice ('Box 1 (BOX 1)'); a name the player gave is shown after the number
  if (v.groups[1].title !== 'Box 1' || v.groups[2].title !== 'Box 3 (RAIDS)') return 'titles ' + J(v.groups.map((g) => g.title));
  if (party[1].reasons.some((r) => r.message === r.code || /^[a-z]+\.[a-z-]+$/.test(r.message))) return 'a reason message is just its code ' + J(party[1].reasons);
  // W1 fix D6 (round 3): EVERY reason is said in words: no dotted code, no machine word in parentheses ("... this move (not-learnable)"), the move named; the code stays in `code` (the row's hover text)
  { const all = [...v.rows.flatMap((r) => r.reasons), ...v.rejected];
    const leaks = all.filter((r) => /\b[a-z]{2,}\.[a-z][a-z-]{2,}\b/.test(r.message) || /\([a-z]+(?:[-.][a-z]+)+\)/.test(r.message));
    if (leaks.length) return 'machine words on the screen: ' + J(leaks.map((r) => r.message));
    const mv = pack.moves[illegalMove];
    if (!party[1].reasons.some((r) => r.code === 'move.illegal' && mv && r.message.includes(mv.name))) return 'the illegal move is not named in words: ' + J(party[1].reasons);
    const pr = IM.plainReason({ code: 'weird.code', message: 'this species cannot know this move (not-learnable)' }, pack);
    if (pr !== 'this species cannot know this move') return 'plainReason kept the machine word: ' + J(pr); }
  // the SAME Pokemon are judged by the destination's rules: under the Champions rules (Lv 50 fixed) a Lv 100 Pokemon is no longer legal
  const v5 = IM.buildImportView(res, pack, CHAMP);
  if (v5.summary.legal >= v.summary.legal || v5.ruleset !== CHAMP) return 'the Champions ruleset did not change the verdicts: ' + v5.summary.legal + ' vs ' + v.summary.legal;
  // default selection: the LEGAL party members, in order, up to the room
  if (J([...IM.defaultSelection(v, 6)]) !== J(['p0', 'p2']) || J([...IM.defaultSelection(v, 1)]) !== J(['p0']) || IM.defaultSelection(v, 0).size !== 0) return 'default selection ' + J([...IM.defaultSelection(v, 6)]);
  // the buttons
  const sel = (mode, cap = 6) => J([...IM.selectionFor(v, mode, cap)]);
  if (sel('none') !== '[]' || sel('party') !== J(['p0', 'bad-1', 'p2']) || sel('legal') !== J(['p0', 'p2', 'b0', 'b2']) || sel('all') !== J(['p0', 'bad-1', 'p2', 'b0', 'b2']) || sel('all', 2) !== J(['p0', 'bad-1'])) return 'selection modes ' + sel('party') + ' ' + sel('legal') + ' ' + sel('all') + ' ' + sel('all', 2);
  // the verdict: nothing ticked, too many for a new team (6), too many for a team with room
  const vd = (selected, capacity) => IM.importVerdict({ selected, capacity, hasProfile: true });
  if (vd(0, 6).ok || vd(7, 6).ok || vd(3, 2).ok || !vd(6, 6).ok || !vd(1, 1).ok || !/untick 1/.test(vd(7, 6).reason) || !/room for 2/.test(vd(3, 2).reason)) return 'verdicts ' + J([vd(0, 6), vd(7, 6), vd(3, 2)]);
  if (IM.capacityOf({ teamId: null, room: 0 }) !== 6 || IM.capacityOf({ teamId: 't', room: 2 }) !== 2 || IM.capacityOf({ teamId: 't', room: 9 }) !== 6 || IM.capacityOf({ teamId: 't', room: -1 }) !== 0) return 'capacityOf';
  // the records come out in LIST order, never in the order they were ticked
  if (J(IM.recordsFor(v, new Set(['b2', 'p2', 'p0'])).map((m) => m.id)) !== J(['p0', 'p2', 'b2'])) return 'recordsFor order';
  // a profile made from a save is named after its trainer when the profile rules accept the name
  if (IM.profileNameFrom('NOVA', () => true) !== 'NOVA' || IM.profileNameFrom('  ', () => true) !== 'TRAINER' || IM.profileNameFrom('BAD{}', () => false) !== 'TRAINER' || IM.profileNameFrom(null, null) !== 'TRAINER') return 'profileNameFrom';
  // every failure the importer can report has a title, a message and a hint, and none echoes anything but numbers
  for (const code of ['save.size', 'save.empty', 'save.no-valid-slot', 'save.wrong-rom', 'save.layout', 'save.rom-missing', 'save.bad-input', 'save.internal', 'file.too-large', 'file.empty', 'file.read', 'weird.code']) {
    const m = IM.saveErrorMessage({ code, size: 12345 }, 12345);
    if (!m.title || !m.message || !m.hint || m.code !== code) return 'error message for ' + code + ' ' + J(m);
  }
  if (!/12,345 bytes/.test(IM.saveErrorMessage({ code: 'save.size', size: 12345 }).message) || !/131,072/.test(IM.saveErrorMessage({ code: 'save.size', size: 5 }).message)) return 'the wrong-size message does not say the sizes';
  if (IM.saveErrorMessage({ code: 'save.no-valid-slot' }).title === IM.saveErrorMessage({ code: 'save.size' }).title) return 'wrong game and wrong size share a title';
  if (IM.buildImportView({ ok: false, error: { code: 'save.empty' } }, pack, STD).error.code !== 'save.empty' || IM.buildImportView(null, pack, STD).ok !== false) return 'a failed import must give an error view';
  return true;
});
add('state/import/a-card-naming-a-pokemon-the-rom-lacks-is-refused', async (c) => {
  // species 21 is an EMPTY slot of this ROM's table; 5000 and 65535 are past its end. A card with such a Pokemon would store a record nobody can open.
  const emptySlot = pack.species.findIndex((x, i) => i > 0 && x === null);
  if (emptySlot < 1) return 'this ROM has no empty species slot to test with';
  const f = withMons(c, [PIKACHU, CHARIZARD], { teams: 1 });
  const dec = await c.T.decodeTeamCode(await c.T.encodeTeamCode(c.T.teamFromProfile(f.s.profile, f.teamId)));
  if (!dec.ok) return J(dec);
  const g = fresh(c, { deps: detDeps(9), teams: 0 });
  for (const sp of [emptySlot, 5000, 65535]) {
    const team = { ...dec.team, mons: [dec.team.mons[0], { ...dec.team.mons[1], species: sp }] };
    const r = rejected(g.s, go(c, g.ctx, g.s, { type: 'teamImport', team }), 'species.unknown', 'species ' + sp);
    if (r !== true) return r;
  }
  return go(c, g.ctx, g.s, { type: 'teamImport', team: dec.team }).error ? 'the control card (both species exist) was refused' : true;
});
add('art/pictures-for-ids-the-rom-lacks-are-null-not-a-throw', (c) => {
  // one hand-edited record must never be able to blank a whole screen: the art kit answers "no picture" and the view draws a ROM-font mark
  const emptySlot = pack.species.findIndex((x, i) => i > 0 && x === null);
  const art = c.A.createArtKit(rom);
  for (const id of [0, -1, 1.5, 5000, 65535, 1578, NaN, '25', null, undefined]) {
    for (const f of [() => art.monIcon(id), () => art.monIcon(id, { shiny: true }), () => art.frontSprite(id)]) {
      let v; try { v = f(); } catch (e) { return 'id ' + J(id) + ' threw ' + (e && e.message); }
      if (v !== null) return 'id ' + J(id) + ' gave a picture';
    }
  }
  let e1; try { e1 = art.monIcon(emptySlot); } catch (e) { return 'the empty slot ' + emptySlot + ' threw ' + e.message; }
  if (e1 !== null) return 'the empty slot ' + emptySlot + ' gave a picture';
  return art.monIcon(PIKACHU) && art.frontSprite(PIKACHU) ? true : 'a real species lost its picture';
});
add('state/box/unused-mons-are-reported-and-cleaned-on-request', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD]);
  const p = clone(f.s.profile);
  p.teams[0].monIds = [f.monIds[0]]; // Charizard is now on no team
  const s = { ...f.s, profile: p };
  if (c.S.unusedMons(p).length !== 1) return 'unusedMons';
  const r = go(c, f.ctx, s, { type: 'boxCleanup' });
  const none = go(c, f.ctx, r, { type: 'boxCleanup' });
  return r.profile.box.length === 1 && none.notice.code === 'box.clean' && none.profile === r.profile ? true : 'cleanup';
});

// ================================ state: robustness
add('state/robustness/garbage-actions-never-throw-and-never-change-the-profile', (c) => {
  const f = withMons(c, [PIKACHU]);
  const garbage = [undefined, null, 7, 'rename', [], {}, { type: 5 }, { type: 'nope' }, { type: 'monSet' }, { type: 'monSet', monId: f.monIds[0] }, { type: 'monSet', monId: f.monIds[0], field: '__proto__', value: 1 },
    { type: 'evSet', monId: f.monIds[0], stat: '__proto__', value: 1 }, { type: 'teamImport', team: { mons: 'x' } }, { type: 'load' }, { type: 'saved' }, { type: 'moveSet', monId: f.monIds[0], slot: {}, moveId: [] }];
  const hostile = { type: 'rename', get name() { throw new Error('boom'); } };
  { let r; try { r = c.S.reduce(f.s, hostile, f.ctx); } catch (e) { return 'a throwing getter escaped reduce(): ' + e.message; }
    if (!r.error || r.error.code !== 'internal.error' || r.profile !== f.s.profile) return 'a throwing getter was not reported as internal.error: ' + J(r.error); }
  for (const a of garbage) {
    let r;
    try { r = c.S.reduce(f.s, a, f.ctx); } catch (e) { return 'threw on ' + J(a) + ': ' + e.message; }
    if (r.profile !== f.s.profile && !(a && a.type === 'load')) return 'the profile changed on ' + J(a);
    if (r.error && r.error.code === 'internal.error') return 'internal.error on ' + J(a) + ': ' + r.error.message;
  }
  return true;
});
add('state/robustness/the-reducer-does-not-mutate-its-input-even-when-frozen', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD]);
  const frozen = deepFreeze(clone({ ...f.s, undo: [], redo: [] }));
  const id = frozen.profile.teams[0].monIds[0];
  const actions = [
    { type: 'monSet', monId: id, field: 'nature', value: 4 }, { type: 'evSet', monId: id, stat: 'atk', value: 100, mode: 'ev' }, { type: 'ivPreset', monId: id, preset: 'zeroAtk' },
    { type: 'moveSet', monId: id, slot: 1, moveId: 98 }, { type: 'teamRename', teamId: frozen.profile.teams[0].id, name: 'NEW' }, { type: 'teamDuplicate', teamId: frozen.profile.teams[0].id },
    { type: 'teamRuleset', teamId: frozen.profile.teams[0].id, ruleset: CHAMP }, { type: 'teamConform', teamId: frozen.profile.teams[0].id }, { type: 'monMove', teamId: frozen.profile.teams[0].id, monId: id, to: 1 },
    { type: 'evSnap', monId: id }, { type: 'monSet', monId: id, field: 'species', value: 9 },
  ];
  for (const a of actions) { const r = c.S.reduce(frozen, a, f.ctx); if (r.error && r.error.code === 'internal.error') return `${a.type}: ${r.error.message}`; }
  return true;
});
add('state/robustness/determinism-the-same-actions-and-deps-give-the-same-document', (c) => {
  const run = () => {
    const f = withMons(c, [PIKACHU, CHARIZARD, 9], { deps: detDeps(11) });
    let s = go(c, f.ctx, f.s, { type: 'teamDuplicate', teamId: f.teamId });
    s = go(c, f.ctx, s, { type: 'monSet', monId: f.monIds[0], field: 'nature', value: 7 });
    return J(s.profile);
  };
  return run() === run() ? true : 'two runs with identical deps differ';
});
add('state/robustness/fuzz-invariants', (c) => {
  const rng = mulberry32(2024);
  const f = fresh(c, { deps: detDeps(5), teams: 2 });
  let s = f.s;
  const ctx = { pack, deps: detDeps(6) };
  const stats = c.ST.STAT_ORDER;
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const junk = () => pick([0, 1, 2, 3, 31, 50, 100, 252, 255, 256, 300, -1, -50, 1.5, NaN, Infinity, '5', null, undefined, true, 'x', [], {}]);
  const steps = 1500 * FUZZ;
  let accepted = 0, rejectedN = 0;
  for (let i = 0; i < steps; i++) {
    const teams = s.profile.teams, team = pick(teams.length ? teams : [{ id: 'x', monIds: [] }]);
    const mons = s.profile.box, mon = pick(mons.length ? mons : [{ id: 'y' }]);
    const species = rng() < 0.8 ? pick(pack.roster) : junk();
    const a = pick([
      () => ({ type: 'monAdd', teamId: team.id, species }), () => ({ type: 'monRemove', teamId: team.id, monId: mon.id }), () => ({ type: 'monMove', teamId: team.id, monId: mon.id, to: junk() }),
      () => ({ type: 'monSet', monId: mon.id, field: pick(['level', 'nature', 'abilitySlot', 'heldItem', 'gender', 'shiny', 'friendship', 'species', 'nickname']), value: pick([junk(), junk(), species, 'ZAP']) }),
      () => ({ type: 'evSet', monId: mon.id, stat: pick(stats), value: junk(), mode: pick(['ev', 'points']), coalesce: rng() < 0.3 ? 'k' : undefined }),
      () => ({ type: 'ivSet', monId: mon.id, stat: pick(stats), value: junk() }), () => ({ type: 'ivPreset', monId: mon.id, preset: pick(['all31', 'all0', 'zeroAtk', 'hp:Fire', 'hp:Dark', 'bad']) }),
      () => ({ type: 'moveSet', monId: mon.id, slot: pick([0, 1, 2, 3, 4, junk()]), moveId: pick([junk(), 1 + Math.floor(rng() * 900), null]) }),
      () => ({ type: 'teamCreate', ruleset: pick(PRESETS) }), () => ({ type: 'teamDelete', teamId: team.id }), () => ({ type: 'teamDuplicate', teamId: team.id }), () => ({ type: 'teamMove', teamId: team.id, to: junk() }),
      () => ({ type: 'teamRuleset', teamId: team.id, ruleset: pick(PRESETS) }), () => ({ type: 'teamConform', teamId: team.id }), () => ({ type: 'evSnap', monId: mon.id }), () => ({ type: 'evReset', monId: mon.id }),
      () => ({ type: 'undo' }), () => ({ type: 'redo' }), () => ({ type: 'boxCleanup' }), () => ({ type: 'rename', name: pick(['RED', 'BLUE', '', 'A{B', 'WAYTOOLONGNAME']) }),
    ])();
    let r;
    try { r = c.S.reduce(s, a, ctx); } catch (e) { return `step ${i} threw on ${J(a)}: ${e.message}`; }
    if (r.error) {
      rejectedN++;
      if (r.error.code === 'internal.error' || r.error.code === 'internal.invalid') return `step ${i}: ${r.error.code} on ${J(a)}: ${r.error.message}`;
      if (r.profile !== s.profile) return `step ${i}: a rejected ${a.type} changed the profile`;
    } else accepted++;
    const bad = c.P.checkProfile(r.profile);
    if (bad.length) return `step ${i}: ${a.type} left an invalid profile: ${bad[0].code} ${bad[0].path}`;
    if (r.undo.length > 20) return 'undo exceeded 20';
    if (r.profile.teams.length > 16) return 'more than 16 teams';
    if (r.profile.teams.some((tm) => tm.monIds.length > 6)) return 'more than 6 mons in a team';
    s = r;
  }
  return accepted > 100 && rejectedN > 100 ? true : `fuzz exercised too little: ${accepted} accepted, ${rejectedN} rejected`;
}, 'slow');
add('state/robustness/every-accepted-mon-edit-keeps-the-mon-legal-fuzz', (c) => {
  // start from a legal Champions team and a legal standard team; apply random VALID-looking edits; whatever is accepted must leave every mon rules-legal
  // for the fields the reducer polices (level, IV, nature, ability, item, moves, EV/points budgets)
  const rng = mulberry32(31);
  for (const rs of [STD, CHAMP, STD + '+lv5']) {
    const f = withMons(c, [PIKACHU, CHARIZARD, 9, 150, 249, 384], { teamRuleset: rs, deps: detDeps(3) });
    let s = f.s;
    const stats = c.ST.STAT_ORDER;
    const pick = (a) => a[Math.floor(rng() * a.length)];
    for (let i = 0; i < 400 * FUZZ; i++) {
      const id = pick(f.monIds);
      const a = pick([
        () => ({ type: 'evSet', monId: id, stat: pick(stats), value: Math.floor(rng() * 300), mode: rs === CHAMP ? 'points' : pick(['ev', 'points']) }), () => ({ type: 'ivSet', monId: id, stat: pick(stats), value: Math.floor(rng() * 40) }),
        () => ({ type: 'monSet', monId: id, field: 'level', value: 1 + Math.floor(rng() * 110) }), () => ({ type: 'monSet', monId: id, field: 'nature', value: Math.floor(rng() * 25) }),
        () => ({ type: 'moveSet', monId: id, slot: Math.floor(rng() * 4), moveId: 1 + Math.floor(rng() * 900) }), () => ({ type: 'monSet', monId: id, field: 'abilitySlot', value: Math.floor(rng() * 3) }),
        () => ({ type: 'monSet', monId: id, field: 'heldItem', value: Math.floor(rng() * 940) }),
      ])();
      const r = c.S.reduce(s, a, f.ctx);
      if (r.error) continue;
      s = r;
      const m = monOf(s, id);
      const v = c.P.validateStoredMon(m, pack, rs);
      // the only reasons an edit sequence may leave are moves made illegal by a LATER level drop (the reducer polices a move when it is set, not retroactively)
      const stray = v.reasons.filter((x) => !(x.code === 'move.illegal' && a.type === 'monSet' && a.field === 'level'));
      if (stray.length) return `${rs} after ${J(a)}: ${J(stray[0])}`;
    }
  }
  return true;
}, 'slow');

// ================================ data
add('data/search/by-name-number-and-type', (c) => {
  const D = c.D;
  const all = D.speciesSearch(pack, '', STD);
  if (all.length !== pack.roster.length) return 'empty query returns ' + all.length;
  const pika = D.speciesSearch(pack, 'pikachu', STD);
  if (pika[0] !== PIKACHU || !pika.every((id) => /pikachu/i.test(pack.species[id].name))) return 'name search ' + J(pika.slice(0, 5));
  const dex = D.speciesSearch(pack, '#25', STD);
  if (!dex.includes(PIKACHU) || !dex.every((id) => pack.species[id].natDex === 25 || String(pack.species[id].natDex).startsWith('25') || id === 25)) return 'number search ' + J(dex.slice(0, 6));
  const fire = D.speciesSearch(pack, 'fire', STD);
  const fireTyped = fire.filter((id) => pack.species[id].types.includes(11));
  if (!fire.includes(CHARIZARD) || fireTyped.length < 20) return 'type search';
  const both = D.speciesSearch(pack, 'fire flying', STD);
  if (!both.includes(CHARIZARD) || both.some((id) => !pack.species[id].types.includes(11) || !pack.species[id].types.includes(3)) && both.some((id) => !/fire|flying/i.test(pack.species[id].name))) return 'AND of two types';
  const none = D.speciesSearch(pack, 'zzzzzz', STD);
  const ex = D.speciesExclusions(pack, STD);
  const availOnly = all.filter((id) => !ex.has(id)), tail = all.filter((id) => ex.has(id));
  const ordered = (xs) => xs.every((id, i) => i === 0 || pack.species[xs[i - 1]].natDex < pack.species[id].natDex || (pack.species[xs[i - 1]].natDex === pack.species[id].natDex && xs[i - 1] < id));
  const groups = all.length === availOnly.length + tail.length && J(all) === J(availOnly.concat(tail));
  return none.length === 0 && ordered(availOnly) && ordered(tail) && groups ? true : 'ordering or the no-match case';
});
add('data/search/banned-species-sort-last-and-are-marked-unavailable', (c) => {
  const R = clone(c.R.resolveRuleset(STD));
  R.banned.species = [PIKACHU];
  const ids = c.D.speciesSearch(pack, 'pikachu', R);
  const rows = ids.map((id) => c.D.speciesRow(pack, id, R));
  const firstBad = rows.findIndex((r) => !r.available);
  return ids.includes(PIKACHU) && rows[rows.length - 1].id === PIKACHU && !rows[rows.length - 1].available && firstBad === rows.length - 1 ? true : 'ban handling ' + J(rows.map((r) => [r.id, r.available]));
});
add('data/moves/catalog-matches-the-learnset-and-carries-tags', (c) => {
  const f = withMons(c, [PIKACHU]);
  const mon = monOf(f.s, f.monIds[0]);
  const cat = c.D.moveCatalog(pack, mon, STD);
  const learn = c.R.learnsetOf(pack, PIKACHU, true);
  if (cat.length !== Object.keys(learn).length) return `catalog ${cat.length} vs learnset ${Object.keys(learn).length}`;
  const tb = cat.find((m) => m.name === 'Thunderbolt');
  if (!tb || !tb.status.ok || !tb.tags.some((x) => x.kind === 'machine' && /^TM\d\d$/.test(x.label)) || tb.type !== 14 || tb.category !== 1) return 'Thunderbolt entry ' + J(tb);
  const lv = cat.find((m) => m.tags.some((x) => x.kind === 'levelUp' && /^Lv \d+$/.test(x.label)));
  const egg = cat.find((m) => m.tags.some((x) => x.kind === 'egg'));
  const all = c.D.moveCatalog(pack, mon, STD, { allMoves: true });
  const extra = all.filter((m) => !m.learnable);
  if (!lv || !egg || all.length <= cat.length + 300 || extra.some((m) => m.status.ok) || extra[0].status.why !== 'not-learnable') return 'tags or allMoves';
  return cat.every((m, i) => i === 0 || cat[i - 1].id < m.id) ? true : 'not ordered by id';
});
add('data/moves/batch-verdicts-equal-one-move-at-a-time-differential', (c) => {
  const rng = mulberry32(8);
  for (let n = 0; n < 18 * FUZZ; n++) {
    const sid = pack.roster[Math.floor(rng() * pack.roster.length)];
    const rs = PRESETS[n % PRESETS.length];
    let R = c.R.resolveRuleset(rs);
    if (n % 3 === 2) { R = clone(R); R.moves.sources = ['levelUp', 'machine']; R.banned.moves = [...new Set([1 + Math.floor(rng() * 930), 1 + Math.floor(rng() * 930), 85, 53])].sort((a, b) => a - b); }
    let rec;
    try { rec = c.R.blankRec(sid, pack, R); } catch (_e) { continue; }
    rec.level = R.level.fixed !== null ? R.level.fixed : 1 + Math.floor(rng() * 100);
    const ids = [];
    for (let i = 0; i < 70; i++) ids.push(1 + Math.floor(rng() * 930));
    const uniq = [...new Set(ids)];
    const batch = c.D.moveStatuses(pack, rec, uniq, R);
    for (const id of uniq) {
      const v = c.R.validateMon({ ...rec, moves: [id] }, pack, R);
      const own = v.reasons.filter((x) => /^moves\[0\]$/.test(x.path));
      if ((own.length === 0) !== batch[id].ok) return `species ${sid} ${rs} move ${id}: batch ${J(batch[id])} vs single ${J(own)}`;
      if (own.length && own[0].code !== batch[id].code) return `code differs for move ${id}`;
    }
  }
  return true;
});
add('data/moves/rules-js-bans-flow-through-with-the-ruleset-code-and-text', (c) => {
  const f = withMons(c, [PIKACHU]);
  const mon = monOf(f.s, f.monIds[0]);
  const tb = pack.moves.findIndex((m) => m && m.name === 'Thunderbolt');
  const R = clone(c.R.resolveRuleset(STD));
  R.banned.moves = [tb];
  const cat = c.D.moveCatalog(pack, mon, R);
  const e = cat.find((m) => m.id === tb);
  if (e.status.ok || e.status.code !== 'move.banned' || e.status.text !== c.R.RULE_CODES['move.banned']) return 'banned move ' + J(e.status);
  const filtered = c.D.filterMoves(cat, {});
  const pos = filtered.findIndex((m) => m.id === tb);
  return pos > filtered.findIndex((m) => m.status.ok && m.id !== tb) && filtered.slice(pos).every((m) => !m.status.ok) ? true : 'unavailable moves must sort after the available ones';
});
add('data/moves/an-evolution-move-is-tagged-Evo', (c) => {
  const sid = pack.roster.find((id) => pack.species[id].levelUp.some(([, lv]) => lv === 0) && !pack.species[id].levelUp.some(([mv, lv]) => lv > 0 && pack.species[id].levelUp.some(([m2, l2]) => l2 === 0 && m2 === mv)));
  const f = withMons(c, [sid]);
  const cat = c.D.moveCatalog(pack, monOf(f.s, f.monIds[0]), STD);
  const evoMove = pack.species[sid].levelUp.find(([, lv]) => lv === 0)[0];
  const e = cat.find((m) => m.id === evoMove);
  return e && e.tags.some((x) => x.kind === 'levelUp' && x.label === 'Evo') && !e.tags.some((x) => x.label === 'Lv 0') ? true : 'evolution move tags ' + J(e && e.tags);
});
add('data/moves/filters', (c) => {
  const f = withMons(c, [PIKACHU]);
  const cat = c.D.moveCatalog(pack, monOf(f.s, f.monIds[0]), STD);
  const D = c.D;
  const elec = D.filterMoves(cat, { type: 14 });
  const phys = D.filterMoves(cat, { category: 0 });
  const strong = D.filterMoves(cat, { powerMin: 90 });
  const weak = D.filterMoves(cat, { powerMax: 40, category: 1 });
  const tm = D.filterMoves(cat, { source: 'machine' });
  const q = D.filterMoves(cat, { q: 'thunder' });
  const byPower = D.filterMoves(cat, { sort: 'power' }).filter((m) => m.status.ok);
  if (!elec.length || elec.some((m) => m.type !== 14)) return 'type';
  if (!phys.length || phys.some((m) => m.category !== 0)) return 'category';
  if (!strong.length || strong.some((m) => m.power < 90)) return 'power min';
  if (weak.some((m) => m.power > 40 || m.category !== 1)) return 'power max';
  if (!tm.length || tm.some((m) => !m.tags.some((x) => x.kind === 'machine'))) return 'source';
  if (!q.length || q.some((m) => !/thunder/i.test(m.name))) return 'text';
  if (!byPower.every((m, i) => i === 0 || byPower[i - 1].power >= m.power)) return 'sort by power';
  return D.filterMoves(cat, { onlyAvailable: true }).every((m) => m.status.ok) ? true : 'onlyAvailable';
});
add('data/items/catalog-lists-hold-effect-items-and-flows-rules-bans', (c) => {
  const R = clone(c.R.resolveRuleset(STD));
  const cat = c.D.itemCatalog(pack, R);
  if (cat.length < 300 || cat.some((i) => !(i.holdEffect > 0))) return 'default list ' + cat.length;
  const left = pack.items.find((i) => i.name === 'Leftovers');
  const all = c.D.itemCatalog(pack, R, { holdEffectOnly: false });
  if (all.length <= cat.length + 100 || !all.some((i) => i.holdEffect === 0)) return 'holdEffectOnly:false';
  R.banned.items = [left.id];
  const banned = c.D.itemCatalog(pack, R);
  const e = banned.find((i) => i.id === left.id);
  const firstBad = banned.findIndex((i) => !i.status.ok);
  if (e.status.ok || e.status.code !== 'item.banned' || e.status.text !== c.R.RULE_CODES['item.banned'] || firstBad < 0 || banned.slice(firstBad).some((i) => i.status.ok)) return 'banned item ' + J(e && e.status) + ' / unavailable items are not all after the available ones';
  const q = c.D.itemCatalog(pack, STD, { q: 'berry' });
  return q.length > 5 && q.every((i) => /berry/i.test(i.name) || /berry/i.test(i.desc || '')) ? true : 'item search';
});
add('data/ability/slots-hidden-flag-and-innates', (c) => {
  const Roff = clone(c.R.resolveRuleset(STD)); Roff.engine = { enforce: false };
  const o = c.D.abilityOptions(pack, PIKACHU, Roff);
  if (J(o.slots.map((s) => s.slot)) !== J([0, 2]) || !o.slots[1].hidden || o.slots[0].hidden || o.slots[0].name !== 'Static' || !o.slots.every((s) => s.allowed)) return 'slots ' + J(o.slots.map((s) => [s.slot, s.name, s.allowed]));
  if (!o.innates.length || !o.innates.every((i) => i.name)) return 'innates';
  const R = clone(c.R.resolveRuleset(STD));
  R.engine = { enforce: false }; // measure the ban list itself, not the engine layer
  R.banned.abilities = [9];
  const b = c.D.abilityOptions(pack, PIKACHU, R).slots[0];
  const R2 = clone(c.R.resolveRuleset(STD));
  R2.engine = { enforce: false };
  R2.ability.slots = [0, 1];
  const d = c.D.abilityOptions(pack, PIKACHU, R2).slots.find((s) => s.slot === 2);
  return !b.allowed && b.code === 'ability.banned' && !d.allowed && d.code === 'ability.slot-disallowed' && d.text === c.R.RULE_CODES['ability.slot-disallowed'] ? true : 'ability verdicts';
});
add('data/engine/the-engine-layer-reaches-species-moves-abilities-and-items-as-rules-js-reasons', (c) => {
  const D = c.D, sup = c.R.engineSupports(pack);
  const text = (code) => c.R.RULE_CODES[code];
  // a species the engine layer excludes is unavailable with rules.js's own code and text, and 'hide' leaves it out
  const ex = c.R.engineExcludedSpecies(pack, STD);
  const e0 = ex[0];
  const row = D.speciesRow(pack, e0.id, STD);
  if (row.available || row.code !== 'species.engine-' + e0.why || row.text !== text(row.code)) return 'excluded species row ' + J(row);
  if (!D.speciesSearch(pack, '', STD).includes(e0.id) || D.speciesSearch(pack, '', STD, { unavailable: 'hide' }).includes(e0.id)) return 'hide / last handling';
  if (D.speciesSearch(pack, '', STD, { unavailable: 'hide' }).length !== pack.roster.length - ex.length) return 'hide count';
  // an unsupported move (one a species CAN learn, which the engine cannot run). Pikachu used to be that species; the engine's coverage has grown and Pikachu's whole learnset runs now, so the
  // test looks for ANY species of the roster that still has one (the check is about the status and the rejection, not about which species it is)
  let fixSp = PIKACHU, badMove;
  for (const id of [PIKACHU, ...pack.roster.filter((x) => !ex.some((e) => e.id === x))]) {
    const m = Object.keys(c.R.learnsetOf(pack, id, true)).map(Number).find((mv) => !sup.moves.has(mv) && pack.moves[mv] && c.R.moveLegality(pack, id, 100, mv, STD).legal);
    if (m !== undefined) { fixSp = id; badMove = m; break; }
  }
  // round 3: the engine runs every move a species learns, so when none is left the status path is exercised on a copy of the pack where one learnable move is turned into a class the engine does not run
  let pk = pack;
  if (badMove === undefined) { badMove = Object.keys(c.R.learnsetOf(pack, PIKACHU, true)).map(Number).find((mv) => pack.moves[mv] && c.R.moveLegality(pack, PIKACHU, 100, mv, STD).legal); pk = { ...pack, moves: pack.moves.map((m, i) => (i === badMove ? { ...m, effect: 307 } : m)) }; }
  const f = withMons(c, [fixSp]);
  const mon = monOf(f.s, f.monIds[0]);
  const ent = D.moveCatalog(pk, mon, STD).find((m) => m.id === badMove);
  if (ent.status.ok || ent.status.code !== 'move.engine-unsupported' || ent.status.text !== text('move.engine-unsupported')) return 'unsupported move status ' + J(ent.status);
  if (pk === pack) {   // the app's own pack is the real one, so the rejection can only be tried while a real unsupported move exists
    const rej = rejected(f.s, go(c, f.ctx, f.s, { type: 'moveSet', monId: f.monIds[0], slot: 1, moveId: badMove }), 'move.engine-unsupported', 'unsupported move');
    if (rej !== true) return rej;
  }
  // an unsupported item
  const badItem = pack.items.find((it) => it.holdEffect > 0 && !sup.items.has(it.id));
  if (!badItem) return 'no unsupported hold-effect item found';
  const ist = D.itemStatus(pack, badItem.id, STD);
  if (ist.ok || ist.code !== 'item.engine-unsupported' || ist.text !== text('item.engine-unsupported')) return 'unsupported item status ' + J(ist);
  const ri = rejected(f.s, go(c, f.ctx, f.s, { type: 'monSet', monId: f.monIds[0], field: 'heldItem', value: badItem.id }), 'item.engine-unsupported', 'unsupported item');
  if (ri !== true) return ri;
  const goodItem = pack.items.find((it) => it.holdEffect > 0 && sup.items.has(it.id));
  if (D.itemStatus(pack, goodItem.id, STD).ok !== true) return 'a supported item is not ok';
  // an unsupported ability slot on a species that has one supported slot and one that is not
  const sp = pack.roster.find((id) => { const s = pack.species[id]; const ab = [0, 1, 2].map((k) => s.abilities[k]).filter(Boolean); return ab.length >= 2 && ab.some((a) => sup.abilities.has(a)) && ab.some((a) => !sup.abilities.has(a)); });
  if (sp === undefined) return 'no species with one supported and one unsupported ability found';
  const opts = D.abilityOptions(pack, sp, STD);
  const bad = opts.slots.find((s) => !sup.abilities.has(s.id)), good = opts.slots.find((s) => sup.abilities.has(s.id));
  if (!bad || bad.allowed || bad.code !== 'ability.engine-unsupported' || bad.text !== text('ability.engine-unsupported') || !good.allowed) return 'ability verdicts ' + J(opts.slots.map((s) => [s.slot, s.id, s.allowed, s.code]));
  // and with the layer off (a ruleset OBJECT, as rules.js allows) the same slot is fine
  const R = clone(c.R.resolveRuleset(STD)); R.engine = { enforce: false };
  const offBad = D.abilityOptions(pack, sp, R).slots.find((s) => s.id === bad.id);
  const offMove = D.moveCatalog(pk, mon, R).find((m) => m.id === badMove);
  return offBad.allowed && offMove.status.ok && D.itemStatus(pack, badItem.id, R).ok ? true : 'with the engine layer off these are still refused';
});
add('data/nature/25-with-labels-and-neutral-ones', (c) => {
  const n = c.D.natureOptions(pack);
  const adamant = n.find((x) => x.name === 'Adamant'), hardy = n.find((x) => x.name === 'Hardy');
  return n.length === 25 && adamant.label === 'Adamant (+Atk, -SpA)' && adamant.up === 'atk' && adamant.down === 'spa' && hardy.neutral && hardy.label === 'Hardy (neutral)' && n.filter((x) => x.neutral).length === 5 ? true : J([adamant, hardy]);
});
add('data/derived/stats-equal-rules-battle-stats-and-the-garchomp-vector', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  let s = go(c, f.ctx, f.s, { type: 'monSet', monId: id, field: 'nature', value: 3 });
  s = go(c, f.ctx, s, { type: 'evSet', monId: id, stat: 'atk', value: 252, mode: 'ev' });
  const m = monOf(s, id);
  const d = c.D.derived(pack, m, STD);
  const want = c.R.battleStats(c.P.toRulesRec(m, STD), pack, STD);
  if (!d.ok || J(d.stats) !== J(want) || d.level !== 50) return 'stats ' + J(d);
  if (d.nature.name !== 'Adamant' || d.nature.up !== 'atk' || d.nature.down !== 'spa') return 'nature ' + J(d.nature);
  const bad = c.D.derived(pack, { ...m, species: 99999 }, STD);
  const lv100 = c.D.derived(pack, m, STD + '+lv100');
  return !bad.ok && lv100.level === 100 && lv100.stats.atk > d.stats.atk && d.pointsUsed === 32 + 0 && d.evUsed === 252 ? true : 'bad species / lv100 / budgets ' + J([bad, lv100.level, d.pointsUsed, d.evUsed]);
});
add('data/derived/stats-equal-an-independent-gen-3-formula-for-300-random-mons', (c) => {
  // An oracle that shares no code with rules.js / stats.js: HP = floor((2B + IV + floor(EV/4)) * L / 100) + L + 10; every other stat is
  // floor((floor((2B + IV + floor(EV/4)) * L / 100) + 5) * nature) with nature 11/10, 9/10 or 1 (integer arithmetic, never a float).
  const rng = mulberry32(20261101);
  const modes = [[STD, 50], [STD + '+lv5', 5], [STD + '+lv100', 100]];
  const roster = pack.roster.filter((id) => pack.species[id].baseStats.hp !== 1);   // Shedinja's HP is fixed at 1 in every game
  let checked = 0, mons = 0;
  for (let n = 0; mons < 300 && n < 3000; n++) {
    const sid = roster[Math.floor(rng() * roster.length)];
    const [ruleset, L] = modes[n % 3];
    const ev = {}, iv = {};
    let left = 510;
    for (const k of c.ST.STAT_ORDER) { const v = Math.min(left, Math.floor(rng() * 256)); ev[k] = v; left -= v; iv[k] = Math.floor(rng() * 32); }
    let rec; try { rec = c.R.blankRec(sid, pack, STD); } catch (_e) { continue; }   // a few species have no ability the rules allow: nothing to build
    mons++;
    const nature = Math.floor(rng() * 25);
    const mon = c.P.createMon({ species: sid, level: 1 + Math.floor(rng() * 100), nature, abilitySlot: rec.abilitySlot, heldItem: 0, moves: rec.moves, ev, iv, gender: c.D.genderOptions(pack, sid)[0] }, detDeps(n));
    const d = c.D.derived(pack, mon, ruleset);
    if (!d.ok) return 'derived failed for species ' + sid + ': ' + d.error;
    const B = pack.species[sid].baseStats, nat = pack.natures[nature];
    for (const k of c.ST.STAT_ORDER) {
      const core = Math.floor(((2 * B[k] + iv[k] + Math.floor(ev[k] / 4)) * L) / 100);
      let want = k === 'hp' ? core + L + 10 : core + 5;
      if (k !== 'hp' && nat.up !== nat.down) { if (k === nat.up) want = Math.floor((want * 110) / 100); else if (k === nat.down) want = Math.floor((want * 90) / 100); }
      if (d.stats[k] !== want) return 'species ' + sid + ' ' + pack.species[sid].name + ' under ' + ruleset + ' stat ' + k + ': the page would show ' + d.stats[k] + ', the formula gives ' + want + ' (B ' + B[k] + ' IV ' + iv[k] + ' EV ' + ev[k] + ' nature ' + nature + ')';
      checked++;
    }
  }
  return mons === 300 && checked === 1800 ? true : 'only ' + mons + ' Pokemon / ' + checked + ' stats compared';
});
add('data/derived/budgets-for-both-views', (c) => {
  const f = withMons(c, [PIKACHU]);
  const id = f.monIds[0];
  const s = go(c, f.ctx, f.s, { type: 'evSet', monId: id, stat: 'atk', value: 252, mode: 'ev' });
  const b = c.D.budgets(monOf(s, id), STD);
  const ch = withMons(c, [PIKACHU], { teamRuleset: CHAMP });
  const s2 = go(c, ch.ctx, ch.s, { type: 'evSet', monId: ch.monIds[0], stat: 'atk', value: 20, mode: 'points' });
  const b2 = c.D.budgets(monOf(s2, ch.monIds[0]), CHAMP);
  return b.ev.used === 252 && b.ev.total === 510 && b.ev.remaining === 258 && !b.pointsBinding && b.points.used === 32 && b2.pointsBinding && b2.points.total === 66 && b2.points.used === 20 && b2.ev === null && c.D.storedView(CHAMP) === 'points' && c.D.storedView(STD) === 'ev' ? true : J([b, b2]);
});
add('data/validation/grouped-with-rules-text-and-readable-labels', (c) => {
  const f = withMons(c, [PIKACHU, CHARIZARD]);
  const p = clone(f.s.profile);
  p.box[0].level = 50;
  p.box[0].moves = [{ id: pack.moves.findIndex((m) => m && m.name === 'Hydro Cannon'), ppUps: 0 }];
  p.box[1].heldItem = 99999;
  const mons = c.S.teamMonsOf(p, f.teamId);
  const v = c.D.validationView(pack, mons, STD);
  const m0 = v.mons[0].find((x) => x.code === 'move.illegal');
  const m1 = v.mons[1].find((x) => x.code === 'item.unknown');
  if (v.ok || !m0 || !m1 || m0.text !== c.R.RULE_CODES['move.illegal'] || m0.label !== 'Move 1' || m1.label !== 'Held item') return 'grouping ' + J(v);
  const sameSpecies = c.D.validationView(pack, [mons[0], { ...mons[0], id: 'm_dup' }], STD);
  const clause = sameSpecies.team.find((x) => x.code === 'team.species-clause');
  const good = c.D.validationView(pack, [f.s.profile.box[0]], STD);
  return clause && clause.text === c.R.RULE_CODES['team.species-clause'] && good.ok && good.count === 0 && c.D.fieldLabel('mons[2].evs.atk') === 'EVs (Attack)' ? true : 'team-level reasons or the ok case ' + J(sameSpecies);
});
add('data/validation/unknown-codes-fall-back-to-the-reason-message', (c) => {
  return c.D.reasonText('some.future-code', 'the engine cannot run this') === 'the engine cannot run this' && c.D.reasonText('some.future-code') === 'some.future-code' && c.D.reasonText('move.banned') === c.R.RULE_CODES['move.banned'] ? true : 'reasonText';
});
add('data/gender/options-follow-the-rom-ratio', (c) => {
  const genderless = pack.roster.find((id) => pack.species[id].genderRatio === 255), maleOnly = pack.roster.find((id) => pack.species[id].genderRatio === 0), femaleOnly = pack.roster.find((id) => pack.species[id].genderRatio === 254);
  return J(c.D.genderOptions(pack, genderless)) === '["-"]' && J(c.D.genderOptions(pack, maleOnly)) === '["M"]' && J(c.D.genderOptions(pack, femaleOnly)) === '["F"]' && J(c.D.genderOptions(pack, PIKACHU)) === '["M","F"]'
    && c.D.defaultGender(pack, PIKACHU, 'F') === 'F' && c.D.defaultGender(pack, PIKACHU, '-') === 'M' ? true : 'gender options';
});

// ================================ links, routes, input parsing
const CODE = 'ARENA1.' + 'A'.repeat(40) + '.abcd';
add('links/battle-url-carries-the-contract-query-and-refuses-anything-else', (c) => {
  const L = c.L;
  const u = L.battleUrl({ team: CODE, foe: 'random', seed: 4294967295, format: '3v3', cpu: 'hard' });
  const p = L.parseBattleUrl(u);
  if (p.path !== '/pokemonarena/battle.html' || p.team !== CODE || p.foe !== 'random' || p.seed !== 4294967295 || p.format !== '3v3' || p.cpu !== 'hard') return 'round trip ' + J(p) + ' from ' + u;
  const withFoe = L.parseBattleUrl(L.battleUrl({ team: CODE, foe: CODE, seed: 0 }));
  if (withFoe.foe !== CODE || withFoe.seed !== 0 || withFoe.format !== undefined) return 'foe as a code / seed 0 / omitted format ' + J(withFoe);
  const throws = (o) => { try { L.battleUrl(o); return false; } catch (e) { return e instanceof RangeError; } };
  const bad = [
    [{ team: 'nope' }, 'a team that is not a code'], [{ team: 'ARENA1.' + 'A'.repeat(10) + '&foe=evil' + '.abcd' }, 'a team code with an injected parameter in its payload'], [{ team: CODE, foe: 'x' }, 'a foe that is not random or a code'],
    [{ team: CODE, seed: -1 }, 'a negative seed'], [{ team: CODE, seed: 4294967296 }, 'a seed past 32 bits'], [{ team: CODE, seed: 1.5 }, 'a fractional seed'], [{ team: CODE, seed: '5' }, 'a seed that is a string'],
    [{ team: CODE, format: '4v4' }, 'an unknown format'], [{ team: CODE, cpu: 'insane' }, 'an unknown difficulty'], [{ team: 'ARENA1.' + 'A'.repeat(2000) + '.abcd' }, 'a code over the length cap'], [{}, 'no team'],
  ];
  for (const [o, why] of bad) if (!throws(o)) return 'accepted ' + why;
  return c.L.isTeamCode(CODE) && !c.L.isTeamCode('ARENA1.x.zz') && !c.L.isTeamCode(null) ? true : 'isTeamCode';
});
add('links/seeds-are-unsigned-32-bit-and-formats-follow-the-team-size', (c) => {
  const L = c.L;
  if (L.seedFrom(() => [255, 255, 255, 255]) !== 4294967295 || L.seedFrom(() => [128, 0, 0, 0]) !== 2147483648 || L.seedFrom(() => [0, 0, 0, 1]) !== 1) return 'seedFrom';
  // W1 correction (H1's hub test D): battle.html REFUSES 3v3 for fewer than three Pokemon, so only a team of exactly three defaults to 3v3; one or two play 6v6 (= all of them), four to six play 6v6
  if (L.formatForTeamSize(3) !== '3v3' || ![0, 1, 2, 4, 5, 6].every((n) => L.formatForTeamSize(n) === '6v6')) return 'formatForTeamSize: ' + [0, 1, 2, 3, 4, 5, 6].map((n) => n + '=' + L.formatForTeamSize(n)).join(' ');
  // and the formats a team MAY choose follow the same rule: no 3v3 under three Pokemon
  return J(L.formatsForTeamSize(2)) === J(['6v6']) && J(L.formatsForTeamSize(3)) === J(['6v6', '3v3']) && J(L.formatsForTeamSize(6)) === J(['6v6', '3v3']) && J(L.formatsForTeamSize(0)) === J(['6v6']) ? true : 'formatsForTeamSize';
});
add('links/routes-round-trip-and-hostile-hashes-fall-back-to-the-profile-screen', (c) => {
  const L = c.L;
  const routes = [{ name: 'profiles' }, { name: 'teams' }, { name: 'import' }, { name: 'team', teamId: 't_abc123' }, { name: 'mon', teamId: 't_1', monId: 'm_2', tab: 'build' }, { name: 'mon', teamId: 't_1', monId: 'm_2', tab: 'moves' }, { name: 'mon', teamId: 't_1', monId: 'm_2', tab: 'stats' }];
  for (const r of routes) { const back = L.parseRoute(L.routeHash(r)); if (J(back) !== J(r)) return 'round trip ' + J(r) + ' -> ' + J(back); }
  const hostile = ['', '#', '#/', '#/team/../../x', '#/team/' + 'a'.repeat(41), '#/team/t_1/mon/m_2/evil', '#/team/t_1/mon', '#/teams/extra', '#/team/<script>', '#/team/t_1/mon/m_2/stats/extra', 'javascript:alert(1)'];
  for (const h of hostile) if (L.parseRoute(h).name !== 'profiles') return 'hostile hash ' + h + ' -> ' + J(L.parseRoute(h));
  return L.parseRoute('#/team/t_1/mon/m_2').tab === 'build' ? true : 'default tab';
});
add('input/typed-numbers-are-parsed-strictly', (c) => {
  const P = c.V.parseWhole;
  const good = [['12', 12], [' 7 ', 7], ['-3', -3], ['0', 0], ['255', 255], ['000', 0]];
  for (const [s, n] of good) if (P(s) !== n) return J(s) + ' -> ' + P(s);
  for (const s of ['', ' ', 'abc', '1e3', '0x10', '1.5', '1,5', '+5', '--3', '12abc', '\u0661\u0662', '1234567', 'Infinity', 'NaN', '5 5', null, undefined]) if (P(s) !== null) return J(s) + ' was accepted as ' + P(s);
  return true;
});
add('state/avatar/is-checked-against-the-roms-portraits-and-roster', (c) => {
  const f = fresh(c);
  const ok1 = go(c, f.ctx, f.s, { type: 'avatar', kind: 'preset', id: 51 }), ok2 = go(c, f.ctx, f.s, { type: 'avatar', kind: 'mon', id: PIKACHU });
  if (ok1.error || J(ok1.profile.avatar) !== J({ kind: 'preset', id: 51 }) || ok2.error || J(ok2.profile.avatar) !== J({ kind: 'mon', id: PIKACHU })) return 'valid avatars refused ' + J([ok1.error, ok2.error]);
  const rs = [go(c, f.ctx, f.s, { type: 'avatar', kind: 'preset', id: 52 }), go(c, f.ctx, f.s, { type: 'avatar', kind: 'preset', id: -1 }), go(c, f.ctx, f.s, { type: 'avatar', kind: 'mon', id: 0 }), go(c, f.ctx, f.s, { type: 'avatar', kind: 'mon', id: 99999 }), go(c, f.ctx, f.s, { type: 'avatar', kind: 'wat', id: 1 }), go(c, f.ctx, f.s, { type: 'avatar', kind: 'preset', id: 1.5 })];
  for (const [i, r] of rs.entries()) { const x = rejected(f.s, r, 'avatar.' + (i === 4 ? 'kind' : 'id'), 'avatar case ' + i); if (x !== true) return x; }
  const same = go(c, f.ctx, f.s, { type: 'avatar', kind: 'preset', id: f.s.profile.avatar.id });
  return same.profile === f.s.profile ? true : 'an unchanged avatar counted as an edit';
});
add('state/save/rebase-adopts-the-stores-rev-and-keeps-the-document-dirty', (c) => {
  const f = withMons(c, [PIKACHU]);
  let s = go(c, f.ctx, f.s, { type: 'monSet', monId: f.monIds[0], field: 'nature', value: 3 });
  s = go(c, f.ctx, s, { type: 'saved', rev: 3, seq: s.seq });
  s = go(c, f.ctx, s, { type: 'monSet', monId: f.monIds[0], field: 'nature', value: 4 });
  const r = go(c, f.ctx, s, { type: 'rebase', rev: 9 });
  if (r.profile.rev !== 9 || !c.S.isDirty(r) || monOf(r, f.monIds[0]).nature !== 4) return 'rebase ' + J([r.profile.rev, c.S.isDirty(r)]);
  return [rejected(s, go(c, f.ctx, s, { type: 'rebase', rev: -1 }), 'rebase.shape', 'negative rev'), rejected(s, go(c, f.ctx, s, { type: 'rebase', rev: '9' }), 'rebase.shape', 'string rev')].find((x) => x !== true) || true;
});

// ================================ art (no DOM): the kit decodes lazily and deterministically from the ROM
add('art/kit-draws-from-the-rom-and-only-what-is-asked', (c) => {
  const art = c.A.createArtKit(rom);
  const n0 = art.cacheSize();
  const ic = art.monIcon(PIKACHU), ic2 = art.monIcon(PIKACHU, { frame: 1 }), sh = art.monIcon(PIKACHU, { shiny: true });
  if (ic.width !== 32 || ic.height !== 32 || ic.rgba.length !== 32 * 32 * 4 || ic.source !== 'icon') return 'icon shape';
  if (J(Array.from(ic.rgba)) === J(Array.from(ic2.rgba)) || J(Array.from(ic.rgba)) === J(Array.from(sh.rgba))) return 'frames / shiny palette are not distinct';
  if (art.cacheSize() > n0 + 8) return 'one icon request decoded far more than one icon: cache grew by ' + (art.cacheSize() - n0);
  const opaque = (img) => { let n = 0; for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i]) n++; return n; };
  const types = [];
  for (let ty = 1; ty <= 19; ty++) { const b = art.typeBadge(ty); if (b.width !== 32 || b.height !== 16 || opaque(b) < 100) return 'type badge ' + ty + ' is blank'; types.push(J(Array.from(b.rgba))); }
  if (new Set(types).size !== 19) return 'type badges are not all distinct';
  const cats = [0, 1, 2].map((k) => art.categoryIcon(k));
  if (cats.some((x) => x.width !== 16 || opaque(x) < 20) || new Set(cats.map((x) => J(Array.from(x.rgba)))).size !== 3) return 'category icons';
  const lo = art.statBar(10, 400), hi = art.statBar(390, 400);
  if (J(Array.from(lo.rgba)) === J(Array.from(hi.rgba)) || lo.width !== 64 || lo.height !== 8) return 'bars do not differ';
  const noIcon = art.monIcon(1557);
  return noIcon && noIcon.source === 'front' && opaque(noIcon) > 50 && c.A.barKind(100, 100) === 'hpGreen' && c.A.barKind(30, 100) === 'hpYellow' && c.A.barKind(5, 100) === 'hpRed' && c.A.barPixels(1, 1000) === 1 && c.A.barPixels(0, 100) === 0 && c.A.barPixels(100, 100) === 64 ? true : 'fallback / bar rules';
});
add('art/type-badges-use-the-roms-own-palette-table', (c) => {
  const art = c.A.createArtKit(rom);
  const sheet = art.ui.get('icon.types');
  const banks = [0x6a3e98, 0x6a3eb8, 0x6a3ed8].map((o) => c.G.readPalette(rom, o, 16));
  for (let ty = 1; ty <= 19; ty++) {
    const slot = rom[0x4d877d + ty - 1];
    const want = c.G.bitmapToRGBA({ width: 32, height: 16, pixels: sheet.pixels.subarray(ty * 512, (ty + 1) * 512) }, banks[slot - 13], { transparent0: true });
    if (J(Array.from(want)) !== J(Array.from(art.typeBadge(ty).rgba))) return 'badge ' + ty + ' does not use palette slot ' + slot;
  }
  const slots = new Set(); for (let ty = 1; ty <= 19; ty++) slots.add(rom[0x4d877d + ty - 1]);
  return slots.size === 3 ? true : 'the ROM table is expected to use all three palette banks, saw ' + [...slots];
});
add('art/the-art-changes-when-the-rom-bytes-change', (c) => {
  // provenance control: zero the party-icon bytes of Pikachu and the icon must change; an untouched species must not
  const art = c.A.createArtKit(rom);
  const before = J(Array.from(art.monIcon(PIKACHU).rgba)), other = J(Array.from(art.monIcon(CHARIZARD).rgba));
  const bad = rom.slice();
  const rec = base_speciesRecord(bad, PIKACHU);
  bad.fill(0, rec.icon, rec.icon + 1024);
  const art2 = c.A.createArtKit(bad);
  return J(Array.from(art2.monIcon(PIKACHU).rgba)) !== before && J(Array.from(art2.monIcon(CHARIZARD).rgba)) === other ? true : 'the icon does not come from the ROM bytes';
});
function base_speciesRecord(bytes, id) {
  const b = 0x7c7310 + id * 0x118;
  const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  return { icon: u32(b + 0x6c) - 0x08000000 };
}

// ---------------------------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------------------------
async function runSuite(mods, only) {
  const failed = [];
  for (const chk of suite) {
    if (only && !only.includes(chk.id)) continue;
    let r;
    try { r = await chk.fn(mods); } catch (e) { r = 'threw ' + (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : e); }
    if (r !== true) failed.push({ id: chk.id, why: String(r).slice(0, 300) });
  }
  return failed;
}

console.log('pokemonarena editor test; ROM ' + ROM_PATH + '; node ' + process.version + '; pack ' + pack.counts.speciesLegal + ' legal species');
const realDir = makeCopy(null);
const real = await loadCopy(realDir);
const t0 = Date.now();
const realFailed = await runSuite(real);
for (const chk of suite) t(chk.id, !realFailed.some((f) => f.id === chk.id) ? true : realFailed.find((f) => f.id === chk.id).why);
console.log(`  ${suite.length} checks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---- twin: a second, unmutated copy goes through the same loader and must be silent
{
  const twin = await loadCopy(makeCopy(null));
  const f = await runSuite(twin);
  t('twin/the unmutated copy passes every check', f.length === 0, f.map((x) => x.id).join(', '));
}

// ---- mutants
const MUTANTS = [];
const mut = (id, file, from, to, expect, count = 1) => MUTANTS.push({ id, file, from, to, expect, count });
const E = (...x) => x;
mut('M01 rename accepts an empty name', 'editor_state.js', "if (t.value.trim() === '') return reject(state, type, 'name.empty', 'the name cannot be empty');", '', E('state/rename/rejects-bad-names-and-keeps-the-same-profile-object'));
mut('M02 a no-op rename counts as an edit', 'editor_state.js', "if (t.value === P.trainerName) return { ...state, error: null, notice: null, result: null };", '', E('state/rename/the-same-name-is-not-an-edit'));
mut('M03 the team limit is 17', 'editor_state.js', 'teamsMax: 16,', 'teamsMax: 17,', E('state/team/sixteen-is-the-limit'));
mut('M04 duplicate shares mon ids with the original', 'editor_state.js', "const mons = teamMonsOf(P, team.id).map((m) => ({ ...clone(m), id: newId('m', deps), createdAt: deps.now(), updatedAt: deps.now() }));", 'const mons = teamMonsOf(P, team.id).map((m) => ({ ...clone(m) }));', E('state/team/duplicate-clones-the-mons-with-new-ids-and-sits-after-the-original'));
mut('M05 delete leaves the team mons in the box', 'editor_state.js', "const next = { ...P, teams: P.teams.filter((t) => t !== team), box: P.box.slice() };\n    gcBox(next);", 'const next = { ...P, teams: P.teams.filter((t) => t !== team), box: P.box.slice() };', E('state/team/delete-removes-its-mons-but-keeps-a-mon-another-team-uses'));
mut('M06 the box cleanup drops mons another team still uses', 'editor_state.js', "const gcBox = (profile) => { const used = new Set(profile.teams.flatMap((t) => t.monIds)); profile.box = profile.box.filter((m) => used.has(m.id)); };", 'const gcBox = (profile) => { profile.box = []; };', E('state/team/delete-removes-its-mons-but-keeps-a-mon-another-team-uses', 'state/mon/remove-reorder-duplicate'));
mut('M07 a seventh Pokemon fits', 'editor_state.js', "if (team.monIds.length >= Math.min(R.team.max, EDITOR_LIMITS.teamSize)) return reject(state, type, 'team.full', `this team already", "if (team.monIds.length >= Math.min(R.team.max, EDITOR_LIMITS.teamSize) + 1) return reject(state, type, 'team.full', `this team already", E('state/mon/add-respects-the-team-size-and-the-roster'));
mut('M08 an illegal species can be added (the roster check is gone; only blankRec would stop it)', 'editor_state.js', "if (!sp.legal) return reject(state, type, 'species.illegal', 'that species is not on the roster');\n    { const ex = speciesExclusions(pack, R).get(action.species);", "{ const ex = speciesExclusions(pack, R).get(action.species);", E('state/mon/add-respects-the-team-size-and-the-roster'));
mut('M60 a fresh state starts dirty', 'editor_state.js', 'return { profile, seq: 0, savedSeq: 0,', 'return { profile, seq: 1, savedSeq: 0,', E('state/initial/a-fresh-state-is-clean'));
mut('M61 an edit does not bump the sequence number', 'editor_state.js', 'return { ...state, profile: next, seq: state.seq + 1, undo,', 'return { ...state, profile: next, seq: state.seq, undo,', E('state/rename/accepts-a-name-and-marks-dirty-and-undoable'));
mut('M62 a default ruleset is stored unchecked', 'editor_state.js', "let id; try { id = resolveRuleset(action.value).id; } catch (e) { return reject(state, type, 'setting.ruleset', 'unknown ruleset'); }", 'const id = action.value;', E('state/setting/default-ruleset-and-enums-are-validated'));
mut('M63 every new team is called TEAM 1', 'editor_state.js', "const c = 'TEAM ' + n; if (!names.has(c)) return c;", "const c = 'TEAM 1'; if (n > 0) return c;", E('state/team/create-uses-the-default-ruleset-names-it-and-reports-the-id'));
mut('M64 a new team takes any ruleset text', 'editor_state.js', "try { rs = resolveRuleset(action.ruleset === undefined ? P.settings.defaultRuleset : action.ruleset).id; } catch (e) { return reject(state, type, 'ruleset.unknown', 'unknown ruleset'); }", 'rs = action.ruleset === undefined ? P.settings.defaultRuleset : action.ruleset;', E('state/team/create-validates-name-and-ruleset'));
mut('M65 a team can be renamed to nothing', 'editor_state.js', "if (t.value.trim() === '') return reject(state, type, 'name.empty', 'the team name cannot be empty');", '', E('state/team/rename'));
mut('M66 teamMove lands one slot late', 'editor_state.js', 'teams.splice(to.value, 0, teams.splice(i, 1)[0]);', 'teams.splice(to.value + 1, 0, teams.splice(i, 1)[0]);', E('state/team/move-reorders-and-clamps'));
mut('M68 moves reorder the wrong way', 'editor_state.js', 'mv.splice(to, 0, mv.splice(from, 1)[0]);', 'mv.splice(from, 0, mv.splice(to, 1)[0]);', E('state/moves/reorder'));
mut('M69 EV reset keeps the EVs', 'editor_state.js', "for (const k of STAT_ORDER) m.ev[k] = 0;\n    return commit(state, type, stamp());", "for (const k of STAT_ORDER) m.ev[k] = m.ev[k];\n    return commit(state, type, stamp());", E('state/ev/reset'));
mut('M09 the Champions starter keeps level 100', 'editor_state.js', 'moves: rec.moves, ev, iv, gender:', 'moves: rec.moves, ev, iv, level: 100, gender:', E('state/mon/starter-defaults-follow-the-ruleset', 'state/mon/add-makes-a-legal-starter-under-every-preset'));
mut('M10 level is not clamped', 'editor_state.js', 'const v = Math.max(lo, Math.min(hi, value));\n  return { ok: true, value: v, clamped: v !== value };', 'const v = value;\n  return { ok: true, value: v, clamped: false };', E('state/field/level-clamps-integers-and-rejects-everything-else', 'state/ev/classic-clamps-per-stat-and-to-the-510-total-with-a-notice', 'state/iv/set-clamps-and-presets'));
mut('M11 a fractional number is accepted', 'editor_state.js', "const isInt = (v) => typeof v === 'number' && Number.isInteger(v);", "const isInt = (v) => typeof v === 'number' && Number.isFinite(v);", E('state/field/level-clamps-integers-and-rejects-everything-else', 'state/ev/non-integers-and-unknown-stats-are-rejected', 'state/iv/set-clamps-and-presets'));
mut('M12 a numeric string is accepted as a number', 'editor_state.js', "const isInt = (v) => typeof v === 'number' && Number.isInteger(v);", "const isInt = (v) => Number.isInteger(Number(v)) && v !== null && v !== '' && v !== undefined && typeof v !== 'object';", E('state/field/level-clamps-integers-and-rejects-everything-else', 'state/ev/non-integers-and-unknown-stats-are-rejected'));
mut('M13 the fixed level can be edited away', 'editor_state.js', "if (R.level.fixed !== null && r.value !== R.level.fixed) return reject(", 'if (false) return reject(', E('state/field/the-champions-layer-fixes-the-level-ivs-and-locks-evs-to-points'));
mut('M14 fixed IVs can be edited', 'editor_state.js', "if (R.iv.fixed !== null) return reject(state, type, 'iv.fixed', `these rules fix every IV at ${R.iv.fixed}`, { expected: R.iv.fixed });\n    const r = intIn(action.value, R.iv.min, R.iv.max);", 'const r = intIn(action.value, R.iv.min, R.iv.max);', E('state/field/the-champions-layer-fixes-the-level-ivs-and-locks-evs-to-points'));
mut('M15 classic EVs can be edited under stat points', 'editor_state.js', "if (mode === 'ev' && R.points) return reject(", "if (false) return reject(", E('state/field/the-champions-layer-fixes-the-level-ivs-and-locks-evs-to-points'));
// (M16, 'the nature range is 26', was tried and is EQUIVALENT: intIn clamps to 0..24 and the limit guard rejects 25 either way, so each guard covers the other.)
mut('M17 an empty ability slot can be chosen', 'editor_state.js', "if (!slot) return reject(state, type, 'ability.slot-empty', 'this species has no ability in that slot');\n      if (!slot.allowed)", 'if (!slot) { m.abilitySlot = v; } else if (!slot.allowed)', E('state/field/nature-ability-gender-shiny-friendship-nickname'));
mut('M18 a genderless Pokemon can be given a gender it cannot have', 'editor_state.js', "if (!genderOptions(pack, m.species).includes(v)) return reject(state, type, 'gender.species', 'this species cannot be that gender');", '', E('state/field/nature-ability-gender-shiny-friendship-nickname'));
// (M19, 'the item-id guard is removed', was tried and is EQUIVALENT: rules.js answers item.unknown for the same ids through itemStatus(), so the guard is defence in depth.)
mut('M20 rules.js bans on items are ignored', 'editor_state.js', "if (v !== 0) { const st = itemStatus(pack, v, R); if (!st.ok) return reject(state, type, st.code, st.text, { item: v }); }", '', E('state/field/held-item-is-checked-against-the-item-table-and-the-rules'));
mut('M21 a duplicate move is accepted', 'editor_state.js', "if (m.moves.some((x, i) => x.id === id && i !== slot)) return reject(state, type, 'move.duplicate', 'this Pokemon already knows that move');", '', E('state/moves/rejections-carry-the-rules-code'));
mut('M22 rules.js move verdicts are ignored', 'editor_state.js', "if (!st.ok) return reject(state, type, st.code, st.text, { move: id, why: st.why, needLevel: st.needLevel });", '', E('state/moves/rejections-carry-the-rules-code', 'state/moves/the-level-gate-is-asked-of-rules-js', 'state/robustness/every-accepted-mon-edit-keeps-the-mon-legal-fuzz'));
mut('M23 the rejection loses the why detail', 'editor_state.js', "{ move: id, why: st.why, needLevel: st.needLevel }", '{ move: id }', E('state/moves/rejections-carry-the-rules-code', 'state/moves/the-level-gate-is-asked-of-rules-js'));
mut('M24 the last move can be cleared', 'editor_state.js', "if (m.moves.length <= 1) return reject(state, type, 'moves.min', 'a Pokemon needs at least one move');", '', E('state/moves/set-append-clear'));
mut('M25 a move slot gap is allowed', 'editor_state.js', "slot > 3 || slot > m.moves.length)", 'slot > 3)', E('state/moves/rejections-carry-the-rules-code'));
mut('M26 changing species keeps moves the new species cannot learn', 'editor_state.js', "let keep = m.moves.filter((x) => st[x.id].ok);\n      const dropped", "let keep = m.moves.slice();\n      const dropped", E('state/species/change-keeps-learnable-moves-fixes-ability-and-gender'));
mut('M27 changing species leaves the old gender', 'editor_state.js', 'm.gender = defaultGender(pack, v, m.gender);\n      const slots', 'const slots', E('state/species/change-keeps-learnable-moves-fixes-ability-and-gender'));
mut('M28 changing species leaves a dead ability slot', 'editor_state.js', 'if (!slots.some((s) => s.slot === m.abilitySlot)) m.abilitySlot = slots.length ? slots[0].slot : 0;', '', E('state/species/change-clears-a-dead-ability-slot'));
mut('M29 the 510 EV total is not enforced', 'editor_state.js', "if (R.ev.total !== null) {\n        const room = Math.max(0, R.ev.total - others.reduce((a, k) => a + m.ev[k], 0));\n        if (v > room) v = room;\n      }", '', E('state/ev/classic-clamps-per-stat-and-to-the-510-total-with-a-notice'));
mut('M30 the points total cap is not enforced', 'editor_state.js', "v = Math.min(v, Math.max(0, R.points.total - used));", '', E('state/ev/champions-points-cap-at-32-per-stat-and-66-total-and-stay-on-the-4-then-8-grid'));
mut('M31 points convert to EVs 8 per point', 'editor_state.js', "m.ev[stat] = pointsToEv(v, iv);\n      if (v !== action.value)", "m.ev[stat] = v * 8;\n      if (v !== action.value)", E('state/ev/points-and-evs-stay-linked-for-every-points-value', 'state/ev/champions-points-cap-at-32-per-stat-and-66-total-and-stay-on-the-4-then-8-grid'));
mut('M32 the points view ignores the IV parity', 'editor_state.js', "const iv = R.iv.fixed !== null ? R.iv.fixed : m.iv[stat];\n      const perStat", "const iv = 31;\n      const perStat", E('state/ev/the-points-view-respects-an-even-iv'));
mut('M33 snap-to-minimum is a no-op', 'editor_state.js', "for (const k of STAT_ORDER) m.ev[k] = r.evs[k];\n    return commit(state, type, stamp(), { notice: { code: 'snapped'", "for (const k of STAT_ORDER) m.ev[k] = m.ev[k];\n    return commit(state, type, stamp(), { notice: { code: 'snapped'", E('state/ev/snap-to-minimum'));
mut('M34 snap uses the mon level instead of the battle level', 'editor_state.js', 'const level = R.level.battle !== null ? R.level.battle : m.level;', 'const level = m.level;', E('state/ev/snap-uses-the-battle-level-not-the-mons-own'));
mut('M35 an IV preset writes 30', 'editor_state.js', 'for (const k of STAT_ORDER) iv[k] = R.iv.max;\n      if (p === \'all0\')', 'for (const k of STAT_ORDER) iv[k] = R.iv.max - 1;\n      if (p === \'all0\')', E('state/iv/set-clamps-and-presets'));
mut('M36 the Hidden Power preset ignores the type', 'editor_state.js', "try { iv = hiddenPowerIvs(p.slice(3)); }", "try { iv = hiddenPowerIvs('Fire'); }", E('state/iv/hidden-power-presets-round-trip-for-all-16-types'));
mut('M37 undo depth is 21', 'editor_state.js', 'undoMax: 20,', 'undoMax: 21,', E('state/undo/twenty-edits-and-no_more'));
mut('M38 a drag is many undo steps', 'editor_state.js', 'const coalesce = !!meta.key && state.lastKey === meta.key && state.undo.length > 0;', 'const coalesce = false;', E('state/undo/one-drag-is-one-undo-step'));
mut('M39 coalescing ignores an action in between', 'editor_state.js', "lastKey: meta.key || null, error: null, notice: meta.notice || null", "lastKey: meta.key || state.lastKey, error: null, notice: meta.notice || null", E('state/undo/a-different-action-between-two-same-key-edits-breaks-the-group'));
mut('M40 a new edit keeps the redo stack', 'editor_state.js', "undo, redo: [], lastKey: meta.key || null", "undo, redo: state.redo, lastKey: meta.key || null", E('state/undo/redo-replays-and-a-new-edit-clears-it'));
mut('M41 undo rolls the identity back', 'editor_state.js', "return { ...current, trainerName: snapshot.trainerName, avatar: snapshot.avatar, settings: snapshot.settings, teams: snapshot.teams, box: snapshot.box };", "return { ...snapshot };", E('state/undo/restores-teams-and-box-but-never-the-identity-or-the-rev'));
mut('M42 undo does not mark the document dirty', 'editor_state.js', "redo: state.redo.concat([{ profile: state.profile, label: entry.label }]), seq: state.seq + 1,", "redo: state.redo.concat([{ profile: state.profile, label: entry.label }]), seq: state.seq,", E('state/undo/an-undone-edit-is-dirty-again'));
mut('M43 an edit made while saving is lost', 'editor_state.js', "savedSeq: Math.max(state.savedSeq, action.seq), error: null };", "savedSeq: state.seq, error: null };", E('state/save/saved-bookkeeping'));
mut('M44 a saved ack for the future is accepted', 'editor_state.js', "|| action.seq > state.seq) return reject(state, type, 'saved.shape'", ") return reject(state, type, 'saved.shape'", E('state/save/saved-bookkeeping'));
mut('M45 a read-only profile is editable', 'editor_state.js', "if (state.readOnly) return reject(", 'if (false) return reject(', E('state/readonly/a-newer-document-cannot-be-edited'));
mut('M46 switching rulesets silently rewrites mons', 'editor_state.js', "return commit(state, type, { ...P, teams: P.teams.map((x) => (x === team ? { ...x, ruleset: id } : x)) }, { notice: { code: 'ruleset-changed'", "return commit(state, type, { ...P, teams: P.teams.map((x) => (x === team ? { ...x, ruleset: id } : x)), box: P.box.map((mm) => ({ ...mm, level: 50 })) }, { notice: { code: 'ruleset-changed'", E('state/rules/switching-changes-only-the-id-and-conform-fixes-it'));
mut('M47 conform leaves the level alone', 'editor_state.js', "set('level', m, 'level', R.level.fixed !== null ? R.level.fixed : Math.max(R.level.min, Math.min(R.level.max, m.level)));", '', E('state/rules/switching-changes-only-the-id-and-conform-fixes-it', 'state/rules/conform-always-produces-a-legal-mon-under-every-preset-fuzz'));
mut('M48 conform does not snap EVs to the points grid', 'editor_state.js', 'for (const k of STAT_ORDER) ev[k] = pointsToEv(pts[k], m.iv[k]);', 'for (const k of STAT_ORDER) ev[k] = ev[k];', E('state/rules/switching-changes-only-the-id-and-conform-fixes-it', 'state/rules/conform-always-produces-a-legal-mon-under-every-preset-fuzz'));
mut('M49 conform does not trim the points budget', 'editor_state.js', 'for (let i = STAT_ORDER.length - 1; i >= 0 && over > 0; i--) { const k = STAT_ORDER[i]; const cut = Math.min(pts[k], over); pts[k] -= cut; over -= cut; }', '', E('state/rules/conform-always-produces-a-legal-mon-under-every-preset-fuzz'));
mut('M50 conform keeps an illegal move', 'editor_state.js', 'let keep = m.moves.filter((x, i) => st[x.id].ok && m.moves.findIndex((y) => y.id === x.id) === i).slice(0, R.moves.max);', 'let keep = m.moves.slice();', E('state/rules/conform-always-produces-a-legal-mon-under-every-preset-fuzz', 'state/rules/conform-drops-only-moves-that-became-illegal'));
mut('M51 conform drops every move', 'editor_state.js', 'let keep = m.moves.filter((x, i) => st[x.id].ok && m.moves.findIndex((y) => y.id === x.id) === i).slice(0, R.moves.max);', 'let keep = [];', E('state/rules/conform-drops-only-moves-that-became-illegal'));
mut('M52 import accepts seven Pokemon', 'editor_state.js', 'src.mons.length > EDITOR_LIMITS.teamSize', 'src.mons.length > EDITOR_LIMITS.teamSize + 1', E('state/import/a-decoded-team-becomes-a-new-team-with-its-mons'));
mut('M53 import trusts a malformed Pokemon', 'editor_state.js', "try { mons = monsFromDecoded(src, deps); } catch (e) { return reject(state, type, 'import.invalid'", "try { mons = src.mons.map((x, i) => ({ ...x, id: newId('m', deps) })); } catch (e) { return reject(state, type, 'import.invalid'", E('state/import/a-decoded-team-becomes-a-new-team-with-its-mons'));
mut('M54 a rejected action returns a NEW profile object (identity is the contract)', 'editor_state.js', "const reject = (state, type, code, message, detail) => ({ ...state, error:", "const reject = (state, type, code, message, detail) => ({ ...state, profile: { ...state.profile }, error:", E('state/robustness/fuzz-invariants', 'state/rename/rejects-bad-names-and-keeps-the-same-profile-object'));
mut('M55 box cleanup deletes everything', 'editor_state.js', "const next = { ...P, box: P.box.slice() };\n    gcBox(next);\n    return commit(state, type, next, { notice: { code: 'box.cleaned'", "const next = { ...P, box: [] };\n    return commit(state, type, next, { notice: { code: 'box.cleaned'", E('state/box/unused-mons-are-reported-and-cleaned-on-request'));
mut('M56 reduce lets exceptions escape', 'editor_state.js', "  try {\n    return step(state, action, ctx);\n  } catch (e) {\n    return reject(state, action && action.type, 'internal.error', 'unexpected failure: ' + (e && e.message ? e.message : String(e)));\n  }", '  return step(state, action, ctx);', E('state/robustness/garbage-actions-never-throw-and-never-change-the-profile'));
mut('M57 an edit mutates the frozen input in place', 'editor_state.js', "const m = clone(mon);\n  const stamp", "const m = mon;\n  const stamp", E('state/robustness/the-reducer-does-not-mutate-its-input-even-when-frozen'));
mut('M58 ids come from Math.random', 'editor_state.js', "const deps = { ...defaultDeps(), ...(ctx.deps || {}) };", "const deps = { ...defaultDeps() };", E('state/robustness/determinism-the-same-actions-and-deps-give-the-same-document'));
mut('M59 parseRulesetId drops the item clause', 'editor_state.js', "itemClause: layers.includes('item-clause'),", 'itemClause: false,', E('state/rules/parse-and-build-ids-round-trip'));
// ---- editor_data.js
mut('D01 the search ignores types', 'editor_data.js', "if (typeByName.has(t) && s.types.includes(typeByName.get(t))) return true;", '', E('data/search/by-name-number-and-type'));
mut('D02 the search matches the number as a name', 'editor_data.js', "if (num) { const n = Number(num[1]); return s.natDex === n || s.id === n || String(s.natDex).startsWith(num[1]); }", '', E('data/search/by-name-number-and-type'));
mut('D03 the search is OR instead of AND', 'editor_data.js', 'const hits = index.filter((s) => toks.every((t) => {', 'const hits = index.filter((s) => toks.some((t) => {', E('data/search/by-name-number-and-type'));
mut('D04 species a ruleset leaves out sort first', 'editor_data.js', ": avail.concat(rows.filter((r) => !r.available))).map((r) => r.id);", ": rows.filter((r) => !r.available).concat(avail)).map((r) => r.id);", E('data/search/banned-species-sort-last-and-are-marked-unavailable', 'data/search/by-name-number-and-type'));
mut('D05 a banned species is not marked unavailable', 'editor_data.js', "baseForm: isBaseForm(sp), available: !!sp.legal && !ex };", "baseForm: isBaseForm(sp), available: !!sp.legal };", E('data/search/banned-species-sort-last-and-are-marked-unavailable'));
mut('D06 move verdicts are copied from a fixed list instead of asked of rules.js', 'editor_data.js', "const v = validateMon({ ...rec, moves: batch }, pack, R);", "const v = validateMon({ ...rec, moves: batch }, pack, resolveRuleset('arena-gen3-standard'));", E('data/moves/rules-js-bans-flow-through-with-the-ruleset-code-and-text', 'data/moves/batch-verdicts-equal-one-move-at-a-time-differential'));
mut('D07 batches are misaligned by one slot', 'editor_data.js', "const id = batch[slot];", "const id = batch[slot + 1] === undefined ? batch[slot] : batch[slot + 1];", E('data/moves/batch-verdicts-equal-one-move-at-a-time-differential'));
mut('D08 only the first batch is asked', 'editor_data.js', 'for (let i = 0; i < moveIds.length; i += BATCH) {', 'for (let i = 0; i < Math.min(moveIds.length, BATCH); i += BATCH) {', E('data/moves/batch-verdicts-equal-one-move-at-a-time-differential', 'data/moves/catalog-matches-the-learnset-and-carries-tags'));
mut('D09 the verdict text is not the RULE_CODES text', 'editor_data.js', "if (Object.prototype.hasOwnProperty.call(RULE_CODES, code)) return RULE_CODES[code];", '', E('data/moves/rules-js-bans-flow-through-with-the-ruleset-code-and-text', 'data/validation/unknown-codes-fall-back-to-the-reason-message', 'data/items/catalog-lists-hold-effect-items-and-flows-rules-bans'));
mut('D10 the TM label is lost', 'editor_data.js', "if (entry.machine) tags.push({ kind: 'machine', label: machineLabels(pack).get(moveId) || 'TM' });", "if (entry.machine) tags.push({ kind: 'machine', label: 'TM' });", E('data/moves/catalog-matches-the-learnset-and-carries-tags'));
mut('D11 an evolution move is labelled Lv 0', 'editor_data.js', "label: entry.levelUp === 0 ? 'Evo' : 'Lv ' + entry.levelUp", "label: 'Lv ' + entry.levelUp", E('data/moves/an-evolution-move-is-tagged-Evo'));
mut('D12 the type filter is ignored', 'editor_data.js', "e.type !== Number(f.type)) return false;", 'false) return false;', E('data/moves/filters'));
mut('D13 the power-min filter is inverted', 'editor_data.js', "!(e.power >= Number(f.powerMin))", '!(e.power <= Number(f.powerMin))', E('data/moves/filters'));
mut('D14 unavailable moves sort among the available ones', 'editor_data.js', "return out.filter((e) => e.status.ok).concat(out.filter((e) => !e.status.ok));\n}\n\n// ---------------------------------------------------------------------------------------------\n// items", "return out;\n}\n\n// ---------------------------------------------------------------------------------------------\n// items", E('data/moves/rules-js-bans-flow-through-with-the-ruleset-code-and-text'));
mut('D15 the allMoves list marks unlearnable moves available', 'editor_data.js', "status: status[id],\n    };", "status: entry ? status[id] : { ok: true },\n    };", E('data/moves/catalog-matches-the-learnset-and-carries-tags'));
mut('D16 the item list is not narrowed to hold effects', 'editor_data.js', "if (holdOnly && !(it.holdEffect > 0)) continue;", '', E('data/items/catalog-lists-hold-effect-items-and-flows-rules-bans'));
mut('D17 an item is probed with a fixed ruleset', 'editor_data.js', "}, pack, R);\n  const r = v.reasons.find((x) => x.path === 'item');", "}, pack, resolveRuleset('arena-gen3-standard'));\n  const r = v.reasons.find((x) => x.path === 'item');", E('data/items/catalog-lists-hold-effect-items-and-flows-rules-bans'));
mut('D18 the hidden slot is not flagged', 'editor_data.js', "hidden: s === 2, allowed, code, text });", 'hidden: false, allowed, code, text });', E('data/ability/slots-hidden-flag-and-innates'));
mut('D19 a disallowed or banned ability slot is reported allowed', 'editor_data.js', "const allowed = !r, code = r ? r.code : null,", "const allowed = true, code = r ? r.code : null,", E('data/ability/slots-hidden-flag-and-innates'));
mut('D20 the nature label swaps up and down', 'editor_data.js', "`${n.name} (+${STAT_SHORT[n.up]}, -${STAT_SHORT[n.down]})`", "`${n.name} (+${STAT_SHORT[n.down]}, -${STAT_SHORT[n.up]})`", E('data/nature/25-with-labels-and-neutral-ones'));
mut('D21 derived stats are computed at the mon level', 'editor_data.js', "ok: true, stats, level: battleLevel(rec, R),", "ok: true, stats: battleStats({ ...rec, level: rec.level }, pack, { ...R, level: { ...R.level, battle: null } }), level: battleLevel(rec, R),", E('data/derived/stats-equal-rules-battle-stats-and-the-garchomp-vector'), 1);
mut('D22 the EV budget is 500', 'editor_data.js', "ev: mk(sumStats(evs), R.ev.total),", "ev: mk(sumStats(evs), R.ev.total === null ? null : 500),", E('data/derived/budgets-for-both-views'));
mut('D23 team-level reasons are attributed to mon 0', 'editor_data.js', "if (r.mon !== undefined && per[r.mon]) per[r.mon].push(mk(r));\n    else team.push(mk(r));", "if (per[r.mon === undefined ? 0 : r.mon]) per[r.mon === undefined ? 0 : r.mon].push(mk(r));\n    else team.push(mk(r));", E('data/validation/grouped-with-rules-text-and-readable-labels'));
mut('D24 the move field label ignores the slot', 'editor_data.js', "if (m) return `Move ${Number(m[1]) + 1}`;", "if (m) return 'Moves';", E('data/validation/grouped-with-rules-text-and-readable-labels'));
mut('D25 genderless species are offered both genders', 'editor_data.js', "return r === 255 ? ['-'] : r === 0 ? ['M'] : r === 254 ? ['F'] : ['M', 'F'];", "return r === 0 ? ['M'] : r === 254 ? ['F'] : ['M', 'F'];", E('data/gender/options-follow-the-rom-ratio'));
mut('M70 adding a species ignores the engine layer exclusions', 'editor_state.js', "{ const ex = speciesExclusions(pack, R).get(action.species); if (ex) return reject(state, type, ex.code, ex.text, { species: action.species }); }\n    let rec;", "let rec;", E('state/mon/add-refuses-species-the-engine-layer-excludes-with-rules-js-codes'));
mut('M71 changing species ignores the engine layer exclusions and bans', 'editor_state.js', "{ const ex = speciesExclusions(pack, R).get(v); if (ex && v !== m.species) return reject(state, type, ex.code, ex.text, { species: v }); }", '', E('state/mon/add-refuses-species-the-engine-layer-excludes-with-rules-js-codes', 'state/species/rejects-unknown-illegal-and-banned'));
mut('D26 the species list ignores the engine layer', 'editor_data.js', "if (R.engine && R.engine.enforce && typeof RULES.engineExcludedSpecies === 'function') {", 'if (false) {', E('data/engine/the-engine-layer-reaches-species-moves-abilities-and-items-as-rules-js-reasons', 'state/mon/add-refuses-species-the-engine-layer-excludes-with-rules-js-codes'));
mut('D27 an engine-unsupported ability slot is shown as available', 'editor_data.js', "const r = v.reasons.find((x) => x.path === 'abilitySlot') || v.reasons.find((x) => x.code === 'species.engine-no-ability');", "const r = v.reasons.find((x) => x.path === 'abilitySlot' && x.code !== 'ability.engine-unsupported') || v.reasons.find((x) => x.code === 'species.engine-no-ability');", E('data/engine/the-engine-layer-reaches-species-moves-abilities-and-items-as-rules-js-reasons'));
mut('D28 the picker cannot hide the species a ruleset leaves out', 'editor_data.js', "return (opts.unavailable === 'hide' ? avail : avail.concat(rows.filter((r) => !r.available))).map((r) => r.id);", "return avail.concat(rows.filter((r) => !r.available)).map((r) => r.id);", E('data/engine/the-engine-layer-reaches-species-moves-abilities-and-items-as-rules-js-reasons'));
mut('D29 an engine-unsupported item is shown as available', 'editor_data.js', "const r = v.reasons.find((x) => x.path === 'item');", "const r = v.reasons.find((x) => x.path === 'item' && x.code !== 'item.engine-unsupported');", E('data/engine/the-engine-layer-reaches-species-moves-abilities-and-items-as-rules-js-reasons'));
mut('D30 the exclusion reason text is invented, not the RULE_CODES text', 'editor_data.js', "out.set(e.id, { code, text: reasonText(code) });", "out.set(e.id, { code, text: 'excluded' });", E('data/engine/the-engine-layer-reaches-species-moves-abilities-and-items-as-rules-js-reasons'));
mut('L01 a team code may carry an ampersand (parameter injection)', 'editor_links.js', "export const CODE_RE = /^ARENA1\\.[A-Za-z0-9_-]+\\.[0-9a-fA-F]{4}$/;", "export const CODE_RE = /^ARENA1\\.[A-Za-z0-9_&=-]+\\.[0-9a-fA-F]{4}$/;", E('links/battle-url-carries-the-contract-query-and-refuses-anything-else'));
mut('L02 a seed may be 33 bits', 'editor_links.js', "const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;", "const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0x1ffffffff;", E('links/battle-url-carries-the-contract-query-and-refuses-anything-else'));
mut('L03 a seed may be negative', 'editor_links.js', "const isU32 = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;", "const isU32 = (n) => Number.isInteger(n) && n >= -5 && n <= 0xffffffff;", E('links/battle-url-carries-the-contract-query-and-refuses-anything-else'));
mut('L04 a four-Pokemon team plays 3v3', 'editor_links.js', "export function formatForTeamSize(n) { return n === 3 ? '3v3' : '6v6'; }", "export function formatForTeamSize(n) { return n <= 4 ? '3v3' : '6v6'; }", E('links/seeds-are-unsigned-32-bit-and-formats-follow-the-team-size'));
mut("S01 (W1) the imported records keep the importer ids", 'editor_state.js', "const mons = src.map((m) => ({ ...clone(m), id: newId('m', deps), origin: 'save-import' }));", "const mons = src.map((m) => ({ ...clone(m), origin: 'save-import' }));", E('state/save-import/records-from-a-save-join-the-profile-as-a-new-team-or-an-existing-one'));
mut("S02 (W1) a save import may exceed the team size", 'editor_state.js', "src.length < 1 || src.length > EDITOR_LIMITS.teamSize) return reject(state, type, 'import.shape', 'choose 1 to 6 Pokemon to import');", "src.length < 1) return reject(state, type, 'import.shape', 'choose 1 to 6 Pokemon to import');", E('state/save-import/records-from-a-save-join-the-profile-as-a-new-team-or-an-existing-one'));
mut("S03 (W1) appending ignores the free room of the team", 'editor_state.js', "if (mons.length > room) return reject(state, type, 'team.full',", "if (false) return reject(state, type, 'team.full',", E('state/save-import/records-from-a-save-join-the-profile-as-a-new-team-or-an-existing-one'));
mut("S04 (W1) a record naming a species the ROM lacks is stored", 'editor_state.js', "!isInt(m.species) || (pack && !pack.species[m.species])) return reject(state, type, 'species.unknown', `Pokemon ${i + 1} is not in this ROM`);", "!isInt(m.species)) return reject(state, type, 'species.unknown', `Pokemon ${i + 1} is not in this ROM`);", E('state/save-import/records-from-a-save-join-the-profile-as-a-new-team-or-an-existing-one'));
mut("S05 (W1) a malformed record is stored without the shape check", 'editor_state.js', "if (bad.length) return reject(state, type, 'import.invalid', `Pokemon ${i + 1} is not a well formed record:", "if (false) return reject(state, type, 'import.invalid', `Pokemon ${i + 1} is not a well formed record:", E('state/save-import/records-from-a-save-join-the-profile-as-a-new-team-or-an-existing-one'));
mut("I01 (W1) the list is judged by the importer's ruleset, not the destination's", 'editor_import_model.js', "try { v = validateStoredMon(mon, pack, ruleset); }", "try { v = validateStoredMon(mon, pack, 'arena-gen3-standard'); }", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I02 (W1) the default selection ticks Pokemon that need fixing", 'editor_import_model.js', "if (r.status === 'legal') out.add(r.id); }\n  return out;\n}\n\n/** Select all", "out.add(r.id); }\n  return out;\n}\n\n/** Select all", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I03 (W1) a team with two free places accepts three", 'editor_import_model.js', "if (selected > capacity) return { ok: false,", "if (selected > capacity + 1) return { ok: false,", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I04 (W1) the records come out in the order they were ticked", 'editor_import_model.js', "return view.rows.filter((r) => selectedIds.has(r.id)).map((r) => r.mon);", "return [...selectedIds].map((id) => view.rows.find((r) => r.id === id)).filter(Boolean).map((r) => r.mon);", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I05 (W1) empty boxes are listed", 'editor_import_model.js', "for (const b of res.boxes) {\n    if (!b.mons.length) continue;", "for (const b of res.boxes) {", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I06 (W1) a wrong-game save is described as a wrong-size file", 'editor_import_model.js', "case 'save.no-valid-slot':\n      return { code, title: 'This is not a SoulGold v1.1.1 save',", "case 'save.no-valid-slot':\n      return { code, title: 'That is not a SoulGold save file',", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I07 (W1) Tick all ignores the room of the destination", 'editor_import_model.js', "if (mode === 'all') take(view.rows);", "if (mode === 'all') { for (const r of view.rows) out.add(r.id); }", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I09 (W1 fix D6) a box with the game's default name is titled twice ('Box 1 (BOX 1)')", 'editor_import_model.js', "title: 'Box ' + (b.index + 1) + (plain ? '' : ' (' + label + ')')", "title: 'Box ' + (b.index + 1) + ' (' + label + ')'", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I10 (W1 fix D6) a needs-fixing row prints the rules' raw message with its machine word", 'editor_import_model.js', "message: plainReason(r, pack) })),\n    notes:", "message: r.message || r.code })),\n    notes:", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I11 (W1 fix D6) reasonText leaves the parenthesised machine word in", 'editor_data.js', "return String(message || code).replace(/\\s*\\(\\s*[a-z]+(?:[-.][a-z]+)+\\s*\\)/gi, '') || code;", "return String(message || code) || code;", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut("I08 (W1) refused records are dropped from the report", 'editor_import_model.js', "rejected: (res.rejected || []).map(", "rejected: [].map(", E('import/the-save-import-list-judges-every-pokemon-and-names-every-failure'));
mut('L09 (W1 negative control) a team of one or two defaults to 3v3 again, which battle.html refuses', 'editor_links.js', "export function formatForTeamSize(n) { return n === 3 ? '3v3' : '6v6'; }", "export function formatForTeamSize(n) { return n <= 3 ? '3v3' : '6v6'; }", E('links/seeds-are-unsigned-32-bit-and-formats-follow-the-team-size'));
mut('L10 (W1) a team of two may choose 3v3', 'editor_links.js', "export function formatsForTeamSize(n) { return n >= 3 ? ['6v6', '3v3'] : ['6v6']; }", "export function formatsForTeamSize(n) { return n >= 2 ? ['6v6', '3v3'] : ['6v6']; }", E('links/seeds-are-unsigned-32-bit-and-formats-follow-the-team-size'));
mut('L11 (W1) the save-import route is not recognised', 'editor_links.js', "if (h === '/import') return { name: 'import' };", "", E('links/routes-round-trip-and-hostile-hashes-fall-back-to-the-profile-screen'));
mut('L05 a seed can come out negative', 'editor_links.js', "return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; }", "return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]); }", E('links/seeds-are-unsigned-32-bit-and-formats-follow-the-team-size'));
mut('L06 ids in a route may be 400 characters', 'editor_links.js', "const ID = '[A-Za-z0-9_-]{1,40}';", "const ID = '[A-Za-z0-9_-]{1,400}';", E('links/routes-round-trip-and-hostile-hashes-fall-back-to-the-profile-screen'));
mut('L07 an unknown tab is accepted in a route', 'editor_links.js', "(?:/(build|moves|stats))?$`).exec(h)", "(?:/(\\w+))?$`).exec(h)", E('links/routes-round-trip-and-hostile-hashes-fall-back-to-the-profile-screen'));
mut('L08 the foe may be any text', 'editor_links.js', "if (foe !== 'random' && !isTeamCode(foe)) throw", "if (false) throw", E('links/battle-url-carries-the-contract-query-and-refuses-anything-else'));
mut('V01 typed numbers accept a decimal exponent', 'editor_views.js', "export function parseWhole(s) { const t = String(s).trim(); return /^-?\\d{1,6}$/.test(t) ? Number(t) : null; }", "export function parseWhole(s) { const t = String(s).trim(); return /^-?[\\d.e]{1,6}$/.test(t) && !isNaN(Number(t)) ? Number(t) : null; }", E('input/typed-numbers-are-parsed-strictly'));
mut('V02 typed numbers accept a plus sign and an empty string', 'editor_views.js', "return /^-?\\d{1,6}$/.test(t) ? Number(t) : null; }", "return /^[-+]?\\d{0,6}$/.test(t) ? Number(t) : null; }", E('input/typed-numbers-are-parsed-strictly'));
mut('M72 there are 53 preset avatars', 'editor_state.js', "export const AVATAR_PRESETS = 52;", "export const AVATAR_PRESETS = 53;", E('state/avatar/is-checked-against-the-roms-portraits-and-roster'));
mut('M73 a mon avatar need not be on the roster', 'editor_state.js', "if (!sp || !sp.legal) return reject(state, type, 'avatar.id', 'that species is not on the roster');", '', E('state/avatar/is-checked-against-the-roms-portraits-and-roster'));
mut('M74 rebase marks the document clean', 'editor_state.js', "return { ...state, profile: { ...state.profile, rev: action.rev }, seq: state.seq + 1, error: null };", "return { ...state, profile: { ...state.profile, rev: action.rev }, savedSeq: state.seq, error: null };", E('state/save/rebase-adopts-the-stores-rev-and-keeps-the-document-dirty'));
mut('M75 rebase takes any value as a rev', 'editor_state.js', "if (!isInt(action.rev) || action.rev < 0) return reject(state, type, 'rebase.shape', 'rebase needs a rev');", '', E('state/save/rebase-adopts-the-stores-rev-and-keeps-the-document-dirty'));
mut('M76 a card may carry a Pokemon the ROM lacks', 'editor_state.js', "if (pack) {\n      const bad = src.mons.findIndex((m) => !m || !isInt(m.species) || !pack.species[m.species]);", "if (false) {\n      const bad = src.mons.findIndex((m) => !m || !isInt(m.species) || !pack.species[m.species]);", E('state/import/a-card-naming-a-pokemon-the-rom-lacks-is-refused'));
mut('D31 the derived stats are worked out with Speed IV 0', 'editor_data.js', 'const rec = toRulesRec(mon, R);\n    const stats = battleStats(rec, pack, R);', 'const rec = toRulesRec({ ...mon, iv: { ...mon.iv, spe: 0 } }, R);\n    const stats = battleStats(rec, pack, R);', E('data/derived/stats-equal-an-independent-gen-3-formula-for-300-random-mons'));
// ---- editor_art.js
mut('A09 an icon for an id past the table throws', 'editor_art.js', "function monIconFrames(id, shiny) {\n    if (!knownId(id)) return null;", "function monIconFrames(id, shiny) {", E('art/pictures-for-ids-the-rom-lacks-are-null-not-a-throw'));
mut('A10 a front sprite for an id past the table throws', 'editor_art.js', "function frontSprite(id, opts = {}) {\n    if (!knownId(id)) return null;", "function frontSprite(id, opts = {}) {", E('art/pictures-for-ids-the-rom-lacks-are-null-not-a-throw'));
mut('A01 the type badge palette table is ignored', 'editor_art.js', "const slot = k >= 1 && k <= TYPE_PALETTE_COUNT ? rom[TYPE_PALETTE_TABLE + k - 1] : 13;", 'const slot = 13;', E('art/type-badges-use-the-roms-own-palette-table'));
mut('A02 both icon frames are the same', 'editor_art.js', "const f = frames[(opts.frame | 0) % 2];", 'const f = frames[0];', E('art/kit-draws-from-the-rom-and-only-what-is-asked'));
mut('A03 the shiny icon palette is ignored', 'editor_art.js', 'const p = shiny ? shinyPal : pal;', 'const p = pal;', E('art/kit-draws-from-the-rom-and-only-what-is-asked'));
mut('A04 the whole species is decoded for an icon', 'editor_art.js', "const r = speciesRecord(rom, id);\n      if (!r || !r.icon) return null;", "for (let k = 1; k < 200; k++) frontSprite(k, {});\n      const r = speciesRecord(rom, id);\n      if (!r || !r.icon) return null;", E('art/kit-draws-from-the-rom-and-only-what-is-asked'));
mut('A05 the bar colour never changes', 'editor_art.js', "return f > 24 ? 'hpGreen' : f > 9 ? 'hpYellow' : 'hpRed';", "return 'hpGreen';", E('art/kit-draws-from-the-rom-and-only-what-is-asked'));
mut('A06 a positive value can draw an empty bar', 'editor_art.js', 'return r === 0 ? 1 : r;', 'return r;', E('art/kit-draws-from-the-rom-and-only-what-is-asked'));
mut('A07 the front-sprite fallback draws nothing', 'editor_art.js', 'out[(y * 32 + x) * 4 + c] = src.rgba[((y * 2) * 64 + x * 2) * 4 + c];', 'out[(y * 32 + x) * 4 + c] = 0;', E('art/kit-draws-from-the-rom-and-only-what-is-asked'));
mut('A08 the kit ignores the ROM it is given after the first one (a stand-in that does not read the bytes)', 'editor_art.js', "export function createArtKit(rom) {\n  const ui = loadUiAssets(rom);", "export function createArtKit(rom) {\n  rom = globalThis.__arenaFirstRom || (globalThis.__arenaFirstRom = rom);\n  const ui = loadUiAssets(rom);", E('art/the-art-changes-when-the-rom-bytes-change'));

function mutate(m) {
  return makeCopy({ [m.file]: (src) => {
    const n = src.split(m.from).length - 1;
    if (n !== m.count) throw new Error(`mutation target found ${n}x in ${m.file} (want ${m.count}): ${m.from.slice(0, 80)}`);
    return m.count === 0 ? src : src.split(m.from).join(m.to);
  } });
}
let caught = 0, usable = 0;
const named = new Set();
const SKIP_MUT = !!process.env.ARENA_SKIP_MUTANTS;
const QUIET = !!process.env.ARENA_QUIET;
const toRun = (SKIP_MUT ? [] : MUTANTS).filter((m) => m.count !== 0); // count 0 = documented equivalent mutant, not run
const tm0 = Date.now();
let tmLast = tm0, done = 0;
if (toRun.length && !QUIET) console.log(`  running ${toRun.length} mutants (each runs only the checks it names)`);
for (const m of SKIP_MUT ? [] : MUTANTS) {
  if (m.count === 0) { continue; } // documented equivalent / skipped
  done++;
  if (!QUIET && (done % 10 === 0 || Date.now() - tmLast > 15000)) { tmLast = Date.now(); console.log(`  mutants ${done}/${toRun.length}  (${((tmLast - tm0) / 1000).toFixed(1)} s)`); }
  let dir;
  try { dir = mutate(m); } catch (e) { t(m.id + ' (target)', e.message); continue; }
  usable++;
  let mods;
  try { mods = await loadCopy(dir); } catch (e) { t(m.id, 'the mutant does not even load: ' + e.message.split('\n')[0]); continue; }
  const f = await runSuite(mods, m.expect);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* the modules are already loaded; the files are not needed again */ }
  delete globalThis.__arenaFirstRom;
  const tripped = f.map((x) => x.id);
  m.expect.forEach((x) => named.add(x));
  const missing = m.expect.filter((x) => !tripped.includes(x));
  if (tripped.length === 0) t(m.id + ' is caught', 'NOT CAUGHT by any check');
  else if (missing.length) t(m.id + ' is caught by the named check', 'tripped ' + tripped.join(', ') + ' but not ' + missing.join(', '));
  else { caught++; t(m.id + ' -> caught by ' + m.expect.join(' + '), true); }
}
if (!SKIP_MUT) {
  if (!QUIET) console.log(`  ${usable} mutants in ${((Date.now() - tm0) / 1000).toFixed(1)} s`);
  t(`all ${usable} source mutants are caught (${caught} caught)`, caught === usable, `${usable - caught} not caught`);
  const unnamed = suite.filter((c) => !named.has(c.id)).map((c) => c.id);
  t('every check is named by at least one mutant (a check nobody can make fail is decoration)', unnamed.length === 0, unnamed.join(', '));
} else console.log('  (mutants skipped: ARENA_SKIP_MUTANTS)');

cleanTmp();
console.log('\n' + (failed ? 'FAILED' : 'OK') + ': ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);
